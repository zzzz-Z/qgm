# Skills 索引

## 目录

```text
skills/
├── _loader.cjs              动态加载器
├── INDEX.md                 本文件
├── core/                    核心规则
│   ├── behavior.md          AI 决策准则
│   ├── loop-protocol.md     循环协议（含输出模式/契约）
│   └── gen-rules.md         [废弃 stub]
├── script/
│   ├── standards.md         脚本规范（头部/通道/读写协议）
│   └── ai-api.md            __AI__ API
├── env/
│   ├── preflight.md         会话首条自检 + 提交前闸门（短）
│   └── troubleshooting.md   踩坑库（E/T/P/A）
├── refactor/
│   └── ts.md                TS 高内聚低耦合架构
└── ui/
    └── pitfalls.md          CSS/Vue UI 踩坑
```

## 动态加载

Node:

    const { load, loadFor, list } = require("./skills/_loader.cjs")
    load("ui")              // UI 相关
    load(["rules","script"])
    loadFor("改 CSS 选择器")  // 按任务描述匹配

CLI:

    node skills/_loader.cjs --list
    node skills/_loader.cjs ui
    node skills/_loader.cjs --for "改 CSS"

## 功能 → 文件映射

| 功能 | 文件 |
| :--- | :--- |
| `core` | core/behavior.md · core/loop-protocol.md |
| `rules` | core/behavior.md · script/standards.md · env/preflight.md |
| `loop` | core/loop-protocol.md |
| `script` | script/standards.md · script/ai-api.md |
| `env` | env/preflight.md · env/troubleshooting.md |
| `ui` | ui/pitfalls.md |
| `refactor` | refactor/ts.md |

## 常驻（每轮注入）

`core/behavior.md` · `core/loop-protocol.md` · `script/standards.md` · `script/ai-api.md` · `env/preflight.md`

判定：每轮都影响输出形状 / 每轮写脚本必用 → 常驻；特定任务才用 → 按需加载。
红线上限 10KB；当前 ~7.3KB。
## 精简说明

- `core/gen-rules.md` 已拆分为 behavior / standards / loop-protocol，保留为废弃 stub

## 兼容

会话复盘并入 ui/pitfalls.md 末尾。
