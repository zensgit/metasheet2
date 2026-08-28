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
            :disabled="catalogLoading"
            @click="loadCatalog(false)"
          >{{ l('loadMore') }}</button>

          <div v-if="selectedEntry" class="archive-recovery__preview" data-test="archive-recovery-preview-area">
            <div class="archive-recovery__mode" role="group" :aria-label="l('mode')">
              <button
                v-for="candidate in MODES"
                :key="candidate"
                type="button"
                class="archive-recovery__mode-button"
                :class="{ 'archive-recovery__mode-button--active': mode === candidate }"
                :data-test="`archive-recovery-mode-${candidate}`"
                :disabled="previewLoading || executing"
                @click="mode = candidate; clearPreview()"
              >{{ modeLabel(candidate) }}</button>
              <button
                type="button"
                class="archive-recovery__preview-button"
                data-test="archive-recovery-request-preview"
                :disabled="previewLoading || executing"
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
              <p v-else-if="!canExecute" class="archive-recovery__state archive-recovery__state--warning" data-test="archive-recovery-blocked">{{ blockedLabel(preview.blockedReason) }}</p>

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
                  @click="executePreview"
                >{{ executing ? l('executing') : l('execute') }}</button>
              </template>
            </template>
            <p v-if="result" class="archive-recovery__state archive-recovery__state--success" data-test="archive-recovery-result">{{ resultLabel }}</p>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type {
  RecoveryArchiveCatalogEntry,
  RecoveryArchiveCatalogPage,
  RecoveryArchiveExecuteResult,
  RecoveryArchivePreview,
  RecoveryArchiveScope,
} from '../api/client'
import { MtIconButton } from '../ui'

const MODES = ['revert', 'reset'] as const
const WHOLE_SHEET_SCOPE: RecoveryArchiveScope = { kind: 'whole_sheet' }

const props = defineProps<{
  visible: boolean
  sheetId: string
  isZh: boolean
  listCatalog: (sheetId: string, params?: { cursor?: string; limit?: number }) => Promise<RecoveryArchiveCatalogPage>
  previewArchive: (sheetId: string, input: { generationId: string; mode: 'revert' | 'reset'; scope: RecoveryArchiveScope }) => Promise<RecoveryArchivePreview>
  executeArchive: (sheetId: string, input: { previewIdentity: string; scope: RecoveryArchiveScope }) => Promise<RecoveryArchiveExecuteResult>
}>()

const emit = defineEmits<{ (e: 'close'): void; (e: 'executed'): void }>()

const entries = ref<RecoveryArchiveCatalogEntry[]>([])
const nextCursor = ref<string | null>(null)
const selectedGenerationId = ref<string | null>(null)
const mode = ref<'revert' | 'reset'>('revert')
const catalogLoading = ref(false)
const catalogError = ref<string | null>(null)
const previewLoading = ref(false)
const previewError = ref<string | null>(null)
const preview = ref<RecoveryArchivePreview | null>(null)
const confirmed = ref(false)
const executing = ref(false)
const result = ref<RecoveryArchiveExecuteResult | null>(null)
let catalogRequest = 0
let previewRequest = 0

const selectedEntry = computed(() => entries.value.find((entry) => entry.generationId === selectedGenerationId.value) ?? null)
const canExecute = computed(() =>
  preview.value?.executionKind === 'sync' &&
  preview.value.executable === true &&
  typeof preview.value.previewIdentity === 'string' &&
  preview.value.previewIdentity.length > 0,
)
const confirmLabel = computed(() => props.isZh
  ? `我确认执行${mode.value === 'reset' ? '重置' : '回退'}。`
  : `I confirm this ${mode.value === 'reset' ? 'reset' : 'revert'}.`)
const resultLabel = computed(() => {
  if (!result.value) return ''
  const data = result.value
  return props.isZh
    ? `已完成：回退 ${data.revertedCount}，恢复 ${data.resurrectedCount}，删除 ${data.deletedCount}。`
    : `Completed: ${data.revertedCount} reverted, ${data.resurrectedCount} restored, ${data.deletedCount} deleted.`
})

function l(key: string): string {
  const zh: Record<string, string> = {
    title: '归档恢复', subtitle: '选择归档恢复点并生成整表预览。', close: '关闭归档恢复', loading: '正在加载归档恢复点…',
    empty: '没有可用的归档恢复点。', loadMore: '加载更多', superseded: '已被后续归档替代', mode: '恢复模式',
    preview: '生成预览', previewing: '正在生成预览…', changes: '写入变更', reverts: '回退记录', resurrections: '恢复记录',
    deletions: '删除记录', kept: '保留后建记录', drift: '架构漂移', asyncRequired: '此预览需要受控异步作业；当前界面不会提交作业。',
    executing: '正在执行…', execute: '执行恢复', blocked: '服务器未允许执行此预览。', no_changes: '当前状态没有需要恢复的变更。',
    schema_drift: '当前架构与归档恢复点不兼容。', inbound_unprovable: '关联完整性无法证明，服务器拒绝执行。',
  }
  const en: Record<string, string> = {
    title: 'Archive recovery', subtitle: 'Select an archive recovery point and prepare a whole-sheet preview.', close: 'Close archive recovery', loading: 'Loading archive recovery points…',
    empty: 'No archive recovery points are available.', loadMore: 'Load more', superseded: 'Superseded by a newer archive', mode: 'Recovery mode',
    preview: 'Preview', previewing: 'Preparing preview…', changes: 'Write changes', reverts: 'Records reverted', resurrections: 'Records restored',
    deletions: 'Records deleted', kept: 'Later records kept', drift: 'Schema drift', asyncRequired: 'This preview requires a controlled asynchronous job. This screen will not submit one.',
    executing: 'Executing…', execute: 'Execute recovery', blocked: 'The server did not allow this preview.', no_changes: 'There are no changes to recover.',
    schema_drift: 'The current schema is incompatible with this archive point.', inbound_unprovable: 'Link integrity cannot be proven, so the server refused execution.',
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
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString()
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : l('blocked')
}

function clearPreview(): void {
  previewRequest++
  previewLoading.value = false
  preview.value = null
  previewError.value = null
  confirmed.value = false
  result.value = null
}

function selectEntry(generationId: string): void {
  selectedGenerationId.value = generationId
  clearPreview()
}

async function loadCatalog(reset: boolean): Promise<void> {
  const sheetId = props.sheetId
  if (!sheetId || catalogLoading.value || (!reset && !nextCursor.value)) return
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
  if (!generationId || !sheetId || previewLoading.value || executing.value) return
  const request = ++previewRequest
  previewLoading.value = true
  previewError.value = null
  preview.value = null
  confirmed.value = false
  result.value = null
  try {
    const next = await props.previewArchive(sheetId, { generationId, mode: mode.value, scope: WHOLE_SHEET_SCOPE })
    if (request !== previewRequest || generationId !== selectedGenerationId.value || sheetId !== props.sheetId) return
    preview.value = next
  } catch (error) {
    if (request === previewRequest) previewError.value = messageFor(error)
  } finally {
    if (request === previewRequest) previewLoading.value = false
  }
}

async function executePreview(): Promise<void> {
  const current = preview.value
  const sheetId = props.sheetId
  if (!current || !canExecute.value || !confirmed.value || !sheetId || executing.value) return
  const previewIdentity = current.previewIdentity
  if (!previewIdentity) return
  executing.value = true
  previewError.value = null
  result.value = null
  try {
    result.value = await props.executeArchive(sheetId, { previewIdentity, scope: WHOLE_SHEET_SCOPE })
    emit('executed')
    confirmed.value = false
  } catch (error) {
    previewError.value = messageFor(error)
  } finally {
    executing.value = false
  }
}

function close(): void {
  emit('close')
}

watch(
  () => [props.visible, props.sheetId] as const,
  ([visible]) => {
    if (visible) void loadCatalog(true)
  },
  { immediate: true },
)
</script>

<style scoped>
.archive-recovery-overlay { position: fixed; inset: 0; z-index: 2100; display: grid; place-items: center; padding: 24px; background: rgb(15 23 42 / 42%); }
.archive-recovery-modal { width: min(760px, 100%); max-height: min(760px, calc(100vh - 48px)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--el-border-color); border-radius: 8px; background: var(--el-bg-color); box-shadow: 0 18px 48px rgb(15 23 42 / 28%); }
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
.archive-recovery__entry-time { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.archive-recovery__entry-meta, .archive-recovery__entry-state { color: var(--el-text-color-secondary); font-size: 12px; white-space: nowrap; }
.archive-recovery__entry-state { color: var(--el-color-warning-dark-2); }
.archive-recovery__load-more { margin-top: 10px; border: 0; background: transparent; color: var(--el-color-primary); cursor: pointer; }
.archive-recovery__preview { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--el-border-color-lighter); }
.archive-recovery__mode { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.archive-recovery__mode-button, .archive-recovery__preview-button, .archive-recovery__execute { min-height: 32px; border: 1px solid var(--el-border-color); border-radius: 4px; background: var(--el-fill-color-blank); color: inherit; cursor: pointer; }
.archive-recovery__mode-button { padding: 0 12px; }
.archive-recovery__mode-button--active { border-color: var(--el-color-primary); color: var(--el-color-primary); }
.archive-recovery__preview-button { margin-left: auto; padding: 0 12px; border-color: var(--el-color-primary); color: var(--el-color-primary); }
.archive-recovery__summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 14px 0; }
.archive-recovery__summary div { padding: 8px 10px; border-left: 2px solid var(--el-border-color); }
.archive-recovery__summary dt { color: var(--el-text-color-secondary); font-size: 12px; }
.archive-recovery__summary dd { margin: 3px 0 0; font-variant-numeric: tabular-nums; }
.archive-recovery__confirm { display: flex; gap: 8px; align-items: center; margin-top: 14px; font-size: 14px; }
.archive-recovery__execute { margin-top: 10px; padding: 0 12px; border-color: var(--el-color-danger); color: var(--el-color-danger); }
.archive-recovery__mode-button:disabled, .archive-recovery__preview-button:disabled, .archive-recovery__execute:disabled, .archive-recovery__load-more:disabled { cursor: not-allowed; opacity: .55; }
@media (max-width: 600px) { .archive-recovery-overlay { padding: 12px; } .archive-recovery__entry { grid-template-columns: 1fr auto; } .archive-recovery__entry-state { grid-column: 1 / -1; } .archive-recovery__summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } .archive-recovery__preview-button { margin-left: 0; } }
</style>
