<template>
  <section class="automation-runs">
    <header class="automation-runs__header">
      <h1 class="automation-runs__title">{{ automationLabel('runs.title', isZh) }}</h1>
      <p class="automation-runs__subtitle">{{ automationLabel('runs.subtitle', isZh) }}</p>
    </header>

    <!-- Admin-only surface (backend is gated by requireAdminRole; this is the UX mirror) -->
    <div v-if="!isAdmin" class="automation-runs__denied" role="alert" data-denied="true">
      {{ automationLabel('runs.adminOnly', isZh) }}
    </div>

    <template v-else>
      <div class="automation-runs__toolbar">
        <select v-model="statusFilter" class="automation-runs__select" data-field="statusFilter">
          <option value="">{{ automationLabel('status.all', isZh) }}</option>
          <option v-for="s in STATUS_OPTIONS" :key="s" :value="s">{{ automationStatusLabel(s, isZh) }}</option>
        </select>
        <input
          v-model.trim="sheetFilter"
          class="automation-runs__input"
          data-field="sheetFilter"
          :placeholder="automationLabel('runs.sheetFilter', isZh)"
        />
        <button class="automation-runs__btn" type="button" data-action="refresh" @click="loadData">
          {{ automationLabel('log.refresh', isZh) }}
        </button>
      </div>

      <div v-if="loadError" class="automation-runs__error" role="alert" data-error="true">
        <span>{{ automationLabel('log.errorPrefix', isZh) }}</span>
        <span data-field="error-message">{{ loadError }}</span>
        <button class="automation-runs__btn" type="button" data-action="retry" @click="loadData">
          {{ automationLabel('log.retry', isZh) }}
        </button>
      </div>

      <EmptyState v-if="loading" :title="automationLabel('log.loading', isZh)" />
      <EmptyState
        v-else-if="!loadError && runs.length === 0"
        data-empty="true"
        :title="automationLabel('log.empty', isZh)"
      />

      <div
        v-for="run in runs"
        :key="run.id"
        class="automation-runs__item"
        :data-run-id="run.id"
        @click="toggleExpand(run.id)"
      >
        <div class="automation-runs__summary">
          <span class="automation-runs__time">{{ formatTime(run.triggeredAt) }}</span>
          <StatusTag domain="automationRun" :status="run.status" />
          <span class="automation-runs__rule" data-field="ruleName">
            <template v-if="run.ruleName && run.ruleName !== run.ruleId">{{ run.ruleName }}</template>
            <code v-else class="automation-runs__code" data-field="ruleId">{{ run.ruleId }}</code>
          </span>
          <span v-if="run.sheetId" class="automation-runs__sheet" data-field="sheetName">
            <template v-if="run.sheetName && run.sheetName !== run.sheetId">{{ run.sheetName }}</template>
            <code v-else class="automation-runs__code" data-field="sheetId">{{ run.sheetId }}</code>
          </span>
          <span class="automation-runs__trigger" data-field="triggeredBy">{{ run.triggeredBy }}</span>
          <span class="automation-runs__duration">{{ run.duration ?? '-' }}ms</span>
        </div>

        <div v-if="expandedId === run.id" class="automation-runs__detail" data-detail="true">
          <div v-if="detailLoading" class="automation-runs__empty">{{ automationLabel('runs.loadingDetail', isZh) }}</div>
          <template v-else-if="detail">
            <h2 class="automation-runs__detail-h">{{ automationLabel('runs.steps', isZh) }}</h2>
            <div
              v-for="step in detail.steps"
              :key="step.id"
              class="automation-runs__step"
              :class="{ 'automation-runs__step--branch-child': branchChildStep(step.stepKey) || parallelChildStep(step.stepKey) }"
            >
              <span class="automation-runs__step-key">{{ step.stepKey }}</span>
              <span v-if="branchChildStep(step.stepKey)" class="automation-runs__branch-child" data-field="branch-child">
                ↳ {{ automationLabel('runs.branchStep', isZh) }} {{ branchChildStep(step.stepKey)?.branchKey }} · #{{ branchChildStep(step.stepKey)?.actionIndex }}
              </span>
              <span v-else-if="parallelChildStep(step.stepKey)" class="automation-runs__branch-child" data-field="parallel-child">
                ↳ {{ automationLabel('runs.parallelBranchStep', isZh) }} {{ parallelChildStep(step.stepKey)?.branchKey }} · #{{ parallelChildStep(step.stepKey)?.actionIndex }}
              </span>
              <StatusTag domain="automationRun" :status="step.status" size="sm" />
              <!-- A6-2: resume a suspended step (admin detail only; token used internally, never shown). -->
              <button
                v-if="step.status === 'suspended' && step.suspend?.resumeToken"
                class="automation-runs__btn automation-runs__btn--sm"
                type="button"
                data-action="resume"
                :disabled="resuming === step.id"
                @click.stop="resumeStep(step)"
              >{{ automationLabel('runs.resume', isZh) }}</button>
              <div v-if="step.error" class="automation-runs__step-error" data-field="step-error">
                {{ summarizeStepError(step.error) }}
              </div>
              <div v-if="conditionBranchSelection(step)" class="automation-runs__branch-selection" data-field="branch-selection">
                <template v-if="conditionBranchSelection(step)?.key">{{ automationLabel('runs.selectedBranch', isZh) }} {{ conditionBranchSelection(step)?.label ? `${conditionBranchSelection(step)?.label} (${conditionBranchSelection(step)?.key})` : conditionBranchSelection(step)?.key }}</template>
                <template v-else>{{ automationLabel('runs.branchNoMatch', isZh) }}</template>
              </div>
              <div v-if="parallelBranchSummary(step)" class="automation-runs__branch-selection" data-field="parallel-summary">
                {{ automationLabel('runs.parallelJoinAll', isZh) }}
                <span v-for="branch in parallelBranchSummary(step)?.branches" :key="branch.key" class="automation-runs__parallel-branch" data-field="parallel-branch-status">
                  {{ branch.label ? `${branch.label} (${branch.key})` : branch.key }}: {{ automationStatusLabel(branch.status, isZh) }}
                </span>
              </div>
              <div v-if="step.result !== undefined && step.result !== null && !conditionBranchSelection(step) && !parallelBranchSummary(step)" class="automation-runs__step-output" data-field="step-output">
                {{ summarizeStepOutput(step.result) }}
              </div>
            </div>

            <!-- A6-2: resume failures map the discriminated code to an INLINE message (never a generic toast). -->
            <div v-if="resumeError" class="automation-runs__step-error" data-field="resume-error" role="alert">{{ resumeError }}</div>

            <!--
              P3-4: whole-EXECUTION re-run (distinct from per-step Resume above), state-gated on the
              SAME status the backend's retryExecution() enforces (failed/skipped only). TWO admin
              gates are in force here and BOTH are load-bearing: the outer `<template v-else>` wrapper
              (nothing below it renders for a non-admin) and the `isAdmin &&` conjunct on this block.
              Round-2 B2 replaced the previous claim that the conjunct is "observably a no-op" — that
              was only true while the wrapper held; the gate spec now removes BOTH in one mutation and
              reddens, so neither may be dropped as redundant.

              Round-2 B1: rows the backend REFUSES using data this view has already loaded render the
              button DISABLED with the refusal reason (rerunBlockedReasonKey) instead of sending a
              request that is deterministically 409'd.
            -->
            <div v-if="isAdmin && canRerunExecution(run)" class="automation-runs__rerun" data-field="rerun-panel">
              <button
                class="automation-runs__btn automation-runs__btn--rerun"
                type="button"
                data-action="rerun"
                :disabled="rerunning === run.id || rerunBlockedReason(run) !== null"
                :title="rerunBlockedReason(run) ?? undefined"
                :aria-describedby="rerunBlockedReason(run) ? `rerun-blocked-${run.id}` : undefined"
                @click.stop="rerunExecution(run)"
              >{{ automationLabel('runs.rerun', isZh) }}</button>
              <!--
                The reason is a VISIBLE sibling, not only the button's `title`: a disabled button is
                dropped from the accessibility tree by some assistive tech, which would hide a
                title-only reason from exactly the readers who need it. `aria-describedby` points at
                this span for the tech that does expose it.
              -->
              <span
                v-if="rerunBlockedReason(run)"
                :id="`rerun-blocked-${run.id}`"
                class="automation-runs__rerun-blocked"
                data-field="rerun-blocked-reason"
                role="note"
              >{{ rerunBlockedReason(run) }}</span>
              <span
                v-if="rerunTargetId === run.id && rerunSuccessId !== null"
                class="automation-runs__rerun-success"
                data-field="rerun-success"
              >{{ automationLabel('runs.rerunSuccessPrefix', isZh) }} {{ rerunSuccessId }}</span>
              <span
                v-else-if="rerunTargetId === run.id && rerunSuccessGeneric"
                class="automation-runs__rerun-success"
                data-field="rerun-success"
              >{{ automationLabel('runs.rerunSuccessGeneric', isZh) }}</span>
            </div>
            <div
              v-if="rerunTargetId === run.id && rerunError"
              class="automation-runs__step-error"
              data-field="rerun-error"
              role="alert"
            >{{ rerunError }}</div>

            <h2 class="automation-runs__detail-h">{{ automationLabel('runs.triggerEvent', isZh) }}</h2>
            <pre class="automation-runs__json" data-field="trigger-event">{{ jsonView(detail.triggerEvent) }}</pre>
            <h2 class="automation-runs__detail-h">{{ automationLabel('runs.ruleSnapshot', isZh) }}</h2>
            <pre class="automation-runs__json" data-field="rule-snapshot">{{ jsonView(detail.ruleSnapshot) }}</pre>
          </template>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { useLocale } from '../composables/useLocale'
import { useAuth } from '../composables/useAuth'
import { multitableClient, type MultitableApiClient } from '../multitable/api/client'
import type { AutomationRunView, AutomationRunStepView, WorkflowJobStatus } from '../multitable/types'
import { automationActionTypeLabel, automationLabel, automationStatusLabel, type AutomationLabelKey } from '../multitable/utils/meta-automation-labels'
import { redactString, redactValue, summarizeStepError, summarizeStepOutput } from '../multitable/utils/automation-log-redact'
import StatusTag from '../components/status/StatusTag.vue'
import EmptyState from '../components/status/EmptyState.vue'

const props = defineProps<{ client?: MultitableApiClient }>()
const client = props.client ?? multitableClient

const { isZh } = useLocale()
const auth = useAuth()
const isAdmin = auth.hasAdminAccess()

// Statuses a stored run can currently carry (legacy 4-state mapped to C1). The other
// C1 states (queued/suspended/rejected/errored) only appear once the convergence
// engine lands — the A2 API returns empty for them, so they are omitted from the UI.
const STATUS_OPTIONS: WorkflowJobStatus[] = ['resolved', 'failed', 'skipped', 'running']

const runs = ref<AutomationRunView[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)
const statusFilter = ref('')
const sheetFilter = ref('')
const expandedId = ref<string | null>(null)
const detail = ref<AutomationRunView | null>(null)
const detailLoading = ref(false)
const resuming = ref<string | null>(null)
const resumeError = ref<string | null>(null)

// P3-4: whole-execution re-run state. `rerunTargetId` scopes success/error display to the run
// that was actually re-run (only one row can be expanded at a time, but this stays explicit
// rather than relying on that coincidence).
const rerunning = ref<string | null>(null)
const rerunTargetId = ref<string | null>(null)
const rerunSuccessId = ref<string | null>(null)
const rerunSuccessGeneric = ref(false)
const rerunError = ref<string | null>(null)

// A6-3-2b/A6-3-4 (read-only): surface branch lineage from the persisted C1 jobs.
// Parent step's result carries { selectedBranchKey, matched }; nested branch-action jobs use a
// `${stepIndex}.branch.${key}.${i}` stepKey. parallel_branch uses the same shape with
// `${stepIndex}.parallel.${key}.${i}` and a parent result containing branchStatuses.
// Pure readers over the existing run-view shape.
function conditionBranchSelection(step: AutomationRunStepView): { key: string; label: string; matched: boolean } | null {
  const r = step.result
  if (r && typeof r === 'object' && !Array.isArray(r) && 'selectedBranchKey' in r) {
    const rec = r as Record<string, unknown>
    return {
      key: typeof rec.selectedBranchKey === 'string' ? rec.selectedBranchKey : '',
      label: typeof rec.selectedBranchLabel === 'string' ? rec.selectedBranchLabel : '',
      matched: Boolean(rec.matched),
    }
  }
  return null
}
function branchChildStep(stepKey: string): { branchKey: string; actionIndex: string } | null {
  const m = /\.branch\.([A-Za-z0-9_-]+)\.(\d+)$/.exec(stepKey)
  return m ? { branchKey: m[1], actionIndex: m[2] } : null
}
function parallelChildStep(stepKey: string): { branchKey: string; actionIndex: string } | null {
  const m = /\.parallel\.([A-Za-z0-9_-]+)\.(\d+)$/.exec(stepKey)
  return m ? { branchKey: m[1], actionIndex: m[2] } : null
}
function parallelBranchSummary(step: AutomationRunStepView): { branches: Array<{ key: string; label: string; status: WorkflowJobStatus }> } | null {
  const r = step.result
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  const rec = r as Record<string, unknown>
  if (rec.joinMode !== 'all' || !rec.branchStatuses || typeof rec.branchStatuses !== 'object' || Array.isArray(rec.branchStatuses)) return null
  const labels = rec.branchLabels && typeof rec.branchLabels === 'object' && !Array.isArray(rec.branchLabels)
    ? rec.branchLabels as Record<string, unknown>
    : {}
  const branches = Object.entries(rec.branchStatuses as Record<string, unknown>)
    .map(([key, status]) => ({
      key,
      label: typeof labels[key] === 'string' ? labels[key] : '',
      status: (typeof status === 'string' ? status : 'running') as WorkflowJobStatus,
    }))
  return { branches }
}

async function loadData() {
  loading.value = true
  loadError.value = null
  expandedId.value = null
  detail.value = null
  try {
    runs.value = await client.listAutomationRuns({
      status: statusFilter.value || undefined,
      sheetId: sheetFilter.value || undefined,
      limit: 100,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    loadError.value = redactString(message) || automationLabel('error.unknown', isZh.value)
    runs.value = []
  } finally {
    loading.value = false
  }
}

async function toggleExpand(id: string) {
  resumeError.value = null
  rerunError.value = null
  rerunSuccessId.value = null
  rerunSuccessGeneric.value = false
  rerunTargetId.value = null
  if (expandedId.value === id) {
    expandedId.value = null
    detail.value = null
    return
  }
  expandedId.value = id
  detail.value = null
  detailLoading.value = true
  let run: AutomationRunView | null = null
  try {
    run = await client.getAutomationRun(id)
  } catch {
    run = null
  }
  // Drop a STALE response: if a newer row was expanded while this fetch was in
  // flight, expandedId has moved on — that newer flow owns the state, so this
  // (older) response must not paint its detail under the wrong row.
  if (expandedId.value !== id) return
  if (run) {
    detail.value = run
  } else {
    expandedId.value = null // detail failed for the still-current row → collapse
  }
  detailLoading.value = false
}

const RESUME_ERROR_LABELS: Record<string, AutomationLabelKey> = {
  NOT_FOUND: 'runs.resumeError.notFound',
  ALREADY_RESUMED: 'runs.resumeError.alreadyResumed',
  RULE_CHANGED: 'runs.resumeError.ruleChanged',
  RULE_MISSING_OR_DISABLED: 'runs.resumeError.ruleMissingOrDisabled',
  RECORD_GONE: 'runs.resumeError.recordGone',
}

/** Map the resume endpoint's discriminated code → an inline localized message (never a generic toast). */
function mapResumeError(err: unknown): string {
  const code = (err as { code?: string })?.code
  if (code && RESUME_ERROR_LABELS[code]) return automationLabel(RESUME_ERROR_LABELS[code], isZh.value)
  const msg = err instanceof Error ? err.message : String(err)
  return redactString(msg) || automationLabel('runs.resumeError.generic', isZh.value)
}

// UF-8: ElMessageBox.confirm replaces window.confirm (design-lock §3.6).
async function confirmResumeStep(): Promise<boolean> {
  try {
    await ElMessageBox.confirm(
      automationLabel('runs.resumeConfirm', isZh.value),
      automationLabel('runs.resumeConfirmTitle', isZh.value),
      { type: 'warning', confirmButtonText: automationLabel('runs.resume', isZh.value), cancelButtonText: automationLabel('editor.cancel', isZh.value) },
    )
    return true
  } catch {
    return false
  }
}

/**
 * A6-2: resume a suspended step. Confirm-gated (the remaining actions re-run, with possible external
 * side effects — same mental model as A5 retry's confirmSideEffects). The token is used internally and
 * never displayed. On success the run detail reloads in place; on failure the code maps to INLINE error.
 */
async function resumeStep(step: AutomationRunStepView) {
  if (resuming.value || !step.suspend?.resumeToken) return
  if (!(await confirmResumeStep())) return
  const runId = expandedId.value
  resumeError.value = null
  resuming.value = step.id
  try {
    await client.resumeAutomation(step.suspend.resumeToken)
    if (runId && expandedId.value === runId) {
      const refreshed = await client.getAutomationRun(runId).catch(() => null)
      if (expandedId.value === runId && refreshed) detail.value = refreshed
    }
  } catch (err) {
    resumeError.value = mapResumeError(err)
  } finally {
    resuming.value = null
  }
}

// P3-4 — whole-execution re-run (A5 `POST /automation-executions/:id/retry`, mirrored from
// packages/core-backend/src/multitable/automation-service.ts retryExecution()). CONFIRM_SIDE_EFFECTS_REQUIRED
// is deliberately NOT mapped here: this client always sends confirmSideEffects:true, so that code
// firing means the request stopped sending it — let it fall through to the raw message instead of
// dressing up a real defect as a normal rejection reason.
const RERUN_ERROR_LABELS: Record<string, AutomationLabelKey> = {
  NOT_FOUND: 'runs.rerunError.notFound',
  NOT_RETRYABLE: 'runs.rerunError.notRetryable',
  TEST_RUN_NOT_RETRYABLE: 'runs.rerunError.testRunNotRetryable',
  MISSING_TRIGGER_EVENT: 'runs.rerunError.missingTriggerEvent',
  RETRY_WINDOW_EXPIRED: 'runs.rerunError.retryWindowExpired',
  START_APPROVAL_ALREADY_CREATED: 'runs.rerunError.approvalAlreadyCreated',
  RULE_MISSING_OR_DISABLED: 'runs.rerunError.ruleMissingOrDisabled',
  RULE_CHANGED: 'runs.rerunError.ruleChanged',
  RETRY_LEDGER_EVIDENCE_MISSING: 'runs.rerunError.ledgerEvidenceMissing',
  // Round-2 B5 — the route guard's 403 body is `{ error: 'AccessDenied', code: 'ADMIN_REQUIRED',
  // message: '<English>' }` (routes/automation.ts:793 requireAdminRole). The SHARED normalizer
  // (multitable/api/client.ts normalizeApiErrorPayload) only reads a top-level `code` when `error`
  // is an OBJECT; for the string-`error` shape it keys the thrown error as `AccessDenied` and drops
  // `ADMIN_REQUIRED`, so without this entry the raw English server string renders in a zh session.
  // Both keys are mapped: `AccessDenied` is what the client actually throws today, `ADMIN_REQUIRED`
  // is the code the backend documents. Widening the shared normalizer instead would change
  // `error.code` for EVERY endpoint returning `{error:'<string>', code:'<X>'}` — an unbounded
  // caller set for a one-button slice; that is the right long-term home, not this change.
  AccessDenied: 'runs.rerunError.adminRequired',
  ADMIN_REQUIRED: 'runs.rerunError.adminRequired',
}

/** Map the retry endpoint's discriminated code → an inline localized message (never a generic toast). */
function mapRerunError(err: unknown): string {
  const code = (err as { code?: string })?.code
  if (code && RERUN_ERROR_LABELS[code]) return automationLabel(RERUN_ERROR_LABELS[code], isZh.value)
  const msg = err instanceof Error ? err.message : String(err)
  return redactString(msg) || automationLabel('runs.rerunError.generic', isZh.value)
}

/**
 * COMPLETE enumeration of the refusals `retryExecution()` can return
 * (packages/core-backend/src/multitable/automation-service.ts), and which of them this view can
 * predict from data it has ALREADY loaded. Nothing here guesses at state the client cannot see.
 *
 *  PREDICTABLE (mirrored below — never sent):
 *   1. 409 NOT_RETRYABLE            automation-service.ts:2723-2729 — status ∉ {failed, skipped}.
 *      Mirrored by `canRerunExecution` on the list row's `status`; the C1 `status` field is
 *      identity-mapped to the legacy status for exactly those two values
 *      (routes/automation.ts toRunView + workflow-job-contract.ts legacyAutomationStatusToJobStatus),
 *      so the mirror is neither wider nor narrower. → the button is NOT RENDERED (see below).
 *   2. 409 TEST_RUN_NOT_RETRYABLE   automation-service.ts:2733-2739 — `triggeredBy === 'manual_test'`.
 *      The list row carries the same field (routes/automation.ts:139 `triggeredBy:
 *      execution.triggeredBy`) and renders it as `data-field="triggeredBy"`; the value is stamped
 *      server-side (automation-executor.ts:1599 from `_triggeredBy`, set by testRun at
 *      automation-service.ts:3774). → button DISABLED + reason.
 *   3. 409 MISSING_TRIGGER_EVENT    automation-service.ts:2740-2743, predicate at :903-908 — the
 *      stored trigger event must be a NON-EMPTY, non-array plain object. The detail GET serializes
 *      the SAME persisted object the retry guard reads (`svc.logs.getById` → toRunView
 *      `triggerEvent: execution.triggerEvent ?? null`, routes/automation.ts:152), so
 *      `hasUsableStoredTriggerEvent` below restates the same predicate. Claim scope: the mirror is
 *      asserted equal to :903 for the values the spec exercises — null, `[]`, `{}`, a populated
 *      event, and a record-less `{ _triggeredBy: 'schedule' }` — not proven equivalent over all
 *      inputs. It fails CLOSED on `undefined`/absent, which the current detail path cannot produce.
 *      → button DISABLED + reason.
 *
 *  NOT PREDICTABLE (still sent; the server's refusal is surfaced verbatim-by-code via mapRerunError):
 *   4. 404 NOT_FOUND                     :2721 — the row can be deleted between list and click.
 *   5. 409 RETRY_WINDOW_EXPIRED          :2748-2753 — measured on the LINEAGE ROOT's triggeredAt
 *      (a row this view may never have loaded) against a backend-only window
 *      (multitable/automation-retry-eligibility.ts:111, not imported by apps/web).
 *   6. 409 START_APPROVAL_ALREADY_CREATED :2757-2760 — approval-bridge query over the lineage.
 *   7. 409 RULE_MISSING_OR_DISABLED      :2764-2765 — CURRENT rule state; the run only carries a
 *      historical snapshot.
 *   8. 409 RULE_CHANGED                  :2775-2781 — fingerprint of the CURRENT rule vs the one
 *      stored at run time; the stored fingerprint is not on the run view at all.
 *   9. 409 RETRY_LEDGER_EVIDENCE_MISSING :2790-2795 — retry-ledger evidence query.
 *  (400 CONFIRM_SIDE_EFFECTS_REQUIRED is not a row property — this client always sends the flag;
 *   403 ADMIN_REQUIRED is mirrored by `isAdmin`, an approximation — see the B4 disclosure.)
 */
function canRerunExecution(run: AutomationRunView): boolean {
  return run.status === 'failed' || run.status === 'skipped'
}

/** Byte-faithful mirror of automation-service.ts:903 `isRetryableStoredTriggerEvent`. */
function hasUsableStoredTriggerEvent(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).length > 0
}

/**
 * Round-2 B1 — the refusal this row would deterministically get, or null when the request is worth
 * sending. Only classes 2 and 3 above; `detail` is always THIS run's detail where the button
 * renders (toggleExpand nulls it before each fetch and drops stale responses).
 */
function rerunBlockedReasonKey(run: AutomationRunView): AutomationLabelKey | null {
  if (run.triggeredBy === 'manual_test') return 'runs.rerunError.testRunNotRetryable'
  if (!hasUsableStoredTriggerEvent(detail.value?.triggerEvent)) return 'runs.rerunError.missingTriggerEvent'
  return null
}

function rerunBlockedReason(run: AutomationRunView): string | null {
  const key = rerunBlockedReasonKey(run)
  return key ? automationLabel(key, isZh.value) : null
}

/**
 * The consequences of re-running, read from the already-loaded detail's ruleSnapshot (no extra
 * fetch). TWO states only (round-2 B3): either every action is nameable, or the enumeration is
 * refused as a whole. A missing/non-object snapshot, a non-array `actions`, an EMPTY action list,
 * or a single entry whose `type` is not a string all collapse to `unknown` — fail closed, because a
 * partial list read as a complete one is exactly the boilerplate this control must not show.
 */
type RerunConsequences = { state: 'enumerated'; labels: string[] } | { state: 'unknown' }

function rerunConsequences(): RerunConsequences {
  const snapshot = detail.value?.ruleSnapshot
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return { state: 'unknown' }
  const actions = (snapshot as Record<string, unknown>).actions
  if (!Array.isArray(actions) || actions.length === 0) return { state: 'unknown' }
  const seen = new Set<string>()
  const kinds: string[] = []
  for (const action of actions) {
    if (!action || typeof action !== 'object') return { state: 'unknown' }
    const type = (action as Record<string, unknown>).type
    if (typeof type !== 'string' || !type) return { state: 'unknown' }
    const label = automationActionTypeLabel(type, isZh.value)
    if (!seen.has(label)) {
      seen.add(label)
      kinds.push(label)
    }
  }
  return { state: 'enumerated', labels: kinds }
}

// UF-8: ElMessageBox.confirm replaces window.confirm (design-lock §3.6). Enumerates the
// consequences from data already on the row (rule/sheet) + the loaded detail (action kinds) —
// req (2): the operator sees what will run again before confirming, not just a generic warning.
async function confirmRerunExecution(run: AutomationRunView): Promise<boolean> {
  const ruleName = run.ruleName || run.ruleId
  const sheetName = run.sheetName || run.sheetId || automationLabel('runs.rerunConfirmNoSheet', isZh.value)
  const consequences = rerunConsequences()
  const kindsText = consequences.state === 'enumerated'
    ? consequences.labels.join(', ')
    : automationLabel('runs.rerunConfirmUnknownActions', isZh.value)
  const message = [
    `${automationLabel('runs.rerunConfirmRuleLabel', isZh.value)} ${ruleName}`,
    `${automationLabel('runs.rerunConfirmSheetLabel', isZh.value)} ${sheetName}`,
    `${automationLabel('runs.rerunConfirmActionsLabel', isZh.value)} ${kindsText}`,
    automationLabel('runs.rerunConfirmFooter', isZh.value),
  ].join('\n')
  try {
    await ElMessageBox.confirm(
      message,
      automationLabel('runs.rerunConfirmTitle', isZh.value),
      { type: 'warning', confirmButtonText: automationLabel('runs.rerun', isZh.value), cancelButtonText: automationLabel('editor.cancel', isZh.value) },
    )
  } catch {
    return false
  }
  // Round-2 B3 — when the consequences could NOT be enumerated, the first dialog showed an honest
  // "cannot be listed" line rather than an action list, so the operator has approved a side-effecting
  // run they were unable to preview. Require a SECOND, differently-worded acknowledgement before
  // sending. (Chosen over refusing the re-run outright: an unusable ruleSnapshot is NOT one of the
  // backend's refusals — retryExecution() never reads it — so refusing here would withdraw a
  // capability the server still grants, and would do it silently.)
  if (consequences.state === 'unknown') {
    try {
      await ElMessageBox.confirm(
        automationLabel('runs.rerunUnknownActionsAckMessage', isZh.value),
        automationLabel('runs.rerunUnknownActionsAckTitle', isZh.value),
        {
          type: 'warning',
          confirmButtonText: automationLabel('runs.rerunUnknownActionsAckConfirm', isZh.value),
          cancelButtonText: automationLabel('editor.cancel', isZh.value),
        },
      )
    } catch {
      return false
    }
  }
  return true
}

/**
 * P3-4: re-run a whole execution through the EXISTING A5 retry endpoint (never a new one).
 * Confirm-gated; on success shows the new execution id inline (never auto-reloads the list, which
 * would collapse this just-confirmed row); on failure the discriminated code maps to an INLINE
 * message next to the button that was clicked (per-row, honest — never a generic toast, never
 * silently swallowed into the existing list).
 */
async function rerunExecution(run: AutomationRunView) {
  if (rerunning.value || !canRerunExecution(run)) return
  // Round-2 B1: belt-and-braces only, and stated as such — the rendered `disabled` attribute is the
  // gate that the spec actually pins. Removing THIS line alone leaves all 22 specs green (mutation
  // run in round 2), because a disabled button swallows the click before the handler; it earns its
  // place only against a future refactor that drops `disabled`. Silent by design: the reason is
  // already on screen next to the button (`data-field="rerun-blocked-reason"`).
  if (rerunBlockedReasonKey(run) !== null) return
  if (!(await confirmRerunExecution(run))) return
  rerunTargetId.value = run.id
  rerunError.value = null
  rerunSuccessId.value = null
  rerunSuccessGeneric.value = false
  rerunning.value = run.id
  try {
    const result = await client.retryAutomationExecution(run.id)
    if (typeof result?.id === 'string' && result.id) {
      rerunSuccessId.value = result.id
    } else {
      rerunSuccessGeneric.value = true
    }
  } catch (err) {
    rerunError.value = mapRerunError(err)
  } finally {
    rerunning.value = null
  }
}

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ts
  }
}

/**
 * Render a redacted snapshot blob (A2 already scrubs at persist; this is
 * defense-in-depth). Uses redactValue (not redactString) so the UI-side guard
 * also masks structured secret keys (authorization/cookie/…), matching the
 * step-output redaction path — not just in-string patterns.
 */
function jsonView(value: unknown): string {
  if (value === undefined || value === null) return '—'
  try {
    return JSON.stringify(redactValue(value), null, 2)
  } catch {
    return '—'
  }
}

if (isAdmin) void loadData()
</script>

<style scoped>
.automation-runs { padding: 20px 24px; max-width: 1000px; margin: 0 auto; }
.automation-runs__header { margin-bottom: 16px; }
.automation-runs__title { margin: 0; font-size: 20px; font-weight: 700; color: var(--ms-text-1); }
.automation-runs__subtitle { margin: 4px 0 0; font-size: 13px; color: var(--ms-text-2); }
.automation-runs__denied { padding: 14px 16px; border-radius: 10px; background: var(--el-color-danger-light-9); color: var(--el-color-danger-dark-2); font-size: 14px; }
.automation-runs__toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.automation-runs__select, .automation-runs__input { border: 1px solid var(--ms-border); border-radius: 8px; padding: 6px 10px; font-size: 13px; background: var(--ms-bg-card); }
.automation-runs__btn { border: 1px solid var(--ms-border); border-radius: 8px; padding: 6px 14px; background: var(--ms-bg-card); color: var(--ms-text-1); font-size: 13px; cursor: pointer; }
/* P3-4: visually distinct from the plain `.automation-runs__btn` load-failure Retry (req 1) —
   warning-toned border/text, same family as the destructive/side-effect affordances elsewhere. */
.automation-runs__btn--rerun { border-color: var(--el-color-warning); color: var(--el-color-warning-dark-2); }
.automation-runs__rerun { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 4px 0; }
.automation-runs__rerun-success { font-size: 12px; color: var(--el-color-success); }
/* Round-2 B1: the reason a deterministically-refused row's button is disabled, shown next to it. */
.automation-runs__rerun-blocked { font-size: 12px; color: var(--ms-text-2); }
.automation-runs__btn--rerun:disabled { cursor: not-allowed; opacity: 0.6; }
.automation-runs__empty { padding: 10px 12px; border-radius: 10px; font-size: 13px; background: var(--ms-bg-page); color: var(--ms-text-2); }
.automation-runs__error { padding: 10px 12px; border-radius: 10px; font-size: 13px; background: var(--el-color-danger-light-9); color: var(--el-color-danger-dark-2); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.automation-runs__item { border: 1px solid var(--ms-border-light); border-radius: 8px; padding: 10px 12px; cursor: pointer; margin-bottom: 8px; }
.automation-runs__item:hover { background: var(--ms-bg-page); }
.automation-runs__summary { display: flex; align-items: center; gap: 10px; font-size: 13px; flex-wrap: wrap; }
.automation-runs__time { color: var(--ms-text-2); min-width: 150px; }
.automation-runs__rule { color: var(--ms-text-2); font-weight: 600; }
.automation-runs__sheet { color: var(--ms-text-2); }
/* B3-11: the list payload now resolves ruleName/sheetName via a batched server-side lookup
   (UF-8's prior "no lookup available" constraint is lifted). A resolved name renders as plain
   text; an UNRESOLVED one (rule/sheet deleted, or name === id) still degrades to the honest
   <code> id fallback — it names the value as a machine id instead of dressing it up as a
   plain label (design-lock §3.5). */
.automation-runs__code { font-family: monospace; font-size: 11px; background: var(--ms-bg-page); padding: 1px 4px; border-radius: var(--ms-radius-sm); }
.automation-runs__trigger { color: var(--ms-text-2); }
.automation-runs__duration { margin-left: auto; color: var(--ms-text-3); }
/* UF-3: the run/step status badges are now <StatusTag domain="automationRun"> (utils/
   statusDomains.ts) — this file's own uppercase/hex badge palette (one of six independent
   status-color implementations the UI foundation design-lock audit found) is removed. */
.automation-runs__detail { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--ms-border-light); display: flex; flex-direction: column; gap: 6px; }
.automation-runs__detail-h { margin: 6px 0 2px; font-size: 12px; font-weight: 700; color: var(--ms-text-2); text-transform: uppercase; }
.automation-runs__step { display: flex; align-items: center; gap: 8px; font-size: 12px; flex-wrap: wrap; }
.automation-runs__step-key { font-weight: 700; color: var(--ms-color-primary); }
.automation-runs__step--branch-child { margin-left: 20px; border-left: 2px solid var(--ms-border-light); padding-left: 8px; }
.automation-runs__branch-child { color: var(--ms-text-2); font-size: 11px; }
.automation-runs__branch-selection { width: 100%; padding: 4px 8px; background: var(--el-color-primary-light-9); color: var(--el-color-primary-dark-2); border-radius: 4px; font-size: 11px; font-weight: 600; }
.automation-runs__step-error { width: 100%; padding: 4px 8px; background: var(--el-color-danger-light-9); color: var(--ms-color-danger); border-radius: 4px; font-size: 11px; }
.automation-runs__step-output { width: 100%; padding: 4px 8px; background: var(--ms-bg-page); color: var(--ms-text-2); border-radius: 4px; font-size: 11px; word-break: break-all; }
.automation-runs__json { width: 100%; margin: 0; padding: 8px; background: var(--ms-bg-page); color: var(--ms-text-2); border-radius: 6px; font-size: 11px; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow: auto; }
</style>
