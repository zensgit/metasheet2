<template>
  <Teleport to="body">
    <TransitionGroup name="meta-toast" tag="div" class="meta-toast-container">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="meta-toast"
        :class="`meta-toast--${toast.type}`"
      >
        <span class="meta-toast__icon">{{ icons[toast.type] }}</span>
        <span class="meta-toast__message">{{ toast.message }}</span>
        <button class="meta-toast__close" @click="dismiss(toast.id)">&times;</button>
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<script setup lang="ts">
import { ref } from 'vue'

export interface ToastItem {
  id: number
  message: string
  type: 'error' | 'success' | 'info'
}

const icons: Record<string, string> = {
  error: '\u26A0',   // ⚠
  success: '\u2714', // ✔
  info: '\u2139',    // ℹ
}

const toasts = ref<ToastItem[]>([])
let nextId = 0

function show(message: string, type: ToastItem['type'] = 'info', duration = 3000) {
  const id = nextId++
  toasts.value.push({ id, message, type })
  if (duration > 0) setTimeout(() => dismiss(id), duration)
}

function dismiss(id: number) {
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

function showError(message: string) { show(message, 'error', 5000) }
function showSuccess(message: string) { show(message, 'success', 3000) }

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
.meta-toast__close { border: none; background: none; color: rgba(255,255,255,.7); font-size: 16px; cursor: pointer; padding: 0 2px; flex-shrink: 0; }
.meta-toast__close:hover { color: #fff; }
.meta-toast-enter-active { transition: all 0.3s ease; }
.meta-toast-leave-active { transition: all 0.2s ease; }
.meta-toast-enter-from { opacity: 0; transform: translateX(30px); }
.meta-toast-leave-to { opacity: 0; transform: translateX(30px); }
</style>
