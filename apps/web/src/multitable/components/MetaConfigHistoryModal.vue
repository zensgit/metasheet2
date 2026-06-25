<template>
  <Teleport to="body">
    <div v-if="visible" class="cfg-history-overlay" data-test="config-history" @click.self="$emit('close')">
      <div class="cfg-history-modal" role="dialog" :aria-label="l('record.configHistoryTitle')">
        <div class="cfg-history__header">
          <strong>{{ l('record.configHistoryTitle') }}</strong>
          <button class="cfg-history__close" :aria-label="l('record.configHistoryClose')" @click="$emit('close')">&times;</button>
        </div>

        <!-- Entity-type filter (server still gates; this only narrows within what the server returned). -->
        <div class="cfg-history__filters" data-test="config-history-filters">
          <button
            v-for="opt in FILTERS"
            :key="opt"
            type="button"
            class="cfg-history__chip"
            :class="{ 'cfg-history__chip--active': entityType === opt }"
            :data-test="`config-history-filter-${opt || 'all'}`"
            @click="$emit('filter-change', opt)"
          >{{ filterLabel(opt) }}</button>
        </div>

        <div class="cfg-history__body">
          <p v-if="loading" class="cfg-history__hint" data-test="config-history-loading">{{ l('record.configHistoryLoading') }}</p>
          <p v-else-if="items.length === 0" class="cfg-history__hint" data-test="config-history-empty">{{ l('record.configHistoryEmpty') }}</p>
          <ul v-else class="cfg-history__list" data-test="config-history-list">
            <li v-for="rev in items" :key="rev.id" class="cfg-history__row" :data-entity-type="rev.entityType">
              <div class="cfg-history__row-head">
                <span class="cfg-history__action" :class="`cfg-history__action--${rev.action}`">{{ actionLabel(rev.action) }}</span>
                <span class="cfg-history__entity">{{ entityLabel(rev.entityType) }}</span>
                <span class="cfg-history__entity-id">{{ recordLabelOf(rev.entityId) }}</span>
                <button
                  v-if="canRevert(rev)"
                  type="button"
                  class="cfg-history__revert"
                  data-test="config-history-revert"
                  @click="openRevert(rev)"
                >{{ l('record.configRestoreAction') }}</button>
              </div>
              <ul v-if="rev.action === 'update' && rev.changedKeys.length" class="cfg-history__changes">
                <li v-for="k in rev.changedKeys" :key="k" class="cfg-history__change">
                  <span class="cfg-history__key">{{ k }}</span>
                  <span class="cfg-history__before">{{ display(rev.before?.[k]) }}</span>
                  <span class="cfg-history__arrow">→</span>
                  <span class="cfg-history__after">{{ display(rev.after?.[k]) }}</span>
                </li>
              </ul>
              <div class="cfg-history__meta">
                <span v-if="rev.actorId">{{ l('record.configHistoryBy') }} {{ rev.actorId }}</span>
                <span class="cfg-history__time">{{ rev.createdAt }}</span>
              </div>
            </li>
          </ul>
        </div>

        <!-- T9-W revert confirm. The safe/gated/drift decision is the SERVER's (the preview) — rendered as-is. -->
        <div v-if="revert.visible" class="cfg-restore-overlay" data-test="config-restore-confirm" @click.self="cancelRevert">
          <div class="cfg-restore-panel" role="dialog" :aria-label="l('record.configRestoreTitle')">
            <strong>{{ l('record.configRestoreTitle') }}</strong>
            <p v-if="revert.loading" class="cfg-history__hint" data-test="config-restore-loading">{{ l('record.configHistoryLoading') }}</p>
            <p v-else-if="revert.error" class="cfg-restore-error" data-test="config-restore-error">{{ revert.error }}</p>
            <template v-else-if="revert.preview">
              <p v-if="revert.preview.opKind === 'gated'" class="cfg-restore-gated" data-test="config-restore-gated">
                {{ revert.preview.gatedReason || l('record.configRestoreGated') }}
              </p>
              <template v-else>
                <p v-if="revert.preview.driftConflict" class="cfg-restore-drift" data-test="config-restore-drift">{{ l('record.configRestoreDrift') }}</p>
                <p class="cfg-restore-summary">{{ l('record.configRestoreWillRevert') }}</p>
                <ul class="cfg-restore-changes" data-test="config-restore-changes">
                  <li v-for="k in revert.preview.changedKeys" :key="k" class="cfg-history__change">
                    <span class="cfg-history__key">{{ k }}</span>
                    <span class="cfg-history__before">{{ display(revert.preview.current[k]) }}</span>
                    <span class="cfg-history__arrow">→</span>
                    <span class="cfg-history__after">{{ display(revert.preview.target[k]) }}</span>
                  </li>
                </ul>
              </template>
            </template>
            <div class="cfg-restore-actions">
              <button type="button" data-test="config-restore-cancel" @click="cancelRevert">{{ l('record.configRestoreCancel') }}</button>
              <button
                v-if="revert.preview && revert.preview.opKind === 'safe'"
                type="button"
                data-test="config-restore-confirm-btn"
                :disabled="revert.preview.driftConflict || revert.executing"
                @click="confirmRevert"
              >{{ l('record.configRestoreConfirm') }}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref } from 'vue'

import type { MetaConfigRevision, ConfigRestorePreview } from '../api/client'
import { recordLabel, type MetaRecordLabelKey } from '../utils/meta-record-labels'

const props = defineProps<{
  visible: boolean
  items: MetaConfigRevision[]
  loading: boolean
  /** current entity-type filter ('' = all). */
  entityType: string
  /** resolve an entity id to a display label (the workbench owns the field/view name map). */
  recordLabelOf: (entityId: string) => string
  isZh: boolean
  /** T9-W: when provided, an update row gets a Revert action wired through these (the workbench owns the client). */
  previewRevert?: (revisionId: string) => Promise<ConfigRestorePreview>
  executeRevert?: (revisionId: string, previewToken: string) => Promise<void>
}>()

const emit = defineEmits<{ (e: 'close'): void; (e: 'filter-change', entityType: string): void; (e: 'reverted'): void }>()

const FILTERS = ['', 'field', 'view', 'permission', 'sheet_config'] as const
const l = (key: MetaRecordLabelKey): string => recordLabel(key, props.isZh)
const ENTITY_KEY: Record<string, MetaRecordLabelKey> = {
  field: 'record.configHistoryEntityField', view: 'record.configHistoryEntityView',
  permission: 'record.configHistoryEntityPermission', sheet_config: 'record.configHistoryEntitySheetConfig',
}
const ACTION_KEY: Record<string, MetaRecordLabelKey> = {
  create: 'record.configHistoryActionCreate', update: 'record.configHistoryActionUpdate', delete: 'record.configHistoryActionDelete',
}
const filterLabel = (opt: string): string => (opt === '' ? l('record.configHistoryFilterAll') : entityLabel(opt))
const entityLabel = (t: string): string => (ENTITY_KEY[t] ? l(ENTITY_KEY[t]) : t)
const actionLabel = (a: string): string => (ACTION_KEY[a] ? l(ACTION_KEY[a]) : a)
// Render a config value (a view filter/sort/group, a permission grant, a hidden-field list, a scalar) as a compact
// human summary instead of a raw JSON blob — objects become `k: v` pairs, primitive arrays join, and anything deeper
// than two levels falls back to JSON (safe). These are CONFIG values (never record data), so no value-masking is
// needed. No translatable strings are introduced (the separators/markers are structural).
function summarizeConfigValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return '∅'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const allPrimitive = value.every((v) => v === null || typeof v !== 'object')
    return allPrimitive ? value.map((v) => summarizeConfigValue(v, depth + 1)).join('; ') : `[${value.length}]`
  }
  if (typeof value === 'object') {
    if (depth >= 2) return JSON.stringify(value) // deep nesting → safe JSON fallback
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return '{}'
    return entries.map(([k, v]) => `${k}: ${summarizeConfigValue(v, depth + 1)}`).join(', ')
  }
  return JSON.stringify(value)
}
function display(value: unknown): string {
  return summarizeConfigValue(value)
}

// --- T9-W revert flow (the gate stays server-side; this only shows the server's preview + confirms) ---
interface RevertState { visible: boolean; loading: boolean; executing: boolean; error: string; preview: ConfigRestorePreview | null }
const revert = ref<RevertState>({ visible: false, loading: false, executing: false, error: '', preview: null })
const canRevert = (rev: MetaConfigRevision): boolean => typeof props.previewRevert === 'function' && rev.action === 'update'

async function openRevert(rev: MetaConfigRevision): Promise<void> {
  if (!props.previewRevert) return
  revert.value = { visible: true, loading: true, executing: false, error: '', preview: null }
  try {
    const preview = await props.previewRevert(rev.id)
    revert.value = { visible: true, loading: false, executing: false, error: '', preview }
  } catch (e) {
    revert.value = { visible: true, loading: false, executing: false, error: (e as Error)?.message ?? l('record.configRestoreError'), preview: null }
  }
}
async function confirmRevert(): Promise<void> {
  const preview = revert.value.preview
  if (!preview || !props.executeRevert) return
  revert.value = { ...revert.value, executing: true, error: '' }
  try {
    await props.executeRevert(preview.revisionId, preview.previewToken)
    revert.value = { visible: false, loading: false, executing: false, error: '', preview: null }
    emit('reverted')
  } catch (e) {
    revert.value = { ...revert.value, executing: false, error: (e as Error)?.message ?? l('record.configRestoreError') }
  }
}
function cancelRevert(): void { revert.value = { visible: false, loading: false, executing: false, error: '', preview: null } }
</script>

<style scoped>
.cfg-history-overlay { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.cfg-history-modal { position: relative; background: var(--surface, #fff); border-radius: 10px; width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 64px); display: flex; flex-direction: column; box-shadow: 0 12px 40px rgba(15, 23, 42, 0.2); }
.cfg-history__header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--border, #e2e8f0); }
.cfg-history__close { border: none; background: none; font-size: 20px; line-height: 1; cursor: pointer; color: var(--text-secondary, #64748b); }
.cfg-history__filters { display: flex; gap: 6px; flex-wrap: wrap; padding: 10px 16px 0; }
.cfg-history__chip { padding: 3px 10px; border-radius: 999px; border: 1px solid var(--border, #cbd5e1); background: var(--surface, #fff); cursor: pointer; font-size: 12px; }
.cfg-history__chip--active { background: var(--primary, #2563eb); color: #fff; border-color: var(--primary, #2563eb); }
.cfg-history__body { padding: 12px 16px 16px; overflow-y: auto; }
.cfg-history__hint { margin: 0; color: var(--text-secondary, #64748b); }
.cfg-history__list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 10px; }
.cfg-history__row { padding: 8px 10px; background: var(--surface-muted, #f1f5f9); border-radius: 8px; }
.cfg-history__row-head { display: flex; gap: 8px; align-items: baseline; }
.cfg-history__action { font-size: 11px; font-weight: 600; text-transform: uppercase; }
.cfg-history__action--create { color: var(--success, #15803d); }
.cfg-history__action--update { color: var(--primary, #2563eb); }
.cfg-history__action--delete { color: var(--danger, #b91c1c); }
.cfg-history__entity { font-size: 12px; color: var(--text-secondary, #64748b); }
.cfg-history__entity-id { font-weight: 600; word-break: break-word; }
.cfg-history__revert { margin-left: auto; padding: 1px 8px; border-radius: 6px; border: 1px solid var(--border, #cbd5e1); background: var(--surface, #fff); cursor: pointer; font-size: 11px; }
.cfg-history__changes { margin: 6px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 3px; }
.cfg-history__change { display: flex; gap: 6px; align-items: baseline; font-size: 12px; }
.cfg-history__key { font-weight: 600; }
.cfg-history__before { color: var(--text-secondary, #64748b); text-decoration: line-through; word-break: break-word; }
.cfg-history__arrow { color: var(--text-secondary, #64748b); }
.cfg-history__after { word-break: break-word; }
.cfg-history__meta { display: flex; gap: 10px; margin-top: 6px; font-size: 11px; color: var(--text-secondary, #64748b); }
.cfg-history__time { margin-left: auto; }
.cfg-restore-overlay { position: absolute; inset: 0; background: rgba(15, 23, 42, 0.35); display: flex; align-items: center; justify-content: center; border-radius: 10px; }
.cfg-restore-panel { background: var(--surface, #fff); border-radius: 8px; padding: 14px 16px; width: min(420px, calc(100% - 32px)); box-shadow: 0 8px 28px rgba(15, 23, 42, 0.2); display: flex; flex-direction: column; gap: 8px; }
.cfg-restore-error { margin: 0; color: var(--danger, #b91c1c); font-size: 13px; }
.cfg-restore-gated { margin: 0; color: var(--text-secondary, #64748b); font-size: 13px; }
.cfg-restore-drift { margin: 0; color: var(--warning, #b45309); font-size: 12px; }
.cfg-restore-summary { margin: 0; font-size: 12px; color: var(--text-secondary, #64748b); }
.cfg-restore-changes { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 3px; }
.cfg-restore-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
.cfg-restore-actions button { padding: 4px 12px; border-radius: 6px; border: 1px solid var(--border, #cbd5e1); background: var(--surface, #fff); cursor: pointer; font-size: 13px; }
.cfg-restore-actions button[disabled] { opacity: 0.5; cursor: not-allowed; }
</style>
