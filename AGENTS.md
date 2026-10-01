# AGENTS.md

> 项目入口索引。**唯一规则来源（SSOT）为 [`SYSTEM.md`](./packages/core/SYSTEM.md)**；冲突时以 SYSTEM.md 为准。
> 本文件缺失仅警告，不中断。

## 首轮加载顺序

`AGENTS.md` → `SYSTEM.md` → `.ai-runner/state.json` → 当前任务

---

## 契约速查（完整定义见 SYSTEM.md）

| 主题       | 摘要                                                           | 出处           |
| :--------- | :------------------------------------------------------------- | :------------- |
| 输出围栏   | 首尾字符 / 零溢出；违反即整轮丢弃                              | SYSTEM.md §1   |
| 脚本头     | Shebang `#! /usr/bin/env node` + `@desc` + `@why`              | SYSTEM.md §1   |
| 收尾轮     | 首行严格 `DONE` + 后续 Markdown 总结；不写脚本、不调 log       | SYSTEM.md §1   |
| 首轮探测   | `typeof __AI__` 判定；失败带 `exitCode: 2` 上报                | SYSTEM.md §2   |
| 读写协议   | R1 读为先 / R2 锚点验证 / R3 幂等有据                          | SYSTEM.md §3   |
| 运行时沙箱 | 禁原生 `fs` / `path` / `child_process` / `os`，全部走 `__AI__` | SYSTEM.md §4   |
| 降级协议   | 仅当探测确认缺失 + `// ⚠️ fallback: ...` 注释                  | SYSTEM.md §4.3 |
| 架构红线   | 单文件 import ≤ 8；普通 ≤ 400 行、组件 ≤ 500 行                | SYSTEM.md §5   |
| 调试排查   | `__AI__.browser.*` 优先；grep → dump ±20                       | SYSTEM.md §6   |
| 注释规范   | 三问（WHY / CONSTRAINT / CHANGE-IMPACT）取其二                 | SYSTEM.md §7   |
| 命名规范   | 文件 kebab-case；禁止 `var`；函数 ≤ 30 行                      | SYSTEM.md §8   |
| 重试预算   | 同一报错最多重试 3 次；第 2 次仍失败必须换策略                 | SYSTEM.md §9   |
| 跨文件级联 | 改导出类型/签名/props 必须 grep 全部调用方同步                 | SYSTEM.md §10  |
| 输出预算   | 单轮脚本 ≤ 300 行 / 12 KB；超限拆轮                            | SYSTEM.md §11  |

---

## 项目结构速览

```text
packages/core/        @qgm/core          宿主无关核心（Hono 路由 / 脚本执行 / post-run / 状态 / 快照）
packages/client/      @qgm/client        Vue 3 SPA 工作台（唯一一份产物）
apps/vite-plugin/     @qgm/vite-plugin   Vite 插件宿主
apps/standalone/      @qgm/ai-runner               独立 Web 应用宿主（Node HTTP server + bin）
bin/                  CLI 工具集（air-ask / air-check / air-log / air-recover / air-run-all）
scripts/              build / dev / 分析 / 校验等辅助脚本
test/server|web/      后端 / 前端 node-test 单测
docs/                 USAGE.md / DOCS-INDEX.md
```

三条架构铁律（由 `test/server/workspace-guard.node-test.ts` 覆盖）：

1. `packages/*` 不得依赖 `apps/*`
2. `packages/*` 里禁止 `listen` / `createServer` / `import vite` / `@hono/node-server`
3. `packages/client` 不得 import `packages/core`

---

## 提交前闸门

```bash
pnpm tsc          # 服务端类型检查
pnpm tsc:client   # 前端 vue-tsc 类型检查
pnpm lint         # ESLint flat config
pnpm test:unit    # vitest（test/web + test/server）
```

`pnpm verify` 一把梭：`tsc → tsc:apps → tsc:client → test:tsc → lint → test:unit`。

`git status` 不得包含 `.ai-runner/` 运行态文件。

---

## 不做清单

- 不贴大段内容；不手编自动生成文件；未备份不做 L1+ 变更
- 不动无关核心；不提交敏感文件
- 禁 `as any` / `as unknown as`（除非注释理由）
- 不执行 `rm -rf`、`sudo`、`git reset --hard`、`git push -f` 等破坏性命令
- 不在 `packages/*` 里引入宿主专有依赖（见铁律）

---

## 详见

完整规则（输出契约 / 运行时沙箱 / 架构红线 / 注释与命名 / 重试预算 / 跨文件级联 / 输出预算）见 [`SYSTEM.md`](./packages/core/SYSTEM.md)。
打包使用 / 环境变量 / 部署见 [`docs/USAGE.md`](./docs/USAGE.md)。
