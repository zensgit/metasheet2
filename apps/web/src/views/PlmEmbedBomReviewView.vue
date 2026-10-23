<template>
  <section class="plm-embed-bom" data-testid="plm-embed-bom-review">
    <header class="plm-embed-bom__head">
      <strong>BOM Review（只读）</strong>
      <small>嵌入视图 · 来自 PLM 的受治理只读快照；不可在此编辑或写回。</small>
    </header>

    <div class="plm-embed-bom__body" data-testid="plm-embed-bom-state" :data-state="reviewState">
      <p v-if="reviewState === 'not-configured'" class="plm-embed-bom__hint plm-embed-bom__hint--strong" data-testid="plm-embed-bom-not-configured">
        嵌入未配置允许来源（fail-closed），无法接收 PLM 嵌入令牌。
      </p>
      <p v-else-if="reviewState === 'awaiting-token'" class="plm-embed-bom__hint" data-testid="plm-embed-bom-awaiting">
        等待来自 PLM 的嵌入令牌…
      </p>
      <p v-else-if="reviewState === 'loading'" class="plm-embed-bom__hint">正在读取 BOM review…</p>
      <p v-else-if="reviewState === 'unavailable'" class="plm-embed-bom__hint plm-embed-bom__hint--muted">
        当前 PLM 不支持 BOM review，或暂时不可用。
      </p>
      <p v-else-if="reviewState === 'upgrade'" class="plm-embed-bom__hint plm-embed-bom__hint--strong">
        当前租户尚未开通 BOM review；真实授权由 PLM license 判定。
      </p>
      <p v-else-if="reviewState === 'error'" class="plm-embed-bom__hint plm-embed-bom__hint--strong" data-testid="plm-embed-bom-error">
        加载 BOM review 失败（PLM 暂时不可用）。请从 PLM 重新打开此嵌入视图以重新授权。
      </p>
      <p v-else-if="reviewState === 'empty'" class="plm-embed-bom__hint">
        未找到该 Part 的 BOM 数据。
      </p>

      <PlmBomReviewTable v-else-if="reviewState === 'table' && context" :context="context" />
      <div
        v-if="visualPartId && (reviewState === 'table' || (visualPreviewEnabled && reviewState === 'empty'))"
        class="plm-embed-bom__collaboration" :class="{ 'plm-embed-bom__collaboration--visual': visualPreviewEnabled }">
        <PlmEmbedVisualPreviewPanel
          v-if="visualPreviewEnabled" :key="`visual:${visualPartId}`"
          ref="visualPanel" :parent-origin="parentOrigin" :part-id="visualPartId"
          :comments="visualComments" :draft="visualDraft" :selected-id="selectedVisualComment" :busy="discussionBusy"
          @draft="visualDraft = $event" @select="selectVisualComment" />
        <PlmEmbedDiscussionPanel
          :key="`discussion:${visualPartId}`" ref="discussionPanel"
          :parent-origin="parentOrigin" :target="{ target_type: 'item', target_id: visualPartId }"
          :visual-draft="visualDraft" :selected-comment-id="selectedVisualComment"
          @visual-comments="visualComments = $event" @clear-visual-draft="visualDraft = null"
          @visual-rejected="invalidateVisual" @select-visual-comment="selectVisualComment"
          @busy-change="discussionBusy = $event" />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
// PLM-COLLAB P3-D2 (frontend): the token-bound BOM-review embed page.
//
// Handshake (LISTEN-only for the initial token): this page's inbound handshake never posts to the
// parent. A later authenticated successor (new session id, higher continuous generation, same
// epoch and frozen user, tenant, and revision) requests one fresh `bom-read` embed token
// through the existing child token client. The discussion panel this page mounts posts its own
// discussion purposes. Every outbound post uses the pinned parent origin, never '*'.
//   1. fetch /api/plm-embed/config for the parent-origin allowlist -- the SINGLE source of truth,
//      never a URL parameter, and never containing '*'.
//   2. wait for the parent to postMessage the PLM-minted embed token. Accept it ONLY from an origin
//      in the allowlist (strict exact match); pin that origin. An empty allowlist accepts nothing.
//   3. call /api/plm-embed/bom-review/context with the token in the X-PLM-Embed-Token header. There
//      is NO part input -- the part is bound to the token's part_id claim on the server.
//   4. render the identical read-only table the standalone panel uses.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  getPlmEmbedBomContext,
  getPlmEmbedConfig,
  getPlmEmbedManagedBomContext,
  type PlmEmbedBomResult,
} from '../services/integration/plmEmbed'
import {
  createPlmEmbedBomReadTokenClient,
  type PlmEmbedBomReadTokenClient,
} from '../services/integration/plmEmbedWriteToken'
import {
  onAuthPrincipalChange,
  readAuthSessionSignature,
  readManagedDescriptor,
  readManagedEpoch,
  readManagedProbeMarker,
  readStoredToken,
} from '../composables/authPrincipal'
import { useAuth } from '../composables/useAuth'
import PlmBomReviewTable from '../components/plm/PlmBomReviewTable.vue'
import PlmEmbedDiscussionPanel from '../components/plm/PlmEmbedDiscussionPanel.vue'
import PlmEmbedVisualPreviewPanel from '../components/plm/PlmEmbedVisualPreviewPanel.vue'
import type { VisualComment, VisualMarkupDraft } from '../services/integration/plmVisualMarkup'

const visualPanel = ref<InstanceType<typeof PlmEmbedVisualPreviewPanel> | null>(null)
const discussionPanel = ref<InstanceType<typeof PlmEmbedDiscussionPanel> | null>(null)
const visualDraft = ref<VisualMarkupDraft | null>(null)
const visualComments = ref<VisualComment[]>([])
const selectedVisualComment = ref<string | null>(null)
const discussionBusy = ref(false)
function selectVisualComment(id: string): void {
  selectedVisualComment.value = id
  discussionPanel.value?.focusComment(id)
}
function invalidateVisual(reason: 'stale' | 'denied'): void {
  visualPanel.value?.invalidate(reason)
  if (reason === 'denied') {
    visualComments.value = []
    selectedVisualComment.value = null
  }
}



// the inbound postMessage envelope: { type: 'plm-embed:token', token: '<jwt>' }
const EMBED_TOKEN_MESSAGE_TYPE = 'plm-embed:token'

const configReady = ref(false)
const allowedOrigins = ref<string[]>([])
const visualPreviewEnabled = ref(false)
// pinned to the first allowlisted sender; kept for any future outbound use (none today)
const parentOrigin = ref<string | null>(null)
const tokenReceived = ref(false)
const loading = ref(false)
const result = ref<PlmEmbedBomResult | null>(null)
// messages that arrive before the allowlist is known are buffered, then re-validated in order
let pendingMessages: MessageEvent[] = []
let bomReadClient: PlmEmbedBomReadTokenClient | null = null
let pinnedSource: MessageEventSource | null = null
let loadSerial = 0
let disposed = false
let baseline: ContinuityObserve | null = null
let loadStart: ContinuityObserve | null = null
let frozenPartId: string | null = null

interface ContinuityObserve {
  epoch: number
  signature: string
  userId: string
  tenantId: string
  sessionId: string
  revision: number
  mode: 'continuous' | 'other'
  generation: number | null
  parentOrigin: string | null
  tokenAbsent: boolean
}

function observeContinuity(): ContinuityObserve {
  const descriptor = readManagedDescriptor()
  const generation = descriptor?.credentialGeneration
  const continuous = descriptor?.continuityMode === 'continuous'
    && typeof generation === 'number'
  return {
    epoch: readManagedEpoch(),
    signature: readAuthSessionSignature(),
    userId: descriptor?.userId ?? '',
    tenantId: descriptor?.tenantId ?? '',
    sessionId: descriptor?.sessionId ?? '',
    revision: descriptor?.revision ?? 0,
    mode: continuous ? 'continuous' : 'other',
    generation: continuous ? generation : null,
    parentOrigin: parentOrigin.value,
    tokenAbsent: readStoredToken() === null,
  }
}

function authorizedSuccessor(start: ContinuityObserve, next: ContinuityObserve): boolean {
  // Renewal installs successorId as a new descriptor.sessionId. The session signature includes
  // that id. Epoch stays put; resetSessionBootstrap is what bumps it. User, tenant, and link
  // revision stay frozen. A same-session generation bump is not this successor.
  return start.mode === 'continuous'
    && next.mode === 'continuous'
    && start.tokenAbsent
    && next.tokenAbsent
    && start.epoch === next.epoch
    && start.userId !== ''
    && start.userId === next.userId
    && start.tenantId === next.tenantId
    && start.revision === next.revision
    && start.sessionId !== ''
    && next.sessionId !== ''
    && start.sessionId !== next.sessionId
    && start.signature !== 'invalid'
    && next.signature !== 'invalid'
    && start.signature !== next.signature
    && start.generation !== null
    && next.generation !== null
    && next.generation > start.generation
    && start.parentOrigin !== null
    && start.parentOrigin === next.parentOrigin
    && window.parent === pinnedSource
}

function sameContinuityIdentity(left: ContinuityObserve, right: ContinuityObserve): boolean {
  return left.epoch === right.epoch
    && left.signature === right.signature
    && left.userId === right.userId
    && left.tenantId === right.tenantId
    && left.sessionId === right.sessionId
    && left.revision === right.revision
    && left.parentOrigin === right.parentOrigin
    && window.parent === pinnedSource
}

function partIdOf(value: PlmEmbedBomResult): string | null {
  if (!value.available) return null
  if (value.partId) return value.partId
  return value.context?.part.part_id || null
}

function clearRows(): void {
  loadSerial += 1
  loadStart = null
  loading.value = false
  frozenPartId = null
  result.value = { available: false, reason: 'unavailable' }
}

function refuseRead(serial: number): void {
  if (disposed || serial !== loadSerial) return
  loadStart = null
  loading.value = false
  result.value = { available: false, reason: 'unavailable' }
}

function replaceBomReadClient(): PlmEmbedBomReadTokenClient | null {
  bomReadClient?.dispose()
  bomReadClient = parentOrigin.value
    ? createPlmEmbedBomReadTokenClient(() => parentOrigin.value)
    : null
  return bomReadClient
}

const context = computed(() => (result.value && result.value.available ? result.value.context : null))

const visualPartId = computed(() => {
  const current = result.value
  return current?.available && current.entitled ? context.value?.part.part_id || current.partId : undefined
})

type EmbedReviewState =
  | 'not-configured'
  | 'awaiting-token'
  | 'loading'
  | 'unavailable'
  | 'upgrade'
  | 'error'
  | 'empty'
  | 'table'

// not-configured (allowlist empty -> can never accept a token) -> awaiting-token -> loading ->
// one of: unavailable (no support / degraded), upgrade (supported but not entitled), error
// (entitled but the provider fetch failed after the single-use token was spent; parent must re-mint
// by reopening/reloading the embed), empty (entitled, no context, no reason = part not found), table
// (entitled + context).
const reviewState = computed<EmbedReviewState>(() => {
  if (!tokenReceived.value) {
    if (configReady.value && allowedOrigins.value.length === 0) return 'not-configured'
    return 'awaiting-token'
  }
  if (loading.value) return 'loading'
  const current = result.value
  if (!current) return 'loading'
  if (!current.available) return 'unavailable'
  if (!current.entitled) return 'upgrade'
  if (current.context) return 'table'
  if (current.reason) return 'error'
  return 'empty'
})

watch([parentOrigin, visualPartId, reviewState], () => {
  visualDraft.value = null
  visualComments.value = []
  selectedVisualComment.value = null
  discussionBusy.value = false
})

function isOriginAllowed(origin: string): boolean {
  // Single source = the server /config allowlist, which NEVER contains '*'. An empty list is
  // fail-closed: nothing is accepted. Strict exact-match only -- no wildcard, no prefix.
  return allowedOrigins.value.length > 0 && allowedOrigins.value.includes(origin)
}

function acceptBomResult(serial: number, started: ContinuityObserve, fetched: PlmEmbedBomResult): void {
  if (disposed || serial !== loadSerial) return
  if (!sameContinuityIdentity(started, observeContinuity())) {
    clearRows()
    baseline = observeContinuity()
    return
  }
  const partId = partIdOf(fetched)
  if ((frozenPartId && partId && partId !== frozenPartId) || !fetched.available) {
    refuseRead(serial)
    baseline = observeContinuity()
    return
  }
  result.value = fetched
  if (partId) frozenPartId = partId
  baseline = observeContinuity()
  loadStart = null
}

async function consumeToken(origin: string, token: string): Promise<void> {
  parentOrigin.value = origin // pin the trusted parent origin
  pinnedSource = window.parent
  tokenReceived.value = true
  replaceBomReadClient()
  const serial = ++loadSerial
  const started = observeContinuity()
  loadStart = started
  loading.value = true
  const managed = readManagedDescriptor() !== null
  try {
    const fetched = managed
      ? await getPlmEmbedManagedBomContext(token)
      : await getPlmEmbedBomContext(token)
    acceptBomResult(serial, started, fetched)
  } catch {
    if (!disposed && serial === loadSerial) {
      refuseRead(serial)
      baseline = observeContinuity()
    }
  } finally {
    if (!disposed && serial === loadSerial) loading.value = false
  }
}

async function refreshBomForGeneration(expected: ContinuityObserve): Promise<void> {
  const started = observeContinuity()
  if (
    !sameContinuityIdentity(expected, started)
    || started.mode !== 'continuous'
    || started.generation !== expected.generation
    || started.sessionId !== expected.sessionId
    || started.signature !== expected.signature
    || window.parent !== pinnedSource
  ) {
    return
  }
  const client = replaceBomReadClient()
  if (!client) return
  const serial = ++loadSerial
  loadStart = started
  loading.value = true
  try {
    const fresh = await client.requestBomReadToken()
    if (disposed || serial !== loadSerial) return
    // The stamp is this successor, not "any later session". A newer successor or an
    // identity switch fails this equality and cannot reuse the body.
    if (!sameContinuityIdentity(started, observeContinuity())) {
      clearRows()
      baseline = observeContinuity()
      return
    }
    const current = readManagedDescriptor()
    if (
      !current
      || current.continuityMode !== 'continuous'
      || current.credentialGeneration !== expected.generation
      || current.sessionId !== expected.sessionId
      || current.userId !== expected.userId
      || current.tenantId !== expected.tenantId
      || current.revision !== expected.revision
    ) {
      clearRows()
      baseline = observeContinuity()
      return
    }
    const fetched = await getPlmEmbedManagedBomContext(fresh)
    acceptBomResult(serial, started, fetched)
  } catch {
    if (!disposed && serial === loadSerial) {
      refuseRead(serial)
      baseline = observeContinuity()
    }
  } finally {
    if (!disposed && serial === loadSerial) loading.value = false
  }
}

function onContinuitySignal(): void {
  if (disposed || !tokenReceived.value || !pinnedSource) return
  const next = observeContinuity()
  const start = baseline ?? loadStart
  if (!start) {
    baseline = next
    return
  }
  if (authorizedSuccessor(start, next)) {
    baseline = next
    void refreshBomForGeneration(next)
    return
  }
  const leftContinuous = start.mode === 'continuous' && next.mode !== 'continuous'
  const generationMoved = start.generation !== next.generation
  if (!sameContinuityIdentity(start, next) || leftContinuous || generationMoved) {
    clearRows()
    baseline = observeContinuity()
    return
  }
  baseline = next
}

function processMessage(event: MessageEvent): void {
  if (tokenReceived.value) return // first valid token wins; ignore the rest
  if (!isOriginAllowed(event.origin)) return // reject non-allowlisted origin (no '*')
  // Only accept a token from the embedding parent. A real browser postMessage always sets
  // event.source, so when present it must be window.parent; a different (allowlisted-origin but
  // non-parent) window is rejected. Synthetic events with no source fall back to the origin gate.
  if (event.source && event.source !== window.parent) return
  const data = event.data
  if (!data || typeof data !== 'object') return
  if ((data as { type?: unknown }).type !== EMBED_TOKEN_MESSAGE_TYPE) return
  const token = (data as { token?: unknown }).token
  if (typeof token !== 'string' || !token) return
  void consumeToken(event.origin, token)
}

function onMessage(event: MessageEvent): void {
  if (!configReady.value) {
    pendingMessages.push(event) // buffer until the allowlist is loaded
    return
  }
  processMessage(event)
}

const unsubscribeContinuity = onAuthPrincipalChange(onContinuitySignal)

onMounted(async () => {
  // Attach the listener FIRST so a token posted while /config is in flight is not missed.
  window.addEventListener('message', onMessage)
  // One existing session read when this document already holds the managed probe.
  // Renewal stays inside bootstrap; this view does not start its own timer.
  if (readManagedProbeMarker() || readManagedDescriptor()) {
    try {
      await useAuth().bootstrapSession()
    } catch {
      // The handshake still fail-closes. A missed current session is not a BOM success.
    }
  }
  const config = await getPlmEmbedConfig()
  allowedOrigins.value = config.allowedOrigins
  visualPreviewEnabled.value = config.visualPreviewEnabled
  configReady.value = true
  const buffered = pendingMessages
  pendingMessages = []
  for (const event of buffered) processMessage(event)
})

onBeforeUnmount(() => {
  disposed = true
  loadSerial += 1
  window.removeEventListener('message', onMessage)
  bomReadClient?.dispose()
  bomReadClient = null
  unsubscribeContinuity()
})
</script>

<style scoped>
.plm-embed-bom { display: flex; flex-direction: column; gap: 8px; padding: 12px; }
.plm-embed-bom__head { display: flex; flex-direction: column; }
.plm-embed-bom__body { display: flex; flex-direction: column; gap: 8px; }
.plm-embed-bom__hint--muted { opacity: 0.6; }
.plm-embed-bom__hint--strong { font-weight: 600; }
.plm-embed-bom__collaboration--visual { display: grid; grid-template-columns: minmax(0, 3fr) minmax(280px, 2fr); gap: 20px; }
@media (max-width: 900px) { .plm-embed-bom__collaboration--visual { grid-template-columns: minmax(0, 1fr); } }

</style>
