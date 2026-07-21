/**
 * W0-1 v3.7 Lane L7 — the EXACT-ANCHOR recovery PLAN (target-set classification for execute).
 *
 * Design authority: `…v37-exact-anchor-trust-design-lock-20260715.md` (#4331) §5 (execute = full
 * target/schema/set recomputation under the fence) + §9 item 3 (target-generation A) + item 5. Builds on
 * L6-b: the causal reconstructor already resolves each record's TARGET-GENERATION state at the exact
 * `anchorSeq` (a delete→recreate chain reconstructs to the generation whose window contains the anchor —
 * proven by the MULTI-GEN golden), so this layer's job is the remaining §5 semantics: classify the FULL
 * record set (live ∪ at-anchor, deleted/trash-aware) into the executable plan a destructive apply consumes.
 *
 * CLASSIFICATION (per record, target = as-of-anchorSeq state from `reconstructRecordsAtSeq`):
 *   target EXISTS + live row present  → REVERT candidate (live differs from target; identical rows skipped)
 *   target EXISTS + no live row       → RESURRECT candidate (deleted AFTER the anchor; carries the full
 *                                       at-anchor snapshot — never the trash row's terminal-vintage data)
 *   target DELETED (delete ≤ anchor) + live row → `deletedAtAnchorLiveNow` (the record was deleted as of the
 *                                       anchor but was later resurrected): Revert semantics KEEP it
 *                                       (non-destructive); Reset semantics delete it. The plan EXPOSES the
 *                                       list; the L8 caller picks — this module never chooses destruction.
 *   target DELETED + no live row      → unchanged (stays deleted; NEVER resurrected — LOCK-9).
 *   absent from stateMap + live row   → `createdAfterAnchor` (no revision ≤ anchor): Revert keeps, Reset
 *                                       deletes — exposed, caller picks.
 *
 * SCHEMA DRIFT (§5 "schema recomputation"): a target snapshot carrying a field id that no longer exists in
 * the CURRENT schema is EXCLUDED from the plan and counted in `driftCount` — re-inserting it would write a
 * stale field key into `meta_records.data`. SEMANTICS (owner P1-2 ruling 2026-07-17, superseding the F2
 * "honest partial" note): the L8 apply core treats `driftCount > 0` as a WHOLE-apply refusal
 * (`schema-drift`, zero writes, burn rolled back) — T-path parity; no partial-set apply is smuggled
 * through drift exclusion, and an EXPLICIT partial recovery is a future separate mode. This plan layer
 * still computes and exposes `driftCount` so a read-only preview can DISCLOSE the drift to the actor
 * before they ever mint/spend a token.
 *
 * LAYERING CONTRACT (deliberate, loud): this is the CORE set-classification only — it performs NO
 * permission masking, NO row-level-deny filtering, NO size ceilings, and NO fence acquisition. Those are
 * the HTTP/execute wiring's obligations (L8): the route must (a) run this UNDER the canonical fence,
 * (b) apply the actor's field mask + denied-record filter to what it returns/executes (the T-path's PIT-3
 * discipline), and (c) enforce SHEET_REVERT_MAX_RECORDS-class ceilings. Consuming this module without those
 * layers is NOT a production path. The W2 integration now supplies them from the four legacy
 * revert/reset routes; destructive execution remains default-OFF behind its route flags.
 * After retention has pruned raw revisions, production callers must also resolve the trusted checkpoint and
 * compose its baseline overlay before calling `classifyExactAnchorRecoveryPlan`. This module intentionally
 * exposes NO multi-query builder: assembling fields, live rows, and revisions from separate autocommit reads
 * can produce a state that never existed. The L8 caller owns that assembly inside one transaction after taking
 * the canonical sheet fence, then hands this pure classifier the resulting snapshot.
 *
 * EXACT BIGINT remains the assembly layer's obligation: `anchorSeq` stays a decimal string through
 * `reconstructRecordsAtSeq`'s `::bigint` bind. This classifier receives the already-resolved state map and
 * performs no sequence arithmetic or coercion.
 */

export interface AnchorRevertCandidate {
  recordId: string
  /** the FULL at-anchor record data (unmasked — see the layering contract). */
  targetData: Record<string, unknown>
  /** the at-anchor version (the version the record had as of the anchor). */
  targetVersion: number
  /** the CURRENT live version (optimistic-concurrency anchor for the apply). */
  liveVersion: number
}

export interface AnchorResurrectCandidate {
  recordId: string
  /** the FULL at-anchor snapshot (from the revision chain — never the trash row's terminal vintage). */
  snapshot: Record<string, unknown>
  targetVersion: number
}

export interface ExactAnchorRecoveryPlan {
  /** records whose live data differs from the at-anchor state (live row present). */
  reverts: AnchorRevertCandidate[]
  /** records that existed at the anchor but have NO live row now (deleted after the anchor). */
  resurrects: AnchorResurrectCandidate[]
  /** records DELETED as of the anchor that are live now (later resurrected): Revert keeps, Reset deletes. */
  deletedAtAnchorLiveNow: string[]
  /** live records with no revision ≤ anchor (created after the anchor): Revert keeps, Reset deletes. */
  createdAfterAnchor: string[]
  /** records excluded because their target snapshot carries a field id absent from the current schema. */
  driftCount: number
  /** records whose live data already equals the at-anchor state (no-op — informational). */
  unchangedCount: number
}

function canonicalize(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (v === undefined) return null
    if (Array.isArray(v)) return v.map(normalize)
    if (v !== null && typeof v === 'object') {
      const source = v as Record<string, unknown>
      const ordered: Record<string, unknown> = {}
      for (const key of Object.keys(source).sort())
        ordered[key] = normalize(source[key])
      return ordered
    }
    return v
  }
  return JSON.stringify(normalize(value) ?? null)
}

/** Key-order-insensitive equality on JSON-shaped record data. */
function dataEquals(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  return canonicalize(a) === canonicalize(b)
}

export class ExactAnchorPlanDataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExactAnchorPlanDataError'
  }
}

function requireLiveVersion(value: unknown, recordId: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ExactAnchorPlanDataError(
      `live record ${recordId} has an invalid version`,
    )
  }
  return value
}

function requireTargetVersion(value: unknown, recordId: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ExactAnchorPlanDataError(`at-anchor record ${recordId} has an invalid version`)
  }
  return value
}

function requireRecordData(
  value: unknown,
  recordId: string,
  side: 'live' | 'at-anchor',
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExactAnchorPlanDataError(`${side} record ${recordId} has an invalid data snapshot`)
  }
  return value as Record<string, unknown>
}

function compareRecordId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The PURE classification core (extracted for L8's execute, which composes the L5 baseline into the state
 * map before planning — the classification semantics are identical either way; see the module doc table).
 */
export function classifyExactAnchorRecoveryPlan(
  stateMap: Map<
    string,
    {
      recordId: string
      exists: boolean
      data: Record<string, unknown> | null
      version: number | null
    }
  >,
  liveById: ReadonlyMap<string, { data: unknown; version: unknown }>,
  fieldIds: ReadonlySet<string>,
): ExactAnchorRecoveryPlan {
  const plan: ExactAnchorRecoveryPlan = {
    reverts: [],
    resurrects: [],
    deletedAtAnchorLiveNow: [],
    createdAfterAnchor: [],
    driftCount: 0,
    unchangedCount: 0,
  }

  const validatedLiveById = new Map<string, { data: Record<string, unknown>; version: number }>()
  for (const [recordId, live] of liveById) {
    validatedLiveById.set(recordId, {
      data: requireRecordData(live.data, recordId, 'live'),
      version: requireLiveVersion(live.version, recordId),
    })
  }

  for (const [recordId, target] of stateMap) {
    const live = validatedLiveById.get(recordId)
    if (target.exists) {
      const targetData = requireRecordData(target.data, recordId, 'at-anchor')
      const targetVersion = requireTargetVersion(target.version, recordId)
      if (live && dataEquals(live.data, targetData)) {
        plan.unchangedCount++
        continue
      }
      // Schema-drift guard — identical for the revert and resurrect branches (excluded, counted, re-preview).
      let drift = false
      for (const fid of Object.keys(targetData))
        if (!fieldIds.has(fid)) {
          drift = true
          break
        }
      if (drift) {
        plan.driftCount++
        continue
      }
      if (!live) {
        // Existed at the anchor, gone now ⇒ deleted AFTER the anchor ⇒ resurrectable to its at-anchor state.
        plan.resurrects.push({
          recordId,
          snapshot: targetData,
          targetVersion,
        })
        continue
      }
      plan.reverts.push({
        recordId,
        targetData,
        targetVersion,
        liveVersion: live.version,
      })
      continue
    }
    // target deleted as of the anchor (latest seq<=anchor revision is a delete — LOCK-9):
    if (live) plan.deletedAtAnchorLiveNow.push(recordId) // resurrected after the anchor — caller picks keep/delete
    // no live row ⇒ stays deleted; NEVER resurrected.
  }

  // Live rows with no revision ≤ anchor at all: created after the anchor.
  for (const id of validatedLiveById.keys())
    if (!stateMap.has(id)) plan.createdAfterAnchor.push(id)

  plan.reverts.sort((a, b) => compareRecordId(a.recordId, b.recordId))
  plan.resurrects.sort((a, b) => compareRecordId(a.recordId, b.recordId))
  plan.deletedAtAnchorLiveNow.sort(compareRecordId)
  plan.createdAfterAnchor.sort(compareRecordId)

  return plan
}
