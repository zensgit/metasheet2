// Real core live actor/rule/material -> shared outbox/claim -> native prepare/
// permanent fence -> atomic admission/encrypted anchor -> known COMMIT ticket.
// Not JWT/host registration, token/form HTTP or the future delegated runner.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createYidaAutomationExecutionFixture, executionFixtureScope } from '../utils/yida-automation-execution-fixture'
import type { ClaimedConsumer } from '../../src/multitable/automation-durable-dispatcher'
import { probeEncryptedStores } from '../../src/security/encrypted-store-probe'
import { assertAutomationIntegrationActor } from '../../src/integration/automation-live-authority'

type Fixture = Awaited<ReturnType<typeof createYidaAutomationExecutionFixture>>
type Authority = ReturnType<Fixture['execution']>
const denied = (pending: Promise<unknown>) => expect(pending).rejects.toThrow('YIDA_AUTOMATION_EXECUTION_DENIED')
it('sentinel: delegated admission requires explicitly provided disposable PG', () => {
  expect(process.env.EXPECT_DB).toBe('1'); expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})
describe('SA06D delegated atomic admission and known-COMMIT permit — real PG', () => {
  let f: Fixture, authority: Authority, claim: ClaimedConsumer, grantId: string
  beforeEach(async () => {
    if (!process.env.DATABASE_URL) throw new Error('SA06D_OWNED_DB_REQUIRED')
    f = await createYidaAutomationExecutionFixture(process.env.DATABASE_URL)
    const ready = await f.ready(); grantId = ready.grantId; claim = ready.claim
    authority = f.execution()
  }, 15000)
  afterEach(async () => { await f?.cleanup() })
  it('commits actual prepare, budget and encrypted snapshot before releasing one opaque ticket', async () => {
    const admitted = await authority.admitForExecution(claim)
    expect(admitted.approval).toMatchObject({ grantId, reused: false, status: 'admitted', canSend: false, externalWriteAttempted: false })
    expect(admitted.permit).not.toBeNull()
    expect(Object.keys(admitted.permit!)).toEqual([]); expect(JSON.stringify(admitted.permit)).toBe('{}')
    expect(await f.counts()).toEqual({ ledgers: 1, admissions: 1, snapshots: 1, used: 1 })
    const saved = (await f.pool.query('SELECT worker_id,worker_fence::text AS fence,snapshot_encrypted FROM integration_yida_auto_execution_snapshots')).rows[0]
    expect(saved.worker_id).toBe('synthetic-worker'); expect(saved.fence).toBe(claim.fence)
    expect(saved.snapshot_encrypted.startsWith('enc:')).toBe(true)
    expect(saved.snapshot_encrypted.includes('synthetic-worker')).toBe(false)
    const report = await probeEncryptedStores({ query: (sql, params) => f.pool.query(sql, params), rowLimit: 1, env: process.env })
    expect(report.stores.find(row => row.store === 'integration_yida_auto_execution_snapshots')).toMatchObject({
      status: 'ok', rows: 1, encrypted: 1, undecryptable: 0, plaintext: 0 })
    const handle = authority.takeExecution(admitted.permit)
    expect(() => authority.takeExecution(admitted.permit)).toThrow('YIDA_AUTOMATION_EXECUTION_DENIED')
    const checked = await handle.checkpoint()
    expect(checked.context).toEqual({ ...executionFixtureScope, actorId: 'synthetic-worker' })
    expect(checked.context.actorId).not.toBe(checked.context.ownerId)
    expect(checked.canSend).toBe(false); expect(checked.externalWriteAttempted).toBe(false)
    expect(Object.keys(checked).sort()).toEqual(['context', 'operation', 'grantRef', 'expiresAt', 'executionDigest',
      'targetRef', 'targetRevision', 'planRevision', 'credentialBinding', 'config', 'row', 'canSend', 'externalWriteAttempted'].sort())
    expect(checked.row).toMatchObject({ projectNo: 'DEMO-P1', lineId: 'L1' })
    expect(JSON.stringify(checked)).not.toContain('DEMO-P2')
    expect(JSON.stringify(checked)).not.toContain('NOT-AUTHORIZED')
    for (const key of ['selection', 'source', 'plan', 'systemToken', 'appSecret']) expect(checked).not.toHaveProperty(key)
    handle.close(); await denied(handle.checkpoint())
  })
  it('concurrent delivery returns one real ticket and one history result without another prepare', async () => {
    const results = await Promise.all([authority.admitForExecution(claim), authority.admitForExecution(claim)])
    expect(results.filter(row => row.permit !== null)).toHaveLength(1)
    expect(results.map(row => row.approval.reused).sort()).toEqual([false, true])
    expect(await f.counts()).toEqual({ ledgers: 1, admissions: 1, snapshots: 1, used: 1 })
  })
  it('metadata observation remains tenant-scoped even when the same real owner is authorized in both tenants', async () => {
    const admitted = await authority.admitForExecution(claim)
    const { grantId, requestId, admissionId, ledgerId } = admitted.approval
    const identity = { grantId, requestId, admissionId, ledgerId }
    expect(await authority.observeAdmission(identity)).toEqual({ status: 'prepared', durable: true,
      canSend: false, externalWriteAttempted: false })
    await f.pool.query("INSERT INTO user_orgs VALUES ('synthetic-owner','other-synthetic-tenant',true)")
    const otherActor = { actorId: 'synthetic-owner', tenantId: 'other-synthetic-tenant', workspaceId: null } as const
    // Prove this denial is the observation's tenant predicate, not a second
    // failed ACL guard that accidentally masks a missing SQL scope condition.
    await f.transaction(trx => assertAutomationIntegrationActor(trx, otherActor))
    const anotherTenant = f.execution({ grantor: otherActor })
    await denied(anotherTenant.observeAdmission(identity))
    await denied(authority.observeAdmission({ ...identity, ledgerId: 'other-synthetic-ledger' }))
    expect(await f.counts()).toEqual({ ledgers: 1, admissions: 1, snapshots: 1, used: 1 })
  })
  it('actual snapshot INSERT failure rolls back ledger, original CREATE fence and the budget', async () => {
    await f.pool.query(`CREATE FUNCTION fail_execution_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'SA06D_TEST_SNAPSHOT_FAILURE'; END; $$;
      CREATE TRIGGER fail_execution_snapshot BEFORE INSERT ON integration_yida_auto_execution_snapshots
      FOR EACH ROW EXECUTE FUNCTION fail_execution_snapshot();`)
    await denied(authority.admitForExecution(claim))
    expect(await f.counts()).toEqual({ ledgers: 0, admissions: 0, snapshots: 0, used: 0 })
    await f.pool.query('DROP TRIGGER fail_execution_snapshot ON integration_yida_auto_execution_snapshots')
    expect((await authority.admitForExecution(claim)).permit).not.toBeNull()
    expect(await f.counts()).toEqual({ ledgers: 1, admissions: 1, snapshots: 1, used: 1 })
  })
  it('a real rollback before COMMIT exposes no ticket and leaves no half state', async () => {
    f.controls.beforeCommitFailure = true
    await denied(authority.admitForExecution(claim))
    expect(await f.counts()).toEqual({ ledgers: 0, admissions: 0, snapshots: 0, used: 0 })
    expect((await authority.admitForExecution(claim)).permit).not.toBeNull()
  })
  it('lost response after actual COMMIT consumes the budget but replay cannot remint a ticket', async () => {
    f.controls.loseCommitResponse = true
    await denied(authority.admitForExecution(claim))
    expect(await f.counts()).toEqual({ ledgers: 1, admissions: 1, snapshots: 1, used: 1 })
    const history = await authority.admitForExecution(claim)
    expect(history.approval.reused).toBe(true); expect(history.permit).toBeNull()
    const anotherInstance = f.execution() // Same synthetic activation, not an actual process restart.
    expect((await anotherInstance.admitForExecution(claim)).permit).toBeNull()
    expect(() => anotherInstance.takeExecution({})).toThrow('YIDA_AUTOMATION_EXECUTION_DENIED')
  })
  it('durable revoke invalidates an already-issued checkpoint opportunity', async () => {
    const admitted = await authority.admitForExecution(claim), handle = authority.takeExecution(admitted.permit)
    await handle.checkpoint()
    await f.management.revoke(grantId)
    await denied(handle.checkpoint())
    expect(await f.counts()).toEqual({ ledgers: 1, admissions: 1, snapshots: 1, used: 1 })
  })
  it('actual credential revocation after admission blocks the fresh material checkpoint', async () => {
    const admitted = await authority.admitForExecution(claim), handle = authority.takeExecution(admitted.permit)
    await f.materials.revoke({ credentialRef: f.credential.credentialRef, expectedGeneration: f.credential.credentialGeneration })
    await denied(handle.checkpoint())
    expect((await f.counts()).used).toBe(1)
  })
  it('real live permission revocation blocks admission before ledger or budget writes', async () => {
    await f.pool.query("DELETE FROM user_permissions WHERE user_id='synthetic-owner'")
    await denied(authority.admitForExecution(claim))
    expect(await f.counts()).toEqual({ ledgers: 0, admissions: 0, snapshots: 0, used: 0 })
  })
  it('the actual original owner factory lacks the private service transitions and cannot install as a worker', async () => {
    expect(() => f.execution({ primitives: f.primitives })).toThrow('YIDA_AUTOMATION_EXECUTION_DENIED')
    expect(await f.counts()).toEqual({ ledgers: 0, admissions: 0, snapshots: 0, used: 0 })
  })
  it('default OFF and non-exact literals never admit; disabling also invalidates a live handle', async () => {
    const defaultOff = f.execution({ readEnablement: undefined })
    await denied(defaultOff.admitForExecution(claim))
    for (const value of [undefined, true, 'TRUE', ' true', '1', 1, Promise.resolve('true')]) {
      f.controls.enabled = value; await denied(authority.admitForExecution(claim))
    }
    expect(await f.counts()).toEqual({ ledgers: 0, admissions: 0, snapshots: 0, used: 0 })
    f.controls.enabled = 'true'
    const admitted = await authority.admitForExecution(claim), handle = authority.takeExecution(admitted.permit)
    f.controls.enabled = 'false'
    await denied(handle.checkpoint()); expect((await f.counts()).used).toBe(1)
  })
  it('timeout, copied ticket and activation close cannot recover the consumed opportunity', async () => {
    const admitted = await authority.admitForExecution(claim)
    expect(() => authority.takeExecution(JSON.parse(JSON.stringify(admitted.permit)))).toThrow('YIDA_AUTOMATION_EXECUTION_DENIED')
    const handle = authority.takeExecution(admitted.permit)
    f.controls.mono += 10000
    await denied(handle.checkpoint())
    authority.close()
    await denied(authority.admitForExecution(claim))
    expect((await f.counts()).used).toBe(1)
  })
  it('the public promise exposes no ticket while the actual COMMIT is held', async () => {
    let reach: () => void = () => {}, release: () => void = () => {}, returned = false
    const reached = new Promise<void>(resolve => { reach = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    f.controls.beforeCommitGate = { reached: reach, wait }
    const pending = authority.admitForExecution(claim).then(value => { returned = true; return value })
    void pending.catch(() => {})
    try {
      await reached
      expect(returned).toBe(false)
      expect(await f.counts()).toEqual({ ledgers: 0, admissions: 0, snapshots: 0, used: 0 })
      expect(() => authority.takeExecution({})).toThrow('YIDA_AUTOMATION_EXECUTION_DENIED')
    } finally { release() }
    expect((await pending).permit).not.toBeNull()
    expect(await f.counts()).toEqual({ ledgers: 1, admissions: 1, snapshots: 1, used: 1 })
  })
  it('a changed real rule fingerprint invalidates the next material checkpoint', async () => {
    const result = await authority.admitForExecution(claim), handle = authority.takeExecution(result.permit)
    await f.pool.query("UPDATE automation_rules SET name='changed-after-admission'")
    await denied(handle.checkpoint()); expect((await f.counts()).used).toBe(1)
  })
  it('a producer lease lost after COMMIT blocks the ticket checkpoint', async () => {
    const result = await authority.admitForExecution(claim), handle = authority.takeExecution(result.permit)
    await f.pool.query("UPDATE meta_automation_outbox_consumer SET lease_expires_at=clock_timestamp()-interval '1 second'")
    await denied(handle.checkpoint()); expect((await f.counts()).used).toBe(1)
  })
  it('the actual decrypted envelope must exactly match the committed anchor', async () => {
    const decrypt = f.security.decrypt.bind(f.security), encrypt = f.security.encrypt.bind(f.security)
    // Actual AES decrypt still runs; a post-decrypt provider fault is injected.
    // This is anchor-comparison fault coverage, not an AES-authentication proof.
    const altered = f.execution({ security: { encrypt, decrypt: async value => (await decrypt(value)) + ' ' } })
    const result = await altered.admitForExecution(claim), handle = altered.takeExecution(result.permit)
    await denied(handle.checkpoint()); expect((await f.counts()).used).toBe(1)
  })
  it('native pre-cancellation and forged signals reject before the first authority statement', async () => {
    const controller = new AbortController(); controller.abort()
    f.controls.statementCount = 0
    await denied(authority.admitForExecution(claim, { signal: controller.signal }))
    let getters = 0
    const getter = { get signal() { getters += 1; return controller.signal } }
    const proxy = new Proxy(controller.signal, {})
    for (const options of [getter, { signal: proxy }, { signal: { aborted: false } },
      { signal: controller.signal, extra: true }]) await denied(authority.admitForExecution(claim, options))
    expect(getters).toBe(0); expect(f.controls.statementCount).toBe(0)
    expect(await f.counts()).toEqual({ ledgers: 0, admissions: 0, snapshots: 0, used: 0 })
  })
  it('cancellation during actual PG work stops later SQL and permanently closes that handle', async () => {
    const admitted = await authority.admitForExecution(claim), handle = authority.takeExecution(admitted.permit)
    const controller = new AbortController()
    f.controls.statementCount = 0
    f.controls.afterStatement = count => { if (count === 5) controller.abort() }
    await denied(handle.checkpoint('prepared', { signal: controller.signal }))
    expect(f.controls.statementCount).toBe(5)
    f.controls.afterStatement = undefined
    await denied(handle.checkpoint()); expect(f.controls.statementCount).toBe(5)
    expect(await f.counts()).toEqual({ ledgers: 1, admissions: 1, snapshots: 1, used: 1 })
  })
  it('closing a handle during real PG work prevents the following statement', async () => {
    const admitted = await authority.admitForExecution(claim), handle = authority.takeExecution(admitted.permit)
    f.controls.statementCount = 0
    f.controls.afterStatement = count => { if (count === 5) handle.close() }
    await denied(handle.checkpoint()); expect(f.controls.statementCount).toBe(5)
    f.controls.afterStatement = undefined
    expect((await f.counts()).used).toBe(1)
  })
  it('the admission signal remains bound even if the handle caller omits its signal option', async () => {
    const controller = new AbortController()
    const admitted = await authority.admitForExecution(claim, { signal: controller.signal })
    const handle = authority.takeExecution(admitted.permit)
    f.controls.statementCount = 0
    controller.abort()
    await denied(handle.checkpoint()); expect(f.controls.statementCount).toBe(0)
    expect((await f.counts()).used).toBe(1)
  })
  it('cancellation while real COMMIT is held awaits its outcome and never remints the spent opportunity', async () => {
    const controller = new AbortController()
    let reach: () => void = () => {}, release: () => void = () => {}, settled = false
    const reached = new Promise<void>(resolve => { reach = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    f.controls.beforeCommitGate = { reached: reach, wait }
    const pending = authority.admitForExecution(claim, { signal: controller.signal })
      .finally(() => { settled = true })
    void pending.catch(() => {})
    try {
      await reached; controller.abort(); await Promise.resolve()
      expect(settled).toBe(false)
      expect(await f.counts()).toEqual({ ledgers: 0, admissions: 0, snapshots: 0, used: 0 })
    } finally { release() }
    await denied(pending); expect(settled).toBe(true)
    expect(await f.counts()).toEqual({ ledgers: 1, admissions: 1, snapshots: 1, used: 1 })
    const replay = await authority.admitForExecution(claim)
    expect(replay.permit).toBeNull(); expect(replay.approval.reused).toBe(true)
  })
})
