// [run-helpers] /run 路由用到的纯计算逻辑（无副作用、无 IO）
import type { ClaimMismatch } from './types.js'
import type { VerifyTarget } from '../headless/discover-targets.js'

/** 规则遵守度静态特征（供 compliance 报告） */

/** 合规检查标志位集合 */
export interface ComplianceFlags {
  hasDesc: boolean
  hasSelfCheck: boolean
  /**
   * [real-selfcheck-observe-v1] verify-contract-v1 判据：脚本是否调用 syntaxCheck / typeCheck
   * [WHY] 旧 hasSelfCheck 判 assert/exit(1)，与 SYSTEM.md 定义不符；此字段前向观测真实命中率
   * [CONSTRAINT] 仅采集不闸门（观测期）；命中率达标后再评估是否接入 DONE 拒收
   */
  hasRealSelfCheck: boolean
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
    // [real-selfcheck-observe-v1] 兼容 __AI__.syntaxCheck(...) 与解构后裸调用（含空行前后缀不误判）
    // [verify-lang-matrix-v1] lint 计入自检：TS/Vue/ESM 场景下项目内 eslint 才是有效校验手段，
    //   只认 syntaxCheck/typeCheck 会把「正确地用了 lint」判成没自检，逼 AI 去调能力外的 syntaxCheck。
    hasRealSelfCheck: /__AI__\.(?:syntaxCheck|typeCheck|lint)\b|(?:^|[^\w.])(?:syntaxCheck|typeCheck|lint)\(/.test(effectiveScript),
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

/**
 * 冒烟报告合规：DONE 文本是否引用了自动发现的业务 app 目标。
 * [WHY] 原 bug：agent 只验宿主 5175/__ai/，把「宿主健康」当「业务 app 已验证」写进 DONE。
 *   这里把自动发现到的 app 目标拉出来，若 DONE 一个都没提到 → 视为漏验（降级可见，不拒收）。
 * [CONSTRAINT] fail-open：只打 [warn] 计入 degraded，绝不把正常 DONE 判 fail（否则熔断）。
 *   宿主目标（source='host'）不查——它本就由宿主巡检覆盖。
 * @returns null 无 app 目标可查；否则 { ok:true, missing: 未被引用的目标 }
 */
export function computeSmokeReportCompliance(doneText: string, targets: VerifyTarget[]): { ok: true, missing: VerifyTarget[] } | null {
  const appTargets = targets.filter(t => t.source !== 'host')
  if (appTargets.length === 0) return null
  const missing = appTargets.filter((t) => {
    const port = t.url.replace(/^https?:\/\/127\.0\.0\.1:/, '').replace(/\/$/, '')
    return !doneText.includes(t.tag) && !doneText.includes(port) && !doneText.includes(t.url)
  })
  return { ok: true, missing }
}

/**
 * [delivery-routing-v1] 交付路由校验：识别写进死信槽的交付物。
 * [WHY] `.ai-runner/` 是 git 忽略区——写进那里等于永远不进仓库、不被 review、
 *   不被后续会话读到。分析/评估类任务结论若落在那里，是一次静默的交付路由错误。
 * [CONSTRAINT] 仅采集不拒收：纯读 changes 列表，不引入新启发式；触发后由调用方 emit 软告警。
 * @param paths 待筛查的路径列表（通常为 claimMismatch.extra：实际写但未声明）
 * @returns 命中的相对路径（去重、最多 10 条）；无命中返回空数组
 */
export function pickDeadLetterWrites(paths: string[]): string[] {
  const hits = new Set<string>()
  for (const raw of paths) {
    const p = String(raw || '')
    if (p.startsWith('.ai-runner/')) hits.add(p)
    if (hits.size >= 10) break
  }
  return [...hits]
}
