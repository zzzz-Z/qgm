// [ai-guard-v1] 硬执行器：pre-execution 原生 API 扫描 + __AI__ JSDoc 幂等注入

/** 扫描结果：是否命中禁用的 node 原生 API，以及命中的具体模式 */
export interface ScanResult {
  hit: boolean
  matches: string[]
  /** [advisory-v1] 软提示：不阻断执行，随回执附给 AI */
  warnings?: string[]
}

export interface HeadResult {
  ok: boolean
  reason?: string
}

/** 原生 API 黑名单：fs / path / child_process / os / process.exit */
const FORBIDDEN: { name: string, re: RegExp }[] = [
  { name: 'require(fs)', re: /\brequire\s*\(\s*['"](?:node:)?fs['"]\s*\)/ },
  { name: 'import from fs', re: /\bimport\s+(?:[^\s;][^;\n]*)?\bfrom\s+['"](?:node:)?fs['"]/ },
  { name: 'fs.method', re: /\bfs\s*\.\s*[A-Za-z_$]/ },
  { name: 'require(child_process)', re: /\brequire\s*\(\s*['"](?:node:)?child_process['"]\s*\)/ },
  { name: 'import from child_process', re: /\bimport\s+(?:[^\s;][^;\n]*)?\bfrom\s+['"](?:node:)?child_process['"]/ },
  { name: 'require(os)', re: /\brequire\s*\(\s*['"](?:node:)?os['"]\s*\)/ },
  { name: 'import from os', re: /\bimport\s+(?:[^\s;][^;\n]*)?\bfrom\s+['"](?:node:)?os['"]/ },
  { name: 'path.method', re: /\bpath\s*\.\s*[A-Za-z_$]/ },
  // [guard-v2] exit 规则要求必须带调用括号：
  //   WHY: 字符串字面量 'process.exit' / JSDoc 里的提及 process.exit 均不应视为原生调用，
  //        旧正则把任意裸提及都判为命中而拦下合规脚本。
  //   [CHANGE-IMPACT] 引用式 const e = 'process.exit' 不再拦截（极罕见），其余路径不变。
  { name: 'process.exit', re: /\bprocess\s*\.\s*exit\s*\(/ },
]
// [advisory-v1] 软规则：命中只提示不拦截。全量日志（16,348 脚本）里这两类手写极高频，
//   但历史上确实存在合法用法（如需原始字节的 cat），故不能进 FORBIDDEN 的 400 通道。
const ADVISORY: { name: string, re: RegExp, hint: string }[] = [
  // [WHY] literals 存的是**去引号后的内容**（'sh'/-c/'cat foo.txt'），不是源码形态；正则按裸内容写。
  { name: 'shell-cat-file', re: /(?:^|\0)\s*(?:cat|head|tail)\s+\S/, hint: '读文件请用 __AI__.readText / dump，别用 sh -c cat（多一层进程与转义风险）' },
  { name: 'hardcoded-abs-path', re: /^\/Users\/[\w.-]+\//, hint: '硬编码绝对路径换机即废，请用 __AI__.getProjectRoot() 拼路径' },
]

/** 降级协议标记匹配：`// __AI__.xxx not found` 形式的显式豁免注释 */
const FALLBACK_RE = /\/\/\s*(?:[\u26A0!]\s*)?__AI__\.\w+\s+not found/i

/** 注入标识：命中后 injectAiJsdoc 幂等 */
const INJECT_MARK = '[__AI__-injected-v1]'

/**
 * 注入到脚本顶部的 __AI__ API 最小清单（每轮强制注入）。
 *
 * [api-surface-parity-v1] 本块是**每轮强制注入**的教学层，错了会直接教坏 AI。
 * 历史三处漂移（均已修，作为不再回退的锚点）：
 *   ① `patchFile(p, { find, replace })` —— 谎报对象参数（真实是位置参数）；
 *   ② `exists(p)` —— io.cjs 有实现但门面漏转发，照抄恒 TypeError；
 *   ③ `listDir(p)` —— 全仓无任何实现（幻觉 API），列目录用 `walk(p, { ext?, skip? })`。
 *
 * [design-v1] 为何瘦身：教学层与源码签名**双写**是历史漂移的根源（改一处漏一处）。
 * 本块只列**基础 + 易错**项；其余签名的唯一 SSOT 是 `packages/core/src/helpers/*.cjs`
 * 各文件顶部 JSDoc。AI 需要查具体签名时，用 `__AI__.grep('function <name>')` 或
 * `__AI__.readText('packages/core/src/helpers/<file>.cjs')` 读源码。
 *
 * [CONSTRAINT] 改本块前先实测：`require('./helpers.cjs')` 后读 `global.__AI__`，
 * 用真实 arity / 存在性对账，勿凭印象。api-surface-parity 守卫断言本块提到的 API 都存在。
 */
const AI_JSDOC = [
  '/**',
  ' * [__AI__ 运行时沙箱 · 基础 API]',
  ' * 禁用：node 原生 fs / path / child_process / os / process.exit',
  ' * 完整 API（含参数/返回/异常）见 packages/core/src/helpers/*.cjs 各文件顶部 JSDoc',
  ' * [CONSTRAINT] 不确定签名时**先查再写**：__AI__.grep(\'function xxx\') 或 readText 对应 helpers 文件；',
  ' *   凭记忆写签名是本会话 4 次返工的根因（syntaxCheck 当布尔 / shell 找 exit 字段 / readText 加 .catch）。',
  ' *',
  ' * 基础：readText(p) / writeText(p,s) / readJSON(p) / exists(p) / readFiles(glob)',
  ' *       grep(pattern, opts?) / walk(dir, {ext?,skip?}) / dump(file, from, to)',
  ' *       log / ok / warn / err / skip / exit(code, msg?)',
  ' *       okJson(obj, {maxBytes?}) ← 结构化输出；勿手写 ok(JSON.stringify(x))（循环引用会抛错）',
  ' *       shell(cmd, opts?) ← 异步须 await；字符串不做 shell 解析',
  ' *       shellStatus(id) / shellWait(id, {timeoutMs?}) ← 后者内部轮询到结束，勿手写 sleep 循环',
  ' *       probe(port, {path?,timeoutMs?}) ← 进程内 fetch 探活，勿用 curl（沙箱内会返 000）',
  ' *       testRun(files?, {timeoutMs?}) → {passed,failed,failedFiles[]}，勿从 stdout 截取判断',
  ' *       git.status() → {branch,modified,untracked,staged,clean}；git.recent(n) → 提交列表，勿手写 git status 解析',
  ' *',
  ' * 易错项（务必记住）：',
  ' *   patchFile(file, anchor, replacement, opts?) ← 位置参数；失配抛异常，不返 {ok:false}',
  ' *   replaceInFile(p, {oldString, newString}) ← 对象参数；与 patchFile 形态相反，勿混用',
  ' *   tryReadFile(p) → {ok, content?} 对象；readState() → 对象；两者都不是字符串',
  ' *   syntaxCheck(code, filename) ← 仅 CJS/JS；TS/ESM 返 UNSUPPORTED_LANG（能力边界非语法错）',
  ' *   flush() ← 沙箱内子进程读真盘，写入后先 flush 再让子进程校验',
  ' *   getProjectRoot() ← 拼路径一律用它；禁止硬编码 /Users/... 绝对路径（换机即废）',
  ' *   shell(\'sh\',\'-c\',\'cat x\') → 直接 readText(x) / dump(x,a,b)；shell 读文件多一层进程与转义风险',
  ' */',
].join('\n')

/** 词法剥离产物：可执行代码骨架 + 被剥离的字面量内容 */
export interface Tokenized {
  /** 字面量/注释内容替换为空格（换行保留）后的代码骨架 */
  code: string
  /** 所有字符串与模板字面量的内容原文（不含引号），供动态执行通道二次扫描 */
  literals: string[]
}

/** 这些关键字之后的 `/` 是正则起始而不是除号 */
const RE_PREFIX_WORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'case',
  'in',
  'of',
  'delete',
  'void',
  'do',
  'else',
  'yield',
  'await',
])

/** 上一有意义字符落在这些符号上时，`/` 是除号（前一个表达式已产出「值」） */
const RE_DIVISION_TAIL = /\w[$)\]'"`]/

/** 骨架以这些片段收尾时，紧随的字面量是 require / import 的模块名（语义参数，不剥） */
const MODULE_SPEC_TAIL = /(?:\brequire\s*\(|\bfrom|\bimport)\s*$/

/**
 * [ai-guard-tokenize-v2] 单遍词法剥离：把「字符串 / 模板字面量 / 正则字面量 / 注释」的内容
 * 替换为空格，只留下可执行代码骨架；**换行原样保留**。
 *
 * [WHY] 旧实现是 `stripComments(stripStrings(code))` 两步拼接，有两个结构性漏洞：
 *   ① 顺序漏洞：剥字符串时注释尚未移除 → 注释里的撇号（`// don't`）被当成字符串起始，
 *      一路吞到下一个撇号，把真实代码行一起吃掉（漏检，且无从察觉）。
 *   ② 行号错位：旧占位符 'STR'/'S' 不保留换行 → 跨行模板字面量让行数与原文不一致，
 *      scanNativeApisWithFallback 的 `@L<n>` 与降级标记回溯（hasFallbackNear）全部错位。
 *
 * [CONSTRAINT] 一个通道刻意**不剥离**：`require(...)` / `import ... from '...'` 的模块名。
 *   它是语义参数而非惰性文本——`const fs = require('fs')` 挖掉引号内容后就再也拦不住了。
 *   判别方式：看已产出骨架是否以 `require(` / `from` / `import` 收尾。
 * [CONSTRAINT] 正则字面量按「前一有意义字符不可能是值」判别；误判最坏只波及当前行
 *   （正则体不跨行）。注释与字面量都在同一遍里处理，故不存在「注释撇号吞代码」。
 * [CHANGE-IMPACT] 是 scanNativeApis / scanNativeApisWithFallback 的唯一前置步骤。
 *   语义变化：**写在普通字面量里的黑名单词不再拦截**（例如把测试源码当文本写入的那一排
 *   字符串、配置文件的原有代码）。这正是本改动的目的；eval / new Function 的实参仍会被
 *   执行，由 literals 二次扫描兜住。
 *
 * @param code 脚本源码原文
 */
export function tokenize(code: string): Tokenized {
  const src = String(code || '')
  const n = src.length
  const literals: string[] = []
  let out = ''
  let i = 0
  /** 最近一个非空白源码字符，用于区分正则与除号 */
  let prev = ''
  /** 正在累积的标识符 */
  let word = ''
  /** 上一个完整标识符（用于 `return /re/` 这类关键字后置正则） */
  let lastWord = ''

  const isWordChar = (c: string): boolean => /[\w$]/.test(c)
  const blankRun = (from: number, to: number): string => {
    let s = ''
    for (let k = from; k < to; k += 1) s += src[k] === '\n' ? '\n' : ' '
    return s
  }

  while (i < n) {
    const ch = src[i]

    // 行注释：剥到行尾（不含换行本身）
    if (ch === '/' && src[i + 1] === '/') {
      let j = i
      while (j < n && src[j] !== '\n') j += 1
      out += blankRun(i, j)
      i = j
      continue
    }

    // 块注释：整段替换为空格，内部换行保留
    if (ch === '/' && src[i + 1] === '*') {
      let j = i + 2
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j += 1
      j = Math.min(j + 2, n)
      out += blankRun(i, j)
      i = j
      continue
    }

    // 正则字面量
    if (ch === '/' && (!RE_DIVISION_TAIL.test(prev) || (word === '' && RE_PREFIX_WORDS.has(lastWord)))) {
      let j = i + 1
      let inClass = false
      while (j < n) {
        const c = src[j]
        if (c === '\\') { j += 2; continue }
        if (c === '\n') break
        if (c === '[') { inClass = true }
        else if (c === ']') { inClass = false }
        else if (c === '/' && !inClass) { j += 1; break }
        j += 1
      }
      out += blankRun(i, j)
      i = j
      prev = ')'
      lastWord = ''
      continue
    }

    // 字符串 / 模板字面量
    if (ch === '\'' || ch === '"' || ch === '`') {
      const q = ch
      let j = i + 1
      while (j < n) {
        const c = src[j]
        if (c === '\\') { j += 2; continue }
        if (c === q) break
        // 单双引号不跨行：未闭合时防御性停在行尾，避免吞掉后续真实代码
        if (q !== '`' && c === '\n') break
        j += 1
      }
      const closed = j < n && src[j] === q
      literals.push(src.slice(i + 1, j))
      // 模块名是语义参数，原样保留；其余字面量一律视为惰性文本
      const isModuleSpec = MODULE_SPEC_TAIL.test(out.slice(-40))
      const end = closed ? j + 1 : j
      out += (isModuleSpec && closed) ? src.slice(i, end) : blankRun(i, end)
      i = end
      prev = q
      lastWord = ''
      continue
    }

    out += ch
    if (isWordChar(ch)) {
      word += ch
      prev = ch
    }
    else if (/\s/.test(ch)) {
      if (word) { lastWord = word; word = '' }
    }
    else {
      if (word) { lastWord = word; word = '' }
      prev = ch
    }
    i += 1
  }

  return { code: out, literals }
}

/**
 * 动态执行通道：`eval('...')` / `Function('...')` 的实参是字符串却会被当作代码执行，
 * 故此时额外把「所有字面量的内容」按代码再扫一遍。
 * [CONSTRAINT] 只在骨架里真的出现调用时才启用——否则会把「要写入的文本」重新变成误报源。
 */
const DYNAMIC_EXEC_RE = /\beval\s*\(|\bFunction\s*\(/

/** 命中清单里的动态执行标记后缀（这些命中没有行号，因为来源是字面量内容） */
const EVAL_TAG = ' @eval'

function scanLiterals(literals: string[], matches: string[]): void {
  if (!literals.length) return
  const joined = literals.join('\n')
  for (const f of FORBIDDEN) {
    if (f.re.test(joined)) matches.push(`${f.name}${EVAL_TAG}`)
  }
}

/** 扫描脚本源码，返回是否命中禁用 API 及命中清单 */
// [script-head-contract-v1] 脚本头契约：shebang 唯一合法 + @desc/@why 必需
/** 校验脚本头：shebang 只允许 node；@desc 与 @why 必需 */
export function scanScriptHead(code: string): HeadResult {
  let first = String(code).split(/\r?\n/, 1)[0] || ''
  if (first.charCodeAt(0) === 0xFEFF) first = first.slice(1)
  if (first.startsWith('#!')) {
    const isNode = /^#!\s*\/usr\/bin\/(?:env\s+)?node\b/.test(first)
    if (!isNode) {
      return {
        ok: false,
        reason: `ILLEGAL_SHEBANG: ${first.trim()}`,
      }
    }
  }
  const hasDesc = /^[^\S\n]*(?:\/\/|#)[^\S\n]*@desc\b/m.test(code)
  const hasWhy = /^[^\S\n]*(?:\/\/|#)[^\S\n]*@why\b/m.test(code)
  if (!hasDesc) return { ok: false, reason: 'MISSING_DESC' }
  if (!hasWhy) return { ok: false, reason: 'MISSING_WHY' }

  return { ok: true }
}

/**
 * 扫描脚本源码中的禁用的原生 API 调用
 * [WHY] 沙箱运行时注入的是 __AI__ 命名空间，禁止直接 require fs / path / child_process；此扫描为编译前拦截
 * [CONSTRAINT] 先 tokenize 剥掉字面量与注释，只对代码骨架匹配；命中规则在 FORBIDDEN 表
 * [CHANGE-IMPACT] 被 run-script 用于前置拦截；FORBIDDEN 表新增规则会波及既有脚本的兼容性
 * @param code 脚本源码原文
 */
export function scanNativeApis(code: string): ScanResult {
  const { code: skeleton, literals } = tokenize(code)
  const matches: string[] = []
  for (const f of FORBIDDEN) {
    if (f.re.test(skeleton)) matches.push(f.name)
  }
  if (DYNAMIC_EXEC_RE.test(skeleton)) scanLiterals(literals, matches)
  return { hit: matches.length > 0, matches }
}

// [ai-guard-fallback-v2] 降级协议：显式标记才允许豁免原生 API
// 命中原生 API 的行，向上回溯 3 行内若出现 `// __AI__.xxx not found`，该行豁免
/** 从给定行向上回溯 lookback 行，判断是否出现降级协议标记 */
function hasFallbackNear(lines: string[], idx: number, lookback = 3): boolean {
  const from = Math.max(0, idx - lookback)
  for (let i = from; i <= idx; i++) {
    if (FALLBACK_RE.test(lines[i])) return true
  }
  return false
}

/** 带降级协议豁免的扫描：命中位置附近的显式降级标记可豁免该行 */
export function scanNativeApisWithFallback(code: string): ScanResult {
  // [guard-v2] 整段先做词法剥离再逐行——
  //   WHY: 旧实现只剥行尾 //，导致 injectAiJsdoc 注入的头部 JSDoc 内关键字被命中，
  //        每一条脚本都会被误报 NATIVE_API_FORBIDDEN，静态扫描形同虚设。
  //   [CONSTRAINT] fallback 检查必须用原始行（注释原文），否则降级协议标记会随注释一起被剥掉。
  //   [CONSTRAINT] tokenize 保留换行 → 骨架行号与原文行号一一对应，`@L<n>` 与回溯才可信。
  //   [CHANGE-IMPACT] 影响所有经 run-script 前置校验的脚本；不再误伤「把原生 API 当文本写入」的脚本。
  const { code: skeleton, literals } = tokenize(code)
  const skeletonLines = skeleton.split(/\r?\n/)
  const origLines = code.split(/\r?\n/)
  const matches: string[] = []
  for (let i = 0; i < skeletonLines.length; i++) {
    const line = skeletonLines[i]
    for (const f of FORBIDDEN) {
      if (f.re.test(line) && !hasFallbackNear(origLines, i)) {
        matches.push(`${f.name} @L${i + 1}`)
        break
      }
    }
  }
  if (DYNAMIC_EXEC_RE.test(skeleton)) scanLiterals(literals, matches)
  // [advisory-v1] 软提示：只收集不阻断
  const warnings: string[] = []
  for (const a of ADVISORY) {
    // [advisory-literal-v1] 必须匹配 literals 而非 skeleton：tokenize 会把字符串内容剥成空格，
    //   而 `sh -c cat` 与 `/Users/...` 恰恰都在字符串里（实测骨架为 `shell([    ,     ,    ])`）。
    if (a.re.test(literals.join(' \u0000 '))) warnings.push(`${a.name}: ${a.hint}`)
  }
  return { hit: matches.length > 0, matches, warnings }
}

/** 将 __AI__ 速查 JSDoc 幂等注入脚本头部；保留 shebang 行在其后 */
export function injectAiJsdoc(code: string): string {
  if (code.includes(INJECT_MARK)) return code
  const block = `${AI_JSDOC}\n// ${INJECT_MARK}\n`
  const shebang = code.match(/^(#![^\n]*\n)/)
  if (shebang) return shebang[1] + block + code.slice(shebang[1].length)
  return block + code
}
