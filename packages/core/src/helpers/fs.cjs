'use strict'

/** [api-ssot-v1] 本文件是本族 API 签名的唯一 SSOT；SYSTEM.md §3.2 与 ai-guard 注入只列「名字 + 常用项」，完整签名/返回/异常以本文件 JSDoc 为准。 */

/**
 * [helpers-fs-v1] 文件系统族：glob 遍历 / 变更集读取 / 项目根 / 原子写。
 *
 * [WHY] 与 io.cjs 的区别：io.cjs 管单文件读写 + 审计漏斗；本族管目录遍历与写事务（tmp + rename）。
 *
 * [CONSTRAINT] require 单向：index.cjs -> fs.cjs；本文件禁止反向 require。
 */
const fs = require('node:fs')
const path = require('node:path')

/**
 * 创建文件系统族 API。
 * @param {{safeReaddir: Function, globToRe: Function, changelog: Function}} deps
 * safeReaddir 来自 io.cjs、globToRe 来自 util.cjs、changelog 是写审计漏斗
 * @returns {{readFiles: Function, getChangedFiles: Function, getProjectRoot: Function, atomicWrite: Function}}
 */
function createFsApi(deps) {
  const { safeReaddir, globToRe, changelog: _changelog } = deps

  /**
   * [read-files-v1] 按 glob 遍历 cwd，跳过点开头目录与 node_modules。
   *
   * [CONSTRAINT] glob 语义：** 跨目录、* 单段、? 单字符（由 globToRe 转换）。
   * @param {string} glob
   * @returns {string[]} 匹配文件的绝对路径列表
   */
  function readFiles(glob) {
    const root = process.cwd()
    const out = []
    const re = globToRe(glob)
    const walk = function (dir) {
      let entries
      try { entries = safeReaddir(dir) } catch { return }
      for (const ent of entries) {
        if (ent.name.startsWith('.') || ent.name === 'node_modules') continue
        const full = path.join(dir, ent.name)
        if (ent.isDirectory()) { walk(full) }
        else if (ent.isFile()) {
          const rel = path.relative(root, full).replace(/\\/g, '/')
          if (re.test(rel)) out.push(full)
        }
      }
    }
    walk(root)
    return out
  }

  /**
   * [changed-files-v1] 本轮变更清单（服务端经 AI_RUNNER_CHANGED 注入，overlay 落盘后写回）。
   * @returns {string[]}
   */
  function getChangedFiles() {
    try { return JSON.parse(process.env.AI_RUNNER_CHANGED || '[]') }
    catch { return [] }
  }

  /**
   * 项目根（等价 process.cwd()）。
   * @returns {string}
   */
  function getProjectRoot() { return process.cwd() }

  /**
   * [atomic-write-v1] 同目录写 tmp + rename 落盘：中断时不会留半写文件。
   *
   * [CONSTRAINT] rename 是同设备原子操作；跨设备会退化为 copy+unlink（不保证）。
   * @param {string} file
   * @param {string} content
   * @returns {boolean} 恒 true（失败会抛异常）
   */
  function atomicWrite(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, content, 'utf8')
    fs.renameSync(tmp, file)
    _changelog('write', file)
    return true
  }

  return { readFiles, getChangedFiles, getProjectRoot, atomicWrite }
}

module.exports = { createFsApi }
