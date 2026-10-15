import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
/** Owned local HTTP fixture. Uses real auth, receiver, dispatcher and record automation. */
import { createHash, randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../../package.json', import.meta.url))
const express = require('express')
const { Pool } = require('pg')
const { Kysely, PostgresDialect } = require('kysely')
import { bootstrapPlmIngressTestDb } from '../../tests/plm-record-ingress/bootstrap'
import { provisionPlmRecordBinding } from '../../src/multitable/plm-record-ingress-binding'
import { createPlmRecordIngressRouter, createPlmRecordIngressBodyParser } from '../../src/routes/plm-record-ingress'
import { poolManager } from '../../src/integration/db/connection-pool'
import { EventBus } from '../../src/integration/events/event-bus'
import { AutomationService } from '../../src/multitable/automation-service'
import { buildDurableConsumerHandlers } from '../../src/multitable/automation-durable-consumer-handlers'
import { buildConsumerAdapterRegistry } from '../../src/multitable/automation-durable-activation'
import { ConsumerAdapterRegistry, runDispatchTick } from '../../src/multitable/automation-durable-dispatch-loop'

if (!process.env.DATABASE_URL || !process.env.W21_READY_FILE) throw new Error('owned fixture configuration required')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
await bootstrapPlmIngressTestDb(pool)
const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
// Additional real migrations needed to execute, deduplicate and audit record automations.
for (const name of [
  'zzzz20260413120000_create_automation_rules',
  'zzzz20260414100000_extend_automation_rules',
  'zzzz20260414100001_create_automation_executions_and_dashboard_charts',
  'zzzz20260527120000_add_automation_execution_snapshot_fields',
  'zzzz20260529120000_add_automation_retry_attempt_fields',
  'zzzz20260530120000_create_automation_jobs_and_execution_mode',
  'zzzz20260701120000_create_automation_event_fires',
  'zzzz20260716100000_create_automation_action_applied',
  'zzzz20260716140000_event_fires_lease',
  'zzzz20260716160000_add_execution_rule_fingerprint',
]) await (await import(`../../src/db/migrations/${name}.ts`)).up(db)

const token = `mst_${randomBytes(32).toString('hex')}`
const binding = {
  id: '00000000-0000-4000-8000-000000000002', version: 1, token_id: 'w21-token',
  source: { connection_id: 'fixture-yuantus', tenant_id: 'default', org_id: 'fixture-org', part_id: 'fixture-part' },
  sheet_id: 'w21-sheet', fields: { quantity: 'f-q', uom: 'f-u', find_num: 'f-n', refdes: 'f-r' },
}
await pool.query(`
  INSERT INTO users VALUES('writer',true,'user','activated',true,ARRAY['multitable:read','multitable:write']);
  INSERT INTO meta_bases(id,owner_id) VALUES('w21-base','writer');
  INSERT INTO meta_sheets(id,base_id) VALUES('w21-sheet','w21-base');
  INSERT INTO meta_fields(id,sheet_id,type,property)
    SELECT id,'w21-sheet','string','{"readOnly":true}'::jsonb FROM unnest(ARRAY['f-q','f-u','f-n','f-r']) id;
  INSERT INTO meta_fields VALUES('f-local','w21-sheet','string','{}');
`)
await pool.query(`INSERT INTO multitable_api_tokens(id,token_hash,token_prefix,name,created_by,scopes,base_ids,sheet_ids)
  VALUES('w21-token',$1,$2,'synthetic-local-fixture','writer','["records:write"]',ARRAY['w21-base'],ARRAY['w21-sheet'])`,
  [createHash('sha256').update(token).digest('hex'), token.slice(0, 8)])
const connection = poolManager.get()
const configPath = join(dirname(process.env.W21_READY_FILE), 'binding-config.json')
await writeFile(configPath, JSON.stringify(binding), { mode: 0o600 })
for (const mode of ['--dry-run', '--apply']) {
  const cli = spawnSync(process.execPath, ['--import', 'tsx', 'packages/core-backend/scripts/plm-record-ingress-provision.ts', configPath, mode],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 30000 })
  assert.equal(cli.status, 0, `operator CLI ${mode} failed`)
  assert.equal(JSON.parse(cli.stdout).result, mode === '--apply' ? 'provisioned' : 'validated')
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM meta_plm_record_bindings')).rows[0].n), mode === '--apply' ? 1 : 0)
}
await provisionPlmRecordBinding(connection, binding, { apply: true })
for (const [id, type, trigger] of [
  ['w21-created', 'record.created', {}],
  ['w21-updated', 'field.value_changed', { fieldId: 'f-q', condition: 'any' }],
] as const) {
  const config = { fields: { 'f-local': 'automation-ran' } }
  await pool.query(`INSERT INTO automation_rules(id,sheet_id,name,trigger_type,trigger_config,action_type,action_config,actions,created_by)
    VALUES($1,'w21-sheet','W21 local projection automation',$2,$3::jsonb,'update_record',$4::jsonb,$5::jsonb,'writer')`,
    [id, type, JSON.stringify(trigger), JSON.stringify(config), JSON.stringify([{ type: 'update_record', config }])])
}

const automation = new AutomationService(new EventBus(), db as never, connection.query.bind(connection))
const unexpected = new Proxy({}, { get: () => () => { throw new Error('unexercised non-record consumer') } })
const handlers = buildDurableConsumerHandlers({ automationService: automation,
  projectionService: unexpected, webhookService: unexpected, recordApprovalService: unexpected, todoMirrorService: unexpected } as never)
const all = buildConsumerAdapterRegistry(handlers)
const registry = new ConsumerAdapterRegistry()
registry.register(all.get('automation-record-trigger')!)
const app = express()
app.use('/api/multitable/plm-record-ingress', createPlmRecordIngressBodyParser()!)
app.use('/api/multitable', createPlmRecordIngressRouter()!)
const server = app.listen(0, '127.0.0.1')
await new Promise<void>(resolve => server.once('listening', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('listener unavailable')
await writeFile(process.env.W21_READY_FILE, JSON.stringify({ port: address.port, token, binding }), { mode: 0o600 })
console.log('W21_READY')

async function snapshot() {
  const result: Record<string, unknown> = {}
  for (const table of ['meta_records','meta_plm_record_inbox','meta_plm_record_rows','meta_record_revisions',
    'meta_record_history_operations','oapi_write_audit','meta_automation_outbox','meta_automation_event_fires','multitable_automation_executions']) {
    result[table] = (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n
  }
  result.records = (await pool.query('SELECT id,data,version FROM meta_records ORDER BY id')).rows
  result.executions = (await pool.query('SELECT rule_id,status,error,steps FROM multitable_automation_executions ORDER BY triggered_at')).rows
  result.consumers = (await pool.query('SELECT consumer_key,status,count(*)::int AS n FROM meta_automation_outbox_consumer GROUP BY 1,2 ORDER BY 1,2')).rows
  return result
}
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line)
  try {
    if (command.op === 'drain') for (let i = 0; i < 6; i++) await runDispatchTick(connection, registry)
    else if (command.op === 'revoke') await pool.query("UPDATE multitable_api_tokens SET revoked=$1 WHERE id='w21-token'", [command.value])
    else if (command.op === 'stop') break
    else if (command.op !== 'inspect') throw new Error('unknown owned fixture command')
    console.log('W21_RESULT ' + JSON.stringify(await snapshot()))
  } catch (error) {
    console.log('W21_RESULT ' + JSON.stringify({ error: String(error) }))
  }
}
await new Promise<void>(resolve => server.close(() => resolve()))
await pool.end()
process.exit(0)
