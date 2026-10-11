# 多工作区方案（计划）

- **性质**：应用端提案（待宿主 / 用户拍板），**未开工**。
- **实施状态（2026-10-11 更新）**：用户已拍板，分支 `feat/multi-workspace` 已落地
  **阶段 1 全部 + 阶段 2 核心链路**：工作区注册表（config.ts，幂等入册 / 激活 / 拒移活跃项）、
  `/run` 带 `workspaceId`（缺省活跃项，未知 id 404）、ALS root 作用域（`workspace-scope.ts`，
  103 处 getRoot 消费点与 8 处 env 旁路零改语义即获得按请求隔离）、左栏站点列表改工作区列表
  （AiWindowList.vue + useWorkspaces.ts）。未做：传输层（油猴 / 无头）消息带 workspaceId、
  看板 `running` 每工作区一项（SYSTEM.md §2 宿主契约，只提案）、git worktree / clone 式新建（D3 另两入口）。
- **关联**：`packages/core/SYSTEM.md` 顶部「应用级 / 工作区级」边界（本会话新增）。
- **闸门**：属新功能，撞阶段闸门（`bin/check-status.cjs` 报 `prompt-budget 2/3`，规则「≥ 2 周不做新功能」）。
  用户已显式授权开工（2026-10-11）。

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
- UI 是单工作区视图（站点列表在 `AiWindowList.vue`（ScriptPanel 左栏），**不是** SidePane——
  SidePane 是 tree/changes/worklog/kb/terminal 标签页；站点切model的会话逻辑在 `useAiSite.ts` / App.vue）。
- 看板 `running` 是 `string`（SYSTEM.md §2 契约），多工作区同时跑时需要改成每工作区一项。
- `tasksBySid` 按 sid 分桶，sid 与 workspaceId 是两个维度——需明确工作区切换时 sid 是否新建。
- 传输层（油猴 / 无头）回传消息不带 workspaceId。
- **`getRoot()` 调用面（2026-10-11 实测）**：103 处消费、38 个文件；另有 **8 处 env 旁路**
  （snapshot / tsc / lint / overlay / compliance / error-files / plan-parser / error-fingerprint / file-index
  直接读 `process.env.AI_RUNNER_ROOT`，import 不到 config）——单宿主并发时 post-run 会解析到错误 root，
  这是比「config.ts 单值改多值」更大的隐藏改造面（解法见 §5 D5）。
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
- **D5（2026-10-11 新增，可行性分析结论）：root 解析策略**。103 处 `getRoot()` + 8 处 env 旁路逐点穿参不可行（改动面失控）；
  采用 **AsyncLocalStorage 作用域**：`/run` 解析 workspaceId 后把执行链包进 `runWithWorkspace()`，
  `getRoot()` 与 8 处本地 resolver 改读「ALS store → env → cwd」逐级回落——调用点零改动即按请求隔离，
  并发运行不串台。落地：`packages/core/src/workspace-scope.ts`。

## §6 改造清单（阶段 2）

按依赖顺序：

1. **`config.ts`**：单 root → `Map<workspaceId, Root>` + `activeWorkspaceId`（✅ 已落地；activate 仍落 `setRoot` 原语，103 处消费点语义不变）。
2. **`workspace.ts`**：新增 `POST /workspace/create`（git worktree / clone / register）、`DELETE /workspace/:id`、`POST /workspace/:id/activate`（✅ 已落地 register / activate / remove / registry 四端点；create 的 worktree / clone 入口未做）。
3. **`/run` 路由**：请求体加 `workspaceId`；缺省用活跃工作区（✅ 已落地；未知 id 404）。
4. **`runProcess` 调用点**：从 `run-script` 或 `session-manager` 传 `cwd: workspaceRoot(id)`（✅ 经 D5 ALS 隐式生效，`run-script.ts` 的 `getRoot()` 自动按作用域解析）。
5. **看板 `running`**：`task-store.ts` 从 string 改为 `Record<workspaceId, string>`（未做——SYSTEM.md §2 宿主契约，只提案）。
6. **`SYSTEM.md §2`**：同步 `running` 契约（宿主独占，应用端只提案）（未做）。
7. **传输层**：`/__ai/ws` 与油猴回传消息体加 `workspaceId`（未做；沙箱子进程已注入 `AI_RUNNER_WORKSPACE_ID` env 供后续接线）。
8. **UI**：左栏从站点列表改为工作区列表——**实际文件是 `AiWindowList.vue`（ScriptPanel 左栏）而非 SidePane**（✅ 已落地，配 `useWorkspaces.ts`；原承重测试 `aiwin-collapse.node-test.ts` 的 aria 断言同步更新）。
9. **观测层**：`logs/*.jsonl` 每条加 `workspaceId`；跨工作区聚合视图（runner 通道已带 runId/sid，workspaceId 接线未做）。

## §7 风险

- **`node_modules` 磁盘成本**：每工作区一份。缓解：pnpm 的 `.pnpm-store` 共享 / 限制同时活跃数 / worktree 共享 `.git`。
- **合并策略**：每工作区一个分支时，最终合并回主分支的时机、触发人、冲突处理是产品决策。
- **`.ai-runner` 状态分裂**：`lessons.md` / `skills/` 建议共享（跨工作区累积），`state.json` 按工作区分片（看板隔离）。
- **观测层缺口**：跨会话日志目前隔离；多工作区必须自带统一观测层，否则每个新会话都在同一盲区里重造轮子（AGENTS.md 已记录此模式）。
- **`instance-ownership-v1` 边界**：多工作区后，5175 的启动 / 重启是否要按工作区独立？本方案不涉及（沿用现有 pm2 托管模型）。
- **`AGENTS.md` 的加载位置**：`SYSTEM.md` 是应用级（每会话一次注入，跨工作区相同）；`AGENTS.md` 是工作区级（每工作区各一份）。
  **2026-10-11 取证修正**：core 代码里并没有「宿主从进程 cwd 读 AGENTS.md」的运行时实现
  （只有 `workspace.ts` 的 `hasAgents` 探测与 docs 检索器读 `docs/`）——该注入发生在 harness 层。
  因此「宿主改为按活跃工作区读 AGENTS.md」不是代码改造项，而是 harness 侧需要跟进的层级约定；
  应用侧能保证的是：`/workspace/activate` 切换 root 后，工作区级的 `.ai-runner` 状态
  （state.json / scripts / snapshots / 日志）天然随 root 分片（✅ 已随 ALS 落地）。

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
