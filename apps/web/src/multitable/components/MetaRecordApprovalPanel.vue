<!--
  审批 / Record approvals — a collapsible section at the foot of the record inspector's 详情 tab, right
  after 数据来源 (MetaRecordProvenancePanel), 多维表 × 审批 阶段二 (design
  docs/development/takeover-beiliao-20260821/multitable-approval-phase2-record-submit-design-20260915.md §5).

  What a business user gets: after submitting a record for approval, opening the record and expanding 审批
  shows every submission of THIS record — template, status, request number, who submitted it, when — plus
  a warning when the record has been edited since it was submitted.

  WIRE: GET /api/multitable/sheets/:sheetId/records/:recordId/approvals through the workbench's own
  client (`listRecordApprovals`). The route needs only sheet `canRead`; the record's own approval state
  comes from the multitable submissions table, never from /api/approvals (whose scope is
  requester/approver/cc/admin only — design §2 item 3).

  SELF-GATING: renders NOTHING unless a record, a sheetId and an apiClient are all present. The drawer is
  mounted by several frozen specs (and by MetaRecordDrawer.vue's compat shell) with no client at all —
  this component hides rather than crashing, the same discipline MetaRecordProvenancePanel follows.

  LAZY: the GET fires on FIRST EXPAND only — never on record open, so the record-detail critical path
  gains no request. Collapse/re-expand reuses the loaded list. A real change signal — the record's version
  moving (a `record-updated` refresh reaches this component as a new `record` prop, see
  MultitableWorkbench's realtime handler) or `refreshToken` being bumped by the inspector after a
  successful submit — always INVALIDATES that cache: an open section re-reads immediately, a collapsed one
  re-reads on its next expand (still lazy, never eager). A signal that lands mid-read is queued rather
  than dropped, because the read in flight is about to write pre-change rows.

  VALUES-FREE: renders identifiers, a status, a timestamp and a COUNT of changed fields. Drift never
  names a field and never shows a value (the route does not return one).

  ONE PAGE (backend #5763): the GET asks for an EXPLICIT `?limit=` and the route answers
  `{ submissions, hasMore }`. `hasMore` is the SERVER's truncation flag (a limit+1 probe) and is never
  inferred from the row count; the notice it renders counts the rows actually on screen and is never a
  total. There is no paging UI here on purpose (design §5 ships a section); the approval centre owns the
  full history.
  The same PR stamps `RECORD_APPROVAL_NOTIFICATION_FAILED` on a submission whose terminal write landed but
  whose requester notification did not; a terminal row carrying it gets a one-line marker, because
  otherwise the missing bell is invisible on a row that looks perfectly approved.
-->
<template>
  <section v-if="sectionVisible" class="meta-record-approval" data-test="record-approval">
    <button
      type="button"
      class="meta-record-approval__toggle"
      data-test="record-approval-toggle"
      :aria-expanded="expanded"
      :aria-controls="bodyId"
      :title="expanded ? l('approval.panelCollapse') : l('approval.panelExpand')"
      @click="onToggle"
    >
      <span class="meta-record-approval__caret" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
      <span class="meta-record-approval__title">{{ l('approval.panelTitle') }}</span>
    </button>
    <div v-if="expanded" :id="bodyId" class="meta-record-approval__body" data-test="record-approval-body">
      <div
        v-if="loading"
        class="meta-record-approval__hint"
        data-test="record-approval-loading"
      >{{ l('approval.panelLoading') }}</div>
      <div
        v-else-if="loadFailed"
        class="meta-record-approval__hint meta-record-approval__hint--error"
        data-test="record-approval-error"
      >{{ l('approval.panelError') }}</div>
      <ol
        v-else-if="submissions.length > 0"
        class="meta-record-approval__list"
        data-test="record-approval-list"
      >
        <li
          v-for="submission in submissions"
          :key="submission.id"
          class="meta-record-approval__entry"
          data-test="record-approval-entry"
        >
          <div class="meta-record-approval__entry-head">
            <strong
              class="meta-record-approval__template"
              data-test="record-approval-template"
            >{{ submission.templateName || submission.templateId }}</strong>
            <!-- 'creating'/'failed' describe the SUBMISSION, not an approval instance, and the shared
                 approvalInstance domain table does not carry them (statusDomains.ts) — its fallback would
                 print the raw English token in a zh UI. Those two are rendered locally with real copy;
                 every status StatusTag owns still goes through StatusTag. -->
            <StatusTag
              v-if="!localStatusLabel(submission.status)"
              domain="approvalInstance"
              size="sm"
              :status="submission.status"
            />
            <span
              v-else
              class="meta-record-approval__status"
              :data-status="submission.status"
              data-test="record-approval-local-status"
            >{{ localStatusLabel(submission.status) }}</span>
          </div>
          <div class="meta-record-approval__entry-meta">
            <span v-if="submission.requestNo" data-test="record-approval-request-no">
              {{ l('approval.requestNo') }}
              <RouterLink
                v-if="hasRouter && submission.approvalInstanceId"
                class="meta-record-approval__link"
                data-test="record-approval-request-link"
                :to="{ name: 'approval-detail', params: { id: submission.approvalInstanceId } }"
              >{{ submission.requestNo }}</RouterLink>
              <span v-else data-test="record-approval-request-text">{{ submission.requestNo }}</span>
            </span>
            <span data-test="record-approval-submitted-by">
              {{ l('approval.submittedBy') }}
              {{ submission.submittedByName || submission.submittedBy || l('approval.unknownActor') }}
            </span>
            <span v-if="submission.createdAt" data-test="record-approval-created-at">
              {{ l('approval.submittedAt') }} {{ formatApprovalTime(submission.createdAt) }}
            </span>
          </div>
          <!-- A failed submission otherwise gave the operator nothing: the row carries a sanitized
               refusal CODE (never a message, never a value). Render it as localized copy when we know the
               code, and NOTHING when we do not — a raw token is not an explanation. -->
          <div
            v-if="failureReason(submission)"
            class="meta-record-approval__failure"
            data-test="record-approval-failure"
          >{{ l('approval.failureReason') }}: {{ failureReason(submission) }}</div>
          <!-- A TERMINAL row whose write is correct but whose requester bell was never written
               (RECORD_APPROVAL_NOTIFICATION_FAILED). Without this line the miss is invisible: the row
               looks like every other approved one and the requester simply never heard. Values-free -
               a coded marker rendered as copy, exactly like the failure line above. -->
          <div
            v-if="notificationNotice(submission)"
            class="meta-record-approval__notification-failed"
            data-test="record-approval-notification-failed"
          >{{ notificationNotice(submission) }}</div>
          <div
            v-if="submission.drift.changed"
            class="meta-record-approval__drift"
            data-test="record-approval-drift"
          >{{ driftNotice(submission) }}</div>
        </li>
      </ol>
      <div
        v-else
        class="meta-record-approval__hint"
        data-test="record-approval-empty"
      >{{ l('approval.panelEmpty') }}</div>
      <!-- The route returned `hasMore` for the page we asked for: say so instead of presenting a
           truncated list as the whole history. No paging UI by design (§5 ships a section, not a list
           view) - the approval centre is where the rest lives.
           GATED ON THE LIST BEING ON SCREEN: `hasMore` survives a reload (it is the last answer the
           server gave, not a guess), but while the next read is in flight - or after it failed - the
           rows it counts are NOT rendered, and 「加载中」 + 「还有更多（仅显示最近 N 条）」 in the same
           body describes a list nobody can see. -->
      <div
        v-if="hasMore && !loading && !loadFailed"
        class="meta-record-approval__hint meta-record-approval__more"
        data-test="record-approval-has-more"
      >{{ hasMoreNotice }}</div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, useId, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import StatusTag from '../../components/status/StatusTag.vue'
import { useLocale } from '../../composables/useLocale'
import {
  recordApprovalDriftNotice,
  recordApprovalErrorLabel,
  recordApprovalHasMoreNotice,
  recordApprovalNotificationFailedNotice,
  recordApprovalSubmissionStatusLabel,
  recordLabel,
  type MetaRecordLabelKey,
} from '../utils/meta-record-labels'
import type { MultitableApiClient } from '../api/client'
import type { MetaRecord, MetaRecordApprovalSubmission } from '../types'

const props = defineProps<{
  record?: MetaRecord | null
  sheetId?: string
  apiClient?: MultitableApiClient
  /**
   * Bumped by the inspector after a successful submit. A plain counter (not the submission itself) so
   * this panel stays the ONE place that reads the list from the server — a locally-appended row would
   * be missing the server-computed drift and request number.
   */
  refreshToken?: number
}>()

const { isZh } = useLocale()
const l = (key: MetaRecordLabelKey) => recordLabel(key, isZh.value)
// Non-throwing inject (see MetaRecordInspector.vue's file header): the drawer mounts without a router in
// several frozen specs, so the request-number link is rendered only when a router really exists.
const hasRouter = !!useRouter()

/**
 * The page this panel asks for. EXPLICIT on purpose: the route has its own default and clamps to
 * [1, 100], and a UI that never names its page size inherits whatever the server later changes that
 * default to. Raising it here is the whole knob; there is no paging UI (design §5), the approval centre
 * owns the full history. It is NOT what the 「仅显示最近 N 条」 notice counts — see `hasMoreNotice`.
 */
const RECORD_APPROVAL_PAGE_SIZE = 20

const bodyId = `meta-record-approval-${useId()}`
const expanded = ref(false)
const loading = ref(false)
const loaded = ref(false)
const loadFailed = ref(false)
const submissions = ref<MetaRecordApprovalSubmission[]>([])
// Server-derived truncation flag for the page above - never a count, and never inferred from
// `submissions.length === RECORD_APPROVAL_PAGE_SIZE` (a record with exactly one full page has no more).
const hasMore = ref(false)

const sectionVisible = computed(() => Boolean(props.record && props.sheetId && props.apiClient))

// COUNT-FREE when the server masked every changed field id away (`{ changed: true, changedFieldIds: [] }`
// is a legitimate answer for an actor whose field-read mask hides the changed fields) — see the helper.
const driftNotice = (submission: MetaRecordApprovalSubmission) =>
  recordApprovalDriftNotice(submission.drift.changedFieldIds.length, isZh.value)

const localStatusLabel = (status: string) => recordApprovalSubmissionStatusLabel(status, isZh.value)

const failureReason = (submission: MetaRecordApprovalSubmission): string | null =>
  submission.status === 'failed' ? recordApprovalErrorLabel(submission.error, isZh.value) : null

// Terminal row + RECORD_APPROVAL_NOTIFICATION_FAILED => the marker; null for every other pair (an
// approved row WITHOUT the code renders nothing, a failed row keeps its single failure line).
const notificationNotice = (submission: MetaRecordApprovalSubmission): string | null =>
  recordApprovalNotificationFailedNotice(submission.status, submission.error, isZh.value)

// 「仅显示最近 N 条」 counts the rows RENDERED, never the page size we asked for: the client normaliser
// drops rows it cannot identify and a server is free to answer short, either of which would turn the
// requested 20 into a claim about rows that are not on screen.
const hasMoreNotice = computed(() => recordApprovalHasMoreNotice(submissions.value.length, isZh.value))

// Stale-response guard (same closure-counter idiom as MetaRecordProvenancePanel): a load whose captured
// version no longer matches when its await settles was superseded by a record switch, a refresh or the
// component unmounting, and must not write state however late it lands.
let activeLoadVersion = 0

// A change signal that arrives WHILE a read is in flight would otherwise be swallowed: the in-flight read
// is about to write the PRE-change rows and set `loaded`, and nothing re-arms it (so even a later
// collapse/re-expand would serve the stale cache for the life of the mount). Remember it and re-run from
// that read's own `finally`.
let refreshPending = false

function resetState(): void {
  activeLoadVersion += 1
  refreshPending = false
  expanded.value = false
  loading.value = false
  loaded.value = false
  loadFailed.value = false
  submissions.value = []
  hasMore.value = false
}

// Record navigation inside the drawer must not show the previous row's approvals.
watch(() => props.record?.id, () => {
  resetState()
})

// A real change signal: the record's version moved (the workbench re-read it after a `record-updated`
// realtime event or a local patch) or the inspector bumped refreshToken after a submit. The CACHE is
// invalidated either way — including while collapsed, where an edit used to be dropped permanently
// because `loaded` stayed true and the next expand was a no-op. Only the FETCH is conditional: a
// collapsed panel stays lazy and re-reads on its next expand.
//
// ARRAY OF GETTERS, not one getter returning an array. The earlier shape
// (`() => [props.record?.version, props.refreshToken] as const`) allocated a NEW array on every
// evaluation, and `watch` compares a getter's result with `Object.is` — two arrays holding the same
// two numbers are never `Object.is`-equal, so the callback fired on EVERY re-evaluation of the source,
// i.e. every time the workbench handed this panel a fresh `record` object. The grid replaces
// `record` wholesale on any page reload / re-read, version unchanged, so an OPEN panel issued a
// redundant GET each time — a request storm driven by nothing the user changed. With the multi-source
// form Vue compares PER ELEMENT, so an equal-version replacement is a no-op and only a real
// version/token move reaches the body. A record SWITCH is not this watcher's job either way: the
// `props.record?.id` watcher above already calls `resetState()` (which clears `loaded`), so a
// same-version switch to a different record still invalidates. Semantics below are unchanged.
watch(
  [() => props.record?.version, () => props.refreshToken],
  () => {
    loaded.value = false
    if (!expanded.value) return
    if (loading.value) {
      refreshPending = true
      return
    }
    void loadSubmissions()
  },
)

onUnmounted(() => {
  activeLoadVersion += 1
})

async function loadSubmissions(): Promise<void> {
  if (loaded.value || loading.value) return
  const client = props.apiClient
  const sheetId = props.sheetId
  const recordId = props.record?.id
  const loadVersion = ++activeLoadVersion
  if (!client || !sheetId || !recordId) {
    submissions.value = []
    hasMore.value = false
    loaded.value = true
    return
  }
  loading.value = true
  loadFailed.value = false
  try {
    const page = await client.listRecordApprovals(sheetId, recordId, { limit: RECORD_APPROVAL_PAGE_SIZE })
    if (loadVersion !== activeLoadVersion) return
    submissions.value = page.submissions
    hasMore.value = page.hasMore
    loaded.value = true
  } catch {
    if (loadVersion !== activeLoadVersion) return
    // A failed read shows the error state only: a stale truncation notice under it would be a claim
    // about an answer we never got.
    hasMore.value = false
    loadFailed.value = true
  } finally {
    if (loadVersion === activeLoadVersion) {
      loading.value = false
      if (refreshPending) {
        refreshPending = false
        // What we just wrote predates the signal that arrived mid-flight: drop it and read again.
        loaded.value = false
        if (expanded.value) void loadSubmissions()
      }
    }
  }
}

function onToggle(): void {
  expanded.value = !expanded.value
  if (expanded.value) void loadSubmissions()
}

function formatApprovalTime(value: string): string {
  if (!value) return ''
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return value
  return new Date(timestamp).toLocaleString()
}
</script>

<style scoped>
.meta-record-approval { margin-top: 16px; border-top: 1px solid #e2e8f0; padding-top: 10px; }
.meta-record-approval__toggle { display: flex; align-items: center; gap: 6px; background: none; border: none; padding: 0; cursor: pointer; color: #475569; font-size: 12px; font-weight: 600; }
.meta-record-approval__caret { font-size: 10px; color: #94a3b8; }
.meta-record-approval__title { letter-spacing: 0.02em; }
.meta-record-approval__body { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
.meta-record-approval__hint { font-size: 12px; color: #94a3b8; }
.meta-record-approval__hint--error { color: #b45309; }
.meta-record-approval__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.meta-record-approval__entry { display: flex; flex-direction: column; gap: 3px; border-left: 2px solid #e2e8f0; padding-left: 8px; }
.meta-record-approval__entry-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.meta-record-approval__template { font-size: 12px; color: #1e293b; }
.meta-record-approval__entry-meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 11px; color: #64748b; }
.meta-record-approval__link { color: var(--ms-color-primary, #409eff); }
.meta-record-approval__drift { font-size: 11px; color: #b45309; }
.meta-record-approval__failure { font-size: 11px; color: #b91c1c; }
.meta-record-approval__notification-failed { font-size: 11px; color: #b45309; }
.meta-record-approval__more { color: #b45309; }
.meta-record-approval__status { font-size: 11px; color: #64748b; background: #f1f5f9; border-radius: 4px; padding: 1px 6px; }
</style>
