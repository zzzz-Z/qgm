// process barrel — 收敛下游 imports（HCLC §4）

export { BASH_TIMEOUT_MS, buildEnvWhitelist, checkBashBlacklist } from './bash-guard.js'
// [bash-whitelist-wire-v1]
export { BASH_WHITELIST_CMDS, checkBashWhitelist } from './bash-guard.js'
export { detectPackageManager, runProcess } from './proc.js'

export type { ProcessResult, RunProcessOptions } from './proc.js'
