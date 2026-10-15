# QA-Agent Skill 参考资料：知识库沉淀模板（§9）

> 由 qa-agent-generate.cjs --split 自动生成，源为 `skills/qa-agent/SKILL.md` 内容块。
> 正文中引用的 §0–§5、§10 规则见主文件 SKILL.md。

- §9 知识库沉淀（分流规则 + AGENTS.md 质量公约 / quality.md / qa-glossary.md 模板 + 更新触发器）

## 9. 知识库沉淀（DONE 后执行）

### 9.1 分流规则

| 内容                                     | 去向                        | 写入方                                   |
| ---------------------------------------- | --------------------------- | ---------------------------------------- |
| AI Agent 仓库公约（质量红线 + 产物解读） | `AGENTS.md` 草案 → 报告 §14 | 报告草案，人工合入（根目录超出写入范围） |
| 质量知识/长期台账                        | `docs/quality.md`           | 直接写草案                               |
| 方法论术语总表                           | `docs/qa-glossary.md`       | 直接写草案                               |
| 一次性分析过程                           | 只留 `.qa/final-report.md`  | 不沉淀                                   |

> 若同仓库已运行 PM-Agent，AGENTS.md 草案须与 PM 草案**合并**（质量条款追加为其 §8"质量公约"），避免双份维护。

### 9.2 `AGENTS.md` 质量公约草案模板（进报告 §14，人工合入）

```markdown
## 8. 质量公约（QA-Agent 条款，固定部分变更须经团队评审）

- 8.1 测试红线：禁止 skip/only 合入主分支；禁止空断言用例；禁止裸 sleep 等待；
- 8.2 CI 门禁现状：[blocking 检查清单，来自 ci_gates]；
- 8.3 .qa/ 产物解读：state.json / final-report.md / last-run.txt 含义；
- 8.4 来源类型速查（七档，含 RUN）与 P0/P1/P2 含义；
- 8.5 维护规则：flaky 新增即登记 / "可能已变更"触发复核 /草案 diff 合入流程。
```

### 9.3 `docs/quality.md` 模板（直接写草案）

```markdown
# 质量知识库

> QA-Agent 产出草案，人工审核合入；条目沿用来源类型标注（含 RUN）。
> 最后同步：YYYY-MM-DD ｜ 同步自 run：YYYY-MM-DD

## 1. 质量身份（产品类型/关键性 money·pii·safety/测试栈/CI 成熟度，各附来源+证据）

## 2. 测试资产台账（套件 | 模块 | 四态 | 证据 file:line | CI 状态）

## 3. 质量债台账（ID | 标记类型 | 位置 | 影响 | 状态）

## 4. 基线观察台账（测试域 | 我们 | 业界基准 | 差距 | 来源 | observed_at | 可能已变更）

## 5. 风险台账（模块 | churn | fix 密度 | 关键性 | 风险等级 | 证据）

## 6. 差距与方案台账（ID | 类型 | 问题 | 严重度 | score | effort 乐/悲 | 状态）

## 7. flaky 登记簿（用例 | 3 次执行结果 | 疑似根因 | 状态）

## 8. 假设登记簿（ID | 假设 | 影响范围 | 验证方法 | 若假调整 | 置信度 | 状态）

## 9. 未验证基准线索（EXTERN_MEM + 模型知识截止时间 + 待验证点）

## 10. 专项登记（shared_dependency / requires_external_service 清单）

## 11. 变更记录（日期 | 变更 | 依据 | 操作人）
```

### 9.4 `docs/qa-glossary.md` 生成规则（直接写草案）

表头统一为 `术语 | 定义 | 关键规则/禁区`，按五组分类：

- **A 来源与证据**：FACT、RUN、INFER、ASSUME、EXTERN、EXTERN_MEM、BENCH_DEFAULT、证据锚点、confidence、flaky 疑似；
- **B 流程与预算**：round、Phase、budget.allocation、rounds_used、reserve、新增、无新增提前退出、saturated、全局停机、上下文压缩、只读模式、degraded_mode、原子写入、沙箱执行；
- **C 打分与优先级**：风险面、故障概率、后果强度、impact、w_r/w_f/w_s、confidence_weight、effort 三值、cost、score、P0 候选集合、P0/P1/P2、依赖提升、平局排序、gap 严重度回填、v1/v2 拆分、经验系数表、带宽；
- **D 产出与台账**：测试体检表、套件四态、质量债标记、untested_areas、基线地图、时间衰减、差距三档、proposal、Quick Win、假设表格、未验证基准线索、churn、fix 密度、shared_dependency、requires_external_service；
- **E 状态与并发**：state.json、version/writer_id/updated_at、MERGED、CONFLICT、final-report.md、last-run.txt、phase="done"。

> 头部加维护协议："本表提取自 QA-Agent Skill，术语定义与技能正文一一对应，技能升级须同步更新。"

### 9.5 沉淀更新触发器

| 触发事件               | 动作                                                        |
| ---------------------- | ----------------------------------------------------------- |
| DONE 完成              | 报告 §14 草案 → 按 §9.1 分流合入 → 更新各文件头部"最后同步" |
| 新发现 flaky           | 登记 quality.md §7（附 3 次执行结果）                       |
| 基准条目标"可能已变更" | 人工复核 quality.md §4 对应行                               |
| EXTERN_MEM 被人工验证  | 升级 EXTERN（补 URL+日期）→ 移入基线台账，退出 §9           |
| 假设验证完成/被推翻    | 更新 quality.md §8 状态（显式更正，不悄悄改口）             |
| state.json 标 CONFLICT | 人工裁决后同步台账                                          |

---
