/** Actual action migrations + actual AutomationService save boundary on a fresh
 * owned schema. No grants/runtime/source providers or external execution exist.
 * This is persistence evidence, not full JWT/HTTP or production boot evidence.
 */
import { randomBytes } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { up as createRules } from '../../src/db/migrations/zzzz20260413120000_create_automation_rules'
import { up as extendRules } from '../../src/db/migrations/zzzz20260414100000_extend_automation_rules'
import { up as executionMode } from '../../src/db/migrations/zzzz20260530120000_create_automation_jobs_and_execution_mode'
import { up as fwbActions } from '../../src/db/migrations/zzzz20260720120000_add_write_approval_form_values_automation_action'
import { up, down } from '../../src/db/migrations/zzzz20261001133000_add_automation_read_preview_action'
import { AutomationService, parseCreateRuleInput, parseUpdateRuleInput, serializeAutomationRule } from '../../src/multitable/automation-service'
import { EventBus } from '../../src/integration/events/event-bus'
import { AUTOMATION_READ_ACTION_TYPE, AUTOMATION_READ_OPERATION } from '../../src/integration/automation-read-operation-policy'
import { AUTOMATION_READ_AUTHORING_INVALID, validAutomationReadAuthoringShape } from '../../src/integration/automation-read-authoring-policy'

const database = process.env.DATABASE_URL ? describe : describe.skip
const requireDatabase = process.env.EXPECT_DB === '1' ? it : it.skip
requireDatabase('read authoring acceptance has a real owned database', () => { expect(process.env.DATABASE_URL).toBeTruthy() })
const config = () => ({ operation: AUTOMATION_READ_OPERATION, allowManual: true })
const action = () => ({ type: AUTOMATION_READ_ACTION_TYPE, config: config() })
const input = () => ({ name: 'Synthetic read', triggerType: 'record.created', actionType: AUTOMATION_READ_ACTION_TYPE,
  actionConfig: config(), enabled: false })

database('Automation read authoring: actual service, real migrated CHECK and concurrent final-row enforcement', () => {
  const schema = `read_authoring_${randomBytes(8).toString('hex')}`
  let admin: Pool, pool: Pool, db: Kysely<unknown>, service: AutomationService
  const extraDbs: Kysely<unknown>[] = []
  const extraServices: AutomationService[] = []

  async function row(id: string) {
    return (await pool.query('SELECT * FROM automation_rules WHERE id=$1', [id])).rows[0]
  }
  async function count() {
    return (await pool.query('SELECT count(*)::int AS count FROM automation_rules')).rows[0].count as number
  }
  async function save(body: Record<string, unknown> = input()) {
    return service.createRule('synthetic-sheet', parseCreateRuleInput(body, 'synthetic-owner'))
  }
  async function migrate(operation: typeof up) {
    await db.transaction().execute(transaction => operation(transaction))
  }

  beforeAll(async () => {
    if (!/^read_authoring_[a-f0-9]{16}$/.test(schema)) throw new Error('AUTHORING_FIXTURE_INVALID')
    admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
    await admin.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3,
      options: `-c search_path=${schema} -c statement_timeout=5000` })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    for (const migration of [createRules, extendRules, executionMode, fwbActions, up]) await migrate(migration)
    service = new AutomationService(new EventBus(), db as never, pool.query.bind(pool))
  })
  beforeEach(async () => { await pool.query('TRUNCATE automation_rules') })
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const extra of extraServices.splice(0)) extra.shutdown()
    for (const extra of extraDbs.splice(0)) await extra.destroy()
  })
  afterAll(async () => {
    service?.shutdown()
    await db?.destroy()
    if (admin) {
      // Exactly the random schema owned above, never public/customer tables.
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
      await admin.end()
    }
  })

  it.each([null, [], [action()]])('saves one logical read action through public parser and actual service: %j', async actions => {
    const saved = await save({ ...input(), actions })
    const stored = await row(saved.id)
    expect(stored).toMatchObject({ action_type: AUTOMATION_READ_ACTION_TYPE, action_config: config(),
      actions, execution_mode: null, trigger_type: 'record.created', created_by: 'synthetic-owner' })
    expect(serializeAutomationRule((await service.getRule(saved.id))!).actionConfig).toEqual(config())
    expect(await count()).toBe(1)
  })

  it('saves the parser modern singleton fallback without dropping the actual action list', async () => {
    const saved = await save({ triggerType: 'record.created', actions: [action()], enabled: false })
    expect(await row(saved.id)).toMatchObject({ action_type: AUTOMATION_READ_ACTION_TYPE,
      action_config: config(), actions: [action()] })
  })

  it.each([
    { actionConfig: { ...config(), sourceId: 'synthetic-private' } },
    { actionConfig: { ...config(), allowManual: 'true' } },
    { actionConfig: {} }, { executionMode: 'workflow_job_v1' }, { triggerType: 'field.changed' },
    { actions: [action(), action()] }, { actions: [{ ...action(), successor: 'synthetic' }] },
  ])('rejects malformed public create before persistence %#', async patch => {
    await expect(Promise.resolve().then(() => save({ ...input(), ...patch })))
      .rejects.toMatchObject({ code: AUTOMATION_READ_AUTHORING_INVALID })
    expect(await count()).toBe(0)
  })

  it.each([null, 'private', [], false])('does not swallow explicit malformed config %j on public PATCH', async actionConfig => {
    const saved = await save()
    const original = await row(saved.id)
    await expect(Promise.resolve().then(() => service.updateRule(saved.id, 'synthetic-sheet',
      parseUpdateRuleInput({ name: 'must not save', actionConfig })!)))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(await row(saved.id)).toEqual(original)
  })

  it.each([{ name: 'renamed' }, { enabled: true }, { conditions: null }, { triggerConfig: {} }])(
    'validates and preserves the complete valid read row on partial PATCH %#', async patch => {
      const saved = await save()
      const updated = await service.updateRule(saved.id, 'synthetic-sheet', parseUpdateRuleInput(patch)!)
      expect(updated).toBeTruthy()
      expect(await row(saved.id)).toMatchObject({ action_type: AUTOMATION_READ_ACTION_TYPE,
        action_config: config(), actions: null, execution_mode: null, trigger_type: 'record.created' })
    })

  it.each([{ triggerType: 'field.changed' }, { executionMode: 'workflow_job_v1' },
    { actionConfig: { ...config(), params: {} } }, { actions: [action(), { type: 'record_click', config: {} }] }])(
    'rejects a merged invalid PATCH and leaves every stored column unchanged %#', async patch => {
      const saved = await save()
      const original = await row(saved.id)
      await expect(service.updateRule(saved.id, 'synthetic-sheet', parseUpdateRuleInput(patch)!))
        .rejects.toMatchObject({ code: AUTOMATION_READ_AUTHORING_INVALID })
      expect(await row(saved.id)).toEqual(original)
    })

  it.each([
    ['action_config', null], ['action_config', '{}'], ['action_config', 'null'],
    ['action_config', JSON.stringify({ ...config(), allowManual: null })],
    ['action_config', JSON.stringify({ ...config(), sourceId: 'synthetic-private' })],
    ['actions', JSON.stringify([action(), action()])], ['execution_mode', 'workflow_job_v1'],
    ['trigger_type', 'field.changed'],
  ])('actual CHECK rejects direct DB tampering at %s (%#)', async (column, value) => {
    const saved = await save()
    const original = await row(saved.id)
    // Column identifiers are this test's finite literal table, never request data.
    await expect(pool.query(`UPDATE automation_rules SET ${column}=$1 WHERE id=$2`, [value, saved.id]))
      .rejects.toMatchObject({ code: '23514', constraint: 'chk_automation_read_preview_shape' })
    expect(await row(saved.id)).toEqual(original)
  })

  it('checks nested action paths without rejecting old free text containing the action name', async () => {
    const old = await save({ name: 'old', triggerType: 'record.created', actionType: 'record_click',
      actionConfig: { text: AUTOMATION_READ_ACTION_TYPE, data: { type: AUTOMATION_READ_ACTION_TYPE } }, enabled: false })
    for (const actions of [[action()], [{ type: 'condition_branch', config: {
      branches: [{ key: 'x', actions: [action()] }],
    } }], [{ type: 'parallel_branch', config: { branches: [{ key: 'x', actions: [action()] }] } }]]) {
      await expect(pool.query('UPDATE automation_rules SET actions=$1::jsonb WHERE id=$2', [JSON.stringify(actions), old.id]))
        .rejects.toMatchObject({ code: '23514', constraint: 'chk_automation_read_preview_shape' })
    }
    expect((await row(old.id)).action_config).toMatchObject({ text: AUTOMATION_READ_ACTION_TYPE })
  })

  it('two real service snapshots cannot commit an invalid action-only plus trigger-only combined row', async () => {
    const saved = await save({ ...input(), actionType: 'record_click', actionConfig: {} })
    let arrived = 0, release!: () => void, ready!: () => void
    const databaseRefusals: string[] = []
    const gate = new Promise<void>(resolve => { release = resolve })
    const updatesReady = new Promise<void>(resolve => { ready = resolve })
    const peers = Array.from({ length: 2 }, () => {
      const peerPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1,
        options: `-c search_path=${schema} -c statement_timeout=5000` })
      // Pause only the real final UPDATE, after all service validation/reads.
      // Both peers therefore validate the old row, and the loser MUST be the
      // actual PostgreSQL CHECK, not an earlier application-layer refusal.
      peerPool.on('connect', client => {
        const originalQuery = client.query
        vi.spyOn(client, 'query').mockImplementation(((...args: unknown[]) => {
          if (typeof args[0] !== 'string' || !args[0].startsWith('update "automation_rules" ')) {
            return Reflect.apply(originalQuery, client, args)
          }
          if (++arrived === 2) ready()
          return gate.then(() => Reflect.apply(originalQuery, client, args)).catch((error: unknown) => {
            if (error && typeof error === 'object' && 'code' in error && error.code === '23514'
              && 'constraint' in error && error.constraint === 'chk_automation_read_preview_shape') {
              databaseRefusals.push('chk_automation_read_preview_shape')
            }
            throw error
          })
        }) as typeof client.query)
      })
      const peerDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: peerPool }) })
      const peer = new AutomationService(new EventBus(), peerDb as never, peerPool.query.bind(peerPool))
      extraDbs.push(peerDb); extraServices.push(peer)
      return peer
    })
    const outcomes = Promise.allSettled([
      peers[0].updateRule(saved.id, 'synthetic-sheet', { actionType: AUTOMATION_READ_ACTION_TYPE, actionConfig: config() }),
      peers[1].updateRule(saved.id, 'synthetic-sheet', { triggerType: 'field.changed' }),
    ])
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([updatesReady, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('AUTHORING_RACE_NOT_REACHED')), 4000)
      })])
      expect(arrived).toBe(2)
    } finally {
      if (timer) clearTimeout(timer)
      release()
      await outcomes
    }
    const results = await outcomes
    expect(databaseRefusals).toEqual(['chk_automation_read_preview_shape'])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const refused = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(refused.reason).toMatchObject({ code: AUTOMATION_READ_AUTHORING_INVALID,
      message: AUTOMATION_READ_AUTHORING_INVALID })
    const final = await row(saved.id)
    expect(validAutomationReadAuthoringShape({ actionType: final.action_type, actionConfig: final.action_config,
      actions: final.actions, executionMode: final.execution_mode, triggerType: final.trigger_type })).toBe(true)
  })

  it('up replay retains data; down refuses in-use action without deleting data or weakening CHECK', async () => {
    const saved = await save()
    const original = await row(saved.id)
    await migrate(up)
    expect(await row(saved.id)).toEqual(original)
    await expect(migrate(down)).rejects.toMatchObject({ code: '55000' })
    expect(await row(saved.id)).toEqual(original)
    await expect(pool.query('UPDATE automation_rules SET action_config=NULL WHERE id=$1', [saved.id]))
      .rejects.toMatchObject({ code: '23514', constraint: 'chk_automation_read_preview_shape' })
    await pool.query('DELETE FROM automation_rules WHERE id=$1', [saved.id])
    await migrate(down)
    await migrate(up)
  })
})
