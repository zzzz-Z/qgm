# 打包后使用方式

> 本文档回答一个问题：**这个项目打包后，怎么跑起来、怎么装到别处**。
> 若只要「开发时怎么用」，看 README「十、本地开发」即可。

## 一、三种使用形态

| 形态                    | 适用场景              | 当前状态          |
| :---------------------- | :-------------------- | :---------------- |
| A. 仓库内开发           | 改本项目源码、调试    | ✅ 可用           |
| B. 仓库内构建产物自托管 | 本机当独立 Web 应用跑 | ✅ 可用           |
| C. 发布后安装到别的项目 | 给别人用              | ⚠️ 发布链路待补全 |

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

## 四、形态 C：发布后安装（待补全）

### 目标用法（设计意图）

**C1. 作为 Vite 插件（挂到用户自己的项目）**

```bash
pnpm add -D @qgm/vite-plugin-ai-runner
```

```ts
import { aiRunner } from '@qgm/vite-plugin-ai-runner'

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

- ✅ `packages/core` 独立 build：`pnpm --filter @qgm/ai-runner-core build` → `packages/core/dist/`（.js + .d.ts + runtime .cjs）
- ✅ `packages/client` 独立 build：`pnpm --filter @qgm/ai-runner-client build` → `packages/client/dist/`
- ✅ `apps/vite-plugin` 独立 build：`pnpm --filter @qgm/vite-plugin-ai-runner build` → `apps/vite-plugin/dist/`
- ✅ `apps/standalone` 独立 build：`pnpm --filter @qgm/ai-runner build` → `apps/standalone/dist/`（_server + client + runtime cjs）
- ✅ `apps/standalone/bin/air-server.cjs` 自包含 launcher（`__dirname` 定位，发布态可用）
- ✅ 根 `pnpm start` 指向包内 launcher
- ✅ `pnpm publish --dry-run` 通过（standalone 包）

**已完成（截至本轮）**

- ✅ `packages/core` 独立 build：`pnpm --filter @qgm/ai-runner-core build` → `packages/core/dist/`（.js + .d.ts + runtime .cjs）
- ✅ `packages/client` 独立 build：`pnpm --filter @qgm/ai-runner-client build` → `packages/client/dist/`
- ✅ `apps/vite-plugin` 独立 build：vite SSR 打包内联 core → `apps/vite-plugin/dist/index.js`（不再 external core）
- ✅ `apps/standalone` 独立 build：→ `apps/standalone/dist/`（_server + client + runtime cjs）
- ✅ `apps/standalone/bin/air-server.cjs` 自包含 launcher（`__dirname` 定位）
- ✅ 根 `pnpm start` 指向包内 launcher
- ✅ `@qgm/ai-runner-core` / `@qgm/ai-runner-client` 去 private，补 description/license/publishConfig
- ✅ 四个包 `pnpm publish --dry-run` 全部通过

**唯一遗留：Vite 插件发布态的 client 托管**

dev 模式下（仓库内），`page.ts` 通过 `/@fs/${abs}` 引用 `packages/client/main.ts` 源码，由 Vite 转译。
发布到别的项目后：

- `page.ts` 兜底的相对路径解析到 `node_modules/client/main.ts`（不存在）
- `plugin.ts` 的 `createRequire.resolve("@qgm/ai-runner-client/main.ts")` 会失败（exports 声明该路径但 files 未带源码）

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
pnpm link --global @qgm/vite-plugin-ai-runner  # Vite 插件
```

## 五、环境变量

| 变量                   | 默认                    | 作用                                  |
| :--------------------- | :---------------------- | :------------------------------------ |
| `AIR_SERVER_PORT`      | `5175`                  | 后端监听端口                          |
| `AIR_SERVER_HOST`      | `127.0.0.1`             | 后端绑定地址                          |
| `AIR_BACKEND_URL`      | `http://127.0.0.1:5175` | 前端 dev proxy 目标                   |
| `AIR_WEB_PORT`         | `5174`                  | 前端 dev server 端口                  |
| `AIR_INPROCESS_PLUGIN` | （空）                  | 设为 `1` 时前端内嵌 aiRunner 插件兜底 |
| `DEEPSEEK_API_KEY`     | （空）                  | 「问 AI」直连所需                     |

## 六、常见问题

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

## 七、产物清单速查

```
packages/core/dist/           core 编译产物（.js + .d.ts）
packages/client/dist/         SPA（index.html + assets）
dist/_server/index.js         standalone 服务（Vite SSR）
dist/*.cjs                    runtime（interceptor/helpers/logger）
bin/*.cjs                     CLI 工具集
```
