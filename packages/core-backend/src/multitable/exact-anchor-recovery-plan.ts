import type { QueryFn } from './permission-service'
import { reconstructRecordsAtSeq } from './record-reconstructor'
import { assertSeqString } from './history-trust-checkpoint'

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
 * layers is NOT a production path — it is not wired to any route in this lane (default-off by construction).
 * After retention has pruned raw revisions, production callers must also resolve the trusted checkpoint,
 * compose its baseline overlay, and pass that composed state to `classifyExactAnchorRecoveryPlan`; the direct
 * builder below is intentionally raw-history-only and is not a checkpoint-complete recovery authority.
 *
 * EXACT BIGINT: `anchorSeq` is a decimal string handed to `reconstructRecordsAtSeq`'s `::bigint` bind;
 * `assertSeqString` fails closed here too so a garbage anchor never reaches SQL from the plan layer.
 */

export interface AnchorRevertCandidate {
  recordId: string
  /** the FULL at-anchor record data (unmasked — see the layering contract). */
  targetData: Record<string, unknown>
  /** the at-anchor version (the version the record had as of the anchor). */
  targetVersion: number | null
  /** the CURRENT live version (optimistic-concurrency anchor for the apply). */
  liveVersion: number
}

export interface AnchorResurrectCandidate {
  recordId: string
  /** the FULL at-anchor snapshot (from the revision chain — never the trash row's terminal vintage). */
  snapshot: Record<string, unknown>
  targetVersion: number | null
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

const asRec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}

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

function compareRecordId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Build the exact-anchor recovery plan for a sheet (§5 set recomputation; PURE READ — writes nothing).
 * See the module doc for the classification table and the layering contract.
 */
export async function buildExactAnchorRecoveryPlan(
  query: QueryFn,
  sheetId: string,
  anchorSeq: string,
): Promise<ExactAnchorRecoveryPlan> {
  assertSeqString(anchorSeq, 'buildExactAnchorRecoveryPlan.anchorSeq') // fail-closed on a garbage anchor

  // Current schema — the drift guard's truth (a stale field key must never be re-written).
  const fieldRes = await query(
    'SELECT id FROM meta_fields WHERE sheet_id = $1',
    [sheetId],
  )
  const fieldIds = new Set(
    (fieldRes.rows as Array<{ id: unknown }>).map((r) => String(r.id)),
  )

  // Live rows.
  const liveById = new Map<
    string,
    { data: Record<string, unknown>; version: number }
  >()
  const liveRes = await query(
    'SELECT id, data, version FROM meta_records WHERE sheet_id = $1',
    [sheetId],
  )
  for (const r of liveRes.rows as Array<{
    id: unknown
    data: unknown
    version: unknown
  }>) {
    const recordId = String(r.id)
    liveById.set(recordId, {
      data: asRec(r.data),
      version: requireLiveVersion(r.version, recordId),
    })
  }

  // The causal at-anchor state (delete-aware, target-generation-correct — L6-b).
  const stateMap = await reconstructRecordsAtSeq(query, sheetId, anchorSeq)
  return classifyExactAnchorRecoveryPlan(stateMap, liveById, fieldIds)
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
  liveById: Map<string, { data: Record<string, unknown>; version: number }>,
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

  for (const [recordId, target] of stateMap) {
    const live = liveById.get(recordId)
    if (target.exists) {
      const targetData = asRec(target.data)
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
          targetVersion: target.version,
        })
        continue
      }
      if (dataEquals(live.data, targetData)) {
        plan.unchangedCount++
        continue
      }
      plan.reverts.push({
        recordId,
        targetData,
        targetVersion: target.version,
        liveVersion: live.version,
      })
      continue
    }
    // target deleted as of the anchor (latest seq<=anchor revision is a delete — LOCK-9):
    if (live) plan.deletedAtAnchorLiveNow.push(recordId) // resurrected after the anchor — caller picks keep/delete
    // no live row ⇒ stays deleted; NEVER resurrected.
  }

  // Live rows with no revision ≤ anchor at all: created after the anchor.
  for (const id of liveById.keys())
    if (!stateMap.has(id)) plan.createdAfterAnchor.push(id)

  plan.reverts.sort((a, b) => compareRecordId(a.recordId, b.recordId))
  plan.resurrects.sort((a, b) => compareRecordId(a.recordId, b.recordId))
  plan.deletedAtAnchorLiveNow.sort(compareRecordId)
  plan.createdAfterAnchor.sort(compareRecordId)

  return plan
}
