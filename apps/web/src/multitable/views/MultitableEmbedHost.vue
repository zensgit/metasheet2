<template>
  <div
    class="mt-embed-host"
    :class="{ 'mt-embed-host--embedded': embedded }"
    :style="cssVars"
  >
    <MultitableWorkbench
      ref="workbenchRef"
      :base-id="effectiveBaseId"
      :sheet-id="effectiveSheetId"
      :view-id="effectiveViewId"
      :record-id="recordId"
      :mode="mode"
      :role="role"
      @ready="onWorkbenchReady"
      @external-context-result="onWorkbenchExternalContextResult"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter, type LocationQueryRaw } from 'vue-router'
import type { MultitableRole } from '../composables/useMultitableCapabilities'
import MultitableWorkbench from './MultitableWorkbench.vue'
import { AppRouteNames } from '../../router/types'

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
  (e: 'navigation-result', params: {
    status: 'applied' | 'deferred' | 'blocked' | 'failed' | 'superseded'
    baseId?: string
    sheetId?: string
    viewId?: string
    reason?: string
    requestId?: string | number
  }): void
}>()

type ExternalContextSyncStatus = 'applied' | 'deferred' | 'blocked' | 'failed' | 'superseded'
type EmbedHostBlockingReason = 'busy' | 'unsaved-drafts' | null
type EmbedHostStateSnapshot = {
  currentContext: {
    baseId: string
    sheetId: string
    viewId: string
  }
  hasBlockingState: boolean
  blockingReason: EmbedHostBlockingReason
  hasUnsavedDrafts: boolean
  busy: boolean
  pendingContext: {
    baseId: string
    sheetId: string
    viewId: string
    requestId?: string | number
    reason?: Exclude<EmbedHostBlockingReason, null>
  } | null
}
type MultitableWorkbenchExpose = {
  confirmPageLeave?: () => boolean
  getEmbedHostState?: () => EmbedHostStateSnapshot
  requestExternalContextSync?: (
    input: { baseId?: string; sheetId?: string; viewId?: string },
    options?: { confirmIfBlocked?: boolean; requestId?: string | number },
  ) => Promise<{
    status: ExternalContextSyncStatus
    context: { baseId: string; sheetId: string; viewId: string }
    reason?: string
  }>
}
type ContextSnapshot = {
  baseId: string
  sheetId: string
  viewId: string
}
type PendingNavigationEcho = {
  requestId: string | number
  context: ContextSnapshot
}

const workbenchRef = ref<MultitableWorkbenchExpose | null>(null)
const route = useRoute()
const router = useRouter()
const overrideBaseId = ref<string | undefined>(undefined)
const overrideSheetId = ref<string | undefined>(undefined)
const overrideViewId = ref<string | undefined>(undefined)
const pendingNavigationEcho = ref<PendingNavigationEcho | null>(null)
let autoNavigationRequestId = 0

const effectiveBaseId = computed(() => overrideBaseId.value ?? props.baseId)
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
      void handleNavigateMessage(data)
      break

    case 'mt:get-navigation-state':
      emitStateSnapshot(data)
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

function getEmbedHostStateSnapshot(): EmbedHostStateSnapshot {
  return workbenchRef.value?.getEmbedHostState?.() ?? {
    currentContext: {
      baseId: effectiveBaseId.value ?? '',
      sheetId: effectiveSheetId.value ?? '',
      viewId: effectiveViewId.value ?? '',
    },
    hasBlockingState: false,
    blockingReason: null,
    hasUnsavedDrafts: false,
    busy: false,
    pendingContext: null,
  }
}

function emitStateSnapshot(data: Record<string, unknown>) {
  const requestId = typeof data.requestId === 'string' || typeof data.requestId === 'number' ? data.requestId : undefined
  const snapshot = getEmbedHostStateSnapshot()
  postToParent({
    type: 'mt:navigation-state',
    requestId,
    currentContext: snapshot.currentContext,
    hasBlockingState: snapshot.hasBlockingState,
    blockingReason: snapshot.blockingReason,
    hasUnsavedDrafts: snapshot.hasUnsavedDrafts,
    busy: snapshot.busy,
    pendingContext: snapshot.pendingContext,
  })
}

function normalizeContextSnapshot(input: { baseId?: string; sheetId?: string; viewId?: string }): ContextSnapshot {
  return {
    baseId: input.baseId ?? '',
    sheetId: input.sheetId ?? '',
    viewId: input.viewId ?? '',
  }
}

function contextMatches(a: ContextSnapshot, b: ContextSnapshot) {
  return a.baseId === b.baseId && a.sheetId === b.sheetId && a.viewId === b.viewId
}

function toOptionalContext(input: ContextSnapshot) {
  return {
    baseId: input.baseId || undefined,
    sheetId: input.sheetId || undefined,
    viewId: input.viewId || undefined,
  }
}

function emitNavigated(context: ContextSnapshot, requestId?: string | number) {
  const payload = {
    type: 'mt:navigated',
    ...toOptionalContext(context),
    requestId,
  }
  emit('navigated', {
    sheetId: context.sheetId || undefined,
    viewId: context.viewId || undefined,
  })
  postToParent(payload)
}

function flushPendingNavigationEcho(context: ContextSnapshot) {
  if (!pendingNavigationEcho.value || !contextMatches(pendingNavigationEcho.value.context, context)) {
    return false
  }
  const requestId = pendingNavigationEcho.value.requestId
  pendingNavigationEcho.value = null
  emitNavigated(context, requestId)
  return true
}

async function applyHostOverrides(context: ContextSnapshot) {
  overrideBaseId.value = context.baseId || undefined
  overrideSheetId.value = context.sheetId || undefined
  overrideViewId.value = context.viewId || undefined
  if (route.name !== AppRouteNames.MULTITABLE) return
  const routeContext = normalizeContextSnapshot({
    baseId: typeof route.query.baseId === 'string' ? route.query.baseId : undefined,
    sheetId: typeof route.params.sheetId === 'string' ? route.params.sheetId : undefined,
    viewId: typeof route.params.viewId === 'string' ? route.params.viewId : undefined,
  })
  if (contextMatches(routeContext, context)) return
  const nextQuery: LocationQueryRaw = {
    ...route.query,
    baseId: context.baseId || undefined,
  }
  delete nextQuery.recordId
  delete nextQuery.mode
  await router.replace({
    name: AppRouteNames.MULTITABLE,
    params: {
      sheetId: context.sheetId,
      viewId: context.viewId,
    },
    query: nextQuery,
  })
}

function resolveNavigationRequestId(data: Record<string, unknown>) {
  if (typeof data.requestId === 'string' || typeof data.requestId === 'number') return data.requestId
  autoNavigationRequestId += 1
  return `mt_nav_${autoNavigationRequestId}`
}

async function handleNavigateMessage(data: Record<string, unknown>) {
  const nextBaseId = typeof data.baseId === 'string' ? data.baseId : effectiveBaseId.value
  const nextSheetId = typeof data.sheetId === 'string' ? data.sheetId : effectiveSheetId.value
  const nextViewId = typeof data.viewId === 'string' ? data.viewId : effectiveViewId.value
  const requestId = resolveNavigationRequestId(data)
  const result = await workbenchRef.value?.requestExternalContextSync?.(
    {
      baseId: nextBaseId,
      sheetId: nextSheetId,
      viewId: nextViewId,
    },
    { confirmIfBlocked: true, requestId },
  ) ?? {
    status: 'applied' as const,
    context: {
      baseId: nextBaseId ?? '',
      sheetId: nextSheetId ?? '',
      viewId: nextViewId ?? '',
    },
  }
  const resolvedContext = normalizeContextSnapshot(result.context)
  emitNavigationResult({
    status: result.status,
    ...toOptionalContext(resolvedContext),
    reason: result.reason,
    requestId,
  })
  if (result.status !== 'applied') return
  pendingNavigationEcho.value = { requestId, context: resolvedContext }
  if (flushPendingNavigationEcho(normalizeContextSnapshot({
    baseId: effectiveBaseId.value,
    sheetId: effectiveSheetId.value,
    viewId: effectiveViewId.value,
  }))) {
    return
  }
  await applyHostOverrides(resolvedContext)
}

function onWorkbenchExternalContextResult(payload: {
  status: ExternalContextSyncStatus
  context: { baseId: string; sheetId: string; viewId: string }
  reason?: string
  requestId?: string | number
}) {
  if (payload.requestId == null) return
  const resolvedContext = normalizeContextSnapshot(payload.context)
  emitNavigationResult({
    status: payload.status,
    ...toOptionalContext(resolvedContext),
    reason: payload.reason,
    requestId: payload.requestId,
  })
  if (payload.status !== 'applied') return
  pendingNavigationEcho.value = { requestId: payload.requestId, context: resolvedContext }
  if (flushPendingNavigationEcho(normalizeContextSnapshot({
    baseId: effectiveBaseId.value,
    sheetId: effectiveSheetId.value,
    viewId: effectiveViewId.value,
  }))) {
    return
  }
  void applyHostOverrides(resolvedContext)
}

function onWorkbenchReady(payload: { baseId: string; sheetId: string; viewId: string }) {
  postToParent({ type: 'mt:ready', baseId: payload.baseId, sheetId: payload.sheetId, viewId: payload.viewId })
}

onMounted(() => {
  window.addEventListener('message', onMessage)
})

onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
})

onBeforeRouteLeave(() => {
  return workbenchRef.value?.confirmPageLeave?.() ?? true
})

function postToParent(payload: Record<string, unknown>) {
  try {
    if (window.parent !== window) window.parent.postMessage(payload, '*')
  } catch { /* cross-origin guard */ }
}

function emitNavigationResult(payload: {
  status: ExternalContextSyncStatus
  baseId?: string
  sheetId?: string
  viewId?: string
  reason?: string
  requestId?: string | number
}) {
  emit('navigation-result', payload)
  postToParent({
    type: 'mt:navigate-result',
    ...payload,
  })
}

// Notify parent on navigation changes
watch([effectiveBaseId, effectiveSheetId, effectiveViewId], ([bid, sid, vid]) => {
  const currentContext = normalizeContextSnapshot({ baseId: bid, sheetId: sid, viewId: vid })
  if (flushPendingNavigationEcho(currentContext)) return
  emitNavigated(currentContext)
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
