/* eslint-disable regexp/no-super-linear-backtracking, regexp/optimal-quantifier-concatenation -- markdown 任务行解析正则，复杂度固有 */
import fs from 'node:fs'
import path from 'node:path'
// AIRUNNER-BATCH4-1B-NO-CONFIG

/** 计划中的单个任务：编号、标题、状态 */
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

/**
 * 解析 Plan Todo
 * @param planPath - plan Path
 */
export function parsePlanTodo(planPath?: string): PlanTask[] {
  // [root-env-align-v1] 与 config.setRoot 对齐：setRoot 写 AI_RUNNER_ROOT，原实现只读 AIR_ROOT
  // 导致 standalone 切换工作区后 PLAN.md 仍从启动 cwd 读取（隐藏 bug）
  const base = process.env.AI_RUNNER_ROOT || process.env.AIR_ROOT || process.cwd()
  const p = planPath || path.join(base, 'PLAN.md')
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
  const SECTION_RE = /^###[^\S\n]+(\S[^\n]*)$/
  const NUM_RE = /^[^\S\n]*\d+\.[^\S\n]+\*\*([^*\n]+)\*\*(?:[：:][^\S\n]*(\S[^\n]*))?[^\S\n]*$/
  const CHECK_RE = /^[^\S\n]*-[^\S\n]*\[([ x])\][^\S\n]+(\S[^\n]*)[^\S\n]*$/i

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
