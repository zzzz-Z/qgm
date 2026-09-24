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
 * 计算 Compliance
 * @param effectiveScript - effective Script
 * @param desc - desc
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
