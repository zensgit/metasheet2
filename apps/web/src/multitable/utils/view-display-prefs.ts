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
  /** The groupField id the collapsedKeys belong to. Undefined = legacy/empty (never applies). */
  fieldId?: string
  /** Collapsed group keys (the same `String(value)`/`__ungrouped__` keys MetaGridTable groups by). */
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
 * `config.groupCollapse` → `{ fieldId?, collapsedKeys }`. Strict: requires an object with a
 * string[] `collapsedKeys`; `fieldId` is carried only if it is a non-empty string. Anything else
 * → `{ collapsedKeys: [] }`.
 */
export function parseGroupCollapse(config: Record<string, unknown> | null | undefined): GroupCollapseConfig {
  const value = config?.groupCollapse
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...EMPTY_GROUP_COLLAPSE }
  const obj = value as Record<string, unknown>
  const rawKeys = obj.collapsedKeys
  if (!Array.isArray(rawKeys) || !rawKeys.every((x) => typeof x === 'string')) return { ...EMPTY_GROUP_COLLAPSE }
  const fieldId = typeof obj.fieldId === 'string' && obj.fieldId ? obj.fieldId : undefined
  return { fieldId, collapsedKeys: rawKeys as string[] }
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
