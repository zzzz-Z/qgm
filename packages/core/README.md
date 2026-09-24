# @qgm/ai-runner-core

宿主无关核心层。vite-plugin 与 standalone 两个宿主共享的全部逻辑都在这里。

## 边界（违反即结构守卫阻断）

- 禁止 import vite
- 禁止 createServer / listen
- 禁止 import @hono/node-server
- 禁止隐式假设 process.cwd()：root 必须显式传入
- 不得依赖 apps/*

## 对外导出

- createCoreApp(options): Hono app
- 一组 service 接口（Config / Process / State ...）
