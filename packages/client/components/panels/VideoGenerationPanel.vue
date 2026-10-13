<!-- [video-panel-v1] 视频生成面板：主题输入 → 提交任务 → 轮询进度 → 下载成品。 -->
<!-- [WHY] 对齐 MPT 的 WebUI，消费 /__ai/video/* 端点；作为右侧栏新 tab。 -->
<!-- [CONSTRAINT] 轮询间隔 2s，任务终态即停；不轮询时不留定时器。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'

interface TaskSummary {
  taskId: string
  status: string
  progress: number
  stage: string
  subject: string
  error?: string
  updatedAt: number
}
interface VideoConfigView {
  ai: { apiKey: string, model: string, provider: 'agnes' | 'cogvideox' }
  material: { pexelsApiKey: string, pixabayApiKey: string, cacheTtlHours: number }
  azure: { apiKey: string, region: string }
  tts: { provider: 'edge' | 'say', voice: string, rate: number, volume: number }
}

/** 任务状态中文名 */
const STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  processing: '生成中',
  completed: '已完成',
  failed: '失败',
}
/** 阶段顺序：用于把当前 stage 映射为「第几步」 */
const STAGE_ORDER = ['script', 'terms', 'audio', 'materials', 'compose']
let timer: ReturnType<typeof setInterval> | null = null
/** 阶段中文名 */
const STAGE_LABEL: Record<string, string> = {
  script: '剧本',
  terms: '搜索词',
  audio: '音频字幕',
  materials: '素材',
  compose: '合成',
}

/** 表单：主题、素材来源、画幅 */
const subject = ref('')
const videoSource = ref<'local' | 'pexels' | 'pixabay' | 'ai'>('local')
const aspect = ref<'9:16' | '16:9'>('9:16')
/** 任务列表与提交状态 */
const tasks = ref<TaskSummary[]>([])
const submitting = ref(false)
const message = ref('')
/** 配置面板展开状态与已加载配置 */
const showConfig = ref(false)
const cfgLoading = ref(false)
const cfgMsg = ref('')
/** 本地编辑副本；Key 显示为 **** 时表示「不改」 */
const cfgForm = ref<VideoConfigView | null>(null)
/** 本地素材与 BGM 列表 */
const materials = ref<string[]>([])
const musics = ref<string[]>([])

/** 任务统计：总数 / 进行中 / 已完成 / 失败 */
const stats = computed(() => {
  const by = (s: string) => tasks.value.filter(t => t.status === s).length
  return {
    total: tasks.value.length,
    active: by('pending') + by('processing'),
    done: by('completed'),
    failed: by('failed'),
  }
})

onUnmounted(stopPolling)

loadAssets()
/** 挂载即刷新 */
refresh().then(() => {
  if (tasks.value.some(t => t.status === 'pending' || t.status === 'processing')) startPolling()
})

/** 拉配置（脱敏） */
async function loadConfig() {
  cfgLoading.value = true
  cfgMsg.value = ''
  try {
    const res = await fetch('/__ai/video/config', { headers: { accept: 'application/json' } })
    const data = await res.json() as { ok: boolean, config?: VideoConfigView }
    if (data.ok && data.config) cfgForm.value = data.config
  } catch (e) {
    cfgMsg.value = `配置加载失败：${String(e).slice(0, 80)}`
  } finally {
    cfgLoading.value = false
  }
}
/** 保存配置（**** 占位由后端跳过） */
async function saveConfig() {
  if (!cfgForm.value) return
  cfgMsg.value = ''
  try {
    const res = await fetch('/__ai/video/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cfgForm.value),
    })
    const data = await res.json() as { ok: boolean, config?: VideoConfigView, error?: string }
    if (data.ok && data.config) { cfgForm.value = data.config; cfgMsg.value = '已保存' }
    else { cfgMsg.value = `保存失败：${data.error || '未知'}`
    }
  } catch (e) {
    cfgMsg.value = `保存失败：${String(e).slice(0, 80)}`
  }
}
/** 拉本地素材与 BGM 列表 */
async function loadAssets() {
  try {
    const [m, b] = await Promise.all([
      fetch('/__ai/video/materials', { headers: { accept: 'application/json' } }),
      fetch('/__ai/video/musics', { headers: { accept: 'application/json' } }),
    ])
    materials.value = ((await m.json()) as { items?: string[] }).items || []
    musics.value = ((await b.json()) as { items?: string[] }).items || []
  } catch {
    /* 列表拉取失败不阻塞主流程 */
  }
}
/** 展开配置时按需加载 */
function toggleConfig() {
  showConfig.value = !showConfig.value
  if (showConfig.value && !cfgForm.value) loadConfig()
}
/** 当前 stage 在第几步（1-based）；未知阶段返回 0 */
function stageIndex(stage: string): number {
  return STAGE_ORDER.indexOf(stage) + 1
}
/** 拉任务列表 */
async function refresh() {
  try {
    const res = await fetch('/__ai/video/tasks?limit=20', { headers: { accept: 'application/json' } })
    const data = await res.json() as { ok: boolean, items?: TaskSummary[] }
    tasks.value = data.items || []
  } catch {
    message.value = '任务列表拉取失败'
  }
}
/** 提交新任务 */
async function submit() {
  const s = subject.value.trim()
  if (!s) { message.value = '请填写视频主题'; return }
  submitting.value = true
  message.value = ''
  try {
    const res = await fetch('/__ai/video/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ videoSubject: s, videoSource: videoSource.value, aspect: aspect.value }),
    })
    const data = await res.json() as { ok: boolean, taskId?: string, error?: string }
    message.value = data.ok ? `已提交：${data.taskId}` : (`提交失败：${data.error || '未知'}`)
    await refresh()
    startPolling()
  } catch (e) {
    message.value = `请求失败：${String(e).slice(0, 120)}`
  } finally {
    submitting.value = false
  }
}
/** 启动轮询：有进行中任务时每 2s 刷新一次，全终态则自停 */
function startPolling() {
  if (timer) return
  timer = setInterval(async () => {
    await refresh()
    const active = tasks.value.some(t => t.status === 'pending' || t.status === 'processing')
    if (!active) stopPolling()
  }, 2000)
}
/** 停止轮询 */
function stopPolling() {
  if (timer) { clearInterval(timer); timer = null }
}
/** 删除任务 */
async function remove(taskId: string) {
  await fetch(`/__ai/video/tasks/${taskId}`, { method: 'DELETE' })
  await refresh()
}
/** 手动刷新：立即拉一次，若有进行中任务则续跑轮询 */
async function manualRefresh() {
  message.value = ''
  await refresh()
  if (tasks.value.some(t => t.status === 'pending' || t.status === 'processing')) startPolling()
}
</script>

<template>
  <div class="video-panel">
    <div class="vp-head">
      <h3 class="vp-title">
        视频生成
      </h3>
      <button class="vp-refresh" title="刷新" @click="manualRefresh">
        刷新
      </button>
    </div>
    <div class="vp-stats">
      <span>共 {{ stats.total }}</span>
      <span v-if="stats.active" class="vp-st-active">进行 {{ stats.active }}</span>
      <span v-if="stats.done" class="vp-st-done">完成 {{ stats.done }}</span>
      <span v-if="stats.failed" class="vp-st-failed">失败 {{ stats.failed }}</span>
    </div>

    <details class="vp-cfg" :open="showConfig" @toggle="(e) => { if ((e.target as HTMLDetailsElement).open !== showConfig) toggleConfig() }">
      <summary class="vp-cfg-sum">
        素材源配置
      </summary>
      <div v-if="cfgForm" class="vp-cfg-body">
        <label class="vp-label">AI 素材源</label>
        <select v-model="cfgForm.ai.provider" class="vp-select">
          <option value="agnes">
            Agnes AI（免费）
          </option>
          <option value="cogvideox">
            CogVideoX（付费）
          </option>
        </select>
        <label class="vp-label">AI API Key</label>
        <input v-model="cfgForm.ai.apiKey" class="vp-input" placeholder="留空则不启用" type="password">

        <label class="vp-label">Pexels API Key</label>
        <input v-model="cfgForm.material.pexelsApiKey" class="vp-input" placeholder="可选" type="password">

        <label class="vp-label">Pixabay API Key</label>
        <input v-model="cfgForm.material.pixabayApiKey" class="vp-input" placeholder="可选" type="password">

        <label class="vp-label">TTS 引擎</label>
        <select v-model="cfgForm.tts.provider" class="vp-select">
          <option value="edge">
            Edge TTS（在线）
          </option>
          <option value="say">
            macOS say（离线）
          </option>
        </select>

        <button class="vp-btn vp-btn-sm" @click="saveConfig">
          保存配置
        </button>
        <p v-if="cfgMsg" class="vp-msg">
          {{ cfgMsg }}
        </p>
      </div>
      <p v-else-if="cfgLoading" class="vp-msg">
        加载中…
      </p>
    </details>

    <label class="vp-label">主题</label>
    <input v-model="subject" class="vp-input" placeholder="例如：长安古风故事" @keyup.enter="submit">

    <div class="vp-row">
      <label class="vp-label">素材源</label>
      <select v-model="videoSource" class="vp-select">
        <option value="local">
          本地素材
        </option>
        <option value="pexels">
          Pexels
        </option>
        <option value="pixabay">
          Pixabay
        </option>
        <option value="ai">
          AI 生成
        </option>
      </select>
    </div>

    <p v-if="videoSource === 'local'" class="vp-assets">
      本地素材 {{ materials.length }} 个 · BGM {{ musics.length }} 首
    </p>

    <div class="vp-row">
      <label class="vp-label">画幅</label>
      <select v-model="aspect" class="vp-select">
        <option value="9:16">
          竖屏 9:16
        </option>
        <option value="16:9">
          横屏 16:9
        </option>
      </select>
    </div>

    <button class="vp-btn" :disabled="submitting" @click="submit">
      {{ submitting ? '提交中…' : '生成视频' }}
    </button>

    <p v-if="message" class="vp-msg">
      {{ message }}
    </p>

    <h4 class="vp-sub">
      任务（{{ tasks.length }}）
    </h4>
    <ul class="vp-list">
      <li v-for="t in tasks" :key="t.taskId" class="vp-item">
        <div class="vp-item-head">
          <span class="vp-subject">{{ t.subject }}</span>
          <span class="vp-status" :class="`st-${t.status}`">{{ STATUS_LABEL[t.status] || t.status }}</span>
        </div>
        <div class="vp-progress">
          <div class="vp-bar" :style="{ width: `${t.progress}%` }" />
        </div>
        <div class="vp-meta">
          <span v-if="t.stage">第 {{ stageIndex(t.stage) }}/5 步 · {{ STAGE_LABEL[t.stage] || t.stage }}</span>
          <span v-if="t.error" class="vp-err">{{ t.error }}</span>
        </div>
        <div class="vp-actions">
          <a v-if="t.status === 'completed'" :href="`/__ai/video/tasks/${t.taskId}/download`" target="_blank">下载</a>
          <button class="vp-del" @click="remove(t.taskId)">
            删除
          </button>
        </div>
      </li>
    </ul>
    <p v-if="!tasks.length" class="vp-empty">
      暂无任务
    </p>
  </div>
</template>

<style scoped>
.video-panel {
  padding: 12px;
  font-size: 13px;
}
.vp-assets {
  margin: 4px 0;
  font-size: 12px;
  color: var(--fg-dim, #888);
}
.vp-cfg {
  margin-bottom: 10px;
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  padding: 6px 8px;
}
.vp-cfg-sum {
  cursor: pointer;
  font-size: 12px;
  color: var(--fg-dim, #888);
}
.vp-cfg-body {
  padding-top: 6px;
}
.vp-btn-sm {
  margin-top: 6px;
  padding: 4px 10px;
  font-size: 12px;
}
.vp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.vp-refresh {
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
}
.vp-stats {
  display: flex;
  gap: 10px;
  margin: 6px 0 10px;
  font-size: 12px;
  color: var(--fg-dim, #888);
}
.vp-st-active {
  color: var(--accent, #4a8);
}
.vp-st-done {
  color: #4c8;
}
.vp-st-failed {
  color: #e55;
}
.vp-status.st-completed {
  color: #4c8;
}
.vp-status.st-failed {
  color: #e55;
}
.vp-status.st-processing {
  color: var(--accent, #4a8);
}
.vp-title {
  margin: 0 0 8px;
  font-size: 14px;
}
.vp-sub {
  margin: 16px 0 6px;
  font-size: 13px;
  color: var(--fg-dim, #888);
}
.vp-label {
  display: block;
  margin: 6px 0 4px;
  color: var(--fg-dim, #888);
}
.vp-input,
.vp-select {
  width: 100%;
  padding: 6px 8px;
  box-sizing: border-box;
}
.vp-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.vp-row .vp-label {
  margin: 0;
  flex: 0 0 60px;
}
.vp-btn {
  width: 100%;
  margin-top: 10px;
  padding: 6px;
}
.vp-msg {
  margin: 8px 0;
  color: var(--fg-dim, #888);
}
.vp-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.vp-item {
  padding: 8px;
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  margin-bottom: 6px;
}
.vp-item-head {
  display: flex;
  justify-content: space-between;
}
.vp-progress {
  height: 4px;
  background: var(--border, #333);
  border-radius: 2px;
  margin: 6px 0;
  overflow: hidden;
}
.vp-bar {
  height: 100%;
  background: var(--accent, #4a8);
  transition: width 0.3s;
}
.vp-meta {
  font-size: 12px;
  color: var(--fg-dim, #888);
}
.vp-err {
  color: #e55;
}
.vp-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.vp-empty {
  color: var(--fg-dim, #888);
  text-align: center;
}
</style>
