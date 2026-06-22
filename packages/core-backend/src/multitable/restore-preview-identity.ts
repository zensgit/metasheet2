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
 * It deliberately does NOT express a batch / multi-record / field-subset scope. T6-2 v1 must therefore execute
 * a single-record record-version restore ONLY; a batch / fan-out restore identity is a later slice that adds a
 * `scope` claim (kind + recordIds/fieldIds/batchId) and binds a scope canonical hash. Do not read this v1
 * identity as authorizing a wider scope just because `changesHash` matches.
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
