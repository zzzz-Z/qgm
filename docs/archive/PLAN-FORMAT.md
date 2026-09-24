# 计划数据格式（PLAN-FORMAT）

> 计划 = **静态描述**（`plan.json`）+ **运行时状态**（`state.json`）。
> 前端合并两者渲染任务清单。

## 一、文件职责

| 文件                    | 职责                                 | 谁写                    |
| ----------------------- | ------------------------------------ | ----------------------- |
| `.ai-runner/plan.json`  | 「有什么任务」——描述性，不随运行变化 | 生成/刷新（脚本或人工） |
| `.ai-runner/state.json` | 「做到哪了」——运行时状态，每轮更新   | runner 自动             |

## 二、plan.json schema

```json
{
  "version": "2026-09-23-v1",
  "updatedAt": "2026-09-23T...",
  "description": "...",
  "totals": { "all": 104, "done": 80, "pending": 24 },
  "tiers": [
    {
      "id": "MAIN0",
      "name": "主线0 AI 上下文",
      "order": 2,
      "type": "main",
      "total": 14,
      "done": 12,
      "pending": 2,
      "items": [
        {
          "id": "p0-1",
          "desc": "补 state 环境字段",
          "status": "done",
          "tier": "MAIN0",
          "deps": [],
          "verify": null
        }
      ]
    }
  ]
}
```
