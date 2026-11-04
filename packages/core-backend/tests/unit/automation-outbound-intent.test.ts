/**
 * #4196 Class-B outbound two-phase intent/outcome — module unit tests (design-lock
 * `approval-automation-retry-action-classification-designlock-20260712.md` §3 + §8 Q-B).
 *
 * Fast local proof of (1) the §3+§8-Q-B classification tiers and (2) the two-phase state machine
 * (`claimOutboundIntent` / `recordOutboundOutcome`) against an IN-MEMORY table mock that faithfully honors
 * the guard clauses read from the SQL TEXT — so the crash-flip and the `status='pending'` single-writer
 * guard are mutation-provable here as well as in the real-DB golden.
 *
 * The mock keys rows by (kind, root, action_key, target_key) and parses each statement:
 *   - INSERT ... ON CONFLICT DO NOTHING  → rowCount 1 if new (stores the attempt token + lease), 0 otherwise;
 *   - SELECT status, attempt_token, lease_live → the current row, liveness against the mock clock;
 *   - UPDATE ... SET status = 'X' / $4 ...    → applies iff the row satisfies EVERY guard PARSED FROM THE SQL
 *     (`AND status = '…'`, the token fence, the lease-expired predicate), so deleting a guard in the module
 *     changes behavior through the mock.
 */
import { afterEach, describe, expect, it } from 'vitest'

import {
  claimOutboundIntent,
  classifyFetchError,
  classifyOutboundResult,
  deriveOutboundTargetKey,
  isClassBOutboundEnabled,
  outboundLeaseForTimeout,
  outboundReasonClass,
  recordOutboundOutcome,
  OUTBOUND_LEASE_GRACE_MS,
  type OutboundAttemptResult,
  type OutboundIntentIdentity,
  type OutboundQueryFn,
} from '../../src/multitable/automation-outbound-intent'

// ── in-memory faithful table mock ────────────────────────────────────────────
interface Row {
  status: string
  attempts: number
  last_error: string | null
  attempt_token: string | null
  /** lease expiry on the mock clock (ms); null = no lease (a row written before leases existed). */
  lease_expires_at: number | null
}
interface Table {
  query: OutboundQueryFn
  rows: Map<string, Row>
  /** the mock DB clock — tests advance it to expire a lease */
  clock: { now: number }
  /** every UPDATE statement that flipped a row to outcome_unknown, in order (observed token param) */
  flips: Array<{ observedToken: string | null; affected: number }>
  seed: (id: OutboundIntentIdentity, row: Partial<Row> & { status: string }) => void
  rowOf: (id: OutboundIntentIdentity) => Row | undefined
}
const keyOfId = (id: OutboundIntentIdentity) => `${id.kind}|${id.rootExecutionId}|${id.actionKey}|${id.targetKey ?? ''}`

function makeTable(): Table {
  const rows = new Map<string, Row>()
  const clock = { now: 1_000_000 }
  const flips: Table['flips'] = []
  // target_key is $4 in every statement except the terminal write, where the SQL names its own position.
  const keyOf = (s: string, p: unknown[]) => {
    const pos = /target_key = \$(\d+)/i.exec(s)?.[1]
    const target = pos ? String(p[Number(pos) - 1] ?? '') : String(p[3] ?? '')
    return `${String(p[0])}|${String(p[1])}|${String(p[2])}|${target}`
  }
  const query: OutboundQueryFn = async (sql, params = []) => {
    const s = String(sql)
    const key = keyOf(s, params)
    if (/^\s*INSERT INTO meta_automation_outbound_intent/i.test(s)) {
      if (rows.has(key)) return { rows: [], rowCount: 0 } // ON CONFLICT DO NOTHING
      rows.set(key, {
        status: 'pending', attempts: 0, last_error: null,
        attempt_token: (params[4] as string | undefined) ?? null,
        lease_expires_at: typeof params[5] === 'number' ? clock.now + params[5] : null,
      })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*SELECT status/i.test(s)) {
      const r = rows.get(key)
      if (!r) return { rows: [], rowCount: 0 }
      const leaseLive = r.lease_expires_at !== null && r.lease_expires_at > clock.now
      return { rows: [{ status: r.status, attempt_token: r.attempt_token, lease_live: leaseLive }], rowCount: 1 }
    }
    if (/^\s*UPDATE meta_automation_outbound_intent/i.test(s)) {
      const r = rows.get(key)
      if (!r) return { rows: [], rowCount: 0 }
      // Honor whichever `AND status = '…'` guard the SQL actually carries (absent ⇒ unconditional).
      const guard = /AND status = '([a-z_]+)'/i.exec(s)?.[1] ?? null
      if (guard && r.status !== guard) return { rows: [], rowCount: 0 }
      // Token fence, as written: `attempt_token IS NOT DISTINCT FROM $n` (null-safe) or `attempt_token = $n`.
      const nullSafe = /attempt_token IS NOT DISTINCT FROM \$(\d+)/i.exec(s)?.[1]
      const strict = /AND attempt_token = \$(\d+)/i.exec(s)?.[1]
      if (nullSafe && (r.attempt_token ?? null) !== ((params[Number(nullSafe) - 1] as string | null | undefined) ?? null)) {
        if (/SET status = 'outcome_unknown'/i.test(s)) flips.push({ observedToken: (params[Number(nullSafe) - 1] as string | null) ?? null, affected: 0 })
        return { rows: [], rowCount: 0 }
      }
      if (strict && r.attempt_token !== params[Number(strict) - 1]) return { rows: [], rowCount: 0 }
      // Lease-expired predicate, as written.
      if (/lease_expires_at IS NULL OR lease_expires_at <= now\(\)/i.test(s)) {
        if (r.lease_expires_at !== null && r.lease_expires_at > clock.now) return { rows: [], rowCount: 0 }
      }
      // Target status: a literal `SET status = 'X'` or the parameterized `SET status = $4`.
      const literal = /SET status = '([a-z_]+)'/i.exec(s)?.[1]
      const next = literal ?? (s.includes('status = $4') ? String(params[3]) : r.status)
      if (literal === 'outcome_unknown') flips.push({ observedToken: nullSafe ? ((params[Number(nullSafe) - 1] as string | null) ?? null) : null, affected: 1 })
      r.status = next
      if (/attempts = attempts \+ 1/i.test(s)) r.attempts += 1
      if (s.includes('last_error = $5')) r.last_error = (params[4] ?? null) as string | null
      else if (/last_error = '([a-z_]+)'/i.test(s)) r.last_error = /last_error = '([a-z_]+)'/i.exec(s)?.[1] ?? r.last_error
      // A re-arm (`attempt_token = $n, lease_expires_at = now() + ($m::int ...)`) hands the row to a new attempt.
      const setToken = /SET [^]*?attempt_token = \$(\d+)/i.exec(s)?.[1]
      const setLease = /lease_expires_at = now\(\) \+ \(\$(\d+)::int/i.exec(s)?.[1]
      if (setToken) r.attempt_token = (params[Number(setToken) - 1] as string | undefined) ?? null
      if (setLease) r.lease_expires_at = clock.now + Number(params[Number(setLease) - 1])
      rows.set(key, r)
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected SQL: ${s}`)
  }
  const seed: Table['seed'] = (id, row) => {
    rows.set(keyOfId(id), {
      status: row.status,
      attempts: row.attempts ?? 0,
      last_error: row.last_error ?? null,
      attempt_token: row.attempt_token ?? null,
      lease_expires_at: row.lease_expires_at === undefined ? null : row.lease_expires_at,
    })
  }
  return { query, rows, clock, flips, seed, rowOf: (id) => rows.get(keyOfId(id)) }
}

const ID: OutboundIntentIdentity = { kind: 'execution', rootExecutionId: 'exec_root_1', actionKey: 'ak_hook_1' }
const TARGET_A = deriveOutboundTargetKey(['yida_form_record', 'form_1', 'rec_a'])
const TARGET_B = deriveOutboundTargetKey(['yida_form_record', 'form_1', 'rec_b'])
const ID_TARGET_A: OutboundIntentIdentity = { ...ID, targetKey: TARGET_A }
const ID_TARGET_B: OutboundIntentIdentity = { ...ID, targetKey: TARGET_B }

/** Wraps a query fn so a hook runs right AFTER the first consult SELECT (deterministic interleaving). */
function afterFirstConsult(query: OutboundQueryFn, hook: () => Promise<void> | void): OutboundQueryFn {
  let fired = false
  return async (sql, params) => {
    const result = await query(sql, params)
    if (!fired && /^\s*SELECT status/i.test(String(sql))) {
      fired = true
      await hook()
    }
    return result
  }
}

afterEach(() => {
  delete process.env.AUTOMATION_CLASSB_OUTBOUND_ENABLED
})

// ── §3 + §8 Q-B classification ───────────────────────────────────────────────
describe('classifyOutboundResult — §3 + §8 Q-B tiers', () => {
  it('2xx → sent', () => {
    for (const status of [200, 201, 202, 204, 299]) {
      expect(classifyOutboundResult({ kind: 'response', status })).toBe('sent')
    }
  })

  it('§8 Q-B: EVERY 4xx received after body-sent → outcome_unknown (NOT failed) — 400/404/409/429/499', () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429, 499]) {
      expect(classifyOutboundResult({ kind: 'response', status })).toBe('outcome_unknown')
    }
  })

  it('5xx and 3xx received after body-sent → outcome_unknown', () => {
    for (const status of [301, 302, 500, 502, 503, 504]) {
      expect(classifyOutboundResult({ kind: 'response', status })).toBe('outcome_unknown')
    }
  })

  it('timeout → outcome_unknown (the request MAY be processing server-side)', () => {
    expect(classifyOutboundResult({ kind: 'timeout' })).toBe('outcome_unknown')
  })

  it('DEFINITE pre-dispatch non-delivery ONLY → failed: DNS / conn-refused / TLS handshake', () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']) {
      expect(classifyOutboundResult({ kind: 'network-error', code })).toBe('failed')
    }
    for (const code of ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER']) {
      expect(classifyOutboundResult({ kind: 'network-error', code })).toBe('failed')
    }
  })

  it('post-dispatch / indistinguishable network errors → outcome_unknown (reset / broken pipe / socket timeout / unknown)', () => {
    for (const code of ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', null]) {
      expect(classifyOutboundResult({ kind: 'network-error', code })).toBe('outcome_unknown')
    }
  })
})

describe('outboundReasonClass — bounded redacted classes (never a body/URL/token)', () => {
  it('maps to coarse categories in lock-step with the outcome', () => {
    expect(outboundReasonClass({ kind: 'response', status: 200 })).toBe('sent_2xx')
    expect(outboundReasonClass({ kind: 'response', status: 404 })).toBe('http_404')
    expect(outboundReasonClass({ kind: 'timeout' })).toBe('timeout')
    expect(outboundReasonClass({ kind: 'network-error', code: 'ENOTFOUND' })).toBe('dns_failure')
    expect(outboundReasonClass({ kind: 'network-error', code: 'ECONNREFUSED' })).toBe('conn_refused')
    expect(outboundReasonClass({ kind: 'network-error', code: 'CERT_HAS_EXPIRED' })).toBe('tls_failure')
    expect(outboundReasonClass({ kind: 'network-error', code: 'ECONNRESET' })).toBe('network_ECONNRESET')
    expect(outboundReasonClass({ kind: 'network-error', code: null })).toBe('network_error')
  })
})

describe('classifyFetchError — raw fetch rejection → values-free attempt result', () => {
  it('AbortError / TimeoutError (direct or as cause) → timeout', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    expect(classifyFetchError(abort)).toEqual({ kind: 'timeout' })
    const wrapped = Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('t'), { name: 'TimeoutError' }) })
    expect(classifyFetchError(wrapped)).toEqual({ kind: 'timeout' })
  })

  it('undici TypeError with a socket cause → network-error carrying cause.code', () => {
    const err = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) })
    expect(classifyFetchError(err)).toEqual({ kind: 'network-error', code: 'ECONNREFUSED', name: 'TypeError' })
  })

  it('direct .code (e.g. ENOTFOUND) is read when there is no cause', () => {
    const err = Object.assign(new Error('dns'), { code: 'ENOTFOUND' })
    expect(classifyFetchError(err)).toEqual({ kind: 'network-error', code: 'ENOTFOUND', name: 'Error' })
  })

  it('a non-object rejection → network-error with null code', () => {
    expect(classifyFetchError('boom')).toEqual({ kind: 'network-error', code: null, name: null })
  })
})

// ── two-phase state machine (in-memory mock) ─────────────────────────────────
describe('claimOutboundIntent — two-phase decisions', () => {
  it('happy path: fresh insert → proceed with a token + lease; the SAME token confirms sent; replay → skip_sent (no resend)', async () => {
    const t = makeTable()
    const claim = await claimOutboundIntent(t.query, ID, { leaseMs: 5_000 })
    expect(claim.decision).toBe('proceed')
    expect(typeof claim.attemptToken).toBe('string')
    expect(t.rowOf(ID)).toMatchObject({ status: 'pending', attempt_token: claim.attemptToken, lease_expires_at: t.clock.now + 5_000 })
    expect(await recordOutboundOutcome(t.query, ID, 'sent', 'sent_2xx', claim.attemptToken as string)).toEqual({ confirmed: true })
    expect(t.rowOf(ID)?.status).toBe('sent')
    expect(await claimOutboundIntent(t.query, ID)).toEqual({ decision: 'skip_sent', attemptToken: null })
  })

  it('LIVE pending (lease not expired) → skip_inflight: no send, NO flip — the in-flight attempt still owns the row', async () => {
    const t = makeTable()
    const first = await claimOutboundIntent(t.query, ID, { leaseMs: 60_000 })
    expect(first.decision).toBe('proceed')
    t.clock.now += 59_000 // still inside the lease
    const replay = await claimOutboundIntent(t.query, ID)
    expect(replay).toEqual({ decision: 'skip_inflight', attemptToken: null })
    expect(t.rowOf(ID)).toMatchObject({ status: 'pending', attempt_token: first.attemptToken })
    expect(t.flips).toEqual([]) // nothing declared dead
    // ... and the in-flight attempt can still confirm its own result afterwards.
    expect(await recordOutboundOutcome(t.query, ID, 'sent', 'sent_2xx', first.attemptToken as string)).toEqual({ confirmed: true })
  })

  it('CRASH-MID-SEND: pending with an EXPIRED lease, no outcome recorded, replay → flips pending→outcome_unknown and skip_unknown', async () => {
    const t = makeTable()
    const first = await claimOutboundIntent(t.query, ID, { leaseMs: 60_000 }) // committed pending, then "crash"
    t.clock.now += 60_001 // lease expired
    const replay = await claimOutboundIntent(t.query, ID)
    expect(replay).toEqual({ decision: 'skip_unknown', attemptToken: null }) // NEVER a second send
    expect(t.rowOf(ID)).toMatchObject({ status: 'outcome_unknown', last_error: 'lease_expired' })
    expect(t.flips).toEqual([{ observedToken: first.attemptToken, affected: 1 }]) // the flip names the attempt it observed
    // The crashed attempt's late terminal write is refused and TOLD so.
    expect(await recordOutboundOutcome(t.query, ID, 'sent', 'sent_2xx', first.attemptToken as string)).toEqual({ confirmed: false })
    expect(t.rowOf(ID)?.status).toBe('outcome_unknown')
  })

  it('a lease-less legacy pending row (written before leases existed) is never live: replay flips it (pre-lease behaviour kept)', async () => {
    const t = makeTable()
    t.seed(ID, { status: 'pending', attempt_token: null, lease_expires_at: null })
    expect(await claimOutboundIntent(t.query, ID)).toEqual({ decision: 'skip_unknown', attemptToken: null })
    expect(t.rowOf(ID)?.status).toBe('outcome_unknown')
    expect(t.flips).toEqual([{ observedToken: null, affected: 1 }]) // null-safe token fence matched the NULL token
  })

  it('the crash-flip is token-fenced: a row re-armed by a newer attempt between consult and flip is left alone', async () => {
    const t = makeTable()
    const stale = await claimOutboundIntent(t.query, ID, { leaseMs: 1_000, attemptToken: 'tok_stale' })
    expect(stale.decision).toBe('proceed')
    t.clock.now += 1_001 // tok_stale's lease expired
    // The replay consults (pending, tok_stale, expired). Before its flip UPDATE runs, the stale attempt lands a
    // definite `failed` and a NEW attempt re-arms the row (tok_new, live lease).
    const interleaved = afterFirstConsult(t.query, async () => {
      expect(await recordOutboundOutcome(t.query, ID, 'failed', 'dns_failure', 'tok_stale')).toEqual({ confirmed: true })
      const rearm = await claimOutboundIntent(t.query, ID, { leaseMs: 60_000, attemptToken: 'tok_new' })
      expect(rearm.decision).toBe('retry_failed')
    })
    const replay = await claimOutboundIntent(interleaved, ID)
    expect(replay).toEqual({ decision: 'skip_inflight', attemptToken: null }) // re-consulted, found a live owner
    expect(t.rowOf(ID)).toMatchObject({ status: 'pending', attempt_token: 'tok_new' })
    expect(t.flips).toEqual([{ observedToken: 'tok_stale', affected: 0 }]) // the flip named tok_stale and hit nothing
  })

  it('outcome_unknown is TERMINAL: a further retry stays skip_unknown, never re-sends', async () => {
    const t = makeTable()
    const claim = await claimOutboundIntent(t.query, ID)
    await recordOutboundOutcome(t.query, ID, 'outcome_unknown', 'timeout', claim.attemptToken as string)
    expect((await claimOutboundIntent(t.query, ID)).decision).toBe('skip_unknown')
    expect((await claimOutboundIntent(t.query, ID)).decision).toBe('skip_unknown')
  })

  it('failed (definite pre-dispatch non-delivery) → retry_failed with a NEW token + lease → can then succeed', async () => {
    const t = makeTable()
    const first = await claimOutboundIntent(t.query, ID, { attemptToken: 'tok_1' })
    await recordOutboundOutcome(t.query, ID, 'failed', 'dns_failure', 'tok_1')
    const retry = await claimOutboundIntent(t.query, ID, { attemptToken: 'tok_2', leaseMs: 7_000 })
    expect(retry).toEqual({ decision: 'retry_failed', attemptToken: 'tok_2', leaseMs: 7_000 }) // eligible to re-attempt
    expect(t.rowOf(ID)).toMatchObject({ status: 'pending', attempts: 1, attempt_token: 'tok_2', lease_expires_at: t.clock.now + 7_000 })
    // the OLD attempt's token can no longer write this row; the new one can.
    expect(await recordOutboundOutcome(t.query, ID, 'sent', 'sent_2xx', first.attemptToken as string)).toEqual({ confirmed: false })
    expect(await recordOutboundOutcome(t.query, ID, 'sent', 'sent_2xx', 'tok_2')).toEqual({ confirmed: true })
    expect((await claimOutboundIntent(t.query, ID)).decision).toBe('skip_sent')
  })

  it('EXACTLY ONE winner of failed→pending: a concurrent re-arm that loses the compare-and-set re-consults and does not send', async () => {
    const t = makeTable()
    const first = await claimOutboundIntent(t.query, ID, { attemptToken: 'tok_1' })
    await recordOutboundOutcome(t.query, ID, 'failed', 'dns_failure', first.attemptToken as string)
    // Both claimants consult `failed`; A's CAS commits before B's CAS runs (B is interleaved after its consult).
    const b = afterFirstConsult(t.query, async () => {
      const a = await claimOutboundIntent(t.query, ID, { attemptToken: 'tok_a', leaseMs: 60_000 })
      expect(a.decision).toBe('retry_failed')
    })
    const bClaim = await claimOutboundIntent(b, ID, { attemptToken: 'tok_b', leaseMs: 60_000 })
    expect(bClaim).toEqual({ decision: 'skip_inflight', attemptToken: null }) // the loser never sends
    expect(t.rowOf(ID)).toMatchObject({ status: 'pending', attempts: 1, attempt_token: 'tok_a' })
  })

  it('lease length: defaults to 120s, clamps to [1s, 1h]; the webhook lease is timeout + grace', async () => {
    const t = makeTable()
    expect(await claimOutboundIntent(t.query, ID)).toMatchObject({ decision: 'proceed', leaseMs: 120_000 })
    expect(await claimOutboundIntent(t.query, { ...ID, actionKey: 'ak_2' }, { leaseMs: 1 })).toMatchObject({ leaseMs: 1_000 })
    expect(await claimOutboundIntent(t.query, { ...ID, actionKey: 'ak_3' }, { leaseMs: 10 ** 9 })).toMatchObject({ leaseMs: 3_600_000 })
    expect(outboundLeaseForTimeout(10_000)).toBe(10_000 + OUTBOUND_LEASE_GRACE_MS)
  })

  it('input validation: bad kind / blank root / blank key / malformed targetKey throw before any SQL', async () => {
    const stub: OutboundQueryFn = async () => { throw new Error('must not be queried') }
    await expect(claimOutboundIntent(stub, { kind: 'bogus' as never, rootExecutionId: 'r', actionKey: 'k' })).rejects.toThrow(/kind must be/)
    await expect(claimOutboundIntent(stub, { kind: 'execution', rootExecutionId: ' ', actionKey: 'k' })).rejects.toThrow(/rootExecutionId/)
    await expect(claimOutboundIntent(stub, { kind: 'execution', rootExecutionId: 'r', actionKey: '' })).rejects.toThrow(/actionKey/)
    await expect(claimOutboundIntent(stub, { ...ID, targetKey: 'rec_a' })).rejects.toThrow(/targetKey/)
    await expect(recordOutboundOutcome(stub, ID, 'sent', null, '')).rejects.toThrow(/attemptToken/)
  })
})

describe('per-target keys (#4450 §2.1) — stable business keys for repeated writes inside one step', () => {
  it('two records → two keys; the same record → the same key; order of resolution is irrelevant; 64-hex shape', () => {
    const a1 = deriveOutboundTargetKey(['yida_form_record', 'form_1', 'rec_a'])
    const a2 = deriveOutboundTargetKey(['yida_form_record', 'form_1', 'rec_a'])
    const b = deriveOutboundTargetKey(['yida_form_record', 'form_1', 'rec_b'])
    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
    expect(a1).toMatch(/^[0-9a-f]{64}$/)
    const forward = [['x', '1'], ['x', '2'], ['x', '3']].map((p) => deriveOutboundTargetKey(p))
    const reversed = [['x', '3'], ['x', '2'], ['x', '1']].map((p) => deriveOutboundTargetKey(p))
    expect(new Set(forward)).toEqual(new Set(reversed))
    // injective encoding: a delimiter collision in the parts does not collide the key
    expect(deriveOutboundTargetKey(['a|b', 'c'])).not.toBe(deriveOutboundTargetKey(['a', 'b|c']))
    expect(() => deriveOutboundTargetKey([])).toThrow(/non-empty/)
    expect(() => deriveOutboundTargetKey(['ok', ' '])).toThrow(/non-blank/)
  })

  it('two targets of one action are two independent intents; replaying one target after a crash reuses ITS row', async () => {
    const t = makeTable()
    const a = await claimOutboundIntent(t.query, ID_TARGET_A, { leaseMs: 60_000 })
    const b = await claimOutboundIntent(t.query, ID_TARGET_B, { leaseMs: 60_000 })
    expect(a.decision).toBe('proceed')
    expect(b.decision).toBe('proceed')
    await recordOutboundOutcome(t.query, ID_TARGET_A, 'sent', 'sent_2xx', a.attemptToken as string)
    // crash before B's outcome; the replay handles each record by its own key
    t.clock.now += 60_001
    expect((await claimOutboundIntent(t.query, ID_TARGET_A)).decision).toBe('skip_sent')
    expect((await claimOutboundIntent(t.query, ID_TARGET_B)).decision).toBe('skip_unknown')
    expect(t.rowOf(ID_TARGET_A)?.status).toBe('sent')
    expect(t.rowOf(ID_TARGET_B)?.status).toBe('outcome_unknown')
  })

  it('key-format upgrade: history written under the whole-action key still blocks per-target sends (sent / unknown), failed does not', async () => {
    const t = makeTable()
    t.seed(ID, { status: 'sent' }) // pre-#4450 row shape: target_key '' , no token, no lease
    expect(await claimOutboundIntent(t.query, ID_TARGET_A)).toEqual({ decision: 'skip_sent', attemptToken: null })
    expect(t.rowOf(ID_TARGET_A)).toBeUndefined() // no per-target intent was even written
    t.seed(ID, { status: 'outcome_unknown' })
    expect((await claimOutboundIntent(t.query, ID_TARGET_A)).decision).toBe('skip_unknown')
    t.seed(ID, { status: 'pending', attempt_token: null, lease_expires_at: null }) // a crashed legacy attempt
    expect((await claimOutboundIntent(t.query, ID_TARGET_A)).decision).toBe('skip_unknown')
    expect(t.rowOf(ID)?.status).toBe('outcome_unknown') // flipped, fail closed
    t.seed(ID, { status: 'failed' }) // definite non-delivery under the old format blocks nothing
    expect((await claimOutboundIntent(t.query, ID_TARGET_A)).decision).toBe('proceed')
    expect(t.rowOf(ID_TARGET_A)?.status).toBe('pending')
    // and the whole-action identity itself keeps reading the legacy row
    expect((await claimOutboundIntent(t.query, ID)).decision).toBe('retry_failed')
  })
})

describe('recordOutboundOutcome — status=pending AND attempt_token single-writer fence', () => {
  it('a terminalized (outcome_unknown) row is NOT overwritten by a later sent (0 rows, confirmed:false)', async () => {
    const t = makeTable()
    const claim = await claimOutboundIntent(t.query, ID) // pending
    const token = claim.attemptToken as string
    expect(await recordOutboundOutcome(t.query, ID, 'outcome_unknown', 'timeout', token)).toEqual({ confirmed: true })
    expect(await recordOutboundOutcome(t.query, ID, 'sent', 'sent_2xx', token)).toEqual({ confirmed: false }) // zombie's late write
    expect(t.rowOf(ID)?.status).toBe('outcome_unknown') // stays terminal
  })

  it('a pending row owned by another attempt is NOT written by a foreign token (confirmed:false, row untouched)', async () => {
    const t = makeTable()
    await claimOutboundIntent(t.query, ID, { attemptToken: 'tok_owner' })
    expect(await recordOutboundOutcome(t.query, ID, 'sent', 'sent_2xx', 'tok_other')).toEqual({ confirmed: false })
    expect(t.rowOf(ID)).toMatchObject({ status: 'pending', attempt_token: 'tok_owner', last_error: null })
  })

  it('last_error is bounded to a redacted class (defense-in-depth cap)', async () => {
    const t = makeTable()
    const claim = await claimOutboundIntent(t.query, ID)
    await recordOutboundOutcome(t.query, ID, 'failed', 'x'.repeat(500), claim.attemptToken as string)
    expect((t.rowOf(ID)?.last_error ?? '').length).toBe(200)
  })
})

describe('isClassBOutboundEnabled — default OFF', () => {
  it('unset / anything-but-true → false; exactly "true" → true', () => {
    expect(isClassBOutboundEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    expect(isClassBOutboundEnabled({ AUTOMATION_CLASSB_OUTBOUND_ENABLED: '1' } as unknown as NodeJS.ProcessEnv)).toBe(false)
    expect(isClassBOutboundEnabled({ AUTOMATION_CLASSB_OUTBOUND_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv)).toBe(true)
  })
})
