/**
 * Display-pref view.config helpers (persist-display-prefs arc, 2026-06-16).
 *
 * Promotes three previously client-only display prefs into the SHARED, server-persisted
 * `view.config` JSON, alongside `frozenLeftColumnIds`/`aggregations`:
 *   - `columnWidths`  (was localStorage in the grid composable)
 *   - `rowDensity`    (was an in-memory ref on the workbench)
 *   - `groupCollapse` (was an in-memory Set inside MetaGridTable)
 *
 * `view.config` is freeform JSON (`Record<string, unknown>`); every reader here is a NARROW,
 * defensive parser (mirrors `parseFrozenIds`): dirty/invalid config can never reach layout/offset
 * math — it degrades to the documented default. Backward-compat: an ABSENT config key yields the
 * current pre-arc default ({} widths / 'normal' density / no collapse).
 *
 * The backend PATCH /views/:viewId does a WHOLE-REPLACE of config, so every WRITE must spread the
 * full existing config. The merge builders below take the authoritative LOCAL pref value and the
 * (possibly stale) existing config and produce the next config with ONLY that one key replaced — so
 * a burst of same-pref writes (resize drag / collapse spree) is immune to a stale `activeView.config`
 * read between writes, and sibling keys (frozen/aggregations/conditional-formatting) are preserved.
 */
import type { RowDensity } from '../types'

const ROW_DENSITIES: readonly RowDensity[] = ['compact', 'normal', 'expanded']

/** Default row density when config is absent/invalid — matches the pre-arc in-memory ref default. */
export const DEFAULT_ROW_DENSITY: RowDensity = 'normal'

/** Scoped group-collapse state: collapse keys are only meaningful under the field they were authored on. */
export interface GroupCollapseConfig {
  /** The level-1 groupField id the collapsedKeys belong to. Undefined = legacy/empty (never applies). */
  fieldId?: string
  /**
   * The ORDERED group field ids (nested grouping) the collapsedKeys belong to. The collapse keys are
   * COMPOSITE path keys built from these levels in order, so a stale set authored on a DIFFERENT ordered
   * field list (regroup OR reorder) must NOT apply. Undefined for legacy single-field-only configs; the
   * single-field `fieldId` stays as a level-1 fallback so pre-nested configs keep collapsing.
   */
  fieldIds?: string[]
  /** Collapsed group keys (composite per-level paths joined by NUL; single-level = the bare value key). */
  collapsedKeys: string[]
}

const EMPTY_GROUP_COLLAPSE: GroupCollapseConfig = { collapsedKeys: [] }

/**
 * `config.columnWidths` → `Record<fieldId, number>`. Strict: only an object whose values are
 * finite positive numbers passes; any non-finite / non-positive / non-number entry is dropped.
 * Non-object input → {}.
 */
export function parseColumnWidths(config: Record<string, unknown> | null | undefined): Record<string, number> {
  const value = config?.columnWidths
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof k !== 'string' || !k) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue
    out[k] = v
  }
  return out
}

/** `config.rowDensity` → `RowDensity`. Anything outside the union → `'normal'`. */
export function parseRowDensity(config: Record<string, unknown> | null | undefined): RowDensity {
  const value = config?.rowDensity
  return ROW_DENSITIES.includes(value as RowDensity) ? (value as RowDensity) : DEFAULT_ROW_DENSITY
}

/**
 * `config.groupCollapse` → `{ fieldId?, fieldIds?, collapsedKeys }`. Strict: requires an object with a
 * string[] `collapsedKeys`; `fieldId` is carried only if it is a non-empty string; `fieldIds` is carried
 * ONLY when it is a non-empty array of non-empty strings (otherwise omitted entirely, never `[]`).
 * Anything else → `{ collapsedKeys: [] }`.
 */
export function parseGroupCollapse(config: Record<string, unknown> | null | undefined): GroupCollapseConfig {
  const value = config?.groupCollapse
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...EMPTY_GROUP_COLLAPSE }
  const obj = value as Record<string, unknown>
  const rawKeys = obj.collapsedKeys
  if (!Array.isArray(rawKeys) || !rawKeys.every((x) => typeof x === 'string')) return { ...EMPTY_GROUP_COLLAPSE }
  const fieldId = typeof obj.fieldId === 'string' && obj.fieldId ? obj.fieldId : undefined
  const rawFieldIds = obj.fieldIds
  const fieldIds = Array.isArray(rawFieldIds) && rawFieldIds.length > 0 && rawFieldIds.every((x) => typeof x === 'string' && x)
    ? (rawFieldIds as string[])
    : undefined
  const out: GroupCollapseConfig = { collapsedKeys: rawKeys as string[] }
  if (fieldId) out.fieldId = fieldId
  if (fieldIds) out.fieldIds = fieldIds
  return out
}

/**
 * Resolve the collapsed-group keys that ACTUALLY apply for the currently-grouped field. Stale-key
 * guard: a saved collapse set is ignored unless it was authored on the active groupField — otherwise
 * a leftover set would wrongly collapse unrelated groups after the user regroups. No active
 * groupField → nothing collapses.
 */
export function resolveActiveCollapsedKeys(
  config: Record<string, unknown> | null | undefined,
  activeGroupFieldId: string | null | undefined,
): string[] {
  if (!activeGroupFieldId) return []
  const parsed = parseGroupCollapse(config)
  return parsed.fieldId === activeGroupFieldId ? parsed.collapsedKeys : []
}

/**
 * Nested-grouping variant of the stale-key guard. Collapse keys are COMPOSITE paths built from the
 * ORDERED group field ids, so a saved set applies only when it was authored on the EXACT same ordered
 * list (a regroup OR a reorder invalidates it — composite paths would otherwise collapse the wrong
 * groups). Back-compat: a config saved before nested grouping has no `fieldIds`, only a single `fieldId`;
 * it applies iff the active grouping is that one field (single-level), so pre-nested collapse survives.
 * No active group fields → nothing collapses.
 */
export function resolveActiveCollapsedKeysForFields(
  config: Record<string, unknown> | null | undefined,
  activeGroupFieldIds: readonly string[] | null | undefined,
): string[] {
  const active = activeGroupFieldIds ?? []
  if (active.length === 0) return []
  const parsed = parseGroupCollapse(config)
  if (parsed.fieldIds) {
    return arraysEqual(parsed.fieldIds, active) ? parsed.collapsedKeys : []
  }
  // legacy single-field config: applies only to a single-level grouping by that same field
  return parsed.fieldId && active.length === 1 && active[0] === parsed.fieldId ? parsed.collapsedKeys : []
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/** Merge `columnWidths` into existing config, preserving every sibling key (whole-replace-safe). */
export function mergeColumnWidths(
  existing: Record<string, unknown> | null | undefined,
  columnWidths: Record<string, number>,
): Record<string, unknown> {
  return { ...(existing ?? {}), columnWidths }
}

/** Merge `rowDensity` into existing config, preserving every sibling key. */
export function mergeRowDensity(
  existing: Record<string, unknown> | null | undefined,
  rowDensity: RowDensity,
): Record<string, unknown> {
  return { ...(existing ?? {}), rowDensity }
}

/** Merge scoped `groupCollapse` into existing config, preserving every sibling key. */
export function mergeGroupCollapse(
  existing: Record<string, unknown> | null | undefined,
  groupCollapse: GroupCollapseConfig,
): Record<string, unknown> {
  return { ...(existing ?? {}), groupCollapse }
}
