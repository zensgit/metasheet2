import type { PersonalViewConfigOverlay } from '../types'

/**
 * Slice 3d — additive personal-config writes.
 *
 * The backend `PUT /views/:id/personal-config` REPLACES the whole row (upsertPersonalViewConfig does
 * `DO UPDATE SET config = $3`). So sending only the edited facet (e.g. `{ sortInfo }`) would WIPE the actor's
 * other personal facets (filter/group/hidden/fieldOrder). This read-merge-write reads the current personal
 * config, merges the patch over it, and writes the whole thing back — a single-facet edit preserves the rest.
 *
 * Clearing a facet: this generic helper still accepts a patch facet set to `undefined` — since
 * `JSON.stringify` drops `undefined`-valued keys, the backend never receives that key, and its
 * `sanitizePersonalOverlayConfig` omits it from what gets stored, so the facet is REMOVED from the
 * personal row (falling back to the shared view's value). Facets ABSENT from the patch (never
 * mentioned) are separately preserved from `base`, same as always.
 *
 * BUT no current caller actually clears this way: the toolbar's clear actions for sort/filter (#6075)
 * and grouping (#6110) all send an explicit EMPTY value instead (`{ rules: [] }`,
 * `{ conjunction, conditions: [] }`, `{}` for groupInfo) — so a cleared facet PUTs as an explicit
 * "no rule for me" personal override, not a removal that reverts to whatever the shared view has. The
 * `undefined` shape above remains a real, tested capability of this merge helper (see
 * multitable-grid-personal-additive-write.spec.ts's `{ filterInfo: undefined }` case) — it just is not
 * how sort/filter/group are cleared today.
 *
 * Mirrors the read-merge-write already used by the column-reorder path (utils/reorder-view-fields.ts).
 */
export interface PersonalConfigWriteClient {
  getPersonalViewConfig(viewId: string): Promise<{ config: PersonalViewConfigOverlay | null }>
  putPersonalViewConfig(viewId: string, overlay: PersonalViewConfigOverlay): Promise<unknown>
}

export async function writePersonalConfigMerged(
  client: PersonalConfigWriteClient,
  viewId: string,
  patch: PersonalViewConfigOverlay,
): Promise<void> {
  let base: PersonalViewConfigOverlay = {}
  try {
    // A view with no personal row yet returns { config: null } (row created lazily on first write).
    base = (await client.getPersonalViewConfig(viewId))?.config ?? {}
  } catch (err) {
    // FAIL-CLOSED: only a 404 (no row / flag off / view gone) is a safe "start from empty". Any OTHER
    // failure (500 / network / transient auth) must NOT proceed — writing { ...{}, ...patch } would REPLACE
    // the row and wipe the actor's other personal facets (the very thing this helper exists to prevent).
    if ((err as { status?: number } | null)?.status !== 404) throw err
    base = {}
  }
  await client.putPersonalViewConfig(viewId, { ...base, ...patch })
}
