'use strict'

/** [api-ssot-v1] 本文件是本族 API 签名的唯一 SSOT；SYSTEM.md §3.2 与 ai-guard 注入只列「名字 + 常用项」，完整签名/返回/异常以本文件 JSDoc 为准。 */

/**
 * [helpers-misc-v1] 杂项族：行号切片读取 / cwd 断言 / 语法检查 / overlay 落盘 / 上下文断言。
 *
 * [WHY] 五者在语义上互不相关，但均只需 __AI__ 少量能力（err / exec）即可完成，
 * 放同文件避免为 5 个短函数各开一个文件（cohesion-over-budget-v1：按职责，不按行数）。
 *
 * [CONSTRAINT] require 单向：index.cjs -> misc.cjs；err 与 exec 由 deps 注入。
 */
const fs = require('node:fs')

/**
 * 创建杂项族 API。
 * @param {{err: Function, exec: Function}} deps err 走 __AI__.err 通道；exec 走 __AI__.exec
 * @returns {{dump: Function, cwdMust: Function, syntaxCheck: Function, flush: Function, assertCtx: Function}}
 */
function createMiscApi(deps) {
  const { err, exec } = deps

  /**
   * [dump-v1] 读文件并按 1-based 行号切片（from/to 越界自动夹紧到 [1, 总行数]）。
   *
   * [WHY] 用于「大文件仅 dump ±N 行」的读取纪律（SYSTEM.md §2 R1）。
   * @param {string} file
   * @param {number} from 起始行（1-based）
   * @param {number} to 结束行（1-based，含）
   * @returns {string} 形如「<行号>: <原文>」的多行文本
   */
  function dump(file, from, to) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    const s = Math.max(1, from | 0)
    const e = Math.min(lines.length, (to | 0) || lines.length)
    const out = []
    for (let i = s - 1; i < e; i++) out.push(`${i + 1}: ${lines[i]}`)
    return out.join('\n')
  }

  /**
   * [cwd-must-v1] cwd 前置断言：不符即 stderr 报错 + exit 2（overlay 全丢弃）。
   * @param {string} expected 期望 cwd
   * @returns {boolean} 相符恒 true
   */
  function cwdMust(expected) {
    const cwd = process.cwd()
    if (cwd !== expected) {
      err(`cwd mismatch: expected=${expected} actual=${cwd}`)
      process.exit(2)
    }
    return true
  }
  /**
   * [syntax-check-guard-v1] 入参友好化：路径误传 / SFC 传入时给出明确错误。
   *
   * [WHY] 传路径字符串 → vm.Script 把 /Users/... 的 / 当正则开头，抛 "Invalid regular expression flags"；
   * 传 .vue SFC 源码 → 因 <script> 标签报 Unexpected token 错。
   *
   * [CONSTRAINT] 只在入参为单行短文本且指向真实存在的文件时才短路，避免误伤正常代码。
   * @param {string} code 源码内容（不是路径）
   * @param {string} [filename] 用于报错信息的文件名
   * @returns {{ok: boolean, error?: string, code?: string, hint?: string}}
   */
  function syntaxCheck(code, filename) {
    const s = String(code)
    if (!s.includes('\n') && s.length < 500) {
      try { if (fs.existsSync(s)) return { ok: false, error: 'syntaxCheck 接收源码内容而非文件路径；请用 __AI__.readText(p) 读取后传入' } } catch { /* ignore */ }
    }
    if (/<script[\s>]|<template[\s>]|<style[\s>]/.test(s)) {
      return { ok: false, error: 'syntaxCheck 不支持 .vue SFC；请改用 __AI__.typeCheck' }
    }
    const TS_EXT_RE = /\.(?:ts|tsx|mts|cts|mjs)$/i
    const ESM_ERR_RE = /Cannot use import statement outside a module|Unexpected token '?export'?|Cannot use '?import\.meta'?/
    if (TS_EXT_RE.test(String(filename || ''))) {
      return {
        ok: false,
        code: 'UNSUPPORTED_LANG',
        error: `syntaxCheck 仅校验 CJS/JS 语法（vm.Script），${String(filename)} 不在支持范围内`,
        hint: '对 .ts/.tsx/.mjs 请用 __AI__.lint([file])（项目内 eslint）或 __AI__.typeCheck()（tsc/vue-tsc）',
      }
    }
    const vm = require('node:vm')
    try {
      const compiled = new vm.Script(s, { filename: filename || 'script.cjs' })
      void compiled
      return { ok: true }
    } catch (e) {
      const msg = String((e && e.message) || e)
      if (ESM_ERR_RE.test(msg)) {
        return {
          ok: false,
          code: 'UNSUPPORTED_LANG',
          error: `syntaxCheck 仅校验 CJS/JS 语法；此处失败是能力边界不是语法错误：${msg}`,
          hint: 'ESM/TS 请用 __AI__.lint([file])（项目内 eslint）或 __AI__.typeCheck()（tsc/vue-tsc）',
        }
      }
      return { ok: false, error: msg }
    }
  }

  /**
   * [flush-v1] 显式落盘：把本轮 overlay 写入真盘（供子进程校验）。
   *
   * [WHY] shell/exec 与 lint/typeCheck 都起真子进程、读真盘，看不见本轮 writeText 的内容。
   * [CONSTRAINT] ① 仅在 overlay 沙箱内可用；② 落盘后本轮失败不再回滚（与人工保存同语义）。
   * @returns {{ok: boolean, applied?: number, failed?: string[], error?: string}}
   */
  function flush() {
    const fn = globalThis.__AI_APPLY_OVERLAY
    if (typeof fn !== 'function') {
      return { ok: false, applied: 0, error: '当前不在 overlay 沙箱内（writeText 已直写真盘），无需 flush' }
    }
    return fn()
  }

  /**
   * [assert-ctx-v1] 前置断言：cwd / git 分支不符即 exit 2。
   *
   * [CONSTRAINT] git 分支校验走 exec（异步）；失败一律 stderr + exit 2。
   * @param {{cwd?: string, branch?: string}} [spec]
   * @returns {Promise<boolean>} 相符恒 true
   */
  async function assertCtx(spec) {
    spec = spec || {}
    const cwd = process.cwd()
    if (spec.cwd && cwd !== spec.cwd) {
      err(`assertCtx: cwd 期望 ${spec.cwd}，实际 ${cwd}`)
      process.exit(2)
    }
    if (spec.branch) {
      const r = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
      if (!r.ok) { err('assertCtx: git 命令失败'); process.exit(2) }
      const b = String(r.stdout || '').trim()
      if (b !== spec.branch) {
        err(`assertCtx: 分支期望 ${spec.branch}，实际 ${b}`)
        process.exit(2)
      }
    }
    return true
  }

  return { dump, cwdMust, syntaxCheck, flush, assertCtx }
}

module.exports = { createMiscApi }
