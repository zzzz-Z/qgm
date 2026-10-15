# Skills 使用指南（PM-Agent / QA-Agent 通用版）

> **适用对象**：`skills/pm-agent/SKILL.md` 与 `skills/qa-agent/SKILL.md`。
> **适用环境**：任何支持 Agent Skills（SKILL.md 开放格式）的 Agent 运行时；自建 Agent 可直接读取全文注入。

## 0. 源码与生成关系

- **技能源码**：`skills/pm-agent/` 与 `skills/qa-agent/`（入 git，唯一源码）。每个技能的 `references/` 目录相对该技能目录；绝对路径从 `GET /__ai/skills` 返回的 `path` 字段获得。
- **本指南**：手工维护文档，**不由任何脚本生成**——更新时直接编辑本文件，无生成/回写链路。
- **生成器**：`pm-agent-generate.cjs` 已丢失、不再找回；`qa-agent-generate.cjs` 保留仅用于重新生成 `skills/qa-agent/` 输出（不再产出使用指南）。
- **运行位安装**：`GET /__ai/skills` 只扫 `.ai-runner/skills/`；把 `skills/<name>/` 整个目录放到该路径下（或走安装端点）后，`@` 选择器与 `/skills/match` 才能命中。验证：`curl -sS http://127.0.0.1:5175/__ai/skills` 能列出该技能即安装成功。

---

## 1. 安装

技能目录名必须是 `pm-agent` / `qa-agent`（目录名即调用名）。按所用平台约定放置：

| 平台类型                                                   | 放置位置                                                                         | 说明                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 支持 Agent Skills 标准的 CLI Agent（如 Claude Code）       | `<repo>/.claude/skills/<name>/`（项目级）或 `~/.claude/skills/<name>/`（用户级） | 目录名即命令名                                                                         |
| 其他支持 SKILL.md 的运行时（Cursor / Windsurf / Codex 等） | 以各平台文档为准                                                                 | 至少识别 frontmatter 的 name + description 与正文                                      |
| 自建 Agent / 框架                                          | 任意路径                                                                         | 全文注入 system prompt；或按需注入：必读部分（铁律 + 启动 + 参考卡）常驻，其余按需检索 |

**验证**：安装后用一句任务描述测试自动触发，或用平台显式命令（如 `/pm-agent`、`/qa-agent`）调用。

## 2. 触发运行（3 种方式）

- **A 自动触发**：自然语言命中 frontmatter `description` 场景词。
  - PM：「分析仓库产品现状 / 盘点功能 / 体验债 / 竞品对标 / 产品分析报告 / 迭代路线 / 改造成本」
  - QA：「评估测试/质量现状 / 盘点测试覆盖 / 找测试缺口 / 质量风险 / 测试建设规划 / 测试改造成本 / 分析 flaky」
- **B 显式调用**：`/pm-agent` 或 `/qa-agent` 或平台等价命令；可附加聚焦参数（「只跑 Phase 0–1」/「续跑」/「无网络，走降级」/ QA 特有「不执行测试，纯静态分析」）。
- **C 脚本 / CI**：用平台的 headless / 批处理模式调用，例如 `<你的Agent CLI> "/pm-agent 完整运行至 DONE"`。

## 3. 运行中交互

| 介入时机                         | 用户动作                                           | Agent 行为                                                 |
| -------------------------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| Pre-phase 0 完成后               | 检查环境探测结果（git / 写权限 / 网络 / 仓库类型） | 已写入 environment，进入 identity；只读 / 无网络会声明降级 |
| Phase 3 GAP（QA 为 RISK-GAP）后  | 纠偏（如「剔除锦上添花类，聚焦阻塞体验」）         | 记 log 并调整；否定 FACT 需提供反驳证据                    |
| Phase 4 PROPOSAL（QA 为 PLAN）后 | 评审 proposal，打回个别方案                        | 重新打分，P0/P1/P2 分布与依赖提升重算                      |

**需人工回答的两种情况**：(a) 缺部署/登录环境 → 请求授权；(b) 缺业务数据（转化率/留存/量级）→ 给出低/中/高三档分叉方案供选择。**自动降级不打断**：无网络（EXTERN_MEM）、预算耗尽（保 DONE）、无数据线索（自行推断）。

## 4. 产物与续跑（平台无关）

**PM-Agent**：

```text
<repo>/
├── .pm/
│   ├── state.json          # 全量状态（phase / budget / identity / gaps / proposals / log）
│   ├── final-report.md     # 最终产品分析报告
│   ├── last-run.txt        # 运行摘要
│   └── state.json.bak      # 备份（如有）
└── docs/
    ├── product.md          # 产品知识库草案（待人工审核）
    └── pm-glossary.md      # 术语总表草案（待人工审核）
```

**QA-Agent**：

```text
<repo>/
├── .qa/
│   ├── state.json          # 全量状态（phase / budget / identity / risks / gaps / proposals / log）
│   ├── final-report.md     # 最终测试质量报告
│   ├── last-run.txt        # 运行摘要
│   └── state.json.bak      # 备份（如有）
└── docs/
    ├── quality.md          # 质量知识库草案（待人工审核）
    └── qa-glossary.md      # 术语总表草案（待人工审核）
```

两技能状态目录独立（`.pm/` 与 `.qa/`），可同仓共存；AGENTS.md 草案需人工合并（PM 为基础，QA 条款追加为质量公约节）。

- **续跑**：再次触发即从中断 Phase 继续（state.json 已存在且 phase != "done"）；`phase = "done"` 时读报告即停，不重跑。重跑：删除对应状态目录后再触发。
- **只读模式**：报告出 stdout（头部 `READ_ONLY_MODE=true`）+ state.json 快照；续跑不可用，人工保存快照到对应状态目录后方可恢复。
- **跨机器迁移**：打包状态目录（`.pm/` / `.qa/`）到新机器解压后触发「续跑」。
- **并发**：多人/多 Agent 同仓库并行时按 state.json 的 `version` 自动合并（`MERGED`）；出现 `CONFLICT` 标记需人工裁决。

## 5. 排查表

**通用**：

| 症状                              | 原因                                             | 解法                                             |
| --------------------------------- | ------------------------------------------------ | ------------------------------------------------ |
| 技能未被识别 / 无法调用           | 目录名不对，或放置路径不符平台约定               | 重命名目录；对照平台技能目录文档                 |
| 自然语言未触发                    | 说法不在 frontmatter description 场景词内        | 把该说法补进 description                         |
| 跑到一半停                        | 全局停机命中（55 轮 / 上下文 >95% / 连续无新增） | 正常停机；查看停止输出中的建议续接点，触发续跑   |
| 报告只有骨架无清单                | 盘点 Phase 预算耗尽                              | 续跑消耗 reserve；或要求降低扫描深度             |
| state.json 损坏                   | 写入被中断                                       | 从 `state.json.bak` 恢复；无备份则删状态目录重跑 |
| 需修改阈值（预算 55 / P0 封顶等） | 硬编码于 SKILL.md                                | 直接编辑对应章节，即时生效                       |

**PM-Agent 特有**：

| 症状                                | 原因             | 解法                                                         |
| ----------------------------------- | ---------------- | ------------------------------------------------------------ |
| 对标表为空                          | 无网络且未进降级 | 检查 environment.network；显式说「无网络，走 degraded_mode」 |
| P0 超过 20% / EXTERN_MEM 混入对标表 | 自检门未正确执行 | 手动要求「重新执行 PRE-DONE CHECK」                          |

**QA-Agent 特有**：

| 症状                         | 原因                     | 解法                                          |
| ---------------------------- | ------------------------ | --------------------------------------------- |
| Agent 要求安装依赖或启动容器 | 测试执行需要环境         | 沙箱内放行，或明确「纯静态分析」跳过 RUN      |
| 报告无 RUN 证据              | 环境不可用或选择了纯静态 | 静态结论已降级标注，可补环境后续跑            |
| flaky 判定缺失               | 单次执行不构成判定       | 要求「对疑似用例补 3 次执行」（消耗 reserve） |

## 6. 快速上手清单

**PM-Agent**：

```text
1. 将 skills/pm-agent/ 放到平台技能目录（见 §1）
2. 触发运行，等 Phase 6 DONE                    # 约 55 轮内
3. 阅读 .pm/final-report.md                     # 核心产出
4. 按报告 §14 草案合入 AGENTS.md / docs/product.md
5. 需要时触发续跑或重跑                          # 见 §4
```

**QA-Agent**：

```text
1. node qa-agent-generate.cjs <目标目录> --split  # 重新生成 skills/qa-agent/（可选）
2. 将 skills/qa-agent/ 放到平台技能目录（见 §1）
3. 触发运行，等 Phase 6 DONE                    # 约 55 轮内
4. 阅读 .qa/final-report.md                     # 核心产出
5. 按报告 §14 草案合入 AGENTS.md / docs/quality.md
6. 需要时触发续跑或重跑                          # 见 §4
```
