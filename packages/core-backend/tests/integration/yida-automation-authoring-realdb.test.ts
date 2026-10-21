import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import type { Database } from '../../src/db/types'
import { up as oldReadUp } from '../../src/db/migrations/zzzz20261001133000_add_automation_read_preview_action'
import { up as revisionUp } from '../../src/db/migrations/zzzz20261001122000_automation_rule_authority_revision'
import { up, down } from '../../src/db/migrations/zzzz20261019120000_add_yida_authorized_automation_action'
import { createYidaAutomationInstalledFixture, installedActor } from '../utils/yida-automation-installed-fixture'
import { AutomationService, parseCreateRuleInput, serializeAutomationRule } from '../../src/multitable/automation-service'
import { EventBus } from '../../src/integration/events/event-bus'

it('sentinel: authoring migration requires the explicitly owned disposable PostgreSQL', () => {
  expect(process.env.EXPECT_DB).toBe('1'); expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})
describe('SA06D actual action CHECK migration and service-save -> installed consent path', () => {
  let f: Awaited<ReturnType<typeof createYidaAutomationInstalledFixture>>, db: Kysely<Database>, service: AutomationService
  let migrationDb: Kysely<unknown>
  const input = () => parseCreateRuleInput({ name: 'Synthetic', enabled: false, triggerType: 'schedule.interval',
    triggerConfig: { intervalMs: 60000 }, actionType: 'integration_yida_send_authorized',
    actionConfig: { authorizationSlot: 'synthetic-slot' }, actions: null, conditions: null, executionMode: 'legacy' }, installedActor.actorId)
  const save = () => service.createRule('synthetic-sheet', input())
  async function snapshot(id: string) {
    return (await f.pool.query(`SELECT action_type,action_config,actions,execution_mode,trigger_type,trigger_config,conditions,
      integration_authority_revision::text FROM automation_rules WHERE id=$1`, [id])).rows[0]
  }
  beforeEach(async () => {
    f = undefined!; service = undefined!
    f = await createYidaAutomationInstalledFixture(process.env.DATABASE_URL!)
    await f.pool.query(`DELETE FROM automation_rules;
      ALTER TABLE automation_rules ALTER COLUMN integration_authority_revision TYPE uuid USING integration_authority_revision::uuid;
      ALTER TABLE automation_rules ALTER COLUMN created_at SET DEFAULT clock_timestamp(), ALTER COLUMN updated_at SET DEFAULT clock_timestamp()`)
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: f.pool }) })
    migrationDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: f.pool }) })
    await migrationDb.transaction().execute(revisionUp)
    await migrationDb.transaction().execute(oldReadUp)
    service = new AutomationService(new EventBus(), db, (sql, values) => f.pool.query(sql, values))
  }, 15000)
  afterEach(async () => {
    try { await service?.shutdown(); expect(f?.sourceCalls ?? 0).toBe(0) } finally { await f?.cleanup() }
  }, 15000)
  it('the actual previous action CHECK refuses this new action before migration', async () => {
    await expect(save()).rejects.toMatchObject({ code: '23514', constraint: 'chk_automation_action_type' })
    expect((await f.pool.query('SELECT count(*)::int AS n FROM automation_rules')).rows[0].n).toBe(0)
  })
  it('the actual service saves a DB-versioned rule and its actual installed source can support explicit owner consent', async () => {
    await up(migrationDb)
    const rule = await service.createRule('synthetic-sheet', { ...input(), enabled: true })
    const row = await snapshot(rule.id)
    expect(row.action_type).toBe('integration_yida_send_authorized')
    expect(row.integration_authority_revision).toMatch(/^[a-f0-9-]{36}$/u)
    expect(serializeAutomationRule(rule).integrationAuthorityRevision).toBe(row.integration_authority_revision)
    const reference = await f.transaction(trx => f.readRuntime.installedBindingSourceForYida()
      .resolveInTransaction(trx, installedActor, rule.id))
    const manager = f.managementInstalled(reference)
    const grant = await manager.create({ ...f.consent(), ruleId: rule.id, expectedRuleRevision: row.integration_authority_revision })
    expect(grant).toMatchObject({ reused: false, usedExecutions: 0, canSend: false, externalWriteAttempted: false })
    expect((await f.pool.query('SELECT count(*)::int AS n FROM meta_automation_outbox')).rows[0].n).toBe(0)
  })
  it('final-row CHECK rejects direct/partial SQL for thirteen malformed private shapes without changing the original row', async () => {
    await up(migrationDb); const rule = await save(), original = await snapshot(rule.id)
    const patches = [
      { action_config: {} }, { action_config: { authorizationSlot: ' slot ' } },
      { action_config: { authorizationSlot: 'synthetic-slot', grantId: 'invented' } },
      { action_config: { authorizationSlot: 1 } }, { actions: [{ type: 'record_click', config: {} }] },
      { execution_mode: 'workflow_job_v1' }, { trigger_type: 'webhook.received' },
      { trigger_config: { intervalMs: 60000, private: 'invented' } }, { trigger_config: { intervalMs: '60000' } },
      { trigger_config: { intervalMs: 999 } }, { trigger_config: { intervalMs: 1000.5 } },
      { conditions: { conjunction: 'and', conditions: [] } },
      { action_type: 'record_click', action_config: {}, actions: [{ type: 'parallel_branch', config: {
        branches: [{ actions: [{ type: 'integration_yida_send_authorized', config: { authorizationSlot: 'synthetic-slot' } }] }],
      } }] },
    ]
    for (const patch of patches) {
      const row = { ...original, ...patch }
      await expect(f.pool.query(`UPDATE automation_rules SET action_type=$2,action_config=$3::jsonb,actions=$4::jsonb,
        execution_mode=$5,trigger_type=$6,trigger_config=$7::jsonb,conditions=$8::jsonb WHERE id=$1`,
      [rule.id, row.action_type, JSON.stringify(row.action_config), JSON.stringify(row.actions), row.execution_mode,
        row.trigger_type, JSON.stringify(row.trigger_config), JSON.stringify(row.conditions)]))
        .rejects.toMatchObject({ code: '23514', constraint: 'chk_automation_yida_authorized_shape' })
      expect(await snapshot(rule.id)).toEqual(original)
    }
    expect(patches).toHaveLength(13)
  })
  it('retains the old read-shape guard and does not classify ordinary config text as an executable private action', async () => {
    await up(migrationDb); const rule = await save()
    await expect(f.pool.query(`UPDATE automation_rules SET action_type='integration_read_preview',action_config='{}'::jsonb WHERE id=$1`, [rule.id]))
      .rejects.toMatchObject({ code: '23514', constraint: 'chk_automation_read_preview_shape' })
    await f.pool.query(`UPDATE automation_rules SET action_type='record_click',action_config=$2::jsonb,
      actions=NULL,trigger_type='record.created',trigger_config='{}'::jsonb WHERE id=$1`,
    [rule.id, JSON.stringify({ text: 'integration_yida_send_authorized' })])
    expect((await snapshot(rule.id)).action_type).toBe('record_click')
  })
  it('up replays safely without rewriting any retained private rule or its authority revision', async () => {
    await up(migrationDb); const rule = await save(), before = await snapshot(rule.id)
    await up(migrationDb); expect(await snapshot(rule.id)).toEqual(before)
  })
  it('rollback refuses retained private rules and preserves the action CHECK and row', async () => {
    await up(migrationDb); const rule = await save(), before = await snapshot(rule.id)
    await expect(down(migrationDb)).rejects.toMatchObject({ code: '55000' })
    expect(await snapshot(rule.id)).toEqual(before)
    await f.pool.query('UPDATE automation_rules SET name=$2 WHERE id=$1', [rule.id, 'Synthetic retained'])
  })
  it('rollback refuses even revoked grant history after its rule was deleted', async () => {
    await up(migrationDb)
    const rule = await service.createRule('synthetic-sheet', { ...input(), enabled: true }), row = await snapshot(rule.id)
    const reference = await f.transaction(trx => f.readRuntime.installedBindingSourceForYida().resolveInTransaction(trx, installedActor, rule.id))
    const manager = f.managementInstalled(reference)
    const grant = await manager.create({ ...f.consent(), ruleId: rule.id, expectedRuleRevision: row.integration_authority_revision })
    await f.pool.query('DELETE FROM automation_rules WHERE id=$1', [rule.id])
    await manager.revoke(grant.grantId)
    await expect(down(migrationDb)).rejects.toMatchObject({ code: '55000' })
    expect((await f.pool.query('SELECT count(*)::int AS n FROM integration_yida_auto_grants')).rows[0].n).toBe(1)
  })
  it('empty-history rollback replays and re-up preserves the prior action and read constraints', async () => {
    await up(migrationDb); await down(migrationDb); await down(migrationDb)
    await expect(save()).rejects.toMatchObject({ code: '23514', constraint: 'chk_automation_action_type' })
    await up(migrationDb); expect((await save()).action_type).toBe('integration_yida_send_authorized')
  })
})
