export interface Price { input: number, output: number }

/**
 * 单价表：input/output 均为「元 / token」。
 * 未列出的模型 estimateCost 返回 null（调用方显示 token 数不显示金额）。
 */
export const PRICING: Record<string, Price> = {
  'deepseek-chat': { input: 1e-6, output: 2e-6 },
  'deepseek-reasoner': { input: 4e-6, output: 16e-6 },
}

export interface Usage { prompt_tokens: number, completion_tokens: number }

export function estimateCost(model: string, usage: Usage): number | null {
  const p = PRICING[model]
  if (!p) return null
  const inTok = Math.max(0, Number(usage.prompt_tokens) || 0)
  const outTok = Math.max(0, Number(usage.completion_tokens) || 0)
  return inTok * p.input + outTok * p.output
}

export function formatCost(yuan: number | null): string {
  if (yuan === null || yuan === undefined) return '未知'
  if (!Number.isFinite(yuan)) return '未知'
  if (yuan < 0.01) return '<¥0.01'
  return '¥' + yuan.toFixed(2)
}
