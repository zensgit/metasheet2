import type { PersonalViewConfigOverlay } from '../types'

/**
 * Slice 3d — additive personal-config writes.
 *
 * The backend `PUT /views/:id/personal-config` REPLACES the whole row (upsertPersonalViewConfig does
 * `DO UPDATE SET config = $3`). So sending only the edited facet (e.g. `{ sortInfo }`) would WIPE the actor's
 * other personal facets (filter/group/hidden/fieldOrder). This read-merge-write reads the current personal
 * config, merges the patch over it, and writes the whole thing back — a single-facet edit preserves the rest.
 *
 * Clearing still works: a patch facet set to `undefined` overrides the base value, and since `JSON.stringify`
 * drops `undefined`, the backend receives no such key and its `sanitizePersonalOverlayConfig` omits it — i.e.
 * the facet is cleared, while facets ABSENT from the patch (never mentioned) are preserved from `base`.
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
