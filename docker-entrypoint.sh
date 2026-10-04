#!/bin/sh
set -eu

# [robust-mkdir-v1] 目录不可创建（未挂载 /workspace、只读 rootfs）不应拖垮启动
mkdir -p "$HOME/.ai-runner" /app/.ai-runner 2> /dev/null || true
mkdir -p /workspace 2> /dev/null || true

if [ ! -s "$HOME/.ai-runner/workspace.json" ]; then
  printf '{"root":"/workspace"}\n' > "$HOME/.ai-runner/workspace.json"
fi

# [xvnc-stale-lock-v1] 上一次容器是「被 kill」退出时，Chromium 来不及清 SingletonLock。
# 该锁是指向「旧容器 hostname-pid」的 symlink，新容器 hostname 已变，Chromium 判定 profile
# 正在被占用并立即退出，表层报错是 browserType.launchPersistentContext:
# Target page, context or browser has been closed —— 与「登录窗口打不开」易混但根因不同。
# 容器启动瞬间必然没有浏览器在跑，可安全清理。
for base in "$HOME/.ai-runner/headless-profile" "/app/.ai-runner/headless-profile" "/workspace/.ai-runner/headless-profile"; do
  [ -d "$base" ] || continue
  find "$base" -maxdepth 3 -name 'Singleton*' -exec rm -f {} + 2> /dev/null || true
done

# [exit-type-clean-v1] 容器 kill/restart 属非正常退出，Chromium 会把 profile 标成 exit_type=Crashed。
# 有头模式下这有两个连锁后果：启动弹 "Restore pages?" 气泡，并且【丢弃 session cookie】——
# DeepSeek 登录态（ds_session_id）正是 session cookie，于是表现为「明明登录过却被踢到 /sign_in」。
# 无头 shell（headless shell 二进制）不走崩溃恢复 UI，session cookie 照常加载，所以无头不受影响，
# 这就是「无头能进、有头被踢」假象的来源。启动前把标记改回 Normal，两条路径行为一致。
for pref in \
  "$HOME/.ai-runner/headless-profile/Default/Preferences" \
  "/app/.ai-runner/headless-profile/Default/Preferences" \
  "/workspace/.ai-runner/headless-profile/Default/Preferences"; do
  [ -f "$pref" ] || continue
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    try {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      j.profile = j.profile || {};
      if (j.profile.exit_type && j.profile.exit_type !== "Normal") {
        j.profile.exit_type = "Normal";
        j.profile.exited_cleanly = true;
        fs.writeFileSync(p, JSON.stringify(j));
        console.log("[air-entrypoint] profile.exit_type -> Normal:", p);
      }
    } catch (e) { console.log("[air-entrypoint] 跳过 Preferences 修补:", String(e.message).slice(0, 120)); }
  ' "$pref" || true
done

# [air-xvnc-v1] 容器内没有 X server，ai-headless 的 openLoginGui(sid) 走 headless:false 起有头窗口，
# 缺 X 会直接抛 "headed browser without having a XServer running"。
# 这里拉起虚拟显示 Xvfb + x11vnc + noVNC：用浏览器打开 6080（vnc.html）即可看到并操作
# 那扇有头登录窗口，登录态落盘后由无头链路复用。
# [CONSTRAINT] 必须在 exec "$@" 之前 export DISPLAY，否则子进程 node 起的有头浏览器仍找不到 X。
# AIR_XVFB=0 可关闭（无 xvfb 的裁剪镜像 / 不需要有头登录的场景）。
if [ "${AIR_XVFB:-1}" != "0" ] && command -v Xvfb > /dev/null 2>&1; then
  XVFB_DISPLAY="${AIR_XVFB_DISPLAY:-:99}"
  XVFB_SCREEN="${AIR_XVFB_SCREEN:-1280x900x24}"
  XVFB_NUM="${XVFB_DISPLAY#:}"
  XVFB_SOCK="/tmp/.X11-unix/X${XVFB_NUM}"
  export DISPLAY="$XVFB_DISPLAY"

  # [xvfb-restart-v1] 容器 restart 会保留 /tmp：上一轮的 socket 与 lock 文件还在，
  # Xvfb 会以 "Server is already active for display N" 直接退出；不清掉则下面的等待循环
  # 会立刻误判「已就绪」，连锁让整段 X 启动失败。
  rm -f "/tmp/.X${XVFB_NUM}-lock" "$XVFB_SOCK" 2> /dev/null || true

  Xvfb "$XVFB_DISPLAY" -screen 0 "$XVFB_SCREEN" -nolisten tcp > /tmp/xvfb.log 2>&1 &
  XVFB_PID=$!

  # 等 X unix socket 出现，避免 x11vnc / openbox 抢在 X 就绪前启动而退出
  i=0
  while [ "$i" -lt 100 ]; do
    if [ -e "$XVFB_SOCK" ] && kill -0 "$XVFB_PID" 2> /dev/null; then break; fi
    i=$((i + 1))
    sleep 0.1
  done

  # [air-xvfb-nonfatal] 虚拟显示只是「有头登录」的可选增强。起不来也必须让主服务照常启动，
  # 否则 compose 的 restart: unless-stopped 会把它放大成无限重启循环。
  if kill -0 "$XVFB_PID" 2> /dev/null; then
    # 轻量窗口管理器：让有头窗口带装饰与焦点，登录窗口不至于无边框难以操作
    if command -v openbox > /dev/null 2>&1; then openbox > /tmp/openbox.log 2>&1 & fi

    # 无密码时任何人可接管浏览器会话；AIR_VNC_PASSWORD 设了就强制走密码认证
    if [ -n "${AIR_VNC_PASSWORD:-}" ]; then
      x11vnc -display "$XVFB_DISPLAY" -rfbport 5900 -passwd "$AIR_VNC_PASSWORD" -forever -shared -repeat -quiet -bg -o /tmp/x11vnc.log \
        || echo '[air-xvfb] 警告：x11vnc 启动失败，noVNC 不可用'
    else
      x11vnc -display "$XVFB_DISPLAY" -rfbport 5900 -nopw -forever -shared -repeat -quiet -bg -o /tmp/x11vnc.log \
        || echo '[air-xvfb] 警告：x11vnc 启动失败，noVNC 不可用'
    fi

    websockify --web=/usr/share/novnc 6080 localhost:5900 > /tmp/websockify.log 2>&1 &
    echo "[air-xvfb] DISPLAY=$XVFB_DISPLAY  noVNC: http://0.0.0.0:6080/vnc.html?autoconnect=1&resize=scale"
  else
    echo '[air-xvfb] 警告：Xvfb 未就绪，跳过 noVNC（有头登录窗口将不可用），详见 /tmp/xvfb.log'
    sed -n '1,5p' /tmp/xvfb.log 2> /dev/null || true
  fi
fi

exec "$@"
