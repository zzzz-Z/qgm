# 阶段 5 诊断报告（Jaccard 20.2% 根因）

> 判定依据：PLAN 阶段 5「Jaccard < 60% → 暂停第一线，回阶段 0 检查」。

## 1. 现象

| 指标       | v1    | v2     |
| ---------- | ----- | ------ |
| Jaccard    | 19.9% | 20.2%  |
| A 路精确率 | 21.2% | 20.2%  |
| B 路精确率 | 76.0% | 100.0% |

补 mapping 后 Jaccard 仅升 0.3pp。**mapping 不是瓶颈。**

## 2. 根因

### 2.1 A 路信号源失真（主因）

A 路信号 = `baseline.samples[].autoIntent`，来自「脚本 desc + why + 正文」的关键词分类。
问题：这些历史轮次的 desc/why 常为空（如 `"desc":""`），autoIntent 实际只从正文抽词 → 与 B 路信号源高度重叠却口径不同，产生大量假阴性。

### 2.2 B 路过度命中（次因）

B 路几乎每条都命中 `RULES` + `AI-API`（因脚本头必带 `__AI__.cwdMust`），v2 后 B 精确率=100% 是**自己跟自己比**，不代表真值。

### 2.3 baseline 缺真实意图声明

阶段 5 本应评估「AI 真实声明的意图 → 映射 → 加载章节」是否覆盖真值。
但 baseline 只有 `autoIntent`（自动分类），**没有阶段2 产出的意图声明 JSON**。
→ 评估对象与设计对象不一致，**当前回归不具权威性**。

## 3. 处置（按 PLAN 回阶段 0）

### 3.1 已做

- 给 `baseline.json` 的 30 条样本填 `pendingHumanChapters` AI 初稿。
- 初稿口径 = 从脚本正文关键词抽章节（比 autoIntent 更贴近内容）。
- 标注 `annotationVersion=2026-09-22-draft-v1`。

### 3.2 待人工

1. **复核 30 条 `pendingHumanChapters`**：逐条增删，作权威 ground truth。
2. 复核口径：这条轮次「如果重新走阶段 2，AI 应声明哪些章节？」
3. 复核完把 `annotationVersion` 升级为 `final-v1`。

### 3.3 之后

- 用 final ground truth 重跑回归（A 路消费真实意图声明，非 autoIntent）。
- 只有那时 Jaccard 才具权威性，才能走 5.5 灰度。

## 4. 明确不做

- ❌ 继续自动补 mapping：信号源问题不解决，补 mapping 是**在错误方向上优化**。
- ❌ 直接走 5.5 灰度：Jaccard 20% 不达阈值。
- ❌ 用 autoIntent 当 ground truth：口径失真。

## 5. 一句话

阶段 5 卡在「真值缺失」，不是「映射不准」。下一步的唯一有效动作是**人工标注**。
