// @env node
// src/deps.ts —— Route 层依赖聚合入口（HCLC §4：单文件 import 数 ≤ 5）

// 环境元数据

export { type Change, getRoot, getWorkspace, SCRIPTS_DIR } from './config.js'

// Git
export { gitCommitAfter, gitSnapshot } from './git.js'

// 验证目标自动发现（宿主 + 业务 app 多目标）
export { discoverTargets, type VerifyTarget } from './headless/discover-targets.js'

// 冒烟测试
export { runSmoke, runSmokeTargets, type SmokeResult } from './headless/smoke.js'

// [hclc-fix] run.ts 直 import ai-guard.js 使该文件唯一 import 达 9（>8 阻断）；
// scanScriptHead 上提至 barrel，令所有 route 层调用方统一从 deps 入口引入
export { scanScriptHead } from './post-run/ai-guard.js'

// 运行后处理
export {
  applyOverlay,
  checkScriptSyntax,
  type ClaimMismatch,
  extractErrorFiles,
  hasEslint,
  hashRules,
  type LintResult,
  measureScriptSize,
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
  type ScriptSize,
  splitShebang,
} from './post-run/index.js'

// 运行辅助（纯计算）
export {
  type ComplianceFlags,
  computeClaimMismatch,
  computeCompliance,
  pickDeadLetterWrites,
} from './post-run/run-compliance.js'

// 进程执行
export {
  BASH_TIMEOUT_MS,
  buildEnvWhitelist,
  checkBashBlacklist,
  runProcess,
} from './process/index.js'

// [hclc-fix] 控制面留痕（见 routes/control-log.ts）
//   run.ts 直 import `./control-log.js` 会使该文件唯一模块数回到 9（>8 阻断）——
//   run.ts 本就是 route 层模块数最紧的文件，新增任何直连依赖都会顶格。
//   与 scanScriptHead 同理：上提 barrel，令 routes/ 调用方统一从 deps 入口引入。
export { buildBoardEntry, buildRejectEntry } from './routes/control-log.js'

// [reject-breaker-v1] 前置拒收熔断器（见 routes/reject-breaker.ts）
export { type BreakerVerdict, recordReject, REJECT_BREAKER_MAX, resetRejectStreak } from './routes/reject-breaker.js'

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
  reapStaleTmp,
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
  saveIndexBefore,
  scanIndex,
} from './utils/index.js'

// [multi-workspace-v1] 工作区作用域（ALS）：/run 请求级 root 隔离
//   run.ts 直 import 会使该文件模块数达 9（>8 阻断），与 scanScriptHead 同理走 barrel
export { runWithWorkspace } from './workspace-scope.js'
