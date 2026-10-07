# 直派工单 · 第六轮 WO-20261005-06（新鲜度闸门作用域 + 返回值语义）

> **派发方**：宿主侧（复核兼构建）
> **承接方**：应用端（网页端 AI）
> **对象**：应用端对 WO-20261005-05 的 `DONE` 回执
> **本件路径**：`docs/workorder-app-freshness-scope-2026-10-05.md`（已登记 `docs/DOCS-INDEX.md`，`git status` 可见）
> **不要再往 `docs/plan/` 找**——该目录整目录被 `.gitignore` 忽略且被 `docs:verify` 显式豁免。

---

## 段零 · 派发记录（宿主侧本轮亲跑，供开工前自查基线）

```text
全量重建：pnpm build → step 1/3、2/3、2.5/3（synced）、3/3（copied）、done 五标志齐
产物哈希（与上一轮 21:34 那次的记录逐字节一致 ⇒ 重建确定，可当基线）：
  packages/core/dist/post-run/lesson-extract.js          sha256 c53ef599…65fb482b
  packages/core/dist/post-run/lesson-title-similarity.js sha256 8b7ee137…e13e0e3b5
  apps/standalone/dist/_server/index.js                  sha256 000894e3…da0e9dbb78
实例：5175 重启完成，pid 33923
活体自检：GET / -> 200（1203B）｜首页引用的 7 个 /assets/*（6 js + 1 css）全 200
           ｜/__ai/skills 200｜/__ai/tasks 200｜/__ai/workspace 200
闸门（宿主侧独立跑）：vitest 132 files / 1253 tests 全绿；eslint 0 error / 85 warning；docs:verify 20 篇
```

**开工前请先自查**：若你的 `packages/core/dist/post-run/lesson-extract.js` 哈希不是 `c53ef599…`，
说明你与本工单的基线不同，先 `pnpm build` 对齐再动手。

---

## 段一（P1）· 新鲜度闸门的作用域不完整：漏了被判模块的**直接依赖**

### 现场

你在段二采用方案 A：给 `lessons-add.node-test.ts` 加了一道 `FRESHNESS` 前置闸门，
用 `scripts/artifact-freshness.cjs` 的 `checkPair(src, dist)` 判「产物不得落后于源码」。
这道闸门**方向正确**，但它把 pair **硬编码成了一对**：

```text
// packages/core/tests/lessons-add.node-test.ts:28-31
const FRESHNESS = checkPair(
  path.join(REPO, 'packages/core/src/post-run/lesson-extract.ts'),
  path.join(REPO, 'packages/core/dist/post-run/lesson-extract.js'),
)
```

而 `dist/post-run/lesson-extract.js` **不是自足的**（产物第 5 行）：

```text
import { isNearDuplicateTitle } from './lesson-title-similarity.js'
```

`lesson-title-similarity.js` 正是被断言行为的**载体**（`isNearDuplicateTitle` 与
`LESSON_DUP_THRESHOLD = 0.35` 都在它里面）。**改 `lesson-title-similarity.ts` 而不重建，
闸门无感、用例照绿。**

### 宿主侧亲跑证据（同一时刻、同一状态）

```text
$ node -e "…checkPair 两对…"
  ok=true  | lesson-extract.ts      -> lesson-extract.js
  ok=FALSE | lesson-title-similarity.ts -> .js  (闸门没守)
           <- artifact stale: packages/core/dist/post-run/lesson-title-similarity.js
              older than packages/core/src/post-run/lesson-title-similarity.ts
--- mtime ---
  2026-10-05T13:57:24.708Z  packages/core/src/post-run/lesson-title-similarity.ts
  2026-10-05T13:34:44.446Z  packages/core/dist/post-run/lesson-title-similarity.js

$ npx vitest run … lessons-add.node-test.ts
 ✓ packages/core/tests/lessons-add.node-test.ts (4 tests) 27ms
      Tests  4 passed (4)
```

即：**第二对已经陈旧（源码晚产物 22 分钟），闸门不报，用例 4 passed。**
把源码阈值改成 `0.999`（`isNearDuplicateTitle` 几乎恒 false）后，`lessons-add` 仍 **4 passed**——
判据读的是产物里旧的 `0.35` 行为，源码早已不是被测对象。

### 严重度为什么不是「无人守」

全量单测能兜住：阈值改 `0.999` 时全量 = `1 failed | 131 passed`，红的正是**读源码**的
`post-run-lesson-extract.node-test.ts` 两条（失败句含「前提：A/B 必须近重复，否则本用例是真空判据」）。
⇒ 阈值本身**有**判据承载，本条不是「阈值没人守」，而是「**闸门的作用域没人守**」：

- 合成用例 `artifact-freshness: 源新于产物时判 stale…` 只测 `checkPair` **自身的比较逻辑**；
- 没有任何判据断言「闸门的 pair 清单**覆盖了**被判对象的依赖闭包」。

⇒ **新增一个核心模块时，忘记加进清单不会被任何测试发现**——而 `lesson-title-similarity.ts`
恰恰就是上一轮新增的模块，这一轮加闸门时就漏了它。

### 形态归类

与「判据粒度粗于被判对象」同族，本次的具体形态是
**「闸门粒度粗于被判对象」**：守 A，但 A 的行为由 B 决定。

### 要求

1. **把 pair 清单从依赖图推导，不要硬编码。** 至少覆盖 `packages/core/dist/post-run/*.js`
   的全部**相对 import**（用 `node:module` 或正则扫 `from '…'`），对每个相对依赖生成一对。
   允许加显式白名单，但白名单本身要有用例说明为什么能豁免。
2. **补一条「覆盖范围」判据**：让「清单漏了某个相对依赖」这件事**会变红**。
   例：合成一个临时 dist 目录，造 `a.js` `import './b.js'`，断言生成器给出的 pair 列表**包含 b 那一对**；
   变异（把生成器改成只返回第一条）必须变红。
3. **承重证据**：给出「先红后绿」的原始输出（改完 `lesson-title-similarity.ts` 不重建 ⇒ 闸门红），
   以及至少一次变异（改恒真 / 只取首条 / 漏掉相对 import）的变红-还原记录。

---

## 段二（P2）· `appendLessons` 的 `catch { return 0 }` 把「写盘失败」与「全重复」压成同一个返回值

### 现场（读源码 + 推演链）

```text
// packages/core/src/post-run/lesson-extract.ts:238-267
if (!handled) return 0
…
try {
  fs.mkdirSync(…); fs.writeFileSync(file, next, 'utf8')
  return handled
} catch { return 0 }        // ← 写盘失败也返回 0，与「全部重复」不可区分
```

调用方因此只能按下述方式反推：

```text
// scripts/lessons-add-core.cjs:30-34
const n = append([{ title, body }], rootDir)
if (n === 0 && after === before) return { added: 0, mode: 'skipped' }
return { added: n, mode: n > 0 ? 'append-or-merge' : 'skipped' }
```

`n === 0` 有**两种**来源：① 全部重复（`handled === 0` 早返回）；② 写盘抛错（`catch`）。
两者在 `bin/lessons-add.cjs` 里被报成同一句话：

```text
if (r.mode === 'skipped') { console.error(`duplicate title: ${title}`); process.exit(2) }
```

⇒ **磁盘满 / 权限错 / 目录不可写时，用户看到的是「标题重复」。** 真因被掩盖，且与「重复」
共用同一退出码 2，脚本调用方无法二分。

### 形态归类

与上一轮「返回值虚报、日志撒谎」同源：**一个返回值承载两种语义**（信息量不足 ⇒ 调用方只能猜 ⇒ 猜错就撒谎）。

### 要求

把返回值细化为可区分的三态（形态自定，例如返回 `{ added, merged, failed }` 或 `null` 表示失败，
但**不得**再用「返回 0」同时表示两种含义），并让 `lessons-add` 对「写失败」给**区别于重复**的
退出码与人话。补用例覆盖「写盘失败」这条路径（可用只读目录 / 伪造 fs 抛错），并做变异承重。

---

## 段三（P2）· `bin/lessons-add.cjs` 的条目计数会数到代码围栏内的 `## `

### 现场

```text
// bin/lessons-add.cjs
const count = (after.match(/^## .+$/gm) || []).length
```

这是**行级**匹配，不跳代码围栏——与上一轮你修掉的「围栏内 `## ` 被当条目」是**同一个坑的残余**：
那一轮你新增了 `scripts/lessons-parse.cjs`（含围栏跳过状态机），但 CLI 这条计数没跟上，
仍走本地的行级正则。台账里只要有一段粘贴了含 `## ` 的原始输出，`total N entries` 就会虚高。

### 要求

改走共享解析器（`require('../scripts/lessons-parse.cjs')`），并补一条用例：
「台账含代码围栏内的 `## ` 行 ⇒ 计数不含围栏内标题」+ 变异承重（把状态机改恒假 ⇒ 变红）。

---

## 段四（P3）· `addLesson` 的 `mode` 二值不可观测

`addLesson` 只返回 `mode: 'append-or-merge' | 'skipped'`，CLI 打印 `OK append-or-merge "<title>"`——
**「新增一条」与「并入既有条目」说同一句话**；而 `added` 的语义是 `appendLessons` 的 `handled`
（新增 + 并入既有 + 并入同批的**总数**），不是「新增条数」。使用者无法从输出判断到底发生了什么。

请二选一：

- **(A)** 细分 `mode`（如 `appended` / `merged-existing` / `merged-batch`），CLI 分别打印；或
- **(B)** 判定为「可观测性降级」，与既有 D8 降级可观测一起挂账——**需给出依据**（引 `bin/check-status.cjs`
  的阶段闸门结论），并按挂账格式登记（`[ACCEPTED]` + 确认者 + 时间）。

---

## 段五 · 回执纪律（本段是给写作方的，不要求改代码）

本轮复核时**宿主侧自己也栽在计数口径上**，故写进工单共享：

- `grep -c <pattern>` 数的是**匹配行数**，不是**出现次数**。同一行出现两次仍只算 1。
  出现次数要用 `(s.match(/<pattern>/g) || []).length`。
  实测：`packages/core/src/post-run/lesson-extract.ts` 的 `nearFresh`——**行数 3 / 次数 4**；
  产物 `dist/post-run/lesson-extract.js` 同为 **3 行 / 4 次**。
- 故：你回执里 `nearFresh=4` 是**正确**的（次数口径），宿主侧起初用 `grep -c` 得 3、一度误判为虚报。
  **本条不追究任何一方，只固化口径。**
- 今后回执里所有计数类证据，请附「**口径 + 可复现命令**」（例：`出现次数（match /g）`）。无口径的数字视为未取证。

---

## 段六 · 边界（不要越界）

- 不要动 `docs/defect-review-verification.md` 的**判定结论**——它是你的复验报告，宿主侧只做排版级 `--fix`，不改正文。
- 不要放宽 `LESSON_DUP_THRESHOLD = 0.35`（ratchet）；本工单段一只要求闸门覆盖它，不要求改它。
- **「继续生成」按钮的处置**仍按 WO-20261005-04 段四判定挂账（属新功能，观察期不开闸），本轮不动。
- 不执行 `rm -rf` / `sudo` / `git reset --hard` / `git push -f`。
- 不得用「删断言 / skip 用例 / 改断言为恒真」让闸门变绿。

---

## 段七 · 完成标准

1. 段一：闸门覆盖范围**由依赖图推导**（或至少含 `lesson-title-similarity` 这一对），
   且「漏依赖」这件事**有判据会让它变红**；附先红后绿 + 变异记录。
2. 段二：写盘失败与「全重复」**可区分**（返回值 + CLI 信息 + 退出码），附用例与变异。
3. 段三：CLI 计数走共享解析器，围栏内标题不计入，附用例与变异。
4. 段四：(A) 实现，或 (B) 按挂账格式留痕并给依据。
5. 全部改动经 `pnpm build` 打到**两份产物**（`packages/core/dist/**` 与 `apps/standalone/dist/_server/index.js`），
   并给出两份的产物反查（新符号存在 + 进程启动晚于产物 mtime）。
6. `npx vitest run --config vitest.config.ts` 全绿、`npx eslint .` 0 error、`node scripts/verify-docs-index.cjs` 通过。

---

## 段八 · 回报格式

按既有格式（`### 结论` / `### 变更文件` / `### 验证结果` / `### 遗留风险` / `### 踩坑记录`）。
`### 验证结果` 里**每条计数都必须带口径与命令**（见段五）。原始输出用代码围栏，
**围栏内不要写 `## ` 开头的行**——采集侧现在虽已跳过围栏，但别给解析器留把柄。
