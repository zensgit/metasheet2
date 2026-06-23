import jwt, { type SignOptions } from 'jsonwebtoken'
import { createHash } from 'node:crypto'
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
