import { createHash, randomUUID } from 'node:crypto'

import type { QueryFn } from './permission-service'
import { assertInTransaction } from './pg-transaction-guard'
import { fenceWriterEntry, isWriterFenceEnabled } from './canonical-sheet-fence'
import { selectCheckpointByAnchorSeq } from './history-trust-checkpoint'
import { reconstructRecordsAtSeq, type RecordStateAtT } from './record-reconstructor'
import { mintOperation, sealOperation } from './operation-ledger'
import { recordRecordRevision } from './record-history-service'
import { ensureRecordNotLocked } from './record-lock'
import { loadFieldsForSheet } from './loaders'
import { isFieldAlwaysReadOnly } from './permission-derivation'
import {
  hashExactAnchorLiveSet,
  hashAnchorRecoveryScope,
  hashExactAnchorSchema,
  hashRecoveryAuthorizationScope,
  verifyExactAnchorRecoveryIdentity,
  type ExactAnchorRecoveryMode,
} from './restore-preview-identity'
import { composeBaselineOverlay, ExactAnchorHistoryDataError, type EvaluateRecoveryFullReadAccess } from './exact-anchor-recovery'
import {
  classifyExactAnchorRecoveryPlan,
  ExactAnchorPlanDataError,
  type ExactAnchorRecoveryPlan,
} from './exact-anchor-recovery-plan'
import {
  assertWithinCaptureCap,
  countInboundLinkCaptureRows,
  insertInboundLinkTombstones,
  isTombstoneCaptureEnabled,
} from './tombstone-capture'
import { projectRestorableOntoLive } from './record-restore-diff'
import {
  isContiguityStrictMode,
  precheckSheetHistoryIntegrity,
} from './history-integrity-precheck'
import type { MultitableField } from './field-codecs'
import {
  assertExactRestorableRecordValid,
  assertExactRestorableScalarValue,
  ExactRestoreValueError,
} from './exact-anchor-restore-validate'
import {
  assertNoHierarchyParentCycle,
  buildHierarchyParentOverridesByField,
  collectSameSheetLinkChangeFieldIds,
  HierarchyCycleError,
  loadHierarchyParentFieldIds,
  type HierarchyCycleLinkGuard,
} from './hierarchy-cycle-guard'
import {
  hydrateLiveLinkProjection,
  isLiveLinkTargetForeignKeyViolation,
  LiveLinkProjectionDataError,
  loadAuthoritativeLiveLinkEdgesForSheet,
} from './live-link-projection-integrity'

/** Normalize a link-field cell (array | single | null) to a string[] of foreign record ids. */
function normalizeLinkIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.length > 0)
  return typeof value === 'string' && value.length > 0 ? [value] : []
}

/**
 * Resolve a link field's declared foreign sheet from a RAW property bag (not post-serialize).
 * Conflicting non-empty aliases (foreignSheetId / foreignDatasheetId / datasheetId) are
 * AMBIGUOUS → fail closed (null). Exactly one distinct trimmed value is required.
 * Prefer calling with the DB `meta_fields.property` blob; `serializeFieldRow` collapses aliases.
 */
export function resolveForeignSheetIdFromProperty(property: Record<string, unknown> | null | undefined): string | null {
  const p = property ?? {}
  const unique = new Set<string>()
  for (const c of [p.foreignSheetId, p.foreignDatasheetId, p.datasheetId]) {
    if (typeof c === 'string' && c.trim().length > 0) unique.add(c.trim())
  }
  if (unique.size !== 1) return null
  return [...unique][0]!
}

/** Convenience over MultitableField.property (may already be alias-normalized by serializeFieldRow). */
export function resolveForeignSheetId(field: MultitableField): string | null {
  return resolveForeignSheetIdFromProperty(field.property as Record<string, unknown> | undefined)
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
): Promise<string[]> {
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
  return [...new Set([...toDelete, ...toInsert])]
}

type TwoWayMirrorConfig = { foreignSheetId: string; mirrorFieldId: string }

function twoWayMirrorConfig(property: Record<string, unknown> | null | undefined): TwoWayMirrorConfig | null {
  const p = property ?? {}
  const foreignSheetId = resolveForeignSheetIdFromProperty(p)
  const mirrorFieldId = typeof p.mirrorFieldId === 'string' ? p.mirrorFieldId.trim() : ''
  if (p.twoWay !== true || !foreignSheetId || !mirrorFieldId) return null
  return { foreignSheetId, mirrorFieldId }
}

export interface ExactAnchorLinkInvalidation {
  sheetId: string
  recordIds: string[]
  fieldIds: string[]
}

function addLinkInvalidation(
  groups: Map<string, { recordIds: Set<string>; fieldIds: Set<string> }>,
  sheetId: string,
  recordId: string,
  fieldId: string,
): void {
  const group = groups.get(sheetId) ?? { recordIds: new Set<string>(), fieldIds: new Set<string>() }
  group.recordIds.add(recordId)
  group.fieldIds.add(fieldId)
  groups.set(sheetId, group)
}

function serializeLinkInvalidations(
  groups: Map<string, { recordIds: Set<string>; fieldIds: Set<string> }>,
): ExactAnchorLinkInvalidation[] {
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([sheetId, group]) => ({
      sheetId,
      recordIds: [...group.recordIds].sort(),
      fieldIds: [...group.fieldIds].sort(),
    }))
}

async function collectResetLinkInvalidations(
  query: QueryFn,
  deleteRecordIds: readonly string[],
): Promise<ExactAnchorLinkInvalidation[]> {
  if (deleteRecordIds.length === 0) return []
  const deleteIds = [...new Set(deleteRecordIds)]
  const deleteSet = new Set(deleteIds)
  const rows = (await query(
    `SELECT ml.record_id, ml.foreign_record_id,
            f.id AS field_id, f.sheet_id AS source_sheet_id, f.property,
            source_sheet.base_id AS source_base_id
       FROM meta_links ml
       JOIN meta_fields f ON f.id = ml.field_id
       JOIN meta_sheets source_sheet ON source_sheet.id = f.sheet_id
      WHERE ml.record_id = ANY($1::text[])
         OR ml.foreign_record_id = ANY($1::text[])
      ORDER BY f.sheet_id, f.id, ml.record_id, ml.foreign_record_id`,
    [deleteIds],
  )).rows as Array<{
    record_id: unknown
    foreign_record_id: unknown
    field_id: unknown
    source_sheet_id: unknown
    property: unknown
    source_base_id: unknown
  }>

  const foreignSheetIds = new Set<string>()
  for (const row of rows) {
    const property = row.property && typeof row.property === 'object' && !Array.isArray(row.property)
      ? row.property as Record<string, unknown>
      : {}
    const cfg = twoWayMirrorConfig(property)
    if (cfg) foreignSheetIds.add(cfg.foreignSheetId)
  }
  const baseBySheetId = new Map<string, string | null>()
  if (foreignSheetIds.size > 0) {
    const baseRows = (await query(
      'SELECT id, base_id FROM meta_sheets WHERE id = ANY($1::text[])',
      [[...foreignSheetIds]],
    )).rows as Array<{ id: unknown; base_id: unknown }>
    for (const row of baseRows) {
      baseBySheetId.set(String(row.id), typeof row.base_id === 'string' ? row.base_id : null)
    }
  }

  const groups = new Map<string, { recordIds: Set<string>; fieldIds: Set<string> }>()
  for (const row of rows) {
    const sourceRecordId = String(row.record_id)
    const targetRecordId = String(row.foreign_record_id)
    const fieldId = String(row.field_id)
    const sourceSheetId = String(row.source_sheet_id)
    const sourceBaseId = typeof row.source_base_id === 'string' ? row.source_base_id : null
    const property = row.property && typeof row.property === 'object' && !Array.isArray(row.property)
      ? row.property as Record<string, unknown>
      : {}

    // An inbound edge disappears when its target is reset-deleted. The surviving source record's
    // authoritative link projection changed, so invalidate that source field/record.
    if (deleteSet.has(targetRecordId) && !deleteSet.has(sourceRecordId)) {
      addLinkInvalidation(groups, sourceSheetId, sourceRecordId, fieldId)
    }

    // An outbound two-way edge disappears with its source record. Match RecordWriteService's
    // same-base mirror nudge; cross-base mirror reads remain pull/refetch only by existing design.
    if (deleteSet.has(sourceRecordId)) {
      const cfg = twoWayMirrorConfig(property)
      if (
        cfg &&
        baseBySheetId.has(cfg.foreignSheetId) &&
        sourceBaseId === baseBySheetId.get(cfg.foreignSheetId)
      ) {
        addLinkInvalidation(groups, cfg.foreignSheetId, targetRecordId, cfg.mirrorFieldId)
      }
    }
  }
  return serializeLinkInvalidations(groups)
}

async function loadSameBaseMirrorConfigByField(
  query: QueryFn,
  sourceSheetId: string,
  rawPropById: ReadonlyMap<string, Record<string, unknown>>,
  writableLinkFieldIds: ReadonlySet<string>,
): Promise<Map<string, TwoWayMirrorConfig>> {
  const configByField = new Map<string, TwoWayMirrorConfig>()
  const sheetIds = new Set<string>([sourceSheetId])
  for (const fieldId of writableLinkFieldIds) {
    const cfg = twoWayMirrorConfig(rawPropById.get(fieldId))
    if (!cfg) continue
    configByField.set(fieldId, cfg)
    sheetIds.add(cfg.foreignSheetId)
  }
  if (configByField.size === 0) return configByField

  const baseRows = (await query(
    'SELECT id, base_id FROM meta_sheets WHERE id = ANY($1::text[])',
    [[...sheetIds]],
  )).rows as Array<{ id: unknown; base_id: unknown }>
  const baseBySheetId = new Map<string, string | null>()
  for (const row of baseRows) {
    baseBySheetId.set(String(row.id), typeof row.base_id === 'string' ? row.base_id : null)
  }
  if (!baseBySheetId.has(sourceSheetId)) return new Map()
  const sourceBaseId = baseBySheetId.get(sourceSheetId)
  for (const [fieldId, cfg] of configByField) {
    if (!baseBySheetId.has(cfg.foreignSheetId) || baseBySheetId.get(cfg.foreignSheetId) !== sourceBaseId) {
      configByField.delete(fieldId)
    }
  }
  return configByField
}

/**
 * W0-1 v3.7 Lane L8 — the exact-anchor DESTRUCTIVE APPLY: one transaction, all-or-nothing.
 *
 * Design authority: v3.7 lock (#4331) §5 (execute = full target/schema/set recomputation UNDER THE FENCE;
 * all writes + revisions/tombstones in one txn; lock/permission recheck before apply) + §2 (canonical fence;
 * formula/lookup/rollup/auto-number non-restorable) + L6-b/L7 stack.
 *
 * THE SHAPE — one outer transaction, COMMIT once, any failure ⇒ FULL ROLLBACK (incl. burn):
 *   0. TRANSACTION PROOF: `assertInTransaction` (pg_current_xact_id probe, pg-transaction-guard) before
 *      ANY fence/burn/write. A forged `transaction` wrapper running autocommit statements would make
 *      "all-or-nothing" a lie (a committed burn over a failed apply, half-applied writes); the probe asks
 *      Postgres itself. Failure ⇒ the same values-free `recovery-trust-required` (non-oracular).
 *   1. fenceWriterEntry (L4, fence-FIRST).
 *   2. ENV-ONLY TRUST FLAGS (kernel fail-closed): BOTH `MULTITABLE_ENABLE_WRITER_FENCE` and
 *      `MULTITABLE_HISTORY_CONTIGUITY_STRICT` must be on.
 *   3. PRELIMINARY in-fence full-read + authorizedScopeHash (P1-2), BEFORE any sheet-state
 *      integrity/anchor adjudication. A revoke while parked on the fence must get uniform
 *      `forbidden`, never an oracle.
 *   4. Production `precheckSheetHistoryIntegrity` under the fence; any non-ok ⇒
 *      `history-incomplete`, zero writes. The direct strict seam is test-only and must not be used here.
 *   5. BURN the token (anti-replay PK; rolled back on every later refusal).
 *   6. IN-FENCE checkpoint re-resolution (never trust the token echo).
 *   7. Composed scopeHash drift, then §5 step 7 ROW LOCKS over the FULL current live set
 *      (`ORDER BY id FOR UPDATE`, deterministic — never only the delta: a RESET delete-set escape or a
 *      version bump on a "non-affected" row is still live-set drift) + liveSetHash check from the LOCKED
 *      rows, then a FRESH id/version re-hash in a NEW statement snapshot (catches an unfenced CREATE or a
 *      not-yet-locked bump committed while the lock statement was PARKED behind a concurrent writer).
 *      Malformed live truth (non-object data, non-integer/negative version) is NEVER coerced — it refuses
 *      `recovery-trust-required`, as does `ExactAnchorPlanDataError` from the plan classifier.
 *   8. Plan (L7); schema-drift whole-reject; RESURRECT fail-closed (`inbound-unprovable` — D1c link history
 *      unsolved; temporary kernel boundary, not route-deferred replay).
 *   9. Canonical restorable PROJECTION only (projectRestorableOntoLive) — derived-only ⇒ no-op. Builds the
 *      exact write delta WITHOUT scalar/link validation (no-oracle: value/existence must not leak before auth).
 *  10. Lock the source/changed-foreign sheet authority rows plus actor membership tables through COMMIT,
 *      then repeat full-read and run REQUIRED `evaluatePlanAuthorization` over that delta (person membership
 *      + foreign-target read/edit authority belong here in the route adapter). Deny ⇒ uniform `forbidden`
 *      before any sensitive validator.
 *  11. AFTER planAuth=true: scalar/whole-record CURRENT validation, foreign-target existence, hierarchy cycle.
 *  12. APPLY: restorable reverts (data + meta_links, version-CAS) + RESET canonical delete parity
 *      (version-CAS delete) — any CAS miss ⇒ `preview-drift`, full rollback; seal last.
 *
 * THREAT-MODEL HONESTY (ratified all-writer-fence, v3.7 §2): every writer in the recovery trust model takes
 * the canonical fence. Named revision-exempt provisioning writers remain outside that model; a user-content
 * mismatch they leave behind is refused by the strict precheck before apply. The full-set FOR UPDATE + fresh
 * re-hash + write-time CAS additionally catch fence-BYPASSING direct SQL that committed up to that final
 * recheck. Arbitrary direct SQL committed AFTER the final recheck (e.g. an INSERT while validation runs) is
 * indistinguishable from a hostile DB session and is OUTSIDE the model — no READ COMMITTED in-transaction
 * recheck can close it; that class would require SERIALIZABLE or triggers.
 *
 * KERNEL-OWNED: security adjudication, restorable projection, link integrity, both-direction reset cleanup,
 * tombstone/trash, anti-replay, trust substrate. Route-owned: presentation masking, size ceilings, realtime,
 * HTTP mapping. WIRED by the univer-meta revert/reset routes (W2); env flags stay default-OFF and
 * `RECONSTRUCTION_CAUSALITY_LANDED` flipped true in that same wiring change.
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
  | 'schema-drift' // schemaHash mismatch (retype/property/field set) OR plan.driftCount > 0 ⇒ WHOLE apply refused, zero writes
  | 'inbound-unprovable' // plan.resurrects.length > 0 — at-anchor inbound relations cannot be proven (D1c)
  | 'link-integrity' // missing/ambiguous foreign sheet, missing/wrong-sheet target, same-op delete target, mirror, or hierarchy parent cycle
  | 'value-invalid' // current-schema scalar exactness OR whole-record validateRecord fails
  | 'record-locked' // in-fence lock check: record locked by another actor (values-free)
  | 'history-incomplete' // strict in-fence chain/content precheck failed; established values-free 409 contract
  | 'recovery-trust-required' // fence/strict/txn substrate missing or malformed

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
 * PROJECTION (before scalar/link validation) so the route adapter can enforce manage-sheet + per-record
 * edit/delete/row ownership + field-write permissions over exactly the true restorable delta (not full
 * snapshots).
 *
 * ROUTE ADAPTER MUST also adjudicate inside this callback (no-oracle / cross-base parity):
 *   - person-field membership (whether historical person ids are still allowable for the actor/sheet),
 *   - foreign link target READ/EDIT authority (including cross-base target sheet access).
 * Those checks MUST run here so a denied actor receives uniform `forbidden` and cannot distinguish
 * value-invalid / link-integrity / missing-target via response shape.
 */
export interface ExactAnchorPlanAuthContext {
  mode: ExactAnchorApplyMode
  sheetId: string
  actorId: string
  plan: ExactAnchorRecoveryPlan
  /** reverts that would write (isNoOp filtered out) — projected delta, not yet value/target validated. */
  revertWrites: ExactAnchorRevertWriteIntent[]
  /** record ids the TOKEN-BOUND reset mode would delete. */
  deleteRecordIds: string[]
}

/**
 * REQUIRED — omission is a TypeScript error. Must return true to proceed to sensitive validation + writes.
 * Invoked AFTER restorable projection and BEFORE scalar/whole-record validation, foreign-target existence,
 * and hierarchy-cycle checks. Route adapters: include person membership + foreign-target read/edit authority
 * (see {@link ExactAnchorPlanAuthContext}).
 */
export type EvaluatePlanAuthorization = (
  query: QueryFn,
  context: ExactAnchorPlanAuthContext,
) => Promise<boolean>

/**
 * One APPLIED mutation fact, emitted through {@link ExactAnchorMutationTxnHook} INSIDE the destructive
 * transaction, immediately after that mutation's own writes (row + links + revision) succeeded. The
 * `patch` is the true restorable delta for EVENT-PAYLOAD use only (durable enqueue / post-commit
 * automation emit) — route adapters must never serialize it into HTTP results (values-free contract).
 */
export type ExactAnchorAppliedMutation =
  | {
      kind: 'revert'
      recordId: string
      /** post-write version (CAS-returned, revision-emitted). */
      version: number
      changedFieldIds: string[]
      patch: Record<string, unknown>
      revisionId: string
      linkInvalidations: ExactAnchorLinkInvalidation[]
    }
  | {
      kind: 'delete'
      recordId: string
      revisionId: string
      linkInvalidations: ExactAnchorLinkInvalidation[]
    }

/**
 * OPTIONAL same-transaction seam for durable event enqueue (P1#2d family): the route adapter builds one
 * stable event payload per mutation and enqueues it through `enqueueRecordEventIfDurable` on the SAME
 * `query`, so the enqueue commits or rolls back atomically with the source writes. A hook throw
 * propagates and forces the FULL rollback (atomicity is bidirectional — no half-enqueued recovery).
 */
export type ExactAnchorMutationTxnHook = (query: QueryFn, mutation: ExactAnchorAppliedMutation) => Promise<void>

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

/** Database conflicts that are safe, whole-transaction retry signals rather than server faults. */
export function classifyExactAnchorDatabaseConflict(e: unknown): ExactAnchorApplyRefusal | null {
  if (typeof e !== 'object' || e === null) return null
  const pg = e as { code?: unknown; constraint?: unknown }
  if (pg.code === '40P01' || pg.code === '40001') return 'preview-drift'
  if (isLiveLinkTargetForeignKeyViolation(e)) {
    return 'link-integrity'
  }
  return null
}

/**
 * Live-state truth must be WELL-FORMED — a malformed row is corrupt substrate, not a value to coerce.
 * (The old `asRec`/`Number(...) || 0` coercions could hash a corrupt row into a "matching" live set and
 * then destructively write over it.) Refusal is the values-free `recovery-trust-required`.
 */
const requireLiveData = (v: unknown): Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new ApplyRefusalError('recovery-trust-required')
  }
  return v as Record<string, unknown>
}
const requireLiveVersion = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new ApplyRefusalError('recovery-trust-required')
  }
  return v
}

export interface ExactAnchorApplyInput {
  token: string
  sheetId: string
  actorId: string
  /** REQUIRED in-fence full-read adjudication (P1-2) — same contract as the preview. */
  evaluateFullReadAccess: EvaluateRecoveryFullReadAccess
  /**
   * REQUIRED in-fence WRITE authorization over the true restorable projection delta (v3.7 §5).
   * Invoked AFTER projection and BEFORE scalar/link validation + mintOperation/any write (no-oracle).
   * Route adapters must include person membership + foreign-target read/edit authority here.
   * Omission is structurally impossible (typed required field). Full-read alone is insufficient.
   */
  evaluatePlanAuthorization: EvaluatePlanAuthorization
  /**
   * OPTIONAL same-transaction mutation seam (see {@link ExactAnchorMutationTxnHook}). Invoked once per
   * applied revert/delete AFTER that mutation's writes, BEFORE sealOperation. A throw ⇒ full rollback.
   */
  onMutationApplied?: ExactAnchorMutationTxnHook
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
  const { anchorSeq, checkpointId, scopeHash, liveSetHash, schemaHash, mode, authorizedScopeHash } = verified.claims

  try {
    return await transaction(async (query) => {
      // 0. PROVE a real ongoing transaction (pg_current_xact_id probe) before any fence/burn/write. A
      //    forged wrapper over a pool/autocommit client is caught by Postgres itself, not a marker; the
      //    refusal is the same values-free substrate refusal as every other trust failure (non-oracular).
      try {
        await assertInTransaction(
          {
            query: async (sql: string, params?: unknown[]) => {
              const res = await query(sql, params)
              return { rows: res.rows as Array<Record<string, unknown>>, rowCount: res.rowCount ?? null }
            },
          },
          'exact-anchor destructive apply',
        )
      } catch {
        throw new ApplyRefusalError('recovery-trust-required')
      }

      // 1. Fence-first (L4).
      await fenceWriterEntry(query, input.sheetId)

      // 2. ENV-ONLY TRUST FLAGS — before any sheet-state adjudication, burn, or write. Fence alone is
      //    a flag-off no-op; refuse unless the trusted recovery substrate is actually armed.
      if (!isWriterFenceEnabled() || !isContiguityStrictMode()) {
        throw new ApplyRefusalError('recovery-trust-required')
      }

      // 3. PRELIMINARY in-fence full-read + authorizedScopeHash (P1-2), FIRST among sheet-state checks.
      //    This preserves the no-oracle ordering while the plan is assembled. The authoritative full-read
      //    and plan checks run again below while holding every relevant permission-authority lock through
      //    COMMIT, closing a revoke-after-check race without exposing history/checkpoint state.
      if (!(await input.evaluateFullReadAccess(query))) throw new ApplyRefusalError('forbidden')
      if (authorizedScopeHash !== hashRecoveryAuthorizationScope({ sheetId: input.sheetId, actorId: input.actorId })) {
        throw new ApplyRefusalError('forbidden')
      }

      // 4. Strict history under the fence, after authority is freshly established.
      const trust = await precheckSheetHistoryIntegrity(query, input.sheetId)
      if (!trust.ok) throw new ApplyRefusalError('history-incomplete')

      // 5. Burn — at-most-once barrier (rolled back on any later refusal).
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

      // 6. In-fence checkpoint re-resolution.
      const checkpoint = await selectCheckpointByAnchorSeq(query, input.sheetId, anchorSeq)
      if (!checkpoint) throw new ApplyRefusalError('no-covering-checkpoint')
      if (checkpoint.id !== checkpointId) throw new ApplyRefusalError('checkpoint-changed')

      // 6. Dual-hash drift + live rows for plan/projection.
      const replayMap = await reconstructRecordsAtSeq(query, input.sheetId, anchorSeq)
      let composed: Map<string, RecordStateAtT>
      try {
        composed = await composeBaselineOverlay(query, { sheetId: input.sheetId, checkpointId: checkpoint.id, stateMap: replayMap })
      } catch (error) {
        if (error instanceof ExactAnchorHistoryDataError) throw new ApplyRefusalError('history-incomplete')
        throw error
      }
      const anchorHash = hashAnchorRecoveryScope(
        [...composed.values()].map((s) => ({ recordId: s.recordId, exists: s.exists, version: s.version })),
      )
      if (anchorHash !== scopeHash) throw new ApplyRefusalError('preview-drift')

      // §5 step 7 ROW LOCKS — the FULL current live set, deterministic id order (multi-writer deadlock
      // safety). Locking only the write delta is NOT enough under the ratified all-writer-fence model's
      // direct-SQL hardening: a RESET's stale delete set and a version bump on a "non-affected" row are
      // both live-set drift the token's liveSetHash must veto, so every live row is locked and hashed
      // from the LOCKED (EvalPlanQual-fresh) truth. Malformed rows fail closed — never coerced.
      let liveById = new Map<string, {
        data: Record<string, unknown>
        version: number
        locked?: unknown
        locked_by?: unknown
        created_by?: unknown
        created_at?: unknown
        updated_at?: unknown
      }>()
      for (const r of (await query(
        `SELECT id, data, version, locked, locked_by, created_by, created_at, updated_at
         FROM meta_records WHERE sheet_id = $1
         ORDER BY id
         FOR UPDATE`,
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
          data: requireLiveData(r.data),
          version: requireLiveVersion(r.version),
          locked: r.locked,
          locked_by: r.locked_by,
          created_by: r.created_by,
          created_at: r.created_at,
          updated_at: r.updated_at,
        })
      }
      const liveHash = hashExactAnchorLiveSet(
        [...liveById.entries()].map(([recordId, l]) => ({ recordId, version: l.version })),
        await loadAuthoritativeLiveLinkEdgesForSheet(query, input.sheetId),
      )
      if (liveHash !== liveSetHash) throw new ApplyRefusalError('preview-drift')

      // FRESH id/version re-hash in a NEW statement snapshot. If the lock above PARKED behind a concurrent
      // writer, rows that writer committed AFTER the lock statement's snapshot began — an unfenced CREATE
      // (FOR UPDATE cannot lock a phantom) or a bump on a row not yet locked — are visible only to a fresh
      // statement. Any divergence from the token ⇒ preview-drift, full rollback (burn included).
      // HONESTY: fence-bypassing direct SQL committed AFTER this recheck is outside the all-writer-fence
      // model (see module doc); fenced writers cannot commit while we hold the fence.
      const recheckHash = hashExactAnchorLiveSet(
        ((await query('SELECT id, version FROM meta_records WHERE sheet_id = $1', [input.sheetId]))
          .rows as Array<{ id: unknown; version: unknown }>)
          .map((r) => ({ recordId: String(r.id), version: requireLiveVersion(r.version) })),
        await loadAuthoritativeLiveLinkEdgesForSheet(query, input.sheetId),
      )
      if (recheckHash !== liveSetHash) throw new ApplyRefusalError('preview-drift')

      // 6b. G-SCHEMA-BEFORE-FENCE — CURRENT field surface must match the token-bound schemaHash.
      // Catches retype (string→longText) and property-only edits that leave record ids/versions unchanged
      // and may still leave historical values "valid" under the new type (scope/live hashes cannot see this).
      const schemaRes = await query('SELECT id, type, property FROM meta_fields WHERE sheet_id = $1', [input.sheetId])
      const schemaRows = schemaRes.rows as Array<{ id: unknown; type: unknown; property: unknown }>
      const liveSchemaHash = hashExactAnchorSchema(
        schemaRows.map((r) => ({ id: String(r.id), type: String(r.type ?? ''), property: r.property })),
      )
      if (liveSchemaHash !== schemaHash) throw new ApplyRefusalError('schema-drift')

      // Field surface for restorable projection (exclude mirror-owned link fields — spine invariant).
      // Also load RAW property blobs so link alias ambiguity is not collapsed by serializeFieldRow.
      const fieldIds = new Set(schemaRows.map((r) => String(r.id)))
      const rawTypeById = new Map(schemaRows.map((r) => [String(r.id), String(r.type ?? '')]))
      const fields = await loadFieldsForSheet(query, input.sheetId)
      const rawPropRes = await query('SELECT id, property FROM meta_fields WHERE sheet_id = $1', [input.sheetId])
      const rawPropById = new Map<string, Record<string, unknown>>()
      for (const r of rawPropRes.rows as Array<{ id: unknown; property: unknown }>) {
        let prop: Record<string, unknown> = {}
        if (r.property && typeof r.property === 'object' && !Array.isArray(r.property)) {
          prop = r.property as Record<string, unknown>
        } else if (typeof r.property === 'string' && r.property.trim()) {
          try {
            const parsed = JSON.parse(r.property) as unknown
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) prop = parsed as Record<string, unknown>
          } catch { /* ignore */ }
        }
        rawPropById.set(String(r.id), prop)
      }
      const fieldById = new Map<string, MultitableField>()
      const projectionFieldById = new Map<string, { type: string }>()
      const writableLinkFieldIds = new Set<string>()
      for (const f of fields) {
        fieldById.set(f.id, f)
        if (f.type === 'link' && isFieldAlwaysReadOnly(f)) continue
        if (f.type === 'link') writableLinkFieldIds.add(f.id)
        projectionFieldById.set(f.id, { type: f.type })
      }

      // meta_links is authoritative for writable forward links; meta_records.data is not a second
      // authority and can legitimately retain stale link-shaped JSON after normal delete/repair flows.
      // Hydrate the effective current relation exactly like read paths before planning. A duplicate
      // authoritative edge remains corrupt substrate and fails closed.
      try {
        liveById = await hydrateLiveLinkProjection(query, liveById, writableLinkFieldIds)
      } catch (error) {
        if (error instanceof LiveLinkProjectionDataError) {
          throw new ApplyRefusalError('recovery-trust-required')
        }
        throw error
      }
      const sameBaseMirrorConfigByField = await loadSameBaseMirrorConfigByField(
        query,
        input.sheetId,
        rawPropById,
        writableLinkFieldIds,
      )

      // 7. Plan (L7). A malformed at-anchor/live snapshot (ExactAnchorPlanDataError) is corrupt
      //    substrate — the same values-free recovery-trust-required, never a coerced-through plan.
      let plan: ExactAnchorRecoveryPlan
      try {
        plan = classifyExactAnchorRecoveryPlan(composed, liveById, fieldIds)
      } catch (e) {
        if (e instanceof ExactAnchorPlanDataError) throw new ApplyRefusalError('recovery-trust-required')
        throw e
      }

      if (plan.driftCount > 0) throw new ApplyRefusalError('schema-drift')

      // RESURRECT fail-closed: D1c leaves link-edge history unsolved; terminal tombstones/current neighbors
      // cannot prove the inbound relation set AT the requested anchor. Whole-apply refuse — never partial.
      if (plan.resurrects.length > 0) throw new ApplyRefusalError('inbound-unprovable')

      const deleteRecordIds =
        mode === 'reset' ? [...plan.deletedAtAnchorLiveNow, ...plan.createdAfterAnchor] : []
      const deleteIdSet = new Set(deleteRecordIds)

      // Restorable PROJECTION only (no value/target validation yet — no-oracle ordering).
      // Build the exact write delta first; planAuth adjudicates it before any sensitive validator can leak.
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

      // Row locks were taken over the FULL live set (ORDER BY id FOR UPDATE) before the liveSetHash check,
      // so liveById already IS in-lock truth for ensureRecordNotLocked + apply. This assertion pins the
      // plan/projection invariant locally; write-time CAS remains the concurrency guard.
      for (const rw of revertWrites) {
        const live = liveById.get(rw.recordId)
        if (!live || live.version !== rw.liveVersion) throw new ApplyRefusalError('preview-drift')
      }

      const authorizationContext: ExactAnchorPlanAuthContext = {
        mode,
        sheetId: input.sheetId,
        actorId: input.actorId,
        plan,
        revertWrites,
        deleteRecordIds,
      }

      // Stabilize sheet-local permission authority before the final adjudication. All production
      // sheet/field/record permission writers take the owning meta_sheets row lock. Actor/person RBAC,
      // active-user, role and member-group authority is stabilized by the route adapter's DB-enforced
      // per-user advisory protocol; no process-wide table lock is taken here.
      // Acquiring all sheet rows in one ORDER BY avoids A->B / B->A recovery deadlocks.
      const authoritySheetIds = new Set<string>([input.sheetId])
      for (const rw of revertWrites) {
        for (const lu of rw.linkUpdates) {
          const foreignSheetId = resolveForeignSheetIdFromProperty(rawPropById.get(lu.fieldId))
          if (!foreignSheetId) throw new ApplyRefusalError('forbidden')
          authoritySheetIds.add(foreignSheetId)
        }
      }
      const orderedAuthoritySheetIds = [...authoritySheetIds].sort()
      const authorityRows = await query(
        `SELECT id FROM meta_sheets
          WHERE id = ANY($1::text[])
          ORDER BY id
          FOR UPDATE`,
        [orderedAuthoritySheetIds],
      )
      const lockedAuthorityIds = new Set(
        (authorityRows.rows as Array<{ id: unknown }>).map((row) => String(row.id)),
      )
      if (orderedAuthoritySheetIds.some((id) => !lockedAuthorityIds.has(id))) {
        throw new ApplyRefusalError('forbidden')
      }
      // REQUIRED FINAL authorization over the true restorable delta (BEFORE scalar/link validation).
      // Full-read is repeated under the authority locks; the route adapter then covers source row/field,
      // person membership, and foreign target read/edit authority. Every denial is the same `forbidden`,
      // so value-invalid / missing-target cannot become an authorization oracle.
      if (!(await input.evaluateFullReadAccess(query))) throw new ApplyRefusalError('forbidden')
      if (!(await input.evaluatePlanAuthorization(query, authorizationContext))) {
        throw new ApplyRefusalError('forbidden')
      }

      // AFTER planAuth=true — sensitive validators (may distinguish shapes only for authorized writers).
      // Per-scalar exactness under CURRENT codecs (delegates longText → validateLongTextValue).
      for (const rw of revertWrites) {
        try {
          for (const fid of rw.changedFieldIds) {
            const field = fieldById.get(fid)
            if (!field) continue
            if (field.type === 'link') continue // dedicated link path below
            const hist = rw.patch[fid]
            if (hist === null || hist === undefined) continue // unset; whole-record check covers required
            assertExactRestorableScalarValue(
              {
                id: field.id,
                type: field.type,
                property: field.property as Record<string, unknown> | undefined,
                options: field.options,
              },
              hist,
            )
          }
          // Whole projected record: explicit property.validation ?? getDefaultValidationRules
          // (same precedence as record-service buildDirectValidationFields).
          assertExactRestorableRecordValid(
            fields.map((f) => ({
              id: f.id,
              name: f.name,
              type: f.type,
              property: f.property as Record<string, unknown> | undefined,
            })),
            rw.projectedData,
          )
        } catch (e) {
          if (e instanceof ExactRestoreValueError) throw new ApplyRefusalError('value-invalid')
          throw e
        }
      }

      // Foreign-link integrity for every changed writable forward link (incl. existence — oracle-class).
      for (const rw of revertWrites) {
        for (const lu of rw.linkUpdates) {
          const field = fieldById.get(lu.fieldId)
          if (!field || field.type !== 'link') throw new ApplyRefusalError('link-integrity')
          if (isFieldAlwaysReadOnly(field)) throw new ApplyRefusalError('link-integrity')
          const foreignSheetId = resolveForeignSheetIdFromProperty(rawPropById.get(lu.fieldId))
          if (!foreignSheetId) throw new ApplyRefusalError('link-integrity') // missing OR ambiguous aliases
          const targetIds = lu.targetIds
          if (targetIds.length === 0) continue
          // Same-operation delete: a projected link target that this apply will delete becomes dangling.
          if (targetIds.some((id) => deleteIdSet.has(id))) throw new ApplyRefusalError('link-integrity')
          // The route authorization adapter already holds these target rows FOR UPDATE through COMMIT;
          // re-select them here to keep the kernel's existence/wrong-sheet check explicit. The database
          // FK is the final structural guard for every link writer and target-delete path.
          const found = await query(
            `SELECT id FROM meta_records
              WHERE sheet_id = $1 AND id = ANY($2::text[])
              ORDER BY id
              FOR KEY SHARE`,
            [foreignSheetId, targetIds],
          )
          const foundSet = new Set((found.rows as Array<{ id: unknown }>).map((row) => String(row.id)))
          if (targetIds.some((id) => !foundSet.has(id))) throw new ApplyRefusalError('link-integrity')
        }
      }

      // Hierarchy parent cycle (RecordWriteService parity): multi-record FINAL-STATE overrides, before mutation.
      // A historical same-sheet parent link can be valid at the anchor yet cycle against the CURRENT live graph.
      {
        const changesByRecord = new Map<string, Array<{ fieldId: string; value: unknown }>>()
        for (const rw of revertWrites) {
          if (rw.linkUpdates.length === 0) continue
          changesByRecord.set(
            rw.recordId,
            rw.linkUpdates.map((lu) => ({ fieldId: lu.fieldId, value: lu.targetIds })),
          )
        }
        if (changesByRecord.size > 0) {
          const linkGuardById = new Map<string, HierarchyCycleLinkGuard>()
          for (const f of fields) {
            if (f.type !== 'link') {
              linkGuardById.set(f.id, { type: f.type })
              continue
            }
            const foreignSheetId = resolveForeignSheetIdFromProperty(rawPropById.get(f.id))
            const prop = rawPropById.get(f.id) ?? {}
            const limitSingle =
              prop.limitSingleRecord === true ||
              prop.isSingle === true ||
              // property may use nested link shape after serializeFieldRow
              (f.property as { link?: { limitSingleRecord?: unknown } } | undefined)?.link?.limitSingleRecord === true
            linkGuardById.set(f.id, {
              type: 'link',
              link: foreignSheetId
                ? { foreignSheetId, limitSingleRecord: limitSingle }
                : null,
            })
          }
          const sameSheetLinkChangeFieldIds = collectSameSheetLinkChangeFieldIds({
            changesByRecord,
            fieldById: linkGuardById,
            sheetId: input.sheetId,
          })
          if (sameSheetLinkChangeFieldIds.size > 0) {
            const hierarchyParentFieldIds = await loadHierarchyParentFieldIds({
              query,
              sheetId: input.sheetId,
              fields: fields.map((f) => ({
                id: f.id,
                type: f.type,
                order: typeof f.order === 'number' ? f.order : undefined,
                property: f.property as Record<string, unknown> | undefined,
              })),
            })
            const guardedHierarchyParentFieldIds = new Set(
              [...sameSheetLinkChangeFieldIds].filter((fid) => hierarchyParentFieldIds.has(fid)),
            )
            if (guardedHierarchyParentFieldIds.size > 0) {
              const hierarchyParentOverridesByField = buildHierarchyParentOverridesByField({
                changesByRecord,
                hierarchyParentFieldIds: guardedHierarchyParentFieldIds,
                normalizeLinkIds,
              })
              for (const rw of revertWrites) {
                for (const lu of rw.linkUpdates) {
                  if (!guardedHierarchyParentFieldIds.has(lu.fieldId)) continue
                  const foreignSheetId = resolveForeignSheetIdFromProperty(rawPropById.get(lu.fieldId))
                  if (foreignSheetId !== input.sheetId) continue
                  // Empty parent clears the edge — cannot create a cycle.
                  if (lu.targetIds.length === 0) continue
                  try {
                    await assertNoHierarchyParentCycle({
                      query,
                      sheetId: input.sheetId,
                      recordId: rw.recordId,
                      fieldId: lu.fieldId,
                      parentRecordIds: lu.targetIds,
                      parentOverridesByRecord: hierarchyParentOverridesByField.get(lu.fieldId) ?? new Map(),
                      normalizeLinkIds,
                    })
                  } catch (e) {
                    if (e instanceof HierarchyCycleError) throw new ApplyRefusalError('link-integrity')
                    throw e
                  }
                }
              }
            }
          }
        }
      }

      // Apply — every write revision-emitted + ledger-tagged.
      const op = await mintOperation(query, input.sheetId)

      let sheetBaseId: string | null = null
      if (deleteRecordIds.length > 0) {
        const baseRow = (await query('SELECT base_id FROM meta_sheets WHERE id = $1', [input.sheetId])).rows[0] as
          | { base_id?: unknown }
          | undefined
        sheetBaseId = baseRow && typeof baseRow.base_id === 'string' ? baseRow.base_id : null
      }
      const resetLinkInvalidations = mode === 'reset'
        ? await collectResetLinkInvalidations(query, deleteRecordIds)
        : []

      // RESET: two-phase delete inside the same txn so cross-links between delete candidates are captured
      // against the ORIGINAL graph (not order-dependent after the first link wipe).
      //   phase 1 — lock + pre-gen revision ids + inbound tombstone capture/cap for ALL deletes
      //   phase 2 — both-direction link delete + revision + trash + live delete for each
      let deletes = 0
      if (mode === 'reset') {
        type PendingDelete = {
          recordId: string
          live: NonNullable<ReturnType<typeof liveById.get>>
          revisionId: string
        }
        const pending: PendingDelete[] = []
        for (const recordId of deleteRecordIds) {
          const live = liveById.get(recordId)
          if (!live) continue
          ensureRecordNotLocked(
            input.actorId,
            live,
            () => new ApplyRefusalError('record-locked'),
          )
          pending.push({ recordId, live, revisionId: randomUUID() })
        }
        // Phase 1: capture ALL inbound tombstones against the original graph.
        if (isTombstoneCaptureEnabled()) {
          let totalCap = 0
          for (const p of pending) totalCap += await countInboundLinkCaptureRows(query, p.recordId)
          assertWithinCaptureCap(totalCap)
          for (const p of pending) {
            await insertInboundLinkTombstones(query, {
              sheetId: input.sheetId,
              recordId: p.recordId,
              sourceRevisionId: p.revisionId,
            })
          }
        }
        // Phase 2: destroy links + revise + trash + live delete.
        for (let pendingIndex = 0; pendingIndex < pending.length; pendingIndex++) {
          const p = pending[pendingIndex]!
          await query('DELETE FROM meta_links WHERE record_id = $1 OR foreign_record_id = $1', [p.recordId])
          // lock-guarded: L8 reset delete — ensureRecordNotLocked in phase-1 loop, same txn.
          // revision-emitted: L8 reset delete — pre-gen id so trash + tombstones share the causal anchor.
          await recordRecordRevision(query, {
            sheetId: input.sheetId,
            recordId: p.recordId,
            version: p.live.version,
            action: 'delete',
            source: 'restore',
            actorId: input.actorId,
            changedFieldIds: [],
            patch: {},
            snapshot: p.live.data,
            id: p.revisionId,
            ledger: op,
          })
          const createdBy = typeof p.live.created_by === 'string' ? p.live.created_by : null
          await query(
            `INSERT INTO meta_records_trash
               (record_id, sheet_id, base_id, data, original_version, created_by, deleted_by,
                original_created_at, original_updated_at, delete_revision_id)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)`,
            [
              p.recordId,
              input.sheetId,
              sheetBaseId,
              JSON.stringify(p.live.data),
              p.live.version,
              createdBy,
              input.actorId,
              p.live.created_at ?? null,
              p.live.updated_at ?? null,
              p.revisionId,
            ],
          )
          // Version-CAS on the LOCKED expected version: a zero-row delete means the row moved under us
          // (fence-bypassing direct SQL / same-txn side effect) ⇒ preview-drift, full rollback — never a
          // bare Error and never an unconditional delete of a row the token did not hash.
          // lock-guarded: L8 reset delete — ensureRecordNotLocked earlier in this txn.
          // revision-emitted: L8 reset delete — recordRecordRevision(action:'delete', id=pre-gen) above.
          const del = await query(
            'DELETE FROM meta_records WHERE id = $1 AND sheet_id = $2 AND version = $3 RETURNING version',
            [p.recordId, input.sheetId, p.live.version],
          )
          if (!del.rows[0]) throw new ApplyRefusalError('preview-drift')
          // Same-txn mutation seam (durable event enqueue) — atomic with THIS delete's writes.
          if (input.onMutationApplied) {
            await input.onMutationApplied(query, {
              kind: 'delete',
              recordId: p.recordId,
              revisionId: p.revisionId,
              linkInvalidations: pendingIndex === 0 ? resetLinkInvalidations : [],
            })
          }
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
            () => new ApplyRefusalError('record-locked'),
          )
        }
        // lock-guarded: L8 revert apply — ensureRecordNotLocked just above, same txn.
        // revision-emitted: L8 revert apply — recordRecordRevision below, same txn (source 'restore').
        const upd = await query(
          `UPDATE meta_records SET data = $1::jsonb, version = version + 1, updated_at = now(), modified_by = $5
           WHERE id = $2 AND sheet_id = $3 AND version = $4
           RETURNING version`,
          [JSON.stringify(rw.projectedData), rw.recordId, input.sheetId, rw.liveVersion, input.actorId],
        )
        // CAS miss ⇒ the locked row moved under us ⇒ preview-drift, full rollback (never a bare Error).
        const row = upd.rows[0] as { version?: unknown } | undefined
        if (!row) throw new ApplyRefusalError('preview-drift')
        const linkInvalidationGroups = new Map<string, { recordIds: Set<string>; fieldIds: Set<string> }>()
        for (const lu of rw.linkUpdates) {
          const changedTargetIds = await syncOneOutboundLinkField(query, rw.recordId, lu.fieldId, lu.targetIds)
          const mirror = sameBaseMirrorConfigByField.get(lu.fieldId)
          if (mirror) {
            for (const recordId of changedTargetIds) {
              addLinkInvalidation(
                linkInvalidationGroups,
                mirror.foreignSheetId,
                recordId,
                mirror.mirrorFieldId,
              )
            }
          }
        }
        // revision-emitted: L8 revert — true restorable delta only (never Object.keys(full target)).
        const newVersion = requireLiveVersion(row.version)
        const revisionId = await recordRecordRevision(query, {
          sheetId: input.sheetId,
          recordId: rw.recordId,
          version: newVersion,
          action: 'update',
          source: 'restore',
          actorId: input.actorId,
          changedFieldIds: rw.changedFieldIds,
          patch: rw.patch,
          snapshot: rw.projectedData,
          ledger: op,
        })
        // Same-txn mutation seam (durable event enqueue) — atomic with THIS revert's writes.
        if (input.onMutationApplied) {
          await input.onMutationApplied(query, {
            kind: 'revert',
            recordId: rw.recordId,
            version: newVersion,
            changedFieldIds: rw.changedFieldIds,
            patch: rw.patch,
            revisionId,
            linkInvalidations: serializeLinkInvalidations(linkInvalidationGroups),
          })
        }
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
    const conflict = classifyExactAnchorDatabaseConflict(e)
    if (conflict) return { ok: false, reason: conflict }
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
