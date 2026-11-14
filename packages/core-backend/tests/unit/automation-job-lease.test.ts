/**
 * R-69 1b-ii — job lease primitives (automation-job-lease.ts), module level, zero DB (design baseline v2.3
 * §10.2.3 I-1..I-6, §10.2.5 T2a / T7 / T11 at the primitive level; the DB-clock cases live in
 * tests/integration/multitable-automation-job-lease-realdb.test.ts).
 *
 *   - heartbeat (fake clock): renews every ttl/3, never fires lostSignal while renewals succeed (T2a's module
 *     half); a renewal ERROR, a renewal TIMEOUT and a passed LOCAL DEADLINE each fire lostSignal at once (T11);
 *     stop() awaits the in-flight tick and a late failure after stop never aborts;
 *   - unified lock order: renewal and finalization touch the lease row FOR UPDATE first, then the intent row;
 *     any 0-row CAS throws inside the transaction (rollback), finalization reports confirmed:false;
 *   - T7 arithmetic: for every accepted timeoutMs (≤ 55 min) outboundLeaseForTimeout(t) ≥ t + 30 s and the
 *     1 h clamp is never hit;
 *   - anyAbortSignal: first reason wins, pre-aborted input short-circuits.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_JOB_LEASE_TTL_MS,
  JobLeaseLostError,
  RUN_INTEGRATION_JOB_TIMEOUT_DEFAULT_MS,
  RUN_INTEGRATION_JOB_TIMEOUT_MAX_MS,
  anyAbortSignal,
  claimJobLease,
  finalizeJobWithFencedOutcome,
  jobLeaseScopeKey,
  renewJobAndIntentLeases,
  startJobLeaseHeartbeat,
  type JobLeaseHandle,
  type JobLeaseQueryFn,
  type JobLeaseTransaction,
} from '../../src/multitable/automation-job-lease'
import {
  OUTBOUND_LEASE_GRACE_MS,
  OUTBOUND_LEASE_MAX_MS,
  outboundLeaseForTimeout,
  type OutboundIntentIdentity,
} from '../../src/multitable/automation-outbound-intent'

const LEASE: JobLeaseHandle = { scopeKey: 'stock_prep_pull:tenant_a:P-001', holder: 'exec_a', fence: '7' }
const INTENT: OutboundIntentIdentity = { kind: 'execution', rootExecutionId: 'exec_a', actionKey: '["0","run_integration_job","abc"]' }

/** A scripted query fn: each statement is classified by its SQL shape and answered from the script. */
type Answer = { rows?: unknown[]; rowCount?: number } | Error
function scriptedQuery(answers: Record<string, Answer>, log: string[]): JobLeaseQueryFn {
  return async (sqlText) => {
    const kind = /FOR UPDATE/.test(sqlText) ? 'lock'
      : /UPDATE meta_automation_job_leases[\s\S]*lease_expires_at > now\(\)/.test(sqlText) ? 'renew_job'
      : /UPDATE meta_automation_job_leases[\s\S]*holder = NULL/.test(sqlText) ? 'release'
      : /INSERT INTO meta_automation_job_leases/.test(sqlText) ? 'claim'
      : /UPDATE meta_automation_outbound_intent[\s\S]*SET lease_expires_at/.test(sqlText) ? 'renew_intent'
      : /UPDATE meta_automation_outbound_intent[\s\S]*SET status/.test(sqlText) ? 'outcome'
      : 'other'
    log.push(kind)
    const answer = answers[kind]
    if (answer instanceof Error) throw answer
    return { rows: answer?.rows ?? [], rowCount: answer?.rowCount ?? 0 }
  }
}
/** A fake transaction seam that records BEGIN/COMMIT/ROLLBACK around the scripted query fn. */
function scriptedTransaction(answers: Record<string, Answer>, log: string[]): JobLeaseTransaction {
  return async (handler) => {
    log.push('BEGIN')
    try {
      const result = await handler({ query: scriptedQuery(answers, log) })
      log.push('COMMIT')
      return result
    } catch (error) {
      log.push('ROLLBACK')
      throw error
    }
  }
}
const lockedOk = { rows: [{ holder: LEASE.holder, fence: LEASE.fence, live: true }], rowCount: 1 }
const oneRow = { rows: [], rowCount: 1 }
const zeroRows = { rows: [], rowCount: 0 }

describe('jobLeaseScopeKey', () => {
  it('builds the ADR §3.4 keys from configuration identifiers only', () => {
    expect(jobLeaseScopeKey({ kind: 'stock_prep_pull', tenantId: 'tenant_a', projectNo: 'P-001' })).toBe('stock_prep_pull:tenant_a:P-001')
    expect(jobLeaseScopeKey({ kind: 'pipeline', pipelineId: 'pipe_1' })).toBe('pipeline:pipe_1')
  })
  it('rejects blank parts and unknown kinds', () => {
    expect(() => jobLeaseScopeKey({ kind: 'stock_prep_pull', tenantId: ' ', projectNo: 'P' })).toThrow(RangeError)
    expect(() => jobLeaseScopeKey({ kind: 'pipeline', pipelineId: '' })).toThrow(RangeError)
    expect(() => jobLeaseScopeKey({ kind: 'apply' } as never)).toThrow(RangeError)
  })
})

describe('claimJobLease', () => {
  it('returns the handle from RETURNING fence::text, and null (busy) when the single UPSERT matched no row', async () => {
    const log: string[] = []
    const claimed = await claimJobLease(scriptedQuery({ claim: { rows: [{ fence: '3' }], rowCount: 1 } }, log), LEASE.scopeKey, 'exec_b', 2_000)
    expect(claimed).toEqual({ scopeKey: LEASE.scopeKey, holder: 'exec_b', fence: '3' })
    const busy = await claimJobLease(scriptedQuery({ claim: zeroRows }, log), LEASE.scopeKey, 'exec_b', 2_000)
    expect(busy).toBeNull()
    expect(log).toEqual(['claim', 'claim'])
  })
  it('is ONE statement that locks nothing and reads nothing first (T10b: it must block behind an open FOR UPDATE)', async () => {
    const log: string[] = []
    const seen: string[] = []
    const query: JobLeaseQueryFn = async (sqlText) => { seen.push(sqlText); return { rows: [{ fence: '1' }], rowCount: 1 } }
    await claimJobLease(query, LEASE.scopeKey, 'exec_b')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/INSERT INTO meta_automation_job_leases/)
    expect(seen[0]).toMatch(/ON CONFLICT \(scope_key\) DO UPDATE/)
    expect(seen[0]).toMatch(/WHERE meta_automation_job_leases\.lease_expires_at <= now\(\)/)
    expect(seen[0]).toMatch(/RETURNING fence::text/)
    expect(log).toEqual([])
  })
})

describe('renewJobAndIntentLeases — unified lock order, all-or-nothing', () => {
  it('locks the lease row FOR UPDATE first, renews the job lease, then renews the intent lease; commits', async () => {
    const log: string[] = []
    await renewJobAndIntentLeases(
      scriptedTransaction({ lock: lockedOk, renew_job: oneRow, renew_intent: oneRow }, log),
      LEASE,
      { id: INTENT, attemptToken: 'tok_a', leaseMs: 60_000 },
      DEFAULT_JOB_LEASE_TTL_MS,
    )
    expect(log).toEqual(['BEGIN', 'lock', 'renew_job', 'renew_intent', 'COMMIT'])
  })
  it.each([
    ['verify fails (another holder / stale fence / expired)', { lock: { rows: [{ holder: 'exec_b', fence: '8', live: true }], rowCount: 1 } }, 'verify', ['BEGIN', 'lock', 'ROLLBACK']],
    ['verify fails (row expired under the lock)', { lock: { rows: [{ holder: LEASE.holder, fence: LEASE.fence, live: false }], rowCount: 1 } }, 'verify', ['BEGIN', 'lock', 'ROLLBACK']],
    ['job renewal is 0 rows', { lock: lockedOk, renew_job: zeroRows }, 'renew_job', ['BEGIN', 'lock', 'renew_job', 'ROLLBACK']],
    ['intent renewal is 0 rows (token no longer owns a pending row)', { lock: lockedOk, renew_job: oneRow, renew_intent: zeroRows }, 'renew_intent', ['BEGIN', 'lock', 'renew_job', 'renew_intent', 'ROLLBACK']],
  ] as const)('%s ⇒ JobLeaseLostError, whole transaction rolled back', async (_label, answers, stage, expectedLog) => {
    const log: string[] = []
    await expect(renewJobAndIntentLeases(
      scriptedTransaction(answers as Record<string, Answer>, log),
      LEASE,
      { id: INTENT, attemptToken: 'tok_a', leaseMs: 60_000 },
    )).rejects.toMatchObject({ name: 'JobLeaseLostError', stage })
    expect(log).toEqual(expectedLog)
  })
})

describe('finalizeJobWithFencedOutcome — Tx B (I-6)', () => {
  const intent = { id: INTENT, attemptToken: 'tok_a' }
  it('lease row FOR UPDATE → fenced outcome → fence-CAS release → COMMIT ⇒ confirmed', async () => {
    const log: string[] = []
    const result = await finalizeJobWithFencedOutcome(scriptedTransaction({ lock: lockedOk, outcome: oneRow, release: oneRow }, log), LEASE, intent, 'sent', 'job_succeeded')
    expect(result).toEqual({ confirmed: true })
    expect(log).toEqual(['BEGIN', 'lock', 'outcome', 'release', 'COMMIT'])
  })
  it.each([
    ['verification fails under the lock', { lock: { rows: [{ holder: 'exec_b', fence: '8', live: true }], rowCount: 1 } }, { confirmed: false, reason: 'lease_lost', stage: 'verify' }, ['BEGIN', 'lock', 'ROLLBACK']],
    ['intent outcome is 0 rows (stale token)', { lock: lockedOk, outcome: zeroRows }, { confirmed: false, reason: 'outcome_unconfirmed' }, ['BEGIN', 'lock', 'outcome', 'ROLLBACK']],
    ['release is 0 rows', { lock: lockedOk, outcome: oneRow, release: zeroRows }, { confirmed: false, reason: 'lease_lost', stage: 'release' }, ['BEGIN', 'lock', 'outcome', 'release', 'ROLLBACK']],
    ['the database fails mid-transaction', { lock: lockedOk, outcome: new Error('connection reset') }, { confirmed: false, reason: 'transaction_failed' }, ['BEGIN', 'lock', 'outcome', 'ROLLBACK']],
  ] as const)('%s ⇒ ROLLBACK, confirmed:false', async (_label, answers, expected, expectedLog) => {
    const log: string[] = []
    const result = await finalizeJobWithFencedOutcome(scriptedTransaction(answers as Record<string, Answer>, log), LEASE, intent, 'sent', 'job_succeeded')
    expect(result).toEqual(expected)
    expect(log).toEqual(expectedLog)
  })
})

describe('startJobLeaseHeartbeat (fake clock)', () => {
  afterEach(() => { vi.useRealTimers() })

  it('T2a: renews every ttl/3 and never fires lostSignal while renewals succeed across 10 TTLs', async () => {
    vi.useFakeTimers()
    const renew = vi.fn(async () => undefined)
    const hb = startJobLeaseHeartbeat({ renew, ttlMs: 3_000 })
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(1_000)
    expect(renew).toHaveBeenCalledTimes(30)
    expect(hb.lost).toBe(false)
    expect(hb.lostSignal.aborted).toBe(false)
    await hb.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(renew).toHaveBeenCalledTimes(30)
    expect(hb.lostSignal.aborted).toBe(false)
  })

  it('T11: a renewal ERROR fires lostSignal at once (reason JobLeaseLostError renew_error) and stops renewing', async () => {
    vi.useFakeTimers()
    const renew = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new JobLeaseLostError('renew_job'))
    const hb = startJobLeaseHeartbeat({ renew, ttlMs: 3_000 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(hb.lost).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(hb.lost).toBe(true)
    expect(hb.lostSignal.aborted).toBe(true)
    expect(hb.lostSignal.reason).toBeInstanceOf(JobLeaseLostError)
    expect((hb.lostSignal.reason as JobLeaseLostError).stage).toBe('renew_error')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(renew).toHaveBeenCalledTimes(2)
    await hb.stop()
  })

  it('T11: a renewal that does not answer within renewTimeoutMs fires lostSignal (renew_timeout) before the DB answers', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const renew = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const hb = startJobLeaseHeartbeat({ renew, ttlMs: 3_000, renewTimeoutMs: 500, safetyMs: 0 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(renew).toHaveBeenCalledTimes(1)
    expect(hb.lost).toBe(false)
    await vi.advanceTimersByTimeAsync(499)
    expect(hb.lost).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(hb.lost).toBe(true)
    expect((hb.lostSignal.reason as JobLeaseLostError).stage).toBe('renew_timeout')
    release()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(renew).toHaveBeenCalledTimes(1)
    await hb.stop()
  })

  it('T11: the LOCAL DEADLINE (lastRenewOk + ttl − safety) fires lostSignal while a renewal is still unanswered', async () => {
    vi.useFakeTimers()
    const renew = vi.fn(() => new Promise<void>(() => undefined)) // never answers
    // renewTimeoutMs > deadline so only the deadline can fire; safety = 1 s ⇒ deadline at t = 2 s.
    const hb = startJobLeaseHeartbeat({ renew, ttlMs: 3_000, renewTimeoutMs: 60_000, safetyMs: 1_000 })
    await vi.advanceTimersByTimeAsync(1_000) // first tick issued at 1 s, hangs
    expect(renew).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(hb.lost).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(hb.lost).toBe(true)
    expect((hb.lostSignal.reason as JobLeaseLostError).stage).toBe('deadline')
    await hb.stop()
  })

  it('a successful renewal moves the local deadline forward (deadline measured from the LAST successful renewal)', async () => {
    vi.useFakeTimers()
    let answers = 0
    const renew = vi.fn(() => (answers++ < 2 ? Promise.resolve() : new Promise<void>(() => undefined)))
    const hb = startJobLeaseHeartbeat({ renew, ttlMs: 3_000, renewTimeoutMs: 60_000, safetyMs: 1_000 })
    await vi.advanceTimersByTimeAsync(2_000) // ticks at 1 s and 2 s succeed ⇒ lastOk = 2 s ⇒ deadline = 4 s
    expect(renew).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_000) // tick at 3 s hangs
    expect(renew).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(999) // t = 3.999 s
    expect(hb.lost).toBe(false)
    await vi.advanceTimersByTimeAsync(1) // t = 4 s
    expect(hb.lost).toBe(true)
    await hb.stop()
  })

  it('stop() awaits the in-flight tick and a failure arriving after stop never fires lostSignal (no spurious loss before Tx B)', async () => {
    vi.useFakeTimers()
    let reject!: (error: Error) => void
    const renew = vi.fn(() => new Promise<void>((_resolve, rej) => { reject = rej }))
    const hb = startJobLeaseHeartbeat({ renew, ttlMs: 3_000, renewTimeoutMs: 60_000 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(renew).toHaveBeenCalledTimes(1)
    let stopped = false
    const stopping = hb.stop().then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(stopped).toBe(false) // waits for the in-flight tick
    reject(new JobLeaseLostError('renew_job'))
    await stopping
    expect(stopped).toBe(true)
    expect(hb.lost).toBe(false)
    expect(hb.lostSignal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(100_000)
    expect(renew).toHaveBeenCalledTimes(1)
  })

  it('a pre-lost heartbeat is idempotent: stop() after loss resolves and does not throw', async () => {
    vi.useFakeTimers()
    const renew = vi.fn().mockRejectedValue(new Error('db down'))
    const hb = startJobLeaseHeartbeat({ renew, ttlMs: 3_000 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(hb.lost).toBe(true)
    await expect(hb.stop()).resolves.toBeUndefined()
    await expect(hb.stop()).resolves.toBeUndefined()
  })
})

describe('T7: timeoutMs cap vs the 1 h intent-lease clamp', () => {
  it('for every accepted timeoutMs (≤ 55 min) the intent lease covers the timeout plus the full 30 s grace — the clamp is never hit', () => {
    const samples = [0, 1, 1_000, 60_000, RUN_INTEGRATION_JOB_TIMEOUT_DEFAULT_MS, 45 * 60_000, RUN_INTEGRATION_JOB_TIMEOUT_MAX_MS - 1, RUN_INTEGRATION_JOB_TIMEOUT_MAX_MS]
    for (const t of samples) {
      const lease = outboundLeaseForTimeout(t)
      expect(lease, `t=${t}`).toBeGreaterThanOrEqual(t + OUTBOUND_LEASE_GRACE_MS)
      expect(lease, `t=${t}`).toBeLessThan(OUTBOUND_LEASE_MAX_MS)
    }
    expect(RUN_INTEGRATION_JOB_TIMEOUT_MAX_MS + OUTBOUND_LEASE_GRACE_MS).toBeLessThan(OUTBOUND_LEASE_MAX_MS)
    expect(RUN_INTEGRATION_JOB_TIMEOUT_DEFAULT_MS).toBeLessThanOrEqual(RUN_INTEGRATION_JOB_TIMEOUT_MAX_MS)
  })
  it('the ADR’s original 3 h cap would NOT hold the property (the clamp eats the grace past 59.5 min)', () => {
    const threeHours = 3 * 60 * 60_000
    expect(outboundLeaseForTimeout(threeHours)).toBe(OUTBOUND_LEASE_MAX_MS)
    expect(outboundLeaseForTimeout(threeHours)).toBeLessThan(threeHours + OUTBOUND_LEASE_GRACE_MS)
  })
})

describe('anyAbortSignal', () => {
  it('aborts with the first reason and ignores later ones', () => {
    const a = new AbortController()
    const b = new AbortController()
    const any = anyAbortSignal([a.signal, b.signal])
    expect(any.aborted).toBe(false)
    b.abort(new Error('b first'))
    a.abort(new Error('a later'))
    expect(any.aborted).toBe(true)
    expect((any.reason as Error).message).toBe('b first')
  })
  it('short-circuits on an already-aborted input', () => {
    const a = new AbortController()
    a.abort(new Error('pre'))
    const any = anyAbortSignal([new AbortController().signal, a.signal])
    expect(any.aborted).toBe(true)
    expect((any.reason as Error).message).toBe('pre')
  })
})
