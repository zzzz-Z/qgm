<script setup lang="ts">
// [kb-panel-v2] 工作台「知识库」面板：支持三源——lessons（本地台账）/ docs（本地文档）/ wiki（外部 LLM Wiki）。
// [WHY] v1 只接 /wiki/*（需外部 token，恒 degraded），而真正可用的 /lessons/match（含 scope=docs）未接——
//   「能用的没接、接了的不能用」。v2 默认 lessons，让面板开箱即用。
// [CONSTRAINT] 只读：不做「一键注入对话」（首问/上下文污染风险）。样式 scoped，避让 App.scss。
import { onMounted, ref } from 'vue'

type Source = 'lessons' | 'docs' | 'wiki'
interface Health { ok: boolean, degraded?: boolean, reason?: string }
interface Match { title?: string, body?: string, state?: string, src?: string, score?: number, path?: string, snippet?: string }

// lessons/docs 走本地端点，无 token 依赖——开箱即用；wiki 需外部服务。
const LOCAL = new Set<Source>(['lessons', 'docs'])

const source = ref<Source>('lessons')
const query = ref('')
const hits = ref<Match[]>([])
const searched = ref(false)
const busy = ref(false)
const degraded = ref(false)
const reason = ref('')

onMounted(() => { if (source.value === 'wiki') void checkWikiHealth() })

function switchSource(s: Source) {
  source.value = s
  hits.value = []
  searched.value = false
  degraded.value = false
  reason.value = ''
  if (s === 'wiki') void checkWikiHealth()
}
async function checkWikiHealth() {
  try {
    const r = await fetch('/__ai/wiki/health')
    const j = (await r.json()) as Health
    degraded.value = Boolean(j.degraded) || !j.ok
    reason.value = j.reason || ''
  } catch { degraded.value = true; reason.value = 'network' }
}
async function search() {
  const q = query.value.trim()
  if (!q) return
  busy.value = true
  searched.value = true
  degraded.value = false
  reason.value = ''
  try {
    if (LOCAL.has(source.value)) {
      const r = await fetch('/__ai/lessons/match', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q, scope: source.value, limit: 8 }),
      })
      const j = (await r.json()) as { ok: boolean, matches?: Match[] }
      hits.value = Array.isArray(j.matches) ? j.matches : []
    } else {
      const r = await fetch(`/__ai/wiki/search?q=${encodeURIComponent(q)}`)
      const j = (await r.json()) as { ok: boolean, degraded?: boolean, results?: Match[], reason?: string }
      if (j.degraded) { degraded.value = true; reason.value = j.reason || 'degraded'; hits.value = []; return }
      hits.value = Array.isArray(j.results) ? j.results : []
    }
  } catch {
    degraded.value = true
    reason.value = 'network'
    hits.value = []
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="kb-panel">
    <header class="kb-head">
      <span class="kb-title">知识库</span>
      <span v-if="source === 'wiki'" class="kb-status" :class="degraded ? 'off' : 'on'">
        {{ degraded ? `离线${reason ? `（${reason}）` : ''}` : '在线' }}
      </span>
    </header>
    <div class="kb-sources" role="tablist">
      <button
        v-for="s in (['lessons', 'docs', 'wiki'] as const)" :key="s"
        role="tab" :aria-selected="source === s" class="kb-src" :class="{ active: source === s }"
        @click="switchSource(s)"
      >
        {{ s === 'lessons' ? '经验台账' : s === 'docs' ? '项目文档' : '外部 Wiki' }}
      </button>
    </div>
    <div class="kb-search">
      <input
        v-model="query" class="kb-input" placeholder="搜索知识库…" spellcheck="false"
        @keydown.enter.prevent="search"
      >
      <button class="kb-btn" :disabled="busy || !query.trim()" @click="search">
        搜索
      </button>
    </div>
    <ul v-if="hits.length" class="kb-hits">
      <li v-for="(h, i) in hits" :key="i" class="kb-hit">
        <div class="kb-hit-head">
          <span class="kb-path">{{ h.src || h.path || '（无路径）' }}</span>
          <span v-if="h.state" class="kb-state">{{ h.state }}</span>
        </div>
        <div class="kb-hit-title">
          {{ h.title || '' }}
        </div>
        <div class="kb-snippet">
          {{ h.snippet || (h.body || '').slice(0, 160) }}
        </div>
      </li>
    </ul>
    <p v-else-if="degraded" class="kb-offline">
      知识库离线，无法检索（{{ reason }}）
    </p>
    <p v-else-if="searched" class="kb-empty">
      无命中
    </p>
  </section>
</template>

<style scoped>
.kb-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  font-size: 13px;
}
.kb-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.kb-title {
  font-weight: 600;
}
.kb-status.on {
  color: #3fb950;
}
.kb-status.off {
  color: #d29922;
}
/* 源切换按钮：等宽分段，激活态高亮 */
.kb-sources {
  display: flex;
  gap: 4px;
}
.kb-src {
  flex: 1;
  padding: 4px 6px;
  font-size: 12px;
  border: 1px solid var(--border-2, #3a3a3a);
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.7;
}
.kb-src.active {
  opacity: 1;
  border-color: var(--primary, #58a6ff);
  color: var(--primary, #58a6ff);
  background: rgb(88 166 255 / 8%);
}
.kb-search {
  display: flex;
  gap: 6px;
}
.kb-input {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid var(--border-2, #3a3a3a);
  border-radius: 4px;
  background: transparent;
  color: inherit;
}
.kb-btn {
  padding: 4px 10px;
  border: 1px solid var(--border-2, #3a3a3a);
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.kb-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.kb-hits {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.kb-hit {
  border: 1px solid var(--border-2, #2a2a2a);
  border-radius: 4px;
  padding: 6px 8px;
}
.kb-hit-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.kb-path {
  font-family: monospace;
  font-size: 12px;
  opacity: 0.8;
}
.kb-state {
  font-size: 11px;
  opacity: 0.6;
  margin-left: auto;
}
.kb-hit-title {
  margin-top: 2px;
  font-size: 12px;
  opacity: 0.9;
}
.kb-snippet {
  margin-top: 2px;
  font-size: 12px;
  opacity: 0.7;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.kb-empty,
.kb-offline {
  opacity: 0.6;
  margin: 4px 0;
}
</style>
