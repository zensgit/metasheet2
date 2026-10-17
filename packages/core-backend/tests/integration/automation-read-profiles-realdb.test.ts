/** Actual owned PostgreSQL + production profile capture/registry. No source IO,
 * JWT/Connection authorization, live installed-material epoch or consumer proof. */
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { up, down } from '../../src/db/migrations/zzzz20261001125000_automation_read_profiles'
import { up as addReadLedger } from '../../src/db/migrations/zzzz20261001123000_automation_read_ledger'
import { activateAutomationReadProfiles as activate, deactivateAutomationReadProducer as deactivate,
  renewAutomationReadProducer as renew, lockAutomationReadProfile as load,
  lockAutomationReadProducerForRead as fence,
  type PreparedAutomationReadProfile, type AutomationReadProducerIdentity } from '../../src/integration/automation-read-profiles'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

const requirePlugin = createRequire(import.meta.url)
const lib = path.resolve(__dirname, '../../../../plugins/plugin-integration-core/lib')
const { prepareStockPreparationAutomationProfiles: prepare, restoreStockPreparationAutomationProfileMaterial: restore } = requirePlugin(path.join(lib, 'stock-preparation-automation-profile.cjs')) as {
  prepareStockPreparationAutomationProfiles(input: { config: unknown }): readonly PreparedAutomationReadProfile[]
  restoreStockPreparationAutomationProfileMaterial(input: { material: unknown }): {
    action: unknown; packCatalog: { get(id: string): { extensionFields: Array<{ id: string }> } }; extFieldMapping: unknown
  }
}
const { FACTORY_A_SAMPLE_PACK: rawPack } = requirePlugin(path.join(lib, 'customer-packs/factory-a.sample.cjs')) as {
  FACTORY_A_SAMPLE_PACK: { packId: string; extensionFields: Array<{ id: string }> }
}
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE: template } = requirePlugin(path.join(lib, 'stock-preparation-templates.cjs')) as {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE: { fields: Array<{ id: string }> }
}
const { __internals: { buildExtensionFieldProperty } } = requirePlugin(path.join(lib, 'stock-preparation-customer-pack-installer.cjs')) as {
  __internals: { buildExtensionFieldProperty(field: unknown, pack: unknown): unknown }
}
const { isNormalizedExtFieldMapping } = requirePlugin(path.join(lib, 'stock-preparation-ext-field-mapping.cjs')) as {
  isNormalizedExtFieldMapping(value: unknown): boolean
}
const { deriveAutomationReadTargetContract } = requirePlugin(path.join(lib, 'stock-preparation-automation-target-contract.cjs')) as {
  deriveAutomationReadTargetContract(input: unknown): { projection: { fieldIds: string[]; logicalFieldIds: string[] } }
}
const { PLM_STOCK_PREPARATION_ACTION_ID: actionId } = requirePlugin(path.join(lib, 'stock-preparation-table-actions.cjs')) as {
  PLM_STOCK_PREPARATION_ACTION_ID: string
}
const describeDb = process.env.DATABASE_URL ? describe : describe.skip
const expectDb = process.env.EXPECT_DB === '1' ? it : it.skip
expectDb('EXPECT_DB supplies a real database', () => { expect(process.env.DATABASE_URL).toBeTruthy() })
const scope = { tenantId: 'synthetic-tenant', workspaceId: null, projectId: 'synthetic-deployment', actionId }
function fixture(sheet = 'synthetic-sheet', tenantId = scope.tenantId) {
  return prepare({ config: {
    stockPreparationAutomationProfiles: [{ ...scope, tenantId }],
    stockPreparationTableActions: [{ actionId, source: { externalSystemId: 'synthetic-source' },
      target: { sheetId: sheet, fieldIdMap: {} } }],
  } })
}
const fail = (code: string) => ({ code })

describeDb('private Automation profiles: persistent tenancy and fenced producer lifecycle', () => {
  const schema = `automation_profiles_${randomBytes(8).toString('hex')}`
  let pool: Pool, db: Kysely<unknown>, admin: PoolClient, reader: PoolClient, writer: PoolClient, observer: PoolClient
  let created = false
  async function tx<T>(client: PoolClient, work: (trx: PoolClient) => Promise<T>): Promise<T> {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    try { const result = await work(client); await client.query('COMMIT'); return result }
    catch (error) { await client.query('ROLLBACK'); throw error }
  }
  async function start(prepared = fixture(), ttl = 60000) { return tx(admin, trx => activate(trx, prepared, ttl)) }
  async function capture(producer: AutomationReadProducerIdentity, targetId: string, tenantId = scope.tenantId) {
    return tx(reader, trx => load(trx, producer, { targetId, tenantId }))
  }
  async function snapshot() {
    return Promise.all(['automation_read_producer_slot', 'automation_read_target_bindings', 'automation_read_target_profiles']
      .map(async table => (await admin.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows))
  }
  async function expire() {
    // Only the currently held, legitimate identity may shorten its own lease.
    const current = (await admin.query('SELECT generation::text, nonce::text FROM automation_read_producer_slot WHERE slot_id=1')).rows[0]
    await tx(admin, trx => renew(trx, current, 1))
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  async function pid(client: PoolClient) { return Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid) }
  beforeAll(async () => {
    if (!/^automation_profiles_[a-f0-9]{16}$/u.test(schema)) throw new Error('Unowned schema')
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6,
      options: `-c search_path=${schema} -c statement_timeout=8000` })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    admin = await pool.connect()
    await admin.query(`CREATE SCHEMA "${schema}"`); created = true
    await db.transaction().execute(up)
    await db.transaction().execute(addReadLedger)
    reader = await pool.connect(); writer = await pool.connect(); observer = await pool.connect()
  })
  afterAll(async () => {
    for (const client of [reader, writer, observer]) if (client) { await client.query('ROLLBACK').catch(() => {}); client.release() }
    if (admin) {
      await admin.query('ROLLBACK').catch(() => {})
      if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
      admin.release()
    }
    if (db) await db.destroy(); else await pool?.end()
  })
  beforeEach(async () => {
    for (const client of [admin, reader, writer, observer]) await client.query('ROLLBACK')
    // Owned-schema superuser fixture reset only; ordinary DML cannot erase tenancy.
    const tables = ['automation_read_producer_slot', 'automation_read_target_bindings', 'automation_read_target_profiles']
    for (const table of tables) await admin.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`)
    try {
      await admin.query('TRUNCATE automation_read_target_profiles, automation_read_target_bindings, integration_automation_read_requests, integration_automation_read_grants')
      await admin.query('UPDATE automation_read_producer_slot SET generation=0, nonce=NULL, expires_at=NULL WHERE slot_id=1')
    } finally { for (const table of tables) await admin.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`) }
  })

  it('real producer capture persists detached immutable material and an opaque target', async () => {
    const prepared = fixture()
    const result = await start(prepared)
    expect(result.producer.generation).toBe('1')
    expect(result.targets).toHaveLength(1)
    expect(result.targets[0].targetId).toMatch(/^[a-f0-9-]{36}$/u)
    const row = await capture(result.producer, result.targets[0].targetId)
    expect(row).toMatchObject({ ...prepared[0], producer: result.producer, targetId: result.targets[0].targetId })
    expect(row.material).not.toBe(prepared[0].material)
    expect(Object.isFrozen(row.material)).toBe(true)
    expect(Object.isFrozen(row.material.action)).toBe(true)
    expect(Object.isFrozen(row.producer)).toBe(true)
    expect(Object.isFrozen(result.targets)).toBe(true)
  })
  it('reads do not mutate profile, lifetime, or tenancy', async () => {
    const result = await start(), before = await snapshot()
    await capture(result.producer, result.targets[0].targetId)
    expect(await snapshot()).toEqual(before)
  })
  it.each(['synthetic-layout-a', 'synthetic-layout-b'])('roundtrips %s through DB and real branded mapper/closed target contract', async layout => {
    const logicalIds = [...template.fields, ...rawPack.extensionFields].map(field => field.id)
    const fieldIdMap = Object.fromEntries(logicalIds.map((id, index) => [id, `${layout}-${index}`]))
    const prepared = prepare({ config: {
      stockPreparationAutomationProfiles: [scope],
      stockPreparationTableActions: [{ actionId, source: { externalSystemId: 'synthetic-source' },
        extensionFieldIds: ['ext_legacyRowId'], target: { sheetId: `${layout}-sheet`, fieldIdMap } }],
      stockPreparationCustomerPacks: { [rawPack.packId]: rawPack },
      stockPreparationExtFieldMapping: { packId: rawPack.packId, mappingId: 'synthetic-map', mappingVersion: 1,
        mappings: [{ sourceColumn: 'SyntheticColumn', target: 'ext_legacyRowId' }] },
    } })
    const registered = await start(prepared), row = await capture(registered.producer, registered.targets[0].targetId)
    expect(isNormalizedExtFieldMapping(row.material.extFieldMappingConfig)).toBe(false)
    const restored = restore({ material: row.material })
    expect(isNormalizedExtFieldMapping(restored.extFieldMapping)).toBe(true)
    const pack = restored.packCatalog.get(rawPack.packId)
    // Synthetic installed classification only; real installed DB epoch is a separate prerequisite.
    const installedFieldProperties = pack.extensionFields.map(field => ({ fieldId: field.id, property: buildExtensionFieldProperty(field, pack) }))
    const contract = deriveAutomationReadTargetContract({ action: restored.action, extFieldMapping: restored.extFieldMapping, installedFieldProperties })
    expect(contract.projection.logicalFieldIds).toEqual([...new Set(logicalIds)].sort())
    expect(contract.projection.fieldIds).toEqual(contract.projection.logicalFieldIds.map(id => fieldIdMap[id]).sort())
  })
  it('a live second activation cannot steal the producer or disable its profiles', async () => {
    const result = await start(), before = await snapshot()
    await expect(start(fixture('synthetic-second'))).rejects.toMatchObject(fail('AUTOMATION_PROFILE_PRODUCER_BUSY'))
    expect(await snapshot()).toEqual(before)
    await capture(result.producer, result.targets[0].targetId)
  })
  it('concurrent activations have exactly one committed producer', async () => {
    const both = await Promise.allSettled([tx(reader, trx => activate(trx, fixture())), tx(writer, trx => activate(trx, fixture('synthetic-second')))])
    expect(both.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(both.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect((await admin.query('SELECT * FROM automation_read_target_profiles')).rows).toHaveLength(1)
  })
  it('renewal preserves producer identity, target identity, and revision', async () => {
    const first = await start(), prior = await capture(first.producer, first.targets[0].targetId)
    await tx(admin, trx => renew(trx, first.producer, 90000))
    expect(await capture(first.producer, first.targets[0].targetId)).toEqual(prior)
  })
  it.each(['0', '25ms', '2s'])('producer fence preserves caller lock_timeout %s, including transaction-local restoration', async setting => {
    const first = await start()
    const baseline = (await reader.query("SHOW lock_timeout")).rows[0].lock_timeout
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    try {
      await reader.query("SELECT set_config('lock_timeout',$1,true)", [setting])
      const original = (await reader.query('SHOW lock_timeout')).rows[0].lock_timeout
      const effective: number[] = []
      const actual: Queryable = { async query(sql, args) {
        if (/WHERE slot_id = 1 FOR (?:KEY )?SHARE/u.test(sql)) effective.push(Number((await reader.query(
          "SELECT setting FROM pg_catalog.pg_settings WHERE name='lock_timeout'",
        )).rows[0].setting))
        return reader.query(sql, args)
      } }
      await fence(actual, first.producer)
      expect(effective).toEqual([setting === '25ms' ? 25 : 250])
      expect((await reader.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe(original)
      // A second call on the same transaction must not inherit an altered GUC.
      await fence(actual, first.producer)
      expect((await reader.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe(original)
      await reader.query('COMMIT')
      expect((await reader.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe(baseline)
    } finally { await reader.query('ROLLBACK') }
  })
  it.each(['renewal', 'expiry', 'replacement'] as const)('writer-first %s is judged after real producer lock wait', async kind => {
    const first = await start()
    const blocker = await pid(writer), waiter = await pid(reader)
    await writer.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    await renew(writer, first.producer, 60000)
    let settled = false, pending: Promise<unknown> | undefined
    try {
      // A normal lease renewal holds the lock before the actual fence starts.
      pending = tx(reader, trx => fence(trx, first.producer)).finally(() => { settled = true })
      void pending.catch(() => {})
      let witnessed = false
      for (const until = performance.now() + 3000; !settled && performance.now() < until;) {
        if ((await observer.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked', [waiter, blocker])).rows[0].blocked) {
          witnessed = true; break
        }
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(witnessed).toBe(true)
      if (kind === 'expiry') {
        // Real DB time elapses while the actual reader is blocked. This is not
        // a fabricated live=false receipt, and remains below the 250ms lock cap.
        await renew(writer, first.producer, 1)
        await writer.query('SELECT pg_sleep(0.015)')
      } else if (kind === 'replacement') {
        await deactivate(writer, first.producer)
        await activate(writer, fixture())
      }
      await writer.query('COMMIT')
      if (kind === 'renewal') await expect(pending).resolves.toBeUndefined()
      else await expect(pending).rejects.toMatchObject(fail('AUTOMATION_PROFILE_FENCE_LOST'))
    } finally {
      await writer.query('ROLLBACK')
      await pending?.catch(() => {})
    }
  })
  it('a held renewal still times out under the shorter caller cap without partial profile mutation', async () => {
    const first = await start(), before = await snapshot()
    await writer.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    await renew(writer, first.producer, 60000)
    try {
      await expect(tx(reader, async trx => {
        await trx.query("SET LOCAL lock_timeout='20ms'")
        await fence(trx, first.producer)
      })).rejects.toMatchObject(fail('AUTOMATION_PROFILE_UNAVAILABLE'))
    } finally { await writer.query('ROLLBACK') }
    expect(await snapshot()).toEqual(before)
    await capture(first.producer, first.targets[0].targetId)
  })
  it('expiry cannot be renewed with the old identity; explicit reacquisition rotates both fields', async () => {
    const first = await start(); await expire()
    await expect(tx(admin, trx => renew(trx, first.producer))).rejects.toMatchObject(fail('AUTOMATION_PROFILE_FENCE_LOST'))
    await expect(capture(first.producer, first.targets[0].targetId)).rejects.toMatchObject(fail('AUTOMATION_PROFILE_FENCE_LOST'))
    const next = await start()
    expect(BigInt(next.producer.generation)).toBeGreaterThan(BigInt(first.producer.generation))
    expect(next.producer.nonce).not.toBe(first.producer.nonce)
    expect(next.targets[0].targetId).toBe(first.targets[0].targetId)
    await capture(next.producer, next.targets[0].targetId)
  })
  it('the database itself rejects same-nonce renewal after expiry', async () => {
    const first = await start(); await expire()
    await expect(admin.query("UPDATE automation_read_producer_slot SET expires_at=clock_timestamp()+interval '1 minute' WHERE nonce=$1", [first.producer.nonce]))
      .rejects.toMatchObject({ code: '55000' })
  })
  it.each(['renew', 'deactivate', 'load'] as const)('old process cannot %s a replacement', async operation => {
    const first = await start(); await expire(); const next = await start(), before = await snapshot()
    const work = operation === 'renew' ? tx(admin, trx => renew(trx, first.producer))
      : operation === 'deactivate' ? tx(admin, trx => deactivate(trx, first.producer))
        : capture(first.producer, next.targets[0].targetId)
    await expect(work).rejects.toMatchObject(fail('AUTOMATION_PROFILE_FENCE_LOST'))
    expect(await snapshot()).toEqual(before)
  })
  it('stop/restart with identical configuration never revives the old generation or profile revision', async () => {
    const first = await start(), prior = await capture(first.producer, first.targets[0].targetId)
    await tx(admin, trx => deactivate(trx, first.producer))
    await expect(capture(first.producer, first.targets[0].targetId)).rejects.toMatchObject(fail('AUTOMATION_PROFILE_FENCE_LOST'))
    const next = await start(), current = await capture(next.producer, next.targets[0].targetId)
    expect(current.targetId).toBe(prior.targetId)
    expect(current.revision).not.toBe(prior.revision)
    expect(current.producer.nonce).not.toBe(prior.producer.nonce)
  })
  it('disabled tenant binding survives restart and forbids reassignment atomically', async () => {
    const first = await start(); await tx(admin, trx => deactivate(trx, first.producer))
    const before = await snapshot()
    await expect(start(fixture('synthetic-sheet', 'synthetic-other-tenant'))).rejects.toMatchObject(fail('AUTOMATION_PROFILE_DENIED'))
    expect(await snapshot()).toEqual(before)
  })
  it('old omitted target is disabled, not silently adopted by the new producer', async () => {
    const first = await start(); await tx(admin, trx => deactivate(trx, first.producer))
    const next = await start(fixture('synthetic-second'))
    await expect(capture(next.producer, first.targets[0].targetId)).rejects.toMatchObject(fail('AUTOMATION_PROFILE_DENIED'))
    await capture(next.producer, next.targets[0].targetId)
    expect((await admin.query('SELECT * FROM automation_read_target_bindings')).rows).toHaveLength(2)
  })
  it('target UUID alone cannot cross tenant', async () => {
    const first = await start()
    await expect(capture(first.producer, first.targets[0].targetId, 'synthetic-other')).rejects.toMatchObject(fail('AUTOMATION_PROFILE_DENIED'))
  })
  it('private registry supports more than one action per same-tenant sheet without reassigning tenancy', async () => {
    // Storage contract, not claiming the current PLM normalizer supports arbitrary actions.
    const [one] = fixture(), second = { ...one, actionId: 'synthetic-future-reviewed-action' }
    const first = await start([one, second])
    expect(new Set(first.targets.map(target => target.targetId)).size).toBe(2)
    for (const target of first.targets) expect((await capture(first.producer, target.targetId)).actionId).toBe(target.actionId)
  })
  it('profile A→B→A changes DB revision even on the same producer', async () => {
    const first = await start(), target = first.targets[0].targetId, a = await capture(first.producer, target)
    await admin.query("UPDATE automation_read_target_profiles SET project_id='synthetic-changed' WHERE target_id=$1", [target])
    const b = await capture(first.producer, target)
    await admin.query('UPDATE automation_read_target_profiles SET project_id=$1 WHERE target_id=$2', [scope.projectId, target])
    const restored = await capture(first.producer, target)
    expect(new Set([a.revision, b.revision, restored.revision]).size).toBe(3)
    expect(restored.projectId).toBe(a.projectId)
  })
  it('caller cannot rewind producer generation or reuse a submitted prior nonce', async () => {
    const first = await start()
    await admin.query('UPDATE automation_read_producer_slot SET generation=0 WHERE slot_id=1')
    expect((await admin.query('SELECT generation::text FROM automation_read_producer_slot')).rows[0].generation).toBe(first.producer.generation)
    await tx(admin, trx => deactivate(trx, first.producer))
    const next = await start()
    await admin.query('UPDATE automation_read_producer_slot SET nonce=$1,generation=$2 WHERE slot_id=1', [first.producer.nonce, first.producer.generation])
    const actual = (await admin.query('SELECT generation::text,nonce::text FROM automation_read_producer_slot')).rows[0]
    expect(actual.nonce).not.toBe(first.producer.nonce)
    expect(BigInt(actual.generation)).toBeGreaterThan(BigInt(next.producer.generation))
  })
  it.each(['automation_read_producer_slot', 'automation_read_target_bindings', 'automation_read_target_profiles'])(
    'ordinary DELETE/TRUNCATE cannot erase %s history', async table => {
      await start()
      await expect(admin.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: '55000' })
      await expect(admin.query(`TRUNCATE ${table} CASCADE`)).rejects.toMatchObject({ code: '55000' })
    },
  )
  it('tenancy cannot be changed by direct binding/profile DML', async () => {
    await start()
    await expect(admin.query("UPDATE automation_read_target_bindings SET tenant_id='synthetic-other'")).rejects.toMatchObject({ code: '55000' })
    await expect(admin.query("UPDATE automation_read_target_profiles SET tenant_id='synthetic-other'")).rejects.toMatchObject({ code: '55000' })
  })
  it('an unreferenced tenant reservation cannot be reassigned or deleted without relying on a profile FK', async () => {
    await admin.query("INSERT INTO automation_read_target_bindings VALUES ('synthetic-reserved','synthetic-original')")
    await expect(admin.query("UPDATE automation_read_target_bindings SET tenant_id='synthetic-other' WHERE sheet_id='synthetic-reserved'"))
      .rejects.toMatchObject({ code: '55000' })
    await expect(admin.query("DELETE FROM automation_read_target_bindings WHERE sheet_id='synthetic-reserved'"))
      .rejects.toMatchObject({ code: '55000' })
  })
  it('slot SHARE also blocks a direct non-key lease update, independently of helper FOR UPDATE', async () => {
    const first = await start()
    await reader.query('BEGIN')
    await load(reader, first.producer, { tenantId: scope.tenantId, targetId: first.targets[0].targetId })
    const blocker = await pid(reader), waiter = await pid(writer)
    let done = false
    const pending = writer.query("UPDATE automation_read_producer_slot SET expires_at=clock_timestamp()+interval '1 minute' WHERE slot_id=1")
      .then(result => { done = true; return result })
    void pending.catch(() => {})
    try {
      let witnessed = false
      for (const deadline = Date.now() + 3000; Date.now() < deadline;) {
        if ((await observer.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked', [waiter, blocker])).rows[0].blocked) { witnessed = true; break }
        expect(done).toBe(false)
        await new Promise(resolve => setTimeout(resolve, 15))
      }
      expect(witnessed).toBe(true); expect(done).toBe(false)
      await reader.query('COMMIT')
      expect((await pending).rowCount).toBe(1)
    } finally { await reader.query('ROLLBACK'); await pending.catch(() => {}) }
  })
  it('real profile reader holds row locks until COMMIT, proven by another PG writer', async () => {
    const first = await start()
    await reader.query('BEGIN')
    await load(reader, first.producer, { tenantId: scope.tenantId, targetId: first.targets[0].targetId })
    const blocker = await pid(reader), waiter = await pid(writer)
    let done = false
    const pending = writer.query('UPDATE automation_read_target_profiles SET enabled=false WHERE target_id=$1', [first.targets[0].targetId])
      .then(result => { done = true; return result })
    void pending.catch(() => {})
    try {
      let witnessed = false
      for (const deadline = Date.now() + 3000; Date.now() < deadline;) {
        if ((await observer.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked', [waiter, blocker])).rows[0].blocked) { witnessed = true; break }
        expect(done).toBe(false)
        await new Promise(resolve => setTimeout(resolve, 15))
      }
      expect(witnessed).toBe(true); expect(done).toBe(false)
      await reader.query('COMMIT')
      expect((await pending).rowCount).toBe(1)
    } finally { await reader.query('ROLLBACK'); await pending.catch(() => {}) }
    await expect(capture(first.producer, first.targets[0].targetId)).rejects.toMatchObject(fail('AUTOMATION_PROFILE_DENIED'))
  })
  it('a reader blocks stop until its transaction ends; NOWAIT fails without partial disable', async () => {
    const first = await start()
    await reader.query('BEGIN')
    await load(reader, first.producer, { tenantId: scope.tenantId, targetId: first.targets[0].targetId })
    await expect(tx(writer, trx => deactivate(trx, first.producer))).rejects.toMatchObject(fail('AUTOMATION_PROFILE_UNAVAILABLE'))
    await reader.query('ROLLBACK')
    await capture(first.producer, first.targets[0].targetId)
  })
  it('writer-first profile changes cause reader NOWAIT refusal', async () => {
    const first = await start()
    await writer.query('BEGIN')
    try {
      await writer.query('UPDATE automation_read_target_profiles SET enabled=false')
      await expect(capture(first.producer, first.targets[0].targetId)).rejects.toMatchObject(fail('AUTOMATION_PROFILE_UNAVAILABLE'))
    } finally { await writer.query('ROLLBACK') }
  })
  it('holding locks cannot suspend wall-clock expiry or authorize another load', async () => {
    const first = await start()
    await tx(admin, trx => renew(trx, first.producer, 300))
    await reader.query('BEGIN')
    try {
      await load(reader, first.producer, { tenantId: scope.tenantId, targetId: first.targets[0].targetId })
      await reader.query('SELECT pg_sleep(0.32)')
      await expect(load(reader, first.producer, { tenantId: scope.tenantId, targetId: first.targets[0].targetId }))
        .rejects.toMatchObject(fail('AUTOMATION_PROFILE_FENCE_LOST'))
    } finally { await reader.query('ROLLBACK') }
  })
  it('expiry during material capture is rejected by the second producer check', async () => {
    const first = await start()
    await tx(admin, trx => renew(trx, first.producer, 300))
    const slow: Queryable = { async query(sql, args) {
      const result = await reader.query(sql, args)
      if (sql.includes('JOIN automation_read_target_bindings')) await reader.query('SELECT pg_sleep(0.32)')
      return result
    } }
    await expect(tx(reader, () => load(slow, first.producer, { tenantId: scope.tenantId, targetId: first.targets[0].targetId })))
      .rejects.toMatchObject(fail('AUTOMATION_PROFILE_FENCE_LOST'))
  })
  it('a re-enabled old profile still cannot be adopted by a replacement generation', async () => {
    const first = await start(); await tx(admin, trx => deactivate(trx, first.producer))
    const next = await start(fixture('synthetic-next'))
    await admin.query('UPDATE automation_read_target_profiles SET enabled=true WHERE target_id=$1', [first.targets[0].targetId])
    await expect(capture(next.producer, first.targets[0].targetId)).rejects.toMatchObject(fail('AUTOMATION_PROFILE_DENIED'))
  })
  it.each(['autocommit', 'repeatable read'] as const)('refuses %s before any activation write', async isolation => {
    const before = await snapshot()
    if (isolation !== 'autocommit') await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    try { await expect(activate(reader, fixture())).rejects.toMatchObject(fail('AUTOMATION_PROFILE_TRANSACTION_REQUIRED')) }
    finally { await reader.query('ROLLBACK') }
    expect(await snapshot()).toEqual(before)
  })
  it('caller objects are captured before the first await', async () => {
    const raw = JSON.parse(JSON.stringify(fixture())) as PreparedAutomationReadProfile[]
    let first = true
    const wrapped: Queryable = { async query(sql, args) {
      if (first) { first = false; Object.assign(raw[0], { tenantId: 'synthetic-spoof' }) }
      return admin.query(sql, args)
    } }
    const result = await tx(admin, () => activate(wrapped, raw))
    expect((await capture(result.producer, result.targets[0].targetId)).tenantId).toBe(scope.tenantId)
  })
  it.each(['getter', 'toJSON', 'workspace', 'duplicate', 'cross-tenant', 'ttl'] as const)(
    'invalid %s is refused before the first database call', async kind => {
      const raw = JSON.parse(JSON.stringify(fixture())) as PreparedAutomationReadProfile[]
      let calls = 0
      const never: Queryable = { async query() { calls++; throw new Error('No SQL permitted') } }
      let hooks = 0
      if (kind === 'getter') Object.defineProperty(raw[0], 'material', { enumerable: true, get() { hooks++; return {} } })
      if (kind === 'toJSON') Object.defineProperty(raw[0].material, 'toJSON', { value() { hooks++; return {} } })
      if (kind === 'workspace') Object.assign(raw[0], { workspaceId: 'synthetic-workspace' })
      if (kind === 'duplicate') raw.push(raw[0])
      if (kind === 'cross-tenant') raw.push({ ...raw[0], tenantId: 'synthetic-other', actionId: 'synthetic-another' })
      await expect(activate(never, raw, kind === 'ttl' ? 120001 : 60000)).rejects.toMatchObject(fail('AUTOMATION_PROFILE_INPUT_INVALID'))
      expect(calls).toBe(0); expect(hooks).toBe(0)
    },
  )
  it('down cannot erase even disabled persistent tenant reservations', async () => {
    const first = await start(); await tx(admin, trx => deactivate(trx, first.producer))
    await expect(db.transaction().execute(down)).rejects.toMatchObject({ code: '55000' })
    expect((await admin.query('SELECT * FROM automation_read_target_bindings')).rows).toHaveLength(1)
  })
  it('empty history down/up works, journal replay never silently replaces a live schema', async () => {
    await db.transaction().execute(down)
    await db.transaction().execute(up)
    await expect(db.transaction().execute(up)).rejects.toMatchObject({ code: '42P07' })
    expect((await start()).producer.generation).toBe('1')
  })
  it('same-named empty grant table in an earlier schema cannot hide retained real history from down', async () => {
    const decoy = `${schema}_decoy`
    await admin.query(`CREATE SCHEMA "${decoy}"`)
    try {
      await admin.query(`CREATE TABLE "${decoy}".integration_automation_read_grants (id text)`)
      await admin.query(`INSERT INTO integration_automation_read_grants
        (id,tenant_id,owner_id,selector,source_reference,authority_key,projects,triggers,budget,expires_at,max_executions)
        VALUES (gen_random_uuid(),$1,'synthetic-owner','{}',jsonb_build_object('connectionId','synthetic-connection','connectionIncarnation',gen_random_uuid()::text),
          $2,ARRAY['synthetic-project'],ARRAY['manual'],'{}',clock_timestamp()+interval '1 hour',1)`, [scope.tenantId, 'a'.repeat(64)])
      await expect(db.transaction().execute(async trx => {
        // Only this transaction sees our owned decoy; slot resolution still finds the real table.
        const { sql } = await import('kysely')
        await sql.raw(`SET LOCAL search_path = "${decoy}", "${schema}"`).execute(trx)
        await down(trx)
      })).rejects.toMatchObject({ code: '55000' })
      expect((await admin.query('SELECT * FROM automation_read_producer_slot')).rows).toHaveLength(1)
    } finally { await admin.query(`DROP SCHEMA "${decoy}" CASCADE`) }
  })
})
