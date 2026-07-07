import type { MetaField } from '../types'
import { writePersonalConfigMerged, type PersonalConfigWriteClient } from './personal-config-write'

/**
 * Slice 3c — the column-reorder WRITE path, split by personal-vs-shared so the two never cross (design-lock
 * multitable-personal-views-slice3-fe-toggle-design-lock-20260706.md).
 *
 * Two LOAD-BEARING constraints (each has a golden in reorder-view-fields.spec.ts):
 *  1. In personal mode a drag writes ONLY the actor's `personal-config.fieldOrder` — it NEVER calls
 *     `updateField({ order })` (which is the SHARED field order every user sees). The shared path (personal
 *     off) is unchanged: reorder `grid.fields` and persist each `field.order`, byte-for-byte as before.
 *  2. Writing `fieldOrder` MUST preserve the actor's other personal facets (filter/sort/group/hidden). The
 *     backend PUT replaces the whole config row, so we read-merge-write: fetch the current personal config,
 *     spread it, and set only `fieldOrder`.
 *
 * Personal reorder operates over the user-VISIBLE order (`visibleFieldIds`) — the order the user actually sees
 * and drags — and produces the new visible id list as the personal `fieldOrder`. Shared reorder operates over
 * `grid.fields` to preserve the existing sheet-global `field.order` semantics.
 */
// The reorder client is the shared personal-config write client (get/put) plus the shared-order updateField —
// so the personal write can be handed straight to writePersonalConfigMerged with no shape duplication.
export interface ReorderClient extends PersonalConfigWriteClient {
  updateField(fieldId: string, input: { order: number }): Promise<unknown>
}

/** Move `fromId` to `toId`'s slot within `ids`. Returns null if either id is absent (no-op). */
export function moveWithin(ids: readonly string[], fromId: string, toId: string): string[] | null {
  const arr = [...ids]
  const fromIdx = arr.indexOf(fromId)
  const toIdx = arr.indexOf(toId)
  if (fromIdx < 0 || toIdx < 0) return null
  const [moved] = arr.splice(fromIdx, 1)
  arr.splice(toIdx, 0, moved)
  return arr
}

export interface ReorderViewFieldsParams {
  fromId: string
  toId: string
  /** True iff personal views are enabled AND the active view's personal toggle is ON. */
  isPersonal: boolean
  viewId: string
  /** grid.fields.value — the shared field list (drives shared `field.order`). */
  sharedFields: readonly MetaField[]
  /** grid.visibleFields ids — the user-visible order the personal drag reorders. */
  visibleFieldIds: readonly string[]
  client: ReorderClient
  /** Apply the shared reorder locally (grid.fields.value = arr). */
  onSharedOrder: (fields: MetaField[]) => void
  /** Apply the personal reorder locally, optimistically (grid.fieldOrder.value = ids). */
  onPersonalOrder: (ids: string[]) => void
}

export async function reorderViewFields(params: ReorderViewFieldsParams): Promise<void> {
  if (params.isPersonal) {
    // --- Personal path (constraint 1: NEVER updateField; constraint 2: preserve other facets) ---
    const order = moveWithin(params.visibleFieldIds, params.fromId, params.toId)
    if (!order) return
    params.onPersonalOrder(order) // optimistic — the grid re-renders columns immediately
    // Constraint 2 write goes through the SINGLE shared read-merge-write entry point (fail-closed on non-404).
    // One implementation of "merge this patch over the actor's current personal config" serves both the reorder
    // path and the in-place facet edits — so the fail-closed guard can never drift on just one side (post-3c/3d
    // dedup; see utils/personal-config-write.ts).
    await writePersonalConfigMerged(params.client, params.viewId, { fieldOrder: order })
    return
  }

  // --- Shared path (unchanged from pre-3c: reorder all fields, persist each field.order) ---
  const arr = [...params.sharedFields]
  const fromIdx = arr.findIndex((f) => f.id === params.fromId)
  const toIdx = arr.findIndex((f) => f.id === params.toId)
  if (fromIdx < 0 || toIdx < 0) return
  const [moved] = arr.splice(fromIdx, 1)
  arr.splice(toIdx, 0, moved)
  params.onSharedOrder(arr)
  await Promise.all(arr.map((field, index) => params.client.updateField(field.id, { order: index }))).catch(() => {})
}
