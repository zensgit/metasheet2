<template>
  <section data-testid="plm-managed-discussion-view">
    <h1>元图讨论</h1>
    <template v-if="context">
      <PlmEmbedVisualPreviewPanel v-if="context.visualPreviewEnabled" :key="`visual:${panelKey}`" ref="visualPanel"
        :parent-origin="context.parentOrigin" :part-id="context.partId" :managed-source-id="context.sourceId"
        :comments="visualComments" :draft="visualDraft" :selected-id="selectedVisualComment" :busy="discussionBusy"
        @draft="visualDraft = $event" @select="selectVisualComment" />
      <PlmEmbedDiscussionPanel :key="panelKey" ref="discussionPanel" :parent-origin="context.parentOrigin"
        :managed-source-id="context.sourceId" :target="{ target_type: 'item', target_id: context.partId }"
        :visual-draft="visualDraft" :selected-comment-id="selectedVisualComment"
        @visual-comments="visualComments = $event" @clear-visual-draft="visualDraft = null"
        @visual-rejected="invalidateVisual" @select-visual-comment="selectVisualComment"
        @busy-change="discussionBusy = $event" />
    </template>
    <template v-else>
      <p data-testid="managed-discussion-message">{{ message }}</p>
      <a :href="signInPath" target="_blank" rel="noopener noreferrer" data-testid="managed-discussion-signin">在新窗口确认身份</a>
      <button type="button" :disabled="busy || !candidateOrigin" data-testid="managed-discussion-retry" @click="retry">确认后继续</button>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import PlmEmbedDiscussionPanel from '../components/plm/PlmEmbedDiscussionPanel.vue'
import PlmEmbedVisualPreviewPanel from '../components/plm/PlmEmbedVisualPreviewPanel.vue'
import type { VisualComment, VisualMarkupDraft } from '../services/integration/plmVisualMarkup'
import { discoverManagedDiscussion } from '../services/plm/plmManagedDiscussion'
import { createPlmEmbedReadTokenClient, type PlmEmbedReadTokenClient } from '../services/integration/plmEmbedWriteToken'
import { onAuthSessionSwitch, readAuthSessionSignature } from '../composables/authPrincipal'

type Context = { sourceId: string; partId: string; parentOrigin: string; visualPreviewEnabled?: true }
const context = ref<Context | null>(null)
const visualPanel = ref<InstanceType<typeof PlmEmbedVisualPreviewPanel> | null>(null)
const discussionPanel = ref<InstanceType<typeof PlmEmbedDiscussionPanel> | null>(null)
const visualDraft = ref<VisualMarkupDraft | null>(null)
const visualComments = ref<VisualComment[]>([])
const selectedVisualComment = ref<string | null>(null)
const discussionBusy = ref(false)
function clearContext(): void {
  context.value = null; visualDraft.value = null; visualComments.value = []
  selectedVisualComment.value = null; discussionBusy.value = false
}
function selectVisualComment(id: string): void {
  selectedVisualComment.value = id
  discussionPanel.value?.focusComment(id)
}
function invalidateVisual(reason: 'stale' | 'denied'): void {
  visualPanel.value?.invalidate(reason)
  if (reason === 'denied') { visualComments.value = []; selectedVisualComment.value = null }
}
const candidateOrigin = ref<string | null>(null)
const busy = ref(false)
const message = ref('请从元图入口打开并确认身份。')
const signInPath = '/plm/managed-entry' + window.location.search
const panelKey = computed(() => JSON.stringify(context.value))
let client: PlmEmbedReadTokenClient | null = null
let generation = 0, disposed = false, receivedInitial = false
function exactContext(value: unknown, origin: string): value is Context {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return (Object.keys(item).length === 3 && !('visualPreviewEnabled' in item)
    || Object.keys(item).length === 4 && item.visualPreviewEnabled === true)
    && Object.keys(item).every(key => ['sourceId', 'partId', 'parentOrigin', 'visualPreviewEnabled'].includes(key))
    && item.parentOrigin === origin
    && typeof item.sourceId === 'string' && Boolean(item.sourceId) && item.sourceId === item.sourceId.trim()
    && typeof item.partId === 'string' && Boolean(item.partId) && item.partId === item.partId.trim()
}
async function accept(token: () => Promise<string>, origin: string): Promise<void> {
  if (busy.value || disposed) return
  const current = ++generation, signature = readAuthSessionSignature()
  clearContext(); busy.value = true
  try {
    const raw = await token()
    if (disposed || current !== generation || signature !== readAuthSessionSignature()) return
    const result = await discoverManagedDiscussion(raw, origin)
    if (disposed || current !== generation || signature !== readAuthSessionSignature()) return
    if (result.ok && exactContext(result.data, origin)) {
      context.value = result.data
    } else message.value = '身份或当前来源未确认。请确认身份后重试。'
  } catch {
    if (!disposed && current === generation) message.value = '暂时无法确认讨论身份，请重试。'
  } finally { if (!disposed && current === generation) busy.value = false }
}
function onMessage(event: MessageEvent): void {
  if (window.parent === window || event.source !== window.parent || receivedInitial || busy.value || context.value) return
  if (event.data?.type !== 'plm-embed:token' || typeof event.data.token !== 'string' || !event.data.token || event.origin === 'null') return
  try { if (new URL(event.origin).origin !== event.origin) return } catch { return }
  receivedInitial = true
  candidateOrigin.value = event.origin
  client?.dispose()
  client = createPlmEmbedReadTokenClient(() => candidateOrigin.value)
  // The candidate becomes trusted only after the server compares it to the locked Native source.
  void accept(() => Promise.resolve(event.data.token), event.origin)
}
function retry(): void {
  const active = client, origin = candidateOrigin.value
  if (!active || !origin) return
  void accept(() => active.requestReadToken(), origin)
}
const unsubscribe = onAuthSessionSwitch(() => {
  generation += 1; clearContext(); busy.value = false
  client?.dispose()
  client = candidateOrigin.value ? createPlmEmbedReadTokenClient(() => candidateOrigin.value) : null
  message.value = '身份已改变，请重新确认当前讨论来源。'
})
onMounted(() => window.addEventListener('message', onMessage))
onBeforeUnmount(() => {
  disposed = true; generation += 1; clearContext()
  window.removeEventListener('message', onMessage); client?.dispose(); unsubscribe()
})
</script>
