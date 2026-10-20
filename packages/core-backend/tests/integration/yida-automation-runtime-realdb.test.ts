// Actual owned PG/core/native sender/shared dispatcher loop; only fetch returns
// synthetic Responses. No JWT, actual plugin install, production host.stop or
// global manifest/default registration is represented by this private runtime.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createYidaAutomationExecutionFixture } from '../utils/yida-automation-execution-fixture'
import { ConsumerAdapterRegistry, runDispatchTick } from '../../src/multitable/automation-durable-dispatch-loop'
import type { ClaimedConsumer } from '../../src/multitable/automation-durable-dispatcher'

type Fixture = Awaited<ReturnType<typeof createYidaAutomationExecutionFixture>>
type Runtime = ReturnType<Fixture['runtime']>
it('sentinel: private delegated runtime needs the explicitly owned disposable PG', () => {
  expect(process.env.EXPECT_DB).toBe('1'); expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})

describe('SA06D private per-installation runtime with actual shared dispatcher and scoped authority', () => {
  let f: Fixture, runtime: Runtime | undefined, claim: ClaimedConsumer
  let tokenCount: number, formCount: number, expectedStopFailure: boolean
  let tokenHook: (() => void | Promise<void>) | undefined
  const options = () => ({ signal: new AbortController().signal })
  const fetchSynthetic: typeof fetch = async (url, init) => {
    expect(typeof url).toBe('string'); expect(init?.signal).toBeInstanceOf(AbortSignal)
    if (url === 'https://api.dingtalk.com/v1.0/oauth2/accessToken') {
      tokenCount += 1; await tokenHook?.()
      return new Response(JSON.stringify({ accessToken: 'synthetic-runtime-access', expireIn: 3600 }))
    }
    expect(url).toBe('https://api.dingtalk.com/v1.0/yida/forms/instances')
    formCount += 1
    const body = JSON.parse(String(init?.body))
    expect(JSON.parse(body.formDataJson)).toEqual({ project: 'DEMO-P1', line: 'L1' })
    return new Response(JSON.stringify({ result: 'synthetic-runtime-instance' }), { status: 201 })
  }
  beforeEach(async () => {
    if (!process.env.DATABASE_URL) throw new Error('SA06D_OWNED_DB_REQUIRED')
    f = await createYidaAutomationExecutionFixture(process.env.DATABASE_URL)
    claim = (await f.ready()).claim
    runtime = undefined; tokenCount = 0; formCount = 0; tokenHook = undefined; expectedStopFailure = false
  }, 15000)
  afterEach(async () => {
    try {
      if (runtime) {
        if (expectedStopFailure) await expect(runtime.stop()).rejects.toThrow('YIDA_AUTOMATION_RUNTIME_STOP_FAILED')
        else await runtime.stop()
      }
    } finally { await f?.cleanup() }
  })
  it('the actual shared runDispatchTick completes only after real delegated ledger ACK', async () => {
    runtime = f.runtime(fetchSynthetic)
    // The fixture already acquired a real initial claim. Make it due again
    // before any execution, so the actual loop must acquire its OWN new fence.
    await f.pool.query("UPDATE meta_automation_outbox_consumer SET status='pending',lease_expires_at=NULL")
    const registry = new ConsumerAdapterRegistry(); registry.register(runtime.adapter)
    await runDispatchTick(f.pool, registry)
    expect((await f.pool.query('SELECT status FROM meta_automation_outbox_consumer')).rows[0].status).toBe('done')
    expect((await f.pool.query('SELECT status FROM integration_yida_delivery_ledger')).rows[0].status).toBe('acknowledged')
    expect([tokenCount, formCount]).toEqual([1, 1]); expect((await f.counts()).used).toBe(1)
    expect(runtime.status().activeRunCount).toBe(0)
  })
  it('ACK replay observes actual scoped history without constructing another attempt or token flight', async () => {
    let constructed = 0
    runtime = f.runtime(fetchSynthetic, { createAttempt: input => {
      constructed += 1; return f.runner.createInternalYidaAutomationSendAttempt({ db: f.db, ...input })
    } })
    expect(await runtime.adapter.handle(claim, options())).toEqual({ outcome: 'success' })
    expect(await runtime.adapter.handle(claim, options())).toEqual({ outcome: 'success' })
    expect(constructed).toBe(1); expect([tokenCount, formCount]).toEqual([1, 1])
    expect(await f.counts()).toEqual({ ledgers: 1, admissions: 1, snapshots: 1, used: 1 })
  })
  it('OFF and malformed or pre-cancelled contexts do not start authority SQL or material IO', async () => {
    runtime = f.runtime(fetchSynthetic, { readEnablement: undefined })
    f.controls.statementCount = 0
    expect(await runtime.adapter.handle(claim, options())).toEqual({ outcome: 'retryable_failure', reason: 'unknown' })
    expect(await runtime.adapter.handle(claim)).toEqual({ outcome: 'permanent_failure', reason: 'permanent_rejection' })
    const controller = new AbortController(); controller.abort()
    expect(await runtime.adapter.handle(claim, { signal: controller.signal })).toEqual({ outcome: 'retryable_failure', reason: 'unknown' })
    expect(f.controls.statementCount).toBe(0); expect([tokenCount, formCount]).toEqual([0, 0])
    expect((await f.counts()).used).toBe(0); expect(runtime.status().accepting).toBe(false)
  })
  it('a trusted profile with the wrong tenant still fails actual live ACL before any sender exists', async () => {
    runtime = f.runtime(fetchSynthetic, { grantor: { actorId: 'synthetic-owner', tenantId: 'other-synthetic-tenant', workspaceId: null } })
    expect(await runtime.adapter.handle(claim, options())).toEqual({ outcome: 'retryable_failure', reason: 'unknown' })
    expect([tokenCount, formCount]).toEqual([0, 0]); expect((await f.counts()).used).toBe(0)
  })
  it('stop stays pending until an original token flight that ignores cancellation actually settles', async () => {
    runtime = f.runtime(fetchSynthetic)
    let enter: () => void = () => {}, release: () => void = () => {}, handled = false, stopped = false
    const reached = new Promise<void>(resolve => { enter = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    tokenHook = async () => { enter(); await wait }
    const pending = runtime.adapter.handle(claim, options()).finally(() => { handled = true })
    let drain: Promise<void> | undefined
    try {
      await Promise.race([reached, pending.then(() => { throw new Error('SA06D_TOKEN_NOT_REACHED') })])
      drain = runtime.stop().finally(() => { stopped = true })
      await new Promise(resolve => setImmediate(resolve))
      expect([handled, stopped]).toEqual([false, false])
      expect(runtime.status()).toMatchObject({ accepting: false, activeRunCount: 1, stopPending: true, stopFailed: false })
      expect(await runtime.adapter.handle(claim, options())).toEqual({ outcome: 'retryable_failure', reason: 'unknown' })
    } finally {
      release()
      // Also drain the ORIGINAL promise when the stop assertion is deliberately
      // broken by a mutation; never let the harness orphan the very flight it proves.
      await pending
      if (drain) await drain
    }
    expect(await pending).toEqual({ outcome: 'permanent_failure', reason: 'permanent_rejection' })
    await drain; expect([handled, stopped]).toEqual([true, true])
    expect(runtime.status()).toEqual({ accepting: false, activeRunCount: 0, stopPending: false, stopFailed: false })
    expect([tokenCount, formCount]).toEqual([1, 0])
  })
  it('the total deadline includes pre-admission SQL without abandoning its actual pending response', async () => {
    runtime = f.runtime(fetchSynthetic, { timeoutMs: 50 }) // TIGHTER test budget, not a raised production budget.
    let enter: () => void = () => {}, release: () => void = () => {}, settled = false
    const reached = new Promise<void>(resolve => { enter = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    f.controls.statementCount = 0
    f.controls.afterStatement = async count => { if (count === 1) { enter(); await wait } }
    const pending = runtime.adapter.handle(claim, options()).finally(() => { settled = true })
    try {
      await reached; await new Promise(resolve => setTimeout(resolve, 80))
      expect(settled).toBe(false); expect(f.controls.statementCount).toBe(1)
    } finally { release(); f.controls.afterStatement = undefined }
    expect(await pending).toEqual({ outcome: 'retryable_failure', reason: 'unknown' })
    expect(f.controls.statementCount).toBe(1)
    expect(await f.counts()).toEqual({ ledgers: 0, admissions: 0, snapshots: 0, used: 0 })
    expect([tokenCount, formCount]).toEqual([0, 0])
  })
  it('unknown admission COMMIT cannot recover a sender on transport replay', async () => {
    runtime = f.runtime(fetchSynthetic); f.controls.loseCommitResponse = true
    expect(await runtime.adapter.handle(claim, options())).toEqual({ outcome: 'retryable_failure', reason: 'unknown' })
    expect(await runtime.adapter.handle(claim, options())).toEqual({ outcome: 'permanent_failure', reason: 'permanent_rejection' })
    expect(await f.counts()).toEqual({ ledgers: 1, admissions: 1, snapshots: 1, used: 1 })
    expect([tokenCount, formCount]).toEqual([0, 0])
  })
  it('a real pre-COMMIT rollback can retry metadata and still construct exactly one actual sender', async () => {
    let constructed = 0
    runtime = f.runtime(fetchSynthetic, { createAttempt: input => {
      constructed += 1; return f.runner.createInternalYidaAutomationSendAttempt({ db: f.db, ...input })
    } })
    f.controls.beforeCommitFailure = true
    expect(await runtime.adapter.handle(claim, options())).toEqual({ outcome: 'retryable_failure', reason: 'unknown' })
    expect(await f.counts()).toEqual({ ledgers: 0, admissions: 0, snapshots: 0, used: 0 })
    expect([constructed, tokenCount, formCount]).toEqual([0, 0, 0])
    expect(await runtime.adapter.handle(claim, options())).toEqual({ outcome: 'success' })
    expect([constructed, tokenCount, formCount]).toEqual([1, 1, 1])
    expect(await f.counts()).toEqual({ ledgers: 1, admissions: 1, snapshots: 1, used: 1 })
  })
  it('an independent close/drain failure is retained by stop rather than hidden as ordinary business failure', async () => {
    let lastWall = -Infinity, wallRegressed = false, maxBackwardMs = 0
    runtime = f.runtime(fetchSynthetic, { createAttempt: input => {
      const actual = input.authority
      const authority = { ...actual, takeExecution(permit: unknown) {
        const handle = actual.takeExecution(permit)
        return Object.freeze({ ...handle, close() { handle.close(); throw new Error('synthetic-private-close-fault') } })
      } }
      return f.runner.createInternalYidaAutomationSendAttempt({ db: f.db, ...input, authority, wallClock: () => {
        // Forward the ACTUAL clock; do not stabilize, clamp or replace it.
        const now = Date.now()
        if (now < lastWall) { wallRegressed = true; maxBackwardMs = Math.max(maxBackwardMs, lastWall - now) }
        lastWall = Math.max(lastWall, now); return now
      } })
    } })
    expect(await runtime.adapter.handle(claim, options())).toEqual({ outcome: 'permanent_failure', reason: 'permanent_rejection' })
    expectedStopFailure = true
    await expect(runtime.stop()).rejects.toThrow('YIDA_AUTOMATION_RUNTIME_STOP_FAILED')
    expect(runtime.status()).toMatchObject({ activeRunCount: 0, stopFailed: true, stopPending: false })
    const status = (await f.pool.query('SELECT status FROM integration_yida_delivery_ledger')).rows[0].status
    if (status !== 'acknowledged') process.stderr.write('SA06D_RUNTIME_CLOCK ' + JSON.stringify({
      wallRegressed, maxBackwardMs, tokenCount, formCount, ackObserved: false }) + '\n')
    expect(status).toBe('acknowledged')
  })
  it('a concurrent redelivery never joins or duplicates the original active request', async () => {
    runtime = f.runtime(fetchSynthetic)
    let enter: () => void = () => {}, release: () => void = () => {}
    const reached = new Promise<void>(resolve => { enter = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    tokenHook = async () => { enter(); await wait }
    const pending = runtime.adapter.handle(claim, options())
    try {
      await Promise.race([reached, pending.then(() => { throw new Error('SA06D_TOKEN_NOT_REACHED') })])
      expect(await runtime.adapter.handle(claim, options())).toEqual({ outcome: 'retryable_failure', reason: 'unknown' })
      expect([tokenCount, formCount]).toEqual([1, 0])
    } finally { release(); await pending }
    expect(await pending).toEqual({ outcome: 'success' })
    expect([tokenCount, formCount]).toEqual([1, 1]); expect((await f.counts()).used).toBe(1)
  })
})
