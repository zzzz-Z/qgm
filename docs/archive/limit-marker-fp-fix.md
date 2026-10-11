# 修复计划：limit-marker 触顶误报（自指命中）

> 状态：**P0 + P1 + P3 已实施（带证据）；回填侧两条通道（C/D）已关闭**；  
> P0b 因**取证前提不成立**按计划 fail-open 取向**明确不实施**（见 §8.3）；P2 仍为待办。  
> 起因：2026-10-10 12:02:58 工作台弹「AI 会话已达长度上限（页面命中：maximum context length）」，  
> 随后判「AI 网页已停止生成，本轮不再等待」——**掐掉了一整轮**（12:02:22–12:02:31 那批核验）。  
> 复现脚本：`.ai-runner/tmp/limit-fp-repro.cjs`（happy-dom；正则与剥离实现体均按守卫同一规则从源文件提取，不手抄）

## 0. 结论先行：`[limit-detect-v3]` **没有**修掉这个误报

- v3 只收紧了**中文**分支（要求自带动作子句）。该文件注释原话：「**英文分支不变**（英文正文自指风险低且无对应动作子句）」。
- 而 12:02 的命中串恰好是**英文裸分支** `maximum context length`——复现出的 `last match` 与该 toast **逐字符一致**。
- 触发链（已取证）：某轮脚本 `readText('packages/core/src/headless/headless-inject-simple.ts')` + `console.log(t.split('\n').slice(0,140)…)` ⇒ 打印第 1–140 行；`maximum context length` 正在**第 136 行**；该 stdout 被工作台以「# 脚本执行结果」回填进会话（`send.jsonl` 12:02:34 `source=copyOutput bytes=12871`），而 stdout 段是 \`\`\` 围栏（`prompt-builder.ts:297` `appendRawOutputs`）⇒ 页面里落成 `<pre><code>`；`countLimitMarkers()` 扫整页 `document.body.textContent` ⇒ 命中 ⇒ 基线比对判「本轮新增上限标记」。
- **⇒ 误报的本质是「探针扫到了自己的工作语言」**：任何被回填进页面的源码/文档（含 banner 文案本身）都会命中。

### 实测（复现脚本输出）

| 案例                                                                           | 整页 `textContent`                               | 剥 `pre/code/输入框` 后                                      |
| :----------------------------------------------------------------------------- | :----------------------------------------------- | :----------------------------------------------------------- |
| 1｜**12:02 实况**（回填 stdout 在 `<pre><code>` 内）                           | 命中 1 次，最后一次 = `"maximum context length"` | **0**                                                        |
| 2｜同文本但**未围栏**（裸文本落在 user 气泡）                                  | 1 次                                             | **1**（P0 单独不够）                                         |
| 3｜dump **`limit-marker-guard.node-test.ts` 自身**（含真 banner 文案 fixture） | **8 次**（最后一次 `context length limit`）      | **0**                                                        |
| 4｜真 banner + 同轮回填源码（混合）                                            | —                                                | 1，最后一次 = `达到对话长度上限，请开启新对话`（真阳性保住） |
| 5｜英文 API 真错文 `This model's maximum context length is 65536 tokens`       | 1 次                                             | —                                                            |

**案例 3 说明 v3 之后仍有更宽的通道**：只要 dump 到任何引用过 banner 文案的文件（守卫测试、文档、源码注释）就会命中，且 8 次能轻松撑过「计数增长」判据。

## 1. 先立判据（改前必红 / 改后必绿）

1. **修前必红**：案例 1、3 的整页命中 ≥1，且案例 1 的 `last match === 'maximum context length'`（= 与研究结论一致，防止把偶然命中共现当判据）。
2. **修后必绿**：剥壳计数 案例 1 = 0、案例 3 = 0；案例 4 = 1 且命中串为中文 banner；案例 5 = 1。
3. **parity 承重**：三处 `bodyText()` 实现体**逐字符一致**（复用 `limit-marker-guard` 既有的「提取字面量 + 断言相等」范式）。
4. **变异承重**：把 `bodyText()` 的剥离改成恒等（直接 `return b.textContent`）⇒ 守卫用例 1/3 必红；把 parity 改回去 ⇒ 第 3 条必红。

## 2. 改动清单

### P0（必须）：探针读文本一律走「剥壳后的 body 文本」

**做法**：每个文件内新增一个**局部**函数（不能跨文件共享——headless 侧函数经 `page.evaluate` 序列化注入，不能引用模块级常量，这是既有的 3 处内联根因）：

````js
// [limit-scan-strip-v1] 触顶/停止类探针只扫「正文」：剥掉代码块、输入框与可编辑区，
//   WHY: 工作台把脚本 stdout（``` 围栏）回填进会话，源码里含探针自己的词表（本例
//   `headless-inject-simple.ts:136` 的 `maximum context length`）⇒ 自指命中误报（2026-10-10 实测）
function bodyText() {
  const b = document.body
  if (!b) return ''
  const c = b.cloneNode(true)
  const kill = c.querySelectorAll('pre,code,textarea,input,[contenteditable="true"],script,style')
  for (let i = 0; i < kill.length; i++) kill[i].remove()
  return c.textContent || ''
}
````

**接点**（该文件内**所有** body 文本读取点统一改走它，避免逐处改写漂移；行号只是参考、以符号名为准）：

| 文件                                                   | 读取点（符号，行号为 2026-10-10 快照）                                                                        | 用途       |
| :----------------------------------------------------- | :------------------------------------------------------------------------------------------------------------ | :--------- |
| `packages/core/src/headless/headless-inject.ts`        | `detectReplyInPage` 内 `limitText`（`:140`）、其上的 busy / stopped 读取点                                    | 探测       |
| `packages/core/src/headless/headless-inject-simple.ts` | `resetReplyDedupInPage` 内 `:128`（签名）、`:133`（busy）、`:134`（stopped）、`:136`（limit）、`:139`（rate） | 基线       |
| `scripts/tampermonkey-session-id.user.js`              | `countLimitMarkers`（读点 `:211`）、`countStopMarkers`（读点 `:194`）                                         | 页面内计数 |

**常态零额外开销**（cloneNode 有成本，不能每帧跑）：维持双计数——

- `sync*Baseline()`（每轮一次）记 **剥壳后** 计数为基线；
- 每帧探测先用**整页 raw 快筛**（零成本）；仅当 `raw > rawBaseline` 时才做一次剥壳复算并用其值判定。  
  ⇒ 无候选命中时完全不 clone；有候选时才付一次成本。

### P0b（建议，需先取证）：同时剥掉 user 侧消息容器

案例 2 证明：**未围栏**的回填文本 P0 拦不住。回填文本一律是 user role，而真 banner 不是。

- 加一份 `USER_ROOT_SELECTORS`（对齐现有 `ASSISTANT_ROOT_SELECTORS` 的先例），剥 DeepSeek/ChatGPT/千问的 user 容器。
- **实施前必须在真站点取证**：① 各站点 user 容器选择器；② 确认触顶 banner **不在** user 容器内（否则引入漏报）。
- 取证不成 ⇒ 退回只做 P0（fail-open，仍是「宁可漏」方向）。

### P1（建议）：英文分支收紧到真错文形态

当前正则尾 `|context length (?:limit|exceeded|too long)|maximum context length` 两条**裸匹配**（无任何上下文要求），这正是本次误报的入口。收紧为需邻近 token 数：

- `maximum context length` ⇒ 要求后随 `(?:is|of)\s*\d+` 或邻近 `\d+\s*tokens`（案例 5 必须仍命中）；
- `context length (?:limit|exceeded|too long)` **保持原样**（守卫已有正例 `'context length limit exceeded'`，且源码里该串带 `(?:` 前缀不会被自身命中——已实测）；
- 三处同构。

### P2（可选，更强但更贵）：基线时机后移

`syncLimitMarkerBaseline()` 现在在 `ai-runner:fill` 处理**开头**（`user.js:1106`，先于 `fillInput`/`doSend`）⇒ 基线是「本轮提示词落进 DOM **之前**」的数，于是**工作台自己喂进去的任何文本**都算「新增」。把它移到 `doSend` 复核成功之后（`[send-ack-after-verify-v1]` 已把 `onResult(ok, reason)` 回调打通，接点现成）。

- 收益：从**时间维度**消掉「自指」整类（对案例 2 也有效）。
- 代价/风险：发送确认有 400–800ms 窗口，其间若真 banner 已出现会被算进基线 ⇒ 需加「本轮 pending」抑制标志，否则有竞态。取向仍是宁可漏，但实现复杂度明显高于 P0。
- **建议单独一轮做**；P0 + P1 已覆盖已发生的两类案例。

### P3（必须）：守卫扩展

`packages/core/tests/limit-marker-guard.node-test.ts` 补：

1. `bodyText()` 三处实现体逐字符一致的 parity 用例；
2. DOM 级用例（`@vitest-environment happy-dom`）：把复现脚本的案例 1–5 搬进来（含 `<pre><code>` 内 dump、未围栏 dump、真 banner 混合、英文真错文）；
3. 假阳性 fixture（字符串级，最小化依赖）：`136: const limitMessages = …|maximum context length/gi` 这一行**必须不命中**（收紧 P1 前）——这条现在就会红，正好锁住 P1。

## 3. 同步面与部署

- **三处必须同构**，改一处漏一处会由 §1 判据 3 直接拦下。
- `@version` `1.6.7` → `1.6.8`；已核实 `http://127.0.0.1:5178/tampermonkey-session-id.user.js`（pid 24430）**直供磁盘文件**（两边都是 66588 字节）⇒ 服务端不需要额外动作。
- **用户侧必须更新油猴脚本**：页面内实际生效的只有油猴那份（`countLimitMarkers`），headless 两份只在无头通道生效——**不更新脚本，页面照旧误报**。
- `dist` 产物与 5175 静态根不受影响（本次不涉及 client/server 源码）。

## 4. 验收步骤

```bash
# 1) 复现脚本（改前 vs 改后；改后需把 stripText 换成新 bodyText 实现）——期望案例 1/3 由 1/8 → 0
node .ai-runner/tmp/limit-fp-repro.cjs
# 2) 守卫（含新增 DOM 级与 parity 用例）
npx vitest run packages/core/tests/limit-marker-guard.node-test.ts
# 3) 类型与闸门（headless 侧改动涉 core）
CODEBUDDY_SAFE_DELETE_ENABLED=0 pnpm tsc && pnpm test:tsc
CODEBUDDY_SAFE_DELETE_ENABLED=0 pnpm docs:verify && pnpm anchors:verify
# 4) e2e 级（真 Chrome 注入**改后**脚本 + 造页含 dump 文本）⇒ 期望不触发触顶
#    范式复用 .ai-runner/tmp/e2e-userscript-bridge.cjs
```

DONE 须贴：复现脚本改前后两段原始输出 + 守卫原始输出 + e2e 结论。**未跑 e2e 不得写「已修复」**（原文案是「页面内生效」的判据，单测覆盖不到页面 DOM 真实形态）。

## 5. 风险与取舍

| 风险                                    | 处置                                                                                                                                        |
| :-------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------ |
| 漏报面扩大（真 banner 落在 `<pre>` 内） | DeepSeek 触顶提示是 UI chrome 不是 markdown 块；实施后在真站点目视确认一次                                                                  |
| `cloneNode` 性能                        | 快筛 + 仅候选时复算（§2 P0），常态零开销                                                                                                    |
| P0b 选择器站点相关                      | 取证不成即退回 P0；不引入猜测性选择器                                                                                                       |
| 同类风险外溢                            | `busy` / `stopped` / `rate` 三类探针同源（同一整页文本），本计划顺手用 `bodyText()` 覆盖；如需进一步收敛（如「只扫 assistant 区块」）另开单 |

## 6. 明确不做

- **提议 4（`window.name` 反向引用）**：已实测判死——按名字取引用受 **browsing context group** 约束，跨组只会**静默新建一张 about:blank**（与「名字不存在」的负面对照签名一致），而同组场景 `window.opener` 本就可用 ⇒ 方案对该目标场景无效且多余。脚本：`.ai-runner/tmp/e2e-name-group-probe.cjs`（4/4 PASS）。
- **提议 3（`script-hello` 版本广播）**：暂缓。B 判死后它退化为纯版本可见性（「窗口在线」已有 `fill → fill-ack` 判据），而代价是用户重装脚本。若日后要做，按 4 点修正：走 `_trySend` 直发（不进 `_pending`）、周期性/`visibilitychange` 补发、`SCRIPT_VERSION` 与 `@version` parity 守卫、客户端校验 `e.origin`。
- 「用户手动打开的页面不可达」= **结构性边界**，记为 `[ACCEPTED]`，不挂待办。

## 7. 执行记录（2026-10-10 12:30–12:50）

### 7.1 落地的改动

| 文件                                                      | 改动                                                                                                                                                                                                                   |
| :-------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/headless/headless-inject.ts`           | 新增局部 `bodyText()`（克隆后剥 `pre,code,textarea,input,[contenteditable="true"],script,style`）+ 共用剥壳快照（整页 raw 作失效判据，raw 不变则零 clone）；`detectReplyInPage` 的 **5** 个探针读取点全改走 `scanText` |
| `packages/core/src/headless/headless-inject-simple.ts`    | 同构 `bodyText()`；`resetReplyDedupInPage` 的 **4** 个基线探针改走 `scanText`                                                                                                                                          |
| `scripts/tampermonkey-session-id.user.js`                 | 同构 `bodyText()` + `scanBodyText()`（两类探针共用一份快照，避免 350ms 循环里 clone 两次）；`countStopMarkers` / `countLimitMarkers` 改走它；`@version` 1.6.7 → **1.6.8**                                              |
| `packages/core/tests/limit-marker-guard.node-test.ts`     | 新增 5 个用例：实现体 parity（三处一致 + 选择器字面量）／调用点冻结清单 ratchet／DOM 级案例 1·3 归零／真 banner 与英文真错文不回归／两处已知残留 ratchet                                                               |
| `packages/core/tests/stopped-baseline-guard.node-test.ts` | 锚点随读取点同步（顺带锁住「没有退化回整页 raw 读取」）                                                                                                                                                                |

**刻意不改**（有 WHY，见各文件 `[CONSTRAINT]`）：

- `bodySignature()` / `stillStreamingReply()`（`headless-inject.ts` / `headless-inject-simple.ts` / `user.js` 三处）——代码块属于回复正文，剥掉会让「正文是否仍在增长」的判据失真。
- `verifyFillSentInPage` 的频控探针（读整页 raw 末 3000 字符）——该正则每条分支都带转义（`please\s+slow\s+down` 等），在源码文本里是字面反斜杠、**无法自匹配**；且它守在 send 复核路径上（改它会牵动 fill-ack 判定）。已在守卫里作为**唯一在册例外**（`MARKER_RECEIVER_ALLOWLIST` + 例外数 = 1）冻结。

### 7.2 判据与原始结论

- **修前**（`.ai-runner/tmp/limit-fp-repro.cjs`）：案例 1 整页命中 1（`last = "maximum context length"`，与 toast 逐字符一致）／剥壳后 **0**；案例 3 整页 **8** → 剥壳 0。
- **修后**（同一脚本，剥壳实现体改为**从源文件抽出**再 `vm.runInContext` 执行）：案例 1 `1 → 0`、案例 3 `17 → 0`、案例 4 真阳性 = 1（命中中文 banner）、案例 5 英文真错文 = 1、案例 2（未围栏）= 1（已知残留）。
- **守卫**：`limit-marker-guard` 10 项 + `stopped-baseline-guard` 2 项 全绿。
- **变异承重**（脚本 `.ai-runner/tmp/mutate-limit-strip.cjs`，改前改后 sha1 校验一致）：
  - 变异 A（把 `headless-inject.ts` 的剥离改恒等）⇒ **3 红**（parity / 案例 1·3 / 案例 4 连带）；还原后 3 文件 sha1 逐字节复原。
  - 变异 B（只把 `user.js` 的选择器置空）⇒ **1 红**（「userscript 与 headless-inject 的 bodyText 不一致」）。
- **e2e（真 Chromium + 真油猴脚本 + 假站点按 DeepSeek markdown 语义渲染）**：`.ai-runner/tmp/e2e-limit-fp.cjs`
  - `real` 模式 **9/9 PASS**：围栏完整形态两轮（单行源码 / 140 行全量）**零误报**；真 banner 仍 `kind:'limit'`；无 pageerror。
  - `mutant` 模式：把剥离改回恒等后，第一轮即误报且 `last = "maximum context length"` ⇒ **台架承重成立**（否则 real 的「零误报」是空判据）。
- **全量闸门**：vitest 184 文件 / 1638 测试全过；`tsc` / `tsc:apps` / `tsc:client` / `test:tsc` 四份 exit 0；`eslint .` 0 error；`docs:verify` / `anchors:verify` / `crossfile:verify` 全过。

### 7.3 新发现（e2e 抓到的第 3 条通道，P0 覆盖不到）

**回填文本自身含三反引号 ⇒ 撑破外层围栏**。工作台 `appendRawOutputs` 用 `围栏包裹 stdout；若被 dump 的源码/文档里也含`（本例：`headless-inject-simple.ts` 本轮新加的注释里就有），围栏在**它自己**那里提前闭合，后半段落成普通文本 ⇒ 结构剥离失效 ⇒ 自指误报回归。

- e2e 已把这一形态做成 **轮 3 ratchet**（断言「仍会误报」= 已知残留），P0b/P1 落地后该断言应转红。
- 该通道的根治在**回填格式**（工作台侧：按内容长度/围栏内容选择更长的围栏，或对内容里的 \`\`\` 转义），不属本次 `bodyText()` 的范围 ⇒ 另立条目，不混在这一单里。

### 7.4 部署面（与 §3 的更正）

§3 曾说「dist 产物与 5175 静态根不受影响」——**这句是错的**：`packages/core/src/headless/*` 会被打进 `packages/core/dist/**`（tsc）与 `apps/standalone/dist/_server/index.js`（运行读它）。

- **页面通道（用户当前痛点，油猴）**：5178 直供磁盘文件，**改完即在供 1.6.8**（已实测 `curl` 到 `@version 1.6.8`）。**但页面里生效的只有用户自己在油猴面板更新的那一份** —— 不更新脚本，页面照旧误报。
- **无头通道**：产物已于 12:43 重建（`build-all` + `tsc` emit + `copy-runtime` 均 exit 0；产物反查 `pre,code,textarea` 命中、`_scanRaw` 命中；mtime 12:43 > 源码 12:33）。**需 `pm2 restart ai-runner` 才在 5175 实例生效**（进程早于产物启动，内存里还是旧代码）。
- 产物反查注意：**不能按整串字面量 grep** —— 压缩器会把选择器里的 `"true"` 改写成 `\"true\"`，整串 grep 假阴为 0；按无转义子串（`pre,code,textarea`）才命中。

## 8. 执行记录（2026-10-10 12:50–13:10，续作：P1 + 回填侧 C/D）

### 8.1 落地的改动

| 文件                                                                                   | 改动                                                                                                                                                                                                                                   |
| :------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `headless-inject.ts` / `headless-inject-simple.ts` / `tampermonkey-session-id.user.js` | **P1**：英文分支由裸匹配收紧为**必须邻近 token 数** —— `maximum context length (?:is\|of)\s*\d+` 或后随 `\d+\s*tokens`；`context length (?:limit\|exceeded\|too long)` **保持原样**（它带 `(?:` 前缀，源码文本无法自匹配）。三处同构。 |
| `headless-inject.ts`                                                                   | 注释里引述真文案改为**分段**（`「达到对话长度上限」+「请开启新对话」`）与**参数化**（`maximum context length is <N> tokens`）⇒ 探针源码库零自命中。                                                                                    |
| `prompt-builder.ts`                                                                    | 新增 `fenceFor(body)` / `pushFenced(p, body)`：围栏长度 = 内容里最长反引号串 + 1（最少 3，无反引号时仍是三反引号）。替换 6 处固定三反引号围栏（变更列表 / tsc / eslint / test / 基线变更 / stdout·stderr）。                           |
| `prompt-builder.ts`                                                                    | **Channel D**：`appendFailedSourceFiles` 的 `# 相关文件源码` 段由**无围栏**（直接 push `buildErrorContext` 输出）改为围栏包裹；`<file path=…>` 与 `N\| ` 行号**逐字符不变**（AI 侧解析契约不动）。                                     |
| `limit-marker-guard.node-test.ts`                                                      | 12 项：新增「探针源码库零自命中」「首问注入块不得含标记词表」两条 ratchet；案例 1 改写为「围栏内 / 裸文本**都必须 0**」（P1 直接关闭，不再依赖剥壳）；案例 3 独立承担「剥壳对仍可命中的 payload 有效」。                               |
| `promptBuilder.node-test.ts`                                                           | 10 项：`fenceFor` 自适应；按 markdown 围栏语义切块断言「内容原样留在一个块内」；各 append* 含反引号输出不得撑破；`# 相关文件源码` 必须落在围栏内。                                                                                     |
| `tampermonkey-session-id.user.js`                                                      | `@version` 1.6.8 → **1.6.9**（否则用户无法在油猴面板区分新旧副本）。                                                                                                                                                                   |

**刻意不改**：`context length (?:limit|exceeded|too long)`（源码不可自匹配，且有正例 `'context length limit exceeded'`）；看板镜像块（`fetchBoardMirror`）仍无围栏边界 —— 记在册（§8.4）。

### 8.2 判据与原始结论

- **仓内自命中盘点**（`.ai-runner/tmp/probe-en-branch.cjs`）：
  - 改前 `headless-inject.ts` **2** 处（注释引述真文案：`达到对话长度上限，请开启新对话` 与 `maximum context length is 65536`）、`inject-simple.ts` 0、`user.js` 0；
  - 改后三处**全 0**；`lessons.md` / `AGENTS.md` / `SYSTEM.md` 亦全 0（首问注入块无围栏 ⇒ 命中即第一轮误报）。
- **12:02 实况 payload**（`inject-simple.ts` 第 1..135 行，探针自己的词表所在行）：命中数由 **≥1 → 0**（P1 在**正则级**关闭，不再依赖剥壳）。这条同时说明 `headless-inject-simple.ts` 与 `user.js` 已无自命中。
- **变异承重**（`.ai-runner/tmp/mutation-fence-safe.cjs`，4 例；每例从内存还原后 sha1 **逐字节一致**）：
  - A｜`fenceFor` 改回固定三反引号 ⇒ **4 红**（fenceFor / pushFenced / appendRawOutputs / tsc·lint·test）；
  - B｜`# 相关文件源码` 退回裸 push ⇒ **1 红**（Channel D 用例）；
  - C｜英文分支退回裸匹配（三处）⇒ **2 红**（零自命中 ratchet + 案例 1）；
  - D｜往 `lessons.md` 写入真 banner 文案 ⇒ **1 红**（首问注入块 ratchet）。
- **e2e**（`.ai-runner/tmp/e2e-limit-fp.cjs`，真 Chromium + 真油猴脚本 + 假站点）：
  - `real` **9/9 PASS**：轮 1（单行回填）/ 轮 2（落单围栏 payload + 自适应围栏）**零误报**；轮 4 真 banner 仍 `kind='limit'`；无 pageerror。
  - **同轮内对照**：同一 payload 换成 fixed 三反引号 ⇒ **误报 = 1**（自适应时 = 0）⇒ 轮 2 的零误报不是空判据。
  - `mutant`（剥离改恒等）轮 1 即误报且 `last='达到对话长度上限，请开启新对话'` ⇒ 台架承重成立。
- **台架两处必要修正**（都是「判据承重」逼出来的，记档以免重踩）：
  - 假站点取文本必须用 `innerText`：油猴用 `execCommand('insertText')` 填充 contenteditable，换行落成 `<div>/<br>`，`textContent` **丢掉换行** ⇒ 行式 markdown 解析退化成一整行、永远解析不出 `<pre><code>`（实测 `code=false`）。
  - 「撑破围栏」必须用**落单（奇数）围栏行**，且计数要用**与渲染器同一条**围栏正则：偶数个内层围栏会与内容自身重新配对（整篇文档 dump 的 fixed 对照误报也是 0）；用 `/^\s*`{3,}\s*$/`数行会漏掉带语言后缀的` \`\`\`js \` ⇒ 奇偶判断失真。
- **全量闸门**：vitest 全绿；`tsc` / `tsc:apps` / `tsc:client` / `test:tsc` 四份 exit 0；`eslint .` **0 error**（39 条既有 warning 全在 `.cjs` helpers）；`docs:verify`（55）/ `anchors:verify`（63）/ `crossfile:verify`（31）全过。

### 8.3 P0b 取证结论：**不成立 ⇒ 按计划 fail-open，明确不实施**

计划 §5 给 P0b 定的前置是「① 取到各站点 user 容器选择器；② 确认触顶 banner **不在** user 容器内（否则引入漏报）」，并规定「取证不成 ⇒ 退回只做 P0」。

- **① 前提缺失**：真站点取证需要**已登录 DeepSeek** 的浏览器。`/tmp` 只剩未登录的 `chrome-probe-fresh`；9333 无监听（无 CDP 通道）；运行器 profile 在 `.ai-runner/headless-profile`（被 5175 实例以 `launchPersistentContext` **独占**，登录态未经核实）。借用用户日常 Chrome profile 需单实例锁且触碰真实账号数据，不做。
- **② 即使拿到选择器也无法确认**：banner 只在真触顶时渲染，无法在不把某会话跑爆的前提下观察它挂在哪。**② 才是真正的卡点**，不是选择器本身。
- **边际收益已下降**：本轮把「**工作台自己的文本**」这条**实际出事**的通道全部关闭（P1 正则级 + 围栏 C/D + 首问词表 ratchet）。P0b 只剩「外部/历史 user 文本」一类，且该类不含探针词表时无害。
- 处置：**不引入猜测性选择器**；残留用 ratchet 锁住（§8.4），日后若真站点可得，再按本节 ①② 取证后单开一轮。

### 8.4 残留通道（在册）

| 通道                                                                             | 现状                                               | 守卫 / 处置                                       |
| :------------------------------------------------------------------------------- | :------------------------------------------------- | :------------------------------------------------ |
| 工作台自己注入的文本（stdout / 源码 / tsc·lint·test / 文档）                     | **已关闭**（P1 + 围栏自适应 + 相关文件源码加围栏） | 变异 A/B/C 承重                                   |
| 首问注入块（`<file path="SYSTEM.md">` / AGENTS.md / lessons.md，**无围栏**注入） | 实测 **0**（潜伏）                                 | `首问注入块不得含标记词表` ratchet（变异 D 承重） |
| 外部/历史 user 文本（非工作台产出）                                              | P0 拦不住，P0b 未做                                | `未围栏的可命中文本仍是已知残留` ratchet          |
| 看板镜像块（`fetchBoardMirror`，无围栏边界）                                     | 未覆盖；词表来自任务标题，风险低                   | 记在册；若日后漏报/误报出现再收                   |

### 8.5 部署面（本轮）

- **页面通道（用户痛点，油猴）**：5178 直供磁盘文件 ⇒ 改完即供 **1.6.9**。**但页面里生效的只有用户自己在油猴面板更新的那一份** —— 不更新脚本，页面照旧误报。
- **无头通道**：`packages/core/src/headless/*` 与 `packages/client/components/script/prompt-builder.ts` **都在产物里**（`packages/core/dist/**`、`apps/standalone/dist/_server/index.js`、`dist/client`）⇒ 必须 rebuild + `pm2 restart ai-runner` 才在 5175 实例生效。

## 9. 复检结论（2026-10-10，独立复核）

> 对象：本轮 DONE 的 ① Channel D 第二发射点 + ② send-btn/ack + 仪器类修复。
> 方式：读回磁盘源码 / 打活端点 / 逐字节比对，不依赖 DONE 转述。结论：**通过**。

### 9.1 ② send-btn / ack

- `scripts/tampermonkey-session-id.user.js:921` `[send-btn-widen-v1]` 在位。
- `:1104` `function doSend(box, onResult)` 复核回调在位；`:1156` ack 走回调。
- 旧式 `ackFill(true, '', …)` 残留 **0**；`@version` = **1.6.9**；`script-hello` / `SCRIPT_VERSION` = 0。

### 9.2 ① Channel D 第二发射点（tree-attach.ts）

- `:9` 引入 `pushFenced`；`:131`（目录）/ `:140`（单文件）均走 pushFenced。
- `parts.push(f.content)` 裸推 = **0**；标题行 `═════ 附件目录 … ═════` 与分隔行 `----- path -----` 逐字符保持。

### 9.3 三处内联同构（逐字节）

- `bodyText()`：headless / simple / userjs 三处 300 B **完全一致**。
- strip selector：`pre,code,textarea,input,[contenteditable="true"],script,style` 三处一致。
- 触顶正则：三处 len=359 **逐字节一致**（含英文分支 `maximum context length (?:is|of)\s*\d+`）。

### 9.4 仪器类修复

- `gate.sh`：`note_fail` 累计失败 + 末尾 `exit 1`（:51-55）；vitest 输出落文件取真实退出码（:33-39）。
- `tsconfig.test.json`：已含 `packages/client/auto-imports.d.ts`。

### 9.5 活端点

- `[host]` ✓ `http://localhost:5175/__ai/` (HTTP 200)
- `[userscript]` ✓ `http://localhost:5178/` (HTTP 200)

### 9.6 闸门

- `final-guards.log`：2 files / 24 tests passed（promptBuilder 12 + limit-marker-guard 12）。
- `gate-2026-10-10-attach2.log`：vitest + 4×tsc + eslint（0 error）+ docs（55）+ anchors（63）+ crossfile（31）全绿。

### 9.7 未闭合项

- **P2 未做**：属 `[ACCEPTED]` —— 阶段 4 观察期闸门未开（prompt-budget 2/3，14 天窗内），非缺陷。
- **用户需在油猴面板手动更新到 1.6.9**：5178 已供新版，页面生效需人工确认（DONE 已明说）。

## 10. 新发现（2026-10-10 14:14，用户截图）：「停止」探针的**同源自指误报**（已取证，未改行为）

弹的是 `AI 网页已停止生成，本轮不再等待`（`kind:'stopped'`），**不是** §8 那条触顶（`kind:'limit'`）。
机制与前者**完全同源、同为自指** —— 但前面几节只加固了**触顶**一路，**停止一路一条都没补**。

### 10.1 判据链（全部来自本机日志 / 源码，非推测）

| 证据                  | 内容                                                                                                                                                                                                                                                                                   |
| :-------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| toast 出口            | `packages/client/composables/ai/useAiReplyHandlers.ts:136` —— 收到 `kind==='stopped'` 即 `toast('AI 网页已停止生成，本轮不再等待')`                                                                                                                                                    |
| 停止探针              | `scripts/tampermonkey-session-id.user.js:222-224` `countStopMarkers()` = `scanBodyText().match(/当前问题已停止\|已停止生成\|已停止回答/g)`                                                                                                                                             |
| 触发阈值              | `user.js:694` `if (stopCount > stopMarkerBaseline)` ⇒ postMessage `kind:'stopped'`                                                                                                                                                                                                     |
| **放大器（P2 同款）** | `user.js:1133`（fill）/ `:1177`（rotate）：`syncStopMarkerBaseline()` 在 **`fillInput(box, prompt)`（:1154）之前**执行 ⇒ **我们自己回填的文本本身**也会被算成「新增标记」。这正是 §6 P2 描述的问题，当时只为触顶通道记录、未在停止通道上修                                             |
| 时间线（本机日志）    | `arrive.jsonl`：14:14:18「全仓定位复检涉及的实体文件」、14:14:23「全仓定位复检目标文件：tree-attach / 变异脚本 / gate.sh / gate-selftest / e2e / tsconfig.test」——**AI 正在 grep 并回显这些文件**；`send.jsonl`：14:14:29 同一窗口 `copyOutput` **239091 B 合并回传**（本批 2 次结果） |

### 10.2 根因：停止词表就是我们自己的 UI 文案，且从未被 ratchet 覆盖

`grep -E "已停止生成"` 在客户端源码里 **7 处**：

- `useAiReplyHandlers.ts:70 / 136 / 286 / 351`（:136 就是这句 toast 的**字面量本身**）
- `tests/stopped-plain-noise.node-test.ts:48`、`tests/stopped-no-autorun.node-test.ts:70 / 84`

⇒ 只要把这个文件 dump 进会话（`readText` / patch 失败回显 `nearLines` / AI 在行文里复述），`已停止生成` 就成为**页面普通文本** ⇒ 被自身探针当成「AI 停止生成」的横幅 ⇒ 回传 stopped ⇒ 工作台终止本轮等待。
（旁证：`.ai-runner/logs/2026-10-10.jsonl:23` 那条历史脚本里，`old/new` 补丁就用字符串形式写着这句 toast 文案。）

**未覆盖的守卫面**（触顶一路 vs 停止一路）：

| 触顶一路（已做）                        | 停止一路（**未做**）                                                                             |
| :-------------------------------------- | :----------------------------------------------------------------------------------------------- |
| P1：英文分支收紧为「必须邻近 token 数」 | 无等价收紧（中文三态，任一形态都能被原样引用）                                                   |
| ratchet「探针源码库零自命中」           | 无 —— 现在探针源码**本身就是自命中**（三个停机态写在正则里）                                     |
| ratchet「首问注入块不得含标记词表」     | 无（实测 `lessons.md` 当前干净 ⇒ 纯属运气，非守卫拦住）                                          |
| stdout / 源码段四处加围栏               | 围栏只挡 `<pre><code>`；**AI 行文、合并回传的分段标题、patch `nearLines` 都是普通文本** ⇒ 挡不住 |

### 10.3 候选修法（均未实施；改行为 ⇒ 需单开一轮）

1. **补守卫**（闸门允许，成本最低）：把现有两条 ratchet 的词表扩展到停止三态 ⇒ 会**立即转红**（7 处），需连带把 UI 文案改成分段/拼接引用（沿用 §8 「引述真文案须分段」纪律）。
2. **基线时机后移**（= §6 P2 的停止通道版）：`syncStopMarkerBaseline()` 移到 `doSend` 复核成功之后 ⇒ 我们自己的回填不再被算成新增。**失败模式**：pending 标记卡住会静默关掉检测。
3. **判据改看 UI 结构而非文本**：找站点的停止横幅 / 按钮 DOM 节点做判据，彻底摆脱文本自指 —— 但需真站点取证（与 §8.3 P0b 同一前提，当前不可得）。

推荐顺序：**先 1（补守卫，先把自指捂住），再视信号决定是否 2**；3 只在真站点可得时做。

### 10.4 不改代码的临时规避

会话里**避免**让含停止词的文件以普通文本形式出现在页面上（要引用就落在围栏代码块内，并避免让 AI 在行文中复述该句）。治标，见 §10.3。

### 10.5 已实施（2026-10-10 15:0x–15:20）：A + B 一起

- **A｜停止分支回传命中原文**（`scripts/tampermonkey-session-id.user.js`，`@version` **1.6.9 → 1.7.0**）
  - 新增 `stopMarkerText`，`countStopMarkers()` 记录 `m[m.length - 1]`；停止载荷 `text: stopMarkerText || STOPPED_GENERIC`。
  - **与 headless 拉齐**：`packages/core/src/headless/headless-inject.ts:150` 早就 `text: stopMessages[stopMessages.length - 1]`——**只有油猴这条路径写死**。
  - 兜底值 `STOPPED_GENERIC` 亦按**分段拼接**（`'AI 网页' + '已停止' + '生成'`），不引入新的源码自命中。
  - 客户端 `formatStopToast()` 回显：`…（页面命中：<原文，折叠空白 + 截断 40 字>）`，与触顶 `formatLimitToast` 同范式。
- **B｜停机态整句净出客户端源码**（新增 `packages/client/utils/stop-notice.ts`）
  - 抬头/脚本提示/通用文案全部改为分段拼接；**运行时呈现逐字不变**（有用例锁死：抬头运行时必须仍能命中词表）。
  - 改 `useAiReplyHandlers.ts` 4 处（:70 注释、:136 停止 toast、:286/:351 脚本提示）与 3 处测试 fixture（改用 `STOPPED_HEAD` 常量）。
- **守卫**：新增 `packages/client/tests/stop-notice.node-test.ts`（7 条）= 词表 census（递归扫 `packages/client/**/*.{ts,vue}`）+ 回显承重 + 呈现不变。
  - **首跑即自曝 4 处连写**（含我自己刚写进注释与 fixture 的 3 处）⇒ 判据确为承重；修净后转绿。
- **变异承重**（7 例，全部 sha1 逐字节复原 + 基线复跑全绿）：**F｜停机态整句写回 ⇒ 1 红**；**G｜formatStopToast 忽略命中原文 ⇒ 2 红**。
- **闸门**：vitest **185 文件 / 1655 测试**全过（+1 文件 / +7 测试）；4×tsc exit 0；`eslint .` 0 error（39 条既有 warning）；docs/anchors/crossfile 全过。
- **部署取证**：`pnpm build` exit 0（step 1→2→2.5→3 + done）；产物 mtime **15:17:21** > 源码；客户端资产换名 **`index-Cs7ze3R4.js`**（含 `页面命中：`）；`pm2 restart` ⇒ 5175 监听 pid **33592**；活端点资产 sha1 `95dfbde1…`（175852 B）与磁盘**逐字节相等**，`/__ai/preset/system` 200；5178 供 `@version **1.7.0**`，sha1 `5b8a5047…`（70007 B）与磁盘相等。
- **⚠️ 需人工**：用户须在油猴面板更新到 **1.7.0**（否则 A 的回显在页面侧拿不到，仍然只能旁证）。
- **仍未做**：10.3 的第 2 项（基线时机后移，改行为 + 阶段闸门未开）与第 3 项（判据改看 UI 结构，需真站点取证）。

### 10.6 已实施（2026-10-10 15:30–15:35）：刷新后的**冷启动基线缺陷** `[stopped-detect-v3]`（A 回显立功）

**现象**：用户刷新 DeepSeek 页面后立刻弹 `AI 网页已停止生成，本轮不再等待（页面命中：已停止生成）`。
这次**带了命中原文** —— 正是 A（§10.5）的产出；它同时把 §10.1 的推测推翻了一半：

- 命中原文是**干净的 `已停止生成`**，不带我们自己的 toast 前缀、不带文件名、不带围栏标记 ⇒ **不是** §10.2 那条「把客户端源码 dump 进会话」的自指回显；
- 而是**页面刷新时就已经存在**的历史角标 —— 刷新后探针基线是 0，历史里的永久「已停止」被算成「本轮新增」。

**根因（源码取证，非推测）**：

| 环节                  | 位置                                                                        | 事实                                                   |
| :-------------------- | :-------------------------------------------------------------------------- | :----------------------------------------------------- |
| 观察器接入时机        | `user.js:877` `resumeReplyObserver()`                                       | 脚本注入即接管，**早于任何一轮 fill**                  |
| 停止基线初值          | `user.js`（`stopMarkerBaseline`）                                           | **0**，且**只在 fill / rotate 时同步**                 |
| ⇒ 缺陷                | —                                                                           | 刷新后第一轮：历史角标计数 > 0 = 基线 ⇒ 判「本轮停止」 |
| **headless 早就修过** | `packages/core/src/headless/headless-inject.ts:77-90` `[stopped-detect-v2]` | 冷启动先同步一次基线再开判 —— **只有油猴这条路径漏了** |

**修法**：新增 `_roundBaselinesReady`（`user.js:209`），在触顶 / 停止**两个分支之前**插入守卫
（`:713`）：`if (!_roundBaselinesReady) { stopMarkerBaseline = countStopMarkers(); limitMarkerBaseline = countLimitMarkers(); return }`
—— 刷新后**第一次 tick 只做基线快照、不发判**，之后在 fill（`:1164`）/ rotate（`:1209`）各置 `true`，守卫永久失效（本轮语义成立）。

**判据与承重**：

- e2e `e2e-limit-fp.cjs` 新增**轮 0（冷启动历史角标）**：注入前先在 body 里放 N 个停止标记，
  断言 fill 前 `limit=0 stopped=0 error=0` ⇒ **real 12/12 PASS**。
- **变异承重** `mutation-coldstart.cjs`：把 `if (!_roundBaselinesReady) {` 短路成 `if (false) {`
  ⇒ **轮 0 转红、总判 NOT OK**；复原后 sha1 逐字节等于原值且不等于变异态 ⇒ 判据非恒真。
- 闸门：vitest **185 文件 / 1655 测试**全过；4×tsc exit 0；`eslint .` 0 error；docs/anchors/crossfile 全过。

**部署取证**（`pnpm build` exit 0，step 1→2→2.5→3 + done）：

| 项         | 值                                                                                                   |
| :--------- | :--------------------------------------------------------------------------------------------------- |
| 客户端资产 | 换名 **`index-CcSw-pW8.js`**；活端点 sha1 `eb57a918…`（175852 B）与磁盘**逐字节相等**（`cmp` 通过）  |
| 油猴脚本   | 5178 供 `@version **1.7.1**`，sha1 `6278ceb7…`（71738 B）与磁盘相等；`_roundBaselinesReady` 4 处命中 |
| 实例       | `pm2 restart ai-runner` ⇒ 5175 监听 pid **41217**；`/__ai/preset/system` **200**                     |

- **⚠️ 需人工**：用户须在油猴面板更新到 **1.7.1**（此前 10.5 说的是 1.7.0，被本轮覆盖）。
- **仍未做**：10.3 第 2 / 3 项（同前）；另注：冷启动守卫只解决「刷新后首拍误判」，
  §10.2 的**源码自指**一路仍靠 B（整句净出源码）+ 围栏纪律兜着，二者不是同一条路径。
