import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './config.js'

export interface PlanTask {
  title: string
  done: boolean
  section?: string
}

/**
 * 解析 PLAN.md「## 二、待办」章节中的任务项。
 * 支持两种行格式：
 *   1. **标题**：描述    （编号 + 加粗标题，可带冒号描述）
 *   1. **标题**          （编号 + 加粗标题，无描述）
 *   - [ ] 标题          （markdown 复选框，未完成）
 *   - [x] 标题          （markdown 复选框，已完成）
 * 找不到「## 二、待办」章节时返回空数组。
 */
export function parsePlanTodo(planPath?: string): PlanTask[] {
  const p = planPath || path.join(ROOT, 'PLAN.md')
  let src = ''
  try { src = fs.readFileSync(p, 'utf8') } catch { return [] }
  const lines = src.split('\n')

  // 定位「## 二、待办」到下一个「## 」之间
  let secStart = -1; let secEnd = -1
  for (let i = 0; i < lines.length; i++) {
    if (secStart < 0 && /^##\s+二、待办/.test(lines[i])) { secStart = i; continue }
    if (secStart >= 0 && i > secStart && /^##\s/.test(lines[i])) { secEnd = i; break }
  }
  if (secStart < 0) return []
  if (secEnd < 0) secEnd = lines.length

  const out: PlanTask[] = []
  const SECTION_RE = /^###\s+(.+)$/
  const NUM_RE = /^\s*\d+\.\s+\*\*(.+?)\*\*(?:[：:]\s*(.*))?\s*$/
  const CHECK_RE = /^\s*-\s*\[([ x])\]\s+(.+?)\s*$/i

  let currentSection = ''
  for (let i = secStart + 1; i < secEnd; i++) {
    const l = lines[i]
    const secM = l.match(SECTION_RE)
    if (secM) { currentSection = secM[1].trim(); continue }
    const numM = l.match(NUM_RE)
    if (numM) {
      const title = numM[1].trim()
      const desc = (numM[2] || '').trim()
      const text = desc ? `${title}：${desc}` : title
      out.push({ title: text, done: false, section: currentSection })
      continue
    }
    const chkM = l.match(CHECK_RE)
    if (chkM) {
      out.push({ title: chkM[2].trim(), done: /x/i.test(chkM[1]), section: currentSection })
    }
  }
  return out
}
