// [probe-v1] 服务/端口探活与测试统一入口。
// [WHY] 全量日志分析（16,286 脚本）：端口探活 990 次、curl 739 次、vitest 调用 1,977 次且写法分裂成 10 种。
//   curl 在沙箱内不可靠（实测返回 000 被误判成服务挂掉），vitest 每种写法都要自己拼环境垫片。
// [CONSTRAINT] 一律用进程内 fetch，不 spawn curl；不反向 require 其它 helper。

/**
 * 探活一个本地 HTTP 端口。
 * @param {number|string} port - 端口号
 * @param {{path?: string, timeoutMs?: number, host?: string}} [opts]
 * @returns {Promise<{ok: boolean, listening: boolean, status: number, url: string, error?: string}>} 探活结果；listening=false 表示无进程监听
 *   listening=true 表示有进程在监听（即使 HTTP 返回非 2xx）
 */
async function probe(port, opts = {}) {
  const host = opts.host || '127.0.0.1'
  const path = opts.path || '/'
  const timeoutMs = opts.timeoutMs || 5000
  const url = `http://${host}:${port}${path}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return { ok: true, listening: true, status: res.status, url }
  } catch (e) {
    return { ok: false, listening: false, status: 0, url, error: String((e && e.message) || e).slice(0, 120) }
  }
}

/**
 * 等后台 shell 任务结束（内部轮询 shellStatus，替代 AI 手写 sleep 循环）。
 * @param {string} id - shell 后台任务 id
 * @param {{timeoutMs?: number, intervalMs?: number}} [opts]
 * @param {(id: string) => object} statusFn - 由 index.cjs 注入的 shellStatus
 * @returns {Promise<{ok: boolean, running: boolean, exitCode: number|null, waitedMs: number, timedOut: boolean}>} 等待结果；timedOut=true 表示超时仍在跑
 */
async function shellWait(id, opts = {}, statusFn) {
  const timeoutMs = opts.timeoutMs || 180000
  const intervalMs = opts.intervalMs || 1000
  const t0 = Date.now()
  let st = statusFn(id)
  while (st && st.running && Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, intervalMs))
    st = statusFn(id)
  }
  const waitedMs = Date.now() - t0
  const timedOut = Boolean(st && st.running)
  return { ok: Boolean(st && st.ok), running: Boolean(st && st.running), exitCode: st ? (st.exitCode ?? null) : null, waitedMs, timedOut }
}

/**
 * 跑 vitest 并返回结构化结果（替代从 stdout 截取文字判断）。
 * @param {string[]} [files] - 测试文件路径；省略则跑全量
 * @param {{timeoutMs?: number}} [opts]
 * @param {(cmd: string[], o?: object) => Promise<object>} runFn - 由 index.cjs 注入的 shell
 * @returns {Promise<{ok: boolean, passed: number, failed: number, failedFiles: string[], rawTail: string}>} 测试结果；failed=-1 表示无法解析输出
 */
async function testRun(files, opts = {}, runFn) {
  const args = ['npx', 'vitest', 'run']
  if (files && files.length) args.push(...files)
  const env = Object.assign({}, process.env, { CODEBUDDY_SAFE_DELETE_ENABLED: '0' })
  const r = await runFn(args, { timeoutMs: opts.timeoutMs || 170000, env })
  // [probe-ansi-v1] vitest 输出带 ANSI 颜色码（'Tests' 与数字之间夹 \u001b[22m 等），
  //   不剥就直接正则必然匹配不到（初版实测 passed=0/failed=0 而实际 7 passed）。
  const raw = String((r && r.stdout) || '') + String((r && r.stderr) || '')
  const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
  const out = raw.replace(ANSI, '')
  const m = out.match(/Tests\s+(\d+) failed\s*\|\s*(\d+) passed/) || out.match(/Tests\s+(\d+) passed/)
  const failed = m && m[2] !== undefined ? Number(m[1]) : (m ? 0 : (r && r.ok ? 0 : -1))
  const passed = m && m[2] !== undefined ? Number(m[2]) : (m ? Number(m[1]) : 0)
  const failedFiles = [...out.matchAll(/FAIL\s+(\S+)/g)].map(x => x[1])
  return { ok: Boolean(r && r.ok), passed, failed, failedFiles, rawTail: out.slice(-2000) }
}

module.exports = { probe, shellWait, testRun }
