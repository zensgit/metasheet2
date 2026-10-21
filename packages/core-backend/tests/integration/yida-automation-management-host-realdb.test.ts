import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createYidaAutomationInstalledFixture, installedActor } from '../utils/yida-automation-installed-fixture'
import { createYidaAutomationManagementHost } from '../../src/integration/yida-automation-management-host'
import { checkedYidaAutomationAuthorization } from '../../src/integration/yida-automation-authorization-contracts'
import { ConsumerAdapterRegistry, runDispatchTick } from '../../src/multitable/automation-durable-dispatch-loop'
import { claimDueConsumers } from '../../src/multitable/automation-durable-dispatcher'
import { buildConsumerAdapterRegistry, type DurableConsumerHandlers } from '../../src/multitable/automation-durable-activation'
import { CURRENT_ROUTING_MANIFEST, assertManifestCompleteness } from '../../src/multitable/automation-routing-manifest'
import { YIDA_AUTOMATION_CONSUMER, YIDA_AUTOMATION_ROUTING_CANDIDATE } from '../../src/integration/yida-automation-outbox'
import { captureInternalYidaAutomationClaim } from '../../src/integration/yida-automation-dispatch-claim'

type Fixture = Awaited<ReturnType<typeof createYidaAutomationInstalledFixture>>
type Host = ReturnType<typeof createYidaAutomationManagementHost>
const twoRowCases = {
  acknowledged: 'positive control: two genuinely approved rows can each ACK within the same installed finite grant',
  unknown: 'unknown blocks an actually unused approved row while one execution remains, without revocation or exhausted-row masking',
} as const
it('sentinel: management host uses the explicitly owned disposable PostgreSQL', () => {
  expect(process.env.EXPECT_DB).toBe('1'); expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})

describe('SA06D host -> actual installed read runtime -> native material and owned transaction', () => {
  let f: Fixture, host: Host, registry: ConsumerAdapterRegistry, ready: boolean, tokenCount: number, formCount: number
  let tokenHook: ((signal: AbortSignal) => Promise<void>) | undefined
  let formHook: ((signal: AbortSignal) => Promise<void>) | undefined, invalidFormReceipt: boolean
  const options = () => ({ signal: new AbortController().signal })
  async function revokeProbe<T>(stage: 'TOKEN' | 'COMMIT' | 'REVOKED' | 'INSPECT', promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    process.stderr.write('SA06D_REVOKE_PROGRESS ' + JSON.stringify({ stage, state: 'STARTED' }) + '\n')
    try {
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('SA06D_REVOKE_PROBE_' + stage)), 5000)
      })])
    } finally {
      clearTimeout(timer)
      process.stderr.write('SA06D_REVOKE_PROGRESS ' + JSON.stringify({ stage, state: 'SETTLED' }) + '\n')
    }
  }
  const consent = () => {
    const { maxTotalRows: _derived, ...raw } = checkedYidaAutomationAuthorization(f.consent())
    return raw
  }
  function makeHost(timeoutMs = 10000) {
    const local = new ConsumerAdapterRegistry()
    const result = createYidaAutomationManagementHost({ database: { transaction: f.transaction }, readRuntime: f.readRuntime,
      monotonicNow: () => f.controls.mono, timeoutMs, security: f.security, fetch: async (url, init) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        if (url === 'https://api.dingtalk.com/v1.0/oauth2/accessToken') {
          tokenCount += 1; await tokenHook?.(init!.signal as AbortSignal)
          return new Response(JSON.stringify({ accessToken: 'synthetic-host-access', expireIn: 3600 }))
        }
        expect(url).toBe('https://api.dingtalk.com/v1.0/yida/forms/instances')
        formCount += 1
        const body = JSON.parse(String(init?.body))
        expect(JSON.parse(body.formDataJson)).toEqual({ project: 'DEMO-P1',
          line: consent().rowKeys.length === 2 && formCount === 2 ? 'L2' : 'L1' })
        await formHook?.(init!.signal as AbortSignal)
        return new Response(JSON.stringify({ result: invalidFormReceipt ? null : 'synthetic-host-instance' }), { status: 201 })
      },
      readEnablement: () => f.controls.enabled,
      deliveryReady: () => ready && local.get(result.adapter.key) === result.adapter })
    local.register(result.adapter)
    return result
  }
  async function enqueue() {
    await activate()
    const grant = await host.port.create(installedActor, consent(), options()) as { grantId: string }
    await host.port.requestManual(installedActor, grant.grantId, { requestKey: 'synthetic-dispatch-request' }, options())
    return grant
  }
  async function claim() {
    const claims = await claimDueConsumers(f.pool, { consumerKeys: [YIDA_AUTOMATION_CONSUMER], leaseMs: 60000 })
    expect(claims).toHaveLength(1); return claims[0]
  }
  async function activate() { return host.createPluginCapability().activate(f.automationBinding()) }
  async function intervalOccurrence() {
    const result = await f.pool.query(`UPDATE automation_rules SET created_at=date_trunc('second',clock_timestamp())-interval '60 seconds'
      WHERE id='synthetic-rule' RETURNING floor(extract(epoch FROM created_at)*1000)::text AS anchor_ms`)
    const anchorMs = Number(result.rows[0].anchor_ms)
    return Object.freeze({ ruleId: 'synthetic-rule', triggerType: 'schedule.interval' as const,
      anchorMs, scheduledAtMs: anchorMs + 60000, intervalMs: 60000 })
  }
  beforeEach(async ({ task }) => {
    f = undefined!; host = undefined!
    // Each case still owns a fresh schema, migrations, crypto and installation.
    // Select its initial rows before creating any grant; do not first create
    // and discard an unused one-row fixture in these two-row scenarios.
    const approvedSecondRow = Object.values(twoRowCases).some(title => title === task.name)
    f = await createYidaAutomationInstalledFixture(process.env.DATABASE_URL!, { approvedSecondRow })
    ready = true; tokenCount = 0; formCount = 0; tokenHook = undefined; formHook = undefined
    invalidFormReceipt = false; f.controls.enabled = 'false'
    host = makeHost()
    const unexpected = async (): Promise<never> => { throw new Error('SA06D_UNEXPECTED_LEGACY_ADAPTER') }
    const legacy: DurableConsumerHandlers = {
      'approval-bridge': unexpected, 'approval-trigger': unexpected, 'approval-projection': unexpected,
      'approval-task-trigger': unexpected, 'automation-record-trigger': unexpected, 'webhook-event-bridge': unexpected,
      'multitable-record-approval': unexpected, 'dingtalk-todo-mirror': unexpected,
    }
    registry = buildConsumerAdapterRegistry(legacy, { key: 'integration-read-preview', async handle() {
      throw new Error('SA06D_UNEXPECTED_READ_ADAPTER')
    } }, host.adapter)
    assertManifestCompleteness(registry, YIDA_AUTOMATION_ROUTING_CANDIDATE)
  }, 15000)
  afterEach(async () => {
    try { await host?.stop(); expect(f?.sourceCalls ?? 0).toBe(0) } finally { await f?.cleanup() }
  }, 15000)
  it('refuses create/request before the actual plugin capability has activated', async () => {
    await expect(host.port.create(installedActor, consent(), options())).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
    expect((await f.pool.query('SELECT count(*)::int AS n FROM integration_yida_auto_grants')).rows[0].n).toBe(0)
  })
  it('commits one installed grant and one native outbox request, then observes/revokes without a sender', async () => {
    await activate()
    const grant = await host.port.create(installedActor, consent(), options()) as { grantId: string }
    const accepted = await host.port.requestManual(installedActor, grant.grantId, { requestKey: 'synthetic-host-request' }, options())
    expect(accepted).toMatchObject({ reused: false, deliveryQueued: true, canSend: false, externalWriteAttempted: false })
    const replay = await host.port.requestManual(installedActor, grant.grantId, { requestKey: 'synthetic-host-request' }, options())
    expect(replay).toMatchObject({ reused: true, deliveryQueued: true })
    expect(await host.port.inspect(installedActor, grant.grantId, options())).toMatchObject({
      grantId: grant.grantId, usedExecutions: 0, requests: [{ status: 'queued', rowOrdinal: 0 }], serialBlocked: false })
    expect(await host.port.revoke(installedActor, grant.grantId, options())).toMatchObject({ revoked: true, canSend: false })
    expect((await f.pool.query('SELECT count(*)::int AS n FROM meta_automation_outbox')).rows[0].n).toBe(1)
    expect(await f.counts()).toEqual({ ledgers: 0, admissions: 0, snapshots: 0, used: 0 })
  })
  it('inspection/revocation retain live owner/admin checks after plugin and read source are disabled', async () => {
    const plugin = await activate()
    const grant = await host.port.create(installedActor, consent(), options()) as { grantId: string }
    await plugin.stop(); f.setInstalledEnabled(false)
    expect(await host.port.inspect(installedActor, grant.grantId, options())).toMatchObject({ status: 'stale' })
    expect(await host.port.revoke(installedActor, grant.grantId, options())).toMatchObject({ revoked: true })
    await expect(host.port.requestManual(installedActor, grant.grantId, { requestKey: 'synthetic-disabled' }, options()))
      .rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
    await expect(host.port.inspect({ ...installedActor, tenantId: 'synthetic-foreign-tenant' }, grant.grantId, options()))
      .rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
    await f.pool.query("DELETE FROM user_roles WHERE user_id='synthetic-owner'")
    await expect(host.port.inspect(installedActor, grant.grantId, options())).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
  })
  it('requires the real read installation, never substitutes a request or cached binding', async () => {
    await activate(); f.setInstalledEnabled(false)
    await expect(host.port.create(installedActor, consent(), options())).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
    expect((await f.pool.query('SELECT count(*)::int AS n FROM integration_yida_auto_grants')).rows[0].n).toBe(0)
  })
  it('re-resolves current installation for a request and rejects an old grant after metadata ABA', async () => {
    await activate()
    const grant = await host.port.create(installedActor, consent(), options()) as { grantId: string }
    await f.metadataAba()
    await expect(host.port.requestManual(installedActor, grant.grantId, { requestKey: 'synthetic-host-aba' }, options()))
      .rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
    expect((await f.pool.query('SELECT count(*)::int AS n FROM integration_yida_auto_requests')).rows[0].n).toBe(0)
  })
  it('a new plugin activation cannot resume an old grant even without a read profile change', async () => {
    await activate()
    const grant = await host.port.create(installedActor, consent(), options()) as { grantId: string }
    await activate()
    await expect(host.port.requestManual(installedActor, grant.grantId, { requestKey: 'synthetic-reactivate' }, options()))
      .rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
    expect(await host.port.inspect(installedActor, grant.grantId, options())).toMatchObject({ status: 'stale' })
  })
  it('a stale single-use plugin capability cannot replace the current registration', async () => {
    const stale = host.createPluginCapability()
    await activate()
    await expect(stale.activate(f.automationBinding())).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_CLOSED')
    expect(await host.port.create(installedActor, consent(), options())).toMatchObject({ reused: false })
  })
  it('cancellation while an original SQL response is held waits for it and rolls back', async () => {
    await activate()
    const controller = new AbortController()
    let entered: () => void = () => {}, release: () => void = () => {}, settled = false
    const reached = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const first = f.controls.statementCount + 1
    f.controls.afterStatement = async count => { if (count === first) { entered(); await gate } }
    const pending = host.port.create(installedActor, consent(), { signal: controller.signal }).finally(() => { settled = true })
    void pending.catch(() => {})
    try {
      await reached; controller.abort()
      await new Promise(resolve => setTimeout(resolve, 20)); expect(settled).toBe(false)
    } finally { release(); await pending.catch(() => {}) }
    await expect(pending).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
    expect((await f.pool.query('SELECT count(*)::int AS n FROM integration_yida_auto_grants')).rows[0].n).toBe(0)
  })
  it('host stop and read stop both await the original COMMIT; committed history is not reminted', async () => {
    await activate()
    let entered: () => void = () => {}, release: () => void = () => {}, hostStopped = false, readStopped = false
    const reached = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    f.controls.beforeCommitGate = { reached: entered, wait: gate }
    const pending = host.port.create(installedActor, consent(), options())
    void pending.catch(() => {})
    let stop: Promise<void> | undefined, readStop: Promise<void> | undefined
    try {
      await Promise.race([reached, pending.then(() => { throw new Error('SA06D_HOST_COMMIT_GATE_MISSED') })])
      stop = host.stop().finally(() => { hostStopped = true })
      const beforeRetirement = f.runtimeTransactionsStarted
      readStop = f.readRuntime.stop().finally(() => { readStopped = true })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(hostStopped).toBe(false); expect(readStopped).toBe(false)
      // A producer UPDATE could itself block on our transaction locks. Checking
      // only stopPending would let that unrelated DB wait hide a missing drain.
      expect(f.runtimeTransactionsStarted).toBe(beforeRetirement)
    } finally { release(); await pending.catch(() => {}); await stop; await readStop }
    await expect(pending).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
    const rows = (await f.pool.query('SELECT id FROM integration_yida_auto_grants')).rows
    expect(rows).toHaveLength(1)
    const observer = makeHost()
    try {
      expect(await observer.port.inspect(installedActor, rows[0].id as string, options())).toMatchObject({ status: 'stale', usedExecutions: 0 })
      expect(await observer.port.revoke(installedActor, rows[0].id as string, options())).toMatchObject({ revoked: true })
    } finally { await observer.stop() }
    expect((await f.pool.query('SELECT count(*)::int AS n FROM integration_yida_auto_grants')).rows[0].n).toBe(1)
  })
  it('a real transaction failure rolls back the entire native grant and never returns acceptance', async () => {
    await activate(); f.controls.beforeCommitFailure = true
    await expect(host.port.create(installedActor, consent(), options())).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
    expect((await f.pool.query('SELECT count(*)::int AS n FROM integration_yida_auto_grants')).rows[0].n).toBe(0)
  })
  it('an unavailable shared consumer refuses request enqueue even when installation and owner consent are valid', async () => {
    await activate()
    const grant = await host.port.create(installedActor, consent(), options()) as { grantId: string }
    ready = false
    await expect(host.port.requestManual(installedActor, grant.grantId, { requestKey: 'synthetic-not-ready' }, options()))
      .rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
    expect((await f.pool.query('SELECT count(*)::int AS n FROM meta_automation_outbox')).rows[0].n).toBe(0)
    expect((await f.pool.query('SELECT count(*)::int AS n FROM integration_yida_auto_requests')).rows[0].n).toBe(0)
    expect([tokenCount, formCount]).toEqual([0, 0])
  })
  it('the actual boot registry and shared dispatch tick consume native installed authority and close the same request', async () => {
    const grant = await enqueue(); f.controls.enabled = 'true'
    expect(CURRENT_ROUTING_MANIFEST.version).toBe(4)
    await runDispatchTick(f.pool, registry, { batchSize: 1, leaseMs: 60000 })
    expect((await f.pool.query('SELECT status FROM meta_automation_outbox_consumer')).rows[0].status).toBe('done')
    expect((await f.pool.query('SELECT status FROM integration_yida_delivery_ledger')).rows[0].status).toBe('acknowledged')
    expect(await host.port.inspect(installedActor, grant.grantId, options())).toMatchObject({ usedExecutions: 1,
      activeRequestId: null, serialBlocked: false, requests: [{ status: 'closed_observed', ledgerStatus: 'acknowledged' }] })
    expect([tokenCount, formCount]).toEqual([1, 1])
  })
  it('OFF and malformed claim identity are refused before any host authority SQL or token/form call', async () => {
    await enqueue(); const delivery = await claim()
    const before = f.controls.statementCount
    expect(await host.adapter.handle(delivery, options())).toMatchObject({ outcome: 'retryable_failure' })
    expect(f.controls.statementCount).toBe(before)
    f.controls.enabled = 'true'
    expect(await host.adapter.handle({ ...delivery, payload: { ...captureInternalYidaAutomationClaim(delivery).payload, ownerId: 'invented' } }, options()))
      .toMatchObject({ outcome: 'permanent_failure' })
    expect(f.controls.statementCount).toBe(before); expect([tokenCount, formCount]).toEqual([0, 0])
  })
  it('a metadata ABA after enqueue fails native worker authorization without consuming a budget or loading a sender', async () => {
    await enqueue(); f.controls.enabled = 'true'; await f.metadataAba()
    expect(await host.adapter.handle(await claim(), options())).toMatchObject({ outcome: 'retryable_failure' })
    expect(await f.counts()).toEqual({ ledgers: 0, admissions: 0, snapshots: 0, used: 0 })
    expect([tokenCount, formCount]).toEqual([0, 0])
  })
  it('live revocation after enqueue blocks the real worker before token exchange', async () => {
    const grant = await enqueue(); f.controls.enabled = 'true'
    await host.port.revoke(installedActor, grant.grantId, options())
    expect(await host.adapter.handle(await claim(), options())).toMatchObject({ outcome: 'retryable_failure' })
    expect(await f.counts()).toEqual({ ledgers: 0, admissions: 0, snapshots: 0, used: 0 })
    expect([tokenCount, formCount]).toEqual([0, 0])
  })
  it('concurrent redelivery of the same real claim cannot create a second native attempt', async () => {
    await enqueue(); f.controls.enabled = 'true'; const delivery = await claim()
    let entered: () => void = () => {}, release: () => void = () => {}
    const reached = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    tokenHook = async () => { entered(); await gate }
    const pending = host.adapter.handle(delivery, options())
    try {
      await Promise.race([reached, pending.then(() => { throw new Error('SA06D_HOST_TOKEN_NOT_REACHED') })])
      expect(await host.adapter.handle(delivery, options())).toMatchObject({ outcome: 'retryable_failure' })
      expect(tokenCount).toBe(1)
    } finally { release() }
    expect(await pending).toEqual({ outcome: 'success' })
    expect([tokenCount, formCount]).toEqual([1, 1]); expect((await f.counts()).used).toBe(1)
  })
  it('actual host stop waits for the original token flight and prevents publishing it to a form request', async () => {
    await enqueue(); f.controls.enabled = 'true'; const delivery = await claim()
    let entered: () => void = () => {}, release: () => void = () => {}, stopped = false
    const reached = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    tokenHook = async () => { entered(); await gate }
    const pending = host.adapter.handle(delivery, options())
    let stop: Promise<void> | undefined
    try {
      await Promise.race([reached, pending.then(() => { throw new Error('SA06D_HOST_TOKEN_NOT_REACHED') })])
      stop = host.stop().finally(() => { stopped = true })
      await new Promise(resolve => setTimeout(resolve, 20)); expect(stopped).toBe(false)
    } finally { release(); await pending; await stop }
    expect(stopped).toBe(true); expect([tokenCount, formCount]).toEqual([1, 0])
    expect((await f.counts()).used).toBe(1) // No refund/no second CREATE.
  })
  it('the total execution budget includes owner/profile SQL and does not abandon its original response', async () => {
    await host.stop(); host = makeHost(50)
    await enqueue(); f.controls.enabled = 'true'; const delivery = await claim()
    let entered: () => void = () => {}, release: () => void = () => {}, settled = false
    const reached = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const first = f.controls.statementCount + 1
    f.controls.afterStatement = async count => { if (count === first) { entered(); await gate } }
    const pending = host.adapter.handle(delivery, options()).finally(() => { settled = true })
    try {
      await Promise.race([reached, pending.then(() => { throw new Error('SA06D_HOST_HINT_NOT_REACHED') })])
      await new Promise(resolve => setTimeout(resolve, 75))
      expect(settled).toBe(false) // Budget expiry cancels, but never abandons SQL.
    } finally { release() }
    expect(await pending).toMatchObject({ outcome: 'retryable_failure' })
    expect([tokenCount, formCount]).toEqual([0, 0])
    expect(await f.counts()).toEqual({ ledgers: 0, admissions: 0, snapshots: 0, used: 0 })
  })
  it(twoRowCases.acknowledged, async () => {
    expect(consent().rowKeys).toHaveLength(2); expect(consent().maxExecutions).toBe(2)
    const grant = await enqueue(); f.controls.enabled = 'true'
    expect(await host.adapter.handle(await claim(), options())).toMatchObject({ outcome: 'success' })
    expect(await host.port.inspect(installedActor, grant.grantId, options())).toMatchObject({
      usedExecutions: 1, maxExecutions: 2, serialBlocked: false })
    expect(await host.port.requestManual(installedActor, grant.grantId, { requestKey: 'synthetic-second-row' }, options()))
      .toMatchObject({ rowOrdinal: 1, deliveryQueued: true, reused: false })
    expect(await host.adapter.handle(await claim(), options())).toMatchObject({ outcome: 'success' })
    expect(await host.port.inspect(installedActor, grant.grantId, options())).toMatchObject({
      usedExecutions: 2, maxExecutions: 2, serialBlocked: false,
      requests: [{ status: 'closed_observed', ledgerStatus: 'acknowledged' }, { status: 'closed_observed', ledgerStatus: 'acknowledged' }] })
    expect(await f.counts()).toEqual({ ledgers: 2, admissions: 2, snapshots: 2, used: 2 })
    expect([tokenCount, formCount]).toEqual([2, 2])
  })
  it(twoRowCases.unknown, async () => {
    expect(consent().rowKeys).toHaveLength(2); expect(consent().maxExecutions).toBe(2)
    const grant = await enqueue(); f.controls.enabled = 'true'; invalidFormReceipt = true
    expect(await host.adapter.handle(await claim(), options())).toEqual({ outcome: 'permanent_failure', reason: 'permanent_rejection' })
    const firstLedger = (await f.pool.query('SELECT * FROM integration_yida_delivery_ledger')).rows
    expect(firstLedger).toHaveLength(1); expect(firstLedger[0].status).toBe('outcome_unknown')
    expect(await host.port.inspect(installedActor, grant.grantId, options())).toMatchObject({
      usedExecutions: 1, maxExecutions: 2, revoked: false, serialBlocked: true })
    // Prove the second row is successfully reserved and reaches the real host
    // adapter/claim. A denial at request creation is not admission evidence.
    expect(await host.port.requestManual(installedActor, grant.grantId, { requestKey: 'synthetic-unused-row' }, options()))
      .toMatchObject({ rowOrdinal: 1, deliveryQueued: true, reused: false })
    const outcome = await host.adapter.handle(await claim(), options())
    process.stderr.write('SA06D_REMAINING_UNKNOWN_CHECK ' + JSON.stringify({ outcome: outcome.outcome,
      approvedRows: consent().rowKeys.length, maximumExecutions: consent().maxExecutions,
      tokenCalls: tokenCount, formCalls: formCount, ...await f.counts() }) + '\n')
    expect(outcome).toEqual({ outcome: 'retryable_failure', reason: 'unknown' })
    expect(await host.port.inspect(installedActor, grant.grantId, options())).toMatchObject({
      usedExecutions: 1, maxExecutions: 2, revoked: false, serialBlocked: true,
      requests: [{ rowOrdinal: 0, status: 'admitted', ledgerStatus: 'outcome_unknown' },
        { rowOrdinal: 1, status: 'queued', admissionId: null, ledgerStatus: null }] })
    expect((await f.pool.query('SELECT * FROM integration_yida_delivery_ledger')).rows).toEqual(firstLedger)
    expect(await f.counts()).toEqual({ ledgers: 1, admissions: 1, snapshots: 1, used: 1 })
    expect([tokenCount, formCount]).toEqual([1, 1])
  })
  it('a native invalid 2xx is durably unknown and neither replay nor a fresh consent can create another sender', async () => {
    const grant = await enqueue(); f.controls.enabled = 'true'; invalidFormReceipt = true
    const delivery = await claim()
    expect(await host.adapter.handle(delivery, options())).toEqual({ outcome: 'permanent_failure', reason: 'permanent_rejection' })
    expect((await f.pool.query('SELECT status FROM integration_yida_delivery_ledger')).rows).toEqual([{ status: 'outcome_unknown' }])
    expect(await host.port.inspect(installedActor, grant.grantId, options())).toMatchObject({ usedExecutions: 1,
      serialBlocked: true, requests: [{ ledgerStatus: 'outcome_unknown', durable: true, canSend: false }] })
    expect(await host.adapter.handle(delivery, options())).toMatchObject({ outcome: 'permanent_failure' })
    const second = await host.port.create(installedActor, { ...consent(), allowedTriggers: ['manual'], confirmationId: 'synthetic-second-consent' }, options()) as { grantId: string }
    await host.port.requestManual(installedActor, second.grantId, { requestKey: 'synthetic-second-request' }, options())
    const next = await claim()
    expect(await host.adapter.handle(next, options())).toMatchObject({ outcome: 'retryable_failure' })
    expect((await f.pool.query('SELECT status FROM integration_yida_delivery_ledger')).rows).toEqual([{ status: 'outcome_unknown' }])
    expect(await f.counts()).toEqual({ ledgers: 1, admissions: 1, snapshots: 1, used: 1 })
    expect([tokenCount, formCount]).toEqual([1, 1])
  })
  for (const disconnect of [false, true]) it(`committed revoke cancels the native token signal after COMMIT even with waiter disconnect=${disconnect}`, async () => {
    const grant = await enqueue(); f.controls.enabled = 'true'; const delivery = await claim()
    let entered: () => void = () => {}, release: () => void = () => {}, commitEntered: () => void = () => {}, commitRelease: () => void = () => {}
    const reached = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const commitReached = new Promise<void>(resolve => { commitEntered = resolve }), commitGate = new Promise<void>(resolve => { commitRelease = resolve })
    let nativeSignal: AbortSignal | undefined, settled = false, stopped = false, stop: Promise<void> | undefined
    let revocation: Promise<unknown> | undefined
    tokenHook = async signal => { nativeSignal = signal; entered(); await gate }
    const pending = host.adapter.handle(delivery, options()).finally(() => { settled = true })
    try {
      await revokeProbe('TOKEN', Promise.race([reached, pending.then(() => { throw new Error('SA06D_HOST_TOKEN_NOT_REACHED') })]))
      expect(nativeSignal!.aborted).toBe(false)
      f.controls.beforeCommitGate = { reached: commitEntered, wait: commitGate }
      const waiter = new AbortController()
      revocation = host.port.revoke(installedActor, grant.grantId, { signal: waiter.signal })
      void revocation.catch(() => {})
      await revokeProbe('COMMIT', Promise.race([commitReached, revocation.then(() => { throw new Error('SA06D_REVOKE_COMMIT_GATE_MISSED') })]))
      // A transaction that has not committed must not cancel admitted work.
      expect(nativeSignal!.aborted).toBe(false)
      if (disconnect) waiter.abort()
      commitRelease()
      if (disconnect) await expect(revokeProbe('REVOKED', revocation)).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
      else expect(await revokeProbe('REVOKED', revocation)).toMatchObject({ revoked: true, usedExecutions: 1 })
      expect(await revokeProbe('INSPECT', host.port.inspect(installedActor, grant.grantId, options()))).toMatchObject({ revoked: true, usedExecutions: 1 })
      expect(nativeSignal!.aborted).toBe(true)
      expect([tokenCount, formCount]).toEqual([1, 0])
      // The synthetic vendor deliberately ignores abort: notification must not
      // detach the original request or make stop pretend it has already drained.
      stop = host.stop().finally(() => { stopped = true })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(stopped).toBe(false); expect(settled).toBe(false)
    } finally { commitRelease(); release(); await revocation?.catch(() => {}); await pending; await stop }
    expect(stopped).toBe(true); expect(await pending).not.toEqual({ outcome: 'success' })
    expect([tokenCount, formCount]).toEqual([1, 0])
    expect(await f.counts()).toEqual({ ledgers: 1, admissions: 1, snapshots: 1, used: 1 })
    expect((await f.pool.query('SELECT status FROM integration_yida_delivery_ledger')).rows[0].status).not.toBe('acknowledged')
  })
  it('another grant, denied scope and rolled-back revoke never cancel the original native token request', async () => {
    const grant = await enqueue()
    const other = await host.port.create(installedActor, { ...consent(), allowedTriggers: ['manual'],
      confirmationId: 'synthetic-revoke-other' }, options()) as { grantId: string }
    f.controls.enabled = 'true'; const delivery = await claim()
    let entered: () => void = () => {}, release: () => void = () => {}, nativeSignal: AbortSignal | undefined
    const reached = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    tokenHook = async signal => { nativeSignal = signal; entered(); await gate }
    const pending = host.adapter.handle(delivery, options())
    try {
      await Promise.race([reached, pending.then(() => { throw new Error('SA06D_HOST_TOKEN_NOT_REACHED') })])
      expect(await host.port.revoke(installedActor, other.grantId, options())).toMatchObject({ revoked: true })
      expect(nativeSignal!.aborted).toBe(false)
      for (const actor of [{ ...installedActor, tenantId: 'synthetic-foreign-tenant' }, { ...installedActor, actorId: 'synthetic-foreign-owner' }]) {
        await expect(host.port.revoke(actor, grant.grantId, options())).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
        expect(nativeSignal!.aborted).toBe(false)
      }
      f.controls.beforeCommitFailure = true
      await expect(host.port.revoke(installedActor, grant.grantId, options())).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
      expect(nativeSignal!.aborted).toBe(false)
      expect(await host.port.inspect(installedActor, grant.grantId, options())).toMatchObject({ revoked: false, usedExecutions: 1 })
    } finally { release(); await pending }
    expect(await pending).toEqual({ outcome: 'success' })
    expect([tokenCount, formCount]).toEqual([1, 1])
    expect((await f.pool.query('SELECT status FROM integration_yida_delivery_ledger')).rows).toEqual([{ status: 'acknowledged' }])
  })
  it('committed revoke cancels the native form signal but preserves unresolved history after a late valid receipt', async () => {
    const grant = await enqueue(); f.controls.enabled = 'true'; const delivery = await claim()
    let entered: () => void = () => {}, release: () => void = () => {}, nativeSignal: AbortSignal | undefined
    const reached = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    formHook = async signal => { nativeSignal = signal; entered(); await gate }
    const pending = host.adapter.handle(delivery, options())
    try {
      await Promise.race([reached, pending.then(() => { throw new Error('SA06D_HOST_FORM_NOT_REACHED') })])
      expect(nativeSignal!.aborted).toBe(false)
      expect(await host.port.revoke(installedActor, grant.grantId, options())).toMatchObject({ revoked: true, usedExecutions: 1 })
      expect(nativeSignal!.aborted).toBe(true)
    } finally { release(); await pending }
    expect(await pending).not.toEqual({ outcome: 'success' })
    expect((await f.pool.query('SELECT status FROM integration_yida_delivery_ledger')).rows).toEqual([{ status: 'dispatching' }])
    expect(await host.port.inspect(installedActor, grant.grantId, options())).toMatchObject({ revoked: true, usedExecutions: 1, serialBlocked: true })
    expect(await host.adapter.handle(delivery, options())).not.toEqual({ outcome: 'success' })
    expect([tokenCount, formCount]).toEqual([1, 1])
    expect(await f.counts()).toEqual({ ledgers: 1, admissions: 1, snapshots: 1, used: 1 })
  })
  it('stopping after form dispatch waits for the real response and never turns a late valid 2xx into ACK or a second CREATE', async () => {
    const grant = await enqueue(); f.controls.enabled = 'true'; const delivery = await claim()
    let entered: () => void = () => {}, release: () => void = () => {}, stopped = false, settled = false
    const reached = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    formHook = async () => { entered(); await gate }
    const pending = host.adapter.handle(delivery, options()).finally(() => { settled = true })
    let stop: Promise<void> | undefined
    try {
      await Promise.race([reached, pending.then(() => { throw new Error('SA06D_HOST_FORM_NOT_REACHED') })])
      stop = host.stop().finally(() => { stopped = true })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(stopped).toBe(false); expect(settled).toBe(false); expect([tokenCount, formCount]).toEqual([1, 1])
    } finally { release(); await pending; await stop }
    expect(await pending).not.toEqual({ outcome: 'success' })
    expect(stopped).toBe(true)
    // The parent lifetime is revoked, so late cleanup cannot bypass its guards
    // merely to improve the ledger's appearance. Preserve durable dispatching:
    // it is unresolved history, NOT an ACK, rollback or permission to retry.
    expect((await f.pool.query('SELECT status FROM integration_yida_delivery_ledger')).rows).toEqual([{ status: 'dispatching' }])
    const old = host
    host = makeHost(); await activate()
    expect(await host.port.inspect(installedActor, grant.grantId, options())).toMatchObject({ status: 'stale',
      usedExecutions: 1, serialBlocked: true, requests: [{ ledgerStatus: 'dispatching', canSend: false, durable: true }] })
    expect(await host.adapter.handle(delivery, options())).toMatchObject({ outcome: 'permanent_failure' })
    expect([tokenCount, formCount]).toEqual([1, 1])
    expect(await f.counts()).toEqual({ ledgers: 1, admissions: 1, snapshots: 1, used: 1 })
    await old.stop()
  })
  it('an explicit interval grant feeds the original shared tick once; same occurrence never reserves or sends twice', async () => {
    const occurrence = await intervalOccurrence()
    await host.produceSchedule(occurrence, options().signal)
    await activate(); await host.produceSchedule(occurrence, options().signal)
    expect((await f.pool.query('SELECT count(*)::int AS n FROM meta_automation_outbox')).rows[0].n).toBe(0)
    const grant = await host.port.create(installedActor, { ...consent(), allowedTriggers: ['schedule.interval'] }, options()) as { grantId: string }
    await host.produceSchedule(occurrence, options().signal); await host.produceSchedule(occurrence, options().signal)
    expect((await f.pool.query('SELECT count(*)::int AS n FROM meta_automation_outbox')).rows[0].n).toBe(1)
    expect([tokenCount, formCount]).toEqual([0, 0])
    f.controls.enabled = 'true'; await runDispatchTick(f.pool, registry, { batchSize: 1, leaseMs: 60000 })
    expect(await host.port.inspect(installedActor, grant.grantId, options())).toMatchObject({ usedExecutions: 1,
      serialBlocked: false, requests: [{ status: 'closed_observed', ledgerStatus: 'acknowledged' }] })
    expect([tokenCount, formCount]).toEqual([1, 1])
  })
  it('manual-only consent cannot be discovered or upgraded by the interval producer', async () => {
    const occurrence = await intervalOccurrence(); await activate()
    await host.port.create(installedActor, { ...consent(), allowedTriggers: ['manual'] }, options())
    await host.produceSchedule(occurrence, options().signal)
    expect((await f.pool.query('SELECT count(*)::int AS n FROM meta_automation_outbox')).rows[0].n).toBe(0)
    expect([tokenCount, formCount]).toEqual([0, 0])
  })
  it('a second interval confirmation must not silently replace the selected grant; explicit revocation permits a new selection', async () => {
    const occurrence = await intervalOccurrence(); await activate()
    const grant = await host.port.create(installedActor, consent(), options()) as { grantId: string }
    const next = { ...consent(), confirmationId: 'synthetic-next-interval' }
    await expect(host.port.create(installedActor, next, options())).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_CONFLICT')
    await host.port.revoke(installedActor, grant.grantId, options())
    await host.port.create(installedActor, next, options()); await host.produceSchedule(occurrence, options().signal)
    expect((await f.pool.query('SELECT count(*)::int AS n FROM meta_automation_outbox')).rows[0].n).toBe(1)
    expect((await f.pool.query('SELECT count(*)::int AS n FROM integration_yida_auto_grants')).rows[0].n).toBe(2)
  })
  it('historical consent replay in a new activation never republishes an automatic slot', async () => {
    const occurrence = await intervalOccurrence(); await activate()
    await host.port.create(installedActor, consent(), options())
    await activate()
    expect(await host.port.create(installedActor, consent(), options())).toMatchObject({ reused: true })
    await host.produceSchedule(occurrence, options().signal)
    expect((await f.pool.query('SELECT count(*)::int AS n FROM meta_automation_outbox')).rows[0].n).toBe(0)
  })
  it('interval hints cannot override the actual DB phase, interval, time, version or principal', async () => {
    const occurrence = await intervalOccurrence(); await activate()
    await host.port.create(installedActor, consent(), options())
    for (const bad of [
      { ...occurrence, anchorMs: occurrence.anchorMs - 60000 },
      { ...occurrence, intervalMs: 30000 },
      { ...occurrence, scheduledAtMs: occurrence.scheduledAtMs + 60000 },
      { ...occurrence, tenantId: 'synthetic-other-tenant' },
    ]) await expect(host.produceSchedule(bad, options().signal)).rejects.toThrow()
    await f.pool.query("UPDATE automation_rules SET integration_authority_revision='99999999-9999-4999-8999-999999999999'")
    await expect(host.produceSchedule(occurrence, options().signal)).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
    expect((await f.pool.query('SELECT count(*)::int AS n FROM meta_automation_outbox')).rows[0].n).toBe(0)
    expect([tokenCount, formCount]).toEqual([0, 0])
  })
})
