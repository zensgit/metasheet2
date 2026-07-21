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

/**
 * Canonical restorable projection for a live row (W0-1 v3.7 §2 non-restorable + T6 restore-diff unify).
 *
 * Applies ONLY the true restorable delta from `computeRecordRestoreDiff` onto a SHALLOW COPY of
 * `currentData`. Formula/lookup/rollup/autoNumber/system/attachment/button materializations and any
 * other non-restorable key present live are PRESERVED (never overwritten from the at-anchor snapshot).
 * Link fields that actually change appear in `linkUpdates` so the caller can keep `meta_links` consistent
 * with `data` (link reads use meta_links). A derived-only / restorable-no-op difference yields
 * `isNoOp: true` with empty patch/changedFieldIds/linkUpdates — the caller must not version-bump,
 * revise, or write links.
 */
export interface RestorableProjection {
  /** live data with only restorable fields projected from the target snapshot. */
  data: Record<string, unknown>
  /** revision patch: set values or null for unset — ONLY true restorable delta keys. */
  patch: Record<string, unknown>
  /** field ids in `patch` order. */
  changedFieldIds: string[]
  /** changed writable-forward link fields → deduped target id arrays (for meta_links sync). */
  linkUpdates: Array<{ fieldId: string; targetIds: string[] }>
  /** true when no restorable field differs — no write should occur. */
  isNoOp: boolean
}

/** Order-preserving dedupe of link target ids (shared by data / patch / meta_links). */
export function canonicalDedupeLinkIds(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

export function projectRestorableOntoLive(input: RestoreDiffInput): RestorableProjection {
  const changes = computeRecordRestoreDiff(input)
  if (changes.length === 0) {
    return {
      data: { ...input.currentData },
      patch: {},
      changedFieldIds: [],
      linkUpdates: [],
      isNoOp: true,
    }
  }
  const data: Record<string, unknown> = { ...input.currentData }
  const patch: Record<string, unknown> = {}
  const changedFieldIds: string[] = []
  const linkUpdates: Array<{ fieldId: string; targetIds: string[] }> = []
  for (const c of changes) {
    changedFieldIds.push(c.fieldId)
    if (c.op === 'unset') {
      delete data[c.fieldId]
      patch[c.fieldId] = null
      continue
    }
    if (input.fieldById.get(c.fieldId)?.type === 'link') {
      const raw = Array.isArray(c.value)
        ? (c.value as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0)
        : input.normalizeLinkIds(c.value)
      // ONE canonical array for data, patch, and meta_links — no data/meta_links divergence.
      const deduped = canonicalDedupeLinkIds(raw)
      data[c.fieldId] = deduped
      patch[c.fieldId] = deduped
      linkUpdates.push({ fieldId: c.fieldId, targetIds: deduped })
      continue
    }
    data[c.fieldId] = c.value
    patch[c.fieldId] = c.value
  }
  return { data, patch, changedFieldIds, linkUpdates, isNoOp: false }
}
