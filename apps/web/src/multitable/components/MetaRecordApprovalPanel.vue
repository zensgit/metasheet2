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

  审批进度 (Q17): a row with an `approvalInstanceId` also offers a COLLAPSED 「查看进度」 card that reads the
  approval INSTANCE — `GET /api/approvals/:id` + `/history`, through the approval centre's own
  `getApproval`/`getApprovalHistory`. Three rules make that safe to put on a multitable surface:
    * GATE. The card (toggle included) renders only when the viewer holds `approvals:read` on the FE —
      the SAME `useApprovalPermissions()` gate ApprovalCenterView/ApprovalDetailView use. Without it
      NOTHING new is rendered and no request is ever issued: the existing request-number link and the
      submissions list, which come from the multitable route's own `canRead`, are untouched. This is a
      fail-closed CONVENIENCE gate, not the authority — the server re-decides both reads (rbacGuard
      `approvals:read` first, then the per-instance participant predicate).
    * LAZY, PER INSTANCE. The pair of reads fires on FIRST EXPAND of THAT row's card only, in parallel,
      and is cached per `approvalInstanceId`. Collapse/re-expand reuses it; nothing polls, nothing
      subscribes, nothing auto-retries.
    * FRESHNESS. The cache is dropped by the SAME invalidation path the submissions list already has
      (record switch, record version move, `refreshToken` bump) — see `invalidateProgress`. Progress that
      predates an approval action is worse than no progress, so an invalidation also COLLAPSES every open
      card: the next expand is a real re-read, and the panel stays lazy (no request is issued by the
      invalidation itself).
  VALUES-FREE degradation: 403 (no approvals:read on the server) and 404 (`APPROVAL_NOT_FOUND`, the
  values-free answer a non-participant gets for an approval that does exist) are DIFFERENT sentences, an
  answer that is not ABOUT this instance is a THIRD, and everything else is one generic failure with a
  manual 重试. None of the four carries the thrown message, a status code, or anything else the server
  said — the spec pins each by EQUALITY, not by substring, so a later 'improvement' that appends
  `error.message` is red rather than green.
    * IDENTITY (and what it says about DEV servers). `GET /api/approvals/:id` builds its DTO from
      `SELECT * FROM approval_instances WHERE id = $1` and returns `id: row.id`
      (ApprovalBridgeService.toUnifiedDTO), so a real answer echoes the requested id on BOTH the platform
      and the PLM branch; a `detail.id` that differs is another approval's timeline about to be printed
      under this record's row, and is refused. That check is also the only thing standing between this
      card and `approvals/api.ts`'s mock branch, which short-circuits `getApproval`/`getApprovalHistory`
      to module FIXTURES whenever `import.meta.env.DEV` is set without an explicit
      `__APPROVAL_MOCK__ === false`, answering `apv_1` (`parseInt(id.replace('apv_', ''), 10) || 1`) for
      every id this panel can hold. Suppressing the mock at its source would need `approvals/api.ts` to
      export the flag — an owner ask, not this panel's call. Until then a dev-server walkthrough shows
      the mismatch notice here, and is NOT evidence that the 步骤 / 待处理人 / 历史 rendering is correct.
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
            <!-- 完成时间: data the list route ALREADY returns and the panel never rendered. TERMINAL rows
                 only (isRecordApprovalTerminalStatus — the same set the notification marker uses): the
                 column is written by the terminal promote, so printing it beside a `pending` row would
                 assert an outcome the server never gave. -->
            <span v-if="completedAtText(submission)" data-test="record-approval-completed-at">
              {{ l('approval.completedAt') }} {{ completedAtText(submission) }}
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
          <!-- 审批进度 (Q17). Rendered ONLY with approvals:read (see the file header's GATE rule) and only
               for a row that actually has an instance to read — a `creating`/`failed` submission has no
               `approvalInstanceId` and gets nothing here. -->
          <div
            v-if="canReadApprovals && submission.approvalInstanceId"
            class="meta-record-approval__progress"
            data-test="record-approval-progress"
          >
            <button
              type="button"
              class="meta-record-approval__progress-toggle"
              data-test="record-approval-progress-toggle"
              :data-instance="submission.approvalInstanceId"
              :aria-expanded="isProgressExpanded(submission.approvalInstanceId)"
              @click="onToggleProgress(submission.approvalInstanceId)"
            >{{
              isProgressExpanded(submission.approvalInstanceId)
                ? l('approval.progressCollapse')
                : l('approval.progressExpand')
            }}</button>
            <div
              v-if="isProgressExpanded(submission.approvalInstanceId)"
              class="meta-record-approval__progress-body"
              data-test="record-approval-progress-body"
            >
              <div
                v-if="isProgressLoading(submission.approvalInstanceId)"
                class="meta-record-approval__hint"
                data-test="record-approval-progress-loading"
              >{{ l('approval.progressLoading') }}</div>
              <template v-else-if="progressErrorText(submission.approvalInstanceId)">
                <div
                  class="meta-record-approval__hint meta-record-approval__hint--error"
                  data-test="record-approval-progress-error"
                >{{ progressErrorText(submission.approvalInstanceId) }}</div>
                <!-- A 403/404 is an ANSWER, not a hiccup: retrying it changes nothing and would train the
                     operator to hammer a door that is closed. Only the generic failure offers 重试, and it
                     is a BUTTON — there is no timer anywhere in this component. -->
                <button
                  v-if="progressCanRetry(submission.approvalInstanceId)"
                  type="button"
                  class="meta-record-approval__progress-retry"
                  data-test="record-approval-progress-retry"
                  @click="onRetryProgress(submission.approvalInstanceId)"
                >{{ l('approval.progressRetry') }}</button>
              </template>
              <template v-else-if="isProgressReady(submission.approvalInstanceId)">
                <div
                  v-if="progressStepText(submission.approvalInstanceId)"
                  class="meta-record-approval__progress-step"
                  data-test="record-approval-progress-step"
                >{{ progressStepText(submission.approvalInstanceId) }}</div>
                <div
                  v-if="progressApprovers(submission.approvalInstanceId).length > 0"
                  class="meta-record-approval__progress-approvers"
                  data-test="record-approval-progress-approvers"
                >{{ l('approval.progressApprovers') }}: {{ progressApprovers(submission.approvalInstanceId).join('、') }}</div>
                <div class="meta-record-approval__progress-history-title">{{ l('approval.progressHistory') }}</div>
                <ol
                  v-if="progressHistoryRows(submission.approvalInstanceId).length > 0"
                  class="meta-record-approval__progress-history"
                  data-test="record-approval-progress-history"
                >
                  <li
                    v-for="row in progressHistoryRows(submission.approvalInstanceId)"
                    :key="row.key"
                    class="meta-record-approval__progress-history-row"
                    data-test="record-approval-progress-history-row"
                  >
                    <span v-if="row.occurredAt" data-test="record-approval-progress-history-time">{{ formatApprovalTime(row.occurredAt) }}</span>
                    <span data-test="record-approval-progress-history-actor">{{ row.actorName || l('approval.unknownActor') }}</span>
                    <span data-test="record-approval-progress-history-action">{{ historyActionLabel(row.action) }}</span>
                    <span v-if="row.comment" data-test="record-approval-progress-history-comment">{{ row.comment }}</span>
                  </li>
                </ol>
                <div
                  v-else
                  class="meta-record-approval__hint"
                  data-test="record-approval-progress-history-empty"
                >{{ l('approval.progressHistoryEmpty') }}</div>
                <div
                  v-if="isProgressHistoryTruncated(submission.approvalInstanceId)"
                  class="meta-record-approval__hint meta-record-approval__more"
                  data-test="record-approval-progress-history-more"
                >{{ historyCapNotice }}</div>
              </template>
            </div>
          </div>
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
import { computed, inject, onUnmounted, ref, useId, watch } from 'vue'
import { RouterLink, routerKey } from 'vue-router'
import StatusTag from '../../components/status/StatusTag.vue'
import { useLocale } from '../../composables/useLocale'
import {
  isRecordApprovalTerminalStatus,
  recordApprovalApproverFallbackLabel,
  recordApprovalDriftNotice,
  recordApprovalErrorLabel,
  recordApprovalHasMoreNotice,
  recordApprovalHistoryActionLabel,
  recordApprovalNotificationFailedNotice,
  recordApprovalProgressHistoryCapNotice,
  recordApprovalProgressStepNotice,
  recordApprovalSubmissionStatusLabel,
  recordLabel,
  type MetaRecordLabelKey,
} from '../utils/meta-record-labels'
// 审批进度 (Q17) — the approval centre's OWN read helpers, imported, never re-implemented: one client for
// `/api/approvals/:id` and `/:id/history` means the envelope-unwrapping fix that lives in
// `normalizeApprovalHistoryEnvelope` cannot drift away from this surface.
import { getApproval, getApprovalHistory, normalizeApprovalHistoryEnvelope } from '../../approvals/api'
// The SAME shared, session-lifetime display-name resolver ApprovalCenterDetailPane uses, so a pending
// approver reads identically in the drawer and in the approval centre (and degrades to the same
// values-free 「成员 N」 ordinal when the directory cannot confirm a name).
import { ensureUserNamesResolved, getResolvedUserName } from '../../approvals/directoryResolve'
import { useApprovalPermissions } from '../../approvals/permissions'
import type { MultitableApiClient } from '../api/client'
import type { MetaRecord, MetaRecordApprovalSubmission } from '../types'
import type { ApprovalAssignmentDTO, UnifiedApprovalDTO } from '../../types/approval'

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
const hasRouter = !!inject(routerKey, null)

// 审批进度 GATE (Q17). The SAME hook ApprovalCenterView.vue (`canWrite`) and ApprovalDetailView.vue
// (`canAct`) already call — one definition of what `approvals:read` means on the FE, read off the
// session snapshot. It is a CONVENIENCE gate: the server re-decides every read (rbacGuard
// `approvals:read` runs BEFORE the per-instance participant predicate on both routes), so a viewer who
// somehow gets past this still gets 403/404, which the card renders as copy. Calling it here is safe
// outside the approval surface: `bindApprovalAccessRefresh()` is idempotent behind a module-level
// `listenersBound` flag, so a drawer that opens a hundred times still installs exactly one
// storage/focus listener pair per page — the same one the approval centre installs.
const { canRead: canReadApprovals } = useApprovalPermissions()

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

/**
 * How many history rows the card renders. The card is a SUMMARY beside a record, not the timeline — the
 * approval centre owns the full one. The oldest rows are the ones dropped (see `normalizeProgressHistory`):
 * an operator opening a record wants the last thing that happened.
 */
const PROGRESS_HISTORY_CAP = 20

type ProgressErrorKind = 'forbidden' | 'not-participant' | 'mismatch' | 'failed'

interface ProgressHistoryRow {
  key: string
  occurredAt: string | null
  actorName: string | null
  action: string
  comment: string | null
}

interface ProgressEntry {
  loading: boolean
  loaded: boolean
  errorKind: ProgressErrorKind | null
  detail: UnifiedApprovalDTO | null
  history: ProgressHistoryRow[]
  historyTruncated: boolean
}

// Per-instance, per-mount caches. Keyed by `approvalInstanceId` rather than by submission id because the
// READ is about the instance: two submissions can never share one, and the key survives a list re-read.
const progressOpen = ref<Record<string, boolean>>({})
const progressEntries = ref<Record<string, ProgressEntry>>({})
// Stale-response guard for the progress reads specifically. The list's own `activeLoadVersion` is NOT
// enough: a refreshToken bump invalidates progress WITHOUT calling resetState(), so a progress read in
// flight across that bump would otherwise write post-invalidation state that predates the change.
let activeProgressVersion = 0

/**
 * Drop every cached progress read AND collapse every open card. Called from exactly the places that
 * invalidate the submissions list (record switch via `resetState`, version/refreshToken move, unmount),
 * so 「查看进度」 can never show an answer older than the list it sits in. Issues NO request: the next
 * expand does, which keeps the whole panel lazy.
 */
function invalidateProgress(): void {
  activeProgressVersion += 1
  progressOpen.value = {}
  progressEntries.value = {}
}

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
  invalidateProgress()
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
    // Same signal, same invalidation: a submission whose approval just moved must not keep serving the
    // progress read taken before it moved.
    invalidateProgress()
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
  activeProgressVersion += 1
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

// ---------------------------------------------------------------------------
// 审批进度 (Q17) — read, cache, render.
// ---------------------------------------------------------------------------

const historyCapNotice = computed(() =>
  recordApprovalProgressHistoryCapNotice(PROGRESS_HISTORY_CAP, isZh.value))

const completedAtText = (submission: MetaRecordApprovalSubmission): string =>
  submission.completedAt && isRecordApprovalTerminalStatus(submission.status)
    ? formatApprovalTime(submission.completedAt)
    : ''

const isProgressExpanded = (instanceId: string | undefined): boolean =>
  Boolean(instanceId && progressOpen.value[instanceId])

const progressEntry = (instanceId: string | undefined): ProgressEntry | undefined =>
  instanceId ? progressEntries.value[instanceId] : undefined

const isProgressLoading = (instanceId: string | undefined): boolean =>
  Boolean(progressEntry(instanceId)?.loading)

const isProgressReady = (instanceId: string | undefined): boolean =>
  Boolean(progressEntry(instanceId)?.loaded)

const PROGRESS_ERROR_KEYS: Record<ProgressErrorKind, MetaRecordLabelKey> = {
  forbidden: 'approval.progressForbidden',
  'not-participant': 'approval.progressNotParticipant',
  mismatch: 'approval.progressMismatch',
  failed: 'approval.progressFailed',
}

const progressErrorText = (instanceId: string | undefined): string => {
  const kind = progressEntry(instanceId)?.errorKind
  return kind ? l(PROGRESS_ERROR_KEYS[kind]) : ''
}

// 403/404 — and an answer about the WRONG instance — are ANSWERS (see the template's own note): only the
// generic failure is retryable, because only it can come out differently the second time.
const progressCanRetry = (instanceId: string | undefined): boolean =>
  progressEntry(instanceId)?.errorKind === 'failed'

const progressStepText = (instanceId: string | undefined): string => {
  const detail = progressEntry(instanceId)?.detail
  if (!detail) return ''
  return recordApprovalProgressStepNotice(detail.currentStep, detail.totalSteps, isZh.value) ?? ''
}

const progressHistoryRows = (instanceId: string | undefined): ProgressHistoryRow[] =>
  progressEntry(instanceId)?.history ?? []

const isProgressHistoryTruncated = (instanceId: string | undefined): boolean =>
  Boolean(progressEntry(instanceId)?.historyTruncated)

const historyActionLabel = (action: string): string =>
  recordApprovalHistoryActionLabel(action, isZh.value)

/**
 * One pending approver's label — byte-for-byte the rule ApprovalCenterDetailPane's `assigneeLabel`
 * applies: a producer-supplied `metadata.assigneeName` first, then the shared directory resolver, then a
 * values-free ordinal. Never the raw internal user id.
 */
function progressAssigneeLabel(assignment: ApprovalAssignmentDTO, ordinal: number): string {
  const metaName = assignment.metadata?.assigneeName
  if (typeof metaName === 'string' && metaName.trim()) return metaName.trim()
  const resolved = getResolvedUserName(assignment.assigneeId)
  if (resolved) return resolved
  return recordApprovalApproverFallbackLabel(ordinal, isZh.value)
}

/**
 * Every ACTIVE assignment at the current node(s) — linear (`currentNodeKey`) or parallel
 * (`currentNodeKeys`), the same resolution ApprovalCenterDetailPane's `pendingApproverLabels` uses. Read
 * from the render effect (not a `computed`) on purpose: `getResolvedUserName` reads a `reactive()` map,
 * so the row re-renders by itself once the batch resolve kicked off by `loadProgress` lands.
 */
function progressApprovers(instanceId: string | undefined): string[] {
  const detail = progressEntry(instanceId)?.detail
  if (!detail) return []
  const keys = new Set<string>(
    detail.currentNodeKeys && detail.currentNodeKeys.length > 0
      ? detail.currentNodeKeys
      : detail.currentNodeKey
        ? [detail.currentNodeKey]
        : [],
  )
  if (keys.size === 0) return []
  return (detail.assignments ?? [])
    .filter((a) => a.isActive && !!a.nodeKey && keys.has(a.nodeKey))
    .map((a, index) => progressAssigneeLabel(a, index + 1))
}

function pickString(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/**
 * History rows, oldest first, capped.
 *
 * SHAPE: the platform branch of `GET /api/approvals/:id/history` returns SNAKE_CASE rows
 * (`occurred_at`/`actor_name`/`from_status`), while the PLM branch and `UnifiedApprovalHistoryDTO`
 * are camelCase — a drift `approvals/api.ts` documents and does not reconcile. Reading BOTH spellings
 * here is what makes the card work against a platform instance at all; picking one would render a
 * timeline of blank actors and blank times for exactly the instances this panel creates.
 *
 * ORDER: sorted ASCENDING by parsed timestamp, with the server's own order as the tie-break (and as the
 * whole order for rows whose timestamp will not parse) — never dropped for being unparseable.
 * The CAP keeps the NEWEST rows (`slice(-cap)`), because the tail is what an operator opening a record
 * is looking for.
 *
 * NOTHING-ROWS: a non-object element (a `null`, a scalar) used to be coerced to `{}` and still emitted a
 * row — no time, no action, actor 「未知」 — i.e. an assertion that an unknown person did an unnamed
 * thing at an unknown time. Such an element is dropped, and so is any row that survives parsing with no
 * time, no actor, no action AND no comment: every other unknown on this card degrades to rendering
 * nothing (步骤 needs both numbers, 待处理人 needs a current node), and a history row carrying zero
 * information should too. A row that still carries SOMETHING — an orphan comment, say — is KEPT: the rule
 * is 'no information', not 'unknown actor'.
 */
function normalizeProgressHistory(payload: unknown): { rows: ProgressHistoryRow[]; truncated: boolean } {
  const items = (normalizeApprovalHistoryEnvelope(payload) as unknown[])
    .filter((raw): raw is Record<string, unknown> => Boolean(raw) && typeof raw === 'object')
  const parsed = items.map((row, index) => {
    const occurredAt = pickString(row, 'occurredAt', 'occurred_at', 'createdAt', 'created_at')
    const timestamp = occurredAt ? Date.parse(occurredAt) : Number.NaN
    return {
      index,
      timestamp,
      row: {
        key: `${pickString(row, 'id') ?? 'row'}-${index}`,
        occurredAt,
        actorName: pickString(row, 'actorName', 'actor_name'),
        action: pickString(row, 'action') ?? '',
        comment: pickString(row, 'comment'),
      } satisfies ProgressHistoryRow,
    }
  }).filter(({ row }) => Boolean(row.occurredAt || row.actorName || row.action || row.comment))
  parsed.sort((a, b) => {
    const aKnown = !Number.isNaN(a.timestamp)
    const bKnown = !Number.isNaN(b.timestamp)
    if (aKnown && bKnown && a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
    return a.index - b.index
  })
  const rows = parsed.map((entry) => entry.row)
  if (rows.length <= PROGRESS_HISTORY_CAP) return { rows, truncated: false }
  return { rows: rows.slice(rows.length - PROGRESS_HISTORY_CAP), truncated: true }
}

/**
 * The HTTP status behind a failed read, parsed DEFENSIVELY.
 *
 * `apiGet` (utils/api.ts) throws a plain `new Error(\`API error: \${status} \${statusText}\`)` — there is no
 * typed error and no `status` property on that path, so the status has to come out of the message. A
 * typed thrower (`ApprovalApiError` carries a real `status`) is preferred when present, and anything
 * neither shape yields `null`, which the caller maps to the generic failure rather than guessing.
 * The `API error:` prefix is part of the pattern on purpose: a bare three-digit match would read a 404
 * out of any message that happens to contain one.
 */
function progressErrorStatus(error: unknown): number | null {
  if (error && typeof error === 'object') {
    const direct = (error as { status?: unknown }).status
    if (typeof direct === 'number' && Number.isFinite(direct)) return direct
  }
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : ''
  const match = /API error:\s*(\d{3})\b/.exec(message)
  return match ? Number(match[1]) : null
}

function progressErrorKind(error: unknown): ProgressErrorKind {
  const status = progressErrorStatus(error)
  // 403 = the rbacGuard (no approvals:read on the server). 404 = APPROVAL_NOT_FOUND, the values-free
  // answer canReadApprovalInstance gives a NON-PARTICIPANT. Two different sentences — see the labels.
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not-participant'
  return 'failed'
}

async function loadProgress(instanceId: string): Promise<void> {
  // Fail-closed second time: the template already hides the toggle without the permission, and this
  // makes a programmatic call without it a no-op rather than a request.
  if (!canReadApprovals.value || !instanceId) return
  const existing = progressEntries.value[instanceId]
  // Cached (loaded) or already in flight => nothing. An ERROR entry is neither, so 重试 / a re-expand
  // after a failure really does read again.
  if (existing && (existing.loading || existing.loaded)) return
  const loadVersion = activeProgressVersion
  progressEntries.value[instanceId] = {
    loading: true,
    loaded: false,
    errorKind: null,
    detail: null,
    history: [],
    historyTruncated: false,
  }
  try {
    // In PARALLEL: the two reads are independent and the card shows both or neither.
    const [detail, history] = await Promise.all([
      getApproval(instanceId),
      getApprovalHistory(instanceId),
    ])
    if (loadVersion !== activeProgressVersion) return
    // IDENTITY: the answer must be ABOUT the instance we asked for. See the file header — the route
    // answers `id: row.id` from `WHERE id = $1`, so an echo mismatch is never a legitimate answer; it is
    // either another approval's timeline or the DEV fixture branch of `approvals/api.ts`. Fail closed to
    // a values-free notice (no 重试 — a re-read returns the same wrong instance) and render NEITHER
    // half, because the history read is keyed by the same id and would be just as wrong.
    const answeredId = typeof detail?.id === 'string' ? detail.id : ''
    if (answeredId && answeredId !== instanceId) {
      progressEntries.value[instanceId] = {
        loading: false,
        loaded: false,
        errorKind: 'mismatch',
        detail: null,
        history: [],
        historyTruncated: false,
      }
      return
    }
    // Side effect OUTSIDE any computed (directoryResolve.ts's own contract): kick off the batch
    // display-name resolve for the ids this card is about to show.
    ensureUserNamesResolved((detail?.assignments ?? []).map((a) => a.assigneeId))
    const { rows, truncated } = normalizeProgressHistory(history)
    progressEntries.value[instanceId] = {
      loading: false,
      loaded: true,
      errorKind: null,
      detail: detail ?? null,
      history: rows,
      historyTruncated: truncated,
    }
  } catch (error) {
    if (loadVersion !== activeProgressVersion) return
    progressEntries.value[instanceId] = {
      loading: false,
      loaded: false,
      errorKind: progressErrorKind(error),
      detail: null,
      history: [],
      historyTruncated: false,
    }
  }
}

function onToggleProgress(instanceId: string | undefined): void {
  if (!instanceId) return
  const next = !progressOpen.value[instanceId]
  progressOpen.value = { ...progressOpen.value, [instanceId]: next }
  if (next) void loadProgress(instanceId)
}

function onRetryProgress(instanceId: string | undefined): void {
  if (!instanceId) return
  void loadProgress(instanceId)
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
.meta-record-approval__progress { margin-top: 2px; }
.meta-record-approval__progress-toggle { background: none; border: none; padding: 0; cursor: pointer; font-size: 11px; color: var(--ms-color-primary, #409eff); }
.meta-record-approval__progress-body { margin-top: 4px; display: flex; flex-direction: column; gap: 3px; border-left: 2px solid #f1f5f9; padding-left: 8px; }
.meta-record-approval__progress-step { font-size: 11px; color: #334155; font-weight: 600; }
.meta-record-approval__progress-approvers { font-size: 11px; color: #475569; }
.meta-record-approval__progress-history-title { font-size: 11px; color: #94a3b8; }
.meta-record-approval__progress-history { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.meta-record-approval__progress-history-row { display: flex; flex-wrap: wrap; gap: 6px; font-size: 11px; color: #64748b; }
.meta-record-approval__progress-retry { align-self: flex-start; background: none; border: none; padding: 0; cursor: pointer; font-size: 11px; color: var(--ms-color-primary, #409eff); }
</style>
