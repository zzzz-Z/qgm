// [ai-guard-v1] 硬执行器：pre-execution 原生 API 扫描 + __AI__ JSDoc 幂等注入

/** 扫描结果：是否命中禁用的 node 原生 API，以及命中的具体模式 */
export interface ScanResult {
  hit: boolean
  matches: string[]
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

/** 降级协议标记匹配：`// __AI__.xxx not found` 形式的显式豁免注释 */
const FALLBACK_RE = /\/\/\s*(?:[\u26A0!]\s*)?__AI__\.\w+\s+not found/i

/** 注入标识：命中后 injectAiJsdoc 幂等 */
const INJECT_MARK = '[__AI__-injected-v1]'

/** 注入到脚本顶部的 __AI__ API 速查 JSDoc */
const AI_JSDOC = [
  '/**',
  ' * [__AI__ 运行时沙箱]',
  ' * 禁用：node 原生 fs / path / child_process / os / process.exit',
  ' * 可用：__AI__.readText(p) / writeText(p, s) / exists(p) / readJSON(p)',
  ' *       __AI__.atomicWrite(p, s) / patchFile(p, { find, replace })',
  ' *       __AI__.join(...parts) / cwdMust() / listDir(p)',
  ' *       __AI__.ok(msg) / warn(msg) / err(msg) / skip(msg)',
  ' */',
].join('\n')

/** 剥离注释，避免把说明性文字里的 fs. 当调用命中 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
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
        reason: `ILLEGAL_SHEBANG: ${first.trim()}`
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
 * [CONSTRAINT] 先 stripComments 再匹配，避免注释内示例触发误报；命中规则在 FORBIDDEN 表
 * [CHANGE-IMPACT] 被 run-script 用于前置拦截；FORBIDDEN 表新增规则会波及既有脚本的兼容性
 * @param code 脚本源码原文
 */
export function scanNativeApis(code: string): ScanResult {
  const cleaned = stripComments(code)
  const matches: string[] = []
  for (const f of FORBIDDEN) {
    if (f.re.test(cleaned)) matches.push(f.name)
  }
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
  // [guard-v2] 先用 stripComments 处理整段再逐行——
  //   WHY: 旧实现只剥行尾 //，导致 injectAiJsdoc 注入的头部 JSDoc 内关键字被命中，
  //        每一条脚本都会被误报 NATIVE_API_FORBIDDEN，静态扫描形同虚设。
  //   [CONSTRAINT] fallback 检查必须用原始行（注释原文），否则降级协议标记会随注释一起被剥掉。
  //   [CHANGE-IMPACT] 影响所有经 run-script 前置校验的脚本；不再误伤含 JSDoc 的合规脚本。
  const stripped = stripComments(code)
  const strippedLines = stripped.split(/\r?\n/)
  const origLines = code.split(/\r?\n/)
  const matches: string[] = []
  for (let i = 0; i < strippedLines.length; i++) {
    const line = strippedLines[i]
    for (const f of FORBIDDEN) {
      if (f.re.test(line) && !hasFallbackNear(origLines, i)) {
        matches.push(`${f.name} @L${i + 1}`)
        break
      }
    }
  }
  return { hit: matches.length > 0, matches }
}

/** 将 __AI__ 速查 JSDoc 幂等注入脚本头部；保留 shebang 行在其后 */
export function injectAiJsdoc(code: string): string {
  if (code.includes(INJECT_MARK)) return code
  const block = `${AI_JSDOC}\n// ${INJECT_MARK}\n`
  const shebang = code.match(/^(#![^\n]*\n)/)
  if (shebang) return shebang[1] + block + code.slice(shebang[1].length)
  return block + code
}
