/**
 * Strict three-valued read of the committed facts a realtime session depends on.
 *
 * For every bound session the answer is exactly one of:
 *   - allowed: the read succeeded and no applicable fact ends the session;
 *   - denied:  the read succeeded and an applicable fact ends the session;
 *   - unknown: the read did not complete, or a structure it needs could not be read.
 *
 * Only `allowed` permits a protected receive or delivery. A missing table, a refused read, a timeout
 * or any other failure is `unknown` for every session of the batch: this reader never substitutes a
 * permissive answer for a failed read, and it never trusts role or identity claims of the credential.
 *
 * COST CONTRACT. One read serves a whole batch: the ordinary sessions of a batch are answered by a
 * fixed number of statements (two) regardless of how many sessions the batch holds; a strict session
 * is verified once per distinct session of the batch. Nothing is cached between reads.
 */
import { bindingKey, type RealtimeSessionBinding } from './session-binding'

export type AuthorityDeniedReason =
  | 'user-missing'
  | 'user-not-active'
  | 'watermark-applies'
  | 'session-not-current'
  | 'membership-lost'
  | 'credential-expired'
  | 'strict-session-not-current'

export type AuthorityUnknownReason = 'authority-read-failed' | 'authority-read-timeout' | 'authority-row-missing'

export type AuthorityVerdict =
  | { readonly state: 'allowed' }
  | { readonly state: 'denied'; readonly reason: AuthorityDeniedReason }
  | { readonly state: 'unknown'; readonly reason: AuthorityUnknownReason }

export type AuthorityQuery = (
  sql: string,
  params: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>

/** Resolves true when the strict session is current, false when it is not; rejects when it cannot tell. */
export type StrictSessionVerifier = (binding: RealtimeSessionBinding) => Promise<boolean>

export interface RealtimeAuthorityReader {
  read(bindings: readonly RealtimeSessionBinding[]): Promise<ReadonlyMap<string, AuthorityVerdict>>
}

export interface RealtimeAuthorityReaderDeps {
  query: AuthorityQuery
  verifyStrict: StrictSessionVerifier
  /** Wall clock in seconds, for the expiry carried by the credential. */
  nowSeconds?: () => number
  /** Upper bound for one whole read; past it every unanswered session is `unknown`. */
  timeoutMs?: number
}

export const DEFAULT_AUTHORITY_READ_TIMEOUT_MS = 2000

export const ORDINARY_SUBJECT_AUTHORITY_SQL = `
SELECT w.ord::int AS ord,
       (u.id IS NOT NULL) AS user_found,
       u.is_active AS is_active,
       u.role AS role,
       u.activation_status AS activation_status,
       (to_jsonb(u) ->> 'deleted_at') AS deleted_at,
       (to_jsonb(u) ->> 'purged_at') AS purged_at,
       (r.user_id IS NOT NULL) AS watermark_found,
       (EXTRACT(EPOCH FROM r.revoked_after) * 1000)::float8 AS revoked_after_ms,
       (w.org_id IS NULL OR EXISTS (
          SELECT 1 FROM user_orgs uo
           WHERE uo.user_id = w.user_id AND uo.org_id = w.org_id AND uo.is_active = true
       )) AS membership_ok
  FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS w(user_id, org_id, ord)
  LEFT JOIN users u ON u.id = w.user_id
  LEFT JOIN user_session_revocations r ON r.user_id = w.user_id`

export const ORDINARY_SESSION_AUTHORITY_SQL = `
SELECT s.id AS id, s.user_id AS user_id, (s.revoked_at IS NULL) AS open
  FROM user_sessions s
 WHERE s.id = ANY($1::text[])`

const ALLOWED: AuthorityVerdict = Object.freeze({ state: 'allowed' })

function denied(reason: AuthorityDeniedReason): AuthorityVerdict {
  return Object.freeze({ state: 'denied', reason })
}

function unknown(reason: AuthorityUnknownReason): AuthorityVerdict {
  return Object.freeze({ state: 'unknown', reason })
}

function present(value: unknown): boolean {
  return value != null && String(value).trim().length > 0
}

function ordinarySubjectVerdict(
  binding: RealtimeSessionBinding,
  row: Record<string, unknown> | undefined,
): AuthorityVerdict {
  if (!row) return unknown('authority-row-missing')
  if (row.user_found !== true) return denied('user-missing')
  if (present(row.deleted_at) || present(row.purged_at)) return denied('user-not-active')
  if (row.is_active !== true || row.role === 'disabled') return denied('user-not-active')
  if (row.activation_status !== 'activated') return denied('user-not-active')
  if (row.watermark_found === true) {
    const revokedAfterMs = typeof row.revoked_after_ms === 'number' ? row.revoked_after_ms : Number.NaN
    // A credential without an issue time cannot be shown to postdate the watermark.
    if (binding.issuedAtSeconds == null || !Number.isFinite(revokedAfterMs)) return denied('watermark-applies')
    if (binding.issuedAtSeconds * 1000 <= revokedAfterMs) return denied('watermark-applies')
  } else if (row.watermark_found !== false) {
    return unknown('authority-row-missing')
  }
  if (row.membership_ok !== true) return denied('membership-lost')
  return ALLOWED
}

async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  // The abandoned read may still reject after the deadline won; that rejection is already accounted for.
  work.then(undefined, () => undefined)
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function createRealtimeAuthorityReader(deps: RealtimeAuthorityReaderDeps): RealtimeAuthorityReader {
  const nowSeconds = deps.nowSeconds ?? (() => Date.now() / 1000)
  const timeoutMs = deps.timeoutMs ?? DEFAULT_AUTHORITY_READ_TIMEOUT_MS

  async function readOrdinary(
    subjects: readonly RealtimeSessionBinding[],
    out: Map<string, AuthorityVerdict>,
  ): Promise<void> {
    if (subjects.length === 0) return
    const subjectRows = await deps.query(ORDINARY_SUBJECT_AUTHORITY_SQL, [
      subjects.map((binding) => binding.userId),
      subjects.map((binding) => binding.organizationId),
    ])
    const byOrdinal = new Map<number, Record<string, unknown>>()
    for (const row of subjectRows.rows) byOrdinal.set(Number(row.ord), row)

    const sessionIds = [...new Set(subjects.flatMap((binding) => (binding.sessionId ? [binding.sessionId] : [])))]
    const sessions = new Map<string, Record<string, unknown>>()
    if (sessionIds.length > 0) {
      const sessionRows = await deps.query(ORDINARY_SESSION_AUTHORITY_SQL, [sessionIds])
      for (const row of sessionRows.rows) sessions.set(String(row.id), row)
    }

    subjects.forEach((binding, index) => {
      let verdict = ordinarySubjectVerdict(binding, byOrdinal.get(index + 1))
      if (verdict.state === 'allowed' && binding.sessionId) {
        const session = sessions.get(binding.sessionId)
        if (!session || session.user_id !== binding.userId || session.open !== true) {
          verdict = denied('session-not-current')
        }
      }
      out.set(bindingKey(binding), verdict)
    })
  }

  async function readStrict(
    subjects: readonly RealtimeSessionBinding[],
    out: Map<string, AuthorityVerdict>,
  ): Promise<void> {
    // One verification per distinct session, one at a time: each holds a pooled connection.
    for (const binding of subjects) {
      const key = bindingKey(binding)
      if (binding.expiresAtSeconds == null || binding.expiresAtSeconds <= nowSeconds()) {
        out.set(key, denied('credential-expired'))
        continue
      }
      try {
        out.set(key, (await deps.verifyStrict(binding)) === true ? ALLOWED : denied('strict-session-not-current'))
      } catch {
        out.set(key, unknown('authority-read-failed'))
      }
    }
  }

  return {
    async read(bindings) {
      const distinct = new Map<string, RealtimeSessionBinding>()
      for (const binding of bindings) distinct.set(bindingKey(binding), binding)
      const out = new Map<string, AuthorityVerdict>()
      if (distinct.size === 0) return out

      const ordinary = [...distinct.values()].filter((binding) => binding.sessionClass === 'ordinary')
      const strict = [...distinct.values()].filter((binding) => binding.sessionClass === 'strict')

      let outcome: void | 'timeout'
      let failed = false
      try {
        outcome = await withDeadline(
          (async () => {
            await readOrdinary(ordinary, out)
            await readStrict(strict, out)
          })(),
          timeoutMs,
        )
      } catch {
        failed = true
      }
      // A late completion of the abandoned read must not turn an `unknown` back into an answer.
      const settled = new Map(out)
      for (const key of distinct.keys()) {
        if (failed) settled.set(key, unknown('authority-read-failed'))
        else if (outcome === 'timeout' && !settled.has(key)) settled.set(key, unknown('authority-read-timeout'))
        else if (!settled.has(key)) settled.set(key, unknown('authority-row-missing'))
      }
      if (outcome === 'timeout') {
        for (const key of distinct.keys()) {
          const verdict = settled.get(key)
          // A session answered before the deadline keeps a denial; an unfinished batch grants nothing.
          if (verdict?.state === 'allowed') settled.set(key, unknown('authority-read-timeout'))
        }
      }
      return settled
    },
  }
}
