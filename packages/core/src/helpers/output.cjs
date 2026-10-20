'use strict'

/** [api-ssot-v1] 本文件是本族 API 签名的唯一 SSOT；SYSTEM.md §3.2 与 ai-guard 注入只列「名字 + 常用项」，完整签名/返回/异常以本文件 JSDoc 为准。 */

/* eslint-disable no-console -- __AI__ 的 ok/skip/warn/err/log 需直接输出（与 helpers/index.cjs 同款豁免） */

/**
 * [helpers-output-v1] 语义输出 + 退出协议 + 断言族。
 *
 * [WHY] log/ok/err 等是「AI 脚本 → 人类/协议」的唯一出口，与文件、检索、状态族职责正交；
 * assert 族需 __AI__ 自引用（readText/assert），走工厂 self 注入；
 * _c（chalk 包装或降级为恒等函数）由 index.cjs 注入，本文件不重复探测 TTY。
 *
 * [CONSTRAINT] require 单向：index.cjs -> output.cjs；本文件禁止反向 require。
 */

/**
 * 创建输出/退出/断言族 API。
 * @param {{self: () => object, c: object}} deps self 传函数避免装配期未就绪；c 为 chalk 兼容对象
 * @returns {{log: Function, exit: Function, assert: Function, assertVueHasName: Function, assertContains: Function, assertNotContains: Function, writeDiffReport: Function, exitNeedInput: Function, exitNeedFiles: Function, ok: Function, skip: Function, warn: Function, err: Function}}
 */
function createOutputApi(deps) {
  const { self, c: _c } = deps
  const S = () => self()

  /**
   * 语义日志（带 [AI] 前缀；chalk 降级时前缀无色）。
   * @param {...unknown} args
   */
  function log() {
    console.log.apply(console, [_c.dim('[AI]')].concat([].slice.call(arguments)))
  }

  /**
   * [ai-shell-exit-v2] 统一退出：可选先打印错误，再带 code 退出。
   * @param {number} [code] 退出码（非 number 视作 0）
   * @param {string} [msg] 若提供先经 err 通道打印
   */
  function exit(code, msg) {
    if (msg) S().err(msg)
    process.exit(typeof code === 'number' ? code : 0)
  }

  /**
   * 断言：cond 为假时打印并 exit 1。
   * @param {unknown} cond
   * @param {string} msg
   */
  function assert(cond, msg) {
    if (!cond) { console.error(_c.red('[assert]'), msg); process.exit(1) }
  }

  /**
   * 断言 Vue SFC 文件含 defineOptions({...})。
   * @param {string} file
   */
  function assertVueHasName(file) {
    const s = S().readText(file)
    S().assert(/defineOptions\s*\(\s*\{/.test(s), `${file} 缺 defineOptions`)
  }

  /**
   * 断言文件包含 anchor；缺失打印并 exit 1。
   * @param {string} file
   * @param {string} anchor
   */
  function assertContains(file, anchor) {
    const s = require('node:fs').readFileSync(file, 'utf8')
    if (!s.includes(anchor)) { console.error(_c.red('[assertContains]'), `${file} missing: ${anchor}`); process.exit(1) }
  }

  /**
   * 断言文件不含 anchor；命中打印并 exit 1。
   * @param {string} file
   * @param {string} anchor
   */
  function assertNotContains(file, anchor) {
    const s = require('node:fs').readFileSync(file, 'utf8')
    if (s.includes(anchor)) { console.error(_c.red('[assertNotContains]'), `${file} has: ${anchor}`); process.exit(1) }
  }

  /**
   * [P3-2d] @mode: diff 显式声明：脚本用它标记本次为只读预览（服务端强制 read-only 沙盒）。
   * @param {object} obj
   */
  function writeDiffReport(obj) {
    console.log(`__AI_MODE_DIFF__${JSON.stringify(obj || {})}`)
    process.exit(0)
  }

  /**
   * ASK 状态：打印决策帧并 exit 2。
   * @param {string} question
   * @param {Array<unknown>} options
   * @param {string} [defaultId]
   */
  function exitNeedInput(question, options, defaultId) {
    console.log(`__AI_RUNNER_DECISION__${JSON.stringify({ question, options, default: defaultId })}`)
    process.exit(2)
  }

  /**
   * 缺文件状态：打印文件请求帧并 exit 4。
   * @param {string|string[]} paths
   */
  function exitNeedFiles(paths) {
    console.log(`__AI_NEED_FILES__${JSON.stringify({ paths: Array.isArray(paths) ? paths : [paths] })}`)
    process.exit(4)
  }

  return {
    log,
    exit,
    assert,
    assertVueHasName,
    assertContains,
    assertNotContains,
    writeDiffReport,
    exitNeedInput,
    exitNeedFiles,
    ok(msg) { console.log(_c.green('✓'), msg) },
    /**
     * [ok-json-v1] 结构化输出：等价 `ok(JSON.stringify(obj))`，但处理循环引用与超长截断。
     * [WHY] 全量日志（16,348 脚本）中 1714 次（10.48%）手写 `ok(JSON.stringify(...))`；
     *   拼接写法遇循环引用直接抛错、遇大对象把输出预算吃光（本会话多次被截断）。
     * @param {unknown} obj - 任意可序列化值
     * @param {{maxBytes?: number}} [opts] - maxBytes 默认 6000，超出截断并标注
     * @returns {void}
     */
    okJson(obj, opts = {}) {
      const maxBytes = opts.maxBytes || 6000
      const seen = new WeakSet()
      let text
      try {
        text = JSON.stringify(obj, (k, v) => {
          if (v && typeof v === 'object') {
            if (seen.has(v)) return '[circular]'
            seen.add(v)
          }
          return v
        }, 2)
      } catch (e) {
        text = `[unserializable] ${String((e && e.message) || e)}`
      }
      if (text === undefined) text = 'undefined'
      const bytes = Buffer.byteLength(text, 'utf8')
      if (bytes > maxBytes) {
        const cut = text.slice(0, maxBytes)
        text = `${cut}\n…[truncated: ${bytes} bytes, limit ${maxBytes}]`
      }
      console.log(_c.green('✓'), text)
    },
    skip(msg) { console.log(_c.yellow('!'), msg) },
    warn(msg) { console.log(_c.yellow('⚠'), msg) },
    err(msg) { console.error(_c.red('✗'), msg) },
  }
}

module.exports = { createOutputApi }
