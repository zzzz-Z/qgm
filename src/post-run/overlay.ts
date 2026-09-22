// overlay apply 与变更读取
import fs from 'node:fs'
import path from 'node:path'

function getRoot(): string {
  return process.env.AI_RUNNER_ROOT || process.env.AIR_ROOT || process.cwd()
}
// AIRUNNER-BATCH10-9-INLINE-ROOT: 内联类型与 root 派生，解除 config.js 依赖（strip-types 可加载）
export type ChangeType = 'added' | 'modified' | 'deleted'
export interface Change {
  path: string
  type: ChangeType
  afterLines?: number
}

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
