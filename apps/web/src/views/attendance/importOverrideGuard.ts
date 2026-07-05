// Override import guard (frontend-only, 2026-07-05 design-lock, posture A — forced
// preview-first): pure helpers for the override-import confirm gate. AttendanceView.vue
// wires these into the Import button so overwriting attendance rows always goes through
// a forced Preview + an explicit, honest, irreversible-warning confirm before `runImport()`
// fires — for BOTH the sync and async (`/import/commit-async`) commit lanes, since the gate
// sits before `runImport()` is even called, not inside it.
//
// See docs/development/attendance-override-import-guard-design-lock-20260705.md (PR #3597,
// RATIFIED — posture A; posture B "confirm-modal-only, no forced preview" was rejected).
//
// Hard boundaries carried over from the lock (§4):
//   - Zero backend changes. The "export backup first" action only calls the existing
//     read-only `GET /api/attendance/export` (single-userId-scoped, `attendance:read`).
//   - NEVER show a precise overwrite-count N. The confirm only restates the Preview's
//     already-resolved scope (parsed row count + date range + distinct user count) plus a
//     generic "cannot be restored via rollback" warning — computing an exact N would need
//     either a backend change or one export/read call per distinct user, both deferred
//     (§6).
//   - merge mode never gates (non-destructive union) and the default import mode is
//     unchanged (still `override`).
//
// Current-state anchors this slice is built against (2026-07-05, re-verified against the
// checked-out `main` tip, not just the lock's own audit numbers):
//   - `AttendanceView.vue`: mode selector ~L5902-5911, Import button ~L6084,
//     `previewImport()` ~L18013, `runImport()` ~L18244 (internally picks sync vs
//     `/import/commit-async` by row-count threshold — the gate wraps the call, not a
//     branch inside it), `annualOpsConfirm`/`openAnnualOpsConfirm` ~L7100-7113/~L22760
//     (the in-DOM two-step-confirm idiom this gate's modal structure mirrors),
//     `requestAnnualAdjust()` ~L22866 (G3 target), `exportCsv()` ~L20633 (existing
//     `/api/attendance/export` call site this backup button's query-building mirrors).
//   - `plugins/plugin-attendance/index.cjs`: `GET /api/attendance/export` ~L41529-41531 —
//     `targetUserId = query.userId ?? requesterId` (strictly single-user; there is no
//     "all users in org" mode). A multi-user override import (CSV + user-map) therefore
//     can only get an honest one-click backup when the Preview resolves to exactly one
//     distinct user, or the operator has filled in the top-level "User ID" field — see
//     `resolveImportBackupTargetUserId` below and the PR body for the documented tradeoff.

export type ImportMode = 'override' | 'merge'
export type TranslateFn = (en: string, zh: string) => string

/** G2: only `override` is destructive (row-level overwrite, not restorable via rollback);
 *  `merge` stays one-click. */
export function importModeRequiresConfirm(mode: ImportMode): boolean {
  return mode === 'override'
}

/** G1 posture A: mirrors the accrual `:disabled="!annualAccrualDry"` idiom — override
 *  cannot be submitted without a Preview that is still fresh for the CURRENT payload. */
export function isOverrideSubmitBlocked(mode: ImportMode, hasFreshPreview: boolean): boolean {
  return mode === 'override' && !hasFreshPreview
}

export interface ImportPreviewRangeItem {
  userId?: string | null
  workDate?: string | null
}

export interface ImportPreviewRangeSummary {
  /** Earliest `workDate` across the currently-loaded preview rows (may be a truncated
   *  sample, not the full import — this is advisory scope, not a guarantee). */
  from: string | null
  to: string | null
  /** De-duplicated, order-stable list of `userId`s seen in the loaded preview rows. */
  userIds: string[]
}

/** Derive a best-effort affected date range + distinct-user set from whatever preview
 *  rows are currently loaded. This is the Preview's own already-resolved (rule-set /
 *  timezone / user-map applied) output — the honest, available substitute for a precise
 *  overwrite count (design-lock §2/§4/§6: computing exact N is out of scope for this
 *  slice). */
export function summarizeImportPreviewRange(items: ImportPreviewRangeItem[]): ImportPreviewRangeSummary {
  let from: string | null = null
  let to: string | null = null
  const seenUsers = new Set<string>()
  const userIds: string[] = []
  for (const item of items) {
    const workDate = typeof item.workDate === 'string' ? item.workDate.trim() : ''
    if (workDate) {
      if (from === null || workDate < from) from = workDate
      if (to === null || workDate > to) to = workDate
    }
    const userId = typeof item.userId === 'string' ? item.userId.trim() : ''
    if (userId && !seenUsers.has(userId)) {
      seenUsers.add(userId)
      userIds.push(userId)
    }
  }
  return { from, to, userIds }
}

export interface ImportOverrideConfirmLine {
  label: string
  value: string
}

export interface BuildImportOverrideConfirmLinesInput {
  /** The Preview's already-resolved parsed-row count (`importPreviewTotalRows` in the
   *  view) — NOT an overwrite count. */
  rowCount: number
  range: ImportPreviewRangeSummary
  /** Set when the loaded preview rows are a truncated sample (shown < total): the modal
   *  must say so, since the date-range/user-count lines are sample-derived (review P3-1). */
  sampleTruncated?: { shown: number; total: number } | null
}

/** G1 lines: mode + Preview's rowCount + date range / distinct-user set. Deliberately
 *  never includes an overwrite/existing-row count — design-lock §4 hard boundary. */
export function buildImportOverrideConfirmLines(
  input: BuildImportOverrideConfirmLinesInput,
  tr: TranslateFn,
): ImportOverrideConfirmLine[] {
  const { rowCount, range } = input
  const dateRangeValue = range.from && range.to
    ? (range.from === range.to ? range.from : `${range.from} ~ ${range.to}`)
    : tr('unknown (no preview rows loaded)', '未知（无预览行）')
  const lines: ImportOverrideConfirmLine[] = [
    { label: tr('Mode', '模式'), value: tr('override (overwrite same user/date)', '覆盖（同用户同日期）') },
    { label: tr('Parsed rows (preview)', '解析行数（预览）'), value: String(rowCount) },
    { label: tr('Date range (preview)', '日期范围（预览）'), value: dateRangeValue },
    { label: tr('Distinct users (preview)', '涉及用户数（预览）'), value: String(range.userIds.length) },
  ]
  if (input.sampleTruncated) {
    const { shown, total } = input.sampleTruncated
    lines.push({
      label: tr('Sample truncated', '样本已截断'),
      value: tr(
        `${shown}/${total} rows loaded — the date-range/user figures above reflect the loaded sample only`,
        `已加载 ${shown}/${total} 行——上方日期范围/用户数仅基于已加载样本`,
      ),
    })
  }
  return lines
}

/** G1 generic, honest irreversible-warning text — never a precise overwrite count. */
export function buildImportOverrideWarningText(tr: TranslateFn): string {
  return tr(
    'Overwritten rows cannot be restored via rollback.',
    '被覆盖行无法通过 rollback 恢复。',
  )
}

/** G1 mandatory-checkbox label (mirrors `annualOpsConfirm.extraConfirmLabel`). */
export function buildImportOverrideConfirmCheckboxLabel(tr: TranslateFn): string {
  return tr(
    'I understand overwritten rows cannot be restored via rollback.',
    '我已知晓被覆盖行无法通过 rollback 恢复。',
  )
}

/** G3: manual (negative-delta) adjustment ledger-irreversibility note, appended to
 *  `requestAnnualAdjust()`'s `annualOpsConfirm.lines` only when `deltaMinutes < 0`. Pure
 *  text — no behavior change. */
export function buildManualAdjustDeductionLedgerLine(tr: TranslateFn): ImportOverrideConfirmLine {
  return {
    label: tr('Note', '提示'),
    value: tr(
      'The deduction is written to the ledger; restoring it needs a reverse adjustment (it cannot be undone directly).',
      '扣减将写入台账，需以反向调整回补（不可直接撤销）。',
    ),
  }
}

/** The existing `GET /api/attendance/export` route is strictly single-userId-scoped
 *  (defaults to the calling admin when `userId` is omitted) — so the one-click backup can
 *  only target a real user when either the import form names one explicitly, or the
 *  Preview happens to resolve to exactly one distinct user. Otherwise there is no honest
 *  single-call target (falling back to "no userId" would silently back up the acting
 *  admin's own records, not the imported employees' — worse than no backup button at all),
 *  so callers should disable the backup action instead. */
export function resolveImportBackupTargetUserId(
  formUserId: string,
  previewUserIds: string[],
  sampleTruncated = false,
): string | null {
  const trimmed = formUserId.trim()
  if (trimmed) return trimmed
  // Review P3-1: when the loaded preview is a truncated sample, "exactly one distinct
  // user in the sample" says nothing about the full import — auto-resolving would offer a
  // confident-looking backup that may cover only part of the affected users. Only an
  // explicit form userId counts then.
  if (!sampleTruncated && previewUserIds.length === 1) return previewUserIds[0]
  return null
}

/** Exact wire query for the backup-export call — kept pure/exported so the shape is
 *  unit-testable without a network mock (mirrors `exportCsv()`'s `buildQuery({...})`
 *  usage at ~L20648, scoped to the import's own range/target instead of the Records tab's
 *  filters). */
export function buildImportBackupExportQuery(input: {
  orgId: string
  targetUserId: string
  range: ImportPreviewRangeSummary
}): Record<string, string> {
  const query: Record<string, string> = { format: 'csv' }
  if (input.orgId) query.orgId = input.orgId
  if (input.targetUserId) query.userId = input.targetUserId
  if (input.range.from) query.from = input.range.from
  if (input.range.to) query.to = input.range.to
  return query
}

export type ImportBackupExportStatus = 'idle' | 'exporting' | 'exported' | 'failed'
