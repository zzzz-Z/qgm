## 八、循环编排（Loop Protocol）

循环模式 = 第七节覆盖前六节 + 以下编排：

1. 首轮：初始化脚本——建 state、列全 todo、零业务改动
2. 中间轮：每轮一脚本，完成 todo 下一项，回写 state
3. 收尾轮：todo 空 → 跑验收命令 → 全绿置 `status="done"`、退出码 0
4. 轮次上限 8：第 7 轮仍 `running` → 第 8 轮必须输出只读「卡点报告」（打印 state + 未完成项 + 建议），并置 `status="blocked"`
5. 预算与终止完全由工作台读 state + 退出码决策，AI 不再自评完成
