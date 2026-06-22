// AI bulk-fill review-before-write dialog chrome string table (B-3).
//
// Scope: MetaAiBulkFillDialog.vue + Workbench-owned AI-fill trigger/result
// fallbacks. Field names, record ids, backend messages, and provider/runtime
// error text stay raw. Error CODE copy lives in meta-api-error-labels
// (aiBulkErrorMessage) — this module is chrome + per-row state labels only.
//
// The central requirement (owner's flagged risk): TRUTHFUL STATUS. Every
// preview state and commit outcome has its OWN distinct label here so the user
// is never misled about what was or wasn't written.

type LocaleText = { en: string; zh: string }

export type MetaAiBulkLabelKey =
  // Trigger
  | 'aibulk.trigger'
  | 'aibulk.triggerAria'
  | 'aibulk.triggerNeedsConfig'
  | 'aibulk.triggerDirtyConfig'
  // Dialog chrome
  | 'aibulk.title'
  | 'aibulk.close'
  | 'aibulk.cancel'
  // Scope step
  | 'aibulk.scopeView'
  | 'aibulk.scopeSelection'
  | 'aibulk.scopeViewHint'
  | 'aibulk.scopeSelectionHint'
  | 'aibulk.generate'
  | 'aibulk.generating'
  // Cost honesty (the abandon-still-charged warning)
  | 'aibulk.quotaNote'
  | 'aibulk.costLabel'
  // Preview table
  | 'aibulk.colSelect'
  | 'aibulk.colRecord'
  | 'aibulk.colCurrent'
  | 'aibulk.colProposed'
  | 'aibulk.colState'
  | 'aibulk.currentEmpty'
  | 'aibulk.selectAll'
  // Distinct preview-row state badges
  | 'aibulk.badgeConfirmable'
  | 'aibulk.badgeMasked'
  | 'aibulk.badgeMaskedTitle'
  // Non-selectable groupings
  | 'aibulk.skippedHeading'
  | 'aibulk.skippedNote'
  | 'aibulk.failuresHeading'
  | 'aibulk.failuresNote'
  // Distinct skipped reasons (UNCHARGED)
  | 'aibulk.reasonNoPerm'
  | 'aibulk.reasonRateLimited'
  | 'aibulk.reasonBlocked'
  | 'aibulk.reasonGenFailed'
  | 'aibulk.reasonUnsafe'
  // Distinct failure reasons (CHARGED, non-confirmable)
  | 'aibulk.reasonProviderError'
  | 'aibulk.reasonCacheFailed'
  // Partial-preview (capped:true) notice
  | 'aibulk.partialNotice'
  // Empty preview
  | 'aibulk.emptyConfirmable'
  // Confirm step
  | 'aibulk.confirm'
  | 'aibulk.committing'
  | 'aibulk.back'
  // Commit outcome heading + distinct per-row outcomes
  | 'aibulk.outcomeHeading'
  | 'aibulk.outcomeWritten'
  | 'aibulk.outcomeStale'
  | 'aibulk.outcomeStaleGuidance'
  | 'aibulk.outcomeConflict'
  | 'aibulk.outcomeNotInCache'
  | 'aibulk.outcomeSkippedNoPerm'
  | 'aibulk.allExpired'
  | 'aibulk.done'

const LABELS: Record<MetaAiBulkLabelKey, LocaleText> = {
  'aibulk.trigger': { en: 'AI fill column', zh: 'AI 填充整列' },
  'aibulk.triggerAria': { en: 'Bulk-fill this column with AI (review before write)', zh: '用 AI 批量填充此列（写入前可审阅）' },
  'aibulk.triggerNeedsConfig': {
    en: 'Save an AI config on this field to enable bulk fill.',
    zh: '请先为该字段保存 AI 配置以启用批量填充。',
  },
  'aibulk.triggerDirtyConfig': {
    en: 'Save your AI config changes first — bulk fill runs the saved config.',
    zh: '请先保存 AI 配置改动——批量填充执行的是已保存的配置。',
  },
  'aibulk.title': { en: 'AI fill — review before write', zh: 'AI 填充 — 写入前审阅' },
  'aibulk.close': { en: 'Close', zh: '关闭' },
  'aibulk.cancel': { en: 'Cancel', zh: '取消' },
  'aibulk.scopeView': { en: 'All rows in this view', zh: '当前视图的全部行' },
  'aibulk.scopeSelection': { en: 'Selected rows only', zh: '仅所选行' },
  'aibulk.scopeViewHint': {
    en: 'Fills every row the current view resolves to (filtered + on every page), not just the loaded page.',
    zh: '填充当前视图筛选出的全部行（含未加载的分页），不仅是已加载页。',
  },
  'aibulk.scopeSelectionHint': { en: 'Fills only the rows you selected in the grid.', zh: '仅填充你在表格中选择的行。' },
  'aibulk.generate': { en: 'Generate preview', zh: '生成预览' },
  'aibulk.generating': { en: 'Generating…', zh: '生成中…' },
  // The crux of cost honesty — shown BEFORE generation and on the result.
  'aibulk.quotaNote': {
    en: 'Generating the preview consumes AI quota for every row. Confirm only writes the cached results — abandoning afterwards does NOT refund the quota already spent.',
    zh: '生成预览会为每一行消耗 AI 配额。确认只是写入已缓存的结果——之后放弃不会退还已消耗的配额。',
  },
  'aibulk.costLabel': { en: 'Preview cost (already charged)', zh: '预览成本（已扣费）' },
  'aibulk.colSelect': { en: 'Write', zh: '写入' },
  'aibulk.colRecord': { en: 'Record', zh: '记录' },
  'aibulk.colCurrent': { en: 'Current', zh: '当前值' },
  'aibulk.colProposed': { en: 'Proposed', zh: '建议值' },
  'aibulk.colState': { en: 'State', zh: '状态' },
  'aibulk.currentEmpty': { en: '(empty)', zh: '（空）' },
  'aibulk.selectAll': { en: 'Select all writable', zh: '全选可写入' },
  'aibulk.badgeConfirmable': { en: 'Ready to write', zh: '可写入' },
  'aibulk.badgeMasked': { en: 'May be incomplete', zh: '可能不完整' },
  'aibulk.badgeMaskedTitle': {
    en: 'Generated from a reduced context — a source field you cannot read was omitted. Still writable; review carefully.',
    zh: '基于精简上下文生成——已省略你无权读取的源字段。仍可写入，请仔细核对。',
  },
  'aibulk.skippedHeading': { en: 'Skipped (will not be written)', zh: '已跳过（不会写入）' },
  'aibulk.skippedNote': {
    en: 'These rows were not generated and consumed no quota. They cannot be written.',
    zh: '这些行未生成、未消耗配额，无法写入。',
  },
  'aibulk.failuresHeading': { en: 'Failed (charged, nothing to write)', zh: '失败（已扣费，无可写入内容）' },
  'aibulk.failuresNote': {
    en: 'These rows reached the provider and CONSUMED quota, but produced no usable result — there is nothing to write. Re-running may help.',
    zh: '这些行已调用模型并消耗配额，但未产出可用结果——无内容可写入。重新运行可能有帮助。',
  },
  'aibulk.reasonNoPerm': { en: 'No write permission', zh: '无写入权限' },
  'aibulk.reasonRateLimited': { en: 'Rate-limited — re-run to reach it', zh: '触发限流——重新运行可处理' },
  'aibulk.reasonBlocked': { en: 'AI unavailable — re-run later', zh: 'AI 暂不可用——稍后重试' },
  'aibulk.reasonGenFailed': { en: 'Generation failed (not charged)', zh: '生成失败（未扣费）' },
  'aibulk.reasonUnsafe': { en: 'Content blocked (secret-shaped) — not sent', zh: '内容被拦截（疑似密钥）——未发送' },
  'aibulk.reasonProviderError': { en: 'Provider error after charge', zh: '扣费后模型出错' },
  'aibulk.reasonCacheFailed': { en: 'Result lost after charge', zh: '扣费后结果丢失' },
  // capped:true — partial preview; NO count (hidden-row oracle guard).
  'aibulk.partialNotice': {
    en: 'Preview stopped early — some in-scope rows were not previewed yet. Write these results, then run AI fill again to continue with the rest.',
    zh: '预览提前结束——范围内仍有部分行未预览。可先写入这些结果，再次运行 AI 填充以继续处理其余行。',
  },
  'aibulk.emptyConfirmable': {
    en: 'No rows are ready to write. See skipped/failed rows below for why.',
    zh: '没有可写入的行。原因见下方的跳过/失败行。',
  },
  'aibulk.confirm': { en: 'Write selected rows', zh: '写入所选行' },
  'aibulk.committing': { en: 'Writing…', zh: '写入中…' },
  'aibulk.back': { en: 'Back to preview', zh: '返回预览' },
  'aibulk.outcomeHeading': { en: 'Write results', zh: '写入结果' },
  'aibulk.outcomeWritten': { en: 'Written', zh: '已写入' },
  'aibulk.outcomeStale': { en: 'Changed since preview — not written', zh: '预览后已变更——未写入' },
  'aibulk.outcomeStaleGuidance': {
    en: 'These rows changed after the preview was generated, so they were NOT written. Run AI fill again to re-preview them against the latest values.',
    zh: '这些行在生成预览后发生了变更，因此未写入。请再次运行 AI 填充，基于最新值重新预览。',
  },
  'aibulk.outcomeConflict': { en: 'Write conflict — not written', zh: '写入冲突——未写入' },
  'aibulk.outcomeNotInCache': { en: 'Expired / not cached — not written', zh: '已过期 / 未缓存——未写入' },
  'aibulk.outcomeSkippedNoPerm': { en: 'No write permission — not written', zh: '无写入权限——未写入' },
  'aibulk.allExpired': {
    en: 'None of the confirmed rows could be written — the preview likely expired. Run AI fill again to regenerate.',
    zh: '确认的行均无法写入——预览可能已过期。请再次运行 AI 填充以重新生成。',
  },
  'aibulk.done': { en: 'Done', zh: '完成' },
}

export function aiBulkLabel(key: MetaAiBulkLabelKey, isZh: boolean): string {
  const entry = LABELS[key]
  return isZh ? entry.zh : entry.en
}

function rowWord(count: number): string {
  return count === 1 ? 'row' : 'rows'
}

/** Trigger button title: how many rows are in the current scope context, for the menu. */
export function aiBulkTriggerTitle(isZh: boolean): string {
  return aiBulkLabel('aibulk.triggerAria', isZh)
}

/** Distinct copy for each preview SKIPPED reason (UNCHARGED). Falls back to the raw reason. */
export function aiBulkSkippedReason(reason: string, isZh: boolean): string {
  switch (reason) {
    case 'skipped_no_perm':
      return aiBulkLabel('aibulk.reasonNoPerm', isZh)
    case 'rate_limited_before_call':
      return aiBulkLabel('aibulk.reasonRateLimited', isZh)
    case 'blocked_before_call':
      return aiBulkLabel('aibulk.reasonBlocked', isZh)
    case 'generation_failed_before_usage':
      return aiBulkLabel('aibulk.reasonGenFailed', isZh)
    case 'unsafe_input':
      return aiBulkLabel('aibulk.reasonUnsafe', isZh)
    default:
      return reason
  }
}

/** Distinct copy for each preview FAILURE reason (CHARGED, non-confirmable). Falls back to the raw reason. */
export function aiBulkFailureReason(reason: string, isZh: boolean): string {
  switch (reason) {
    case 'provider_error_charged':
      return aiBulkLabel('aibulk.reasonProviderError', isZh)
    case 'cache_failed_after_generation':
      return aiBulkLabel('aibulk.reasonCacheFailed', isZh)
    default:
      return reason
  }
}

/** Distinct copy for each commit per-row OUTCOME. Falls back to the raw outcome. */
export function aiBulkOutcomeLabel(outcome: string, isZh: boolean): string {
  switch (outcome) {
    case 'written':
      return aiBulkLabel('aibulk.outcomeWritten', isZh)
    case 'stale_reprev':
      return aiBulkLabel('aibulk.outcomeStale', isZh)
    case 'write_conflict':
      return aiBulkLabel('aibulk.outcomeConflict', isZh)
    case 'not_in_cache':
      return aiBulkLabel('aibulk.outcomeNotInCache', isZh)
    case 'skipped_no_perm':
      return aiBulkLabel('aibulk.outcomeSkippedNoPerm', isZh)
    default:
      return outcome
  }
}

/** Preview summary line: how many rows are ready vs skipped vs failed (charged). */
export function aiBulkPreviewSummary(
  confirmable: number,
  skipped: number,
  failures: number,
  isZh: boolean,
): string {
  if (isZh) {
    return `可写入 ${confirmable} 行 · 跳过 ${skipped} 行 · 失败（已扣费）${failures} 行`
  }
  return `${confirmable} ready · ${skipped} skipped · ${failures} failed (charged)`
}

/** Cost line: the already-charged USD spend for this preview. */
export function aiBulkCostLine(costUsd: number, isZh: boolean): string {
  const amount = `$${costUsd.toFixed(4)}`
  return isZh ? `${aiBulkLabel('aibulk.costLabel', isZh)}：${amount}` : `${aiBulkLabel('aibulk.costLabel', isZh)}: ${amount}`
}

/**
 * Aggregate commit summary — the headline truthful-status line. Lists every
 * non-zero outcome bucket so the user sees EXACTLY what landed and what didn't.
 */
export function aiBulkCommitSummary(counts: Record<string, number>, isZh: boolean): string {
  const written = counts.written ?? 0
  const stale = counts.stale_reprev ?? 0
  const conflict = counts.write_conflict ?? 0
  const notInCache = counts.not_in_cache ?? 0
  const noPerm = counts.skipped_no_perm ?? 0
  const parts: string[] = []
  if (isZh) {
    parts.push(`已写入 ${written} 行`)
    if (stale > 0) parts.push(`需重新预览 ${stale} 行`)
    if (conflict > 0) parts.push(`写入冲突 ${conflict} 行`)
    if (notInCache > 0) parts.push(`已过期/未缓存 ${notInCache} 行`)
    if (noPerm > 0) parts.push(`无权限 ${noPerm} 行`)
    return parts.join(' · ')
  }
  parts.push(`${written} written`)
  if (stale > 0) parts.push(`${stale} need re-preview`)
  if (conflict > 0) parts.push(`${conflict} write-conflict`)
  if (notInCache > 0) parts.push(`${notInCache} expired/not-cached`)
  if (noPerm > 0) parts.push(`${noPerm} no-permission`)
  return parts.join(' · ') + ` (${written + stale + conflict + notInCache + noPerm} ${rowWord(written + stale + conflict + notInCache + noPerm)})`
}
