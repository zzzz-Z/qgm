# SYSTEM.md 优化计划（WO-20261007-14）

- **性质**：宿主侧自主分析产出的优化计划（**待批，未执行**）。
- **对象**：`packages/core/SYSTEM.md`（26200 B / 244 行，执行规则 SSOT，归**宿主独占**——应用端只提案）。
- **闸门**：**闸门内**。内容是修 SSOT 文案、消内部环式矛盾、补承重守卫；非新功能、无新依赖。
- **基线**：`system-contract`(4) + `reply-mark-parity`(9) + `host-owned-write-guard`(4) = **17 passed**；`anchors:verify` 72 绿、`docs:verify` 43 篇绿。
- **关联**：`WO-20261007-12`（已落笔自主决策条款）、`WO-20261007-13`（对应用端 10 项建议的裁决）。本单**不重提已裁决项**，清单见段五。

## 段〇 判断摘要

**SYSTEM.md 的问题不在「太长」，在「太多条文没有机器承重」。**

三条实测事实决定本单取向：

- **F2**：15 个章节里只有 §1B/§1D/§8/§12（契约一致性）与 §4（阈值同值）有机器守卫，其余 11 章的条文全靠自觉。
- **F1**：它不是每轮注入，而是**每会话 / 循环首轮一次** ⇒ 体积不是经常性成本 ⇒ 首问瘦身（阶段 C）的 ROI 排序应**下调**。
- **F3**：首当其冲的是一条**结构性环式死锁**——§1D 的 `[DECIDE]`「改用 ASK」与 §8「不上报 ASK」成环，导致全部 `@todo` 熔断时状态机无出口。

故排序为：**先解环（P0-1）→ 再补承重基础设施（P0-2）→ 再修「声明 vs 机制」落差（P1）**。

## 段一 事实基础（本轮实测；复现命令见段六）

### F1 体积与分布

总体 26200 B / 244 行。按 `## §N` 切片：

- §1 输出契约与状态机 —— **6930 B（26.4%）**
- §3 运行时沙箱 —— 2980 B
- §12 提交前自复检协议 —— 2366 B
- §0.1 机制依赖声明 —— 2144 B
- 其余 11 章合计 —— 约 11900 B（§2 1733 / §11 1316 / §4 1189 / §10 1189 / §13 1110 / §8 1060 / §9 715 / §7 668 / §5 535 / §6 500 + 标题）
- ⇒ **前 4 项占 55%**，且它们恰好也是承重覆盖最密的四块（例外是 §3 —— 2980 B 零守卫）。

### F2 注入频率：不是每轮，是每会话一次

- `load-rules.ts` 有 Promise 缓存；`useAiWindow.ts:51-56` 的 `[rules-always-v1]` 按 **sid** 去重（`RULES_INJECTED_MAX=100` 的 LRU）。
- 调用点只有三处：`copyAndFill` 首发送、`buildNewSessionPrompt`（handoff 交接新会话）、`buildLoopInitialPrompt`（循环首轮）。
- ⇒ **纠正两处现存错误注释**：
  - `packages/core/tests/system-contract.node-test.ts:2` 写「SYSTEM.md 每轮注入」——不成立。
  - `docs/DOCS-INDEX.md` 维护规则写「`SYSTEM.md` 每轮必读」——同样不成立。
- **意义（重要）**：既然不是每轮成本，优化的靶心就不是「砍字节」，而是「条文有没有被机器守住」。反过来，真风险是**长会话后期规则远离上下文**（50 轮硬上限下，第 40 轮时规则已在很远处）——这条要记录，但排期属于阶段 C，本单不做（见 P2-7）。

### F3 机器承重覆盖

读 `SYSTEM.md` 的机器只有四处：

- `tests/system-contract.node-test.ts`：G1–G4，按标题切片后校验 §1B / §1D / §8 / §12 的段间契约。
- `tests/module-size-ratchet.node-test.ts`：`[ssot-parity-v1]` 断言 §4 阈值与三处守卫常量同值。
- `scripts/anchors.json`：**2 条内容锚点**——§11 的「获取顺序：本地优先，不可跳层」、§1 的「状态 C：TEXT（纯文本回执）」。改文只要不动这两串就不撞锚点。
- `tests/host-owned-write-guard.node-test.ts`：写入记账（假 fs，不触真盘）。

⇒ §0.1 / §2 / §3 / §5 / §6 / §7 / §9 / §10 / §11 / §13 **零承重**。

### F4 「写了但没人执行」的落差

- §10 标题词是「**硬性**预算：单轮脚本 ≤300 行 / 12 KB」，实测**无闸门**：`routes/control-log.ts:39` 的 `overBudget` 只进 `reject.jsonl` 留痕；`routes/run.ts:353` 的 `[budget-feedback-v1]` 每轮回传 `scriptSize` 供 AI 自测。两处都是**观测**，不是拦截。
- 对照 §0.1 自己的诚实写法：`verify-contract v1（post-run/run-compliance.ts **仅采集不闸门**，观测期）`——这才是正确标注形态。**缺的不是诚实，是统一的承重标注**（⇒ P0-2）。
- 反例：§6 / §7 是诚实的（明文写「无机器守卫」「不作硬性门槛」）。⇒ 本单要做的不是给每条补守卫，而是**让「有无守卫」可被一眼看出且可被机器校验**。

### F5 执行面：改了怎么才生效

- 三份复制：`scripts/build-all.mjs:42`（→ `dist/SYSTEM.md`）、`scripts/copy-runtime.cjs:23`（→ `packages/core/dist/SYSTEM.md`）、standalone 运行实例读的是 `apps/standalone/dist/SYSTEM.md`。
- `routes/preset.ts:18-19`：路径模块级缓存、**内容不缓存** ⇒ 改源码后**必须 `pnpm build`、免重启**。

## 段二 优化项

### P0-1 解开 `[DECIDE]` ⇒ ASK 的环式死锁（结构性缺陷）

- **现状**（§1 状态 D，risk-class-v1 一行）：`[DECIDE]` 需人类决策（改用 ASK）。
- **缺陷链**（三点，缺一环不成立）：
  - §8 熔断后禁止一切自动重放，要求用 `TEXT` 播报并「继续服务其他 `@todo`」——**若无其他可推进项，这句无处落地**；
  - §1 状态 C 明写 `TEXT`「不结束任务」，§1 状态 D 的 DONE 触发要求「无遗留 `@todo`」；
  - ASK 被 §8（`不上报 ASK`）与 §12#2（`不得转 ASK`）双禁；
  - 剩下唯一的收尾路径是 §2 的 `fail(['<原文>'])`（做完不成 writes off）之后写 DONE——而 §1D 又把 `[DECIDE]` **重定向回 ASK** ⇒ 环闭合。
- **后果**：此刻唯一物理出口是 AGENTS.md 的循环硬上限（50 轮 / 30 min），即**烧满预算零推进**。不是永久悬挂，但是真实浪费，且是「活端点全通、就是不产出」的可能成因之一。
- **拟改**（只改 `[DECIDE]` 一句，其余不动）：

```text
旧：`[DECIDE]` 需人类决策（改用 ASK）
新：`[DECIDE]` 需人类决策（确定做不成的先 `__AI__.tasks.fail([...])` 收尾，本项随 DONE 挂账，
     写明待决项与建议倾向；**不中途阻塞**——把它改写成 ASK 会与 §8 熔断处置冲突）
```

- **为什么它比「开 ASK 逃生口」更好**：~先 `fail()` 使桶里无 pending todo ⇒ DONE 合法~ —— ⚠️ **这句不成立，见段 −1.1 实测推翻**；「不中途阻塞、随 DONE 挂账」的结论仍成立，但**理由换成了段 −1.1 的第五条链路**。且**不动 §8 的绝对句、不动 G2/G3 断言**。
- **判据**（扩到 `system-contract.node-test.ts`，与 G1–G4 同文件同法：读源码、按标题切片）：
  - G5-a：`stateD` **不得**含「改用 `ASK`」。变异：把旧句加回去 ⇒ 红。
  - G5-b：`stateD` **必须**含「随 DONE 挂账」。变异：删该短语（只做了「删」没做「替」）⇒ 红。
  - 两条互补：a 挡回退、b 挡过度删除。
- **体积记账**：约 +90 B。
- **成本**：一句话 + 2 条断言。

### P0-2 每章加「承重：」标注 + 覆盖率守卫（基础设施，收益最高）

- **拟改**：每个 `## §N` 标题下第一行加统一格式标注，取值只有两种：

```text
- 承重：守卫 tests/xxx.node-test.ts（<判据名>）
- 承重：无（提示词侧自律，无机器守卫）
```

- **新判据**（同样扩进 `system-contract.node-test.ts`）：
  - G6-a：每个 `## §N` 段（切片到下一个 `## ` 或 `---`）**必须**含一个 `- 承重：` 行。变异：删掉任一章的标注行 ⇒ 红。
  - G6-b：标注行里以行内代码写出的**测试/脚本文件路径必须在磁盘真实存在**。变异：把路径写成 `tests/not-exist.node-test.ts` ⇒ 红。
- **为什么值得**：它把§0.1「这条机制宿主会不会跑」的诚实传统，扩展到「这条**规则**有没有承重」；直接把本仓库反复发作的「真空判据 / 声明↔机制落差」变成可机检项。同时 G6-b 顺手堵住 WO-20261007-10 段二要防的**悬空 SSOT 指针**在 SYSTEM.md 内的同类形态。
- **风险与限定**：G6-b 只解析标注行（不扫全文），避免正文示例误报；只校验 `.node-test.ts` / `.cjs` / `.json` 三种后缀；路径一律相对仓库根。
- **体积记账**：约 +600 B（15 章 × 约 40 B）。

### P1-3 修正两处「每轮注入 / 每轮必读」错误注释

- `packages/core/tests/system-contract.node-test.ts:2`、 `docs/DOCS-INDEX.md` 维护规则对应的那条。
- 依据见 F2。属**代码/索引**改动，不在 SYSTEM.md 内；成本低但防误导——错误的前提会让人继续把「瘦身」当成首要战役。

### P1-4 §10 预算口径：把「硬性」改写成真实形态

- 现状：标题词「硬性预算」与「无闸门」并存（F4）。
- 建议取向（**待拍板 D2**）：先按 §0.1 的诚实范改写措辞——「预算 300 行 / 12 KB；**不设闸门**，仅每轮回传 `scriptSize` 供你自测，超限只进 `reject.jsonl` 留痕（overBudget）」，把「墙在哪」的可用性交给 AI 而不是假装有一堵墙。
- 备选（成本显著更高）：真上闸门——需在 `/run` 前置层加拦截，且会与 §10 自己的「分步提交三段式」冲突（超预算的合法分段会被误伤）。**不建议**。

### P2-5 §0.1 编号消歧（零重编号解）

- 采纳 WO-20261007-13 段四的推荐解：标题改为 `## §0.1 机制依赖声明（全篇适用，非 §0 子节）`。
- 不动编号 ⇒ 不破坏 2 份工单正文对其的具名引用。

### P2-6 §1 巨章按职责拆（可选，须先确认收益）

- §1 是 6930 B 的巨章，内含两件不同的事：**五个状态的定义**（A–E）与**横向执行条款**（脚本头契约 / verify-contract / selfcheck-gate / 产物核验 / degraded / 脚本纪律 / 实例生命周期 / 文件级同权）。
- 按 §4 自己明文的标准——「拆分的**唯一依据是职责边界**，不是行数」——这两件确实是两件事，与用户「同一功能不必在意行数限制」的裁定**不冲突**。
- 但必须回答「收益是什么」才动手：候选收益是**守卫的定位精度**（`system-contract` 现在按 `### 状态 X` 切片，横切条款无处可锚）。若你说不清收益，就**不做**——这正是 WO-20261006-05 判过的「已写全再补属假强制」。

### P2-7 长会话规则衰减（**只记录，不排期**）

- F2 推出：规则只在会话首轮出现一次 ⇒ 50 轮后期约束力衰减。候选对策为「每 N 轮回传 ≤15 行紧凑摘要」。
- 但首问 / 循环首轮瘦身属知识整合计划**阶段 C ≡ 项目级阶段 5**，而 `qgm-stage-gate` 实测 `prompt-budget` 仅 2/3、观察期「≥2 周不做新功能」未达阈 ⇒ **不在本单，也不建议现在开**。

## 段 −1 应用端反馈裁决（2026-10-07 16:2x，v2 修订）

被裁决对象：应用端《WO-14 计划可行性分析》（核实为真 3 条 / 需修正 1 条 / 建议缓 1 条 / 判不可行 2 条）。

### −1.1 P0-1 的推理**被实测推翻了一半**（本单最重要的一处自我否证）

应用端主张：「拟改没把 `fail()` 写进去，补一句即可」。逐磁盘核实：

- **它的事实断言为假**：拟改（本文件段二 P0-1 的 `新：` 一行）**明文已含** `确定做不成的先 __AI__.tasks.fail([...]) 收尾`。
- **但它指出的方向命中了一个更深的缺陷**：我原先写「先 `fail()` 使桶里无 pending todo ⇒ DONE 合法」——**这条推理是错的**。实测链路：
  - `task-store.ts:608-617`：`mode === 'fail'` 只把该项标成 `status:'failed'`（**不移除**，对比 `:606` 的 `complete` 是 `items.filter(...)` 真移除）；
  - `task-store.ts:364-377` `projectItems()`：**`status !== 'done'` 一律 push 进 `todo`** ⇒ **failed 项仍在 `tasks.list().todo` 里**；
  - `TaskProgressPanel.vue:96` 反而按 `items[].status` 把 failed 单列一组 —— ⇒ **UI 与 AI 读到的口径不一致**（面板说「失败 3」，模型看到 `todo` 里同样这 3 条）。
- ⇒ **环有第五条链路**：模型判「是否还有遗留 `@todo`」时读的是含 failed 的 `todo` 数组 ⇒ 即便补了 `fail()`，DONE 触发里的「无遗留 `@todo`」**依然不成立**。所以本单原方案与应用端的补句**都解不开环**。
- **正解**（分两层，只有第一层在本单）：
  - **P0-1a（提示词侧，本单，近零成本）**：§2 「返回形状」改判遗留的口径——**以 `items[].status` 为准（`pending`/`running` 才算遗留），`list().todo` 含 `failed` 属已知偏差，不得用来判遗留**。同时 `[DECIDE]` 一句保留 `fail()` 步骤（收 UI 的单列失败组）。
  - **P0-1b（实现侧，独立成单）**：`projectItems()` 把 failed 从 `todo` 排除并新增 `failed: string[]` 返回字段——这才是根因（实现与 §2「不许沉默留在待办」的自述矛盾）。连带：`session-start.cjs:120`（`status !== 'done'` 同偏差）、`board-m3.cjs` / `board-pending.cjs` 的未收口率口径（failed 长期被计为 pending ⇒ 历史数值系统性偏高），以及 `TaskProgressPanel` 的回落视图 `:109`。**须 build + 重启**。
- **采纳它的断言粒度意见**：G5-b 从「必须含『随 DONE 挂账』」收紧为——**risk-class 那一行必须同时含 `[DECIDE]`、`fail`、`随 DONE 挂账` 三个 token，缺一即红**（补他们说的「挡不住没 fail」）。注意别写成宽松的 `stateD.includes('fail')`（那会在别处出现时变恒真 ⇒ 真空判据）。

### −1.2 G6-b 降级建议：**驳回**

- 理由一：**降级后判据恒真**。只校验「后缀合法 + 以 `tests/` 开头」，`tests/system-contract-typo.node-test.ts` 照样通过 ⇒ 正是本仓库反复要防的真空判据（§12#3）。它的价值恰恰在于「改名会红」。
- 理由二：**成本被高估**。标注写路径的章节**不是 15 个**——只有带守卫的章节才写（现状是 §1 → `system-contract`、§4 → `module-size-ratchet`、§0.1/§11 → `anchors.json`，约 3–4 处），其余 11 章写「承重：无」。「改一次名同步 15 处」不成立。
- 理由三：**同类先例**：`module-size-ratchet` 的 `[ssot-parity-v1]` 就是「文档字面量 ↔ 守卫常量」的双向钉死，改名必红，一直是可接受的。WO-10 段二的悬空指针检测也是存在性校验。
- 「放 CI 而非每轮测试」是伪二选一：`pnpm verify` 内含 vitest 且 CI 跑的就是它；只挪到 CI 反而让本地看不见红。维持 vitest（开销 = 若干次 `existsSync`）。

### −1.3 P2-6（§1 拆分）：**采纳「不做」，但结论理由要换**

- 它说「横切条款跨状态，本就不该按状态切片锚定 ⇒ 守卫定位精度是假收益」——这句**反驳反而坐实了错位**：正因为跨状态，它们才不该住在状态 A 底下。实测 §1 状态 A 下 8 条里有 **4 条是 DONE 门槛**（verify-contract / selfcheck-gate / 终验轮全量自检 / 产物核验，原文开头都是「DONE 前…」「首次 DONE 时…」），却挂在 SCRIPT 状态里。
- ⇒ 真正的候选项不是「拆分」，而是「**错位**：DONE 的触发前闸门写在 SCRIPT 段里」。
- 但这条依赖版式意图判断、且**没有可承重判据**（判据只能校验文档自己的版式，属元数据编排胜），不符合本单开业标准 ⇒ **降级为观察项，不落笔**。P2-6 维持「不做」。

### −1.4 其余

- **P1-4 备选（真上闸门）双方一致不做**，理由确认：会误伤 §10 自己的「分步提交三段式」。
- **F1 行数差**：`wc -l` 计换行符 = 244，末行无换行故按行读 = 245。无损，不改。
- **F3 口径**：它数「守卫 3」指 `.node-test.ts`；本单原写「四处」是把 `scripts/anchors.json` 的 2 条**内容锚**算作第四类（非 ts、且锚的是字串不是「章节」）。做 P0-2 标注时 anchors 单列一类，避免它在哪一章下挂不上。
- **D4（提建议前先 `git diff -w` + 读现存裁决单）已达成共识**。落点建议：**写进 `AGENTS.md` 的「项目独有约束」**（AGENTS.md 与 SYSTEM.md 同为每会话一次注入，不额外增加首问之外的成本；且它是「项目约定」而非「执行规则」，按 SSOT 分工归 AGENTS.md）。

## 段三 执行顺序与闸门

顺序（理由是「结构缺陷最易腐 + 基础设施先于用它的判据」）：

1. P0-1（解环，一句 + G5）→ 2. P0-2（承重标注 + G6）→ 3. P1-3（两处错注释）→ 4. P1-4（§10 措辞）→ 5. P2-5 → 6. P2-6（若拍板做）。

每一步的闸门（宿主落笔后一并跑；`SYSTEM.md` 归宿主独占，不由应用端代写）：

- `npx eslint <改动文件> --fix` + 复检无输出。
- `pnpm test:tsc`（新增断言必须过 `vue-tsc -p tsconfig.test.json`）。
- 四个 SYSTEM.md 相关测试：`system-contract` / `module-size-ratchet` / `reply-mark-parity` / `host-owned-write-guard`。
- `pnpm anchors:verify`（**内容锚定 2 条**，改文不得触碰「获取顺序：本地优先，不可跳层」与「状态 C：TEXT（纯文本回执）」）。
- `pnpm docs:verify` + `pnpm crossfile:verify`。
- 最后 `pnpm build`（三份复制到位）→ 活端点复核：`curl -s http://127.0.0.1:5175/__ai/preset/system` 与源逐字一致（**免重启**）。
- 判「我的改动范围」一律用 `git diff -w`（本工作区写 md 会被格式化器重排整份 diff，已知）。

## 段四 明确不做清单（含与已裁决项的关系）

- **不做**「§12 加 ASK 逃生口」——WO-13 段三.1 已裁决驳回（会重开 §8 矛盾 + 当场打红 `system-contract:39`）。**P0-1 是它的更低代价替代解，两者互斥**，只能选一个。
- **不做**「§1B 三问门槛改 ≥2 否」——WO-13 段三.2 已裁决驳回（是放宽，不是收紧）。
- **不做**「删日期戳 / 加头部元信息指向 CHANGELOG」——WO-13 段三.3 已裁决驳回（L147 / L177 是证据坐标；拟指路径不存在且被 gitignore）。
- **不做**「§0.1 重编号为 §0.2」——WO-13 段四判为无效（仍是 `.M` 形，且破坏 2 份具名引用）。采用 P2-5 的加后缀解。
- **不做** `@ask` → `ASK` 统一——**已落地**（SYSTEM.md 0 处、AGENTS.md 0 处、识别正则双收别名已去除、`G2/G3` 断言字面量已改）。残留只有 `packages/client/utils/ask-parser.ts` 的 8 处注释仍在宣称「过渡别名 `@ask`」而识别器已不认 ⇒ 注释与代码背离，**归应用端**，不计入本单。
- **不做** 首问瘦身 / 阶段 C——见 P2-7，撞阶段闸门。
- **不做** 给每条规则都补守卫——P0-2 只做「标注 + 覆盖率」，把「要不要补」变成显式可拍板的台账，而不是一次性全铺开。

## 段五 待拍板

- **D1**：P0-2 的 G6-b 是否要求「标注里写的路径必须存在」。风险是改文件名时会红（但那正是它要防的漂移）。
- **D2**：P1-4 取「改措辞」还是「真上闸门」。建议前者。
- **D3**：P2-6（§1 拆分）做不做。若做，先答「收益是什么」。
- **D4**：是否要求应用端在提优化建议前，`git diff -w` + 读一遍现存裁决单。今天已出现第 N 次「陈旧上下文产出」：同一批建议在 13:xx 与 15:xx 被以不同形式重提，且全文不引用 `docs/archive/workorder-app-system-md-review-verdict-2026-10-07.md`。

### 应用端处置记录（2026-10-11）

- **P1-3 已落地**：全仓 `grep "每轮注入"` 零命中；`packages/core/tests/system-contract.node-test.ts:2` 已是「每会话注入一次」；`docs/DOCS-INDEX.md` 维护规则段同步。
- **D4 已落地**：`AGENTS.md` 已含 `[read-verdict-first-v1]` 条目（`git diff -w` + 读现存裁决单）。本条从待决转为已采纳。
- **D1 / D2 / D3**：仍待宿主侧拍板——三项均涉及 `packages/core/SYSTEM.md` 与新增守卫，属宿主独占侧。
- **关联**：`docs/review-ai-runner-vs-agents-2026-10-11.md` §5 的「对比文档改写清单」所在对比文档不在本仓库磁盘上（属宿主侧会话上下文），无法代做；其可执行部分（`symbol()` 升级调研、`verify-contracts.cjs` 退出原因分类）已由该文档记录，供下一轮调研。

## 段六 可复现命令

```bash
# 1) 章节体积分布
awk '/^## /{if(sec)printf "%-46s %6d\n", sec, len; sec=$0; len=0; next}{len+=length($0)+1}END{printf "%-46s %6d\n", sec, len}' packages/core/SYSTEM.md

# 2) 注入频率：三处调用点 + sid 去重 + Promise 缓存
grep -rn "loadRulesBlock" packages/client/composables/ai/ | grep -v import
grep -n "rules-always-v1" -A 6 packages/client/composables/ai/useAiWindow.ts

# 3) 承重覆盖：现有哪些机器读 SYSTEM.md
grep -rln "SYSTEM.md" packages/core/tests scripts/anchors.json

# 4) §10 预算「只观测不闸门」的证据
grep -n "overBudget" packages/core/src/routes/control-log.ts
grep -n "budget-feedback-v1" -A 3 packages/core/src/routes/run.ts

# 5) 改完必跑（免重启，只认活端点）
npx eslint <改动文件> --fix
pnpm test:tsc
pnpm vitest run packages/core/tests/system-contract.node-test.ts packages/core/tests/module-size-ratchet.node-test.ts packages/core/tests/reply-mark-parity.node-test.ts packages/core/tests/host-owned-write-guard.node-test.ts
pnpm anchors:verify && pnpm docs:verify && pnpm crossfile:verify
pnpm build
curl -sS --noproxy '*' http://127.0.0.1:5175/__ai/preset/system | head -c 200
```
