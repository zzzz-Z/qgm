# 多工作区方案（计划）

- **性质**：应用端提案（待宿主 / 用户拍板），**未开工**。
- **关联**：`packages/core/SYSTEM.md` 顶部「应用级 / 工作区级」边界（本会话新增）。
- **闸门**：属新功能，撞阶段闸门（`bin/check-status.cjs` 报 `prompt-budget 2/3`，规则「≥ 2 周不做新功能」）。

## §0 一句话

现状离多工作区比预期的近：`workspace.ts` 已有单工作区切换机制、`runProcess` 已支持 `cwd`、沙箱 `interceptor.cjs` 的 overlay 是**每脚本子进程独立**的。缺的不是重写，是把「单工作区切换」升级为「多工作区并存」。

## §1 目标

用户原话：「每个会话都可以处理单独的工作区，相当于把现在的功能复刻一份，但是独立的。」「删掉多站点，左侧改为多会话。」

拆解为三条：

- **左侧**：从「站点列表」改为「工作区列表」，每个工作区是一份独立代码树（目录 + git + 沙箱）。
- **执行**：多个工作区可以同时跑脚本，互不干扰。
- **移除**：站点选择 UI 移除；底层站点适配层（deepseek / chatgpt / claude 的 DOM 选择器）保留。

## §2 现状取证（2026-10-11 读盘）

**已就绪**

- `packages/core/src/routes/workspace.ts`：已有单工作区切换机制。端点 `GET /workspace`（返回 root + hasWorkspace）、`GET /workspace/list`（列目录）、`POST /workspace/...`（切换，通过 `setRoot` / `persistWorkspace` / `clearWorkspace` 落到 `config.ts`）。
- `packages/core/src/process/proc.ts:52`：`runProcess(cmd, { cwd, env })` 已支持自定义 cwd 与 env。
- `packages/core/src/interceptor.cjs:11,25`：overlay 是 `new Map()`（在**脚本执行子进程**内），`__SANDBOX_ROOT = process.cwd()`。**每个脚本子进程天然独立**——只要子进程以正确 cwd 启动，沙箱就是隔离的。
- `config.ts` 的 `getRoot()`：单一 root 状态已存在。
- 看板 `state.json` 的 `tasksBySid`：已按 sid 分桶，多工作区可复用该分桶模型。

**缺口**

- `/run` 请求不带 workspaceId（隐含使用 `getRoot()` 返回的单值）。
- `getRoot()` 返回单个 root；多工作区需要按 id 索引的列表 + 当前活跃 id。
- UI 是单工作区视图（`SidePane` 是站点列表，切站点不切工作区）。
- 看板 `running` 是 `string`（SYSTEM.md §2 契约），多工作区同时跑时需要改成每工作区一项 running。
- `tasksBySid` 按 sid 分桶，sid 与 workspaceId 是两个维度——需明确工作区切换时 sid 是否新建。
- 传输层（油猴 / 无头）回传消息不带 workspaceId。
- **观测层**：跨会话 / 跨工作区的日志目前是隔离的（AGENTS.md 已记录此模式），多工作区必须自带统一观测层。

## §3 三条路径

**路径 A：每工作区一个宿主进程（不同端口）**

- 优点：`process.cwd()` 天然独立，零改造；进程崩溃隔离。
- 缺点：端口管理复杂（5175 / 5176 / …）、内存成倍、前端需连多个 WS、pm2 托管多个实例、`instance-ownership-v1` 规则需重写。
- 适用：工作区数量少（2–3）。

**路径 B：单宿主 + 请求带 workspaceId（推荐）**

- 改造点：`/run` 解析 workspaceId、`runProcess({cwd})` 传对应 root、`config.ts` 从单 root 改为按 id 索引的 map、UI 多工作区视图。
- 优点：资源省、前端一个 WS、日志集中、与现有 `workspace.ts` 演进方向一致。
- 缺点：`config.ts` 需从单值改多值（中等改动）。
- 适用：工作区数量中等（3–10）。

**路径 C：git worktree（B 的特化）**

- 若多个「工作区」是同仓库不同分支，用 `git worktree add` 共享 `.git` 对象库，磁盘开销只有工作树本身。
- 优点：git 历史共享、分支隔离、合并路径清晰。
- 缺点：只适用「同仓库多分支」；跨仓库不适用。
- 建议：作为路径 B 的「新建工作区」选项之一，不作独立路径。

## §4 推荐：路径 B 分阶段

**阶段 0：前置决策（见 §5，需拍板）**

**阶段 1：只读多工作区（低成本、可先行）**

- 不改执行器、不动沙箱。
- 允许多个工作区同时在注册表里，同一时刻只有一个是「活跃工作区」（跑脚本的那个）。
- UI 侧栏从站点列表改为工作区列表；点击切换 = 切活跃工作区。
- 其他工作区只读观察：终端历史、看板、变更集。

**阶段 2：真并行执行（结构性）**

- `/run` 带 workspaceId。
- `config.ts` 从单 root 改为 `Map<workspaceId, Root>` + 活跃 id。
- `runProcess({cwd: workspaceRoot(id)})` 起脚本子进程。
- 看板 `running` 从 string 改为每工作区一项。
- 传输层消息带 workspaceId，宿主按它路由。
- 冲突消解：同一文件被两工作区同时改（不同路径，天然不冲突）；同一工作区被两会话同时操作（防御性检查）。

**阶段 3：删站点 UI**

- 侧栏 UI 移除站点选择。
- 站点适配层（deepseek / chatgpt / claude 的 DOM 选择器、油猴按 URL 识别）保留——它是「会话与站点」的底层绑定，与工作区正交。

## §5 前置决策

- **D1：工作区注册表落点**。`state.json` 加字段 / 独立 `workspaces.json` / 复用 `config.ts` 的持久化机制。建议：复用 `config.ts`（它已有 `persistWorkspace`）。
- **D2：sid 与 workspaceId 的关系**。同工作区多会话（sid 不同）？同会话跨工作区（workspaceId 变）？两者是独立维度还是绑定？建议：**独立维度**——sid 是会话，workspaceId 是工作区，一个会话可切换工作区，一个工作区可服务多个会话。
- **D3：新建工作区的方式**。`git worktree`（同仓库多分支）/ `git clone`（异仓库）/ 指向已有目录（只注册）。建议：三种都支持，UI 上分三个入口。
- **D4：并发写入策略**。同工作区同时被两会话操作时的行为：拒绝 / 排队 / 后写胜。建议：**拒绝**（后到者报冲突）——与 `overlay-atomic-v1` 的「整轮原子」语义一致。

## §6 改造清单（阶段 2）

按依赖顺序：

1. **`config.ts`**：单 root → `Map<workspaceId, Root>` + `activeWorkspaceId`。
2. **`workspace.ts`**：新增 `POST /workspace/create`（git worktree / clone / register）、`DELETE /workspace/:id`、`POST /workspace/:id/activate`。
3. **`/run` 路由**：请求体加 `workspaceId`；缺省用活跃工作区。
4. **`runProcess` 调用点**：从 `run-script` 或 `session-manager` 传 `cwd: workspaceRoot(id)`。
5. **看板 `running`**：`task-store.ts` 从 string 改为 `Record<workspaceId, string>`。
6. **`SYSTEM.md §2`**：同步 `running` 契约（宿主独占，应用端只提案）。
7. **传输层**：`/__ai/ws` 与油猴回传消息体加 `workspaceId`。
8. **UI**：`SidePane.vue` 从站点列表改为工作区列表；`TerminalPane` / `ScriptPanel` / `TaskProgressPanel` 按 workspaceId 分视图。
9. **观测层**：`logs/*.jsonl` 每条加 `workspaceId`；跨工作区聚合视图。

## §7 风险

- **`node_modules` 磁盘成本**：每工作区一份。缓解：pnpm 的 `.pnpm-store` 共享 / 限制同时活跃数 / worktree 共享 `.git`。
- **合并策略**：每工作区一个分支时，最终合并回主分支的时机、触发人、冲突处理是产品决策。
- **`.ai-runner` 状态分裂**：`lessons.md` / `skills/` 建议共享（跨工作区累积），`state.json` 按工作区分片（看板隔离）。
- **观测层缺口**：跨会话日志目前隔离；多工作区必须自带统一观测层，否则每个新会话都在同一盲区里重造轮子（AGENTS.md 已记录此模式）。
- **`instance-ownership-v1` 边界**：多工作区后，5175 的启动 / 重启是否要按工作区独立？本方案不涉及（沿用现有 pm2 托管模型）。
- **`AGENTS.md` 的加载位置**：`SYSTEM.md` 是应用级（每会话一次注入，跨工作区相同）；`AGENTS.md` 是工作区级（每工作区各一份）。宿主当前从「进程 cwd」读取 AGENTS.md——多工作区后须改为从「活跃工作区 root」读。**这是本方案的核心机制依赖**（与本会话新建的层级边界直接相关）。

## §8 明确不做

- 不重写 `runProcess`（已支持 cwd）。
- 不重写 `interceptor.cjs`（overlay 已天然 per-process）。
- 不改站点适配层（deepseek / chatgpt / claude 的 DOM 选择器保留）。
- 不做跨工作区的自动合并。
- 不改 `instance-ownership-v1`（本方案不涉及重启策略）。
- 不建新守卫——本方案落地前需先确认阶段闸门解除。

## §9 验收

- 存在 3 个工作区，可以同时活跃。
- 会话 A 在工作区 1 跑脚本，会话 B 在工作区 2 跑脚本，互不干扰。
- 会话 A 的变更集不出现在工作区 2 的视图里。
- 切换工作区后 `AGENTS.md` 加载的是该工作区的那份（应用级 / 工作区级边界生效）。
- 看板 `running` 字段在多工作区同时跑时能正确表达「谁在跑」。
- 观测层能跨工作区聚合日志。

## §10 关联

- `packages/core/SYSTEM.md` 顶部「应用级 / 工作区级」边界（本会话新增）。
- `AGENTS.md`「monorepo 结构铁律」——本方案不破坏。
- 关联机制：`overlay-atomic-v1`（§2 沙箱）、`instance-ownership-v1`（§1 实例生命周期）、`board-read-all-states-v1`（§2 看板）。
