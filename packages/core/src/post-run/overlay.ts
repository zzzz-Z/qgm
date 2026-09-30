// overlay apply 与变更读取
import fs from 'node:fs'
import path from 'node:path'

// AIRUNNER-BATCH10-9-INLINE-ROOT: 内联类型与 root 派生，解除 config.js 依赖（strip-types 可加载）

/** 文件变更类型：新增 / 修改 / 删除 */
export type ChangeType = 'added' | 'modified' | 'deleted'
/** 单个文件变更记录：类型、路径、差异内容 */
export interface Change {
  path: string
  type: ChangeType
  afterLines?: number
}

/**
 * 获取 Root
 */
function getRoot(): string {
  return process.env.AI_RUNNER_ROOT || process.env.AIR_ROOT || process.cwd()
}

/**
 * 应用 Overlay
 * @param overlayPath - overlay Path
 */
export function applyOverlay(overlayPath: string): { applied: number, failed?: string } {
  if (!fs.existsSync(overlayPath)) return { applied: 0 }
  let raw: string
  try { raw = fs.readFileSync(overlayPath, 'utf8') } catch { return { applied: 0 } }
  let entries: Record<string, { op: string, data: string | null, dir?: boolean }>
  try { entries = JSON.parse(raw) } catch { return { applied: 0 } }
  let applied = 0
  for (const [abs, v] of Object.entries(entries)) {
    const rel = path.relative(getRoot(), abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue
    try {
      if (v.op === 'delete') {
        // 目录（rmSync recursive）→ 整目录删除；文件 → unlink
        if (fs.existsSync(abs)) {
          if (v.dir || fs.statSync(abs).isDirectory()) fs.rmSync(abs, { recursive: true, force: true })
          else fs.unlinkSync(abs)
        }
      } else if (v.op === 'write' && v.data) {
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, Buffer.from(v.data, 'base64'))
      } else {
        continue
      }
      applied++
    } catch (e) {
      return { applied, failed: `${rel}: ${String(e)}` }
    }
  }
  return { applied }
}
/**
 * 从沙箱 overlay 文件解析出本次脚本试图写入的变更（未应用）
 * [WHY] 脚本失败时 overlay 已记录写意图；据此判定"dry-run 声称的变更"，供合规反馈与用户回看
 * [CONSTRAINT] overlay 键为绝对路径，需转换为项目内相对路径；越界路径会被跳过；读取 / 解析失败一律返回空数组
 * [CHANGE-IMPACT] type='modified'/'added' 由 before 是否命中该路径决定；调用方依赖此语义做 diff 展示
 * @param overlayPath overlay JSON 文件绝对路径
 * @param before 运行前全量内容映射（键为相对路径）
 */
export function readOverlayChanges(overlayPath: string, before: Map<string, string>): Change[] {
  if (!fs.existsSync(overlayPath)) return []
  let raw: string
  try { raw = fs.readFileSync(overlayPath, 'utf8') } catch { return [] }
  let entries: Record<string, { op: string, data: string | null, dir?: boolean }>
  try { entries = JSON.parse(raw) } catch { return [] }
  const out: Change[] = []
  for (const [abs, v] of Object.entries(entries)) {
    const rel = path.relative(getRoot(), abs).replace(/\\/g, '/')
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue
    if (v.op === 'delete') out.push({ path: rel, type: 'deleted' })
    else if (v.op === 'write') out.push({ path: rel, type: before.has(rel) ? 'modified' : 'added' })
  }
  return out
}
