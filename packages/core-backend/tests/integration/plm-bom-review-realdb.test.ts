import { registerChangeCrossprocess } from '../plm-bom-review/change-crossprocess'
import { up as listenerUp, down as listenerDown } from '../../src/db/migrations/zzzz20261015010000_add_plm_change_listeners'
import { up as changeDispatchUp, down as changeDispatchDown } from '../../src/db/migrations/zzzz20261014080000_dispatch_plm_change_events'
import { up as changeInboxUp, down as changeInboxDown } from '../../src/db/migrations/zzzz20261014070000_add_plm_change_inbox'
import { registerBomReviewRealAuthHttpTests } from '../plm-bom-review/auth-http'
import { registerBomReviewNativeHttpTests } from '../plm-bom-review/native-http'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { Pool, Client } from 'pg'
import { randomUUID, createHmac } from 'crypto'
import { createServer } from 'http'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'
import { EventEmitter } from 'events'
import { Kysely, PostgresDialect } from 'kysely'
import { bootstrapPlmBomReviewTestDb } from '../plm-bom-review/bootstrap'
import { shareSnapshot } from '../plm-bom-review/fixture'
import {
  PlmBomReviewService,
  type BomReviewPool,
} from '../../src/multitable/plm-bom-review-service'
import {
  down,
  up,
} from '../../src/db/migrations/zzzz20261002010000_create_plm_bom_reviews'
import {
  up as ownerViewUp,
  down as ownerViewDown,
} from '../../src/db/migrations/zzzz20261002020000_add_plm_bom_owner_view_initialized'
import { up as reviewStatesUp, down as reviewStatesDown } from '../../src/db/migrations/zzzz20261014010000_add_plm_bom_review_states'
import {
  createSheet,
  createView,
  ensureFields,
  getObjectSheetId,
  getObjectViewId,
  getObjectFieldId,
} from '../../src/multitable/provisioning'
import {
  LOCAL_FIELDS,
  SOURCE_FIELDS,
} from '../../src/multitable/plm-bom-review-wire'
import { up as completionUp, down as completionDown } from '../../src/db/migrations/zzzz20261014020000_add_plm_bom_completion_events'
import { up as statusViewsUp, down as statusViewsDown } from '../../src/db/migrations/zzzz20261014030000_add_plm_bom_status_views_initialized'
import { up as rowEventsUp, down as rowEventsDown } from '../../src/db/migrations/zzzz20261014040000_add_plm_bom_row_completion_events'
import { up as completionIntentsUp, down as completionIntentsDown } from '../../src/db/migrations/zzzz20261014050000_add_plm_bom_completion_intents'
import { up as completionAttemptsUp, down as completionAttemptsDown } from '../../src/db/migrations/zzzz20261014060000_add_plm_bom_completion_attempts'
import { RecordService } from '../../src/multitable/record-service'
import { recordConfigRevision } from '../../src/multitable/config-revision-recorder'
import { PlmBomNotificationWorker } from '../../src/multitable/plm-bom-notification-worker'
import { resolveSheetCapabilitiesForUserOnQuery } from '../../src/services/approval-record-link-txn-auth'
if (!process.env.DATABASE_URL)
  throw new Error(
    'DATABASE_URL required: isolated disposable database only; EXPECT_DB cannot skip-green',
  )
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
const tx: BomReviewPool = {
  query: pool.query.bind(pool),
  async transaction(fn) {
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      const r = await fn({ query: c.query.bind(c) })
      await c.query('COMMIT')
      return r
    } catch (e) {
      await c.query('ROLLBACK')
      throw e
    } finally {
      c.release()
    }
  },
}
const config = {
  id: 'ds',
  name: 'Y',
  type: 'plm',
  connection: { baseUrl: 'https://synthetic.invalid' },
  credentials: { token: 'synthetic-no-network' },
  options: {},
  poolConfig: undefined,
}
let sourceCalls = 0
let current = shareSnapshot(),
  onFetch: (() => Promise<void>) | undefined
const adapter = {
  getConfig: () => config,
  getBomShareContext: async () => {
    sourceCalls += 1
    if (onFetch) await onFetch()
    return structuredClone(current)
  },
  getEffectiveTenantId: () => 't',
  getEffectiveOrgId: () => 'o',
}
const service = new PlmBomReviewService({
  pool: tx,
  dataSourceManager: { getDataSource: () => adapter as never },
})
let b: any, preview: any, requestId: string
async function counts() {
  return Promise.all(
    [
      'meta_sheets',
      'meta_views',
      'meta_records',
      'meta_plm_bom_review_bindings',
      'meta_plm_bom_review_syncs',
      'meta_record_revisions',
      'meta_record_history_operations',
      'meta_config_revisions',
      'meta_automation_outbox',
    ].map(
      async (t) =>
        (await pool.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n,
    ),
  )
}
async function makePreview() {
  return service.preview('owner', {
    dataSourceId: 'ds',
    partId: 'P',
    baseId: 'base',
    name: 'Review',
  })
}
async function binding() {
  return (
    await pool.query('SELECT * FROM meta_plm_bom_review_bindings WHERE id=$1', [
      b.id,
    ])
  ).rows[0]
}
async function child() {
  return (
    await pool.query(
      "SELECT r.* FROM meta_records r JOIN meta_plm_bom_review_rows p ON p.record_id=r.id WHERE p.binding_id=$1 AND p.bom_line_id='RC'",
      [b.id],
    )
  ).rows[0]
}
beforeAll(async () => {
  process.env.PLM_BOM_REVIEW_ENABLED = 'true'
  process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = 'true'
  process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
  await bootstrapPlmBomReviewTestDb(pool)
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
  await listenerDown(db)
  await changeDispatchDown(db)
  await changeInboxDown(db)
  await completionAttemptsDown(db)
  await completionIntentsDown(db)
  await rowEventsDown(db)
  await statusViewsDown(db)
  await completionDown(db)
  await reviewStatesDown(db)
  await ownerViewDown(db)
  await down(db)
  await up(db)
  await ownerViewUp(db)
  await reviewStatesUp(db)
  await completionUp(db)
  await statusViewsUp(db)
  await rowEventsUp(db)
  await completionIntentsUp(db)
  await completionAttemptsUp(db)
  await changeInboxUp(db)
  await changeDispatchUp(db)
  await listenerUp(db)
  await pool.query(
    "INSERT INTO users VALUES('owner',true,'user','activated',true,'{}'),('member',true,'user','activated',true,'{}'),('outsider',true,'user','activated',true,'{}'); INSERT INTO meta_bases(id,name,owner_id) VALUES('base','Team','owner')",
  )
  await pool.query(
    "INSERT INTO data_sources(id,name,type,config,owner_id,is_active,scope_kind) VALUES('ds','Y','plm',$1::jsonb,'owner',true,'user')",
    [
      JSON.stringify({
        connection: config.connection,
        credentials: config.credentials,
        options: config.options,
      }),
    ],
  )
})
afterAll(async () => {
  await pool.end()
  // Real auth/RBAC share this native pool across the dedicated HTTP verification groups.
  const { poolManager } = await import(
    '../../src/integration/db/connection-pool'
  )
  await poolManager.close()
})
describe('actual PG native BOM collaboration', () => {
  it('source owner and target base authority are independent; no network for forbidden target', async () => {
    expect((await service.bases('owner')).items).toHaveLength(1)
    expect((await service.bases('outsider')).items).toHaveLength(0)
    await expect(
      service.preview('outsider', {
        dataSourceId: 'ds',
        partId: 'P',
        baseId: 'base',
        name: 'X',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('native reserved e-learning Base rejects even a global writer', async () => {
    const reserved = 'base_el_stats_' + 'a'.repeat(32)
    await pool.query(
      'INSERT INTO meta_bases(id,name,owner_id) VALUES($1,$2,$3)',
      [reserved, 'Synthetic system base', 'outsider'],
    )
    await pool.query(
      "INSERT INTO user_permissions(user_id,permission_code) VALUES('owner','multitable:write')",
    )
    try {
      expect(
        (await service.bases('owner')).items.map((x: any) => x.id),
      ).not.toContain(reserved)
      await expect(
        service.preview('owner', {
          dataSourceId: 'ds',
          partId: 'P',
          baseId: reserved,
          name: 'Forbidden system child',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    } finally {
      await pool.query("DELETE FROM user_permissions WHERE user_id='owner'")
      await pool.query('DELETE FROM meta_bases WHERE id=$1', [reserved])
    }
  })
  it('confirmed server receipt creates native sheet, creator grant, 3 logical rows and 4 occurrences atomically', async () => {
    preview = await makePreview()
    requestId = randomUUID()
    const out = await Promise.all([
      service.create('owner', { previewId: preview.previewId, requestId }),
      service.create('owner', { previewId: preview.previewId, requestId }),
    ])
    b = out[0]
    expect(out[1]).toEqual(b)
    expect(b).toMatchObject({
      lineCount: 3,
      occurrenceCount: 4,
      status: 'active',
      canRefresh: true,
    })
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM meta_fields WHERE sheet_id=$1',
          [b.sheetId],
        )
      ).rows[0].n,
    ).toBe(22)
    const statusField = (
      await pool.query('SELECT type,property FROM meta_fields WHERE id=$1 AND sheet_id=$2', [
        getObjectFieldId('plm-bom-review', preview.previewId, 'status'),
        b.sheetId,
      ])
    ).rows[0]
    expect(statusField).toMatchObject({
      type: 'select',
      property: {
        options: [
          { value: '待评审' },
          { value: '评审中' },
          { value: '有问题' },
          { value: '已完成' },
        ],
      },
    })
    expect(
      (
        await pool.query(
          'SELECT subject_id,perm_code FROM spreadsheet_permissions WHERE sheet_id=$1',
          [b.sheetId],
        )
      ).rows,
    ).toEqual([{ subject_id: 'owner', perm_code: 'spreadsheet:admin' }])
    const stored = await binding(),
      row = await child()
    expect(
      JSON.parse(row.data[stored.fields.occurrences]).map(
        (o: any) => o.relations,
      ),
    ).toEqual([
      ['RA1', 'RC'],
      ['RA2', 'RC'],
    ])
    expect(
      (await pool.query('SELECT source FROM meta_record_revisions')).rows.every(
        (r) => r.source === 'system_sync',
      ),
    ).toBe(true)
    expect(
      (await pool.query('SELECT count(*)::int n FROM meta_automation_outbox'))
        .rows[0].n,
    ).toBe(0)
    const before = await counts()
    expect(
      await service.create('owner', {
        previewId: preview.previewId,
        requestId,
      }),
    ).toEqual(b)
    expect(await counts()).toEqual(before)
    await expect(
      service.create('owner', {
        previewId: preview.previewId,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'BINDING_CONFLICT' })
  })
  it('enforces review transitions even for direct writes and preserves source-sync initial state in revisions', async () => {
    const field = getObjectFieldId('plm-bom-review', preview.previewId, 'status')
    const row = await child()
    expect(row.data[field]).toBe('待评审')
    const revision = (await pool.query(
      'SELECT snapshot,patch FROM meta_record_revisions WHERE record_id=$1 ORDER BY version LIMIT 1',
      [row.id],
    )).rows[0]
    expect(revision.snapshot[field]).toBe('待评审')
    expect(revision.patch[field]).toBe('待评审')
    const write = (value: unknown) => pool.query(
      'UPDATE meta_records SET data=jsonb_set(data,ARRAY[$1],$2::jsonb) WHERE id=$3',
      [field, JSON.stringify(value), row.id],
    )
    for (const bad of ['已完成', '有问题', '', null, { value: '评审中' }])
      await expect(write(bad)).rejects.toMatchObject({ code: '23514' })
    expect((await child()).data[field]).toBe('待评审')
    for (const state of ['评审中', '有问题', '评审中', '已完成', '评审中', '有问题', '已完成'])
      await write(state)
    await expect(write('待评审')).rejects.toMatchObject({ code: '23514' })
    const shadow = await pool.connect()
    try {
      await shadow.query('CREATE TEMP TABLE meta_plm_bom_review_state_fields(binding_id uuid,field_id text)')
      await expect(shadow.query('UPDATE public.meta_records SET data=jsonb_set(data,ARRAY[$1],to_jsonb($2::text)) WHERE id=$3',
        [field, '待评审', row.id])).rejects.toMatchObject({ code: '23514' })
      await expect(shadow.query("UPDATE public.meta_fields SET property='{}'::jsonb WHERE id=$1", [field]))
        .rejects.toMatchObject({ code: '23514' })
      await shadow.query('BEGIN')
      try {
        await shadow.query('ALTER FUNCTION public.meta_bom_review_state_guard() RESET search_path')
        await shadow.query('UPDATE public.meta_records SET data=jsonb_set(data,ARRAY[$1],to_jsonb($2::text)) WHERE id=$3',
          [field, '待评审', row.id])
        expect((await shadow.query('SELECT data FROM public.meta_records WHERE id=$1', [row.id])).rows[0].data[field])
          .toBe('待评审')
      } finally {
        await shadow.query('ROLLBACK')
      }
    } finally {
      await shadow.query('DROP TABLE pg_temp.meta_plm_bom_review_state_fields')
      shadow.release()
    }
    await createSheet({ query: pool.query.bind(pool), sheetId: 'state-unmanaged', baseId: 'base', name: 'Unmanaged' })
    await pool.query("INSERT INTO meta_records(id,sheet_id,data) VALUES('state-unmanaged-record','state-unmanaged','{}')")
    await expect(pool.query('UPDATE meta_records SET sheet_id=$1 WHERE id=$2', [b.sheetId, 'state-unmanaged-record']))
      .rejects.toMatchObject({ code: '23514' })
    await pool.query("DELETE FROM meta_records WHERE id='state-unmanaged-record'")
    await pool.query("DELETE FROM meta_sheets WHERE id='state-unmanaged'")
    await expect(pool.query('UPDATE meta_records SET data=data-$1 WHERE id=$2', [field,row.id]))
      .rejects.toMatchObject({ code: '23514' })
    await expect(pool.query('INSERT INTO meta_plm_bom_review_state_fields(binding_id,field_id,owner_field_id,due_field_id) VALUES($1,$2,$3,$4)',
      [b.id,(await binding()).fields.quantity,getObjectFieldId('plm-bom-review', preview.previewId, 'owner'),getObjectFieldId('plm-bom-review', preview.previewId, 'due_date')])).rejects.toMatchObject({ code: '23514' })
    await expect(pool.query('DELETE FROM meta_plm_bom_review_state_fields WHERE field_id=$1', [field]))
      .rejects.toMatchObject({ code: '23514' })
    await expect(pool.query('TRUNCATE meta_plm_bom_review_state_fields'))
      .rejects.toMatchObject({ code: '23514' })
    await expect(pool.query("UPDATE meta_fields SET property='{}'::jsonb WHERE id=$1", [field]))
      .rejects.toMatchObject({ code: '23514' })
    expect((await child()).data[field]).toBe('已完成')
    const control = await pool.connect()
    try {
      await control.query('BEGIN')
      await control.query('ALTER TABLE meta_records DISABLE TRIGGER meta_bom_review_state_guard')
      await control.query('UPDATE meta_records SET data=jsonb_set(data,ARRAY[$1],to_jsonb($2::text)) WHERE id=$3',
        [field, '待评审', row.id])
      expect((await control.query('SELECT data FROM meta_records WHERE id=$1', [row.id])).rows[0].data[field])
        .toBe('待评审')
    } finally {
      await control.query('ROLLBACK')
      control.release()
    }
    await expect(write('待评审')).rejects.toMatchObject({ code: '23514' })
  })
  it('records issue-time owners atomically, stops on completion and opens an independent round on reopen', async () => {
    const p = await makePreview()
    const local = await service.create('owner', { previewId: p.previewId, requestId: randomUUID() })
    const row = (await pool.query('SELECT r.* FROM meta_records r JOIN meta_plm_bom_review_rows l ON l.record_id=r.id WHERE l.binding_id=$1 AND l.bom_line_id=$2',
      [local.id, 'RC'])).rows[0]
    const field = getObjectFieldId('plm-bom-review', p.previewId, 'status')
    const owner = getObjectFieldId('plm-bom-review', p.previewId, 'owner')
    const rounds = async () => (await pool.query(
      'SELECT * FROM meta_plm_bom_review_rounds WHERE record_id=$1 ORDER BY round', [row.id],
    )).rows
    const write = (data: Record<string, unknown>) => pool.query(
      'UPDATE meta_records SET data=data||$1::jsonb,version=version+1 WHERE id=$2 RETURNING version',
      [JSON.stringify(data),row.id],
    )
    await write({ [field]: '评审中', [owner]: ['owner'] })
    const opened = (await rounds()).at(-1)
    expect(opened.issue_started_at).toBeNull()
    expect(opened.completed_at).toBeNull()
    const version = (await write({ [field]: '有问题' })).rows[0].version
    const issue = (await rounds()).at(-1)
    expect(issue.issue_owner_ids).toEqual(['owner'])
    expect(String(issue.issue_record_version)).toBe(String(version))
    expect(issue.issue_started_at).toBeInstanceOf(Date)
    await write({ [owner]: ['member'] })
    await write({ [field]: '有问题' })
    await write({ [field]: '评审中' })
    expect((await rounds()).at(-1)).toEqual(issue)
    const beforeRollback = await rounds()
    await expect(tx.transaction(async ({ query }) => {
      await query('UPDATE meta_records SET data=data||$1::jsonb,version=version+1 WHERE id=$2',
        [JSON.stringify({ [field]: '已完成' }),row.id])
      throw new Error('synthetic rollback')
    })).rejects.toThrow('synthetic rollback')
    expect(await rounds()).toEqual(beforeRollback)
    expect((await pool.query('SELECT data FROM meta_records WHERE id=$1', [row.id])).rows[0].data[field]).toBe('评审中')
    await write({ [field]: '已完成' })
    const completed = (await rounds()).at(-1)
    expect(completed.completed_at).toBeInstanceOf(Date)
    expect(completed.issue_owner_ids).toEqual(['owner'])
    await write({ [field]: '评审中' })
    expect((await rounds()).at(-2)).toEqual(completed)
    const reopened = (await rounds()).at(-1)
    expect(Number(reopened.round)).toBe(Number(completed.round)+1)
    expect(reopened.issue_started_at).toBeNull()
    await write({ [field]: '有问题' })
    expect((await rounds()).at(-1).issue_owner_ids).toEqual(['member'])
    await write({ [field]: '已完成' })
    const raceVersion = (await write({ [field]: '评审中' })).rows[0].version
    const race = await Promise.all(['owner','member'].map((user) => pool.query(
      'UPDATE meta_records SET data=data||$1::jsonb,version=version+1 WHERE id=$2 AND version=$3 RETURNING data',
      [JSON.stringify({ [field]: '有问题', [owner]: [user] }),row.id,raceVersion],
    )))
    expect(race.map((r) => r.rowCount).sort()).toEqual([0,1])
    const winner = race.find((r) => r.rowCount === 1)!.rows[0]
    const raceRound = (await rounds()).at(-1)
    expect(raceRound.issue_owner_ids).toEqual(winner.data[owner])
    expect(Number(raceRound.issue_record_version)).toBe(Number(raceVersion)+1)
    for (const sql of [
      'UPDATE meta_plm_bom_review_rounds SET completed_at=now() WHERE record_id=$1',
      'DELETE FROM meta_plm_bom_review_rounds WHERE record_id=$1',
    ]) await expect(pool.query(sql,[row.id])).rejects.toMatchObject({ code: '23514' })
    await expect(pool.query('TRUNCATE meta_plm_bom_review_rounds')).rejects.toMatchObject({ code: '0A000' })
    await expect(pool.query('TRUNCATE meta_plm_bom_review_rounds CASCADE')).rejects.toMatchObject({ code: '23514' })
    await expect(pool.query('TRUNCATE meta_records CASCADE')).rejects.toMatchObject({ code: '23514' })
  })
  it('scans configured issue, deadline and SLA events once per round with live read permissions', async () => {
    const p = await makePreview()
    const local = await service.create('owner', { previewId: p.previewId, requestId: randomUUID() })
    const row = (await pool.query('SELECT r.* FROM meta_records r JOIN meta_plm_bom_review_rows l ON l.record_id=r.id WHERE l.binding_id=$1 AND l.bom_line_id=$2', [local.id,'RC'])).rows[0]
    const field = getObjectFieldId('plm-bom-review',p.previewId,'status')
    const owner = getObjectFieldId('plm-bom-review',p.previewId,'owner')
    const due = getObjectFieldId('plm-bom-review',p.previewId,'due_date')
    const clock = new Date(), advanced = new Date(clock.getTime()+70*60000)
    const count = async () => (await pool.query('SELECT count(*)::int n FROM meta_plm_bom_review_notification_events WHERE binding_id=$1', [local.id])).rows[0].n
    const write = (data: Record<string,unknown>) => pool.query('UPDATE meta_records SET data=data||$1::jsonb,version=version+1 WHERE id=$2', [JSON.stringify(data),row.id])
    expect(await service.scanNotifications(local.id,clock)).toEqual({ created: 0 })
    await service.notifications('owner',local.id,{ expectedVersion: 0,notifications: {
      issue: { enabled: true,recipientStrategy: 'event_owner' },
      reminder: { enabled: true,recipientStrategy: 'current_owner',leadMinutes: 15 },
      escalation: { enabled: true,slaMinutes: 60,recipientUserIds: ['owner'] },
    } })
    await write({ [field]: '评审中',[owner]: ['owner'],[due]: new Date(clock.getTime()+20*60000).toISOString() })
    expect(await service.scanNotifications(local.id,clock)).toEqual({ created: 0 })
    await write({ [field]: '有问题' })
    await pool.query("INSERT INTO record_permissions(sheet_id,record_id,subject_type,subject_id,access_level) VALUES($1,$2,'user','owner','none')", [local.sheetId,row.id])
    expect(await service.scanNotifications(local.id,advanced)).toEqual({ created: 0 })
    await pool.query('DELETE FROM record_permissions WHERE sheet_id=$1 AND record_id=$2', [local.sheetId,row.id])
    expect(await service.scanNotifications(local.id,clock)).toEqual({ created: 1 })
    expect(await service.scanNotifications(local.id,clock)).toEqual({ created: 0 })
    expect(await service.scanNotifications(local.id,new Date(clock.getTime()+5*60000-1))).toEqual({ created: 0 })
    await pool.query("UPDATE meta_fields SET property=property||'{\"hidden\":true}'::jsonb WHERE id=$1", [due])
    const issueAt = (await pool.query('SELECT issue_started_at FROM meta_plm_bom_review_rounds WHERE record_id=$1 ORDER BY round DESC LIMIT 1', [row.id])).rows[0].issue_started_at
    expect(await service.scanNotifications(local.id,new Date(issueAt.getTime()+60*60000-1))).toEqual({ created: 0 })
    expect(await service.scanNotifications(local.id,new Date(issueAt.getTime()+60*60000))).toEqual({ created: 1 })
    expect(await count()).toBe(2)
    await pool.query("UPDATE meta_fields SET property=property-'hidden' WHERE id=$1", [due])
    const race = await Promise.all([service.scanNotifications(local.id,advanced),service.scanNotifications(local.id,advanced)])
    expect(race.reduce((sum,r) => sum+r.created,0)).toBe(1)
    expect(await count()).toBe(3)
    await write({ [field]: '已完成' })
    expect(await service.scanNotifications(local.id,advanced)).toEqual({ created: 0 })
    await write({ [field]: '评审中' })
    await write({ [field]: '有问题' })
    let inserts = 0
    const failing = new PlmBomReviewService({ pool: { query: tx.query,
      transaction: (fn) => tx.transaction(({ query }) => fn({ query: async (text,params) => {
        if (text.includes('INSERT INTO meta_plm_bom_review_notification_events') && ++inserts === 2) throw new Error('synthetic event insert failure')
        return query(text,params)
      } })),
    },dataSourceManager: { getDataSource: () => adapter as never } })
    await expect(failing.scanNotifications(local.id,advanced)).rejects.toThrow('synthetic event insert failure')
    expect(await count()).toBe(3)
    await pool.query("UPDATE spreadsheet_permissions SET perm_code='spreadsheet:read' WHERE sheet_id=$1 AND subject_id='owner'", [local.sheetId])
    await expect(service.scanNotifications(local.id,advanced)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await count()).toBe(3)
    await pool.query("UPDATE spreadsheet_permissions SET perm_code='spreadsheet:admin' WHERE sheet_id=$1 AND subject_id='owner'", [local.sheetId])
    expect(await service.scanNotifications(local.id,advanced)).toEqual({ created: 3 })
    expect(await count()).toBe(6)
    const events = (await pool.query(`SELECT e.*,r.actor_id FROM meta_plm_bom_review_notification_events e
      JOIN meta_config_revisions r ON r.id=e.configuration_revision_id WHERE e.binding_id=$1`, [local.id])).rows
    expect(events).toHaveLength(6)
    expect(events.every((e) => e.creator_id === 'owner' && e.actor_id === 'owner' && Number(e.configuration_version) === 1)).toBe(true)
  })
  it('freezes both owner strategies, revalidates access and commits native receipts with intent state exactly once', async () => {
    const p = await makePreview()
    const local = await service.create('owner',{ previewId: p.previewId,requestId: randomUUID() })
    const row = (await pool.query('SELECT r.* FROM meta_records r JOIN meta_plm_bom_review_rows l ON l.record_id=r.id WHERE l.binding_id=$1 AND l.bom_line_id=$2',[local.id,'RC'])).rows[0]
    const field = getObjectFieldId('plm-bom-review',p.previewId,'status'), owner = getObjectFieldId('plm-bom-review',p.previewId,'owner')
    await pool.query("INSERT INTO spreadsheet_permissions(sheet_id,subject_type,subject_id,perm_code) VALUES($1,'user','member','spreadsheet:read')",[local.sheetId])
    const policy = (strategy: string) => ({ issue: { enabled: true,recipientStrategy: strategy },
      reminder: { enabled: false,recipientStrategy: null,leadMinutes: null },
      escalation: { enabled: false,slaMinutes: null,recipientUserIds: [] } })
    await service.notifications('owner',local.id,{ expectedVersion: 0,notifications: policy('event_owner') })
    const write = (data: Record<string,unknown>) => pool.query('UPDATE meta_records SET data=data||$1::jsonb,version=version+1 WHERE id=$2',[JSON.stringify(data),row.id])
    const event = async () => {
      await service.scanNotifications(local.id)
      return (await pool.query("SELECT * FROM meta_plm_bom_review_notification_events WHERE record_id=$1 AND kind='issue' ORDER BY round DESC LIMIT 1",[row.id])).rows[0]
    }
    const receipts = (id: string) => pool.query('SELECT * FROM meta_record_subscription_notifications WHERE source_event_id=$1',[`bom-review:${id}`])
    const reopen = async (user: string | null) => {
      await write({ [field]: '已完成' }); await write({ [field]: '评审中',[owner]: user ? [user] : [] }); await write({ [field]: '有问题' })
      return event()
    }
    await write({ [field]: '评审中',[owner]: ['owner'] }); await write({ [field]: '有问题' })
    const first = await event(); await write({ [owner]: ['member'] })
    expect(await service.prepareNotification(first.id)).toEqual({ state: 'prepared' })
    expect((await pool.query('SELECT recipient_ids FROM meta_plm_bom_review_notification_intents WHERE event_id=$1',[first.id])).rows[0].recipient_ids).toEqual(['owner'])
    expect(await service.deliverNotification(first.id)).toEqual({ state: 'delivered',inserted: 1 })
    expect(await service.deliverNotification(first.id)).toEqual({ state: 'delivered',inserted: 0 })
    expect((await receipts(first.id)).rows.map((r) => r.user_id)).toEqual(['owner'])
    await service.notifications('owner',local.id,{ expectedVersion: 1,notifications: policy('current_owner') })
    const second = await reopen('owner'); await write({ [owner]: ['member'] })
    expect(await service.prepareNotification(second.id)).toEqual({ state: 'prepared' })
    await expect(pool.query("UPDATE meta_plm_bom_review_notification_intents SET recipient_ids='[\"owner\"]' WHERE event_id=$1",[second.id]))
      .rejects.toMatchObject({ code: '23514' })
    await write({ [owner]: ['owner'] })
    const race = await Promise.all([service.deliverNotification(second.id),service.deliverNotification(second.id)])
    expect(race.reduce((n,r) => n+r.inserted,0)).toBe(1)
    expect((await receipts(second.id)).rows.map((r) => r.user_id)).toEqual(['member'])
    const denied = await reopen('member'); await service.prepareNotification(denied.id)
    await pool.query("DELETE FROM spreadsheet_permissions WHERE sheet_id=$1 AND subject_id='member'",[local.sheetId])
    expect(await service.deliverNotification(denied.id)).toEqual({ state: 'cancelled',inserted: 0 })
    expect((await receipts(denied.id)).rows).toHaveLength(0)
    await pool.query("INSERT INTO spreadsheet_permissions(sheet_id,subject_type,subject_id,perm_code) VALUES($1,'user','member','spreadsheet:read')",[local.sheetId])
    const completed = await reopen('owner'); await service.prepareNotification(completed.id); await write({ [field]: '已完成' })
    expect(await service.deliverNotification(completed.id)).toEqual({ state: 'cancelled',inserted: 0 })
    await write({ [field]: '评审中',[owner]: ['owner'] }); await write({ [field]: '有问题' })
    const retry = await event(); await service.prepareNotification(retry.id)
    const failing = new PlmBomReviewService({ pool: { query: tx.query,
      transaction: (fn) => tx.transaction(({ query }) => fn({ query: async (text,params) => {
        if (text.includes("UPDATE meta_plm_bom_review_notification_intents SET state='delivered'")) throw new Error('synthetic receipt commit failure')
        return query(text,params)
      } })),
    },dataSourceManager: { getDataSource: () => adapter as never } })
    await expect(failing.deliverNotification(retry.id)).rejects.toThrow('synthetic receipt commit failure')
    expect((await receipts(retry.id)).rows).toHaveLength(0)
    expect(await service.prepareNotification(retry.id)).toEqual({ state: 'prepared' })
    expect(await service.deliverNotification(retry.id)).toEqual({ state: 'delivered',inserted: 1 })
    const late = await reopen(null)
    expect(await service.prepareNotification(late.id)).toEqual({ state: 'waiting' })
    await write({ [owner]: ['member'] })
    expect(await service.prepareNotification(late.id)).toEqual({ state: 'prepared' })
    expect(await service.deliverNotification(late.id)).toEqual({ state: 'delivered',inserted: 1 })
    const corrupt = await reopen('owner')
    await pool.query("INSERT INTO meta_plm_bom_review_notification_intents(event_id,recipient_ids,state) VALUES($1,'[]','prepared')",[corrupt.id])
    expect(await service.deliverNotification(corrupt.id)).toEqual({ state: 'cancelled',inserted: 0 })
    expect((await receipts(corrupt.id)).rows).toHaveLength(0)
    const disabled = await reopen('owner'); await service.prepareNotification(disabled.id)
    const off = policy('current_owner'); off.issue.enabled = false
    await service.notifications('owner',local.id,{ expectedVersion: 2,notifications: off })
    expect(await service.deliverNotification(disabled.id)).toEqual({ state: 'cancelled',inserted: 0 })
    expect((await receipts(disabled.id)).rows).toHaveLength(0)
    await expect(pool.query('TRUNCATE meta_plm_bom_review_notification_intents')).rejects.toMatchObject({ code: '23514' })
    await pool.query("DELETE FROM spreadsheet_permissions WHERE sheet_id=$1 AND subject_id='member'",[local.sheetId])
  })
  it('rolls completion policy back when its native audit cannot be committed', async () => {
    const p = await makePreview(), local = await service.create('owner',{ previewId: p.previewId,requestId: randomUUID() })
    const failing = new PlmBomReviewService({ pool: { query: tx.query,transaction: (fn) => tx.transaction(({ query }) => fn({
      query: async (sql,params) => { if (sql.includes('INSERT INTO meta_config_revisions')) throw new Error('audit unavailable'); return query(sql,params) },
    })) },dataSourceManager: { getDataSource: () => adapter as never } })
    const off = { reviewCompleted: { enabled: false,webhookId: null,granularity: null },plmChangeApplied: { enabled: false,webhookId: null,source: null } }
    await expect(failing.completionWebhooks('owner',local.id,{ expectedVersion: 0,webhooks: off })).rejects.toThrow('audit unavailable')
    expect(await service.completionWebhooks('owner',local.id)).toEqual({ version: 0,webhooks: null })
    expect((await pool.query('SELECT * FROM meta_config_revisions WHERE entity_id=$1',[`plm-bom-review:${local.id}:completion-webhooks`])).rows).toEqual([])
  })
  it('delivers signed completion HTTP with durable attempt budgets, stable replay keys and live authority', async () => {
    const calls: Array<{ id: string; body: string; signature: string | undefined; webhook: string | undefined }> = []
    const accepted = new Set<string>()
    let statusCode = 503, redirectReceived = 0, receiverBase = ''
    const receiver = createServer((req,res) => {
      if (req.url === '/redirect-target') { redirectReceived++; req.resume(); res.writeHead(204); res.end(); return }
      let body = ''
      req.on('data',chunk => { body += chunk })
      req.on('end',() => {
        const id = String(req.headers['idempotency-key'])
        calls.push({ id,body,signature: req.headers['x-webhook-signature'] as string | undefined,webhook: req.headers['x-webhook-id'] as string | undefined })
        if (statusCode === 204) accepted.add(id) // receiver owns logical idempotency
        if (statusCode === 0) return // owned stalled peer: actual five-second abort budget
        if (statusCode === 302) res.setHeader('Location',receiverBase+'/redirect-target')
        res.writeHead(statusCode); res.end()
      })
    })
    await new Promise<void>(resolve => receiver.listen(0,'127.0.0.1',resolve))
    const address = receiver.address() as { port: number }
    receiverBase = `http://127.0.0.1:${address.port}`
    const p = await makePreview(), local = await service.create('owner',{ previewId: p.previewId,requestId: randomUUID() })
    const field = getObjectFieldId('plm-bom-review',p.previewId,'status')
    const row = (await pool.query('SELECT record_id FROM meta_plm_bom_review_rows WHERE binding_id=$1 AND bom_line_id=$2',[local.id,'RC'])).rows[0]
    const target = randomUUID(), secret = 'synthetic-local-receiver-secret'
    await pool.query(`INSERT INTO multitable_webhooks(id,name,url,secret,created_by,max_retries,retry_base_delay_ms)
      VALUES($1,'Local completion',$2,$3,'owner',2,100)`,[target,`http://127.0.0.1:${address.port}/completion`,secret])
    await pool.query("INSERT INTO user_permissions VALUES('owner','multitable:send_webhook')")
    const makeEvent = async () => {
      for (const state of ['评审中','已完成']) await pool.query('UPDATE meta_records SET data=data||$1::jsonb,version=version+1,modified_by=$3 WHERE id=$2',
        [JSON.stringify({ [field]: state }),row.record_id,'member'])
      return (await pool.query('SELECT id FROM meta_plm_bom_review_completion_events WHERE binding_id=$1 ORDER BY created_at DESC LIMIT 1',[local.id])).rows[0].id as string
    }
    const waitRetry = async (id: string) => {
      const next = (await pool.query('SELECT next_retry_at FROM meta_plm_bom_review_completion_intents WHERE event_id=$1',[id])).rows[0].next_retry_at
      await new Promise(resolve => setTimeout(resolve,Math.max(0,new Date(next).getTime()-Date.now())+20))
    }
    let others: Array<{ id: string; active: boolean }> = []
    let worker: PlmBomNotificationWorker | undefined
    try {
      await service.completionWebhooks('owner',local.id,{ expectedVersion: 0,webhooks: {
        reviewCompleted: { enabled: true,webhookId: target,granularity: 'row' },plmChangeApplied: { enabled: false,webhookId: null,source: null },
      } })
      const retried = await makeEvent()
      expect(await service.deliverCompletion(retried)).toEqual({ state: 'prepared' })
      statusCode = 204; await waitRetry(retried)
      expect(await service.deliverCompletion(retried)).toEqual({ state: 'delivered' })
      expect(await service.deliverCompletion(retried)).toEqual({ state: 'delivered' })
      const attempts = calls.filter(c => c.id === retried)
      expect(attempts).toHaveLength(2); expect(attempts[0].body).toBe(attempts[1].body)
      expect(attempts.every(c => c.webhook === target && c.signature === createHmac('sha256',secret).update(c.body).digest('hex'))).toBe(true)
      expect(JSON.parse(attempts[0].body)).toMatchObject({ event_type: 'bom.review.completed',granularity: 'row' })
      const concurrent = await makeEvent()
      const peer = new PlmBomReviewService({ pool: tx,dataSourceManager: { getDataSource: () => adapter as never } })
      const raced = await Promise.all([service.deliverCompletion(concurrent),peer.deliverCompletion(concurrent)])
      expect(raced.some(r => r.state === 'delivered')).toBe(true)
      expect(raced.every(r => ['delivered','waiting'].includes(r.state))).toBe(true)
      expect(calls.filter(c => c.id === concurrent)).toHaveLength(1)
      expect((await pool.query('SELECT attempt_count FROM meta_plm_bom_review_completion_intents WHERE event_id=$1',[concurrent])).rows[0].attempt_count).toBe(1)

      const uncertain = await makeEvent()
      const beforeEffects = accepted.size
      const failing = new PlmBomReviewService({ pool: { query: tx.query,transaction: fn => tx.transaction(({ query }) => fn({ query: async (sql,params) => {
        if (sql.includes('SET state=$2,last_http_status=$3')) throw new Error('receipt persist unavailable')
        return query(sql,params)
      } })) },dataSourceManager: { getDataSource: () => adapter as never } })
      await expect(failing.deliverCompletion(uncertain)).rejects.toThrow('receipt persist unavailable')
      expect((await pool.query('SELECT state,attempt_count FROM meta_plm_bom_review_completion_intents WHERE event_id=$1',[uncertain])).rows[0]).toEqual({ state: 'prepared',attempt_count: 1 })
      await expect(pool.query('UPDATE meta_plm_bom_review_completion_intents SET attempt_count=0 WHERE event_id=$1',[uncertain])).rejects.toMatchObject({ code: '23514' })
      expect(await service.deliverCompletion(uncertain)).toEqual({ state: 'waiting' })
      // Accelerate only the owned failed-process lease; do not pretend this waited 30 real seconds.
      await pool.query("UPDATE meta_plm_bom_review_completion_intents SET lease_until=clock_timestamp()-interval '1 second' WHERE event_id=$1",[uncertain])
      const resumed = new PlmBomReviewService({ pool: tx,dataSourceManager: { getDataSource: () => adapter as never } })
      expect(await resumed.deliverCompletion(uncertain.toUpperCase())).toEqual({ state: 'delivered' })
      expect(calls.filter(c => c.id === uncertain)).toHaveLength(2)
      expect(accepted.has(uncertain)).toBe(true)
      expect(accepted.size).toBe(beforeEffects+1)

      statusCode = 503
      const revoked = await makeEvent(); expect(await service.deliverCompletion(revoked)).toEqual({ state: 'prepared' })
      await pool.query("DELETE FROM user_permissions WHERE user_id='owner' AND permission_code='multitable:send_webhook'")
      expect(await service.deliverCompletion(revoked)).toEqual({ state: 'cancelled' })
      expect(calls.filter(c => c.id === revoked)).toHaveLength(1)
      await pool.query("INSERT INTO user_permissions VALUES('owner','multitable:send_webhook')")

      const exhausted = await makeEvent(); expect(await service.deliverCompletion(exhausted)).toEqual({ state: 'prepared' })
      await waitRetry(exhausted)
      expect(await service.deliverCompletion(exhausted)).toEqual({ state: 'cancelled' })
      expect(await service.deliverCompletion(exhausted)).toEqual({ state: 'cancelled' })
      expect(calls.filter(c => c.id === exhausted)).toHaveLength(2)
      await expect(completionAttemptsDown(new Kysely({ dialect: new PostgresDialect({ pool }) }))).rejects.toThrow('bom_review_completion_attempt_evidence_present')

      statusCode = 302
      const redirected = await makeEvent()
      expect(await service.deliverCompletion(redirected)).toEqual({ state: 'prepared' })
      expect(calls.filter(c => c.id === redirected)).toHaveLength(1); expect(redirectReceived).toBe(0)
      statusCode = 0
      const stalled = await makeEvent(), started = Date.now()
      expect(await service.deliverCompletion(stalled)).toEqual({ state: 'prepared' })
      expect(Date.now()-started).toBeGreaterThanOrEqual(5000)
      expect(calls.filter(c => c.id === stalled)).toHaveLength(1)
      expect((await pool.query('SELECT last_http_status,attempt_count FROM meta_plm_bom_review_completion_intents WHERE event_id=$1',[stalled])).rows[0])
        .toEqual({ last_http_status: null,attempt_count: 1 })

      const changedBeforeClaim = await makeEvent()
      let mutated = false
      const changing = new PlmBomReviewService({ pool: { query: tx.query,transaction: async fn => {
        const result = await tx.transaction(fn)
        if (!mutated && (result as { state?: string }).state === 'prepared') {
          mutated = true
          await pool.query('UPDATE multitable_webhooks SET url=$2 WHERE id=$1',[target,receiverBase+'/changed'])
        }
        return result
      } },dataSourceManager: { getDataSource: () => adapter as never } })
      expect(await changing.deliverCompletion(changedBeforeClaim)).toEqual({ state: 'cancelled' })
      expect(calls.filter(c => c.id === changedBeforeClaim)).toHaveLength(0)
      expect((await pool.query('SELECT cancellation_reason FROM meta_plm_bom_review_completion_intents WHERE event_id=$1',[changedBeforeClaim])).rows[0].cancellation_reason).toBe('CONTEXT_INVALID')
      await pool.query('UPDATE multitable_webhooks SET url=$2 WHERE id=$1',[target,receiverBase+'/completion'])
      statusCode = 204
      await pool.query('UPDATE multitable_webhooks SET max_retries=1 WHERE id=$1',[target])
      const lastUnknown = await makeEvent()
      await expect(failing.deliverCompletion(lastUnknown)).rejects.toThrow('receipt persist unavailable')
      await pool.query("UPDATE meta_plm_bom_review_completion_intents SET lease_until=clock_timestamp()-interval '1 second' WHERE event_id=$1",[lastUnknown])
      expect(await service.deliverCompletion(lastUnknown)).toEqual({ state: 'cancelled' })
      expect((await pool.query('SELECT cancellation_reason,attempt_count FROM meta_plm_bom_review_completion_intents WHERE event_id=$1',[lastUnknown])).rows[0])
        .toEqual({ cancellation_reason: 'OUTCOME_UNKNOWN',attempt_count: 1 })
      expect(calls.filter(c => c.id === lastUnknown)).toHaveLength(1)
      expect(accepted.has(lastUnknown)).toBe(true) // no false assertion that the peer did not receive it
      await pool.query('UPDATE multitable_webhooks SET max_retries=2 WHERE id=$1',[target])

      statusCode = 204
      const background = await makeEvent()
      // All destinations here belong to this disposable test DB. Make unrelated fixtures inert
      // before the genuine unfiltered worker runs, so no test contacts a remote service.
      others = (await pool.query('SELECT id,active FROM multitable_webhooks WHERE id<>$1',[target])).rows
      await pool.query('UPDATE multitable_webhooks SET active=false WHERE id<>$1',[target])
      worker = new PlmBomNotificationWorker(tx,service,() => undefined)
      await worker.start(); await worker.tick(); await worker.stop()
      expect(calls.filter(c => c.id === background)).toHaveLength(1)
      expect((await pool.query('SELECT state FROM meta_plm_bom_review_completion_intents WHERE event_id=$1',[background])).rows[0].state).toBe('delivered')
      expect((await pool.query('SELECT count(*)::int n FROM multitable_webhook_deliveries WHERE webhook_id=$1',[target])).rows[0].n).toBe(0)
    } finally {
      await worker?.stop()
      await pool.query("DELETE FROM user_permissions WHERE user_id='owner' AND permission_code='multitable:send_webhook'")
      for (const other of others) await pool.query('UPDATE multitable_webhooks SET active=$2 WHERE id=$1',[other.id,other.active])
      await new Promise<void>(resolve => receiver.close(() => resolve()))
    }
  },15000)
  it('prepares a fixed completion intent and cancels it on authority, destination or round changes', async () => {
    const p = await makePreview(), local = await service.create('owner',{ previewId: p.previewId,requestId: randomUUID() })
    const status = getObjectFieldId('plm-bom-review',p.previewId,'status')
    const row = (await pool.query('SELECT record_id FROM meta_plm_bom_review_rows WHERE binding_id=$1 AND bom_line_id=$2',[local.id,'RC'])).rows[0]
    const destination = randomUUID()
    await pool.query("INSERT INTO multitable_webhooks(id,name,url,secret,created_by) VALUES($1,'Fixed completion','https://example.com/original','original-secret','owner')",[destination])
    await pool.query("INSERT INTO user_permissions VALUES('owner','multitable:send_webhook')")
    const write = (state: string) => pool.query('UPDATE meta_records SET data=data||$1::jsonb,version=version+1,modified_by=$3 WHERE id=$2',
      [JSON.stringify({ [status]: state }),row.record_id,'member'])
    const makeEvent = async () => {
      await write('评审中'); await write('已完成')
      return (await pool.query('SELECT id FROM meta_plm_bom_review_completion_events WHERE binding_id=$1 ORDER BY created_at DESC LIMIT 1',[local.id])).rows[0].id as string
    }
    const webhooks = { reviewCompleted: { enabled: true,webhookId: destination,granularity: 'row' },
      plmChangeApplied: { enabled: true,webhookId: destination,source: 'bom_line_writeback' } }
    try {
      await service.completionWebhooks('owner',local.id,{ expectedVersion: 0,webhooks })
      const first = await makeEvent()
      expect(await Promise.all([service.prepareCompletion(first),service.prepareCompletion(first)])).toEqual([{ state: 'prepared' },{ state: 'prepared' }])
      const before = (await pool.query('SELECT * FROM meta_plm_bom_review_completion_intents WHERE event_id=$1',[first])).rows[0]
      expect(before.destination_fingerprint).toMatch(/^[a-f0-9]{64}$/)
      expect(JSON.stringify(before)).not.toContain('original-secret')
      await service.completionWebhooks('owner',local.id,{ expectedVersion: 1,webhooks: {
        ...webhooks,plmChangeApplied: { ...webhooks.plmChangeApplied,source: 'eco_batch_apply' },
      } })
      expect(await service.prepareCompletion(first)).toEqual({ state: 'prepared' }) // unrelated rule preserves intent
      expect((await pool.query('SELECT * FROM meta_plm_bom_review_completion_intents WHERE event_id=$1',[first])).rows[0]).toEqual(before)
      await pool.query("UPDATE multitable_webhooks SET url='https://example.com/changed' WHERE id=$1",[destination])
      expect(await service.prepareCompletion(first)).toEqual({ state: 'cancelled' })
      await pool.query("UPDATE multitable_webhooks SET url='https://example.com/original' WHERE id=$1",[destination])
      expect(await service.prepareCompletion(first)).toEqual({ state: 'cancelled' }) // never resurrect cancelled intent

      const egress = await makeEvent(); expect(await service.prepareCompletion(egress)).toEqual({ state: 'prepared' })
      await pool.query("DELETE FROM user_permissions WHERE user_id='owner' AND permission_code='multitable:send_webhook'")
      expect(await service.prepareCompletion(egress)).toEqual({ state: 'cancelled' })
      await pool.query("INSERT INTO user_permissions VALUES('owner','multitable:send_webhook')")

      const deniedRow = await makeEvent()
      await pool.query("INSERT INTO record_permissions(sheet_id,record_id,subject_type,subject_id,access_level) VALUES($1,$2,'user','owner','none')",[local.sheetId,row.record_id])
      expect(await service.prepareCompletion(deniedRow)).toEqual({ state: 'cancelled' })
      await pool.query('DELETE FROM record_permissions WHERE sheet_id=$1',[local.sheetId])

      const deniedField = await makeEvent()
      await pool.query("INSERT INTO field_permissions(sheet_id,field_id,subject_type,subject_id,visible,read_only) VALUES($1,$2,'user','owner',false,false)",[local.sheetId,status])
      expect(await service.prepareCompletion(deniedField)).toEqual({ state: 'cancelled' })
      await pool.query('DELETE FROM field_permissions WHERE sheet_id=$1',[local.sheetId])

      const reopened = await makeEvent(); expect(await service.prepareCompletion(reopened)).toEqual({ state: 'prepared' })
      await write('评审中')
      expect(await service.prepareCompletion(reopened)).toEqual({ state: 'cancelled' })
      const inactive = await makeEvent(); expect(await service.prepareCompletion(inactive)).toEqual({ state: 'prepared' })
      await pool.query("UPDATE users SET is_active=false WHERE id='owner'")
      expect(await service.prepareCompletion(inactive)).toEqual({ state: 'cancelled' })
      await pool.query("UPDATE users SET is_active=true WHERE id='owner'")
      const changedRule = await makeEvent(); expect(await service.prepareCompletion(changedRule)).toEqual({ state: 'prepared' })
      await service.completionWebhooks('owner',local.id,{ expectedVersion: 2,webhooks: {
        ...webhooks,reviewCompleted: { ...webhooks.reviewCompleted,granularity: 'bom' },
      } })
      expect(await service.prepareCompletion(changedRule)).toEqual({ state: 'cancelled' })
      const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
      await expect(completionIntentsDown(db)).rejects.toThrow('bom_review_completion_intent_evidence_present')
      await expect(pool.query("UPDATE meta_plm_bom_review_completion_intents SET destination_fingerprint='changed' WHERE event_id=$1",[first])).rejects.toMatchObject({ code: '23514' })
      await expect(pool.query('DELETE FROM meta_plm_bom_review_completion_intents WHERE event_id=$1',[first])).rejects.toMatchObject({ code: '23514' })
      await expect(pool.query('TRUNCATE meta_plm_bom_review_completion_intents')).rejects.toMatchObject({ code: '23514' })
    } finally {
      await pool.query("UPDATE users SET is_active=true WHERE id='owner'")
      await pool.query("DELETE FROM user_permissions WHERE user_id='owner' AND permission_code='multitable:send_webhook'")
      await pool.query('DELETE FROM record_permissions WHERE sheet_id=$1',[local.sheetId])
      await pool.query('DELETE FROM field_permissions WHERE sheet_id=$1',[local.sheetId])
    }
  })
  it('captures immutable row-mode completion events atomically without reporting whole-BOM or PLM success', async () => {
    const p = await makePreview(), local = await service.create('owner',{ previewId: p.previewId,requestId: randomUUID() })
    const field = getObjectFieldId('plm-bom-review',p.previewId,'status')
    const row = (await pool.query('SELECT record_id FROM meta_plm_bom_review_rows WHERE binding_id=$1 AND bom_line_id=$2',[local.id,'RC'])).rows[0]
    const destination = randomUUID()
    await pool.query("INSERT INTO multitable_webhooks(id,name,url,created_by) VALUES($1,'Row event','https://example.com/row','owner')",[destination])
    await pool.query("INSERT INTO user_permissions VALUES('owner','multitable:send_webhook')")
    const write = (state: string,query = pool.query.bind(pool)) => query('UPDATE meta_records SET data=data||$1::jsonb,version=version+1,modified_by=$3 WHERE id=$2',
      [JSON.stringify({ [field]: state }),row.record_id,'member'])
    const events = async () => (await pool.query('SELECT * FROM meta_plm_bom_review_completion_events WHERE binding_id=$1 ORDER BY created_at',[local.id])).rows
    try {
      const webhooks = { reviewCompleted: { enabled: true,webhookId: destination,granularity: 'bom' },
        plmChangeApplied: { enabled: true,webhookId: destination,source: 'eco_batch_apply' } }
      await service.completionWebhooks('owner',local.id,{ expectedVersion: 0,webhooks })
      await write('评审中'); await write('已完成')
      expect(await events()).toEqual([])
      await service.completionWebhooks('owner',local.id.toUpperCase(),{ expectedVersion: 1,webhooks: {
        ...webhooks,reviewCompleted: { ...webhooks.reviewCompleted,granularity: 'row' },
      } })
      expect(await events()).toEqual([]) // no backfill when changing the mode
      await write('评审中')
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('CREATE TEMP TABLE meta_plm_bom_review_completion_config AS SELECT * FROM public.meta_plm_bom_review_completion_config WHERE false')
        await write('已完成',client.query.bind(client))
        expect((await client.query('SELECT count(*)::int n FROM meta_plm_bom_review_completion_events WHERE binding_id=$1',[local.id])).rows[0].n).toBe(1)
        await client.query('ROLLBACK')
      } finally { client.release() }
      expect(await events()).toEqual([])
      await write('已完成'); await write('已完成')
      const [event] = await events()
      expect(await events()).toHaveLength(1)
      expect(event).toMatchObject({ event_type: 'bom.review.completed',granularity: 'row',webhook_id: destination,creator_id: 'owner' })
      expect(event.payload).toMatchObject({ event_type: 'bom.review.completed',granularity: 'row',bom_line_id: 'RC',round: 2,
        binding_id: local.id,record_id: row.record_id,configuration_version: 2 })
      expect(event.configuration_revision_id).toBe((await pool.query('SELECT revision_id FROM meta_plm_bom_review_completion_config WHERE binding_id=$1',[local.id])).rows[0].revision_id)
      await expect(pool.query("UPDATE meta_plm_bom_review_completion_events SET creator_id='outsider' WHERE id=$1",[event.id])).rejects.toMatchObject({ code: '23514' })
      await expect(pool.query('DELETE FROM meta_plm_bom_review_completion_events WHERE id=$1',[event.id])).rejects.toMatchObject({ code: '23514' })
      await expect(pool.query('TRUNCATE meta_plm_bom_review_completion_events CASCADE')).rejects.toMatchObject({ code: '23514' })
      const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
      await expect(rowEventsDown(db)).rejects.toThrow('bom_review_completion_event_evidence_present')
    } finally { await pool.query("DELETE FROM user_permissions WHERE user_id='owner' AND permission_code='multitable:send_webhook'") }
  })
  it('persists each customer-selected completion grain and PLM success source in native audit', async () => {
    const p = await makePreview(), local = await service.create('owner',{ previewId: p.previewId,requestId: randomUUID() })
    const destination = randomUUID()
    await pool.query("INSERT INTO multitable_webhooks(id,name,url,created_by) VALUES($1,'Completion modes','https://example.com/modes','owner')",[destination])
    await pool.query("INSERT INTO user_permissions VALUES('owner','multitable:send_webhook')")
    try {
      let version = 0
      for (const granularity of ['bom','row']) for (const source of ['bom_line_writeback','eco_batch_apply']) {
        const webhooks = { reviewCompleted: { enabled: true,webhookId: destination,granularity },
          plmChangeApplied: { enabled: true,webhookId: destination,source } }
        const saved = await service.completionWebhooks('owner',local.id,{ expectedVersion: version,webhooks })
        expect(saved).toEqual({ version: ++version,webhooks })
        expect(await service.completionWebhooks('owner',local.id)).toEqual(saved)
        const row = (await pool.query(`SELECT r.after FROM meta_config_revisions r
          JOIN meta_plm_bom_review_completion_config c ON c.revision_id=r.id WHERE c.binding_id=$1`,[local.id])).rows[0]
        expect(row.after.webhooks).toEqual(webhooks)
      }
    } finally { await pool.query("DELETE FROM user_permissions WHERE user_id='owner' AND permission_code='multitable:send_webhook'") }
  })
  it('persists independent completion policies with explicit owned destinations, egress permission and audit CAS', async () => {
    const p = await makePreview(), local = await service.create('owner',{ previewId: p.previewId,requestId: randomUUID() })
    const a = randomUUID(), c = randomUUID(), foreign = randomUUID()
    await pool.query(`INSERT INTO multitable_webhooks(id,name,url,created_by) VALUES($1,'Review','https://example.com/review','owner'),
      ($2,'PLM','https://example.com/plm','owner'),($3,'Foreign','https://example.com/foreign','outsider')`,[a,c,foreign])
    const webhooks = { reviewCompleted: { enabled: true,webhookId: a,granularity: 'row' },plmChangeApplied: { enabled: true,webhookId: c,source: 'bom_line_writeback' } }
    expect(await service.completionWebhooks('owner',local.id)).toEqual({ version: 0,webhooks: null })
    await expect(service.completionWebhooks('owner',local.id,{ expectedVersion: 0,webhooks })).rejects.toMatchObject({ status: 403 })
    await pool.query("INSERT INTO user_permissions VALUES('owner','multitable:send_webhook')")
    try {
      const destinations = await service.completionWebhookDestinations('owner',local.id)
      expect(destinations).toEqual(expect.arrayContaining([{ id: a,name: 'Review' },{ id: c,name: 'PLM' }]))
      expect(destinations.some((row) => row.id === foreign)).toBe(false)
      expect(destinations.every((row) => Object.keys(row).sort().join(',') === 'id,name')).toBe(true)
      await expect(service.completionWebhooks('member',local.id,{ expectedVersion: 0,webhooks })).rejects.toMatchObject({ status: 403 })
      await expect(service.completionWebhooks('owner',local.id,{ expectedVersion: 0,webhooks: { ...webhooks,
        plmChangeApplied: { enabled: true,webhookId: foreign,source: 'bom_line_writeback' } } })).rejects.toMatchObject({ status: 403 })
      expect(await service.completionWebhooks('owner',local.id,{ expectedVersion: 0,webhooks })).toEqual({ version: 1,webhooks })
      expect(await service.completionWebhooks('owner',local.id,{ expectedVersion: 1,webhooks })).toEqual({ version: 1,webhooks })
      await expect(service.completionWebhooks('owner',local.id,{ expectedVersion: 0,webhooks })).rejects.toMatchObject({ status: 409 })
      const audit = (await pool.query(`SELECT r.after FROM meta_plm_bom_review_completion_config c
        JOIN meta_config_revisions r ON r.id=c.revision_id WHERE c.binding_id=$1`,[local.id])).rows[0]
      expect(audit.after).toEqual({ webhooks })
      await pool.query('UPDATE multitable_webhooks SET active=false WHERE id=$1',[a])
      await expect(service.completionWebhooks('owner',local.id,{ expectedVersion: 1,webhooks: { ...webhooks,
        plmChangeApplied: { enabled: false,webhookId: null,source: null } } })).rejects.toMatchObject({ status: 403 })
      await pool.query("DELETE FROM user_permissions WHERE user_id='owner' AND permission_code='multitable:send_webhook'")
      const off = { reviewCompleted: { enabled: false,webhookId: a,granularity: null },plmChangeApplied: { enabled: false,webhookId: c,source: null } }
      expect(await service.completionWebhooks('owner',local.id,{ expectedVersion: 1,webhooks: off })).toEqual({ version: 2,webhooks: off })
    } finally { await pool.query("DELETE FROM user_permissions WHERE user_id='owner' AND permission_code='multitable:send_webhook'") }
  })
  it('captures review completion once per enabled future round in the record transaction, never a PLM success', async () => {
    const p = await makePreview(), local = await service.create('owner',{ previewId: p.previewId,requestId: randomUUID() })
    const field = getObjectFieldId('plm-bom-review',p.previewId,'status')
    const row = (await pool.query('SELECT r.* FROM meta_records r JOIN meta_plm_bom_review_rows l ON l.record_id=r.id WHERE l.binding_id=$1 AND l.bom_line_id=$2',[local.id,'RC'])).rows[0]
    const destination = randomUUID()
    await pool.query("INSERT INTO multitable_webhooks(id,name,url,created_by) VALUES($1,'Completion','https://example.com/complete','owner')",[destination])
    await pool.query("INSERT INTO user_permissions VALUES('owner','multitable:send_webhook')")
    const facts = async () => (await pool.query('SELECT * FROM meta_plm_bom_review_completion_occurrences WHERE record_id=$1 ORDER BY round',[row.id])).rows
    const write = (state: string,query = pool.query.bind(pool)) => query('UPDATE meta_records SET data=data||$1::jsonb,version=version+1,modified_by=$3 WHERE id=$2',[JSON.stringify({ [field]: state }),row.id,'owner'])
    try {
      await service.completionWebhooks('owner',local.id,{ expectedVersion: 0,webhooks: {
        reviewCompleted: { enabled: false,webhookId: null,granularity: null },plmChangeApplied: { enabled: true,webhookId: destination,source: 'bom_line_writeback' },
      } })
      await write('评审中'); await write('已完成')
      expect(await facts()).toEqual([])
      await service.completionWebhooks('owner',local.id,{ expectedVersion: 1,webhooks: {
        reviewCompleted: { enabled: true,webhookId: destination,granularity: 'row' },plmChangeApplied: { enabled: true,webhookId: destination,source: 'bom_line_writeback' },
      } })
      expect(await facts()).toEqual([]) // enabling never backfills a previous completion
      await write('评审中')
      const client = await pool.connect()
      try {
        await client.query('CREATE TEMP TABLE meta_plm_bom_review_completion_config AS SELECT * FROM public.meta_plm_bom_review_completion_config WHERE false')
        await client.query('BEGIN'); await write('已完成',client.query.bind(client))
        expect((await client.query('SELECT * FROM meta_plm_bom_review_completion_occurrences WHERE record_id=$1',[row.id])).rows).toHaveLength(1)
        await client.query('ROLLBACK')
      } finally { await client.query('ROLLBACK'); await client.query('DROP TABLE pg_temp.meta_plm_bom_review_completion_config'); client.release() }
      expect(await facts()).toEqual([])
      await Promise.all([write('已完成'),write('已完成')])
      const first = (await facts())[0]
      expect(first).toMatchObject({ binding_id: local.id,record_id: row.id,round: '2',event_type: 'bom.review.row_completed',actor_id: 'owner',configuration_version: '2' })
      const record = (await pool.query('SELECT version FROM meta_records WHERE id=$1',[row.id])).rows[0]
      expect(Number(first.record_version)).toBe(Number(record.version)-1)
      const round = (await pool.query('SELECT completed_at FROM meta_plm_bom_review_rounds WHERE record_id=$1 AND round=2',[row.id])).rows[0]
      expect(first.occurred_at).toEqual(round.completed_at)
      expect(await facts()).toHaveLength(1)
      for (const sql of [
        'UPDATE meta_plm_bom_review_completion_occurrences SET actor_id=NULL WHERE id=$1',
        'DELETE FROM meta_plm_bom_review_completion_occurrences WHERE id=$1',
        'INSERT INTO meta_plm_bom_review_completion_occurrences SELECT * FROM meta_plm_bom_review_completion_occurrences WHERE id=$1',
      ]) await expect(pool.query(sql,[first.id])).rejects.toMatchObject({ code: '23514' })
      await expect(pool.query('TRUNCATE meta_plm_bom_review_completion_occurrences CASCADE')).rejects.toMatchObject({ code: '23514' })
      await write('评审中'); await write('有问题'); await write('已完成')
      expect((await facts()).map((item) => [item.round,item.event_type])).toEqual([['2','bom.review.row_completed'],['3','bom.review.row_completed']])
      const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
      await expect(completionDown(db)).rejects.toThrow('bom_review_completion_evidence_present')
    } finally { await pool.query("DELETE FROM user_permissions WHERE user_id='owner' AND permission_code='multitable:send_webhook'") }
  })
  it('a changed issue rule still cancels the fixed prepared intent, while uppercase binding audit IDs remain valid',async () => {
    const p = await makePreview(), local = await service.create('owner',{ previewId: p.previewId,requestId: randomUUID() })
    const row = (await pool.query('SELECT r.* FROM meta_records r JOIN meta_plm_bom_review_rows l ON l.record_id=r.id WHERE l.binding_id=$1 AND l.bom_line_id=$2',[local.id,'RC'])).rows[0]
    const status = getObjectFieldId('plm-bom-review',p.previewId,'status'), owner = getObjectFieldId('plm-bom-review',p.previewId,'owner')
    const notifications = { issue: { enabled: true,recipientStrategy: 'event_owner' },reminder: { enabled: false,recipientStrategy: null,leadMinutes: null },
      escalation: { enabled: false,slaMinutes: null,recipientUserIds: [] } }
    await service.notifications('owner',local.id.toUpperCase(),{ expectedVersion: 0,notifications })
    await pool.query('UPDATE meta_records SET data=data||$1::jsonb,version=version+1 WHERE id=$2',[JSON.stringify({ [status]: '评审中',[owner]: ['owner'] }),row.id])
    await pool.query('UPDATE meta_records SET data=data||$1::jsonb,version=version+1 WHERE id=$2',[JSON.stringify({ [status]: '有问题' }),row.id])
    await service.scanNotifications(local.id)
    const event = (await pool.query('SELECT * FROM meta_plm_bom_review_notification_events WHERE binding_id=$1',[local.id])).rows[0]
    expect(await service.prepareNotification(event.id)).toEqual({ state: 'prepared' })
    await service.notifications('owner',local.id,{ expectedVersion: 1,notifications: { ...notifications,issue: { enabled: true,recipientStrategy: 'current_owner' } } })
    expect(await service.deliverNotification(event.id)).toEqual({ state: 'cancelled',inserted: 0 })
    expect((await pool.query('SELECT * FROM meta_record_subscription_notifications WHERE source_event_id=$1',['bom-review:'+event.id])).rows).toEqual([])
  })
  it('an unrelated SLA policy edit does not swallow a queued enabled issue notification',async () => {
    const p = await makePreview(), local = await service.create('owner',{ previewId: p.previewId,requestId: randomUUID() })
    const row = (await pool.query('SELECT r.* FROM meta_records r JOIN meta_plm_bom_review_rows l ON l.record_id=r.id WHERE l.binding_id=$1 AND l.bom_line_id=$2',[local.id,'RC'])).rows[0]
    const status = getObjectFieldId('plm-bom-review',p.previewId,'status'), owner = getObjectFieldId('plm-bom-review',p.previewId,'owner')
    const notifications = { issue: { enabled: true,recipientStrategy: 'event_owner' },
      reminder: { enabled: false,recipientStrategy: null,leadMinutes: null },escalation: { enabled: false,slaMinutes: null,recipientUserIds: [] } }
    await service.notifications('owner',local.id,{ expectedVersion: 0,notifications })
    await pool.query('UPDATE meta_records SET data=data||$1::jsonb,version=version+1 WHERE id=$2',[JSON.stringify({ [status]: '评审中',[owner]: ['owner'] }),row.id])
    await pool.query('UPDATE meta_records SET data=data||$1::jsonb,version=version+1 WHERE id=$2',[JSON.stringify({ [status]: '有问题' }),row.id])
    expect(await service.scanNotifications(local.id)).toEqual({ created: 1 })
    const event = (await pool.query('SELECT * FROM meta_plm_bom_review_notification_events WHERE binding_id=$1',[local.id])).rows[0]
    await service.notifications('owner',local.id,{ expectedVersion: 1,notifications: { ...notifications,
      escalation: { enabled: true,slaMinutes: 60,recipientUserIds: ['owner'] } } })
    const worker = new PlmBomNotificationWorker(tx,service,() => undefined)
    try { await worker.start(); await worker.tick() } finally { await worker.stop() }
    expect((await pool.query('SELECT * FROM meta_record_subscription_notifications WHERE source_event_id=$1',['bom-review:'+event.id])).rows.map(r => r.user_id)).toEqual(['owner'])
    expect((await pool.query('SELECT state FROM meta_plm_bom_review_notification_intents WHERE event_id=$1',[event.id])).rows[0].state).toBe('delivered')
  })
  it('two real background workers scan and persist a native receipt once, then stop cleanly', async () => {
    const p = await makePreview()
    const local = await service.create('owner',{ previewId: p.previewId,requestId: randomUUID() })
    const row = (await pool.query('SELECT r.* FROM meta_records r JOIN meta_plm_bom_review_rows l ON l.record_id=r.id WHERE l.binding_id=$1 AND l.bom_line_id=$2',[local.id,'RC'])).rows[0]
    const field = getObjectFieldId('plm-bom-review',p.previewId,'status'), owner = getObjectFieldId('plm-bom-review',p.previewId,'owner')
    await service.notifications('owner',local.id,{ expectedVersion: 0,notifications: {
      issue: { enabled: true,recipientStrategy: 'event_owner' },
      reminder: { enabled: false,recipientStrategy: null,leadMinutes: null },
      escalation: { enabled: false,slaMinutes: null,recipientUserIds: [] },
    } })
    await pool.query('UPDATE meta_records SET data=data||$1::jsonb,version=version+1 WHERE id=$2',[JSON.stringify({ [field]: '评审中',[owner]: ['owner'] }),row.id])
    await pool.query('UPDATE meta_records SET data=data||$1::jsonb,version=version+1 WHERE id=$2',[JSON.stringify({ [field]: '有问题' }),row.id])
    const failures: number[] = []
    const first = new PlmBomNotificationWorker(tx,service,() => failures.push(1))
    const second = new PlmBomNotificationWorker(tx,service,() => failures.push(1))
    try {
      await Promise.all([first.start(),second.start()])
      await Promise.all([first.tick(),second.tick()])
      expect((await pool.query(`SELECT n.* FROM meta_record_subscription_notifications n
        JOIN meta_plm_bom_review_notification_events e ON n.source_event_id='bom-review:'||e.id::text
        WHERE e.binding_id=$1`,[local.id])).rows.map((r) => r.user_id)).toEqual(['owner'])
      expect((await pool.query(`SELECT i.state FROM meta_plm_bom_review_notification_intents i
        JOIN meta_plm_bom_review_notification_events e ON e.id=i.event_id WHERE e.binding_id=$1`,[local.id])).rows).toEqual([{ state: 'delivered' }])
      expect(failures).toHaveLength(0)
    } finally { await Promise.all([first.stop(),second.stop()]) }
  })
  it('notification config and native audit roll back together when the audit INSERT fails', async () => {
    const failing = new PlmBomReviewService({ pool: {
      query: tx.query,
      transaction: (fn) => tx.transaction(({ query }) => fn({ query: async (text,params) => {
        if (text.includes('INSERT INTO meta_config_revisions')) throw new Error('synthetic config audit failure')
        return query(text,params)
      } })),
    }, dataSourceManager: { getDataSource: () => adapter as never } })
    const notifications = {
      issue: { enabled: true, recipientStrategy: 'event_owner' },
      reminder: { enabled: false, recipientStrategy: 'current_owner', leadMinutes: null },
      escalation: { enabled: false, slaMinutes: null, recipientUserIds: [] },
    }
    expect(await service.notifications('owner', b.id)).toEqual({ version: 0, notifications: null })
    await expect(failing.notifications('owner', b.id, { expectedVersion: 0, notifications }))
      .rejects.toThrow('synthetic config audit failure')
    expect(await service.notifications('owner', b.id)).toEqual({ version: 0, notifications: null })
    expect((await pool.query('SELECT count(*)::int n FROM meta_config_revisions WHERE entity_id=$1',
      [`plm-bom-review:${b.id}:notifications`])).rows[0].n).toBe(0)
  })
  it('state migration leaves unenrolled legacy rows unchanged and refuses rollback of enrolled evidence', async () => {
    await expect(reviewStatesDown(new Kysely({ dialect: new PostgresDialect({ pool }) })))
      .rejects.toThrow('bom_review_state_mapping_present')
    await pool.query('CREATE SCHEMA state_migration')
    const isolated = new Pool({ connectionString: process.env.DATABASE_URL,
      options: '-c search_path=state_migration,public', max: 1 })
    const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: isolated }) })
    try {
      await isolated.query(`CREATE TABLE meta_records(id text PRIMARY KEY,sheet_id text,data jsonb);
        CREATE TABLE meta_fields(id text PRIMARY KEY,type text,sheet_id text,property jsonb);
        CREATE TABLE meta_plm_bom_review_bindings(id uuid PRIMARY KEY,sheet_id text);
        CREATE TABLE meta_config_revisions(id uuid PRIMARY KEY);
        CREATE TABLE meta_record_subscription_notifications(id uuid PRIMARY KEY,user_id text);
        INSERT INTO meta_records VALUES('legacy','legacy','{"status":"custom"}');`)
      await reviewStatesUp(db)
      await isolated.query("UPDATE meta_records SET data='{}'::jsonb WHERE id='legacy'")
      expect((await isolated.query('SELECT data FROM meta_records')).rows).toEqual([{ data: {} }])
      await reviewStatesDown(db)
      expect((await isolated.query('SELECT data FROM meta_records')).rows).toEqual([{ data: {} }])
    } finally {
      await db.destroy()
      await pool.query('DROP SCHEMA state_migration CASCADE')
    }
  })
  it('new shares include one audited native owner-group view without changing primary navigation', async () => {
    const views = (
      await pool.query(
        'SELECT * FROM meta_views WHERE sheet_id=$1 ORDER BY created_at,id',
        [b.sheetId],
      )
    ).rows
    expect(views).toHaveLength(4)
    expect(views[0]).toMatchObject({ id: b.viewId,name: '全部',filter_info: {} })
    const ownerField = (
      await pool.query(
        "SELECT id FROM meta_fields WHERE sheet_id=$1 AND name='负责人'",
        [b.sheetId],
      )
    ).rows[0].id
    expect(views[1]).toMatchObject({
      name: '按负责人',
      type: 'grid',
      group_info: { fieldId: ownerField, fieldIds: [ownerField] },
    })
    const statusId = getObjectFieldId('plm-bom-review',preview.previewId,'status')
    for (const [index,name,state] of [[2,'待评审','待评审'],[3,'问题项','有问题']] as const) {
      expect(views[index]).toMatchObject({ name,type: 'grid',filter_info: {
        conjunction: 'and',conditions: [{ fieldId: statusId,operator: 'is',value: state }],
      } })
      const audit = (await pool.query("SELECT * FROM meta_config_revisions WHERE sheet_id=$1 AND entity_type='view' AND entity_id=$2",[b.sheetId,views[index].id])).rows
      expect(audit).toHaveLength(1); expect(audit[0].after.filterInfo).toEqual(views[index].filter_info)
    }
    expect((await binding()).owner_view_initialized).toBe(true)
    const revisions = (
      await pool.query(
        "SELECT * FROM meta_config_revisions WHERE sheet_id=$1 AND entity_type='view' AND entity_id=$2",
        [b.sheetId, views[1].id],
      )
    ).rows
    expect(revisions).toHaveLength(1)
    expect(revisions[0]).toMatchObject({
      action: 'create',
      actor_id: 'owner',
      after: { groupInfo: { fieldId: ownerField, fieldIds: [ownerField] } },
    })
  })
  it('snapshot visibility is native member scope, no source-access inheritance', async () => {
    expect((await service.list('outsider', 'ds', 'P')).items).toEqual([])
    await pool.query(
      "INSERT INTO spreadsheet_permissions VALUES($1,'user','member','spreadsheet:write')",
      [b.sheetId],
    )
    const shown = (await service.list('member', 'ds', 'P')).items
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ canRefresh: false, canDisable: false })
    await expect(
      service.refresh('member', b.id, { expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('two native users edit local fields with CAS/history/durable event; readonly rejects', async () => {
    const native = new RecordService(tx as never, new EventEmitter() as never),
      row = await child(),
      stored = await binding()
    const note = (
      await pool.query(
        "SELECT id FROM meta_fields WHERE sheet_id=$1 AND name='备注'",
        [b.sheetId],
      )
    ).rows[0].id
    const edit = async (actor: string, value: string, version: number) => {
      const { capabilities } = await resolveSheetCapabilitiesForUserOnQuery(
        tx.query,
        b.sheetId,
        actor,
      )
      return native.patchRecord({
        recordId: row.id,
        sheetId: b.sheetId,
        data: { [note]: value },
        expectedVersion: version,
        access: { userId: actor, isAdminRole: false, permissions: [] },
        capabilities,
      } as never)
    }
    await edit('member', 'member opinion', 1)
    await expect(edit('owner', 'stale overwrite', 1)).rejects.toMatchObject({
      name: 'VersionConflictError',
    })
    await edit('owner', 'owner note', 2)
    expect((await child()).data[note]).toBe('owner note')
    const { capabilities } = await resolveSheetCapabilitiesForUserOnQuery(
      tx.query,
      b.sheetId,
      'owner',
    )
    await expect(
      native.patchRecord({
        recordId: row.id,
        sheetId: b.sheetId,
        data: { [stored.fields.quantity]: '99' },
        expectedVersion: 3,
        access: { userId: 'owner', permissions: [], isAdminRole: false },
        capabilities,
      } as never),
    ).rejects.toThrow()
    expect(
      (await pool.query('SELECT count(*)::int n FROM meta_automation_outbox'))
        .rows[0].n,
    ).toBe(2)
  })
  it('refresh preserves local collaboration and removed row history, then can restore source occurrence', async () => {
    const old = await child(),
      stored = await binding()
    current.context.lines = current.context.lines.filter(
      (x) => x.bom_line_id !== 'RC',
    )
    b = await service.refresh('owner', b.id, { expectedVersion: Number(b.version) })
    const removed = await child()
    expect(removed.data).toMatchObject({
      ...old.data,
      [stored.fields.sync_status]: 'removed',
      [stored.fields.occurrences]: '[]',
    })
    expect(removed.version).toBe(old.version + 1)
    current = shareSnapshot()
    b = await service.refresh('owner', b.id, { expectedVersion: Number(b.version) })
    expect((await child()).data[stored.fields.sync_status]).toBe('snapshot')
  })
  it('provider config changes across await fail closed and stale retained snapshot without rewriting rows', async () => {
    const before = await child()
    onFetch = async () => {
      await pool.query(
        "UPDATE data_sources SET config=jsonb_set(config,'{connection,baseUrl}','\"https://changed.invalid\"') WHERE id='ds'",
      )
    }
    await expect(
      service.refresh('owner', b.id, { expectedVersion: Number(b.version) }),
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
    onFetch = undefined
    expect(await child()).toEqual(before)
    expect((await binding()).status).toBe('stale')
    await pool.query("UPDATE data_sources SET config=$1::jsonb WHERE id='ds'", [
      JSON.stringify({
        connection: config.connection,
        credentials: config.credentials,
        options: config.options,
      }),
    ])
    b = (await service.list('owner', 'ds', 'P')).items[0]
  })
  it('previews cannot replay changed source or target, expiry, wrong actor, or reused request id', async () => {
    const p = await makePreview()
    current.context.lines[0].quantity = 9
    await expect(
      service.create('owner', {
        previewId: p.previewId,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
    current = shareSnapshot()
    await pool.query(
      "UPDATE meta_plm_bom_review_previews SET expires_at=now()-interval '1 second' WHERE id=$1",
      [p.previewId],
    )
    await expect(
      service.create('owner', {
        previewId: p.previewId,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'PREVIEW_EXPIRED' })
    await expect(
      service.create('member', { previewId: preview.previewId, requestId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('confirmation rechecks base ownership after provider await and reuses no foreign request id', async () => {
    const p = await makePreview(),
      before = await counts()
    onFetch = async () => {
      await pool.query(
        "UPDATE meta_bases SET owner_id='outsider' WHERE id='base'",
      )
    }
    try {
      await expect(
        service.create('owner', {
          previewId: p.previewId,
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(await counts()).toEqual(before)
    } finally {
      onFetch = undefined
      await pool.query("UPDATE meta_bases SET owner_id='owner' WHERE id='base'")
    }
    await expect(
      service.create('owner', { previewId: p.previewId, requestId }),
    ).rejects.toMatchObject({ code: 'BINDING_CONFLICT' })
    expect(await counts()).toEqual(before)
  })
  it('explicit row deny prevents refresh and retains all local/source data', async () => {
    const row = await child(),
      before = await counts()
    await pool.query(
      "INSERT INTO record_permissions(sheet_id,record_id,subject_type,subject_id,access_level) VALUES($1,$2,'user','owner','none')",
      [b.sheetId, row.id],
    )
    current.context.lines[1].quantity = 6
    current.context.lines[3].quantity = 6
    try {
      await expect(
        service.refresh('owner', b.id, { expectedVersion: Number(b.version) }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(await child()).toEqual(row)
      expect(await counts()).toEqual(before)
    } finally {
      await pool.query('DELETE FROM record_permissions WHERE sheet_id=$1', [
        b.sheetId,
      ])
      current = shareSnapshot()
    }
  })
  it('revision SQL failure rolls all source changes and receipt/ledger back', async () => {
    const before = await counts(),
      old = await child()
    current.context.lines[1].quantity = 5
    current.context.lines[3].quantity = 5
    await pool.query(
      "CREATE FUNCTION reject_bom_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$; CREATE TRIGGER reject_bom_revision BEFORE INSERT ON meta_record_revisions FOR EACH ROW EXECUTE FUNCTION reject_bom_revision()",
    )
    await expect(
      service.refresh('owner', b.id, { expectedVersion: Number(b.version) }),
    ).rejects.toThrow('synthetic')
    await pool.query(
      'DROP TRIGGER reject_bom_revision ON meta_record_revisions; DROP FUNCTION reject_bom_revision()',
    )
    expect(await counts()).toEqual(before)
    expect(await child()).toEqual(old)
    current = shareSnapshot()
  })
  it.each([
    { visible: false, readOnly: false },
    { visible: true, readOnly: true },
  ])(
    'explicit source field permission %j refuses snapshot publish',
    async (deny) => {
      const stored = await binding(),
        before = await child(),
        version = b.version
      await pool.query(
        "INSERT INTO field_permissions(sheet_id,field_id,subject_type,subject_id,visible,read_only) VALUES($1,$2,'user','owner',$3,$4)",
        [b.sheetId, stored.fields.quantity, deny.visible, deny.readOnly],
      )
      current.context.lines[1].quantity = 8
      current.context.lines[3].quantity = 8
      try {
        await expect(
          service.refresh('owner', b.id, { expectedVersion: version }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' })
        expect(await child()).toEqual(before)
      } finally {
        await pool.query('DELETE FROM field_permissions WHERE sheet_id=$1', [
          b.sheetId,
        ])
        current = shareSnapshot()
        b = (await service.list('owner', 'ds', 'P')).items[0]
      }
    },
  )
  it('concurrent refresh has one CAS winner', async () => {
    const result = await Promise.allSettled([
      service.refresh('owner', b.id, { expectedVersion: Number(b.version) }),
      service.refresh('owner', b.id, { expectedVersion: Number(b.version) }),
    ])
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(result.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'VERSION_CONFLICT' },
    })
    b = (await service.list('owner', 'ds', 'P')).items[0]
  })
  it.each([
    'source-cell',
    'record-delete',
    'field-retype',
    'field-delete',
    'field-unlock',
    'sheet-delete',
    'base-soft-delete',
    'truncate',
    'fake-sync',
  ])(
    'ordinary %s cannot change authority or remove provenance',
    async (action) => {
      const r = await child(),
        s = await binding(),
        queries: Record<string, [string, unknown[]]> = {
          'source-cell': [
            'UPDATE meta_records SET data=data||$1::jsonb WHERE id=$2',
            [JSON.stringify({ [s.fields.quantity]: '999' }), r.id],
          ],
          'record-delete': ['DELETE FROM meta_records WHERE id=$1', [r.id]],
          'field-retype': [
            "UPDATE meta_fields SET type='number' WHERE id=$1",
            [s.fields.quantity],
          ],
          'field-delete': [
            'DELETE FROM meta_fields WHERE id=$1',
            [s.fields.quantity],
          ],
          'field-unlock': [
            "UPDATE meta_fields SET property='{}' WHERE id=$1",
            [s.fields.quantity],
          ],
          'sheet-delete': ['DELETE FROM meta_sheets WHERE id=$1', [b.sheetId]],
          'base-soft-delete': [
            'UPDATE meta_bases SET deleted_at=now() WHERE id=$1',
            [b.baseId],
          ],
          truncate: ['TRUNCATE meta_records', []],
          'fake-sync': [
            'UPDATE meta_records SET data=data||$1::jsonb WHERE id=$2',
            [JSON.stringify({ [s.fields.quantity]: '999' }), r.id],
          ],
        }
      await expect(
        tx.transaction(async ({ query }) => {
          if (action === 'fake-sync')
            await query(
              "SELECT set_config('metasheet.bom_review_sync',$1,true)",
              [randomUUID()],
            )
          const [sql, params] = queries[action]
          await query(sql, params)
        }),
      ).rejects.toMatchObject({ code: action === 'truncate' ? '0A000' : '23514' })
    },
  )
  it('actual connected adapter uses freshly persisted raw per-source config rather than global normalized cache', async () => {
    const calls: {
      url: string
      authorization: unknown
      tenant: unknown
      org: unknown
    }[] = []
    const server = createServer((req, res) => {
      calls.push({
        url: req.url!,
        authorization: req.headers.authorization,
        tenant: req.headers['x-tenant-id'],
        org: req.headers['x-org-id'],
      })
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify(
          req.url?.endsWith('/share-context') ? shareSnapshot() : {},
        ),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const raw = {
      id: 'real',
      name: 'Real',
      type: 'plm',
      connection: { url },
      options: { apiMode: 'yuantus', tenantId: 't', orgId: 'o' },
      credentials: { token: 'explicit-source-token' },
    }
    const globalConfig: Record<string, unknown> = {
      'plm.url': url,
      'plm.mock': false,
      'plm.apiMode': 'yuantus',
      'plm.tenantId': 'global-t',
      'plm.orgId': 'global-o',
      'plm.apiToken': 'global-token',
    }
    const connected = new PLMAdapter(
      { get: async (key: string) => globalConfig[key] } as never,
      { info: () => {}, warn: () => {}, error: () => {} } as never,
      structuredClone(raw) as never,
    )
    connected.on('error', () => {})
    try {
      await connected.connect()
      expect(connected.isConnected()).toBe(true)
      expect(connected.getConfig().connection).toMatchObject({
        baseURL: url,
        headers: { 'x-tenant-id': 'global-t', 'x-org-id': 'global-o' },
      })
      await pool.query(
        "INSERT INTO data_sources(id,name,type,config,owner_id,is_active,scope_kind) VALUES('real','Real','plm',$1,'owner',true,'user')",
        [
          JSON.stringify({
            connection: raw.connection,
            options: raw.options,
            credentials: raw.credentials,
          }),
        ],
      )
      const realService = new PlmBomReviewService({
        pool: tx,
        dataSourceManager: { getDataSource: () => connected },
      })
      const p = await realService.preview('owner', {
        dataSourceId: 'real',
        partId: 'P',
        baseId: 'base',
        name: 'Real connected',
      })
      const shared = await realService.create('owner', {
        previewId: p.previewId,
        requestId: randomUUID(),
      })
      expect(shared.lineCount).toBe(3)
      const fetches = calls.filter((c) => c.url.endsWith('/share-context'))
      expect(fetches).toHaveLength(2)
      expect(
        fetches.every(
          (c) =>
            c.authorization === 'Bearer explicit-source-token' &&
            c.tenant === 't' &&
            c.org === 'o',
        ),
      ).toBe(true)
      await pool.query(
        "UPDATE data_sources SET config=jsonb_set(config,'{credentials}','{}') WHERE id='real'",
      )
      await expect(
        realService.preview('owner', {
          dataSourceId: 'real',
          partId: 'P',
          baseId: 'base',
          name: 'No fallback',
        }),
      ).rejects.toMatchObject({ code: 'SOURCE_FORBIDDEN' })
      expect(
        calls.filter((c) => c.url.endsWith('/share-context')),
      ).toHaveLength(2)
    } finally {
      await connected.disconnect()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  it('disable retains snapshot and all protection, no new refresh; migration refuses evidence loss', async () => {
    b = await service.disable('owner', b.id, { expectedVersion: Number(b.version) })
    expect(b).toMatchObject({
      status: 'disabled',
      canRefresh: false,
      canDisable: false,
    })
    await expect(
      service.refresh('owner', b.id, { expectedVersion: Number(b.version) }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    const row = await child(),
      stored = await binding()
    await expect(
      pool.query('UPDATE meta_records SET data=data||$1::jsonb WHERE id=$2', [
        JSON.stringify({ [stored.fields.quantity]: '999' }),
        row.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      down(new Kysely({ dialect: new PostgresDialect({ pool }) })),
    ).rejects.toThrow('bom_review_source_evidence_present')
    expect((await service.list('member', 'ds', 'P')).items).toHaveLength(1)
  })
})

// Persist an old-format, empty BOM snapshot using the predecessor schema's actual primitives.
// The additive marker defaults false; no trigger is disabled and no new true marker is reset.
async function legacyOwnerViewBinding() {
  const p = await makePreview()
  const stored = (
    await pool.query('SELECT * FROM meta_plm_bom_review_previews WHERE id=$1', [
      p.previewId,
    ])
  ).rows[0]
  const id = randomUUID(),
    sheetId = getObjectSheetId('plm-bom-review', p.previewId)
  const viewId = getObjectViewId('plm-bom-review', p.previewId, 'grid')
  const ownerId = getObjectFieldId('plm-bom-review', p.previewId, 'owner')
  const groupedId = getObjectViewId('plm-bom-review', p.previewId, 'owner')
  const fields = Object.fromEntries(
    SOURCE_FIELDS.map((k) => [
      k,
      getObjectFieldId('plm-bom-review', p.previewId, k),
    ]),
  )
  await tx.transaction(async ({ query }) => {
    await createSheet({ query, sheetId, baseId: 'base', name: 'Legacy review' })
    await ensureFields({
      query,
      sheetId,
      fields: [
        ...SOURCE_FIELDS.map((k) => ({
          id: fields[k],
          name: `PLM ${k}`,
          type: 'string' as const,
          property: { readOnly: true },
        })),
        ...LOCAL_FIELDS.map((f) => ({
          ...f,
          id: getObjectFieldId('plm-bom-review', p.previewId, f.id),
          property: 'property' in f ? { options: [...f.property.options] } : {},
        })),
      ],
    })
    await createView({
      query,
      sheetId,
      viewId,
      name: 'User original',
      type: 'grid',
      sortInfo: { fieldId: ownerId, direction: 'desc' },
    })
    await query(
      "INSERT INTO spreadsheet_permissions(sheet_id,subject_type,subject_id,perm_code) VALUES($1,'user','owner','spreadsheet:admin')",
      [sheetId],
    )
    await query(
      `INSERT INTO meta_plm_bom_review_bindings(id,data_source_id,part_id,creator_id,source_fingerprint,source,base_id,sheet_id,view_id,name,fields,status,snapshot_hash,last_synced_at,line_count,occurrence_count)
      VALUES($1,'ds','P','owner',$2,$3,'base',$4,$5,'Legacy review',$6,'active',$7,now(),0,0)`,
      [
        id,
        stored.source_fingerprint,
        stored.source,
        sheetId,
        viewId,
        JSON.stringify(fields),
        stored.snapshot_hash,
      ],
    )
    await query(
      "UPDATE meta_plm_bom_review_previews SET binding_id=$2,request_id=$3,expires_at=now()-interval '1 day' WHERE id=$1",
      [p.previewId, id, randomUUID()],
    )
  })
  return { id, sheetId, viewId, ownerId, groupedId, fields,previewId: p.previewId }
}
async function ownerViewState(id: string) {
  const stored = (
    await pool.query('SELECT * FROM meta_plm_bom_review_bindings WHERE id=$1', [
      id,
    ])
  ).rows[0]
  return {
    binding: stored,
    views: (
      await pool.query(
        'SELECT * FROM meta_views WHERE sheet_id=$1 ORDER BY id',
        [stored.sheet_id],
      )
    ).rows,
    revisions: (
      await pool.query(
        "SELECT * FROM meta_config_revisions WHERE sheet_id=$1 AND entity_type='view' ORDER BY id",
        [stored.sheet_id],
      )
    ).rows,
    records: (
      await pool.query(
        'SELECT * FROM meta_records WHERE sheet_id=$1 ORDER BY id',
        [stored.sheet_id],
      )
    ).rows,
  }
}
async function enrolledStatusViewsBinding() {
  const old = await legacyOwnerViewBinding()
  const field = getObjectFieldId('plm-bom-review',old.previewId,'status')
  await pool.query('INSERT INTO meta_plm_bom_review_state_fields(binding_id,field_id,owner_field_id,due_field_id) VALUES($1,$2,$3,$4)',
    [old.id,field,old.ownerId,getObjectFieldId('plm-bom-review',old.previewId,'due_date')])
  return { ...old,field,pendingId: getObjectViewId('plm-bom-review',old.previewId,'pending-review'),issuesId: getObjectViewId('plm-bom-review',old.previewId,'issues') }
}
describe('registered review status view upgrade', () => {
  beforeAll(() => { current = shareSnapshot() })
  it('upgrades an expired registered binding once, preserving primary, serializing refresh and protecting its marker',async () => {
    const old = await enrolledStatusViewsBinding(), before = await ownerViewState(old.id)
    expect(before.binding.status_views_initialized).toBe(false)
    const raced = await Promise.allSettled([service.refresh('owner',old.id,{ expectedVersion: 1 }),service.refresh('owner',old.id,{ expectedVersion: 1 })])
    expect(raced.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect((raced.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'VERSION_CONFLICT' })
    const after = await ownerViewState(old.id)
    expect(after.binding.status_views_initialized).toBe(true)
    expect(after.views.find(v => v.id === old.viewId)).toEqual(before.views[0])
    for (const [id,value] of [[old.pendingId,'待评审'],[old.issuesId,'有问题']]) {
      expect(after.views.find(v => v.id === id).filter_info).toEqual({ conjunction: 'and',conditions: [{ fieldId: old.field,operator: 'is',value }] })
      expect(after.revisions.filter(r => r.entity_id === id)).toHaveLength(1)
    }
    await service.refresh('owner',old.id,{ expectedVersion: 2 })
    expect((await ownerViewState(old.id)).views).toEqual(after.views)
    expect((await ownerViewState(old.id)).revisions).toEqual(after.revisions)
    await pool.query('DELETE FROM meta_views WHERE id=$1',[old.issuesId])
    await service.refresh('owner',old.id,{ expectedVersion: 3 })
    expect((await ownerViewState(old.id)).views.some(v => v.id === old.issuesId)).toBe(false)
    await expect(pool.query('UPDATE meta_plm_bom_review_bindings SET status_views_initialized=false WHERE id=$1',[old.id])).rejects.toMatchObject({ code: '23514' })
    const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
    await expect(statusViewsDown(db)).rejects.toThrow('bom_review_status_view_initialization_evidence_present')
  })
  it('cannot admit status view initialization after a binding was disabled',async () => {
    const old = await enrolledStatusViewsBinding()
    await service.disable('owner',old.id,{ expectedVersion: 1 })
    await expect(pool.query('UPDATE meta_plm_bom_review_bindings SET status_views_initialized=true WHERE id=$1',[old.id])).rejects.toMatchObject({ code: '23514' })
    const state = await ownerViewState(old.id)
    expect(state.binding.status_views_initialized).toBe(false); expect(state.views).toHaveLength(1)
    await expect(service.refresh('owner',old.id,{ expectedVersion: 2 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(await ownerViewState(old.id)).toEqual(state)
  })
  it('retains an existing customized reserved view and audits only the actually created missing view',async () => {
    const old = await enrolledStatusViewsBinding()
    await createView({ query: tx.query,sheetId: old.sheetId,viewId: old.pendingId,name: 'Existing user view',type: 'grid',
      filterInfo: { conjunction: 'and',conditions: [{ fieldId: old.field,operator: 'is',value: '评审中' }] } })
    const before = (await pool.query('SELECT * FROM meta_views WHERE id=$1',[old.pendingId])).rows[0]
    await service.refresh('owner',old.id,{ expectedVersion: 1 })
    const after = await ownerViewState(old.id)
    expect(after.binding.status_views_initialized).toBe(true)
    expect(after.views.find(v => v.id === old.pendingId)).toEqual(before)
    expect(after.revisions.some(r => r.entity_id === old.pendingId)).toBe(false)
    expect(after.revisions.filter(r => r.entity_id === old.issuesId)).toHaveLength(1)
  })
  it('does not recreate physically deleted views whose native history predates the marker upgrade',async () => {
    const old = await enrolledStatusViewsBinding()
    await tx.transaction(async ({ query }) => {
      for (const id of [old.pendingId,old.issuesId]) {
        const created = await createView({ query,sheetId: old.sheetId,viewId: id,name: 'Previously used view',type: 'grid' })
        await recordConfigRevision(query,{
          sheetId: old.sheetId,entityType: 'view',entityId: id,action: 'create',before: null,after: created.view,
          changedKeys: ['name'],batchId: old.id,actorId: 'owner',
        })
        await query('DELETE FROM meta_views WHERE id=$1',[id])
        await recordConfigRevision(query,{
          sheetId: old.sheetId,entityType: 'view',entityId: id,action: 'delete',before: created.view,after: null,
          changedKeys: ['deleted'],batchId: old.id,actorId: 'owner',
        })
      }
    })
    const before = (await ownerViewState(old.id)).revisions.filter(r => [old.pendingId,old.issuesId].includes(r.entity_id))
    expect(before).toHaveLength(4)
    await service.refresh('owner',old.id,{ expectedVersion: 1 })
    const after = await ownerViewState(old.id)
    expect(after.binding.status_views_initialized).toBe(true)
    expect(after.views.some(v => [old.pendingId,old.issuesId].includes(v.id))).toBe(false)
    expect(after.revisions.filter(r => [old.pendingId,old.issuesId].includes(r.entity_id))).toEqual(before)
  })
  it.each(['metadata','scoped'])('waits without consuming status initialization when the field is %s hidden',async (mode) => {
    const old = await enrolledStatusViewsBinding()
    if (mode === 'metadata') await pool.query("UPDATE meta_fields SET property=property||'{\"hidden\":true}'::jsonb WHERE id=$1",[old.field])
    else await pool.query("INSERT INTO field_permissions(sheet_id,field_id,subject_type,subject_id,visible,read_only) VALUES($1,$2,'user','owner',false,false)",[old.sheetId,old.field])
    try {
      await service.refresh('owner',old.id,{ expectedVersion: 1 })
      const waiting = await ownerViewState(old.id)
      expect(waiting.binding.status_views_initialized).toBe(false)
      expect(waiting.views.some(v => [old.pendingId,old.issuesId].includes(v.id))).toBe(false)
    } finally {
      if (mode === 'metadata') await pool.query("UPDATE meta_fields SET property=property-'hidden' WHERE id=$1",[old.field])
      else await pool.query('DELETE FROM field_permissions WHERE sheet_id=$1 AND field_id=$2',[old.sheetId,old.field])
    }
    await service.refresh('owner',old.id,{ expectedVersion: 2 })
    expect((await ownerViewState(old.id)).binding.status_views_initialized).toBe(true)
  })
  it('a share-only source owner waits for native view management permission',async () => {
    const old = await enrolledStatusViewsBinding()
    await pool.query('DELETE FROM spreadsheet_permissions WHERE sheet_id=$1',[old.sheetId])
    await pool.query("INSERT INTO user_permissions(user_id,permission_code) VALUES('owner','multitable:read'),('owner','multitable:share')")
    try {
      await service.refresh('owner',old.id,{ expectedVersion: 1 })
      const waiting = await ownerViewState(old.id)
      expect(waiting.binding.status_views_initialized).toBe(false); expect(waiting.views).toHaveLength(1)
      await pool.query("INSERT INTO spreadsheet_permissions VALUES($1,'user','owner','spreadsheet:admin')",[old.sheetId])
      await service.refresh('owner',old.id,{ expectedVersion: 2 })
      expect((await ownerViewState(old.id)).binding.status_views_initialized).toBe(true)
    } finally { await pool.query("DELETE FROM user_permissions WHERE user_id='owner'") }
  })
  it.each(['missing','duplicate','wrong-sheet'])('rejects %s original preview integrity even when owner initialization was previously consumed',async (mode) => {
    const old = await enrolledStatusViewsBinding()
    await pool.query('UPDATE meta_plm_bom_review_bindings SET owner_view_initialized=true WHERE id=$1',[old.id])
    if (mode === 'missing') await pool.query('UPDATE meta_plm_bom_review_previews SET binding_id=null WHERE binding_id=$1',[old.id])
    else if (mode === 'duplicate') {
      const extra = await makePreview()
      await pool.query('UPDATE meta_plm_bom_review_previews SET binding_id=$2 WHERE id=$1',[extra.previewId,old.id])
    } else await pool.query('UPDATE meta_plm_bom_review_previews SET id=$2 WHERE binding_id=$1',[old.id,randomUUID()])
    const before = await ownerViewState(old.id)
    await expect(service.refresh('owner',old.id,{ expectedVersion: 1 })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(await ownerViewState(old.id)).toEqual(before)
  })
  it.each(['view','audit'])('rolls the %s failure back with marker, source version and all records',async (target) => {
    const old = await enrolledStatusViewsBinding()
    await pool.query('UPDATE meta_plm_bom_review_bindings SET owner_view_initialized=true WHERE id=$1',[old.id])
    const before = await ownerViewState(old.id)
    const failing = new PlmBomReviewService({ pool: { query: tx.query,transaction: fn => tx.transaction(({ query }) => fn({
      query: async (sql,params) => { if (target === 'view' ? sql.startsWith('INSERT INTO meta_views') : sql.startsWith('INSERT INTO meta_config_revisions')) throw new Error('synthetic status view failure'); return query(sql,params) },
    })) },dataSourceManager: { getDataSource: () => adapter as never } })
    await expect(failing.refresh('owner',old.id,{ expectedVersion: 1 })).rejects.toThrow('synthetic status view failure')
    expect(await ownerViewState(old.id)).toEqual(before)
    await service.refresh('owner',old.id,{ expectedVersion: 1 })
    expect((await ownerViewState(old.id)).binding.status_views_initialized).toBe(true)
  })
})
describe('owner default view upgrade and native customization', () => {
  beforeAll(() => {
    current = shareSnapshot()
  })
  it.each(['owner_view_initialized','status_views_initialized'])('old-schema missing %s fails closed before source or data work', async (marker) => {
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(
        `ALTER TABLE meta_plm_bom_review_bindings RENAME COLUMN ${marker} TO unavailable_marker`,
      )
      const old = new PlmBomReviewService({
        pool: {
          query: c.query.bind(c),
          transaction: (fn) => fn({ query: c.query.bind(c) }),
        },
        dataSourceManager: { getDataSource: () => adapter as never },
      })
      const calls = sourceCalls
      await expect(old.bases('owner')).rejects.toMatchObject({
        status: 503,
        code: 'RUNTIME_UNAVAILABLE',
      })
      expect(sourceCalls).toBe(calls)
    } finally {
      await c.query('ROLLBACK')
      c.release()
    }
  })
  it('old binding backfills once from its expired original preview, preserves primary and serializes concurrent refresh', async () => {
    const old = await legacyOwnerViewBinding()
    await pool.query(
      "UPDATE meta_fields SET name='User renamed owner' WHERE id=$1",
      [old.ownerId],
    )
    const before = await ownerViewState(old.id)
    expect(before.binding.owner_view_initialized).toBe(false)
    const results = await Promise.allSettled([
      service.refresh('owner', old.id, { expectedVersion: 1 }),
      service.refresh('owner', old.id, { expectedVersion: 1 }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'VERSION_CONFLICT' },
    })
    const after = await ownerViewState(old.id)
    expect(after.binding).toMatchObject({
      owner_view_initialized: true,
      version: '2',
      view_id: old.viewId,
    })
    expect(after.views.find((v) => v.id === old.viewId)).toEqual(
      before.views[0],
    )
    expect(after.views.find((v) => v.id === old.groupedId)).toMatchObject({
      group_info: { fieldId: old.ownerId, fieldIds: [old.ownerId] },
    })
    expect(after.revisions).toHaveLength(1)
    await service.refresh('owner', old.id, { expectedVersion: 2 })
    expect((await ownerViewState(old.id)).views).toEqual(after.views)
    expect((await ownerViewState(old.id)).revisions).toEqual(after.revisions)
  })
  it.each(['missing', 'duplicate', 'wrong-sheet'])(
    'rejects %s original receipt integrity failures without consuming initialization or writing source data',
    async (mode) => {
      const old = await legacyOwnerViewBinding()
      if (mode === 'missing')
        await pool.query(
          'UPDATE meta_plm_bom_review_previews SET binding_id=null WHERE binding_id=$1',
          [old.id],
        )
      else if (mode === 'duplicate') {
        const extra = await makePreview()
        await pool.query(
          'UPDATE meta_plm_bom_review_previews SET binding_id=$2 WHERE id=$1',
          [extra.previewId, old.id],
        )
      } else {
        await pool.query(
          'UPDATE meta_plm_bom_review_previews SET id=$2 WHERE binding_id=$1',
          [old.id, randomUUID()],
        )
      }
      const before = await ownerViewState(old.id)
      await expect(
        service.refresh('owner', old.id, { expectedVersion: 1 }),
      ).rejects.toMatchObject({ status: 503, code: 'RUNTIME_UNAVAILABLE' })
      expect(await ownerViewState(old.id)).toEqual(before)
    },
  )
  it.each(['deleted', 'retyped'])(
    'respects a %s owner field, marks a one-time skip and never manufactures view history',
    async (mode) => {
      const old = await legacyOwnerViewBinding()
      const original = (
        await pool.query('SELECT * FROM meta_fields WHERE id=$1', [old.ownerId])
      ).rows[0]
      if (mode === 'deleted')
        await pool.query('DELETE FROM meta_fields WHERE id=$1', [old.ownerId])
      else
        await pool.query("UPDATE meta_fields SET type='string' WHERE id=$1", [
          old.ownerId,
        ])
      await service.refresh('owner', old.id, { expectedVersion: 1 })
      const skipped = await ownerViewState(old.id)
      expect(skipped.binding.owner_view_initialized).toBe(true)
      expect(skipped.views).toHaveLength(1)
      expect(skipped.revisions).toEqual([])
      expect(skipped.records).toHaveLength(3)
      if (mode === 'deleted')
        await pool.query(
          'INSERT INTO meta_fields(id,sheet_id,name,type,property,"order") VALUES($1,$2,$3,$4,$5,$6)',
          [
            original.id,
            original.sheet_id,
            original.name,
            original.type,
            original.property,
            original.order,
          ],
        )
      else
        await pool.query("UPDATE meta_fields SET type='person' WHERE id=$1", [
          old.ownerId,
        ])
      await service.refresh('owner', old.id, { expectedVersion: 2 })
      expect((await ownerViewState(old.id)).views).toEqual(skipped.views)
      expect((await ownerViewState(old.id)).revisions).toEqual([])
    },
  )
  it('a share-only owner can refresh but cannot initialize a native view until view management is granted', async () => {
    const old = await legacyOwnerViewBinding()
    await pool.query('DELETE FROM spreadsheet_permissions WHERE sheet_id=$1', [
      old.sheetId,
    ])
    await pool.query(
      "INSERT INTO user_permissions(user_id,permission_code) VALUES('owner','multitable:read'),('owner','multitable:share')",
    )
    try {
      const { capabilities } = await resolveSheetCapabilitiesForUserOnQuery(
        tx.query,
        old.sheetId,
        'owner',
      )
      expect(capabilities).toMatchObject({
        canManageSheetAccess: true,
        canManageViews: false,
      })
      await service.refresh('owner', old.id, { expectedVersion: 1 })
      const state = await ownerViewState(old.id)
      expect(state.binding.owner_view_initialized).toBe(false)
      expect(state.records).toHaveLength(3)
      expect(state.views).toHaveLength(1)
      await pool.query(
        "INSERT INTO spreadsheet_permissions(sheet_id,subject_type,subject_id,perm_code) VALUES($1,'user','owner','spreadsheet:admin')",
        [old.sheetId],
      )
      await service.refresh('owner', old.id, { expectedVersion: 2 })
      expect(
        (await ownerViewState(old.id)).binding.owner_view_initialized,
      ).toBe(true)
    } finally {
      await pool.query("DELETE FROM user_permissions WHERE user_id='owner'")
    }
  })
  it('unauthorized or source-denied refresh cannot initialize or alter existing views', async () => {
    const old = await legacyOwnerViewBinding(),
      before = await ownerViewState(old.id)
    await expect(
      service.refresh('member', old.id, { expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await ownerViewState(old.id)).toEqual(before)
    await pool.query("UPDATE data_sources SET is_active=false WHERE id='ds'")
    try {
      await expect(
        service.refresh('owner', old.id, { expectedVersion: 1 }),
      ).rejects.toMatchObject({ code: 'SOURCE_FORBIDDEN' })
    } finally {
      await pool.query("UPDATE data_sources SET is_active=true WHERE id='ds'")
    }
    const after = await ownerViewState(old.id)
    expect(after.binding.owner_view_initialized).toBe(false)
    expect(after.views).toEqual(before.views)
    expect(after.revisions).toEqual([])
  })
  it.each(['view', 'audit'])(
    'a %s write failure rolls back initialization, source refresh and all records together',
    async (target) => {
      const old = await legacyOwnerViewBinding(),
        before = await ownerViewState(old.id)
      const failing = new PlmBomReviewService({
        pool: {
          query: tx.query,
          transaction: (fn) =>
            tx.transaction(({ query }) =>
              fn({
                query: async (sql, params) => {
                  if (
                    target === 'view'
                      ? sql.startsWith('INSERT INTO meta_views')
                      : sql.startsWith('INSERT INTO meta_config_revisions')
                  )
                    throw new Error('synthetic owner view failure')
                  return query(sql, params)
                },
              }),
            ),
        },
        dataSourceManager: { getDataSource: () => adapter as never },
      })
      await expect(
        failing.refresh('owner', old.id, { expectedVersion: 1 }),
      ).rejects.toThrow('synthetic owner view failure')
      expect(await ownerViewState(old.id)).toEqual(before)
      await service.refresh('owner', old.id, { expectedVersion: 1 })
      expect(
        (await ownerViewState(old.id)).binding.owner_view_initialized,
      ).toBe(true)
    },
  )
  it.each(['view', 'audit'])(
    'new share %s failure rolls back the sheet, grant, records, marker and receipt confirmation',
    async (target) => {
      const preview = await makePreview(),
        requestId = randomUUID()
      const before = await counts()
      const grants = (
        await pool.query('SELECT count(*)::int n FROM spreadsheet_permissions')
      ).rows[0].n
      const failing = new PlmBomReviewService({
        pool: {
          query: tx.query,
          transaction: (fn) =>
            tx.transaction(({ query }) =>
              fn({
                query: async (sql, params) => {
                  if (
                    target === 'view'
                      ? sql.startsWith('INSERT INTO meta_views') &&
                        params?.[2] === '按负责人'
                      : sql.startsWith('INSERT INTO meta_config_revisions') &&
                        params?.[2] === 'view'
                  )
                    throw new Error('synthetic create owner view failure')
                  return query(sql, params)
                },
              }),
            ),
        },
        dataSourceManager: { getDataSource: () => adapter as never },
      })
      await expect(
        failing.create('owner', { previewId: preview.previewId, requestId }),
      ).rejects.toThrow('synthetic create owner view failure')
      expect(await counts()).toEqual(before)
      expect(
        (
          await pool.query(
            'SELECT count(*)::int n FROM spreadsheet_permissions',
          )
        ).rows[0].n,
      ).toBe(grants)
      expect(
        (
          await pool.query(
            'SELECT binding_id,request_id FROM meta_plm_bom_review_previews WHERE id=$1',
            [preview.previewId],
          )
        ).rows[0],
      ).toEqual({ binding_id: null, request_id: null })
      const created = await service.create('owner', {
        previewId: preview.previewId,
        requestId,
      })
      expect(
        (await ownerViewState(created.id)).binding.owner_view_initialized,
      ).toBe(true)
    },
  )
  it('migration preserves an old binding, defaults it false, and allows unused marker rollback without weakening the old guard', async () => {
    await pool.query('CREATE SCHEMA owner_view_migration')
    const isolated = new Pool({
      connectionString: process.env.DATABASE_URL,
      options: '-c search_path=owner_view_migration,public',
      max: 1,
    })
    const db = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: isolated }),
    })
    try {
      await isolated.query(
        'CREATE TABLE meta_records(id text); CREATE TABLE meta_fields(id text); CREATE TABLE meta_sheets(id text); CREATE TABLE meta_bases(id text)',
      )
      await up(db)
      await isolated.query(
        `INSERT INTO meta_plm_bom_review_bindings(id,data_source_id,part_id,creator_id,source_fingerprint,source,base_id,sheet_id,view_id,name,fields,status,snapshot_hash,last_synced_at,line_count,occurrence_count)
        VALUES($1,'ds','P','owner','fixture-fingerprint','{}','base','sheet','view','Legacy','{}','active','fixture-snapshot',now(),0,0)`,
        [randomUUID()],
      )
      const old = (
        await isolated.query('SELECT * FROM meta_plm_bom_review_bindings')
      ).rows
      await ownerViewUp(db)
      expect(
        (
          await isolated.query(
            'SELECT owner_view_initialized FROM meta_plm_bom_review_bindings',
          )
        ).rows,
      ).toEqual([{ owner_view_initialized: false }])
      await ownerViewDown(db)
      expect(
        (await isolated.query('SELECT * FROM meta_plm_bom_review_bindings'))
          .rows,
      ).toEqual(old)
      await expect(
        isolated.query(
          "UPDATE meta_plm_bom_review_bindings SET creator_id='outsider'",
        ),
      ).rejects.toMatchObject({ code: '23514' })
      await ownerViewUp(db)
      expect(
        (
          await isolated.query(
            'SELECT owner_view_initialized FROM meta_plm_bom_review_bindings',
          )
        ).rows,
      ).toEqual([{ owner_view_initialized: false }])
    } finally {
      await isolated.end()
      await pool.query('DROP SCHEMA owner_view_migration CASCADE')
    }
  })
  it('marker is monotonic and does not unlock source changes or a disabled binding', async () => {
    const old = await legacyOwnerViewBinding()
    await service.refresh('owner', old.id, { expectedVersion: 1 })
    for (const update of [
      'owner_view_initialized=false',
      "source_fingerprint='changed'",
      "creator_id='outsider'",
      "fields='{}'::jsonb",
    ]) {
      await expect(
        pool.query(
          `UPDATE meta_plm_bom_review_bindings SET ${update} WHERE id=$1`,
          [old.id],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    }
    const disabled = await legacyOwnerViewBinding()
    await service.disable('owner', disabled.id, { expectedVersion: 1 })
    await expect(
      pool.query(
        'UPDATE meta_plm_bom_review_bindings SET owner_view_initialized=true WHERE id=$1',
        [disabled.id],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      pool.query(
        "UPDATE meta_plm_bom_review_bindings SET status='active' WHERE id=$1",
        [disabled.id],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })
  it('initialized evidence blocks down before any schema/function/data changes, observed on a new connection', async () => {
    const snapshot = async () => {
      const c = new Client({ connectionString: process.env.DATABASE_URL })
      await c.connect()
      try {
        return {
          rows: (
            await c.query(
              'SELECT * FROM meta_plm_bom_review_bindings ORDER BY id',
            )
          ).rows,
          columns: (
            await c.query(
              "SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='meta_plm_bom_review_bindings' ORDER BY ordinal_position",
            )
          ).rows,
          guard: (
            await c.query(
              "SELECT pg_get_functiondef('meta_bom_review_binding_guard()'::regprocedure) AS definition",
            )
          ).rows,
        }
      } finally {
        await c.end()
      }
    }
    const before = await snapshot()
    await expect(
      ownerViewDown(new Kysely({ dialect: new PostgresDialect({ pool }) })),
    ).rejects.toThrow('bom_review_owner_view_initialization_evidence_present')
    expect(await snapshot()).toEqual(before)
  })
})

describe('PLM change durable source verification', () => {
  it('revalidates owner and rules across source await, freezes receipts and rejects replay conflicts', async () => {
    const p = await makePreview(), local = await service.create('owner',{ previewId: p.previewId,requestId: randomUUID() })
    const binding = (await pool.query('SELECT * FROM meta_plm_bom_review_bindings WHERE id=$1',[local.id])).rows[0]
    const destination = randomUUID()
    await pool.query("INSERT INTO multitable_webhooks(id,name,url,secret,created_by) VALUES($1,'PLM fact','https://no-send.invalid','fixture','owner')",[destination])
    await pool.query("INSERT INTO user_permissions VALUES('owner','multitable:send_webhook')")
    const rules = { reviewCompleted: { enabled: false,webhookId: null,granularity: null },
      plmChangeApplied: { enabled: true,webhookId: destination,source: 'bom_line_writeback' } }
    let onVerify: (() => Promise<void>) | undefined, calls = 0
    const verifier = { ...adapter,verifyPlmChangeEvent: async (input: unknown) => {
      calls++; if (onVerify) await onVerify(); return structuredClone(input)
    } }
    const receiver = new PlmBomReviewService({ pool: tx,dataSourceManager: { getDataSource: () => verifier as never } })
    const event = { schema: 'yuantus.plm-change-event.v1',event_type: 'bom.plm_change.applied',
      event_id: randomUUID(),binding_id: local.id,binding_version: Number(binding.version),
      source: { connection_id: 'ds',tenant_id: binding.source.tenant_id,org_id: binding.source.org_id,part_id: binding.part_id },
      change: { kind: 'bom_line_writeback',audit_id: randomUUID(),bom_line_id: 'RC' },occurred_at: '2026-10-14T13:00:00.123456Z' }
    const count = async () => Number((await pool.query('SELECT count(*) n FROM meta_plm_bom_change_inbox WHERE binding_id=$1',[local.id])).rows[0].n)
    try {
      await expect(receiver.receiveChange('owner',event)).rejects.toMatchObject({ code: 'RULE_DISABLED' })
      expect(calls).toBe(0)
      await service.completionWebhooks('owner',local.id,{ expectedVersion: 0,webhooks: rules })
      await pool.query('ALTER TABLE meta_plm_bom_change_inbox RENAME TO unavailable_change_inbox')
      try {
        await expect(receiver.receiveChange('owner',event)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
        expect(calls).toBe(0)
      } finally { await pool.query('ALTER TABLE unavailable_change_inbox RENAME TO meta_plm_bom_change_inbox') }
      const receipts = await Promise.all([receiver.receiveChange('owner',event),receiver.receiveChange('owner',event)])
      expect(receipts[0]).toEqual(receipts[1]); expect(receipts[0].verified).toBe(true); expect(await count()).toBe(1)
      await expect(receiver.receiveChange('owner',{ ...event,occurred_at: '2026-10-14T13:00:01.123456Z' })).rejects.toMatchObject({ code: 'EVENT_CONFLICT' })
      await expect(receiver.receiveChange('outsider',event)).rejects.toThrow()
      const priorCalls = calls
      await expect(receiver.receiveChange('owner',{ ...event,source: { ...event.source,org_id: 'foreign' } })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
      expect(calls).toBe(priorCalls)
      onVerify = async () => { await pool.query("UPDATE data_sources SET owner_id='outsider' WHERE id='ds'") }
      await expect(receiver.receiveChange('owner',{ ...event,event_id: randomUUID() })).rejects.toMatchObject({ code: 'SOURCE_FORBIDDEN' })
      await pool.query("UPDATE data_sources SET owner_id='owner' WHERE id='ds'")
      onVerify = async () => { await service.completionWebhooks('owner',local.id,{ expectedVersion: 1,
        webhooks: { ...rules,reviewCompleted: { ...rules.reviewCompleted,granularity: 'bom' } } }) }
      await expect(receiver.receiveChange('owner',{ ...event,event_id: randomUUID() })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
      expect(await count()).toBe(1)
      await expect(pool.query("UPDATE meta_plm_bom_change_inbox SET payload='{}' WHERE binding_id=$1",[local.id])).rejects.toThrow('plm_change_inbox_protected')
      await expect(changeInboxDown(new Kysely({ dialect: new PostgresDialect({ pool }) }))).rejects.toThrow('plm_change_inbox_evidence_present')
    } finally {
      await pool.query("UPDATE data_sources SET owner_id='owner' WHERE id='ds'")
      await pool.query("DELETE FROM user_permissions WHERE user_id='owner' AND permission_code='multitable:send_webhook'")
    }
  })
})

describe('PLM success outbound delivery', () => {
  it.each(['bom_line_writeback','eco_batch_apply'])('delivers %s with stable retry identity and cancels revoked source', async (kind) => {
    const calls: Array<{ body: string; id: string; signature: string; type: string }> = []
    let status = 503, denied = false, transient = false, verifications = 0
    const peer = createServer((req,res) => {
      let body = ''; req.on('data',chunk => { body += chunk }); req.on('end',() => {
        calls.push({ body,id: String(req.headers['idempotency-key']),signature: String(req.headers['x-webhook-signature']),type: String(req.headers['x-webhook-event']) })
        res.writeHead(status); res.end()
      })
    })
    await new Promise<void>(resolve => peer.listen(0,'127.0.0.1',resolve))
    const port = (peer.address() as { port: number }).port
    const verifier = { ...adapter,verifyPlmChangeEvent: async (input: unknown) => {
      verifications++
      if (denied || transient) throw Object.assign(new Error('fixture source denial'),{ response: { status: denied ? 403 : 503 } })
      return structuredClone(input)
    } }
    const receiver = new PlmBomReviewService({ pool: tx,dataSourceManager: { getDataSource: () => verifier as never } })
    const p = await makePreview(), local = await service.create('owner',{ previewId: p.previewId,requestId: randomUUID() })
    const binding = (await pool.query('SELECT * FROM meta_plm_bom_review_bindings WHERE id=$1',[local.id])).rows[0]
    const target = randomUUID(),secret = 'local-plm-delivery-secret'
    await pool.query("INSERT INTO multitable_webhooks(id,name,url,secret,created_by,max_retries,retry_base_delay_ms) VALUES($1,'PLM success',$2,$3,'owner',2,100)",[target,`http://127.0.0.1:${port}`,secret])
    await pool.query("INSERT INTO user_permissions VALUES('owner','multitable:send_webhook')")
    try {
      await service.completionWebhooks('owner',local.id,{ expectedVersion: 0,webhooks: {
        reviewCompleted: { enabled: false,webhookId: null,granularity: null },plmChangeApplied: { enabled: true,webhookId: target,source: kind } } })
      const input = () => ({ schema: 'yuantus.plm-change-event.v1',event_type: 'bom.plm_change.applied',
        event_id: randomUUID(),binding_id: local.id,binding_version: Number(binding.version),
        source: { connection_id: 'ds',tenant_id: binding.source.tenant_id,org_id: binding.source.org_id,part_id: binding.part_id },
        change: kind === 'bom_line_writeback' ? { kind,audit_id: randomUUID(),bom_line_id: 'RC' } : { kind,eco_id: 'ECO-1',target_version_id: 'v2' },
        occurred_at: '2026-10-14T13:00:00.123456Z' })
      const capture = async () => {
        const event = input(); await receiver.receiveChange('owner',event)
        return (await pool.query('SELECT id FROM meta_plm_bom_review_completion_events WHERE binding_id=$1 AND plm_event_id=$2',[local.id,event.event_id])).rows[0].id
      }
      const first = await capture()
      expect(await receiver.deliverCompletion(first)).toEqual({ state: 'prepared' })
      const next = (await pool.query('SELECT next_retry_at FROM meta_plm_bom_review_completion_intents WHERE event_id=$1',[first])).rows[0].next_retry_at
      await new Promise(resolve => setTimeout(resolve,Math.max(0,new Date(next).getTime()-Date.now())+20))
      status = 204
      expect(await receiver.deliverCompletion(first)).toEqual({ state: 'delivered' })
      expect(calls).toHaveLength(2)
      expect(calls[0].id).toBe(calls[1].id); expect(calls[0].body).toBe(calls[1].body)
      expect(calls.every(c => c.type === 'bom.plm_change.applied' && c.signature === createHmac('sha256',secret).update(c.body).digest('hex'))).toBe(true)
      expect(verifications).toBe(3) // intake plus every actual delivery attempt
      const revoked = await capture(); denied = true
      expect(await receiver.deliverCompletion(revoked)).toEqual({ state: 'cancelled' })
      expect(calls).toHaveLength(2)
      denied = false
      const unavailable = await capture(); transient = true
      expect(await receiver.deliverCompletion(unavailable)).toEqual({ state: 'waiting' })
      expect((await pool.query('SELECT attempt_count FROM meta_plm_bom_review_completion_intents WHERE event_id=$1',[unavailable])).rows[0].attempt_count).toBe(0)
      transient = false
      expect(await receiver.deliverCompletion(unavailable)).toEqual({ state: 'delivered' })
      expect(calls).toHaveLength(3)
      const background = await capture()
      const others = (await pool.query('SELECT id,active FROM multitable_webhooks WHERE id<>$1',[target])).rows
      const worker = new PlmBomNotificationWorker(tx,receiver,() => undefined)
      try {
        await pool.query('UPDATE multitable_webhooks SET active=false WHERE id<>$1',[target])
        await worker.start(); await worker.stop()
        expect(calls.filter(c => c.id === background)).toHaveLength(1)
        expect((await pool.query('SELECT state FROM meta_plm_bom_review_completion_intents WHERE event_id=$1',[background])).rows[0].state).toBe('delivered')
      } finally {
        await worker.stop()
        for (const other of others) await pool.query('UPDATE multitable_webhooks SET active=$2 WHERE id=$1',[other.id,other.active])
      }
      await expect(changeDispatchDown(new Kysely({ dialect: new PostgresDialect({ pool }) }))).rejects.toThrow('plm_change_dispatch_evidence_present')
    } finally {
      await pool.query('UPDATE multitable_webhooks SET active=false WHERE id=$1',[target])
      await pool.query("DELETE FROM user_permissions WHERE user_id='owner' AND permission_code='multitable:send_webhook'")
      peer.closeAllConnections(); await new Promise<void>(resolve => peer.close(() => resolve()))
    }
  })
})


describe('durable owner-authorized PLM listener', () => {
  it.each(['bom_line_writeback','eco_batch_apply'])('baselines, atomically consumes and stops %s', async kind => {
    const local = await service.create('owner',{ previewId: (await makePreview()).previewId,requestId: randomUUID() })
    const b = (await pool.query('SELECT * FROM meta_plm_bom_review_bindings WHERE id=$1',[local.id])).rows[0]
    const target = randomUUID()
    await pool.query("INSERT INTO multitable_webhooks(id,name,url,created_by) VALUES($1,'listener','https://synthetic.invalid/listener','owner')",[target])
    await pool.query("INSERT INTO user_permissions VALUES('owner','multitable:send_webhook')")
    await service.completionWebhooks('owner',local.id,{ expectedVersion: 0,webhooks: {
      reviewCompleted: { enabled: false,webhookId: null,granularity: null },
      plmChangeApplied: { enabled: true,webhookId: target,source: kind } } })
    let head = 5, denied = false, fail = false, pages = 0
    let onPage: (() => Promise<void>) | undefined
    const facts = new Map<number,unknown>()
    const source = { ...adapter,verifyPlmChangeEvent: async (event: unknown) => event,
      getPlmChangePage: async (request: any) => {
        pages++
        if (onPage) await onPage()
        if (denied || fail) throw Object.assign(new Error('fixture'),{ response: { status: denied ? 403 : 503 } })
        return { schema: 'yuantus.plm-change-page.v1',source: request.source,head_sequence: head,next_sequence: head,
          events: request.after_sequence === undefined ? [] : [...facts].filter(([seq]) => seq>request.after_sequence)
            .map(([sequence,event]) => ({ sequence,event })) }
      } }
    const receiver = () => new PlmBomReviewService({ pool: tx,dataSourceManager: { getDataSource: () => source as never } })
    const event = (sourceKind = kind) => ({ schema: 'yuantus.plm-change-event.v1',event_type: 'bom.plm_change.applied',
      event_id: randomUUID(),binding_id: b.id,binding_version: Number(b.version),
      source: { connection_id: 'ds',tenant_id: b.source.tenant_id,org_id: b.source.org_id,part_id: b.part_id },
      change: sourceKind === 'bom_line_writeback' ? { kind: sourceKind,audit_id: randomUUID(),bom_line_id: 'RC' }
        : { kind: sourceKind,eco_id: 'ECO-listener',target_version_id: 'v2' },occurred_at: '2026-10-15T00:00:00.000001Z' })
    const state = async () => (await pool.query('SELECT * FROM meta_plm_bom_change_listeners WHERE binding_id=$1',[b.id])).rows[0]
    try {
      await expect(receiver().changeListener('outsider',b.id,{ expectedVersion: Number(b.version) })).rejects.toMatchObject({ status: 403 })
      await pool.query("INSERT INTO spreadsheet_permissions(sheet_id,subject_type,subject_id,perm_code) VALUES($1,'user','member','spreadsheet:admin')",[b.sheet_id])
      try {
        await expect(receiver().changeListener('member',b.id,{ expectedVersion: Number(b.version) })).rejects.toMatchObject({ code: 'SOURCE_FORBIDDEN' })
      } finally {
        await pool.query("DELETE FROM spreadsheet_permissions WHERE sheet_id=$1 AND subject_id='member' AND perm_code='spreadsheet:admin'",[b.sheet_id])
      }
      expect(pages).toBe(0)
      expect(await receiver().changeListener('owner',b.id,{ expectedVersion: Number(b.version) })).toMatchObject({ cursor: 5,status: 'active' })
      facts.set(6,event()); head=6
      let release!: () => void, admitted!: () => void
      const started=new Promise<void>(resolve => { admitted=resolve })
      const hold=new Promise<void>(resolve => { release=resolve })
      let held=false
      onPage=async () => { if (!held) { held=true; admitted(); await hold } }
      const restarting=receiver().changeListener('owner',b.id,{ expectedVersion: Number(b.version) })
      await started
      const originalGeneration=(await state()).generation
      expect(await receiver().pollChanges(b.id)).toMatchObject({ cursor: 6 })
      release()
      await expect(restarting).rejects.toMatchObject({ code: 'LISTENER_CHANGED' })
      expect((await state()).generation).toBe(originalGeneration)
      onPage=undefined
      // Start a new baseline explicitly after the completed concurrent pass.
      await receiver().changeListener('owner',b.id,{ expectedVersion: Number(b.version) })
      facts.set(7,event()); head=7
      // Failure while advancing must roll back both receipt and trigger-created outbound event.
      await pool.query(`CREATE FUNCTION test_listener_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.binding_id='${b.id}'::uuid AND NEW.cursor=7 THEN RAISE EXCEPTION 'fixture_cursor_failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER test_listener_abort BEFORE UPDATE ON meta_plm_bom_change_listeners FOR EACH ROW EXECUTE FUNCTION test_listener_abort()`)
      expect(await receiver().pollChanges(b.id)).toEqual({ state: 'waiting' })
      expect(Number((await state()).cursor)).toBe(6)
      expect((await pool.query('SELECT count(*)::int n FROM meta_plm_bom_change_inbox WHERE binding_id=$1',[b.id])).rows[0].n).toBe(1)
      await pool.query('DROP TRIGGER test_listener_abort ON meta_plm_bom_change_listeners; DROP FUNCTION test_listener_abort()')
      const results = await Promise.all([receiver().pollChanges(b.id),receiver().pollChanges(b.id)])
      expect(results.some(r => r.state==='active')).toBe(true)
      expect(Number((await state()).cursor)).toBe(7)
      expect((await pool.query('SELECT count(*)::int n FROM meta_plm_bom_change_inbox WHERE binding_id=$1',[b.id])).rows[0].n).toBe(2)
      facts.set(8,event(kind==='bom_line_writeback' ? 'eco_batch_apply' : 'bom_line_writeback')); head=8
      expect(await receiver().pollChanges(b.id)).toMatchObject({ cursor: 8 })
      expect((await pool.query('SELECT count(*)::int n FROM meta_plm_bom_change_inbox WHERE binding_id=$1',[b.id])).rows[0].n).toBe(2)
      fail=true; expect(await receiver().pollChanges(b.id)).toEqual({ state: 'waiting' }); fail=false
      denied=true; expect(await receiver().pollChanges(b.id)).toEqual({ state: 'stopped' }); denied=false
      const calls=pages; expect(await receiver().pollChanges(b.id)).toEqual({ state: 'inactive' }); expect(pages).toBe(calls)
      facts.set(9,event()); head=9
      await receiver().changeListener('owner',b.id,{ expectedVersion: Number(b.version) })
      expect(await receiver().pollChanges(b.id)).toMatchObject({ cursor: 9 })
      expect((await pool.query('SELECT count(*)::int n FROM meta_plm_bom_change_inbox WHERE binding_id=$1',[b.id])).rows[0].n).toBe(2)
      onPage=async () => { await pool.query("UPDATE data_sources SET owner_id='member' WHERE id='ds'") }
      expect(await receiver().pollChanges(b.id)).toEqual({ state: 'stopped' })
      onPage=undefined
      expect((await state()).status).toBe('stopped')
      await expect(receiver().changeListener('owner',b.id,{ expectedVersion: Number(b.version) })).rejects.toMatchObject({ status: 403 })
      await pool.query("INSERT INTO spreadsheet_permissions(sheet_id,subject_type,subject_id,perm_code) VALUES($1,'user','member','spreadsheet:admin')",[b.sheet_id])
      const rebound=await receiver().changeListener('member',b.id,{ expectedVersion: Number(b.version) })
      expect(rebound).toMatchObject({ status: 'active',cursor: 9,bindingVersion: Number(b.version) })
      facts.set(10,{ ...event(),binding_version: Number(b.version) }); head=10
      expect(await receiver().pollChanges(b.id)).toMatchObject({ cursor: 10 })
      expect((await pool.query('SELECT count(*)::int n FROM meta_plm_bom_change_inbox WHERE binding_id=$1',[b.id])).rows[0].n).toBe(3)
      await pool.query("UPDATE data_sources SET owner_id='owner' WHERE id='ds'")
      expect((await state()).status).toBe('stopped')
      const queued=(await pool.query('SELECT id FROM meta_plm_bom_review_completion_events WHERE binding_id=$1',[b.id])).rows
      for (const queuedEvent of queued) expect(await receiver().deliverCompletion(queuedEvent.id)).toEqual({ state: 'cancelled' })
      // Merely restoring the previous owner cannot restart a revoked authorization.
      expect(await receiver().pollChanges(b.id)).toEqual({ state: 'inactive' })
      await expect(listenerDown(new Kysely({ dialect: new PostgresDialect({ pool }) }))).rejects.toThrow('plm_change_listener_evidence_present')
    } finally {
      await pool.query("UPDATE data_sources SET owner_id='owner' WHERE id='ds'")
      await pool.query('UPDATE multitable_webhooks SET active=false WHERE id=$1',[target])
      await pool.query("DELETE FROM user_permissions WHERE user_id='owner' AND permission_code='multitable:send_webhook'")
    }
  })
})

registerChangeCrossprocess(pool,tx)

registerBomReviewRealAuthHttpTests(
  pool,
  { pool: tx, dataSourceManager: { getDataSource: () => adapter as never } },
  () => sourceCalls,
)
registerBomReviewNativeHttpTests(pool)
