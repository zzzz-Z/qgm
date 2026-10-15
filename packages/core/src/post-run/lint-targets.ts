// AIRUNNER-BATCH10-4-SPLIT-LINT: 从 lint.ts 抽出的纯函数（pickLintTargets + 常量）；无外部依赖
import path from 'node:path'

/** 文件变更类型：新增 / 修改 / 删除 */
export type ChangeType = 'added' | 'modified' | 'deleted'
/** 单个文件变更记录：类型、路径、差异内容 */
export interface Change {
  path: string
  type: ChangeType
  afterLines?: number
}

/**
 * lint 时纳入的源文件扩展名集合
 * [lint-targets-md-v1] 2026-10-05 加入 `.md` —— 这是 D11「并发写手」根本形态的结构性修复。
 * [WHY] `/run` 落盘后本来就会对**本次变更文件**跑 `eslint --fix`（`routes/run.ts`），
 *   但原集合不含 `.md` ⇒ 「写 markdown 的 agent 不跑 lint 就落盘」这条路径上**没有任何机制接住**：
 *   未对齐的表格会一直留在盘上，直到**第三方**跑全量 `pnpm lint` 才炸 ——
 *   把别人的提交闸门变成移动靶（实测同一小时内复发三次，第三次正好打红正在跑的 `pnpm verify`）。
 *   `.md` 入集合后，写入方无需知道 lint 的存在，落盘即被机械修复。
 * [CONSTRAINT] `--fix` 只作用于**本次变更的文件**（定向），不是全仓 ——
 *   全仓 `eslint --fix` 会重写 headless-inject 的内联正则（AGENTS.md 明令禁止）。
 * [EVIDENCE] 亲跑：把 `docs/defect-review-verification.md` §一 判定表的一行压窄 →
 *   `format/prettier` error（exit 1）；同一文件 `--fix` 后与压窄前原文**逐字节一致**
 *   （`diff -q` 无输出）。即「修复只动格式、不动语义」这个前提已实测成立。
 */
export const LINT_EXTS = new Set(['.ts', '.tsx', '.vue', '.js', '.jsx', '.mjs', '.cjs', '.md'])

/**
 * 路径段命中这些目录的文件**不**传给 eslint。
 * [WHY] 它们要么已被 `eslint.config.ts` 的 `ignores` 排除，要么本就不该被格式修复。
 *   显式传入 ignored 文件时 eslint 只打印
 *   `File ignored because of a matching ignore pattern` 告警并以 exit 0 结束 ——
 *   无害但纯噪声，且会让 `lint.ok` 的语义（「本次变更的代码是否 lint 干净」）变模糊。
 * [CONSTRAINT] 按**路径段**匹配而非前缀，`packages/client/test-results/error-context.md` 这类
 *   嵌套路径必须同样命中（P3 报告里它曾是 `git status` 的常客）。
 *   故意**不**排除点目录：`.github/*.md` 是应当被 lint 的正文文档。
 * [CHANGE-IMPACT] 本集合必须与 eslint 的忽略集保持一致；由
 *   `post-run-lint-targets.node-test.ts` 的「与 eslint.config.ts 的 ignores 不漂移」用例守卫。
 * [BOUNDARY] 但 eslint 的忽略集有**两层**：`eslint.config.ts` 的显式 `ignores`，**加上**
 *   `@antfu/eslint-config` 默认读入的 `.gitignore`。本集合只覆盖了前者 —— 那条守卫也只解析
 *   显式数组（仓库里没有 .gitignore 解析器），所以它对第二层是**盲**的。
 *   已知漏网：`docs/plan/**`。2026-10-05 复核方实测：`eslint docs/plan/__lint-probe.md`
 *   → `File ignored because of a matching ignore pattern`（exit 0），即 eslint 侧确实忽略它；
 *   但本集合不含 `docs/plan` ⇒ `pickLintTargets` 会把它当目标返回，白传一次。
 *   **危害 = 每个草稿文件多一条 warning、`lint.ok` 语义略模糊，无失败、无破坏。**
 *   之所以不修：本集合按**路径段**匹配，表达不了 `docs/plan/**`（段名 `plan` 太泛 ——
 *   加进去会让任何包底下名为 plan 的目录一起被跳过）。根治要把判定升级成
 *   「段集合 + 路径前缀集合」两个，当前收益不足以抵这次改动。
 * [GOTCHA] 本注释块内**不得**出现「星号紧跟斜杠」的字符序列（例如用来举例的
 *   「packages 通配目录 / plan」路径）：它会**提前闭合块注释**，后半段注释被当成代码解析
 *   ⇒ `error TS2304: Cannot find name 'plan'`。2026-10-05 实测踩过一次。
 */
const LINT_SKIP_SEGMENTS = new Set(['.ai-runner', 'node_modules', 'dist', 'coverage', 'test-results', 'playwright-report', 'skills'])

/**
 * 路径中是否含被跳过的目录段
 * @param p - 仓库相对路径
 */
function hasSkippedSegment(p: string): boolean {
  return p.split(/[\\/]/).some(seg => LINT_SKIP_SEGMENTS.has(seg))
}

/**
 * 从变更列表中挑出需要跑 eslint 的源文件
 * [WHY] 全量 eslint 慢；只对变更文件跑可显著提速
 * [CONSTRAINT] 排除 deleted；只留 LINT_EXTS 命中的扩展名；跳过 eslint 已忽略的目录
 * [CHANGE-IMPACT] 结果被 run.ts 传给 runEslint（带 `--fix`）；与 pickTscTargets 复用同一 changes 输入
 * @param changes 本轮检测到的变更列表
 */
export function pickLintTargets(changes: Change[]): string[] {
  return changes
    .filter(c => c.type !== 'deleted')
    .map(c => c.path)
    .filter(p => LINT_EXTS.has(path.extname(p).toLowerCase()))
    .filter(p => !hasSkippedSegment(p))
}

/** 供守卫测试断言「跳过集合与 eslint ignores 不漂移」 */
export { LINT_SKIP_SEGMENTS }
