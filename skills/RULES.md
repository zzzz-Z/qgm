---
name: rules
description: 项目唯一规则来源（Single Source of Truth）
version: 2026-09-24-v4
---

# 规则总纲（Single Source of Truth）
> 冲突时以本文件为准。会话首轮加载顺序：AGENTS.md → 本文件 → 当前任务。
> AGENTS.md 缺失仅警告，不中断。

## 一、输出契约（JS-Only Absolute Contract）

### 1.0 绝对围栏
-   **单块纯化**：每次回复**只输出一个可直接运行的cjs代码块**
-   **首字符**：回复第一个非空字符必须是 ```js
-   **尾字符**：回复最后一个非空字符必须是独立的 ```
-   **零溢出**：代码块外部禁止任何字符（含问候、解释、Markdown、多余换行）
-   **文本输出**：问题以@ask开头 则不输出代码块 输出文本或md 
### 1.1 内容约束
-   **注释替代**：所有解释/推理/TODO/摘要必须以  /* */ 写在代码块内部
-   **完成信号（// DONE）**：
    - `// DONE` 仅用于**整个任务收尾轮**
    - **单轮脚本执行成功不是任务完成**：单轮成功应使用 `__AI__.ok(...)` 上报，不得输出 `// DONE`
    - 任何中间轮（诊断、修复、验证）一律禁止输出 `// DONE`
    - 不确定是否满足收尾条件时，默认不输出 `// DONE`，继续循环
    - 违反本条视为提前结束循环，runner 可标记 blocked 并 exit 2
-   **验证正则**：发送前自检 /^```js\n[\s\S]*\n```$/；未通过 → 重试 1 次 → 仍失败则输出标准错误对象（见 1.3）

### 1.2 推进强制
-   每轮新状态；同 SHA-256 跳过；格式错仅重试一次
-   完成条件查询仅返回机器可读断言（JS 对象）


### 1.3 脚本头契约（Script Head Contract）
> [script-head-contract-v1] 由 ai-guard.ts#scanScriptHead + run-script.ts 强制；缺失即 exit 2。

-   **Shebang（唯一合法）**：#! /usr/bin/env node
    -   其他 shebang（bash/sh/zsh/python 等）→ 拒绝执行，错误码 ILLEGAL_SHEBANG
    -   无 shebang：默认按 node 处理（runner 自动补），不视为违规
-   **必需字段**（缺一即拒）：
    -   // @desc <做什么>（≤200 字符）
    -   // @why <为什么>（≤200 字符）
-   **可选字段**：@plan / @state / @done / @mode / @ctx / @changes / @todo
    -   @mode: diff → 只读预览（对应 __AI__.writeDiffReport）
    -   @ctx: full → 输出不裁剪
    -   @changes: <路径列表> → 声明本轮预期变更文件
## 二、循环状态机与熔断

### 2.1 状态流转
| 阶段   | 动作                     | state.json         |
|--------|--------------------------|--------------------|
| 首轮   | 初始化 + 拆解 todo       | status: running    |
| 中间轮 | 读 state → 执行 → 回写   | current_step 更新  |
| 收尾轮 | todo 空 → 验收全绿       | status: done, exit 0 |
| 卡点轮 | 无进展 → 输出 1.3 错误对象 | status: blocked, exit 2 |

### 2.2 熔断阈值
-   LOOP_STALL_LIMIT=3 / LOOP_FP_STALL_LIMIT=2
-   同 hash/todo 连续 2 轮未推进 → exit 2
-   Token 溢出前强制 checkpoint

## 三、AI 行为准则

### 3.1 自主决策
-   全程自主，不问用户；L0 ⚡️ 直接执行 / L1 ⚡️ 执行 + 写 state / L2 ⚠️ 暂停确认 + 回滚方案
-   分歧按决策阶梯裁决：YAGNI → 复用 → 标准库 → 平台特性 → 已装依赖 → 一行解 → 最少代码
-   除 L2 或 exit 2 外，禁打断循环

### 3.2 状态持久化
-   L1+ 决策/中断/完成 → 必写 state.json { goal, decisions[], blocker, checkpoint }
-   Session 恢复 → 首行注释 // Resuming: [goal] @ [checkpoint]

### 3.3 输出形状（ADHD v2）
-   锚点注释：// ⚡️ 动作 / // 🧠 理由 / // ⚠️ 风险 / // ✅ 验证
-   报错：// 📍file:line | 🔥现象 | 🔧修法
-   关键动作必附验证断言

### 3.4 不做清单
-   不贴大段内容；不手编自动生成文件；未备份不做 L1+；不动无关核心；不提交敏感文件
-   禁 as any / as unknown as（除非注释理由）；union 类型只定义一次

### 3.5 发送前自查
[ ] 首尾围栏正确 [ ] 块外零字符 [ ] 通过验证正则 [ ] L1+ 已写 state [ ] 关键动作有验证 [ ] L2 有 ⚠️ [ ] 无原生模块调用 [ ] 3 秒获知结果

## 四、__AI__ API（强制运行时沙箱）

> ⛔ **绝对禁令**：禁止 require/import fs / path / child_process / os / process
> 所有副作用操作**必须且只能**通过 __AI__ 命名空间。
> 检测正则（发送前自检）：/\b(require\s*\(\s*["']fs["']|import[^;\n]*from\s+["']fs["']|fs\.|path\.|child_process\.|process\.exit)\b/

### 4.1 安全封装（Bash 黑名单下沉至此）
__AI__.shell(cmd) 内置拦截；以下模式无论是否拼接均拒绝执行并返回 1.3 错误：
rm -rf / sudo / curl|sh / wget|sh / dd / mkfs / >/dev/sd* / git push -f / git reset --hard / fork bomb / chmod 777

### 4.2 API 映射表（Native → __AI__）
> [rules-4.2-sync-v2] 由 helpers.cjs 的 `__AI__` 顶层对象反向生成；覆盖 54 个公开 key。
> 每次改动 helpers.cjs 后须重跑同步。

**文件读**

| ❌ 禁用 (Native) | ✅ 强制 (__AI__) | 备注 |
|---|---|---|
| fs.readFileSync(p, "utf8") | __AI__.readText(p) | 同步读文本 |
| fs.readFileSync(p) + try/catch | __AI__.tryReadFile(p) | { ok, content|error } |
| fs.readFileSync(p) 别名 | __AI__.readFile(p) | 等价 readText |
| JSON.parse(fs.readFileSync(p)) | __AI__.readJSON(p) | JSON 读，错误带文件名 |
| statSync 比 mtime/size | __AI__.fileSig(p) | "mtimeMs:size" 字符串 |
| 读缓存命中判断 | __AI__.readIfChanged(p) | { content, changed, sig } |

**文件写**

| ❌ 禁用 (Native) | ✅ 强制 (__AI__) | 备注 |
|---|---|---|
| fs.writeFileSync(p, s) | __AI__.writeText(p, s) | 自动建目录 + changelog |
| fs.writeFileSync(p, s) 别名 | __AI__.writeFile(p, s) | 等价 writeText |
| 写 tmp + rename 原子落盘 | __AI__.atomicWrite(p, s) | 防中断损坏 |
| copyFileSync 到 .ai-runner/backup | __AI__.backup(p) | 幂等备份 |
| 字符串 split/join + writeFileSync | __AI__.patchFile(f, anchor, next, opts) | R2 锚点 + 唯一性 + 回读 |
| str.replace + 唯一性校验 | __AI__.replaceInFile(p, { oldString, newString, unique }) | 整串替换 |

**文件系统查询与遍历**

| ❌ 禁用 (Native) | ✅ 强制 (__AI__) | 备注 |
|---|---|---|
| fs.existsSync(p) | __AI__.exists(p) | 布尔返回 |
| fs.readdirSync(p) | __AI__.listDir(p) | { name, isDir, isFile }[] |
| fs.rmSync(p, { recursive }) | __AI__.deleteFile(p) | 递归删 + changelog |
| 递归遍历目录 | __AI__.walk(dir, { ext, maxDepth, skip }) | 内置跳过 node_modules/.git |
| glob 批量读文件 | __AI__.readFiles(glob) | glob: **/*.ts 等 |

**检索与定位**

| ❌ 禁用 (Native) | ✅ 强制 (__AI__) | 备注 |
|---|---|---|
| grep -rn | __AI__.grep(pattern, { dir, ext, max }) | { file, line, text } |
| 精确符号查找 | __AI__.symbol(name, opts) | grep 的转义版 |
| sed -n "s,e p" | __AI__.dump(file, from, to) | 行区间文本 |
| awk NR 上下文窗口 | __AI__.dumpCtx(file, line, n) | line±n 文本 |
| 查看 .vue 的 <template> 段 | __AI__.template(file) | 模板段文本 |
| 模板中是否引用某名字 | __AI__.usedInTemplate(file, names) | 命中名字列表 |
| 正则元字符转义 | __AI__.esc(s) | 安全拼接正则 |

**状态（state.json）**

| ❌ 禁用 (Native) | ✅ 强制 (__AI__) | 备注 |
|---|---|---|
| 读 .ai-runner/state.json | __AI__.readState() | JSON 解析；失败 null |
| state.json 绝对路径 | __AI__.statePath() | .ai-runner/state.json |
| 写 .ai-runner/state.json | __AI__.updateState(fn) | fn(st) + round++ + 环境字段 |

**执行与断言**

| ❌ 禁用 (Native) | ✅ 强制 (__AI__) | 备注 |
|---|---|---|
| execFileSync(cmd, args) | __AI__.exec(cmd, args, opts) | 统一执行入口 |
| 所有 shell 调用 | __AI__.shell(cmd, opts) | 黑名单拦截（rm -rf / sudo / …） |
| node_modules/.bin/eslint | __AI__.lint(files) | lint 包装 |
| node_modules/.bin/vue-tsc | __AI__.typeCheck() | 类型检查包装 |
| new vm.Script 语法检查 | __AI__.syntaxCheck(code, filename) | 不执行只解析 |
| throw / 退出码 1 | __AI__.assert(cond, msg) | 不符即 exit 1 |
| 退出码控制 | __AI__.exit(code, msg) | 可选打印后退出 |
| cwd 一致性校验 | __AI__.cwdMust(expected) | 不符即 exit 2 |
| cwd / branch 上下文断言 | __AI__.assertCtx({ cwd, branch }) | 不符即 exit 2 |
| 写后断言含 / 不含 | __AI__.assertContains(f, s) / __AI__.assertNotContains(f, s) | 不符即 exit 1 |
| 自查 .vue 是否有 defineOptions | __AI__.assertVueHasName(file) | 缺则 exit 1 |

**输出协议（供 runner 解析）**

| ❌ 禁用 (Native) | ✅ 强制 (__AI__) | 备注 |
|---|---|---|
| console.log/error | __AI__.ok / __AI__.skip / __AI__.warn / __AI__.err | 带 ✓/!/⚠/✗ 前缀 |
| console.log 加前缀 | __AI__.log(...args) | "[AI]" 前缀 |
| 结构化上报 | __AI__.writeReport(obj) | __AI_REPORT__<JSON> |
| 只读预览模式 | __AI__.writeDiffReport(obj) | __AI_MODE_DIFF__ + 退出 |
| 交互式询问 | __AI__.exitNeedInput(q, opts, def) | __AI_RUNNER_DECISION__ + exit 2 |
| 请求外部文件 | __AI__.exitNeedFiles(paths) | __AI_NEED_FILES__ + exit 4 |

**上下文辅助**

| ❌ 禁用 (Native) | ✅ 强制 (__AI__) | 备注 |
|---|---|---|
| child_process + headless CLI | __AI__.browser.cssom(url, sel) | CSSOM 查询 |
| headless 截图 | __AI__.browser.screenshot(url, sel, out, mask) | 截图到文件 |
| process.cwd() | __AI__.getProjectRoot() | 语义化根路径 |
| process.env.AI_RUNNER_CHANGED | __AI__.getChangedFiles() | 本轮已变更文件 |
| 跨平台路径拼接 | __AI__.join(...parts) | path.join 的封装 |
| 读缓存 / 清缓存 | __AI__.readCacheMap() / __AI__.clearReadCache() | 同进程内读去重 |

> 若某 `__AI__` 函数在运行时不存（非 AI 遗忘），按 §4.3 降级协议先注 `// ⚠️ not found` 再用原生，并写 state.json#blocker。

### 4.3 注入与降级
-   Runner 必须在执行前注入 __AI__ JSDoc 签名
-   未注入 → AI 输出 { error: "API_MISSING", exitCode: 2 }
-   仅当函数确实不存在于运行时，允许降级：先注释 // ⚠️ fallback，再用原生，同时写 state.json#blocker

## 五、读写协议（R1-R3）

-   **R1 读为先**：改前必读；>200 行只 dump ±20 行；未读即写 → precheck fail
-   **R2 锚点验证**：patchFile 前验 anchor 存在；不存在 → exit 2；禁宽松正则未验命中数
-   **R3 幂等有据**：判已应用需验 MARKER 语义完整（后 30 字符关键行存在）

## 六、环境与提交闸门

### 6.1 会话首条自检
[ ] pwd 正确 [ ] 分支正确 [ ] packages/ 存在 + node_modules [ ] worktree 无孤儿

### 6.2 提交前闸门
[ ] node --check 改动 .cjs [ ] pnpm tsc 通过 [ ] git status 无 .ai-runner/ 运行态文件
> [rules-drift-fix-v1] 闸门载体：scripts/verify-contracts.cjs（契约校验）+ 本清单（人工自查）。
> pre-commit hook 为可选增强（未安装 husky/lint-staged 时不视为违规）。

## 七、踩坑库索引（E/T/P/A）
> 详细案例见 .ai-runner/pitfalls/，此处仅保留检索键

-   **E 环境**: E1-cwd 空 / E2-devserver 挂 / E3-worktree 混乱
-   **T 工具**: T1-overlay 丢改动 / T4-bashguard 误伤 / T6-strip-types / T9-vue-vif 破坏
-   **P 流程**: P1-tsc 失败 commit / P2-merge 运行态 / P3-worktree 落后 / P4-长脚本截断
-   **A 协作**: A1-压缩行号 / A2-盲改 vs 探针 / A3-分批原则

## 八、TS HCLC 架构

-   跨模块走契约；状态用 Discriminated Unions；satisfies 验实现
-   依赖分级：Domain Core(零依赖) → Application(仅 Domain 接口) → Infrastructure(允许 SDK) → Edge(API+Zod)
-   重构安全：必有测试 / Characterization Test；优先 IDE 自动化重构
-   CR 量化（Domain Core 严格档）：Import ≤ 5 / 参数 ≤ 3 / 圈复杂度 ≤ 10 / any = 0
-   CR 量化（Application/Infrastructure/Edge 宽档）：Import ≤ 9 / 参数 ≤ 4 / 圈复杂度 ≤ 15 / any 需注释理由
    > [rules-drift-fix-v1] 分档依据：Core 是零依赖层，其他层天然高扇入（run.ts 路由聚合 = 9、run-script.ts 编排 = 7）。
    > [rules-barrel-exempt-v1] barrel 豁免：`*/routes/index.ts`、`*/server/index.ts`、`*/index.ts` 等聚合入口的 import 数不设上限（其职责就是 re-export 与装配）。
    > 判定：文件名匹配 `index.ts|barrel.ts` 且首行注释含 `barrel` / `聚合` / `re-export` 关键字，即视为豁免对象。

## 九、UI/CSS/Vue 速查

-   排查：DevTools Elements → Styles → grep 源码 → 一处一改强刷
-   禁：截图猜色 / 改容器背景 / 改全局变量 / 删主题
-   三环境：Node.cjs(工作台) / Browser(Console) / Shell(__AI__.shell 封装)
-   AI 协作：先 grep 再改；一轮一处；改完 tsc；不确定出只读诊断(JS 对象)

## 十、文件内分区（TS/Vue）
import → Vue 宏 → 类型 → 常量 → ref/reactive → computed → watch/onMounted → function → export
-   固定顺序；同类聚合；function 声明；节间空一行
-   跨模块 UI 共享状态（主题/布局/宽高/折叠）仅 packages/client/stores/runtime.ts（useStorage）；禁散落 ref
-   领域内组合式状态归属自身 composable：loopPaused 定义于 packages/client/composables/ai/useAiWaiting.ts
    > [rules-drift-fix-v1] 归属判据：先问「是否被 3 个以上非本域模块读写」→ 是 → runtime.ts；否则留原 composable。

## 十一、代码风格与注释

-   catch 不吞错误；可忽略需注释理由
-   标记 [fix-xxx-v1] >5 处抽常量/函数
-   参数 >2 用 options object
-   外部数据过 Zod；布尔 is/has/can/should；时间 timeoutMs/durationSec；集合复数
-   注释：函数一句话做什么 / 变量一句话是什么 / 复杂逻辑为什么 / 禁复述代码 / jsdoc 类型