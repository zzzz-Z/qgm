# Skills 索引

## 目录

    skills/
    ├── _loader.cjs              动态加载器
    ├── INDEX.md                 本文件
    ├── core/                    核心规则
    │   ├── behavior.md          AI 决策准则
    │   ├── loop-protocol.md     循环协议
    │   └── gen-rules.md         脚本生成规则
    ├── script/
    │   └── standards.md         脚本编写规范
    ├── env/
    │   ├── preflight.md         会话首条自检 + 提交闸门
    │   └── troubleshooting.md   环境/工具链踩坑库
    ├── ui/
    │   └── pitfalls.md          CSS/Vue UI 踩坑
    └── sessions/
        └── 2026-09-20.md        2026-09-20 会话复盘

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
| `core` | core/behavior.md · core/loop-protocol.md · core/gen-rules.md |
| `rules` | core/behavior.md · core/gen-rules.md · env/preflight.md |
| `loop` | core/loop-protocol.md |
| `script` | script/standards.md · core/gen-rules.md |
| `env` | env/preflight.md · env/troubleshooting.md |
| `ui` | ui/pitfalls.md |
| `session` | sessions/2026-09-20.md |

## 兼容

顶层旧文件保留为 stub：`<!-- 已移动到 X（见 INDEX.md） -->`
新会话复盘放 `sessions/YYYY-MM-DD.md`。
