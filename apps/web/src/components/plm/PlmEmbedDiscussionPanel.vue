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

    <!-- The REAL thread list for this Part, fetched from the discussion read relay on mount (and
         whenever the pinned parent origin newly becomes available). Includes BOTH open AND
         resolved threads (the relay sends a fixed include_resolved=true) -- a historical resolved
         thread loaded from the server still renders its "reopen" affordance below, same as one
         resolved this session. List summaries start with EMPTY comments (the list omits them);
         `upsert` from a write/detail response replaces a thread's full state in place. -->
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
          <button
            v-if="!detailLoaded[t.id]"
            type="button"
            :data-testid="`plm-discussion-load-detail-${t.id}`"
            :disabled="!canRead || detailBusy[t.id]"
            @click="loadDetail(t.id)"
          >{{ detailBusy[t.id] ? '加载中…' : '加载详情' }}</button>
        </div>
        <ul class="plm-disc-panel__comments">
          <li v-for="(c, ci) in t.comments" :key="c.id ?? `${t.id}-c${ci}`" class="plm-disc-panel__comment">{{ c.body ?? '（已删除）' }}</li>
        </ul>
        <!-- REPLY-GATING LOCK: the input + submit stay disabled until this thread's DETAIL has
             been fetched (detailLoaded[t.id]) AND it has a root (first) comment. A thread whose
             detail was never loaded, or that loaded with no root comment, can never be replied to
             from here -- `reply()` below re-checks the same condition and returns early
             (fail-closed), so a disabled control is defense in depth, not the only gate. -->
        <form class="plm-disc-panel__reply" @submit.prevent="reply(t.id)">
          <input
            v-model="replyDraft[t.id]"
            :data-testid="`plm-discussion-reply-input-${t.id}`"
            :disabled="busy || !canWrite || !replyEnabled(t.id)"
            :placeholder="replyEnabled(t.id) ? '回复…' : '请先加载详情'"
          />
          <button
            type="submit"
            :data-testid="`plm-discussion-reply-submit-${t.id}`"
            :disabled="busy || !canWrite || !replyEnabled(t.id) || !(replyDraft[t.id] || '').trim()"
          >回复</button>
        </form>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
// Discussion panel — real relay list/detail + reply-gating lock. Owns TWO token clients for its
// mount: a WRITE client (create/reply/resolve/reopen, unchanged from the prior slice) and a READ
// client (list/detail, new here). Each action independently mints a FRESH single-use token right
// before its own relay call (one token = one relay call, never cached/reused). After a successful
// WRITE the affected thread is replaced by the SERVER's response (full DiscussionThreadDetail) --
// never a local optimistic mutation. Both clients are disposed on unmount and the moment the
// pinned origin is lost.
//
// Local thread model: `threads` holds EITHER a list SUMMARY (comments: [], detailLoaded: false)
// OR a full DETAIL (comments populated, detailLoaded: true) -- a write response and a detail fetch
// are both "full detail" and go through `upsert`, which is the ONLY path that ever sets
// `detailLoaded[id] = true`. A list refresh goes through `applySummary`, which updates an existing
// thread's status WITHOUT touching its comments/detailLoaded, so a thread already loaded this
// session (via create/reply/resolve/reopen or an explicit detail load) keeps its full state across
// a later list reload.
//
// Reply-gating lock (security-critical): reply is enabled ONLY when detailLoaded[threadId] is true
// AND that thread's comments[0] exists. FAIL CLOSED with no root: a loaded-but-empty comments[]
// keeps reply disabled forever for that thread and the reply handler returns early -- there is no
// code path that falls back to sending a bare top-level `{ body }` comment.
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import {
  createPlmEmbedWriteTokenClient,
  createPlmEmbedReadTokenClient,
  type PlmEmbedWriteTokenClient,
  type PlmEmbedReadTokenClient,
} from '../../services/integration/plmEmbedWriteToken'
import {
  createDiscussionThread,
  addDiscussionComment,
  resolveDiscussionThread,
  reopenDiscussionThread,
  type CreateThreadInput,
  type PlmDiscussionWriteResult,
} from '../../services/integration/plmEmbedDiscussionWrite'
import {
  listDiscussionThreads,
  getDiscussionThread,
  type PlmDiscussionReadResult,
} from '../../services/integration/plmEmbedDiscussionRead'

interface ThreadComment { id: string | null; body: string | null }
interface ThreadDetail { id: string; status: string; comments: ThreadComment[] }
interface ThreadSummary { id: string; status: string }

const props = defineProps<{
  parentOrigin: string | null
  target: { target_type: CreateThreadInput['target_type']; target_id: string }
}>()

const draft = ref('')
const replyDraft = reactive<Record<string, string>>({})
const busy = ref(false)
const error = ref<string | null>(null)
const threads = ref<ThreadDetail[]>([])
// Set to true ONLY by `upsert` (a full-detail apply, from a write response or an explicit detail
// fetch) -- the reply-gating lock's source of truth.
const detailLoaded = reactive<Record<string, boolean>>({})
const detailBusy = reactive<Record<string, boolean>>({})

let client: PlmEmbedWriteTokenClient | null = createPlmEmbedWriteTokenClient(() => props.parentOrigin)
let readClient: PlmEmbedReadTokenClient | null = createPlmEmbedReadTokenClient(() => props.parentOrigin)
const canWrite = computed(() => Boolean(props.parentOrigin) && client !== null)
const canRead = computed(() => Boolean(props.parentOrigin) && readClient !== null)

function disposeClient(): void {
  if (client) { client.dispose(); client = null }
}
function disposeReadClient(): void {
  if (readClient) { readClient.dispose(); readClient = null }
}
watch(() => props.parentOrigin, (o) => {
  if (!o) {
    disposeClient()
    disposeReadClient()
  }
})
// Real list on mount (and again if the pinned origin transitions to a new truthy value, e.g. the
// handshake finishes after an initial null render).
watch(() => props.parentOrigin, (o) => { if (o) loadThreads() }, { immediate: true })

function asThread(data: unknown): ThreadDetail | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (typeof d.id !== 'string' || typeof d.status !== 'string') return null
  const comments = Array.isArray(d.comments)
    ? (d.comments as Record<string, unknown>[]).map((c) => ({
        // FAIL CLOSED (adversarial-verify P3): only a real non-empty string id counts. String(c.id)
        // would coerce a missing/object/null id to a TRUTHY "undefined"/"[object Object]"/"null",
        // unlocking reply + minting a write token for a comment with no real parent. null keeps the
        // comment visible but makes replyEnabled() fail closed for a rootless-id thread.
        id: typeof c.id === 'string' && c.id ? c.id : null,
        body: typeof c.body === 'string' ? c.body : null,
      }))
    : []
  return { id: d.id, status: d.status, comments }
}

function asThreadSummary(data: unknown): ThreadSummary | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (typeof d.id !== 'string' || typeof d.status !== 'string') return null
  return { id: d.id, status: d.status }
}

function replyEnabled(threadId: string): boolean {
  if (detailLoaded[threadId] !== true) return false
  const thread = threads.value.find((x) => x.id === threadId)
  const rootId = thread?.comments[0]?.id
  return typeof rootId === 'string' && rootId.length > 0
}

// Applies a server LIST summary: a not-yet-seen thread is added with EMPTY comments (the list
// omits them, so it starts detail-NOT-loaded); an already-known thread has ONLY its status synced
// -- comments/detailLoaded are left untouched, so a thread already fully loaded (this session or
// via an earlier detail fetch) keeps its full state across a later list reload.
function applySummary(s: ThreadSummary): void {
  const i = threads.value.findIndex((x) => x.id === s.id)
  if (i >= 0) {
    threads.value.splice(i, 1, { ...threads.value[i], status: s.status })
  } else {
    threads.value.push({ id: s.id, status: s.status, comments: [] })
    detailLoaded[s.id] = false
  }
}

// Applies a server FULL detail (a write response OR an explicit detail fetch): replaces the
// thread's comments wholesale and marks detail-loaded. The ONLY path that ever sets
// detailLoaded[id] = true.
function upsert(t: ThreadDetail): void {
  const i = threads.value.findIndex((x) => x.id === t.id)
  if (i >= 0) threads.value.splice(i, 1, t)
  else threads.value.unshift(t)
  detailLoaded[t.id] = true
}

async function loadThreads(): Promise<void> {
  if (!readClient) return
  try {
    const token = await readClient.requestReadToken() // fresh, single-use, this read only
    const result: PlmDiscussionReadResult = await listDiscussionThreads(token)
    if (result.ok) {
      const data = result.data as { threads?: unknown[] } | null
      const list = Array.isArray(data?.threads) ? data.threads : []
      for (const raw of list) {
        const summary = asThreadSummary(raw)
        if (summary) applySummary(summary)
      }
    } else {
      error.value = '加载讨论列表失败，请重试'
    }
  } catch {
    error.value = '加载讨论列表失败，请重试'
  }
}

async function loadDetail(threadId: string): Promise<void> {
  if (!readClient || detailBusy[threadId]) return
  detailBusy[threadId] = true
  try {
    const token = await readClient.requestReadToken() // fresh, single-use, this read only
    const result: PlmDiscussionReadResult = await getDiscussionThread(token, threadId)
    if (result.ok) {
      const t = asThread(result.data)
      if (t) upsert(t)
    } else {
      error.value = '加载讨论详情失败，请重试'
    }
  } catch {
    error.value = '加载讨论详情失败，请重试'
  } finally {
    detailBusy[threadId] = false
  }
}

// Wraps a single WRITE action: mint ONE fresh token, run the relay call, apply the server response.
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

async function create(): Promise<void> {
  const body = draft.value.trim()
  if (!body) return
  await run(
    (token) => createDiscussionThread(token, { target_type: props.target.target_type, target_id: props.target.target_id, body }),
    (t) => { upsert(t); draft.value = '' },
  )
}

async function reply(threadId: string): Promise<void> {
  // FAIL CLOSED: no loaded root comment for this thread -> never send anything, never fall back
  // to a bare top-level `{ body }` comment. Mirrors the disabled control above (defense in depth).
  if (!replyEnabled(threadId)) return
  const body = (replyDraft[threadId] || '').trim()
  if (!body) return
  const thread = threads.value.find((x) => x.id === threadId)
  const parentId = thread?.comments[0]?.id
  if (typeof parentId !== 'string' || !parentId) return // never send without a real root id
  await run(
    (token) => addDiscussionComment(token, threadId, { body, parent_comment_id: parentId }),
    (t) => { upsert(t); replyDraft[threadId] = '' },
  )
}

async function transition(threadId: string, kind: 'resolve' | 'reopen'): Promise<void> {
  await run(
    (token) => (kind === 'resolve' ? resolveDiscussionThread : reopenDiscussionThread)(token, threadId),
    upsert,
  )
}

onBeforeUnmount(() => {
  disposeClient()
  disposeReadClient()
})
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
