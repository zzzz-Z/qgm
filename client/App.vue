<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ScriptPanel from './components/ScriptPanel.vue'
import GeneratePanel from './components/GeneratePanel.vue'
import TracePanel from './components/TracePanel.vue'
import { DEFAULT_URL, MODELS, getActiveWin, openDeepseek, useDeepseekUrl } from './composables/useDeepseekUrl'
import { useScriptInbox } from './composables/useScriptInbox'
import {
  currentLoopContext,
  isLoopActive,
  onNonScriptReply,
  onScriptArrival
} from './composables/useAutoLoop'
import { useSessionManager } from './composables/useSessionManager'
import { useToast } from './composables/useToast'
import { useTraceLog } from './composables/useTraceLog'
import { useCodeCleaner } from './composables/useCodeCleaner'
import { useRunner } from './composables/useRunner'
import ToastHost from './components/ToastHost.vue'
import TooltipHost from './components/TooltipHost.vue'

const SESSION_HISTORY_KEY = '__ai_session_history'
/** mock 通道（v6 §13.2 ?mock=1）：注入合成 message，无需打开真实 AI 站点即可自检整条链路 */
const MOCK_MODE = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('mock')
interface SessionEntry { id: string, url: string, title: string, createdAt: number, tokens?: number }
function loadHistory(): SessionEntry[] {
  try { const raw = localStorage.getItem(SESSION_HISTORY_KEY); return raw ? JSON.parse(raw) : [] } catch { return [] }
}
function saveHistory(h: SessionEntry[]) {
  try { localStorage.setItem(SESSION_HISTORY_KEY, JSON.stringify(h)) } catch {}
}
const sessionHistory = ref<SessionEntry[]>(loadHistory())
const ACTIVE_SESSION_KEY = '__ai_active_session_id'
function loadActiveSessionId(): string {
  try { return localStorage.getItem(ACTIVE_SESSION_KEY) || '' } catch { return '' }
}
const activeSessionId = ref<string>(loadActiveSessionId())
watch(activeSessionId, (v) => {
  try {
    if (v) localStorage.setItem(ACTIVE_SESSION_KEY, v)
    else localStorage.removeItem(ACTIVE_SESSION_KEY)
  } catch { }
})
const sidebarOpen = ref(false)
const settingsOpen = ref(false)
function addSessionToHistory(id: string, url: string, title: string) {
  const entry: SessionEntry = { id, url, title, createdAt: Date.now() }
  sessionHistory.value = [entry, ...sessionHistory.value.filter(s => s.id !== id)].slice(0, 50)
  saveHistory(sessionHistory.value)
}
function removeSessionFromHistory(id: string) {
  sessionHistory.value = sessionHistory.value.filter(s => s.id !== id)
  saveHistory(sessionHistory.value)
  if (activeSessionId.value === id) activeSessionId.value = ''
}
const TOKEN_LIMIT = 50000
function tokenPct(n?: number): number {
  if (!n) return 0
  return Math.min(100, Math.round((n / TOKEN_LIMIT) * 100))
}
function tokenLevel(n?: number): 'ok' | 'warn' | 'over' {
  if (!n) return 'ok'
  if (n >= TOKEN_LIMIT) return 'over'
  if (n >= TOKEN_LIMIT * 0.8) return 'warn'
  return 'ok'
}
function fmtTok(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
function formatSessionTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    const p = (n: number) => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}`
  }
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return '昨天'
  const diff = Math.floor((now.getTime() - ts) / 86400000)
  if (diff < 7) return `${diff}天前`
  return `${d.getMonth() + 1}/${d.getDate()}`
}
function clearHistory() {
  if (!sessionHistory.value.length) return
  if (!window.confirm('清空所有对话历史？此操作不可撤销')) return
  sessionHistory.value = []
  saveHistory([])
  activeSessionId.value = ''
}

const showNewSessionDialog = ref(false)
const editingSessionId = ref('')
const newSessionTitle = ref('')
const newSessionModel = ref('deepseek')
const newSessionUrl = ref('')
const dialogTitleRef = ref<HTMLInputElement | null>(null)
// dialog-autofocus-enter
function focusDialogTitle() {
  nextTick(() => {
    dialogTitleRef.value?.focus()
    dialogTitleRef.value?.select()
  })
}
function genWebSessionId(): string {
  return `s-${Math.random().toString(16).slice(2, 10)}`
}
function openNewSessionDialog() {
  editingSessionId.value = ''
  newSessionTitle.value = ''
  newSessionModel.value = modelId.value
  const m = MODELS.find(x => x.id === modelId.value)
  newSessionUrl.value = m ? m.url : DEFAULT_URL
  showNewSessionDialog.value = true
  focusDialogTitle()
}
function openEditSessionDialog(s: SessionEntry) {
  editingSessionId.value = s.id
  newSessionTitle.value = s.title || ''
  newSessionUrl.value = s.url || ''
  const m = MODELS.find(x => x.url === s.url)
  newSessionModel.value = m ? m.id : modelId.value
  showNewSessionDialog.value = true
  focusDialogTitle()
}
function closeNewSessionDialog() {
  showNewSessionDialog.value = false
  editingSessionId.value = ''
}
function onNewSessionModelChange() {
  const m = MODELS.find(x => x.id === newSessionModel.value)
  if (m) newSessionUrl.value = m.url
}
function confirmNewSession() {
  const url = newSessionUrl.value.trim()
  if (!url) return
  // 编辑模式
  if (editingSessionId.value) {
    const idx = sessionHistory.value.findIndex(x => x.id === editingSessionId.value)
    if (idx < 0) { closeNewSessionDialog(); return }
    const prev = sessionHistory.value[idx]
    const title = newSessionTitle.value.trim() || prev.title
    sessionHistory.value[idx] = { ...prev, url, title }
    sessionHistory.value = [...sessionHistory.value]
    saveHistory(sessionHistory.value)
    if (activeSessionId.value === editingSessionId.value) {
      setDeepseekUrl(url)
    }
    showNewSessionDialog.value = false
    editingSessionId.value = ''
    return
  }
  // 新建
  const id = genWebSessionId()
  const label = MODELS.find(x => x.id === newSessionModel.value)?.label || '新会话'
  const hhmm = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  const title = newSessionTitle.value.trim() || `${label} · ${hhmm}`
  setModel(newSessionModel.value)
  setDeepseekUrl(url)
  addSessionToHistory(id, url, title)
  activeSessionId.value = id
  const oldId = sessionId.value
  const text = `上一步会话总结：\n\n（粘贴 AI 的总结到这里）\n\n会话 ID: ${oldId}`
  navigator.clipboard.writeText(text).catch(() => { })
  resetSession()
  openDeepseek(url)
  showNewSessionDialog.value = false
  editingSessionId.value = ''
}
async function handoffToNextSession(s: SessionEntry) {
  const summary = generateHandoffSummary()
  try {
    await navigator.clipboard.writeText(summary)
  } catch {
    toast('复制失败，请手动复制', 'error')
    return
  }
  const id = genWebSessionId()
  const label = MODELS.find(x => x.url === s.url)?.label
    || MODELS.find(x => x.id === modelId.value)?.label
    || '新会话'
  const hhmm = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  const title = `${label} · 交接 ${hhmm}`
  const url = s.url || deepseekUrl.value
  addSessionToHistory(id, url, title)
  activeSessionId.value = id
  setDeepseekUrl(url)
  resetSession()
  openDeepseek(url)
  toast('交接总结已复制，新会话已创建', 'success')
}
function openSessionUrl(url: string) {
  if (url) openDeepseek(url)
}
function selectSession(s: SessionEntry) {
  activeSessionId.value = s.id
  if (s.url) setDeepseekUrl(s.url)
}

type Tab = 'run' | 'trace'
const tab = ref<Tab>('run')
const askOpen = ref(false)
const isEmbedded = typeof window !== 'undefined' && window.parent !== window
function collapsePanel() {
  if (!isEmbedded) return
  try {
    window.parent.postMessage({ type: 'ai-runner:close' }, '*')
  } catch { }
}
const KEY_THEME = '__ai_theme'
function loadTheme(): 'light' | 'dark' {
  try { return localStorage.getItem(KEY_THEME) === 'dark' ? 'dark' : 'light' } catch { return 'light' }
}
const theme = ref<'light' | 'dark'>(loadTheme())
watch(theme, (v) => {
  document.documentElement.setAttribute('data-theme', v)
  try { localStorage.setItem(KEY_THEME, v) } catch { }
}, { immediate: true })

const { url: deepseekUrl, setUrl: setDeepseekUrl, modelId, setModel } = useDeepseekUrl()
const headerUrl = computed(() => {
  const s = sessionHistory.value.find(x => x.id === activeSessionId.value)
  return s ? s.url : deepseekUrl.value
})

function onSessionIdMessage(e: MessageEvent) {
  const d = e.data
  if (!d) return

  // ============================================================================
  // 油猴 → 工作台：统一回复通道（v6 §3.1 ai-runner:reply）
  // kind: script（恰好 1 个新 cjs/bash 块）/ done（严格 DONE）/ plain（纯文本）/ multi（多块）
  // 安全约束（v6 §3.4）：origin 必须落在已知 AI 站点；source 优先比对 getActiveWin()
  // ============================================================================
  if (d.type === 'ai-runner:reply') {
    if (!isFromActiveAiSite(e)) return
    const kind = String(d.kind || '')
    if (kind === 'script') {
      const code = String(d.code || '')
      const lang = (d.lang === 'bash' ? 'bash' : 'cjs') as 'cjs' | 'bash'
      const site = String(d.site || e.origin || '')
      const item = scriptInbox.push({ code, lang, site, hash: d.hash ? String(d.hash) : undefined })
      if (item) {
        const lineCount = code.split('\n').length
        toast(`AI 脚本已到达 · ${lang} · ${lineCount} 行 · ${item.desc || '无说明'}`, 'info', 4000)
        // 决策链路：脚本到达事件入 TraceLog（v6 §3.2），循环中盖 loopId/loopRound
        addTrace({
          kind: 'script',
          summary: `📥 脚本到达 · ${lang} · ${lineCount} 行${item.desc ? ' · ' + item.desc : ''}`,
          payload: {
            script: code.slice(0, 4000),
            desc: item.desc,
            why: item.why,
            lang,
            hash: item.hash,
            ...currentLoopContext(),
          },
        })
        if (isLoopActive.value) {
          // 循环模式：状态机接管（不经编辑器覆盖策略）
          void onScriptArrival(item)
        } else {
          // 手动模式：覆盖保护后填入编辑器
          scriptInbox.applyToEditor(item)
        }
      }
      return
    }
    // done / plain / multi 仅循环模式消费
    if (isLoopActive.value) {
      void onNonScriptReply({
        kind: kind as 'done' | 'plain' | 'multi',
        count: Number(d.count) || 0,
      })
    }
    return
  }

  // 兼容旧版油猴（v1.2）的 ai-runner:script 单脚本消息
  if (d.type === 'ai-runner:script') {
    if (!isFromActiveAiSite(e)) return
    const code = String(d.code || '')
    const lang = (d.lang === 'bash' ? 'bash' : 'cjs') as 'cjs' | 'bash'
    const site = String(d.site || e.origin || '')
    const item = scriptInbox.push({ code, lang, site, hash: d.hash ? String(d.hash) : undefined })
    if (item) {
      if (isLoopActive.value) void onScriptArrival(item)
      else scriptInbox.applyToEditor(item)
    }
    return
  }

  // token-estimate 用固定 key 原地更新，防 MutationObserver 风暴（v6 §12.5）
  if (d.type === 'ai-runner:token-estimate') {
    if (activeSessionId.value) {
      const i = sessionHistory.value.findIndex(x => x.id === activeSessionId.value)
      if (i >= 0 && sessionHistory.value[i].tokens !== d.tokens) {
        sessionHistory.value[i] = { ...sessionHistory.value[i], tokens: Number(d.tokens) || 0 }
        sessionHistory.value = [...sessionHistory.value]
        saveHistory(sessionHistory.value)
      }
    }
    const tokens = Number(d.tokens) || 0
    if (tokens > 0) {
      const k = Math.max(0, tokens / 1000).toFixed(1)
      toast(`会话 token 约 ${k}k`, 'info', 3000, { key: 'ai-runner:token-estimate' })
      // 喂给循环状态机做 30k 增量熔断（v6 §6.9 第 4 条）
      setTokenEstimate(tokens)
    }
    return
  }

  if (d.type !== 'ai-runner:session-id' || !d.id) return
  if (!activeSessionId.value) return
  const idx = sessionHistory.value.findIndex(x => x.id === activeSessionId.value)
  if (idx < 0) return
  const m = MODELS.find(x => x.id === modelId.value)
  const url = m && m.sessionTemplate
    ? m.sessionTemplate.replace('{id}', encodeURIComponent(String(d.id)))
    : sessionHistory.value[idx].url
  if (url === sessionHistory.value[idx].url) return
  sessionHistory.value[idx] = { ...sessionHistory.value[idx], url }
  sessionHistory.value = [...sessionHistory.value]
  saveHistory(sessionHistory.value)
  setDeepseekUrl(url)
}

/** 油猴来源校验：origin 必须落在已知 AI 站点；source 优先比对 getActiveWin()，为 null 时降级只校验 origin */
function isFromActiveAiSite(e: MessageEvent): boolean {
  // mock 模式：跳过来源校验，让合成 MessageEvent 直走完整链路
  if (MOCK_MODE) return true
  const AI_ORIGINS = MODELS
    .map(m => { try { return new URL(m.url).origin } catch { return '' } })
    .filter(Boolean)
  if (!AI_ORIGINS.includes(e.origin)) {
    console.warn('[ai-runner] 来源 origin 非 AI 站点，已忽略', e.origin)
    return false
  }
  // e.source 可能为 null（窗口已关 / 跨域限制）；只在非 null 时比对
  if (e.source !== null) {
    const active = getActiveWin()
    if (active !== null && e.source !== active) {
      console.warn('[ai-runner] source 非当前循环窗口，已忽略')
      return false
    }
  }
  return true
}
function onEscClose(e: KeyboardEvent) {
  if (e.key === 'Escape' && askOpen.value) askOpen.value = false
}
onMounted(() => {
  window.addEventListener('message', onSessionIdMessage)
  window.addEventListener('keydown', onEscClose)
  // —— mock 通道（v6 §13.2 ?mock=1）—— 不打开真实 AI 站点，注入合成 message 自检整条链路
  // 注意：必须放在 activeSessionId 早退之前，否则无会话时无法触发
  if (MOCK_MODE) {
    toast('mock 模式已启用：将注入合成脚本，无需打开 AI 站点', 'warn', 6000)
    const fakeScript = [
      '#!/usr/bin/env node',
      '// @desc: 给所有 .vue 文件补 defineOptions({ name })',
      '// @why: P1 mock 自检 · 验证脚本到达 → 覆盖编辑器 → 运行 整条链路',
      "const fs = require('node:fs')",
      "const path = require('node:path')",
      "const files = fs.readdirSync('.').filter(f => f.endsWith('.vue'))",
      'for (const f of files) {',
      '  const p = path.join(".", f)',
      "  const src = fs.readFileSync(p, 'utf8')",
      '  if (!/defineOptions\\s*\\(\\s*{/.test(src)) {',
      '    const name = f.replace(/\\.vue$/, "")',
      '    const updated = src.replace(/<script setup lang="ts">/, `<script setup lang="ts">\\ndefineOptions({ name: ${JSON.stringify(name)} })`)',
      "    fs.writeFileSync(p, updated)",
      '    console.log("updated", f)',
      '  }',
      '}',
    ].join('\n')
    setTimeout(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'ai-runner:script',
          code: fakeScript,
          lang: 'cjs',
          hash: 'mock0001',
          site: 'https://chat.deepseek.com',
        },
        origin: 'https://chat.deepseek.com',
        source: window,
      }))
    }, 1200)
    return  // mock 模式下不需要拉会话历史 url
  }
  if (!activeSessionId.value) return
  const s = sessionHistory.value.find(x => x.id === activeSessionId.value)
  if (s && s.url && deepseekUrl.value !== s.url) {
    setDeepseekUrl(s.url)
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('message', onSessionIdMessage)
  window.removeEventListener('keydown', onEscClose)
})
const { sessionId, resetSession, generateHandoffSummary } = useSessionManager()
const { toast } = useToast()
const { stripComments, stripBlankLines, toggleStripComments, toggleStripBlankLines } = useCodeCleaner()
const { smokeEnabled, gitCommit } = useRunner()
const scriptInbox = useScriptInbox()
const { addTrace } = useTraceLog()
// 注意：getActiveWin 是 useDeepseekUrl 模块级导出，已在 import 中带入；这里无需再解构
</script>

<template>
  <header class="hdr">
    <div class="title">
      <span class="logo">⚡</span>
      <h1>AI Runner</h1>
      <span class="env">dev</span>
      <button
        v-if="isEmbedded"
        v-tooltip="'收起 AI Runner 面板（内嵌模式）'"
        class="collapse-btn"
        @click="collapsePanel"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="11 17 6 12 11 7" />
          <polyline points="18 17 13 12 18 7" />
        </svg>
        <span>收起</span>
      </button>
    </div>
    <div class="hdr-right">
      <button
        v-tooltip="theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'"
        class="theme-toggle"
        @click="theme = theme === 'dark' ? 'light' : 'dark'"
      >
        <span v-if="theme === 'dark'">☀</span>
        <span v-else>☾</span>
      </button>
      <button v-tooltip="settingsOpen ? '关闭设置' : '打开设置（去注释 / 去空行）'" class="settings-toggle" @click="settingsOpen = !settingsOpen">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      <button
        v-tooltip="'打开「问 AI」面板（拖文件 + 写问题 → 拼 prompt）'"
        class="ask-open-btn"
        @click="askOpen = true"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span>问 AI</span>
      </button>
      <div class="ds-url">
        <span v-tooltip="headerUrl || '（未选中会话）'" class="ds-value-static">{{ headerUrl || '（未选中会话）' }}</span>
      </div>
    </div>
  </header>

  <div v-if="settingsOpen" class="settings-mask" @click.self="settingsOpen = false">
    <div class="settings-card">
      <div class="settings-head">
        <span class="settings-title">设置</span>
        <button v-tooltip="'关闭设置'" class="settings-close" @click="settingsOpen = false">
          ×
        </button>
      </div>
      <div class="settings-body">
        <label v-tooltip="'发送前去掉注释（保护字符串字面量）'" class="settings-row">
          <span class="settings-label">去注释</span>
          <input type="checkbox" :checked="stripComments" @change="toggleStripComments(($event.target as HTMLInputElement).checked)">
        </label>
        <label v-tooltip="'发送前去掉空行'" class="settings-row">
          <span class="settings-label">去空行</span>
          <input type="checkbox" :checked="stripBlankLines" @change="toggleStripBlankLines(($event.target as HTMLInputElement).checked)">
        </label>
        <label v-tooltip="'脚本运行成功后无头访问 / 和 /__ai/，收集 pageerror / console.error / HTTP 4xx-5xx'" class="settings-row">
          <span class="settings-label">运行脚本冒烟</span>
          <input v-model="smokeEnabled" type="checkbox">
        </label>
        <label v-tooltip="'脚本运行前自动 git add -A && commit（仅 git 仓库生效）'" class="settings-row">
          <span class="settings-label">Git 保护</span>
          <input v-model="gitCommit" type="checkbox">
        </label>
      </div>
    </div>
  </div>
  <div v-if="showNewSessionDialog" class="ns-mask" @click.self="closeNewSessionDialog">
    <div class="ns-card">
      <div class="ns-head">
        <span class="ns-title">{{ editingSessionId ? '编辑会话' : '新建会话' }}</span>
        <button v-tooltip="'关闭'" class="ns-close" @click="closeNewSessionDialog">
          ×
        </button>
      </div>
      <div class="ns-body">
        <label class="ns-field">
          <span class="ns-label">名称</span>
          <input
            ref="dialogTitleRef"
            v-model="newSessionTitle"
            class="ns-input"
            spellcheck="false"
            placeholder="会话名称（留空自动生成）"
            @keydown.enter.prevent="confirmNewSession"
          >
        </label>
        <label class="ns-field">
          <span class="ns-label">模型</span>
          <select v-model="newSessionModel" class="ns-select" @change="onNewSessionModelChange">
            <option v-for="m in MODELS" :key="m.id" :value="m.id">
              {{ m.label }}
            </option>
          </select>
        </label>
        <label class="ns-field">
          <span class="ns-label">会话 URL</span>
          <input v-model="newSessionUrl" class="ns-input" spellcheck="false" placeholder="https://..." @keydown.enter.prevent="confirmNewSession">
        </label>
        <div class="ns-hint">
          <template v-if="editingSessionId">
            保存后立即生效，列表与 header 同步更新
          </template>
          <!-- custom-tooltip -->
          <template v-else>
            创建后：本地会话重置 → 新会话加入左侧列表 → 打开上方 URL
            <br>
            header 与「复制并跳转」等按钮会跟着切到此 URL
          </template>
        </div>
      </div>
      <div class="ns-actions">
        <button v-tooltip="'取消，不保存'" class="ns-btn ghost" @click="closeNewSessionDialog">
          取消
        </button>
        <button
          v-tooltip="editingSessionId ? '保存对该会话的修改' : '创建会话并打开配置的 URL'"
          class="ns-btn primary"
          :disabled="!newSessionUrl.trim()"
          @click="confirmNewSession"
        >
          {{ editingSessionId ? '保存' : '创建并打开' }}
        </button>
      </div>
    </div>
  </div>
  <div class="layout-row">
    <div
      class="sidebar-mask"
      :class="{ 'is-open': sidebarOpen }"
      @click="sidebarOpen = false"
    />
    <aside class="session-sidebar" :class="{ 'is-open': sidebarOpen }">
      <div class="sidebar-header">
        <span class="sidebar-title">对话列表</span>
        <span v-if="sessionHistory.length" class="sidebar-count">{{ sessionHistory.length }}</span>
        <div class="sidebar-actions">
          <button
            v-if="sessionHistory.length"
            v-tooltip="`清空全部 ${sessionHistory.length} 条会话历史（不可撤销）`"
            class="sidebar-icon-btn"
            @click="clearHistory"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
            </svg>
          </button>
          <button v-tooltip="'新建会话：填写名称 \\/ 模型 \\/ URL，创建并打开'" class="sidebar-new-btn" @click="openNewSessionDialog">
            +
          </button>
        </div>
      </div>
      <div v-if="sessionHistory.length" class="sidebar-list">
        <div
          v-for="s in sessionHistory"
          :key="s.id"
          v-tooltip="s.url || s.title || s.id"
          class="sidebar-item is-card"
          :class="{ 'is-active': s.id === activeSessionId }"
          @click="selectSession(s)"
          @dblclick.stop="openEditSessionDialog(s)"
        >
          <div class="sidebar-item-main">
            <div class="sidebar-item-title">
              {{ s.title || s.id }}
            </div>
            <div class="sidebar-item-meta">
              <span class="sidebar-item-id">{{ s.id }}</span>
              <span
                v-if="s.tokens"
                v-tooltip="`页面估算：${s.tokens.toLocaleString()} / 50,000 tok（${tokenPct(s.tokens)}%）`"
                class="sidebar-item-tokens"
                :class="{ warn: tokenLevel(s.tokens) === 'warn', over: tokenLevel(s.tokens) === 'over' }"
              >
                <span class="tok-bar"><span class="tok-fill" :style="{ width: `${tokenPct(s.tokens)}%` }" /></span>
                <span class="tok-num">{{ fmtTok(s.tokens) }}</span>
              </span>
              <span class="sidebar-item-time">{{ formatSessionTime(s.createdAt) }}</span>
            </div>
          </div>
          <button
            v-tooltip="'打开会话'"
            class="sidebar-item-open"
            @click.stop="openSessionUrl(s.url)"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
          <button
            v-tooltip="'总结到下一会话（复制总结 → 创建新会话）'"
            class="sidebar-item-handoff"
            @click.stop="handoffToNextSession(s)"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 12h13" />
              <polyline points="13 7 18 12 13 17" />
              <path d="M20 4v16" />
            </svg>
          </button>
          <button
            v-tooltip="'删除'"
            class="sidebar-item-del"
            @click.stop="removeSessionFromHistory(s.id)"
          >
            ×
          </button>
        </div>
      </div>
      <div v-else class="sidebar-empty">
        <div class="sidebar-empty-icon">
          💬
        </div>
        <div class="sidebar-empty-title">
          还没有历史会话
        </div>
        <div class="sidebar-empty-hint">
          点上方「新建会话」开始
        </div>
      </div>
    </aside>

    <div class="layout-main">
      <nav class="tabs">
        <button
          v-tooltip="sidebarOpen ? '收起对话列表' : '展开对话列表'"
          class="tabs-burger"
          @click="sidebarOpen = !sidebarOpen"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <button v-tooltip="'写脚本 -> 运行 -> 看 diff / 回滚'" :class="{ active: tab === 'run' }" @click="tab = 'run'">
          运行脚本
        </button>
        <button v-tooltip="'查看运行脚本 / 问 AI 的历史记录'" :class="{ active: tab === 'trace' }" @click="tab = 'trace'">
          会话记录
        </button>
      </nav>
      <main class="main">
        <ScriptPanel v-if="tab === 'run'" @open-ask="askOpen = true" />
        <TracePanel v-if="tab === 'trace'" />
      </main>
    </div>
  </div>
  <Teleport to="body">
    <Transition name="ask-modal">
      <div v-if="askOpen" class="ask-modal-mask" @click.self="askOpen = false">
        <div class="ask-modal-card">
          <div class="ask-modal-head">
            <span class="ask-modal-title">问 AI</span>
            <button v-tooltip="'关闭（Esc）'" class="ask-modal-close" @click="askOpen = false">×</button>
          </div>
          <div class="ask-modal-body">
            <GeneratePanel v-if="askOpen" @sent="askOpen = false" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
  <ToastHost />
  <TooltipHost />
</template>

<style scoped>
/* LAYOUT-FIX: 顶部栏和 tab 固定，内容区撑满剩余空间 */
.hdr {
  flex-shrink: 0;
  position: relative;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  /* tighten-spacing */
  padding: 8px 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.title {
  display: flex;
  align-items: center;
  gap: 10px;
}
.logo {
  font-size: 18px;
}
.title h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.2px;
}
.env {
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--primary-bg);
  color: var(--primary);
  font-size: 11px;
  font-weight: 600;
}

.tabs {
  flex-shrink: 0;
  /* tighten-spacing */
  padding: 0 18px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  display: flex;
  gap: 4px;
}
.tabs button {
  /* tighten-spacing */
  padding: 9px 4px;
  margin-right: 16px;
  background: none;
  border: 0;
  cursor: pointer;
  color: var(--text-2);
  font-size: 13px;
  font-weight: 500;
  border-bottom: 2px solid transparent;
  transition: 0.15s;
}
.tabs button:hover {
  color: var(--text);
}
.tabs button.active {
  color: var(--primary);
  border-bottom-color: var(--primary);
}

.main {
  flex: 1;
  min-height: 0;
  /* tighten-spacing */
  padding: 12px 14px;
  overflow: hidden;
}

.btn {
  padding: 6px 14px;
  font-size: 13px;
  border: 1px solid var(--border-2);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  transition: 0.15s;
}
.btn:hover {
  background: var(--surface-2);
}

.session-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--border-2);
  border-radius: 6px;
  background: var(--surface);
  font-size: 11px;
  font-family: var(--mono, monospace);
  color: var(--text-2);
  cursor: pointer;
  transition: 0.15s;
}
.session-badge:hover {
  background: var(--surface-2);
  color: var(--text);
}
.session-badge.warn {
  border-color: var(--warning, #f59e0b);
  color: var(--warning, #f59e0b);
}
.session-badge.limit {
  border-color: var(--danger, #ef4444);
  color: var(--danger, #ef4444);
  background: var(--danger-bg, #fef2f2);
}
.sess-id {
  font-weight: 600;
}
.sess-tok {
  color: var(--text-3);
}
.sess-flag {
  font-weight: 700;
}
.session-mask {
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  background: rgb(15 30 60 / 32%);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
}
.session-card {
  width: 480px;
  max-width: calc(100vw - 40px);
  background: var(--surface);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgb(15 30 60 / 24%);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.session-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.session-title {
  font-size: 14px;
  font-weight: 600;
}
.session-close {
  width: 24px;
  height: 24px;
  border: 0;
  background: transparent;
  color: var(--text-3);
  font-size: 18px;
  cursor: pointer;
}
.session-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}
.session-label {
  flex: 0 0 90px;
  color: var(--text-3);
}
.session-val {
  flex: 1;
  font-family: var(--mono, monospace);
  color: var(--text);
  word-break: break-all;
}
.session-input {
  flex: 1;
  padding: 4px 8px;
  font: 12px/1.4 var(--mono, monospace);
  border: 1px solid var(--border-2);
  border-radius: 4px;
  outline: 0;
}
.session-input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px rgb(37 99 235 / 15%);
}
.session-warn {
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--warning-bg, #fffbeb);
  color: var(--warning, #f59e0b);
  font-size: 12px;
}
.session-actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
.session-btn {
  flex: 1;
  padding: 8px 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: 0.15s;
  border: 1px solid var(--border-2);
  background: var(--surface);
  color: var(--text);
}
.session-btn.ghost:hover {
  background: var(--surface-2);
}
.session-btn.primary {
  background: var(--primary);
  color: #fff;
  border-color: transparent;
  box-shadow: 0 2px 6px rgb(37 99 235 / 28%);
}
.session-btn.primary:hover {
  transform: translateY(-1px);
}
.session-hint {
  font-size: 11px;
  color: var(--text-3);
  text-align: center;
}
.hdr-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.clean-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.clean-toggle input {
  margin: 0;
}

/* ---------- DeepSeek URL 配置 ---------- */
.ds-url {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border: 1px solid var(--border-2);
  border-radius: var(--radius-sm);
  background: var(--surface);
  font-size: 12px;
  max-width: calc(100vw - 520px);
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.ds-url.editing {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px rgb(37 99 235 / 15%);
}
.ds-label {
  color: var(--text-3);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.2px;
}
.ds-value {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  font: 12px/1.4 var(--mono);
  cursor: pointer;
  max-width: min(720px, 55vw);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ds-value:hover {
  color: var(--primary);
}
.ds-input {
  width: 260px;
  padding: 2px 4px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  font: 12px/1.4 var(--mono);
}
.ds-session {
  width: 180px;
  padding: 2px 6px;
  border: 0;
  border-left: 1px solid var(--border-2);
  outline: 0;
  background: transparent;
  color: var(--text);
  font: 12px/1.4 var(--mono);
}
.ds-session:focus {
  background: var(--surface-2);
}
.ds-session::placeholder {
  color: var(--text-3);
}
.theme-toggle {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--border-2);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-2);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  transition: 0.15s;
}
.theme-toggle:hover {
  color: var(--primary);
  border-color: var(--primary);
  background: var(--primary-bg);
}
.settings-toggle {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--border-2);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-2);
  cursor: pointer;
  transition: 0.15s;
}
.settings-toggle:hover {
  color: var(--primary);
  border-color: var(--primary);
  background: var(--primary-bg);
}
.settings-mask {
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  background: rgb(15 30 60 / 32%);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
}
.settings-card {
  width: 320px;
  max-width: calc(100vw - 40px);
  background: var(--surface);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgb(15 30 60 / 24%);
  padding: 16px 18px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.settings-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.settings-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.settings-close {
  width: 24px;
  height: 24px;
  border: 0;
  background: transparent;
  color: var(--text-3);
  font-size: 18px;
  cursor: pointer;
  line-height: 1;
}
.settings-close:hover {
  color: var(--danger);
}
.settings-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
  transition: background 0.12s;
}
.settings-row:hover {
  background: var(--surface-2);
}
.settings-label {
  font-size: 13px;
  color: var(--text);
}
.settings-row input {
  margin: 0;
  accent-color: var(--primary);
}

.layout-row {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
  /* tighten-spacing */
}
.layout-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.session-sidebar {
  /* tighten-spacing */
  width: 236px;
  flex-shrink: 0;
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.sidebar-header {
  display: flex;
  align-items: center;
  gap: 6px;
  /* tighten-spacing */
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  flex-shrink: 0;
}
.sidebar-title {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.6px;
}
.sidebar-count {
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--primary-bg);
  color: var(--primary);
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.sidebar-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
}
.sidebar-icon-btn {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--border-2);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-2);
  cursor: pointer;
  transition: 0.12s;
}
.sidebar-icon-btn:hover {
  border-color: var(--danger);
  color: var(--danger);
  background: var(--danger-bg);
}
.sidebar-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0 8px;
}
.sidebar-list::-webkit-scrollbar-track {
  background: transparent;
}
.sidebar-list::-webkit-scrollbar {
  width: 6px;
}
.sidebar-list::-webkit-scrollbar-thumb {
  background: var(--border-2);
  border-radius: 3px;
}
.sidebar-list::-webkit-scrollbar-thumb:hover {
  background: var(--text-3);
}
.sidebar-item {
  display: flex;
  align-items: center;
  gap: 6px;
  /* tighten-spacing */
  padding: 5px 8px 5px 10px;
  margin: 1px 4px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.1s;
  position: relative;
}
.sidebar-item:hover {
  background: var(--surface-2);
}
.sidebar-item:hover .sidebar-item-del,
.sidebar-item:hover .sidebar-item-open,
.sidebar-item:hover .sidebar-item-handoff,
.sidebar-item.is-active .sidebar-item-del,
.sidebar-item.is-active .sidebar-item-open,
.sidebar-item.is-active .sidebar-item-handoff {
  opacity: 1;
}
.sidebar-item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sidebar-item-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
}
.sidebar-item-title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sidebar-item-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--text-3);
  margin-top: 2px;
}
.sidebar-item-id {
  font-family: var(--mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}
.sidebar-item-time-row {
  display: flex;
  align-items: center;
  margin-top: 2px;
}
.sidebar-item-time {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  font-size: 10px;
  color: var(--text-3);
  opacity: 0.85;
}
.sidebar-item-tokens {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--primary-bg);
  color: var(--primary);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  font-size: 10px;
}
.sidebar-item-tokens.warn {
  background: var(--warning-bg);
  color: var(--warning);
}
.sidebar-item-tokens.over {
  background: var(--danger-bg);
  color: var(--danger);
}
.tok-bar {
  display: inline-block;
  width: 24px;
  height: 3px;
  border-radius: 2px;
  background: currentColor;
  opacity: 0.22;
  overflow: hidden;
  position: relative;
}
.tok-fill {
  display: block;
  height: 100%;
  background: currentColor;
  border-radius: 2px;
  transition: width 0.2s ease;
}
.tok-num {
  line-height: 1;
}
.sidebar-item.is-active {
  background: var(--surface);
  border-color: var(--primary);
  box-shadow:
    0 4px 12px rgb(79 70 229 / 14%),
    0 0 0 1px var(--primary);
}
.sidebar-item.is-active .sidebar-item-title {
  color: var(--primary);
  font-weight: 600;
}
.sidebar-item-open {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  opacity: 0;
  transition: 0.12s;
  padding: 0;
}
.sidebar-item-open:hover {
  color: var(--primary);
  background: var(--primary-bg);
}
.sidebar-item-handoff {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  opacity: 0;
  transition: 0.12s;
  padding: 0;
}
.sidebar-item-handoff:hover {
  color: var(--primary);
  background: var(--primary-bg);
}
.sidebar-item-del {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-3);
  font-size: 14px;
  cursor: pointer;
  opacity: 0;
  transition: 0.12s;
}
.sidebar-item-del:hover {
  color: var(--danger);
  background: var(--danger-bg);
}
.sidebar-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--text-3);
  font-size: 12px;
  padding: 24px 12px;
  text-align: center;
}
.sidebar-empty-icon {
  font-size: 24px;
  opacity: 0.5;
  margin-bottom: 2px;
}
.sidebar-empty-title {
  font-size: 12px;
  color: var(--text-2);
  font-weight: 500;
}
.sidebar-empty-hint {
  font-size: 11px;
  color: var(--text-3);
  opacity: 0.8;
}
.sidebar-new-btn {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--border-2);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-2);
  font-size: 14px;
  line-height: 1;
  font-weight: 700;
  cursor: pointer;
  transition: 0.12s;
  font-family: inherit;
}
.sidebar-new-btn:hover {
  background: var(--primary-bg);
  border-color: var(--primary);
  color: var(--primary);
}
.ns-mask {
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  background: rgb(15 30 60 / 32%);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
}
.ns-card {
  width: 460px;
  max-width: calc(100vw - 40px);
  background: var(--surface);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgb(15 30 60 / 24%);
  padding: 18px 20px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ns-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.ns-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.ns-close {
  width: 24px;
  height: 24px;
  border: 0;
  background: transparent;
  color: var(--text-3);
  font-size: 18px;
  cursor: pointer;
  line-height: 1;
}
.ns-close:hover {
  color: var(--danger);
}
.ns-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ns-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ns-label {
  font-size: 11px;
  color: var(--text-3);
  font-weight: 500;
}
.ns-input,
.ns-select {
  width: 100%;
  padding: 6px 10px;
  font: 12px/1.4 var(--mono, monospace);
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border-2);
  border-radius: 6px;
  outline: 0;
  box-sizing: border-box;
}
.ns-select {
  font-family: inherit;
  cursor: pointer;
}
.ns-input:focus,
.ns-select:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px rgb(37 99 235 / 15%);
}
.ns-hint {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.6;
  padding: 8px 10px;
  background: var(--surface-2);
  border-radius: 6px;
}
.ns-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.ns-btn {
  padding: 7px 16px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: 0.15s;
  font-family: inherit;
}
.ns-btn.ghost {
  border: 1px solid var(--border-2);
  background: var(--surface);
  color: var(--text);
}
.ns-btn.ghost:hover {
  background: var(--surface-2);
}
.ns-btn.primary {
  border: 0;
  background: var(--primary);
  color: #fff;
  box-shadow: 0 2px 6px rgb(37 99 235 / 28%);
}
.ns-btn.primary:hover:not(:disabled) {
  background: var(--primary-hover);
  transform: translateY(-1px);
  box-shadow: 0 6px 16px rgb(37 99 235 / 32%);
}
.ns-btn.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ds-value-static {
  padding: 0 2px;
  color: var(--text);
  font: 12px/1.4 var(--mono, monospace);
  max-width: min(720px, 55vw);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: default;
  user-select: text;
}
/* ============ 响应式布局 ============ */
.tabs-burger {
  display: none;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  margin: 5px 6px 5px 0;
  padding: 0;
  border: 1px solid var(--border-2);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-2);
  cursor: pointer;
  flex-shrink: 0;
  transition: 0.15s;
}
.tabs-burger:hover {
  background: var(--primary-bg);
  color: var(--primary);
  border-color: var(--primary);
}
.sidebar-mask {
  display: none;
  position: absolute;
  inset: 0;
  z-index: 19;
  background: rgb(15 30 60 / 34%);
  backdrop-filter: blur(2px);
  animation: sbMaskIn 0.18s ease-out;
}
@keyframes sbMaskIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@media (max-width: 1280px) {
  .ds-url {
    max-width: calc(100vw - 460px);
  }
  .ds-value-static {
    max-width: min(480px, 42vw);
  }
}
@media (max-width: 1100px) {
  .clean-toggle {
    display: none;
  }
  .ds-url {
    max-width: calc(100vw - 320px);
  }
  .ds-value-static {
    max-width: min(400px, 42vw);
  }
}
@media (max-width: 1024px) {
  .tabs-burger {
    display: inline-flex;
  }
  .session-sidebar {
    position: absolute;
    top: 0;
    left: 0;
    bottom: 0;
    z-index: 20;
    width: 260px;
    max-width: 82vw;
    transform: translateX(-100%);
    transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow: 4px 0 24px rgb(15 30 60 / 20%);
  }
  .session-sidebar.is-open {
    transform: translateX(0);
  }
  .sidebar-mask.is-open {
    display: block;
  }
  .main {
    padding: 12px 14px;
  }
  .tabs {
    padding: 0 16px;
  }
}
@media (max-width: 720px) {
  .hdr {
    padding: 8px 14px;
  }
  .ds-url {
    display: none;
  }
  .main {
    padding: 10px 10px;
  }
  .tabs {
    padding: 0 10px;
  }
  .tabs button:not(.tabs-burger) {
    margin-right: 12px;
    font-size: 12px;
    padding: 10px 4px;
  }
  .session-card,
  .ns-card {
    width: calc(100vw - 24px);
    max-width: 100%;
  }
}
.collapse-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 4px;
  padding: 3px 10px;
  border: 1px solid var(--border-2);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: 0.15s;
  font-family: inherit;
}
.collapse-btn:hover {
  background: var(--surface-2);
  color: var(--text);
  border-color: var(--text-3);
}
.collapse-btn svg {
  flex-shrink: 0;
}


.ask-open-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 12px;
  border: 1px solid var(--primary);
  border-radius: 6px;
  background: var(--primary-bg);
  color: var(--primary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: 0.12s;
  font-family: inherit;
}
.ask-open-btn:hover {
  background: var(--primary);
  color: #fff;
}
.ask-modal-mask {
  position: fixed;
  inset: 0;
  z-index: 2147483645;
  background: rgb(15 30 60 / 42%);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.ask-modal-card {
  width: min(1280px, 96vw);
  height: min(900px, 92vh);
  background: var(--surface);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgb(15 30 60 / 28%);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: ask-modal-in 0.18s ease-out;
}
.ask-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  flex-shrink: 0;
}
.ask-modal-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.ask-modal-close {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  transition: 0.12s;
}
.ask-modal-close:hover {
  color: var(--danger);
  background: var(--danger-bg);
}
.ask-modal-body {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}
.ask-modal-body > * {
  flex: 1;
  min-width: 0;
}
.ask-modal-enter-active,
.ask-modal-leave-active {
  transition: opacity 0.18s ease;
}
.ask-modal-enter-from,
.ask-modal-leave-to {
  opacity: 0;
}
@keyframes ask-modal-in {
  from { transform: scale(0.97); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}
</style>
<!-- tooltip-audit -->

