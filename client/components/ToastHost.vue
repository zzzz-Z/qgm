<script setup lang="ts">
defineOptions({ name: 'ToastHost' })
import { useToast } from '../composables/useToast'

const { toasts, confirmState, dismissToast, resolveConfirm } = useToast()
</script>

<template>
  <Teleport to="body">
    <div class="toast-host">
      <TransitionGroup name="toast">
        <div
          v-for="t in toasts"
          :key="t.id"
          class="toast"
          :class="t.type"
          @click="dismissToast(t.id)"
        >
          <span class="toast-icon">{{ t.icon }}</span>
          <span class="toast-msg">{{ t.msg }}</span>
        </div>
      </TransitionGroup>
    </div>
    <Transition name="modal">
      <div
        v-if="confirmState"
        class="modal-mask"
        @click.self="resolveConfirm(false)"
      >
        <div class="modal-card">
          <div class="modal-body">
            <div class="modal-icon" :class="{ danger: confirmState.danger }">
              {{ confirmState.icon }}
            </div>
            <div class="modal-text">
              <div class="modal-msg">
                {{ confirmState.msg }}
              </div>
              <div v-if="confirmState.detail" class="modal-detail">
                {{ confirmState.detail }}
              </div>
            </div>
          </div>
          <div class="modal-actions">
            <button v-tooltip="'取消并关闭弹窗'" class="modal-btn ghost" @click="resolveConfirm(false)">
              {{ confirmState.cancelText }}
            </button>
            <button v-tooltip="confirmState.danger ? '确认执行此破坏性操作' : '确认并继续'" class="modal-btn primary" :class="{ danger: confirmState.danger }" @click="resolveConfirm(true)">
              {{ confirmState.okText }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.toast-host {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  min-width: 200px;
  max-width: 380px;
  background: var(--surface);
  border: 1px solid var(--border, #e5e9f0);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgb(15 30 60 / 14%);
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}
.toast.info {
  border-left: 3px solid var(--primary, #2563eb);
}
.toast.success {
  border-left: 3px solid var(--success, #10b981);
}
.toast.warn {
  border-left: 3px solid var(--warning, #f59e0b);
}
.toast.error {
  border-left: 3px solid var(--danger, #ef4444);
}
.toast-icon {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
}
.toast.info .toast-icon {
  background: var(--primary-bg, #eaf2ff);
  color: var(--primary, #2563eb);
}
.toast.success .toast-icon {
  background: var(--success-bg, #ecfdf5);
  color: var(--success, #10b981);
}
.toast.warn .toast-icon {
  background: var(--warning-bg, #fffbeb);
  color: var(--warning, #f59e0b);
}
.toast.error .toast-icon {
  background: var(--danger-bg, #fef2f2);
  color: var(--danger, #ef4444);
}
.toast-msg {
  flex: 1;
  min-width: 0;
  word-break: break-word;
  color: var(--text, #1f2d3d);
  line-height: 1.5;
}
.toast-enter-active,
.toast-leave-active {
  transition: all 0.25s ease;
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(24px);
}
.toast-leave-to {
  opacity: 0;
  transform: translateX(24px);
}
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  background: rgb(15 30 60 / 32%);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
}
.modal-card {
  min-width: 320px;
  max-width: 460px;
  background: var(--surface);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgb(15 30 60 / 24%);
  overflow: hidden;
  animation: modal-in 0.18s ease-out;
}
@keyframes modal-in {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
.modal-body {
  display: flex;
  gap: 12px;
  padding: 20px 20px 16px;
  align-items: flex-start;
}
.modal-icon {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  font-weight: 700;
  flex-shrink: 0;
  background: var(--primary-bg, #eaf2ff);
  color: var(--primary, #2563eb);
}
.modal-icon.danger {
  background: var(--danger-bg, #fef2f2);
  color: var(--danger, #ef4444);
}
.modal-text {
  flex: 1;
  min-width: 0;
  padding-top: 4px;
}
.modal-msg {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--text, #1f2d3d);
  word-break: break-word;
}
.modal-detail {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-3, #8592a6);
  line-height: 1.5;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 20px 20px;
}
.modal-btn {
  padding: 7px 16px;
  border-radius: 8px;
  border: 1px solid var(--border-2, #d0d7de);
  background: var(--surface);
  color: var(--text, #1f2d3d);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}
.modal-btn.ghost:hover {
  background: var(--surface-2);
}
.modal-btn.primary {
  background: var(--primary);
  color: #fff;
  border-color: transparent;
  box-shadow: 0 2px 6px rgb(37 99 235 / 28%);
}
.modal-btn.primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 16px rgb(37 99 235 / 32%);
}
.modal-btn.primary.danger {
  background: var(--danger);
  box-shadow: 0 2px 6px rgb(239 68 68 / 28%);
}
.modal-btn.primary.danger:hover {
  box-shadow: 0 6px 16px rgb(239 68 68 / 32%);
}
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.18s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
</style>
<!-- tooltip-audit -->
