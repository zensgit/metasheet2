import { createHash, randomUUID } from 'node:crypto'

import type { QueryFn } from './permission-service'
import { fenceWriterEntry } from './canonical-sheet-fence'
import { selectCheckpointByAnchorSeq } from './history-trust-checkpoint'
import { reconstructRecordsAtSeq } from './record-reconstructor'
import { mintOperation, sealOperation } from './operation-ledger'
import { recordRecordRevision } from './record-history-service'
import { ensureRecordNotLocked } from './record-lock'
import { loadFieldsForSheet } from './loaders'
import { isFieldAlwaysReadOnly } from './permission-derivation'
import {
  hashAnchorRecoveryScope,
  hashRecoveryAuthorizationScope,
  verifyExactAnchorRecoveryIdentity,
  type ExactAnchorRecoveryMode,
} from './restore-preview-identity'
import { composeBaselineOverlay, type EvaluateRecoveryFullReadAccess } from './exact-anchor-recovery'
import { classifyExactAnchorRecoveryPlan, type ExactAnchorRecoveryPlan } from './exact-anchor-recovery-plan'

/** Normalize a link-field cell (array | single | null) to a string[] of foreign record ids (local copy of the
 *  record-service private helper — the resurrect outbound-link rebuild needs exactly the same shape). */
function normalizeLinkIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.length > 0)
  return typeof value === 'string' && value.length > 0 ? [value] : []
}

/**
 * W0-1 v3.7 Lane L8 — the exact-anchor DESTRUCTIVE APPLY: one transaction, all-or-nothing.
 *
 * Design authority: v3.7 lock (#4331) §5 (execute = full target/schema/set recomputation UNDER THE FENCE,
 * preview verification in-fence) + §2 (canonical fence) + the L6-b gate's pinned L8 deferrals (2026-07-16):
 * (1) in-fence checkpoint re-resolution, (2) L5 baseline composition, (3) anti-replay single-use burn.
 *
 * THE SHAPE — one outer transaction, every step inside it, COMMIT once, any failure ⇒ FULL ROLLBACK with
 * zero writes (including the token burn — a refused execute leaves the world byte-identical):
 *   1. fenceWriterEntry (L4, fence-FIRST): serializes against every fenced writer AND any in-flight
 *      recovery; observes a durable `applying` block and refuses. A concurrent writer parks on this fence
 *      until we commit — nothing interleaves with the apply.
 *   2. BURN the token (INSERT sha256 into `meta_recovery_token_burns`): the PK is the at-most-once
 *      barrier — a second execute of the same token conflicts here and the whole txn rolls back
 *      (`token-replayed`). Burned only on SUCCESS (any later refusal rolls the burn back with everything
 *      else, so a drifted preview's token dies by TTL, not by half-burn).
 *   3. IN-FENCE AUTHORIZATION RE-ADJUDICATION (P1-2, owner ruling 2026-07-17): the REQUIRED
 *      `evaluateFullReadAccess` dependency is evaluated FRESH under the fence (revocation between preview
 *      and execute ⇒ `forbidden`), and the token's signed `authorizedScopeHash` must equal the recomputed
 *      v1 basis — the token's echo is never the authority.
 *   4. IN-FENCE CHECKPOINT RE-RESOLUTION (deferral 1): re-run `selectCheckpointByAnchorSeq` and require
 *      the resolved id to EQUAL the token's `checkpointId` — the token's echo is never trusted. A
 *      checkpoint pruned/superseded-below since preview ⇒ `checkpoint-changed` (re-preview).
 *   5. DRIFT RE-CHECK (§5 preview verification): re-reconstruct at the TOKEN-BOUND anchorSeq, compose the
 *      L5 baseline overlay via the SHARED `composeBaselineOverlay` (deferral 2 + F4: records below the
 *      replay horizon come from the RESOLVED checkpoint's immutable baseline — non-trashed ⇒ at-anchor
 *      state, trashed ⇒ deleted-at-anchor), and re-hash the COMPOSED set; any divergence from the signed
 *      `scopeHash` ⇒ `preview-drift` (409-class, zero writes). The preview hashed the SAME composed set —
 *      what the actor saw is what gets planned; and it runs UNDER the fence (no check→write TOCTOU).
 *   6. (folded into 5 — the composed map from the drift re-check IS the plan input.)
 *   7. PLAN (L7): `classifyExactAnchorRecoveryPlan` over the composed map. `driftCount > 0` ⇒
 *      `schema-drift` refusal — the WHOLE apply, zero writes (P1-2: no partial-set apply smuggled through
 *      drift exclusion; explicit partial recovery is a future separate mode).
 *   8. APPLY all-or-nothing, every write revision-emitted + ledger-tagged (L6-a; the recovery itself
 *      becomes a sealed operation — a future exact anchor):
 *        reverts    → UPDATE to the FULL at-anchor data (version+1, optimistic version guard) +
 *                     revision(action:'update', source:'restore', snapshot = at-anchor data).
 *        resurrects → lock the trash vintage FOR UPDATE → INSERT (new generation, version resets to 1 —
 *                     the MULTI-GEN convention) → rebuild WRITABLE outbound meta_links from the snapshot →
 *                     revision(action:'create', source:'restore') → DELETE the `meta_records_trash` row
 *                     (live/trash mutual exclusion; mirrors `restoreRecord`; owner P1 2026-07-17). All in
 *                     THIS txn, so an injected failure rolls the resurrect + its trash deletion back together.
 *        TOKEN mode 'reset' ONLY: DELETE `deletedAtAnchorLiveNow` + `createdAfterAnchor` rows +
 *                     revision(action:'delete', snapshot = pre-delete data). mode 'revert' KEEPS both
 *                     (non-destructive). P1-1: the mode is read from the VERIFIED CLAIMS — the caller has
 *                     no mode input; a revert-preview token can never drive a reset.
 *   9. SEAL the operation LAST (endpoint after its events — the deferred-FK discipline).
 *
 * LAYERING CONTRACT (P1-2 narrowed it — the SECURITY adjudication is KERNEL-OWNED): full-read
 * authorization, mode authority, schema-drift whole-rejection, anti-replay, checkpoint/scope freshness, AND
 * the recovery DATA-INTEGRITY invariants (resurrect ⇒ trash-row cleanup + outbound-link rebuild = live/trash
 * mutual exclusion, owner P1 2026-07-17) all live HERE. What remains the route wiring's obligation:
 * presentation masking of RETURNED data, size ceilings (SHEET_REVERT_MAX_RECORDS-class), the BROADER
 * link-field side-effects (mirror guards, foreign-existence checks, inbound-tombstone replay), realtime
 * fan-out, HTTP mapping. NOT wired to any route in this lane; the legacy Revert/Reset
 * routes' switch onto this module is the OWNER's wiring decision behind their existing default-OFF flags
 * (`MULTITABLE_ENABLE_SHEET_REVERT` / `MULTITABLE_ENABLE_PIT_RESET`). Default-off by construction: nothing
 * reaches this module today.
 */

/** The apply's mode IS the token's mode (P1-1) — one vocabulary, defined with the identity claims. */
export type ExactAnchorApplyMode = ExactAnchorRecoveryMode

export type ExactAnchorApplyRefusal =
  | 'identity-invalid' // signature/expiry/sheet/actor verification failed (pre-txn, zero DB writes)
  | 'token-replayed' // the token was already burned by a previous successful execute
  | 'forbidden' // in-fence fresh full-read adjudication failed, or the token's authorizedScopeHash does not match the recomputed basis (P1-2)
  | 'no-covering-checkpoint' // no active/retained checkpoint covers the anchor any more (fail-closed)
  | 'checkpoint-changed' // a checkpoint covers it, but NOT the one the preview was minted under
  | 'preview-drift' // the live reconstruction diverged from the signed scope (409-class; re-preview)
  | 'schema-drift' // the plan carries schema-drifted records (driftCount > 0) ⇒ WHOLE apply refused, zero writes (P1-2; explicit partial recovery is a future separate mode)

export interface ExactAnchorApplySuccess {
  ok: true
  /** the TOKEN-BOUND mode (P1-1) — never a request-supplied one. */
  mode: ExactAnchorApplyMode
  anchorSeq: string
  checkpointId: string
  applied: { reverts: number; resurrects: number; deletes: number }
  keptCreatedAfterAnchor: number
}
export type ExactAnchorApplyResult = ExactAnchorApplySuccess | { ok: false; reason: ExactAnchorApplyRefusal }

/** Typed control-flow error: thrown inside the txn to force a FULL rollback, mapped to a refusal outside. */
class ApplyRefusalError extends Error {
  constructor(readonly reason: ExactAnchorApplyRefusal) {
    super(`exact-anchor apply refused: ${reason}`)
    this.name = 'ApplyRefusalError'
  }
}

/** Postgres unique-violation on the burn PK ⇒ the token was already used. */
const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505'

const asRec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

export interface ExactAnchorApplyInput {
  token: string
  sheetId: string
  actorId: string
  /** REQUIRED in-fence authorization dependency (P1-2) — same contract as the preview's (see
   *  `EvaluateRecoveryFullReadAccess`). The apply re-adjudicates FRESH inside the fence; there is no
   *  "already checked at preview" shortcut and no way to omit it. */
  evaluateFullReadAccess: EvaluateRecoveryFullReadAccess
}

/**
 * Execute the destructive apply. `transaction` must open a REAL database transaction and roll back when the
 * callback throws (the poolManager.get().transaction shape). See the module doc for the step protocol.
 * The MODE comes from the VERIFIED TOKEN (P1-1) — there is no mode input: a preview minted for a
 * non-destructive `revert` is structurally unusable to drive a `reset`.
 */
export async function applyExactAnchorRecovery(
  transaction: <T>(fn: (query: QueryFn) => Promise<T>) => Promise<T>,
  input: ExactAnchorApplyInput,
): Promise<ExactAnchorApplyResult> {
  // Identity verification is pure (no DB) — fail fast before opening a transaction.
  const verified = verifyExactAnchorRecoveryIdentity(input.token, { sheetId: input.sheetId, actorId: input.actorId })
  if (!verified.valid || !verified.claims) return { ok: false, reason: 'identity-invalid' }
  const { anchorSeq, checkpointId, scopeHash, liveSetHash, mode, authorizedScopeHash } = verified.claims

  try {
    return await transaction(async (query) => {
      // 1. Fence-first (L4): serialize against all writers + refuse under a durable recovery block.
      await fenceWriterEntry(query, input.sheetId)

      // 2. Burn — the at-most-once barrier. A replayed token conflicts on the PK; a LATER refusal in this
      //    txn rolls this row back too (zero-writes refusals).
      const tokenSha = createHash('sha256').update(input.token).digest('hex')
      try {
        await query(
          'INSERT INTO meta_recovery_token_burns (token_sha256, sheet_id, actor_id) VALUES ($1,$2,$3)',
          [tokenSha, input.sheetId, input.actorId],
        )
      } catch (e) {
        if (isUniqueViolation(e)) throw new ApplyRefusalError('token-replayed')
        throw e
      }

      // 3. IN-FENCE AUTHORIZATION RE-ADJUDICATION (P1-2): evaluate the actor's full-read capability FRESH
      //    (permission revoked since preview ⇒ refused; the burn above rolls back with everything else, so
      //    the token survives a refusal and works again if the grant returns) AND recompute the v1
      //    authorization basis against the token's signed `authorizedScopeHash` — the token's echo is never
      //    the authority, exactly like the checkpoint re-resolution below.
      if (!(await input.evaluateFullReadAccess(query))) throw new ApplyRefusalError('forbidden')
      if (authorizedScopeHash !== hashRecoveryAuthorizationScope({ sheetId: input.sheetId, actorId: input.actorId })) {
        throw new ApplyRefusalError('forbidden')
      }

      // 4. In-fence checkpoint re-resolution (deferral 1) — never trust the token's echo.
      const checkpoint = await selectCheckpointByAnchorSeq(query, input.sheetId, anchorSeq)
      if (!checkpoint) throw new ApplyRefusalError('no-covering-checkpoint')
      if (checkpoint.id !== checkpointId) throw new ApplyRefusalError('checkpoint-changed')

      // 5. Drift re-check UNDER the fence (§5) — TWO independent hashes, two failure classes:
      //    (a) the ANCHOR AUTHORITY: re-reconstruct at the token anchor, compose the SAME L5 baseline
      //        overlay the preview hashed (F4 symmetry — what the actor previewed IS what gets planned;
      //        `composeBaselineOverlay` is the one shared implementation), and re-hash the COMPOSED set.
      //        Immutable under an append-only history + immutable baselines, so a divergence means retention
      //        pruned below the anchor or the anchor was recomputed (the MAX-recompute mutation class) — refuse.
      const replayMap = await reconstructRecordsAtSeq(query, input.sheetId, anchorSeq)
      const composed = await composeBaselineOverlay(query, { sheetId: input.sheetId, checkpointId: checkpoint.id, stateMap: replayMap })
      const anchorHash = hashAnchorRecoveryScope(
        [...composed.values()].map((s) => ({ recordId: s.recordId, exists: s.exists, version: s.version })),
      )
      if (anchorHash !== scopeHash) throw new ApplyRefusalError('preview-drift')
      //    (b) PREVIEW FRESHNESS: re-fingerprint the LIVE set {id, version} in-fence. Any concurrent
      //        version-bumping write / create / delete since the preview changes it — the actor must apply
      //        exactly the world they previewed (the T-path's changesHash discipline, set-level). Read the
      //        live rows HERE (they double as the plan input below — one read, checked and planned).
      const liveById = new Map<string, { data: Record<string, unknown>; version: number; locked?: unknown; locked_by?: unknown; created_by?: unknown }>()
      for (const r of (await query('SELECT id, data, version, locked, locked_by, created_by FROM meta_records WHERE sheet_id = $1', [input.sheetId])).rows as Array<{ id: unknown; data: unknown; version: unknown; locked?: unknown; locked_by?: unknown; created_by?: unknown }>) {
        liveById.set(String(r.id), {
          data: asRec(r.data),
          version: typeof r.version === 'number' && Number.isFinite(r.version) ? r.version : Number(r.version) || 0,
          locked: r.locked,
          locked_by: r.locked_by,
          created_by: r.created_by,
        })
      }
      const liveHash = hashAnchorRecoveryScope(
        [...liveById.entries()].map(([recordId, l]) => ({ recordId, exists: true, version: l.version })),
      )
      if (liveHash !== liveSetHash) throw new ApplyRefusalError('preview-drift')

      // (Baseline composition happened in step 5 via the shared `composeBaselineOverlay` — the SAME map the
      // anchor hash covered is the map the plan consumes below: what was checked is what is planned.)

      // 6. Plan (L7) over the composed map, against the SAME in-fence live rows the freshness hash covered
      //    (one read: what was checked is what is planned) + the current schema.
      const fieldRes = await query('SELECT id FROM meta_fields WHERE sheet_id = $1', [input.sheetId])
      const fieldIds = new Set((fieldRes.rows as Array<{ id: unknown }>).map((r) => String(r.id)))
      const plan: ExactAnchorRecoveryPlan = classifyExactAnchorRecoveryPlan(composed, liveById, fieldIds)

      // P1-2 SCHEMA-DRIFT WHOLE-REJECT (owner ruling 2026-07-17): ANY schema-drifted record ⇒ the WHOLE
      // apply is refused with zero writes (burn included — the txn rolls back). No partial-set apply is
      // smuggled through drift exclusion; an EXPLICIT partial recovery is a future separate mode with its
      // own preview disclosure, not a side effect of a stale field id.
      if (plan.driftCount > 0) throw new ApplyRefusalError('schema-drift')

      // 7. Apply — every write revision-emitted + ledger-tagged; a single failure rolls EVERYTHING back.
      const op = await mintOperation(query, input.sheetId)

      for (const r of plan.reverts) {
        // Lock discipline (rank-8, mirrors the T-path recovery): a LOCKED record refuses the apply — and
        // because this apply is all-or-nothing, one locked record aborts the WHOLE recovery loudly (unlock
        // first, re-preview). ensureRecordNotLocked throws unless the actor is the locker/owner.
        const liveRow = liveById.get(r.recordId)
        if (liveRow) ensureRecordNotLocked(input.actorId, liveRow, () => new Error(`exact-anchor apply refused: record ${r.recordId} is locked`))
        // lock-guarded: L8 revert apply — ensureRecordNotLocked just above, same txn.
        // revision-emitted: L8 revert apply — recordRecordRevision below, same txn (source 'restore').
        const upd = await query(
          `UPDATE meta_records SET data = $1::jsonb, version = version + 1, updated_at = now()
           WHERE id = $2 AND sheet_id = $3 AND version = $4
           RETURNING version`,
          [JSON.stringify(r.targetData), r.recordId, input.sheetId, r.liveVersion],
        )
        const row = upd.rows[0] as { version?: unknown } | undefined
        // In-fence, post-drift-check: a 0-row update here is an internal invariant break — abort everything.
        if (!row) throw new Error(`exact-anchor apply: optimistic version guard failed for ${r.recordId}`)
        // revision-emitted: L8 revert apply — action:'update', source:'restore', full at-anchor snapshot.
        await recordRecordRevision(query, {
          sheetId: input.sheetId,
          recordId: r.recordId,
          version: Number(row.version),
          action: 'update',
          source: 'restore',
          actorId: input.actorId,
          changedFieldIds: Object.keys(r.targetData),
          patch: r.targetData,
          snapshot: r.targetData,
          ledger: op,
        })
      }

      // Resurrect trash-lifecycle side effects (owner P1, 2026-07-17): a resurrect candidate was deleted
      // AFTER the anchor, so its post-anchor delete left a `meta_records_trash` row. Bringing it back to
      // live WITHOUT removing that row breaks the live/trash mutual-exclusion invariant — the recycle bin
      // still shows the (now-live) record, a later restore of it 23505-conflicts on the id, and its lingering
      // `delete_revision_id` mis-pins tombstone/retention. So the resurrect MUST mirror `restoreRecord`'s
      // trash discipline: lock the vintage FOR UPDATE, rebuild the WRITABLE outbound links from the at-anchor
      // snapshot (so link reads aren't silently empty; mirror side skipped — the spine invariant is
      // structural), then DELETE the trash row — ALL inside this same all-or-nothing txn, so an injected
      // later failure rolls back the INSERT, the revision, the link rebuild AND the trash deletion together.
      const resurrectLinkFieldIds: string[] = plan.resurrects.length > 0
        ? (await loadFieldsForSheet(query, input.sheetId))
            .filter((f) => f.type === 'link' && !isFieldAlwaysReadOnly(f))
            .map((f) => f.id)
        : []
      for (const s of plan.resurrects) {
        // Lock this record's trash vintage(s) FIRST (4c-3 C4 discipline): a concurrent restoreRecord on the
        // same id serializes here rather than racing the INSERT below. A resurrect whose post-anchor delete
        // was a hard delete (no trash row) locks zero rows — harmless.
        // HONEST COVERAGE (gate F1, 2026-07-17): this lock is DEFENSE-IN-DEPTH BENEATH the canonical fence,
        // and it is NOT independently covered — neutering it leaves the suite green, because the apply only
        // ever runs with the writer fence ON (`fenceWriterEntry` is a no-op when the flag is off,
        // canonical-sheet-fence.ts:185) and that fence already serializes apply-vs-apply. What the lock adds
        // is protection against a NON-fenced concurrent writer of the same trash row (today: restoreRecord).
        // Correctness of the race itself is settled by construction rather than by a golden — a second
        // resurrect of the same id conflicts on the burn PK (23505) and rolls back cleanly — but the
        // independent coverage for this lock is deliberately DEFERRED to the wiring rung, not claimed here.
        await query('SELECT id FROM meta_records_trash WHERE record_id = $1 AND sheet_id = $2 FOR UPDATE', [s.recordId, input.sheetId])
        // New generation: version resets to 1 (the MULTI-GEN delete→recreate convention). No lock can exist
        // on a row being created; the snapshot is previously-persisted at-anchor data (no new user payload).
        // revision-emitted: L8 resurrect apply — recordRecordRevision below, same txn (source 'restore').
        await query(
          'INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)',
          [s.recordId, input.sheetId, JSON.stringify(s.snapshot), input.actorId],
        )
        // Rebuild outbound meta_links from the at-anchor snapshot (writable/forward links only) —
        // `loadLinkValuesByRecord` reads meta_links, not `data`, so without this the resurrected record's
        // link cells read empty. IDEMPOTENCE VIA `NOT EXISTS`, NOT `ON CONFLICT`: meta_links has NO unique
        // constraint on the edge triple (only `meta_links_pkey` on the synthetic `id`), so an
        // `ON CONFLICT DO NOTHING` with a freshly-minted uuid can NEVER fire — it reads as a guard while
        // guaranteeing nothing. This is the same discipline 4c-3's inbound replay carries
        // (`inbound-link-replay.ts` ~:154). Today no duplicate is reachable anyway (the record's outbound
        // rows were dropped by `meta_links_record_id_fkey ON DELETE CASCADE` when it was deleted), but the
        // guard makes that a property of THIS statement instead of a precondition inherited from elsewhere.
        for (const fieldId of resurrectLinkFieldIds) {
          for (const foreignId of normalizeLinkIds((s.snapshot as Record<string, unknown>)[fieldId])) {
            await query(
              `INSERT INTO meta_links (id, field_id, record_id, foreign_record_id)
               SELECT $1, $2, $3, $4
                WHERE NOT EXISTS (
                  SELECT 1 FROM meta_links ml
                   WHERE ml.field_id = $2 AND ml.record_id = $3 AND ml.foreign_record_id = $4
                )`,
              [`lnk_${randomUUID()}`.slice(0, 50), fieldId, s.recordId, foreignId],
            )
          }
        }
        // revision-emitted: L8 resurrect apply — action:'create', source:'restore', at-anchor snapshot.
        await recordRecordRevision(query, {
          sheetId: input.sheetId,
          recordId: s.recordId,
          version: 1,
          action: 'create',
          source: 'restore',
          actorId: input.actorId,
          changedFieldIds: Object.keys(s.snapshot),
          patch: s.snapshot,
          snapshot: s.snapshot,
          ledger: op,
        })
        // Trash cleanup — the live/trash mutual-exclusion invariant. Removing the trash row(s) for this id
        // also drops the `delete_revision_id` anchor that was mis-pinning tombstone/retention. (Inbound-edge
        // REPLAY from those terminal-vintage tombstones is deliberately NOT done here: this apply reconstructs
        // the AT-ANCHOR state, a different vintage than the terminal delete the tombstones belong to — a naive
        // replay would restore edges from the wrong vintage. That is a route-wiring / future-mode concern.)
        await query('DELETE FROM meta_records_trash WHERE record_id = $1 AND sheet_id = $2', [s.recordId, input.sheetId])
      }

      let deletes = 0
      // P1-1: the destructive branch keys on the TOKEN-BOUND mode — the one the actor previewed under.
      if (mode === 'reset') {
        for (const recordId of [...plan.deletedAtAnchorLiveNow, ...plan.createdAfterAnchor]) {
          const live = liveById.get(recordId)
          if (!live) continue // defensive: classified live moments ago, under the fence it must still be
          // Lock discipline (rank-8): a LOCKED record aborts the whole all-or-nothing reset (unlock first).
          ensureRecordNotLocked(input.actorId, live, () => new Error(`exact-anchor apply refused: record ${recordId} is locked`))
          // lock-guarded: L8 reset delete — ensureRecordNotLocked just above, same txn.
          // revision-emitted: L8 reset delete — recordRecordRevision below, same txn (source 'restore').
          const del = await query(
            'DELETE FROM meta_records WHERE id = $1 AND sheet_id = $2 RETURNING version',
            [recordId, input.sheetId],
          )
          if (!del.rows[0]) throw new Error(`exact-anchor apply: reset delete found no row for ${recordId}`)
          // revision-emitted: L8 reset delete — action:'delete', pre-delete snapshot (LOCK-9 convention).
          await recordRecordRevision(query, {
            sheetId: input.sheetId,
            recordId,
            version: live.version,
            action: 'delete',
            source: 'restore',
            actorId: input.actorId,
            changedFieldIds: [],
            patch: {},
            snapshot: live.data,
            ledger: op,
          })
          deletes++
        }
      }

      // 8. Seal LAST (endpoint after events — deferred-FK discipline). No-op when the ledger is inert.
      await sealOperation(query, op)

      return {
        ok: true as const,
        mode,
        anchorSeq,
        checkpointId: checkpoint.id,
        applied: { reverts: plan.reverts.length, resurrects: plan.resurrects.length, deletes },
        keptCreatedAfterAnchor: mode === 'revert' ? plan.createdAfterAnchor.length + plan.deletedAtAnchorLiveNow.length : 0,
      }
    })
  } catch (e) {
    if (e instanceof ApplyRefusalError) return { ok: false, reason: e.reason }
    throw e // real failures propagate — the transaction has already rolled everything back
  }
}

/**
 * G1 (pre-wiring gate list) — BURN-RETENTION SWEEP. `meta_recovery_token_burns` grows one row per
 * successful apply, forever; a burn row's at-most-once duty ends once its token can no longer verify
 * (the 10-minute JWT `exp`). Prunes rows older than `keepMinutes`, FLOOR-CLAMPED to 15 minutes: pruning a
 * burn younger than any possibly-live token's lifetime would RESURRECT a replayed token (the PK conflict
 * is the at-most-once barrier), so the floor is a correctness bound (token TTL 10m + clock-skew margin),
 * not a tunable. Values-free (deletes by age only); returns the pruned row count for the operator log.
 * NOT scheduled anywhere in this lane — the sweep's production caller is route/ops wiring (the same PR
 * that wires Revert/Reset onto this module), same posture as every other consumer here.
 */
export async function pruneExpiredRecoveryTokenBurns(query: QueryFn, keepMinutes = 60): Promise<number> {
  const keep = Math.max(15, Math.floor(Number.isFinite(keepMinutes) ? keepMinutes : 60))
  const res = await query(
    `DELETE FROM meta_recovery_token_burns WHERE burned_at < now() - ($1 || ' minutes')::interval`,
    [String(keep)],
  )
  return typeof res.rowCount === 'number' ? res.rowCount : 0
}
