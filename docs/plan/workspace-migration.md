# Workspace 迁移计划：@qgm 四包拆分

目标：同一份核心逻辑，同时服务「Vite 插件」与「独立 Web 应用」两种宿主。

## 包划分

| 路径             | 包名                       | 发布 | 角色              |
| :--------------- | :------------------------- | :--- | :---------------- |
| packages/core    | @qgm/ai-runner-core        | 内部 | 宿主无关能力层    |
| packages/client  | @qgm/ai-runner-client      | 内部 | 唯一一份 SPA 产物 |
| apps/vite-plugin | @qgm/vite-plugin-ai-runner | 对外 | Vite 插件宿主     |
| apps/standalone  | @qgm/ai-runner             | 对外 | 独立 Web 应用宿主 |

## 三条铁律（结构守卫固化）

1. 依赖方向单向：apps -> packages；packages 不得依赖 apps
2. 只有 apps/* 允许 listen / createServer / import vite / @hono/node-server
3. packages/client 不得 import packages/core

## 依赖方向图

apps/vite-plugin ---> packages/core
apps/standalone ---> packages/core
apps/* ---> packages/client
packages/client -X-> packages/core （禁止）

## 迁移步骤

1. [done] 建骨架目录 + 各包 package.json + 边界 README + 本计划
2. [next] 激活 workspace：pnpm-workspace.yaml 加 packages/_与 apps/_；根 package.json 降为 workspace root（private）
3. 搬 core：src/ 除入口外全部 -> packages/core/src，改 import 前缀，core 单测全绿
4. 搬 client：client/ -> packages/client/，build 通过
5. 写 apps/vite-plugin：原 src/index.ts + Vite 中间件适配，对外 API aiRunner() 不变
6. 写 apps/standalone：原 bin/air-server.cjs 逻辑 + Node server + 静态托管 + SPA fallback
7. 结构守卫：三条铁律写进 hclc 或新守卫文件
8. 根 verify 串各包：pnpm -r verify + workspace 级跨包断言

## 风险控制

- 每一步做完 pnpm verify 全绿再进入下一步
- 第 2 步（激活 workspace）之前，本轮骨架不参与 pnpm 解析，现状构建零影响

## 命名与角色决策（已定）

原根包名 @qgm/ai-runner 已占用。最终归属：

| 包               | 名称                       | 承担                                     |
| :--------------- | :------------------------- | :--------------------------------------- |
| apps/standalone  | @qgm/ai-runner             | 独立 Web 应用 + 全部 CLI bin（继承原名） |
| apps/vite-plugin | @qgm/vite-plugin-ai-runner | Vite 插件入口（继承原 main/exports）     |
| packages/core    | @qgm/ai-runner-core        | private，宿主无关核心                    |
| packages/client  | @qgm/ai-runner-client      | private，唯一一份 SPA 产物               |
| 根               | @qgm/ai-runner-workspace   | private，workspace root，不再发布        |

理由：原 @qgm/ai-runner 的 bin 集合本质是「独立应用 + CLI 工具」，与 standalone 定位一致；
vite 插件是装配层的一个新宿主，用新名更清晰，不占用已发布名造成混淆。

## 下一轮激活清单

1. pnpm-workspace.yaml 增 packages 字段：packages/_、apps/_
2. 根 package.json：
   - name 改 @qgm/ai-runner-workspace
   - 加 private: true
   - 移除 bin（迁至 apps/standalone）
   - 移除 main / exports（迁至 apps/vite-plugin）
   - 保留 scripts 作为 workspace 级编排（build / verify / lint）
3. 各子包跑一次 pnpm install 让 workspace 链接生效
4. 验证：根 pnpm verify 仍全绿（此时子包尚未承接代码，应无影响）

## 根 package.json 快照（迁移前，供对照）

name: @qgm/ai-runner
version: 0.1.0
type: module
bin: 9 个
main: ./dist/index.js
exports: ., ./package.json, ./protocol
files: README.md, bin, client, dist, skills

## 进度

- [x] 步骤 1: 建骨架目录 + package.json + 边界 README + 本计划
- [x] 步骤 2: 激活 workspace（pnpm-workspace.yaml + 根降级为 private）
- [x] 步骤 3: 搬 core —— src/ 全部搬入 packages/core/src/（70 文件），外部引用 perl 批量更新
- [x] 步骤 3.5: 搬家收尾 —— tsconfig / vitest / 测试磁盘路径同步，test:unit 836 用例全绿
- [x] 步骤 7（部分）: 结构守卫 —— 三条铁律 + 四包齐备断言
- [ ] 步骤 4.5: 把 core/src/server/ 与 core/src/index.ts 迁入 apps（宿主层代码）
- [ ] 步骤 5: 写 apps/vite-plugin —— 原 src/index.ts + Vite 中间件适配
- [ ] 步骤 6: 写 apps/standalone —— bin/air-server.cjs 逻辑 + Node server
- [ ] 步骤 8: 根 verify 串各包

## 本轮踩坑记录（供后续参考）

- AI Runner 拦截器对 `fs.renameSync` 搬目录报 EISDIR：改用 bash `mv` 原子操作
- AI Runner 拦截器对逐文件 read + unlink 混合操作报 ENOENT：改用 bash `perl -pi` 批量改引用
- 测试磁盘路径硬编码：搬家后需同步 `test/server/*.node-test.ts` 中的 `path.join(__dirname, '..', '..', 'src', ...)`

## 完成记录（宿主层剥离）

- [x] 步骤 4.5: 宿主层剥离
  - `packages/core/src/server/router.ts` 新建（共享路由分发器）
  - `packages/core/src/server/core.ts` 精简为纯 `createRouter` 消费者（现已被迁走）
  - `apps/vite-plugin/src/index.ts` —— Vite 插件对外 API
  - `apps/vite-plugin/src/plugin.ts` —— 插件主体（原 core.ts 的 aiRunner）
  - `apps/standalone/src/server.ts` —— 独立 Node HTTP server
  - `apps/standalone/vite.config.ts` —— SSR 打包配置
- [x] 步骤 5: apps/vite-plugin 装配完成
- [x] 步骤 6: apps/standalone 装配完成
- [x] 步骤 7: 结构守卫升级为 v2 —— 三条铁律 + 宿主层禁止回流 core
- [x] 附加: tsconfig.apps.json 独立类型检查 apps/*

## 遗留（可选，非阻塞）

- AGENTS.md 目录结构说明仍以 src/ 为入口描述，需后续同步
- 各包未拆分独立 build 脚本；根 build-all.mjs 仍为统一编排
- 未来加 `pnpm -r build` 支持时，各包再各加 build 脚本

## 阶段完成（v1）

- [x] 步骤 1-7 全部完成
- [x] packages/core 公开 barrel（src/index.ts）作为唯一契约入口
- [x] apps/* 走包名 `@qgm/ai-runner-core`，不再相对穿透
- [x] 三份 tsconfig（根 / apps / client）都声明 `@qgm/ai-runner-core` paths
- [x] workspace-guard v3：三条铁律 + 宿主层禁止回流 core
- [x] 独立 server 实测可用：`/`、`/__ai/`、`/__ai/workspace` 全 200

## 后续（v2 候选，非阻塞）

- apps/* 独立 `pnpm -r build` 支持（各包自己的 build 脚本 + dist 产物）
- 各包独立 version 与发布流程
- client/vite.config.ts 切换到 `@qgm/vite-plugin-ai-runner` 包名 import
- README 补「独立使用」章节（npx @qgm/ai-runner）

## 遗留：verify-anchors 历史漂移

`scripts/verify-anchors.cjs` 检出的 19 条失效锚点中，仅 `bin/compliance-report.cjs` 由本次迁移直接引起（logger 引用改 shim），已修。
其余 18 条属于 monorepo 迁移前就已存在的结构漂移，与本次无关：

- `client/composables/ai/useSessionManager.ts` — `ASK_ROTATE_THRESHOLD`
- `client/composables/ai/useAutoLoop.ts` — `no-progress` / `same-fingerprint` / `drop-round-limit`
- `client/components/script/ScriptPanel.vue` — `trimOutput` / `unified-status-bar` / `usb-*` / `is-countdown` / `copyoutput-rotate`
- `AGENTS.md` — `## 11. 会话首轮一键 preflight` / `无轮次上限`
- `package.json` — `handoff:gen`
- `scripts/verify-anchors.cjs` — `eslint-disable no-console`

治理选项（择一，待专项）：

1. 逐条核对 anchors.json，剔除或更新过时条目
2. 将 verify-anchors 降级为 warn-only（当前它就是独立脚本，不阻塞 `pnpm verify`）
3. 重建 anchors.json 全量锚点集
