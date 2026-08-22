// Record-inspector 数据来源 / Provenance section string table.
//
// Own module per the T3B2/T3B3 per-surface convention (meta-comment-labels.ts, meta-attachment-
// labels.ts, …): EN + ZH both explicit, components read `useLocale().isZh` and call the accessors
// below. See meta-record-labels.ts for the convention this follows.
//
// The event-type / run-status / run-mode vocabularies mirror the frozen backend enums
// (packages/openapi/src/base.yml `ProvenanceEventType`; plugins/plugin-integration-core/
// lib/pipelines.cjs VALID_RUN_STATUSES / VALID_RUN_MODES). Unknown wire values fall back to the raw
// string so a backend-added member degrades to its code instead of disappearing.

export type MetaRecordProvenanceLabelKey =
  | 'provenance.title'
  | 'provenance.expand' | 'provenance.collapse'
  | 'provenance.loading' | 'provenance.empty' | 'provenance.error'
  | 'provenance.run' | 'provenance.pipeline' | 'provenance.mode'
  | 'provenance.readOnlyNote'

const META_RECORD_PROVENANCE_LABELS: Record<MetaRecordProvenanceLabelKey, { en: string; zh: string }> = {
  'provenance.title': { en: 'Provenance', zh: '数据来源' },
  'provenance.expand': { en: 'Show where this row came from', zh: '查看该行的数据来源' },
  'provenance.collapse': { en: 'Hide where this row came from', zh: '收起该行的数据来源' },
  'provenance.loading': { en: 'Loading provenance...', zh: '正在加载数据来源...' },
  'provenance.empty': { en: 'No provenance recorded', zh: '无来源记录' },
  'provenance.error': { en: 'Provenance is unavailable right now.', zh: '暂时无法加载数据来源。' },
  'provenance.run': { en: 'Run', zh: '运行' },
  'provenance.pipeline': { en: 'Pipeline', zh: '管道' },
  'provenance.mode': { en: 'Mode', zh: '方式' },
  'provenance.readOnlyNote': {
    en: 'Read-only: redacted events only — no source payload, no credentials.',
    zh: '只读：仅展示脱敏后的事件，不含来源原文与凭据。',
  },
}

export function recordProvenanceLabel(key: MetaRecordProvenanceLabelKey, isZh: boolean): string {
  const entry = META_RECORD_PROVENANCE_LABELS[key]
  return isZh ? entry.zh : entry.en
}

const EVENT_TYPE_LABELS: Record<string, { en: string; zh: string }> = {
  source_read: { en: 'Source read', zh: '读取来源' },
  row_imported: { en: 'Imported', zh: '已导入' },
  row_edited: { en: 'Edited', zh: '已修改' },
  mapping_applied: { en: 'Mapping applied', zh: '已套用映射' },
  validation_failed: { en: 'Validation failed', zh: '校验未通过' },
  dry_run_previewed: { en: 'Dry-run previewed', zh: '试运行预览' },
  target_write_attempted: { en: 'Write attempted', zh: '尝试写入' },
  target_write_succeeded: { en: 'Write succeeded', zh: '写入成功' },
  target_write_failed: { en: 'Write failed', zh: '写入失败' },
  row_retried: { en: 'Retried', zh: '已重试' },
  row_exported: { en: 'Exported', zh: '已导出' },
}

const RUN_STATUS_LABELS: Record<string, { en: string; zh: string }> = {
  pending: { en: 'pending', zh: '待运行' },
  running: { en: 'running', zh: '运行中' },
  succeeded: { en: 'succeeded', zh: '成功' },
  partial: { en: 'partial', zh: '部分成功' },
  failed: { en: 'failed', zh: '失败' },
  cancelled: { en: 'cancelled', zh: '已取消' },
}

const RUN_MODE_LABELS: Record<string, { en: string; zh: string }> = {
  incremental: { en: 'incremental', zh: '增量' },
  full: { en: 'full', zh: '全量' },
  manual: { en: 'manual', zh: '手动' },
  replay: { en: 'replay', zh: '重放' },
}

function lookup(table: Record<string, { en: string; zh: string }>, value: string, isZh: boolean): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  const entry = table[raw]
  if (!entry) return raw
  return isZh ? entry.zh : entry.en
}

export function provenanceEventTypeLabel(eventType: string, isZh: boolean): string {
  return lookup(EVENT_TYPE_LABELS, eventType, isZh)
}

export function provenanceRunStatusLabel(runStatus: string, isZh: boolean): string {
  return lookup(RUN_STATUS_LABELS, runStatus, isZh)
}

export function provenanceRunModeLabel(runMode: string, isZh: boolean): string {
  return lookup(RUN_MODE_LABELS, runMode, isZh)
}

const ATTR_KEY_LABELS: Record<string, { en: string; zh: string }> = {
  decision: { en: 'Action', zh: '动作' },
  errorCode: { en: 'Error code', zh: '错误码' },
}

export function provenanceAttrKeyLabel(key: string, isZh: boolean): string {
  return lookup(ATTR_KEY_LABELS, key, isZh)
}
