# PM-Agent Skill 参考资料：Phase 执行手册 · 异常与降级 · monorepo/polyrepo（§6–§8）

> 由 pm-agent-generate.cjs --split 自动生成，源为 `skills/pm-agent/SKILL.md` 内容块。
> 正文中引用的 §0–§5、§10 规则见主文件 SKILL.md。

- §6 Phase 执行手册（Pre-phase 0 → Phase 6 全流程 + 6.9 只读模式交付规范）
- §7 异常与降级（a/b 触发中断，c/d 降级继续）
- §8 monorepo / polyrepo 专项

## 6. Phase 执行手册

### Pre-phase 0 ENVIRONMENT（1 轮，强制最先）

探测并写入 `environment` 字段：

1. **git**：`git rev-parse --git-dir`，成功记录 root + 分支 + 最近 tag；
2. **写权限**：写删 `.pm/test_write.txt`，失败=只读模式（§6.9）；
3. **网络**：访问 `https://www.google.com`（或国内镜像）；
4. **仓库类型**：检测 `pnpm-workspace.yaml` / `lerna.json` / `nx.json` / `turbo.json` / `go.work` / `Cargo.toml` workspace / maven modules → single/monorepo/polyrepo；
5. **语言/框架**：扫描 `package.json` / `go.mod` / `pom.xml` / `requirements.txt` / `pyproject.toml`。
   **降级**：无 git → team/velocity/maturity 全标 ASSUME；无写权限 → 只读模式；无网络 → §7(d)；monorepo/polyrepo → §8。
   **退出**：environment 写入，phase → identity。

### Phase 0 IDENTITY（5 轮）

产出 `identity` 全部字段，**必须确定 product_type**（决定 §3.2 权重；无法判定默认 B 端权重并记 ASSUME）。

1. 产品类型与领域（monorepo 按 §8.1 交集规则）；
2. 核心用户与核心任务：`core_user`、`main_jobs`（README、路由命名、权限模型、界面文案语言推断）；
3. 技术栈与平台：`tech_stack`、`platforms`（依赖清单、Dockerfile、CI 配置）；
4. **团队规模与带宽**（必须有，成本校准用）：
   ```bash
   # 贡献者数（排除 CI/bot）
   git log --format="%ae" --since="90 days ago" \
     | grep -viE 'noreply|bot|dependabot|renovate|ci@' \
     | sort -u | wc -l
   # 周均 commit（90天 ÷ 7 ≈ 12.86 周）
   git log --since="90 days ago" --pretty=format:%H --no-merges \
     | wc -l | awk '{print $1/12.86}'
   ```
   另：前端目录最近修改者去重 → `frontend_count_est`；`.github/workflows` / CODEOWNERS / ISSUE_TEMPLATE / CHANGELOG → 工程化成熟度；输出单改动成本阈值（例：>3 人日=需专项排期）。**全部标"估算"**。
5. 发布节奏（tag 频率、CHANGELOG）、成熟度、市场线索（lang/i18n/compliance）。
   允许来源：FACT/INFER/ASSUME；每条 ASSUME 同步写入 hypotheses。退出：identity 齐全或预算耗尽，product_type 必须有值。

### Phase 1 INVENTORY（11 轮）

- 扫描面（按项目类型裁剪）：路由/页面、API 端点、定时任务、消息队列消费者、迁移文件、前端组件树、CLI 命令；
- 每条功能附 `file:line`（FACT only），分四态：**完整**（链路齐备+有入口）/ **部分**（有入口但链路断）/ **残缺**（仅骨架/TODO）/ **废弃**（无入口引用且 deprecated）；
- **体验债** `ux_debt`：TODO/FIXME、裸 catch、无 loading/错误态、硬编码文案等，只收 FACT，Top 5 进报告；
- **missing_basics**：同类产品必备但本仓库无实现痕迹的能力，允许 INFER，不入体检表，只作 gap 候选；
- 无新增区域写入 `saturated`；共享库与 infra 配置按 §8.1 处理。

### Phase 2 BENCHMARK（10 轮）

- **选品**：有网络——相关度优先，star 数仅作成熟度参考（非 3k 项目须说明理由），必须真实存在、可公开访问，禁止虚构；无网络——§7(d) 降级，产 EXTERN_MEM；
- 产出 2–3 个对标（A/B/C）功能域打勾表，正式表只收 EXTERN/INFER；
- **时间衰减**：每条记录 `observed_at`（ISO8601）、可获取时记 `version_observed`；近 6 个月有重大版本更新 → 标"可能已变更"并建议人工复核；EXTERN_MEM 记模型知识截止时间，不写访问日期。

### Phase 3 GAP（8 轮）

- 输入：inventory（含 missing_basics）+ benchmarks；
- 三档分类：**阻塞体验 / 能力缺失 / 锦上添花**；
- 每条字段：ID | 描述 | 功能域 | 证据锚点或对标参照 | 来源类型 | 初拟严重度；
- 严重度为**初拟**，Phase 5 终算后按 §3.3 回填。

### Phase 4 PROPOSAL（10 轮）

- 每个 gap ≥1 条 proposal；超团队单改动阈值 → 拆 **v1（最小可用）→ v2（完整）**；
- 字段全集：ID | 类型 | 问题 | 目标 | 参照 | 严重度 | 项目类型 | w_c | w_f | w_p | 覆盖 | 频次 | 痛点 | impact | confidence | confidence_weight | cost | score | 证据锚点 | 依赖关系 | 是否可灰度 | 是否可配置开关 | effort_default | effort_optimistic | effort_pessimistic | P0/P1/P2；
- 逐因子标注 confidence + 证据锚点，无证据用 BENCH_DEFAULT；
- 记录 proposal 间依赖（供 §3.4）；
- 粗估 effort 完成 score 初稿与初步分类。

### Phase 5 COST（6 轮）

**经验系数表**（git 历史无法校准时的 fallback）：

| 改动类型                | 基础人日(默认) | 乘数             | 范围    | 乘数默认 |
| ----------------------- | -------------- | ---------------- | ------- | -------- |
| 纯前端页面增改          | 1 (0.5-2)      | × 组件复用率     | 0.5-1.5 | 1.0      |
| 前端组件/交互优化       | 1.5 (1-2)      | × 状态管理复杂度 | 1-2     | 1.0      |
| 接口增改（不动 schema） | 2 (1-3)        | × API 调用方数量 | 1-3     | 1.5      |
| 改 schema + 数据迁移    | 3 (2-8)        | × 数据量级       | 1-2     | 1.0      |
| 新增外部系统集成        | 5 (3-10)       | × 联调系数       | 1.5-3   | 1.5      |
| 权限/安全相关改动       | 3 (2-5)        | × 审计范围       | 1-2     | 1.0      |

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
[ ] 每条 EXTERN 都有 URL + 访问日期，或已标 EXTERN_MEM 并排除打分
[ ] 每个 P0 gap 至少对应一条 proposal
[ ] 每个 proposal 都有 effort 区间（乐观/悲观），P0/P1 不得缺失
[ ] 超阈值的 proposal 已拆分 v1 → v2
[ ] assumptions 清单完整（Phase 0 所有 ASSUME 字段）
[ ] 现状体检表/功能清单内不含 ASSUME 条目
[ ] 对标条目无虚构 URL/star 数/功能细节
[ ] 饱和区域与未探索区域已明确列出
[ ] state.json 中 phase、rounds_used、budget 一致
[ ] 对标地图含观察日期和"可能已变更"标记
[ ] 预算耗尽时已列出未探索区域
[ ] 只读模式下报告已输出到 stdout
[ ] P0/P1/P2 分类有 score 阈值依据（§3.3）
[ ] EXTERN_MEM 未进入正式对标地图（含打勾表和 gap 打分）
[ ] 方案清单含 coverage/frequency/pain 原始因子
[ ] 方案清单含项目类型和 w_c/w_f/w_p
[ ] P0 总数 <= 所有 proposal 的 20%
[ ] BENCH_DEFAULT 使用清单已列出
[ ] 只读模式已声明"续跑不可用"，或已附 state.json 快照
```

### Phase 6 DONE（1 轮）

1. 可写：报告写 `.pm/final-report.md`（UTF-8 Markdown）；只读：输出 stdout，头部标 `READ_ONLY_MODE=true`；
2. 可写：state.json `phase` 置 "done"；
3. 可写：创建 `.pm/last-run.txt`：

```json
{
  "finished_at": "ISO8601时间戳",
  "total_rounds": 0,
  "phase": "done",
  "report_path": ".pm/final-report.md",
  "issues_count": 0,
  "proposals_count": 0
}
```

4. 终端摘要：Top 5 问题（ID | 严重度 | 位置 | 业务后果）+ 报告路径；
5. 按 §9 产出知识库沉淀草案。
   **最终报告结构**（中文，代码/路径保持原文）：

```
0. 身份推断摘要（产品判断 + 依据 + 置信度 + 未解假设）
1. 执行摘要（覆盖范围、轮次、未探索区域及原因）
2. 现状体检表（功能四态清单 + 体验债 Top 5）
3. 对标地图：功能域 | 我们 | 对标 A | 对标 B | 对标 C | 来源 |
   observed_at | version_observed | 状态截至 | 可能已变更
   【只收 EXTERN/INFER；EXTERN_MEM 只进第 10 节】
4. 差距分析（阻塞体验 / 能力缺失 / 锦上添花）
5. 方案清单（表格，字段全集见 §6 Phase 4）
6. 三条 Quick Win（本周可合，附改动位置）
7. 4~8 周迭代路线图（依赖顺序、灰度策略、带宽可行性）
8. 差异化机会（1-2 条对标没有且我们有优势的方向 + 验证方式）
9. 反证与验证计划（高优结论的反证检查、验证方法、负责人）
10. 未验证对标线索（EXTERN_MEM 清单 + 模型知识截止时间）
11. 假设表格（ID | 假设 | 影响范围 | 验证方法 | 若为假如何调整 | 置信度）
12. BENCH_DEFAULT 使用清单
13. 需人工提供的业务数据（仅 §7(b) 命中）+ 拿到后如何重排
14. 建议沉淀进 AGENTS.md / docs/product.md 的条款
```

### 6.9 只读模式交付规范

- state.json 保留内存，无法读取则初始化；`environment.read_only = true`；
- 报告出 stdout（Markdown，头部 `READ_ONLY_MODE=true`）；不写 `.pm/final-report.md`、`.pm/last-run.txt`；
- **续跑不可用**：附 state.json 快照（JSON 代码块）供人工保存。

---

## 7. 异常与降级（仅四类）

### 触发中断（可请求人工）

**(a)** 需要执行/部署/登录环境但不可用。
**(b)** 决策依赖真实业务数据（转化率/留存/用户量级/营收占比），且仓库文件、git 历史均无线索。两条件**同时满足**才触发；仓库有 analytics/metrics/data/ 目录或埋点代码即视为"有线索"，应自行推断而非提问。触发时附：进度摘要 + 缺失数据清单 + 按低/中/高三量级的分叉方案。

### 降级继续（不中断）

**(c)** 预算耗尽但高价值区域未探索完 → 优先保证 DONE 产出报告。
**(d)** 网络不可用或目标网站无法访问 → degraded_mode：允许 EXTERN_MEM（记模型知识截止时间），禁入正式对标表、禁参与 gap 打分，只进"未验证对标线索"；报告标注"因网络不可用，以下功能域对标缺失：[列出]"；继续推进。
---

## 8. monorepo / polyrepo 专项

### 8.1 monorepo

- **identity**：分别对 frontend/backend/infra 推断，取交集为全局 product_type；各模块指向不同领域 → 标"多产品域：[各域及证据]"，分别记录；
- **预算**：全局 allocation 不变；各 Phase 预算 80% 按模块数 N 均分，20% 跨模块分析优先耗 reserve；单模块 <1 轮 → 合并模块或降扫描深度；
- **infrastructure 配置**不计入产品功能，只记 `infrastructure_debt`；
- **共享库**（如 `packages/shared`）不计入功能清单，只记 `shared_dependency`，影响 effort 与依赖。

### 8.2 polyrepo（Pre-phase 0 探测后立即执行）

- 主 state：`.pm/state.json`（repo_list、全局 phase/budget、merge_status、conflicts）；
- 分片 state：`.pm/repos/{repo_name}/state.json`（复用 schema 子集：environment、inventory、benchmarks、gaps、proposals、hypotheses、issues、saturated、log）；
- 各仓库分别环境探测；汇总合并 findings，冲突保留双方标 `CONFLICT`；共享库按 shared_dependency 处理。

---
