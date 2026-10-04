# 打包后使用方式

> 本文档回答一个问题：**这个项目打包后，怎么跑起来、怎么装到别处**。
> 若只要「开发时怎么用」，看 README「十、本地开发」即可。

## 一、四种使用形态

| 形态                    | 适用场景                | 当前状态          |
| :---------------------- | :---------------------- | :---------------- |
| A. 仓库内开发           | 改本项目源码、调试      | ✅ 可用           |
| B. 仓库内构建产物自托管 | 本机当独立 Web 应用跑   | ✅ 可用           |
| D. Docker 容器运行      | 隔离环境 / 部署到服务器 | ✅ 可用           |
| C. 发布后安装到别的项目 | 给别人用                | ⚠️ 发布链路待补全 |

## 二、形态 A：仓库内开发

```bash
pnpm install
pnpm dev:all            # 前后端一键起：前端 5174 + 后端 5175
```

- 前端 5174：SPA + HMR，`/__ai/*` 反代到 5175
- 后端 5175：Hono API + WebSocket + 静态托管
- 打开 `http://localhost:5174/__ai/` 即工作台

## 三、形态 B：构建产物自托管（当前最实际的「打包后」用法）

### 1. 构建

```bash
pnpm build
```

产物落点：

```
dist/_server/index.js            独立 Node 服务（唯一 listen 处）
dist/interceptor.cjs             fs overlay 拦截层
dist/helpers.cjs / logger.cjs    runtime 辅助
packages/client/dist/            SPA（index.html + assets）
packages/core/dist/              core 的 .js + .d.ts
```

### 2. 启动

```bash
pnpm start                          # 默认 127.0.0.1:5175
AIR_SERVER_PORT=5177 pnpm start     # 换端口（5175 常被 dev:all 占用）
AIR_SERVER_HOST=0.0.0.0 pnpm start  # 暴露到局域网
```

等价于直接跑产物（跳过 bin 壳的自动重建）：

```bash
node dist/_server/index.js
AIR_SERVER_PORT=5177 node dist/_server/index.js
```

### 3. 验证

```bash
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5175/__ai/
```

返回 200 即可用浏览器打开 `http://127.0.0.1:5175/__ai/`。

## 四、形态 D：Docker 容器运行

### 1. 启动

**一键部署（推荐）**：

```bash
pnpm docker:deploy            # 缺镜像则自动构建 → 启动 → 等健康 → 打印入口
```

常用变体：

| 命令                  | 作用                                            |
| :-------------------- | :---------------------------------------------- |
| `pnpm docker:deploy`  | 缺镜像自动构建，然后启动并等到 healthy          |
| `pnpm docker:rebuild` | 强制重建镜像（改了 `Dockerfile` / 依赖 / 源码） |
| `pnpm docker:up`      | 只启动，不构建（快；镜像必须已存在）            |
| `pnpm docker:down`    | 停止并删除容器（数据卷保留）                    |
| `pnpm docker:logs`    | 跟随日志（`--tail 100`）                        |

脚本会做四件事：① 自检 docker CLI / compose / 守护进程；② 按需构建镜像；③ `up -d` 后轮询
容器健康状态（上限 300s，可 `--timeout=秒` 调整），并额外对 `5175/__ai/` 做一次 HTTP 探活；
④ 打印工作台 / noVNC 入口与后续命令。失败时自动 `logs --tail 30`，并提示用
`docker compose restart` 复位（僵尸进程 / 残留锁的标准解法）。

**等价的手工命令**（脚本不可用时）：

```bash
docker compose up -d            # 首次会自动构建镜像（较久）
docker compose ps               # 等 STATUS 变 healthy
```

- 工作台：`http://localhost:5175/__ai/`
- 挂载 `./:/workspace`：容器直接把当前仓库当工作区（`$HOME/.ai-runner/workspace.json` 写入 `{"root":"/workspace"}`）
- 镜像内置 Playwright Chromium（`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`），无头链路开箱可用

改了镜像内代码（`Dockerfile` / 依赖 / 源码）需重建：`pnpm docker:rebuild`（等价 `docker compose up -d --build`）。
只改工作区里的脚本不用重建——`/workspace` 是实时挂载的。

### 2. noVNC：容器内完成「有头登录」

`ai-headless` 的 `openLoginGui` 会起 `headless: false` 的有头窗口。容器里没有 X server，
直接调用必然报：

```
browserType.launchPersistentContext: Target page, context or browser has been closed
║ Looks like you launched a headed browser without having a XServer running.
```

镜像里装了 Xvfb + x11vnc + noVNC，entrypoint 会拉起虚拟显示并 `export DISPLAY=:99`。
所以流程是：

1. 浏览器打开 `http://localhost:6080/vnc.html?autoconnect=1&resize=scale`
2. 回到工作台点「打开登录窗口」——此时窗口出现在 noVNC 画面里，在里面正常登录
3. 登录成功后项目会自动关窗并把登录态落盘到 `.ai-runner/headless-profile/<sid>/`，无头链路直接复用

相关环境变量：

| 变量               | 默认          | 作用                                                  |
| :----------------- | :------------ | :---------------------------------------------------- |
| `AIR_XVFB`         | `1`           | 置 `0` 关闭整套 Xvfb/noVNC（不需要有头登录）          |
| `AIR_XVFB_DISPLAY` | `:99`         | 虚拟显示号                                            |
| `AIR_XVFB_SCREEN`  | `1280x900x24` | 虚拟屏分辨率                                          |
| `AIR_VNC_PASSWORD` | （空）        | 设了则 noVNC 需密码；不设等于任何人可接管该浏览器会话 |

noVNC 端口默认只绑本机（`127.0.0.1:6080`）。要局域网访问，把 compose 的端口改成 `"6080:6080"`
并**务必**同时设 `AIR_VNC_PASSWORD`。

### 3. 登录态与宿主机不通用

`headless-profile/<sid>` 里存的是 Chromium profile。**macOS 宿主上登录好的 profile 拷进
Linux 容器后登录态会失效**（cookie 加密密钥来源不同），反之亦然。
所以容器内的登录请在 noVNC 里重新做一次，不要指望挂载共享就够了。

### 4. 两个容易踩的坑

**`Target page, context or browser has been closed`** —— 容器被重建 / 重启时浏览器正在运行，
Chromium 来不及清掉 profile 里的 `SingletonLock`（symlink 指向旧容器 hostname-pid），
新容器 hostname 变了，Chromium 判定 profile 被占用并立即退出。
entrypoint 会在启动时清理 `Singleton*`，所以正常走 `docker compose up -d` 不会再遇到；
若手工 `docker kill` 后仍报，删掉对应 profile 即可：

```bash
rm -f .ai-runner/headless-profile/<sid>/Singleton*
```

**Linux 宿主的 uid 映射** —— 容器以 uid 1000 的 `node` 用户跑，profile 落在 bind mount 上。
macOS / Windows（Docker Desktop）会自动做 uid 映射，无感；**Linux 宿主**下若你的 uid 不是 1000，
浏览器写 profile 会 EACCES。两种解法：`compose.yaml` 里给服务加 `user: "${UID}:${GID}"`，
或改用命名卷挂 profile（放弃「profile 与宿主共享」这个特性）。

## 五、形态 C：发布后安装（待补全）

### 目标用法（设计意图）

**C1. 作为 Vite 插件（挂到用户自己的项目）**

```bash
pnpm add -D @qgm/vite-plugin
```

```ts
import { aiRunner } from '@qgm/vite-plugin'

export default defineConfig({ plugins: [aiRunner()] })
```

**C2. 作为独立 Web 应用（npx / 全局安装）**

```bash
npx @qgm/ai-runner
# 或
pnpm add -g @qgm/ai-runner && ai-runner
```

### 当前进展与剩余缺口

**已完成（截至本轮）**

- ✅ `packages/core` 独立 build：`pnpm --filter @qgm/core build` → `packages/core/dist/`（.js + .d.ts + runtime .cjs）
- ✅ `packages/client` 独立 build：`pnpm --filter @qgm/client build` → `packages/client/dist/`
- ✅ `apps/vite-plugin` 独立 build：`pnpm --filter @qgm/vite-plugin build` → `apps/vite-plugin/dist/`
- ✅ `apps/standalone` 独立 build：`pnpm --filter @qgm/ai-runner build` → `apps/standalone/dist/`（_server + client + runtime cjs）
- ✅ `apps/standalone/bin/air-server.cjs` 自包含 launcher（`__dirname` 定位，发布态可用）
- ✅ 根 `pnpm start` 指向包内 launcher
- ✅ `pnpm publish --dry-run` 通过（standalone 包）

**已完成（截至本轮）**

- ✅ `packages/core` 独立 build：`pnpm --filter @qgm/core build` → `packages/core/dist/`（.js + .d.ts + runtime .cjs）
- ✅ `packages/client` 独立 build：`pnpm --filter @qgm/client build` → `packages/client/dist/`
- ✅ `apps/vite-plugin` 独立 build：vite SSR 打包内联 core → `apps/vite-plugin/dist/index.js`（不再 external core）
- ✅ `apps/standalone` 独立 build：→ `apps/standalone/dist/`（_server + client + runtime cjs）
- ✅ `apps/standalone/bin/air-server.cjs` 自包含 launcher（`__dirname` 定位）
- ✅ 根 `pnpm start` 指向包内 launcher
- ✅ `@qgm/core` / `@qgm/client` 去 private，补 description/license/publishConfig
- ✅ 四个包 `pnpm publish --dry-run` 全部通过

**唯一遗留：Vite 插件发布态的 client 托管**

dev 模式下（仓库内），`page.ts` 通过 `/@fs/${abs}` 引用 `packages/client/main.ts` 源码，由 Vite 转译。
发布到别的项目后：

- `page.ts` 兜底的相对路径解析到 `node_modules/client/main.ts`（不存在）
- `plugin.ts` 的 `createRequire.resolve("@qgm/client/main.ts")` 会失败（exports 声明该路径但 files 未带源码）

因此**发布态的 vite 插件模式下，工作台页面暂时无法加载**。standalone 模式不受影响（它走静态托管 `packages/client/dist`）。

修法（未来工作）：

- **A. 插件模式也走静态托管**：vite-plugin 打包时把 `packages/client/dist` 一起带进 `dist/client/`，`PAGE` 改为引用 `/__ai/assets/*` 而非 `/@fs/.../main.ts`
- **B. client 包额外发布源码入口**：把 `main.ts` 及其依赖的源码加进 `files`，让 `createRequire.resolve` 能在发布态命中

**现阶段在别的项目试用（不走 npm）**

用 `pnpm link --global` 本地挂载，或直接把 `apps/standalone/dist` 目录整体拷过去跑 `node bin/air-server.cjs`。

### 现阶段如何在别的项目试用

用 `link` 方式本地挂载（不改发布链路也能试）：

```bash
# 本仓库
pnpm link --global

# 目标项目
pnpm link --global @qgm/ai-runner       # 独立应用
# 或
pnpm link --global @qgm/vite-plugin  # Vite 插件
```

## 六、环境变量

| 变量                   | 默认                    | 作用                                  |
| :--------------------- | :---------------------- | :------------------------------------ |
| `AIR_SERVER_PORT`      | `5175`                  | 后端监听端口                          |
| `AIR_SERVER_HOST`      | `127.0.0.1`             | 后端绑定地址                          |
| `AIR_BACKEND_URL`      | `http://127.0.0.1:5175` | 前端 dev proxy 目标                   |
| `AIR_WEB_PORT`         | `5174`                  | 前端 dev server 端口                  |
| `AIR_INPROCESS_PLUGIN` | （空）                  | 设为 `1` 时前端内嵌 aiRunner 插件兜底 |
| `DEEPSEEK_API_KEY`     | （空）                  | 「问 AI」直连所需                     |

## 七、常见问题

### `pnpm start` 报 EADDRINUSE

端口被占。已内建友好提示：

```
✗ 端口 5175 已被占用（127.0.0.1:5175）
  · 换端口：AIR_SERVER_PORT=5177 pnpm start
  · 或结束占用：lsof -tiTCP:5175 -sTCP:LISTEN | xargs kill
```

**注意**：`5175` 若正在运行 AI Runner 工作台自身（本工具的 Web 面板），不要 kill；换端口即可。

### `pnpm start` 报 `dist/_server/index.js` 不存在

先跑 `pnpm build`；或 `apps/standalone/bin/air-server.cjs` 会自动检测源码变更并重建。

### 生产模式 /@fs 404

生产模式走静态托管，不走 `/@fs`。若看到 `/@fs/.../main.ts` 404，说明：

- 服务实际在 dev 模式（应走 5174），却访问了 5175
- 或 `packages/client/dist` 未构建 —— 跑 `pnpm build` 即可

### 点「打开登录窗口」报 headed browser / XServer

```
Looks like you launched a headed browser without having a XServer running.
```

该功能走 `headless: false`，需要图形显示。三种情况：

- 在 Docker 里：用 noVNC（见「四、形态 D」），或用 `AIR_XVFB=0` 关掉后改为注入已登录的 profile
- 在无桌面的 Linux 服务器上：`xvfb-run -a pnpm start` 可消除报错，但窗口不可见
- 在 macOS/Windows 本地：不应出现；出现说明 `DISPLAY` 被污染或缺少图形会话

窗口能打开、但无头链路仍报 `页面加载后未找到输入框（可能未登录）`，说明 profile 里没有有效登录态：

- 确认登录与无头用的是同一个 sid（客户端取 `getActiveWinSid()`，默认 `default`）
- 检查 `.ai-runner/headless-profile/<sid>/` 是否就是那次登录落盘的目录
- 跨操作系统迁移 profile（macOS ↔ Linux）登录态不可用，需在目标环境重新登录

### 日志里的 `cloak binary 未装，降级 playwright`

不是错误。`linux-x64` 上优先用 cloakbrowser，未装其二进制时回落 playwright，属预期降级。

## 八、产物清单速查

```
packages/core/dist/           core 编译产物（.js + .d.ts）
packages/client/dist/         SPA（index.html + assets）
dist/_server/index.js         standalone 服务（Vite SSR）
dist/*.cjs                    runtime（interceptor/helpers/logger）
bin/*.cjs                     CLI 工具集
```
