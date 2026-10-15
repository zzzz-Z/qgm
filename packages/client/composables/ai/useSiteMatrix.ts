// [multi-site-matrix-v1] 工作区 × 站点矩阵数据面（中间层）。
// [WHY] AiWindowList 需显示「每工作区绑定站点 + 窗口状态」，但架构守卫
//   （ai-window-sid-wiring.node-test.ts）禁止面板直接耦合站点窗口表
//   （useAiWindowTable / winSidOf）。此 composable 收敛该耦合，面板只消费本模块。
// [CONSTRAINT] 依赖方向：面板 → useSiteMatrix → useAiWindowTable/useAiWindow；不反向。
import { computed, ref } from 'vue'
import { getWindowBySidImpl, isWindowMarkedOpened, probeWindowBySid, windowsTick } from './useAiWindowTable'
import { useAiWindow } from './useAiWindow'
import { modelIdFromSid, MODELS, sidForUrl } from './useAiSite'

/** 单个工作区的矩阵视图数据 */
export interface WorkspaceMatrixItem {
  siteId: string
  siteLabel: string
  winOpen: boolean
}

/** 组合式：工作区站点矩阵数据面（模块级共享状态） */
export function useSiteMatrix() {
  const sessionByWs = ref<Record<string, { url: string, sessionId: string }>>({})

  // [multi-site-matrix-v1] windowsTick 作响应式信号：窗口开关时自动重算
  const openSids = computed(() => {
    void windowsTick.value
    const wins: Array<{ sid: string, url: string }> = useAiWindow().listWindows()
    return new Set(wins.map(w => w.sid))
  })

  /** 批量拉取所有工作区的会话绑定（单请求，非按 ws 循环） */
  async function loadAllSessions(): Promise<void> {
    try {
      const r = await fetch('/__ai/workspace/session')
      if (!r.ok) return
      const j = await r.json().catch(() => null) as { sessions?: Record<string, { url?: string, sessionId?: string }> } | null
      const out: Record<string, { url: string, sessionId: string }> = {}
      for (const [wid, s] of Object.entries(j?.sessions || {})) {
        if (s && typeof s.url === 'string') out[wid] = { url: s.url, sessionId: String(s.sessionId || '') }
      }
      sessionByWs.value = out
      // [win-opened-restore-v1] 刷新后 windowTable 内存清空，「● 已开窗」标记会全丢。
      //   sessionStorage 里的标记还在，此时按 sid 探测一次把引用写回表；windowsTick 自动重算 openSids。
      recoverMarkedWindows(Object.values(out).map(s => sidForUrl(s.url)))
    } catch { /* 服务端不可达：矩阵降级为「站点未知」 */ }
  }

  /**
   * [win-opened-restore-v1] 对「有已开窗标记但内存引用缺失」的 sid 触发一次探测恢复。
   * [WHY] probeWindowBySid 命中真实窗口时写回 windowTable 并保留标记；未命中则新开空白页立即 close 并清标记。
   * [CONSTRAINT] 只对**已标记**的 sid 探测：未标记的 sid 探测会新开空白页（无差别探测 = 弹窗噪音）。
   */
  function recoverMarkedWindows(sids: string[]): void {
    for (const sid of sids) {
      if (!sid) continue
      if (getWindowBySidImpl(sid)) continue
      if (isWindowMarkedOpened(sid)) probeWindowBySid(sid)
    }
  }

  /** 取某工作区的矩阵数据（站点名 + 窗口是否打开） */
  function matrixFor(wsId: string): WorkspaceMatrixItem {
    const sess = sessionByWs.value[wsId]
    const siteId = sess?.url ? modelIdFromSid(sidForUrl(sess.url)) : ''
    const sid = siteId ? `win_${siteId}` : ''
    return {
      siteId,
      siteLabel: siteId ? (MODELS.find(m => m.id === siteId)?.label || siteId) : '',
      winOpen: sid ? openSids.value.has(sid) : false,
    }
  }

  return { sessionByWs, openSids, loadAllSessions, matrixFor }
}
