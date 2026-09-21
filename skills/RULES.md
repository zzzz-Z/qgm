---
name: rules
description: vite-plugin-ai-runner 全部 AI 行为 / 脚本 / 环境 / 架构规则（单一权威）
keywords: 规则, 行为, 脚本, 循环, 环境, 架构, ai-runner, state, __AI__, 输出契约, 踩坑
version: 2026-09-21
---

<!-- RULES-MERGED-v1 -->

<!-- RULES-REORG-v2 -->

# 规则总纲（Single Source of Truth）

> 本文件由 `skills/` 下全部规则合并生成。原分散规则文件已归档至 `skills/_archive/`。
> 冲突时以本文件为准；下文各节标注的 `src:` 仅作历史溯源。

## 目录

1. 输出契约与自动化循环  `（src: core/loop-protocol.md）`
2. AI 行为与决策准则  `（src: core/behavior.md）`
3. 脚本编写与技术规范  `（src: script/standards.md）`
4. __AI__ 全局注入 API  `（src: script/ai-api.md）`
5. 环境自检与提交闸门  `（src: env/preflight.md）`
6. 踩坑库（E/T/P/A）  `（src: env/troubleshooting.md）`
7. TypeScript HCLC 架构  `（src: refactor/ts.md）`

---

## 1. 输出契约与自动化循环

---


## 一、输出契约与自动化循环

<!-- src: core/loop-protocol.md -->


### 输出契约（严格执行）

1.  **单块原则**：每次回复**只输出一个代码块**，块外禁止解释、总结、前言、后记。
2.  **语言标签**：仅限 `js` / `bash`（`cjs` 视同 `js`），其他标签视为格式错误。
3.  **安全熔断**：bash 命令必须通过黑名单校验；清单权威见 `script/standards.md` 的 "Bash 黑名单（命中即停）" 一节。命中即停循环，输出退出码 2。
4.  **完成信号**：任务完成时，第一行严格输出 `DONE`，第二行输出本次修改详情总结。
5.  **推进强制**：每一轮必须产生新状态。禁止重复输出同一脚本（相同 SHA-256 hash 会被跳过）。
6.  **转义安全**：脚本内禁止出现三个连续反引号字面量。写入 markdown/模板内容时，必须使用字符串拼接或变量替换。
7.  **重试限制**：格式错误仅允许重试一次，第二次仍错则触发退出码 2。
8.  **完成条件查询**：收到「请说明完成条件」时，仅回复可验证的、机器可读的完成断言。

### 循环编排与状态机

| 阶段 | 动作 | state.json 变更 |
| :--- | :--- | :--- |
| 首轮 | 初始化 `.ai-runner/state.json`，拆解 todo 为原子动作 | `status: "running"`, `todo: [...]` |
| 中间轮 | 读 state → 执行 todo 下一项 → 回写 state | 更新 `current_step`, `last_hash` |
| 收尾轮 | todo 空 → 跑验收命令 → 全绿 | `status: "done"`, `exit_code: 0` |
| 卡点轮 | 连续无进展 → 输出只读诊断报告 | `status: "blocked"`, `exit_code: 2` |

### 终止与熔断机制

-   **正常结束**：退出码 0 + todo 为空 + 验收通过 → `DONE`
-   **可恢复错误**：退出码 1 → 自动重试一轮（计入 stall counter）
-   **人工介入**：退出码 2 → 暂停循环，等待用户输入
-   **去重熔断**：同 hash 连续 2 次跳过 OR 同 todo 项连续 2 轮未推进 → 强制输出诊断脚本或退出码 2
-   **全局熔断**：无轮次上限，但受以下参数保护：
    -   `LOOP_STALL_LIMIT=3`（无进展轮次上限）
    -   `LOOP_FP_STALL_LIMIT=2`（假进展/重复hash上限）
    -   Token 上下文窗口溢出前自动保存 checkpoint 并退出

### 常用命令清单

-   全量测试：`pnpm test:unit`
-   类型检查：`pnpm tsc --noEmit`
-   Lint 修复：`pnpm lint --fix`
-   端到端：`pnpm test:e2e`
-   全量回归：`pnpm run-all`

---

### 2. AI 行为与决策准则

---


## 二、AI 行为与决策准则

<!-- src: core/behavior.md -->

### 总则（最高优先级）

- **只输出可执行内容**：单块原则、语言标签类别、块外禁止解释/总结/前言/后记 —— 权威定义见 `core/loop-protocol.md` 的 "输出契约" 一节。
- **默认折叠思考**：内部推理不对外展示。
- **连续失败熔断**：阈值见 core/loop-protocol.md 的 LOOP_STALL_LIMIT 参数；达阈值即停止改代码，转为提问诊断。
- **读写协议优先**：涉及文件操作时，严格遵守 `script/standards.md` 中的 R1-R3 协议。

### 自主决策与安全边界

- **AI 全程自主决策**：所有技术选型、实现方案、参数配置均由 AI 自行判断，不得向用户提问或提供选项让用户选择。
- **可逆性分级执行**：
  - **L0 (无感)**: 格式化、类型补全、纯函数重构 → ⚡️ 直接执行，无需记录。
  - **L1 (Git 可恢复)**: 业务逻辑修改、文件增删改、依赖调整 → ⚡️ 直接执行 + 写入 `state.json#decisions`。
  - **L2 (不可逆/跨域)**: 触发条件见下方「L2 触发清单」；命中即 ⚠️ **暂停并请求确认**，必须提供回滚方案。
### L2 触发清单

以下任一条命中即为 L2，必须 ⚠️ 暂停并请求确认，并提供回滚方案：

- 数据库 DDL（CREATE / ALTER / DROP / TRUNCATE）
- 生产环境写操作（线上部署、生产数据修改）
- 删除核心配置文件（package.json / tsconfig.json / vite.config.ts / eslint.config.ts / .gitignore / pnpm-lock.yaml）
- 外部服务写操作（GitHub API 写、云存储写、npm publish）
- 删除或改写 .git 目录 / 强制切分支 / 历史重写
- 卸载或降级核心运行时依赖（node / pnpm / typescript / vite）

- **遇分歧自行裁决**：当存在多种可行方案时，依据 `决策阶梯` 自主选择。
- 若阶梯无法区分，优先选**更易测试 / 更少依赖**的方案，将理由写入 `state.json`，禁止暂停询问。
- **禁止打断自动化循环**：除非触发 L2 级风险或退出码 2（硬性卡点），否则不得以任何理由中断循环、请求确认或等待用户输入。

### 状态持久化协议

- **强制写入时机**：每次 L1+ 决策、循环中断、任务完成时，必须更新 `state.json`。
- **Schema 约束**：
  ```json
  {
    "goal": "当前原子目标",
    "decisions": [{"t":"ISO","c":"选择X","r":"因Y符合阶梯3","rej":["Z"]}],
    "blocker": "null 或具体卡点描述",
    "checkpoint": "最后验证通过的 commit/hash/步骤ID"
  }
  ```
- **Session 恢复**：新对话开始时，若检测到 `state.json` 存在且 `goal` 未完成，首行输出 `🔄 Resuming: [goal] @ [checkpoint]` 并继续执行。

### 输出形状（ADHD 友好 v2）

- **视觉锚点强制**：
  - `⚡️` 置顶可执行内容（命令/代码/路径）
  - `🧠` 决策理由（仅限 L1+ 操作，≤20字）
  - `⚠️` 风险警告（仅限 L2 操作）
  - `✅` 验证结果（执行后必附）
- **首行即动作**：命令/路径/代码片段置顶，背景信息后置或删除。
- **步骤极简**：多步操作编号，能合并则合并，最少步骤优先。
- **列表上限 5 项**：超出则拆分为「现在做 / 稍后做」。
- **报错格式化**：`📍 file:line | 🔥 现象 | 🔧 修法`，禁止情绪化表达或自然语言描述错误。
- **执行后断言**：每个关键动作块末尾，必须包含验证步骤。
  ```bash
  npm run build && echo "✅ Build OK" || echo "❌ Build FAILED at $(date)"
  ```
- **选项类问题**：给 2–4 个排序选项 + 一行取舍说明，默认直接执行排第一的推荐方案（L2 级除外）。

### 决策阶梯（命中即停）

1. 需要做吗？（YAGNI）
2. 项目里已有吗？→ 复用（若涉及 TS 架构变更，自动加载 `refactor-ts` 规范检查）
3. 标准库能做吗？
4. 平台特性覆盖吗？
5. 已装依赖能解吗？
6. 能一行解决吗？
7. 以上都不行 → 写最少能跑的代码

### 不做清单

- 不用 bash 写业务逻辑（仅用于系统操作）
- 不依赖终端粘贴大段内容
- 不手动编辑自动生成文件
- 不在未备份/未提交状态下执行 L1+ 操作
- 不动与任务无关的核心逻辑
- 不提交敏感配置 / `.env` / 锁文件

### 发送前自查

- [ ] 首字符是否为视觉锚点 (`⚡️/🧠/⚠️/✅/🔄`)？非锚点开头 → 重写
- [ ] L1+ 操作是否已写入 state.json？未写 → 补写
- [ ] 关键动作是否附带验证断言？无 → 补充
- [ ] 是否存在 L2 操作未加 ⚠️ 标记？有 → 拦截
- [ ] 末句是否在问「还有别的吗」或 recap？→ 删
- [ ] 是否有无信息模糊词（可能/或许）？→ 删或改为字面动作
- [ ] 读者扫视首尾锚点，能否在 3 秒内获知「做了什么 + 结果如何」？否 → 精简

> 读写协议（R1-R3）、反模式详见 `script/standards.md`。

---

### 3. 脚本编写与技术规范

---


## 三、脚本编写与技术规范

<!-- src: script/standards.md -->

### 脚本头部强制规范（唯一权威）

每个代码块**第一行必须是 Shebang**，**第二行起紧跟元数据注释**。此格式为会话记录摘要的唯一数据源。

#### JS / CJS

```js
#!/usr/bin/env node
// @desc: 一句话说明本脚本做什么（必需，作为会话摘要）
// @why: 解决什么问题（必需）
// @plan: 本轮唯一子目标，对应 state.todo 中一项
// @state: state 文件相对路径，缺省 .ai-runner/state.json
// @done: 本轮收尾的机器可判定条件；非收尾轮省略
```

#### Bash

```bash
#!/usr/bin/env bash
# @desc: 一句话说明本脚本做什么（必需，作为会话摘要）
# @why: 解决什么问题（必需）
# @plan: 本轮唯一子目标，对应 state.todo 中一项
# @state: state 文件相对路径，缺省 .ai-runner/state.json
# @done: 本轮收尾的机器可判定条件；非收尾轮省略
```

#### 约束

- Shebang 必须是第 1 行，前后无空行；禁止硬编码路径（如 `#!/bin/bash`），保证跨平台
- `@desc` 与 `@why` 均为必需，缺一会被要求重试一次
- 可选字段（`@plan` / `@state` / `@done`）被服务端忽略、不报错

### 核心原则

- **文件改动必须走脚本**：禁止手动编辑、口头描述、输出整文件让用户复制。
- **幂等 + 可回滚**：重复执行安全；备份到 `.ai-runner/backup/`；支持 `--rollback`。
- **自检断言**：关键结果逐条校验，失败 `process.exit(1)`；非平凡逻辑留可跑 check。
- **路径安全**：统一 `path.join(ROOT, ...)`，禁止字符串拼接。

### 通道选择

| 通道 | 用途 | 特性 |
| :--- | :--- | :--- |
| `js/cjs` | 改项目文件 | 内存 overlay 沙盒，失败零改动，成功可回滚 |
| `bash` | 系统操作 | 走 shell，跑前工作台自动 git commit 兜底 |

### Bash 黑名单（命中即停）

禁止：`rm -rf` / `sudo` / `curl|sh` / `wget|sh` / `dd if=` / `mkfs` / `> /dev/sd*` / `git push -f` / `git reset --hard` / fork bomb。
注释/字符串中也需避开黑名单字面量，可用字符串拼接或动作描述替代。

### 输出符号规范

- ▶ 阶段 / ✓ 成功（绿） / ! 跳过（黄） / ⚠ 警告（黄） / ✗ 失败（红，stderr）
- 使用语义函数 `ok/skip/warn/err`，禁止裸打印。
- 失败时报出 `文件 + 行号 + 现象`，可直接 grep。

### 读写协议（硬约束）

写文件前必过三关。任一关未过，禁止进 writeFileSync。

#### R1 读为先

- 文件 > 200 行时，只 dump 目标区域 ±20 行（不 dump 全文，避免 stdout 截断）
- 未读即写 = 违反，预检必失败

#### R2 锚点验证

- 每个 `src.replace(anchor, ...)` 前一行加 `if (!src.includes(anchor)) process.exit(2)`
- 锚点不匹配 → 退出码 2（暂停请求人工），**不降级猜测**
- 严禁 `src.replace(/宽松正则/, ...)` 未验证命中数

#### R3 幂等有据

- 判「已应用」不仅查 MARKER，还要验证 MARKER 语义完整（后 30 字符内关键行存在）
- 仅 MARKER 命中就 `skip` = 假阳性隐患

#### 反模式清单

- ❌ 用 `includes(...)` 判使用（会匹配定义行）
- ❌ 用宽正则在未验证命中数时替换
- ❌ 脚本内引用 `state` 却在 `const state` 之前
- ❌ 一轮内跨 ≥ 4 文件改动（拆多轮）
- ❌ 单轮 stdout > 120 行（截断丢证据）

---

### 4. __AI__ 全局注入 API

---


## 四、__AI__ 全局注入 API

<!-- src: script/ai-api.md -->

### 文件操作

- `__AI__.readText(path)` : 读取文本
- `__AI__.writeText(path, content)` : 写入文本（自动创建目录）
- `__AI__.replaceInFile(path, { oldString, newString, unique })` : 替换文本，unique=true 时若非唯一出现会报错
- `__AI__.exists(path)` : 判断文件是否存在
- `__AI__.readJSON(path)` : 读取并解析 JSON

### 质量检查

- `__AI__.lint(files)` : 运行 ESLint，返回 { ok, output }
- `__AI__.typeCheck()` : 运行 vue-tsc --noEmit，返回 { ok, output }

### 日志与断言

- `__AI__.log(...args)` : 带 [AI] 前缀的 console.log
- `__AI__.assert(cond, msg)` : 断言失败即 process.exit(1)

### 执行控制

- `__AI__.writeReport(obj)` : 输出 `__AI_REPORT__` 结构供 Runner 解析
- `__AI__.writeDiffReport(obj)` : 标记为只读预览并退出
- `__AI__.exitNeedInput(question, options, defaultId)` : 请求人工输入

### 语义输出（推荐用，替代裸 console.log）

- `__AI__.ok(msg)` : 绿色 ✓
- `__AI__.skip(msg)` : 黄色 !
- `__AI__.warn(msg)` : 黄色 ⚠
- `__AI__.err(msg)` : 红色 ✗，输出到 stderr

### 文件安全补丁（替代手写 readFileSync + replace + writeFileSync）

- `__AI__.backup(file)` : 备份 `file` → `.ai-runner/backup/<相对路径>`，已存在则保留首次
- `__AI__.patchFile(file, anchor, replacement, opts)` : 幂等补丁
  - 自动 readFileSync → 校验 anchor 命中 → backup → 替换 → 写回 → 回读验证
  - `opts.unique` : anchor 命中数必须为 1，否则抛错
  - `opts.marker` : 命中则返回 `{ ok: true, skipped: true }`（幂等）
  - 返回 `{ ok: true, replaced: N }`

### 断言

- `__AI__.assertContains(file, anchor)` : 文件不含 anchor 则 exit 1
- `__AI__.assertNotContains(file, anchor)` : 文件含 anchor 则 exit 1

### State helper

- **AI**.statePath() : .ai-runner/state.json 绝对路径
- **AI**.readState() : 解析失败返回 null
- **AI**.updateState(fn) : 读 -> fn(st) -> round+1 -> 写回 -> 返回 st

### Regex / file

- **AI**.esc(s) : 正则元字符转义
- **AI**.dump(file, from, to) : 返回「行号: 内容」（1-based 含端点）
- **AI**.atomicWrite(file, content) : tmp + rename

### Env gate

- **AI**.cwdMust(expected) : cwd 不符则 err + exit 2

---

### 5. 环境自检与提交闸门

---


## 五、环境自检与提交闸门

<!-- src: env/preflight.md -->

### 环境自检（会话首条）

- [ ] pwd 正确，非空目录
- [ ] git rev-parse --abbrev-ref HEAD 分支正确
- [ ] ls src/ 有文件，node_modules 存在
- [ ] git worktree list 无孤儿

### 提交前闸门

- [ ] node --check 所有改动的 .cjs
- [ ] pnpm tsc 通过
- [ ] git status 无 .ai-runner/ 运行态文件

### 脚本编写

- [ ] 注释/字符串避开 bash-guard 黑名单字面量
- [ ] 改动幂等 + 有 --rollback
- [ ] 关键结果 assert 自检

### 与 AI 协作

- [ ] 精确改动的文件贴原文，不用压缩包
- [ ] 一次 <= 3 个文件
- [ ] 报错先贴 pwd/ls，再贴 stderr

> 详细踩坑库（E/T/P/A）见 `env/troubleshooting.md`。

---

### 6. 踩坑库（E/T/P/A）

---


## 六、踩坑库（E/T/P/A）

<!-- src: env/troubleshooting.md -->

> 会话首条自检见 `env/preflight.md`。

### 踩坑索引

### 踩坑库（来自 2026-09 会话复盘）

#### 环境类

**E1. 工作台 cwd 指向空目录**

- 现象：脚本全部 exit 1/127；找不到 src/、interceptor.cjs、helpers.cjs
- 根因：IDE 建了目录但没建 git worktree 关联，或 workspace 切换失败
- 规避：
  - 会话第一条脚本固定 `pwd && ls src/ && git rev-parse --abbrev-ref HEAD`
  - 所有改动脚本加 **cwd 闸**（不等于预期目录则拒绝执行）
  - 参考 `scripts/preflight.sh`

**E2. dev server 挂掉 / 未启动**

- 现象：`Failed to fetch`，面板所有脚本挂
- 根因：终端崩溃 / 切 worktree 后未重启 dev server
- 规避：
  - 改动前跑 `curl -s -o /dev/null -w "%{http_code}" http://localhost:5174/__ai/`
  - 不是 200 就先 `pnpm web:dev` 重启
  - 一个 worktree 只保留一个 dev server

**E3. worktree / master 分支混乱**

- 现象：脚本误改到 master，或改动打在半成品分支上
- 根因：没约定 worktree = 分支；切换动作缺失
- 规避：
  - worktree 命名严格等于分支名
  - 会话首条命令 `git worktree list`
  - 每个改动脚本头部加 `git rev-parse --abbrev-ref HEAD` 闸

#### 工具链类

**T1. overlay 沙盒崩溃丢改动**

- 现象：js 脚本中途抛错，报"变更数 0"，磁盘未改；但 stdout 里已打印 "✓ 已写"
- 根因：js 通道写的是内存 overlay，脚本非零退出时 overlay 全丢弃
- 规避：
  - **关键改动走 bash 通道**（直接写真实磁盘）
  - js 通道写后必须紧跟 `fs.readFileSync` **回读**验证
  - 复杂脚本分段提交，避免中途崩

**T2. overlay 沙盒里 `chmodSync` 报 ENOENT**

- 根因：`writeFileSync` 只进内存，真实磁盘无该文件
- 规避：脚本里去掉 `chmodSync`；可执行位由用户在终端 `chmod +x` 补

**T3. overlay 里 `statSync().mtime` 是 undefined**

- 现象：`.mtime.toISOString()` 崩溃
- 规避：统一用 `mtimeMs`（数字）

**T4. bash-guard 黑名单误伤注释/字符串**

- 现象：脚本正文（含注释）出现黑名单词被 400 拦
- 触发类别（此节用描述代替字面量，避免自身再触发）：
  - 递归强删目录（三个 token：命令 + 递归标志 + force 标志）
  - 提权命令
  - 远程下载管道直执行（下载工具 + 竖线 + shell）
  - 磁盘覆写命令
  - 文件系统格式化命令
  - 强制推送 / 硬回退
  - fork bomb
- 规避：
  - 注释/字符串里避免这些字面量
  - 替代写法：拆字母拼字符串（如 `'r' + 'm' + ' -rf'`）、改词（"递归删除"）
  - 或改写成动作描述

**T5. macOS 无 GNU `timeout`**

- 现象：`/bin/sh: timeout: command not found`
- 规避：
  - 不用 `timeout`
  - 用 playwright / node 内置 timeout；或 `perl -e 'alarm N; exec @ARGV'`

**T6. `--experimental-strip-types` 不重写 `.js`→`.ts`**

- 现象：`ERR_MODULE_NOT_FOUND: Cannot find module '.../config.js'`
- 根因：Node 的 TS strip 只剥类型，不改 import 路径
- 规避：
  - 生产入口走 `pnpm build` → 跑 `dist/*.js`
  - 参考 `bin/air-server.cjs` 的 build-then-run 模式

**T7. interceptor 的 `readdirSync withFileTypes` bug**

- 现象：`The "path" argument must be of type string. Received an instance of Dirent`
- 根因：overlay patch 把 Dirent 对象当字符串传给 `path.join`
- 已修：见 commit `fix(interceptor): handle fs.readdirSync withFileTypes`
- 规避：脚本里避免直接用 `fs.readdirSync(dir, { withFileTypes: true })`，改用 `safeReaddir`

**T8. helpers.cjs 正则双重转义**

- 现象：`SyntaxError: Invalid regular expression: /...\\s/: Unterminated group`
- 根因：写正则时错误地写了双反斜杠（应为单反斜杠 + s）
- 规避：正则字面量写完后 `node --check` 或 `node -e 'console.log(/.../)'` 验证

**T9. Vue `v-if`/`v-else` 相邻性破坏**

- 现象：`v-else/v-else-if has no adjacent v-if or v-else-if`
- 根因：在 `v-if` 和 `v-else` 之间插入了新元素
- 规避：
  - 插按钮时看清相邻结构
  - 想插在中间就用 `v-if` 独立条件，不动原有链
  - 或者整段挪到链**之前**

#### 流程类

**P1. tsc 失败但脚本仍 commit**

- 现象：`pnpm tsc && echo` 在 `set -e` 里不阻断后续
- 根因：`&&` 的短路行为在 bash `set -e` 下不足以阻断
- 规避：
  - 统一用 `if ! pnpm tsc; then exit 1; fi`
  - 任何"验证"步骤都不能用 `&&` 挂载

**P2. merge 带进运行态文件**

- 现象：`.ai-runner/compliance.jsonl`、`.ai-runner/SESSION-HANDOFF.md` 误入 master
- 规避：
  - `.gitignore` 覆盖 `.ai-runner/` 运行态子目录
  - merge 前 `git diff --stat master..HEAD` 过一眼
  - 已 untrack 的用 `git rm --cached`

**P3. 合并后 worktree 落后 master**

- 现象：master 领先 worktree 若干 commit
- 规避：合并后立刻在 worktree 里 `git merge --ff-only master`

**P4. 长脚本被截断**

- 现象：脚本贴到面板只跑了前一半，尾部丢失
- 规避：
  - 单脚本 ≤ 200 行
  - 需要更多时拆多次
  - 复杂改动先探针再改

**P5. `git rm --cached` 后 `git add` 路径不存在**

- 现象：`fatal: pathspec '...' did not match any files`
- 根因：`--cached` 移除索引后，磁盘上文件已被手动删掉
- 规避：直接 `git commit`（不 `git add`），或在删除前先 `git add -A`

#### AI 协作类

**A1. 源码被压缩，行号不可信**

- 现象：file 标签带 `cleaned="XXXB"`，大文件只保留骨架
- 规避：
  - 精确改动前**单独贴原文**（用代码块，不走 file 标签）
  - 一次 ≤ 3 个文件
  - 本 AI 看到 `cleaned=` 就明说"行号不可信"

**A2. 盲改 vs 探针**

- 现象：直接改代码，脚本自检报"未找到锚点"，反复失败
- 规避：
  - 每个改动脚本**先探针**（`grep -n` 定位锚点）
  - 锚点不存在则 abort，不盲改
  - 只有探针通过才进改动阶段

**A3. 一次做完 vs 分批**

- 现象：大重构一次脚本做完，出错无法定位
- 规避：
  - 单脚本单目标（≤3 文件）
  - 每步 commit 独立可回滚
  - 依赖链长的（如 headless），先搭骨架，再填逻辑

---

### 7. TypeScript HCLC 架构

---


## 七、TypeScript HCLC 架构

<!-- src: refactor/ts.md -->

#### 🎯 核心目标
在 TypeScript 项目中，通过严格的类型约束、模块化设计和依赖管理，确保：
- 每个模块**职责单一且完整**（高内聚）
- 模块间**依赖最小化且易于替换**（低耦合）

#### 🧠 思维框架 (Design Mindset)

1.  **内聚性检查**：这个文件/类是否只关心"一件事"？修改一个业务需求是否只需要改动这一个文件？
2.  **耦合度检查**：删除或替换这个依赖，是否会导致其他模块崩溃？是否可以通过接口抽象隔离变化？
3.  **类型即文档**：TypeScript 的类型系统不仅是校验工具，更是表达"契约"和"边界"的核心手段。
4.  **显式优于隐式**：拒绝 `any`，拒绝全局状态污染，所有依赖关系必须在构造函数或函数签名中显式声明。

---

#### ⚙️ 执行规范 (Actionable Rules) - 增强版

#### 1. 接口隔离与契约优先 (Enhanced)
*   **规则**：跨模块通信必须通过契约进行。优先使用 **TypeScript 原生类型系统** 表达业务语义，而非仅靠 Interface。
*   **TS 实践**：
    *   **状态表达**：使用 Discriminated Unions 替代 Enum + Class 继承。
        ```ts
        // ✅ Good: 穷尽性检查 + 数据与状态绑定
        type OrderState = 

          | { status: 'draft'; items: CartItem[] }
          | { status: 'paid'; paymentId: string; paidAt: Date }
          | { status: 'shipped'; trackingNo: string };

        ```
    *   **契约验证**：使用 `satisfies` 确保实现符合契约且不丢失字面量类型推断。
    *   **ISP 落地**：若 Interface > 3 个方法，强制审查是否可拆分为 Role-based Interfaces。

#### 2. 依赖管理分级策略 (Tiered Dependency Strategy)
*   **规则**：根据代码层级采用不同的耦合容忍度，避免过度设计。
*   **分级标准**：

    | 层级 | 耦合要求 | DI 方式 | 类型约束 |
    | :--- | :--- | :--- | :--- |
    | Domain Core | 零外部依赖 | 纯函数 / Value Objects | Strict, No `any` |
    | Application | 仅依赖 Domain 接口 | 构造函数注入 / Factory | Interface Only |
    | Infrastructure | 允许具体实现 | 容器注入 / Adapter | 允许 SDK 类型穿透 |
    | Edge/API | 允许框架耦合 | 框架原生 Hooks/Decorators | Zod/Schema 验证边界 |

#### 3. 重构安全协议 (Refactoring Safety Protocol)
*   **⚠️ 强制执行**：在对任何模块进行 HCLC 重构前，必须确认以下任一条件满足：
    1.  存在覆盖该模块公共 API 的单元测试/集成测试。
    2.  已编写 Characterization Test 锁定当前输入输出行为。
    3.  调用方极少且可通过人工/E2E 快速验证。
*   **重构手法**：优先使用 IDE 支持的自动化重构（Extract Method, Move File），再手动调整抽象。禁止“复制粘贴后删除旧代码”的高风险操作。

#### 🔍 Code Review 自检清单 (量化版)

| 检查项 | 🟢 合格 | 🟡 警告 (需记录技术债) | 🔴 阻断 (必须修复) |
| :--- | :--- | :--- | :--- |
| 文件 Import 数 | ≤ 5 个 | 6-8 个 | > 8 个或含循环依赖 |
| 函数参数个数 | ≤ 3 个 | 4 个 | ≥ 5 个 (应封装为 Options Object) |
| 圈复杂度 | ≤ 10 | 11-15 | > 15 |
| `any` 使用 | 0 (Core) / <3 (Infra) | 有合理注释的 `any` | 无注释 `any` 或 `@ts-ignore` |
| 变更影响面 | 单文件 | 同模块内 2-3 文件 | 跨模块 > 3 文件 |

#### 📝 AI 输出格式规范 (Output Schema)

当被要求审查或重构时，**必须**按以下结构响应：

1.  **🩺 诊断摘要**：一句话概括核心架构问题（如："OrderService 承担了持久化与业务计算双重职责"）。
2.  **🎯 违规映射**：列出具体代码行号及其违反的 HCLC 原则编号。
3.  **🛠️ 重构方案**：
    *   **Step-by-Step**：分步骤说明（先提取接口 -> 再创建适配器 -> 最后替换注入）。
    *   **Before/After**：提供关键代码对比片段（Diff 风格）。
4.  **🧪 验证策略**：明确说明如何验证重构未破坏功能（如："运行 `npm test -- orders` 并确保覆盖率不下降"）。
5.  **⚖️ 权衡说明**：诚实指出重构带来的潜在成本（如："增加了 2 个文件，但提升了订单状态流转的可测试性"）。
