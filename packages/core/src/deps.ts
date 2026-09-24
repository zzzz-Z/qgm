// @env node
// src/deps.ts —— Route 层依赖聚合入口（HCLC 第7章：单文件 import 数 ≤ 5）

// 环境元数据

export { type Change, getRoot, SCRIPTS_DIR } from './config.js'

// Git
export { gitCommitAfter, gitSnapshot } from './git.js'

// 冒烟测试
export { runSmoke, type SmokeResult } from './headless/smoke.js'

// 运行后处理
export {
  applyOverlay,
  checkScriptSyntax,
  type ClaimMismatch,
  extractErrorFiles,
  hasEslint,
  hashRules,
  type LintResult,
  parseClaimed,
  parseDecisionMarkers,
  parseScriptMeta,
  pickLintTargets,
  pickTscTargets,
  readOverlayChanges,
  readToolLogWithRetry,
  runEslint,
  runScript,
  runTests,
  runTsc,
  splitShebang,
} from './post-run/index.js'

// 运行辅助（纯计算）
export {
  type ComplianceFlags,
  computeClaimMismatch,
  computeCompliance,
} from './post-run/run-helpers.js'

// 进程执行
export {
  BASH_TIMEOUT_MS,
  buildEnvWhitelist,
  checkBashBlacklist,
  runProcess,
} from './process/index.js'

// HTTP 辅助
export {
  type IncomingMessage,
  parseJSON,
  readBody,
  sendJSON,
  type ServerResponse,
} from './server/http.js'

// 状态快照
export {
  diffMeta,
  ensureDirs,
  gcSnapshots,
  runDir,
  saveSnapshot,
  scanMeta,
  snapshot,
  writeRunLog,
} from './state/snapshot.js'

// 工具
export {
  fingerprintErrors,
  saveIndex,
  scanIndex,
} from './utils/index.js'
