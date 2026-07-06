<template>
  <Teleport to="body">
    <TransitionGroup name="meta-toast" tag="div" class="meta-toast-container" aria-live="polite" role="status">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="meta-toast"
        :class="`meta-toast--${toast.type}`"
      >
        <span class="meta-toast__icon">{{ icons[toast.type] }}</span>
        <span class="meta-toast__message">{{ toast.message }}</span>
        <button
          v-if="toast.action"
          class="meta-toast__action"
          type="button"
          data-test="meta-toast-action"
          @click="runAction(toast)"
        >{{ toast.action.label }}</button>
        <button class="meta-toast__close" @click="dismiss(toast.id)">&times;</button>
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<script setup lang="ts">
import { ref } from 'vue'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastItem {
  id: number
  message: string
  type: 'error' | 'success' | 'info'
  /** W3-5: an optional clickable action (e.g. "View in history") rendered before the close button. */
  action?: ToastAction
}

const icons: Record<string, string> = {
  error: '\u26A0',   // ⚠
  success: '\u2714', // ✔
  info: '\u2139',    // ℹ
}

const toasts = ref<ToastItem[]>([])
let nextId = 0

function show(message: string, type: ToastItem['type'] = 'info', duration = 3000, action?: ToastAction) {
  const id = nextId++
  toasts.value.push({ id, message, type, action })
  if (duration > 0) setTimeout(() => dismiss(id), duration)
}

function dismiss(id: number) {
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

function runAction(toast: ToastItem) {
  toast.action?.onClick()
  dismiss(toast.id)
}

function showError(message: string) { show(message, 'error', 5000) }
function showSuccess(message: string, action?: ToastAction) { show(message, 'success', action ? 6000 : 3000, action) }

defineExpose({ show, showError, showSuccess, dismiss })
</script>

<style scoped>
.meta-toast-container { position: fixed; top: 16px; right: 16px; z-index: 9999; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
.meta-toast { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-radius: 6px; font-size: 13px; color: #fff; box-shadow: 0 4px 12px rgba(0,0,0,.15); pointer-events: auto; max-width: 380px; }
.meta-toast--error { background: #f56c6c; }
.meta-toast--success { background: #67c23a; }
.meta-toast--info { background: #409eff; }
.meta-toast__icon { font-size: 15px; flex-shrink: 0; }
.meta-toast__message { flex: 1; line-height: 1.4; }
.meta-toast__action { border: 1px solid rgba(255,255,255,.6); background: none; color: #fff; font-size: 12px; cursor: pointer; padding: 2px 8px; border-radius: 4px; flex-shrink: 0; white-space: nowrap; }
.meta-toast__action:hover { background: rgba(255,255,255,.15); }
.meta-toast__close { border: none; background: none; color: rgba(255,255,255,.7); font-size: 16px; cursor: pointer; padding: 0 2px; flex-shrink: 0; }
.meta-toast__close:hover { color: #fff; }
.meta-toast-enter-active { transition: all 0.3s ease; }
.meta-toast-leave-active { transition: all 0.2s ease; }
.meta-toast-enter-from { opacity: 0; transform: translateX(30px); }
.meta-toast-leave-to { opacity: 0; transform: translateX(30px); }
</style>
