/**
 * 4c-1 lossy / value-transform retype revert — LOSS ORACLE (design-lock 2026-07-07 #3812 §2.2; owner-ratified
 * 2026-07-08, R6 decision record §1/§2).
 *
 * The load-bearing fact the design-lock rests on: **today's runtime has NO value-level lossy/lossless judgement
 * anywhere.** The forward `PATCH /fields` retype does not migrate cell values at all (raw `UPDATE meta_fields`),
 * and the shipped Tier-2 retype revert is symmetric with it — schema-only, provably lossless. This module is the
 * net-new thing: a PURE, READ-ONLY dry run that answers "if we set this field's config back to `before`, what
 * happens to every stored cell?" by replaying the SAME codec the record write path uses (`coerceBatch1Value`),
 * and bucketing each cell into `unchanged` / `coerced` / `dropped`. It writes nothing.
 *
 * ── ENVELOPE (fail-closed; see /tmp/4c1-envelope-ambiguity.md and the PR body's "信封歧义与所取读法") ──────────
 * §2.1's first clause ("type reverts other than scalar↔scalar whose TARGET (`before`) type is still a plain
 * scalar") is ambiguous: read literally it admits reverts whose CURRENT (`after`) type is an EXCLUDED type
 * (formula, lookup, rollup, link, attachment, button, autoNumber, createdTime/modifiedTime/createdBy/modifiedBy).
 * That reading is unsafe on two independent counts, so it is REFUSED here:
 *
 *   (1) `applyConfigRevert` is a raw `UPDATE meta_fields`. It skips the forward PATCH's type-transition
 *       side-effect handlers (auto-number sequence teardown, `meta_links` join-table, formula dependency graph),
 *       which is exactly why the shipped `isSupportedFieldRetypeRevert` requires BOTH endpoints to be plain
 *       scalars (`config-restore.ts` — "it needs those handlers — a separate slice"). The design-lock's own
 *       justification for excluding the target side ("派生/物化语义 … 有独立副作用面") applies verbatim to the
 *       SOURCE side; the lock simply does not say so.
 *   (2) `coerceBatch1Value` is the IDENTITY function for every non-Batch-1 type. So a `link → text` revert would
 *       have the oracle report "zero loss" while execute leaves link-object arrays sitting in a text column —
 *       silent corruption that the safety device itself would have signed off on.
 *
 * So the v1 envelope is §2.1's SECOND clause only, narrowed to the types the oracle can actually reason about:
 *
 *     entity_type='field' ∧ action='update'
 *   ∧ changed_keys ⊆ {name, order, property} ∧ 'property' ∈ changed_keys   (i.e. NO 'type' key)
 *   ∧ the field's LIVE type ∈ BATCH1_FIELD_TYPES                            (⇒ ∉ FIELD_RETYPE_EXCLUDED_TYPES)
 *
 * This is DISJOINT from the shipped Tier-2 predicate (`isSupportedFieldRetypeRevert` requires a `type` change),
 * so a scalar-safe type revert keeps its schema-only, zero-value-rewrite path even with the lossy flag on
 * (design-lock §4 L2, regression protection). Everything else keeps today's behavior byte-for-byte: `gated`
 * preview + 422 execute (property-only reverts are explicitly deferred by `config-restore.ts`), or 403 when the
 * base Tier-2 flag is off.
 *
 * Widening the envelope (source-side excluded types; coercing within the scalar-safe subset; non-Batch-1 property
 * reverts such as a `singleSelect` option removal) each require a SEPARATE owner sign-off and additional
 * engineering — see the PR body §"若 owner 想放宽".
 *
 * ── NO-ORACLE (U-L8) ────────────────────────────────────────────────────────────────────────────────────────
 * This module deliberately has NO notion of actor, permission, or visibility. Per the owner's 2026-07-08 ruling
 * the caller applies a FULL-READ GATE: an actor who cannot read every record × field of the sheet gets a blanket
 * 403 on both preview and execute. There is therefore no scoped counting mode and no `undisclosedPresent` marker
 * (the design-lock's alternative (ii) is void) — a count computed here is always over the whole table.
 */
import { BATCH1_FIELD_TYPES, coerceBatch1Value } from './field-codecs'
import type { ConfigRevisionRow } from './config-restore'

export type LossBucket = 'unchanged' | 'coerced' | 'dropped'

/** The three-bucket loss magnitude. Over the WHOLE table (the caller's full-read gate guarantees it). */
export interface LossSummary {
  unchanged: number
  coerced: number
  dropped: number
}

export interface CellLossOutcome {
  recordId: string
  bucket: LossBucket
  /** the cell's CURRENT stored value (the pre-image 4c-2 captures when the bucket is coerced/dropped). */
  before: unknown
  /** the value the revert would write. `null` for `dropped`. */
  after: unknown
}

/** Keys a property-only field revert may touch. `type` is deliberately absent — see the envelope note above. */
const LOSSY_RETYPE_REVERT_KEYS: ReadonlySet<string> = new Set(['name', 'order', 'property'])

/**
 * STRUCTURAL half of the envelope (pure on `rev`, mirrors the Tier-1/2/3/4 predicate pattern; `classifyRevert`
 * stays untouched and keeps returning `gated` for these — the ROUTE opens the window). Disjoint from
 * `isSupportedFieldRetypeRevert` by construction: that one REQUIRES a `type` change, this one FORBIDS it.
 */
export function isLossyPropertyRetypeRevertShape(rev: Pick<ConfigRevisionRow, 'entity_type' | 'action' | 'changed_keys'>): boolean {
  return (
    rev.entity_type === 'field' &&
    rev.action === 'update' &&
    Array.isArray(rev.changed_keys) &&
    rev.changed_keys.length > 0 &&
    rev.changed_keys.every((k) => LOSSY_RETYPE_REVERT_KEYS.has(k)) &&
    rev.changed_keys.includes('property')
  )
}

/**
 * TYPE half of the envelope: only the Batch-1 codec types have a real per-type loss oracle. For any other type
 * `coerceBatch1Value` is the identity function, so admitting them would mean reporting "zero loss" for genuinely
 * lossy property changes (a `singleSelect` option removal, a rich-`longText` toggle). Fail-closed → they stay 422.
 */
export function isLossyRetypeSupportedFieldType(liveType: string): boolean {
  return BATCH1_FIELD_TYPES.has(liveType)
}

/**
 * DOUBLE GATE (§2.1): the lossy surface needs BOTH its own flag AND the base Tier-2 flag. Encoding both here is
 * defense-in-depth — the route also 403s the whole surface when the base flag is off, BEFORE this is consulted,
 * which is what makes "base off ⇒ 403 (not 422)" hold. Both default OFF ⇒ this returns false ⇒ the lossy branch
 * is never entered ⇒ every pre-existing response is byte-for-byte unchanged (C1).
 */
export function isLossyRetypeRevertEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY === 'true' &&
    env.MULTITABLE_ENABLE_FIELD_RETYPE_REVERT === 'true'
  )
}

/**
 * Canonical, key-order-independent serialization for the unchanged/changed decision. Postgres hands back jsonb
 * object keys in ITS order while the codec rebuilds objects in JS insertion order (`location` is the live case:
 * `{address, latitude, longitude}`), so a plain `JSON.stringify` compare would spuriously call an identical value
 * `coerced` and inflate the loss magnitude bound into the preview token.
 */
function canonicalize(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (v === undefined) return null
    if (Array.isArray(v)) return v.map(norm)
    if (v !== null && typeof v === 'object') {
      const src = v as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(src).sort()) out[k] = norm(src[k])
      return out
    }
    return v
  }
  return JSON.stringify(norm(value) ?? null)
}

/**
 * The per-cell oracle. Replays the record-write-path codec with the config being RESTORED (`before`):
 *   • the codec throws           → `dropped` (value not representable under the reverted-to property → emptied)
 *   • the codec empties a value  → `dropped` (e.g. `''`/whitespace → null: the cell ends up empty though it wasn't)
 *   • the result is canonically equal to the stored value → `unchanged`
 *   • otherwise                  → `coerced` (representable, but rewritten)
 * The "empties a value" arm is deliberately classified `dropped` rather than `coerced`: the preview's scary
 * number should count every cell that ends up empty, whichever way it got there (fail-closed messaging).
 */
export function classifyCellLoss(
  fieldType: string,
  property: Record<string, unknown> | undefined,
  fieldId: string,
  value: unknown,
): { bucket: LossBucket; next: unknown } {
  let next: unknown
  try {
    next = coerceBatch1Value(fieldType, property, fieldId, value)
  } catch {
    return { bucket: 'dropped', next: null }
  }
  if (canonicalize(next) === canonicalize(value)) return { bucket: 'unchanged', next: value }
  const emptied = (next === null || next === undefined) && value !== null && value !== undefined
  return { bucket: emptied ? 'dropped' : 'coerced', next: next ?? null }
}

/**
 * Dry-run every cell. `cells` must be exactly the records whose `data` CARRIES the field's key — a record with no
 * cell for this field has nothing to lose and is not counted in any bucket (it is still counted against the
 * write-symmetric record cap by the caller, which bounds the SCAN, not the transform).
 */
export function computeLossOutcomes(
  cells: ReadonlyArray<{ recordId: string; value: unknown }>,
  fieldType: string,
  property: Record<string, unknown> | undefined,
  fieldId: string,
): CellLossOutcome[] {
  return cells.map((cell) => {
    const { bucket, next } = classifyCellLoss(fieldType, property, fieldId, cell.value)
    return { recordId: cell.recordId, bucket, before: cell.value, after: next }
  })
}

export function summarizeLoss(outcomes: ReadonlyArray<CellLossOutcome>): LossSummary {
  const summary: LossSummary = { unchanged: 0, coerced: 0, dropped: 0 }
  for (const outcome of outcomes) summary[outcome.bucket] += 1
  return summary
}

/**
 * §3 honesty clause: with no 4c-2 pre-image anchored to a PRIOR lossy revert of this field, the value transform is
 * a RE-COERCION under the restored config, NOT a recovery of the values that existed before the forward change.
 * The preview must say so. (The pre-image this execute captures is what lets a LATER revert-of-revert recover the
 * true values — the first lossy revert always faces the current values.)
 */
export const LOSSY_RETYPE_PREVIEW_NOTE =
  'Reverting this field configuration RE-INTERPRETS every stored cell under the restored configuration: ' +
  'values that cannot be represented are emptied, and values that can be are rewritten in the restored format. ' +
  'This is an approximate restore (a re-formatting), NOT a recovery of the original values. ' +
  'Each changed cell is written as a record revision, so this revert can itself be undone per record.'
