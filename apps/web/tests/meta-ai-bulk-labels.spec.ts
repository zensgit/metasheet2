/**
 * B-3 AI bulk-fill i18n — locks the TRUTHFUL-STATUS copy: each preview reason,
 * each failure reason, and each commit outcome maps to its OWN distinct label
 * (en + zh), the aggregate summary lists only non-zero buckets, and the
 * bulk-specific error codes resolve (delegating shared per-record AI codes).
 */
import { describe, expect, it } from 'vitest'

import {
  aiBulkCommitSummary,
  aiBulkCostLine,
  aiBulkFailureReason,
  aiBulkLabel,
  aiBulkOutcomeLabel,
  aiBulkPreviewSummary,
  aiBulkSkippedReason,
} from '../src/multitable/utils/meta-ai-bulk-labels'
import { aiBulkErrorMessage } from '../src/multitable/utils/meta-api-error-labels'

describe('meta-ai-bulk-labels — distinct state copy', () => {
  it('chrome labels resolve in en and zh', () => {
    expect(aiBulkLabel('aibulk.trigger', false)).toBe('AI fill column')
    expect(aiBulkLabel('aibulk.trigger', true)).toBe('AI 填充整列')
    expect(aiBulkLabel('aibulk.quotaNote', false)).toContain('does NOT refund')
    expect(aiBulkLabel('aibulk.quotaNote', true)).toContain('不会退还')
  })

  it('#5838 the sheet-liveness partial notice is its OWN copy — the generic one gives two instructions that both refuse', () => {
    for (const zh of [false, true]) {
      const generic = aiBulkLabel('aibulk.partialNotice', zh)
      const notLive = aiBulkLabel('aibulk.partialNoticeSheetNotLive', zh)
      expect(notLive).not.toBe(generic)
      // Neither leaks a row count (hidden-row oracle guard).
      expect(notLive).not.toMatch(/\d/)
    }
    // The generic advice — write, then re-run — is exactly what fails on a table that is gone
    // (commit → 404 SHEET_DELETED, re-run → refused at the entry gate), so it must not appear.
    expect(aiBulkLabel('aibulk.partialNotice', false)).toContain('run AI fill again to continue with the rest')
    expect(aiBulkLabel('aibulk.partialNoticeSheetNotLive', false)).not.toContain('Write these results, then run AI fill again')
    expect(aiBulkLabel('aibulk.partialNoticeSheetNotLive', false)).toContain('could not be confirmed available')
    expect(aiBulkLabel('aibulk.partialNoticeSheetNotLive', false)).toContain('restore it first')
    expect(aiBulkLabel('aibulk.partialNoticeSheetNotLive', true)).toContain('无法确认数据表可用')
    expect(aiBulkLabel('aibulk.partialNoticeSheetNotLive', true)).toContain('请先恢复')
  })

  it('every SKIPPED reason (UNCHARGED) maps to a DISTINCT label, never collapsed', () => {
    const reasons = ['skipped_no_perm', 'rate_limited_before_call', 'blocked_before_call', 'generation_failed_before_usage', 'unsafe_input', 'sheet_not_live']
    const en = reasons.map((r) => aiBulkSkippedReason(r, false))
    // All distinct (no two skipped reasons share copy).
    expect(new Set(en).size).toBe(reasons.length)
    expect(aiBulkSkippedReason('skipped_no_perm', false)).toBe('No write permission')
    expect(aiBulkSkippedReason('rate_limited_before_call', false)).toBe('Rate-limited — re-run to reach it')
    expect(aiBulkSkippedReason('generation_failed_before_usage', false)).toContain('not charged')
    // zh coverage + raw fallback for an unknown reason.
    expect(aiBulkSkippedReason('skipped_no_perm', true)).toBe('无写入权限')
    // #5838: a table that stops being confirmable mid-batch stops the send; the rows not reached are
    // UNCHARGED. The server reports ONE reason for three verdicts (deleted / row gone / the liveness
    // lookup itself failed, all fail-closed), so this copy states what is known — that availability
    // could not be confirmed — and must NOT assert a deletion: a DB blip on a LIVE table would
    // otherwise tell the user it was deleted and argue against the one action that works, a re-run.
    expect(aiBulkSkippedReason('sheet_not_live', false)).toContain('could not be confirmed available')
    expect(aiBulkSkippedReason('sheet_not_live', true)).toContain('无法确认数据表可用')
    for (const zh of [false, true]) {
      expect(aiBulkSkippedReason('sheet_not_live', zh)).not.toMatch(/\bdeleted\b|no longer available|已删除|已不可用/)
    }
    expect(aiBulkSkippedReason('weird_new_reason', false)).toBe('weird_new_reason')
  })

  it('every FAILURE reason (CHARGED, non-confirmable) maps to a DISTINCT label', () => {
    expect(aiBulkFailureReason('provider_error_charged', false)).toBe('Provider error after charge')
    expect(aiBulkFailureReason('cache_failed_after_generation', false)).toBe('Result lost after charge')
    expect(aiBulkFailureReason('provider_error_charged', false)).not.toBe(aiBulkFailureReason('cache_failed_after_generation', false))
    expect(aiBulkFailureReason('cache_failed_after_generation', true)).toBe('扣费后结果丢失')
    expect(aiBulkFailureReason('mystery', false)).toBe('mystery')
  })

  // #5842: the backend books a row that was AT the provider when it left `pending` as
  // `failure` with one of two reasons. They are user-visible provenance for a REAL charge, so
  // neither may fall through to the raw-token default (a zh user would read
  // `cancelled_after_charge`), and they must not read the same — one says the user cancelled,
  // the other says something else interrupted the job.
  it('the charged-but-not-offered reasons (#5842) are localised and DISTINCT from each other', () => {
    const reasons = ['cancelled_after_charge', 'interrupted_after_charge']
    for (const reason of reasons) {
      for (const isZh of [false, true]) {
        // Not the raw token: a translated label was actually found.
        expect(aiBulkFailureReason(reason, isZh)).not.toBe(reason)
      }
      // zh is real Chinese copy, not the en string reused.
      expect(aiBulkFailureReason(reason, true)).not.toBe(aiBulkFailureReason(reason, false))
      // The money is named in both locales — this is a charged row.
      expect(aiBulkFailureReason(reason, false).toLowerCase()).toContain('charged')
      expect(aiBulkFailureReason(reason, true)).toContain('扣费')
    }
    expect(aiBulkFailureReason('cancelled_after_charge', false)).not.toBe(aiBulkFailureReason('interrupted_after_charge', false))
    expect(aiBulkFailureReason('cancelled_after_charge', true)).not.toBe(aiBulkFailureReason('interrupted_after_charge', true))
    // …and distinct from the two pre-existing charged failures, so the review page can tell all
    // four apart.
    const all = ['provider_error_charged', 'cache_failed_after_generation', ...reasons].map((r) => aiBulkFailureReason(r, true))
    expect(new Set(all).size).toBe(all.length)
  })

  it('every COMMIT outcome maps to a DISTINCT label; only "written" reads as success', () => {
    const outcomes = ['written', 'stale_reprev', 'write_conflict', 'not_in_cache', 'skipped_no_perm']
    const en = outcomes.map((o) => aiBulkOutcomeLabel(o, false))
    expect(new Set(en).size).toBe(outcomes.length)
    expect(aiBulkOutcomeLabel('written', false)).toBe('Written')
    expect(aiBulkOutcomeLabel('stale_reprev', false)).toContain('not written')
    expect(aiBulkOutcomeLabel('write_conflict', false)).toContain('not written')
    expect(aiBulkOutcomeLabel('not_in_cache', false)).toContain('not written')
    expect(aiBulkOutcomeLabel('skipped_no_perm', false)).toContain('not written')
    // Only "written" omits the "not written" disclaimer.
    expect(aiBulkOutcomeLabel('written', false)).not.toContain('not written')
    expect(aiBulkOutcomeLabel('stale_reprev', true)).toContain('未写入')
  })

  it('preview summary reports ready / skipped / failed(charged) counts', () => {
    expect(aiBulkPreviewSummary(2, 1, 1, false)).toBe('2 ready · 1 skipped · 1 failed (charged)')
    expect(aiBulkPreviewSummary(2, 1, 1, true)).toBe('可写入 2 行 · 跳过 1 行 · 失败（已扣费）1 行')
  })

  it('cost line surfaces the already-charged USD spend', () => {
    expect(aiBulkCostLine(0.0042, false)).toBe('Preview cost (already charged): $0.0042')
    expect(aiBulkCostLine(0.0042, true)).toBe('预览成本（已扣费）：$0.0042')
  })

  it('commit summary lists EVERY non-zero bucket and omits zero buckets (no misleading omission)', () => {
    const summary = aiBulkCommitSummary(
      { written: 3, stale_reprev: 2, write_conflict: 0, not_in_cache: 1, skipped_no_perm: 0 },
      false,
    )
    expect(summary).toContain('3 written')
    expect(summary).toContain('2 need re-preview')
    expect(summary).toContain('1 expired/not-cached')
    expect(summary).not.toContain('write-conflict') // zero → omitted
    expect(summary).not.toContain('no-permission') // zero → omitted

    // All-written: the user sees a clean, unqualified count.
    expect(aiBulkCommitSummary({ written: 5, stale_reprev: 0, write_conflict: 0, not_in_cache: 0, skipped_no_perm: 0 }, false)).toBe('5 written (5 rows)')
    // zh.
    expect(aiBulkCommitSummary({ written: 1, stale_reprev: 1, write_conflict: 0, not_in_cache: 0, skipped_no_perm: 0 }, true)).toBe('已写入 1 行 · 需重新预览 1 行')
  })
})

describe('aiBulkErrorMessage — bulk error codes + shared-code delegation', () => {
  it('maps bulk-specific codes (en + zh)', () => {
    expect(aiBulkErrorMessage('AI_BULK_QUOTA_INSUFFICIENT', false)).toContain('exceed the remaining AI quota')
    expect(aiBulkErrorMessage('BULK_SCOPE_TOO_LARGE', false)).toContain('Too many rows')
    expect(aiBulkErrorMessage('AI_BULK_VIEW_FILTER_UNSUPPORTED', false)).toContain('computed')
    expect(aiBulkErrorMessage('AI_INLINE_CONFIG_REJECTED', false)).toContain('saved AI config')
    expect(aiBulkErrorMessage('FIELD_FORBIDDEN', false)).toContain('not editable')
    expect(aiBulkErrorMessage('AI_BULK_QUOTA_INSUFFICIENT', true)).toContain('超出剩余 AI 配额')
  })

  it('delegates shared per-record AI codes (RATE_LIMITED / AI_BLOCKED) so copy is not duplicated', () => {
    expect(aiBulkErrorMessage('RATE_LIMITED', false)).toBe('Too many AI requests.')
    expect(aiBulkErrorMessage('AI_BLOCKED', false)).toBe('AI is not enabled or not ready. Contact an administrator.')
  })

  it('returns null for an unknown code (caller falls back to the raw backend message)', () => {
    expect(aiBulkErrorMessage('SOMETHING_ELSE', false)).toBeNull()
    expect(aiBulkErrorMessage(undefined, false)).toBeNull()
  })
})
