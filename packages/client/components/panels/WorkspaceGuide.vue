<script setup lang="ts">
import { TOAST_DEFAULT, TOAST_MEDIUM } from '../../utils/toast-durations'

const pathInput = ref('')
const busy = ref(false)

const { toast } = useToast()

async function pick() {
  if (busy.value) return
  busy.value = true
  try {
    const r = await fetch('/__ai/workspace/pick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    if (r.status === 204) return
    if (r.ok) {
      const j = await r.json().catch(() => ({})) as { ok?: boolean, unsupported?: boolean }
      if (j && j.ok) { window.location.reload(); return }
      if (j && j.unsupported) { toast('当前平台不支持系统选择器，请手动输入路径', 'warn', TOAST_MEDIUM); return }
    }
    toast(`选择失败：HTTP ${r.status}`, 'error', TOAST_MEDIUM)
  } catch (e) {
    toast(`选择失败：${e instanceof Error ? e.message : String(e)}`, 'error', TOAST_MEDIUM)
  } finally { busy.value = false }
}
async function selectByPath() {
  const p = pathInput.value.trim()
  if (!p) { toast('请输入工作区绝对路径', 'warn', TOAST_DEFAULT); return }
  if (busy.value) return
  busy.value = true
  try {
    const r = await fetch('/__ai/workspace/select', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }) })
    const j = await r.json().catch(() => ({})) as { ok?: boolean, error?: string }
    if (r.ok && j && j.ok) { window.location.reload(); return }
    toast(j?.error || `选择失败：HTTP ${r.status}`, 'error', TOAST_MEDIUM)
  } catch (e) {
    toast(`选择失败：${e instanceof Error ? e.message : String(e)}`, 'error', TOAST_MEDIUM)
  } finally { busy.value = false }
}
</script>

<template>
  <section class="ws-guide">
    <div class="ws-card">
      <h2 class="ws-title">
        选择工作区
      </h2>
      <p class="ws-desc">
        当前尚未绑定工作区。请选择要操作的目录，AI Runner 将以此目录为根执行脚本与读写文件。
      </p>
      <button class="ws-btn ws-primary" type="button" :disabled="busy" @click="pick">
        打开系统选择器
      </button>
      <div class="ws-divider">
        或手动输入路径
      </div>
      <input
        v-model="pathInput"
        class="ws-input"
        type="text"
        placeholder="/path/to/project"
        spellcheck="false"
        :disabled="busy"
        @keydown.enter.prevent="selectByPath"
      >
      <button class="ws-btn" type="button" :disabled="busy || !pathInput.trim()" @click="selectByPath">
        使用该路径
      </button>
    </div>
  </section>
</template>

<style scoped lang="scss">
.ws-guide {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  padding: 24px;
}

.ws-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 100%;
  max-width: 480px;
  padding: 32px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
}

.ws-title {
  margin: 0;
  font-size: 20px;
}

.ws-desc {
  margin: 0;
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1.6;
}

.ws-btn {
  padding: 10px 16px;
  color: var(--text);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
}

.ws-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.ws-primary {
  color: #fff;
  background: var(--accent);
  border-color: var(--accent);
}

.ws-divider {
  color: var(--text-dim);
  font-size: 12px;
  text-align: center;
}

.ws-input {
  padding: 10px 12px;
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
}
</style>
