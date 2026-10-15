# QA-Agent Skill 使用指南（通用版）

> **适用对象**：`skills/qa-agent/SKILL.md`（由 qa-agent-generate.cjs 生成）
> **适用环境**：任何支持 Agent Skills（SKILL.md 开放格式）的 Agent 运行时；自建 Agent 可直接读取全文注入。
> **与 PM-Agent 的关系**：可同仓共存（状态目录分别为 `.qa/` 与 `.pm/`），AGENTS.md 草案需人工合并（QA 条款追加为质量公约节）。

## 1. 安装

脚本默认生成到 `<目标>/skills/qa-agent/SKILL.md`。按所用平台约定放置（目录名必须是 `qa-agent`，即调用名）：

| 平台类型                           | 放置位置               | 说明                                                       |
| ---------------------------------- | ---------------------- | ---------------------------------------------------------- |
| 支持 Agent Skills 标准的 CLI Agent | 项目级或用户级技能目录 | 目录名即命令名                                             |
| 其他支持 SKILL.md 的运行时         | 以各平台文档为准       | 至少识别 frontmatter name + description 与正文             |
| 自建 Agent / 框架                  | 任意路径               | 全文注入；或常驻 §0 + §1 + §10，§2–§5、§6、§8、§9 按需检索 |

## 2. 触发运行

- **自动触发**：命中 description 场景词——"评估测试/质量现状 / 盘点测试覆盖 / 找测试缺口 / 质量风险 / 测试建设规划 / 测试改造成本 / 分析 flaky"。
- **显式调用**：`/qa-agent` 或平台等价命令；可附加参数（"只跑 Phase 0–1" / "续跑" / "不执行测试，纯静态分析" / "无网络，走降级"）。
- **脚本 / CI**：用平台 headless 模式调用。

## 3. 测试执行相关（QA 特有）

- **RUN 前置确认**：Agent 只执行静态确认过的命令（来自 package.json scripts / CI 配置 / Makefile），不凭空构造；
- **沙箱要求**：测试执行仅限本地/容器/沙箱；依赖真实外部服务的测试自动跳过并标记 `requires_external_service`；
- **超时**：单条 60s / 全套 300s，超时中止并记录；
- **flaky 判定**：同一测试执行 3 次，结果不一致才标 flaky 疑似；
- **纯静态模式**：不想让 Agent 执行任何命令时，显式说"纯静态分析"，Agent 跳过 RUN 证据，全部结论降级为 FACT/INFER（报告中标注"未执行验证"）。

## 4. 产物与续跑

```
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

- **续跑**：再次触发即从中断 Phase 继续；重跑：删除 `.qa/` 后再触发；
- **只读模式**：报告出 stdout + state.json 快照；续跑不可用；
- **并发**：按 state.json `version` 自动合并（MERGED）；CONFLICT 需人工裁决。

## 5. 排查表（QA 特有项）

| 症状                         | 原因                        | 解法                                        |
| ---------------------------- | --------------------------- | ------------------------------------------- |
| Agent 要求安装依赖或启动容器 | 测试执行需要环境            | 沙箱内放行，或明确"纯静态分析"跳过 RUN      |
| 报告无 RUN 证据              | 环境不可用或选择了纯静态    | 静态结论已降级标注，可补环境后续跑          |
| flaky 判定缺失               | 单次执行不构成判定          | 要求"对疑似用例补 3 次执行"（消耗 reserve） |
| 基线表为空                   | 无网络且未进降级            | 显式说"无网络，走 degraded_mode"            |
| 与 PM-Agent 草案冲突         | 两 Agent 各自起草 AGENTS.md | 人工合并：PM 为基础，QA 条款追加为 §8       |

## 6. 快速上手清单

```
1. node qa-agent-generate.cjs <目标目录>        # 生成文件
2. 将 skills/qa-agent/ 放到平台技能目录
3. 触发运行，等 Phase 6 DONE                    # 约 55 轮内
4. 阅读 .qa/final-report.md                     # 核心产出
5. 按报告 §14 草案合入 AGENTS.md / docs/quality.md
6. 需要时触发续跑或重跑
```
