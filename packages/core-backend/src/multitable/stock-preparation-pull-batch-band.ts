/**
 * 批次标识 (pull batch) — the HOST half of the band contract (design batch-id design-final §4.1; ADR
 * adr-stock-prep-manual-rows-20261030 §5.5; register row R-65, coordinator rulings C1 / C10).
 *
 * THE CONTRACT. The plugin creates two `string` columns on a stock-prep project sheet (首次批次 / 本次拉取) and writes,
 * in the same `ensureMissingObjectFields` call, the property
 *
 *     { humanWriteLock: 'plm_system', stockPreparationPullBatch: { band: 'v1', manualLabel } }
 *
 * with `manualLabel` ∈ {'人工补充', 'Manual row'} (the sheet's own label locale, which lives in the plugin DB). The host
 * never knows the two column ids: it finds them by this marker. When a person creates a manual supplementary row on such
 * a sheet, the host writes `manualLabel` into BOTH band cells, in the same INSERT (record-service.ts createRecord, the
 * manual-row branch), from the field rows that transaction already read — no extra statement.
 *
 * FORGE / DROP HARDENING.
 *   - A band column must carry the human write lock too. Only plugin provisioning can set the lock (a person route
 *     strips it, a sheet copy drops it), so a marker a person managed to put on a column of their own is NOT a band
 *     column: it is ignored, and it cannot break a real band either (it is not counted).
 *   - `POST /fields` strips a client-supplied marker (`stripPullBatchBandMarker`); `PATCH /fields/:fieldId` and the field
 *     config revert carry the STORED marker over whatever the body / revision says (`carryPullBatchBandMarker`), so a
 *     person can neither set, change nor drop it — the same rule as the lock and the manual-rows switch.
 *
 * SWITCH-INDEPENDENT (C10). The label is written whenever a sheet carries the band, whatever
 * `STOCK_PREP_PULL_BATCH_ENABLED` says: it is not ledger IO. No sheet carries a band until an owner-approved install or a
 * birth with that switch on, so on every sheet today this module finds nothing and the create is byte-identical.
 *
 * FAIL-SOFT. Any band shape other than exactly two consistent marker columns ⇒ no band cell is written; the manual row is
 * still created (the plugin's install backfill writes 人工补充 into blank band cells later).
 *
 * Pure; no IO. Imports only human-write-lock.ts (a leaf), so record-service / config-restore / the routes can use it
 * without a load cycle. Kept out of stock-preparation-manual-rows.ts on purpose (other open work edits that file).
 */
import { humanWriteLockKindOfProperty } from './human-write-lock'

export const PULL_BATCH_BAND_PROPERTY_KEY = 'stockPreparationPullBatch' as const
export const PULL_BATCH_BAND_MARKER = 'v1' as const
/** The only labels the host writes. Exact match; anything else is not a band. */
export const PULL_BATCH_MANUAL_LABELS: readonly string[] = Object.freeze(['人工补充', 'Manual row'])
/** The column type the band uses. */
export const PULL_BATCH_BAND_FIELD_TYPE = 'string' as const

export type PullBatchBandMarker = Readonly<{ band: typeof PULL_BATCH_BAND_MARKER; manualLabel: string }>
export type PullBatchBandStamp = Readonly<{ fieldIds: readonly [string, string]; label: string }>

function asPropertyObject(property: unknown): Record<string, unknown> | null {
  if (property && typeof property === 'object' && !Array.isArray(property)) return property as Record<string, unknown>
  if (typeof property === 'string' && property.trim()) {
    try {
      const parsed = JSON.parse(property)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      return null
    }
  }
  return null
}

const hasOwn = (obj: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(obj, key)

/** The well-formed marker a raw or sanitized property carries (`band === 'v1'` and a known label), or null. */
export function pullBatchBandMarkerOf(property: unknown): PullBatchBandMarker | null {
  const obj = asPropertyObject(property)
  if (!obj || !hasOwn(obj, PULL_BATCH_BAND_PROPERTY_KEY)) return null
  const marker = obj[PULL_BATCH_BAND_PROPERTY_KEY]
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null
  const { band, manualLabel } = marker as Record<string, unknown>
  if (band !== PULL_BATCH_BAND_MARKER) return null
  if (typeof manualLabel !== 'string' || !PULL_BATCH_MANUAL_LABELS.includes(manualLabel)) return null
  return Object.freeze({ band: PULL_BATCH_BAND_MARKER, manualLabel })
}

/** Does the property carry the marker KEY at all (any value)? What strip / carry act on. */
export function hasPullBatchBandMarkerKey(property: unknown): boolean {
  const obj = asPropertyObject(property)
  return obj !== null && hasOwn(obj, PULL_BATCH_BAND_PROPERTY_KEY) && obj[PULL_BATCH_BAND_PROPERTY_KEY] !== undefined
}

/**
 * Is this field row a band column? ALL of: type `string`, the human write lock `plm_system` (which only plugin
 * provisioning can set — the forge hardening), and a well-formed marker.
 */
export function isPullBatchBandField(row: { type?: unknown; property?: unknown } | null | undefined): boolean {
  if (!row || row.type !== PULL_BATCH_BAND_FIELD_TYPE) return false
  if (humanWriteLockKindOfProperty(row.property) !== 'plm_system') return false
  return pullBatchBandMarkerOf(row.property) !== null
}

/**
 * The manual-row band stamp for a sheet, from its field rows: exactly two band columns with the SAME label ⇒
 * `{ fieldIds, label }` (field-row order); any other shape (none, one, three, two different labels) ⇒ null.
 * A column carrying the marker without the lock is not a band column and is not counted.
 */
export function pullBatchBandStampOf(
  fieldRows: ReadonlyArray<{ id?: unknown; type?: unknown; property?: unknown }> | null | undefined,
): PullBatchBandStamp | null {
  if (!Array.isArray(fieldRows)) return null
  const ids: string[] = []
  const labels = new Set<string>()
  for (const row of fieldRows) {
    if (!isPullBatchBandField(row) || typeof row.id !== 'string' || !row.id) continue
    ids.push(row.id)
    labels.add((pullBatchBandMarkerOf(row.property) as PullBatchBandMarker).manualLabel)
  }
  if (ids.length !== 2 || ids[0] === ids[1] || labels.size !== 1) return null
  return Object.freeze({ fieldIds: Object.freeze([ids[0], ids[1]] as [string, string]), label: [...labels][0] })
}

/** The person field-write entry (`POST /fields`, `PATCH /fields/:fieldId`): a person can never SET the marker. */
export function stripPullBatchBandMarker(property: Record<string, unknown>): Record<string, unknown> {
  if (!hasOwn(property, PULL_BATCH_BAND_PROPERTY_KEY)) return property
  const { [PULL_BATCH_BAND_PROPERTY_KEY]: _dropped, ...rest } = property
  return rest
}

/**
 * `PATCH /fields/:fieldId` (both the unlocked read and the locked re-read) and the field config revert: whatever the
 * body / revision said (set, cleared, changed or omitted), the STORED marker is carried onto the next property verbatim;
 * a field without one gets none. The lock is carried by its own rule from the same stored row.
 */
export function carryPullBatchBandMarker(storedProperty: unknown, nextProperty: Record<string, unknown>): Record<string, unknown> {
  const next = stripPullBatchBandMarker(nextProperty)
  if (!hasPullBatchBandMarkerKey(storedProperty)) return next
  const stored = (asPropertyObject(storedProperty) as Record<string, unknown>)[PULL_BATCH_BAND_PROPERTY_KEY]
  return { ...next, [PULL_BATCH_BAND_PROPERTY_KEY]: structuredClone(stored) }
}
