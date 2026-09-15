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

const bodyId = `meta-record-approval-${useId()}`
const expanded = ref(false)
const loading = ref(false)
const loaded = ref(false)
const loadFailed = ref(false)
const submissions = ref<MetaRecordApprovalSubmission[]>([])

const sectionVisible = computed(() => Boolean(props.record && props.sheetId && props.apiClient))

// COUNT-FREE when the server masked every changed field id away (`{ changed: true, changedFieldIds: [] }`
// is a legitimate answer for an actor whose field-read mask hides the changed fields) — see the helper.
const driftNotice = (submission: MetaRecordApprovalSubmission) =>
  recordApprovalDriftNotice(submission.drift.changedFieldIds.length, isZh.value)

const localStatusLabel = (status: string) => recordApprovalSubmissionStatusLabel(status, isZh.value)

const failureReason = (submission: MetaRecordApprovalSubmission): string | null =>
  submission.status === 'failed' ? recordApprovalErrorLabel(submission.error, isZh.value) : null

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
watch(
  () => [props.record?.version, props.refreshToken] as const,
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
    loaded.value = true
    return
  }
  loading.value = true
  loadFailed.value = false
  try {
    const result = await client.listRecordApprovals(sheetId, recordId)
    if (loadVersion !== activeLoadVersion) return
    submissions.value = result
    loaded.value = true
  } catch {
    if (loadVersion !== activeLoadVersion) return
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
.meta-record-approval__status { font-size: 11px; color: #64748b; background: #f1f5f9; border-radius: 4px; padding: 1px 6px; }
</style>
