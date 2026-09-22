import { ref } from 'vue'
// AIRUNNER-BATCH20-2-FIX-HASH-SUFFIX: 补 .js 后缀
import { fnv1a8 } from '../../utils/hash.js'
import { useRunner } from './useRunner'
import { toast } from '../ui/useToast'
import { normalizeForHash, parseMeta } from './inbox-logic' // AIRUNNER-BATCH5-0C-INBOX-LOGIC

export interface InboxItem {
  id: string
  /** 脚本内容（不含 ```fence```） */
  code: string
  /** cjs | bash */
  lang: 'js' | 'cjs' | 'bash'
  /** 来源站点 origin（用于回溯） */
  site: string
  /** 归一化后的 hash（去 shebang/注释/空白），用于重复判定 */
  hash: string
  /** 解析自 AI 回复的 @desc（可能为空） */
  desc: string
  /** 解析自 AI 回复的 @why（可能为空） */
  why: string
  /** 到达时间戳 */
  ts: number
}

/**
 * 归一化脚本用于 hash 计算：
 * 去除 shebang 行、注释行（// 与 #）、所有空白字符。
 * 这样「等价变形」（仅注释/空白差异）能识别为同一脚本，
 * 避免通过改注释绕过「连续两轮相同」的重复判定。
 */

const inbox = ref<InboxItem[]>([])
/** 上次自动填入编辑器的内容；用于覆盖保护策略判断 */
let lastAutoFilled = ''

/**
 * 解析 AI 回复中首部的 @desc / @why 元注释（与 src/index.ts parseScriptMeta 对齐）。
 * cjs 用 //，bash 用 #。
 */

export interface PushOptions {
  code: string
  lang: 'js' | 'cjs' | 'bash'
  site: string
  /** 油猴传入的原始 hash（保留为元数据），重复判定始终用归一化 hash */
  hash?: string
}

/**
 * 油猴抓到 AI 脚本后调用此方法入队。
 * 同归一化 hash 在本会话已入队 → 跳过（不 toast、不入队），避免重复刷屏。
 *
 * hash 始终基于「去 shebang + 去注释 + 去空白」的归一化内容计算，
 * 防止 AI 仅改注释或空白绕过「连续两轮相同」的重复判定。
 */
export function push(opts: PushOptions): InboxItem | null {
  const code = opts.code
  if (!code.trim()) return null
  // 归一化 hash：忽略油猴传入的 hash，确保等价变形能识别为同一脚本
  const hash = fnv1a8(normalizeForHash(code))
  if (inbox.value.some(it => it.hash === hash)) {
    return null
  }
  const meta = parseMeta(code, opts.lang)
  const item: InboxItem = {
    id: `inb_${crypto.randomUUID().slice(0, 8)}`,
    code,
    lang: opts.lang,
    site: opts.site,
    hash,
    desc: meta.desc,
    why: meta.why,
    ts: Date.now(),
  }
  inbox.value = [...inbox.value, item]
  return item
}

/**
 * 取一条出队（消费）。返回被消费的 item，队列空时返回 null。
 */
export function consume(): InboxItem | null {
  if (!inbox.value.length) return null
  const [head, ...rest] = inbox.value
  inbox.value = rest
  return head
}

/** 根据 id 取一条出队（指定消费） */
export function consumeById(id: string): InboxItem | null {
  const idx = inbox.value.findIndex(it => it.id === id)
  if (idx < 0) return null
  const [item] = inbox.value.splice(idx, 1)
  return item
}

/** 清空 */
export function clearInbox() {
  inbox.value = []
}

export function peekAll(): InboxItem[] {
  return inbox.value
}

export function getLastAutoFilled(): string {
  return lastAutoFilled
}

export function setLastAutoFilled(code: string) {
  lastAutoFilled = code
}

/**
 * 覆盖策略（v6 §13.1）：
 * - 编辑器内容 === 上次自动填入的 → 直接覆盖，返回 'overwritten'
 * - 编辑器有用户手写内容 → 不覆盖，存 inbox + toast 带「取用」按钮，返回 'queued'
 */
export function applyToEditor(item: InboxItem): 'overwritten' | 'queued' | 'noop' {
  const runner = useRunner()
  const current = runner.script.value
  if (current === lastAutoFilled || current === '') {
    // 安全覆盖
    runner.script.value = item.code
    lastAutoFilled = item.code
    return 'overwritten'
  }
  // 用户有手写内容，保护
  toast(`AI 脚本已到达 · ${item.lang} · ${item.desc || '无说明'}`, 'info', 5000)
  return 'queued'
}

export function useScriptInbox() {
  return {
    inbox,
    push,
    consume,
    consumeById,
    clearInbox,
    peekAll,
    getLastAutoFilled,
    setLastAutoFilled,
    applyToEditor,
  }
}
