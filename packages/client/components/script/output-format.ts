// [script-output-utils-v1] 从 ScriptPanel.vue 抽出（PLAN 4.7 阈值整改）

/** 终端行首符号 → CSS class 映射 */
export function lineClass(line: string): string {
  const t = String(line).replace(/^\s+/, '')
  if (t.startsWith('▶')) return 'out-step'
  if (t.startsWith('✓')) return 'out-ok'
  if (t.startsWith('✗')) return 'out-err'
  if (t.startsWith('!')) return 'out-warn'
  if (t.startsWith('⚠')) return 'out-warn'
  if (t.startsWith('⋯')) return 'out-dim'
  return ''
}

/** 按需截断：ok 时短保尾；失败时保头 20 行 + 保尾 120 行，给更多证据 */
export function trimOutput(text: string, _ok: boolean, _okMax: number, _failMax: number, _ctx?: string): string {
  /* [no-truncate-v1] */
  // 用户要求：不再截断输出，直接返回全文
  return text || ''
}
