<!-- [video-panel-v1] 视频生成面板：主题输入 → 提交任务 → 轮询进度 → 下载成品。 -->
<!-- [WHY] 对齐 MPT 的 WebUI，消费 /__ai/video/* 端点；作为右侧栏新 tab。 -->
<!-- [CONSTRAINT] 轮询间隔 2s，任务终态即停；不轮询时不留定时器。 -->
<script setup lang="ts">
import { ref } from 'vue'

interface TaskSummary {
  taskId: string
  status: string
  progress: number
  stage: string
  subject: string
  error?: string
  updatedAt: number
}

/** 任务状态中文名 */
const STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  processing: '生成中',
  completed: '已完成',
  failed: '失败',
}
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

onUnmounted(stopPolling)

/** 挂载即刷新 */
refresh().then(() => {
  if (tasks.value.some(t => t.status === 'pending' || t.status === 'processing')) startPolling()
})

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
</script>

<template>
  <div class="video-panel">
    <h3 class="vp-title">
      视频生成
    </h3>

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
          <span v-if="t.stage">{{ STAGE_LABEL[t.stage] || t.stage }}</span>
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
