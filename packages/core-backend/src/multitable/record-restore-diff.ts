import type { RecordChange } from './record-write-service'

/**
 * The CANONICAL record-version restore diff — the single source the three restore routes share (`/restore`,
 * `restore-preview` T5-2, `restore-execute` T6-2). Pure: a DIFF PRODUCER, never a permission authority. It makes
 * no permission decision and reads no permission state; masking / schema-drift / row-deny / write-gate /
 * expectedVersion all stay in the routes (each route filters this raw diff with its own allowed set).
 *
 * Design-lock: docs/development/multitable-restore-diff-unify-designlock-20260621.md. This is a RECONCILIATION of
 * three independently-written implementations that mostly agreed; the one divergence (link equality) is resolved
 * to the robust `/restore` set-compare below (the two newer paths previously used a `.join(' ')` form that
 * collides on space-bearing ids; canonical = robust, so the shipped write path stays byte-identical).
 */

// Non-restorable field types: computed / system-auto / link / attachment / button are not scalar-restorable.
const NON_RESTORABLE_TYPES = new Set([
  'formula', 'lookup', 'rollup', 'link', 'attachment', 'button',
  'autoNumber', 'createdTime', 'modifiedTime', 'createdBy', 'modifiedBy',
])
const isRestorableType = (t: string): boolean => !NON_RESTORABLE_TYPES.has(t)
const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * CANONICAL link-set equality: order-insensitive, with NO delimiter collision. (`['a','b c']` and `['a b','c']` are
 * DISTINCT but a `.sort().join(' ')` form collides both to `'a b c'`; reachable only if a link id itself contains
 * a space — e.g. the legacy `normalizeLinkIds` parse of `'a,b c'` → `['a','b c']` vs `'a b,c'` → `['a b','c']`.) Exported only so a golden can pin it through the public
 * helper; routes use `computeRecordRestoreDiff`, not this directly.
 */
export function canonicalSameLinkSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((v, i) => v === sb[i])
}

export interface RestoreDiffInput {
  /** field id → guard; only `guard.type` is read (ReadonlyMap so a `Map<string, FieldMutationGuard>` is assignable). */
  fieldById: ReadonlyMap<string, { type: string }>
  /** field id → raw DB type; used to exclude the no-value `button` trigger (which `mapFieldType` folds to string). */
  rawTypeById: ReadonlyMap<string, string>
  targetSnapshot: Record<string, unknown>
  currentData: Record<string, unknown>
  recordId: string
  currentVersion: number
  /** the route's canonical link-id parser (injected to avoid a route↔helper import cycle; all three pass the same one). */
  normalizeLinkIds: (value: unknown) => string[]
}

/**
 * The faithful set ∪ unset diff over restorable fields. Link fields emit a SET of the normalized id array (routed
 * through patchRecords, which re-syncs meta_links) — never a data-`unset` — and only when the id set actually
 * differs (canonical set-equality). Scalar fields: SET when present-and-different, UNSET when absent-from-snapshot
 * but present-in-current. The `button` no-value trigger and all non-restorable types are skipped.
 */
export function computeRecordRestoreDiff(input: RestoreDiffInput): RecordChange[] {
  const { fieldById, rawTypeById, targetSnapshot, currentData, recordId, currentVersion, normalizeLinkIds } = input
  const diff: RecordChange[] = []
  for (const [fid, guard] of fieldById.entries()) {
    if (rawTypeById.get(fid) === 'button') continue
    const inSnap = Object.prototype.hasOwnProperty.call(targetSnapshot, fid)
    const inCur = Object.prototype.hasOwnProperty.call(currentData, fid)
    if (guard.type === 'link') {
      const target = inSnap ? normalizeLinkIds(targetSnapshot[fid]) : []
      if (!canonicalSameLinkSet(normalizeLinkIds(currentData[fid]), target)) {
        diff.push({ recordId, fieldId: fid, value: target, expectedVersion: currentVersion, op: 'set' })
      }
      continue
    }
    if (!isRestorableType(guard.type)) continue
    if (inSnap) {
      if (!sameValue(currentData[fid], targetSnapshot[fid])) {
        diff.push({ recordId, fieldId: fid, value: targetSnapshot[fid], expectedVersion: currentVersion, op: 'set' })
      }
    } else if (inCur) {
      diff.push({ recordId, fieldId: fid, value: null, expectedVersion: currentVersion, op: 'unset' })
    }
  }
  return diff
}
