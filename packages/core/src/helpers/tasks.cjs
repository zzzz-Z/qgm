'use strict'

/** [api-ssot-v1] 本文件是本族 API 签名的唯一 SSOT；SYSTEM.md §3.2 与 ai-guard 注入只列「名字 + 常用项」，完整签名/返回/异常以本文件 JSDoc 为准。 */

/**
 * [helpers-tasks-v1] 任务看板 API：服务端按会话分桶（sid 从 env 读，脚本不自传）。
 *
 * [WHY] tasks 是 AI 自驱任务板的唯一通道，与检索/patch/output 族职责正交。
 *
 * [CONSTRAINT] 异常一律返回 {ok:false, error}，不抛断脚本；AI 可 `await __AI__.tasks.push([...])`。
 */

/**
 * 看板端点 URL；sid 从环境变量读取（服务端按会话分桶）。
 * @returns {string}
 */
function _url() {
  const port = Number(process.env.AIR_SERVER_PORT || process.env.AIR_RUNNER_SERVER_PORT) || 5175
  const sid = process.env.AI_RUNNER_SESSION_ID || ''
  return `http://127.0.0.1:${port}/__ai/tasks${sid ? `?sid=${encodeURIComponent(sid)}` : ''}`
}

/**
 * POST 到看板端点并归一化响应（todo/done/items/running/warnings 计数）。
 *
 * [WHY] 用 Promise.resolve().then 包裹同步调用：fetch 同步 throw（如环境缺失 / mock 同步抛）
 * 时不会逃出 .catch 链。
 *
 * @param {object} body 请求体（含 mode）
 * @returns {Promise<{ok: boolean, todo?: number, done?: number, items?: number, running?: string, warnings?: string[], error?: string}>}
 */
function _post(body) {
  const url = _url()
  return Promise.resolve().then(() => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })).then(async (res) => {
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const j = await res.json()
    return {
      ok: true,
      todo: Array.isArray(j && j.todo) ? j.todo.length : 0,
      done: Array.isArray(j && j.done) ? j.done.length : 0,
      items: Array.isArray(j && j.items) ? j.items.length : 0,
      running: typeof (j && j.running) === 'string' ? j.running : '',
      warnings: Array.isArray(j && j.warnings) ? j.warnings : [],
    }
  }).catch(e => ({ ok: false, error: String((e && e.message) || e) }))
}

/**
 * [tasks-list-v1] 读回当前会话看板。
 *
 * [WHY] 旧实现只有写：AI 看不到自己的看板，只能盲写。
 * [CONSTRAINT] 失败返回 {ok:false, error}，不抛；items 为结构化任务（含 status/时刻）。
 * [list-read-shape-v1] 返回值含 items / todo / done / running / failed / expiredRunning / summary。
 *   **failed 与 expiredRunning 是独立数组，不在 todo/done/running 中**——只看后三者会漏掉失败项，
 *   从而在 DONE 里误称「全部完成」。核查看板必须遍历 items、显式读 failed，或直接看 summary 计数。
 * @returns {Promise<{ok, items, todo, done, running, expiredRunning, failed, planPending, summary, error?}>}
 */
function list() {
  const url = _url()
  return Promise.resolve().then(() => fetch(url, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  })).then(async (res) => {
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const j = await res.json()
    const items = Array.isArray(j && j.items) ? j.items : []
    const todo = Array.isArray(j && j.todo) ? j.todo : []
    const done = Array.isArray(j && j.done) ? j.done : []
    const running = typeof (j && j.running) === 'string' ? j.running : ''
    const expiredRunning = Array.isArray(j && j.expiredRunning) ? j.expiredRunning : []
    const failed = Array.isArray(j && j.failed) ? j.failed : []
    const planPending = Number(j && j.planPending) || 0
    return {
      ok: true,
      items,
      todo,
      done,
      running,
      expiredRunning,
      failed,
      planPending,
      // [board-summary-v1] 汇总计数：即使只扫顶层也能立即感知失败/超时/待办项，防「漏读 failed 误称全部完成」
      summary: {
        total: items.length,
        todo: todo.length,
        running: running ? 1 : 0,
        done: done.length,
        failed: failed.length,
        expiredRunning: expiredRunning.length,
        planPending,
      },
    }
  }).catch(e => ({ ok: false, error: String((e && e.message) || e) }))
}

/**
 * 登记待办（先拆解再执行，粒度=可独立验证的单步）。
 * @param {string[]} items
 * @returns {Promise<object>}
 */
function push(items) {
  return _post({ mode: 'push', pushTodo: Array.isArray(items) ? items.map(String) : [] })
}

/**
 * 标记任务已完成。
 * @param {string[]} items
 * @returns {Promise<object>}
 */
function complete(items) {
  return _post({ mode: 'complete', complete: Array.isArray(items) ? items.map(String) : [] })
}

/**
 * [task-running-v1] 标记某任务为「正在执行」（面板显示运行态图标）。
 * @param {string[]} items
 * @returns {Promise<object>}
 */
function start(items) {
  return _post({ mode: 'start', start: Array.isArray(items) ? items.map(String) : [] })
}

/**
 * [task-board-fail-v1] 标记某任务为「失败」（面板显示 ✗；不再只能靠沉默留在待办里）。
 * [fail-semantics-v1] 仅用于「确定做不成」（遇不可逾越障碍 / 依赖永久缺失 / 需求取消）。
 *   「评估已完成、结论是无需改动」属**完成**，必须用 complete()，不得用 fail()——
 *   误用会让看板长期挂着假失败项，且与 DONE 里「全部完成」声明自相矛盾（2026-10-09 实测）。
 * @param {string[]} items
 * @returns {Promise<object>}
 */
function fail(items) {
  return _post({ mode: 'fail', fail: Array.isArray(items) ? items.map(String) : [] })
}

module.exports = { _url, _post, list, push, complete, start, fail }
