import { ref } from 'vue'
import { useRunner } from './useRunner'
import { toast } from './useToast'

export interface InboxItem {
  id: string
  /** 脚本内容（不含 ```fence```） */
  code: string
  /** cjs | bash */
  lang: 'js' | 'cjs' | 'bash'
  /** 来源站点 origin（用于回溯） */
  site: string
  /** SHA-256 前 8 位（去重） */
  hash: string
  /** 解析自 AI 回复的 @desc（可能为空） */
  desc: string
  /** 解析自 AI 回复的 @why（可能为空） */
  why: string
  /** 到达时间戳 */
  ts: number
}

const inbox = ref<InboxItem[]>([])
/** 上次自动填入编辑器的内容；用于覆盖保护策略判断 */
let lastAutoFilled = ''

function sha256Short(text: string): string {
  // 同步、稳定的 32-bit FNV-1a 变种，截 8 hex 位。仅用于去重，不要求强抗碰撞。
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h = Math.imul(h ^ c, 0x1000193) >>> 0
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * 解析 AI 回复中首部的 @desc / @why 元注释（与 src/index.ts parseScriptMeta 对齐）。
 * cjs 用 //，bash 用 #。
 */
function parseMeta(code: string, lang: 'js' | 'cjs' | 'bash'): { desc: string, why: string } {
  const out = { desc: '', why: '' }
  const re = (lang === 'cjs' || lang === 'js')
    ? /^\s*\/\/\s*@(desc|why)\s*:\s*(.+)$/gm
    : /^\s*#\s*@(desc|why)\s*:\s*(.+)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    const k = m[1] === 'desc' ? 'desc' : 'why'
    if (!out[k]) out[k] = m[2].trim().slice(0, 200)
  }
  return out
}

export interface PushOptions {
  code: string
  lang: 'js' | 'cjs' | 'bash'
  site: string
  /** 显式 hash（油猴已算好时传入），否则本函数算 */
  hash?: string
}

/**
 * 油猴抓到 AI 脚本后调用此方法入队。
 * 同 hash 在本会话已入队 → 跳过（不 toast、不入队），避免重复刷屏。
 */
export function push(opts: PushOptions): InboxItem | null {
  const code = opts.code
  if (!code.trim()) return null
  const hash = opts.hash || sha256Short(code)
  if (inbox.value.some(it => it.hash === hash)) {
    return null
  }
  const meta = parseMeta(code, opts.lang)
  const item: InboxItem = {
    id: `inb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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
