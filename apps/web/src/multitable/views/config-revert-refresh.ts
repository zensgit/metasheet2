/**
 * T9-W-3: after a config revert succeeds, the live config has changed (field name/order, view
 * filter/config) — so the workbench must reload sheet meta + the grid, mirroring the field/view
 * SAVE paths. Without this the user sees "撤销成功" while the field names / view filter / grid stay
 * stale until a manual refresh.
 *
 * Extracted from MultitableWorkbench.onConfigReverted so the reload contract is unit-testable
 * WITHOUT mounting the 22k-line workbench SFC (whose full mount is red-at-base in the test env).
 */
export interface ConfigRevertRefreshDeps {
  /** the currently active sheet id (null/empty → nothing to refresh) */
  sheetId: string | null | undefined
  /**
   * drop the grid toolbar's staged, unapplied sort/filter edits (grid.discardUnappliedSortFilterEdits) — called
   * BEFORE the reload, whose "persist dirty sort/filter first" step would otherwise PATCH them over the view the
   * revert just restored (客户反馈 2026-09-24 #5 / #6075 round 2). Required, so a caller cannot forget it.
   */
  discardUnappliedEdits: () => void
  /** reload sheet meta (field schema, view config) for the given sheet */
  loadSheetMeta: (sheetId: string) => Promise<unknown>
  /** reload the grid page at the given offset */
  loadViewData: (offset: number) => Promise<unknown>
  /** the current grid page offset to reload */
  offset: number
}

/** Reload sheet meta THEN the grid (meta first, so the grid renders against the reverted schema). */
export async function refreshAfterConfigRevert(deps: ConfigRevertRefreshDeps): Promise<void> {
  if (!deps.sheetId) return // no active sheet → no stale-id reload
  // The revert emits no entity, so the workbench cannot tell whether it touched the CURRENT view's sort/filter —
  // it may have. Staged toolbar edits were made against the pre-revert rules: discard them, never persist them.
  deps.discardUnappliedEdits()
  await deps.loadSheetMeta(deps.sheetId)
  await deps.loadViewData(deps.offset)
}
