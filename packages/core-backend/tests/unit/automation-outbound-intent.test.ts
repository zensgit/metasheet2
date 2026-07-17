/**
 * #4196 Class-B outbound two-phase intent/outcome — module unit tests (design-lock
 * `approval-automation-retry-action-classification-designlock-20260712.md` §3 + §8 Q-B).
 *
 * Fast local proof of (1) the §3+§8-Q-B classification tiers and (2) the two-phase state machine
 * (`claimOutboundIntent` / `recordOutboundOutcome`) against an IN-MEMORY table mock that faithfully honors
 * the guard clauses read from the SQL TEXT — so the crash-flip and the `status='pending'` single-writer
 * guard are mutation-provable here as well as in the real-DB golden.
 *
 * The mock keys rows by (kind, root, action_key) and parses each statement:
 *   - INSERT ... ON CONFLICT DO NOTHING  → rowCount 1 if new, 0 if the identity already exists;
 *   - SELECT status                      → the current status;
 *   - UPDATE ... SET status = 'X' ...    → applies iff the row's status satisfies the `AND status = '…'`
 *     guard PARSED FROM THE SQL (so deleting a guard in the module changes behavior through the mock).
 */
import { afterEach, describe, expect, it } from 'vitest'

import {
  claimOutboundIntent,
  classifyFetchError,
  classifyOutboundResult,
  isClassBOutboundEnabled,
  outboundReasonClass,
  recordOutboundOutcome,
  type OutboundAttemptResult,
  type OutboundIntentIdentity,
  type OutboundQueryFn,
} from '../../src/multitable/automation-outbound-intent'

// ── in-memory faithful table mock ────────────────────────────────────────────
interface Row {
  status: string
  attempts: number
  last_error: string | null
}
function makeTable(): { query: OutboundQueryFn; rows: Map<string, Row> } {
  const rows = new Map<string, Row>()
  const keyOf = (p: unknown[]) => `${String(p[0])}|${String(p[1])}|${String(p[2])}`
  const query: OutboundQueryFn = async (sql, params = []) => {
    const s = String(sql)
    const key = keyOf(params)
    if (/^\s*INSERT INTO meta_automation_outbound_intent/i.test(s)) {
      if (rows.has(key)) return { rows: [], rowCount: 0 } // ON CONFLICT DO NOTHING
      rows.set(key, { status: 'pending', attempts: 0, last_error: null })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*SELECT status FROM meta_automation_outbound_intent/i.test(s)) {
      const r = rows.get(key)
      return { rows: r ? [{ status: r.status }] : [], rowCount: r ? 1 : 0 }
    }
    if (/^\s*UPDATE meta_automation_outbound_intent/i.test(s)) {
      const r = rows.get(key)
      if (!r) return { rows: [], rowCount: 0 }
      // Honor whichever `AND status = '…'` guard the SQL actually carries (absent ⇒ unconditional).
      const guard = /AND status = '([a-z_]+)'/i.exec(s)?.[1] ?? null
      if (guard && r.status !== guard) return { rows: [], rowCount: 0 }
      // Target status: a literal `SET status = 'X'` or the parameterized `SET status = $4`.
      const literal = /SET status = '([a-z_]+)'/i.exec(s)?.[1]
      const next = literal ?? (String(sql).includes('status = $4') ? String(params[3]) : r.status)
      r.status = next
      if (/attempts = attempts \+ 1/i.test(s)) r.attempts += 1
      if (String(sql).includes('last_error = $5')) r.last_error = (params[4] ?? null) as string | null
      rows.set(key, r)
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected SQL: ${s}`)
  }
  return { query, rows }
}

const ID: OutboundIntentIdentity = { kind: 'execution', rootExecutionId: 'exec_root_1', actionKey: 'ak_hook_1' }

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
  it('happy path: fresh insert → proceed; after sent → skip_sent (no resend)', async () => {
    const t = makeTable()
    expect(await claimOutboundIntent(t.query, ID)).toBe('proceed')
    await recordOutboundOutcome(t.query, ID, 'sent', 'sent_2xx')
    expect(await claimOutboundIntent(t.query, ID)).toBe('skip_sent')
    expect(t.rows.get('execution|exec_root_1|ak_hook_1')?.status).toBe('sent')
  })

  it('CRASH-MID-SEND: intent pending, no outcome recorded, retry → flips pending→outcome_unknown and skip_unknown', async () => {
    const t = makeTable()
    expect(await claimOutboundIntent(t.query, ID)).toBe('proceed') // committed pending, then "crash" (no outcome)
    const decision = await claimOutboundIntent(t.query, ID) // the retry
    expect(decision).toBe('skip_unknown') // NEVER a second send
    expect(t.rows.get('execution|exec_root_1|ak_hook_1')?.status).toBe('outcome_unknown') // failed closed
  })

  it('outcome_unknown is TERMINAL: a further retry stays skip_unknown, never re-sends', async () => {
    const t = makeTable()
    await claimOutboundIntent(t.query, ID)
    await recordOutboundOutcome(t.query, ID, 'outcome_unknown', 'timeout')
    expect(await claimOutboundIntent(t.query, ID)).toBe('skip_unknown')
    expect(await claimOutboundIntent(t.query, ID)).toBe('skip_unknown')
  })

  it('failed (definite pre-dispatch non-delivery) → retry_failed permitted → can then succeed', async () => {
    const t = makeTable()
    await claimOutboundIntent(t.query, ID)
    await recordOutboundOutcome(t.query, ID, 'failed', 'dns_failure')
    expect(await claimOutboundIntent(t.query, ID)).toBe('retry_failed') // eligible to re-attempt
    expect(t.rows.get('execution|exec_root_1|ak_hook_1')?.status).toBe('pending')
    expect(t.rows.get('execution|exec_root_1|ak_hook_1')?.attempts).toBe(1) // attempt bumped
    await recordOutboundOutcome(t.query, ID, 'sent', 'sent_2xx')
    expect(await claimOutboundIntent(t.query, ID)).toBe('skip_sent')
  })

  it('input validation: bad kind / blank root / blank key throw before any SQL', async () => {
    const stub: OutboundQueryFn = async () => { throw new Error('must not be queried') }
    await expect(claimOutboundIntent(stub, { kind: 'bogus' as never, rootExecutionId: 'r', actionKey: 'k' })).rejects.toThrow(/kind must be/)
    await expect(claimOutboundIntent(stub, { kind: 'execution', rootExecutionId: ' ', actionKey: 'k' })).rejects.toThrow(/rootExecutionId/)
    await expect(claimOutboundIntent(stub, { kind: 'execution', rootExecutionId: 'r', actionKey: '' })).rejects.toThrow(/actionKey/)
  })
})

describe('recordOutboundOutcome — status=pending single-writer guard', () => {
  it('a terminalized (outcome_unknown) row is NOT overwritten by a later sent (guard writes 0 rows)', async () => {
    const t = makeTable()
    await claimOutboundIntent(t.query, ID) // pending
    await recordOutboundOutcome(t.query, ID, 'outcome_unknown', 'timeout') // terminal
    await recordOutboundOutcome(t.query, ID, 'sent', 'sent_2xx') // a concurrent zombie's late write
    expect(t.rows.get('execution|exec_root_1|ak_hook_1')?.status).toBe('outcome_unknown') // stays terminal
  })

  it('last_error is bounded to a redacted class (defense-in-depth cap)', async () => {
    const t = makeTable()
    await claimOutboundIntent(t.query, ID)
    await recordOutboundOutcome(t.query, ID, 'failed', 'x'.repeat(500))
    expect((t.rows.get('execution|exec_root_1|ak_hook_1')?.last_error ?? '').length).toBe(200)
  })
})

describe('isClassBOutboundEnabled — default OFF', () => {
  it('unset / anything-but-true → false; exactly "true" → true', () => {
    expect(isClassBOutboundEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    expect(isClassBOutboundEnabled({ AUTOMATION_CLASSB_OUTBOUND_ENABLED: '1' } as unknown as NodeJS.ProcessEnv)).toBe(false)
    expect(isClassBOutboundEnabled({ AUTOMATION_CLASSB_OUTBOUND_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv)).toBe(true)
  })
})
