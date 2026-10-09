'use strict'

/** [api-ssot-v1] 本文件是本族 API 签名的唯一 SSOT；SYSTEM.md §3.2 与 ai-guard 注入只列「名字 + 常用项」，完整签名/返回/异常以本文件 JSDoc 为准。 */

/**
 * [helpers-patch-v1] 写入族：backup（首次备份）与 patchFile（锚点替换 + 可诊断失配）。
 *
 * [WHY] 二者是同一事务（patch 前必先 backup 一次），与检索/输出/状态族职责正交；
 * patchFile 需 __AI__.backup 自引用、_changelog 审计、_anchorReport 诊断，走工厂注入。
 *
 * [CONSTRAINT] require 单向：index.cjs -> patch.cjs；本文件禁止反向 require。
 */
const fs = require('node:fs')
const path = require('node:path')

/**
 * 创建写入族 API。
 * @param {{self: () => object, changelog: Function, anchorReport: Function}} deps
 * self 传函数避免装配期未就绪；changelog 走 io 审计漏斗；anchorReport 来自 util.cjs
 * @returns {{backup: Function, patchFile: Function}}
 */
function createPatchApi(deps) {
  const { self, changelog: _changelog, anchorReport: _anchorReport } = deps
  const S = () => self()

  /**
   * 首次备份文件到 .ai-runner/backup/<相对路径>（已存在则复用）。
   *
   * [CONSTRAINT] 文件必须在项目内；越界抛异常。
   * @param {string} file 绝对路径
   * @returns {string} 备份文件路径
   */
  function backup(file) {
    const root = process.cwd()
    const rel = path.relative(root, file)
    if (rel.indexOf('..') === 0) throw new Error('backup: 文件不在项目内')
    const target = path.join(root, '.ai-runner/backup', rel)
    if (fs.existsSync(target)) return target
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(file, target)
    return target
  }

  /**
   * 锚点替换（不解释正则，纯字面）。
   *
   * [patch-skip-changelog-v1] marker 短路是幂等设计；但静默返回会让审计断链，
   * 故补一行 changelog（代价为零，不改落盘语义）。
   *
   * [patch-diagnostic-v1] 锚点失配必须可诊断：
   * [CONSTRAINT] 仍抛异常，不改返回 {ok:false}——调用方普遍不检查返回值，
   * 静默化比裸抛更危险（写一半继续跑）。
   *
   * @param {string} file
   * @param {string} anchor 精确匹配文本（需唯一）
   * @param {string} replacement 替换文本
   * @param {{marker?: string, unique?: boolean}} [opts]
   * @returns {{ok: boolean, replaced?: number, skipped?: boolean, reason?: string}}
   */
  function patchFile(file, anchor, replacement, opts) {
    opts = opts || {}
    const src = fs.readFileSync(file, 'utf8')
    if (opts.marker && src.includes(opts.marker)) {
      _changelog('patch-skip', file)
      return { ok: true, skipped: true, reason: 'marker present' }
    }
    const lines = src.split(/\r?\n/)
    const count = src.split(anchor).length - 1
    if (count === 0) {
      const head = String(anchor).split(/\r?\n/)[0] || ''
      const probe = head.trim().slice(0, 40)
      const near = probe.length >= 6 ? _anchorReport(src, probe, lines) : []
      let hint = '锚点在该文件中不存在：先 readText 确认原文，或换一个稳定片段'
      if (anchor.length < 12) hint = 'ANCHOR_TOO_SHORT：锚点 < 12 字符极易失配，请改用「唯一整行」或带上下文的片段'
      else if (near.length) hint = '锚点首行存在但整段不匹配：多半是缩进/空白/换行与磁盘不一致——先 readText 读回原文再 patch'
      throw new Error(`patchFile: ANCHOR_NOT_FOUND ${JSON.stringify({
        file,
        anchorLen: anchor.length,
        anchorHead: String(anchor).slice(0, 60),
        nearLines: near.map(h => h.line),
        hint,
      })}`)
    }
    if (opts.unique && count > 1) {
      const hits = _anchorReport(src, anchor, lines)
      throw new Error(`patchFile: ANCHOR_NOT_UNIQUE ${JSON.stringify({
        file,
        anchorLen: anchor.length,
        count,
        at: hits.slice(0, 10),
        hint: '锚点不唯一：加长到唯一（带前后各一行最稳），或去掉 opts.unique',
      })}`)
    }
    S().backup(file)
    const next = src.split(anchor).join(replacement)
    fs.writeFileSync(file, next, 'utf8')
    const check = fs.readFileSync(file, 'utf8')
    if (check !== next) throw new Error('patchFile: readback mismatch')
    _changelog('patch', file)
    return { ok: true, replaced: count }
  }

  return { backup, patchFile }
}

module.exports = { createPatchApi }
