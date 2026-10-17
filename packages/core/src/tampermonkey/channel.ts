// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] 本文件是 IIFE 的物理切分片段，不是独立模块：
//   跨片段符号（其它片段定义的函数与类型）在单文件 tsc 检查下不可见，
//   且片段内存在顶层 return 等非模块语法。
// [CONSTRAINT] 全部片段 TS 化完成后，按「拼回后的联合视图」统一接线并移除此 pragma——
//   现在移除会让每次增量检查都失败，掩盖真实类型错误。
/**
 * [tampermonkey-ts-rewrite-v1] 消息通道 —— 外发缓冲、断链队列、fill 回执。
 * 对应原 .js 片段 channel.js（156 行）。逻辑逐字等价，仅补类型与「为什么」注释。
 *
 * [WHY] 用户脚本与工作台之间仅靠 postMessage 通信。opener 未就绪 / 弹窗刚关的那一瞬
 *   消息不能丢——重连后必须能补发，否则出现「脚本跑了但工作台不知道」的静默失败。
 * [CONSTRAINT] 依赖其它片段的符号（extractSidFromHash 等），拼回 IIFE 后才可见；
 *   本目录已被 tsconfig exclude，独立检查不适用。
 */

// [replay-buf] 缓存最近 N 条外发消息，供刷新后重放
const _msgBuf: OutboundEnvelope[] = []
const _MSG_BUF_MAX = 50

// [c1-bridge-v1] 消息去重（msgId）+ 断链队列 + 定期 drain
let _msgSeq = 0

// [fill-dedup-v1] 入站 fill/rotate 去重，防止 postMessage 重试 / 多窗口重复消费
const _seenInbound: Set<string> = new Set()
const _pending: OutboundEnvelope[] = []
const _PENDING_MAX = 200

/** 单调递增的消息 ID（时间戳 + 序号）；不用 UUID 是为了可读、可按到达序排 */
function _nextMsgId(): string {
  _msgSeq = (_msgSeq + 1) >>> 0
  return `${Date.now().toString(36)}-${_msgSeq.toString(36)}`
}

/** 若 opener 就绪则立即发送；否则返回 false，由 post() 入断链队列 */
function _trySend(p: OutboundEnvelope): boolean {
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(p, '*')
      return true
    }
  } catch { /* opener 跨源受限时 postMessage 抛异常，视同未送达 */ }
  return false
}

/** 外发消息：补齐 msgId/ts，进重放缓冲，尽力即刻送达，失败则入断链队列 */
function post(payload: OutboundEnvelope): void {
  if (!payload || typeof payload !== 'object') return
  if (!payload.msgId) payload.msgId = _nextMsgId()
  if (!payload.ts) payload.ts = Date.now()
  _msgBuf.push(payload)
  if (_msgBuf.length > _MSG_BUF_MAX) _msgBuf.shift()
  if (!_trySend(payload)) {
    _pending.push(payload)
    if (_pending.length > _PENDING_MAX) _pending.shift()
  }
}

/** 定期把断链队列补发出去；opener 恢复后即可送达，单次排空全部积压 */
function _drainPending(): void {
  if (!_pending.length) return
  if (!window.opener || window.opener.closed) return
  const items = _pending.splice(0, _pending.length)
  for (const p of items) _trySend(p)
}

setInterval(_drainPending, 1000)

/**
 * [fill-ack-v1] fill 回执：所有失败/跳过路径必须回 ack，否则客户端 sendFillToAsync
 *   无法感知丢帧（表现为「输入框看起来填上了，但工作台以为没发出去」）。
 * [CONSTRAINT] reason 是短枚举字符串；sid 由 URL hash 取，客户端按 sid 匹配最近一条 ack。
 */
function ackFill(ok: boolean, reason: string, ackId: string | undefined): void {
  post({
    type: 'ai-runner:fill-ack',
    ok: Boolean(ok),
    reason: String(reason || ''),
    ackId: String(ackId || ''),
    sid: extractSidFromHash(),
  })
}
