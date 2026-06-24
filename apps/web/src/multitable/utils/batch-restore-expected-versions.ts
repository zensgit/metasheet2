import type { RestoreBatchPreviewRecord } from '../api/client'

/**
 * BS-4 wire-drift guard. Build the `expectedVersions` map the batch execute submits: ONLY the records in `scope`
 * (the restorable set the preview identity binds), each mapped to its preview-time `previewVersion`. A record not
 * in `scope`, or one lacking a numeric `previewVersion`, is excluded.
 *
 * This is the version-bind contract (#2): the FE submits each record's PREVIEW-TIME version verbatim — never the
 * current version — so the server folds the submitted value into the scopeHash and a stale/tampered version is
 * rejected. The FE is a faithful client of the security model; it does not reinterpret it. The execute's `recordIds`
 * must be the preview's `scope`, and these expectedVersions are keyed over exactly that scope.
 */
export function buildBatchExpectedVersions(
  records: RestoreBatchPreviewRecord[],
  scope: string[],
): Record<string, number> {
  const scopeSet = new Set(scope)
  const out: Record<string, number> = {}
  for (const r of records) {
    if (scopeSet.has(r.recordId) && typeof r.previewVersion === 'number') out[r.recordId] = r.previewVersion
  }
  return out
}
