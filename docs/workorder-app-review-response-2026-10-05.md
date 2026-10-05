# 工单 WO-20261005-02 · 复核判决响应（给应用端）

> **本件路径**：`docs/workorder-app-review-response-2026-10-05.md`。
> 不要再往 `docs/plan/` 找 —— 该目录整目录被 `.gitignore` 忽略，且 `docs:verify` 对它显式豁免，
> 放进去等于没派发（已登记为铁律）。
>
> **上游**：`docs/review-verdict-2026-10-05.md` —— 宿主侧对你在 WO-20261005 交付的 `DONE` 的逐条判决。
> **派发方**：宿主侧（A 侧复核方）。**执行方**：应用端。
> **前提**：判决判为「属实」的六段结论**无需重做**。本工单只处理判决 §二 的 2 项「不符」，
> 外加一项留痕义务（段三）。

## 背景：裁判结论一句话

WO-20261005 六段主体属实（三处勘误数字经独立复核全部正确；你自设计的 M3 变异被宿主侧独立复现：
红 → 还原复绿；`5175` 产物早于源码却行为等价这条判定也成立，且宿主侧给出的证据比探针更硬 ——
重编译后产物 sha256 仍 `74da6383…`、与 19:16 逐字节一致）。

但有两处需要你处理，都是**「说的」与「磁盘上的」不一致**，而不是技术判断错。

## 段一：澄清或纠正 2.1 —— 声称的「删除 lessons 近重复残留」在磁盘上没有发生（必做）

`DONE` 的「变更文件」表写：`.ai-runner/lessons.md`「删除『配置修复与数据修复是两件事』近重复残留
（并入既有 SSOT 条），修复 lessons-hygiene 守卫」。宿主侧实测三条事实：

- `git diff --numstat .ai-runner/lessons.md` → **`49  0`**：49 行新增、**0 行删除**；
- 你引用的那句「（同族条目…已于 2026-10-05 治理时并入本条）」在 **HEAD 中已存在**（第 540 行），
  不是本轮产物 —— 你引用的对象早已不是独立条目；
- 台账计数侧证「只增不删」：新增 4 条 `##` 后 total 由 77 变 81。

**二选一，不接受含糊**：

- **A. 补可复现证据**：改动前后的 `wc -l`、`git diff --numstat`、以及「守卫曾经红」的原始输出。
  三样缺一不可 —— 只有「现在绿」不算修复证据。
- **B. 改掉描述**：把该条改成与磁盘一致的说法（例如「本轮只新增 4 条台账条目，未删除任何条目」）。

`[WHY]` 本工单要治的正是「自述代替证据」。**「修复了某守卫」这类结论必须有失败 → 通过的原始输出**，
否则与你批评过的「只看绿灯」是同一件事 —— 不能在你自己的交付里复发。

## 段二：复核宿主侧对 2.2 的改写是否准确（必做）

你在台账新入的条目「`docs/plan/**` 在 `.gitignore` 里但**不在** eslint `ignores` 里」被实测推翻：
`node node_modules/eslint/bin/eslint.js docs/plan/__lint-probe.md` →
`File ignored because of a matching ignore pattern`（exit 0）⇒ 它**在**忽略范围内。
`eslint.config.ts` 的显式 `ignores` 只是**一层**，另一层是 `@antfu/eslint-config` 默认读入的 `.gitignore`。

宿主侧已代为处置（判决 §三）：

- 该条已标 `[REJECTED]`，并补了正确归因（两层来源、两个方向、守卫缺口各写明）；
- `packages/core/src/post-run/lint-targets.ts` 新增 `[BOUNDARY]` 段，把 `docs/plan/**` 登记为已知边界，
  并写明**不修的理由**：该集合按**路径段**匹配，段名 `plan` 太泛（加进去会误伤 `packages/*/plan/**`），
  根治需把判定升级为「段集合 + 路径前缀集合」两个，当前收益不抵改动。

**要求**：

1. 读 `.ai-runner/lessons.md` 中该条现文 + `lint-targets.ts` 的 `[BOUNDARY]` 段，逐句核对。
2. 给三选一结论：**准确** / **不准确**（带原始输出反驳）/ **部分不准确**（指出是哪一句）。
3. 自己跑一条**能推翻它的命令**（例如对 `docs/plan/` 下的 md 定向 lint、或 `--print-config`），
   附原始输出。没有原始输出的「实测」不许写进报告。

**注意范围**：你报告正文的 §十二 段一「反例」段其实**写对了** —— 它说的是「不在
`LINT_SKIP_SEGMENTS` 里」，没说错。错的只有你塞进台账的那条**标题与归因**。
不要为了迎合本工单去改一段本来正确的文字。

## 段三：报告留痕（必做）

`docs/defect-review-verification.md` 目前只反映你自己的视角，读者看不到复核判决。要求：

1. §十二 段一「反例」段（`:243-248`）补一句机制说明：`docs/plan/**` 对 eslint 之所以是「ignored」，
   来自**两层来源**（`eslint.config.ts` 的显式数组 + `@antfu/eslint-config` 默认读入的 `.gitignore`），
   而非仅前者；并指向 `lint-targets.ts` 的 `[BOUNDARY]`。
2. 新增一节（或并入 §十二）：登记「台账该条已标 `[REJECTED]`、归因已由宿主侧更正」，
   以及段一 2.1 的最终澄清结果。**引用宿主侧判决时给出路径与结论，不要复述成你的结论。**
3. **不要改动 §一～§十一 的既有结论**（已核过），只做补充。

## 段四：边界与不做清单

- **D8 仍挂账**，不许开闸 —— 判决已认可你「属新功能」的判定（依据 `bin/check-status.cjs:105-106`）。
- **不要改** `packages/core/src/post-run/lint-targets.ts` 的实现；`[BOUNDARY]` 的「不修」已判定。
- **不要替宿主侧提交 git**（方案 C：AI 改动不自行 commit，主分支只在用户显式 commit 时前进）。
- **不要把工单或报告放进 `docs/plan/`** —— 整目录被 `.gitignore:51` 覆盖 + `docs:verify` 显式豁免。
- **审查类文档不要用 markdown 表格**（本工单也遵守）。交付 md 前先跑
  `npx eslint <file> --fix`，再跑 `npx eslint <file>` 确认 0 error。

## 段五：完成标准

- 段一：A 或 B 之一落地且可复现；
- 段二：三选一结论 + 亲跑原始输出（含一条可能推翻它的命令）；
- 段三：报告有留痕；`npx eslint docs/defect-review-verification.md` → 0 error；
  `node scripts/verify-docs-index.cjs` → 通过（篇数以脚本输出为准，本工单入索引后应为 17 篇）；
- 附 `npx vitest run --config vitest.config.ts` 的原始输出（改 md 不触发代码测试，但请照附）。
- **若要跑完整 `pnpm verify`**：不要在 `/run` 里跑 —— 实测全链 1m16s / 1m39s / 1m42s，
  远超沙箱 60s 硬超时。走 bash 直执行通道，或拆成 `lint` + `test:unit` 分别跑。

## 段六：宿主侧当前状态（供你对账，勿复述为你的结论）

- `pnpm verify`：`Test Files 130 passed (130)` / `Tests 1244 passed (1244)`，lint 0 error / 85 warning；
- `bin/check-status.cjs`：`✓ 阶段 0 - 3.2 产物到位，阶段 4 观察期就绪`（exit 0）；
- 台账：81 条 / 待复核 13（16.0%，低于 30% 上限）；
- `5175` 实例：产物 mtime 晚于源码 mtime，首页与静态资源全 200。

## 段七：回报格式

`DONE` + 逐段结果（段一/二/三各自「做了什么 + 原始输出 + 结论」）+ 未做项与理由。
**没有原始输出的「实测」不许写进回报**；未跑完的项必须显式写「未跑完」，不要写成绿。
