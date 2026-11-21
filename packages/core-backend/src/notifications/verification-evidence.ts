/** Persisted notification verification evidence. Fingerprints are internal comparison values only. */
import type { IntegrationScope } from '../integrations/provider-capability-registry'
import type { DingTalkWorkNotificationVerifyResult } from '../integrations/dingtalk/work-notification-verify'
import type { Db } from './recipient-resolver'
import { NotificationHttpError } from './notification-errors'

export const NOTIFICATION_VERIFICATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export type NotificationVerificationLevel = 'token' | 'send'
export type NotificationVerificationFailureCode =
  | 'verification_missing'
  | 'verification_stale'
  | 'verification_invalidated'
  | 'verification_anchor_changed'
  | 'verification_fingerprint_changed'

/** The only evidence fields suitable for an HTTP response. */
export interface NotificationVerificationSummary {
  level: NotificationVerificationLevel | null
  verifiedUntil: string | null
  valid: boolean
}

export type NotificationVerificationCheck =
  | { ok: true; verification: NotificationVerificationSummary }
  | { ok: false; code: NotificationVerificationFailureCode; verification: NotificationVerificationSummary }

interface VerificationIdentity {
  connectionId: string
  provider: string
  scope: IntegrationScope | null
  /** A failed current credential resolution is represented by null, never by an old fingerprint. */
  tupleFingerprint: string | null
  now?: Date
}

export interface WriteNotificationVerificationInput extends VerificationIdentity {
  verifiedBy: string
  report: Pick<DingTalkWorkNotificationVerifyResult, 'reachedLevel' | 'failure' | 'requestedLevel'>
}

const SELECT_EVIDENCE = `SELECT provider, reached_level, tuple_fingerprint, bound_tenant, bound_app_scope,
       verified_at, invalidated_at
  FROM notification_connection_verifications
 WHERE connection_id = $1::uuid`

const UPSERT_EVIDENCE = `INSERT INTO notification_connection_verifications
  (connection_id, provider, reached_level, tuple_fingerprint, bound_tenant, bound_app_scope,
   verified_by, verified_at, invalidated_at)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, NULL)
ON CONFLICT (connection_id) DO UPDATE SET
  provider = EXCLUDED.provider, reached_level = EXCLUDED.reached_level,
  tuple_fingerprint = EXCLUDED.tuple_fingerprint, bound_tenant = EXCLUDED.bound_tenant,
  bound_app_scope = EXCLUDED.bound_app_scope, verified_by = EXCLUDED.verified_by,
  verified_at = EXCLUDED.verified_at, invalidated_at = NULL,
  revision = notification_connection_verifications.revision + 1, updated_at = now()`

const INVALIDATE_EVIDENCE = `UPDATE notification_connection_verifications
   SET invalidated_at = $3, revision = revision + 1, updated_at = now()
 WHERE connection_id = $1::uuid AND provider = $2
   AND CASE reached_level WHEN 'token' THEN 2 WHEN 'send' THEN 3 ELSE 0 END >= $4`

/**
 * The caller owns the transaction. A run that reached token replaces older send evidence even when
 * its send step failed. Earlier failures invalidate according to the failed step, not the request.
 */
export async function writeNotificationVerification(db: Db, input: WriteNotificationVerificationInput): Promise<void> {
  const { reachedLevel, failure } = input.report
  const now = input.now ?? new Date()
  if (reachedLevel === 'token' || reachedLevel === 'send') {
    if (!input.scope || !input.tupleFingerprint || !/^[0-9a-f]{64}$/.test(input.tupleFingerprint)) {
      throw new NotificationHttpError(409, 'VERIFICATION_TUPLE_UNSUPPORTED')
    }
    await db.query(UPSERT_EVIDENCE, [
      input.connectionId, input.provider, reachedLevel, input.tupleFingerprint,
      input.scope.tenant, input.scope.appScope, input.verifiedBy, now,
    ])
    return
  }
  if (failure) {
    const failureRank = { config: 1, token: 2, send: 3 }[failure.level]
    await db.query(INVALIDATE_EVIDENCE, [input.connectionId, input.provider, now, failureRank])
  }
}

/** Ordinary SELECT only: this check never takes another lock inside a capability PATCH. */
export async function checkNotificationVerification(db: Db, input: VerificationIdentity): Promise<NotificationVerificationCheck> {
  const result = await db.query(SELECT_EVIDENCE, [input.connectionId])
  const row = result.rows[0]
  const verification: NotificationVerificationSummary = { level: null, verifiedUntil: null, valid: false }
  const fail = (code: NotificationVerificationFailureCode): NotificationVerificationCheck => ({ ok: false, code, verification })
  if (!row) return fail('verification_missing')
  if (row.reached_level !== 'token' && row.reached_level !== 'send') return fail('verification_missing')
  verification.level = row.reached_level
  const verifiedAt = new Date(row.verified_at as string | Date).getTime()
  if (Number.isFinite(verifiedAt)) verification.verifiedUntil = new Date(verifiedAt + NOTIFICATION_VERIFICATION_MAX_AGE_MS).toISOString()
  if (row.invalidated_at !== null) return fail('verification_invalidated')
  if (row.provider !== input.provider || !input.scope
    || row.bound_tenant !== input.scope.tenant || row.bound_app_scope !== input.scope.appScope) {
    return fail('verification_anchor_changed')
  }
  if (!input.tupleFingerprint || row.tuple_fingerprint !== input.tupleFingerprint) {
    return fail('verification_fingerprint_changed')
  }
  const now = (input.now ?? new Date()).getTime()
  if (!Number.isFinite(verifiedAt) || verifiedAt > now || verifiedAt + NOTIFICATION_VERIFICATION_MAX_AGE_MS <= now) {
    return fail('verification_stale')
  }
  verification.valid = true
  return { ok: true, verification }
}
