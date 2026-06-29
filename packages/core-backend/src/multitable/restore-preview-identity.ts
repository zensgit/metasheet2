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
}

export function mintConfigRestorePreviewIdentity(claims: ConfigRestorePreviewIdentityClaims, expiresIn: SignOptions['expiresIn'] = DEFAULT_TTL): string {
  return jwt.sign({ type: 'config-restore-preview', ...claims }, getSecret(), { algorithm: 'HS256', expiresIn } as SignOptions)
}

export interface ConfigRestoreVerifyResult {
  valid: boolean
  reason?: 'invalid' | 'expired' | 'wrong_type' | 'mismatch_sheetId' | 'mismatch_revisionId' | 'mismatch_entityType' | 'mismatch_entityId' | 'mismatch_baselineHash' | 'mismatch_actorId'
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
