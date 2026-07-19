import { createHash, randomUUID } from 'node:crypto'

import type { QueryFn } from './permission-service'
import { fenceWriterEntry, isWriterFenceEnabled } from './canonical-sheet-fence'
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
import {
  assertWithinCaptureCap,
  countInboundLinkCaptureRows,
  insertInboundLinkTombstones,
  isTombstoneCaptureEnabled,
} from './tombstone-capture'
import { projectRestorableOntoLive } from './record-restore-diff'
import {
  isContiguityStrictMode,
  precheckSheetHistoryIntegrityStrict,
} from './history-integrity-precheck'
import type { MultitableField } from './field-codecs'

/** Normalize a link-field cell (array | single | null) to a string[] of foreign record ids. */
function normalizeLinkIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.length > 0)
  return typeof value === 'string' && value.length > 0 ? [value] : []
}

/** Resolve a link field's declared foreign sheet (aliases used across codecs / writers). */
function resolveForeignSheetId(field: MultitableField): string | null {
  const property = (field.property ?? {}) as Record<string, unknown>
  for (const c of [property.foreignSheetId, property.foreignDatasheetId, property.datasheetId]) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim()
  }
  return null
}

/**
 * Synchronize one record's WRITABLE forward-link `meta_links` for a single field to exactly `ids`.
 * Mirror-side fields are never passed here (spine invariant). Same-txn only.
 */
async function syncOneOutboundLinkField(
  query: QueryFn,
  recordId: string,
  fieldId: string,
  ids: readonly string[],
): Promise<void> {
  const current = await query(
    'SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2',
    [fieldId, recordId],
  )
  const existingIds = (current.rows as Array<{ foreign_record_id: unknown }>).map((r) => String(r.foreign_record_id))
  const existing = new Set(existingIds)
  const next = new Set(ids)
  const toDelete = existingIds.filter((id) => !next.has(id))
  const toInsert = ids.filter((id) => !existing.has(id))
  if (toDelete.length > 0) {
    await query(
      'DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2 AND foreign_record_id = ANY($3::text[])',
      [fieldId, recordId, toDelete],
    )
  }
  for (const foreignId of toInsert) {
    await query(
      `INSERT INTO meta_links (id, field_id, record_id, foreign_record_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [`lnk_${randomUUID()}`.slice(0, 50), fieldId, recordId, foreignId],
    )
  }
  if (ids.length === 0) {
    await query('DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2', [fieldId, recordId])
  }
}

/**
 * W0-1 v3.7 Lane L8 — the exact-anchor DESTRUCTIVE APPLY: one transaction, all-or-nothing.
 *
 * Design authority: v3.7 lock (#4331) §5 (execute = full target/schema/set recomputation UNDER THE FENCE;
 * all writes + revisions/tombstones in one txn; lock/permission recheck before apply) + §2 (canonical fence;
 * formula/lookup/rollup/auto-number non-restorable) + L6-b/L7 stack.
 *
 * THE SHAPE — one outer transaction, COMMIT once, any failure ⇒ FULL ROLLBACK (incl. burn):
 *   1. fenceWriterEntry (L4, fence-FIRST).
 *   2. TRUSTED SUBSTRATE (kernel fail-closed): BOTH `MULTITABLE_ENABLE_WRITER_FENCE` and
 *      `MULTITABLE_HISTORY_CONTIGUITY_STRICT` must be on, then `precheckSheetHistoryIntegrityStrict` under
 *      the fence — any non-ok ⇒ `recovery-trust-required`, zero writes. Prevents an accidental route wire
 *      from running destructive apply with the fence as a flag-off no-op.
 *   3. BURN the token (anti-replay PK).
 *   4. IN-FENCE full-read + authorizedScopeHash (P1-2).
 *   5. IN-FENCE checkpoint re-resolution (never trust the token echo).
 *   6. Dual-hash drift (composed scopeHash + live liveSetHash) + plan (L7).
 *   7. schema-drift whole-reject; RESURRECT fail-closed (`inbound-unprovable` — D1c link history unsolved;
 *      temporary kernel boundary, not route-deferred replay).
 *   8. Canonical restorable projection per revert (projectRestorableOntoLive): derived-only ⇒ no-op;
 *      foreign-link integrity for every changed writable forward link; REQUIRED
 *      `evaluatePlanAuthorization` over the true restorable delta (before mint/writes).
 *   9. APPLY: restorable reverts (data + meta_links) + RESET canonical delete parity; seal last.
 *
 * KERNEL-OWNED: security adjudication, restorable projection, link integrity, both-direction reset cleanup,
 * tombstone/trash, anti-replay, trust substrate. Route-owned: presentation masking, size ceilings, realtime,
 * HTTP mapping. NOT wired; flags OFF; `RECONSTRUCTION_CAUSALITY_LANDED` stays false.
 */

/** The apply's mode IS the token's mode (P1-1) — one vocabulary, defined with the identity claims. */
export type ExactAnchorApplyMode = ExactAnchorRecoveryMode

export type ExactAnchorApplyRefusal =
  | 'identity-invalid' // signature/expiry/sheet/actor verification failed (pre-txn, zero DB writes)
  | 'token-replayed' // the token was already burned by a previous successful execute
  | 'forbidden' // full-read / authorizedScopeHash / plan authorization failed (values-free)
  | 'no-covering-checkpoint' // no active/retained checkpoint covers the anchor any more (fail-closed)
  | 'checkpoint-changed' // a checkpoint covers it, but NOT the one the preview was minted under
  | 'preview-drift' // the live reconstruction diverged from the signed scope (409-class; re-preview)
  | 'schema-drift' // plan.driftCount > 0 ⇒ WHOLE apply refused, zero writes
  | 'inbound-unprovable' // plan.resurrects.length > 0 — at-anchor inbound relations cannot be proven (D1c)
  | 'link-integrity' // missing/ambiguous foreign sheet, missing/wrong-sheet target, or mirror write attempt
  | 'recovery-trust-required' // fence+strict substrate missing or HISTORY_INCOMPLETE under the fence

export interface ExactAnchorApplySuccess {
  ok: true
  /** the TOKEN-BOUND mode (P1-1) — never a request-supplied one. */
  mode: ExactAnchorApplyMode
  anchorSeq: string
  checkpointId: string
  /** counts of WRITES that landed (no-op restorable projections are not counted as reverts). */
  applied: { reverts: number; resurrects: number; deletes: number }
  keptCreatedAfterAnchor: number
}
export type ExactAnchorApplyResult = ExactAnchorApplySuccess | { ok: false; reason: ExactAnchorApplyRefusal }

/** True restorable delta for one revert that will write (for plan-authorization / field-write gates). */
export interface ExactAnchorRevertWriteIntent {
  recordId: string
  liveVersion: number
  changedFieldIds: string[]
  patch: Record<string, unknown>
  projectedData: Record<string, unknown>
  linkUpdates: Array<{ fieldId: string; targetIds: string[] }>
}

/**
 * Context for the REQUIRED in-fence write-authorization dependency. Built AFTER plan + restorable
 * projection so the eventual route adapter can enforce manage-sheet + per-record edit/delete/row ownership
 * + field-write permissions over exactly the true restorable delta (not full snapshots).
 */
export interface ExactAnchorPlanAuthContext {
  mode: ExactAnchorApplyMode
  sheetId: string
  actorId: string
  plan: ExactAnchorRecoveryPlan
  /** reverts that would write (isNoOp filtered out). */
  revertWrites: ExactAnchorRevertWriteIntent[]
  /** record ids the TOKEN-BOUND reset mode would delete. */
  deleteRecordIds: string[]
}

/** REQUIRED — omission is a TypeScript error. Must return true to proceed to mint/writes. */
export type EvaluatePlanAuthorization = (
  query: QueryFn,
  context: ExactAnchorPlanAuthContext,
) => Promise<boolean>

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
  /** REQUIRED in-fence full-read adjudication (P1-2) — same contract as the preview. */
  evaluateFullReadAccess: EvaluateRecoveryFullReadAccess
  /**
   * REQUIRED in-fence WRITE authorization over the true restorable plan/projection (v3.7 §5 step 7).
   * Re-evaluated FRESH under the fence after the plan is known and BEFORE mintOperation/any write.
   * Omission is structurally impossible (typed required field). Full-read alone is insufficient.
   */
  evaluatePlanAuthorization: EvaluatePlanAuthorization
}

/**
 * Execute the destructive apply. `transaction` must open a REAL database transaction and roll back when the
 * callback throws. MODE comes from the VERIFIED TOKEN only (P1-1).
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
      // 1. Fence-first (L4).
      await fenceWriterEntry(query, input.sheetId)

      // 2. TRUSTED SUBSTRATE — before burn/write. Fence alone is a flag-off no-op; refuse unless the
      //    trusted recovery substrate is actually armed, then re-check history under the fence.
      if (!isWriterFenceEnabled() || !isContiguityStrictMode()) {
        throw new ApplyRefusalError('recovery-trust-required')
      }
      const trust = await precheckSheetHistoryIntegrityStrict(query, input.sheetId)
      if (!trust.ok) throw new ApplyRefusalError('recovery-trust-required')

      // 3. Burn — at-most-once barrier (rolled back on any later refusal).
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

      // 4. IN-FENCE full-read + authorizedScopeHash (P1-2).
      if (!(await input.evaluateFullReadAccess(query))) throw new ApplyRefusalError('forbidden')
      if (authorizedScopeHash !== hashRecoveryAuthorizationScope({ sheetId: input.sheetId, actorId: input.actorId })) {
        throw new ApplyRefusalError('forbidden')
      }

      // 5. In-fence checkpoint re-resolution.
      const checkpoint = await selectCheckpointByAnchorSeq(query, input.sheetId, anchorSeq)
      if (!checkpoint) throw new ApplyRefusalError('no-covering-checkpoint')
      if (checkpoint.id !== checkpointId) throw new ApplyRefusalError('checkpoint-changed')

      // 6. Dual-hash drift + live rows for plan/projection.
      const replayMap = await reconstructRecordsAtSeq(query, input.sheetId, anchorSeq)
      const composed = await composeBaselineOverlay(query, { sheetId: input.sheetId, checkpointId: checkpoint.id, stateMap: replayMap })
      const anchorHash = hashAnchorRecoveryScope(
        [...composed.values()].map((s) => ({ recordId: s.recordId, exists: s.exists, version: s.version })),
      )
      if (anchorHash !== scopeHash) throw new ApplyRefusalError('preview-drift')

      const liveById = new Map<string, {
        data: Record<string, unknown>
        version: number
        locked?: unknown
        locked_by?: unknown
        created_by?: unknown
        created_at?: unknown
        updated_at?: unknown
      }>()
      for (const r of (await query(
        'SELECT id, data, version, locked, locked_by, created_by, created_at, updated_at FROM meta_records WHERE sheet_id = $1',
        [input.sheetId],
      )).rows as Array<{
        id: unknown
        data: unknown
        version: unknown
        locked?: unknown
        locked_by?: unknown
        created_by?: unknown
        created_at?: unknown
        updated_at?: unknown
      }>) {
        liveById.set(String(r.id), {
          data: asRec(r.data),
          version: typeof r.version === 'number' && Number.isFinite(r.version) ? r.version : Number(r.version) || 0,
          locked: r.locked,
          locked_by: r.locked_by,
          created_by: r.created_by,
          created_at: r.created_at,
          updated_at: r.updated_at,
        })
      }
      const liveHash = hashAnchorRecoveryScope(
        [...liveById.entries()].map(([recordId, l]) => ({ recordId, exists: true, version: l.version })),
      )
      if (liveHash !== liveSetHash) throw new ApplyRefusalError('preview-drift')

      // 7. Plan (L7).
      const fieldRes = await query('SELECT id, type FROM meta_fields WHERE sheet_id = $1', [input.sheetId])
      const fieldRows = fieldRes.rows as Array<{ id: unknown; type: unknown }>
      const fieldIds = new Set(fieldRows.map((r) => String(r.id)))
      const rawTypeById = new Map(fieldRows.map((r) => [String(r.id), String(r.type ?? '')]))
      const plan: ExactAnchorRecoveryPlan = classifyExactAnchorRecoveryPlan(composed, liveById, fieldIds)

      if (plan.driftCount > 0) throw new ApplyRefusalError('schema-drift')

      // RESURRECT fail-closed: D1c leaves link-edge history unsolved; terminal tombstones/current neighbors
      // cannot prove the inbound relation set AT the requested anchor. Whole-apply refuse — never partial.
      if (plan.resurrects.length > 0) throw new ApplyRefusalError('inbound-unprovable')

      // Field surface for restorable projection (exclude mirror-owned link fields — spine invariant).
      const fields = await loadFieldsForSheet(query, input.sheetId)
      const fieldById = new Map<string, MultitableField>()
      const projectionFieldById = new Map<string, { type: string }>()
      for (const f of fields) {
        fieldById.set(f.id, f)
        if (f.type === 'link' && isFieldAlwaysReadOnly(f)) continue
        projectionFieldById.set(f.id, { type: f.type })
      }

      // Restorable projection per plan.revert — derived-only differences become no-ops.
      const revertWrites: ExactAnchorRevertWriteIntent[] = []
      for (const r of plan.reverts) {
        const live = liveById.get(r.recordId)
        if (!live) continue
        const projection = projectRestorableOntoLive({
          fieldById: projectionFieldById,
          rawTypeById,
          targetSnapshot: r.targetData,
          currentData: live.data,
          recordId: r.recordId,
          currentVersion: live.version,
          normalizeLinkIds,
        })
        if (projection.isNoOp) continue
        revertWrites.push({
          recordId: r.recordId,
          liveVersion: r.liveVersion,
          changedFieldIds: projection.changedFieldIds,
          patch: projection.patch,
          projectedData: projection.data,
          linkUpdates: projection.linkUpdates,
        })
      }

      // Foreign-link integrity for every changed writable forward link (before any mutation).
      for (const rw of revertWrites) {
        for (const lu of rw.linkUpdates) {
          const field = fieldById.get(lu.fieldId)
          if (!field || field.type !== 'link') throw new ApplyRefusalError('link-integrity')
          if (isFieldAlwaysReadOnly(field)) throw new ApplyRefusalError('link-integrity')
          const foreignSheetId = resolveForeignSheetId(field)
          if (!foreignSheetId) throw new ApplyRefusalError('link-integrity')
          const targetIds = lu.targetIds
          if (targetIds.length === 0) continue
          const found = await query(
            'SELECT id FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])',
            [foreignSheetId, targetIds],
          )
          const foundSet = new Set((found.rows as Array<{ id: unknown }>).map((row) => String(row.id)))
          if (targetIds.some((id) => !foundSet.has(id))) throw new ApplyRefusalError('link-integrity')
        }
      }

      const deleteRecordIds =
        mode === 'reset' ? [...plan.deletedAtAnchorLiveNow, ...plan.createdAfterAnchor] : []

      // 8. REQUIRED in-fence WRITE authorization over the true restorable plan (after plan/projection,
      //    before mint/writes). Revocation between preview and execute, or field/record deny ⇒ forbidden.
      if (!(await input.evaluatePlanAuthorization(query, {
        mode,
        sheetId: input.sheetId,
        actorId: input.actorId,
        plan,
        revertWrites,
        deleteRecordIds,
      }))) {
        throw new ApplyRefusalError('forbidden')
      }

      // 9. Apply — every write revision-emitted + ledger-tagged.
      const op = await mintOperation(query, input.sheetId)

      let sheetBaseId: string | null = null
      if (deleteRecordIds.length > 0) {
        const baseRow = (await query('SELECT base_id FROM meta_sheets WHERE id = $1', [input.sheetId])).rows[0] as
          | { base_id?: unknown }
          | undefined
        sheetBaseId = baseRow && typeof baseRow.base_id === 'string' ? baseRow.base_id : null
      }

      // RESET deletes BEFORE reverts so inbound edges that a concurrent restorable projection
      // would clear (peer rows linking to a created-after-anchor delete candidate) are still
      // present for tombstone capture — same-txn, still all-or-nothing.
      let deletes = 0
      if (mode === 'reset') {
        for (const recordId of deleteRecordIds) {
          const live = liveById.get(recordId)
          if (!live) continue
          ensureRecordNotLocked(
            input.actorId,
            live,
            () => new Error(`exact-anchor apply refused: record ${recordId} is locked`),
          )
          // Canonical delete parity (deleteRecord / PIT-reset): pre-gen id → optional inbound capture →
          // both-direction meta_links delete → revision → trash → live delete.
          const resetDeleteRevisionId = randomUUID()
          if (isTombstoneCaptureEnabled()) {
            const totalToCapture = await countInboundLinkCaptureRows(query, recordId)
            assertWithinCaptureCap(totalToCapture)
            await insertInboundLinkTombstones(query, {
              sheetId: input.sheetId,
              recordId,
              sourceRevisionId: resetDeleteRevisionId,
            })
          }
          await query('DELETE FROM meta_links WHERE record_id = $1 OR foreign_record_id = $1', [recordId])
          // lock-guarded: L8 reset delete — ensureRecordNotLocked above, same txn.
          // revision-emitted: L8 reset delete — pre-gen id so trash + tombstones share the causal anchor.
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
            id: resetDeleteRevisionId,
            ledger: op,
          })
          const createdBy = typeof live.created_by === 'string' ? live.created_by : null
          await query(
            `INSERT INTO meta_records_trash
               (record_id, sheet_id, base_id, data, original_version, created_by, deleted_by,
                original_created_at, original_updated_at, delete_revision_id)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)`,
            [
              recordId,
              input.sheetId,
              sheetBaseId,
              JSON.stringify(live.data),
              live.version,
              createdBy,
              input.actorId,
              live.created_at ?? null,
              live.updated_at ?? null,
              resetDeleteRevisionId,
            ],
          )
          // lock-guarded: L8 reset delete — ensureRecordNotLocked earlier in this loop body, same txn.
          // revision-emitted: L8 reset delete — recordRecordRevision(action:'delete', id=pre-gen) above, same txn.
          const del = await query(
            'DELETE FROM meta_records WHERE id = $1 AND sheet_id = $2 RETURNING version',
            [recordId, input.sheetId],
          )
          if (!del.rows[0]) throw new Error(`exact-anchor apply: reset delete found no row for ${recordId}`)
          deletes++
        }
      }

      let revertsApplied = 0
      for (const rw of revertWrites) {
        const liveRow = liveById.get(rw.recordId)
        if (liveRow) {
          ensureRecordNotLocked(
            input.actorId,
            liveRow,
            () => new Error(`exact-anchor apply refused: record ${rw.recordId} is locked`),
          )
        }
        // lock-guarded: L8 revert apply — ensureRecordNotLocked just above, same txn.
        // revision-emitted: L8 revert apply — recordRecordRevision below, same txn (source 'restore').
        const upd = await query(
          `UPDATE meta_records SET data = $1::jsonb, version = version + 1, updated_at = now()
           WHERE id = $2 AND sheet_id = $3 AND version = $4
           RETURNING version`,
          [JSON.stringify(rw.projectedData), rw.recordId, input.sheetId, rw.liveVersion],
        )
        const row = upd.rows[0] as { version?: unknown } | undefined
        if (!row) throw new Error(`exact-anchor apply: optimistic version guard failed for ${rw.recordId}`)
        for (const lu of rw.linkUpdates) {
          await syncOneOutboundLinkField(query, rw.recordId, lu.fieldId, lu.targetIds)
        }
        // revision-emitted: L8 revert — true restorable delta only (never Object.keys(full target)).
        await recordRecordRevision(query, {
          sheetId: input.sheetId,
          recordId: rw.recordId,
          version: Number(row.version),
          action: 'update',
          source: 'restore',
          actorId: input.actorId,
          changedFieldIds: rw.changedFieldIds,
          patch: rw.patch,
          snapshot: rw.projectedData,
          ledger: op,
        })
        revertsApplied++
      }

      // RESURRECT branch intentionally absent: plan.resurrects already failed closed above.

      await sealOperation(query, op)

      return {
        ok: true as const,
        mode,
        anchorSeq,
        checkpointId: checkpoint.id,
        applied: { reverts: revertsApplied, resurrects: 0, deletes },
        keptCreatedAfterAnchor:
          mode === 'revert' ? plan.createdAfterAnchor.length + plan.deletedAtAnchorLiveNow.length : 0,
      }
    })
  } catch (e) {
    if (e instanceof ApplyRefusalError) return { ok: false, reason: e.reason }
    throw e
  }
}

/**
 * G1 — BURN-RETENTION SWEEP. Floor-clamped to 15 minutes (token TTL + skew). Not scheduled in this lane.
 */
export async function pruneExpiredRecoveryTokenBurns(query: QueryFn, keepMinutes = 60): Promise<number> {
  const keep = Math.max(15, Math.floor(Number.isFinite(keepMinutes) ? keepMinutes : 60))
  const res = await query(
    `DELETE FROM meta_recovery_token_burns WHERE burned_at < now() - ($1 || ' minutes')::interval`,
    [String(keep)],
  )
  return typeof res.rowCount === 'number' ? res.rowCount : 0
}
