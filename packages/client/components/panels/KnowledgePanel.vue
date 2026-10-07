<script setup lang="ts">
// [wiki-panel-v1] 工作台「知识库」只读面板：调 /wiki/health 显示在线/离线态，调 /wiki/search 展示命中。
// [WHY] 离线态必须渲染「离线」而非空列表——空列表会让用户误判为「知识库里没有」。
// [CONSTRAINT] 只读：不做「一键注入对话」（首问/上下文污染风险）。样式用 scoped，避让 App.scss。
import { onMounted, ref } from 'vue'

interface Health { ok: boolean, degraded?: boolean, reason?: string }
interface Hit { path?: string, snippet?: string }

const online = ref<boolean | null>(null)
const reason = ref('')
const query = ref('')
const hits = ref<Hit[]>([])
const searched = ref(false)
const busy = ref(false)

onMounted(checkHealth)

async function checkHealth() {
  try {
    const r = await fetch('/__ai/wiki/health')
    const j = (await r.json()) as Health
    online.value = Boolean(j.ok) && !j.degraded
    reason.value = j.reason || ''
  } catch {
    online.value = false
    reason.value = 'network'
  }
}
async function search() {
  const q = query.value.trim()
  if (!q) return
  busy.value = true
  searched.value = true
  try {
    const r = await fetch(`/__ai/wiki/search?q=${encodeURIComponent(q)}`)
    const j = (await r.json()) as { ok: boolean, degraded?: boolean, results?: Hit[], reason?: string }
    if (j.degraded) {
      online.value = false
      reason.value = j.reason || 'degraded'
      hits.value = []
      return
    }
    hits.value = Array.isArray(j.results) ? j.results : []
  } catch {
    online.value = false
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
      <span class="kb-status" :class="online ? 'on' : 'off'">
        <template v-if="online === null">检测中…</template>
        <template v-else-if="online">在线</template>
        <template v-else>离线{{ reason ? `（${reason}）` : '' }}</template>
      </span>
    </header>
    <div class="kb-search">
      <input
        v-model="query"
        class="kb-input"
        placeholder="搜索知识库…"
        spellcheck="false"
        @keydown.enter.prevent="search"
      >
      <button class="kb-btn" :disabled="busy || !query.trim()" @click="search">
        搜索
      </button>
    </div>
    <ul v-if="hits.length" class="kb-hits">
      <li v-for="(h, i) in hits" :key="i" class="kb-hit">
        <div class="kb-path">
          {{ h.path || "（无路径）" }}
        </div>
        <div class="kb-snippet">
          {{ h.snippet || "" }}
        </div>
      </li>
    </ul>
    <p v-else-if="online === false" class="kb-offline">
      知识库离线，无法检索
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
.kb-search {
  display: flex;
  gap: 6px;
}
.kb-input {
  flex: 1;
  padding: 4px 8px;
  border: 1px solid #3a3a3a;
  border-radius: 4px;
  background: transparent;
  color: inherit;
}
.kb-btn {
  padding: 4px 10px;
  border: 1px solid #3a3a3a;
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
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 6px 8px;
}
.kb-path {
  font-family: monospace;
  font-size: 12px;
  opacity: 0.8;
}
.kb-snippet {
  margin-top: 2px;
  opacity: 0.7;
}
.kb-empty,
.kb-offline {
  opacity: 0.6;
  margin: 4px 0;
}
</style>
