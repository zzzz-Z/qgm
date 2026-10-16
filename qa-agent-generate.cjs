#!/usr/bin/env node
/**
 * qa-agent-generate.cjs — QA-Agent Skill 一键生成脚本（通用版）
 *
 * 用法：node qa-agent-generate.cjs [目标目录] [选项]
 *
 * 选项：
 *   --force, -f   覆盖已存在文件（默认跳过）
 *   --split       拆分模式：SKILL.md 只保留必读部分（§0–§5 + §10 + 加载指引），
 *                 §6–§8 拆到 references/phases.md，§9 拆到 references/templates.md
 *   --check       校验模式：比对磁盘文件与脚本内置内容（全部一致退出码 0，有差异退出码 1）
 *
 * 示例：
 *   node qa-agent-generate.cjs .                     # 单文件版
 *   node qa-agent-generate.cjs ~/my-repo --split     # 拆分版
 *   node qa-agent-generate.cjs . --check --split     # 校验拆分版
 *
 * 生成清单：
 *   skills/qa-agent/SKILL.md（+ --split 时 references/ 两件）
 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')
/* ================================================================
 * 文件内容区（=====FILE: <相对路径> ===== ... =====END FILE =====）
 * 直接编辑下方内容后重新运行脚本即可更新产物。
 * ================================================================ */
/* =====FILE: skills/qa-agent/SKILL.md =====
---
name: qa-agent
description: 测试工程师 Agent——零外部输入、全自主推断。仅通过阅读代码仓库（含 git 历史）、静态分析与受控测试执行，完成测试资产盘点、风险建模、业界基准对标、质量差距分析、测试改进方案与成本核算，产出 .qa/final-report.md 最终报告与 docs/quality.md 沉淀。当用户要求"评估测试/质量现状""盘点测试覆盖""找测试缺口/质量风险""规划测试建设""评估测试改造成本""分析 flaky 测试"时使用。
---
# QA-Agent：仓库级测试质量分析技能
## 0. 执行铁律（先读这个，任何时刻不得违反）
1. **预算封顶**：总轮次 ≤ 55，各 Phase 独立计数，见 §4.2 预算表。
2. **质量债只收 FACT**：每个标记必须附 `file:line`，严禁虚构。
3. **只分析不改码**：禁止修改业务源码与现有测试文件；写入仅限 `.qa/` 与 `docs/` 目录。
4. **RUN 证据规范**：测试执行前必须先静态确认命令（来自 scripts/CI 配置），执行后附命令 + 时间戳 + 结果计数 + 环境标记；有破坏性副作用的脚本一律禁执行。
5. **EXTERN_MEM 隔离**：无网络时的记忆基准永不进入正式基线表、不参与 gap 打分。
6. **P0 封顶**：P0 方案 ≤ 全部 proposal 的 20%。
7. **安全红线**：见 §5.1，违反立即停止当前动作并输出警告。
8. **终态即停 / 只读无续跑**：读到 `phase = "done"` 读 `.qa/final-report.md` 即停；无写权限时报告出 stdout 并附 state.json 快照。
## 1. 启动流程（每次启动严格执行）
```
1. 读取 .qa/state.json（不存在则初始化 §4.1 空结构）。
2. 若 phase = "done" → 读取 .qa/final-report.md，停止。
3. 若 phase != "done"：
   - environment 未探测 → 执行 Pre-phase 0；
   - 已探测 → 从当前 phase 继续执行，不重头开始。
4. 上下文压缩时：state.json 不动，仅压缩 [发现]/[下一步] 文本；
   压缩摘要必须与 hypotheses/issues/saturated 保持同步。
```
**主流程**：Pre-phase 0 (1轮) → Phase 0 IDENTITY (5) → Phase 1 INVENTORY (11) → Phase 2 BASELINE (10) → Phase 3 RISK-GAP (8) → Phase 4 PLAN (10) → Phase 5 COST (6) → Phase 5.5 PRE-DONE CHECK (1) → Phase 6 DONE (1)；另有 reserve 储备 2 轮。
---
## 2. 全局定义
### 2.1 来源类型（七档，互斥）
| 来源类型 | 定义 | 置信度 | 禁止事项 |
|---|---|---|---|
| **FACT** | 代码/配置/测试文件中明确存在 | 不需要 | 必须附 `file:line` |
| **RUN** | 实际执行测试/命令得到的动态证据 | 不需要（观测事实） | 必须附：执行命令 + ISO8601 时间戳 + 关键结果计数（pass/fail/skip）+ 环境标记（local/ci/container）；flaky 判定须附 3 次执行结果 |
| **INFER** | 从证据推断（附推理链） | 高/中/低 | 禁止当 FACT 转述（不得说"测试证明了 X"） |
| **ASSUME** | 无证据的临时假设 | 不需要 | 必须进假设清单；禁止写入测试体检表 |
| **EXTERN** | 外部引用 | 不需要 | 必须附 URL + 访问日期；禁止虚构 |
| **EXTERN_MEM** | 无网络时用模型内部知识补全的基准条目 | 不需要 | 必须记录模型知识截止时间；只进"未验证基准线索"；禁入正式基线表、禁参与 gap 打分 |
| **BENCH_DEFAULT** | impact 因子完全无证据时的兜底（风险面=3、故障概率=3、后果强度=3） | 强制 low | 可参与打分，必须列入"BENCH_DEFAULT 使用清单" |
### 2.2 输出区域来源限制
| 输出区域 | 允许来源 | 禁止来源 |
|---|---|---|
| 测试现状体检表 / 测试清单 / 质量债 | FACT / RUN | INFER / ASSUME / EXTERN / EXTERN_MEM / BENCH_DEFAULT |
| identity（产品类型、关键性、测试栈等） | FACT / INFER / ASSUME | EXTERN_MEM / BENCH_DEFAULT |
| 正式基线打勾表 | EXTERN / INFER | ASSUME / EXTERN_MEM / BENCH_DEFAULT / RUN |
| 探索线索区 / 未验证基准线索 | EXTERN_MEM | FACT / RUN / EXTERN |
| baseline 分析正文 | INFER / EXTERN | ASSUME / EXTERN_MEM |
| 风险模型 / gap 分析 | FACT / RUN / INFER / BENCH_DEFAULT | ASSUME / EXTERN_MEM |
| proposal | INFER / BENCH_DEFAULT | ASSUME / EXTERN_MEM |
**冲突裁决**：FACT/RUN 与 ASSUME 并存时取前者，注明"原假设：XXX（已被证据推翻）"；RUN 与静态 FACT 矛盾时（如测试文件存在但执行失败），以 RUN 为准并记录矛盾。
### 2.3 confidence 判定基准
| confidence | 标准 |
|---|---|
| 高 | FACT（`file:line`）/ RUN（执行证据）直接支撑，或 EXTERN（URL 可核）直接对应 |
| 中 | INFER：推理链完整、无矛盾证据 |
| 低 | BENCH_DEFAULT 兜底 / 证据薄弱 / 存在未解矛盾（含仅单次执行的 flaky 疑似） |
### 2.4 关键术语
- **round（轮次）**：一次"探索→记录→决策"循环。
- **新增**：新 FACT / 新 RUN / 新 URL / 新在盘发现（用于"无新增"判定）。
- **impact 因子量纲**：风险面/故障概率/后果强度各取 **1–5**。
- **flaky 疑似**：同一测试重复执行 3 次，结果不一致。
---
## 3. 优先级算法（唯一版本）
### 3.1 公式
```
impact = (风险面 × w_r) × (故障概率 × w_f) × (后果强度 × w_s)
cost = sqrt(effort_pessimistic)
confidence_weight = 三因子中最低 confidence 对应权重
                    (high=1.0, medium=0.7, low=0.4)
score = impact × confidence_weight / cost
```
因子定义（各 1–5）：
- **风险面**：该模块被多少用户路径/下游依赖触达（1=边缘功能 … 5=核心主链路）；
- **故障概率**：基于 churn、复杂度、历史 fix 密度（1=稳定少改 … 5=高频变更且多 fix）；
- **后果强度**：故障后的业务后果（1=体验瑕疵 … 5=资金/数据/安全事故）。
> impact ≥ 150 为绝对阈值：通用默认权重（1/1/1）下理论上限 125，该阈值主要对加权类型（资金类 w_s=1.5 等）生效，属预期设计。
### 3.2 项目类型权重表（Phase 0 推断后应用）
| 项目类型 | w_r（风险面） | w_f（故障概率） | w_s（后果强度） |
|---|---|---|---|
| 资金/支付/交易类 | 1.0 | 1.0 | 1.5 |
| C 端产品 | 1.5 | 1.0 | 1.0 |
| 内部工具 | 0.5 | 1.0 | 1.5 |
| 平台/API/SDK | 1.0 | 1.5 | 1.0 |
| 通用（默认，无法判定时用此） | 1.0 | 1.0 | 1.0 |
### 3.3 分类规则
**分类对象 = proposal（测试改进方案）**；gap 的 P0/P1/P2 = 对应 proposal 的最高优先级（gap 不单独算分）。
**P0 候选集合** = confidence ≠ low 的所有 proposal。
```
P0：score 前 20%（基于候选集合）或 impact ≥ 150（均要求 confidence ≠ low）；
    总数 ≤ 全部 proposal 的 20%，超出按 score 截断。
P1：非 P0 且剩余前 50%；或 confidence=low 且 impact ≥ 100。
P2：其余。
```
### 3.4 依赖提升与封顶
- 被 ≥ 2 个 proposal 依赖者提升一级（P2→P1，P1→P0），在基础分类完成后执行；
- 测试基建类方案（如"测试数据工厂""CI 门禁"）常被多条用例方案依赖，本机制天然适用；
- 已为 P0 不再提升；提升会破 P0 封顶则不生效；配额竞争按 §3.5 平局排序取优。
### 3.5 平局排序
```
score 降序 → impact 降序 → confidence 降序 → effort 升序 → 主链路前置
```
### 3.6 打分时序
Phase 4 产出 score 初稿（粗估 effort）→ Phase 5 校准 effort 后**终算 score 并落最终分类** → 回填 gap 严重度。
---
## 4. 状态、预算与执行协议
### 4.1 state.json Schema（`.qa/state.json`）
```json
{
  "version": 1,
  "writer_id": "qa-agent",
  "updated_at": "ISO8601时间戳",
  "phase": "identity",
  "workspace_topology": "single",
  "repo_list": [],
  "merge_status": "clean",
  "conflicts": [],
  "environment": {
    "git": true, "writable": true, "network": true,
    "repo_type": "single", "read_only": false,
    "test_timeout": { "single": 60, "suite": 300 },
    "test_runner": { "detected": false, "command": "", "framework": "" },
    "ci": { "detected": false, "platform": "", "test_blocking": false }
  },
  "budget": {
    "rounds_used": 0,
    "rounds_max": 55,
    "rounds_used_per_phase": {},
    "allocation": {
      "environment": 1, "identity": 5, "inventory": 11,
      "baseline": 10, "risk_gap": 8, "plan": 10,
      "cost": 6, "pre_done": 1, "done": 1, "reserve": 2
    }
  },
  "identity": {
    "product_type": { "value": "", "source": "", "confidence": "" },
    "criticality": { "money": false, "pii": false, "safety": false, "evidence": [] },
    "tech_stack": { "frontend": "", "backend": "", "db": "", "infra": "", "evidence": [] },
    "test_stack": { "unit": "", "integration": "", "e2e": "", "runner": "", "coverage_tool": "", "evidence": [] },
    "team": { "contributors_est": 0, "velocity_commits_per_week": 0, "evidence": [] },
    "ci_maturity": { "value": "", "evidence": [] },
    "market_hints": { "lang": ["zh"], "i18n": false, "compliance": [] },
    "evidence": []
  },
  "inventory": { "test_suites": [], "quality_debt": [], "untested_areas": [], "ci_gates": [] },
  "baselines": [],
  "risks": [],
  "gaps": [],
  "proposals": [],
  "hypotheses": [],
  "issues": [],
  "saturated": [],
  "log": []
}
```
> `version`/`writer_id`/`updated_at` 为并发控制顶层字段，不在 budget 内；`workspace_topology` 与 `environment.repo_type` 取值应一致；allocation 总和 = 55 = rounds_max；`rounds_used_per_phase` 的 key 与 allocation 一一对应。
### 4.2 预算表（allocation key → Phase）
| key | Phase | 预算 |
|---|---|---|
| environment | Pre-phase 0 ENVIRONMENT | 1 |
| identity | Phase 0 IDENTITY | 5 |
| inventory | Phase 1 INVENTORY | 11 |
| baseline | Phase 2 BASELINE | 10 |
| risk_gap | Phase 3 RISK-GAP | 8 |
| plan | Phase 4 PLAN | 10 |
| cost | Phase 5 COST | 6 |
| pre_done | Phase 5.5 PRE-DONE CHECK | 1 |
| done | Phase 6 DONE | 1 |
| reserve | 储备（跨 Phase 高价值跳跃） | 2 |
| **合计** | | **55** |
**耗尽策略**：① 各 Phase 达上限即退出；② 连续 2 轮无新增提前退出并列出未探索区域；③ 预算耗尽优先保证 PRE-DONE CHECK → DONE 产出报告；④ monorepo 分摊见 §8.1。
### 4.3 并发处理
- 写入前比较 `version`；写入用原子操作（先写 `.qa/state.json.tmp` 再 rename）；损坏时从 `.qa/state.json.bak` 恢复。
- 远程 version > 本地：远程已 done → 停止并读报告；否则以远程为基——log 按 round 去重合并、hypotheses/issues/saturated 按 ID 取并集、phase 取更保守、rounds_used 取 max、标 `MERGED`。
- 同 version 不同内容：保留双方 log、phase 取更保守、标 `CONFLICT` 待人工。
- **禁止**用"round 超限"判断并发，以 version 为准。
### 4.4 上下文压缩（>20 轮或窗口 >80% 触发）
1. state.json 完整不动；2. 历史 [发现] 压为摘要（每轮 ≤2 句，保留 `file:line` 与 RUN 计数）；3. 摘要追加 log 标 `compress_round=N`；4. 可丢弃已确认 low-confidence 假设的推理链（保留 ID 和结论）；5. 记录 `{round, action:"compress", rounds_kept, rounds_compressed}`。
### 4.5 全局停机（优先于一切 Phase 退出条件）
满足**任一**立即转入 PRE-DONE CHECK → DONE：
1. 总轮次达 55；
2. 上下文窗口 >95% 且无法压缩；
3. 所有已开始且未完成 Phase 均连续 2 轮无新增，且无待验证假设；
4. 全局连续 3 轮无新增，且无待验证假设。
> Phase 内"2 轮无新增"只退当前 Phase，不触发全局停机。停止时输出：已完成 Phase / 未完成 Phase 及原因 / 问题数与假设数 / 建议续接点。
---
## 5. 安全红线与执行约束
### 5.1 安全红线（违反即停并警告）
- 禁止 `rm -rf`、`DROP TABLE`、`truncate`、`chmod 777` 等破坏性命令；
- 禁止 `git push`、`git reset --hard`、`git clean -fdx`；
- 禁止读取 `.env`、`secrets/`、`credentials/`、`.ssh/`、`.git/credentials`、`.git/config`；
- **禁止修改任何业务源码与现有测试文件**（本 Agent 为分析型；编写新测试属于后续人工/开发动作，本 Agent 只产出方案）；写入仅限 `.qa/` 与 `docs/`；
- **执行任何脚本前必须静态审查副作用**（写文件/删数据/网络请求/安装依赖），有破坏性副作用禁止执行；
- 测试执行仅限本地/沙箱/容器环境；**依赖真实外部服务（支付/短信/邮件/第三方 API）的测试默认跳过并标记 `requires_external_service`**，不因跳过而判"失败"；
- 数据库依赖测试仅允许连接本地/容器化测试库；禁止连接任何远程共享库或生产库；
- 安装依赖（如 `npm install`）仅允许在沙箱内进行，且安装前须审查 package scripts 无危险钩子（postinstall/preinstall）；
- 禁止将代码/数据上传到外部服务；禁止执行未审查的第三方脚本（`curl | sh` 等）；
- 测试执行超时：单条 ≤60s，全套 ≤300s，超时中止并记录（阈值可在 `environment.test_timeout` 配置）。
### 5.2 语言约定
- 分析/推理/建议用中文；代码、路径、函数名、报错、日志保持原文；
- 技术术语首次出现附英文原文，如"幂等性（idempotency）"；
- 禁止自动翻译代码注释术语；基准引用的原文保留原文 + 括号内中文翻译。
### 5.3 反幻觉规则
1. 严禁编造文件、函数、API、包名、测试结果——**未执行不得声称"测试通过/失败"**；引用外部工具能力标"需核实"；
2. 严禁把"存在测试文件"当"覆盖有效"——须核查断言与被测对象是否匹配；
3. 无法构造反例的问题，严重度 ≤ P1 且 confidence=low；
4. 每 5 轮自检：问题按"违反哪条规格"归类，无依据主动撤回；
5. 证据推翻前结论必须在 log 显式更正，不许悄悄改口；
6. "业界常识"与"本仓库的做法"严格分开表述；
7. 禁止夸大收益（如"覆盖率从 40% 到 80% 将使故障率下降 50%"）——收益只能定性分级或标"需线上数据验证"；
8. 团队规模/带宽一律标"估算"，不得当硬约束编造精确数字。
---
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
  | 标记 | 示例 | 含义 |
  |---|---|---|
  | skip/todo | `it.skip` / `test.todo` / `@Disabled` / `xit` | 已知未跑 |
  | only 残留 | `it.only` / `fit` / `fdescribe` | 焦点测试未清理 |
  | 空断言 | 测试体无 expect/assert | 假覆盖 |
  | 裸等待 | `sleep()` / `setTimeout` 代替显式等待 | flaky 源 |
  | 注释测试 | 被注释的用例块 | 债务累积 |
  | 门禁缺失 | coverage 配置存在但 CI 未强制 | 度量空转 |
  | 外部依赖 | 测试直连真实第三方 API | 不可重现 |
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
| 改动类型 | 基础人日(默认) | 乘数 | 范围 | 乘数默认 |
|---|---|---|---|---|
| 补单元测试（每模块） | 2 (1-4) | × 逻辑复杂度 | 1-2 | 1.0 |
| 补集成测试 | 3 (2-6) | × 外部依赖数 | 1-2 | 1.5 |
| 补 E2E 冒烟 | 3 (2-5) | × 环境准备复杂度 | 1-3 | 1.5 |
| 修复 flaky 测试 | 1 (0.5-3) | × 根因明确度 | 0.5-2 | 1.0 |
| 引入覆盖率门禁 | 1 (0.5-2) | × CI 平台差异 | 0.5-1.5 | 1.0 |
| 测试数据工厂/基建 | 5 (3-10) | × 数据模型复杂度 | 1-2 | 1.5 |
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
## 9. 知识库沉淀（DONE 后执行）
### 9.1 分流规则
| 内容 | 去向 | 写入方 |
|---|---|---|
| AI Agent 仓库公约（质量红线 + 产物解读） | `AGENTS.md` 草案 → 报告 §14 | 报告草案，人工合入（根目录超出写入范围） |
| 质量知识/长期台账 | `docs/quality.md` | 直接写草案 |
| 方法论术语总表 | `docs/qa-glossary.md` | 直接写草案 |
| 一次性分析过程 | 只留 `.qa/final-report.md` | 不沉淀 |
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
| 触发事件 | 动作 |
|---|---|
| DONE 完成 | 报告 §14 草案 → 按 §9.1 分流合入 → 更新各文件头部"最后同步" |
| 新发现 flaky | 登记 quality.md §7（附 3 次执行结果）|
| 基准条目标"可能已变更" | 人工复核 quality.md §4 对应行 |
| EXTERN_MEM 被人工验证 | 升级 EXTERN（补 URL+日期）→ 移入基线台账，退出 §9 |
| 假设验证完成/被推翻 | 更新 quality.md §8 状态（显式更正，不悄悄改口） |
| state.json 标 CONFLICT | 人工裁决后同步台账 |
---
## 10. 快速参考卡
**公式卡**：`impact = (风险面×w_r)×(故障概率×w_f)×(后果强度×w_s)`；`cost = sqrt(effort_pessimistic)`；`score = impact × confidence_weight / cost`；confidence_weight：高 1.0 / 中 0.7 / 低 0.4；因子量纲 1–5。
**预算卡**：1+5+11+10+8+10+6+1+1+2 = 55。压缩阈值：>20 轮或 >80%；停机：>95%。
**来源卡**：体检表=FACT/RUN；基线表=EXTERN/INFER；风险/gap 可用 BENCH_DEFAULT；ASSUME 只进假设清单；EXTERN_MEM 只进线索区；RUN 与静态 FACT 矛盾以 RUN 为准。
**数字卡**：P0 ≤20%；impact≥150 绝对阈值；P1 兜底 impact≥100；依赖提升 N≥2；flaky=3 次不一致；时间衰减 6 个月；90 天 = 12.86 周；churn 统计窗口 180 天；测试超时 60s/300s；带宽专注系数 0.6–0.8；单改动阈值示例 >3 人日。
=====END FILE ===== */
/* ================================================================
 * 生成 / 拆分 / 校验逻辑（与 pm-agent-generate.cjs 引擎一致）
 * ================================================================ */
const FILE_RE = /=====FILE: (.+?) =====\r?\n([\s\S]*?)\r?\n=====END FILE =====/g
function extractFiles() {
  const self = fs.readFileSync(__filename, 'utf8')
  const files = {}
  let m
  while ((m = FILE_RE.exec(self)) !== null) {
    files[m[1].trim()] = m[2]
  }
  return files
}
/* ---------- 拆分逻辑（--split） ---------- */
const PHASE_SECTIONS = ['6', '7', '8']
const TEMPLATE_SECTIONS = ['9']
const MAIN_SECTIONS = ['0', '1', '2', '3', '4', '5', '10']
const POINTER_BLOCK = [
  '## 6–9 按需加载（references/）',
  '',
  '> 本文件为精简主文件，以下章节已拆分至 references/ 目录，**运行到对应阶段时读取**：',
  '>',
  '> - **§6 Phase 执行手册**（Pre-phase 0 → Phase 6 全流程 + 6.9 只读模式交付规范）→ `references/phases.md`',
  '> - **§7 异常与降级**（四类：a/b 触发中断，c/d 降级继续）→ `references/phases.md`',
  '> - **§8 monorepo / polyrepo 专项** → `references/phases.md`',
  '> - **§9 知识库沉淀模板**（DONE 后产出 docs/ 草案）→ `references/templates.md`',
  '>',
  '> 章节编号在 references 文件中保持原编号；主文件正文中出现的 §6–§9 交叉引用均指向上述文件。',
].join('\n')
function splitSkillBySections(content) {
  const lines = content.split('\n')
  const sections = []
  const preamble = []
  let current = null
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence
    const isBoundary = !inFence && line.startsWith('## ')
    if (isBoundary) {
      if (current) sections.push(current)
      current = { num: (line.match(/^## (\d+)/) || [])[1], body: [line] }
    } else if (current) {
      current.body.push(line)
    } else {
      preamble.push(line)
    }
  }
  if (current) sections.push(current)
  return { preamble: preamble.join('\n'), sections }
}
function buildSplitFiles(skillContent) {
  const { preamble, sections } = splitSkillBySections(skillContent)
  const byNum = {}
  for (const s of sections) byNum[s.num] = s
  const expected = [...MAIN_SECTIONS, ...PHASE_SECTIONS, ...TEMPLATE_SECTIONS]
  const missing = expected.filter(n => !byNum[n])
  if (missing.length) {
    throw new Error(`拆分失败：SKILL.md 缺少章节 ${missing.join('、')}（内容标记可能被改动）。`)
  }
  const refHeader = (title, toc) =>
    `# QA-Agent Skill 参考资料：${title}\n\n`
    + `> 由 qa-agent-generate.cjs --split 自动生成，源为 \`skills/qa-agent/SKILL.md\` 内容块。\n`
    + `> 正文中引用的 §0–§5、§10 规则见主文件 SKILL.md。\n\n${toc}`
  const joinSections = nums =>
    nums.map(n => byNum[n].body.join('\n').trimEnd()).join('\n\n')
  const phases
    = `${refHeader(
      'Phase 执行手册 · 异常与降级 · monorepo/polyrepo（§6–§8）',
      [
        '- §6 Phase 执行手册（Pre-phase 0 → Phase 6 全流程 + 6.9 只读模式交付规范）',
        '- §7 异常与降级（a/b 触发中断，c/d 降级继续）',
        '- §8 monorepo / polyrepo 专项',
      ].join('\n')
    )
    }\n\n${joinSections(PHASE_SECTIONS)}\n`
  const templates
    = `${refHeader(
      '知识库沉淀模板（§9）',
      ['- §9 知识库沉淀（分流规则 + AGENTS.md 质量公约 / quality.md / qa-glossary.md 模板 + 更新触发器）'].join('\n')
    )
    }\n\n${joinSections(TEMPLATE_SECTIONS)}\n`
  const mainParts = [preamble.trimEnd()]
  for (const n of ['0', '1', '2', '3', '4', '5']) {
    mainParts.push(byNum[n].body.join('\n').trimEnd())
  }
  mainParts.push(POINTER_BLOCK)
  mainParts.push(byNum['10'].body.join('\n').trimEnd())
  const main = `${mainParts.join('\n\n')}\n`
  return {
    'skills/qa-agent/SKILL.md': main,
    'skills/qa-agent/references/phases.md': phases,
    'skills/qa-agent/references/templates.md': templates,
  }
}
/* ---------- 校验逻辑（--check） ---------- */
const normalize = s => s.replace(/\r\n/g, '\n').replace(/\s+$/, '')
function checkFiles(target, files, splitMode) {
  console.log(`QA-Agent Skill 校验（${splitMode ? '拆分模式' : '单文件模式'}）｜ 目标目录：${path.resolve(target)}\n`)
  let ok = 0; let diff = 0; let missing = 0
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.resolve(target, rel)
    if (!fs.existsSync(abs)) {
      console.log(`  MISSING  ${rel}`)
      missing++
      continue
    }
    const disk = fs.readFileSync(abs, 'utf8')
    if (normalize(disk) === normalize(content)) {
      console.log(`  OK       ${rel}`)
      ok++
    } else {
      console.log(`  DIFF     ${rel}    （与脚本内置内容不一致）`)
      diff++
    }
  }
  console.log(`\n结果：${ok} OK / ${diff} DIFF / ${missing} MISSING`)
  if (diff + missing > 0) {
    if (!splitMode) {
      const skillPath = path.resolve(target, 'skills/qa-agent/SKILL.md')
      if (fs.existsSync(skillPath)
        && !fs.readFileSync(skillPath, 'utf8').includes('## 6. Phase 执行手册')) {
        console.log('提示：检测到磁盘上的 SKILL.md 为拆分版主文件——请改用 --check --split 校验。')
      }
    }
    console.log(`同步方式：node qa-agent-generate.cjs <目标目录> --force${splitMode ? ' --split' : ''}`)
    process.exit(1)
  }
  console.log('全部一致。')
  process.exit(0)
}
/* ---------- 生成逻辑 ---------- */
function generateFiles(target, files, force, splitMode) {
  console.log(`QA-Agent Skill 生成器（${splitMode ? '拆分模式' : '单文件模式'}）｜ 目标目录：${path.resolve(target)}\n`)
  let created = 0; let skipped = 0
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.resolve(target, rel)
    if (fs.existsSync(abs) && !force) {
      console.log(`  跳过（已存在，加 --force 覆盖）：${rel}`)
      skipped++
      continue
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content.endsWith('\n') ? content : `${content}\n`, 'utf8')
    console.log(`  已生成：${rel}`)
    created++
  }
  console.log(`\n完成：新建 ${created} 个文件${skipped ? `，跳过 ${skipped} 个` : ''}。`)
  console.log('\n下一步：')
  console.log('  1. 阅读 docs/skills-guide.md 了解安装与触发方式（本指南为手工维护文档）')
  console.log('  2. 将 skills/qa-agent/ 整个目录放置到你的 Agent 平台技能目录')
  if (splitMode) {
    console.log('     （拆分版：SKILL.md 为主文件，references/ 由 Agent 运行到对应阶段时按需读取）')
  }
  console.log('  3. 用"评估这个仓库的测试现状"或平台显式命令触发运行')
  console.log(`  4. 团队同步检查：node qa-agent-generate.cjs <目标目录> --check${splitMode ? ' --split' : ''}`)
}
function main() {
  const args = process.argv.slice(2)
  const force = args.includes('--force') || args.includes('-f')
  const splitMode = args.includes('--split')
  const checkMode = args.includes('--check')
  const target = args.find(a => !a.startsWith('-')) || '.'
  let files = extractFiles()
  if (Object.keys(files).length === 0) {
    console.error('错误：未在脚本中解析到任何文件内容块（内容标记可能损坏）。')
    process.exit(1)
  }
  try {
    if (splitMode) {
      files = buildSplitFiles(files['skills/qa-agent/SKILL.md'])
    }
  } catch (e) {
    console.error(`错误：${e.message}`)
    process.exit(1)
  }
  if (checkMode) checkFiles(target, files, splitMode)
  else generateFiles(target, files, force, splitMode)
}
main()
