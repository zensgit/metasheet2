/**
 * BS-4 UX follow-up: resolve batch-restore record titles AT SELECTION TIME. A record can only be selected while it
 * is loaded, so its primary-field value is in the loaded rows when the selection changes. Capturing it then means
 * the batch-restore dialog can show a real title even if the row later scrolls off or a view reset clears the grid
 * (off-page resolution) — without any fetch and without touching the restore wire/identity.
 *
 * Pure: given the current selection, the loaded rows, the primary field id, and the previously-captured labels,
 * returns the new label map. A fresh on-page title wins; otherwise a previously-captured title is kept (the record
 * has since scrolled off / a reset cleared it); otherwise the entry is empty and the caller falls back to the id.
 */
export function resolveSelectionLabels(
  recordIds: string[],
  rows: ReadonlyArray<{ id: string; data?: Record<string, unknown> }>,
  primaryFieldId: string | undefined,
  prev: Record<string, string>,
): Record<string, string> {
  const next: Record<string, string> = {}
  for (const id of recordIds) {
    const row = rows.find((r) => r.id === id)
    const fresh = row && primaryFieldId ? row.data?.[primaryFieldId] : undefined
    next[id] = fresh != null && fresh !== '' ? String(fresh) : (prev[id] ?? '')
  }
  return next
}
