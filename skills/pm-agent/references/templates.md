# PM-Agent Skill 参考资料：知识库沉淀模板（§9）

> 由 pm-agent-generate.cjs --split 自动生成，源为 `skills/pm-agent/SKILL.md` 内容块。
> 正文中引用的 §0–§5、§10 规则见主文件 SKILL.md。

- §9 知识库沉淀（分流规则 + AGENTS.md / product.md / pm-glossary.md 模板 + 更新触发器）

## 9. 知识库沉淀（DONE 后执行）

### 9.1 分流规则

| 内容                                 | 去向                        | 写入方                                   |
| ------------------------------------ | --------------------------- | ---------------------------------------- |
| AI Agent 仓库公约（红线 + 产物解读） | `AGENTS.md` 草案 → 报告 §14 | 报告草案，人工合入（根目录超出写入范围） |
| 产品知识/长期台账                    | `docs/product.md`           | 直接写草案                               |
| 方法论术语总表                       | `docs/pm-glossary.md`       | 直接写草案                               |
| 一次性分析过程                       | 只留 `.pm/final-report.md`  | 不沉淀                                   |

### 9.2 `AGENTS.md` 草案模板（进报告 §14，人工合入根目录）

```markdown
# AGENTS.md

> §1–3 由 PM-Agent 产出草案人工合入；§4–6 固定条款变更须经团队评审。
> 最后同步：YYYY-MM-DD ｜ 数据来源 run：YYYY-MM-DD

## 1. 项目身份速览（产品类型/核心用户/核心任务/平台/多产品域，附来源标注）

## 2. 技术栈（层 | 技术 | 证据 file:line）

## 3. 常用命令（安装/运行/测试/构建——由团队维护，PM-Agent 不代填）

## 4. AI Agent 工作红线（固定条款：§5.1 安全红线 + 事实标注要求 + 写入范围）

## 5. 写作与语言约定（固定条款：§5.2 + 禁止夸大收益）

## 6. .pm/ 产物解读指南

6.1 路径表（state.json / final-report.md / last-run.txt）
6.2 来源类型速查（六档含义 + 阅读处理方式，见 §2.1）
6.3 优先级含义（P0/P1/P2 + gap 回填规则）

## 7. 维护规则（草案 diff 合入流程 / "可能已变更"复核触发 / 固定条款评审）
```

### 9.3 `docs/product.md` 模板（直接写草案）

```markdown
# 产品知识库

> PM-Agent 产出草案，人工审核合入；条目沿用来源类型标注。
> 最后同步：YYYY-MM-DD ｜ 同步自 run：YYYY-MM-DD

## 1. 产品身份（类型/发布节奏/成熟度/市场线索，各附来源+证据）

## 2. 用户与场景（核心用户 / main_jobs / 平台）

## 3. 产品术语表（术语 | 英文/代码标识 | 业务含义 | 证据锚点 | 来源）

## 4. 功能地图（功能域 | 功能 | 状态四态 | 证据 file:line | 备注）

## 5. 体验债台账（ID | 问题 | 位置 | 影响 | 状态）

## 6. 对标观察台账（对标地图同列 + 复核规则 + 准入规则）

准入：只收 EXTERN/INFER；EXTERN_MEM 进 §9，人工验证后升级移入

## 7. 差距与方案台账（ID | 类型 | 问题 | 严重度 | score | effort 乐/悲 | 可灰度 | 可开关 | 状态）

## 8. 假设登记簿（ID | 假设 | 影响范围 | 验证方法 | 若假调整 | 置信度 | 状态）

## 9. 未验证对标线索（EXTERN_MEM + 模型知识截止时间 + 待验证点）

## 10. 专项登记（shared_dependency / infrastructure_debt / 多产品域）

## 11. 变更记录（日期 | 变更 | 依据 | 操作人）
```

### 9.4 `docs/pm-glossary.md` 生成规则（直接写草案）

从本技能提取术语生成总表，表头统一为 `术语 | 定义 | 关键规则/禁区`，按五组分类，逐组覆盖：

- **A 来源与证据**：FACT、INFER、ASSUME、EXTERN、EXTERN_MEM、BENCH_DEFAULT、证据锚点、confidence；
- **B 流程与预算**：round、Phase、budget.allocation、rounds_used、reserve、新增、无新增提前退出、saturated、全局停机、上下文压缩、只读模式、degraded_mode、原子写入；
- **C 打分与优先级**：impact 三因子、impact、w_c/w_f/w_p、confidence_weight、effort 三值、cost、score、P0 候选集合、P0/P1/P2、依赖提升、平局排序、gap 严重度回填、v1/v2 拆分、经验系数表、带宽；
- **D 产出与台账**：现状体检表、功能四态、体验债、missing_basics、对标地图、时间衰减、gap 三档、proposal、Quick Win、假设表格、未验证对标线索、shared_dependency、infrastructure_debt、多产品域；
- **E 状态与并发**：state.json、version/writer_id/updated_at、MERGED、CONFLICT、final-report.md、last-run.txt、phase="done"。

> 头部加维护协议："本表提取自 PM-Agent Skill，术语定义与技能正文一一对应，技能升级须同步更新。"

### 9.5 沉淀更新触发器

| 触发事件               | 动作                                                        |
| ---------------------- | ----------------------------------------------------------- |
| DONE 完成              | 报告 §14 草案 → 按 §9.1 分流合入 → 更新各文件头部"最后同步" |
| 对标条目标"可能已变更" | 人工复核 product.md §6 对应行                               |
| EXTERN_MEM 被人工验证  | 升级 EXTERN（补 URL+日期）→ 移入对标台账，退出 §9           |
| 假设验证完成/被推翻    | 更新 product.md §8 状态（显式更正，不悄悄改口）             |
| state.json 标 CONFLICT | 人工裁决后同步台账                                          |

---
