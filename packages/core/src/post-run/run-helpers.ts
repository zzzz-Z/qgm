// [run-helpers] /run 路由用到的纯计算逻辑（无副作用、无 IO）
import type { ClaimMismatch } from './types.js'

/** 规则遵守度静态特征（供 compliance 报告） */

/** 合规检查标志位集合 */
export interface ComplianceFlags {
  hasDesc: boolean
  hasSelfCheck: boolean
  isDecision: boolean
}

/** 从脚本原文与 desc 静态推断合规特征 */

/**
 * 统计脚本的合规性标志（用于合规反馈与统计）
 * [WHY] SYSTEM.md 要求脚本必须有 @desc、自带断言、决策走专有标记；此处正则粗判供 UI 展示
 * [CONSTRAINT] 判定基于正则匹配而非 AST，存在极少数误判；仅作提示不阻断执行
 * [CHANGE-IMPACT] 结果写入 compliance.jsonl；聚合统计会受影响
 * @param effectiveScript 补 shebang 后的脚本原文
 * @param desc 已解析出的 @desc 值（空串表示未声明）
 */
export function computeCompliance(effectiveScript: string, desc: string): ComplianceFlags {
  return {
    hasDesc: desc.length > 0,
    hasSelfCheck: /__AI__\.assert|\.assert\(|process\.exit\(1\)/.test(effectiveScript),
    isDecision: /__AI__\.exitNeedInput|__AI_RUNNER_DECISION__/.test(effectiveScript),
  }
}

/** claimed vs actual 差异（claim 缺失/多余） */
export function computeClaimMismatch(claimed: string[] | null, actual: { path: string }[]): ClaimMismatch | null {
  if (!claimed) return null
  const actualPaths = actual.map(c => c.path)
  const claimedSet = new Set(claimed)
  const actualSet = new Set(actualPaths)
  const missing = claimed.filter(p => !actualSet.has(p))
  const extra = actualPaths.filter(p => !claimedSet.has(p))
  return { claimed, actual: actualPaths, missing, extra }
}
