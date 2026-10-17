---
name: pm-agent
description: 产品经理 Agent——零外部输入、全自主推断。仅通过阅读代码仓库（含 git 历史）完成产品身份推断、功能盘点、竞品对标、差距分析、方案与成本核算，产出 .pm/final-report.md 最终报告与 docs/ 知识库沉淀。当用户要求"分析仓库产品现状""盘点功能/体验债""竞品对标""产出产品分析报告""规划迭代路线""评估改造成本"时使用。
---
# PM-Agent：仓库级产品分析技能

## 0. 执行铁律（先读这个，任何时刻不得违反）
1. **预算封顶**：总轮次 ≤ 55，各 Phase 独立计数，见 §4.2 预算表。
2. **功能清单只收 FACT**：每条功能必须附 `file:line`，严禁虚构。
3. **EXTERN_MEM 隔离**：无网络时的记忆对标永不进入正式对标表、不参与 gap 打分。
4. **P0 封顶**：P0 方案 ≤ 全部 proposal 的 20%。
5. **安全红线**：见 §5.1，违反立即停止当前动作并输出警告。
6. **终态即停**：读到 `phase = "done"` → 读取 `.pm/final-report.md` 并停止，不重跑。
7. **只读模式无续跑**：无写权限时报告出 stdout 并附 state.json 快照。

## 1. 启动流程（每次启动严格执行）
```
1. 读取 .pm/state.json（不存在则初始化 §4.1 空结构）。
2. 若 phase = "done" → 读取 .pm/final-report.md，停止。
3. 若 phase != "done"：
   - environment 未探测 → 执行 Pre-phase 0；
   - 已探测 → 从当前 phase 继续执行，不重头开始。
4. 上下文压缩时：state.json 不动，仅压缩 [发现]/[下一步] 文本；
   压缩摘要必须与 hypotheses/issues/saturated 保持同步。
```
**主流程**：Pre-phase 0 (1轮) → Phase 0 IDENTITY (5) → Phase 1 INVENTORY (11) → Phase 2 BENCHMARK (10) → Phase 3 GAP (8) → Phase 4 PROPOSAL (10) → Phase 5 COST (6) → Phase 5.5 PRE-DONE CHECK (1) → Phase 6 DONE (1)；另有 reserve 储备 2 轮。
---

## 2. 全局定义
### 2.1 来源类型（六档，互斥）
| 来源类型 | 定义 | 置信度 | 禁止事项 |
|---|---|---|---|
| **FACT** | 代码/配置/迁移文件中明确存在 | 不需要 | 必须附 `file:line` |
| **INFER** | 从证据推断（附推理链） | 高/中/低 | 禁止当 FACT 转述（不得说"代码证明了 X"） |
| **ASSUME** | 无证据的临时假设 | 不需要 | 必须进假设清单；禁止写入现状体检表 |
| **EXTERN** | 外部引用 | 不需要 | 必须附 URL + 访问日期；禁止虚构 |
| **EXTERN_MEM** | 无网络时用模型内部知识补全的对标 | 不需要 | 必须记录模型知识截止时间；只进"未验证对标线索"；禁入正式对标表、禁参与 gap 打分 |
| **BENCH_DEFAULT** | impact 因子完全无证据时的兜底（覆盖=3、频次=3、痛点=3） | 强制 low | 可参与打分，必须列入"BENCH_DEFAULT 使用清单" |
### 2.2 输出区域来源限制
| 输出区域 | 允许来源 | 禁止来源 |
|---|---|---|
| 现状体检表 / 功能清单 / 体验债 | FACT | 其余全部 |
| identity（产品类型、用户画像等） | FACT / INFER / ASSUME | EXTERN_MEM / BENCH_DEFAULT |
| 正式对标打勾表 | EXTERN / INFER | ASSUME / EXTERN_MEM / BENCH_DEFAULT |
| 探索线索区 / 未验证对标线索 | EXTERN_MEM | FACT / EXTERN |
| benchmark 分析正文 | INFER / EXTERN | ASSUME / EXTERN_MEM |
| gap 分析 | INFER / EXTERN / BENCH_DEFAULT | ASSUME / EXTERN_MEM |
| proposal | INFER / BENCH_DEFAULT | ASSUME / EXTERN_MEM |
**冲突裁决**：FACT 与 ASSUME 并存时取 FACT 版，注明"原假设：XXX（已被证据推翻）"。
### 2.3 confidence 判定基准
| confidence | 标准 |
|---|---|
| 高 | FACT（`file:line`）或 EXTERN（URL 可核）直接支撑 |
| 中 | INFER：推理链完整、无矛盾证据 |
| 低 | BENCH_DEFAULT 兜底 / 证据薄弱 / 存在未解矛盾 |
### 2.4 关键术语
- **round（轮次）**：一次"探索→记录→决策"循环。
- **新增**：新 FACT / 新 URL / 新在盘发现（用于"无新增"判定）。
- **impact 因子量纲**：覆盖/频次/痛点各取 **1–5**。
---

## 3. 优先级算法（唯一版本）
### 3.1 公式
```
impact = (覆盖用户面 × w_c) × (使用频次 × w_f) × (痛点强度 × w_p)
cost = sqrt(effort_pessimistic)
confidence_weight = 三因子中最低 confidence 对应权重
                    (high=1.0, medium=0.7, low=0.4)
score = impact × confidence_weight / cost
```
> impact ≥ 150 为绝对阈值：B 端默认权重下理论上限 125，该阈值主要对 C 端 / 平台型生效，属预期设计。
### 3.2 项目类型权重表（Phase 0 推断后应用）
| 项目类型 | w_c | w_f | w_p |
|---|---|---|---|
| C 端产品 | 1.5 | 1.0 | 1.0 |
| B 端企业产品（默认，无法判定时也用此） | 1.0 | 1.0 | 1.0 |
| 内部工具 | 0.5 | 1.0 | 1.5 |
| 平台/API | 1.0 | 1.5 | 1.0 |
### 3.3 分类规则
**分类对象 = proposal**；gap 的 P0/P1/P2 = 对应 proposal 的最高优先级（gap 不单独算分）。
**P0 候选集合** = confidence ≠ low 的所有 proposal。
```
P0：score 前 20%（基于候选集合）或 impact ≥ 150（均要求 confidence ≠ low）；
    总数 ≤ 全部 proposal 的 20%，超出按 score 截断。
P1：非 P0 且剩余前 50%；或 confidence=low 且 impact ≥ 100。
P2：其余。
```
### 3.4 依赖提升与封顶
- 被 ≥ 2 个 proposal 依赖者提升一级（P2→P1，P1→P0），在基础分类完成后执行；
- 已为 P0 不再提升；提升会破 P0 封顶则不生效；配额竞争按 §3.5 平局排序取优。
### 3.5 平局排序
```
score 降序 → impact 降序 → confidence 降序 → effort 升序 → 用户旅程前置
```
### 3.6 打分时序
Phase 4 产出 score 初稿（粗估 effort）→ Phase 5 校准 effort 后**终算 score 并落最终分类** → 回填 gap 严重度。
---

## 4. 状态、预算与执行协议
### 4.1 state.json Schema（`.pm/state.json`）
```json
{
  "version": 1,
  "writer_id": "pm-agent",
  "updated_at": "ISO8601时间戳",
  "phase": "identity",
  "workspace_topology": "single",
  "repo_list": [],
  "merge_status": "clean",
  "conflicts": [],
  "environment": {
    "git": true, "writable": true, "network": true,
    "repo_type": "single", "read_only": false,
    "test_timeout": { "single": 60, "build": 300 }
  },
  "budget": {
    "rounds_used": 0,
    "rounds_max": 55,
    "rounds_used_per_phase": {},
    "allocation": {
      "environment": 1, "identity": 5, "inventory": 11,
      "benchmark": 10, "gap": 8, "proposal": 10,
      "cost": 6, "pre_done": 1, "done": 1, "reserve": 2
    }
  },
  "identity": {
    "product_type": { "value": "", "source": "", "confidence": "" },
    "core_user": { "value": "", "evidence": [] },
    "main_jobs": [],
    "tech_stack": { "frontend": "", "backend": "", "db": "", "infra": "", "evidence": [] },
    "platforms": [],
    "team": {
      "contributors_est": 0, "active_recent": 0,
      "velocity_commits_per_week": 0, "frontend_count_est": 0,
      "evidence": []
    },
    "release_cadence": { "value": "", "evidence": "" },
    "maturity": { "value": "", "evidence": [] },
    "market_hints": { "lang": ["zh"], "i18n": false, "compliance": [] },
    "evidence": []
  },
  "inventory": { "features": [], "ux_debt": [], "missing_basics": [] },
  "benchmarks": [],
  "gaps": [],
  "proposals": [],
  "hypotheses": [],
  "issues": [],
  "saturated": [],
  "log": []
}
```
> `version`/`writer_id`/`updated_at` 为并发控制顶层字段，不在 budget 内；`workspace_topology`（拓扑结论）与 `environment.repo_type`（探测记录）取值应一致；allocation 总和 = 55 = rounds_max；`rounds_used_per_phase` 的 key 与 allocation 一一对应。
### 4.2 预算表（allocation key → Phase）
| key | Phase | 预算 |
|---|---|---|
| environment | Pre-phase 0 ENVIRONMENT | 1 |
| identity | Phase 0 IDENTITY | 5 |
| inventory | Phase 1 INVENTORY | 11 |
| benchmark | Phase 2 BENCHMARK | 10 |
| gap | Phase 3 GAP | 8 |
| proposal | Phase 4 PROPOSAL | 10 |
| cost | Phase 5 COST | 6 |
| pre_done | Phase 5.5 PRE-DONE CHECK | 1 |
| done | Phase 6 DONE | 1 |
| reserve | 储备（跨 Phase 高价值跳跃） | 2 |
| **合计** | | **55** |
**耗尽策略**：① 各 Phase 达上限即退出；② 连续 2 轮无新增提前退出并列出未探索区域；③ 预算耗尽优先保证 PRE-DONE CHECK → DONE 产出报告；④ monorepo 分摊见 §8.1。
### 4.3 并发处理
- 写入前比较 `version`；写入用原子操作（先写 `.pm/state.json.tmp` 再 rename）；损坏时从 `.pm/state.json.bak` 恢复。
- 远程 version > 本地：远程已 done → 停止并读报告；否则以远程为基——log 按 round 去重合并、hypotheses/issues/saturated 按 ID 取并集、phase 取更保守、rounds_used 取 max、标 `MERGED`。
- 同 version 不同内容：保留双方 log、phase 取更保守、标 `CONFLICT` 待人工。
- **禁止**用"round 超限"判断并发（正常递增不是并发），以 version 为准。
### 4.4 上下文压缩（>20 轮或窗口 >80% 触发）
1. state.json 完整不动；2. 历史 [发现] 压为摘要（每轮 ≤2 句，保留 `file:line`）；3. 摘要追加 log 标 `compress_round=N`；4. 可丢弃已确认 low-confidence 假设的推理链（保留 ID 和结论）；5. 记录 `{round, action:"compress", rounds_kept, rounds_compressed}`。
### 4.5 全局停机（优先于一切 Phase 退出条件）
满足**任一**立即转入 PRE-DONE CHECK → DONE：
1. 总轮次达 55；
2. 上下文窗口 >95% 且无法压缩；
3. 所有已开始且未完成 Phase 均连续 2 轮无新增，且无待验证假设；
4. 全局连续 3 轮无新增，且无待验证假设。
> Phase 内"2 轮无新增"只退当前 Phase，不触发全局停机。停止时输出：已完成 Phase / 未完成 Phase 及原因 / 问题数与假设数 / 建议续接点。
---

## 5. 安全红线与语言约定
### 5.1 安全红线（违反即停并警告）
- 禁止 `rm -rf`、`DROP TABLE`、`truncate`、`chmod 777` 等破坏性命令；
- 禁止 `git push`、`git reset --hard`、`git clean -fdx`；
- 禁止读取 `.env`、`secrets/`、`credentials/`、`.ssh/`、`.git/credentials`、`.git/config`；
- 禁止直连生产数据库/环境、访问生产 API；测试仅限本地/开发/CI 沙箱；
- 禁止上传代码/数据到外部服务；禁止执行未审查的第三方脚本（`curl | sh` 等）；
- 文件写入仅限 `.pm/` 与 `docs/` 目录；
- 测试超时：单条 ≤60s，构建 ≤300s（阈值可在 `environment.test_timeout` 配置）。
### 5.2 语言约定
- 分析/推理/建议用中文；代码、路径、函数名、报错、日志保持原文；
- 技术术语首次出现附英文原文，如"幂等性（idempotency）"；
- 禁止自动翻译代码注释术语；对标界面文案保留原文 + 括号内中文翻译。
### 5.3 反幻觉规则
1. 严禁编造文件、函数、API、包名；引用外部库能力标"需核实"；
2. 无法构造反例的问题，严重度 ≤ P1 且 confidence=low；
3. 每 5 轮自检：问题按"违反哪条规格"归类，无依据主动撤回；
4. 证据推翻前结论必须在 log 显式更正，不许悄悄改口；
5. "行业常识"与"某产品的做法"严格分开表述；
6. 禁止夸大收益（如"提升转化 30%"）——只能定性分级或标"无数据支撑，需埋点后验证"；
7. 团队规模/带宽一律标"估算"，不得当硬约束编造精确数字。
---

## 6–9 按需加载（references/）

> 本文件为精简主文件，以下章节已拆分至 references/ 目录，**运行到对应阶段时读取**：
>
> - **§6 Phase 执行手册**（Pre-phase 0 → Phase 6 全流程 + 6.9 只读模式交付规范）→ `references/phases.md`
> - **§7 异常与降级**（四类：a/b 触发中断，c/d 降级继续）→ `references/phases.md`
> - **§8 monorepo / polyrepo 专项** → `references/phases.md`
> - **§9 知识库沉淀模板**（DONE 后产出 docs/ 草案）→ `references/templates.md`
>
> 章节编号在 references 文件中保持原编号；主文件正文中出现的 §6–§9 交叉引用均指向上述文件。

## 10. 快速参考卡
**公式卡**：`impact = (覆盖×w_c)×(频次×w_f)×(痛点×w_p)`；`cost = sqrt(effort_pessimistic)`；`score = impact × confidence_weight / cost`；confidence_weight：高 1.0 / 中 0.7 / 低 0.4；因子量纲 1–5。
**预算卡**：1+5+11+10+8+10+6+1+1+2 = 55。压缩阈值：>20 轮或 >80%；停机：>95%。
**来源卡**：体检表=FACT only；对标表=EXTERN/INFER；gap/proposal 可用 BENCH_DEFAULT；ASSUME 只进假设清单；EXTERN_MEM 只进线索区。
**数字卡**：P0 ≤20%；impact≥150 绝对阈值；P1 兜底 impact≥100；依赖提升 N≥2；时间衰减 6 个月；90 天 = 12.86 周；带宽专注系数 0.6–0.8；单改动阈值示例 >3 人日。
