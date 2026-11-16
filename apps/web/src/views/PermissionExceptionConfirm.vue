<template>
  <div class="permission-exception-confirm__shield" data-testid="permission-mutation-shield">
    <div
      ref="dialogRoot"
      class="permission-exception-confirm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="permission-exception-confirm-title"
      aria-describedby="permission-exception-confirm-summary"
      data-testid="permission-mutation-dialog"
      tabindex="-1"
    >
      <h3 id="permission-exception-confirm-title">{{ title }}</h3>
      <p id="permission-exception-confirm-summary" data-testid="permission-mutation-summary">{{ summary }}</p>
      <div class="permission-exception-confirm__actions">
        <button
          class="permission-exception-confirm__button"
          type="button"
          data-testid="permission-mutation-confirm"
          :disabled="busy"
          @click="emit('confirm')"
        >
          确认
        </button>
        <button
          class="permission-exception-confirm__button permission-exception-confirm__button--secondary"
          type="button"
          data-testid="permission-mutation-cancel"
          :disabled="busy"
          @click="emit('cancel')"
        >
          取消
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

const props = defineProps<{
  title: string
  summary: string
  busy: boolean
}>()

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

const dialogRoot = ref<HTMLElement | null>(null)
let restoreFocus: HTMLElement | null = null

function focusableElements(): HTMLElement[] {
  const root = dialogRoot.value
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>('button, input, a[href], select, textarea')).filter((element) => {
    if (element.hasAttribute('disabled')) return false
    return element.tabIndex !== -1
  })
}

function onDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    if (props.busy) return
    event.preventDefault()
    event.stopPropagation()
    emit('cancel')
    return
  }
  if (event.key !== 'Tab') return
  const root = dialogRoot.value
  if (!root) return
  const items = focusableElements()
  if (items.length === 0) {
    event.preventDefault()
    root.focus()
    return
  }
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (event.shiftKey && (active === first || active === root || !root.contains(active))) {
    event.preventDefault()
    last?.focus()
    return
  }
  if (!event.shiftKey && (active === last || active === root || !root.contains(active))) {
    event.preventDefault()
    first?.focus()
  }
}

onMounted(() => {
  const active = document.activeElement
  restoreFocus = active instanceof HTMLElement ? active : null
  document.addEventListener('keydown', onDialogKeydown)
  dialogRoot.value?.focus()
})

onUnmounted(() => {
  document.removeEventListener('keydown', onDialogKeydown)
  restoreFocus?.focus()
  restoreFocus = null
})
</script>

<style scoped>
.permission-exception-confirm__shield {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(15, 23, 42, 0.45);
  box-sizing: border-box;
}

.permission-exception-confirm {
  width: min(560px, 100%);
  max-width: 100%;
  min-width: 0;
  max-height: min(80vh, 720px);
  overflow: auto;
  box-sizing: border-box;
  background: #fff;
  border-radius: 12px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.permission-exception-confirm h3,
.permission-exception-confirm p {
  margin: 0;
  overflow-wrap: anywhere;
}

.permission-exception-confirm__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.permission-exception-confirm__button {
  border: none;
  border-radius: 10px;
  padding: 8px 12px;
  background: #1d4ed8;
  color: #fff;
  cursor: pointer;
  font: inherit;
}

.permission-exception-confirm__button--secondary {
  background: #e2e8f0;
  color: #0f172a;
}

.permission-exception-confirm__button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
