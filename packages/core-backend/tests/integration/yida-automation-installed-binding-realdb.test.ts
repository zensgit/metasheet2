import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createYidaAutomationInstalledFixture, installedActor } from '../utils/yida-automation-installed-fixture'
import { claimDueConsumers } from '../../src/multitable/automation-durable-dispatcher'
import { YIDA_AUTOMATION_CONSUMER } from '../../src/integration/yida-automation-outbox'
import type { InstalledYidaAutomationBinding } from '../../src/integration/yida-automation-installed-binding'

type Fixture = Awaited<ReturnType<typeof createYidaAutomationInstalledFixture>>
it('sentinel: installed-source proof requires the explicitly owned disposable PostgreSQL', () => {
  expect(process.env.EXPECT_DB).toBe('1'); expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})
describe('SA06D real read-runtime installation -> grant/worker material boundary', () => {
  let f: Fixture
  beforeEach(async () => { f = undefined!; f = await createYidaAutomationInstalledFixture(process.env.DATABASE_URL!) }, 15000)
  afterEach(async () => { try { expect(f?.sourceCalls ?? 0).toBe(0) } finally { await f?.cleanup() } }, 15000)
  it('derives a mapped logical project role from actual profiles, epochs and finite-field ACL, never project==base', async () => {
    const reference = await f.resolve()
    expect(reference.binding).toEqual({ baseId: 'synthetic-base', sheetId: 'synthetic-sheet', projectField: 'projectNo' })
    expect(f.fieldIdMap.projectNo).not.toBe(reference.binding.projectField)
    expect(Object.isFrozen(reference)).toBe(true); expect(Object.isFrozen(reference.binding)).toBe(true)
    expect(await f.transaction(trx => reference.installationRevisionInTransaction(trx))).toMatch(/^[a-f0-9]{64}$/u)
    f.config.stockPreparationAutomationProfiles[0].tenantId = 'changed-after-real-activation'
    expect((await f.resolve()).binding).toEqual(reference.binding)
  })
  it('an inactive read runtime or disabled producer dependency supplies no installation source', async () => {
    const reference = await f.resolve()
    f.setInstalledEnabled(false)
    expect(() => f.readRuntime.installedBindingSourceForYida()).toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    const before = f.controls.statementCount
    await expect(f.transaction(trx => reference.installationRevisionInTransaction(trx))).rejects.toThrow('YIDA_AUTOMATION_INSTALLATION_DENIED')
    expect(f.controls.statementCount).toBe(before)
  })
  it('a disabled current profile is refused instead of disappearing into another or legacy binding', async () => {
    await f.pool.query('UPDATE automation_read_target_profiles SET enabled=false')
    await expect(f.resolve()).rejects.toThrow('YIDA_AUTOMATION_INSTALLATION_DENIED')
  })
  it('a real hidden project field refuses installation even for the integration administrator', async () => {
    await f.pool.query(`INSERT INTO field_permissions VALUES ('synthetic-sheet',$1,'user',$2,false,true)`,
      [f.fieldIdMap.projectNo, installedActor.actorId])
    await expect(f.resolve()).rejects.toThrow('YIDA_AUTOMATION_INSTALLATION_DENIED')
  })
  it('restoring identical field content cannot revive the old material-epoch reference', async () => {
    const old = await f.resolve(), before = await f.transaction(trx => old.installationRevisionInTransaction(trx))
    await f.metadataAba()
    await expect(f.transaction(trx => old.installationRevisionInTransaction(trx))).rejects.toThrow('YIDA_AUTOMATION_INSTALLATION_DENIED')
    const fresh = await f.resolve()
    expect(fresh.binding).toEqual(old.binding)
    expect(await f.transaction(trx => fresh.installationRevisionInTransaction(trx))).not.toBe(before)
  })
  it('a fresh valid installation reference still cannot activate a grant approved before metadata ABA', async () => {
    const old = await f.resolve(), manager = f.managementInstalled(old), grant = await manager.create(f.consent())
    await f.metadataAba()
    const freshManager = f.managementInstalled(await f.resolve())
    await expect(freshManager.requestManual(grant.grantId, { requestKey: 'synthetic-after-aba' }))
      .rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
    expect((await f.pool.query('SELECT count(*)::int AS n FROM integration_yida_auto_requests')).rows[0].n).toBe(0)
    expect((await f.pool.query('SELECT count(*)::int AS n FROM meta_automation_outbox')).rows[0].n).toBe(0)
  })
  it('propagates the same actual installed root into real worker admission and rejects a later installation change', async () => {
    const reference = await f.resolve(), manager = f.managementInstalled(reference), grant = await manager.create(f.consent())
    await manager.requestManual(grant.grantId, { requestKey: 'synthetic-installed-request' })
    const now = (await f.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date
    const claims = await claimDueConsumers(f.pool, { consumerKeys: [YIDA_AUTOMATION_CONSUMER], leaseMs: 60000, now: () => now })
    expect(claims).toHaveLength(1)
    const authority = f.execution({ installationRevisionInTransaction: reference.installationRevisionInTransaction })
    const admitted = await authority.admitForExecution(claims[0])
    expect(admitted.permit).not.toBeNull()
    const handle = authority.takeExecution(admitted.permit)
    const identity = { ...handle.context, ...handle.operation }
    await handle.resolveExecutionSnapshot(identity)
    await f.metadataAba()
    await expect(handle.loadCredential(handle.credentialBinding)).rejects.toThrow('YIDA_AUTOMATION_EXECUTION_DENIED')
    expect(await f.counts()).toEqual({ ledgers: 1, admissions: 1, snapshots: 1, used: 1 })
    expect((await f.pool.query('SELECT status FROM integration_yida_delivery_ledger')).rows[0].status).toBe('prepared')
  })
  it('a bare legacy component grant is not silently promoted into an installed worker authorization', async () => {
    const reference = await f.resolve(), ready = await f.ready()
    const authority = f.execution({ installationRevisionInTransaction: reference.installationRevisionInTransaction })
    await expect(authority.admitForExecution(ready.claim)).rejects.toThrow('YIDA_AUTOMATION_EXECUTION_DENIED')
    expect(await f.counts()).toEqual({ ledgers: 0, admissions: 0, snapshots: 0, used: 0 })
  })
  it('a malformed JS installation callback returning null cannot downgrade to uninstalled material v1', async () => {
    const reference = await f.resolve()
    const malformed = (async () => null) as unknown as InstalledYidaAutomationBinding['installationRevisionInTransaction']
    await expect(f.managementInstalled(reference, { installationRevisionInTransaction: malformed }).create(f.consent()))
      .rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
    expect((await f.pool.query('SELECT count(*)::int AS n FROM integration_yida_auto_grants')).rows[0].n).toBe(0)
  })
  it('read-runtime stop stays pending until the actual held source SQL response settles, then invalidates the reference', async () => {
    const source = f.readRuntime.installedBindingSourceForYida()
    let entered: () => void = () => {}, release: () => void = () => {}, stopped = false
    const reached = new Promise<void>(resolve => { entered = resolve }), wait = new Promise<void>(resolve => { release = resolve })
    const first = f.controls.statementCount + 1
    f.controls.afterStatement = async count => { if (count === first) { entered(); await wait } }
    const pending = f.transaction(trx => source.resolveInTransaction(trx, installedActor, 'synthetic-rule'))
    void pending.catch(() => {})
    let stop: Promise<void> | undefined
    try {
      await Promise.race([reached, pending.then(() => { throw new Error('SA06D_INSTALL_SQL_NOT_REACHED') })])
      stop = f.readRuntime.stop().finally(() => { stopped = true })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(stopped).toBe(false)
    } finally { release(); await pending.catch(() => {}); await stop }
    await expect(pending).rejects.toThrow('YIDA_AUTOMATION_INSTALLATION_DENIED')
    expect(stopped).toBe(true)
    expect(() => f.readRuntime.installedBindingSourceForYida()).toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
  })
  it('restarting the real producer cannot revive old grants even with equal profiles and the same synthetic grant activation id', async () => {
    const old = await f.resolve(), grant = await f.managementInstalled(old).create(f.consent())
    await f.readRuntime.stop(); await f.activate()
    const fresh = await f.resolve()
    expect(fresh.binding).toEqual(old.binding)
    await expect(f.managementInstalled(fresh).requestManual(grant.grantId, { requestKey: 'synthetic-restart' }))
      .rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
    expect((await f.pool.query('SELECT count(*)::int AS n FROM integration_yida_auto_requests')).rows[0].n).toBe(0)
  })
})
