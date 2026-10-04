import { cleanCode } from './codeCleaner'

interface ContextFile {
  path: string
  content: string
  error?: string
}
/** 代码清洗选项（contextBuilder 专用）；[CONSTRAINT] stripComments 与 stripBlankLines 独立生效，不影响行号映射（保留空行占位） */
// [naming-v1] 不叫 CleanOptions：utils/codeCleaner.ts 已有同名但独立的 interface，
// 两者都会被 auto-import dirs 扫描，同名会触发 unimport "Duplicated imports" 告警并静默二选一
export interface ContextCleanOptions {
  stripComments: boolean
  stripBlankLines: boolean
}

/**
 * 把单个文件渲染成 <file> 块（含行号）
 * [WHY] 行号前缀便于 AI 精确定位引用；cleaned 属性标注节省的字节数供人工核对清洗是否过度
 * [CONSTRAINT] keepLines 形参当前被 no-file-truncate-v1 显式忽略，保留以兼容未来按错误位置局部渲染
 * [CHANGE-IMPACT] header/numbered 格式是 AI 侧解析契约（油猴/模型 prompt 依赖），改动需同步使用方
 */
function renderFile(
  p: string,
  content: string,
  opts: ContextCleanOptions,
  keepLines?: Set<number>,
): string {
  // [no-file-truncate-v1] 用户要求：始终返回全文，不再按错误位置局部截断
  void keepLines
  const { code, savedBytes } = cleanCode(content, opts)
  const body = code.replace(/\n+$/, '')
  const lines = body.split('\n')
  // [ctx-attr-escape-v1] 报告 P2：p 含 " 会破坏 <file path="..."> 契约；先转义双引号
  const safePath = String(p).replace(/"/g, '&quot;')
  const cleanedAttr = savedBytes > 0 ? ` cleaned="${savedBytes}B"` : ''
  const header = `<file path="${safePath}" total_lines="${lines.length}"${cleanedAttr}>`
  const numbered = lines.map((l: string, i: number) => `${i + 1}| ${l}`).join('\n')
  return `${header}\n${numbered}\n</file>`
}
/**
 * 拼装完整上下文（不区分错误位置，所有文件全文入列）
 * [WHY] 无 lint/type 错误时的默认路径；每个文件块间补空行便于 AI 分隔解析
 * [CONSTRAINT] 顺序与 files 入参一致，不排序（调用方需自行保证依赖顺序）
 */
export function buildFullContext(files: ContextFile[], opts: ContextCleanOptions): string {
  const out: string[] = []
  for (const f of files) {
    if (f.error) out.push(`<file path="${String(f.path).replace(/"/g, '&quot;')}" error="${String(f.error).replace(/"/g, '&quot;')}"></file>`)
    else out.push(renderFile(f.path, f.content, opts))
    out.push('')
  }
  return out.join('\n')
}
/**
 * 拼装错误上下文（仅渲染已知错误位置，供 lint/type 修复场景使用）
 * [WHY] 与 buildFullContext 互补：错误场景下按 locs 精准渲染，减少无关上下文
 * [CONSTRAINT] errorLocations 键须为已规范化的 POSIX 路径；调用方混用 ./ 前缀时此函数会再试一次归一
 */
export function buildErrorContext(
  files: ContextFile[],
  errorLocations: Map<string, Set<number>>,
  opts: ContextCleanOptions,
): string {
  const out: string[] = []
  for (const f of files) {
    if (f.error) { out.push(`<file path="${String(f.path).replace(/"/g, '&quot;')}" error="${String(f.error).replace(/"/g, '&quot;')}"></file>`); out.push(''); continue }
    const norm = f.path.replace(/\\/g, '/')
    const locs = errorLocations.get(norm) || errorLocations.get(`./${norm}`) || new Set<number>()
    out.push(renderFile(f.path, f.content, opts, locs))
    out.push('')
  }
  return out.join('\n')
}

// AIRUNNER-BATCH16-3-SPLIT-ERR-LOCS: 实现已外移至 context-error-locations.ts
export { parseErrorLocations } from './context-error-locations.js'
