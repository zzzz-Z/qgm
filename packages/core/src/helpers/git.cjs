// [git-query-v1] 结构化 git 查询，替代手写 `git status --porcelain` 后自行解析。
// [WHY] 全量日志（16,286 脚本）：git 命令约 930 次手写（status 400 / diff 233 / log 158 …）。
//   其中 status 解析最易出错：本会话曾因「DONE 后自动提交导致 status 突然为空」误判文件丢失。
// [CONSTRAINT] 只读查询，不执行 add/commit/checkout 等写操作；不反向 require 其它 helper。

/**
 * 查询 git 状态，返回结构化结果。
 * @param {{json?: boolean}} [opts] - json=true 时返回原始字符串数组
 * @param {(cmd: string[], o?: object) => Promise<object>} runFn - 注入的 shell
 * @returns {Promise<{ok: boolean, branch: string, modified: string[], untracked: string[], staged: string[], clean: boolean, error?: string}>} 仓库状态；clean=true 表示工作区无改动
 */
async function status(opts = {}, runFn) {
  const r = await runFn(['git', 'status', '--porcelain'], { timeoutMs: 20000 })
  if (!r || !r.ok) return { ok: false, branch: '', modified: [], untracked: [], staged: [], clean: false, error: String((r && r.stderr) || 'git status failed').slice(0, 200) }
  const lines = String(r.stdout || '').split('\n').filter(Boolean)
  const modified = []; const untracked = []; const staged = []
  for (const l of lines) {
    const code = l.slice(0, 2); const file = l.slice(3).trim()
    if (code === '??') untracked.push(file)
    else if (code[0] !== ' ' && code[0] !== '?') staged.push(file)
    else modified.push(file)
  }
  const b = await runFn(['git', 'branch', '--show-current'], { timeoutMs: 10000 })
  const branch = String((b && b.stdout) || '').trim()
  return { ok: true, branch, modified, untracked, staged, clean: lines.length === 0 }
}

/**
 * 取最近 N 条提交。
 * @param {number} [n] - 条数，默认 5
 * @param {(cmd: string[], o?: object) => Promise<object>} runFn - 注入的 shell
 * @returns {Promise<{ok: boolean, commits: Array<{hash: string, subject: string}>}>} 提交列表
 */
async function recent(n, runFn) {
  const r = await runFn(['git', 'log', '--oneline', '-n', String(n || 5)], { timeoutMs: 15000 })
  if (!r || !r.ok) return { ok: false, commits: [] }
  const commits = String(r.stdout || '').split('\n').filter(Boolean).map((l) => {
    const i = l.indexOf(' ')
    return { hash: l.slice(0, i), subject: l.slice(i + 1) }
  })
  return { ok: true, commits }
}

module.exports = { status, recent }
