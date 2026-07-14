<template>
  <section class="plm-disc-panel" data-testid="plm-discussion-panel">
    <header class="plm-disc-panel__head"><strong>讨论</strong></header>

    <!-- Create a new thread. -->
    <form class="plm-disc-panel__composer" data-testid="plm-discussion-create" @submit.prevent="create">
      <textarea
        v-model="draft"
        class="plm-disc-panel__input"
        data-testid="plm-discussion-create-input"
        rows="3"
        :disabled="busy || !canWrite"
        :placeholder="canWrite ? '在此 Part 上发起讨论…' : '嵌入授权已失效，请从 PLM 重新打开'"
      ></textarea>
      <button
        type="submit"
        data-testid="plm-discussion-create-submit"
        :disabled="busy || !canWrite || draft.trim().length === 0"
      >{{ busy ? '提交中…' : '发起讨论' }}</button>
    </form>

    <p v-if="error" class="plm-disc-panel__error" data-testid="plm-discussion-error">{{ error }}</p>

    <!-- Threads created / acted on in this embed session (server-confirmed from write responses). A
         full list of a Part's PRE-EXISTING threads needs a discussion READ relay route + read-auth
         that does not exist yet (a separate, ratification-gated backend slice). -->
    <ul class="plm-disc-panel__threads" data-testid="plm-discussion-threads">
      <li v-for="t in threads" :key="t.id" class="plm-disc-panel__thread" :data-thread-id="t.id" :data-status="t.status">
        <div class="plm-disc-panel__thread-head">
          <span class="plm-disc-panel__status" :data-testid="`plm-discussion-thread-status-${t.id}`">{{ t.status }}</span>
          <button
            v-if="t.status === 'open'"
            type="button"
            :data-testid="`plm-discussion-resolve-${t.id}`"
            :disabled="busy || !canWrite"
            @click="transition(t.id, 'resolve')"
          >标记已解决</button>
          <button
            v-else-if="t.status === 'resolved'"
            type="button"
            :data-testid="`plm-discussion-reopen-${t.id}`"
            :disabled="busy || !canWrite"
            @click="transition(t.id, 'reopen')"
          >重新打开</button>
        </div>
        <ul class="plm-disc-panel__comments">
          <li v-for="c in t.comments" :key="c.id" class="plm-disc-panel__comment">{{ c.body ?? '（已删除）' }}</li>
        </ul>
        <form class="plm-disc-panel__reply" @submit.prevent="reply(t.id)">
          <input
            v-model="replyDraft[t.id]"
            :data-testid="`plm-discussion-reply-input-${t.id}`"
            :disabled="busy || !canWrite"
            placeholder="回复…"
          />
          <button
            type="submit"
            :data-testid="`plm-discussion-reply-submit-${t.id}`"
            :disabled="busy || !canWrite || !(replyDraft[t.id] || '').trim()"
          >回复</button>
        </form>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
// Cut-3 next slice — the discussion panel: create + reply + resolve + reopen, all four wired.
// Owns ONE token client for its mount; EACH action independently mints a FRESH single-use token
// (client.requestWriteToken() per action, one token = one relay call). After a successful action
// the thread is replaced by the SERVER's response (DiscussionThreadDetail) -- never a local
// optimistic mutation. The client is disposed on unmount and the moment the pinned origin is lost.
// Dark: with DISCUSSION_SESSION_ENABLED off the exchange returns the uniform 401 and the action
// surfaces a clean error.
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { createPlmEmbedWriteTokenClient, type PlmEmbedWriteTokenClient } from '../../services/integration/plmEmbedWriteToken'
import {
  createDiscussionThread,
  addDiscussionComment,
  resolveDiscussionThread,
  reopenDiscussionThread,
  type CreateThreadInput,
  type PlmDiscussionWriteResult,
} from '../../services/integration/plmEmbedDiscussionWrite'

interface ThreadComment { id: string; body: string | null }
interface ThreadDetail { id: string; status: string; comments: ThreadComment[] }

const props = defineProps<{
  parentOrigin: string | null
  target: { target_type: CreateThreadInput['target_type']; target_id: string }
}>()

const draft = ref('')
const replyDraft = reactive<Record<string, string>>({})
const busy = ref(false)
const error = ref<string | null>(null)
const threads = ref<ThreadDetail[]>([])

let client: PlmEmbedWriteTokenClient | null = createPlmEmbedWriteTokenClient(() => props.parentOrigin)
const canWrite = computed(() => Boolean(props.parentOrigin) && client !== null)

function disposeClient(): void {
  if (client) { client.dispose(); client = null }
}
watch(() => props.parentOrigin, (o) => { if (!o) disposeClient() })

function asThread(data: unknown): ThreadDetail | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (typeof d.id !== 'string' || typeof d.status !== 'string') return null
  const comments = Array.isArray(d.comments)
    ? (d.comments as Record<string, unknown>[]).map((c) => ({ id: String(c.id), body: typeof c.body === 'string' ? c.body : null }))
    : []
  return { id: d.id, status: d.status, comments }
}

// Wraps a single action: mint ONE fresh token, run the relay call, apply the server response.
async function run(call: (token: string) => Promise<PlmDiscussionWriteResult>, apply: (t: ThreadDetail) => void): Promise<void> {
  if (busy.value || !canWrite.value || !client) return
  busy.value = true
  error.value = null
  try {
    const token = await client.requestWriteToken() // fresh, single-use, per action
    const result = await call(token)
    if (result.ok) {
      const t = asThread(result.data)
      if (t) apply(t)
    } else {
      error.value = '操作失败，请重试' // failure keeps drafts; a retry mints a brand-new token
    }
  } catch {
    error.value = '操作失败，请重试'
  } finally {
    busy.value = false
  }
}

function upsert(t: ThreadDetail): void {
  const i = threads.value.findIndex((x) => x.id === t.id)
  if (i >= 0) threads.value.splice(i, 1, t)
  else threads.value.unshift(t)
}

async function create(): Promise<void> {
  const body = draft.value.trim()
  if (!body) return
  await run(
    (token) => createDiscussionThread(token, { target_type: props.target.target_type, target_id: props.target.target_id, body }),
    (t) => { upsert(t); draft.value = '' },
  )
}

async function reply(threadId: string): Promise<void> {
  const body = (replyDraft[threadId] || '').trim()
  if (!body) return
  await run(
    (token) => addDiscussionComment(token, threadId, { body }),
    (t) => { upsert(t); replyDraft[threadId] = '' },
  )
}

async function transition(threadId: string, kind: 'resolve' | 'reopen'): Promise<void> {
  await run(
    (token) => (kind === 'resolve' ? resolveDiscussionThread : reopenDiscussionThread)(token, threadId),
    upsert,
  )
}

onBeforeUnmount(disposeClient)
</script>

<style scoped>
.plm-disc-panel { display: flex; flex-direction: column; gap: 10px; padding: 8px 0; }
.plm-disc-panel__composer, .plm-disc-panel__reply { display: flex; gap: 8px; align-items: flex-start; }
.plm-disc-panel__input { flex: 1; box-sizing: border-box; resize: vertical; }
.plm-disc-panel__threads { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
.plm-disc-panel__thread { border: 1px solid #ddd; border-radius: 6px; padding: 8px; }
.plm-disc-panel__thread-head { display: flex; align-items: center; gap: 8px; }
.plm-disc-panel__status { font-weight: 600; }
.plm-disc-panel__comments { list-style: disc; margin: 6px 0; padding-left: 18px; }
.plm-disc-panel__error { color: #b00020; }
</style>
