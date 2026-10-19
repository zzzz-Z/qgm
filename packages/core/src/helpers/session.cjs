// [helpers-session-v1] 会话族：创建 / 发帧 / 关闭隔离会话（HTTP，服务端 session-manager 托管）。
//
// [WHY] 子任务隔离的物理基础已存在（每 session 是独立 REPL 子进程 + 独立 overlay/toolLog），
//   但门面此前完全没有 session 能力 ⇒ AI 无法主动派生隔离会话做子任务。本文件补上这一层。
//
// [CONSTRAINT] 只做 HTTP 转发，不持有会话状态：状态由服务端 sessions Map 托管，
//   门面侧任何缓存都会与服务端真值漂移（degraded / 回收）。
const DEFAULT_PORT = 5175

/** 服务端端口（与 tasks/lessons 族同口径）。 */
function _port() {
  return Number(process.env.AIR_SERVER_PORT || process.env.AIR_RUNNER_SERVER_PORT) || DEFAULT_PORT
}

/** 统一请求封装：异常与非 2xx 都转成 {ok:false, error}，不抛断调用方。 */
async function _req(method, path, body) {
  const url = `http://127.0.0.1:${_port()}/__ai${path}`
  const opts = { method, headers: { accept: 'application/json' } }
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  try {
    const res = await fetch(url, opts)
    const j = await res.json().catch(() => ({}))
    if (!res.ok && j && j.ok === undefined) return { ok: false, error: `HTTP ${res.status}` }
    return j
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/**
 * 创建隔离会话。
 * @param {{"sandbox"?: "read-only"|"workspace-write"}} [opts] 沙箱级别，缺省 read-only
 * @returns {Promise<{ok: boolean, sid?: string, sandbox?: string, pid?: number, overlay?: string, toolLog?: string, error?: string}>} 会话信息或错误
 */
async function create(opts) {
  const sandbox = (opts && opts.sandbox) || 'read-only'
  return _req('POST', '/session', { sandbox })
}

/**
 * 向会话发一帧脚本并等待结果。
 * @param {string} sid 会话 id
 * @param {string} code 脚本源码
 * @param {{id?: string}} [opts] 帧 id（幂等去重用）
 * @returns {Promise<{ok: boolean, frame?: object, code?: string, nextStep?: string, error?: string}>} 帧结果或错误
 */
async function frame(sid, code, opts) {
  if (!sid) return { ok: false, error: 'sid required' }
  if (!code) return { ok: false, error: 'code required' }
  return _req('POST', `/session/${encodeURIComponent(sid)}/frame`, { code, id: opts && opts.id })
}

/**
 * 关闭会话（幂等）。
 * @param {string} sid 会话 id
 * @returns {Promise<{ok: boolean, closed?: boolean, error?: string}>} 关闭结果
 */
async function close(sid) {
  if (!sid) return { ok: false, error: 'sid required' }
  return _req('DELETE', `/session/${encodeURIComponent(sid)}`)
}

module.exports = { create, frame, close }
