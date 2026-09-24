# 默认加载 Skill 清单

> 数据源：`skills/_loader.cjs` · `skills/mapping.json` · `skills/RULES.md` 第零章。

生成日期：2026-09-23

## 一、加载链路（会话首轮）

按 `RULES.md` 第零章，顺序为：

    AGENTS.md  →  skills/RULES.md  →  .ai-runner/state.json  →  当前任务

## 二、三级加载分类

### L1 常驻（每轮无条件注入）

- `RULES`（`skills/RULES.md`）

依据：`_loader.cjs` 中 `ALWAYS_KEYS = ["RULES"]`，`isDefault(key)` 对其返回 true。

### L2 会话首轮强制读取

- `AGENTS.md`（仓库根，运行方式）
- `skills/RULES.md`（AI 行为单一权威）
- `.ai-runner/state.json`（循环状态）

### L3 按需（意图 × 文件类型 → mapping.json）

`skills/mapping.json` 定义 22 条粗映射；命中后由 `--for <组名或 skill key>` 抽取对应正文。

| 意图   | 文件类型 | 加载项                                                  | 说明                       |
| :----- | :------- | :------------------------------------------------------ | :------------------------- |
| 改样式 | vue      | ui · unocss-SKILL · vue-SKILL                           | UI 章节 + UnoCSS + Vue SFC |
| 改样式 | css      | ui · unocss-SKILL                                       | UI 踩坑 + UnoCSS 语法      |
| 改样式 | other    | ui                                                      | 纯 UI 令牌                 |
| 改逻辑 | ts       | core · rules                                            | TS 架构 + R1–R3            |
| 改逻辑 | vue      | core · vue-SKILL                                        | Vue SFC 约定 + 行为准则    |
| 改逻辑 | cjs      | core · rules                                            | 脚本头部规范 + 通道        |
| 修 bug | other    | rules · RULES · core · AI-API · ui · vue-SKILL          | 踩坑库 + 输出契约          |
| 加测试 | ts       | vitest-SKILL · vue-testing-best-practices-SKILL · RULES | 测试约定                   |
| 加测试 | vue      | vitest-SKILL · vue-testing-best-practices-SKILL · RULES | 组件测试                   |
| 重构   | other    | refactor · RULES                                        | HCLC + 重构安全协议        |
| 重构   | vue      | refactor · vue-best-practices-SKILL                     | Vue 拆分结构               |
| 文档   | md       | RULES · core · loop                                     | 输出契约 + 提交闸门        |
| 配置   | json     | rules · core · RULES                                    | 配置约定                   |
| 配置   | ts       | rules · antfu-SKILL · core · RULES                      | antfu 工具链               |
| 脚本   | cjs      | script · core · AI-API                                  | 脚本头部规范 + 通道选择    |
| 脚本   | ts       | script · AI-API                                         | 脚本/工具                  |
| 状态   | ts       | loop                                                    | 状态持久化协议             |
| 状态   | json     | loop                                                    | state schema               |
| 接口   | ts       | core · rules · AI-API · vue-SKILL                       | **AI** API + R1–R3         |
| 接口   | cjs      | rules · AI-API · vue-SKILL                              | **AI** API                 |
| git    | other    | rules                                                   | 提交闸门 + 不做清单        |
| 其他   | other    | RULES                                                   | 兜底                       |
| 脚本   | other    | AI-API                                                  | v2 自动补缺口              |
| 文档   | other    | core · loop                                             | v2 自动补缺口              |
| 加测试 | other    | vue-testing-best-practices-SKILL · RULES                | v2 自动补缺口              |
| 配置   | other    | core · RULES                                            | v2 自动补缺口              |
| 接口   | other    | AI-API · vue-SKILL                                      | v2 自动补缺口              |

**组名（GROUPS，映射到 RULES.md 章节）**：

      core: ['core/', 'behavior', 'loop-protocol'],
      rules: ['core/behavior', 'env/preflight'],
      loop: ['loop-protocol'],
      script: ['script/'],
      env: ['env/'],
      ui: ['ui/'],
      refactor: ['refactor/'],

**Skill key（独立 md 文件）**：

- `RULES` — 本地
- `AI-API` — 本地
- `UI-LESSONS` — 本地
- `PITFALLS-ARCHIVE` — 本地
- `vue-SKILL` — 外部（.agents/.claude/.cursor 或 HOME）
- `unocss-SKILL` — 外部（.agents/.claude/.cursor 或 HOME）
- `vitest-SKILL` — 外部（.agents/.claude/.cursor 或 HOME）
- `antfu-SKILL` — 外部（.agents/.claude/.cursor 或 HOME）
- `vue-best-practices-SKILL` — 外部（.agents/.claude/.cursor 或 HOME）
- `vue-testing-best-practices-SKILL` — 外部（.agents/.claude/.cursor 或 HOME）

## 三、skills/ 目录当前文件

- `AI-API.md` (2718 B)
- `PITFALLS-ARCHIVE.md` (1717 B)
- `RULES.md`（字节数以实际文件为准）
- `UI-LESSONS.md` (10296 B)
- `_loader.cjs` (10148 B)
- `mapping.json` (5237 B)

## 四、一句话结论

- **每轮无条件注入**：`RULES`（即 `skills/RULES.md`）。
- **会话首轮额外强制**：`AGENTS.md` + `.ai-runner/state.json`。
- **其余全部按需**：由 `mapping.json` 依据意图 × 文件类型触发；本地实际可加载的 skill 文件目前有 RULES / AI-API / UI-LESSONS / PITFALLS-ARCHIVE 四个，其余 key 指向外部 skill 库。
