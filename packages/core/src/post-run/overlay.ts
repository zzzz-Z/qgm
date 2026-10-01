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
 * [probe-redirect-v1] 根级 .ai-* 文件（如 AI 脚本探测生成的 .ai-probe.json）重定向到 .ai-runner/probe/
 * WHY: 探测产物落项目根会污染目标仓库 git status（用户截图反馈 product-manage 出现 .ai-probe.json / .ai-env-probe.json）
 * CONSTRAINT: 仅匹配根目录一层、且排除 .ai-runner 自身；子目录内的同名文件不动（可能是业务文件）
 * CHANGE-IMPACT: 被重定向文件的 diff / 回滚按重定向后路径记录；applyOverlay 与 readOverlayChanges 必须同一规则
 */
const AI_PROBE_ROOT_RE = /^\.ai-(?!runner[/\\]).+/

/**
 * 把根级 .ai-* 路径重写到 .ai-runner/probe/ 下；其他路径原样返回
 * @param rel 相对项目根的路径（正斜杠或平台分隔符）
 */
export function redirectProbePath(rel: string): string {
  return AI_PROBE_ROOT_RE.test(rel) ? `.ai-runner/probe/${rel}` : rel
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
    const dst = path.join(getRoot(), redirectProbePath(rel))
    try {
      if (v.op === 'delete') {
        // 目录（rmSync recursive）→ 整目录删除；文件 → unlink
        if (fs.existsSync(dst)) {
          if (v.dir || fs.statSync(dst).isDirectory()) fs.rmSync(dst, { recursive: true, force: true })
          else fs.unlinkSync(dst)
        }
      } else if (v.op === 'write' && v.data) {
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.writeFileSync(dst, Buffer.from(v.data, 'base64'))
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
    const rel = redirectProbePath(path.relative(getRoot(), abs).replace(/\\/g, '/'))
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue
    if (v.op === 'delete') out.push({ path: rel, type: 'deleted' })
    else if (v.op === 'write') out.push({ path: rel, type: before.has(rel) ? 'modified' : 'added' })
  }
  return out
}
