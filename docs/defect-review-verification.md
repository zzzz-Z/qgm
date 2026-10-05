# 缺陷复验报告（逻辑级 · 2026-10-05）

> **对象**：宿主侧《应用端缺陷分析（2026-10-05）》的 D1-D11。
> **方法**：逐行读源码 + 独立手推边界反例，不采信守卫绿灯与报告自述。
> **纪律**：只读取证，零改动；查不清写「未定」。
> **关键结论**：核心事实成立，但报告的「未修」清单已过时——5 项在磁盘上已被修复。

## 一、逐条判定

| 编号              | 报告状态 | 磁盘实测                              | 判定         |
| :---------------- | :------- | :------------------------------------ | :----------- |
| D1 静态服务自毁   | 已修     | 见 §二                                | 属实         |
| D7 台账标题破损   | 已修     | 见 §三                                | 属实         |
| D4 gitignore 前缀 | 未修     | 已改 packages/client/…                | 报告过时     |
| D3 e2e 就绪预算   | 未修     | timeout 180000 + READY_BUDGET_MS      | 报告过时     |
| D5 dev 回退页路径 | 未修     | clientMainCandidates + pickClientMain | 报告过时     |
| D2-a 平台耦合     | 未修     | 已设 snapshotPathTemplate             | 报告过时     |
| D2-b 基线退化     | 未修     | 10 图仅 4 唯一哈希                    | 属实，仍未修 |
| D10 SPA 根多一层  | 未修     | 已改候选列表探测                      | 报告过时     |
| D2-c 01≡02 同视图 | 未修     | 未跑探针                              | 未定         |
| D2-d 遮罩已死     | 未修     | 未跑命中探针                          | 未定         |
| D6/D8/D9/D11      | 未修     | 未逐条取证                            | 未验         |

## 二、D1 逻辑链复验

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

### 修复链（apps/standalone/src/server.ts:205-231）

```text
const stream = fs.createReadStream(served)
stream.once('open', () => {           // 成功才写 200 头
  opened = true
  if (res.destroyed) { stream.destroy(); return }
  res.writeHead(200, { ... })
  pipeline(stream, res, cb)            // 双向管错
})
stream.once('error', (err) => {       // 失败降级，不自杀
  if (rel.startsWith('/assets/')) staticMetaCache.delete(rel)
  if (!opened && !res.headersSent && !res.destroyed) { 404 }
  else if (!res.destroyed) res.destroy()
})
```

### 手推四条路径

| 场景                 | open       | error                  | 结果                    |
| :------------------- | :--------- | :--------------------- | :---------------------- |
| 文件正常             | 成功 → 200 | 不触发                 | 正常                    |
| 文件不存在（缓存脏） | 失败       | 触发 → 未 opened       | 404 + 删脏缓存          |
| open 后中途读错      | 成功 → 200 | 触发 → 已 opened       | res.destroy()，进程存活 |
| 客户端提前断开       | 可能不触发 | pipeline 收 res 侧错误 | 双方 destroy            |

**结论**：createReadStream 对 ENOENT 走 emit error（非抛异常），只要有监听者即被降级。自毁路径已封堵。

### 遗留边界（非致命）

Content-Length 取自缓存 st.size（server.ts:213）。若 .br 被换成不同大小而尚未报错，header 与实际流不一致。

## 三、D7 逻辑链复验（台账标题破损）

### 修复三件套（packages/core/src/post-run/lesson-extract.ts）

```text
// :38 奇偶计数：at 前反引号奇数 = 在行内代码内
insideInlineCode(s, at) => countBackticks(s.slice(0, at)) % 2 === 1
// :54 右到左扫，跳过代码内冒号
lastSeparatorColon(s) => 从右找 : 或全角：，insideInlineCode 命中则 skip
// :164 写入边界规范化
sanitizeTitle(t) = 折行合并 + (奇数反引号 ? 追加一个 : 原样)
```

### 逐例手推

| 输入                          | 末冒号命中               | title                   | 反引号数 |
| :---------------------------- | :----------------------- | :---------------------- | :------- |
| 使用 `docs:verify` 命令：重要 | 末尾「：」（代码内跳过） | 使用 `docs:verify` 命令 | 2 通过   |
| 说明 `docs:verify` 命令       | -1（无代码外冒号）       | 丢弃                    | —        |
| ### 悬空 `TypeError           | —                        | 追加闭合                | 2 通过   |

**结论**：命中报告所述主路径（末冒号劈开 docs:verify）。

### 遗留边界（非致命）

- insideInlineCode 只识别单反引号。Markdown 的双反引号代码段计数为偶，会被误判为不在代码内。
- sanitizeTitle 对奇数反引号选择追加而非删除。宿主报告 §修复建议曾建议删除，实际实现选了追加；
  两者都保偶数计数，语义取径不同，报告正文与代码一致，无造假。

## 四、独立取证事实（不依赖报告自述）

### 视觉基线退化（D2-b）成立

shasum -a 256 实测（10 个 PNG）：

```text
01-home-dark   = 44ef509c11d1   01-home-light   = 44ef509c11d1   ← 同
02-tree-dark   = 44ef509c11d1   02-tree-light   = 44ef509c11d1   ← 同，且 ≡ 01
03-changes-dark= 5db0134613bd   03-changes-light= 5db0134613bd   ← 同
04-tasks-dark  = 18c745adf9d0   04-tasks-light  = 18c745adf9d0   ← 同
05-editor-dark = 45d60c9f9034   05-editor-light = 45d60c9f9034   ← 同
```

10 图仅 4 个唯一哈希。主题生效时 dark 与 light 应逐像素不同，故这批基线不可能是正确渲染的结果。
坏在「基线怎么生成的」，不是当前应用。

### 配置已修 ≠ 数据已修

playwright.config.ts:21 已设 snapshotPathTemplate（去掉 platform 段），平台耦合已解；
但基线内容未重生成——路径修好后仍会因像素差异全红。这是新缺口：
修了「找不到文件」，没修「文件本身是错的」。旧 *-darwin.png 成为孤儿，需随更新一并清理。

## 五、方法学附注

- 「报告称未修」≠「磁盘未修」：报告是某时刻快照，之后并发写手继续改动。
  复验必须以磁盘为准——本轮 D3/D4/D5/D2-a/D10 五项判定全部因此翻转。
- 守卫绿灯 ≠ 逻辑正确：守卫由修复者自己写，可能只覆盖已知路径。
  本轮靠手推边界（双反引号、Content-Length 陈旧）才找到两处未覆盖边界。
- 配置修复与数据修复常被混为一谈：改对路径只解决「找得到」，基线内容是否对得靠重生成。

## 六、复现命令

```bash
# D1/D7 守卫（亲跑通过：27 tests）
npx vitest run --config vitest.config.ts \
  packages/core/tests/static-stream-guard.node-test.ts \
  packages/core/tests/post-run-lesson-extract.node-test.ts

# 视觉基线哈希（预期 10 图 / 4 唯一）
shasum -a 256 packages/client/e2e/visual.spec.ts-snapshots/*.png

# 台账标题反引号奇偶扫描（预期 ODD=0）
node scripts/lessons-status.cjs
```

## 七、未验 / 未定

- D2-c（01≡02 同视图）、D2-d（遮罩命中）未跑受控探针 → 未定。
- D6（工单 G6 陈旧）、D8（无 uncaughtException 兜底）、D9（lint 豁免口径）、
  D11（并发写手致 verify 移动靶）未逐条取证 → 未验。
- D1 的 Content-Length 陈旧、D7 的双反引号边界：已识别，未修。
