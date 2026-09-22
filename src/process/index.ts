// process barrel — 收敛下游 imports（HCLC 第7章）

export { BASH_TIMEOUT_MS, buildEnvWhitelist, checkBashBlacklist } from './bash-guard.js'
export { detectPackageManager, runProcess } from './proc.js'

export type { ProcessResult, RunProcessOptions } from './proc.js'
