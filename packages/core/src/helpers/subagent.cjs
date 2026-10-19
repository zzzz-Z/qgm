// [helpers-subagent-v1] 子智能体编排门面（HTTP，服务端单例编排器托管）。
//
// [WHY] 编排器与执行体都在服务端；门面只做转发，不持有任务状态
//   （跨请求可见性由服务端单例保证，本地缓存必漂移）。
const DEFAULT_PORT = 5175

/** 服务端端口（与 tasks/lessons/session 族同口径）。 */
function _port() {
  return Number(process.env.AIR_SERVER_PORT || process.env.AIR_RUNNER_SERVER_PORT) || DEFAULT_PORT
}

/** 统一请求封装：异常与非 2xx 都转 {ok:false, error}。 */
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
 * 提交子任务（立即返回，异步执行）。
 * @param {string} description 任务描述；repl-script 执行体下即为脚本源码
 * @param {{executor?: "repl-script"}} [opts] 执行体类型
 * @returns {Promise<{ok: boolean, task?: object, error?: string}>} 已登记的任务或错误
 */
async function submit(description, opts) {
  if (!description) return { ok: false, error: 'description required' }
  return _req('POST', '/subagent/tasks', { description, executor: opts && opts.executor })
}

/**
 * 取单个任务。
 * @param {string} id 任务 id
 * @returns {Promise<{ok: boolean, task?: object, error?: string}>} 任务快照或错误
 */
async function get(id) {
  if (!id) return { ok: false, error: 'id required' }
  return _req('GET', `/subagent/tasks/${encodeURIComponent(id)}`)
}

/**
 * 列出任务。
 * @param {"pending"|"running"|"done"|"failed"|"cancelled"} [status] 状态过滤
 * @returns {Promise<{ok: boolean, tasks?: object[], summary?: object, error?: string}>} 任务列表与汇总
 */
async function list(status) {
  const q = status ? `?status=${encodeURIComponent(status)}` : ''
  return _req('GET', `/subagent/tasks${q}`)
}

/**
 * 取消任务（已在终态则无操作）。
 * @param {string} id 任务 id
 * @returns {Promise<{ok: boolean, cancelled?: boolean, error?: string}>} 取消结果
 */
async function cancel(id) {
  if (!id) return { ok: false, error: 'id required' }
  return _req('DELETE', `/subagent/tasks/${encodeURIComponent(id)}`)
}

module.exports = { submit, get, list, cancel }
