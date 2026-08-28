<template>
  <Teleport to="body">
    <div v-if="visible" class="archive-recovery-overlay" data-test="archive-recovery-modal" @click.self="close">
      <section class="archive-recovery-modal" role="dialog" :aria-label="l('title')">
        <header class="archive-recovery__header">
          <div>
            <strong>{{ l('title') }}</strong>
            <span>{{ l('subtitle') }}</span>
          </div>
          <MtIconButton class="archive-recovery__close" :aria-label="l('close')" @click="close">&times;</MtIconButton>
        </header>

        <div class="archive-recovery__body">
          <p v-if="catalogLoading" class="archive-recovery__state" data-test="archive-recovery-loading">{{ l('loading') }}</p>
          <p v-else-if="catalogError" class="archive-recovery__state archive-recovery__state--error" data-test="archive-recovery-catalog-error">{{ catalogError }}</p>
          <p v-else-if="entries.length === 0" class="archive-recovery__state" data-test="archive-recovery-empty">{{ l('empty') }}</p>
          <div v-else class="archive-recovery__catalog" data-test="archive-recovery-catalog">
            <button
              v-for="entry in entries"
              :key="entry.generationId"
              type="button"
              class="archive-recovery__entry"
              :class="{ 'archive-recovery__entry--selected': selectedGenerationId === entry.generationId }"
              :data-test="`archive-recovery-entry-${entry.generationId}`"
              :disabled="Boolean(job)"
              @click="selectEntry(entry.generationId)"
            >
              <span class="archive-recovery__entry-time">{{ formatTime(entry.recoveryPointAt) }}</span>
              <span class="archive-recovery__entry-meta">{{ coverageLabel(entry.coverageRowCount) }}</span>
              <span v-if="entry.superseded" class="archive-recovery__entry-state">{{ l('superseded') }}</span>
            </button>
          </div>
          <button
            v-if="nextCursor"
            type="button"
            class="archive-recovery__load-more"
            data-test="archive-recovery-load-more"
            :disabled="catalogLoading || Boolean(job)"
            @click="loadCatalog(false)"
          >{{ l('loadMore') }}</button>

          <div v-if="selectedEntry && !job" class="archive-recovery__preview" data-test="archive-recovery-preview-area">
            <div class="archive-recovery__scope" role="group" :aria-label="l('scope')">
              <span class="archive-recovery__scope-title">{{ l('scope') }}</span>
              <label class="archive-recovery__scope-option">
                <input v-model="scopeKind" type="radio" value="whole_sheet" :disabled="busy" />
                <span>{{ l('wholeSheet') }}</span>
              </label>
              <label class="archive-recovery__scope-option" :class="{ 'archive-recovery__scope-option--disabled': selectedRecordIds.length === 0 }">
                <input v-model="scopeKind" type="radio" value="selected_records" :disabled="busy || selectedRecordIds.length === 0" />
                <span>{{ selectedRecordsLabel }}</span>
              </label>
              <label class="archive-recovery__scope-option" :class="{ 'archive-recovery__scope-option--disabled': selectedRecordIds.length === 0 || fields.length === 0 }">
                <input v-model="scopeKind" type="radio" value="selected_fields" :disabled="busy || selectedRecordIds.length === 0 || fields.length === 0" />
                <span>{{ l('selectedFields') }}</span>
              </label>
            </div>

            <div v-if="scopeKind === 'selected_fields'" class="archive-recovery__fields" data-test="archive-recovery-fields">
              <div class="archive-recovery__fields-head">
                <span>{{ l('fields') }}</span>
                <span>
                  <button type="button" :disabled="busy" @click="selectAllFields">{{ l('selectAll') }}</button>
                  <button type="button" :disabled="busy" @click="clearAllFields">{{ l('clearAll') }}</button>
                </span>
              </div>
              <label v-for="field in fields" :key="field.id" class="archive-recovery__field-option">
                <input
                  type="checkbox"
                  :checked="selectedFieldIds.has(field.id)"
                  :disabled="busy"
                  @change="toggleField(field.id)"
                />
                <span>{{ field.name }}</span>
              </label>
              <p v-if="selectedFieldIds.size === 0" class="archive-recovery__state archive-recovery__state--warning">{{ l('chooseField') }}</p>
            </div>

            <div class="archive-recovery__mode" role="group" :aria-label="l('mode')">
              <button
                v-for="candidate in MODES"
                :key="candidate"
                type="button"
                class="archive-recovery__mode-button"
                :class="{ 'archive-recovery__mode-button--active': mode === candidate }"
                :data-test="`archive-recovery-mode-${candidate}`"
                :disabled="busy"
                @click="mode = candidate; clearPreview()"
              >{{ modeLabel(candidate) }}</button>
              <button
                type="button"
                class="archive-recovery__preview-button"
                data-test="archive-recovery-request-preview"
                :disabled="!canPreview || busy"
                @click="requestPreview"
              >{{ previewLoading ? l('previewing') : l('preview') }}</button>
            </div>

            <p v-if="previewError" class="archive-recovery__state archive-recovery__state--error" data-test="archive-recovery-preview-error">{{ previewError }}</p>
            <template v-else-if="preview">
              <dl class="archive-recovery__summary" data-test="archive-recovery-summary">
                <div><dt>{{ l('changes') }}</dt><dd>{{ preview.summary.effectiveWriteCount }}</dd></div>
                <div><dt>{{ l('reverts') }}</dt><dd>{{ preview.summary.reverts.length }}</dd></div>
                <div><dt>{{ l('resurrections') }}</dt><dd>{{ preview.summary.resurrectIds.length }}</dd></div>
                <div><dt>{{ l('deletions') }}</dt><dd>{{ preview.summary.deleteIds.length }}</dd></div>
                <div><dt>{{ l('kept') }}</dt><dd>{{ preview.summary.keptCreatedAfterAnchorCount }}</dd></div>
                <div><dt>{{ l('drift') }}</dt><dd>{{ preview.summary.driftCount }}</dd></div>
              </dl>

              <p v-if="preview.executionKind === 'async'" class="archive-recovery__state archive-recovery__state--warning" data-test="archive-recovery-async-required">{{ l('asyncRequired') }}</p>
              <p v-if="!canRunPreview" class="archive-recovery__state archive-recovery__state--warning" data-test="archive-recovery-blocked">{{ blockedLabel(preview.blockedReason) }}</p>

              <template v-else>
                <label class="archive-recovery__confirm" data-test="archive-recovery-confirm-label">
                  <input v-model="confirmed" type="checkbox" data-test="archive-recovery-confirm-input" />
                  <span>{{ confirmLabel }}</span>
                </label>
                <button
                  type="button"
                  class="archive-recovery__execute"
                  data-test="archive-recovery-execute"
                  :disabled="!confirmed || executing"
                  @click="runPreview"
                >{{ actionLabel }}</button>
              </template>
            </template>
            <p v-if="result" class="archive-recovery__state archive-recovery__state--success" data-test="archive-recovery-result">{{ resultLabel }}</p>
          </div>

          <section v-if="job" class="archive-recovery__job" data-test="archive-recovery-job" aria-live="polite">
            <div class="archive-recovery__job-head">
              <strong>{{ l('jobTitle') }}</strong>
              <span data-test="archive-recovery-job-state">{{ jobStateLabel }}</span>
            </div>
            <div class="archive-recovery__job-counts">
              <span>{{ l('progress') }}</span>
              <strong data-test="archive-recovery-job-counts">{{ job.completedCount }} / {{ job.totalCount }}</strong>
            </div>
            <div
              class="archive-recovery__progress"
              role="progressbar"
              :aria-label="l('progress')"
              :aria-valuemin="0"
              :aria-valuemax="100"
              :aria-valuenow="jobProgressPercent"
            ><span :style="{ width: `${jobProgressPercent}%` }"></span></div>
            <p v-if="jobActive" class="archive-recovery__state">{{ deadlineLabel }}</p>
            <p v-if="jobOutcomeLabel" class="archive-recovery__state" :class="jobOutcomeClass" data-test="archive-recovery-job-outcome">{{ jobOutcomeLabel }}</p>
            <p v-if="jobError" class="archive-recovery__state archive-recovery__state--error" data-test="archive-recovery-job-error">{{ jobError }}</p>
            <div class="archive-recovery__job-actions">
              <button type="button" :disabled="jobBusy" data-test="archive-recovery-job-refresh" @click="refreshCurrentJob(false)">{{ l('refresh') }}</button>
              <button v-if="job.state === 'paused_retryable'" type="button" :disabled="jobBusy" data-test="archive-recovery-job-resume" @click="resumeCurrentJob">{{ l('resume') }}</button>
              <button v-if="jobActive" type="button" class="archive-recovery__job-cancel" :disabled="jobBusy" data-test="archive-recovery-job-cancel" @click="cancelCurrentJob">{{ l('cancelJob') }}</button>
              <button v-if="jobTerminal" type="button" data-test="archive-recovery-new" @click="clearJob">{{ l('newRecovery') }}</button>
            </div>
          </section>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import type {
  RecoveryArchiveCatalogEntry,
  RecoveryArchiveCatalogPage,
  RecoveryArchiveExecuteResult,
  RecoveryArchiveJobSnapshot,
  RecoveryArchivePreview,
  RecoveryArchiveScope,
} from '../api/client'
import { MtIconButton } from '../ui'

export interface RecoveryArchiveFieldOption {
  id: string
  name: string
}

const MODES = ['revert', 'reset'] as const
const TERMINAL_JOB_STATES = new Set(['done', 'abandoned_partial', 'cancelled_zero_write'])
const JOB_POLL_MS = 2_000

const props = defineProps<{
  visible: boolean
  sheetId: string
  isZh: boolean
  fields: RecoveryArchiveFieldOption[]
  selectedRecordIds: string[]
  listCatalog: (sheetId: string, params?: { cursor?: string; limit?: number }) => Promise<RecoveryArchiveCatalogPage>
  previewArchive: (sheetId: string, input: { generationId: string; mode: 'revert' | 'reset'; scope: RecoveryArchiveScope }) => Promise<RecoveryArchivePreview>
  executeArchive: (sheetId: string, input: { previewIdentity: string; scope: RecoveryArchiveScope }) => Promise<RecoveryArchiveExecuteResult>
  acceptJob: (sheetId: string, previewIdentity: string) => Promise<RecoveryArchiveJobSnapshot>
  readJob: (sheetId: string, jobId: string) => Promise<RecoveryArchiveJobSnapshot>
  resumeJob: (sheetId: string, jobId: string) => Promise<RecoveryArchiveJobSnapshot>
  cancelJob: (sheetId: string, jobId: string) => Promise<RecoveryArchiveJobSnapshot>
}>()

const emit = defineEmits<{ (e: 'close'): void; (e: 'executed'): void; (e: 'refresh'): void }>()

const entries = ref<RecoveryArchiveCatalogEntry[]>([])
const nextCursor = ref<string | null>(null)
const selectedGenerationId = ref<string | null>(null)
const mode = ref<'revert' | 'reset'>('revert')
const scopeKind = ref<RecoveryArchiveScope['kind']>('whole_sheet')
const selectedFieldIds = ref<Set<string>>(new Set(props.fields.map((field) => field.id)))
const catalogLoading = ref(false)
const catalogError = ref<string | null>(null)
const previewLoading = ref(false)
const previewError = ref<string | null>(null)
const preview = ref<RecoveryArchivePreview | null>(null)
const previewScope = ref<RecoveryArchiveScope | null>(null)
const confirmed = ref(false)
const executing = ref(false)
const result = ref<RecoveryArchiveExecuteResult | null>(null)
const job = ref<RecoveryArchiveJobSnapshot | null>(null)
const jobBusy = ref(false)
const jobError = ref<string | null>(null)
const jobsBySheet = new Map<string, RecoveryArchiveJobSnapshot>()
let catalogRequest = 0
let previewRequest = 0
let executeRequest = 0
let jobRequest = 0
let jobPollTimer: ReturnType<typeof setTimeout> | null = null

const selectedEntry = computed(() => entries.value.find((entry) => entry.generationId === selectedGenerationId.value) ?? null)
const canPreview = computed(() => {
  if (scopeKind.value === 'whole_sheet') return true
  if (props.selectedRecordIds.length === 0) return false
  return scopeKind.value === 'selected_records' || selectedFieldIds.value.size > 0
})
const canExecuteSync = computed(() =>
  preview.value?.executionKind === 'sync' &&
  preview.value.executable === true &&
  typeof preview.value.previewIdentity === 'string' &&
  preview.value.previewIdentity.length > 0,
)
const canAcceptAsync = computed(() =>
  preview.value?.executionKind === 'async' &&
  preview.value.executable === true &&
  typeof preview.value.previewIdentity === 'string' &&
  preview.value.previewIdentity.length > 0,
)
const canRunPreview = computed(() => canExecuteSync.value || canAcceptAsync.value)
const busy = computed(() => previewLoading.value || executing.value || jobBusy.value)
const jobActive = computed(() => Boolean(job.value && !TERMINAL_JOB_STATES.has(job.value.state)))
const jobTerminal = computed(() => Boolean(job.value && TERMINAL_JOB_STATES.has(job.value.state)))
const selectedRecordsLabel = computed(() => props.isZh
  ? `选中的 ${props.selectedRecordIds.length} 条记录`
  : `${props.selectedRecordIds.length} selected records`)
const confirmLabel = computed(() => props.isZh
  ? `我确认执行${mode.value === 'reset' ? '重置' : '回退'}。`
  : `I confirm this ${mode.value === 'reset' ? 'reset' : 'revert'}.`)
const actionLabel = computed(() => {
  if (executing.value) return canAcceptAsync.value ? l('startingJob') : l('executing')
  return canAcceptAsync.value ? l('startJob') : l('execute')
})
const resultLabel = computed(() => {
  if (!result.value) return ''
  const data = result.value
  return props.isZh
    ? `已完成：回退 ${data.revertedCount}，恢复 ${data.resurrectedCount}，删除 ${data.deletedCount}。`
    : `Completed: ${data.revertedCount} reverted, ${data.resurrectedCount} restored, ${data.deletedCount} deleted.`
})
const jobProgressPercent = computed(() => progressPercent(job.value))
const jobStateLabel = computed(() => job.value ? l(`job_${job.value.state}`) : '')
const deadlineLabel = computed(() => job.value
  ? `${l('resumeDeadline')}: ${formatTime(job.value.resumeDeadline)}`
  : '')
const jobOutcomeLabel = computed(() => {
  if (!job.value) return ''
  if (job.value.state === 'done') return l('jobDone')
  if (job.value.state === 'cancelled_zero_write') return l('jobCancelled')
  if (job.value.state === 'abandoned_partial') return l('jobPartial')
  return ''
})
const jobOutcomeClass = computed(() => job.value?.state === 'done'
  ? 'archive-recovery__state--success'
  : 'archive-recovery__state--warning')

function l(key: string): string {
  const zh: Record<string, string> = {
    title: '归档恢复', subtitle: '选择恢复点、作用域和模式，预览后再执行。', close: '关闭归档恢复', loading: '正在加载归档恢复点…',
    empty: '没有可用的归档恢复点。', loadMore: '加载更多', superseded: '已被后续归档替代', mode: '恢复模式', scope: '恢复范围',
    wholeSheet: '整张表', selectedFields: '选中记录的指定字段', fields: '字段', selectAll: '全选', clearAll: '清空', chooseField: '请至少选择一个字段。',
    preview: '生成预览', previewing: '正在生成预览…', changes: '写入变更', reverts: '回退记录', resurrections: '恢复记录',
    deletions: '删除记录', kept: '保留后建记录', drift: '架构漂移', asyncRequired: '变更量超过同步上限，将作为可恢复的后台作业执行。',
    startingJob: '正在创建作业…', startJob: '创建恢复作业', executing: '正在执行…', execute: '执行恢复', blocked: '服务器未允许执行此预览。',
    no_changes: '当前状态没有需要恢复的变更。', schema_drift: '当前架构与归档恢复点不兼容。', inbound_unprovable: '关联完整性无法证明，服务器拒绝执行。',
    async_plan_required: '需要后台恢复作业。', runtimeUnavailable: '归档恢复当前不可用。', forbidden: '没有归档恢复权限。', notFound: '恢复点或作业不存在。',
    conflict: '恢复状态已变化，请刷新后重试。', requestFailed: '归档恢复请求失败。', timeUnavailable: '时间不可用', jobTitle: '恢复作业', progress: '进度',
    resumeDeadline: '最晚继续时间', refresh: '刷新', resume: '继续作业', cancelJob: '取消作业', newRecovery: '开始新的恢复',
    job_planned: '等待执行', job_applying: '正在执行', job_paused_retryable: '已暂停，可继续', job_done: '已完成', job_abandoned_partial: '部分执行后终止', job_cancelled_zero_write: '未写入并已取消',
    jobDone: '作业已完整完成。', jobCancelled: '作业在写入前取消。', jobPartial: '作业仅完成部分写入，未发布完整恢复结果。',
  }
  const en: Record<string, string> = {
    title: 'Archive recovery', subtitle: 'Choose a recovery point, scope, and mode, then preview before running.', close: 'Close archive recovery', loading: 'Loading archive recovery points…',
    empty: 'No archive recovery points are available.', loadMore: 'Load more', superseded: 'Superseded by a newer archive', mode: 'Recovery mode', scope: 'Recovery scope',
    wholeSheet: 'Whole sheet', selectedFields: 'Chosen fields on selected records', fields: 'Fields', selectAll: 'Select all', clearAll: 'Clear', chooseField: 'Select at least one field.',
    preview: 'Preview', previewing: 'Preparing preview…', changes: 'Write changes', reverts: 'Records reverted', resurrections: 'Records restored',
    deletions: 'Records deleted', kept: 'Later records kept', drift: 'Schema drift', asyncRequired: 'This change exceeds the synchronous limit and will run as a resumable background job.',
    startingJob: 'Starting job…', startJob: 'Start recovery job', executing: 'Executing…', execute: 'Execute recovery', blocked: 'The server did not allow this preview.',
    no_changes: 'There are no changes to recover.', schema_drift: 'The current schema is incompatible with this archive point.', inbound_unprovable: 'Link integrity cannot be proven, so the server refused execution.',
    async_plan_required: 'A background recovery job is required.', runtimeUnavailable: 'Archive recovery is currently unavailable.', forbidden: 'You do not have archive recovery permission.', notFound: 'The recovery point or job was not found.',
    conflict: 'Recovery state changed. Refresh and try again.', requestFailed: 'Archive recovery request failed.', timeUnavailable: 'Time unavailable', jobTitle: 'Recovery job', progress: 'Progress',
    resumeDeadline: 'Resume deadline', refresh: 'Refresh', resume: 'Resume job', cancelJob: 'Cancel job', newRecovery: 'Start another recovery',
    job_planned: 'Queued', job_applying: 'Applying', job_paused_retryable: 'Paused and resumable', job_done: 'Completed', job_abandoned_partial: 'Stopped after partial application', job_cancelled_zero_write: 'Cancelled before writes',
    jobDone: 'The recovery job completed in full.', jobCancelled: 'The job was cancelled before any write.', jobPartial: 'Only part of the job was applied; no complete recovery result was published.',
  }
  return (props.isZh ? zh : en)[key] ?? key
}

function modeLabel(value: 'revert' | 'reset'): string {
  return props.isZh ? (value === 'revert' ? '回退' : '重置') : (value === 'revert' ? 'Revert' : 'Reset')
}

function blockedLabel(reason: RecoveryArchivePreview['blockedReason']): string {
  return reason ? l(reason) : l('blocked')
}

function coverageLabel(value: string): string {
  return props.isZh ? `${value} 条覆盖记录` : `${value} covered records`
}

function formatTime(value: string): string {
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? l('timeUnavailable') : time.toLocaleString()
}

function messageFor(error: unknown): string {
  const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  if (status === 403) return l('forbidden')
  if (status === 404) return l('notFound')
  if (status === 409) return l('conflict')
  if (
    status === 503 ||
    (typeof code === 'string' && (
      code.includes('DISABLED') || code.includes('UNAVAILABLE') || code.includes('SUBSTRATE') || code.includes('PERSISTENCE')
    ))
  ) return l('runtimeUnavailable')
  return l('requestFailed')
}

function clearPreview(): void {
  previewRequest++
  previewLoading.value = false
  preview.value = null
  previewScope.value = null
  previewError.value = null
  confirmed.value = false
  result.value = null
}

function selectEntry(generationId: string): void {
  if (job.value) return
  selectedGenerationId.value = generationId
  clearPreview()
}

function toggleField(fieldId: string): void {
  const next = new Set(selectedFieldIds.value)
  if (next.has(fieldId)) next.delete(fieldId)
  else next.add(fieldId)
  selectedFieldIds.value = next
  clearPreview()
}

function selectAllFields(): void {
  selectedFieldIds.value = new Set(props.fields.map((field) => field.id))
  clearPreview()
}

function clearAllFields(): void {
  selectedFieldIds.value = new Set()
  clearPreview()
}

function buildScope(): RecoveryArchiveScope | null {
  if (scopeKind.value === 'whole_sheet') return { kind: 'whole_sheet' }
  if (props.selectedRecordIds.length === 0) return null
  if (scopeKind.value === 'selected_records') {
    return { kind: 'selected_records', recordIds: [...props.selectedRecordIds] }
  }
  const fieldIds = props.fields.filter((field) => selectedFieldIds.value.has(field.id)).map((field) => field.id)
  if (fieldIds.length === 0) return null
  return { kind: 'selected_fields', recordIds: [...props.selectedRecordIds], fieldIds }
}

async function loadCatalog(reset: boolean): Promise<void> {
  const sheetId = props.sheetId
  if (!sheetId || catalogLoading.value || job.value || (!reset && !nextCursor.value)) return
  const request = ++catalogRequest
  catalogLoading.value = true
  catalogError.value = null
  if (reset) {
    entries.value = []
    nextCursor.value = null
    selectedGenerationId.value = null
    clearPreview()
  }
  try {
    const page = await props.listCatalog(sheetId, reset ? { limit: 50 } : { cursor: nextCursor.value ?? undefined, limit: 50 })
    if (request !== catalogRequest || sheetId !== props.sheetId) return
    entries.value = reset ? page.entries : [...entries.value, ...page.entries]
    nextCursor.value = page.nextCursor
  } catch (error) {
    if (request === catalogRequest) catalogError.value = messageFor(error)
  } finally {
    if (request === catalogRequest) catalogLoading.value = false
  }
}

async function requestPreview(): Promise<void> {
  const generationId = selectedGenerationId.value
  const sheetId = props.sheetId
  const scope = buildScope()
  if (!generationId || !sheetId || !scope || previewLoading.value || executing.value || job.value) return
  const request = ++previewRequest
  previewLoading.value = true
  previewError.value = null
  preview.value = null
  previewScope.value = null
  confirmed.value = false
  result.value = null
  try {
    const next = await props.previewArchive(sheetId, { generationId, mode: mode.value, scope })
    if (request !== previewRequest || generationId !== selectedGenerationId.value || sheetId !== props.sheetId) return
    preview.value = next
    previewScope.value = scope
  } catch (error) {
    if (request === previewRequest) previewError.value = messageFor(error)
  } finally {
    if (request === previewRequest) previewLoading.value = false
  }
}

function runPreview(): void {
  if (canAcceptAsync.value) void acceptPreviewJob()
  else void executePreview()
}

async function executePreview(): Promise<void> {
  const current = preview.value
  const scope = previewScope.value
  const sheetId = props.sheetId
  if (!current || !scope || !canExecuteSync.value || !confirmed.value || !sheetId || executing.value) return
  const previewIdentity = current.previewIdentity
  if (!previewIdentity) return
  const request = ++executeRequest
  executing.value = true
  previewError.value = null
  result.value = null
  try {
    const next = await props.executeArchive(sheetId, { previewIdentity, scope })
    if (request !== executeRequest || sheetId !== props.sheetId) return
    result.value = next
    emit('executed')
    confirmed.value = false
  } catch (error) {
    if (request === executeRequest && sheetId === props.sheetId) previewError.value = messageFor(error)
  } finally {
    if (request === executeRequest && sheetId === props.sheetId) executing.value = false
  }
}

async function acceptPreviewJob(): Promise<void> {
  const current = preview.value
  const sheetId = props.sheetId
  if (!current || !canAcceptAsync.value || !confirmed.value || !sheetId || executing.value) return
  const previewIdentity = current.previewIdentity
  if (!previewIdentity) return
  executing.value = true
  previewError.value = null
  try {
    applyJobSnapshot(sheetId, await props.acceptJob(sheetId, previewIdentity))
    if (sheetId === props.sheetId) confirmed.value = false
  } catch (error) {
    if (sheetId === props.sheetId) previewError.value = messageFor(error)
  } finally {
    if (sheetId === props.sheetId) executing.value = false
  }
}

async function refreshCurrentJob(background: boolean): Promise<void> {
  const current = job.value
  const sheetId = props.sheetId
  if (!current || !sheetId || jobBusy.value) return
  const request = ++jobRequest
  if (!background) jobBusy.value = true
  jobError.value = null
  clearJobPoll()
  try {
    const next = await props.readJob(sheetId, current.jobId)
    if (request !== jobRequest || sheetId !== props.sheetId || current.jobId !== job.value?.jobId) return
    applyJobSnapshot(sheetId, next)
  } catch (error) {
    if (request === jobRequest && sheetId === props.sheetId) {
      jobError.value = messageFor(error)
      scheduleJobPoll()
    }
  } finally {
    if (request === jobRequest) jobBusy.value = false
  }
}

async function resumeCurrentJob(): Promise<void> {
  const current = job.value
  const sheetId = props.sheetId
  if (!current || current.state !== 'paused_retryable' || !sheetId || jobBusy.value) return
  const request = ++jobRequest
  jobBusy.value = true
  jobError.value = null
  clearJobPoll()
  try {
    const next = await props.resumeJob(sheetId, current.jobId)
    if (request !== jobRequest || sheetId !== props.sheetId || current.jobId !== job.value?.jobId) return
    applyJobSnapshot(sheetId, next)
  } catch (error) {
    if (request === jobRequest && sheetId === props.sheetId) {
      jobError.value = messageFor(error)
      scheduleJobPoll()
    }
  } finally {
    if (request === jobRequest) jobBusy.value = false
  }
}

async function cancelCurrentJob(): Promise<void> {
  const current = job.value
  const sheetId = props.sheetId
  if (!current || TERMINAL_JOB_STATES.has(current.state) || !sheetId || jobBusy.value) return
  const request = ++jobRequest
  jobBusy.value = true
  jobError.value = null
  clearJobPoll()
  try {
    const next = await props.cancelJob(sheetId, current.jobId)
    if (request !== jobRequest || sheetId !== props.sheetId || current.jobId !== job.value?.jobId) return
    applyJobSnapshot(sheetId, next)
  } catch (error) {
    if (request === jobRequest && sheetId === props.sheetId) {
      jobError.value = messageFor(error)
      scheduleJobPoll()
    }
  } finally {
    if (request === jobRequest) jobBusy.value = false
  }
}

function applyJobSnapshot(sheetId: string, next: RecoveryArchiveJobSnapshot): void {
  const previous = jobsBySheet.get(sheetId)
  jobsBySheet.set(sheetId, next)
  if (sheetId !== props.sheetId) return
  job.value = next
  jobError.value = null
  if (next.state === 'done' && previous?.state !== 'done') emit('executed')
  if (
    next.state === 'abandoned_partial' && previous?.state !== 'abandoned_partial' &&
    decimalCount(next.completedCount) > 0n
  ) emit('refresh')
  scheduleJobPoll()
}

function scheduleJobPoll(): void {
  clearJobPoll()
  if (!props.visible || !jobActive.value) return
  jobPollTimer = setTimeout(() => { void refreshCurrentJob(true) }, JOB_POLL_MS)
}

function clearJobPoll(): void {
  if (jobPollTimer !== null) clearTimeout(jobPollTimer)
  jobPollTimer = null
}

function clearJob(): void {
  if (!jobTerminal.value) return
  jobRequest++
  clearJobPoll()
  jobsBySheet.delete(props.sheetId)
  job.value = null
  jobError.value = null
  void loadCatalog(true)
}

function resetForSheet(): void {
  catalogRequest++
  previewRequest++
  executeRequest++
  jobRequest++
  clearJobPoll()
  entries.value = []
  nextCursor.value = null
  selectedGenerationId.value = null
  mode.value = 'revert'
  scopeKind.value = 'whole_sheet'
  selectedFieldIds.value = new Set(props.fields.map((field) => field.id))
  catalogLoading.value = false
  catalogError.value = null
  clearPreview()
  executing.value = false
  job.value = jobsBySheet.get(props.sheetId) ?? null
  jobBusy.value = false
  jobError.value = null
}

function progressPercent(snapshot: RecoveryArchiveJobSnapshot | null): number {
  if (!snapshot) return 0
  const total = decimalCount(snapshot.totalCount)
  const completed = decimalCount(snapshot.completedCount)
  if (total <= 0n) return 0
  const bounded = completed > total ? total : completed
  return Number((bounded * 10_000n) / total) / 100
}

function decimalCount(value: string): bigint {
  return /^(?:0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : 0n
}

function close(): void {
  clearJobPoll()
  emit('close')
}

watch(scopeKind, () => clearPreview())
watch(
  () => props.selectedRecordIds.join('\u0000'),
  () => {
    if (scopeKind.value !== 'whole_sheet') clearPreview()
  },
)
watch(
  () => props.fields.map((field) => field.id).join('\u0000'),
  () => {
    const allowed = new Set(props.fields.map((field) => field.id))
    selectedFieldIds.value = new Set([...selectedFieldIds.value].filter((fieldId) => allowed.has(fieldId)))
    if (scopeKind.value === 'selected_fields') clearPreview()
  },
)
watch(
  () => [props.visible, props.sheetId] as const,
  ([visible, sheetId], previous) => {
    if (!previous || sheetId !== previous[1]) resetForSheet()
    if (!visible) {
      clearJobPoll()
      return
    }
    if (job.value) void refreshCurrentJob(true)
    else void loadCatalog(true)
  },
  { immediate: true },
)

onBeforeUnmount(clearJobPoll)
</script>

<style scoped>
.archive-recovery-overlay { position: fixed; inset: 0; z-index: 2100; display: grid; place-items: center; padding: 24px; background: rgb(15 23 42 / 42%); }
.archive-recovery-modal { width: min(780px, 100%); max-height: min(780px, calc(100vh - 48px)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--el-border-color); border-radius: 8px; background: var(--el-bg-color); box-shadow: 0 18px 48px rgb(15 23 42 / 28%); }
.archive-recovery__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 16px 18px; border-bottom: 1px solid var(--el-border-color-lighter); }
.archive-recovery__header strong, .archive-recovery__header span { display: block; }
.archive-recovery__header span { margin-top: 4px; color: var(--el-text-color-secondary); font-size: 13px; }
.archive-recovery__body { overflow: auto; padding: 16px 18px 20px; }
.archive-recovery__state { margin: 0; color: var(--el-text-color-secondary); font-size: 14px; line-height: 1.5; }
.archive-recovery__state--error { color: var(--el-color-danger); }
.archive-recovery__state--warning { color: var(--el-color-warning-dark-2); }
.archive-recovery__state--success { margin-top: 12px; color: var(--el-color-success); }
.archive-recovery__catalog { display: grid; gap: 6px; }
.archive-recovery__entry { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 10px; align-items: center; width: 100%; min-height: 44px; padding: 10px 12px; border: 1px solid var(--el-border-color-lighter); border-radius: 6px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.archive-recovery__entry:hover, .archive-recovery__entry--selected { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.archive-recovery__entry:disabled { cursor: not-allowed; opacity: .55; }
.archive-recovery__entry-time { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.archive-recovery__entry-meta, .archive-recovery__entry-state { color: var(--el-text-color-secondary); font-size: 12px; white-space: nowrap; }
.archive-recovery__entry-state { color: var(--el-color-warning-dark-2); }
.archive-recovery__load-more { margin-top: 10px; border: 0; background: transparent; color: var(--el-color-primary); cursor: pointer; }
.archive-recovery__preview, .archive-recovery__job { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--el-border-color-lighter); }
.archive-recovery__scope { display: grid; grid-template-columns: auto repeat(3, minmax(0, 1fr)); gap: 10px; align-items: center; }
.archive-recovery__scope-title { color: var(--el-text-color-secondary); font-size: 12px; }
.archive-recovery__scope-option { display: flex; gap: 6px; align-items: center; font-size: 13px; cursor: pointer; }
.archive-recovery__scope-option--disabled { color: var(--el-text-color-disabled); cursor: not-allowed; }
.archive-recovery__fields { max-height: 180px; overflow: auto; margin-top: 10px; padding: 8px 10px; border: 1px solid var(--el-border-color-lighter); border-radius: 6px; }
.archive-recovery__fields-head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 6px; color: var(--el-text-color-secondary); font-size: 12px; }
.archive-recovery__fields-head button { margin-left: 8px; padding: 0; border: 0; background: transparent; color: var(--el-color-primary); cursor: pointer; }
.archive-recovery__field-option { display: flex; gap: 8px; align-items: center; min-height: 30px; font-size: 13px; }
.archive-recovery__field-option span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.archive-recovery__mode { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 14px; }
.archive-recovery__mode-button, .archive-recovery__preview-button, .archive-recovery__execute, .archive-recovery__job-actions button { min-height: 32px; border: 1px solid var(--el-border-color); border-radius: 4px; background: var(--el-fill-color-blank); color: inherit; cursor: pointer; }
.archive-recovery__mode-button { padding: 0 12px; }
.archive-recovery__mode-button--active { border-color: var(--el-color-primary); color: var(--el-color-primary); }
.archive-recovery__preview-button { margin-left: auto; padding: 0 12px; border-color: var(--el-color-primary); color: var(--el-color-primary); }
.archive-recovery__summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 14px 0; }
.archive-recovery__summary div { padding: 8px 10px; border-left: 2px solid var(--el-border-color); }
.archive-recovery__summary dt { color: var(--el-text-color-secondary); font-size: 12px; }
.archive-recovery__summary dd { margin: 3px 0 0; font-variant-numeric: tabular-nums; }
.archive-recovery__confirm { display: flex; gap: 8px; align-items: center; margin-top: 14px; font-size: 14px; }
.archive-recovery__execute { margin-top: 10px; padding: 0 12px; border-color: var(--el-color-danger); color: var(--el-color-danger); }
.archive-recovery__job-head, .archive-recovery__job-counts { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.archive-recovery__job-head span, .archive-recovery__job-counts { color: var(--el-text-color-secondary); font-size: 13px; }
.archive-recovery__job-counts { margin-top: 14px; }
.archive-recovery__progress { height: 8px; margin: 7px 0 12px; overflow: hidden; border-radius: 4px; background: var(--el-fill-color); }
.archive-recovery__progress span { display: block; height: 100%; background: var(--el-color-success); transition: width .2s ease; }
.archive-recovery__job-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.archive-recovery__job-actions button { padding: 0 12px; }
.archive-recovery__job-actions .archive-recovery__job-cancel { border-color: var(--el-color-danger); color: var(--el-color-danger); }
.archive-recovery__mode-button:disabled, .archive-recovery__preview-button:disabled, .archive-recovery__execute:disabled, .archive-recovery__load-more:disabled, .archive-recovery__job-actions button:disabled, .archive-recovery__fields-head button:disabled { cursor: not-allowed; opacity: .55; }

@media (max-width: 700px) {
  .archive-recovery-overlay { padding: 12px; }
  .archive-recovery__entry { grid-template-columns: 1fr auto; }
  .archive-recovery__entry-state { grid-column: 1 / -1; }
  .archive-recovery__scope { grid-template-columns: 1fr; }
  .archive-recovery__summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .archive-recovery__preview-button { margin-left: 0; }
}
</style>
