// [api-return-shape-v1] __AI__ 易错 API 的返回形状契约（**并集**：成功与失败分支的键都算）。
// [WHY] 台账反复记录同类事故：凭记忆写 `r.code` / 以为 syntaxCheck 返回布尔 / 找 shell.exit。
//   形状漂移（加字段、改名、去字段）会让依赖它的脚本静默判错。
// [CONSTRAINT] 契约值来自**源码取证**而非单次探针：syntaxCheck 成功只回 {ok}，
//   但失败分支回 {ok, error, hint?} / {ok, code, error, hint} —— 只探一次会漏掉半个形状。
//   可选字段用 ? 标注，对账时按「子集包含」判定。
export const API_RETURNS = {
  exec: ['ok', 'stdout', 'stderr', 'code', 'hint?'],
  shell: ['ok', 'stdout', 'stderr', 'code', 'hint?'],
  syntaxCheck: ['ok', 'error?', 'code?', 'hint?', 'capability?'],
} as const

// [api-async-contract-v1] 异步族契约：**返回 Promise，调用方必须 await**。
// [WHY] 门面用箭头函数包 async（如 `status: opts => gitApi.status(...)`），
//   `constructor.name === 'Function'` 与同步方法完全同形 —— 漏 await 不报错，静默得 undefined。
// [CONSTRAINT] 名单必须与实测 thenable **双向**一致（T8 守卫），新增 API 漏登记即红。
export const API_ASYNC = {
  'git.status': true,
  'git.recent': true,
  'shell': true,
  'exec': true,
  'grep': true,
  'walk': true,
  'readFiles': true,
  'probe': true,
  'testRun': true,
  'topFreq': true,
  'lint': true,
  'typeCheck': true,
  'findDefinition': true,
  'findReferences': true,
  'affectedTests': true,
  'reflect': true,
  'lessons.match': true,
  'lessons.distill': true,
  'session.create': true,
  'session.frame': true,
  'session.close': true,
  'subagent.submit': true,
  'subagent.get': true,
  'subagent.list': true,
  'subagent.cancel': true,
  'browser.run': true,
  'tasks.list': true,
  'tasks.push': true,
  'tasks.start': true,
  'tasks.complete': true,
  'tasks.fail': true,
} as const

// [api-error-codes-v1] 失败分支的 code 取值域（H3）。
// [WHY] 调用方若不知道某 API 会回哪些 code，`r.code === 'X'` 在别的 API 上恒 false。
// [CONSTRAINT] capability 为 true 表示「能力边界」而非真失败（H9），不得进入重试预算。
export const API_ERROR_CODES = {
  syntaxCheck: { codes: ['UNSUPPORTED_LANG'], capability: ['UNSUPPORTED_LANG'] },
} as const

// [api-signature-mode-v1] 参数形态契约（H8）：positional 与 object 混用是高频踩坑点。
export const API_SIGNATURE = {
  patchFile: { mode: 'positional', arity: 4 },
  replaceInFile: { mode: 'object', arity: 2 },
  okJson: { mode: 'positional', arity: 2 },
} as const

export type ApiReturnName = keyof typeof API_RETURNS
export type ApiAsyncName = keyof typeof API_ASYNC
