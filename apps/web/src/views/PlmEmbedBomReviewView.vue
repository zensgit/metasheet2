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
        加载 BOM review 失败（PLM 暂时不可用），请稍后重试。
      </p>
      <p v-else-if="reviewState === 'empty'" class="plm-embed-bom__hint">
        未找到该 Part 的 BOM 数据。
      </p>

      <PlmBomReviewTable v-else-if="reviewState === 'table' && context" :context="context" />
    </div>
  </section>
</template>

<script setup lang="ts">
// PLM-COLLAB P3-D2 (frontend): the token-bound BOM-review embed page.
//
// Handshake (LISTEN-only; this page never posts to the parent, so there is no targetOrigin '*' to
// leak through):
//   1. fetch /api/plm-embed/config for the parent-origin allowlist -- the SINGLE source of truth,
//      never a URL parameter, and never containing '*'.
//   2. wait for the parent to postMessage the PLM-minted embed token. Accept it ONLY from an origin
//      in the allowlist (strict exact match); pin that origin. An empty allowlist accepts nothing.
//   3. call /api/plm-embed/bom-review/context with the token in the X-PLM-Embed-Token header. There
//      is NO part input -- the part is bound to the token's part_id claim on the server.
//   4. render the identical read-only table the standalone panel uses.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  getPlmEmbedBomContext,
  getPlmEmbedConfig,
  type PlmEmbedBomResult,
} from '../services/integration/plmEmbed'
import PlmBomReviewTable from '../components/plm/PlmBomReviewTable.vue'

// the inbound postMessage envelope: { type: 'plm-embed:token', token: '<jwt>' }
const EMBED_TOKEN_MESSAGE_TYPE = 'plm-embed:token'

const configReady = ref(false)
const allowedOrigins = ref<string[]>([])
// pinned to the first allowlisted sender; kept for any future outbound use (none today)
const parentOrigin = ref<string | null>(null)
const tokenReceived = ref(false)
const loading = ref(false)
const result = ref<PlmEmbedBomResult | null>(null)
// messages that arrive before the allowlist is known are buffered, then re-validated in order
let pendingMessages: MessageEvent[] = []

const context = computed(() => (result.value && result.value.available ? result.value.context : null))

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
// (entitled but the provider fetch failed transiently), empty (entitled, no context, no reason =
// part not found), table (entitled + context).
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

function isOriginAllowed(origin: string): boolean {
  // Single source = the server /config allowlist, which NEVER contains '*'. An empty list is
  // fail-closed: nothing is accepted. Strict exact-match only -- no wildcard, no prefix.
  return allowedOrigins.value.length > 0 && allowedOrigins.value.includes(origin)
}

async function consumeToken(origin: string, token: string): Promise<void> {
  parentOrigin.value = origin // pin the trusted parent origin
  tokenReceived.value = true
  loading.value = true
  try {
    result.value = await getPlmEmbedBomContext(token)
  } catch {
    result.value = { available: false, reason: 'unavailable' }
  } finally {
    loading.value = false
  }
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

onMounted(async () => {
  // Attach the listener FIRST so a token posted while /config is in flight is not missed.
  window.addEventListener('message', onMessage)
  const config = await getPlmEmbedConfig()
  allowedOrigins.value = config.allowedOrigins
  configReady.value = true
  const buffered = pendingMessages
  pendingMessages = []
  for (const event of buffered) processMessage(event)
})

onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
})
</script>

<style scoped>
.plm-embed-bom { display: flex; flex-direction: column; gap: 8px; padding: 12px; }
.plm-embed-bom__head { display: flex; flex-direction: column; }
.plm-embed-bom__body { display: flex; flex-direction: column; gap: 8px; }
.plm-embed-bom__hint--muted { opacity: 0.6; }
.plm-embed-bom__hint--strong { font-weight: 600; }
</style>
