<script setup lang="ts">
import { ref } from 'vue'
import { TOAST_DEFAULT, TOAST_MEDIUM } from '../../utils/toast-durations'
import { useToast } from '../../composables/ui/useToast'
import { useWorkspaces } from '../../composables/data/useWorkspaces'

const emit = defineEmits<{ ready: [] }>()

const pathInput = ref('')
const busy = ref(false)

const { toast } = useToast()

/**
 * [workspace-guide-inplace-v1] 选定目录后**原地**切换，不再整页 reload。
 * [WHY] reload 会把「清会话 / 清事件 / 清收件箱 / 清规则缓存 / 自增 epoch」全部交给页面重建，
 *   与 workspace-switch-inplace-v1（切工作区不刷新）冲突；且它是唯一绕过 applyRootChanged 的路径。
 * [CONSTRAINT] 只入册 + 激活，不导航 AI 窗口——首问规则由 copyAndFill 按需注入。
 */
async function adopt(path: string): Promise<void> {
  const r = await useWorkspaces().register(path, true)
  if (!r.ok) { toast(`切换工作区失败：${r.error || '未知错误'}`, 'error', TOAST_MEDIUM); return }
  emit('ready')
}
async function pick() {
  if (busy.value) return
  busy.value = true
  try {
    // [workspace-guide-inplace-v1] 改用 pick-path（只返回路径、不入册不激活），
    //   再由 adopt 统一走 register —— 避免服务端 /workspace/pick 自行 setRoot 绕过前端单一出口。
    const r = await fetch('/__ai/workspace/pick-path', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    if (r.status === 204) return
    if (r.status === 501) { toast('当前平台不支持系统选择器，请手动输入路径', 'warn', TOAST_MEDIUM); return }
    const j = await r.json().catch(() => ({})) as { ok?: boolean, path?: string, error?: string }
    if (r.ok && j && j.ok && j.path) { await adopt(j.path); return }
    toast(j?.error || `选择失败：HTTP ${r.status}`, 'error', TOAST_MEDIUM)
  } catch (e) {
    toast(`选择失败：${e instanceof Error ? e.message : String(e)}`, 'error', TOAST_MEDIUM)
  } finally { busy.value = false }
}
async function selectByPath() {
  const p = pathInput.value.trim()
  if (!p) { toast('请输入工作区绝对路径', 'warn', TOAST_DEFAULT); return }
  if (busy.value) return
  busy.value = true
  try { await adopt(p) } finally { busy.value = false }
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
  color: var(--text-3);
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
  /* [ui-p1a-accent-v1] V11 --accent 未定义，改用已定义语义令牌 --primary */
  background: var(--primary);
  border-color: var(--primary);
}

.ws-divider {
  color: var(--text-3);
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
