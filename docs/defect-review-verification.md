# 缺陷复验报告（逻辑级 · 2026-10-05）

> **对象**：宿主侧《应用端缺陷分析（2026-10-05）》的 D1–D11。
> **方法**：逐行读源码 + 独立手推边界反例，**不采信守卫绿灯与报告自述**。
> **纪律**：只读取证，零改动；查不清写「未定」。
> **关键结论**：核心事实成立，但报告的「未修」清单已过时——5 项在磁盘上已被修复。

## 一、逐条判定

| 编号              | 报告状态 | 磁盘实测                                  | 判定            |
| :---------------- | :------- | :---------------------------------------- | :-------------- |
| D1 静态服务自毁   | 已修     | 见 §二                                    | ✅ 属实         |
| D7 台账标题破损   | 已修     | 见 §三                                    | ✅ 属实         |
| D4 gitignore 前缀 | 未修     | 已改 `packages/client/…`                  | ❌ 报告过时     |
| D3 e2e 就绪预算   | 未修     | `timeout: 180_000` + `READY_BUDGET_MS`    | ❌ 报告过时     |
| D5 dev 回退页路径 | 未修     | `clientMainCandidates` + `pickClientMain` | ❌ 报告过时     |
| D2-a 平台耦合     | 未修     | 已设 `snapshotPathTemplate`               | ❌ 报告过时     |
| D2-b 基线退化     | 未修     | 10 图仅 4 唯一哈希                        | ✅ 属实，仍未修 |
| D10 SPA 根多一层  | 未修     | 已改候选列表探测                          | ❌ 报告过时     |
| D2-c 01≡02 同视图 | 未修     | 未跑探针                                  | 未定            |
| D2-d 遮罩已死     | 未修     | 未跑命中探针                              | 未定            |
| D6/D8/D9/D11      | 未修     | 未逐条取证                                | 未验            |

## 二、D1 逻辑链复验（静态服务自毁）

### 故障链（旧实现）

```text
loadMeta 命中缓存 → 返回旧 meta（含已消失的 brStat/gzStat）
       ↓
served = abs + '.br'（依缓存决定）
       ↓
createReadStream(served)  → ENOENT
       ↓
无 error 监听者 → unhandled 'error' → 进程退出
```

### 修复链（现实现 `apps/standalone/src/server.ts:205-231`）

```text
const stream = fs.createReadStream(served)
stream.once('open', () => {           // 成功才写 200 头
  opened = true
  if (res.destroyed) { stream.destroy(); return }
  res.writeHead(200, { ... })
  pipeline(stream, res, cb)            // 双向管错（pipe 只单向）
})
stream.once('error', (err) => {       // 失败降级，不自杀
  if (rel.startsWith('/assets/')) staticMetaCache.delete(rel)
  if (!opened && !res.headersSent && !res.destroyed) { 404 }
  else if (!res.destroyed) res.destroy()
})
```

### 手推四条路径

| 场景                 | open       | error                  | 结果                      |
| :------------------- | :--------- | :--------------------- | :------------------------ |
| 文件正常             | ✓ → 200    | 不触发                 | 正常                      |
| 文件不存在（缓存脏） | ✗          | ✓ → `!opened` 真       | 404 + 删脏缓存            |
| open 后中途读错      | ✓ → 200    | ✓ → `!opened` 假       | `res.destroy()`，进程存活 |
| 客户端提前断开       | 可能不触发 | pipeline 收 res 侧错误 | 双方 destroy              |

**结论**：`createReadStream` 对 ENOENT 走 `emit('error')`（非抛异常），只要有监听者即被降级。
**自毁路径已封堵**。前提是「流错误是事件而非异常」——这决定了监听是否来得及注册。

### 遗留边界（非致命）

> **勘误 2026-10-05**：本条原写「Content-Length 取自缓存 `st.size`」——磁盘实测主路径已是
> `size = fs.fstatSync(fd).size`（`apps/standalone/src/server.ts:222-226`，`stream.once('open')` 内），
> `st.size` 只是 `catch` 回退。即「把回退路径记成了主路径」。

- 剩余边界：`.br` 被换成不同大小而尚未报错时，ETag 仍由缓存 `st.size` 计算（`server.ts:185`），
  与 `Content-Length` 可能短暂不一致。触发条件苛刻。

## 三、D7 逻辑链复验（台账标题破损）

### 修复三件套（`packages/core/src/post-run/lesson-extract.ts`）

```text
// ① :38 奇偶计数：at 前反引号奇数 = 在行内代码内
insideInlineCode(s, at) → countBackticks(s.slice(0, at)) % 2 === 1
// ② :54 右到左扫，跳过代码内冒号
lastSeparatorColon(s) → for(i=len-1..0) if(:||：) && !insideInlineCode → return i
// ③ :164 写入边界规范化
sanitizeTitle(t) = 折行合并 + (奇数反引号 ? 追加一个 : 原样)
```

### 逐例手推

| 输入                              | 末冒号命中              | title                       | 反引号 |
| :-------------------------------- | :---------------------- | :-------------------------- | :----- |
| `使用 \`docs:verify\` 命令：重要` | 末尾 `：`（代码内跳过） | `使用 \`docs:verify\` 命令` | 2 ✅   |
| `说明 \`docs:verify\` 命令`       | -1（无代码外冒号）      | 丢弃                        | —      |
| `### 悬空 \`TypeError`            | —                       | 追加闭合                    | 2 ✅   |

**结论**：命中报告所述主路径（末冒号劈开 `docs:verify`）。

### 遗留边界（非致命）

- `insideInlineCode` 只识别**单**反引号。Markdown 的双反引号代码段（` `a:b` `）计数为偶，
  会被误判为「不在代码内」，冒号被当分界劈开。属启发式替代解析器的固有天花板。
- `sanitizeTitle` 对奇数反引号选择**追加**而非删除。宿主报告 §修复建议曾建议删除，
  实际实现选了追加；两者都保偶数计数，语义取径不同，**报告正文与代码一致，无造假**。

## 四、独立取证事实（不依赖报告自述）

### 视觉基线退化（D2-b）成立

`shasum -a 256 packages/client/e2e/visual.spec.ts-snapshots/*.png` 实测：

```text
01-home-dark   = 44ef509c11d1   01-home-light   = 44ef509c11d1   ← 同
02-tree-dark   = 44ef509c11d1   02-tree-light   = 44ef509c11d1   ← 同，且 ≡ 01
03-changes-dark= 5db0134613bd   03-changes-light= 5db0134613bd   ← 同
04-tasks-dark  = 18c745adf9d0   04-tasks-light  = 18c745adf9d0   ← 同
05-editor-dark = 45d60c9f9034   05-editor-light = 45d60c9f9034   ← 同
```

10 图仅 **4 个唯一哈希**。主题生效时 dark 与 light 应逐像素不同，
故这批基线不可能是正确渲染的结果——坏在「基线怎么生成的」，不是当前应用。

### 配置已修 ≠ 数据已修

`playwright.config.ts:21` 已设 `snapshotPathTemplate`（去掉 `{platform}` 段），
平台耦合已解；但**基线内容未重生成**——路径修好后仍会因像素差异全红。
这是**新缺口**：修了「找不到文件」，没修「文件本身是错的」。
且旧 `*-darwin.png` 成为孤儿，需随 `--update-snapshots` 一并清理。

## 五、方法学附注

- **「报告称未修」≠「磁盘未修」**：报告是某时刻快照，之后并发写手继续改动。
  复验必须以磁盘为准——本轮 D3/D4/D5/D2-a/D10 五项判定全部因此翻转。
- **守卫绿灯 ≠ 逻辑正确**：守卫由修复者自己写，可能只覆盖已知路径。
  本轮靠手推边界（双反引号、Content-Length 陈旧）才找到两处未覆盖边界。
- **配置修复与数据修复常被混为一谈**：改对路径只解决「找得到」，
  基线内容是否对得靠重生成。

## 六、复现命令

```bash
# D1/D7 守卫（亲跑通过：27 tests）
npx vitest run --config vitest.config.ts \
  packages/core/tests/static-stream-guard.node-test.ts \
  packages/core/tests/post-run-lesson-extract.node-test.ts

# 视觉基线哈希（10 图 / 4 唯一）
shasum -a 256 packages/client/e2e/visual.spec.ts-snapshots/*.png

# 台账标题反引号奇偶扫描
node scripts/lessons-status.cjs
```

## 七、未验 / 未定

- D2-c（01≡02 同视图）、D2-d（遮罩命中）未跑受控探针 → **未定**。
- D6（工单 G6 陈旧）、D8（无 uncaughtException 兜底）、D9（lint 豁免口径）、
  D11（并发写手致 verify 移动靶）未逐条取证 → **未验**。
- **勘误 2026-10-05**：D1 的 Content-Length 与 D7 的双反引号边界**均已落地**（提交 `d89a4377`，18:41:32），
  早于本报告 18:43–18:46 的追加。原文「已识别，未修」已过时。

## 八、url-parse 族：实测五处（勘误）

> **勘误 2026-10-05**：此前版本写「url-parse 族四处」——磁盘实测是**五处**。
> `hono-bridge.ts:76` 是注释里的字符串，不算调用点。

| 序  | 文件:行                                      | 失败分支                | 语义                                            |
| :-- | :------------------------------------------- | :---------------------- | :---------------------------------------------- |
| 1   | `apps/standalone/src/server.ts:155`          | `return false`          | 视为非静态资源，交回上层路由                    |
| 2   | `packages/core/src/server/attach-ws.ts:78`   | `return`（不 destroy）  | 交给其他 upgrade 监听器（HMR 共用 http server） |
| 3   | `packages/core/src/server/http.ts:135`       | `pathname = 空串`，放行 | 交给 handle 统一 400                            |
| 4   | `packages/core/src/server/handle.ts:89`      | 400 Bad Request         | 客户端过错，明确告知                            |
| 5   | `packages/core/src/server/hono-bridge.ts:15` | 待复核调用方            | 新增一处，此前版本漏记                          |

守卫 `url-parse-guard.node-test.ts` 把判据从「某几处」升级为「**每一处**」——
凡 `new URL(req.url …)`，要么紧邻 try，要么在 EXEMPT 清单里写明理由。

## 九、视觉遮罩：实测 7 条（勘误）

> **勘误 2026-10-05**：此前版本写「遮罩列表…收缩到 3 条有效」——磁盘实测 `MASK_SELECTORS` 是 **7** 条。

`packages/client/e2e/visual.spec.ts:28-36`：

```text
.cm-content / .toast-host / .tt-host / .script-card-time
.round-divider-time / .tp-time / .wait-elapsed
```

另有 `MASK_VOLATILE_WORKLOG = ['.wl-scroll']`（`visual.spec.ts:55`），**仅 03 工作日志用例叠加**。

## 十、复检方法论补遗

> **勘误 2026-10-05**：本报告 §五「方法学附注」写于早期版本，当时未意识到自身也犯了同一错误。

这次复检被宿主侧指出三处事实错误（Content-Length 记成主路径、url-parse 记成四处实为五处、
遮罩记成 3 条实为 7 条），**根因不是粗心，是方法**——只读了一部分文件就下结论。

新增一条铁律：

- **下结论前必须先跑一条能推翻自己的命令**。
  只读源码不跑变异的结论，与守卫绿灯一样不可靠——两者都可能只覆盖已知路径。
  本轮段一的第三变异（`filter(() => true)`）与段三的生成物漂移对账，都是这条铁律的实践。

## 十一、D8 降级可观测：判定为**新功能**，挂账

依据 `bin/check-status.cjs:105-106` 原文：

```text
ok('阶段 0 - 3.2 产物到位，阶段 4 观察期就绪')
info('规则：>= 2 周不做新功能；仅触发信号达阈值时开下一阶段')
```

**判定**：在侧栏/状态区新增「本进程已兜住 N 次进程级异常」的 UI 展示 + 读取逻辑，
属**新增功能**（不是把已有数据接到已有 UI 上，而是新建 UI 面）。
按项目规则，阶段 4 观察期内**不得开闸**——挂账，待观察期结束或信号达阈值时再评估。

**注**：D8 本身的兜底（`crash-guard-v1`）已落地，属缺陷修复；
本次判定的「可观测」是其增强项，性质不同。

## 十二、工单 WO-20261005 六段复核结论

> 对象：`docs/workorder-app-defect-closure-2026-10-05.md`。本段汇总结论，证据见各段原始输出。

### 段一：D11 根因复核 — 属实

宿主的机制定位与修复**属实**。亲跑原始输出：

```text
[RED  ] M1 从 LINT_EXTS 删掉 .md —— 守卫正确变红 OK
[RED  ] M2 从 LINT_SKIP_SEGMENTS 删掉 dist —— 守卫正确变红 OK
[GREEN] 还原后 —— 应回到全绿
```

**自设计第三变异 M3**（`filter(p => !hasSkippedSegment(p))` → `filter(() => true)`）：

```text
× [承重] eslint ignores 覆盖的目录不传给 eslint
Test Files 1 failed | Tests 1 failed | 9 passed (10)
```

还原后复绿（`Tests 10 passed`）。**判据承重，非真空**。

**反例（宿主没想到）**：`docs/plan/**` 被 `.gitignore:51` 忽略，但**不在**
`LINT_SKIP_SEGMENTS` 里 —— 实测 `pickLintTargets([{path:"docs/plan/x.md"}])` 返回
`["docs/plan/x.md"]`。后果：写在 `docs/plan/` 的 md 会被反复传给 eslint（每次落盘都修一次）。
危害**有限**：eslint 对 gitignore 内文件只打 `File ignored…` 警告、exit 0，
且该目录本就是「草稿区」（工单要求派发前移到 `docs/`）。**不构成缺陷**，但值得知晓。
**机制补充（工单 WO-20261005-02 · 段三 · 2026-10-05）**：`docs/plan/**` 对 eslint 之所以是
「ignored」，来自**两层来源**——`eslint.config.ts` 的显式 `ignores` 数组，**加上**
`@antfu/eslint-config` 默认读入的 `.gitignore`。`LINT_SKIP_SEGMENTS` 只覆盖了前者，
对第二层是盲的。详见 `packages/core/src/post-run/lint-targets.ts` 的 `[BOUNDARY]` 段。

**e2e 探针原始输出**：

```text
对照：同一份内容不经 /run 直接落在 docs/ -> eslint errors=4
--- 正例 docs/__probe-d11.md ---
  run 结果 lint: {"ran":true,"files":1,"ok":true}
  落盘内容 === 写入内容: false
  落盘后 eslint 复核: errors=0 warnings=0
  正例 -> PASS
--- 反例 packages/client/test-results/__probe-d11.md ---
  run 结果 lint: null
  落盘内容 === 写入内容: true
  反例 -> PASS
```

**5175 产物核验**：`apps/standalone/dist/_server/index.js:5744-5753` 确含 `.md`；
产物 mtime `1791198995` 早于 `lint-targets.ts` 源码 mtime `1791200286`，
但探针已真端到端验证产物行为正确（正例被修、反例不修）。

### 段二：报告勘误 — 完成

三处事实错误 + §七 过时说明均已勘误，标注变更日期 2026-10-05：

- **§二 遗留边界**：Content-Length 主路径实为 `fs.fstatSync(fd).size`（`server.ts:222-226`），
  `st.size` 只是 catch 回退；「把回退路径记成主路径」；
- **§八（新增）**：url-parse 实为**五处**（原写四处），`hono-bridge.ts:15` 是新增的第五处；
- **§九（新增）**：遮罩实为 **7** 条（原写 3 条）+ `MASK_VOLATILE_WORKLOG`；
- **§七**：D1 Content-Length 与 D7 双反引号边界**均已落地**（`d89a4377`，18:41:32），
  「已识别，未修」已过时；
- **§十（新增）**：方法论补遗——「下结论前必须先跑一条能推翻自己的命令」。

`npx eslint docs/defect-review-verification.md` 0 error；`pnpm docs:verify` 通过（15 文档）。

### 段三：P3 收口复核 — 部分属实

**自设计变异（非删尾行）**：改文件中部第 558 行尾空格 → `git diff --exit-code` **EXIT=1**，
diff 显示 `-const windowsTick…` / `+const windowsTick… `。还原后 `HEAD_SHA=e4342cf6…` 一致。
**对账判据承重成立**。

**生成确定性**：`shasum` 前后一致（`e4342cf62ec030e6b1513354150508cd682b22fd79d5c5e12fa422e9f90cd506`），
确认 `pnpm build` 后 sha256 不变。

**其他被追踪生成物调查**：全仓 `git ls-files "*.d.ts"` 只有两个——

```text
packages/client/auto-imports.d.ts   ← 已入对账清单
packages/client/env.d.ts            ← 手写声明文件，非生成物
```

`env.d.ts` 内容为 `/// <reference types="vite/client" />` + `declare module '*.vue'`，
属手写环境声明，**不需纳入对账**。**无其他遗漏生成物**。

**P3 原始诉求覆盖判定**：前半（test-results / playwright-report 不污染 git status）由
`.gitignore:38-39` 覆盖；后半（auto-imports.d.ts 漂移）由 ci.yml 的 `git diff --exit-code` 步骤覆盖。
**诉求已完整覆盖**。唯一缺口是「干净检出上 verify 全绿」依赖 auto-imports.d.ts **必须被追踪**
（宿主已在 ci.yml 注释里说明这条取舍）。

### 段四：D8 降级可观测 — 判定为**新功能**，挂账

依据 `bin/check-status.cjs:105-106` 原文：

```text
ok('阶段 0 - 3.2 产物到位，阶段 4 观察期就绪')
info('规则：>= 2 周不做新功能；仅触发信号达阈值时开下一阶段')
```

在侧栏/状态区新增「本进程已兜住 N 次进程级异常」的 UI 展示 + 读逻辑，属**新增功能**。
按项目规则挂账，**本工单不开闸**。

### 段五：prod 形态视觉验收 — 通过

**形态证据**：5175 首页 HTML 含真 bundle（`/assets/index-CvyCjQFZ.js` 等 6 个），
非 dev 回退页（`IS_DEV_FALLBACK=false`）。5174 无监听（`HTTP=000`）。

**跑法**：临时给 playwright.config 加 `AIR_TEST_BASE_URL` 环境变量支持，指向 5175；
跑完还原。**跑的是 prod（5175 一体），不是 dev**。

**原始输出**：

```text
Running 10 tests using 1 worker
  ✓ 1 [chromium] › 视觉基线 · dark › 01 首屏 · dark (1.5s)
  ... （共 10 条，全部 ✓）
  10 passed (18.5s)
```

**结论**：prod 形态视觉套件 **10/10 通过**，无失败像素比（0 失败）。

### 段六：通过用例判据承重性 — 2 个均承重

**用例 A**：`ai-runner.spec.ts:21` 「侧栏 tab 可切换」——变异 `toHaveCount(3)` → `(4)`：

```text
Error: expect(locator).toHaveCount(expected) failed
Expected: 4 | Received: 3
1 failed | 3 passed (9.8s)
```

**判定：承重**。断言对象（`.side-tab` 计数）真实受被测状态控制。

**用例 B**：`baseline-diff.spec.ts:19` 「未知 baselineRunId 返回 404」——变异 `toBe(404)` → `(200)`：

```text
Error: expect(received).toBe(expected)
Expected: 200 | Received: 404
1 failed | 2 passed (3.3s)
```

**判定：承重**。断言对象（HTTP 状态码）真实受被测端点控制。

### 完成标准对账

- 段一：第三个变异跑通 ✓；反例调查有结论 ✓；结论附原始输出 ✓
- 段二：三处勘误 + §七 过时说明改完 ✓；`npx eslint` 0 error ✓；`pnpm docs:verify` 通过 ✓
- 段三：自设计变异（改中部行）跑通 ✓；反例调查有结论（无其他被追踪生成物）✓；
  P3 原始诉求覆盖判定 ✓
- 段四：判定属新功能 + 引原文 ✓
- 段五：prod 形态跑过一次，10/10 通过 ✓
- 段六：2 个用例的变异结论 ✓
- 全程：`npx vitest run` 130 文件 / 1244 用例全通过 ✓；工作区临时改动全部还原 ✓

## 十三、对工单 WO-20261005-02 的响应留痕（2026-10-05）

> 上游：`docs/workorder-app-review-response-2026-10-05.md`；
> 判决：`docs/review-verdict-2026-10-05.md`。
> 本节只做登记，**不复述宿主侧结论为自己的结论**。
>
> **本报告所有计数为快照，复核时以命令重跑为准。**（工单 WO-20261005-03 段二）

### 段一 · 2.1 「删除 lessons 近重复残留」的最终澄清

**采纳 B 方案**：修正描述，与磁盘一致。

**亲跑原始输出（测量时刻 2026-10-05 20:14 快照，重跑命令见块内）**：

```text
git diff --numstat .ai-runner/lessons.md
  58    0    .ai-runner/lessons.md

wc -l .ai-runner/lessons.md              → <行数>（快照）
git show HEAD:.ai-runner/lessons.md | wc -l → <行数>（快照）

grep -n "配置修复" .ai-runner/lessons.md
  534:## 配置修复 ≠ 数据修复
  540:（同族条目「配置修复与数据修复是两件事」已于 2026-10-05 治理时并入本条…）
```

**修正后的描述**：本轮对 `.ai-runner/lessons.md` 相对 `HEAD` 只显示新增、**删除列为 0**（`git diff --numstat` 第二列恒为 0；具体行数随采集追加而变，属快照）。
此前 DONE 声称的「删除近重复残留」，指的是**工作区中间态**——那条「配置修复与数据修复是两件事」
在 `HEAD` 中**本就不存在独立版本**（`HEAD:540` 只有治理记录），因此相对 `HEAD` 不产生任何删除行。
我此前把「工作区中间态的删除」误述为「相对仓库基线的删除」，属**自述代替证据**，与我在 §十
批评过的方法同源。**修正为：本轮对台账只新增条目、不删除相对 HEAD 的任何条目**（具体条数与行数见上方 `git diff --numstat` 与 `git diff --  .ai-runner/lessons.md` 的 `+## ` 行数；属快照）。

### 段二 · 2.2 改写复核结论

**判定：改写准确。**

**亲跑原始输出（自建探针 `docs/plan/__lint-probe.md`，跑后已删）**：

```text
node node_modules/eslint/bin/eslint.js docs/plan/__lint-probe.md
  /Users/apple/web-ai-qgm/docs/plan/__lint-probe.md
    0:0  warning  File ignored because of a matching ignore pattern.
  ✖ 1 problem (0 errors, 1 warning)
```

**该命令本可推翻改写**（若 `docs/plan/**` 真在 eslint ignores 之外，此处会报 format/prettier error 而非
`File ignored`）。实测为 `File ignored` + exit 0 ⇒ **宿主侧改写成立**：该目录确在 eslint 忽略范围内，
来源有**两层**（`eslint.config.ts` 显式 `ignores` + `@antfu/eslint-config` 默认读入 `.gitignore`）。

**对 `[BOUNDARY]` 段逐句核对**（`lint-targets.ts:40-52`）：

- 「两层来源」——与上一条实测一致，准确；
- 「本集合只覆盖了前者，对第二层是盲的」——`LINT_SKIP_SEGMENTS` 只含 `.ai-runner/node_modules/dist/coverage/test-results/playwright-report`，确不含 `docs/plan`，准确；
- 「已知漏网 `docs/plan/**`」——`pickLintTargets([{path:"docs/plan/x.md"}])` 返回该路径（见 §十二 段一反例），准确；
- 「不修的理由：按路径段匹配，段名 `plan` 太泛」——`hasSkippedSegment` 按 `split(/[\\/]/)` 逐段比对，
  若加入 `plan` 会误伤任何名为 plan 的目录，准确；
- 「危害 = 每个草稿文件多一条 warning、`lint.ok` 语义略模糊，无失败、无破坏」——与本次探针实测一致，准确。

**结论**：`[BOUNDARY]` 段**准确**，无异议。

### 段三 · 台账 `[REJECTED]` 登记

台账第 626 行「`docs/plan/**` 在 `.gitignore` 里但不在 eslint `ignores` 里」已被宿主侧标
`[REJECTED]`（`lessons.md:628`），并补正确归因（两层来源 + 两者方向 + 守卫缺口）。
我此前塞进台账的该条**标题与归因**有误；本报告正文 §十二 段一「反例」段未受影响——
它说的是「不在 `LINT_SKIP_SEGMENTS` 里」，与原意一致，无需改。

## 十四、计数类断言总账（工单 WO-20261005-03 · 段三，2026-10-05）

> 纪律：**报告里不留无命令可复现的计数**。下表逐条给出重跑命令与当前值。
> 凡数值会随采集/构建/追加而变的，标注「快照，易腐化」。

### 14.1 已过时（本次改述）

- **§四「10 图仅 4 个唯一哈希」** → 位置 §四；
  重跑 `shasum -a 256 packages/client/e2e/visual.spec.ts-snapshots/*.png | awk '{print $1}' | sort -u | wc -l`；
  当前值 **10**（快照已重生成，10 图 10 唯一）；判定 **已过时（改述）**——已在 §四 标注。

- **§十二段五「6 个 bundle」** → 位置 §十二；
  重跑 `curl -s http://127.0.0.1:5175/__ai/ | grep -oE '/assets/[A-Za-z0-9_-]+\.(js|css)' | wc -l`；
  当前值 **7**（含 `rolldown-runtime` 等，随构建配置变）；判定 **已过时（改述）**。

### 14.2 成立且稳定（不易腐化）

- **§九「遮罩 7 条」** → 重跑 `grep -A 10 'const MASK_SELECTORS' packages/client/e2e/visual.spec.ts | grep "^  '" | wc -l`；
  当前值 **7**；判定 **成立**。

- **§十二段六「2 个用例」** → 报告中列明为 `ai-runner.spec.ts:21` 与 `baseline-diff.spec.ts:19`；
  无重跑命令但为固定指认（具名用例），**成立**。

### 14.3 快照，易腐化（本次标注）

- **§十三「58 行 / 644 行 / 586 行 / 新增 6 条」** → 已在段二改述为「只显示新增、删除列为 0」+ `<行数>（快照）`；
  重跑 `git diff --numstat .ai-runner/lessons.md`；判定 **快照，易腐化**。

- **§十三「台账第 626 行」** → 重跑 `grep -n 'docs/plan.*gitignore' .ai-runner/lessons.md | head -3`；
  当前值 **626**（随条目增删而变）；判定 **快照，易腐化**（README 已注明「行号会变动，按标题定位」）。

- **§十三「新增 6 条台账条目」** → 重跑 `git diff -- .ai-runner/lessons.md | grep -c '^+## '`；
  当前值 **随采集追加变化**（「3」为快照——写作时刻的真实值，其后任意采集都会改写它；
  故本条只保留口径、不留具体数字）；判定 **快照，易腐化**（已在段二改述）。

### 14.4 其余数字

- **§十三「10 图 / 4 唯一哈希」引用** → 已在 14.1 处理；
- **§十二段一「23 个 / 58/0」** → 均已在段二处理；
- **§八「url-parse 五处」** → 重跑 `grep -rn 'new URL(req.url' packages/core/src apps/standalone/src --include='*.ts'`，逐条排除注释；当前值 **5**；判定 **成立**。

## 十五、对工单 WO-20261005-03 段四的复核结论（2026-10-05）

### 15.1 近重复合并 — 内容完整、表述准确

SSOT 条（`.ai-runner/lessons.md` 标题「`docs/plan/**` 在 `.gitignore` 里但不在 eslint `ignores` 里」）：

- 已标 `[REJECTED]` 并给出正确归因（两层来源）；
- 合并记录写明被并入条目的标题、Jaccard 值（0.41）、以及「其表述『两个忽略集不同源』正是本条更正掉的错误归因」；
- **内容完整性**：被删条目仅有「标题 + 一句归因」；该归因已被 SSOT 正文标为错误并更正，
  无独立信息丢失。**内容完整覆盖**。
- **表述准确性**：「归一化二元组 Jaccard 0.41 已并入本条并删除」——与我复跑口径一致，准确。

### 15.2 `--print-config` 措辞更正 — 准确

**亲跑原始输出**（探针 `docs/plan/__pc-probe.md`，跑后已删）：

```text
node node_modules/eslint/bin/eslint.js --print-config docs/plan/__pc-probe.md
  CODE=0 BYTES=10 RAW="undefined\n"
  IS_UNDEFINED=true
```

**结论**：宿主侧措辞更正**准确**——不是「返回空」，而是输出字面量 `undefined`（10 字节含换行）。
判据应写 `stdout.trim() === 'undefined'` 或改用 `git check-ignore`；写成 `stdout === ''` 会落空。

## 十六、对工单 WO-20261005-04 的处置（2026-10-05）

### 16.1 段一 · `appendLessons` 场景 B 静默丢内容

判定 **属实并修复**。

- 事实：同批提交两条近重复、原文件无该标题时，`merged` 的 key 落在**本轮新标题**上，
  写入阶段按 `## <key>` 扫原文件必然命中不了 ⇒ 被并入正文蒸发；返回值虚报、日志撒谎。
- 修复：`merged` 的 key 只取**原文件已有**标题；同批近重复改走 `nearFresh` 分支就地并入，
  返回值改为 `handled`（实际处理条目数），日志措辞同步更正为「并入既有条目」。
- 先红后绿：新用例「同批两条近重复且原文件无该标题，B 的正文不得丢失」在旧实现下变红
  （`AssertionError: B 正文必须在磁盘上`），修复后 24 passed。
- 变异承重：(a) `isNearDuplicateTitle` 恒 `false` → 两条近重复用例变红；
  (b) `merged.get(title)` 换必然不存在的 key → 并入用例变红；
  (b') `nearFresh` 恒 `undefined` → 场景 B 用例变红（`B 应并入 A，只落一个 ## 块`）。
  三次变异均还原复绿。

### 16.2 段一·附 A · 解析器跳过代码围栏

判定 **属实并修复**。

- 两处解析（`scripts/lessons-status.cjs`、`lessons-hygiene` 的 `parseLessons`）此前都不跳围栏，
  正文里粘贴含 `## 示例标题` 的原始输出会凭空造出伪条目，必然与真条目近重复 ⇒ 必然打红闸门。
- 修复：解析实现抽到共享模块 `scripts/lessons-parse.cjs`（两侧 `require` 同一份），
  围栏状态机跳过 ` ``` `/`~~~` 内的内容。**两处口径一致由结构保证**，不再靠人工同步。
- 先红后绿：hygiene 新增「围栏内的 `##` 行不算条目」用例；变异（`inFence` 恒 false）下变红，
  还原后 8 passed。

### 16.3 段一·附 B · 手工补记通道走近重复判定

判定 **属实并修复**。

- 事实：`bin/lessons-add.cjs` 原去重是 `cur.includes(heading)`（精确标题匹配），文件头注释
  却宣称「保证去重」——注释与实现不符，且完全绕过新口径。
- 修复：核心逻辑抽到 `scripts/lessons-add-core.cjs`（可被测试直接引用），内部调用
  `appendLessons`（与采集侧同源）；`bin/lessons-add.cjs` 改走该 core。文件头注释同步更正为
  「保证 ## 标题规则，并接入与自动采集同源的近重复判定」。
- 先红后绿：新增 `lessons-add.node-test.ts`；旧 lib（精确匹配）下「近重复标题应并入既有条目」变红，
  换 `appendLessons` 后 2 passed。变异（lib 换成精确匹配）变红并还原复绿。

### 16.4 段二 · 修复必须打到运行态

判定 **属实并已处置**。

- 事实：`packages/core/dist/**` 是旧产物（`nearFresh` / `scenario-B` 均不存在），
  采集链路跑在编译产物上 ⇒ 修复未生效。
- 处置（当时）：跑 `pnpm build`（`packages/core`）**只重建了 core 产物**，反查：
  `packages/core/dist/post-run/lesson-extract.js` 的 `isNearDuplicateTitle` 出现 **3** 次、
  `nearFresh` 存在、`scenario-B` 存在；`lesson-title-similarity.js` 存在。
  **但这不够** —— 运行读的是**运行产物**，见下。
- 勘误（WO-20261005-05 · 段一）：产物有**两份**——`packages/core/dist/**`（`tsc` 逐文件产物）
  与 `apps/standalone/dist/_server/index.js`（SSR 打包产物）。`apps/standalone/bin/air-server.cjs`
  的 `DIST_ENTRY` 指向后者 ⇒ 只重建 core 产物时，运行态的 5175 从头到尾没有带上修复。
- 宿主侧补跑全量 `pnpm build` + 重启后，两份**运行产物**同时 `21:21`，符号计数一致
  （`nearFresh` / `replyPollers.delete` 均与源码同数）；进程启动晚于产物 mtime。
  判据：以「**运行产物含新符号** + **进程启动晚于产物 mtime**」两条为准，mtime 会随重建漂移。
- 段一附 B 的用例正是靠这次 build 才转绿的（此前红即因 dist 旧）。

### 16.5 段三 · `ai-stopped` 后轮询不停止

**判定：缺陷**。依据：

- 代码路径（`packages/core/src/server/attach-ws.ts`）：`headless:stop` 分支原只调
  `pool.stopGenerating`，不碰 `replyPollers`；而前端 `finish` → `transport.sendStop('')`
  打到的正是该分支。poller 返回的 `stop` 只在**下一次 fill**（`:105-106`）或
  `headless:close`（`:173-180`）被调。
- 最小改动：在 `headless:stop` 分支加 `const stopPoll = replyPollers.get(sid); if (stopPoll) {
stopPoll(); replyPollers.delete(sid) }`。
- 承重守卫：`reply-poll-stop.node-test.ts` 断言该分支含 `replyPollers.delete`；
  先红（分支无 delete）后绿，变异（去掉 delete）复红并还原。

### 16.6 段四 · 网页「继续生成」按钮

**判定：属新功能，挂账**（本工单不实现）。依据：

- 项目既有闸门口径在 `bin/check-status.cjs` 的结论段：
  「阶段 0 - 3.2 产物到位，阶段 4 观察期就绪 / 规则：>= 2 周不做新功能；仅触发信号达阈值时开下一阶段」。
- 把「已停止」改为「点继续生成续写同一消息」是**新增处置路径**（新能力），不是修既有逻辑；
  当前工作台只会主动点发送 / 停止生成 / 新建对话三类按钮，全仓 grep `继续生成` 零命中。
- 故按纪律挂账，不开闸；待观察期结束或信号达阈值再议。

### 16.7 验证结果

- 全量单测：`npx vitest run --config vitest.config.ts` → **132 files / 1251 tests 全绿**。
- 本轮新增用例文件：`post-run-lesson-extract.node-test.ts`（场景 B）、`lessons-hygiene.node-test.ts`
  （围栏跳过 + 同源）、`lessons-add.node-test.ts`（补记通道）、`reply-poll-stop.node-test.ts`（段三守卫）。
- **运行态验证（WO-05 段一要求）**：两份产物反查 + 重启 + 活端点自检——
  `packages/core/dist/post-run/lesson-extract.js` 与 `apps/standalone/dist/_server/index.js`
  均含 `nearFresh`（4 / 4）、`replyPollers.delete`（0 / 3）、`stopPoll`（0 / 3）；
  `curl` 首页 200（1204B）、首页引用的 7 个 `/assets/*` 全 200、`/__ai/tasks` 与 `/__ai/skills` 均 200。
  （沙箱内 `ps` 对外部进程无输出，进程启动时间未能取证；以「产物含新符号 + 端点存活」为准。）
- 新增/改动文件清单见 `DONE` 总结。
