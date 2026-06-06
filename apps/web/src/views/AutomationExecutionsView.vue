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

      <div v-if="loading" class="automation-runs__empty">{{ automationLabel('log.loading', isZh) }}</div>
      <div v-else-if="!loadError && runs.length === 0" class="automation-runs__empty" data-empty="true">
        {{ automationLabel('log.empty', isZh) }}
      </div>

      <div
        v-for="run in runs"
        :key="run.id"
        class="automation-runs__item"
        :data-run-id="run.id"
        @click="toggleExpand(run.id)"
      >
        <div class="automation-runs__summary">
          <span class="automation-runs__time">{{ formatTime(run.triggeredAt) }}</span>
          <span class="automation-runs__badge" :class="`automation-runs__badge--${run.status}`" :data-status="run.status">
            {{ automationStatusLabel(run.status, isZh) }}
          </span>
          <span class="automation-runs__rule" data-field="ruleId">{{ run.ruleId }}</span>
          <span v-if="run.sheetId" class="automation-runs__sheet" data-field="sheetId">{{ run.sheetId }}</span>
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
              :class="{ 'automation-runs__step--branch-child': branchChildStep(step.stepKey) }"
            >
              <span class="automation-runs__step-key">{{ step.stepKey }}</span>
              <span v-if="branchChildStep(step.stepKey)" class="automation-runs__branch-child" data-field="branch-child">
                ↳ {{ automationLabel('runs.branchStep', isZh) }} {{ branchChildStep(step.stepKey)?.branchKey }} · #{{ branchChildStep(step.stepKey)?.actionIndex }}
              </span>
              <span class="automation-runs__badge automation-runs__badge--sm" :class="`automation-runs__badge--${step.status}`">
                {{ automationStatusLabel(step.status, isZh) }}
              </span>
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
              <div v-if="step.result !== undefined && step.result !== null && !conditionBranchSelection(step)" class="automation-runs__step-output" data-field="step-output">
                {{ summarizeStepOutput(step.result) }}
              </div>
            </div>

            <!-- A6-2: resume failures map the discriminated code to an INLINE message (never a generic toast). -->
            <div v-if="resumeError" class="automation-runs__step-error" data-field="resume-error" role="alert">{{ resumeError }}</div>

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
import { useLocale } from '../composables/useLocale'
import { useAuth } from '../composables/useAuth'
import { multitableClient, type MultitableApiClient } from '../multitable/api/client'
import type { AutomationRunView, AutomationRunStepView, WorkflowJobStatus } from '../multitable/types'
import { automationLabel, automationStatusLabel, type AutomationLabelKey } from '../multitable/utils/meta-automation-labels'
import { redactString, redactValue, summarizeStepError, summarizeStepOutput } from '../multitable/utils/automation-log-redact'

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

// A6-3-2b (read-only): surface condition_branch lineage from the persisted C1 jobs.
// Parent step's result carries { selectedBranchKey, matched }; nested branch-action jobs use a
// `${stepIndex}.branch.${key}.${i}` stepKey. Pure readers over the existing run-view shape.
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

/**
 * A6-2: resume a suspended step. Confirm-gated (the remaining actions re-run, with possible external
 * side effects — same mental model as A5 retry's confirmSideEffects). The token is used internally and
 * never displayed. On success the run detail reloads in place; on failure the code maps to INLINE error.
 */
async function resumeStep(step: AutomationRunStepView) {
  if (resuming.value || !step.suspend?.resumeToken) return
  if (!window.confirm(automationLabel('runs.resumeConfirm', isZh.value))) return
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
.automation-runs__title { margin: 0; font-size: 20px; font-weight: 700; color: #0f172a; }
.automation-runs__subtitle { margin: 4px 0 0; font-size: 13px; color: #64748b; }
.automation-runs__denied { padding: 14px 16px; border-radius: 10px; background: #fef2f2; color: #b91c1c; font-size: 14px; }
.automation-runs__toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.automation-runs__select, .automation-runs__input { border: 1px solid #cbd5e1; border-radius: 8px; padding: 6px 10px; font-size: 13px; background: #fff; }
.automation-runs__btn { border: 1px solid #cbd5e1; border-radius: 8px; padding: 6px 14px; background: #fff; color: #0f172a; font-size: 13px; cursor: pointer; }
.automation-runs__empty { padding: 10px 12px; border-radius: 10px; font-size: 13px; background: #f8fafc; color: #64748b; }
.automation-runs__error { padding: 10px 12px; border-radius: 10px; font-size: 13px; background: #fef2f2; color: #b91c1c; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.automation-runs__item { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; cursor: pointer; margin-bottom: 8px; }
.automation-runs__item:hover { background: #f8fafc; }
.automation-runs__summary { display: flex; align-items: center; gap: 10px; font-size: 13px; flex-wrap: wrap; }
.automation-runs__time { color: #64748b; min-width: 150px; }
.automation-runs__rule { color: #334155; font-weight: 600; }
.automation-runs__sheet { color: #475569; }
.automation-runs__trigger { color: #475569; }
.automation-runs__duration { margin-left: auto; color: #94a3b8; }
.automation-runs__badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; background: #f1f5f9; color: #475569; }
.automation-runs__badge--resolved { background: #dcfce7; color: #16a34a; }
.automation-runs__badge--failed, .automation-runs__badge--errored, .automation-runs__badge--rejected { background: #fef2f2; color: #dc2626; }
.automation-runs__badge--skipped { background: #f1f5f9; color: #64748b; }
.automation-runs__badge--running, .automation-runs__badge--queued, .automation-runs__badge--suspended { background: #eff6ff; color: #2563eb; }
.automation-runs__badge--sm { font-size: 10px; padding: 1px 6px; }
.automation-runs__detail { margin-top: 8px; padding-top: 8px; border-top: 1px solid #e2e8f0; display: flex; flex-direction: column; gap: 6px; }
.automation-runs__detail-h { margin: 6px 0 2px; font-size: 12px; font-weight: 700; color: #475569; text-transform: uppercase; }
.automation-runs__step { display: flex; align-items: center; gap: 8px; font-size: 12px; flex-wrap: wrap; }
.automation-runs__step-key { font-weight: 700; color: #2563eb; }
.automation-runs__step--branch-child { margin-left: 20px; border-left: 2px solid #e2e8f0; padding-left: 8px; }
.automation-runs__branch-child { color: #64748b; font-size: 11px; }
.automation-runs__branch-selection { width: 100%; padding: 4px 8px; background: #eff6ff; color: #1d4ed8; border-radius: 4px; font-size: 11px; font-weight: 600; }
.automation-runs__step-error { width: 100%; padding: 4px 8px; background: #fef2f2; color: #dc2626; border-radius: 4px; font-size: 11px; }
.automation-runs__step-output { width: 100%; padding: 4px 8px; background: #f8fafc; color: #475569; border-radius: 4px; font-size: 11px; word-break: break-all; }
.automation-runs__json { width: 100%; margin: 0; padding: 8px; background: #f8fafc; color: #334155; border-radius: 6px; font-size: 11px; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow: auto; }
</style>
