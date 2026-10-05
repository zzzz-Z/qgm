import vm from 'node:vm'

// 兼容多形态 shebang：BOM / 前导空白 / LF / CRLF / CR
// 剥离失败时，附带前 80 字符预览便于定位非法字符

// [truncation-detect-v1] §10 输出长度预算的**机制化**：把文档里的规劝变成可观测信号。
/** 单轮脚本行数上限（SYSTEM.md §10：单轮脚本源码 ≤ 300 行） */
export const MAX_SCRIPT_LINES = 300
/** 单轮脚本字节上限（SYSTEM.md §10：单轮脚本源码 ≤ 12 KB） */
export const MAX_SCRIPT_BYTES = 12 * 1024

/**
 * 「尾部被切断」的典型错误消息族
 * [WHY] 上游 max_tokens 截断与「AI 真写错了」在 stderr 里长得相似，但处理方式相反：
 *   截断是输出通道故障（禁止原地重试、应缩小本轮范围），逻辑错误才是需要修的可重试失败。
 * [CONSTRAINT] **不可单独使用**：`Invalid or unexpected token` 也可能是 AI 漏了个引号。
 *   必须叠加 hasUnclosedStructure 的结构判据（见 isTruncatedScript）。
 * [EVIDENCE] 2026-10-04 在 node 22.22 上实测各类形态（`.ai-runner/tmp/probe-truncation-msgs.mjs`）：
 *   截断族 → `Unexpected end of input`（截在括号/模板/参数中途）或
 *            `Invalid or unexpected token`（截在引号或块注释中途）；
 *   真语法错 → `Unexpected token '='` / `')'` / `'}'`，**与截断族零重叠**。
 *   故这里的正则只需覆盖实测到的两个消息 + V8 其他版本可能的等价措辞。
 */
const TRUNCATION_ERROR_RE
  = /Unexpected end of input|Unterminated (?:string|template|comment|regular expression)|Unclosed (?:parenthesis|bracket|brace)|Invalid or unexpected token/i

type ScanState = 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template'

// 引号字符用码位表示：本文件要同时处理单引号/双引号/反引号三种字面量，
// 直接写字面量会让源码里出现「引号套引号」的转义噪音（也更易被 formatter 改写）
const QUOTE_SINGLE = String.fromCharCode(39) // '
const QUOTE_DOUBLE = String.fromCharCode(34) // "
const QUOTE_BACKTICK = String.fromCharCode(96) // `

/**
 * 扫描源码，判断是否存在**未闭合的结构**（括号 / 引号 / 注释）
 * [WHY] 这是区分「被切断」与「写错了」的关键信号：截断必然留下未闭合结构，
 *   而 `const = ;` 这类真语法错是「结构闭合但非法」。只看错误消息会把两者混为一谈。
 * [CONSTRAINT] 纯字符扫描，不做语义解析。模板字面量里的 `${}` 不展开嵌套——对本判据无害：
 *   被截断的模板字面量同样以「未闭合」收场。转义序列（`\\x`）会被跳过。
 * [CHANGE-IMPACT] 结果只影响 truncated 标记（提示措辞与非熔断判定），**不参与 400 放行决策**
 * @param code 待扫描源码
 */
export function hasUnclosedStructure(code: string): boolean {
  const stack: string[] = []
  let state: ScanState = 'code'
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]
    const next = code[i + 1]
    if (state === 'line-comment') {
      // 行注释以换行收尾；源码末尾的行注释是正常的，不算未闭合
      if (ch === '\n' || ch === '\r') state = 'code'
      continue
    }
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') { state = 'code'; i++ }
      continue
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      const quote = state === 'single' ? QUOTE_SINGLE : state === 'double' ? QUOTE_DOUBLE : QUOTE_BACKTICK
      if (ch === '\\') { i++; continue }
      if (ch === quote) state = 'code'
      continue
    }
    // state === 'code'
    if (ch === '/' && next === '/') { state = 'line-comment'; i++; continue }
    if (ch === '/' && next === '*') { state = 'block-comment'; i++; continue }
    if (ch === QUOTE_SINGLE) { state = 'single'; continue }
    if (ch === QUOTE_DOUBLE) { state = 'double'; continue }
    if (ch === QUOTE_BACKTICK) { state = 'template'; continue }
    if (ch === '{' || ch === '(' || ch === '[') { stack.push(ch); continue }
    if (ch === '}' || ch === ')' || ch === ']') {
      const want = ch === '}' ? '{' : ch === ')' ? '(' : '['
      // 多余闭合（栈空或类型不匹配）同样是「结构不完整」的强信号
      if (stack.length === 0 || stack[stack.length - 1] !== want) return true
      stack.pop()
    }
  }
  // 末尾停在字符串/模板/块注释里 = 未闭合；停在行注释里是正常的
  if (state === 'single' || state === 'double' || state === 'template' || state === 'block-comment') return true
  return stack.length > 0
}

/**
 * 判定「这份脚本是在尾部被切断的」而不是「AI 写错了」
 * [WHY] 供 run.ts 把截断与普通语法错误分流：截断要回传「缩小范围重发」而非「重试」
 * [CONSTRAINT] 双判据缺一不可——只看消息会把漏引号误判为截断，只看结构会把 `const a = (` 当截断
 * [KNOWN-FP] 实测已确认的边界：AI 在首行漏写引号、其后还继续写了多行（如 `const s = 'abc` 后
 *   仍跟 3 行代码）时，受体的结构扫描与「截在引号中途」**完全同形**，本判据会判为截断。
 *   这里**故意不做**「未闭合结构起点须靠近文件尾」之类的启发式：它只会把误判方向反过来
 *   （长块注释被截断会漏判），而漏判截断的代价正是本次要修的原 bug（原地重发→再截断→熔断）。
 *   故判据取高召回：宁可有少量误报，也要覆盖真实的截断。误报的后果仅是提示改成「拆小重发」，
 *   仍然指向正确的动作。
 * @param code 脚本原文
 * @param errorMessage vm.Script 报出的错误消息
 */
export function isTruncatedScript(code: string, errorMessage: string): boolean {
  return TRUNCATION_ERROR_RE.test(errorMessage) && hasUnclosedStructure(code)
}

/** 脚本体积度量结果 */
export interface ScriptSize {
  /** 行数（按 \n / \r\n / \r 切分） */
  lines: number
  /** UTF-8 字节数 */
  bytes: number
  /** 是否超出 §10 预算（行数或字节任一超出即为 true） */
  overBudget: boolean
  maxLines: number
  maxBytes: number
}

/**
 * 度量脚本体积并与 §10 预算比对
 * [WHY] 截断发生时，「服务端收到了多大的脚本」是判断"是否本来就超预算"的唯一线索：
 *   到达的脚本已经接近甚至超过 12 KB，就说明 AI 这一轮本就不可能输出完。
 * [CONSTRAINT] **只度量不拦截**：脚本能完整到达就允许执行——按体积拒收会白白废掉一轮
 * @param code 脚本原文
 */
export function measureScriptSize(code: string): ScriptSize {
  const lines = code.length === 0 ? 0 : code.split(/\r\n|\r|\n/).length
  const bytes = new TextEncoder().encode(code).length
  return {
    lines,
    bytes,
    overBudget: lines > MAX_SCRIPT_LINES || bytes > MAX_SCRIPT_BYTES,
    maxLines: MAX_SCRIPT_LINES,
    maxBytes: MAX_SCRIPT_BYTES,
  }
}

/**
 * 用 node vm.Script 做语法预检（不执行）
 * [WHY] 语法错误是 AI 回填脚本最常见的形态；预检能提前报错避免污染 execute 阶段
 * [CONSTRAINT] 只做语法解析，不校验契约字段；多段尝试策略见函数体
 * [CHANGE-IMPACT] 返回结构被 run.ts 用于 400 提前拦截；truncated 为真时下游会走
 *   「输缩通道故障」文案而非普通重试；错误消息会作为 stderr 反馈给用户
 * @param code 待检脚本原文
 */
export function checkScriptSyntax(code: string): { ok: true } | { ok: false, error: string, truncated: boolean } {
  const tryParse = (src: string): string | null => {
    try {
      // eslint-disable-next-line no-new -- 仅做语法解析
      new vm.Script(src)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }

  // 1. 原样
  let err = tryParse(code)
  if (err === null) return { ok: true }

  // 2. 剥 BOM + 前导空白 + shebang 行
  const stripped = code
    .replace(/^\uFEFF/, '')
    .replace(/^\s*#![^\r\n]*(?:\r\n|\r|\n)?/, '')
  if (stripped !== code) {
    err = tryParse(stripped)
    if (err === null) return { ok: true }
  }

  // 3. 兜底：剥首行
  const nl = code.indexOf('\n')
  if (nl > 0 && nl < code.length - 1) {
    const rest = code.slice(nl + 1)
    const err2 = tryParse(rest)
    if (err2 === null) return { ok: true }
  }

  const preview = code.slice(0, 80).replace(/\r/g, '\\r').replace(/\n/g, '\\n')
  // [truncation-detect-v1] 结构与消息双判据；用**原文**做结构扫描（剥 shebang 不影响括号平衡）
  return { ok: false, error: `${err}（前 80 字符：${preview}）`, truncated: isTruncatedScript(code, err) }
}
