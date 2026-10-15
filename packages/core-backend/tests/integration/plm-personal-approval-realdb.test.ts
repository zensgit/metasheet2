import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { executeDingTalkApprovalCardCallback } from '../../src/integrations/dingtalk/interactive-card-callback'
import { Kysely, PostgresDialect } from 'kysely'
import { up as cards } from '../../src/db/migrations/zzzz20260705120000_create_dingtalk_approval_card_deliveries'
import { up as cardSend } from '../../src/db/migrations/zzzz20260705150100_add_send_columns_to_dingtalk_approval_card_deliveries'
import { up as cardIntegration } from '../../src/db/migrations/zzzz20260709133000_add_integration_id_to_dingtalk_approval_card_deliveries'
import { up as cardOutcome } from '../../src/db/migrations/zzzz20260710150000_add_outcome_unknown_delivery_status'
import { up as cardTaskIndex } from '../../src/db/migrations/zzzz20260710160000_add_task_id_index_to_dingtalk_approval_card_deliveries'
import { up as cardEpoch } from '../../src/db/migrations/zzzz20260711120000_add_entry_epoch_to_dingtalk_approval_card_deliveries'
import { up as outbox } from '../../src/db/migrations/zzzz20260715120000_create_automation_outbox'
import {
  up,
  down,
} from '../../src/db/migrations/zzzz20261015040000_create_plm_personal_approval_cards'
import { PlmPersonalApprovalBindingService } from '../../src/services/PlmPersonalApprovalBindingService'
import {
  PlmPersonalApprovalError,
  type PersonalApprovalTransport,
  type PersonalCommand,
} from '../../src/services/plm-personal-approval-wire'
import { AutomationService } from '../../src/multitable/automation-service'
import { buildDurableConsumerHandlers } from '../../src/multitable/automation-durable-consumer-handlers'
import { eventBus } from '../../src/integration/events/event-bus'
import { PlmPersonalApprovalWorker } from '../../src/services/PlmPersonalApprovalWorker'
if (!process.env.DATABASE_URL)
  throw new Error('DATABASE_URL required; EXPECT_DB does not skip this whole spec')
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
const sourceTask = {
  task_id: randomUUID(),
  round_id: randomUUID(),
  eco_id: randomUUID(),
  eco_name: 'Synthetic ECO',
  eco_state: 'progress',
  stage_id: randomUUID(),
  stage_name: 'Review',
  approval_type: 'mandatory',
  approval_deadline: null,
  assignee_auth_user_id: '42',
  status: 'pending',
}
const scope = {
  connection_id: 'fixed',
  tenant_id: 'fixture-tenant',
  org_id: 'fixture-org',
  auth_user_id: '42',
}
const grant = `yua_${'a'.repeat(32)}_${'b'.repeat(43)}`
const receipts = new Map<string, unknown>()
let listTasks = [sourceTask],
  sends = 0,
  loseAck = false,
  revoked = false,
  malformed = false
const provider: PersonalApprovalTransport = {
  getEffectiveTenantId: () => scope.tenant_id,
  getEffectiveOrgId: () => scope.org_id,
  personalApprovalManagementUrl: () => 'http://127.0.0.1/personal-approval-grants',
  async personalApprovalRequest(op, _grant, _conn, data, id) {
    if (revoked) throw new PlmPersonalApprovalError(401, 'PLM_CARD_UNAUTHORIZED')
    if (op === 'verify')
      return {
        schema: 'yuantus.plm-approval-personal-binding.v1',
        ...scope,
        grant_id: 'a'.repeat(32),
        expires_at: '2099-01-01T00:00:00Z',
      }
    if (op === 'tasks')
      return malformed
        ? { items: [] }
        : { schema: 'yuantus.plm-approval-card-tasks.v1', ...scope, items: listTasks }
    if (op === 'task') {
      const t = listTasks.find((t) => t.task_id === id) ?? sourceTask
      return {
        schema: 'yuantus.plm-approval-card-task.v1',
        ...scope,
        task: t,
        is_current: listTasks.includes(t),
        is_pending: listTasks.includes(t),
        source: {
          eco_id: t.eco_id,
          eco_state: 'progress',
          stage_id: t.stage_id,
          round_id: t.round_id,
          kanban_state: 'normal',
        },
      }
    }
    if (op === 'receipt') {
      if (!receipts.has(id!)) throw new PlmPersonalApprovalError(404, 'PLM_SOURCE_NOT_FOUND')
      return receipts.get(id!)
    }
    sends++
    const cmd = data as PersonalCommand
    const r = {
      schema: 'yuantus.plm-approval-card-receipt.v1',
      command_id: cmd.command_id,
      delivery_id: cmd.delivery_id,
      connection_id: cmd.connection_id,
      task_id: cmd.task_id,
      round_id: cmd.round_id,
      actor_auth_user_id: '42',
      decision: cmd.decision,
      seat_status: cmd.decision === 'approve' ? 'approved' : 'rejected',
      stage_complete: false,
      source_at_commit: {
        eco_id: sourceTask.eco_id,
        eco_state: 'progress',
        stage_id: sourceTask.stage_id,
        round_id: sourceTask.round_id,
        kanban_state: 'normal',
      },
      committed_at: new Date().toISOString(),
    }
    receipts.set(cmd.command_id, r)
    if (loseAck) throw new PlmPersonalApprovalError(503, 'PLM_PROVIDER_UNAVAILABLE')
    return r
  },
}
const service = new PlmPersonalApprovalBindingService(pool, () => provider)
let bindingId = ''
async function taskAndDelivery(name: string) {
  const t = { ...sourceTask, task_id: randomUUID(), round_id: randomUUID(), eco_name: name }
  listTasks = [...listTasks, t]
  await service.sync('owner', bindingId)
  const p = (
    await pool.query('SELECT * FROM plm_personal_approval_tasks WHERE source_task_id=$1', [
      t.task_id,
    ])
  ).rows[0]
  const id = randomUUID()
  await pool.query(
    `INSERT INTO dingtalk_approval_card_deliveries(id,plm_task_id,node_key,recipient_user_id,recipient_dingtalk_user_id,delivery_kind,entry_epoch,send_status) VALUES($1,$2,$3,'owner','synthetic-ding','work_notice_action_card',$4,'sent')`,
    [id, p.id, t.stage_id, p.entry_epoch],
  )
  return { id, t, p }
}
beforeAll(async () => {
  process.env.PLM_APPROVAL_CARD_ENABLED = 'true'
  process.env.PLM_APPROVAL_CARD_CONNECTION_ID = 'fixed'
  process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = 'true'
  process.env.ENCRYPTION_KEY = 'synthetic-plm-test-material-not-production'
  process.env.ENCRYPTION_SALT = 'synthetic-plm-salt'
  await pool.query(
    "CREATE TABLE users(id text PRIMARY KEY,is_active boolean,name text);INSERT INTO users VALUES('owner',true),('other',true);CREATE TABLE approval_instances(id text PRIMARY KEY);CREATE TABLE directory_integrations(id uuid PRIMARY KEY,provider text,corp_id text);",
  )
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
  await cards(db)
  await cardSend(db)
  await cardIntegration(db)
  await cardOutcome(db)
  await cardTaskIndex(db)
  await cardEpoch(db)
  await outbox(db)
  await up(db)
  await down(db)
  await up(db)
  bindingId = (await service.bind('owner', { connectionId: 'fixed', grant })).id
})
afterAll(() => pool.end())
describe('real PostgreSQL personal PLM binding, projection and command persistence', () => {
  it('encrypts secret, projects only verified metadata and refuses foreign account', async () => {
    const r = (await pool.query('SELECT * FROM plm_personal_approval_bindings')).rows[0]
    expect(r.encrypted_grant).toMatch(/^enc:/)
    expect(r.encrypted_grant).not.toContain(grant)
    expect(JSON.stringify(await service.list('owner'))).not.toContain(grant)
    expect((await service.list('other')).bindings).toEqual([])
    await expect(service.sync('other', bindingId)).rejects.toMatchObject({ status: 404 })
  })
  it('commits one task and durable event once under concurrent complete sync', async () => {
    await Promise.all([service.sync('owner', bindingId), service.sync('owner', bindingId)])
    expect(
      (await pool.query('SELECT count(*)::int n FROM plm_personal_approval_tasks')).rows[0].n,
    ).toBe(1)
    expect((await pool.query('SELECT count(*)::int n FROM meta_automation_outbox')).rows[0].n).toBe(
      1,
    )
  })
  it('failed or malformed traversal never withdraws current tasks', async () => {
    malformed = true
    try {
      await expect(service.sync('owner', bindingId)).rejects.toThrow()
      expect(
        (await pool.query('SELECT active FROM plm_personal_approval_tasks LIMIT 1')).rows[0].active,
      ).toBe(true)
    } finally {
      malformed = false
    }
  })
  it('SQL event failure rolls projection back', async () => {
    await pool.query(
      "CREATE FUNCTION fail_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$;CREATE TRIGGER fail_event BEFORE INSERT ON meta_automation_outbox FOR EACH ROW EXECUTE FUNCTION fail_event()",
    )
    const prior = listTasks
    listTasks = [{ ...sourceTask, task_id: randomUUID() }]
    try {
      await expect(service.sync('owner', bindingId)).rejects.toThrow()
      expect(
        (await pool.query('SELECT count(*)::int n FROM plm_personal_approval_tasks')).rows[0].n,
      ).toBe(1)
    } finally {
      listTasks = prior
      await pool.query(
        'DROP TRIGGER fail_event ON meta_automation_outbox;DROP FUNCTION fail_event()',
      )
    }
  })
  it('default off causes no provider/DB work in worker', async () => {
    process.env.PLM_APPROVAL_CARD_ENABLED = 'false'
    try {
      const worker = new PlmPersonalApprovalWorker(service)
      await worker.start()
      expect(await worker.tick()).toBe(0)
      await worker.stop()
    } finally {
      process.env.PLM_APPROVAL_CARD_ENABLED = 'true'
    }
  })
  it('concurrent identical callbacks commit one immutable command and one source decision', async () => {
    const d = await taskAndDelivery('duplicate'),
      before = sends
    await Promise.all([
      service.execute(d.id, 'owner', 'approve'),
      service.execute(d.id, 'owner', 'approve'),
    ])
    expect(sends - before).toBe(1)
    const row = (
      await pool.query('SELECT * FROM plm_personal_approval_commands WHERE delivery_id=$1', [d.id])
    ).rows[0]
    expect(row.receipt.stage_complete).toBe(false)
    expect(row.receipt.source_at_commit.eco_state).toBe('progress')
    await expect(service.execute(d.id, 'owner', 'reject', 'changed')).rejects.toMatchObject({
      status: 409,
    })
    await expect(
      pool.query("UPDATE plm_personal_approval_commands SET subject_id='other' WHERE id=$1", [
        row.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' })
  })
  it('remote commit lost ACK retains intent, unbind destroys secret, same-person rebind reconciles receipt only', async () => {
    const d = await taskAndDelivery('lost-ack')
    loseAck = true
    try {
      await expect(service.execute(d.id, 'owner', 'approve')).rejects.toMatchObject({ status: 503 })
    } finally {
      loseAck = false
    }
    const before = sends
    expect(
      (
        await pool.query('SELECT state FROM plm_personal_approval_commands WHERE delivery_id=$1', [
          d.id,
        ])
      ).rows[0].state,
    ).toBe('pending')
    await service.unbind('owner', bindingId)
    expect(
      (
        await pool.query('SELECT encrypted_grant FROM plm_personal_approval_bindings WHERE id=$1', [
          bindingId,
        ])
      ).rows[0].encrypted_grant,
    ).toBeNull()
    await expect(service.reconcile('owner', bindingId)).rejects.toMatchObject({ status: 409 })
    await service.bind('owner', { connectionId: 'fixed', grant })
    const result = await service.reconcile('owner', bindingId)
    expect(result.settled).toBe(1)
    expect(sends).toBe(before)
  })
  it('settlement SQL failure leaves recoverable same-key intent', async () => {
    const d = await taskAndDelivery('settle-fail')
    await pool.query(
      "CREATE FUNCTION fail_settle() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$;CREATE TRIGGER fail_settle BEFORE UPDATE ON plm_personal_approval_commands FOR EACH ROW EXECUTE FUNCTION fail_settle()",
    )
    try {
      await expect(service.execute(d.id, 'owner', 'approve')).rejects.toThrow()
    } finally {
      await pool.query(
        'DROP TRIGGER fail_settle ON plm_personal_approval_commands;DROP FUNCTION fail_settle()',
      )
    }
    const before = sends
    expect((await service.reconcile('owner', bindingId)).settled).toBe(1)
    expect(sends).toBe(before)
  })
  it('receipt absence never makes reconciliation dispatch; revoked grant never settles', async () => {
    const d = await taskAndDelivery('no-receipt')
    const original = provider.personalApprovalRequest
    provider.personalApprovalRequest = async (op, ...args) => {
      if (op === 'command') throw new PlmPersonalApprovalError(503, 'PLM_PROVIDER_UNAVAILABLE')
      return original(op, ...args)
    }
    try {
      await expect(service.execute(d.id, 'owner', 'approve')).rejects.toThrow()
    } finally {
      provider.personalApprovalRequest = original
    }
    const before = sends
    expect((await service.reconcile('owner', bindingId)).admissionRequired).toBe(1)
    expect(sends).toBe(before)
    revoked = true
    try {
      expect((await service.reconcile('owner', bindingId)).pending).toBe(1)
      expect(sends).toBe(before)
    } finally {
      revoked = false
    }
  })
  it('wrong recipient, stale source round and missing reject comment refuse before send', async () => {
    const d = await taskAndDelivery('stale'),
      before = sends
    await expect(service.execute(d.id, 'other', 'approve')).rejects.toMatchObject({ status: 404 })
    listTasks = listTasks.filter((t) => t.task_id !== d.t.task_id)
    await expect(service.execute(d.id, 'owner', 'approve')).rejects.toMatchObject({ status: 409 })
    const d2 = await taskAndDelivery('blank-reject')
    await expect(service.execute(d2.id, 'owner', 'reject', ' ')).rejects.toThrow()
    expect(sends).toBe(before)
  })
  it('real persisted task event reaches durable consumer and existing sender exactly once', async () => {
    const integration = randomUUID()
    await pool.query(
      `CREATE TABLE directory_accounts(id uuid PRIMARY KEY,integration_id uuid,provider text,external_user_id text,is_active boolean,updated_at timestamptz,corp_id text);CREATE TABLE directory_account_links(directory_account_id uuid,local_user_id text,link_status text);`,
    )
    const account = randomUUID()
    await pool.query("INSERT INTO directory_integrations VALUES($1,'dingtalk','synthetic-corp')", [
      integration,
    ])
    await pool.query(
      "INSERT INTO directory_accounts VALUES($1,$2,'dingtalk','synthetic-ding',true,now(),'synthetic-corp')",
      [account, integration],
    )
    await pool.query("INSERT INTO directory_account_links VALUES($1,'owner','linked')", [account])
    Object.assign(process.env, {
      PUBLIC_APP_URL: 'https://synthetic.invalid',
      APPROVAL_CARD_LINK_SECRET: 'synthetic-card-link-secret',
      DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED: 'true',
      DINGTALK_INTERACTIVE_CARD_CLIENT_ID: 'synthetic-client',
      DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET: 'synthetic-secret',
      DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID: 'synthetic-template',
      DINGTALK_INTERACTIVE_CARD_STREAM_INTEGRATION_ID: integration,
    })
    const t = {
      ...sourceTask,
      task_id: randomUUID(),
      round_id: randomUUID(),
      eco_name: 'actual sender',
    }
    listTasks = [...listTasks, t]
    await service.sync('owner', bindingId)
    const row = (
      await pool.query(
        "SELECT * FROM meta_automation_outbox WHERE payload->'task'->>'plmTaskId'=(SELECT id::text FROM plm_personal_approval_tasks WHERE source_task_id=$1)",
        [t.task_id],
      )
    ).rows[0]
    const fetch = vi.fn(
      async (url: unknown) =>
        new Response(
          JSON.stringify(
            String(url).includes('gettoken')
              ? { errcode: 0, access_token: 'synthetic-access', expires_in: 7200 }
              : {
                  success: true,
                  result: { taskId: 'synthetic-card-task', deliverResults: [{ success: true }] },
                },
          ),
          { status: 200 },
        ),
    )
    const automation = new AutomationService(
      eventBus,
      new Kysely({ dialect: new PostgresDialect({ pool }) }) as never,
      pool.query.bind(pool),
      fetch as typeof globalThis.fetch,
      null,
      {},
      undefined,
      service,
    )
    const noop = async () => {}
    const handlers = buildDurableConsumerHandlers({
      automationService: automation,
      projectionService: { reconcile: noop },
      webhookService: { deliverEvent: noop },
      recordApprovalService: { handleApprovalCompletion: noop },
      todoMirrorService: { handleApprovalTaskCreated: noop, handleApprovalCompletion: noop },
    })
    const claimed = {
      eventType: row.event_type,
      eventId: row.event_id,
      payload: row.payload,
      automationDepth: 0,
    } as never
    await handlers['approval-task-trigger'](claimed)
    const calls = fetch.mock.calls.length
    expect(calls).toBe(2)
    await handlers['approval-task-trigger'](claimed)
    expect(fetch.mock.calls.length).toBe(calls)
    const delivery = (
      await pool.query('SELECT * FROM dingtalk_approval_card_deliveries WHERE plm_task_id=$1', [
        row.payload.task.plmTaskId,
      ])
    ).rows[0]
    expect(delivery.instance_id).toBeNull()
    expect(delivery.send_status).toBe('sent')
    expect(delivery.recipient_user_id).toBe('owner')
    process.env.PLM_APPROVAL_CARD_ENABLED = 'false'
    try {
      await expect(handlers['approval-task-trigger'](claimed)).rejects.toThrow('PLM_CARD_DISABLED')
      expect(fetch.mock.calls.length).toBe(calls)
    } finally {
      process.env.PLM_APPROVAL_CARD_ENABLED = 'true'
    }
    const bad = { ...row.payload, task: { ...row.payload.task, assigneeUserId: 'other' } }
    await expect(
      handlers['approval-task-trigger']({ ...(claimed as object), payload: bad } as never),
    ).rejects.toThrow()
    expect(fetch.mock.calls.length).toBe(calls)
    const callbackDeps = {
      query: pool.query.bind(pool),
      approvals: { dispatchAction: vi.fn() },
      plmPersonalCards: service,
      cardUpdateSender: async () => {},
    }
    const wrong = await executeDingTalkApprovalCardCallback(callbackDeps, {
      outTrackId: delivery.id,
      action: 'approve',
      operatorDingTalkUserId: 'synthetic-ding',
      eventCorpId: 'other-corp',
    })
    expect(wrong.outcome).toBe('operator_unresolved')
    expect(callbackDeps.approvals.dispatchAction).not.toHaveBeenCalled()
    const approved = await executeDingTalkApprovalCardCallback(callbackDeps, {
      outTrackId: delivery.id, action: 'approve', operatorDingTalkUserId: 'synthetic-ding', eventCorpId: 'synthetic-corp',
    })
    expect(approved.outcome).toBe('executed')
    expect(callbackDeps.approvals.dispatchAction).not.toHaveBeenCalled()
    const pendingTask = { ...sourceTask, task_id: randomUUID(), round_id: randomUUID() }
    listTasks.push(pendingTask)
    await service.sync('owner', bindingId)
    const pendingEvent = (
      await pool.query(
        "SELECT payload,event_type,event_id FROM meta_automation_outbox WHERE payload->'task'->>'plmTaskId'=(SELECT id::text FROM plm_personal_approval_tasks WHERE source_task_id=$1)",
        [pendingTask.task_id],
      )
    ).rows[0]
    await service.unbind('owner', bindingId)
    await expect(
      handlers['approval-task-trigger']({
        eventType: pendingEvent.event_type,
        eventId: pendingEvent.event_id,
        payload: pendingEvent.payload,
        automationDepth: 0,
      } as never),
    ).rejects.toMatchObject({ code: 'PLM_BINDING_REQUIRED' })
    expect(fetch.mock.calls.length).toBe(calls)
    await service.bind('owner', { connectionId: 'fixed', grant })
  })
  it('retries a definitely undelivered personal card after transport recovery without duplicating a sent card', async () => {
    const task = { ...sourceTask, task_id: randomUUID(), round_id: randomUUID() }
    listTasks.push(task)
    await service.sync('owner', bindingId)
    const row = (await pool.query("SELECT * FROM meta_automation_outbox WHERE payload->'task'->>'plmTaskId'=(SELECT id::text FROM plm_personal_approval_tasks WHERE source_task_id=$1)", [task.task_id])).rows[0]
    const fetch = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 429 })).mockImplementation(async (url: unknown) => new Response(JSON.stringify(
      String(url).includes('gettoken') ? { errcode: 0, access_token: 'synthetic-recovered-access', expires_in: 7200 } : { success: true, result: { taskId: 'synthetic-recovered-card', deliverResults: [{ success: true }] } },
    ), { status: 200 }))
    const automation = new AutomationService(eventBus, new Kysely({ dialect: new PostgresDialect({ pool }) }) as never, pool.query.bind(pool), fetch as typeof globalThis.fetch, null, {}, undefined, service)
    await expect(automation.handleApprovalTaskCreatedTrigger(row.payload)).rejects.toThrow('PLM_CARD_DELIVERY_UNCONFIRMED')
    const failed = (await pool.query('SELECT * FROM dingtalk_approval_card_deliveries WHERE plm_task_id=$1', [row.payload.task.plmTaskId])).rows[0]
    expect(failed.send_status).toBe('failed')
    await automation.handleApprovalTaskCreatedTrigger(row.payload)
    const recovered = (await pool.query('SELECT * FROM dingtalk_approval_card_deliveries WHERE plm_task_id=$1', [row.payload.task.plmTaskId])).rows
    expect(recovered).toHaveLength(1)
    expect(recovered[0].id).toBe(failed.id)
    expect(recovered[0].send_status).toBe('sent')
    const calls = fetch.mock.calls.length
    await automation.handleApprovalTaskCreatedTrigger(row.payload)
    expect(fetch.mock.calls).toHaveLength(calls)
  })
  it('does not resend an OA card whose successful send was followed by a ledger SQL failure', async () => {
    vi.stubEnv('DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED', 'false')
    vi.stubEnv('DINGTALK_APP_KEY', 'synthetic-oa-key')
    vi.stubEnv('DINGTALK_APP_SECRET', 'synthetic-oa-secret')
    vi.stubEnv('DINGTALK_AGENT_ID', '123456')
    const task = { ...sourceTask, task_id: randomUUID(), round_id: randomUUID() }
    listTasks.push(task)
    await service.sync('owner', bindingId)
    const row = (await pool.query("SELECT * FROM meta_automation_outbox WHERE payload->'task'->>'plmTaskId'=(SELECT id::text FROM plm_personal_approval_tasks WHERE source_task_id=$1)", [task.task_id])).rows[0]
    const fetch = vi.fn(async (url: unknown) => new Response(JSON.stringify(String(url).includes('gettoken') ? { errcode:0,access_token:'synthetic-oa-access',expires_in:7200 } : { errcode:0,task_id:1234 }), { status:200 }))
    const automation = new AutomationService(eventBus, new Kysely({ dialect: new PostgresDialect({ pool }) }) as never, pool.query.bind(pool), fetch as typeof globalThis.fetch, null, {}, undefined, service)
    await pool.query("CREATE SEQUENCE fixture_card_sent_failure; CREATE FUNCTION fixture_card_sent_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.send_status='sent' AND OLD.send_status='pending' THEN IF nextval('fixture_card_sent_failure')=1 THEN RAISE EXCEPTION 'synthetic post-send SQL failure'; END IF; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_card_sent_failure BEFORE UPDATE ON dingtalk_approval_card_deliveries FOR EACH ROW EXECUTE FUNCTION fixture_card_sent_failure()")
    try {
      await expect(automation.handleApprovalTaskCreatedTrigger(row.payload)).rejects.toThrow('PLM_CARD_DELIVERY_UNCONFIRMED')
      await automation.handleApprovalTaskCreatedTrigger(row.payload)
      expect(fetch.mock.calls.filter(([url]) => String(url).includes('asyncsend'))).toHaveLength(1)
      expect((await pool.query('SELECT send_status FROM dingtalk_approval_card_deliveries WHERE plm_task_id=$1', [row.payload.task.plmTaskId])).rows[0].send_status).toBe('outcome_unknown')
    } finally {
      await pool.query('DROP TRIGGER fixture_card_sent_failure ON dingtalk_approval_card_deliveries; DROP FUNCTION fixture_card_sent_failure(); DROP SEQUENCE fixture_card_sent_failure')
      vi.unstubAllEnvs()
    }
  })
  it('rotates receipt reconciliation past 100 absent receipts without issuing decisions', async () => {
    let target = ''
    const before = sends
    for (let n = 1; n <= 101; n++) {
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
      const taskId = randomUUID(), deliveryId = randomUUID(), sourceId = randomUUID(), round = randomUUID()
      const command = { schema: 'yuantus.plm-approval-card-command.v1', command_id: id, connection_id: 'fixed', delivery_id: deliveryId, task_id: sourceId, round_id: round, decision: 'approve', comment: null }
      await pool.query("INSERT INTO plm_personal_approval_tasks(id,binding_id,source_task_id,source_round_id,source_eco_id,source_stage_id,task) VALUES($1,$2,$3,$4,$5,$6,$7)", [taskId,bindingId,sourceId,round,sourceTask.eco_id,sourceTask.stage_id,{eco_name:'synthetic receipt backlog'}])
      await pool.query("INSERT INTO dingtalk_approval_card_deliveries(id,plm_task_id,node_key,recipient_user_id,recipient_dingtalk_user_id,delivery_kind,entry_epoch,send_status) SELECT $1,id,source_stage_id,'owner','synthetic-ding','work_notice_action_card',entry_epoch,'sent' FROM plm_personal_approval_tasks WHERE id=$2", [deliveryId,taskId])
      await pool.query("INSERT INTO plm_personal_approval_commands(id,delivery_id,task_id,binding_id,subject_id,connection_id,tenant_id,org_id,original_grant_id,command,request_hash,created_at) VALUES($1,$2,$3,$4,'42','fixed',$5,$6,$7,$8,'synthetic-hash','2000-01-01'::timestamptz + $9 * interval '1 second')", [id,deliveryId,taskId,bindingId,scope.tenant_id,scope.org_id,'a'.repeat(32),command,n])
      if (n === 101) {
        target = id
        receipts.set(id, { schema:'yuantus.plm-approval-card-receipt.v1', command_id:id, delivery_id:deliveryId,connection_id:'fixed',task_id:sourceId,round_id:round,actor_auth_user_id:'42',decision:'approve',seat_status:'approved',stage_complete:false,source_at_commit:{eco_id:sourceTask.eco_id,eco_state:'progress',stage_id:sourceTask.stage_id,round_id:round,kanban_state:'normal'},committed_at:new Date().toISOString() })
      }
    }
    for (let n = 0; n < 3; n++) await service.reconcile('owner', bindingId)
    expect((await pool.query('SELECT state FROM plm_personal_approval_commands WHERE id=$1', [target])).rows[0].state).toBe('settled')
    expect(sends).toBe(before)
  }, 30000)
  it('downgrade refuses a concurrent binding writer before inspecting retained evidence', async () => {
    const writer = await pool.connect()
    try {
      await writer.query('BEGIN')
      await writer.query('UPDATE plm_personal_approval_bindings SET updated_at=now() WHERE id=$1', [bindingId])
      await expect(down(new Kysely({ dialect: new PostgresDialect({ pool }) }))).rejects.toMatchObject({ code: '55P03' })
    } finally {
      await writer.query('ROLLBACK')
      writer.release()
    }
    expect((await pool.query('SELECT id FROM plm_personal_approval_bindings WHERE id=$1', [bindingId])).rowCount).toBe(1)
  })
  it('source XOR and retained evidence prevent invalid cards and destructive downgrade', async () => {
    await expect(
      pool.query(
        "INSERT INTO dingtalk_approval_card_deliveries(id,node_key,recipient_user_id,recipient_dingtalk_user_id,delivery_kind) VALUES('invalid','node','owner','ding','work_notice_action_card')",
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(down(new Kysely({ dialect: new PostgresDialect({ pool }) }))).rejects.toThrow(
      'plm_personal_evidence_present',
    )
  })
})
