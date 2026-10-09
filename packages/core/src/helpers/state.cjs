'use strict'

/** [api-ssot-v1] 本文件是本族 API 签名的唯一 SSOT；SYSTEM.md §3.2 与 ai-guard 注入只列「名字 + 常用项」，完整签名/返回/异常以本文件 JSDoc 为准。 */

/**
 * [helpers-state-v1] 状态族：.ai-runner/state.json 的读写与环境字段自愈。
 *
 * [WHY] state 是会话级共享资产，与检索、patch 等族职责正交；readState/updateState 需 __AI__ 自引用，
 * 走工厂注入 self（函数形态）避免装配顺序耦合。
 *
 * [CONSTRAINT] require 单向：index.cjs -> state.cjs；本文件禁止反向 require。
 */
const fs = require('node:fs')
const path = require('node:path')

/**
 * 创建 state 族 API。
 * @param {{self: () => object}} deps self 传函数，避免装配期 __AI__ 未就绪
 * @returns {{statePath: Function, readState: Function, updateState: Function, _ensureEnvFields: Function}}
 */
function createStateApi(deps) {
  const S = () => deps.self()

  /**
   * state.json 的绝对路径。
   * @returns {string}
   */
  function statePath() {
    return path.join(process.cwd(), '.ai-runner/state.json')
  }

  /**
   * 读 state.json 并解析；不存在或解析失败返回 null（不抛）。
   * @returns {object|null}
   */
  function readState() {
    const p = S().statePath()
    try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
  }

  /**
   * 读 state → 应用 fn(st) → round +1 → 补环境字段 → 回写。
   *
   * [CONSTRAINT] state.json 不存在直接抛（不静默新建），避免掩盖上游初始化缺失。
   * @param {(st: object) => void} [fn] 对 state 的就地修改回调
   * @returns {object} 更新后的 state
   */
  function updateState(fn) {
    const p = S().statePath()
    if (!fs.existsSync(p)) throw new Error(`state.json missing: ${p}`)
    const st = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (typeof fn === 'function') fn(st)
    st.round = (st.round || 0) + 1
    S()._ensureEnvFields(st)
    fs.writeFileSync(p, JSON.stringify(st, null, 2), 'utf8')
    return st
  }
  /**
   * [rules-version-align-v1] 补齐 state 的环境字段（cwd/worktree/branch/pid/时间戳/计数/规则版本）。
   *
   * [WHY] rulesVersion 原实现读 <cwd>/SYSTEM.md 找 version 行——SSOT 在 packages/core/SYSTEM.md，
   * 且该文件无 version 行 ⇒ rulesVersion 恒 unknown ⇒ DSPy 无法按规则版本分组。
   * 改为 sha256(packages/core/SYSTEM.md) 前 8 位，每次覆盖更新（覆盖会话中途改规则的场景）。
   *
   * [CONSTRAINT] 就地修改传入对象，不返回值；本函数不落盘（由 updateState 负责回写）。
   * @param {object} st
   */
  function _ensureEnvFields(st) {
    const now = new Date().toISOString()
    const cwd = process.cwd()
    if (!st.cwd) st.cwd = cwd
    if (!st.worktree) st.worktree = cwd
    if (!st.branch) {
      try {
        const head = fs.readFileSync(path.join(cwd, '.git/HEAD'), 'utf8').trim()
        const m = head.match(/^ref:[ \t]+refs\/heads\/(\S+)$/)
        st.branch = m ? m[1] : head
      } catch { st.branch = 'unknown' }
    }
    if (!st.pid) st.pid = process.pid
    if (!st.startedAt) st.startedAt = now
    st.updatedAt = now
    if (st.finishedAt === undefined) st.finishedAt = null
    if (typeof st.doneCount !== 'number') st.doneCount = 0
    if (typeof st.totalCount !== 'number') st.totalCount = Array.isArray(st.todo) ? st.todo.length : 0
    if (!st.currentTodoId && Array.isArray(st.todo) && st.todo[0]) {
      const t = st.todo[0]
      st.currentTodoId = (typeof t === 'string') ? t : (t && t.id) || null
    }
    try {
      const rulesCrypto = require('node:crypto')
      const rulesSysPath = path.join(cwd, 'packages/core/SYSTEM.md')
      if (fs.existsSync(rulesSysPath)) {
        const rulesRaw = fs.readFileSync(rulesSysPath, 'utf8')
        st.rulesVersion = rulesCrypto.createHash('sha256').update(rulesRaw).digest('hex').slice(0, 8)
      } else {
        st.rulesVersion = 'unknown'
      }
    } catch { st.rulesVersion = 'unknown' }
  }

  return { statePath, readState, updateState, _ensureEnvFields }
}

module.exports = { createStateApi }
