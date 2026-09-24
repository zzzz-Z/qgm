import { cleanCode } from './codeCleaner'
import { fallbackEstimate } from './tokenEstimator'

/** PROMPT_BUDGET（相关状态/数据） */
const PROMPT_BUDGET = 32000
// [deadcode-a2a1-v1] 已删常量 ERROR_WINDOW
// [deadcode-a2a1-v1] 已删常量 ERROR_HEAD

interface ContextFile {
  path: string
  content: string
  error?: string
}
/** cleanoptions（接口） */
export interface CleanOptions {
  stripComments: boolean
  stripBlankLines: boolean
}

/**
 * 渲染 File
 * @param p - p
 * @param content - content
 * @param opts - opts
 * @param keepLines - keep Lines
 */
function renderFile(
  p: string,
  content: string,
  opts: CleanOptions,
  keepLines?: Set<number>,
): string {
  // [no-file-truncate-v1] 用户要求：始终返回全文，不再按错误位置局部截断
  void keepLines
  const { code, savedBytes } = cleanCode(content, opts)
  const body = code.replace(/\n+$/, '')
  const lines = body.split('\n')
  const cleanedAttr = savedBytes > 0 ? ` cleaned="${savedBytes}B"` : ''
  const header = `<file path="${p}" total_lines="${lines.length}"${cleanedAttr}>`
  const numbered = lines.map((l: string, i: number) => `${i + 1}| ${l}`).join('\n')
  return `${header}\n${numbered}\n</file>`
}
/**
 * 构建 Full Context
 * @param files - files
 * @param opts - opts
 */
export function buildFullContext(files: ContextFile[], opts: CleanOptions): string {
  const out: string[] = []
  for (const f of files) {
    if (f.error) out.push(`<file path="${f.path}" error="${f.error}"></file>`)
    else out.push(renderFile(f.path, f.content, opts))
    out.push('')
  }
  return out.join('\n')
}
// AIRUNNER-BATCH16-3-SPLIT-ERR-LOCS: 实现已外移至 context-error-locations.ts

export { parseErrorLocations } from './context-error-locations.js'
/**
 * 构建 Error Context
 * @param files - files
 * @param errorLocations - error Locations
 * @param Set - Set
 * @param opts - opts
 */
export function buildErrorContext(
  files: ContextFile[],
  errorLocations: Map<string, Set<number>>,
  opts: CleanOptions,
): string {
  const out: string[] = []
  for (const f of files) {
    if (f.error) { out.push(`<file path="${f.path}" error="${f.error}"></file>`); out.push(''); continue }
    const norm = f.path.replace(/\\/g, '/')
    const locs = errorLocations.get(norm) || errorLocations.get(`./${norm}`) || new Set<number>()
    out.push(renderFile(f.path, f.content, opts, locs))
    out.push('')
  }
  return out.join('\n')
}
/**
 * 执行 enforce Budget
 * @param text - text
 */
export function enforceBudget(text: string): { ok: boolean, size: number, budget: number } {
  const size = fallbackEstimate(text)
  return { ok: size <= PROMPT_BUDGET, size, budget: PROMPT_BUDGET }
}
