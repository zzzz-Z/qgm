# 修复计划 v2：触顶误报反复弹 toast（复检后修订版）

> 状态：**待执行**（只出计划，不动代码）
> 前序：`docs/plan/limit-marker-fp-fix.md`
> 复检对象：文档1（limitPosted + 收紧英文分支）、文档2（对文档1 的复检批评）

## 0. 复检结论（逐条实测核验，非转述）

| 论断                         | 实测位置                                | 判定                              |
| :--------------------------- | :-------------------------------------- | :-------------------------------- |
| 触顶分支无去重旗标           | `user.js:742-755`                       | 成立                              |
| headless 有 `_limitReported` | `headless-inject.ts:172,180`            | 成立                              |
| `stopPosted` 重置点          | 实测 `:1165` / `:1210`                  | 文档1 写的 `:1164` / `:1209` 有误 |
| `limitStale` 每轮恒真        | `user.js:743`                           | 成立                              |
| ratchet ⑦ 只扫 3 个 SOURCES  | `limit-marker-guard.node-test.ts:43-47` | 成立                              |
| 「引述须分段」纪律已写死     | 同上 `:28-29`                           | 成立                              |

### 0.1 文档1 两处硬伤

**硬伤 A（会挡真信号）**：`if (!limitPosted)` 把整个触顶分支包住 ⇒ 误报锁定后，同轮真信号（计数增长）也被挡。
正确做法：**只 gate 存量兜底通道**，增长通道自限、不 gate。

**硬伤 B（会引入新误报放大器）**：收紧方案用 `[^\n]*?`，而 `bodyText()` 返回整页 `textContent`，
**聊天消息之间无换行分隔** ⇒ 该模式近乎无界，会把 A 消息的触发词与页面任意位置的 token 数拼接命中，
即 v2 时代「侧栏拼接」教训的重演。若仍要收紧，必须用有界窗口（如 `{0,40}?`）。

### 0.2 文档2 的替代方案更优（采纳）

不动正则，改为两件事：

1. **fixture 裸字面量改分段拼接**（见 `limit-marker-guard.node-test.ts:90`）：运行时串逐字不变 ⇒ 正例不丢，
   而文件文本里该词被引号/加号打断 ⇒ 被 dump 进页面时不再自命中。
2. **ratchet ⑦ 扫描范围扩到测试文件**：当前只扫 3 个 SOURCES（`:43-47`），fixture 的裸串正好漏在网外。

关键优势：**正则一字未改 ⇒ 真错文命中能力零损失**（文档1 的收紧方案有漏报风险）。与 stopped 侧
「整句净出客户端源码」完全同源，是同一纪律的第二次应用。

## 1. 修复 1：`limitPosted` 旗标（拆分写法）

**对标**：headless 的 `dedup._limitReported`（`headless-inject.ts:172` 守卫、`:180` 置位）。油猴是唯一缺这条的通道。

### 1.1 声明

`user.js:199`（`let stopPosted = false`）旁新增：`let limitPosted = false`

### 1.2 分支改造（关键：只 gate 存量兜底）

```text
// 通道一：计数增长 —— 自限（基线更新后下轮不再成立），不 gate
const limitCount = countLimitMarkers()
if (limitCount > limitMarkerBaseline) {
  limitPosted = true          // ← 边界补丁：一并锁死，防同轮 limitStale 补枪
  limitMarkerBaseline = limitCount
  post({ kind: "limit" })
  return
}
// 通道二：存量兜底 —— limitStale 每轮恒真，必须 gate
const limitStale = limitCount > 0 && assistantRootBaseline > 0 && countAssistantRoots() <= assistantRootBaseline
if (!limitPosted && limitStale) {
  limitPosted = true
  post({ kind: "limit" })
  return
}
```

**与文档1 的差别**：文档1 把两条通道塞进同一个闸门，会连真信号一起挡；此处只压通道二。
**边界补丁**：通道一 post 后也置 `limitPosted`（两文档都没写透这一点）。

### 1.3 重置点

`user.js:1165`（fill）与 `:1210`（rotate）的 `stopPosted = false` 后各加一行 `limitPosted = false`。

### 1.4 副作用（必须知道）

修复 1 只是**止血**：误报源未消时，从「每轮 N 次」降到「每轮 1 次」，用户「一直弹」的观感**不解决**。
⇒ 必须配修复 2 消源。

### 1.5 已知边界

若某轮既不 fill 也不 rotate（循环停了 / 手动操作）⇒ `limitPosted` 永不复位 ⇒ 触顶不再报。可接受，但须写进注释。

## 2. 修复 2：净掉 fixture 裸字面量 + 扩 ratchet 扫描范围

**替代文档1 的「收紧英文分支」**——正则一字不改，真错文命中能力零损失。

### 2.1 净掉 fixture（`limit-marker-guard.node-test.ts:90`）

```text
改前：  'context length limit exceeded',
改后：  'context length ' + 'limit exceeded',
```

**原理**：正则要求 `context length ` 后紧跟 `limit`/`exceeded`/`too long`；
拼接后文件文本是 `context length ` + 引号 ⇒ 该位置后是引号，不匹配 ⇒ dump 该文件不再自命中。

**验收**：正例断言（`:92-95`）必须仍通过——运行时 `re.test(s)` 的 `s` 逐字未变。

### 2.2 ❌ 原案作废：ratchet ⑦ **不能**扩到测试文件（实测推翻，2026-10-10 16:05）

原案「把 `limit-marker-guard.node-test.ts` 加进 `SOURCES`、跑一遍看存量」——**该文件必然红，且与 fixture 无关**。

实测（提取 `user.js` 真正则，扫该测试文件）：

```text
测试文件自命中数: 11
样本: 达到对话长度上限，请开启新对话 / 对话长度已达上限，请开启新对话 /
      上下文过长，请开启新对话 / 会话已达上限，请开启新会话 …
把 :90 fixture 改分段拼接后，剩余: 10
```

**原因**：测试文件的职责就是**存放正例**。它的头注释（`:5` 引述真 banner）与 samples 数组（中文触顶文案）
天然就匹配探针正则 ⇒ 「零自命中」这条 ratchet 对测试文件**结构性不成立**。
硬要做只有两条路：把 10 处正例全改成拼接（文件不可读）或给 ratchet 开白名单（判据空心）。**两条都不接受**。

**⇒ 改用「裸串 census」（与 stopped 侧 `stop-notice.node-test.ts` 同范式）**：

- 判据对象不是「正则是否自命中」，而是**「`context length limit` 这一裸串在源码里出现几次」**；
- 扫描范围：全仓源码，**排除运行态** `.workbuddy/`、`.ai-runner/`、`.git/`、产物 `dist/`（仓库既有纪律）；
- 现状实测：全仓**唯一**命中就是 `:90`；改分段拼接后 ⇒ **0**；
- 承重：把 `:90` 改回裸字面量 ⇒ census 转红（真承重，非恒真）。

这与 ratchet ⑦ 是**两条互补但不同口径**的锁：⑦ 锁「探针源码不许自命中」（只管 3 个源文件，不动），
census 锁「该裸串不许出现在任何源码里」（管全仓，逐字精确，不会被正例误伤）。

### 2.3 残留通道（诚实记录）

| 通道                          | 现状                  | 处置                             |
| :---------------------------- | :-------------------- | :------------------------------- |
| fixture 文件被 dump（无围栏） | 本次关闭              | 裸串 census（§2.2 修订版）       |
| AI 行文复述该串               | **未关闭**            | 配合修复 1 降为每轮 1 次，可接受 |
| 其它文件含裸串                | 实测全仓仅 `:90` 一处 | census 覆盖，改后归零            |

## 3. 修复 3：`_limitReported` ↔ `limitPosted` parity 断言

**动因**：今天已**三次**撞上「headless 有、油猴没有」。补一条结构化断言防第四次。

**写法**：仿 `stopped-baseline-guard.node-test.ts` 锁 `_stoppedReported` 的范式——
从两个文件提取旗标的「声明 / 置位 / 复位」三处，断言结构同构。

**改动面**：仅 `packages/core/tests/limit-marker-guard.node-test.ts`（或新建 guard）。

## 4. 收紧英文分支：暂缓（降级为取证后待办）

文档1 主张收紧 `context length (?:limit|exceeded|too long)`，复检后**暂缓**，理由：

1. **前置条件不可得**：真 DeepSeek banner 形态需真站点取证，`limit-marker-fp-fix.md §8.3` 已判不可得。
2. **实现有雷**：`[^\n]*?` 在整页 `textContent` 里近乎无界（消息间无换行），会拼接误报。
3. **漏报风险**：若真错文无 token 数，收紧 ⇒ 死会话永不报告 ⇒ 每轮干等到超时。

**若日后取证到真 banner 形态**，收紧必须满足：

- 用**有界窗口**（如 `.{0,40}?`），禁用 `[^\n]*?`；
- 三处内联同构（`user.js:263` / `headless-inject.ts:173` / `headless-inject-simple.ts:156`）；
- `eslint --fix` 后重跑三处 parity（`@antfu` 会重写正则，已实测）。

## 5. 执行顺序

1. **修复 1**（`limitPosted`，拆分写法）—— 止血，风险低
2. **修复 2**（净 fixture + 扩 ratchet 到测试文件）—— 消源，零漏报风险
3. **修复 3**（parity 断言）—— 防第四次分叉
4. 修复 4（收紧英文分支）—— **不做**，取证后再评估

1+2+3 可一轮做完。

## 6. 闸门（顺序执行，失败即停）

```text
CODEBUDDY_SAFE_DELETE_ENABLED=0 pnpm typecheck
pnpm lint
pnpm test:unit
pnpm anchors:verify && pnpm docs:verify && pnpm crossfile:verify
```

## 7. 变异承重（每例须「改恒等必红」，且还原双等校验）

| 变异                                     | 期望                                                | 还原校验                  |
| :--------------------------------------- | :-------------------------------------------------- | :------------------------ |
| 删 `limitPosted`（触顶分支退回无守卫）   | 守卫用例「每轮只 post 一次」转红                    | sha1 == 原值 && != 变异态 |
| fixture `:90` 退回裸字面量               | 裸串 census 转红（全仓 1 处 → 0 的判据）            | 同上                      |
| 裸串 census 的正则改用「是否自命中」口径 | 被测试文件 10 处正例撑红且无法收口 ⇒ 反证口径不可换 | 同上                      |
| 三处内联正则之一改写                     | parity 用例转红                                     | 同上                      |

**还原双等校验**是仓库纪律——只验证「等于原值」不够，须同时确认「不等于变异态」，
否则可能出现「变异未真正施加」导致的假绿。

## 8. 部署取证

1. `pnpm build`（headless 侧改动进产物；油猴脚本不涉构建但须版本号递增）
2. `@version` 1.7.1 → **1.7.2**（当前实测 1.7.1）
3. **重启 5175 归宿主侧**（instance-ownership-v1）：本轮只报告「产物已更新，请宿主侧重启」，
   不自行 `pm2 restart`（未获显式授权）。
4. `curl -s http://127.0.0.1:5178/tampermonkey-session-id.user.js | grep -m1 @version` → 确认 1.7.2
5. 磁盘 vs 活端点 sha1 比对
6. **用户在油猴面板手动更新到 1.7.2**（页面里生效的只有用户自己更新那一份）

## 9. 执行回执（2026-10-10 16:11–16:20，修复 1+2+3 已落盘并部署）

### 9.1 实际改动

| 修复                  | 落点                                                                                                                                                                         |
| :-------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 `limitPosted`       | `user.js:209` 声明 / `:759` 通道一置位 / `:772` 通道二门 + `:773` 置位 / `:1195`（fill）`:1241`（rotate）复位                                                                |
| 2 净 fixture + census | `limit-marker-guard.node-test.ts:90` 改 `'context length ' + 'limit exceeded'`；新增「裸串 census」用例（扫 `packages`/`apps`/`scripts`，排除 `node_modules`/`dist`/运行态） |
| 3 parity 断言         | 新增「limit 推送去重…四处同构」用例：headless `_limitReported`（声明/守卫/置位）+ 油猴 `limitPosted`（声明 1 / 置位 ≥2 / 复位 ≥3 / 门 1）                                    |
| 版本号                | `@version` **1.7.1 → 1.7.2**                                                                                                                                                 |

### 9.2 判据

- 单跑守卫文件：**14 tests passed**（原 12 + 新增 2）。
- 全量闸门：vitest **184/185 文件、1656/1657 测试通过**；4×tsc exit 0；`eslint .` 0 error；docs / anchors / crossfile 全 0。
- ⚠️ **唯一红项与本次改动无关**：`lessons-hygiene`「待复核 109/356 = 30.6% > 30%」。
  独立性已核验：该用例只读 `.ai-runner/lessons.md`（+ `scripts/lessons-parse.cjs`、`lessons-status.cjs`），
  **不读** `user.js` 或本守卫文件 ⇒ 非本次改动引入（15:35 时该用例仍绿，期间由并行会话的 DONE 自动入库顶过阈值）。
  ⇒ 需单开治理轮：**再核实 3 条**（109 → ≤106）即回到线下。

### 9.3 变异承重（3 例全红 + 还原双等）

| 变异                                                                              | 结果                         |
| :-------------------------------------------------------------------------------- | :--------------------------- |
| A｜移除 `limitPosted` 门（`if (!limitPosted && limitStale)` → `if (limitStale)`） | 红（failed=1），还原双等通过 |
| B｜fixture 退回连写                                                               | 红（failed=1），还原双等通过 |
| C｜删掉 rotate 处的 `limitPosted` 复位                                            | 红（failed=1），还原双等通过 |

脚本 `.ai-runner/tmp/mutation-limit-posted.cjs`（备份按文件去重 + sha1 `== 原值 && != 变异态` 双等）。

### 9.4 部署取证

| 项         | 值                                                                                            |
| :--------- | :-------------------------------------------------------------------------------------------- |
| 客户端资产 | 换名 **`index-Camfd5GQ.js`**，sha1 `3ad0664f…`（175654 B），活端点与磁盘 `cmp` **逐字节相等** |
| 油猴脚本   | 5178 供 `@version **1.7.2**`，sha1 `c9896c99…`（73890 B）与磁盘相等，`limitPosted` 6 处命中   |
| 实例       | `pm2 restart ai-runner` ⇒ 5175 监听 pid **64766**；`/__ai/preset/system` **200**              |

### 9.5 遗留

- **需人工**：油猴面板更新到 **1.7.2**（否则页面侧仍跑旧脚本，`limitPosted` 不生效）。
- **修复 1 只是止血**：误报源已消（fixture 裸串归零），但「AI 行文直接复述该串」这条**无围栏通道**仍未关闭（§2.3）；修复 1 把它压到每轮 1 次。
- **修复 4**（收紧英文分支）维持暂缓（§4）。
- **lessons 台账卫生**红项，见 §9.2，需单开治理轮。
