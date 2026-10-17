// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] IIFE 物理切分片段，非独立模块；跨片段符号在单文件检查下不可见。
//   全部片段 TS 化完成、按拼回后的联合视图接线后再移除本 pragma。

/**
 * AI 回复容器定位与身份指纹。
 * [WHY] 早期实现硬编码 DeepSeek 的 .ds-assistant-message-main-content；
 *   其它站点取不到 ⇒ 退回整页 document，而整页末 300 字符是输入框/页脚，
 *   AI 流式期间恒定 ⇒ 签名不变 ⇒ 永不回传。改为按特异性递减的候选链。
 * [CONSTRAINT] 顺序即优先级：命中即取最后一个（最新一条回复）。
 *   全不命中返回 null，由调用方决定兜底策略（不得在此偷偷退回 document）。
 */

const ASSISTANT_ROOT_SELECTORS: string[] = [
  '.ds-assistant-message-main-content', // DeepSeek
  '[data-message-author-role="assistant"]', // ChatGPT
  '.chat-answers-card-wrap', // 千问 / 通义
  // [chatglm-adapter-v2] 智谱清言：保留原值 + answer-content 类名前缀变体 + answer-body 变体。
  //   原 .conversation-item .answer-content 未实测，实测症状「能发不能回」即该选择器 miss
  //   → 容器为 null → 签名退化为全页末 300 字符（恒定）→ 永不 post。
  // [CONSTRAINT] 必须排在末位（顺序即优先级）。
  '.conversation-item .answer-content, [class*="answer-content"], [class*="answer-body"]',
]

/** 最后一条 AI 回复容器；无回复时返回 null（新会话首轮思考阶段属于这种情况） */
function latestAssistantRoot(): Element | null {
  for (let i = 0; i < ASSISTANT_ROOT_SELECTORS.length; i++) {
    const els = document.querySelectorAll(ASSISTANT_ROOT_SELECTORS[i])
    if (els.length > 0) return els[els.length - 1]
  }
  return null
}

/** 当前 AI 回复块数量（按首个命中的候选选择器计）；选择器不可用时退化为 0，不启用依赖计数的兜底 */
function countAssistantRoots(): number {
  try {
    for (let i = 0; i < ASSISTANT_ROOT_SELECTORS.length; i++) {
      const els = document.querySelectorAll(ASSISTANT_ROOT_SELECTORS[i])
      if (els.length > 0) return els.length
    }
  } catch { /* 选择器不支持/文档未就绪：按 0 处理，不启用兜底 */ }
  return 0
}

/**
 * 最后一个 AI 回复根的身份指纹（文本长度 + 首 64 字符）。
 * [WHY] 单看根计数分不清三种「计数不变」：① 本轮没产出任何回复块（真停止）；
 *   ② regenerate 原地替换（旧根删、新根添）；③ 虚拟列表回收旧根同时挂新根。
 *   ②③ 的最后根身份必然变化，只有①原样不动——补上身份后「冻结」才等价于「没产出」。
 */
function assistantRootId(): string {
  try {
    const r = latestAssistantRoot()
    if (!r) return ''
    const t = String(r.textContent || '')
    return `${t.length}:${t.slice(0, 64)}`
  } catch { /* 取身份失败：返回空串，与 enterRootId='' 相等时不启用身份判据 */ return '' }
}

/**
 * 根冻结判据：进入生成时的计数与最后根身份均未变。
 * [CONSTRAINT] enterCount>0 门槛必须保留：首轮无根时不予判定
 *   （无根站点的思考期停止不可判，宁可不报也不误报）。
 * [CHANGE-IMPACT] 收紧只会让 stopped 更少推（更保守），不会新增误推。
 */
function rootsFrozenNow(enterCount: number, enterRootId: string, nowCount: number, nowRootId: string): boolean {
  return enterCount > 0 && nowCount === enterCount && nowRootId === enterRootId
}
