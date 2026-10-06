// [send-trace-v1] 页面通道**出站留痕**：每次真实投递一条 → `.ai-runner/logs/send.jsonl`（经 `/send-log`）。
//
// [WHY] 「应用往 AI 页面投了多少条提问」直接决定站点限流，而此前磁盘上**没有任何出站留痕**：
//   `runner.jsonl` 只记「脚本到达服务端之后」的 pipeline 与耗时，`reject.jsonl` 只记被拒脚本。
//   于是三个问题全都只能间接推算 —— ① 真实发送间隔分布（频控阈值该取多少）；
//   ② 同轮双发是否发生；③ 一条含 N 块的回复是否真的被放大成 N 次提问。
//   本模块把「一次投递」变成一行事实：`ts`（服务端落盘时打）· `sid` · `source` · `promptHead` · `promptBytes`。
//
// [CONSTRAINT] **绝不阻断投递**：fire-and-forget，任何异常（无 fetch / 网络失败 / 服务端 4xx）
//   一律吞掉。留痕是观测手段，不能反过来变成新的故障源。
// [CONSTRAINT] **不记完整正文**：只上报 UTF-8 字节数与前 120 字符首部 —— prompt 里可能含用户
//   粘贴的代码或密钥，日志不该成为它们的第二份副本。
// [CONSTRAINT] 只覆盖「帧已构造并投递（或试图投递）」这一次事件；`win=null` / `origin=''` 这类
//   本地前置校验失败**不记**（帧从未构造，且调用点已各自 log.warn / finish），
//   以保证「一行 = 一次真实出站」这条口径不被稀释。
import { log } from '../../utils/log'

/** 上报端点（dev 由 vite proxy 转发到后端；standalone 同源） */
const SEND_LOG_ENDPOINT = '/__ai/send-log'

/** prompt 首部留痕长度（与 server 侧 buildSendEntry 的截断一致） */
const PROMPT_HEAD_MAX = 120

/** 出站留痕的入参 */
export interface SendTraceInput {
  /** 会话 id；headless 池常为空串 */
  sid: string
  /** 投递路径：tm = 页面 postMessage（经油猴）；headless = 服务端浏览器池 */
  via: 'tm' | 'headless'
  /** 调用点归因（loop-round / copyOutput / …），用于算各来源占比 */
  source: string
  /** 本次投递的完整 prompt（本模块只取首部与字节数，不外传正文） */
  prompt: string
  /** 投递结果：postMessage / WS 是否未抛错 */
  ok: boolean
}

/**
 * 统计 UTF-8 字节数
 * [WHY] 体积口径必须与脚本侧一致（中文字符 3 字节），用字符数会把中文 prompt 低估 3 倍
 * [CONSTRAINT] TextEncoder 缺失时退化为字符数，绝不抛
 */
function utf8Bytes(s: string): number {
  try {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(s).length
  } catch { /* ignore: 退化到字符数 */ }
  return s.length
}

/**
 * 上报一次出站投递（fire-and-forget，无返回）
 * [CONSTRAINT] 同步不抛、异步不抛；调用方**不需要** await，也不得因它改变控制流
 * @param input 本次投递的归因信息
 */
export function traceSend(input: SendTraceInput): void {
  try {
    if (typeof fetch !== 'function') return
    const prompt = String(input.prompt || '')
    const body = JSON.stringify({
      sid: input.sid,
      via: input.via,
      source: input.source,
      promptBytes: utf8Bytes(prompt),
      // 只截首部：正文换行由服务端单行化，客户端不重复那套转换（避免第二份同构实现）
      promptHead: prompt.slice(0, PROMPT_HEAD_MAX),
      ok: input.ok === true,
    })
    // keepalive：页面正在卸载/切窗口时也尽量把这条送出
    void fetch(SEND_LOG_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => { /* 留痕失败不阻断投递 */ })
  } catch (e) {
    // 观测失败只降级为一条 debug 级日志，绝不冒泡到投递路径
    log.debug('[send-trace] 上报失败（不影响投递）', e)
  }
}
