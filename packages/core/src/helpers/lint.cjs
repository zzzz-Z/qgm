'use strict'

/** [api-ssot-v1] 本文件是本族 API 签名的唯一 SSOT；SYSTEM.md §3.2 与 ai-guard 注入只列「名字 + 常用项」，完整签名/返回/异常以本文件 JSDoc 为准。 */

/**
 * [helpers-lint-v1] 静态校验族：eslint / vue-tsc 同步调用（供 DONE 前自检）。
 *
 * [WHY] 与 util.cjs 的 _execBin 分离：util 提供机制（定位+执行），本族提供策略（选哪个 bin、传什么参数）。
 *
 * [CONSTRAINT] require 单向：index.cjs -> lint.cjs；binPath/execBin 由 deps 注入。
 */
const fs = require('node:fs')

/**
 * 创建静态校验族 API。
 * @param {{binPath: Function, execBin: Function}} deps 来自 util.cjs 的 _binPath / _execBin
 * @returns {{lint: Function, typeCheck: Function}}
 */
function createLintApi(deps) {
  const { binPath: _binPath, execBin: _execBin } = deps

  /**
   * [lint-v1] 跑项目内 eslint；无参时默认全仓（.）。
   *
   * [CONSTRAINT] 返回 {ok, output} 不抛；bin 缺失返回 {ok:false, output}。
   * @param {string[]} [files] 目标文件列表；空则等价于 ['.]
   * @returns {{ok: boolean, output: string}}
   */
  function lint(files) {
    const bin = _binPath('eslint')
    if (!fs.existsSync(bin)) return { ok: false, output: '未找到 node_modules/.bin/eslint' }
    const args = Array.isArray(files) && files.length ? files : ['.']
    return _execBin(bin, args)
  }

  /**
   * [typecheck-v1] 跑 vue-tsc（覆盖 .vue），缺失则退化到 tsc。
   *
   * [CONSTRAINT] 固定传 --noEmit；无参；无 bin 时返回 {ok:false, output}。
   * @returns {{ok: boolean, output: string}}
   */
  function typeCheck() {
    const vueTsc = _binPath('vue-tsc')
    const tsc = _binPath('tsc')
    const bin = fs.existsSync(vueTsc) ? vueTsc : (fs.existsSync(tsc) ? tsc : null)
    if (!bin) return { ok: false, output: '未找到 node_modules/.bin/vue-tsc 或 tsc' }
    return _execBin(bin, ['--noEmit'])
  }

  return { lint, typeCheck }
}

module.exports = { createLintApi }
