FROM mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm

# ── 构建期镜像源（默认国内直连优化；海外可 --build-arg 切回官方源）─────────────
# [mirror-v1] 容器内没有宿主的 ~/.npmrc，pnpm 默认打 registry.npmjs.org。本机实测：
#   registry.npmjs.org   825 KB/s / RTT 2.6s
#   registry.npmmirror   1.7 MB/s / RTT 1.3s
# 首次要拉约 500MB 依赖，差距会放大到数分钟。本项目 pnpm-lock.yaml 只记 integrity、
# 不含 tarball URL（grep registry.npmjs.org 为 0 处），因此换源不会触发 lockfile 校验失败。
#   deb.debian.org       203 KB/s
#   mirrors.cloud.tencent.com 520 KB/s
# apt 首次要下约 443MB（xvfb/noVNC 等）。
# 切回官方源：docker compose build --build-arg NPM_REGISTRY=https://registry.npmjs.org \
#                                     --build-arg APT_MIRROR=
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG APT_MIRROR=https://mirrors.cloud.tencent.com
# [pw-mirror-v1] 可选：playwright 浏览器二进制下载源。默认空 = 走官方 CDN
# （cdn.playwright.dev）。国内首次构建觉得慢可换成 npmmirror 二进制镜像
# （实测 https://cdn.npmmirror.com/binaries/playwright/builds/... 返回 200 且约 1.7MB/s）：
#   docker compose build --build-arg PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright
ARG PLAYWRIGHT_DOWNLOAD_HOST=""

ENV AIR_SERVER_HOST=0.0.0.0 \
    AIR_SERVER_PORT=5175 \
    HOME=/home/node \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# ═══════════════════════════════════════════════════════════════════════════════
# [build-layers-v2] 层序铁律：从「最不常变」排到「最常变」。
#
# 旧版把 `COPY . .` 放在 `pnpm install && pnpm build` 之前，等于给后面每一层都
# 加了一道「源码闸门」。docker history 实测各层体积：
#     COPY . . ...................... 2.4MB   ← 闸门（内容极不稳定）
#     pnpm install + pnpm build ..... 368MB
#     apt xvfb/x11vnc/noVNC ......... 443MB
#     docker-ce-cli（含联网探测）..... 51MB
#     playwright --with-deps chromium 810MB
#                                     ------
#                                     1.67GB
# 改任意一行代码 / README / 脚本 → COPY 层 hash 变 → 上述 5 层全部作废重建，
# 其中还夹着 3 次独立联网下载（npm 依赖约 500MB、debian 源 443MB、
# download.docker.com、playwright CDN 约 170MB）。这就是「只改一行前端却要等
# 好几分钟」的全部原因，与机器性能无关。
#
# 新层序下改源码只重跑 L5；L2/L3/L4 因输入未变而命中缓存。各层另加 BuildKit
# cache mount，即使某一层失效也从本地缓存取包，不再重新下载。
# ═══════════════════════════════════════════════════════════════════════════════

# ── L1 工具链：pnpm 版本固定，与源码无关，几乎永不重跑 ────────────────────────
RUN corepack enable \
    && corepack prepare pnpm@11.8.0 --activate \
    && chown node:node /app

USER root

# ── L2 系统包：Xvfb/noVNC + docker CLI（与源码无关，挂 apt cache）────────────
# [air-xvnc-v1] 容器内无 X server：ai-headless 的 openLoginGui 用 headless:false 起有头窗口，
# 缺 X 会直接抛 "headed browser without having a XServer running"。装 Xvfb + x11vnc + noVNC，
# 由 docker-entrypoint.sh 拉起虚拟显示，用户经 6080 端口用浏览器完成登录。
# [docker-cli-v1] 沙箱需要 docker 命令操作宿主 daemon；配合 compose 挂载 /var/run/docker.sock
# [CONSTRAINT] 仅装 CLI，不含 dockerd；无 socket 挂载时 docker ps 会连接失败
# [docker-cli-resilient-v1] download.docker.com 在部分网络（含国内直连）不可达，原本会让整个
# build 以 exit 100 失败。改为「可达则装、不可达则跳过并打 WARN」：docker CLI 属可选增强，
# 不该阻塞镜像构建；需要时可在能联网的环境重建，或在容器内另行安装。
# [CONSTRAINT] 与 xvfb 合并为单层，省掉一次 apt-get update；docker-ce-cli 分支自带 if 兜底，
# 装不上也不会让本层失败。
# [apt-cache-mount-v1] 挂 /var/cache/apt + /var/lib/apt/lists：本层失效时 apt 从本地缓存取
# deb，不再重下 443MB。必须删掉官方镜像里的 docker-clean 钩子，否则它会在 install 后清空
# /var/cache/apt/archives，让缓存永远失效。
# [apt-mirror-fallback-v1] 换镜像源后 apt-get update 失败则自动回退官方源，避免构建直接挂掉。
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    set -eu; \
    rm -f /etc/apt/apt.conf.d/docker-clean; \
    echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache; \
    if [ -n "$APT_MIRROR" ]; then \
    echo "[apt-mirror-v1] 切换到 $APT_MIRROR"; \
    cp /etc/apt/sources.list.d/debian.sources /tmp/debian.sources.orig; \
    sed -i "s|http://deb.debian.org|$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources; \
    if ! apt-get update; then \
    echo '[apt-mirror-v1][WARN] 镜像源不可达，回退官方源'; \
    cp /tmp/debian.sources.orig /etc/apt/sources.list.d/debian.sources; \
    fi; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends xvfb x11vnc openbox novnc websockify curl ca-certificates gnupg; \
    if install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL --connect-timeout 20 --retry 2 --retry-delay 3 https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli; then \
    echo '[docker-cli-v1] docker-ce-cli 安装成功'; \
    else \
    echo '[docker-cli-v1][WARN] download.docker.com 不可达，跳过 docker CLI 安装（沙箱内将无 docker 命令）'; \
    rm -f /etc/apt/sources.list.d/docker.list; \
    fi

# ── L3 依赖层：只 COPY manifest。lockfile 不变则永不重跑 ──────────────────────
# [CONSTRAINT] 这里只能 COPY manifest：
#   1) 四个子包均无 install/prepare/postinstall 脚本，pnpm 只读 manifest 即可解析
#      workspace 协议（@qgm/client / @qgm/core），缺 src/ 不会失败；
#   2) 【新增 packages/* 或 apps/* 子包时，必须同步补一行 COPY，否则该包依赖装不上】。
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --chown=node:node apps/standalone/package.json apps/standalone/
COPY --chown=node:node apps/vite-plugin/package.json apps/vite-plugin/
COPY --chown=node:node packages/client/package.json packages/client/
COPY --chown=node:node packages/core/package.json packages/core/

USER node
# [pnpm-store-cache-v1] store 挂 cache mount 并以 node(uid=1000) 身份写入：依赖未变时
# 二次安装走本地硬链接，不再从 registry 重下约 500MB。--store-dir 显式指向 mount，
# 避免落到镜像内的空 store；--registry 走上面的 NPM_REGISTRY。
RUN --mount=type=cache,target=/pnpm-store,sharing=locked,uid=1000,gid=1000 \
    pnpm install --frozen-lockfile --store-dir=/pnpm-store --registry="$NPM_REGISTRY"

USER root

# ── L4 Playwright：浏览器只依赖 lockfile 里的 playwright 版本，与源码无关 ─────
# [pw-cache-v1] PLAYWRIGHT_BROWSERS_PATH 先指向 cache mount 完成下载解压（chromium
# 下载约 170MB、解压后约 400MB），再 cp 进镜像正式路径 /ms-playwright —— cache mount
# 的内容不落镜像层，必须显式拷贝。--with-deps 带的系统库同样走上面的 apt cache。
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,target=/pw-cache,sharing=locked \
    set -eu; \
    if [ -n "$PLAYWRIGHT_DOWNLOAD_HOST" ]; then \
    export PLAYWRIGHT_DOWNLOAD_HOST; \
    echo "[pw-mirror-v1] 浏览器下载源：$PLAYWRIGHT_DOWNLOAD_HOST"; \
    fi; \
    PLAYWRIGHT_BROWSERS_PATH=/pw-cache pnpm exec playwright install --with-deps chromium; \
    mkdir -p /ms-playwright /home/node/.ai-runner /app/.ai-runner; \
    cp -a /pw-cache/. /ms-playwright/; \
    chown -R node:node /ms-playwright /home/node/.ai-runner /app/.ai-runner

# ── L5 源码层 + 构建：唯一随源码变动重跑的层（+COPY 2.4MB）────────────────────
COPY --chown=node:node . .

USER node
RUN pnpm build

USER root

# ── L6 入口脚本：单独成层，以后只改 entrypoint 可秒级重建 ─────────────────────
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

USER node

EXPOSE 5175 6080 5900

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "apps/standalone/bin/air-server.cjs"]
