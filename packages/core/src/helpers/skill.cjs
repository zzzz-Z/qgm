'use strict'

/** [api-ssot-v1] 本文件是本族 API 签名的唯一 SSOT；SYSTEM.md §3.2 与 ai-guard 注入只列「名字 + 常用项」，完整签名/返回/异常以本文件 JSDoc 为准。 */

/**
 * [helpers-skill-v1] 技能加载族：接收网页层已拼装裁剪的 content，幂等追加到 .ai-runner/loaded-skill.md。
 *
 * [WHY] 沙箱侧唯一职责是「落盘」——不解析格式、不校验来源、不二次裁剪（裁剪在网页层完成）。
 *
 * [CHANGE-IMPACT] 落盘路径 .ai-runner/loaded-skill.md 会被后续脚本通过 __AI__.readText 消费。
 */
const fs = require('node:fs')
const path = require('node:path')

/**
 * 创建技能加载族 API。
 * @param {{changelog: Function}} deps changelog 为 io.cjs 的写审计漏斗
 * @returns {{loadSkill: (content: string) => {ok: boolean, bytes?: number, path?: string, skipped?: boolean, reason?: string}}}
 */
function createSkillApi(deps) {
  const { changelog: _changelog } = deps

  /**
   * 幂等追加技能内容到 .ai-runner/loaded-skill.md。
   *
   * [CONSTRAINT] 完全一致去重：prev === s 或 prev 以分隔符结尾时跳过。
   * @param {string} content 已由网页层拼装裁剪的技能全文
   * @returns {{ok: boolean, bytes?: number, path?: string, skipped?: boolean, reason?: string}}
   */
  function loadSkill(content) {
    const s = typeof content === 'string' ? content : ''
    if (!s) return { ok: false, reason: 'invalid-content' }
    const p = path.join(process.cwd(), '.ai-runner', 'loaded-skill.md')
    let prev = ''
    try { prev = fs.readFileSync(p, 'utf8') } catch { prev = '' }
    if (prev === s || prev.endsWith(`\n\n---\n\n${s}`)) return { ok: true, skipped: true }
    const next = prev ? `${prev}\n\n---\n\n${s}` : s
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, next, 'utf8')
      _changelog('skill-load', p, { bytes: s.length })
      return { ok: true, bytes: s.length, path: p }
    } catch (e) {
      return { ok: false, reason: String(e) }
    }
  }

  return { loadSkill }
}

module.exports = { createSkillApi }
