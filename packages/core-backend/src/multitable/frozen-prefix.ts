/**
 * Server mirror of the web grid's frozen-columns rule (批次标识 BI-5, the layout read).
 *
 * The web computes the frozen columns of a view in apps/web/src/multitable/utils/frozen-columns.ts:
 *   - `parseFrozenIds` (lines 8-13): `view.config.frozenLeftColumnIds` counts only when it is an array whose EVERY element
 *     is a string; anything else is [];
 *   - `frozenPrefixCount` (lines 19-27): the length of the longest contiguous LEFT prefix of the ordered visible field
 *     ids whose ids are all in the frozen set (non-prefix frozen ids are ignored);
 *   - the ordered visible fields it is applied to (MetaGridTable.vue `props.visibleFields`, built in
 *     useMultitableGrid.ts `visibleFields`): the sheet's fields in their natural order, minus the view's
 *     `hidden_field_ids` AS THE HOST SHIPS THEM (every host view read — GET /view's tryResolveView, /context, the
 *     meta_views serializers — normalises them with field-codecs.ts `normalizeJsonArray`: trimmed, finite numbers
 *     stringified; the grid then hides by exact id), minus property-hidden fields (`property.hidden === true || property.visible === false`, the
 *     web's `isPropertyHiddenField`), minus fields the viewer's field permissions hide, reordered by a personal
 *     `fieldOrder` when one applies;
 *   - and only on a view the web renders as a grid: MultitableWorkbench.vue renders MetaGridTable (the only component
 *     that applies `frozenLeftColumnIds`) in the v-else after the form / kanban / gallery / calendar / timeline /
 *     gantt / hierarchy branches (view-landing.ts DESCRIBE_LAYOUT_NON_GRID_VIEW_TYPES).
 *
 * core-backend cannot import apps/web, so the two functions are re-stated here line for line (the parity cases in
 * tests/unit/multitable-plugin-view-landing.test.ts are the web unit's cases). The layout read applies them to the
 * SHARED view as a viewer without field-permission restrictions or a personal order sees it: per-user permissions and
 * personal orders are per-person facts, and the read counts personal orders separately (`personalOrderOverrides`).
 */

export function parseFrozenLeftColumnIds(config: Record<string, unknown> | null | undefined): string[] {
  const value = config?.frozenLeftColumnIds
  if (!Array.isArray(value)) return []
  if (!value.every((x) => typeof x === 'string')) return []
  return value as string[]
}

export function countFrozenPrefix(orderedFieldIds: string[], frozenIds: string[]): number {
  const set = new Set(frozenIds)
  let n = 0
  for (const id of orderedFieldIds) {
    if (set.has(id)) n++
    else break
  }
  return n
}

export function isFieldPropertyHidden(property: Record<string, unknown> | null | undefined): boolean {
  return property?.hidden === true || property?.visible === false
}
