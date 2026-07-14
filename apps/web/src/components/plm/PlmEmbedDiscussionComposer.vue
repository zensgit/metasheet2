<template>
  <form class="plm-discussion-composer" data-testid="plm-discussion-composer" @submit.prevent="submit">
    <label class="plm-discussion-composer__label" :for="fieldId">在此 Part 上发起讨论</label>
    <textarea
      :id="fieldId"
      v-model="draft"
      class="plm-discussion-composer__input"
      data-testid="plm-discussion-composer-input"
      rows="3"
      :disabled="busy || !canWrite"
      :placeholder="canWrite ? '写下评论…' : '嵌入授权已失效，请从 PLM 重新打开'"
    ></textarea>
    <div class="plm-discussion-composer__row">
      <button
        type="submit"
        class="plm-discussion-composer__submit"
        data-testid="plm-discussion-composer-submit"
        :disabled="busy || !canWrite || draft.trim().length === 0"
      >{{ busy ? '提交中…' : '提交评论' }}</button>
      <span
        v-if="status"
        class="plm-discussion-composer__status"
        :data-testid="'plm-discussion-composer-status'"
        :data-kind="status.kind"
      >{{ status.text }}</span>
    </div>
  </form>
</template>

<script setup lang="ts">
// Cut 3 — the visible write form. Owns ONE child→parent token client for the lifetime of this
// mount (keyed by target in the parent view, so switching Part remounts it). Every submit mints a
// FRESH single-use embed token (never cached, never replayed); one token authorizes exactly one
// relay call; a failure leaves the draft so a retry mints a brand-new token. The client is disposed
// on unmount, and submit is disabled the moment the pinned parent origin is lost. Runtime stays
// dark: with DISCUSSION_SESSION_ENABLED off, the relay/exchange returns the uniform 401 that the
// error branch surfaces -- no client change needed to keep it dark.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { createPlmEmbedWriteTokenClient, type PlmEmbedWriteTokenClient } from '../../services/integration/plmEmbedWriteToken'
import { createDiscussionThread, type CreateThreadInput } from '../../services/integration/plmEmbedDiscussionWrite'

const props = defineProps<{
  /** The origin the READ handshake pinned; null before pinning or after it is lost. */
  parentOrigin: string | null
  /** The token-bound discussion target for this embed (part-bound). */
  target: { target_type: CreateThreadInput['target_type']; target_id: string }
}>()

const emit = defineEmits<{ (e: 'created', data: unknown): void }>()

const fieldId = `plm-disc-composer-${Math.random().toString(36).slice(2, 8)}`
const draft = ref('')
const busy = ref(false)
const status = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)

// Read the pinned origin LIVE per request (same single source of truth the read page pins). A
// disposed flag makes the client fail-closed after teardown.
let client: PlmEmbedWriteTokenClient | null = createPlmEmbedWriteTokenClient(() => props.parentOrigin)

const canWrite = computed(() => Boolean(props.parentOrigin) && client !== null)

function disposeClient(): void {
  if (client) {
    client.dispose()
    client = null
  }
}

// Lost pinned origin -> immediately disable submit + dispose (no dangling channel).
watch(
  () => props.parentOrigin,
  (origin) => {
    if (!origin) disposeClient()
  },
)

async function submit(): Promise<void> {
  if (busy.value || !canWrite.value || !client) return
  const body = draft.value.trim()
  if (!body) return
  busy.value = true
  status.value = null
  try {
    // ONE fresh, single-use token per submit -- requested at submit time, held only for this call.
    const token = await client.requestWriteToken()
    const result = await createDiscussionThread(token, {
      target_type: props.target.target_type,
      target_id: props.target.target_id,
      body,
    })
    if (result.ok) {
      draft.value = ''
      status.value = { kind: 'ok', text: '已提交' }
      emit('created', result.data)
    } else {
      // Failure: keep the draft; a retry issues a BRAND-NEW requestWriteToken (never a replay).
      status.value = { kind: 'error', text: '提交失败，请重试' }
    }
  } catch {
    status.value = { kind: 'error', text: '提交失败，请重试' }
  } finally {
    busy.value = false
  }
}

onBeforeUnmount(disposeClient)
</script>

<style scoped>
.plm-discussion-composer { display: flex; flex-direction: column; gap: 6px; padding: 8px 0; }
.plm-discussion-composer__label { font-weight: 600; }
.plm-discussion-composer__input { width: 100%; box-sizing: border-box; resize: vertical; }
.plm-discussion-composer__row { display: flex; align-items: center; gap: 10px; }
.plm-discussion-composer__status[data-kind='error'] { color: #b00020; }
.plm-discussion-composer__status[data-kind='ok'] { color: #1a7f37; }
</style>
