'use strict'

/** [api-ssot-v1] 本文件是本族 API 签名的唯一 SSOT；SYSTEM.md §3.2 与 ai-guard 注入只列「名字 + 常用项」，完整签名/返回/异常以本文件 JSDoc 为准。 */

/**
 * [helpers-search-v1] 检索与读缓存族：walk / grep / symbol / dumpCtx / template / usedInTemplate / fileSig / readIfChanged。
 *
 * [WHY] 这些方法互相调用（symbol→grep→walk、usedInTemplate→template、readIfChanged→fileSig），
 * 为避免 require 反向，走工厂注入 deps（self 引用由 index.cjs 提供）。
 *
 * [CONSTRAINT] require 单向：index.cjs -> search.cjs；本文件禁止反向 require。
 */
const fs = require('node:fs')
const path = require('node:path')

/**
 * 创建检索与读缓存族 API。
 * @param {{self: () => object, safeReaddir: Function, esc: Function}} deps self 传函数避免装配期未就绪
 * @returns {object} 检索族方法集合，由 index.cjs 展开并入 __AI__
 */
function createSearchApi(deps) {
  const { self, safeReaddir, esc } = deps
  const S = () => self()
  /** [L6] 读缓存：文件内容未变则跳过重读（模块级 Map，进程内有效）。 */
  const _rcMem = {}

  /**
   * [top-freq-v1] 按行匹配后聚合统计频次，等价 `grep | sort | uniq -c | sort -rn`。
   *
   * [WHY 不复用 grep] grep 返回平铺行记录且有 300 条上限、默认 skip `.ai-runner`，
   *   做频次统计会同时失真与漏扫。本函数直接聚合，返回 `[{count, value}]`。
   *
   * @param {string|RegExp} pattern 行匹配正则
   * @param {{dir?: string, files?: string[], ext?: string[], skip?: string[], limit?: number, maxScan?: number, keyOf?: Function}} [opts]
   * @returns {Array<{count: number, value: string}>} 按频次降序
   */
  function topFreq(pattern, opts) {
    opts = opts || {}
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern)
    const files = opts.files || S().walk(opts.dir || process.cwd(), {
      ext: opts.ext || ['ts', 'tsx', 'vue', 'js', 'cjs', 'mjs', 'json', 'jsonl', 'md'],
      skip: opts.skip || [],
    })
    const limit = opts.limit || 20
    const maxScan = opts.maxScan || 200000
    const keyOf = typeof opts.keyOf === 'function' ? opts.keyOf : line => line.trim()
    const counter = new Map()
    let scanned = 0
    for (const f of files) {
      if (scanned >= maxScan) break
      let raw
      try { raw = fs.readFileSync(f, 'utf8') } catch { continue }
      if (typeof raw !== 'string') continue
      const fl = raw.split(String.fromCharCode(10))
      for (const line of fl) {
        re.lastIndex = 0
        if (!re.test(line)) continue
        scanned++
        const key = String(keyOf(line))
        counter.set(key, (counter.get(key) || 0) + 1)
        if (scanned >= maxScan) break
      }
    }
    const arr = []
    for (const [value, count] of counter) arr.push({ count, value })
    arr.sort((a, b) => b.count - a.count)
    return arr.slice(0, limit)
  }

  /**
   * 递归遍历目录，按扩展名与跳过清单过滤。
   *
   * [walk-ext-normalize-v1] opts.ext 自动去前导点（.ts → ts），防静默空匹配。
   * @param {string} dir 起始目录
   * @param {{skip?: string[], ext?: string[], maxDepth?: number}} [opts]
   * @returns {string[]} 命中的文件绝对路径列表
   */
  function walk(dir, opts) {
    opts = opts || {}
    const skip = new Set(opts.skip || ['.git', 'node_modules', 'dist', '.ai-runner', 'coverage', '.vite', '.npmrc', '.env', '.env.local', '.DS_Store'])
    const extRe = (() => { const e = Array.isArray(opts.ext) ? opts.ext.map(x => String(x).replace(/^\./, '')) : null; return e && e.length ? new RegExp(`\\.(${e.join('|')})$`) : null })()
    const maxDepth = opts.maxDepth || 6
    const out = []
    const go = function (p, d) {
      if (d > maxDepth) return
      let st; try { st = fs.statSync(p) } catch { return }
      if (st.isFile()) { if (!extRe || extRe.test(p)) out.push(p); return }
      let entries; try { entries = safeReaddir(p) } catch { return }
      for (const ent of entries) {
        if (skip.has(ent.name)) continue
        go(path.join(p, ent.name), d + 1)
      }
    }
    go(dir, 0)
    return out
  }

  /**
   * 在文件集合里按正则逐行匹配。
   *
   * [grep-g-fix] 每行前 re.lastIndex=0，避免 /g 全局正则复用 lastIndex 状态。
   * @param {string|RegExp} pattern
   * @param {{files?: string[], dir?: string, ext?: string[], max?: number}} [opts]
   * @returns {Array<{file: string, line: number, text: string}>} 命中的行记录列表
   */
  function grep(pattern, opts) {
    opts = opts || {}
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern)
    const files = opts.files || S().walk(opts.dir || process.cwd(), { ext: opts.ext || ['ts', 'tsx', 'vue', 'js', 'cjs', 'mjs'] })
    const maxHits = opts.max || 300
    const out = []
    for (const f of files) {
      if (out.length >= maxHits) break
      let raw
      try { raw = fs.readFileSync(f, 'utf8') } catch { continue }
      if (typeof raw !== 'string') continue
      const fl = raw.split(String.fromCharCode(10))
      for (let i = 0; i < fl.length; i++) {
        if (out.length >= maxHits) break
        re.lastIndex = 0
        if (re.test(fl[i])) {
          out.push({ file: path.relative(process.cwd(), f).replace(/\\/g, '/'), line: i + 1, text: fl[i].trim().slice(0, 200) })
        }
      }
    }
    return out
  }

  /**
   * 按标识符名（词边界）检索符号出现点。
   * @param {string} name
   * @param {object} [opts] 同 grep
   * @returns {Array<{file: string, line: number, text: string}>} 命中的行记录列表
   */
  /**
   * [symbol-semantic-v1] 定义位置检索：按语言常见声明形态匹配 name 的声明点。
   * [WHY] 既有 symbol() 只做 \bname\b 文本匹配，无法区分声明与引用；多文件重构需要定义点。
   * [CONSTRAINT] 纯正则轻量索引，不做 AST/LSP；宁可多报可疑点也不漏报。
   * @param {string} name 符号名
   * @param {{dir?: string, ext?: string[]|string, limit?: number}} [opts]
   * @returns {{file: string, line: number, text: string, kind: string}[]}
   */
  function findDefinition(name, opts) {
    const o = opts || {}
    const n = esc(name)
    const pats = [
      { kind: 'function', re: new RegExp(`(^|[^\\w$.])(?:async\\s+)?function\\s+${n}\\s*\\(`) },
      { kind: 'class', re: new RegExp(`(^|[^\\w$.])class\\s+${n}\\b`) },
      { kind: 'const', re: new RegExp(`(^|[^\\w$.])(?:const|let|var)\\s+${n}\\s*=`) },
      { kind: 'interface', re: new RegExp(`(^|[^\\w$.])interface\\s+${n}\\b`) },
      { kind: 'type', re: new RegExp(`(^|[^\\w$.])type\\s+${n}\\s*=`) },
    ]
    const files = S().walk(o.dir || process.cwd(), { ext: o.ext || ['.ts', '.tsx', '.js', '.cjs', '.mjs', '.vue'] })
    const limit = typeof o.limit === 'number' ? o.limit : 200
    const out = []
    for (const f of files) {
      let txt
      try { txt = fs.readFileSync(f, 'utf8') } catch { continue }
      const lines = txt.split(String.fromCharCode(10))
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!line.includes(name)) continue
        for (const p of pats) {
          if (p.re.test(line)) { out.push({ file: f, line: i + 1, text: line.trim().slice(0, 200), kind: p.kind }); break }
        }
        if (out.length >= limit) return out
      }
    }
    return out
  }

  /**
   * [symbol-semantic-v1] 引用检索：grep 全词匹配 + 标注是否定义行。
   * @param {string} name 符号名
   * @param {{dir?: string, ext?: string[]|string, limit?: number}} [opts]
   * @returns {{file: string, line: number, text: string, isDef: boolean}[]}
   */
  function findReferences(name, opts) {
    const normFile = f => path.resolve(f)
    const defs = findDefinition(name, Object.assign({ limit: 500 }, opts || {}))
    const defSet = new Set(defs.map(d => `${normFile(d.file)}:${d.line}`))
    const hits = S().grep(new RegExp(`\\b${esc(name)}\\b`), opts || {})
    const out = []
    for (const h of hits) {
      const key = `${normFile(h.file)}:${h.line}`
      out.push({ file: h.file, line: h.line, text: h.text, isDef: defSet.has(key) })
    }
    return out
  }

  /**
   * [symbol-semantic-v1] 重命名预演：收集引用并生成替换计划，不落盘。
   * [WHY] 落盘语义归 patchFile/overlay；此处只产出计划，避免绕过原子写与审计漏斗。
   * @param {string} name 旧名
   * @param {string} newName 新名
   * @param {{dir?: string, ext?: string[]|string, limit?: number}} [opts]
   * @returns {{changes: {file: string, line: number, text: string, isDef: boolean}[], total: number}}
   */
  function renameSymbol(name, newName, opts) {
    if (!newName || typeof newName !== 'string') throw new Error('renameSymbol: newName required')
    if (!/^[A-Z_$][\w$]*$/i.test(newName)) throw new Error('renameSymbol: newName must be a valid identifier')
    const refs = findReferences(name, opts)
    return { changes: refs, total: refs.length }
  }

  function symbol(name, opts) {
    const re = new RegExp(`\\b${esc(name)}\\b`)
    return S().grep(re, opts)
  }

  /**
   * 取指定行的上下文（上下各 n 行）。
   * @param {string} file
   * @param {number} line
   * @param {number} [n] 默认 10
   * @returns {string} 形如「<行号>: <原文>」的多行文本
   */
  function dumpCtx(file, line, n) {
    n = n || 10
    const fl = S().readText(file).split(String.fromCharCode(10))
    const s = Math.max(1, line - n)
    const e = Math.min(fl.length, line + n)
    const out = []
    for (let i = s; i <= e; i++) out.push(`${i}: ${fl[i - 1]}`)
    return out.join(String.fromCharCode(10))
  }

  /**
   * 抽取 .vue 文件的 template 段（含标签本身）；缺失返回空串。
   * @param {string} file
   * @returns {string} 模板段文本
   */
  function template(file) {
    const raw = S().readText(file)
    const a = raw.indexOf('<template>')
    const b = raw.lastIndexOf('</template>')
    if (a < 0 || b < 0 || b <= a) return ''
    return raw.slice(a, b + 11)
  }

  /**
   * 在 template 段中查找给定名字的出现（用于自动导入符号的模板校验）。
   * @param {string} file
   * @param {string[]} names
   * @returns {string[]} 命中的名字子集
   */
  function usedInTemplate(file, names) {
    const tpl = S().template(file)
    if (!tpl) return []
    return names.filter((n) => { return new RegExp(`\\b${esc(n)}\\b`).test(tpl) })
  }

  /**
   * 文件指纹（mtimeMs:size）；文件不存在返回空串。
   * @param {string} file
   * @returns {string} 「<mtimeMs>:<size>」形式
   */
  function fileSig(file) {
    try {
      const st = fs.statSync(file)
      return `${String(st.mtimeMs)}:${String(st.size)}`
    } catch { return '' }
  }

  /**
   * 若文件指纹与缓存一致返回 {content:null, changed:false}，否则重读并更新缓存。
   * @param {string} file
   * @returns {{content: string|null, changed: boolean, sig?: string, since?: number, firstRead?: boolean, reason?: string}}
   */
  function readIfChanged(file) {
    const key = path.relative(process.cwd(), file).replace(/\\/g, '/')
    const sig = S().fileSig(file)
    if (!sig) return { content: null, changed: false, reason: 'not-found' }
    const cache = _rcMem
    const prev = cache[key]
    if (prev && prev.sig === sig) {
      return { content: null, changed: false, sig, since: prev.at }
    }
    const content = fs.readFileSync(file, 'utf8')
    cache[key] = { sig, at: Date.now() }
    return { content, changed: true, sig, firstRead: !prev }
  }

  /**
   * 清空进程内读缓存。
   * @returns {boolean} 恒 true
   */
  function clearReadCache() {
    for (const k in _rcMem) delete _rcMem[k]
    return true
  }

  return {
    walk,
    grep,
    topFreq,
    symbol,
    findDefinition,
    findReferences,
    renameSymbol,
    dumpCtx,
    template,
    usedInTemplate,
    fileSig,
    readIfChanged,
    clearReadCache,
    /** 读缓存无落盘路径（内存态）。@returns {string} 固定 "(memory)" */
    _readCachePath() { return '(memory)' },
    /** 取读缓存 Map。@returns {object} 进程内读缓存 Map */
    readCacheMap() { return _rcMem },
    /** 合并写回读缓存。@param {object} m 待合并键值对 */
    _writeCacheMap(m) { for (const k in m) _rcMem[k] = m[k] },
  }
}

module.exports = { createSearchApi }
