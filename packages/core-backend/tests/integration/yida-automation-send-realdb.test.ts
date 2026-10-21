// Actual core grant/outbox/claim/admission/crypto/native material -> shared
// production delivery kernel/token/protocol/real PG ledger. Only fetch is fake;
// this is NOT a JWT, host consumer, real HTTP network or deployment proof.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createYidaAutomationExecutionFixture, executionFixtureScope } from '../utils/yida-automation-execution-fixture'
import type { ClaimedConsumer } from '../../src/multitable/automation-durable-dispatcher'
import { claimDueConsumers } from '../../src/multitable/automation-durable-dispatcher'
import { YIDA_AUTOMATION_CONSUMER } from '../../src/integration/yida-automation-outbox'
import { createYidaAutomationAuthorizationService } from '../../src/integration/yida-automation-authorization-service'
import { assertAutomationIntegrationActor } from '../../src/integration/automation-live-authority'

type Fixture = Awaited<ReturnType<typeof createYidaAutomationExecutionFixture>>
type Authority = ReturnType<Fixture['execution']>
type Attempt = { run(options?: { signal?: AbortSignal }): Promise<{ status: string; durable: boolean;
  externalWriteAttempted: boolean; businessVerified: false; record: Record<string, unknown> | null }> }
const context = { ...executionFixtureScope, actorId: 'synthetic-worker' }

it('sentinel: delegated protocol proof requires only the explicitly owned disposable PG', () => {
  expect(process.env.EXPECT_DB).toBe('1'); expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})

describe('SA06D real delegated authority and shared production sender with synthetic fetch', () => {
  let f: Fixture, authority: Authority, claim: ClaimedConsumer, grantId: string
  let tokenCount: number, formCount: number
  let nativeClockRegressions: number, nativeMaxBackwardMs: number, nativeLastClock: number | null
  let tokenHook: (() => void | Promise<void>) | undefined
  let formHook: (() => Response | Promise<Response>) | undefined
  beforeEach(async () => {
    if (!process.env.DATABASE_URL) throw new Error('SA06D_OWNED_DB_REQUIRED')
    f = await createYidaAutomationExecutionFixture(process.env.DATABASE_URL)
    const ready = await f.ready(); grantId = ready.grantId; claim = ready.claim
    authority = f.execution(); tokenCount = 0; formCount = 0; tokenHook = undefined; formHook = undefined
    nativeClockRegressions = 0; nativeMaxBackwardMs = 0; nativeLastClock = null
  }, 15000)
  afterEach(async () => { await f?.cleanup() })
  async function fetchSynthetic(url: string, init: RequestInit) {
    expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal)
    const body = JSON.parse(String(init.body))
    if (url === 'https://api.dingtalk.com/v1.0/oauth2/accessToken') {
      tokenCount += 1
      expect(body).toEqual({ appKey: 'synthetic-app', appSecret: 'synthetic-secret' })
      expect((await f.pool.query('SELECT status FROM integration_yida_delivery_ledger')).rows[0].status).toBe('prepared')
      await tokenHook?.()
      return new Response(JSON.stringify({ accessToken: 'synthetic-access', expireIn: 3600 }))
    }
    expect(url).toBe('https://api.dingtalk.com/v1.0/yida/forms/instances')
    formCount += 1
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('x-acs-dingtalk-access-token')).toBe('synthetic-access')
    expect(body).toMatchObject({ appType: 'synthetic_app', formUuid: 'synthetic_form',
      systemToken: 'synthetic-system', userId: 'synthetic-executor' })
    expect(JSON.parse(body.formDataJson)).toEqual({ project: 'DEMO-P1', line: 'L1' })
    expect(JSON.stringify(body)).not.toContain('DEMO-P2')
    expect(JSON.stringify(body)).not.toContain('NOT-AUTHORIZED')
    const ledger = (await f.pool.query('SELECT status,claim_actor_id FROM integration_yida_delivery_ledger')).rows[0]
    expect(ledger).toMatchObject({ status: 'dispatching', claim_actor_id: 'synthetic-worker' })
    return formHook ? await formHook() : new Response(JSON.stringify({ result: 'synthetic-instance' }), { status: 201 })
  }
  async function attempt(options: Record<string, unknown> = {}): Promise<Attempt> {
    const admitted = await authority.admitForExecution(claim)
    expect(admitted.permit).not.toBeNull()
    return f.runner.createInternalYidaAutomationSendAttempt({ db: f.db, context, authority, permit: admitted.permit,
      fetch: fetchSynthetic, readEnablement: () => f.controls.enabled, ...options }) as Attempt
  }
  // Forward the actual wall clock unchanged: no clamp, replacement or budget
  // extension. Only the native kernel's observed backward steps are counted.
  function sampledWallClock() {
    const value = Date.now()
    if (nativeLastClock !== null && value < nativeLastClock) {
      nativeClockRegressions += 1; nativeMaxBackwardMs = Math.max(nativeMaxBackwardMs, nativeLastClock - value)
    }
    nativeLastClock = value
    return value
  }
  async function observedStage<T>(stage: 'FIRST_ATTEMPT' | 'SECOND_ATTEMPT' | 'CLOSE_ASSERTIONS', work: () => Promise<T>) {
    try { return await work() }
    catch (error) {
      let states: string[] = [], inspectionFailed = false
      try {
        const rows = (await f.pool.query('SELECT status FROM integration_yida_delivery_ledger')).rows
        states = rows.map(row => ['prepared', 'dispatching', 'acknowledged', 'outcome_unknown', 'not_sent'].includes(row.status)
          ? row.status : 'OTHER')
      } catch { inspectionFailed = true }
      process.stderr.write('SA06D_SEND_CASE_DIAGNOSTIC ' + JSON.stringify({ ...f.diagnostics(), stage,
        tokenCount, formCount, nativeClockRegressions, nativeMaxBackwardMs, states, inspectionFailed }) + '\n')
      throw error
    }
  }
  it('uses the actual original token/form protocols and scoped ledger for one approved row, never a second attempt', async () => {
    const send = await attempt()
    const result = await send.run()
    expect(result).toMatchObject({ status: 'acknowledged', durable: true, businessVerified: false, externalWriteAttempted: true })
    for (const privateValue of ['synthetic-secret', 'synthetic-system', 'synthetic-access']) {
      expect(JSON.stringify(result)).not.toContain(privateValue)
    }
    expect([tokenCount, formCount]).toEqual([1, 1])
    expect(await f.counts()).toEqual({ ledgers: 1, admissions: 1, snapshots: 1, used: 1 })
    const ledger = (await f.pool.query('SELECT status,ack_status_code,ack_instance_id,claim_actor_id FROM integration_yida_delivery_ledger')).rows[0]
    expect(ledger).toEqual({ status: 'acknowledged', ack_status_code: 201,
      ack_instance_id: 'synthetic-instance', claim_actor_id: context.actorId })
    await expect(send.run()).rejects.toThrow('YIDA_RUN_INVALID_INPUT')
    expect((await authority.admitForExecution(claim)).permit).toBeNull()
    expect([tokenCount, formCount]).toEqual([1, 1])
  })
  async function serialFixture() {
    await f.cleanup()
    f = await createYidaAutomationExecutionFixture(process.env.DATABASE_URL!, { approvedSecondRow: true })
    const ready = await f.ready(); grantId = ready.grantId; claim = ready.claim
    authority = f.execution()
  }
  async function nextSerialClaim() {
    await f.management.requestManual(grantId, { requestKey: 'synthetic-second-request' })
    const now = (await f.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date
    const claims = await claimDueConsumers(f.pool, { consumerKeys: [YIDA_AUTOMATION_CONSUMER], leaseMs: 60000, now: () => now })
    expect(claims).toHaveLength(1)
    claim = claims[0]
  }
  async function fetchSerial(url: string, init: RequestInit) {
    expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal)
    if (url === 'https://api.dingtalk.com/v1.0/oauth2/accessToken') {
      tokenCount += 1
      return new Response(JSON.stringify({ accessToken: 'synthetic-access', expireIn: 3600 }))
    }
    expect(url).toBe('https://api.dingtalk.com/v1.0/yida/forms/instances')
    formCount += 1
    const body = JSON.parse(String(init.body))
    expect(JSON.parse(body.formDataJson)).toEqual({ project: 'DEMO-P1', line: formCount === 1 ? 'L1' : 'L2' })
    expect(JSON.stringify(body)).not.toContain('NOT-AUTHORIZED')
    return new Response(JSON.stringify({ result: 'synthetic-instance-' + formCount }), { status: 201 })
  }
  it('retires a known ACK atomically and spends the same finite grant on the next approved row exactly once', async () => {
    await serialFixture()
    const first = await attempt({ fetch: fetchSerial })
    expect((await first.run()).status).toBe('acknowledged')
    expect((await f.pool.query('SELECT status FROM integration_yida_auto_requests')).rows).toEqual([{ status: 'closed_observed' }])
    expect((await f.pool.query('SELECT active_request_id,used_executions FROM integration_yida_auto_grants')).rows)
      .toEqual([{ active_request_id: null, used_executions: 1 }])
    expect(await f.management.inspect(grantId)).toMatchObject({ usedExecutions: 1, serialBlocked: false,
      requests: [{ rowOrdinal: 0, status: 'closed_observed', ledgerStatus: 'acknowledged', durable: true, canSend: false }] })
    expect((await authority.admitForExecution(claim)).permit).toBeNull()
    await nextSerialClaim()
    const second = await attempt({ fetch: fetchSerial })
    expect((await second.run()).status).toBe('acknowledged')
    expect([tokenCount, formCount]).toEqual([2, 2])
    expect(await f.counts()).toEqual({ ledgers: 2, admissions: 2, snapshots: 2, used: 2 })
    expect((await f.pool.query('SELECT status FROM integration_yida_auto_requests')).rows)
      .toEqual([{ status: 'closed_observed' }, { status: 'closed_observed' }])
    expect((await f.pool.query('SELECT active_request_id FROM integration_yida_auto_grants')).rows)
      .toEqual([{ active_request_id: null }])
    expect((await authority.admitForExecution(claim)).permit).toBeNull()
    await expect(f.management.requestManual(grantId, { requestKey: 'synthetic-third-request' })).rejects.toThrow()
    expect([tokenCount, formCount]).toEqual([2, 2])
  })
  it('a lost terminal COMMIT response observes the persisted ACK without reminting and permits only the next row', async () => {
    await serialFixture()
    f.controls.caseCode = 'TERMINAL_COMMIT_LOSS'
    const first = await attempt({ fetch: async (url: string, init: RequestInit) => {
      const response = await fetchSerial(url, init)
      if (url === 'https://api.dingtalk.com/v1.0/yida/forms/instances') f.controls.loseCommitResponse = true
      return response
    }, wallClock: sampledWallClock })
    // The ORIGINAL kernel reads its scoped native ledger after a lost ACK
    // COMMIT response. A durable ACK observed there is evidence, not a retry
    // or an invented success. Do not replace that existing consumer contract.
    await observedStage('FIRST_ATTEMPT', async () => {
      expect(await first.run()).toMatchObject({ status: 'acknowledged', durable: true, externalWriteAttempted: true })
    })
    expect((await f.pool.query('SELECT status FROM integration_yida_delivery_ledger')).rows).toEqual([{ status: 'acknowledged' }])
    expect((await f.pool.query('SELECT active_request_id,used_executions FROM integration_yida_auto_grants')).rows)
      .toEqual([{ active_request_id: null, used_executions: 1 }])
    const replay = await authority.admitForExecution(claim)
    expect(replay.permit).toBeNull()
    const { grantId: savedGrant, requestId, admissionId, ledgerId } = replay.approval
    expect(await authority.observeAdmission({ grantId: savedGrant, requestId, admissionId, ledgerId }))
      .toMatchObject({ status: 'acknowledged', durable: true, canSend: false, externalWriteAttempted: false })
    expect([tokenCount, formCount]).toEqual([1, 1])
    await nextSerialClaim()
    await observedStage('SECOND_ATTEMPT', async () => {
      expect((await (await attempt({ fetch: fetchSerial, wallClock: sampledWallClock })).run()).status).toBe('acknowledged')
    })
    expect([tokenCount, formCount]).toEqual([2, 2])
    expect(await f.counts()).toEqual({ ledgers: 2, admissions: 2, snapshots: 2, used: 2 })
  })
  it('an unknown first-row result keeps the serial slot blocked without a refund or second physical attempt', async () => {
    await serialFixture()
    const first = await attempt({ fetch: async (url: string, init: RequestInit) => {
      const response = await fetchSerial(url, init)
      if (url === 'https://api.dingtalk.com/v1.0/yida/forms/instances') throw new Error('SYNTHETIC_RESPONSE_LOST')
      return response
    } })
    expect((await first.run()).status).toBe('outcome_unknown')
    const state = (await f.pool.query('SELECT active_request_id,used_executions FROM integration_yida_auto_grants')).rows[0]
    expect(typeof state.active_request_id).toBe('string'); expect(state.used_executions).toBe(1)
    await nextSerialClaim()
    await expect(authority.admitForExecution(claim)).rejects.toThrow('YIDA_AUTOMATION_EXECUTION_DENIED')
    expect(await f.counts()).toEqual({ ledgers: 1, admissions: 1, snapshots: 1, used: 1 })
    expect((await f.pool.query('SELECT active_request_id FROM integration_yida_auto_grants')).rows[0].active_request_id)
      .toBe(state.active_request_id)
    expect((await f.pool.query("SELECT count(*)::int AS n FROM integration_yida_auto_requests WHERE status='queued'")).rows[0].n).toBe(1)
    expect([tokenCount, formCount]).toEqual([1, 1])
    f.controls.enabled = 'false'; f.management.close()
    const history = await f.management.inspect(grantId)
    expect(history).toMatchObject({ usedExecutions: 1, serialBlocked: true, canSend: false,
      requests: [{ rowOrdinal: 0, status: 'admitted', ledgerStatus: 'outcome_unknown' },
        { rowOrdinal: 1, status: 'queued', admissionId: null, ledgerStatus: null }] })
    expect(history.requests.every(request => !Object.hasOwn(request, 'externalWriteAttempted'))).toBe(true)
    for (const privateValue of ['synthetic-secret', 'synthetic-system', 'synthetic-access', 'DEMO-P1', 'NOT-AUTHORIZED']) {
      expect(JSON.stringify(history)).not.toContain(privateValue)
    }
    await f.management.revoke(grantId)
    expect(await f.management.inspect(grantId)).toMatchObject({ status: 'revoked', serialBlocked: true })
  })
  it('owner history remains tenant and owner scoped even when both alternative actors pass real live ACL', async () => {
    await f.pool.query(`INSERT INTO user_orgs VALUES ('synthetic-owner','synthetic-other-tenant',true);
      INSERT INTO users VALUES ('synthetic-other-owner','user','[]',true,'activated');
      INSERT INTO user_roles VALUES ('synthetic-other-owner','integration_admin');
      INSERT INTO user_permissions VALUES ('synthetic-other-owner','integration:admin');
      INSERT INTO user_orgs VALUES ('synthetic-other-owner','synthetic-tenant',true);
      INSERT INTO user_namespace_admissions VALUES ('synthetic-other-owner','integration',true)`)
    for (const grantor of [
      { actorId: 'synthetic-owner', tenantId: 'synthetic-other-tenant', workspaceId: null },
      { actorId: 'synthetic-other-owner', tenantId: 'synthetic-tenant', workspaceId: null },
    ] as const) {
      await f.transaction(trx => assertAutomationIntegrationActor(trx, grantor))
      const other = createYidaAutomationAuthorizationService({ grantor,
        binding: { baseId: 'synthetic-base', sheetId: 'synthetic-sheet', projectField: 'projectNo' },
        primitives: f.primitives, database: { transaction: f.transaction },
        activationId: '22222222-2222-4222-8222-222222222222', monotonicNow: () => f.controls.mono })
      try { await expect(other.inspect(grantId)).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED') }
      finally { other.close() }
    }
    expect(await f.management.inspect(grantId)).toMatchObject({ usedExecutions: 0, serialBlocked: false,
      requests: [{ rowOrdinal: 0, status: 'queued', admissionId: null, ledgerStatus: null }] })
    f.controls.mono += 900001
    expect(await f.management.inspect(grantId)).toMatchObject({ status: 'expired', canSend: false,
      requests: [{ rowOrdinal: 0, status: 'queued' }] })
    expect([tokenCount, formCount]).toEqual([0, 0])
  })
  it('a real request-retirement SQL failure rolls back native ACK and leaves the serial slot occupied', async () => {
    await serialFixture()
    await f.pool.query(`CREATE FUNCTION synthetic_refuse_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='closed_observed' THEN RAISE EXCEPTION 'SYNTHETIC_RETIREMENT_REFUSED'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER synthetic_refuse_retirement BEFORE UPDATE ON integration_yida_auto_requests
      FOR EACH ROW EXECUTE FUNCTION synthetic_refuse_retirement()`)
    const send = await attempt({ fetch: fetchSerial })
    try { expect((await send.run()).status).toBe('state_unconfirmed') }
    catch (error) {
      const status = (await f.pool.query('SELECT status FROM integration_yida_delivery_ledger')).rows[0]?.status
      process.stderr.write('SA06D_SERIAL_ROLLBACK ' + JSON.stringify({ tokenCount, formCount,
        status: ['prepared', 'dispatching', 'acknowledged', 'outcome_unknown'].includes(status) ? status : 'OTHER' }) + '\n')
      throw error
    }
    expect((await f.pool.query('SELECT status FROM integration_yida_delivery_ledger')).rows).toEqual([{ status: 'dispatching' }])
    expect((await f.pool.query('SELECT status FROM integration_yida_auto_requests')).rows).toEqual([{ status: 'admitted' }])
    expect((await f.pool.query("SELECT count(*)::int AS n FROM integration_yida_delivery_audit WHERE event='acknowledgement'")).rows[0].n).toBe(0)
    const state = (await f.pool.query('SELECT active_request_id,used_executions FROM integration_yida_auto_grants')).rows[0]
    expect(typeof state.active_request_id).toBe('string'); expect(state.used_executions).toBe(1)
    expect([tokenCount, formCount]).toEqual([1, 1])
    expect((await authority.admitForExecution(claim)).permit).toBeNull()
  })
  it('the original manual factory still refuses the real service actor without consulting any dependency', () => {
    expect(() => f.runner.createYidaDeliveryRunner({ db: f.db, context,
      resolveExecutionSnapshot: () => { throw new Error('SA06D_FORBIDDEN_RESOLVER') },
      tokenClient: {}, formTransport: {} })).toThrow('YIDA_RUN_INVALID_INPUT')
    expect([tokenCount, formCount]).toEqual([0, 0])
  })
  it('a copied JSON permit and a different authority instance cannot construct a sender', async () => {
    const admitted = await authority.admitForExecution(claim)
    const base = { db: f.db, context, fetch: fetchSynthetic, readEnablement: () => 'true' }
    expect(() => f.runner.createInternalYidaAutomationSendAttempt({ ...base, authority, permit: {} })).toThrow('YIDA_RUN_INVALID_INPUT')
    expect(() => f.runner.createInternalYidaAutomationSendAttempt({ ...base, authority: f.execution(), permit: admitted.permit }))
      .toThrow('YIDA_RUN_INVALID_INPUT')
    const send = f.runner.createInternalYidaAutomationSendAttempt({ ...base, authority, permit: admitted.permit }) as Attempt
    expect((await send.run()).status).toBe('acknowledged')
  })
  it('owner revocation before run blocks even the token request and keeps the spent budget', async () => {
    const send = await attempt()
    await f.management.revoke(grantId)
    await expect(send.run()).rejects.toThrow('YIDA_RUN_SNAPSHOT_INVALID')
    expect([tokenCount, formCount]).toEqual([0, 0]); expect((await f.counts()).used).toBe(1)
  })
  it('revocation after token response stops before claim/form and cannot reuse the one-shot attempt', async () => {
    const send = await attempt()
    tokenHook = () => f.management.revoke(grantId).then(() => {})
    await expect(send.run()).rejects.toThrow('YIDA_RUN_TOKEN_FAILED')
    expect([tokenCount, formCount]).toEqual([1, 0])
    expect((await f.pool.query('SELECT status FROM integration_yida_delivery_ledger')).rows[0].status).toBe('prepared')
    await expect(send.run()).rejects.toThrow('YIDA_RUN_INVALID_INPUT')
    expect((await authority.admitForExecution(claim)).permit).toBeNull()
  })
  it('failure after committed claim is durable unknown, not retry, refund or business success', async () => {
    const send = await attempt()
    formHook = async () => { throw new Error('SA06D_SYNTHETIC_TRANSPORT_UNKNOWN') }
    expect(await send.run()).toMatchObject({ status: 'outcome_unknown', durable: true,
      externalWriteAttempted: true, businessVerified: false })
    expect([tokenCount, formCount]).toEqual([1, 1]); expect((await f.counts()).used).toBe(1)
    expect((await authority.admitForExecution(claim)).permit).toBeNull()
    await expect(send.run()).rejects.toThrow('YIDA_RUN_INVALID_INPUT')
  })
  it('default OFF blocks before any token IO even when a valid permit was committed', async () => {
    const send = await attempt({ readEnablement: undefined })
    await expect(send.run()).rejects.toThrow('YIDA_RUN_DISABLED')
    expect([tokenCount, formCount]).toEqual([0, 0]); expect((await f.counts()).used).toBe(1)
  })
  it('the real capability separates snapshot from token material and refuses a third material read', async () => {
    const admitted = await authority.admitForExecution(claim), handle = authority.takeExecution(admitted.permit)
    const snapshot = await handle.resolveExecutionSnapshot({ ...handle.context, ...handle.operation })
    expect(snapshot).toMatchObject({ systemToken: 'synthetic-system', userId: 'synthetic-executor' })
    for (const key of ['appKey', 'appSecret', 'source', 'plan']) expect(snapshot).not.toHaveProperty(key)
    for (let i = 0; i < 2; i++) {
      const material = await handle.loadCredential(handle.credentialBinding)
      expect(Object.keys(material).sort()).toEqual([...Object.keys(handle.credentialBinding), 'appKey', 'appSecret'].sort())
      expect(material).toMatchObject({ appKey: 'synthetic-app', appSecret: 'synthetic-secret' })
    }
    await expect(handle.loadCredential(handle.credentialBinding)).rejects.toThrow('YIDA_AUTOMATION_EXECUTION_DENIED')
    await expect(handle.resolveExecutionSnapshot({ ...handle.context, ...handle.operation })).rejects.toThrow('YIDA_AUTOMATION_EXECUTION_DENIED')
    expect([tokenCount, formCount]).toEqual([0, 0])
  })
  it('trusted host context mismatch consumes and closes the capability without a network operation', async () => {
    const admitted = await authority.admitForExecution(claim)
    expect(() => f.runner.createInternalYidaAutomationSendAttempt({ db: f.db,
      context: { ...context, tenantId: 'other-synthetic-tenant' }, authority, permit: admitted.permit,
      fetch: fetchSynthetic, readEnablement: () => 'true' })).toThrow('YIDA_RUN_INVALID_INPUT')
    expect(() => authority.takeExecution(admitted.permit)).toThrow('YIDA_AUTOMATION_EXECUTION_DENIED')
    expect([tokenCount, formCount]).toEqual([0, 0])
  })
  it('a real shared-outbox fence change during token exchange prevents form IO', async () => {
    const send = await attempt()
    tokenHook = async () => { await f.pool.query('UPDATE meta_automation_outbox_consumer SET fence=fence+1') }
    await expect(send.run()).rejects.toThrow('YIDA_RUN_TOKEN_FAILED')
    expect([tokenCount, formCount]).toEqual([1, 0]); expect((await f.counts()).used).toBe(1)
    expect((await f.pool.query('SELECT status FROM integration_yida_delivery_ledger')).rows[0].status).toBe('prepared')
  })
  it('a genuinely reclaimed shared delivery prevents the stale worker from committing an ACK', async () => {
    const send = await attempt()
    let reclaimed: ClaimedConsumer | undefined
    formHook = async () => {
      await f.pool.query("UPDATE meta_automation_outbox_consumer SET lease_expires_at=clock_timestamp()-interval '1 second'")
      const dbNow = (await f.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date
      const claimed = await claimDueConsumers(f.pool, { consumerKeys: [YIDA_AUTOMATION_CONSUMER],
        leaseMs: 60000, now: () => dbNow })
      expect(claimed).toHaveLength(1); reclaimed = claimed[0]
      expect(reclaimed.fence).not.toBe(claim.fence)
      return new Response(JSON.stringify({ result: 'synthetic-stale-receipt' }))
    }
    const result = await send.run()
    expect(reclaimed).toBeDefined()
    const row = (await f.pool.query('SELECT status,ack_instance_id FROM integration_yida_delivery_ledger')).rows[0]
    expect.soft(result.status).toBe('state_unconfirmed')
    expect.soft(row.status).toBe('dispatching')
    expect.soft(row.ack_instance_id).toBeNull()
    expect([tokenCount, formCount]).toEqual([1, 1]); expect((await f.counts()).used).toBe(1)
    expect((await authority.admitForExecution(reclaimed!)).permit).toBeNull()
  })
  it('a close provider fault cannot be hidden by business ACK or leak its private error', async () => {
    f.controls.caseCode = 'CLOSE_PROVIDER'
    const admitted = await authority.admitForExecution(claim)
    // Real core handle/functions; only an AFTER-close provider fault is added.
    // This does not simulate or prove an actual host.stop failure.
    const faulted = { takeExecution(permit: unknown) {
      const handle = authority.takeExecution(permit)
      return Object.freeze({ ...handle, close() { handle.close(); throw new Error('synthetic-private-close-fault') } })
    } }
    const send = f.runner.createInternalYidaAutomationSendAttempt({ db: f.db, context, authority: faulted,
      permit: admitted.permit, fetch: fetchSynthetic, readEnablement: () => 'true', wallClock: sampledWallClock }) as Attempt
    await observedStage('CLOSE_ASSERTIONS', async () => {
      await expect(send.run()).rejects.toThrow('YIDA_RUN_STOP_FAILED')
      expect([tokenCount, formCount]).toEqual([1, 1])
      expect((await f.pool.query('SELECT status FROM integration_yida_delivery_ledger')).rows[0].status).toBe('acknowledged')
    })
    expect((await authority.admitForExecution(claim)).permit).toBeNull()
  })
  it('actual token-client drain waits for an exchange boundary that ignores cancellation', async () => {
    const send = await attempt(), controller = new AbortController()
    let enter: () => void = () => {}, release: () => void = () => {}, settled = false, exchangeReturned = false
    const reached = new Promise<void>(resolve => { enter = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    tokenHook = async () => { enter(); await wait; exchangeReturned = true }
    const pending = send.run({ signal: controller.signal }).finally(() => { settled = true })
    void pending.catch(() => {})
    try {
      await Promise.race([reached, pending.then(() => { throw new Error('SA06D_TOKEN_NOT_REACHED') })])
      controller.abort(); await new Promise(resolve => setImmediate(resolve))
      expect(exchangeReturned).toBe(false); expect(settled).toBe(false)
    } finally { release() }
    await expect(pending).rejects.toThrow('YIDA_RUN_CANCELLED')
    expect(exchangeReturned).toBe(true); expect(settled).toBe(true)
    expect([tokenCount, formCount]).toEqual([1, 0]); expect((await f.counts()).used).toBe(1)
  })
  it('cancellation while the actual ledger claim COMMIT is held waits and records unknown without form IO', async () => {
    const admitted = await authority.admitForExecution(claim), controller = new AbortController()
    let enter: () => void = () => {}, release: () => void = () => {}, settled = false
    const reached = new Promise<void>(resolve => { enter = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    const observed = { takeExecution(permit: unknown) {
      const handle = authority.takeExecution(permit)
      return Object.freeze({ ...handle, claim(input: unknown) {
        // No substituted SQL or return value. Hold the actual core transaction
        // provider immediately before its real COMMIT, after original claim SQL.
        f.controls.beforeCommitGate = { reached: enter, wait }
        return handle.claim(input)
      } })
    } }
    const send = f.runner.createInternalYidaAutomationSendAttempt({ db: f.db, context, authority: observed,
      permit: admitted.permit, fetch: fetchSynthetic, readEnablement: () => 'true' }) as Attempt
    const pending = send.run({ signal: controller.signal }).finally(() => { settled = true })
    void pending.catch(() => {})
    try {
      await Promise.race([reached, pending.then(() => { throw new Error('SA06D_CLAIM_COMMIT_NOT_REACHED') })])
      controller.abort(); await new Promise(resolve => setImmediate(resolve))
      expect(settled).toBe(false)
      expect((await f.pool.query('SELECT status FROM integration_yida_delivery_ledger')).rows[0].status).toBe('prepared')
    } finally { release() }
    expect(await pending).toMatchObject({ status: 'outcome_unknown', durable: true,
      externalWriteAttempted: false, businessVerified: false })
    expect(settled).toBe(true); expect([tokenCount, formCount]).toEqual([1, 0])
    expect((await f.pool.query('SELECT status FROM integration_yida_delivery_ledger')).rows[0].status).toBe('outcome_unknown')
    expect((await authority.admitForExecution(claim)).permit).toBeNull()
  })
  it('cancellation cannot report completion while the actual synthetic form boundary is still unsettled', async () => {
    const send = await attempt(), controller = new AbortController()
    let entered: () => void = () => {}, release: () => void = () => {}, settled = false
    const reached = new Promise<void>(resolve => { entered = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    formHook = async () => { entered(); await wait; return new Response(JSON.stringify({ result: 'synthetic-late-instance' })) }
    const pending = send.run({ signal: controller.signal }).finally(() => { settled = true })
    void pending.catch(() => {})
    try {
      try {
        await Promise.race([reached, pending.then(() => { throw new Error('SA06D_FORM_NOT_REACHED') })])
        controller.abort(); await Promise.resolve(); expect(settled).toBe(false)
      } finally { release() }
      expect(await pending).toMatchObject({ status: 'outcome_unknown', durable: true, businessVerified: false })
      expect(settled).toBe(true); expect([tokenCount, formCount]).toEqual([1, 1])
      expect((await authority.admitForExecution(claim)).permit).toBeNull()
    } catch (error) {
      process.stderr.write('SA06D_SEND_PROGRESS ' + JSON.stringify({ tokenCount, formCount,
        cancelled: controller.signal.aborted, settled }) + '\n')
      throw error
    }
  })
})
