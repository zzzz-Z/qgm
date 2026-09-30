// [skill-injector-v1] SYSTEM.md §11.8：网页层只做两件事 —— 抓取 AI 回复里的 ai-skill 围栏块 + 拼接到下次 prompt
// [WHY] §11.0 分工：AI 在对话里自己搜/拼 skill，网页层仅被动收集并转发给沙箱
// [CONSTRAINT] 不做搜索、不做筛选、不做裁剪、不校验来源；命中即缓存，未命中静默跳过
// [CHANGE-IMPACT] 被 App.vue 回复处理与 useAiWindow.copyAndFill 消费；缓存为模块级单例，刷新后丢失

import { ref } from 'vue'

/** 会话内已抓到的技能文本；同一会话只保留最新一次抓取结果（§11.1 触发上限 2 次由 AI 侧自律） */
const loadedSkill = ref('')

/**
 * 从围栏块抓取的匹配表达式
 * [CONSTRAINT] 仅匹配三反引号 + ai-skill 开头；块内可含任意字符（含换行）
 * [CHANGE-IMPACT] 与 SYSTEM.md §11.8 中约定的 ```ai-skill 完全对齐；改标记需同步文档
 */
const FENCE_RE = /```ai-skill[ \t]*\n([\s\S]*?)\n```/

/**
 * 从 AI 回复文本抓取技能内容
 * [WHY] §11.8 契约：AI 在回复里以 ```ai-skill 围栏块承载拼装好的 skill 文本
 * [CONSTRAINT] 命中即覆盖缓存（AI 后续块优先）；未命中不改动缓存；非字符串入参静默 no-op
 * [CHANGE-IMPACT] 返回布尔供调用方日志；不触发任何副作用（不落盘、不弹 toast）
 * @param text AI 回复全文（plain / multi / done 的 payload.text）
 * @returns true 表示本次命中并更新了缓存
 */
export function captureSkillFromReply(text: string): boolean {
  const t = typeof text === 'string' ? text : ''
  if (!t) return false
  const m = FENCE_RE.exec(t)
  if (!m || !m[1]) return false
  const body = m[1].trim()
  if (!body) return false
  loadedSkill.value = body
  return true
}

/**
 * 拼接技能段到 prompt 前
 * [WHY] §11.8 契约：每次发给沙箱的提示词前置拼入已加载技能，让沙箱消费
 * [CONSTRAINT] 无缓存时原样返回 prompt；缓存已存在时也保留原 prompt（不覆盖）
 * [CHANGE-IMPACT] 被 useAiWindow.copyAndFill 调用；拼接改变 prompt 长度，超预算由既有 trimPromptIfOverBudget 兜底
 * @param prompt 原始 prompt
 */
export function prependLoadedSkill(prompt: string): string {
  const s = loadedSkill.value
  if (!s) return prompt
  return `# 已加载技能（网页层自动携带）\n\n${s}\n\n${prompt}`
}

/** 只读探针：查看当前缓存的技能文本（调试 / 测试用） */
export function peekLoadedSkill(): string { return loadedSkill.value }

/** 清空缓存（会话切换 / 重置时调用） */
export function clearLoadedSkill(): void { loadedSkill.value = '' }

/** 组合式入口：直接透传模块级单例 */
export function useSkillInjector() {
  return { loadedSkill, captureSkillFromReply, prependLoadedSkill, peekLoadedSkill, clearLoadedSkill }
}
