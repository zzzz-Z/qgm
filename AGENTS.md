<!-- AIRUNNER-BATCH30-VERIFY-DESC -->
<!-- AIRUNNER-BATCH25-3-DOCS-L20 -->
<!-- AIRUNNER-BATCH25-2-DOCS-VITEST: 同步 batch21-24 迁移后的测试工具链 -->

# AGENTS.md

> 面向 AI 与协作者的仓库约定。会话首条应读此文件，再动手。

## 项目概览

- 名称：@qgm/vite-plugin-ai-runner
- 类型：ESM（package.json 的 type 字段为 module）
- Node：>=20.19.0
- 包管理：pnpm
- 用途：Vite 插件 + 本地 Web 工作台；SPA（Vue 3）与 Node 服务端（HTTP + WS）一体

## 技术栈

- 前端：Vue 3 + script setup + TypeScript + UnoCSS + Vite
- 后端：Node 原生 http + WebSocket；dev 由 Vite 中间件承载，prod 由 bin/air-server.cjs 独立壳托管
- 类型：TypeScript，module=NodeNext，target=ES2022，strict
- Lint：ESLint（eslint.config.ts）
- 测试：vitest（单元）+ Playwright（E2E）

## 目录结构（一级）

- src/
  - src/headless/ headless 与注入
  - src/post-run/ 脚本运行后的处理
  - src/process/ 进程与子进程
  - src/routes/ HTTP 路由
  - src/server/ HTTP + WS 服务端
  - src/state/ 状态与快照
  - src/utils/ 通用工具
  - src/index.ts 插件入口
  - src/config.ts 全局配置
  - src/logger.cjs overlay 用日志器
  - src/helpers.cjs overlay 用辅助
  - src/interceptor.cjs overlay 拦截器
- client/
  - client/components/ UI 组件（按域分子目录）
  - client/composables/ Vue 组合式函数（ai/runner/ui/data）
  - test/web/ 前端单元测试（client 侧）；test/server/ 后端单元测试（src 侧）
  - client/main.ts SPA 入口
  - client/App.vue 根组件
- bin/
  - bin/air-server.cjs 独立服务壳
  - bin/check-regression.cjs 回归检查
  - bin/run-all.cjs 全流程
  - bin/recover.cjs 恢复
- scripts/
  - scripts/build-all.mjs 全 vite 打包编排
  - scripts/copy-runtime.cjs 拷贝 .cjs 运行时
  - scripts/session-start.cjs
  - scripts/tampermonkey-session-id.user.js
- skills/
  - skills/RULES.md 全部规则（单一权威，8 章：输出契约 / 行为准则 / 脚本规范 / **AI** API / 环境自检 / 踩坑库 / TS HCLC / UI 踩坑）
  - skills/_loader.cjs 动态加载器（ALWAYS_KEYS=[RULES]；--list / --for 查询）

### client/composables 模块图（AIRUNNER-BATCH5-AUTO-LOOP-MAP)

- client/composables/ai/useAutoLoop.ts —— 循环状态机主入口（单例，模块级 ref）
- client/composables/ai/auto-loop/ —— 从主入口拆出的子模块
  - types.ts 类型定义（LoopState / StopRequest / AiReply / LoopInstance / RoundOutcome）
  - persist.ts sessionStorage 持久化（persist / restore）
  - handoff.ts 会话切换与摘要交接
  - keyboard.ts 快捷键绑定（bindKeyboard / unbindKeyboard）
  - hooks.ts 生命周期 hook（runHook）
  - token-rotate.ts token 估算与自动轮换
- client/composables/runner/useScriptInbox.ts —— 脚本收件箱（push/consume/applyToEditor）
- client/composables/runner/inbox-logic.ts —— 纯函数（normalizeForHash / parseMeta），带单测

约定：拆分后主入口保留 re-export（如 export { persist } from ./auto-loop/persist.js），
以便 handoff.ts 等循环依赖方继续从 useAutoLoop.js 引入而无需改动。

## 脚本入口

- 开发
  - pnpm dev vite，访问 http://localhost:5174/__ai/
- 构建
  - pnpm build 全 vite 一键：SPA + server SSR + copy-runtime
  - pnpm build:tsc tsc 回退路径
- 质量
  - pnpm lint eslint .
  - pnpm lint:fix eslint . --fix
  - pnpm tsc tsc --noEmit
  <!-- AIRUNNER-BATCH28-DOCS-SYNC-AGENTS -->

<!-- AIRUNNER-BATCH31-AGENTS-COV -->

- pnpm test:unit vitest（+ test:tsc 类型检查）
- pnpm test:coverage 覆盖率报告（需先装 @vitest/coverage-v8）
  - pnpm test:e2e Playwright
  - pnpm verify tsc + tsc:client + test:tsc + lint + test:unit（5 道闸门）
  - pnpm check-regression
  - pnpm run-all 全流程
- 运行
  - pnpm start bin/air-server.cjs（检测 src 变化，必要时先 build）
  - pnpm session:start
  - pnpm recover

## 常用命令清单

- 全量测试：`pnpm test:unit`
- 类型检查：`pnpm tsc --noEmit`
- 客户端类型检查：`pnpm tsc:client`（vue-tsc）
- Lint 修复：`pnpm lint --fix`
- 端到端：`pnpm test:e2e`
- 全量回归：`pnpm run-all`

## 开发与运行

### 前端 dev

- pnpm dev 启动 Vite，访问 http://localhost:5174/__ai/
- 唯一 Vite 配置位于仓库根 vite.config.ts；root 指向 client/，PKG_ROOT 由 import.meta.url 得到
- transport 选择可用 URL 参数：?transport=headless 或 ?transport=tampermonkey

### 后端 dev / prod 壳

- pnpm start 调用 bin/air-server.cjs：检测 src/ 是否有更新，必要时先 pnpm build，再跑 dist/server/ws-server.js
- 默认绑定 127.0.0.1:5175；可用 AIR_SERVER_PORT 与 AIR_SERVER_HOST 覆盖
- 静态托管 client/dist；WebSocket 路径 /__ai/ws

### 打包

- 主路径（全 Vite）：pnpm build 调用 node scripts/build-all.mjs
  1. SPA：vite build（root=client/），产出 client/dist/
  2. Server：Vite SSR，产出 dist/server/ws-server.js（单文件 bundle）
  3. Runtime：src 下的 .cjs 拷贝到 dist/ 下 .cjs
  4. 构建前自动清理 dist/ 顶层历史 tsc 遗留
- 回退路径（tsc）：pnpm build:tsc 调用 tsc 与 copy-runtime

## 架构约定

- 唯一 Vite 配置：仓库根 vite.config.ts；不要再新增 client/vite.config.ts
- 正确 server 入口：dist/server/ws-server.js
  不要直接跑 dist/index.js（tsc 遗留入口，会 ERR_MODULE_NOT_FOUND）
- transport 优先级：URL 参数 transport > localStorage.__ai_transport > 默认 tampermonkey
- 跨 origin：dev(5174) 与 prod(5175) 是两个不同 origin，localStorage 与 window.opener 不共享
  跨环境请用 URL 参数或统一端口
- CJS 运行时：src/interceptor.cjs、src/helpers.cjs、src/logger.cjs 是真实磁盘文件，不要改成 .ts
- ESM 与 NodeNext：源码 import 写 ./x.js；Node strip-types 不重写路径，直跑 .ts 需要 resolve hook

## 关键路径

- 插件入口：src/index.ts -> src/server/core.ts
- 独立服务壳：bin/air-server.cjs
- 构建编排：scripts/build-all.mjs
- SPA 入口：client/main.ts -> client/App.vue
- WS 服务端：src/server/ws-server.ts

## 硬约束

1. 文件改动走脚本，禁止手动编辑或整文件复制
2. 幂等且可回滚：备份到 .ai-runner/backup/，重复执行安全
3. 锚点验证：replace 之前必须确认锚点命中；命中数不为 1 时退出码 2
4. 单轮改动不超过 3 个文件；单轮 stdout 不超过 120 行；单脚本不超过 200 行
5. 改动后自检：`pnpm verify`（tsc + tsc:client + test:tsc + lint + test:unit 五道闸门）
6. 不做清单：不用 bash 写业务逻辑；不手动编辑自动生成文件；不动与任务无关的核心逻辑；不提交敏感配置

## 提交前闸门

- node --check 每个改动的 .cjs
- pnpm tsc
- pnpm lint:fix
- pnpm test:unit
- git status 确认 .ai-runner/ 运行态文件未混入

## 常见坑

- overlay 沙箱：js 通道写内存 overlay，脚本非零退出时改动丢失；关键改动走 bash 或回读验证
- spawn 子进程看不到父脚本新写文件：需内联代码或改走 bash 通道
- mtime 在 overlay 下可能为 undefined：统一用 mtimeMs
- macOS 无 timeout：改用 perl 的 alarm 或内核内置 timeout
- Vite 8 与 rolldown 不能在 CJS 进程内动态 import vite：用 ESM 子进程或 --input-type=module -e

## 参考（skills/RULES.md）

单一权威规则文件，按章索引：

- 一、输出契约与自动化循环 （单块原则 / DONE / 熔断）
- 二、AI 行为与决策准则 （L0-L2 分级 / 决策阶梯 / 不做清单）
- 三、脚本编写与技术规范 （Shebang / 通道 / R1-R3 读写协议）
- 四、**AI** 全局注入 API （readText / writeText / patchFile / assert）
- 五、环境自检与提交闸门 （preflight / 提交前检查）
- 六、踩坑库（E/T/P/A） （环境 / 工具链 / 流程 / 协作）
- 七、TypeScript HCLC 架构 （高内聚 / 低耦合 / 依赖分级）
- 八、UI / CSS / Vue 踩坑 （选择器 / UnoCSS / 组件抽取）

加载：`node skills/_loader.cjs --list` 或 `--for "<任务描述>"`。
