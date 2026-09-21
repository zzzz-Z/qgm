import { cleanCode } from './codeCleaner'
import { fallbackEstimate } from './tokenEstimator'

export const PROMPT_BUDGET = 32000
export const ERROR_WINDOW = 10
export const ERROR_HEAD = 20
export interface ContextFile {
  path: string
  content: string
  error?: string
}
export interface CleanOptions {
  stripComments: boolean
  stripBlankLines: boolean
}
function renderFile(
  p: string,
  content: string,
  opts: CleanOptions,
  keepLines?: Set<number>,
): string {
  const { code, savedBytes } = cleanCode(content, opts)
  const body = code.replace(/\n+$/, '')
  const lines = body.split('\n')
  const cleanedAttr = savedBytes > 0 ? ` cleaned="${savedBytes}B"` : ''
  const header = `<file path="${p}" total_lines="${lines.length}"${cleanedAttr}>`
  if (!keepLines) {
    const numbered = lines.map((l, i) => `${i + 1}| ${l}`).join('\n')
    return `${header}\n${numbered}\n</file>`
  }
  const show = new Set<number>()
  for (let i = 1; i <= Math.min(ERROR_HEAD, lines.length); i++) show.add(i)
  for (const n of keepLines) {
    for (let i = Math.max(1, n - ERROR_WINDOW); i <= Math.min(lines.length, n + ERROR_WINDOW); i++) show.add(i)
  }
  const sorted = [...show].sort((a, b) => a - b)
  const out: string[] = []
  let prev = 0
  for (const n of sorted) {
    if (prev && n > prev + 1) out.push('...')
    out.push(`${n}| ${lines[n - 1]}`)
    prev = n
  }
  return `${header}\n${out.join('\n')}\n</file>`
}
export function buildFullContext(files: ContextFile[], opts: CleanOptions): string {
  const out: string[] = []
  for (const f of files) {
    if (f.error) out.push(`<file path="${f.path}" error="${f.error}"></file>`)
    else out.push(renderFile(f.path, f.content, opts))
    out.push('')
  }
  return out.join('\n')
}
export function parseErrorLocations(text: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>()
  const re = /(?:\/|[A-Za-z]:[\\/])?[\w./\\@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|vue):(\d+)(?::(\d+))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const p = m[1].replace(/\\/g, '/')
    if (p.includes('node_modules')) continue
    if (p.startsWith('node:')) continue
    const n = Number(m[2])
    if (!Number.isFinite(n) || n <= 0) continue
    let set = out.get(p)
    if (!set) { set = new Set(); out.set(p, set) }
    set.add(n)
  }
  return out
}
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
export function enforceBudget(text: string): { ok: boolean, size: number, budget: number } {
  const size = fallbackEstimate(text)
  return { ok: size <= PROMPT_BUDGET, size, budget: PROMPT_BUDGET }
}
