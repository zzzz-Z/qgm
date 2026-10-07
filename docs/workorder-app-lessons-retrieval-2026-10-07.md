# WO-20261007-09：lessons 检索化（知识整合计划 · 阶段 B）

> **v2 修订（2026-10-07，宿主侧）**：并入应用端《工单核对结论》的 6 项偏差/优化点。
> 逐条裁决见 **段 −1**；正文按裁决更新（段〇切分口径、段一抽取边界、段四判据落点与硬约束）。
> 核心结论：**应用端 6 项引用全部属实**；其中 A 项（复用共享解析模块）动机成立但**路径需修正**（详见段 −1 A）。

| 项         | 值                                                                                                                                                                    |
| :--------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **编号**   | `WO-20261007-09`（v2）                                                                                                                                                |
| **标题**   | lessons 检索化——把「尾截断注入 5.3%」改为「按当前任务检索 top-k」                                                                                                     |
| **范围**   | 计划 [`docs/plan/knowledge-integration-master-plan.md`](plan/knowledge-integration-master-plan.md) **阶段 B**（P0）                                                   |
| **依赖**   | **无**（不阻塞于 A0/LLM Wiki——见段〇）                                                                                                                                |
| **归属**   | 应用端实现；构建允许；**重启 5175 归宿主侧**                                                                                                                          |
| **一句话** | `lessons.md` 现 113 KB / 155 条，注入预算 6 000 字符且**从文件尾截断** ⇒ 实际进上下文 ≈ 5.3%，95 条 `[VERIFIED]` 基本不在场。本单改为**按当前任务检索相关条目**注入。 |

---

## 段 −1（v2 新增）：应用端核对结论的逐条裁决

> 应用端已逐一核对本单引用的全部源码锚点，声称「全部属实」，并给出 A–F 六项偏差/优化点。
> 宿主侧**复核后确认：6 项事实核对全部属实**（含 1 处小偏差），现逐条裁决如下。

### 事实核对（复核结论：属实）

| 应用端主张                                                                                                           | 宿主侧复核                                                | 结论   |
| :------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------- | :----- |
| `skills/retriever.ts` 含 `rankSkills`/`tokenize`/`DF_RATIO_MAX`/`SCORE_FLOOR`/`K1`/`B`                               | 存在，**8 661 B**（非 7.5 KB，小偏差）                    | ✓ 属实 |
| `load-lessons.ts` 含 `stripPreface`/`splitEntries`/`buildLessonsBlock`/`LESSONS_BUDGET=6000`/`MAX_PENDING_RATIO=0.4` | 存在（**路径在 client**，见下）                           | ✓ 属实 |
| `session-prompt.ts:26/38` 两处 `buildLessonsBlock()` **无参**                                                        | 逐字确认                                                  | ✓ 属实 |
| `routes/skills.ts:124` `skillsHono.post('/skills/match')` 范式存在                                                   | 存在（`skills.ts:31` 定义、`index.ts:42/54` barrel 两处） | ✓ 属实 |
| `packages/core/src/retrieval/bm25.ts` 不存在（待新建）                                                               | 目录不存在                                                | ✓ 属实 |
| `workspace-guard` 已有 `STUB_EXEMPT`（WO-08 所加）                                                                   | 存在（`workspace-guard.node-test.ts:55-64`，v5）          | ✓ 属实 |

> ⚠️ **路径澄清（宿主侧发现，应用端核对表述未点名）**：`load-lessons.ts` 与 `session-prompt.ts`
> **都在 `packages/client/composables/ai/`（浏览器侧）**，不在 core。`buildLessonsBlock` 通过
> `fetch('/__ai/files/read')` 取内容。**这不改变工单架构**（段二本就写的是 client），但**直接决定 A 项裁决**。

### A. 复用 `scripts/lessons-parse.cjs` —— **动机成立，路径修正（部分采纳）**

应用端主张：现存已有共享模块 `scripts/lessons-parse.cjs`，新 `listLessonDocs` 应复用它，
「core 可 require 仓库脚本，`lessons-hygiene` 已示范此路」。**复核后：后半句不成立，故路径需改。**

1. **`lessons-hygiene.node-test.ts` require 仓库脚本能跑，是因为它在 `tests/`（vitest / 完整 node 环境）。**
   而工单段一的 `listLessonDocs` 是**生产代码**（`core/src`），会进 `apps/standalone/dist` 运行产物。
2. **`core/src` 生产代码里零先例 require 仓库根 `scripts/*.cjs`**（宿主侧全量 grep 证实）：
   现有 .cjs 引入全是**同包**——`require('./helpers-io.cjs')`，或 `fileURLToPath(new URL('../interceptor.cjs', import.meta.url))`。
   跨包 require 会撞本项目已知铁律「**运行时 .cjs 不进 bundle**」（须同时改 `build-all.mjs` step3 与
   `copy-runtime.cjs` 两份清单，见 WO-04 教训）⇒ 产物内 `MODULE_NOT_FOUND`。
3. **`parseLessons` 不返回正文**——只产 `{title, status, evidence, line}`（`lessons-parse.cjs:49`），
   而 `listLessonDocs` 需要 `{title, body, state}`。要复用它必须**扩展共享模块 API**，连带回归
   `lessons-status.cjs` 与 `lessons-hygiene` 两个消费方。收益不抵成本。

**裁决（定案）**：`listLessonDocs` **仍在 core 内自写分条**（保留工单原设计），但把「口径一致」
从「两侧各写正则比对」升级为**测试侧机器断言**——见**判据⑤（v2 改法）**：

- **`listLessonDocs` 是唯一实现**（生产路径不跨包）；
- **测试**（`packages/core/tests/`，可安全 require 仓库脚本）同时 `require('../../../scripts/lessons-parse.cjs')`
  与 core 实现，对**同一 fixture** 断言 `title` 序列一致；
- 这样拿到「口径由机器守 + 未来分叉即红」的收益，**又不把仓库脚本拖进运行产物**。

### B. BM25 抽取边界 —— **采纳**

- `retrieval/bm25.ts` 导出**原子件 + 常量 + tokenize**：`tokenize`、`termFreq`、`idfOf`、`scoreField`、
  `pickMatchedSpans`（见 E）、`K1`/`B`/`MIN_LATIN_LEN`/`MAX_MATCHED`/`DF_RATIO_MAX`/`SCORE_FLOOR`/`STOPWORDS`/`CJK_STOP`。
- `skills/retriever.ts` 保留 `rankSkills`/`SkillDoc`/`ScoredSkill`，改为 `import` 核心，**行为逐字不变**。
- `lessons/retriever.ts` **自写双字段打分循环**（字段 = 标题权重 3 + 正文权重 1），**不套 `rankSkills`**
  （后者是 name 3 / keywords 2 / desc 1 **三字段**，字段数不同；套用会引入空字段噪声）。
  但**必须复用** `tokenize`/`termFreq`/`idfOf`/`scoreField`/`DF_RATIO_MAX`/`SCORE_FLOOR`/`K1`/`B`，
  以及 rankSkills 的 df 统计与 `avgLen` 归一化思路 ⇒ **仍是同一份分词/停用词/阈值 SSOT**。

### C. 判据①–⑤ 落点 —— **采纳**（见段四新增「落点」列）

- **①③⑤ → core 侧**（`hono.request` 直调 + `node:http` stub，同 WO-08）。
- **②④ → client 侧**（`vi.stubGlobal('fetch', ...)`，`sessionPromptLessons.node-test.ts` 已有此范式）。
- **⑥** → 段〇验收（`skills-*` 测试全绿）。

### D. `workspace-guard` 铁律 2 冲突 —— **属实，已解除**

段四 `node:http` stub 会触发 `packages/* 禁止 createServer`；WO-08 已加测试文件豁免
（`STUB_EXEMPT` = `{'listen(', 'createServer'}`，`isTest` 限 `tests/` 或 `.node-test.ts`）。本单**不会撞**。

### E. `pickMatchedSpans` / `matched` 字段 —— **采纳，随核心迁移**

工单段一出参已含 `matched`。定案：**保留**（与 `/skills/match` 对称，诊断有价值），
故 `pickMatchedSpans` **一并抽入 `retrieval/bm25.ts`**，lessons 侧同样产出 `matched`。

### F. 不得「顺手修」既有怪值 —— **采纳为硬约束**

宿主侧实测 `CJK_STOP`（`retriever.ts:175-211`）确有怪值：`'之的'`（:205）、
**`'了的'` 重复两次**（:206 / :207）、`'和和'`（:210）。抽取要求「行为逐字不变」⇒
**原样搬运，不得清理/去重/改名**。清理会改分词结果 ⇒ 破坏判据⑥「skills 测试全绿」。

---

## 段〇（设计定案）：复用既有 BM25，**不依赖知识库**

### 关键修正（相对计划原文）

计划 §5 阶段 B 写的是「**wiki 建 lessons 索引**」——**本单修正此点**：lessons 检索走
**服务端 BM25（复用仓库既有实现）**，**不引入 LLM Wiki**。理由：

- 首问 / 循环首轮是**热路径**：它一旦依赖外部服务，wiki 未启动 / 超时 ⇒ 首问降级，
  **等于把「每次开工」绑在一个 GUI 常驻进程上**。这违反本项目「降级必须显式且不阻断」的纪律。
- 仓库**已有**成熟 BM25：`packages/core/src/skills/retriever.ts`（`rankSkills`），具备
  中英文分词（CJK bigram）、停用词表、df 截断（`DF_RATIO_MAX`）、分数下限（`SCORE_FLOOR`）、
  字段加权（name 3 / keywords 2 / desc 1）。客户端范式见
  `packages/client/composables/ai/skill-registry.ts:22`（`matchSkills` → `fetch('/__ai/skills/match')`）。
- LLM Wiki 仍有用，但用在**按需层（L1，阶段 E/F）**，不进热路径。

> 换言之：**阶段 B 与 A0 解耦**，可立即开工。

### 依赖方向（不可成环）

```
client buildLessonsBlock(query)            ← packages/client/composables/ai/load-lessons.ts
   └─POST /__ai/lessons/match─→ core lessons/retriever.ts
                                    └─import─→ core retrieval/bm25.ts（共享 BM25 核心）
                                                   ↑
                          core skills/retriever.ts ┘（改 import，行为逐字不变）
```

### 抽取共享核心（避免第二份 BM25）

- 新建 `packages/core/src/retrieval/bm25.ts`：把 `termFreq` / `idfOf` / `scoreField` /
  `pickMatchedSpans` / 常量（`K1` `B` `MIN_LATIN_LEN` `MAX_MATCHED` `DF_RATIO_MAX` `SCORE_FLOOR`）
  与 **`tokenize`**（含 `STOPWORDS` / `CJK_STOP`）迁入；`skills/retriever.ts` 改为 `import`，**行为必须逐字不变**。
- **硬约束**：搬运时 `CJK_STOP` / `STOPWORDS` **原样逐字**，含已知怪值（段 −1 F）。**不得顺手清理**。
- **不推荐**「新写一份 lessons 专用 BM25」——那会造出第二份分词/停用词表，必然漂移
  （SSOT 纪律）。
- 迁完后 `skills` 既有测试（`skills-retriever*` / `skills-frontmatter*`）**须全绿**，
  这是「抽取无回归」的唯一判据（判据⑥）。

### 切分口径（**统一到共享模块口径，不得新造**）

- **既有事实**（宿主侧实检）：
  - `scripts/lessons-parse.cjs`（**唯一共享实现**，`lessons-status.cjs` 与 `lessons-hygiene` 均 require 它）
    用**严格 `line.slice(0,3) === '## '`**（`##` + 空格）分条，**跳过代码围栏**，产出 `{title,status,evidence,line}`。
  - client `load-lessons.ts:28` `splitEntries` 用 `/^##\s/`（`##` + 空白，**含 Tab**），**不跳围栏**，产出正文块。
  - `core attach-ws.ts`（入库去重）与 `scripts/handoff-gen.cjs` 亦为 `^## `。
- **新检索器口径定案**：`listLessonDocs` 采用**共享模块的严格 `'## '`**（`##` + 空格），
  并在注释写明「与 `scripts/lessons-parse.cjs` 同口径」。
- **已知既有微差（记录，不在本单修）**：client `splitEntries` 的 `/^##\s/` 比共享模块宽一个 Tab 字符
  （`##\tX` 会被 client 分条、不被 `parseLessons` 分条）。实际 `lessons.md` 语料不含 `##\t`，
  本单**不改 client**（避免扩大改动面），仅在注释留痕；若判据⑤暴露差异再单独收口。
- **判据⑤（v2 改法）**：**测试侧交叉校验**——`packages/core/tests/lessons-retrieval.node-test.ts`
  同时 `require('../../../scripts/lessons-parse.cjs')` 与 core 的 `listLessonDocs`，
  对**同一 fixture** 断言 `title` 序列一致；变异 = 服务端改用 `###` 分条 ⇒ **必红**。
  （**不跨包 import client**——铁律「`packages/*` 不依赖 `apps/*`」的同类约束，回避之。）

---

## 段一（P0）：服务端 BM25 检索器

1. **新增 `packages/core/src/lessons/retriever.ts`**
   - `listLessonDocs(root)`：读 `.ai-runner/lessons.md` → 掐引言 → `^## ` 分条（严格 `'## '`，
     与 `scripts/lessons-parse.cjs` 同口径）→ `{ title, body, state }[]`。
     `state` 取条目「首个非空行」是否匹配 `[VERIFIED|REJECTED|STALE]`（与 `load-lessons.ts:71-74`
     `isPendingEntry` 同义）。
   - `rankLessons(query, docs, limit = 3)`：复用 `retrieval/bm25.ts`；
     **字段 = 标题（权重 3）+ 正文（权重 1）**，自写双字段打分循环（不套 `rankSkills`，见段 −1 B）。
   - `[CONSTRAINT]` 纯读取、不写盘；文件缺失/解析异常 → 返回空数组，**不抛错**（首问不得因它中断）。
   - `[CONSTRAINT]` **不得 require 仓库根 `scripts/*.cjs`**（运行产物无此文件，见段 −1 A）。

2. **新增 `POST /__ai/lessons/match`**（照 `skills.ts:124` 的 `skillsHono.post('/skills/match')`）
   - 入参 `{ query: string, limit?: number }`；出参 `{ ok: true, matches: [{ title, body, state, score, matched }] }`；
   - 查询空 / 无命中 → `{ ok: true, matches: [] }`；**任何异常不抛**（返回空 matches）。
   - 路由注册方式**照 `skillsHono`**（barrel 三处：`routes/index.ts` 的 import + `HONO_SUB_APPS` +
     `HONO_PREFIXES`，不得新造注册路径）。

---

## 段二（P0）：客户端接线

1. **`packages/client/composables/ai/load-lessons.ts`**
   - 签名改为 `buildLessonsBlock(query?: string)`（**照 `skill-registry.ts:44` 的 `buildSkillsBlock(query?)` 同构**）：
     - 有 query → `POST /__ai/lessons/match`（照 `skill-registry.ts:22` 的 `matchSkills` 写法）
       → 取 top-k → 拼 `<file path=".ai-runner/lessons.md">` 块（**保留文件头图例** + 命中条目 **verbatim**）；
     - query 为空 / 请求失败 / 零命中 → **回退现有尾截断实现**（`LESSONS_BUDGET` 封顶 + pending ≤ `MAX_PENDING_RATIO`）。
   - `LESSONS_BUDGET = 6000` **保留**，语义从「截断阈值」改为「**预算上限**」（宁少勿滥不变）。
   - `[CONSTRAINT]` 回退路径**必须存在且等价旧行为**——不许把「检索失败」变成「不注入」。
   - `[CONSTRAINT]` 保持 `import { ... } from './load-lessons.js'`（ESM 显式扩展名）不变。

2. **`packages/client/composables/ai/session-prompt.ts`** 两个入口传参：
   - `buildNewSessionPrompt(summary, query)` → `buildLessonsBlock(retrieval)`（`retrieval` 已在其作用域内）；
   - `buildLoopInitialPrompt(goal)` → `buildLessonsBlock(goal)`。
   - ⚠️ 现状两处都是**无参**调用（`:26` / `:38`），漏改 = 检索恒不触发（静默退回尾截断）。
   - ⚠️ `auto-imports.d.ts` 已自动声明 `buildLessonsBlock` 与 `LESSONS_BUDGET`（client）——
     加可选参数**不需手改 `auto-imports.d.ts`**（类型随源码推导），但**改导入必跑 `test:tsc`**（项目铁律）。

---

## 段三（P0）：状态行必须随条目注入

- 命中条目**逐字**注入 ⇒ 其**首行状态行**（`[VERIFIED]` / `[REJECTED]` / `[STALE]` / 无）自然携带。
- **硬约束**：拼装时**不得剥离条目首行状态行**，也不得只取正文。
- 文件头**图例**（`[REJECTED] ⇒ 正文描述是错的，不要照做`）必须保留（现在 `load-lessons.ts:90-99` 有）。
- 理由：plan §2 P1 的实例——`[REJECTED]`「熔断后 429」被应用端**重写三遍**，正是因为没读到那条。
  状态随条目进入上下文，是让 AI「不照做已判假结论」的唯一通道。

---

## 段四（P0）：承重判据与变异

> 通用纪律：判据须**承重**（改坏实现必红）；**不得依赖运行态**；`limit`/阈值**请求期读取**
> （不得模块顶层缓存——否则测试注入失效 ⇒ 判据真空，同 WO-20261007-08 判据④）。
> **落点**（v2 新增，见段 −1 C）：①③⑤ → core；②④ → client；⑥ → 段〇验收。

| #   | 落点   | 判据                                                                                                                                | 变异（必须变红）                             |
| :-- | :----- | :---------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------- |
| ①   | core   | 给定 `query = "e2e 端口漂移"`，注入块**包含**相关条目                                                                               | 把检索退回尾截断 ⇒ 该条目不在注入块 ⇒ **红** |
| ②   | client | 注入块体积 **≤ `LESSONS_BUDGET`**（命中再多也不越界）                                                                               | 去掉预算封顶 ⇒ **红**                        |
| ③   | core   | 命中 `[REJECTED]` 条目时，其**状态行逐字在注入块内** + 图例在                                                                       | 拼装时剥掉条目首行 ⇒ **红**                  |
| ④   | client | 检索端点不可用（mock 500 / 网络抛）⇒ **回退尾截断**（块非空，等于旧行为），不空注入、不抛                                           | 删掉回退分支 ⇒ **红**                        |
| ⑤   | core   | 切分口径一致：同一 fixture，`listLessonDocs` 的 `title` 序列 == `require('scripts/lessons-parse.cjs').parseLessons` 的 `title` 序列 | 服务端改用「按 `###` 分」⇒ **红**            |
| ⑥   | 段〇   | `skills` 既有测试全绿（证明 BM25 抽取**无回归**）                                                                                   | —（这是段〇 的验收）                         |

**测试基建**：用 `node:http` 在 `127.0.0.1:0` 起 stub（同 WO-20261007-08 做法），
**不得依赖真实服务**；stub 的随机端口经 env 注入。`workspace-guard` 的 `STUB_EXEMPT` 已就绪（段 −1 D）。

---

## 段五：闸门与分工

- **闸门**：`tsc` / `tsc:apps` / `tsc:client` / `test:tsc` 全绿 → 目标测试全绿 + 6 组变异逐组确认变红后还原
  → 全量 `vitest`（**带 `CODEBUDDY_SAFE_DELETE_ENABLED=0`**，否则 safe-delete shim 会引爆连环假红）
  → `anchors:verify` / `docs:verify`。
- **构建**：应用端可 `pnpm build`；**重启 5175 归宿主侧**（`instance-ownership-v1`）。
- **回执**：附变异前后原始测试输出（不是自述）。

---

## 本单不做（后续单）

| 项                               | 归属   | 说明                                                                                                       |
| :------------------------------- | :----- | :--------------------------------------------------------------------------------------------------------- |
| **阶段 C 首问瘦身**              | 下一单 | 依赖本单检索通道；且含 **hostOwned** 的 `SYSTEM.md` / `AGENTS.md` **内容拆分**（须宿主侧落笔），故独立成单 |
| 阶段 D（REJECTED 前置检索）      | 后续   | 本单段三只做「状态随条目注入」，D 是生成前拦截，独立评估                                                   |
| 阶段 E/F（文档/冷存镜像入 wiki） | 后续   | **依赖 A0**（装 LLM Wiki）                                                                                 |
| 阶段 G（pm2 托管）               | 宿主侧 | wiki / 油猴分发 / 同步器常驻                                                                               |
| client `splitEntries` 口径收窄   | 后续   | `^##\s` → 严格 `'## '`（仅在判据⑤暴露差异时；本单不改 client）                                             |

---

## 复检要点（宿主侧）

1. 6 组变异**逐组亲跑**，确认「删修复必红」——重点看 ① 与 ④（这两条最易写成真空判据）；
2. 全仓确认真实 bootstrap **只走 `/__ai/lessons/match`**，**零 wiki 依赖**（首问热路径无外部依赖）；
3. `skills` 既有测试全绿（BM25 抽取无回归）；
4. 切分口径（判据⑤）须是**行为断言**（与共享模块对齐），而非「两侧各写一遍正则」；
5. **产物反查**：`retrieval/bm25.ts` 迁出后，确认 `packages/core/dist/**` 与
   `apps/standalone/dist/_server/index.js` **两份产物都含新符号**，且运行进程启动时间 > 产物 mtime；
6. 全量闸门 + build + restart 后，活端实拉一次首问，确认注入块含相关条目。

---

> **背景**：本单是 `docs/plan/knowledge-integration-master-plan.md` §5 阶段 B 的落地；
> 诊断依据见该文件 §2 P1（注入率 5.3%）。**SSOT 不迁移**：`lessons.md` 仍是唯一台账，
> 本单改的是「怎么把它的内容喂进上下文」，不改它的存储。
