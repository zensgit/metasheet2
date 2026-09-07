<template>
  <PageShell width="default">
    <PageHeader
      :title="t.title"
      :subtitle="t.subtitle"
    />

    <!-- The server's own approval-administrator answer decides what this page may claim. Nothing
         below the header renders until it arrives: a form drawn before the answer would invite the
         operator to act on a queue the page cannot yet describe. -->
    <p
      v-if="capability === 'pending'"
      class="batch-transfer__gate"
      data-testid="batch-transfer-capability-pending"
    >{{ t.capabilityPending }}</p>

    <el-alert
      v-else-if="capability === 'denied'"
      type="warning"
      show-icon
      :closable="false"
      class="batch-transfer__alert"
      data-testid="batch-transfer-forbidden"
      :title="t.forbiddenTitle"
      :description="t.forbiddenBody"
    />

    <el-alert
      v-else-if="capability === 'unavailable'"
      type="info"
      show-icon
      :closable="false"
      class="batch-transfer__alert"
      data-testid="batch-transfer-capability-unavailable"
      :title="t.capabilityUnavailableTitle"
      :description="t.capabilityUnavailableBody"
    />

    <template v-else>
      <section class="batch-transfer__form" :aria-label="t.formRegion">
        <div class="batch-transfer__field">
          <span class="batch-transfer__label">{{ t.sourceApprover }}</span>
          <ApprovalUserPicker
            :model-value="fromUserId || null"
            :placeholder="t.userPickerPlaceholder"
            data-testid="batch-transfer-source-picker"
            @update:model-value="onSourceChange"
          />
          <el-button
            class="batch-transfer__load"
            :loading="loadingRows"
            :disabled="!fromUserId"
            data-testid="batch-transfer-load"
            @click="loadRows"
          >
            {{ t.loadPending }}
          </el-button>
        </div>

        <div class="batch-transfer__field">
          <span class="batch-transfer__label">{{ t.targetApprover }}</span>
          <ApprovalUserPicker
            :model-value="toUserId || null"
            :placeholder="t.userPickerPlaceholder"
            :excluded-user-ids="excludedTargets"
            data-testid="batch-transfer-target-picker"
            @update:model-value="toUserId = $event ?? ''"
          />
        </div>

        <div class="batch-transfer__field">
          <span class="batch-transfer__label">{{ t.reasonLabel }}</span>
          <el-input
            v-model="reason"
            type="textarea"
            :rows="2"
            :placeholder="t.reasonPlaceholder"
            data-testid="batch-transfer-reason"
          />
        </div>
      </section>

      <el-alert
        v-if="loadError"
        type="error"
        show-icon
        :closable="false"
        class="batch-transfer__alert"
        data-testid="batch-transfer-load-error"
        :title="t.loadFailed"
      />

      <section class="batch-transfer__rows" :aria-label="t.rowsRegion">
        <div class="batch-transfer__rows-head">
          <el-checkbox
            :model-value="allSelected"
            :disabled="rows.length === 0"
            data-testid="batch-transfer-select-all"
            @update:model-value="toggleAll"
          >
            {{ t.selectAll }}
          </el-checkbox>
          <span class="batch-transfer__count" data-testid="batch-transfer-selected-count">
            {{ t.selectedPrefix }} {{ selectedIds.length }} / {{ rows.length }}
          </span>
        </div>

        <!-- Reachable ONLY on the `granted` branch, so "this approver has nothing to transfer" is
             never stated off a read the caller's own scope may have narrowed. -->
        <p v-if="loaded && rows.length === 0" class="batch-transfer__empty" data-testid="batch-transfer-empty">
          {{ t.emptyQueue }}
        </p>

        <p v-if="truncationNotice" class="batch-transfer__truncated" data-testid="batch-transfer-truncated">
          {{ truncationNotice }}
        </p>

        <ul class="batch-transfer__list">
          <li
            v-for="(row, index) in rows"
            :key="row.id"
            class="batch-transfer__row"
            :data-testid="`batch-transfer-row-${row.id}`"
          >
            <el-checkbox
              :model-value="selectedSet.has(row.id)"
              :data-testid="`batch-transfer-row-check-${row.id}`"
              @update:model-value="toggleRow(row.id, $event)"
            />
            <span class="batch-transfer__row-title">{{ rowLabel(row, index) }}</span>
            <span
              v-if="outcomeFor(row.id)"
              class="batch-transfer__row-outcome"
              :data-testid="`batch-transfer-outcome-${row.id}`"
              :data-outcome="outcomeFor(row.id)!.kind"
              :data-outcome-reason="outcomeFor(row.id)!.reason ?? ''"
            >{{ outcomeText(outcomeFor(row.id)!) }}</span>
          </li>
        </ul>
      </section>

      <section class="batch-transfer__actions">
        <span
          v-if="justSubmitted"
          class="batch-transfer__block"
          data-testid="batch-transfer-submitted-notice"
        >{{ t.alreadySubmitted }}</span>
        <span v-else-if="blockText" class="batch-transfer__block" data-testid="batch-transfer-block-reason">
          {{ blockText }}
        </span>
        <el-button
          type="primary"
          :loading="submitting"
          :disabled="submitDisabled"
          data-testid="batch-transfer-submit"
          @click="submit"
        >
          {{ t.submit }}
        </el-button>
      </section>

      <section
        v-if="summary"
        class="batch-transfer__summary"
        :aria-label="t.summaryRegion"
        data-testid="batch-transfer-summary"
      >
        <span>{{ t.summarySubmitted }} {{ summary.submitted }}</span>
        <span>{{ t.summaryTransferred }} {{ summary.transferred }}</span>
        <span>{{ t.summarySkipped }} {{ summary.skipped }}</span>
        <span v-if="summary.unreported > 0" data-testid="batch-transfer-unreported">
          {{ t.summaryUnreported }} {{ summary.unreported }}
        </span>
      </section>
    </template>
  </PageShell>
</template>

<script setup lang="ts">
// P1b slice 3 — the admin 批量转交 page.
//
// WHAT THIS IS: the first web caller for `POST /api/approvals/admin/reassign`, an endpoint that has
// shipped (and been guarded by `rbacGuard('approvals:admin')`) with no UI at all. Every rule below
// is the SERVER's — this page adds no approval behaviour of its own:
//   * the request always carries explicit `instanceIds` (the rows the operator ticked), so the
//     server's own discovery branch is never invoked and the operator can never submit a set they
//     did not see;
//   * `reason` is required because the endpoint refuses without it, and it lands in the approval
//     record;
//   * `fromUserId === toUserId` is refused by the endpoint, so the source id is passed to the target
//     picker's existing `excludedUserIds` rather than being re-validated separately;
//   * the 200-row cap is the endpoint's own.
//
// HONEST ABOUT THE LIST: the listed set is NOT a promise of what will transfer. The server decides
// per instance inside a transaction (status re-check under lock, seat re-check, attendance-scope
// authorization), so a listed row can still come back skipped. That is why every submitted row gets
// its own outcome, and why an id the server mentions in NEITHER `succeeded` nor `skipped` renders as
// "no result returned" instead of quietly looking like a success.
//
// WHOSE QUEUE THIS CAN DESCRIBE (round-2 item 1, the P2 this page shipped with). The list read is
// the ordinary `GET /api/approvals` projection, whose scope admits another approver's rows only
// through the DB-backed admin arm `users.is_active AND (is_admin OR role = 'admin')`. The route and
// nav gates, by contrast, are TOKEN-derived (`getAccessSnapshot().isAdmin`). A principal admitted by
// the token gate but not the DB one was served arms 1-4 of the scope — a SUBSET of the picked
// approver's queue — and this page stated, as fact, that the approver had nothing to transfer.
// It now asks the server which it is (`GET /api/approvals/admin/capability`, the same DB predicate
// the list scope binds) and renders THREE outcomes: granted (the queue, and only then the
// "nothing pending" copy), denied (an explicit insufficient-privilege state), and unavailable (the
// server did not confirm — never restated as "you are not an administrator").
//
// PROJECTION PERMISSIONS ARE NOT RELAXED: the capability read grants nothing. It is a read of an
// existing predicate; `rbacGuard('approvals:admin')` still gates the mutation and the list scope
// still gates the projection.
//
// ONE SOURCE APPROVER PER BATCH (round-4 item 1). The list read, the rows on screen and the
// submitted request must all be about the SAME approver, and nothing in the wire shape enforces
// that: the read is a query, the request is a body, and the operator can change the picker between
// them. A read is therefore issued with the source it is about and a generation, and a response is
// applied only if BOTH still hold; the source a batch was listed for travels with the rows and is
// what the request carries. A picker change clears the rows it invalidates in the same tick.
//
// WHOSE ANSWER, FOR HOW LONG (round-4 item 2). The capability is held through
// `useApprovalAdminCapability`, which re-reads on an auth transition and drops this page's loaded
// queue with it — an answer resolved for one principal is not a statement about the next, and
// neither is a queue listed under one principal's scope.
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageShell from '../../components/layout/PageShell.vue'
import PageHeader from '../../components/layout/PageHeader.vue'
import ApprovalUserPicker from '../../approvals/components/ApprovalUserPicker.vue'
import {
  APPROVAL_BATCH_TRANSFER_PAGE_LIMIT,
  bulkReassignApprovals,
  listPendingApprovalsForApprover,
} from '../../approvals/api'
import { useApprovalAdminCapability } from '../../approvals/useApprovalAdminCapability'
import {
  blockReasonForTransfer,
  buildTransferOutcomes,
  describeSkipReason,
  summarizeTransferOutcomes,
  type ApprovalBatchTransferBlockReason,
  type ApprovalBatchTransferRowOutcome,
  type ApprovalBatchTransferSummary,
} from '../../approvals/batchTransfer'
import { useLocale } from '../../composables/useLocale'
import type { UnifiedApprovalDTO } from '../../types/approval'

const { isZh } = useLocale()

// ONE table for the whole surface, in the shape App.vue's `navLabels` established. Every string
// this page renders comes from here — the page had a mixed-locale chrome (hardcoded Chinese
// labels around locale-branched error text), which is worse than either consistent alternative.
const ZH = {
  title: '批量转交',
  subtitle: '把某位审批人名下的待办，整批交给另一位审批人。转交后由服务端逐条判定，结果逐条显示。',
  formRegion: '批量转交设置',
  rowsRegion: '待转交审批',
  summaryRegion: '转交结果',
  sourceApprover: '原审批人',
  targetApprover: '转交给',
  reasonLabel: '转交原因',
  userPickerPlaceholder: '搜索用户名 / 邮箱 / ID',
  reasonPlaceholder: '填写转交原因（必填，会写入审批记录）',
  loadPending: '载入待办',
  loadFailed: '待办列表加载失败，请重试',
  selectAll: '全选',
  selectedPrefix: '已选',
  emptyQueue: '该审批人名下没有可转交的平台待办。',
  submit: '转交所选',
  alreadySubmitted: '本批已提交。如需继续处理该审批人，请重新载入待办。',
  summarySubmitted: '提交',
  summaryTransferred: '成功',
  summarySkipped: '跳过',
  summaryUnreported: '未返回结果',
  outcomeTransferred: '已转交',
  outcomeUnreported: '未返回结果',
  capabilityPending: '正在确认权限…',
  forbiddenTitle: '权限不足：无法查看其他审批人的待办',
  forbiddenBody: '批量转交需要审批管理员权限（由服务端按账号判定）。当前账号不具备该权限，因此本页无法列出任何审批人的待办，也无法执行转交。请联系平台管理员。',
  capabilityUnavailableTitle: '暂时无法确认权限',
  capabilityUnavailableBody: '服务端未能确认当前账号是否为审批管理员。这不代表权限不足；在确认之前，本页不会列出任何待办。请稍后重试。',
  submitSuccess: '批量转交已处理，请查看逐条结果',
  submitFailed: '批量转交请求未成功，请重试',
  confirmTitle: '确认批量转交',
} as const

const EN: Record<keyof typeof ZH, string> = {
  title: 'Batch Transfer',
  subtitle: 'Hand one approver’s pending items to another approver in a single batch. The server decides item by item, and every item’s result is shown.',
  formRegion: 'Batch transfer settings',
  rowsRegion: 'Approvals to transfer',
  summaryRegion: 'Transfer results',
  sourceApprover: 'Source approver',
  targetApprover: 'Transfer to',
  reasonLabel: 'Transfer reason',
  userPickerPlaceholder: 'Search by name / email / ID',
  reasonPlaceholder: 'Why this batch is being transferred (required; written to the approval record)',
  loadPending: 'Load pending items',
  loadFailed: 'The pending list could not be loaded; please retry',
  selectAll: 'Select all',
  selectedPrefix: 'Selected',
  emptyQueue: 'This approver has no transferable platform items pending.',
  submit: 'Transfer selected',
  alreadySubmitted: 'This batch has been submitted. Reload the pending list to continue with this approver.',
  summarySubmitted: 'Submitted',
  summaryTransferred: 'Transferred',
  summarySkipped: 'Skipped',
  summaryUnreported: 'No result returned',
  outcomeTransferred: 'Transferred',
  outcomeUnreported: 'No result returned',
  capabilityPending: 'Confirming your access…',
  forbiddenTitle: 'Insufficient privilege: another approver’s queue cannot be shown',
  forbiddenBody: 'Batch transfer requires approval-administrator access, which the server decides per account. This account does not have it, so no approver’s pending items can be listed here and no transfer can be made. Please contact a platform administrator.',
  capabilityUnavailableTitle: 'Your access could not be confirmed right now',
  capabilityUnavailableBody: 'The server did not confirm whether this account is an approval administrator. That is not the same as being refused; until it is confirmed, this page lists nothing. Please retry shortly.',
  submitSuccess: 'Batch transfer processed; see the per-row results',
  submitFailed: 'The batch transfer request did not succeed; please retry',
  confirmTitle: 'Confirm batch transfer',
}

const t = computed(() => (isZh.value ? ZH : EN))

const fromUserId = ref('')
const toUserId = ref('')
const reason = ref('')
const rows = ref<UnifiedApprovalDTO[]>([])
const selectedIds = ref<string[]>([])
// The approver `rows` were LISTED for. Stored WITH the rows because it is what makes them
// interpretable: a set of instance ids means nothing without the approver whose seats they are.
// This — never the picker's live value — is what a submit sends. It deliberately SURVIVES a picker
// change so the page can say "the source approver changed, reload" instead of the much weaker
// "select at least one item" it would otherwise fall through to.
const loadedSource = ref('')
// Monotonic per list read. A response is applied only if its own generation is still the current
// one, which is what makes a superseded read's late arrival a no-op rather than a silent refill.
const loadGeneration = ref(0)
// Monotonic per PRINCIPAL, and deliberately NOT `loadGeneration` (round-5 item 1). An in-flight
// POST needs the same treatment the list read already gets — apply the answer only if it still
// belongs to this page — but the two reads are superseded by different events. A list read is
// superseded by any newer batch, including a picker change; a POST is not, because the source
// picker stays live through the request and the server has ALREADY executed the batch by the time
// the answer arrives. Keying the POST to `loadGeneration` would therefore throw away the outcome of
// a batch that really happened whenever the operator touched the picker mid-flight — the operator
// would never learn which rows moved. This counter is bumped by exactly ONE event, the
// auth-transition invalidation below that empties the page, so a settle is discarded when, and only
// when, the principal it was issued under is no longer the one holding this page.
const principalGeneration = ref(0)
const totalPending = ref(0)
const loadingRows = ref(false)
const loaded = ref(false)
const loadError = ref(false)
const submitting = ref(false)
// Round-3 item 2 — the IN-FLIGHT half of the double-submit latch, and the reason it is a second ref
// rather than an earlier assignment to `submitting`. `submit()` awaits a confirmation dialog before
// it posts, so the window between "the operator activated submit" and "the request exists" is open
// for as long as that dialog is up; `submitting` alone closed only the window around the POST, and
// two activations that both started before the confirm settled both passed the gate and both
// posted. The second answers `not-assigned` for rows the first already moved and overwrites the
// success summary, so a successful batch reads as a failure — the same harm the completed-batch
// latch exists to prevent, one step earlier. This closes SYNCHRONOUSLY at entry, before any await.
//
// SEPARATE FROM `submitting` because `:loading` binds `submitting`: folding the two would put a
// spinner on the button for the whole time the confirmation dialog is open, which is a visible
// behaviour change this fix has no reason to make. `submitDisabled` reads both.
const confirming = ref(false)
// Round-2 item 4: a completed batch latches this until the list is reloaded (or the source approver
// changes). Clearing the selection alone would leave the button re-armable by re-ticking stale
// rows, and a second identical POST overwrites the success summary with a wall of `not-assigned`
// skips — an operator's successful batch reads as a failure.
const justSubmitted = ref(false)
const outcomes = ref<ApprovalBatchTransferRowOutcome[]>([])
const summary = ref<ApprovalBatchTransferSummary | null>(null)

/**
 * Everything about the batch currently on screen, dropped in ONE tick.
 *
 * `loadGeneration` is bumped here rather than only in `loadRows` because the reads this cancels are
 * the ones already in flight: without the bump, a read issued for the batch being dropped would
 * still land and re-populate the page. `loadingRows` is cleared for the same reason — the in-flight
 * read is no longer this page's read, so the control it disables must be released immediately or
 * the operator cannot load the source they just picked.
 */
function clearLoadedBatch(): void {
  loadGeneration.value += 1
  rows.value = []
  selectedIds.value = []
  totalPending.value = 0
  loaded.value = false
  loadError.value = false
  loadingRows.value = false
  justSubmitted.value = false
  resetResults()
}

// The capability, and everything derived from it. The `onInvalidated` half is not decoration: an
// identity change puts the capability back to `pending` (so nothing actionable renders), but the
// rows, the selection and the form are STATE, not chrome — they survive the `v-if` that hides them.
// Left alone, principal A's queue would reappear intact the moment B's answer came back `granted`.
// A new principal gets an empty page, not the previous one's work — and that has to cover requests
// that were ALREADY ISSUED, not only the state on screen: a POST settling after the transition
// would write A's outcomes, summary and success toast onto B's page. `principalGeneration` below is
// what makes the claim true of an in-flight submit as well (round-5 item 1).
const capability = useApprovalAdminCapability({
  onInvalidated: () => {
    // Bumped FIRST, and synchronously: from this tick on, an answer to a request issued by the
    // principal being replaced is no longer this page's to render (round-5 item 1).
    principalGeneration.value += 1
    fromUserId.value = ''
    toUserId.value = ''
    reason.value = ''
    loadedSource.value = ''
    clearLoadedBatch()
    // The two SUBMIT transport flags, released here for the same reason `clearLoadedBatch` releases
    // `loadingRows`: the request they describe is no longer this page's request. Left set, the new
    // principal inherits a spinning, permanently disabled submit control and CANNOT SUBMIT AT ALL
    // until the previous principal's round-trip happens to finish — measured, not assumed. The
    // settle that would have cleared them is now discarded, so this is the only place that can.
    submitting.value = false
    confirming.value = false
  },
})

const selectedSet = computed(() => new Set(selectedIds.value))
// The list read is capped at the endpoint's own page maximum, which is also the service's cap on an
// explicit id array — so a queue larger than the cap renders a COMPLETE-LOOKING page that is not the
// whole queue. `total` comes back on the same response; saying so is the difference between "this
// approver has 200 items" and "this page shows 200 of them". Without this the operator can only
// discover the remainder by noticing that reloading still returns rows.
const truncationNotice = computed(() => {
  if (!loaded.value || totalPending.value <= rows.value.length) return ''
  return isZh.value
    ? `该审批人共有 ${totalPending.value} 条待办，本次仅载入前 ${rows.value.length} 条（单次上限）。处理完这一批后重新载入可继续。`
    : `This approver has ${totalPending.value} pending items; only the first ${rows.value.length} were loaded (per-request cap). Reload after this batch to continue.`
})
const allSelected = computed(() => rows.value.length > 0 && selectedIds.value.length === rows.value.length)
const excludedTargets = computed(() => (fromUserId.value ? [fromUserId.value] : []))

const blockReason = computed<ApprovalBatchTransferBlockReason | null>(() => blockReasonForTransfer({
  fromUserId: fromUserId.value,
  toUserId: toUserId.value,
  reason: reason.value,
  selectedIds: selectedIds.value,
  limit: APPROVAL_BATCH_TRANSFER_PAGE_LIMIT,
  loadedForUserId: loadedSource.value,
}))

const submitDisabled = computed(() => justSubmitted.value || blockReason.value !== null || submitting.value || confirming.value)

const BLOCK_TEXT: Record<ApprovalBatchTransferBlockReason, { zh: string; en: string }> = {
  'no-source': { zh: '请先选择原审批人', en: 'Pick the source approver first' },
  'source-changed': {
    zh: '原审批人已更改，请重新载入该审批人的待办',
    en: 'The source approver changed; reload this approver’s pending items',
  },
  'no-target': { zh: '请选择转交给谁', en: 'Pick who to transfer to' },
  'same-user': { zh: '原审批人与目标用户不能相同', en: 'Source and target must differ' },
  'no-selection': { zh: '请至少勾选一条待办', en: 'Select at least one item' },
  'no-reason': { zh: '请填写转交原因', en: 'A transfer reason is required' },
  'over-limit': { zh: `一次最多转交 ${APPROVAL_BATCH_TRANSFER_PAGE_LIMIT} 条`, en: `At most ${APPROVAL_BATCH_TRANSFER_PAGE_LIMIT} per request` },
}

const blockText = computed(() => {
  if (!blockReason.value) return ''
  const entry = BLOCK_TEXT[blockReason.value]
  return isZh.value ? entry.zh : entry.en
})

function resetResults(): void {
  outcomes.value = []
  summary.value = null
}

// SYNCHRONOUS, and that is the whole point: from the tick the picker changes, the page holds no
// rows and no selection belonging to the approver it no longer names. `loadedSource` is NOT cleared
// here — it is what lets `blockReason` name the mismatch until a read for the new approver lands.
function onSourceChange(next: string | null): void {
  fromUserId.value = next ?? ''
  clearLoadedBatch()
}

async function loadRows(): Promise<void> {
  // The source is captured HERE, once, and every decision below is made against this value rather
  // than against the live picker: the request is about this approver, and so is its answer.
  const source = fromUserId.value
  if (!source || loadingRows.value) return
  loadGeneration.value += 1
  const generation = loadGeneration.value
  loadingRows.value = true
  loadError.value = false
  justSubmitted.value = false
  resetResults()
  try {
    const page = await listPendingApprovalsForApprover(source)
    // TWO independent conditions, because they catch different things: the generation catches a
    // newer read of the SAME approver (a second click, or a re-read after an identity change), and
    // the source comparison catches a picker change — including one that happens to leave the
    // generation looking current. A stale answer is DROPPED, never merged.
    if (generation !== loadGeneration.value || source !== fromUserId.value) return
    // A degraded answer is the server saying "I could not read the approval tables", and it is
    // shaped exactly like an empty queue (`{data: [], total: 0}` plus this flag). Rendered as the
    // business empty state it becomes the page asserting, as fact, that this approver has nothing
    // to transfer — the same false statement the capability gate exists to prevent, arriving
    // through a different door. A payload that is not a page at all is treated the same way: an
    // unreadable answer is a failed read, never an empty one.
    const data = (page as { data?: unknown } | null | undefined)?.data
    const degraded = (page as { degraded?: unknown } | null | undefined)?.degraded === true
    if (degraded || !Array.isArray(data)) {
      applyFailedRead()
      return
    }
    rows.value = data as UnifiedApprovalDTO[]
    totalPending.value = typeof page?.total === 'number' && Number.isFinite(page.total) && page.total >= 0
      ? page.total
      : rows.value.length
    // Default to "everything the operator just looked at"; they can untick.
    selectedIds.value = rows.value.map((row) => row.id)
    loadedSource.value = source
    loaded.value = true
  } catch {
    if (generation !== loadGeneration.value || source !== fromUserId.value) return
    applyFailedRead()
  } finally {
    // Only the CURRENT read owns this flag. A superseded read clearing it would re-enable the load
    // control while the read that replaced it is still running.
    if (generation === loadGeneration.value) loadingRows.value = false
  }
}

/**
 * The read did not produce a queue. `loaded` stays false so the "nothing pending" copy cannot
 * render, and the rows/selection are dropped so nothing is submittable — an operator must never be
 * able to act on a batch that a failed read left behind. The alert this raises names retrying, and
 * the load control stays available as the retry.
 */
function applyFailedRead(): void {
  rows.value = []
  selectedIds.value = []
  totalPending.value = 0
  loaded.value = false
  loadError.value = true
}

function toggleAll(next: unknown): void {
  selectedIds.value = next === true ? rows.value.map((row) => row.id) : []
}

function toggleRow(id: string, next: unknown): void {
  const set = new Set(selectedIds.value)
  if (next === true) set.add(id)
  else set.delete(id)
  selectedIds.value = rows.value.map((row) => row.id).filter((rowId) => set.has(rowId))
}

// Values-free row label, following the same per-list ordinal convention ApprovalUserPicker's
// `optionLabel` established (`成员 N`): a row with neither a title nor a request number renders an
// ordinal, NEVER the raw instance id. The id still keys the row and the test hooks — it is what the
// operator is acting on — but it is not display text.
function rowLabel(row: UnifiedApprovalDTO, index: number): string {
  const title = row.title?.trim()
  if (title) return title
  const requestNo = row.requestNo?.trim()
  if (requestNo) return requestNo
  return isZh.value ? `审批 ${index + 1}` : `Approval ${index + 1}`
}

function outcomeFor(id: string): ApprovalBatchTransferRowOutcome | undefined {
  return outcomes.value.find((outcome) => outcome.id === id)
}

function outcomeText(outcome: ApprovalBatchTransferRowOutcome): string {
  if (outcome.kind === 'transferred') return t.value.outcomeTransferred
  if (outcome.kind === 'unreported') return t.value.outcomeUnreported
  return describeSkipReason(outcome.reason, isZh.value)
}

async function submit(): Promise<void> {
  if (submitDisabled.value) return
  // CLOSED BEFORE THE FIRST AWAIT. Everything from here to the `finally` is inside the latch, so a
  // second activation that arrives while the confirmation dialog is up re-reads `submitDisabled`
  // above and returns without opening a second dialog or posting a second batch. Ordering is the
  // whole fix: any assignment placed after the `await` below leaves the same window open.
  confirming.value = true
  const submittedIds = [...selectedIds.value]
  // Captured together, because they are one fact: THESE rows, of THIS approver, to THIS target, for
  // THIS reason. Whatever the form says by the time the operator answers the dialog, the request
  // below is the one that was confirmed — no part of it can be taken from a different moment.
  //
  // ROUND-5 ITEM 2, and the choice is stated rather than left implicit: the target and the reason
  // are CAPTURED AND POSTED, not re-checked and refused. The source is different in kind — it names
  // the approver the rows were listed for, so a source that has drifted means the rows themselves
  // are no longer about the approver on screen and there is nothing coherent left to send. The
  // target and the reason have no such relationship to the loaded rows: the confirmed fact stays
  // sendable, and the only thing that must never happen is a value the operator did not confirm
  // going out under a confirmation they gave for a different one. Capturing here — BEFORE the
  // dialog, alongside the ids — is what closes that window; capturing after it would leave it open.
  //
  // Safe by the entry gate, not by luck: `submitDisabled` above already refused `no-target`,
  // `same-user` and `no-reason` against these exact values in this exact tick, so a captured pair
  // can never be a body `blockReasonForTransfer` would itself refuse.
  const submittedSource = loadedSource.value
  const submittedTarget = toUserId.value
  const submittedReason = reason.value.trim()
  // The principal this activation belongs to (round-5 item 1). ONE rule, applied at every write
  // below that happens after an await: the two transport flags belong to whoever holds the page
  // NOW. An activation whose principal has been replaced neither renders its result nor releases a
  // latch it no longer owns — the flags it set were already released by `onInvalidated`, and by the
  // time it settles they may belong to a NEW principal's own in-flight submit, which it would
  // otherwise re-arm mid-request.
  const submittedPrincipal = principalGeneration.value
  const stillOurs = (): boolean => submittedPrincipal === principalGeneration.value
  try {
    await ElMessageBox.confirm(
      isZh.value
        ? `将把所选 ${submittedIds.length} 条待办转交给所选用户，转交原因会写入审批记录。是否继续？`
        : `${submittedIds.length} selected item(s) will be transferred to the selected user, and the reason will be written to the approval record. Continue?`,
      t.value.confirmTitle,
      { type: 'warning' },
    )
  } catch {
    // Operator cancelled the confirm — no request is made, and the latch RE-OPENS. Leaving it shut
    // here would brick the button for the rest of the page's life on a plain "no", which is a worse
    // outcome than the double submit this closes.
    if (stillOurs()) confirming.value = false
    return
  }

  // RE-CHECKED AFTER THE DIALOG, against the captured source and NOT against `submitDisabled` —
  // `confirming` is true here by construction, so re-reading the aggregate would refuse everything
  // and prove nothing. The picker stays live while the confirmation is up, so this is the one
  // window in which the rows and the current source can drift apart after the entry check passed.
  // The operator is told through the ordinary block reason, which is already showing.
  //
  // `stillOurs()` LEADS, and it is not redundant with the source comparison. It is tempting to
  // argue that an identity change is already caught because `onInvalidated` empties the picker and
  // `!submittedSource` or the comparison then refuses — but only while the picker STAYS empty. If
  // the new principal picks the same approver id the previous one had loaded, the comparison reads
  // `'x' !== 'x'` and PASSES: the previous principal's ids, target and reason would be posted under
  // the new principal's session, a request they confirmed nothing about. The settle is discarded
  // either way, so nothing would render — which is precisely why only this check can prevent it.
  if (!stillOurs() || !submittedSource || submittedSource !== fromUserId.value) {
    // `confirming` is only cleared when it is still ours to clear; after an invalidation
    // `onInvalidated` has already released it, and it may now belong to the new principal.
    if (stillOurs()) confirming.value = false
    return
  }

  submitting.value = true
  resetResults()
  try {
    const result = await bulkReassignApprovals({
      // The approver the rows were LISTED for, never the picker's current value.
      fromUserId: submittedSource,
      // Both confirmed above, and posted exactly as confirmed.
      toUserId: submittedTarget,
      reason: submittedReason,
      instanceIds: submittedIds,
    })
    // The identity behind this page changed while the request was in flight. `onInvalidated` has
    // already emptied the page for whoever holds it now; writing this batch's outcomes, summary,
    // latch and success toast on top of that would put the PREVIOUS principal's work — counts of
    // what moved out of an approver's queue — on the new principal's screen, which is the same
    // false statement the invalidation exists to prevent. DROPPED SILENTLY: there is no one left on
    // this page to tell, and an error state would be a second false statement (the batch succeeded).
    if (!stillOurs()) return
    outcomes.value = buildTransferOutcomes(submittedIds, result)
    summary.value = summarizeTransferOutcomes(outcomes.value)
    // The batch reached the server and was answered. Both halves matter: the selection is dropped
    // so nothing is armed, and the latch below keeps it that way until the list is reloaded.
    selectedIds.value = []
    justSubmitted.value = true
    ElMessage.success(t.value.submitSuccess)
  } catch {
    // Guarded on the SAME condition as the success arm: a failure toast belongs to the operator who
    // pressed submit, and after an identity change that operator is not the one reading the page.
    if (!stillOurs()) return
    // A failed request leaves the page re-armable on purpose: nothing was processed.
    ElMessage.error(t.value.submitFailed)
  } finally {
    // GUARDED, and this is the half that is easy to get wrong. `onInvalidated` has already
    // released these for the new principal, who may by now have a submit of their own in flight —
    // clearing unconditionally here would re-arm THEIR button mid-request and let a second batch
    // go out under one activation, which is exactly the double submit the latch exists to prevent.
    if (stillOurs()) {
      submitting.value = false
      confirming.value = false
    }
  }
}
</script>

<style scoped>
.batch-transfer__form {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
  margin-bottom: var(--ms-space-4);
}

.batch-transfer__field {
  display: flex;
  align-items: flex-start;
  gap: var(--ms-space-3);
}

.batch-transfer__label {
  flex: 0 0 84px;
  padding-top: 6px;
  color: var(--ms-text-2);
}

.batch-transfer__load {
  flex: 0 0 auto;
}

.batch-transfer__alert {
  margin-bottom: var(--ms-space-3);
}

.batch-transfer__gate {
  padding: var(--ms-space-4) 0;
  color: var(--ms-text-3);
}

.batch-transfer__rows-head {
  display: flex;
  align-items: center;
  gap: var(--ms-space-3);
  padding-bottom: var(--ms-space-2);
  border-bottom: 1px solid var(--ms-border-light);
}

.batch-transfer__count {
  color: var(--ms-text-3);
}

.batch-transfer__empty {
  padding: var(--ms-space-4) 0;
  color: var(--ms-text-3);
}

.batch-transfer__truncated {
  padding: var(--ms-space-2) 0;
  color: var(--ms-text-2);
}

.batch-transfer__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.batch-transfer__row {
  display: flex;
  align-items: center;
  gap: var(--ms-space-3);
  padding: var(--ms-space-2) 0;
  border-bottom: 1px solid var(--ms-border-light);
}

.batch-transfer__row-title {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.batch-transfer__row-outcome {
  flex: 0 0 auto;
  color: var(--ms-text-2);
}

.batch-transfer__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--ms-space-3);
  margin-top: var(--ms-space-4);
}

.batch-transfer__block {
  color: var(--ms-text-3);
}

.batch-transfer__summary {
  display: flex;
  gap: var(--ms-space-4);
  margin-top: var(--ms-space-3);
  color: var(--ms-text-2);
}
</style>
