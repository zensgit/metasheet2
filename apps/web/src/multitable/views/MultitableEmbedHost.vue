<template>
  <div
    class="mt-embed-host"
    :class="{ 'mt-embed-host--embedded': embedded }"
    :style="cssVars"
  >
    <MultitableWorkbench
      ref="workbenchRef"
      :base-id="baseId"
      :sheet-id="effectiveSheetId"
      :view-id="effectiveViewId"
      :record-id="recordId"
      :mode="mode"
      :role="role"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import type { MultitableRole } from '../composables/useMultitableCapabilities'
import MultitableWorkbench from './MultitableWorkbench.vue'

const props = defineProps<{
  baseId?: string
  sheetId?: string
  viewId?: string
  recordId?: string
  mode?: string // force view type: grid | form | kanban | gallery | calendar
  embedded?: boolean
  role?: MultitableRole
  primaryColor?: string
  allowedOrigins?: string[] // origins allowed to send postMessage
}>()

const emit = defineEmits<{
  (e: 'record-selected', recordId: string): void
  (e: 'navigated', params: { sheetId?: string; viewId?: string }): void
}>()

const workbenchRef = ref<InstanceType<typeof MultitableWorkbench> | null>(null)
const overrideSheetId = ref<string | undefined>(undefined)
const overrideViewId = ref<string | undefined>(undefined)

const effectiveSheetId = computed(() => overrideSheetId.value ?? props.sheetId)
const effectiveViewId = computed(() => overrideViewId.value ?? props.viewId)

const cssVars = computed(() => {
  const vars: Record<string, string> = {}
  if (props.primaryColor) vars['--mt-primary'] = props.primaryColor
  return vars
})

// --- Deep-link to record on mount ---
onMounted(() => {
  if (props.recordId) {
    // Set URL hash so workbench resolves the deep link
    try {
      window.location.hash = `recordId=${encodeURIComponent(props.recordId)}`
    } catch { /* SSR guard */ }
  }
})

// --- postMessage API ---
function isOriginAllowed(origin: string): boolean {
  if (!props.allowedOrigins?.length) {
    // Default to same-origin if no restriction specified
    try { return origin === window.location.origin } catch { return false }
  }
  return props.allowedOrigins.includes(origin) || props.allowedOrigins.includes('*')
}

function onMessage(event: MessageEvent) {
  if (!isOriginAllowed(event.origin)) return
  const data = event.data
  if (!data || typeof data !== 'object' || !data.type?.startsWith('mt:')) return

  switch (data.type) {
    case 'mt:navigate':
      if (data.sheetId) overrideSheetId.value = data.sheetId
      if (data.viewId) overrideViewId.value = data.viewId
      emit('navigated', { sheetId: data.sheetId, viewId: data.viewId })
      break

    case 'mt:select-record':
      if (data.recordId) {
        try {
          window.location.hash = `recordId=${encodeURIComponent(data.recordId)}`
        } catch { /* */ }
        emit('record-selected', data.recordId)
      }
      break

    case 'mt:theme':
      if (data.primaryColor) {
        const el = document.querySelector('.mt-embed-host') as HTMLElement | null
        if (el) el.style.setProperty('--mt-primary', data.primaryColor)
      }
      break
  }
}

onMounted(() => {
  window.addEventListener('message', onMessage)
  // Notify parent that embed is ready
  postToParent({ type: 'mt:ready', sheetId: effectiveSheetId.value, viewId: effectiveViewId.value })
})

onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
})

function postToParent(payload: Record<string, unknown>) {
  try {
    if (window.parent !== window) window.parent.postMessage(payload, '*')
  } catch { /* cross-origin guard */ }
}

// Notify parent on navigation changes
watch([effectiveSheetId, effectiveViewId], ([sid, vid]) => {
  postToParent({ type: 'mt:navigated', sheetId: sid, viewId: vid })
})
</script>

<style scoped>
.mt-embed-host {
  height: 100%;
  --mt-primary: #409eff;
}
.mt-embed-host--embedded {
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  overflow: hidden;
}
</style>
