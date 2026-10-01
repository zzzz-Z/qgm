// post-run barrel — 收敛下游 imports（HCLC §4）

export { injectAiJsdoc, scanNativeApis } from './ai-guard.js' // [ai-guard-v1]
export type { ScanResult } from './ai-guard.js'

export { clearRulesHashCache, hashRules } from './compliance.js'
export { parseDecisionMarkers } from './decision.js'
export type { DecisionMarkers, DecisionOption, DecisionPayload } from './decision.js'
export { extractErrorFiles } from './error-files.js'
export { hasEslint, pickLintTargets, runEslint } from './lint.js'
export { applyOverlay, readOverlayChanges } from './overlay.js'
// [run-compliance] /run 合规校验辅助
export { type ComplianceFlags, computeClaimMismatch, computeCompliance } from './run-compliance.js'
export { runScript } from './run-script.js'
export type { RunResult } from './run-script.js'
export { checkScriptSyntax } from './script-check.js'
export { parseClaimed, parseScriptMeta } from './script-meta.js'
export type { ScriptMeta } from './script-meta.js'
export { splitShebang } from './shebang.js'
export type { ShebangSplit } from './shebang.js'
export { runTests } from './test.js'

export { readToolLogWithRetry } from './tool-log.js'

export { pickTscTargets, runTsc } from './tsc.js'
export type { ClaimMismatch, LintResult } from './types.js'
