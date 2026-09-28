/** 单模型单价：input / output 均为「元 / token」 */
interface Price { input: number, output: number }

/**
 * 单价表（元 / token）
 * [CONSTRAINT] 未列出的模型 estimateCost 返回 null（调用方显示 token 数不显示金额）
 * [CHANGE-IMPACT] 修改单价需同步更新展示层期望值；此处不校验正负，仅做单位约定
 */
export const PRICING: Record<string, Price> = {
  'deepseek-chat': { input: 1e-6, output: 2e-6 },
  'deepseek-reasoner': { input: 4e-6, output: 16e-6 },
}

/** API 返回的用量统计；[CONSTRAINT] 字段命名沿用 OpenAI 兼容格式（snake_case） */
export interface Usage { prompt_tokens: number, completion_tokens: number }

/**
 * 按 token 用量估算费用
 * [CONSTRAINT] 未命中 PRICING 的模型返回 null（不报错），让 UI 有"无金额"分支
 * [WHY] tokens 用 Number() 强转并 Math.max(0, ...) 兜底，防 NaN / 负数导致金额异常
 * [CHANGE-IMPACT] 返回值单位为元；PRICING 表按元/token 定义，改动单位会破坏调用方格式化
 * @param model 模型 id（如 'deepseek-chat'）
 * @param usage 用量统计对象
 */
export function estimateCost(model: string, usage: Usage): number | null {
  const p = PRICING[model]
  if (!p) return null
  const inTok = Math.max(0, Number(usage.prompt_tokens) || 0)
  const outTok = Math.max(0, Number(usage.completion_tokens) || 0)
  return inTok * p.input + outTok * p.output
}

/**
 * 把金额格式化为展示串（¥x.xx 或 <¥0.01）
 * [WHY] 小额统一显示 <¥0.01，避免 ¥0.00 造成的"免费"误解
 * [CONSTRAINT] null / undefined / 非有限数统一返回 '未知'；不使用千分位分隔
 * @param yuan 金额（元）；null 表示模型未定价
 */
export function formatCost(yuan: number | null): string {
  if (yuan === null || yuan === undefined) return '未知'
  if (!Number.isFinite(yuan)) return '未知'
  if (yuan < 0.01) return '<¥0.01'
  return `¥${yuan.toFixed(2)}`
}
