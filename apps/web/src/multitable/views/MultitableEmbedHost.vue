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
      :comment-id="commentId"
      :field-id="fieldId"
      :open-comments="openComments"
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
  commentId?: string
  fieldId?: string
  openComments?: boolean
  mode?: string // force view type: grid | form | kanban | gallery | calendar | timeline | gantt | hierarchy
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
// Pinned to the first allowlisted parent that messages us, so outbound posts target a concrete
// origin instead of '*'. See postToParent for the fallback when no inbound message has arrived yet.
const parentOrigin = ref<string | null>(null)

function isOriginAllowed(origin: string): boolean {
  if (!props.allowedOrigins?.length) {
    // Default to same-origin if no restriction specified
    try { return origin === window.location.origin } catch { return false }
  }
  // Strict exact-match against the configured allowlist -- '*' is NOT a wildcard here.
  return props.allowedOrigins.includes(origin)
}

function onMessage(event: MessageEvent) {
  if (!isOriginAllowed(event.origin)) return
  const data = event.data
  if (!data || typeof data !== 'object' || !data.type?.startsWith('mt:')) return
  // pin the parent origin only after a well-formed mt: message, so an unrelated message from an
  // allowlisted origin can't occupy the pin first
  parentOrigin.value = event.origin

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
  reconcileEchoMemoWithWorkbench(snapshot.currentContext)
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

// #5750 follow-up: hosts commonly answer `mt:navigated` with another `mt:navigate` (the "keep my
// outer URL in sync" reflex). Each re-send carries a NEW requestId, so nothing upstream recognises
// it as a repeat at the message layer, and the workbench happily answers 'applied' again -- #5750
// already stopped the HTTP behind that from refetching, but the ECHO kept ping-ponging forever.
// Two guards, both on the echo only:
//   - no `mt:navigated` for the triple that was just echoed (the re-send still gets its
//     `mt:navigate-result` -- results stay 1:1 with requests, so a host awaiting a reply is never
//     starved -- but nothing that could trigger the next re-send);
//   - no requestId echoed twice: a request is answered once, and a SECOND result carrying an
//     already-answered requestId is not that request's answer.
// Two deliberate non-choices, because a dropped echo is its own bug (the parent stops tracking
// where the frame is):
//   - "the LAST echoed triple", not "every triple ever echoed" -- navigating A -> B -> A is real
//     movement the host must hear about; only the back-to-back repeat is the loop;
//   - a repeated requestId whose triple is NEW still posts, just without the requestId (it is an
//     ordinary navigation echo, not a reply), so the frame moving is never silently swallowed.
const ECHOED_NAVIGATION_REQUEST_ID_LIMIT = 200
const echoedNavigationRequestIds = new Set<string | number>()
let lastEchoedNavigatedContext: ContextSnapshot | null = null

function rememberEchoedNavigationRequestId(requestId: string | number) {
  echoedNavigationRequestIds.add(requestId)
  // Set iteration is insertion-ordered, so dropping the first entry is a FIFO trim: a long-lived
  // frame cannot grow this set without bound, and a requestId that old can no longer be in flight.
  while (echoedNavigationRequestIds.size > ECHOED_NAVIGATION_REQUEST_ID_LIMIT) {
    const oldest = echoedNavigationRequestIds.values().next()
    if (oldest.done) break
    echoedNavigationRequestIds.delete(oldest.value)
  }
}

// Review round 2: the dedupe above is keyed on what the HOST last echoed, and the host's own notion of
// where the frame is (effective* = override ?? props) is written only by applyHostOverrides -- so an
// in-frame navigation (a user clicking another view inside the iframe) moves the workbench without the
// host ever hearing about it. A parent that notices the drift the only way it can, by polling
// mt:get-navigation-state (which answers from the WORKBENCH's real context), and then navigates back to
// the triple it was last told about, would otherwise get its move suppressed as a duplicate. Whenever
// that poll shows the frame is not where we said it was, the memo is stale: drop it, so the next landing
// is news again. A parent that re-sends blindly without polling is indistinguishable from the ping-pong
// this dedupe exists for, and is still deduped.
function reconcileEchoMemoWithWorkbench(currentContext: ContextSnapshot) {
  if (!lastEchoedNavigatedContext) return
  if (contextMatches(lastEchoedNavigatedContext, normalizeContextSnapshot(currentContext))) return
  lastEchoedNavigatedContext = null
}

function emitNavigated(context: ContextSnapshot, requestId?: string | number) {
  // An already-answered requestId is dropped from the payload, not used to drop the payload.
  const echoRequestId = requestId != null && echoedNavigationRequestIds.has(requestId) ? undefined : requestId
  // The identical echo is already out; this request is answered by it.
  if (lastEchoedNavigatedContext && contextMatches(lastEchoedNavigatedContext, context)) return false
  // Review round 2: burn the id only HERE, below the triple guard -- a suppressed echo never carried
  // it, so marking it answered would strip the id from the next echo that really does carry it.
  if (requestId != null) rememberEchoedNavigationRequestId(requestId)
  lastEchoedNavigatedContext = context
  const payload = {
    type: 'mt:navigated',
    ...toOptionalContext(context),
    requestId: echoRequestId,
  }
  emit('navigated', {
    sheetId: context.sheetId || undefined,
    viewId: context.viewId || undefined,
  })
  postToParent(payload)
  return true
}

function flushPendingNavigationEcho(context: ContextSnapshot) {
  if (!pendingNavigationEcho.value || !contextMatches(pendingNavigationEcho.value.context, context)) {
    return false
  }
  const requestId = pendingNavigationEcho.value.requestId
  pendingNavigationEcho.value = null
  // `true` means "this pending echo is settled", not "a message went out": when emitNavigated
  // suppresses a duplicate the request is still answered (by the identical echo already sent plus
  // its own mt:navigate-result). The effective-id watch relies on that distinction -- it must NOT
  // fall through to its own generic echo, which would post exactly the duplicate this suppresses.
  emitNavigated(context, requestId)
  return true
}

// `requestedContext` is what the HOST asked for, when that differs from what was applied (a request
// naming a view this sheet does not have resolves back to the view already on screen). It is used for
// the deep-link cleanup below only: the frame does not move for such a request, but ?recordId=/?mode=
// still have to go, exactly as they did when the requested triple was the one pinned into the URL.
async function applyHostOverrides(context: ContextSnapshot, requestedContext?: ContextSnapshot) {
  overrideBaseId.value = context.baseId || undefined
  overrideSheetId.value = context.sheetId || undefined
  overrideViewId.value = context.viewId || undefined
  if (route.name !== AppRouteNames.MULTITABLE) return
  const routeContext = normalizeContextSnapshot({
    baseId: typeof route.query.baseId === 'string' ? route.query.baseId : undefined,
    sheetId: typeof route.params.sheetId === 'string' ? route.params.sheetId : undefined,
    viewId: typeof route.params.viewId === 'string' ? route.params.viewId : undefined,
  })
  // #5750: an applied context WITHOUT a baseId means "whatever base the workbench is already on",
  // not "this sheet has no base". Writing `baseId: undefined` into the query DELETES ?baseId= from
  // the URL (while every other query key survives the spread) even though the workbench keeps
  // rendering that base, so the URL stops round-tripping: a reload or a copied link lands on the
  // base-less resolution path instead of the base the frame is showing. Fall back to the base the
  // workbench itself reports; a workbench that reports no base of its own still drops the key
  // (falling back to the URL's own stale baseId could pin a base that does not own this sheet).
  const resolvedBaseId = context.baseId
    || (workbenchRef.value?.getEmbedHostState?.()?.currentContext?.baseId ?? '')
  // ...but that widened match must not swallow the recordId/mode cleanup this call used to do.
  // Before the fallback, a context without a baseId always mismatched the URL, so the replace below
  // ran and stripped both keys; they are live props (an open record dialog, a forced view mode), so
  // a host navigating back to the plain sheet would otherwise stay pinned on them. Keep doing the
  // replace whenever the raw context would have triggered it and either key is still in the URL.
  const urlShowsResolvedContext = contextMatches(routeContext, { ...context, baseId: resolvedBaseId })
  const urlShowsRawContext = contextMatches(routeContext, requestedContext ?? context)
  const hasDeepLinkKeys = route.query.recordId !== undefined || route.query.mode !== undefined
  if (urlShowsResolvedContext && (urlShowsRawContext || !hasDeepLinkKeys)) return
  const nextQuery: LocationQueryRaw = {
    ...route.query,
    baseId: resolvedBaseId || undefined,
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
  // The echo is settled first (it must not wait for a route change that will not happen), but the
  // overrides pass runs either way: when the frame is already where the request resolves to, it is a
  // no-op for the ids and still does the ?recordId=/?mode= cleanup the request earned. Passing the
  // REQUESTED triple keeps that cleanup on its pre-existing trigger -- "the URL does not show what the
  // host asked for" -- now that the echo carries the resolved triple instead of the requested one.
  flushPendingNavigationEcho(normalizeContextSnapshot({
    baseId: effectiveBaseId.value,
    sheetId: effectiveSheetId.value,
    viewId: effectiveViewId.value,
  }))
  await applyHostOverrides(resolvedContext, normalizeContextSnapshot({
    baseId: nextBaseId,
    sheetId: nextSheetId,
    viewId: nextViewId,
  }))
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
  // Same two-step as handleNavigateMessage. The replayed request's own raw triple is not in hand here
  // (the workbench parked it, not the host), so the resolved one doubles as it: a deferred replay that
  // lands exactly on the URL's triple is a frame that never moved, and leaves the deep link alone.
  flushPendingNavigationEcho(normalizeContextSnapshot({
    baseId: effectiveBaseId.value,
    sheetId: effectiveSheetId.value,
    viewId: effectiveViewId.value,
  }))
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
    if (window.parent === window) return
    // Never post to '*'. Prefer the pinned parent origin (captured from the first allowlisted
    // inbound message); else the single configured allowed origin; else fall back to this frame's
    // own origin -- which a cross-origin parent will simply not receive, so nothing leaks.
    const target =
      parentOrigin.value
      ?? props.allowedOrigins?.find((origin) => origin && origin !== '*')
      ?? window.location.origin
    window.parent.postMessage(payload, target)
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
