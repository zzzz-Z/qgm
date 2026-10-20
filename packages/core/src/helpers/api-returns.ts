// [api-return-shape-v1] __AI__ 易错 API 的返回形状契约（**并集**：成功与失败分支的键都算）。
// [WHY] 台账反复记录同类事故：凭记忆写 `r.code` / 以为 syntaxCheck 返回布尔 / 找 shell.exit。
//   形状漂移（加字段、改名、去字段）会让依赖它的脚本静默判错。
// [CONSTRAINT] 契约值来自**源码取证**而非单次探针：syntaxCheck 成功只回 {ok}，
//   但失败分支回 {ok, error, hint?} / {ok, code, error, hint} —— 只探一次会漏掉半个形状。
//   可选字段用 ? 标注，对账时按「子集包含」判定。
export const API_RETURNS = {
  exec: ['ok', 'stdout', 'stderr', 'code', 'hint?'],
  shell: ['ok', 'stdout', 'stderr', 'code', 'hint?'],
  syntaxCheck: ['ok', 'error?', 'code?', 'hint?'],
} as const

export type ApiReturnName = keyof typeof API_RETURNS
