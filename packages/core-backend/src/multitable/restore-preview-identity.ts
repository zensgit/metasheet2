import jwt, { type SignOptions } from 'jsonwebtoken'
import { createHash, createHmac } from 'node:crypto'
import { secretManager } from '../security/SecretManager'
import { resolveRuntimeJwtSecret } from '../security/auth-runtime-config'

/**
 * Global History — T6-1: the RECORD-VERSION restore preview-identity contract (mint + verify), per the T6
 * scoped-restore design-lock (SR-3). A record-version preview (T5-2) mints an identity that BINDS its
 * (record + targetVersion + strategy + the MASKED diff the actor saw + actor); the eventual restore execute
 * (T6-2) verifies it so "execution matches the preview". This module is the CONTRACT ONLY — it is NOT wired
 * into any route and writes nothing (the mint->preview and verify->execute wiring + the forward-revision write
 * are T6-2).
 *
 * SCOPE LOCK (v1): this identity binds a SINGLE record-version restore — `{ sheetId, recordId, targetVersion }`.
 * A FIELD SUBSET of that record-version is NOT a separate scope — it is represented by the filtered `changesHash`:
 * preview + execute both filter the masked diff to the selected `fieldIds` and hash the FILTERED result, so a
 * different selection yields a different hash and cannot be replayed (the selection is folded into the hash, never
 * trusted as a side input). What this SINGLE-record identity deliberately does NOT express is a MULTI-RECORD /
 * batch / PIT scope: that is the SCOPED identity below (BS-1), a SEPARATE discriminated `type` that adds a `scope`
 * claim (kind + recordIds) and binds an order-invariant `scopeHash`. The two are DISJOINT by `type` — a
 * single-record token can never satisfy a scoped execute and vice versa — so do not read this single-record
 * identity as authorizing a MULTI-RECORD scope just because `changesHash` matches (and vice versa).
 *
 * Stateless (JWT/HS256, same primitive as invite-tokens): signature defeats tampering, `exp` bounds the window,
 * and `changesHash` defeats stale replay (if the data — or the actor's field permissions — moved since preview,
 * the execute's re-hash diverges -> reject -> re-preview). Single-use / anti-replay needs server state and is a
 * T6-2 idempotency concern, NOT this slice.
 */

export interface RestorePreviewIdentityClaims {
  sheetId: string
  recordId: string
  targetVersion: number
  /** v1 = `revert` only (the destructive `reset` is T8, never T6). */
  strategy: 'revert'
  /** sha256 of the MASKED preview changes (what the actor saw) — see hashPreviewChanges. */
  changesHash: string
  /** the actor the preview was minted for — a preview minted for A is unusable by B (no permission-skip replay). */
  actorId: string
}

const DEFAULT_TTL: SignOptions['expiresIn'] = '10m'

function getSecret(): string {
  const dedicated = secretManager.get('RESTORE_PREVIEW_SECRET', { required: false })
  return dedicated ? resolveRuntimeJwtSecret(dedicated) : resolveRuntimeJwtSecret(process.env.JWT_SECRET)
}

/**
 * Canonical, ORDER-INVARIANT hash of the MASKED preview changes — what the actor saw (reveal-free by
 * construction: T5-2's preview has no reveal path, so the identity can only ever bind reveal-free fields, and
 * "a reveal grant never enters the writable set" is inherited at T6-2, not re-solved). Determinism is critical:
 * a non-deterministic hash would make every restore re-hash "diverge" -> a silent denial-of-restore. Each change
 * is serialized as a JSON array `[fieldId, op, value ?? null]` (no delimiter bytes), and the set is sorted by
 * fieldId before hashing.
 */
export function hashPreviewChanges(changes: Array<{ fieldId: string; op: string; value: unknown }>): string {
  const canon = [...changes]
    .sort((a, b) => (a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0))
    .map((c) => JSON.stringify([c.fieldId, c.op, c.value ?? null]))
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex')
}

export function mintRestorePreviewIdentity(claims: RestorePreviewIdentityClaims, expiresIn: SignOptions['expiresIn'] = DEFAULT_TTL): string {
  return jwt.sign({ type: 'restore-preview', ...claims }, getSecret(), { algorithm: 'HS256', expiresIn } as SignOptions)
}

export interface VerifyResult {
  valid: boolean
  /** why it failed (telemetry / 4xx mapping); absent when valid. */
  reason?: 'invalid' | 'expired' | 'wrong_type' | 'mismatch_sheetId' | 'mismatch_recordId' | 'mismatch_targetVersion' | 'mismatch_strategy' | 'mismatch_changesHash' | 'mismatch_actorId'
}

/**
 * Verify a preview identity against the EXPECTED claims the caller (T6-2) computes fresh at execute time. JWT
 * verification covers signature + expiry; the per-claim checks bind scope/strategy/diff/actor so a token cannot
 * be replayed for a different record, a stale diff, or by a different actor.
 */
export function verifyRestorePreviewIdentity(token: string, expected: RestorePreviewIdentityClaims): VerifyResult {
  let payload: Partial<RestorePreviewIdentityClaims> & { type?: string }
  try {
    payload = jwt.verify(token, getSecret()) as Partial<RestorePreviewIdentityClaims> & { type?: string }
  } catch (e) {
    return { valid: false, reason: (e as Error)?.name === 'TokenExpiredError' ? 'expired' : 'invalid' }
  }
  if (payload.type !== 'restore-preview') return { valid: false, reason: 'wrong_type' }
  if (payload.sheetId !== expected.sheetId) return { valid: false, reason: 'mismatch_sheetId' }
  if (payload.recordId !== expected.recordId) return { valid: false, reason: 'mismatch_recordId' }
  if (payload.targetVersion !== expected.targetVersion) return { valid: false, reason: 'mismatch_targetVersion' }
  if (payload.strategy !== expected.strategy) return { valid: false, reason: 'mismatch_strategy' }
  if (payload.changesHash !== expected.changesHash) return { valid: false, reason: 'mismatch_changesHash' }
  if (payload.actorId !== expected.actorId) return { valid: false, reason: 'mismatch_actorId' }
  return { valid: true }
}

// ── BS-1: SCOPED (multi-record) restore preview-identity ────────────────────────────────────────────────────
// Per the batch/scope design-lock (BS-1; D1 recordIds[], D4 scope hash, D6 discriminated union). A SCOPED
// identity binds a MULTI-record restore: the EXACT record set AND each record's per-record (masked, field-
// filtered) `changesHash`, via an order-invariant `scopeHash`. The `type: 'restore-preview-scoped'` discriminator
// makes single and scoped identities DISJOINT — a single-record token can never satisfy a scoped execute and
// vice versa (BS-7 + D6). CONTRACT ONLY — not wired into any route, writes nothing (preview = BS-2, execute = BS-3).

export interface ScopedRestorePreviewIdentityClaims {
  sheetId: string
  /** v1 (D1): an explicit record set. A `batchId` / PIT kind is a later slice. */
  scope: { kind: 'records'; recordIds: string[] }
  targetVersion: number
  /** v1 = `revert` only (the destructive `reset` is T8, never here). */
  strategy: 'revert'
  /** sha256 over the sorted record set + each record's per-record changesHash — see hashScope. */
  scopeHash: string
  /** the actor the preview was minted for (no permission-skip replay by another actor). */
  actorId: string
}

/**
 * Canonical, ORDER-INVARIANT scope hash: binds the EXACT record set, each record's per-record changesHash, AND
 * each record's per-record expected `version`. Sorted by recordId, each entry serialized as
 * `[recordId, changesHash, version]` (D4). A record added/removed changes the set → a different hash; a changed
 * per-record diff → a different hash; a changed per-record version → a different hash. This is what makes BS-7
 * hold (a scoped identity for {A,B,C} cannot execute {A,B} or {A,B,C,D}) AND what binds the per-record
 * optimistic-concurrency anchor: the version is FOLDED IN here at mint (BS-2) and re-folded at verify (BS-3) from
 * the CLIENT-SUBMITTED expectedVersion — never trusted as free side-input — so a client that submits the current
 * (rather than the preview-time) version to slip past the CAS instead diverges the hash and is rejected. Same
 * filter-then-hash discipline that folds `fieldIds` into `changesHash`, applied to the version axis.
 */
export function hashScope(perRecord: Array<{ recordId: string; changesHash: string; version: number }>): string {
  const canon = [...perRecord]
    .sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0))
    .map((r) => JSON.stringify([r.recordId, r.changesHash, r.version]))
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex')
}

/**
 * T8-1 undelete: order-invariant hash over the RESURRECT set (records that existed at T but are deleted now → to be
 * re-inserted at their full T-snapshot). A deleted record has NO live version, so the per-record anchor is a hash of
 * its FULL server-side T-target snapshot (`snapshotHash`), NOT a version. Binding this into the PIT-revert identity
 * means a change to WHICH records are resurrected OR to any target snapshot between preview and execute re-hashes and
 * is rejected (409) — the resurrect set can never be widened/narrowed/altered past what the actor previewed.
 */
export function hashResurrectSet(perRecord: Array<{ recordId: string; snapshotHash: string }>): string {
  const canon = [...perRecord]
    .sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0))
    .map((r) => JSON.stringify([r.recordId, r.snapshotHash]))
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex')
}

export function mintScopedRestorePreviewIdentity(claims: ScopedRestorePreviewIdentityClaims, expiresIn: SignOptions['expiresIn'] = DEFAULT_TTL): string {
  return jwt.sign({ type: 'restore-preview-scoped', ...claims }, getSecret(), { algorithm: 'HS256', expiresIn } as SignOptions)
}

export interface ScopedVerifyResult {
  valid: boolean
  reason?: 'invalid' | 'expired' | 'wrong_type' | 'mismatch_sheetId' | 'mismatch_targetVersion' | 'mismatch_strategy' | 'mismatch_scopeKind' | 'mismatch_scopeHash' | 'mismatch_actorId'
}

/**
 * Verify a SCOPED identity against claims the execute (BS-3) computes FRESH from the actual record set it is about
 * to restore. The `scopeHash` binds the set + per-record diffs, so a narrowed / widened / altered scope diverges
 * and is rejected (BS-7). The `restore-preview-scoped` type makes this DISJOINT from the single-record verify (D6):
 * a single-record token presented here → `wrong_type`, and a scoped token presented to the single verify likewise.
 */
export function verifyScopedRestorePreviewIdentity(token: string, expected: ScopedRestorePreviewIdentityClaims): ScopedVerifyResult {
  let payload: Partial<ScopedRestorePreviewIdentityClaims> & { type?: string }
  try {
    payload = jwt.verify(token, getSecret()) as Partial<ScopedRestorePreviewIdentityClaims> & { type?: string }
  } catch (e) {
    return { valid: false, reason: (e as Error)?.name === 'TokenExpiredError' ? 'expired' : 'invalid' }
  }
  if (payload.type !== 'restore-preview-scoped') return { valid: false, reason: 'wrong_type' } // a single-record token is rejected here
  if (payload.sheetId !== expected.sheetId) return { valid: false, reason: 'mismatch_sheetId' }
  if (payload.targetVersion !== expected.targetVersion) return { valid: false, reason: 'mismatch_targetVersion' }
  if (payload.strategy !== expected.strategy) return { valid: false, reason: 'mismatch_strategy' }
  if (payload.scope?.kind !== expected.scope.kind) return { valid: false, reason: 'mismatch_scopeKind' }
  if (payload.scopeHash !== expected.scopeHash) return { valid: false, reason: 'mismatch_scopeHash' }
  if (payload.actorId !== expected.actorId) return { valid: false, reason: 'mismatch_actorId' }
  return { valid: true }
}

// ---------------------------------------------------------------------------------------------------------------
// T8-1: PIT (point-in-time, sheet-wide) Revert preview-identity. A DISTINCT discriminated `type` from the single
// and scoped identities (PIT-1 + PIT-4): a sheet-wide Revert-to-T binds the as-of time `asOf` PLUS the order-
// invariant `scopeHash` over the EXACT computed revert set (each affected record's masked changesHash + version),
// so a revert set that drifted between preview and execute (a record edited / a new post-T edit) re-hashes and is
// rejected → re-preview. `strategy: 'revert'` only — the destructive Reset is T8-2 (a SEPARATE, hard-gated slice).
export interface PitRevertPreviewIdentityClaims {
  sheetId: string
  /** the point in time the sheet is reverted to (ISO). */
  asOf: string
  strategy: 'revert'
  /** sha256 over the sorted revert set (recordId + per-record masked changesHash + version), via hashScope. */
  scopeHash: string
  /** T8-1: sha256 over the sorted RESURRECT set (recordId + T-snapshot hash), via hashResurrectSet. Always present
   *  (empty-set hash when there are no undeletes) so the (possibly-empty) resurrect set is bound the same way the
   *  Reset identity binds its delete-set — an execute can never inject/alter undeletes the actor did not preview. */
  resurrectScopeHash: string
  actorId: string
}

export function mintPitRevertPreviewIdentity(claims: PitRevertPreviewIdentityClaims, expiresIn: SignOptions['expiresIn'] = DEFAULT_TTL): string {
  return jwt.sign({ type: 'restore-preview-pit-revert', ...claims }, getSecret(), { algorithm: 'HS256', expiresIn } as SignOptions)
}

export interface PitRevertVerifyResult {
  valid: boolean
  reason?: 'invalid' | 'expired' | 'wrong_type' | 'mismatch_sheetId' | 'mismatch_asOf' | 'mismatch_strategy' | 'mismatch_scopeHash' | 'mismatch_resurrectScopeHash' | 'mismatch_actorId'
}

export function verifyPitRevertPreviewIdentity(token: string, expected: PitRevertPreviewIdentityClaims): PitRevertVerifyResult {
  let payload: Partial<PitRevertPreviewIdentityClaims> & { type?: string }
  try {
    payload = jwt.verify(token, getSecret()) as Partial<PitRevertPreviewIdentityClaims> & { type?: string }
  } catch (e) {
    return { valid: false, reason: (e as Error)?.name === 'TokenExpiredError' ? 'expired' : 'invalid' }
  }
  if (payload.type !== 'restore-preview-pit-revert') return { valid: false, reason: 'wrong_type' } // single/scoped tokens rejected
  if (payload.sheetId !== expected.sheetId) return { valid: false, reason: 'mismatch_sheetId' }
  if (payload.asOf !== expected.asOf) return { valid: false, reason: 'mismatch_asOf' }
  if (payload.strategy !== expected.strategy) return { valid: false, reason: 'mismatch_strategy' }
  if (payload.scopeHash !== expected.scopeHash) return { valid: false, reason: 'mismatch_scopeHash' }
  if (payload.resurrectScopeHash !== expected.resurrectScopeHash) return { valid: false, reason: 'mismatch_resurrectScopeHash' }
  if (payload.actorId !== expected.actorId) return { valid: false, reason: 'mismatch_actorId' }
  return { valid: true }
}

// ── T9-W: config-restore preview-identity (D5 / T9-W-L4) ──────────────────────────────────────────────────────
// A config-restore PREVIEW (T9-W-1) mints an identity binding {sheetId, revisionId, entityType, entityId,
// baselineHash, actorId}; EXECUTE (T9-W-2) REQUIRES + verifies it. Without this, the baselineHash alone is
// client-computable (sha256 over the current changed-key config), so a caller could skip the preview entirely —
// breaking the preview-first contract. `type: 'config-restore-preview'` keeps it disjoint from record/scoped
// identities. Stateless JWT/HS256: signature defeats forgery, `exp` bounds the window, and the baselineHash claim
// defeats stale replay (drift since preview → the execute's re-hash diverges → reject → re-preview).
export interface ConfigRestorePreviewIdentityClaims {
  sheetId: string
  revisionId: string
  entityType: string
  entityId: string
  /** the baseline config hash the preview saw (config-restore.ts `configBaselineHash`). */
  baselineHash: string
  /** the actor the preview was minted for — a preview minted for A is unusable by B. */
  actorId: string
  /**
   * 4c-1 (design-lock §2.3): the LOSS-MAGNITUDE binding. Present ONLY on a lossy retype-revert preview
   * (`hashLossSummary`); `undefined` on every pre-existing Tier-1/Tier-2 preview, whose token bytes are therefore
   * unchanged. Execute RE-COMPUTES the loss summary inside the txn (after `FOR UPDATE`) and re-hashes: a divergence
   * means the cell values moved since preview, so the loss the actor confirmed is not the loss about to happen →
   * 409 PLAN_DRIFT. Absence is itself bound (an `undefined` claim must match an `undefined` expectation), so a lossy
   * token can never drive a non-lossy execute and vice versa.
   */
  lossHash?: string
}

/**
 * 4c-1 §2.3: opaque, SERVER-KEYED digest of the loss magnitude. HMAC (not the plain sha256 `configBaselineHash`
 * uses) for the same reason `hashUncreatePlan` is keyed: the inputs are three small integers in a client-decodable
 * JWT, so a plain hash would be trivially brute-forceable into an exact "how many cells will be dropped" oracle for
 * a token holder. The keyed PRF makes the claim opaque. `fieldId` is folded in so a token minted for one field's
 * loss can never satisfy another field's execute even at identical counts. The raw summary IS returned in the
 * preview response body — but only to an actor the full-read gate has already proven can read the whole table.
 */
export function hashLossSummary(fieldId: string, summary: { unchanged: number; coerced: number; dropped: number }): string {
  const n = (v: number): number => (Number.isFinite(v) ? Math.trunc(v) : 0)
  const canon = {
    fieldId: String(fieldId),
    unchanged: n(summary.unchanged),
    coerced: n(summary.coerced),
    dropped: n(summary.dropped),
  }
  return createHmac('sha256', getSecret()).update(JSON.stringify(canon)).digest('hex')
}

export function mintConfigRestorePreviewIdentity(claims: ConfigRestorePreviewIdentityClaims, expiresIn: SignOptions['expiresIn'] = DEFAULT_TTL): string {
  return jwt.sign({ type: 'config-restore-preview', ...claims }, getSecret(), { algorithm: 'HS256', expiresIn } as SignOptions)
}

export interface ConfigRestoreVerifyResult {
  valid: boolean
  // `loss_drift` (4c-1) = the opaque lossHash diverged (cell values moved since preview, so the loss magnitude the
  // actor confirmed is stale) OR the token's lossy-ness does not match the execute path's. The route maps it to ONE
  // generic 409 PLAN_DRIFT — the keyed hash cannot reveal WHICH bucket moved, which would itself be an oracle.
  reason?: 'invalid' | 'expired' | 'wrong_type' | 'mismatch_sheetId' | 'mismatch_revisionId' | 'mismatch_entityType' | 'mismatch_entityId' | 'mismatch_baselineHash' | 'loss_drift' | 'mismatch_actorId'
}

export function verifyConfigRestorePreviewIdentity(token: string, expected: ConfigRestorePreviewIdentityClaims): ConfigRestoreVerifyResult {
  let payload: Partial<ConfigRestorePreviewIdentityClaims> & { type?: string }
  try {
    payload = jwt.verify(token, getSecret()) as Partial<ConfigRestorePreviewIdentityClaims> & { type?: string }
  } catch (e) {
    return { valid: false, reason: (e as Error)?.name === 'TokenExpiredError' ? 'expired' : 'invalid' }
  }
  if (payload.type !== 'config-restore-preview') return { valid: false, reason: 'wrong_type' }
  if (payload.sheetId !== expected.sheetId) return { valid: false, reason: 'mismatch_sheetId' }
  if (payload.revisionId !== expected.revisionId) return { valid: false, reason: 'mismatch_revisionId' }
  if (payload.entityType !== expected.entityType) return { valid: false, reason: 'mismatch_entityType' }
  if (payload.entityId !== expected.entityId) return { valid: false, reason: 'mismatch_entityId' }
  if (payload.baselineHash !== expected.baselineHash) return { valid: false, reason: 'mismatch_baselineHash' }
  // 4c-1: bind the loss magnitude, INCLUDING its absence (`undefined` ↔ `undefined`). `jwt.sign` drops undefined
  // claims, so a pre-4c-1 token carries no `lossHash` and matches a non-lossy expectation; a lossy token presented
  // to the non-lossy branch (or vice versa) diverges here rather than silently executing the wrong contract.
  if ((payload.lossHash ?? null) !== (expected.lossHash ?? null)) return { valid: false, reason: 'loss_drift' }
  if (payload.actorId !== expected.actorId) return { valid: false, reason: 'mismatch_actorId' }
  return { valid: true }
}

// ── T9-W Tier 3 (U-3) un-create preview-identity (design-lock U3-L4) ──────────────────────────────────────────
// Un-create (revert a config `create` = DROP the entity) binds an OPAQUE `planHash` INSTEAD OF baselineHash: a
// create's changed_keys is the full config set, so the Tier-1/2 baselineHash/driftConflict (`current != after`)
// would FALSE-trip on a benign post-create rename when we are dropping the entity anyway. planHash =
// HMAC(secret, canonical(BLAST-RADIUS plan)) — entity-alive + cascade view-id set + order-shift set + (field)
// column-data-presence — computed SERVER-SIDE only; the raw plan is NEVER a claim or a response field (U3-L5
// no-oracle). HMAC-keyed (not the plain sha256 that baselineHash uses) because the column-data-presence input is
// ~1 bit: a plain hash in the client-decodable JWT would be brute-forceable to confirm hidden-column data presence;
// the server key makes it a PRF. `type: 'config-uncreate-preview'` keeps it DISJOINT from the Tier-1/2 config
// identity (an un-create token can never drive a Tier-1/2 restore, and vice versa). Cosmetic config (e.g. name) is
// NOT a plan input → a benign rename does not drift; execute compares the single planHash → ONE generic PLAN_DRIFT.
export interface UncreatePlan {
  entityAlive: boolean
  /** view ids whose config currently references the dropped field (cleaned on drop). [] for view un-create. */
  cascadeViewIds: string[]
  /** trailing field ids whose `order` shifts on drop. [] for view un-create. */
  orderShiftIds: string[]
  /** (field) whether any record currently has a non-null value for the column. false for view un-create. */
  columnDataPresent: boolean
}
export function hashUncreatePlan(plan: UncreatePlan): string {
  const canon = {
    entityAlive: plan.entityAlive === true,
    cascadeViewIds: [...plan.cascadeViewIds].sort(),
    orderShiftIds: [...plan.orderShiftIds].sort(),
    columnDataPresent: plan.columnDataPresent === true,
  }
  return createHmac('sha256', getSecret()).update(JSON.stringify(canon)).digest('hex')
}

export interface ConfigUncreatePreviewIdentityClaims {
  sheetId: string
  revisionId: string
  entityType: string
  entityId: string
  /** opaque HMAC over the blast-radius plan (hashUncreatePlan); raw plan fields are NEVER claims or response fields. */
  planHash: string
  actorId: string
}

export function mintConfigUncreatePreviewIdentity(claims: ConfigUncreatePreviewIdentityClaims, expiresIn: SignOptions['expiresIn'] = DEFAULT_TTL): string {
  return jwt.sign({ type: 'config-uncreate-preview', ...claims }, getSecret(), { algorithm: 'HS256', expiresIn } as SignOptions)
}

export interface ConfigUncreateVerifyResult {
  valid: boolean
  // `plan_drift` = the planHash diverged (entity gone / new view ref / new column data / order-set changed) — the
  // route maps it to ONE generic 409 PLAN_DRIFT (no sub-reason; the opaque hash cannot reveal which input moved).
  reason?: 'invalid' | 'expired' | 'wrong_type' | 'mismatch_sheetId' | 'mismatch_revisionId' | 'mismatch_entityType' | 'mismatch_entityId' | 'plan_drift' | 'mismatch_actorId'
}

export function verifyConfigUncreatePreviewIdentity(token: string, expected: ConfigUncreatePreviewIdentityClaims): ConfigUncreateVerifyResult {
  let payload: Partial<ConfigUncreatePreviewIdentityClaims> & { type?: string }
  try {
    payload = jwt.verify(token, getSecret()) as Partial<ConfigUncreatePreviewIdentityClaims> & { type?: string }
  } catch (e) {
    return { valid: false, reason: (e as Error)?.name === 'TokenExpiredError' ? 'expired' : 'invalid' }
  }
  if (payload.type !== 'config-uncreate-preview') return { valid: false, reason: 'wrong_type' }
  if (payload.sheetId !== expected.sheetId) return { valid: false, reason: 'mismatch_sheetId' }
  if (payload.revisionId !== expected.revisionId) return { valid: false, reason: 'mismatch_revisionId' }
  if (payload.entityType !== expected.entityType) return { valid: false, reason: 'mismatch_entityType' }
  if (payload.entityId !== expected.entityId) return { valid: false, reason: 'mismatch_entityId' }
  if (payload.planHash !== expected.planHash) return { valid: false, reason: 'plan_drift' }
  if (payload.actorId !== expected.actorId) return { valid: false, reason: 'mismatch_actorId' }
  return { valid: true }
}

// ── T9-W Tier 4 (U-4) config-undelete preview-identity (design-lock U4-L5) ────────────────────────────────────
// Undelete (revert a config `delete` = RECREATE the entity from its `before`) binds an opaque HMAC `undeleteHash`
// over the SERVER-SIDE recreate plan — { idFree (the original id is unoccupied), insertOrder, trailingShiftIds,
// targetConfigHash } — never a claim/response field (no-oracle, same discipline as un-create). `type:
// 'config-undelete-preview'` keeps it DISJOINT from un-create / Tier-1/2 (an undelete token can never drive a drop
// or a Tier-1/2 restore, and vice versa). Execute re-checks the id-free guard separately (→ ID_COLLISION) and the
// single hash (→ ONE generic PLAN_DRIFT — the opaque hash cannot reveal WHICH input moved).
export interface UndeletePlan {
  /** the original entity id is currently unoccupied (free to recreate). */
  idFree: boolean
  /** (field) the order the field is re-inserted at (from the delete revision's `before.order`). 0 for view. */
  insertOrder: number
  /** (field) trailing field ids whose `order` shifts +1 on re-insert. [] for view. */
  trailingShiftIds: string[]
  /** sha256 over the immutable `before` config the recreate restores (binds the recreate target). */
  targetConfigHash: string
}
export function hashUndeletePlan(plan: UndeletePlan): string {
  const canon = {
    idFree: plan.idFree === true,
    insertOrder: Number.isFinite(plan.insertOrder) ? Math.trunc(plan.insertOrder) : 0,
    trailingShiftIds: [...plan.trailingShiftIds].sort(),
    targetConfigHash: String(plan.targetConfigHash),
  }
  return createHmac('sha256', getSecret()).update(JSON.stringify(canon)).digest('hex')
}

export interface ConfigUndeletePreviewIdentityClaims {
  sheetId: string
  revisionId: string
  entityType: string
  entityId: string
  /** opaque HMAC over the recreate plan (hashUndeletePlan); raw plan fields are NEVER claims or response fields. */
  undeleteHash: string
  actorId: string
}

export function mintConfigUndeletePreviewIdentity(claims: ConfigUndeletePreviewIdentityClaims, expiresIn: SignOptions['expiresIn'] = DEFAULT_TTL): string {
  return jwt.sign({ type: 'config-undelete-preview', ...claims }, getSecret(), { algorithm: 'HS256', expiresIn } as SignOptions)
}

export interface ConfigUndeleteVerifyResult {
  valid: boolean
  // `plan_drift` = the undeleteHash diverged (id taken / insert-order or trailing set changed) — the route maps it to
  // ONE generic 409 PLAN_DRIFT (the explicit id-occupied check at execute yields the distinct ID_COLLISION).
  reason?: 'invalid' | 'expired' | 'wrong_type' | 'mismatch_sheetId' | 'mismatch_revisionId' | 'mismatch_entityType' | 'mismatch_entityId' | 'plan_drift' | 'mismatch_actorId'
}

export function verifyConfigUndeletePreviewIdentity(token: string, expected: ConfigUndeletePreviewIdentityClaims): ConfigUndeleteVerifyResult {
  let payload: Partial<ConfigUndeletePreviewIdentityClaims> & { type?: string }
  try {
    payload = jwt.verify(token, getSecret()) as Partial<ConfigUndeletePreviewIdentityClaims> & { type?: string }
  } catch (e) {
    return { valid: false, reason: (e as Error)?.name === 'TokenExpiredError' ? 'expired' : 'invalid' }
  }
  if (payload.type !== 'config-undelete-preview') return { valid: false, reason: 'wrong_type' }
  if (payload.sheetId !== expected.sheetId) return { valid: false, reason: 'mismatch_sheetId' }
  if (payload.revisionId !== expected.revisionId) return { valid: false, reason: 'mismatch_revisionId' }
  if (payload.entityType !== expected.entityType) return { valid: false, reason: 'mismatch_entityType' }
  if (payload.entityId !== expected.entityId) return { valid: false, reason: 'mismatch_entityId' }
  if (payload.undeleteHash !== expected.undeleteHash) return { valid: false, reason: 'plan_drift' }
  if (payload.actorId !== expected.actorId) return { valid: false, reason: 'mismatch_actorId' }
  return { valid: true }
}

// ── T9-W permission-revert preview-identity (design-lock #3342, de-escalation-only) ───────────────────────────
// Disjoint `type:'config-permission-revert-preview'`. Binds the CURRENT live grant via `currentGrantHash` (HMAC),
// so a grant changed between preview and execute → drift → 409. The de-escalation direction is re-checked against
// the LIVE grant at execute too (the load-bearing never-escalate guard lives in the route, not just this token).
export function hashPermissionGrant(grant: Record<string, unknown> | null | undefined): string {
  return createHmac('sha256', getSecret()).update(JSON.stringify(grant ?? null)).digest('hex')
}

export interface ConfigPermissionRevertPreviewIdentityClaims {
  sheetId: string
  revisionId: string
  entityId: string
  /** HMAC over the subject's current live grant — drift since preview → reject. */
  currentGrantHash: string
  actorId: string
}

export function mintConfigPermissionRevertPreviewIdentity(claims: ConfigPermissionRevertPreviewIdentityClaims, expiresIn: SignOptions['expiresIn'] = DEFAULT_TTL): string {
  return jwt.sign({ type: 'config-permission-revert-preview', ...claims }, getSecret(), { algorithm: 'HS256', expiresIn } as SignOptions)
}

export interface ConfigPermissionRevertVerifyResult {
  valid: boolean
  reason?: 'invalid' | 'expired' | 'wrong_type' | 'mismatch_sheetId' | 'mismatch_revisionId' | 'mismatch_entityId' | 'grant_drift' | 'mismatch_actorId'
}

export function verifyConfigPermissionRevertPreviewIdentity(token: string, expected: ConfigPermissionRevertPreviewIdentityClaims): ConfigPermissionRevertVerifyResult {
  let payload: Partial<ConfigPermissionRevertPreviewIdentityClaims> & { type?: string }
  try {
    payload = jwt.verify(token, getSecret()) as Partial<ConfigPermissionRevertPreviewIdentityClaims> & { type?: string }
  } catch (e) {
    return { valid: false, reason: (e as Error)?.name === 'TokenExpiredError' ? 'expired' : 'invalid' }
  }
  if (payload.type !== 'config-permission-revert-preview') return { valid: false, reason: 'wrong_type' }
  if (payload.sheetId !== expected.sheetId) return { valid: false, reason: 'mismatch_sheetId' }
  if (payload.revisionId !== expected.revisionId) return { valid: false, reason: 'mismatch_revisionId' }
  if (payload.entityId !== expected.entityId) return { valid: false, reason: 'mismatch_entityId' }
  if (payload.currentGrantHash !== expected.currentGrantHash) return { valid: false, reason: 'grant_drift' }
  if (payload.actorId !== expected.actorId) return { valid: false, reason: 'mismatch_actorId' }
  return { valid: true }
}

// ── T8-2 Reset-to-T (DESTRUCTIVE) preview-identity ────────────────────────────────────────────────────────────
// Reset = Revert (surviving records to their T-state) + SOFT-DELETE the records CREATED AFTER T. Its identity is
// DISJOINT from revert (`type: 'restore-preview-pit-reset'`), so a revert token can never trigger a destructive
// reset (and vice versa). It binds TWO order-invariant hashes: `revertScopeHash` (the reverts, identical to revert)
// AND `deleteScopeHash` (the EXACT set of post-T-created record ids AND their preview-time versions to delete).
// Execute RE-ENUMERATES both and re-hashes; a record created OR edited between preview and execute diverges →
// rejected. So Reset can NEVER delete a record/version the actor did not see in the preview (the load-bearing
// data-safety property for the only path in the line that destroys rows).
export function hashDeleteSet(records: Array<{ recordId: string; version: number }>): string {
  const canon = records
    .map((r) => ({ recordId: r.recordId, version: Number.isFinite(r.version) ? Math.trunc(r.version) : 0 }))
    .sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : a.version - b.version))
    .map((r) => JSON.stringify([r.recordId, r.version]))
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex')
}

export interface PitResetPreviewIdentityClaims {
  sheetId: string
  /** the point in time the sheet is reset to (ISO). */
  asOf: string
  strategy: 'reset'
  /** sha256 over the sorted revert set (recordId + masked changesHash + version), via hashScope — same as revert. */
  revertScopeHash: string
  /** sha256 over the sorted set of post-T-created record ids + preview versions to delete, via hashDeleteSet. */
  deleteScopeHash: string
  actorId: string
}

export function mintPitResetPreviewIdentity(claims: PitResetPreviewIdentityClaims, expiresIn: SignOptions['expiresIn'] = DEFAULT_TTL): string {
  return jwt.sign({ type: 'restore-preview-pit-reset', ...claims }, getSecret(), { algorithm: 'HS256', expiresIn } as SignOptions)
}

export interface PitResetVerifyResult {
  valid: boolean
  reason?: 'invalid' | 'expired' | 'wrong_type' | 'mismatch_sheetId' | 'mismatch_asOf' | 'mismatch_strategy' | 'mismatch_revertScopeHash' | 'mismatch_deleteScopeHash' | 'mismatch_actorId'
}

export function verifyPitResetPreviewIdentity(token: string, expected: PitResetPreviewIdentityClaims): PitResetVerifyResult {
  let payload: Partial<PitResetPreviewIdentityClaims> & { type?: string }
  try {
    payload = jwt.verify(token, getSecret()) as Partial<PitResetPreviewIdentityClaims> & { type?: string }
  } catch (e) {
    return { valid: false, reason: (e as Error)?.name === 'TokenExpiredError' ? 'expired' : 'invalid' }
  }
  if (payload.type !== 'restore-preview-pit-reset') return { valid: false, reason: 'wrong_type' } // revert/single/scoped tokens rejected
  if (payload.sheetId !== expected.sheetId) return { valid: false, reason: 'mismatch_sheetId' }
  if (payload.asOf !== expected.asOf) return { valid: false, reason: 'mismatch_asOf' }
  if (payload.strategy !== expected.strategy) return { valid: false, reason: 'mismatch_strategy' }
  if (payload.revertScopeHash !== expected.revertScopeHash) return { valid: false, reason: 'mismatch_revertScopeHash' }
  if (payload.deleteScopeHash !== expected.deleteScopeHash) return { valid: false, reason: 'mismatch_deleteScopeHash' }
  if (payload.actorId !== expected.actorId) return { valid: false, reason: 'mismatch_actorId' }
  return { valid: true }
}

// ── W0-1 v3.7 L6-b: EXACT-ANCHOR recovery preview-identity (design-lock #4331 §1.3 / §9 item 6) ───────────────
// The DESTRUCTIVE-recovery authority token. A recovery preview resolves an OPAQUE anchor to an EXACT causal
// `anchorSeq` (the immutable `endpoint_seq` of a sealed operation, L6-a) under the active trust checkpoint (L5),
// then FREEZES that resolution into this signed identity. Execute verifies it and reconstructs at the
// TOKEN-BOUND `anchorSeq` — it NEVER recomputes `MAX(seq)` as authority (that mutable value is exactly the
// non-anchor a wall-clock/`MAX` sample would drift on; v3.7 §0/P2-B). `type: 'exact-anchor-recovery-preview'`
// keeps it DISJOINT from every T5/T6/T8 identity above (a revert/reset/config token can never drive it and vice
// versa). Same stateless HS256 primitive + server secret (`getSecret`); signature defeats forgery, `exp` bounds
// the window, and `scopeHash` defeats stale replay (the reconstructed set moved since preview → execute re-hash
// diverges → reject → re-preview).

/**
 * Order-invariant, SERVER-KEYED (HMAC) hash of the reconstructed record set AT the anchor — the exact
 * {recordId, exists, version} the preview computed via `reconstructRecordsAtSeq(anchorSeq)`. Binding this into
 * the identity means the execute (which re-reconstructs at the TOKEN-BOUND anchorSeq and re-hashes) rejects if
 * the set drifted, AND — the load-bearing safety property — reds if the execute recomputes the anchor as
 * `MAX(seq)` instead of using the frozen `anchorSeq` (a later write advances MAX, so the reconstructed set and
 * this hash diverge). HMAC (server key), not a plain sha256, so a token holder cannot brute-force the record
 * set / version map out of the client-decodable JWT (no-oracle, same discipline as `hashLossSummary`). A
 * deleted (exists:false) record contributes `null` for its version (it has none as of the anchor).
 */
export function hashAnchorRecoveryScope(records: Array<{ recordId: string; exists: boolean; version: number | null }>): string {
  const canon = [...records]
    .sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0))
    .map((r) => JSON.stringify([r.recordId, r.exists === true, r.exists && typeof r.version === 'number' && Number.isFinite(r.version) ? r.version : null]))
  return createHmac('sha256', getSecret()).update(JSON.stringify(canon)).digest('hex')
}

/** The recovery mode the preview was minted FOR. Bound into the signed identity (owner P1-1, 2026-07-17):
 *  the destructive apply reads the mode from the VERIFIED CLAIMS, never from the execute request — a token
 *  minted while previewing a non-destructive `revert` is structurally unusable to drive a `reset` (which
 *  deletes `deletedAtAnchorLiveNow` ∪ `createdAfterAnchor` rows). The burn table only makes a token
 *  at-most-once; it is THIS binding that pins WHAT the once is. */
export type ExactAnchorRecoveryMode = 'revert' | 'reset'

/**
 * SERVER-KEYED hash of the v1 recovery-authorization basis (owner P1-2, 2026-07-17). Whole-sheet recovery is
 * authorized by exactly one grant shape in v1 — the 4c-1 U-L8 FULL-READ gate (an actor who cannot read every
 * record × field of the sheet is refused the whole surface; no partial scope exists yet). Binding a hash of
 * that basis into the identity makes the AUTHORIZATION CONTRACT part of the signed token: the execute
 * recomputes this hash from its OWN in-fence adjudication and compares — the token's echo is never the
 * authority (the same discipline as the in-fence checkpoint re-resolution). A future partial-scope recovery
 * mode versions the basis string, so a full-read-era token can never be presented to a partial-scope surface
 * (or vice versa) — cross-contract replay is structurally dead, not checked.
 */
export function hashRecoveryAuthorizationScope(basis: { sheetId: string; actorId: string }): string {
  return createHmac('sha256', getSecret())
    .update(JSON.stringify(['recovery-auth-v1', 'full-read', basis.sheetId, basis.actorId]))
    .digest('hex')
}

/**
 * Deep-sort object keys (recursively) so property JSON is order-invariant. Arrays keep element order
 * (option lists / validation rule lists are position-significant); object keys sort lexicographically.
 */
function deepSortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSortKeys)
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(src).sort()) out[k] = deepSortKeys(src[k])
    return out
  }
  return value
}

/** Normalize a meta_fields.property blob to a plain object (jsonb row, JSON string, or empty). */
function normalizeFieldProperty(property: unknown): Record<string, unknown> {
  if (property && typeof property === 'object' && !Array.isArray(property)) {
    return property as Record<string, unknown>
  }
  if (typeof property === 'string' && property.trim()) {
    try {
      const parsed = JSON.parse(property) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch { /* ignore */ }
  }
  return {}
}

/**
 * G-SCHEMA-BEFORE-FENCE (v3.7 §5) — SERVER-KEYED HMAC over the CURRENT field surface
 * `{id, type, property}` for a sheet. Rows sorted by id; property keys deep-sorted. Bound into the
 * preview identity so a post-preview retype (string→longText) or property-only edit refuses
 * `schema-drift` at execute even when every historical scalar remains "valid" under the new type.
 * HMAC (not plain sha256) keeps the client-decodable JWT from leaking the field map (same discipline
 * as `hashAnchorRecoveryScope` / `hashRecoveryAuthorizationScope`).
 */
export function hashExactAnchorSchema(
  fields: Array<{ id: string; type: string; property?: unknown }>,
): string {
  const canon = [...fields]
    .map((f) => ({
      id: String(f.id),
      type: String(f.type ?? ''),
      property: deepSortKeys(normalizeFieldProperty(f.property)),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((f) => JSON.stringify([f.id, f.type, f.property]))
  return createHmac('sha256', getSecret())
    .update(JSON.stringify(['exact-anchor-schema-v1', canon]))
    .digest('hex')
}

export interface ExactAnchorRecoveryIdentityClaims {
  sheetId: string
  /** the OPAQUE recovery anchor: the sealed operation endpoint id (`meta_record_history_operations.operation_id`).
   *  NOT the S1 user-action `batch_id` (L6-a finding #1 permanently decouples the two identities — this field
   *  was previously named `anchorBatchId`, which was exactly that conflation; renamed with the P1 token-contract
   *  fix). A History-Center batch selection reaches this via the ruling-⑤ resolver (batch → its sealed terminal
   *  operation with MAX `endpoint_seq` on this sheet), server-side only. */
  anchorOperationId: string
  /** the FROZEN exact causal anchor — the sealed operation's `endpoint_seq` as a decimal bigint STRING (never a
   *  Number). Reconstruction/execute bind this straight into `seq <= $::bigint`. */
  anchorSeq: string
  /** the active trust checkpoint covering the anchor (`trusted_since_seq <= anchorSeq`, L5). */
  checkpointId: string
  /** order-invariant HMAC over the reconstructed record set at `anchorSeq` (`hashAnchorRecoveryScope`). */
  scopeHash: string
  /** W0-1 L8: order-invariant HMAC over the LIVE record set {id, version} at preview time (same
   *  `hashAnchorRecoveryScope` primitive, `exists:true`). `scopeHash` binds the ANCHOR AUTHORITY (the
   *  immutable at-anchor reconstruction — it can never move under an append-only history), while this
   *  binds PREVIEW FRESHNESS: any concurrent version-bumping write / create / delete between preview and
   *  execute changes it, and the destructive apply refuses `preview-drift` (409-class) in-fence — the
   *  actor always applies exactly the world they previewed. */
  liveSetHash: string
  /**
   * G-SCHEMA-BEFORE-FENCE: SERVER-KEYED HMAC over CURRENT `{id,type,property}` field surface at preview
   * (`hashExactAnchorSchema`). Recomputed under the apply fence; mismatch ⇒ `schema-drift` before writes.
   * Required (hard cutover: missing ⇒ `pre_contract_token` — module is unwired).
   */
  schemaHash: string
  /** the actor the preview was minted for — a preview minted for A is unusable by B (no cross-actor replay). */
  actorId: string
  /** the recovery mode this preview authorizes — the apply obeys THIS, never a request-supplied mode (P1-1). */
  mode: ExactAnchorRecoveryMode
  /** `hashRecoveryAuthorizationScope` over the v1 full-read authorization basis (P1-2) — recomputed and
   *  compared at execute from the execute's OWN fresh adjudication, never trusted from the token alone. */
  authorizedScopeHash: string
}

export function mintExactAnchorRecoveryIdentity(claims: ExactAnchorRecoveryIdentityClaims, expiresIn: SignOptions['expiresIn'] = DEFAULT_TTL): string {
  return jwt.sign({ type: 'exact-anchor-recovery-preview', ...claims }, getSecret(), { algorithm: 'HS256', expiresIn } as SignOptions)
}

export interface ExactAnchorRecoveryVerifyResult {
  valid: boolean
  /**
   * Failure taxonomy (NIT-1 precision):
   * - `pre_contract_token` — missing/out-of-vocabulary `mode`, missing/empty `authorizedScopeHash`,
   *   or missing/empty `schemaHash` (P1 / G-SCHEMA hard cutover; deliberate — module is unwired so no
   *   live token predates the contract).
   * - `malformed_anchorSeq` — `anchorSeq` is not a decimal bigint string (must never reach `::bigint`).
   * - `malformed_claims` — other required token-authority fields absent/empty (checkpointId /
   *   anchorOperationId / scopeHash / liveSetHash).
   * Execute collapses every `!valid` into `identity-invalid`; these labels are for diagnostics + unit pins.
   */
  reason?: 'invalid' | 'expired' | 'wrong_type' | 'mismatch_sheetId' | 'mismatch_actorId' | 'malformed_anchorSeq' | 'pre_contract_token' | 'malformed_claims'
  /** the verified (signature-checked, sheet+actor-bound) claims — the caller reads the TOKEN-BOUND `anchorSeq`
   *  and `checkpointId` from here; present ONLY when `valid`. */
  claims?: ExactAnchorRecoveryIdentityClaims
}

/**
 * Verify an exact-anchor recovery identity. JWT verification covers signature (any tampered claim — anchorSeq,
 * checkpointId, scopeHash, schemaHash, anchorOperationId, mode, authorizedScopeHash — breaks it → `invalid`) +
 * expiry. The per-claim checks bind the REPLAY axes computed FRESH at execute time: `sheetId` and `actorId`
 * (a token for sheet A / actor A can never drive a recovery on sheet B / actor B). The token-authority fields
 * (`anchorSeq`, `checkpointId`, `anchorOperationId`, `scopeHash`, `schemaHash`, `mode`, `authorizedScopeHash`)
 * are returned in `claims` for the caller to use UNDER THE FENCE — the execute reconstructs at
 * `claims.anchorSeq` and re-checks `claims.scopeHash` / `claims.schemaHash` against the live reconstruction;
 * it does NOT recompute the anchor. `anchorSeq` is shape-validated as a decimal bigint string (fail-closed,
 * never coerced) so a signed-but-garbage anchor cannot reach the `::bigint` bind.
 */
export function verifyExactAnchorRecoveryIdentity(
  token: string,
  expected: { sheetId: string; actorId: string },
): ExactAnchorRecoveryVerifyResult {
  let payload: Partial<ExactAnchorRecoveryIdentityClaims> & { type?: string }
  try {
    payload = jwt.verify(token, getSecret()) as Partial<ExactAnchorRecoveryIdentityClaims> & { type?: string }
  } catch (e) {
    return { valid: false, reason: (e as Error)?.name === 'TokenExpiredError' ? 'expired' : 'invalid' }
  }
  if (payload.type !== 'exact-anchor-recovery-preview') return { valid: false, reason: 'wrong_type' }
  if (payload.sheetId !== expected.sheetId) return { valid: false, reason: 'mismatch_sheetId' }
  if (payload.actorId !== expected.actorId) return { valid: false, reason: 'mismatch_actorId' }
  // P1 + G-SCHEMA token contract (hard cutover): `mode` + `authorizedScopeHash` + `schemaHash` REQUIRED.
  // Classified as `pre_contract_token` (not `malformed_anchorSeq`) so the fail-closed label matches the defect.
  if (payload.mode !== 'revert' && payload.mode !== 'reset') {
    return { valid: false, reason: 'pre_contract_token' }
  }
  if (typeof payload.authorizedScopeHash !== 'string' || !payload.authorizedScopeHash) {
    return { valid: false, reason: 'pre_contract_token' }
  }
  if (typeof payload.schemaHash !== 'string' || !payload.schemaHash) {
    return { valid: false, reason: 'pre_contract_token' }
  }
  // Shape fail-closed: `anchorSeq` must be a decimal bigint string before any `::bigint` bind.
  if (typeof payload.anchorSeq !== 'string' || !/^[0-9]+$/.test(payload.anchorSeq)) {
    return { valid: false, reason: 'malformed_anchorSeq' }
  }
  // Remaining required token-authority fields — precise label, not collapsed into malformed_anchorSeq.
  if (
    typeof payload.checkpointId !== 'string' || !payload.checkpointId ||
    typeof payload.anchorOperationId !== 'string' || !payload.anchorOperationId ||
    typeof payload.scopeHash !== 'string' || !payload.scopeHash ||
    typeof payload.liveSetHash !== 'string' || !payload.liveSetHash
  ) {
    return { valid: false, reason: 'malformed_claims' }
  }
  return {
    valid: true,
    claims: {
      sheetId: payload.sheetId,
      anchorOperationId: payload.anchorOperationId,
      anchorSeq: payload.anchorSeq,
      checkpointId: payload.checkpointId,
      scopeHash: payload.scopeHash,
      liveSetHash: payload.liveSetHash,
      schemaHash: payload.schemaHash,
      actorId: payload.actorId as string,
      mode: payload.mode,
      authorizedScopeHash: payload.authorizedScopeHash,
    },
  }
}
