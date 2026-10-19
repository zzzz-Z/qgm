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
  const { self, safeReaddir, globToRe, changelog: _changelog } = deps
  /** [affected-tests-v1] 门面自引用：walk 属 search 族，经 self 取避免反向 require。 */
  const S = () => self()

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

  /**
   * [affected-tests-v1] 受影响测试发现：按 import 图与路径字面量反查应跑的测试文件。
   * [WHY] 改完源码只知道跑全量（145 个测试文件）反馈太慢；精准跑子集是主流编程智能体的基本能力。
   * [CONSTRAINT] 双通道（静态 import 相对路径 + 文本里的 src/ 路径字面量），因为部分测试用
   *   createRequire + 拼接路径装载，纯静态 import 图会漏。两通道合并去重。
   * @param {string[]} changedFiles 改动文件（绝对或相对均可）
   * @param {{testsDir?: string, srcDir?: string, ext?: string[]|string}} [opts]
   * @returns {{tests: string[], matched: {test: string, reason: string, via: string}[], total: number}}
   */
  function affectedTests(changedFiles, opts) {
    const o = opts || {}
    const cwd = process.cwd()
    const testsDir = o.testsDir || 'packages/core/tests'
    const srcDir = o.srcDir || 'packages/core/src'
    const norm = p => path.relative(cwd, path.resolve(cwd, p)).replace(/\\/g, '/')
    const noExt = p => p.replace(/\.(ts|tsx|js|cjs|mjs)$/, '')
    const changedFull = new Set((changedFiles || []).map(p => norm(p)))
    const changed = new Set((changedFiles || []).map(p => noExt(norm(p))))

    /** 解析候选后缀，返回真实存在的文件路径；不存在返回 null。 */
    const resolveExt = (base) => {
      const cands = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.cjs`]
      const stripped = base.replace(/\.(js|mjs)$/, '')
      if (stripped !== base) cands.unshift(`${stripped}.ts`, `${stripped}.tsx`)
      for (const p0 of cands) {
        try { if (fs.statSync(path.resolve(cwd, p0)).isFile()) return norm(path.resolve(cwd, p0)) } catch {}
      }
      return null
    }
    /** 从一行里抽出被引用的模块路径；无则返回空串。零正则，避免多层转义。 */
    const specOf = (line) => {
      const keys = ['require(', 'from ', 'import ']
      for (const k of keys) {
        const i = line.indexOf(k)
        if (i < 0) continue
        const rest = line.slice(i + k.length)
        const q1 = rest.indexOf(String.fromCharCode(39))
        const q2 = rest.indexOf(String.fromCharCode(34))
        const qi = q1 < 0 ? q2 : (q2 < 0 ? q1 : Math.min(q1, q2))
        if (qi < 0) continue
        const qc = rest[qi]
        const end2 = rest.indexOf(qc, qi + 1)
        if (end2 < 0) continue
        return rest.slice(qi + 1, end2)
      }
      return ''
    }

    /** 展开单个文件的直接依赖（相对 import/require），返回归一化路径集。 */
    const depsOf = (file) => {
      const out = new Set()
      let txt
      try { txt = fs.readFileSync(path.resolve(cwd, file), 'utf8') } catch { return out }
      for (const line of txt.split(String.fromCharCode(10))) {
        if (!line.includes('require') && !line.includes('import')) continue
        const spec = specOf(line)
        if (!spec || spec[0] !== '.') continue
        const base = path.dirname(path.resolve(cwd, file))
        const r = resolveExt(norm(path.resolve(base, spec)))
        if (r) out.add(r)
      }
      return out
    }
    /** 传递闭包：BFS 展开至深度 3，覆盖 barrel 两跳。 */
    const closureOf = (test) => {
      const seen = new Set()
      let frontier = [test]
      for (let depth = 0; depth < 3; depth++) {
        const next = []
        for (const f of frontier) {
          for (const d of depsOf(f)) {
            if (seen.has(d)) continue
            seen.add(d)
            next.push(d)
          }
        }
        frontier = next
      }
      return seen
    }

    const tests = S().walk(testsDir, { ext: o.ext || ['.ts', '.mts', '.js'] })
    const out = []
    const seen = new Set()
    for (const t of tests) {
      const tNorm = norm(t)
      const txt = fs.readFileSync(t, 'utf8')
      let hit = null
      for (const c of changedFull) {
        const rel = path.relative(path.dirname(path.resolve(cwd, tNorm)), path.resolve(cwd, c)).replace(/\\/g, '/')
        if (txt.includes(c) || txt.includes(rel)) { hit = { test: tNorm, reason: c, via: 'literal' }; break }
      }
      if (!hit) {
        const clos = new Set([...closureOf(tNorm)].map(noExt))
        for (const c of changed) {
          if (clos.has(c)) { hit = { test: tNorm, reason: c, via: 'import' }; break }
        }
      }
      if (hit && !seen.has(hit.test)) { seen.add(hit.test); out.push(hit) }
    }
    return { tests: out.map(x => x.test), matched: out, total: out.length }
  }

  /**
   * [reflect-v1] 结构化反思：聚合变更集 / 受影响测试 / 看板状态，产出可执行判断。
   * [WHY] 差异不在「能改代码」，而在「改完知道自己漏了什么」；把静默失效变显式风险。
   * @param {{board?: {failed?: number, todo?: number, running?: number}, testsRun?: string[]}} [opts]
   *   board 由调用方传入（reflect 不发起网络请求，保持纯函数）；testsRun 是本轮已跑测试。
   * @returns {{changed: string[], shouldTest: string[], untested: string[], risks: {kind: string, detail: string}[], nextStep: string}}
   */
  function reflect(opts) {
    const o = opts || {}
    const changed = getChangedFiles()
    const shouldTest = changed.length ? affectedTests(changed).tests : []
    const ran = new Set(o.testsRun || [])
    const untested = shouldTest.filter(t => !ran.has(t))
    const risks = []
    if (untested.length) risks.push({ kind: 'untested', detail: `${untested.length} 个受影响测试未跑` })
    if (o.board && o.board.failed > 0) risks.push({ kind: 'board-failed', detail: `${o.board.failed} 个看板项失败` })
    if (o.board && o.board.running > 0) risks.push({ kind: 'board-running', detail: '仍有任务 running 未收口' })
    if (!changed.length) risks.push({ kind: 'no-change', detail: '变更集为空' })
    let nextStep = '无风险项，可收尾'
    if (untested.length) nextStep = `先跑受影响测试：${untested.slice(0, 3).join(', ')}`
    else if (risks.some(r => r.kind === 'board-failed')) nextStep = '处理看板失败项后再声明完成'
    else if (risks.some(r => r.kind === 'no-change')) nextStep = '确认 AI_RUNNER_CHANGED 注入'
    return { changed, shouldTest, untested, risks, nextStep }
  }
  return { readFiles, getChangedFiles, getProjectRoot, atomicWrite, affectedTests, reflect }
}

module.exports = { createFsApi }
