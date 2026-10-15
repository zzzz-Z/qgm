# QA-Agent Skill 参考资料：Phase 执行手册 · 异常与降级 · monorepo/polyrepo（§6–§8）

> 由 qa-agent-generate.cjs --split 自动生成，源为 `skills/qa-agent/SKILL.md` 内容块。
> 正文中引用的 §0–§5、§10 规则见主文件 SKILL.md。

- §6 Phase 执行手册（Pre-phase 0 → Phase 6 全流程 + 6.9 只读模式交付规范）
- §7 异常与降级（a/b 触发中断，c/d 降级继续）
- §8 monorepo / polyrepo 专项

## 6. Phase 执行手册

### Pre-phase 0 ENVIRONMENT（1 轮，强制最先）

探测并写入 `environment` 字段：

1. **git**：`git rev-parse --git-dir`，成功记录 root + 分支 + 最近 tag；
2. **写权限**：写删 `.qa/test_write.txt`，失败=只读模式（§6.9）；
3. **网络**：访问任一可达公网站点，成功=可上网；
4. **仓库类型**：检测 `pnpm-workspace.yaml` / `lerna.json` / `nx.json` / `turbo.json` / `go.work` / `Cargo.toml` workspace / maven modules → single/monorepo/polyrepo；
5. **测试运行器**：`package.json` scripts（test/e2e 相关）、`pytest.ini`/`pyproject.toml` tool 节、`Makefile`、`go test` 惯例、maven surefire → `test_runner.detected/command/framework`；
6. **CI 探测**：`.github/workflows` / `.gitlab-ci.yml` / `Jenkinsfile` / `.circleci` → `ci.detected/platform`；test step 是否 blocking → `ci.test_blocking`。
   **降级**：无 git → team 标 ASSUME、风险因子"故障概率"无证据时用 BENCH_DEFAULT 兜底；无写权限 → 只读模式；无网络 → §7(d)；monorepo/polyrepo → §8。
   **退出**：environment 写入，phase → identity。

### Phase 0 IDENTITY（5 轮）

产出 `identity` 全部字段，**必须确定 product_type 与 criticality**（决定 §3.2 权重；无法判定默认通用权重并记 ASSUME）。

1. **产品类型与关键性**：`product_type` + `criticality`（money/pii/safety）。证据示例：支付 SDK 依赖、订单/账务模型 → money；加密字段、脱敏工具、合规注释/目录 → pii；
2. **测试栈**：`test_stack`（各层框架、runner、coverage 工具，来自 devDependencies 与配置文件）；
3. **CI 成熟度**：test blocking? coverage 上报? 多阶段流水线? → `ci_maturity`；
4. **团队规模与带宽**（必须有）：
   ```bash
   # 贡献者数（排除 CI/bot）
   git log --format="%ae" --since="90 days ago" \
     | grep -viE 'noreply|bot|dependabot|renovate|ci@' \
     | sort -u | wc -l
   # 周均 commit（90天 ÷ 7 ≈ 12.86 周）
   git log --since="90 days ago" --pretty=format:%H --no-merges \
     | wc -l | awk '{print $1/12.86}'
   ```
   输出单改动成本阈值（例：>3 人日=需专项排期）。**全部标"估算"**。
5. 发布节奏、市场线索（lang/i18n/compliance）。
   允许来源：FACT/INFER/ASSUME；每条 ASSUME 同步写入 hypotheses。退出：identity 齐全或预算耗尽，product_type 必须有值。

### Phase 1 INVENTORY（11 轮）

- **测试文件普查**：按命名约定（`*.test.*` / `*_test.go` / `tests/` / `spec/` / `__tests__`）扫描，按目录/模块归组 → `test_suites`；
- **每套件四态**：**齐备**（主路径+边界有断言、确定性、纳入 CI blocking）/ **部分**（仅主路径，或未入 CI，或依赖外部服务）/ **薄弱**（空断言、重度 mock 被测对象本身、仅 smoke 层级）/ **缺失**（未发现任何测试证据）；
- **质量债普查**（只收 FACT，每条附 `file:line`）→ `quality_debt`：
  | 标记      | 示例                                          | 含义           |
  | --------- | --------------------------------------------- | -------------- |
  | skip/todo | `it.skip` / `test.todo` / `@Disabled` / `xit` | 已知未跑       |
  | only 残留 | `it.only` / `fit` / `fdescribe`               | 焦点测试未清理 |
  | 空断言    | 测试体无 expect/assert                        | 假覆盖         |
  | 裸等待    | `sleep()` / `setTimeout` 代替显式等待         | flaky 源       |
  | 注释测试  | 被注释的用例块                                | 债务累积       |
  | 门禁缺失  | coverage 配置存在但 CI 未强制                 | 度量空转       |
  | 外部依赖  | 测试直连真实第三方 API                        | 不可重现       |
- **CI 门禁清单**：哪些检查 blocking（test / lint / typecheck / coverage）→ `ci_gates`；
- **untested_areas**：无测试痕迹的模块，允许 INFER（"未发现 X 的任何测试"是可验证陈述），**不入体检表主列**，只作 Phase 3 gap 候选；
- **RUN 基线（可选，沙箱内）**：静态盘点后可执行一次测试运行获取基线计数（pass/fail/skip），记录为 RUN 证据；全套超 300s 则只跑关键子集或跳过并记录原因；
- 无新增区域写入 `saturated`；共享库按 §8.1 处理。

### Phase 2 BASELINE（10 轮）

- **选基准来源**：有网络——公开的业界测试实践参照（测试金字塔、社区公认测试指南、官方框架文档），必须真实存在、可公开访问，禁止虚构；无网络——§7(d) 降级，产 EXTERN_MEM；
- **基线维度打勾表**（每测试域一行）：单元 / 集成 / E2E 冒烟 / 契约 / 性能基线 / 安全扫描 / CI 门禁 / 测试数据管理 / 覆盖率度量与门禁；
- 正式打勾表只收 EXTERN/INFER（§2.2）；
- **时间衰减**：每条记录 `observed_at`（ISO8601）；测试工具版本更迭快——主框架 6 个月内有 major 更新 → 标"可能已变更"并建议人工复核；EXTERN_MEM 记模型知识截止时间，不写访问日期。

### Phase 3 RISK-GAP（8 轮）

**先风险建模**（逐模块，证据入 `risks`）：

```bash
# 模块级变更频次（churn，按目录聚合）
git log --since="180 days ago" --pretty=format: --name-only \
  | grep -v '^$' | grep '^src/' | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn
# 模块级修复密度（fix 密度）
git log --since="180 days ago" -i --grep='fix\|bug\|hotfix' --oneline -- src/<module> | wc -l
```

churn/fix 密度为 FACT（git 历史可复现统计）；复杂度判断为 INFER（附推理链）；结合 Phase 0 criticality 定风险面。
**后差距分析**（风险 × 覆盖矩阵）：

- **阻断风险**：高风险 + 低覆盖（主链路无有效防护）；
- **能力缺失**：基准要求有而我们没有（如无契约测试但下游消费方多）；
- **加分项**：其余改进空间。
  每条 gap 字段：ID | 描述 | 模块/域 | 证据（`file:line` / RUN 计数 / churn 数据 / 基准参照）| 来源类型 | 初拟严重度。严重度为**初拟**，Phase 5 终算后按 §3.3 回填。

### Phase 4 PLAN（10 轮）

- 每个 gap ≥1 条 proposal；超团队单改动阈值 → 拆 **v1（最小防护）→ v2（完整建设）**；
- proposal 类型举例：补单元测试 / 补集成测试 / 引入 E2E 冒烟 / 修复 flaky / 加覆盖率门禁 / 契约测试 / 测试数据工厂 / CI 反馈提速；
- 字段全集：ID | 类型 | 问题 | 目标 | 参照 | 严重度 | 项目类型 | w_r | w_f | w_s | 风险面 | 故障概率 | 后果强度 | impact | confidence | confidence_weight | cost | score | 证据锚点 | 依赖关系 | 是否可灰度 | 是否可配置开关 | effort_default | effort_optimistic | effort_pessimistic | P0/P1/P2；
- 逐因子标注 confidence + 证据锚点，无证据用 BENCH_DEFAULT；
- 记录 proposal 间依赖（供 §3.4）；
- 粗估 effort 完成 score 初稿与初步分类。

### Phase 5 COST（6 轮）

**经验系数表**（git 历史无法校准时的 fallback）：

| 改动类型             | 基础人日(默认) | 乘数             | 范围    | 乘数默认 |
| -------------------- | -------------- | ---------------- | ------- | -------- |
| 补单元测试（每模块） | 2 (1-4)        | × 逻辑复杂度     | 1-2     | 1.0      |
| 补集成测试           | 3 (2-6)        | × 外部依赖数     | 1-2     | 1.5      |
| 补 E2E 冒烟          | 3 (2-5)        | × 环境准备复杂度 | 1-3     | 1.5      |
| 修复 flaky 测试      | 1 (0.5-3)      | × 根因明确度     | 0.5-2   | 1.0      |
| 引入覆盖率门禁       | 1 (0.5-2)      | × CI 平台差异    | 0.5-1.5 | 1.0      |
| 测试数据工厂/基建    | 5 (3-10)       | × 数据模型复杂度 | 1-2     | 1.5      |

```
默认 effort = 基础人日默认值 × 几何平均(适用乘数默认值)
乐观 effort = 基础人日下限 × 几何平均(适用乘数下限)
悲观 effort = 基础人日上限 × 几何平均(适用乘数上限)
cost = sqrt(effort_pessimistic)
```

- 报告同时给出三值；可叠加多乘数，须列出实际使用的乘数；
- 带宽：`可用人日 = 团队人数 × 迭代天数 × 专注系数(0.6-0.8)`；
- confidence：git 历史校准=高 / 仅经验系数=中 / 无参照=低；
- **收尾**：校准 effort → 终算 cost/score → 落最终分类（含依赖提升）→ 回填 gap 严重度。

### Phase 5.5 PRE-DONE CHECK（1 轮自检门）

任一不通过 → 回退对应 Phase 补全（记 log）；全过 → phase 置 "done"。

```
[ ] 每条 FACT 结论都有 file:line 证据
[ ] 每条 RUN 证据都有执行命令 + 时间戳 + 结果计数 + 环境标记
[ ] 每条 EXTERN 都有 URL + 访问日期，或已标 EXTERN_MEM 并排除打分
[ ] 每个 P0 gap 至少对应一条 proposal
[ ] 每个 proposal 都有 effort 区间（乐观/悲观），P0/P1 不得缺失
[ ] 无虚构测试结果（所有 pass/fail 声称均有 RUN 证据）
[ ] 超阈值的 proposal 已拆分 v1 → v2
[ ] assumptions 清单完整（Phase 0 所有 ASSUME 字段）
[ ] 测试体检表主列不含 ASSUME/INFER 条目（untested_areas 单列）
[ ] 基准条目无虚构 URL/版本/实践细节
[ ] 饱和区域与未探索区域已明确列出
[ ] state.json 中 phase、rounds_used、budget 一致
[ ] 基线地图含观察日期和"可能已变更"标记
[ ] 预算耗尽时已列出未探索区域
[ ] 只读模式下报告已输出到 stdout
[ ] P0/P1/P2 分类有 score 阈值依据（§3.3）
[ ] EXTERN_MEM 未进入正式基线打勾表与 gap 打分
[ ] 方案清单含风险面/故障概率/后果强度原始因子与 w_r/w_f/w_s
[ ] P0 总数 <= 所有 proposal 的 20%
[ ] BENCH_DEFAULT 使用清单已列出
[ ] flaky 疑似条目均已附 3 次执行结果
[ ] 只读模式已声明"续跑不可用"，或已附 state.json 快照
```

### Phase 6 DONE（1 轮）

1. 可写：报告写 `.qa/final-report.md`（UTF-8 Markdown）；只读：输出 stdout，头部标 `READ_ONLY_MODE=true`；
2. 可写：state.json `phase` 置 "done"；
3. 可写：创建 `.qa/last-run.txt`：

```json
{
  "finished_at": "ISO8601时间戳",
  "total_rounds": 0,
  "phase": "done",
  "report_path": ".qa/final-report.md",
  "issues_count": 0,
  "proposals_count": 0
}
```

4. 终端摘要：Top 5 质量问题（ID | 严重度 | 位置 | 业务后果）+ 报告路径；
5. 按 §9 产出知识库沉淀草案。
   **最终报告结构**（中文，代码/路径保持原文）：

```
0. 质量身份摘要（产品类型 + 关键性等级 + 测试成熟度判断 + 未解假设）
1. 执行摘要（覆盖范围、轮次、未探索区域及原因）
2. 测试现状体检表（套件四态清单 + 质量债 Top 5 + RUN 基线计数）
3. 测试基线地图：测试域 | 我们 | 业界基准 | 差距 | 来源 |
   observed_at | 状态截至 | 可能已变更
   【只收 EXTERN/INFER；EXTERN_MEM 只进第 10 节】
4. 风险-覆盖差距分析（阻断风险 / 能力缺失 / 加分项）
5. 改进方案清单（表格，字段全集见 §6 Phase 4）
6. 三条 Quick Win（本周就能落的测试改进，附改动位置）
7. 4~8 周测试建设路线图（依赖顺序、CI 接入策略、带宽可行性）
8. 高杠杆机会（1-2 条投入小、防风险大的方向 + 验证方式）
9. 反证与验证计划（高优结论的反证检查、验证方法、负责人）
10. 未验证基准线索（EXTERN_MEM 清单 + 模型知识截止时间）
11. 假设表格（ID | 假设 | 影响范围 | 验证方法 | 若为假如何调整 | 置信度）
12. BENCH_DEFAULT 使用清单
13. 需人工提供的质量数据（仅 §7(b) 命中）+ 拿到后如何重排
14. 建议沉淀进 AGENTS.md / docs/quality.md 的条款
```

### 6.9 只读模式交付规范

- state.json 保留内存，无法读取则初始化；`environment.read_only = true`；
- 报告出 stdout（Markdown，头部 `READ_ONLY_MODE=true`）；不写 `.qa/final-report.md`、`.qa/last-run.txt`；
- **续跑不可用**：附 state.json 快照（JSON 代码块）供人工保存。

---

## 7. 异常与降级（仅四类）

### 触发中断（可请求人工）

**(a)** 需要测试执行环境但不可用（依赖无法安装 / 沙箱不可用 / 测试容器无法启动）。
**(b)** 决策依赖真实质量数据（线上故障率/工单分布/SLA 要求），而仓库文件、git 历史均无线索。两条件**同时满足**才触发；仓库有 error-tracking 集成代码（Sentry 类 SDK）、issue 模板含 bug 分类、CHANGELOG 修复记录 → 视为"有线索"，应自行推断而非提问。触发时附：进度摘要 + 缺失数据清单 + 按低/中/高三量级的分叉方案。

### 降级继续（不中断）

**(c)** 预算耗尽但高价值区域未探索完 → 优先保证 DONE 产出报告。
**(d)** 网络不可用或目标网站无法访问（基准阶段的核心依赖）→ degraded_mode：允许 EXTERN_MEM（记模型知识截止时间），禁入正式基线表、禁参与 gap 打分，只进"未验证基准线索"；报告标注"因网络不可用，以下测试域基准缺失：[列出]"；继续推进。
---

## 8. monorepo / polyrepo 专项

### 8.1 monorepo

- **identity**：分别对 frontend/backend/infra 推断产品类型与测试栈，取交集为全局值；各模块指向不同领域 → 标"多产品域：[各域及证据]"，分别记录；
- **风险建模天然按模块**：churn/fix 密度逐模块计算（§6 Phase 3 命令天然按目录聚合）；
- **预算**：全局 allocation 不变；各 Phase 预算 80% 按模块数 N 均分，20% 跨模块分析优先耗 reserve；单模块 <1 轮 → 合并模块或降扫描深度；
- **共享库**（如 `packages/shared`）不入测试清单，记 `shared_dependency`——共享库自身无测试 = 下游所有模块风险放大，此结论必须进报告。

### 8.2 polyrepo（Pre-phase 0 探测后立即执行）

- 主 state：`.qa/state.json`（repo_list、全局 phase/budget、merge_status、conflicts）；
- 分片 state：`.qa/repos/{repo_name}/state.json`（复用 schema 子集：environment、inventory、baselines、risks、gaps、proposals、hypotheses、issues、saturated、log）；
- 各仓库分别环境探测；汇总合并 findings，冲突保留双方标 `CONFLICT`；共享库按 shared_dependency 处理。

---
