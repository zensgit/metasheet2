/** Real runtime activation + DB lifecycle. No source IO or request authority
 * is claimed by this suite; the authority executable chain proves those. */
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { up } from '../../src/db/migrations/zzzz20261001125000_automation_read_profiles'
import { createAutomationReadRuntime, type AutomationReadRuntimeBinding } from '../../src/integration/automation-read-runtime'
import { CURRENT_ROUTING_MANIFEST } from '../../src/multitable/automation-routing-manifest'
import type { AutomationReadLedgerDependencies } from '../../src/integration/automation-read-contracts'
import { lockAutomationReadProfile } from '../../src/integration/automation-read-profiles'

const requirePlugin = createRequire(import.meta.url)
const lib = path.resolve(__dirname, '../../../../plugins/plugin-integration-core/lib')
const codecs = requirePlugin(path.join(lib, 'stock-preparation-automation-profile.cjs'))
const { deriveAutomationReadTargetContract } = requirePlugin(path.join(lib, 'stock-preparation-automation-target-contract.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID: actionId } = requirePlugin(path.join(lib, 'stock-preparation-table-actions.cjs'))
const describeDb = process.env.DATABASE_URL ? describe : describe.skip
;(process.env.EXPECT_DB === '1' ? it : it.skip)('EXPECT_DB supplies a real database', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

describeDb('Automation read host activation against real producer slot', () => {
  const schema = `automation_runtime_${randomBytes(8).toString('hex')}`
  let pool: Pool, db: Kysely<unknown>, created = false
  const runtimes: ReturnType<typeof createAutomationReadRuntime>[] = []
  const transaction: AutomationReadLedgerDependencies['transaction'] = async work => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const value = await work({ isTransaction: true, query: (sql, params) => client.query(sql, params) })
      await client.query('COMMIT'); return value
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema},public`, max: 5 })
    await pool.query(`CREATE SCHEMA "${schema}"`); created = true
    db = new Kysely({ dialect: new PostgresDialect({ pool }) })
    await db.transaction().execute(up)
  })
  afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.stop())) })
  afterAll(async () => {
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    if (db) await db.destroy(); else await pool?.end()
  })
  function config(suffix: string) {
    return { stockPreparationAutomationProfiles: [{ tenantId: 'synthetic-tenant', workspaceId: null,
      projectId: 'synthetic-project', actionId }], stockPreparationTableActions: [{ actionId,
      source: { externalSystemId: 'synthetic-source' }, target: { sheetId: `synthetic-${suffix}`, fieldIdMap: {} } }] }
  }
  const unused = () => { throw new Error('No source IO in lifecycle-only suite') }
  function binding(): AutomationReadRuntimeBinding {
    return { prepareProfiles: codecs.prepareStockPreparationAutomationProfiles,
      codec: { restoreStockPreparationAutomationProfileMaterial: codecs.restoreStockPreparationAutomationProfileMaterial,
        composeStockPreparationAutomationExecution: codecs.composeStockPreparationAutomationExecution, deriveAutomationReadTargetContract },
      sourceStore: { lockActiveForAutomation: async () => unused() }, preview: async () => unused() }
  }
  function host() {
    const runtime = createAutomationReadRuntime({ transaction, manifest: CURRENT_ROUTING_MANIFEST,
      getManager: unused, enabled: () => true, onUnavailable() {} })
    runtimes.push(runtime); return runtime
  }
  async function slot() {
    return (await pool.query('SELECT generation::text,nonce::text,expires_at IS NOT NULL AS live FROM automation_read_producer_slot WHERE slot_id=1')).rows[0]
  }
  it('real preparer and host activation persist captured deployment tenant, then stop disables profiles', async () => {
    const runtime = host(), deploy = config('captured'), cap = runtime.createPluginCapability(deploy)
    deploy.stockPreparationAutomationProfiles[0].tenantId = 'changed-after-capture'
    const handle = await cap.activate(binding()), producer = await slot()
    const row = (await pool.query('SELECT target_id::text,tenant_id,enabled FROM automation_read_target_profiles WHERE sheet_id=$1', ['synthetic-captured'])).rows[0]
    expect(row).toMatchObject({ tenant_id: 'synthetic-tenant', enabled: true })
    const proof = await transaction(trx => lockAutomationReadProfile(trx, { generation: producer.generation, nonce: producer.nonce },
      { tenantId: 'synthetic-tenant', targetId: row.target_id }))
    expect(proof.sheetId).toBe('synthetic-captured')
    await handle.stop()
    expect((await slot()).live).toBe(false)
    expect((await pool.query('SELECT enabled FROM automation_read_target_profiles WHERE target_id=$1', [row.target_id])).rows[0].enabled).toBe(false)
  })
  it('a second actual host cannot steal the live producer or change its target registry', async () => {
    await host().createPluginCapability(config('first')).activate(binding())
    const before = await slot()
    await expect(host().createPluginCapability(config('second')).activate(binding())).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    expect(await slot()).toEqual(before)
    expect((await pool.query('SELECT count(*)::int AS n FROM automation_read_target_profiles WHERE sheet_id=$1', ['synthetic-second'])).rows[0].n).toBe(0)
  })
  it('failed assembly after producer commit retires that exact generation', async () => {
    const broken = binding(); broken.codec = { ...broken.codec, composeStockPreparationAutomationExecution: null as never }
    await expect(host().createPluginCapability(config('broken')).activate(broken)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    expect((await slot()).live).toBe(false)
    expect((await pool.query('SELECT count(*)::int AS n FROM automation_read_target_profiles WHERE enabled=true')).rows[0].n).toBe(0)
  })
  it('stop and replacement mint a new lifetime; an old handle cannot retire the replacement', async () => {
    const runtime = host(), old = await runtime.createPluginCapability(config('restart')).activate(binding())
    const previous = await slot(); await old.stop()
    await runtime.createPluginCapability(config('restart')).activate(binding())
    const current = await slot(); expect(current.nonce).not.toBe(previous.nonce)
    await old.stop(); expect(await slot()).toEqual(current)
  })
})
