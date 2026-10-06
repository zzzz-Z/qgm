// [worklog-commit-v1] 从 WorklogPane.vue 抽出的 commit message 生成逻辑。
// [WHY] WorklogPane 超 §4 组件 500 行红线；AI 生成 + 本地启发式 + 超时门控自成体系。
// [CONSTRAINT] 依赖面由 WorklogPane 注入；本模块无 DOM 直接依赖，便于单测。
// [CHANGE-IMPACT] WorklogPane.vue 中 generateCommitMsg / generateLocalCommitMsg / extractCommitLine
//                 及其状态（aiGenerating / aiCommitMsg / aiError / pendingCommitRequest / pendingCommitSid）
//                 全部下沉到本模块。

import { ref } from 'vue'
import type { Ref } from 'vue'
import { copyAndFill } from '../../composables/ai/useAiWindow'
import { getActiveWinSid } from '../../composables/ai/useAiWindowTable'

export interface WorklogFileEntry {
  path: string
  status: string
  added: number
  removed: number
  diff?: string
}

export interface WorklogResult {
  ok: boolean
  reason?: string
  since: string
  until: string
  generatedAt: number
  files: WorklogFileEntry[]
  history: string[]
  stat: string
  markdown: string
}

interface UseWorklogCommitDeps {
  result: Ref<WorklogResult | null>
  commitMsg: Ref<string>
  load: () => Promise<void>
  getError: () => string
  splitPath: (p: string) => { dir: string, name: string }
}

/** 组装 commit msg 生成族（AI 优先 + 本地启发式 fallback） */
export function useWorklogCommit(deps: UseWorklogCommitDeps) {
  const { result, commitMsg, load, getError, splitPath } = deps
  const aiGenerating = ref(false)
  const aiCommitMsg = ref('')
  const aiError = ref('')
  const pendingCommitRequest = ref(false)
  const pendingCommitSid = ref('')
  let pendingTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * [commit-message-multiline-v1] 从 AI 回复文本提取完整 commit message（保留多行 body/footer）。
   * [WHY] 原 extractCommitLine 只取首行非空 → body/footer 全丢；用户要求完整回填输入框。
   * [CONSTRAINT] 只剥围栏行、首行列表/标题前缀、整段首尾反引号；body 里的列表原样保留。
   */
  function extractCommitMessage(text: string): string {
    const raw = String(text || '').replace(/\r\n?/g, '\n').trim()
    if (!raw) return ''
    const Q = String.fromCharCode(96)
    const FENCE = Q + Q + Q
    const lines = raw.split(String.fromCharCode(10)).filter(ln => !ln.trim().startsWith(FENCE))
    let msg = lines.join('\n').trim()
    while (msg.startsWith(Q) && msg.endsWith(Q) && msg.length > 1) {
      msg = msg.slice(1, -1).trim()
    }
    const arr = msg.split(String.fromCharCode(10))
    const firstIdx = arr.findIndex(ln => ln.trim().length > 0)
    // [commit-message-multiline-v2] 仅单行时剥列表/标题前缀；多行 message 保留首行原样
    //   （AI 生成的多行 body 首行若恰为列表项，剥前缀会改变语义）
    if (firstIdx >= 0 && arr.filter(ln => ln.trim().length > 0).length === 1) {
      arr[firstIdx] = arr[firstIdx].replace(/^(?:[-*+]\s+|#{1,6}\s+)/, '').trim()
    }
    return arr.join('\n').trim()
  }

  /** 从 AI 回复文本中提取单行 commit message（去围栏 / 列表前缀 / 首尾反引号） */
  function extractCommitLine(text: string): string {
    const raw = String(text || '').trim()
    if (!raw) return ''
    const Q = String.fromCharCode(96)
    const splitLines = raw.split(String.fromCharCode(10))
    for (const ln of splitLines) {
      const s = ln.trim()
      if (!s) continue
      if (s.startsWith(Q + Q + Q)) continue
      if (/^[-*+]\s/.test(s)) continue
      if (/^#+\s/.test(s)) continue
      const cleaned = s.replace(/^`+|`+$/g, '').trim()
      if (cleaned) return cleaned
    }
    return raw.split(String.fromCharCode(10))[0].trim()
  }

  /** 本地启发式 fallback：发送失败 / AI 超时时给用户一个草稿 */
  function generateLocalCommitMsg(): void {
    if (!result.value || !result.value.files?.length) return
    const files = result.value.files
    const isTest = (p: string): boolean => /\.(?:test|spec)\.[jt]sx?$/.test(p)
    const isDoc = (p: string): boolean => /\.(?:md|mdx)$/.test(p)
    const isStyle = (p: string): boolean => /\.(?:css|scss|sass|less)$/.test(p)
    const isConfig = (p: string): boolean => /\.(?:json|ya?ml|toml)$/.test(p)
    const isSource = (p: string): boolean => /\.(?:ts|tsx|js|jsx|vue|cjs|mjs)$/.test(p) && !isTest(p)
    const tests = files.filter(f => isTest(f.path))
    const docs = files.filter(f => isDoc(f.path))
    const styles = files.filter(f => isStyle(f.path))
    const configs = files.filter(f => isConfig(f.path))
    const sources = files.filter(f => isSource(f.path))
    let type = 'chore'
    if (files.length === tests.length) type = 'test'
    else if (files.length === docs.length) type = 'docs'
    else if (files.length === styles.length) type = 'style'
    else if (files.length === configs.length) type = 'chore'
    else if (sources.some(f => f.status === 'added')) type = 'feat'
    else if (sources.some(f => f.diff && /^[+-].*(?:fix|Fix|FIX|bug|Bug|BUG|hotfix)/m.test(f.diff))) type = 'fix'
    else if (sources.length > 0 && sources.every(f => f.status === 'deleted')) type = 'remove'
    else if (sources.length > 0) type = 'refactor'
    const dirs = new Set(files.map(f => splitPath(f.path).dir).filter(Boolean))
    let scope = ''
    if (dirs.size === 1) {
      const seg = ([...dirs][0].replace(/\/+$/, '').split('/').pop() || '')
      if (seg && seg !== '.') scope = seg
    }
    let summary = ''
    if (files.length === 1) {
      const f = files[0]
      const name = splitPath(f.path).name
      const action = f.status === 'added' ? 'add' : f.status === 'deleted' ? 'remove' : 'update'
      summary = `${action} ${name}`
    } else {
      const parts: string[] = []
      if (sources.length) parts.push(`${sources.length} src`)
      if (tests.length) parts.push(`${tests.length} test`)
      if (docs.length) parts.push(`${docs.length} doc`)
      if (styles.length) parts.push(`${styles.length} style`)
      if (configs.length) parts.push(`${configs.length} config`)
      summary = parts.length ? parts.join(', ') : `${files.length} files`
    }
    commitMsg.value = scope ? `${type}(${scope}): ${summary}` : `${type}: ${summary}`
  }

  /** 生成按钮入口：拉最新 diff → 拼 prompt → 发 AI；超时 / 失败时本地启发式兜底 */
  async function generateCommitMsg(): Promise<void> {
    aiError.value = ''
    aiGenerating.value = true
    await load()
    if (getError()) {
      aiGenerating.value = false
      aiError.value = `拉取 git diff 失败：${getError()}`
      return
    }
    if (!result.value || !result.value.files?.length) {
      aiGenerating.value = false
      aiError.value = '无变更可生成'
      return
    }
    const Q = String.fromCharCode(96)
    const FENCE = Q + Q + Q
    const prompt = [
      'ASK',
      '请根据我提供的代码变更，生成标准 Git commit message。',
      '【输入】变更内容（git diff）：',
      '【规则】',
      '1. 只输出 commit message 本身，不要解释、不要 markdown 代码块、不要前后缀。',
      '2. 格式：<type>(<scope>): <subject>；body/footer 可选。',
      '3. type 只能使用：feat、fix、docs、style、refactor、perf、test、build、ci、chore、revert。',
      '4. scope 可选，小写模块名。',
      '5. subject 一句话概括，英文祈使句现在时，不加句号；中文简洁。',
      '6. body 说明为什么改和改了什么，每行不超 72 字符。',
      '7. footer 用于 BREAKING CHANGE / Closes / Refs。',
      '8. 不要编造 issue 编号、scope、影响范围。',
      '',
      '变更内容（完整 git diff）：',
      '',
      `${FENCE}diff`,
      result.value.markdown,
      FENCE,
    ].join(String.fromCharCode(10))

    aiCommitMsg.value = ''
    pendingCommitRequest.value = true
    pendingCommitSid.value = getActiveWinSid() || 'default'
    if (pendingTimer) clearTimeout(pendingTimer)
    pendingTimer = setTimeout(() => {
      if (pendingCommitRequest.value) {
        pendingCommitRequest.value = false
        aiGenerating.value = false
        aiError.value = 'AI 回复超时（60 秒）'
        pendingTimer = null
      }
    }, 60_000)

    const r = await copyAndFill(prompt)
    if (r === 'failed') {
      pendingCommitRequest.value = false
      aiGenerating.value = false
      aiError.value = '发送失败：请检查 AI 窗口是否已就绪'
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null }
      generateLocalCommitMsg()
    }
  }

  /** 组件卸载时清理挂起定时器 */
  function cleanup(): void {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null }
  }

  return { aiGenerating, aiCommitMsg, aiError, pendingCommitRequest, pendingCommitSid, extractCommitLine, extractCommitMessage, generateLocalCommitMsg, generateCommitMsg, cleanup }
}
