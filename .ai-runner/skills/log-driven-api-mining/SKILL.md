---
name: log-driven-api-mining
description: 从 AI 运行日志中挖掘「应当下沉为后台原语」的高频手写操作，并按证据量排序实施。当用户要求"分析日志看哪些操作该封装成函数""AI 反复手写什么""优化沙箱 API 面""把重复劳动下沉为原子操作"时使用。适用于任何有完整执行日志的 agent 运行时。
---

# 日志驱动的 API 下沉

## 0. 核心原则（先读）

1. **样本量决定结论方向**：303 个脚本的结论与 16,286 个脚本的结论可能相反。本技能实测：
   小样本判 `pkill` 为高频危险项（5/303），全量后仅 7/16286（0.04%）；
   而「探明类脚本占 64%」在小样本中完全不可见。**先确认真实数据规模，再下判断**。
2. **频次门槛**：低于 1% 的操作不值得新增 API。包一层有成本（API 面膨胀、维护、教学层同步），
   频次不足时收益不抵成本。
3. **区分「缺 API」与「缺强制」**：日志里 3379 次 `sh -c cat` 读文件——`readText` 早就存在。
   这不是缺 API，是 AI 不知道或没遵守。前者靠新增，后者靠教学层与软规则。
4. **半原子 API 比没有更危险**：`shellStatus(id)` 存在但「等到结束」不存在，
   结果每个 AI 都自己写轮询循环，17 处实现各不相同。补全比新增更重要。
## 1. 第一步：确认真实数据规模

不要直接扫 `.ai-runner/scripts/`（只是落盘副本，通常远少于真实执行数）。
**先盘点所有日志源**：

```text
du -sh .ai-runner/* | sort -hr | head -15      # 找最大的日志目录
wc -l .ai-runner/logs/*.jsonl                  # 日级日志的真实条目数
```

本仓实测：`.ai-runner/scripts` 只有 303 个文件（1.2MB），
而 `.ai-runner/logs/2026-*.jsonl` 有 16 天共 16,984 行、24MB。**相差 54 倍**。

## 2. 第二步：全量特征统计

解析日级日志的 `script` 字段，按模式计数。关键点：**一次遍历统计多个模式**，
不要为每个模式重读一遍文件。

```javascript
const days = ["01","02",...]  // 按实际日期列出
const pat = {
  "shellStatus 轮询": /for \([^)]*st\.running/,
  "固定 sleep": /setTimeout\([^,]+,\s*\d{4,}\)/,
  "pm2 restart": /pm2["']?,\s*["']restart/,
  "硬编码绝对路径": /\/Users\//,
}
for (const d of days) {
  const raw = await __AI__.readText(`.ai-runner/logs/2026-10-${d}.jsonl`)
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    let o; try { o = JSON.parse(line) } catch { continue }
    const s = o.script || ""
    if (!s) continue
    for (const [k, re] of Object.entries(pat)) if (re.test(s)) c[k]++
  }
}
```

## 3. 第三步：跨脚本重复行分析（找「复制粘贴」）

频次统计只回答「做了多少次」，重复行分析回答「**同一段代码被抄了多少遍**」——后者才是下沉的强证据。

```javascript
// 逐行去重后统计：同一条代码行出现在多少个不同脚本里
const freq = new Map()
for (const f of files) {
  const seen = new Set()
  for (const raw of src.split("\n")) {
    const l = raw.trim()
    if (l.length < 18 || /^\/\/|^\*/.test(l)) continue  // 跳过短行与注释
    if (seen.has(l)) continue  // 同一脚本内只算一次
    seen.add(l)
    freq.set(l, (freq.get(l) || 0) + 1)
  }
}
// 取出现 ≥5 次的
```

本仓实测抓到的典型：`let st = await __AI__.shellStatus(id)` 出现 19 次、
`const id = 'sh-xxx'` 出现 11 次（同一后台任务 id 被硬编码复制）。
## 4. 第四步：任务类型分布（找最大浪费面）

按 `desc` / `why` 做粗分类，能看出 AI 的时间花在哪：

| 类别 | 本仓占比 | 含义 |
|---|---|---|
| 探明/核对 | **64.1%** | 查代码、读文件、看状态 |
| 修改/写入 | 35.2% | 真正改代码 |
| 验证/测试 | 26.9% | 跑测试与检查 |
| 构建/重启 | 6.9% | 部署动作 |

**探明类占三分之二**——这是最大的优化面。若探明能被原语直接回答，省下的是大头。

## 5. 第五步：判定表（做 / 不做）

| 条件 | 结论 |
|---|---|
| 频次 ≥5% 且有确定语义 | **必须做** |
| 频次 1%-5% 且当前易错 | 值得做 |
| 频次 <1% | 不做（除非错误代价极高） |
| API 已存在但 AI 不用 | **不做新 API**，改教学层 / 加软规则 |
| 只差最后一步（如 shellStatus 缺 shellWait） | **优先补全**，比新增更重要 |
| 属「用错方法」（如行号循环删除） | 不做，改为文档指引 |

## 6. 实施套路

### 6.1 新原语的三件套（缺一不可）

1. **实现**：新建独立文件（如 `helpers/probe.cjs`），不反向 require 其它 helper。
2. **接线**：在门面（`helpers/index.cjs`）转发。**只写实现不接线 = AI 看不到 = 白做**。
3. **教学层**：写进每轮强制注入的 JSDoc（本仓是 `ai-guard.ts` 的 `AI_JSDOC`）。
   **不写进去 = AI 不知道有这个 API**。

三件套缺任何一件，新 API 都不会被用起来。

### 6.2 软规则（不阻断的提示）

当某个模式频次高但存在合法用法时（如 `sh -c cat` 有时确实需要原始字节），
不能进硬拦截表。做法：新增 `ADVISORY` 表（与 `FORBIDDEN` 并列），
命中后把提示附在回执里，不改变执行结果。

### 6.3 守卫测试必须变异验证

写完测试后，**故意把实现改坏**，确认测试变红，再恢复。
本仓实测踩过：变异脚本的 `replace` 根本没命中（源文件是 `shell: [...]` 带冒号，
我替换的是 `'shell'`），测试当然还是绿的——**差点误判「守卫是真空判据」**。
变异脚本必须断言「改动确实写入」。

## 7. 踩坑清单

### 7.1 解析 CLI 输出前必须剥 ANSI 颜色码

`testRun` 首版从 vitest 输出正则匹配 `Tests\s+(\d+)`，恒为 0。
实际输出是 `Tests \u001b[22m \u001b[1m\u001b[32m7 passed`——颜色控制符夹在关键词与数字之间。

```javascript
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g")
const clean = raw.replace(ANSI, "")
```

注意：eslint 的 `no-control-regex` 会拦 `\u001B` 字面量，用 `String.fromCharCode(27)` 构造。

### 7.2 词法剥离后的骨架里没有字符串内容

若运行时对脚本做 tokenize（剥掉字符串与注释只留代码骨架），
那**位于字符串内**的模式（`'sh', '-c', 'cat foo'`、`'/Users/...'`）在骨架上必然零命中。
实测：`__AI__.shell(['sh','-c','cat foo.txt'])` 的骨架是 `shell([    ,     ,    ])`。

正确做法：匹配 `literals`（被剥出的字符串内容数组），且它存的是**去引号的裸内容**，
正则要按裸内容写，不能按源码形态写。

### 7.3 字节数 ≠ 字符串长度

`stat` 报 312154 字节、`String.length` 报 174991，差的是中文字符（UTF-8 3 字节 / UTF-16 1 码元）。
判据应是 `new TextEncoder().encode(s).length === stat`。
同类陷阱：`grep -c '[STALE]'` 是字符类匹配，统计固定串必须用 `grep -cF`。

### 7.4 用字符串 replace 做代码手术会静默删掉相邻行

替换整行时旧行剩余部分可能被一起吃掉，导致变量消失、函数从「结果不准」变成「直接抛错」。
若没有 `no-unused-vars` 之类的 lint 报错，这个 bug 会一路带到线上。
**改代码优先用带锚点的 patchFile 或整块重写**。

## 8. 交付检查清单

- [ ] 实现文件语法检查通过
- [ ] 门面已接线（`index.cjs` 有转发）
- [ ] 教学层已更新（注入 JSDoc 含新 API）
- [ ] 守卫测试覆盖「接线存在」「行为正确」「变异变红」
- [ ] 既有守卫未误报（新文案可能触发旧正则）
- [ ] `pnpm tsc` / `pnpm test:tsc` 通过
- [ ] 构建后产物含新代码，且**进程启动时间晚于产物 mtime**
- [ ] 运行实例端到端实测（不是只看构建成功）
