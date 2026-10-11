/** Actual PG + actual record producers. This proves private raw stored-data capture
 * and schema/condition evidence. Conditional preparation below uses actual current READ permissions,
 * but does NOT prove Connection/tenant authority, automatic admission, HTTP authorization or source IO.
 * Only a randomly owned schema is used; no shared application tables are required.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Request } from 'express'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { up as addOutbox } from '../../src/db/migrations/zzzz20260715120000_create_automation_outbox'
import { up as addMaterialEpochs } from '../../src/db/migrations/zzzz20261001130000_automation_read_material_epochs'
import { up as addRuleRevision } from '../../src/db/migrations/zzzz20261001122000_automation_rule_authority_revision'
import { up as addClassAClaims } from '../../src/db/migrations/zzzz20260716100000_create_automation_action_applied'
import { up as addImages, down as removeImages } from '../../src/db/migrations/zzzz20261001138000_automation_record_after_image'
import { up as addSchemaRevision, down as removeSchemaRevision } from '../../src/db/migrations/zzzz20261001139000_automation_record_schema_revision'
import { encodeAutomationRecordAfterImage, persistAutomationRecordAfterImage,
  type AutomationRecordAfterImageInput } from '../../src/multitable/automation-record-after-image'
import { captureAutomationRecordSchema, resolveAutomationRecordSchemaRevision } from '../../src/multitable/automation-record-schema'
import { enqueueOutboxEvent, type EnqueuedOutboxEvent } from '../../src/multitable/automation-outbox-enqueue'
import { enqueueRecordEventIfDurable } from '../../src/multitable/automation-producer-emit'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'
import { RecordService, VersionConflictError } from '../../src/multitable/record-service'
import { RecordWriteService, type ConnectionPool, type RecordPatchInput } from '../../src/multitable/record-write-service'
import { AutomationExecutor, type AutomationRule } from '../../src/multitable/automation-executor'
import { deriveCapabilities, type AccessInfo } from '../../src/multitable/sheet-capabilities'
import { createRecordWriteHelpers } from '../../src/routes/univer-meta'
import type { EventBus } from '../../src/integration/events/event-bus'
import { createAutomationReadRecordConditions, type AutomationReadRecordConditionEvent } from '../../src/integration/automation-read-record-conditions'

const describeDb = process.env.DATABASE_URL ? describe : describe.skip
const expectDb = process.env.EXPECT_DB === '1' ? it : it.skip
expectDb('EXPECT_DB supplies an isolated database for record after-image evidence', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})
const FLAG = 'AUTOMATION_DURABLE_DELIVERY_ENABLED'
const SHEET = 'synthetic-after-image-sheet', ACTOR = 'synthetic-after-image-owner'
const F_TEXT = 'synthetic-text', F_KEEP = 'synthetic-keep', F_NUM = 'synthetic-number'
const RULE = 'synthetic-condition-rule'
const conditionScope = { actorId: ACTOR, sheetId: SHEET, baseId: 'synthetic-base', ruleId: RULE }
const conditionTree = (fieldId: string, operator: string, value?: unknown) => ({ logic: 'and',
  conditions: [{ fieldId, operator, ...(value === undefined ? {} : { value }) }] })
const createdEvent = 'multitable.record.created', updatedEvent = 'multitable.record.updated'
const capabilities = deriveCapabilities(['multitable:read', 'multitable:write'], false)
const access: AccessInfo = { userId: ACTOR, permissions: ['multitable:read', 'multitable:write'], isAdminRole: false }
const fields: RecordPatchInput['fields'] = [
  { id: F_TEXT, name: 'Text', type: 'string', property: {}, order: 1 },
  { id: F_KEEP, name: 'Keep', type: 'string', property: {}, order: 2 },
  // Currency is normalized by the real BATCH1 write codec; plain number currently preserves input.
  { id: F_NUM, name: 'Amount', type: 'currency', property: {}, order: 3 },
]

describeDb('Private record after-images: real migration and real producer transactions', () => {
  const schema = 'automation_record_image_' + randomBytes(8).toString('hex')
  let pool: Pool, admin: PoolClient, db: Kysely<unknown>, schemaCreated = false
  let service: RecordService, writer: RecordWriteService, executor: AutomationExecutor
  let schemaLockObservation: { conflicts: number; savepointRollbacks: number } | undefined
  // Observe production statement attempts only; all arguments/results/errors still come from PG.
  let executorObservation: { schemaCaptures: number; sourceWrites: number; privateInserts: number } | undefined
  // Values-free facts from the REAL driver's result/arguments only. Never change a query, result,
  // parameter or error; do not retain row contents, record IDs, raw SQL or unbounded observations.
  let captureObservation: {
    projections: Array<{ kind: 'locked-read' | 'write'; textNull: boolean; textBytes: number | null; oversized: boolean }>
    submissions: Array<{ textNull: boolean; reason: 'none' | 'batch_limits' | 'other' }>
    overflow: boolean
  } | undefined
  const emit = vi.fn()
  // This bus only observes the existing post-commit legacy branch. It never supplies source data.
  const eventBus = { emit } as unknown as EventBus
  async function transaction<T>(work: (trx: TransactionalQueryable) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await work({ isTransaction: true, async query(statement, params) {
        if (executorObservation) {
          if (statement === 'SAVEPOINT automation_record_schema_capture') executorObservation.schemaCaptures++
          if (/^\s*(?:INSERT INTO|UPDATE) meta_records\b/u.test(statement)) executorObservation.sourceWrites++
          if (statement.includes('INSERT INTO meta_automation_record_after_images')) executorObservation.privateInserts++
        }
        let response
        try { response = await client.query(statement, params) }
        catch (error) {
          if (schemaLockObservation && error !== null && typeof error === 'object' && 'code' in error && error.code === '55P03') {
            schemaLockObservation.conflicts++
          }
          throw error
        }
        if (schemaLockObservation && /^\s*ROLLBACK TO (?:SAVEPOINT )?/u.test(statement)) schemaLockObservation.savepointRollbacks++
        if (captureObservation) {
          if (statement.includes('automation_after_image_json') && /\b(?:FROM|UPDATE) meta_records\b/u.test(statement)) {
            for (const row of response.rows) {
              if (captureObservation.projections.length >= 300) { captureObservation.overflow = true; break }
              captureObservation.projections.push({
                kind: /^\s*SELECT\b/u.test(statement) ? 'locked-read' : 'write',
                textNull: row.automation_after_image_json === null,
                textBytes: typeof row.automation_after_image_json === 'string' ? Buffer.byteLength(row.automation_after_image_json, 'utf8') : null,
                oversized: row.automation_after_image_oversized === true,
              })
            }
          }
          if (statement.includes('INSERT INTO meta_automation_record_after_images')) {
            if (captureObservation.submissions.length >= 300) captureObservation.overflow = true
            else captureObservation.submissions.push({ textNull: params?.[6] === null,
              reason: params?.[7] === null ? 'none' : params?.[7] === 'batch_limits' ? 'batch_limits' : 'other' })
          }
        }
        return response
      } })
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  async function owned() {
    expect(schema).toMatch(/^automation_record_image_[a-f0-9]{16}$/u)
    expect((await admin.query('SELECT current_schema() AS schema')).rows).toEqual([{ schema }])
  }
  async function seed(recordId = 'synthetic-record', data: Record<string, unknown> = { [F_TEXT]: 'old', [F_KEEP]: 'untouched' }) {
    await admin.query('INSERT INTO meta_records(id,sheet_id,data,version,created_by) VALUES($1,$2,$3::jsonb,1,$4)',
      [recordId, SHEET, JSON.stringify(data), ACTOR])
    return recordId
  }
  function bulk(recordId: string, changes: RecordPatchInput['changesByRecord'] extends Map<string, infer V> ? V : never): RecordPatchInput {
    return { sheetId: SHEET, changesByRecord: new Map([[recordId, changes]]), actorId: ACTOR,
      fields, visiblePropertyFields: fields, visiblePropertyFieldIds: new Set(fields.map(field => field.id)),
      attachmentFields: [], fieldById: new Map(fields.map(field => [field.id,
        { type: field.type, readOnly: false, hidden: false, property: field.property }])), capabilities, access }
  }
  async function images() {
    return (await admin.query(`SELECT i.*,o.payload FROM meta_automation_record_after_images i
      JOIN meta_automation_outbox o ON o.id=i.outbox_id ORDER BY i.created_at,i.outbox_id`)).rows
  }
  async function schemaRevision() {
    const rows = (await admin.query(`SELECT revision::text AS revision FROM automation_read_material_epochs
      WHERE kind='sheet' AND scope=jsonb_build_object('id',$1::text)`, [SHEET])).rows
    expect(rows).toHaveLength(1)
    expect(rows[0].revision).toMatch(/^[a-f0-9-]{36}$/u)
    return String(rows[0].revision)
  }
  async function counts() {
    return (await admin.query(`SELECT
      (SELECT count(*)::int FROM meta_records) records,
      (SELECT count(*)::int FROM meta_record_revisions) revisions,
      (SELECT count(*)::int FROM meta_automation_outbox) events,
      (SELECT count(*)::int FROM meta_automation_outbox_consumer) consumers,
      (SELECT count(*)::int FROM meta_automation_record_after_images) images`)).rows[0]
  }
  async function capture(trx: TransactionalQueryable, data: unknown = { value: 'synthetic' },
    changes: Partial<AutomationRecordAfterImageInput> = {}, eventType = createdEvent) {
    const receipt = await enqueueOutboxEvent(trx, { eventType, eventId: randomUUID(),
      payload: { sheetId: SHEET, recordId: 'synthetic-record', publicMarker: 'unchanged' } })
    await persistAutomationRecordAfterImage(trx, receipt,
      { sheetId: SHEET, recordId: 'synthetic-record', recordVersion: 1, data, ...changes })
    return receipt
  }
  async function expectCaptured(recordId: string, version: number, data: unknown, eventType: string) {
    const matching = (await images()).filter(row => row.record_id === recordId && row.event_type === eventType)
    expect(matching).toHaveLength(1)
    expect(matching[0]).toMatchObject({ record_version: String(version), format_version: 1,
      status: 'captured', reason: null, after_image: data, sheet_id: SHEET, schema_revision: await schemaRevision() })
    expect(matching[0].captured_bytes).toBeGreaterThan(0)
    return matching[0]
  }
  async function rule(conditions: unknown, trigger = 'record.created') {
    await admin.query(`INSERT INTO automation_rules(id,sheet_id,name,trigger_type,action_type,created_by,conditions)
      VALUES($1,$2,'Synthetic condition',$3,'integration_read_preview',$4,$5::jsonb)
      ON CONFLICT(id) DO UPDATE SET conditions=EXCLUDED.conditions,trigger_type=EXCLUDED.trigger_type`,
    [RULE, SHEET, trigger, ACTOR, JSON.stringify(conditions)])
  }
  async function eventFor(recordId: string): Promise<AutomationReadRecordConditionEvent> {
    const found = (await admin.query(`SELECT i.outbox_id,i.event_id,i.event_type FROM meta_automation_record_after_images i
      WHERE i.record_id=$1 ORDER BY i.outbox_id`, [recordId])).rows
    expect(found).toHaveLength(1)
    return { outboxId: found[0].outbox_id as string, eventId: found[0].event_id as string,
      eventType: found[0].event_type as AutomationReadRecordConditionEvent['eventType'] }
  }

  beforeAll(async () => {
    if (!/^automation_record_image_[a-f0-9]{16}$/u.test(schema)) throw new Error('UNOWNED_AFTER_IMAGE_SCHEMA')
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5,
      options: '-c search_path=' + schema + ' -c statement_timeout=8000' })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    admin = await pool.connect()
    await admin.query('CREATE SCHEMA "' + schema + '"'); schemaCreated = true
    // Exact consumed storage columns, not a query-result facade. All DML below runs in PostgreSQL.
    await admin.query(`CREATE TABLE meta_bases(id text PRIMARY KEY,name text,deleted_at timestamptz);
      CREATE TABLE plugin_multitable_object_registry(sheet_id text PRIMARY KEY,project_id text,object_id text,plugin_name text);
      CREATE TABLE integration_stock_prep_pack_installs(id text PRIMARY KEY,tenant_id text,project_id text,object_id text);
      CREATE TABLE meta_sheets(id text PRIMARY KEY,base_id text,name text,description text,deleted_at timestamptz,
        row_level_read_permissions_enabled boolean DEFAULT false,conditional_read_rules jsonb DEFAULT '[]');
      CREATE TABLE meta_fields(id text PRIMARY KEY,sheet_id text,name text,type text,property jsonb,"order" int);
      CREATE TABLE meta_records(id text PRIMARY KEY,sheet_id text,data jsonb NOT NULL DEFAULT '{}',version int NOT NULL,
        created_by text,modified_by text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
        locked boolean NOT NULL DEFAULT false,locked_by text);
      CREATE TABLE meta_links(id text PRIMARY KEY,field_id text,record_id text,foreign_record_id text);
      CREATE TABLE meta_record_revisions(id uuid PRIMARY KEY,sheet_id text,record_id text,version int,action text,source text,
        actor_id text,changed_field_ids text[],patch jsonb,snapshot jsonb,batch_id text,created_at timestamptz DEFAULT now());
      CREATE TABLE meta_records_trash(id bigserial PRIMARY KEY,record_id text,sheet_id text,base_id text,data jsonb,
        original_version int,created_by text,deleted_by text,original_created_at timestamptz,original_updated_at timestamptz,
        delete_revision_id uuid,deleted_at timestamptz DEFAULT now());
      CREATE TABLE users(id text PRIMARY KEY,role text,permissions jsonb,is_active boolean);
      CREATE TABLE user_roles(user_id text,role_id text);
      CREATE TABLE user_permissions(user_id text,permission_code text);
      CREATE TABLE role_permissions(role_id text,permission_code text);
      CREATE TABLE platform_member_group_members(user_id text,group_id uuid);
      CREATE TABLE spreadsheet_permissions(sheet_id text,subject_type text,subject_id text,perm_code text);
      CREATE TABLE field_permissions(sheet_id text,field_id text,subject_type text,subject_id text,visible boolean,read_only boolean);
      CREATE TABLE record_permissions(sheet_id text,record_id text,subject_type text,subject_id text,access_level text);
      CREATE TABLE automation_rules(id text PRIMARY KEY,sheet_id text NOT NULL,name text,trigger_type text NOT NULL,
        trigger_config jsonb DEFAULT '{}',action_type text NOT NULL,action_config jsonb DEFAULT '{}',enabled boolean DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by text,
        conditions jsonb,actions jsonb,execution_mode text);`)
    await db.transaction().execute(addOutbox)
    await db.transaction().execute(addImages)
    await db.transaction().execute(addMaterialEpochs)
    await db.transaction().execute(addSchemaRevision)
    await db.transaction().execute(addRuleRevision)
    await db.transaction().execute(addClassAClaims)
    await admin.query('INSERT INTO meta_bases(id,name) VALUES($1,$2)', ['synthetic-base', 'Synthetic'])
    await admin.query('INSERT INTO meta_sheets(id,base_id,name) VALUES($1,$2,$3)', [SHEET, 'synthetic-base', 'Synthetic'])
    for (const field of fields) await admin.query('INSERT INTO meta_fields(id,sheet_id,name,type,property,"order") VALUES($1,$2,$3,$4,$5::jsonb,$6)',
      [field.id, SHEET, field.name, field.type, JSON.stringify(field.property), field.order])
    const producerPool: ConnectionPool = { query: (statement, params) => pool.query(statement, params),
      transaction: work => transaction(trx => work({ query: trx.query })) }
    service = new RecordService(producerPool, eventBus)
    // Real helper composition with a synthetic actor context; this is not HTTP/JWT authorization evidence.
    const req = { user: { id: ACTOR, roles: [], perms: ['multitable:read', 'multitable:write'] } } as unknown as Request
    writer = new RecordWriteService(producerPool, eventBus, createRecordWriteHelpers(req, producerPool))
    executor = new AutomationExecutor({ eventBus, queryFn: producerPool.query,
      transaction: work => transaction(trx => work({ query: trx.query })) })
  })
  beforeEach(async () => {
    captureObservation = undefined
    schemaLockObservation = undefined
    executorObservation = undefined
    await owned()
    await admin.query(`TRUNCATE meta_automation_record_after_images,meta_automation_outbox_consumer,meta_automation_outbox,
      meta_record_revisions,meta_records_trash,meta_links,meta_records,automation_rules,users,user_roles,user_permissions,
      role_permissions,platform_member_group_members,spreadsheet_permissions,field_permissions,record_permissions,
      meta_automation_action_applied`)
    await admin.query("INSERT INTO users VALUES($1,'user','[]',true)", [ACTOR])
    await admin.query("INSERT INTO user_permissions VALUES($1,'multitable:read')", [ACTOR])
    emit.mockClear()
    vi.stubEnv(FLAG, 'true')
  })
  afterEach(() => { captureObservation = undefined; schemaLockObservation = undefined; executorObservation = undefined; vi.unstubAllEnvs() })
  afterAll(async () => {
    if (admin) {
      await admin.query('ROLLBACK').catch(() => {})
      if (schemaCreated) { await owned(); await admin.query('DROP SCHEMA "' + schema + '" CASCADE') }
      admin.release()
    }
    if (db) await db.destroy(); else await pool?.end()
  })

  it('migration installs actual FK cascade, private ACL and does not backfill old outbox rows', async () => {
    await db.transaction().execute(removeSchemaRevision)
    await db.transaction().execute(removeImages)
    await transaction(trx => enqueueOutboxEvent(trx, { eventType: createdEvent, eventId: randomUUID(),
      payload: { sheetId: SHEET, recordId: 'old-record' } }))
    await db.transaction().execute(addImages)
    await db.transaction().execute(addSchemaRevision)
    expect(await images()).toEqual([])
    const constraints = (await admin.query(`SELECT confdeltype FROM pg_catalog.pg_constraint
      WHERE conrelid='meta_automation_record_after_images'::regclass AND contype='f'`)).rows
    expect(constraints).toEqual([{ confdeltype: 'c' }])
    const privileges = (await admin.query(`SELECT privilege_type FROM information_schema.table_privileges
      WHERE table_schema=$1 AND table_name='meta_automation_record_after_images' AND grantee='PUBLIC'`, [schema])).rows
    expect(privileges).toEqual([])
  })
  it('real helper stores exact jsonb bytes and DB-issued xid, while keeping public payload unchanged', async () => {
    let xid: string | undefined
    const receipt = await transaction(async trx => {
      xid = String((await trx.query('SELECT pg_current_xact_id() AS xid')).rows[0].xid)
      return capture(trx, { a: 1, b: ['synthetic'] })
    })
    const row = (await images())[0]
    expect(row).toMatchObject({ outbox_id: receipt.outboxId, capture_xid: xid,
      schema_revision: null, after_image: { a: 1, b: ['synthetic'] } })
    expect(row.payload).toEqual({ sheetId: SHEET, recordId: 'synthetic-record', publicMarker: 'unchanged' })
    expect((await admin.query('SELECT captured_bytes=octet_length(after_image::text) AS exact FROM meta_automation_record_after_images')).rows)
      .toEqual([{ exact: true }])
  })
  it('omitted fifth argument retains an ordinary event without inventing a snapshot', async () => {
    await transaction(trx => enqueueRecordEventIfDurable(trx, createdEvent,
      { sheetId: SHEET, recordId: 'synthetic-record', _eventId: randomUUID(), data: { public: 'not-evidence' } }))
    expect(await counts()).toMatchObject({ events: 1, consumers: 2, images: 0 })
  })
  it.each(['sheetId', 'recordId', 'recordVersion'] as const)('helper rejects mismatched or invalid %s with full outbox rollback', async key => {
    const mismatch = key === 'recordVersion' ? { recordVersion: 0 } : { [key]: 'different-identity' }
    await expect(transaction(trx => capture(trx, {}, mismatch))).rejects.toThrow('AUTOMATION_RECORD_AFTER_IMAGE_IDENTITY_INVALID')
    expect(await counts()).toMatchObject({ events: 0, consumers: 0, images: 0 })
  })
  it.each(['eventId', 'eventType', 'outboxId'] as const)('DB identity guard rejects changed receipt %s', async key => {
    await expect(transaction(async trx => {
      const receipt = await enqueueOutboxEvent(trx, { eventType: createdEvent, eventId: randomUUID(),
        payload: { sheetId: SHEET, recordId: 'synthetic-record' } })
      const forged: EnqueuedOutboxEvent = { ...receipt, [key]: key === 'eventType' ? updatedEvent : 'different-identity' }
      await persistAutomationRecordAfterImage(trx, forged, { sheetId: SHEET, recordId: 'synthetic-record', recordVersion: 1, data: {} })
    })).rejects.toThrow('AUTOMATION_RECORD_AFTER_IMAGE_IDENTITY_INVALID')
    expect(await images()).toEqual([])
  })
  it('update cannot rewrite snapshot or its identity', async () => {
    await transaction(trx => capture(trx))
    // Each attempted rewrite remains shape-valid, so the independent immutable trigger must reject it.
    for (const expression of ["after_image='{}'::jsonb,captured_bytes=2", 'record_version=2', "status='unavailable',reason='invalid_data',after_image=NULL,captured_bytes=0"])
      await expect(admin.query('UPDATE meta_automation_record_after_images SET ' + expression)).rejects.toThrow('AUTOMATION_RECORD_AFTER_IMAGE_IMMUTABLE')
    expect((await images())[0].after_image).toEqual({ value: 'synthetic' })
  })
  it('down refuses retained captured and unavailable history; parent retention cascades then permits down/up', async () => {
    await transaction(async trx => { await capture(trx); await capture(trx, undefined, { oversized: true }) })
    await expect(db.transaction().execute(removeImages)).rejects.toThrow('AUTOMATION_RECORD_AFTER_IMAGE_HAS_HISTORY')
    expect(await images()).toHaveLength(2)
    await admin.query('DELETE FROM meta_automation_outbox')
    expect(await images()).toEqual([])
    await db.transaction().execute(removeSchemaRevision)
    await db.transaction().execute(removeImages)
    await db.transaction().execute(addImages)
    await db.transaction().execute(addSchemaRevision)
  })
  it.each([
    ['invalid_data', () => ({ value: Number.NaN })],
    ['value_limits', () => ({ value: 'x'.repeat(262145) })],
    ['value_limits', () => ({ value: Array(2049).fill(0) })],
    ['value_limits', () => Object.fromEntries(Array.from({ length: 2049 }, (_, i) => ['f' + i, 0]))],
  ] as const)('bounded refusal %s stores no partial data', async (reason, makeData) => {
    await transaction(trx => capture(trx, makeData()))
    expect((await images())[0]).toMatchObject({ status: 'unavailable', reason, after_image: null, captured_bytes: 0 })
  })
  it('PostgreSQL canonical jsonb size can reject a value whose compact JS encoding fits', async () => {
    const data = { a: Array(2048).fill('x'.repeat(124)) }
    expect(encodeAutomationRecordAfterImage(data).reason).toBeNull()
    await transaction(trx => capture(trx, data))
    expect((await images())[0]).toMatchObject({ status: 'unavailable', reason: 'value_limits', after_image: null })
  })
  it('the persisted same-xid record bound covers repeated helper calls; next transaction has a fresh budget', async () => {
    await transaction(async trx => { for (let i = 0; i < 257; i++) await capture(trx, { n: i }) })
    const rows = await images()
    expect(rows.filter(row => row.status === 'captured')).toHaveLength(256)
    expect(rows.filter(row => row.reason === 'batch_limits')).toHaveLength(1)
    await transaction(trx => capture(trx, { nextTransaction: true }))
    expect((await images()).filter(row => row.status === 'captured')).toHaveLength(257)
  }, 30000)
  it('same transaction has a 4 MiB aggregate captured-byte limit, not just a per-record limit', async () => {
    await transaction(async trx => { for (let i = 0; i < 17; i++) await capture(trx, { value: 'x'.repeat(250000) }) })
    const rows = await images()
    expect(rows.filter(row => row.status === 'captured')).toHaveLength(16)
    expect(rows.filter(row => row.reason === 'batch_limits')).toHaveLength(1)
    expect(rows.reduce((sum, row) => sum + Number(row.captured_bytes), 0)).toBeLessThanOrEqual(4194304)
  })
  it('explicit transaction rollback removes event, consumers and image together', async () => {
    await expect(transaction(async trx => { await capture(trx); throw new Error('SYNTHETIC_ROLLBACK') })).rejects.toThrow('SYNTHETIC_ROLLBACK')
    expect(await counts()).toEqual({ records: 0, revisions: 0, events: 0, consumers: 0, images: 0 })
  })

  it('actual producer captures different schema nonces across metadata A to B to A without rewriting old images', async () => {
    const firstRevision = await schemaRevision()
    const first = await service.createRecord({ sheetId: SHEET, data: { [F_TEXT]: 'first' }, actorId: ACTOR, capabilities })
    try {
      await admin.query('UPDATE meta_fields SET name=$1 WHERE id=$2', ['Text B', F_TEXT])
      const secondRevision = await schemaRevision()
      const second = await service.createRecord({ sheetId: SHEET, data: { [F_TEXT]: 'second' }, actorId: ACTOR, capabilities })
      await admin.query('UPDATE meta_fields SET name=$1 WHERE id=$2', ['Text', F_TEXT])
      const thirdRevision = await schemaRevision()
      const third = await service.createRecord({ sheetId: SHEET, data: { [F_TEXT]: 'third' }, actorId: ACTOR, capabilities })
      expect(new Set([firstRevision, secondRevision, thirdRevision]).size).toBe(3)
      const rows = await images()
      expect(rows.find(row => row.record_id === first.recordId)?.schema_revision).toBe(firstRevision)
      expect(rows.find(row => row.record_id === second.recordId)?.schema_revision).toBe(secondRevision)
      expect(rows.find(row => row.record_id === third.recordId)?.schema_revision).toBe(thirdRevision)
      expect(rows.every(row => row.status === 'captured')).toBe(true)
    } finally { await admin.query('UPDATE meta_fields SET name=$1 WHERE id=$2', ['Text', F_TEXT]) }
  })
  it('real metadata delete and identical-id recreation cannot revive the old image schema nonce', async () => {
    const firstRevision = await schemaRevision()
    const first = await service.createRecord({ sheetId: SHEET, data: { [F_TEXT]: 'before' }, actorId: ACTOR, capabilities })
    const field = fields[0]
    const restoreField = () => admin.query(`INSERT INTO meta_fields(id,sheet_id,name,type,property,"order")
      VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(id) DO NOTHING`,
    [field.id, SHEET, field.name, field.type, JSON.stringify(field.property), field.order])
    try {
      await admin.query('DELETE FROM meta_fields WHERE id=$1', [F_TEXT])
      const deletedRevision = await schemaRevision()
      await restoreField()
      const recreatedRevision = await schemaRevision()
      expect(new Set([firstRevision, deletedRevision, recreatedRevision]).size).toBe(3)
      const second = await service.createRecord({ sheetId: SHEET, data: { [F_TEXT]: 'after' }, actorId: ACTOR, capabilities })
      const rows = await images()
      expect(rows.find(row => row.record_id === first.recordId)?.schema_revision).toBe(firstRevision)
      expect(rows.find(row => row.record_id === second.recordId)?.schema_revision).toBe(recreatedRevision)
    } finally { await restoreField() }
  })
  it('actual REST write commits after schema-writer NOWAIT conflict and real savepoint recovery, with NULL schema', async () => {
    const recordId = await seed()
    const previousRevision = await schemaRevision()
    const blocker = await pool.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('UPDATE meta_fields SET name=$1 WHERE id=$2', ['Uncommitted schema', F_TEXT])
      schemaLockObservation = { conflicts: 0, savepointRollbacks: 0 }
      await service.patchRecord({ recordId, sheetId: SHEET, data: { [F_TEXT]: 'committed' }, actorId: ACTOR, access, capabilities })
      expect(schemaLockObservation).toEqual({ conflicts: 1, savepointRollbacks: 1 })
      expect(await counts()).toEqual({ records: 1, revisions: 1, events: 1, consumers: 2, images: 1 })
      const row = (await images())[0]
      expect(row).toMatchObject({ record_id: recordId, record_version: '2', status: 'captured', schema_revision: null,
        after_image: { [F_TEXT]: 'committed', [F_KEEP]: 'untouched' } })
      expect(row.payload).toEqual({ sheetId: SHEET, recordId, data: { [F_TEXT]: 'committed' }, actorId: ACTOR, _eventId: row.event_id })
      expect((await admin.query('SELECT version,data FROM meta_records WHERE id=$1', [recordId])).rows)
        .toEqual([{ version: 2, data: { [F_TEXT]: 'committed', [F_KEEP]: 'untouched' } }])
    } finally { await blocker.query('ROLLBACK'); blocker.release() }
    expect(await schemaRevision()).toBe(previousRevision)
  })
  it('successful real capture fences a second-connection schema UPDATE until the capture transaction commits', async () => {
    const previousRevision = await schemaRevision()
    const writerClient = await pool.connect()
    try {
      await transaction(async trx => {
        const proof = await captureAutomationRecordSchema(trx, SHEET)
        expect(proof).toBeDefined()
        expect(await resolveAutomationRecordSchemaRevision(trx, SHEET, proof)).toBe(previousRevision)
        await writerClient.query('BEGIN')
        await writerClient.query("SET LOCAL lock_timeout='100ms'")
        // Actual DML from a different backend PID, not a lock-result mock or a sleep oracle.
        await expect(writerClient.query('UPDATE meta_fields SET name=$1 WHERE id=$2', ['Blocked schema', F_TEXT]))
          .rejects.toMatchObject({ code: '55P03' })
        await writerClient.query('ROLLBACK')
        await capture(trx, { held: true }, { schema: proof })
        expect(await resolveAutomationRecordSchemaRevision(trx, SHEET, proof)).toBe(previousRevision)
      })
      // The identical real UPDATE is now permitted, proving the fence ended with the outer commit.
      await writerClient.query('BEGIN')
      await writerClient.query("SET LOCAL lock_timeout='100ms'")
      expect((await writerClient.query('UPDATE meta_fields SET name=$1 WHERE id=$2', ['After commit', F_TEXT])).rowCount).toBe(1)
      await writerClient.query('COMMIT')
      expect(await schemaRevision()).not.toBe(previousRevision)
      expect((await images())[0].schema_revision).toBe(previousRevision)
    } finally {
      await writerClient.query('ROLLBACK')
      writerClient.release()
      await admin.query('UPDATE meta_fields SET name=$1 WHERE id=$2', ['Text', F_TEXT])
    }
  })
  it('an unavailable real capture never upgrades after the other schema writer releases its lock', async () => {
    const blocker = await pool.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('UPDATE meta_fields SET name=$1 WHERE id=$2', ['Temporary schema', F_TEXT])
      await transaction(async trx => {
        const proof = await captureAutomationRecordSchema(trx, SHEET)
        expect(proof).toBeDefined()
        expect(await resolveAutomationRecordSchemaRevision(trx, SHEET, proof)).toBeNull()
        await blocker.query('ROLLBACK')
        expect(await resolveAutomationRecordSchemaRevision(trx, SHEET, proof)).toBeNull()
        await capture(trx, { afterWriter: true }, { schema: proof })
      })
      expect((await images())[0]).toMatchObject({ status: 'captured', schema_revision: null })
    } finally { await blocker.query('ROLLBACK'); blocker.release() }
  })
  it.each(['sheet', 'handle'] as const)('real capture rejects reuse on a different %s without borrowing its nonce', async kind => {
    await transaction(async trx => {
      const proof = await captureAutomationRecordSchema(trx, SHEET)
      expect(proof).toBeDefined()
      expect(await resolveAutomationRecordSchemaRevision(trx, SHEET, proof)).toBe(await schemaRevision())
      // The second handle still queries the SAME actual transaction, isolating object binding from xid.
      const otherHandle: TransactionalQueryable = { isTransaction: true, query: trx.query }
      await expect(resolveAutomationRecordSchemaRevision(kind === 'handle' ? otherHandle : trx,
        kind === 'sheet' ? 'different-synthetic-sheet' : SHEET, proof))
        .rejects.toMatchObject({ code: 'AUTOMATION_RECORD_SCHEMA_TOKEN_INVALID' })
    })
  })
  it('reusing the exact same handle in another real transaction still rejects the old xid-bound proof', async () => {
    const client = await pool.connect()
    const trx: TransactionalQueryable = { isTransaction: true, query: (statement, params) => client.query(statement, params) }
    try {
      await client.query('BEGIN')
      const proof = await captureAutomationRecordSchema(trx, SHEET)
      expect(proof).toBeDefined()
      expect(await resolveAutomationRecordSchemaRevision(trx, SHEET, proof)).toBe(await schemaRevision())
      await client.query('COMMIT')
      await client.query('BEGIN')
      await expect(resolveAutomationRecordSchemaRevision(trx, SHEET, proof))
        .rejects.toMatchObject({ code: 'AUTOMATION_RECORD_SCHEMA_TOKEN_INVALID' })
    } finally { await client.query('ROLLBACK'); client.release() }
  })
  it('same-transaction metadata ABA invalidates the earlier proof instead of capturing a replacement nonce', async () => {
    const previousRevision = await schemaRevision()
    await transaction(async trx => {
      const proof = await captureAutomationRecordSchema(trx, SHEET)
      expect(proof).toBeDefined()
      expect(await resolveAutomationRecordSchemaRevision(trx, SHEET, proof)).toBe(previousRevision)
      await trx.query('UPDATE meta_fields SET name=$1 WHERE id=$2', ['Within transaction', F_TEXT])
      await trx.query('UPDATE meta_fields SET name=$1 WHERE id=$2', ['Text', F_TEXT])
      expect(await resolveAutomationRecordSchemaRevision(trx, SHEET, proof)).toBeNull()
      await capture(trx, { ownChange: true }, { schema: proof })
    })
    expect(await schemaRevision()).not.toBe(previousRevision)
    expect((await images())[0]).toMatchObject({ status: 'captured', schema_revision: null })
  })
  it('rollback to an earlier real savepoint invalidates lost schema fences even when xid and nonce are unchanged', async () => {
    const previousRevision = await schemaRevision()
    await transaction(async trx => {
      await trx.query('SAVEPOINT before_schema_capture')
      const proof = await captureAutomationRecordSchema(trx, SHEET)
      expect(proof).toBeDefined()
      expect(await resolveAutomationRecordSchemaRevision(trx, SHEET, proof)).toBe(previousRevision)
      await trx.query('ROLLBACK TO SAVEPOINT before_schema_capture')
      await trx.query('RELEASE SAVEPOINT before_schema_capture')
      expect(await resolveAutomationRecordSchemaRevision(trx, SHEET, proof)).toBeNull()
      await capture(trx, { afterRollback: true }, { schema: proof })
    })
    expect(await schemaRevision()).toBe(previousRevision)
    expect((await images())[0]).toMatchObject({ status: 'captured', schema_revision: null })
  })
  it('DB schema insert guard rejects a forged nonce while a matching current nonce remains shape-valid', async () => {
    const insertWithRevision = (revision: string) => transaction(async trx => {
      const receipt = await enqueueOutboxEvent(trx, { eventType: createdEvent, eventId: randomUUID(),
        payload: { sheetId: SHEET, recordId: 'synthetic-record' } })
      // Raw INSERT isolates the DB guard from the opaque application-token gate. It does not claim
      // that a current nonce supplied by a schema-owning SQL writer proves pre-DML application capture.
      await trx.query(`INSERT INTO meta_automation_record_after_images
        (outbox_id,event_type,event_id,sheet_id,record_id,record_version,status,reason,after_image,captured_bytes,schema_revision)
        VALUES($1,$2,$3,$4,$5,1,'captured',NULL,'{}'::jsonb,2,$6::uuid)`,
      [receipt.outboxId, receipt.eventType, receipt.eventId, SHEET, 'synthetic-record', revision])
    })
    await expect(insertWithRevision(randomUUID())).rejects.toMatchObject({ code: '23514', message: 'AUTOMATION_RECORD_SCHEMA_REVISION_INVALID' })
    expect(await counts()).toMatchObject({ events: 0, consumers: 0, images: 0 })
    const currentRevision = await schemaRevision()
    await insertWithRevision(currentRevision)
    expect((await images())[0].schema_revision).toBe(currentRevision)
    await expect(admin.query('UPDATE meta_automation_record_after_images SET schema_revision=NULL'))
      .rejects.toThrow('AUTOMATION_RECORD_AFTER_IMAGE_IMMUTABLE')
  })
  it('schema migration down preserves stamped history and becomes available only after parent retention', async () => {
    await service.createRecord({ sheetId: SHEET, data: { [F_TEXT]: 'stamped' }, actorId: ACTOR, capabilities })
    const currentRevision = await schemaRevision()
    expect((await images())[0].schema_revision).toBe(currentRevision)
    await expect(db.transaction().execute(removeSchemaRevision)).rejects.toMatchObject({ code: '55000', message: 'AUTOMATION_RECORD_SCHEMA_HAS_HISTORY' })
    expect((await images())[0].schema_revision).toBe(currentRevision)
    await admin.query('DELETE FROM meta_automation_outbox')
    await db.transaction().execute(removeSchemaRevision)
    await db.transaction().execute(addSchemaRevision)
    expect(await images()).toEqual([])
  })
  it('schema migration down/up retains legacy NULL snapshots without inventing schema evidence', async () => {
    await transaction(trx => capture(trx, { legacy: true }))
    await db.transaction().execute(removeSchemaRevision)
    await db.transaction().execute(addSchemaRevision)
    expect((await images())[0]).toMatchObject({ status: 'captured', after_image: { legacy: true }, schema_revision: null })
  })

  it('actual REST create captures the inserted normalized full row, not a later read', async () => {
    const result = await service.createRecord({ sheetId: SHEET, data: { [F_TEXT]: 'created', [F_NUM]: '12.5' }, actorId: ACTOR, capabilities })
    const row = await expectCaptured(result.recordId, 1, { [F_TEXT]: 'created', [F_NUM]: 12.5 }, createdEvent)
    expect(row.payload).toEqual({ sheetId: SHEET, recordId: result.recordId, data: { [F_TEXT]: 'created', [F_NUM]: 12.5 }, actorId: ACTOR, _eventId: row.event_id })
    await admin.query('UPDATE meta_records SET data=$1::jsonb,version=2 WHERE id=$2', [JSON.stringify({ [F_TEXT]: 'later' }), result.recordId])
    expect((await images())[0].after_image).toEqual({ [F_TEXT]: 'created', [F_NUM]: 12.5 })
    expect(emit).not.toHaveBeenCalled()
  })
  it('actual REST patch captures unchanged fields while its public payload stays patch-only', async () => {
    const recordId = await seed()
    await service.patchRecord({ recordId, sheetId: SHEET, data: { [F_TEXT]: 'patched' }, actorId: ACTOR, access, capabilities })
    const row = await expectCaptured(recordId, 2, { [F_TEXT]: 'patched', [F_KEEP]: 'untouched' }, updatedEvent)
    expect(row.payload).toEqual({ sheetId: SHEET, recordId, data: { [F_TEXT]: 'patched' }, actorId: ACTOR, _eventId: row.event_id })
  })
  it('actual REST patch preserves stored JSONB integer and decimal precision in private capture', async () => {
    const recordId = 'synthetic-exact-jsonb-numbers'
    // Deliberately seed numeric JSON tokens through SQL, never through a JS number/JSONB parser.
    // The service changes only the unrelated text field; PostgreSQL must retain the original values.
    await admin.query(`INSERT INTO meta_records(id,sheet_id,data,version,created_by)
      VALUES($1,$2,jsonb_build_object($4::text,'before') ||
        '{"precisionInteger":9007199254740993,"precisionDecimal":0.12345678901234567890123456789}'::jsonb,1,$3)`,
    [recordId, SHEET, ACTOR, F_TEXT])
    await service.patchRecord({ recordId, sheetId: SHEET, data: { [F_TEXT]: 'after' }, actorId: ACTOR, access, capabilities })
    // Compare JSONB in PG and extract numeric TEXT: a JS-parsed object would round both sides and hide
    // the regression. Do not use `images().after_image` or JSON.stringify as the precision oracle.
    const result = await admin.query(`SELECT i.status,i.record_version,
        i.after_image=r.data AS exact_stored_row,
        i.after_image->>'precisionInteger' AS integer_text,
        i.after_image->>'precisionDecimal' AS decimal_text,
        i.after_image->>$2::text AS changed_text,
        r.data->>'precisionInteger' AS stored_integer_text,
        r.data->>'precisionDecimal' AS stored_decimal_text
      FROM meta_automation_record_after_images i JOIN meta_records r ON r.id=i.record_id AND r.sheet_id=i.sheet_id
      WHERE i.record_id=$1 AND i.event_type=$3`, [recordId, F_TEXT, updatedEvent])
    expect(result.rows).toEqual([{ status: 'captured', record_version: '2', exact_stored_row: true,
      integer_text: '9007199254740993', decimal_text: '0.12345678901234567890123456789', changed_text: 'after',
      stored_integer_text: '9007199254740993', stored_decimal_text: '0.12345678901234567890123456789' }])
    expect((await admin.query('SELECT payload->\'data\' AS public_patch FROM meta_automation_outbox')).rows)
      .toEqual([{ public_patch: { [F_TEXT]: 'after' } }])
  })
  it('actual zero-field REST patch still emits once and captures the locked unchanged row/version', async () => {
    const recordId = await seed()
    await service.patchRecord({ recordId, sheetId: SHEET, data: {}, actorId: ACTOR, access, capabilities })
    const row = await expectCaptured(recordId, 1, { [F_TEXT]: 'old', [F_KEEP]: 'untouched' }, updatedEvent)
    expect(row.payload).toEqual({ sheetId: SHEET, recordId, data: {}, actorId: ACTOR, _eventId: row.event_id })
    expect(await counts()).toMatchObject({ records: 1, revisions: 0, events: 1, images: 1 })
  })
  it('actual oversized REST no-op returns NULL capture text at the locked SQL read, not merely unavailable later', async () => {
    const recordId = 'synthetic-oversized-noop'
    await admin.query(`INSERT INTO meta_records(id,sheet_id,data,version,created_by)
      VALUES($1,$2,jsonb_build_object($4::text,repeat('x',300000)),1,$3)`, [recordId, SHEET, ACTOR, F_TEXT])
    captureObservation = { projections: [], submissions: [], overflow: false }
    await service.patchRecord({ recordId, sheetId: SHEET, data: {}, actorId: ACTOR, access, capabilities })
    // Removing the SQL CASE still eventually gives unavailable, but must FAIL this independent
    // transport-bound assertion: no newly added unbounded text may reach the Node driver.
    expect(captureObservation.projections).toEqual([{ kind: 'locked-read', textNull: true, textBytes: null, oversized: true }])
    expect(captureObservation.overflow).toBe(false)
    const rows = await images()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ record_id: recordId, record_version: '1', status: 'unavailable',
      reason: 'value_limits', after_image: null, captured_bytes: 0 })
    expect(rows[0].payload).toEqual({ sheetId: SHEET, recordId, data: {}, actorId: ACTOR, _eventId: rows[0].event_id })
    expect(await counts()).toEqual({ records: 1, revisions: 0, events: 1, consumers: 2, images: 1 })
    expect((await admin.query('SELECT version,octet_length(data::text)>262144 AS oversized FROM meta_records WHERE id=$1', [recordId])).rows)
      .toEqual([{ version: 1, oversized: true }])
    expect(emit).not.toHaveBeenCalled()
  })
  it('actual trash restore captures inserted data although the public created event has no data field', async () => {
    const recordId = 'synthetic-restored'
    await admin.query(`INSERT INTO meta_records_trash(record_id,sheet_id,base_id,data,original_version,created_by)
      VALUES($1,$2,$3,$4::jsonb,9,$5)`, [recordId, SHEET, 'synthetic-base', JSON.stringify({ [F_TEXT]: 'restored', [F_KEEP]: 'retained' }), ACTOR])
    await service.restoreRecord({ recordId, actorId: ACTOR, access, resolveSheetAccess: async () => ({ capabilities }) })
    const row = await expectCaptured(recordId, 1, { [F_TEXT]: 'restored', [F_KEEP]: 'retained' }, createdEvent)
    expect(row.payload).toEqual({ sheetId: SHEET, recordId, actorId: ACTOR, _eventId: row.event_id })
    expect((await admin.query('SELECT count(*)::int AS n FROM meta_records_trash')).rows).toEqual([{ n: 0 }])
  })
  it('actual grid normalizes numeric input in private capture without changing its legacy changes payload', async () => {
    const recordId = await seed()
    await writer.patchRecords(bulk(recordId, [{ fieldId: F_NUM, value: '12.5' }]))
    const row = await expectCaptured(recordId, 2, { [F_TEXT]: 'old', [F_KEEP]: 'untouched', [F_NUM]: 12.5 }, updatedEvent)
    expect(row.payload).toEqual({ sheetId: SHEET, recordId, changes: { [F_NUM]: '12.5' }, actorId: ACTOR, _eventId: row.event_id })
  })
  it('actual grid unset capture contains the post-subtraction full row, not a merged event patch', async () => {
    const recordId = await seed()
    await writer.patchRecords(bulk(recordId, [{ fieldId: F_TEXT, op: 'unset', value: undefined }]))
    await expectCaptured(recordId, 2, { [F_KEEP]: 'untouched' }, updatedEvent)
    expect((await admin.query('SELECT data FROM meta_records WHERE id=$1', [recordId])).rows).toEqual([{ data: { [F_KEEP]: 'untouched' } }])
  })
  it('actual grid 257-record batch drops excess capture material before helper SQL, while all public updates commit', async () => {
    const ids = Array.from({ length: 257 }, (_, index) => 'synthetic-grid-budget-' + index)
    await admin.query(`INSERT INTO meta_records(id,sheet_id,data,version,created_by)
      SELECT id,$2,jsonb_build_object($4::text,'old',$5::text,'untouched'),1,$3 FROM unnest($1::text[]) AS id`,
    [ids, SHEET, ACTOR, F_TEXT, F_KEEP])
    const input = bulk(ids[0], [{ fieldId: F_TEXT, value: 'new' }])
    input.changesByRecord = new Map(ids.map(id => [id, [{ fieldId: F_TEXT, value: 'new' }]]))
    captureObservation = { projections: [], submissions: [], overflow: false }
    await writer.patchRecords(input)
    expect(captureObservation.overflow).toBe(false)
    expect(captureObservation.projections).toHaveLength(257)
    expect(captureObservation.projections.every(row => row.kind === 'write' && !row.textNull && !row.oversized && Number(row.textBytes) > 0)).toBe(true)
    // This checks the producer's separate retention budget, not just the DB's later same-xid gate.
    // If the producer keeps the 257th rawJson and relies solely on DB refusal, its non-null SQL
    // argument would fail here even though the final unavailable row would look identical.
    expect(captureObservation.submissions).toEqual([
      ...Array.from({ length: 256 }, () => ({ textNull: false, reason: 'none' })),
      { textNull: true, reason: 'batch_limits' },
    ])
    const rows = await images()
    expect(rows.filter(row => row.status === 'captured')).toHaveLength(256)
    const unavailable = rows.filter(row => row.status === 'unavailable')
    expect(unavailable).toHaveLength(1)
    expect(unavailable[0]).toMatchObject({ record_id: ids[256], reason: 'batch_limits', after_image: null, captured_bytes: 0 })
    for (const row of rows) {
      expect(row.payload).toEqual({ sheetId: SHEET, recordId: row.record_id, changes: { [F_TEXT]: 'new' }, actorId: ACTOR, _eventId: row.event_id })
      if (row.status === 'captured') expect(row.after_image).toEqual({ [F_TEXT]: 'new', [F_KEEP]: 'untouched' })
    }
    expect(await counts()).toEqual({ records: 257, revisions: 257, events: 257, consumers: 514, images: 257 })
    expect((await admin.query('SELECT count(*)::int AS n FROM meta_records WHERE version=2 AND data->>$1::text=$2', [F_TEXT, 'new'])).rows)
      .toEqual([{ n: 257 }])
    expect(emit).not.toHaveBeenCalled()
  }, 60000)
  it('actual grid 17-large-row batch drops excess bytes before helper SQL, while all small patches commit', async () => {
    const ids = Array.from({ length: 17 }, (_, index) => 'synthetic-grid-byte-budget-' + index)
    // Existing large values originate in PostgreSQL; the actual grid call supplies only a small patch.
    await admin.query(`INSERT INTO meta_records(id,sheet_id,data,version,created_by)
      SELECT id,$2,jsonb_build_object($4::text,'old',$5::text,repeat('x',250000)),1,$3 FROM unnest($1::text[]) AS id`,
    [ids, SHEET, ACTOR, F_TEXT, F_KEEP])
    const input = bulk(ids[0], [{ fieldId: F_TEXT, value: 'new' }])
    input.changesByRecord = new Map(ids.map(id => [id, [{ fieldId: F_TEXT, value: 'new' }]]))
    captureObservation = { projections: [], submissions: [], overflow: false }
    await writer.patchRecords(input)
    expect(captureObservation.overflow).toBe(false)
    expect(captureObservation.projections).toHaveLength(17)
    expect(captureObservation.projections.every(row => row.kind === 'write' && !row.textNull && !row.oversized
      && Number(row.textBytes) > 250000 && Number(row.textBytes) <= 262144)).toBe(true)
    // Seventeen is far below the count cap: only the producer's aggregate byte branch can discard
    // this argument before the helper SQL. A later DB-only batch refusal cannot satisfy this oracle.
    expect(captureObservation.submissions).toEqual([
      ...Array.from({ length: 16 }, () => ({ textNull: false, reason: 'none' })),
      { textNull: true, reason: 'batch_limits' },
    ])
    const rows = (await admin.query(`SELECT i.record_id,i.status,i.reason,i.captured_bytes,
        i.after_image IS NULL AS image_null,i.after_image=r.data AS exact_stored_row,o.payload,i.event_id
      FROM meta_automation_record_after_images i JOIN meta_records r ON r.id=i.record_id AND r.sheet_id=i.sheet_id
      JOIN meta_automation_outbox o ON o.id=i.outbox_id`)).rows
    expect(rows.filter(row => row.status === 'captured')).toHaveLength(16)
    const unavailable = rows.filter(row => row.status === 'unavailable')
    expect(unavailable).toHaveLength(1)
    expect(unavailable[0]).toMatchObject({ record_id: ids[16], reason: 'batch_limits', image_null: true, captured_bytes: 0 })
    expect(rows.reduce((sum, row) => sum + Number(row.captured_bytes), 0)).toBeLessThanOrEqual(4194304)
    for (const row of rows) {
      expect(row.payload).toEqual({ sheetId: SHEET, recordId: row.record_id, changes: { [F_TEXT]: 'new' }, actorId: ACTOR, _eventId: row.event_id })
      if (row.status === 'captured') expect(row.exact_stored_row).toBe(true)
    }
    expect(await counts()).toEqual({ records: 17, revisions: 17, events: 17, consumers: 34, images: 17 })
    expect((await admin.query(`SELECT count(*)::int AS n FROM meta_records
      WHERE version=2 AND data->>$1::text=$2 AND length(data->>$3::text)=250000`, [F_TEXT, 'new', F_KEEP])).rows)
      .toEqual([{ n: 17 }])
    expect(emit).not.toHaveBeenCalled()
  }, 60000)
  it('actual producer failure to insert private capture rolls back source data, revision and public event', async () => {
    const recordId = await seed()
    await admin.query(`CREATE FUNCTION synthetic_capture_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SYNTHETIC_CAPTURE_FAILURE'; END $$;
      CREATE TRIGGER synthetic_capture_failure BEFORE INSERT ON meta_automation_record_after_images
      FOR EACH ROW EXECUTE FUNCTION synthetic_capture_failure();`)
    try {
      await expect(service.patchRecord({ recordId, sheetId: SHEET, data: { [F_TEXT]: 'must-rollback' }, actorId: ACTOR, access, capabilities }))
        .rejects.toThrow('SYNTHETIC_CAPTURE_FAILURE')
      expect(await counts()).toEqual({ records: 1, revisions: 0, events: 0, consumers: 0, images: 0 })
      expect((await admin.query('SELECT version,data FROM meta_records WHERE id=$1', [recordId])).rows)
        .toEqual([{ version: 1, data: { [F_TEXT]: 'old', [F_KEEP]: 'untouched' } }])
      expect(emit).not.toHaveBeenCalled()
    } finally { await admin.query('DROP TRIGGER synthetic_capture_failure ON meta_automation_record_after_images; DROP FUNCTION synthetic_capture_failure()') }
  })
  it('actual source version conflict has no event or image', async () => {
    const recordId = await seed()
    await expect(service.patchRecord({ recordId, sheetId: SHEET, data: { [F_TEXT]: 'no' }, expectedVersion: 99, actorId: ACTOR, access, capabilities }))
      .rejects.toBeInstanceOf(VersionConflictError)
    expect(await counts()).toEqual({ records: 1, revisions: 0, events: 0, consumers: 0, images: 0 })
  })
  it('missing capture migration is a real producer failure, not a silently omitted private snapshot', async () => {
    await db.transaction().execute(removeSchemaRevision)
    await db.transaction().execute(removeImages)
    try {
      await expect(service.createRecord({ sheetId: SHEET, data: { [F_TEXT]: 'no' }, actorId: ACTOR, capabilities })).rejects.toMatchObject({ code: '42P01' })
      expect((await admin.query('SELECT count(*)::int AS n FROM meta_records')).rows).toEqual([{ n: 0 }])
      expect((await admin.query('SELECT count(*)::int AS n FROM meta_automation_outbox')).rows).toEqual([{ n: 0 }])
    } finally {
      await db.transaction().execute(addImages)
      await db.transaction().execute(addSchemaRevision)
    }
  })
  it('missing only schema-revision migration rolls back the actual REST create and every durable side effect', async () => {
    // Keep the real material-epoch and raw-image migrations installed. This isolates deployment
    // ordering for the new schema_revision column from the existing missing-image-table refusal.
    await db.transaction().execute(removeSchemaRevision)
    try {
      await expect(service.createRecord({ sheetId: SHEET, data: { [F_TEXT]: 'must-rollback' }, actorId: ACTOR, capabilities }))
        .rejects.toMatchObject({ code: '42703' })
      expect(await counts()).toEqual({ records: 0, revisions: 0, events: 0, consumers: 0, images: 0 })
      expect(emit).not.toHaveBeenCalled()
    } finally { await db.transaction().execute(addSchemaRevision) }
  })
  describe('AutomationExecutor public execute: actual PG source writes and private images', () => {
    type ProducerAction = 'create_record' | 'update_record'
    const actionTypes = ['create_record', 'update_record'] as const
    const producerRecord = 'synthetic-executor-record'
    const makeConditions = () => createAutomationReadRecordConditions({ businessTimeZone: 'Asia/Shanghai' })
    function producerRule(actionType: ProducerAction, patch: Record<string, unknown> = { [F_TEXT]: 'submitted' }): AutomationRule {
      return { id: 'synthetic-producer-rule', name: 'Synthetic producer', sheetId: SHEET,
        trigger: { type: 'record.created', config: {} }, enabled: true, createdBy: ACTOR,
        createdAt: '2026-10-02T00:00:00.000Z', actions: [{ type: actionType,
          config: actionType === 'create_record' ? { data: { [F_KEEP]: 'untouched', ...patch } } : { fields: patch } }] }
    }
    function executeProducer(actionType: ProducerAction, patch?: Record<string, unknown>, rootExecutionId?: string) {
      return executor.execute(producerRule(actionType, patch),
        { sheetId: SHEET, recordId: producerRecord, actorId: ACTOR, _automationDepth: 1 }, undefined, rootExecutionId)
    }
    async function prepareProducer(actionType: ProducerAction) {
      if (actionType === 'update_record') await seed(producerRecord)
    }
    async function onlyRecordId() {
      const rows = (await admin.query('SELECT id FROM meta_records')).rows
      expect(rows).toHaveLength(1)
      return String(rows[0].id)
    }
    async function evaluateEvent(event: AutomationReadRecordConditionEvent) {
      const conditions = makeConditions()
      return transaction(async trx => conditions.evaluate(trx, await conditions.lock(trx, conditionScope), event))
    }
    beforeEach(() => {
      // This fixture proves the existing same-sheet producer transaction, not canonical fence boot.
      vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'false')
      vi.stubEnv('MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT', 'false')
      vi.stubEnv('AUTOMATION_CLASSA_CLAIM_ENABLED', 'false')
    })

    it.each(actionTypes)('%s captures pre-DML schema and the trigger-modified RETURNING row, not the submitted patch', async actionType => {
      await prepareProducer(actionType)
      const revision = await schemaRevision()
      await admin.query(`CREATE FUNCTION synthetic_executor_saved_row() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_catalog.pg_backend_pid()
            AND relation='meta_fields'::regclass AND mode='ShareLock' AND granted) THEN
            RAISE EXCEPTION 'SYNTHETIC_SCHEMA_NOT_CAPTURED_BEFORE_WRITE';
          END IF;
          NEW.data=NEW.data || '{"synthetic-text":"stored-by-trigger","synthetic-number":9007199254740993}'::jsonb;
          NEW.version=NEW.version+5;
          RETURN NEW;
        END $$;
        CREATE TRIGGER synthetic_executor_saved_row BEFORE INSERT OR UPDATE ON meta_records
        FOR EACH ROW EXECUTE FUNCTION synthetic_executor_saved_row()`)
      try {
        const result = await executeProducer(actionType)
        expect(result.status).toBe('success')
        expect(result.steps).toHaveLength(1)
        expect(await counts()).toEqual({ records: 1, revisions: 1, events: 1, consumers: 2, images: 1 })
        const recordId = await onlyRecordId(), row = (await images())[0]
        expect(row).toMatchObject({ record_id: recordId, sheet_id: SHEET,
          event_type: actionType === 'create_record' ? createdEvent : updatedEvent,
          record_version: actionType === 'create_record' ? '6' : '7', status: 'captured', reason: null,
          schema_revision: revision, after_image: { [F_TEXT]: 'stored-by-trigger', [F_KEEP]: 'untouched' } })
        // Compare raw jsonb inside PG; the default JSON driver would round this numeric literal.
        expect((await admin.query(`SELECT i.after_image=r.data AS exact_data,
          i.record_version=r.version AS exact_version, i.capture_xid::text=r.xmin::text AS same_transaction,
          i.captured_bytes=octet_length(r.data::text) AS exact_bytes,
          i.after_image->>$1::text AS exact_number
          FROM meta_automation_record_after_images i JOIN meta_records r ON r.id=i.record_id`, [F_NUM])).rows)
          .toEqual([{ exact_data: true, exact_version: true, same_transaction: true, exact_bytes: true, exact_number: '9007199254740993' }])
        expect(row.payload).toEqual({ sheetId: SHEET, recordId, actorId: ACTOR, _automationDepth: 2,
          _eventId: row.event_id, ...(actionType === 'create_record'
            ? { data: { [F_KEEP]: 'untouched', [F_TEXT]: 'submitted' } } : { changes: { [F_TEXT]: 'submitted' } }) })
        expect(emit).not.toHaveBeenCalled()
      } finally {
        await admin.query('DROP TRIGGER synthetic_executor_saved_row ON meta_records; DROP FUNCTION synthetic_executor_saved_row()')
      }
    })

    it.each(['9007199254740993', '1.0000000000000001', '1e-400'])('update_record preserves untouched fields and raw numeric %s through actual PG', async numberText => {
      const raw = '{' + JSON.stringify(F_TEXT) + ':"before",' + JSON.stringify(F_KEEP) + ':"untouched",'
        + JSON.stringify(F_NUM) + ':' + numberText + '}'
      await admin.query('INSERT INTO meta_records(id,sheet_id,data,version,created_by) VALUES($1,$2,$3::jsonb,1,$4)',
        [producerRecord, SHEET, raw, ACTOR])
      expect((await executeProducer('update_record')).status).toBe('success')
      const row = (await images())[0]
      expect(row).toMatchObject({ status: 'captured', record_version: '2', schema_revision: await schemaRevision(),
        after_image: { [F_TEXT]: 'submitted', [F_KEEP]: 'untouched' }, payload: { changes: { [F_TEXT]: 'submitted' } } })
      expect((await admin.query(`SELECT i.after_image=r.data AS exact_data,
        (i.after_image->>$1::text)::numeric=$2::numeric AS exact_number,
        i.after_image->>$1::text=r.data->>$1::text AS exact_raw_number,
        i.captured_bytes=octet_length(r.data::text) AS exact_bytes
        FROM meta_automation_record_after_images i JOIN meta_records r ON r.id=i.record_id`, [F_NUM, numberText])).rows)
        .toEqual([{ exact_data: true, exact_number: true, exact_raw_number: true, exact_bytes: true }])
      await rule(conditionTree(F_NUM, 'not_equals', -1), 'record.updated')
      expect(await evaluateEvent(await eventFor(producerRecord)))
        .toEqual({ kind: 'unreadable', reason: 'VALUE_UNREADABLE' })
      expect(emit).not.toHaveBeenCalled()
    })

    it.each(actionTypes)('%s condition evidence continues to use the original full image after a later PG record change', async actionType => {
      await prepareProducer(actionType)
      expect((await executeProducer(actionType)).status).toBe('success')
      const recordId = await onlyRecordId(), event = await eventFor(recordId)
      await rule({ logic: 'and', conditions: [{ fieldId: F_TEXT, operator: 'equals', value: 'submitted' },
        { fieldId: F_KEEP, operator: 'equals', value: 'untouched' }] },
      actionType === 'create_record' ? 'record.created' : 'record.updated')
      expect(await evaluateEvent(event)).toEqual({ kind: 'match' })
      await admin.query('UPDATE meta_records SET data=$1::jsonb,version=version+1 WHERE id=$2',
        [JSON.stringify({ [F_TEXT]: 'later', [F_KEEP]: 'changed-later' }), recordId])
      expect(await evaluateEvent(event)).toEqual({ kind: 'match' })
      expect((await images())[0].after_image).toEqual({ [F_TEXT]: 'submitted', [F_KEEP]: 'untouched' })
    })

    it.each(actionTypes)('%s survives real schema NOWAIT contention via its savepoint with unavailable condition evidence', async actionType => {
      await prepareProducer(actionType)
      const previousRevision = await schemaRevision(), blocker = await pool.connect()
      let event: AutomationReadRecordConditionEvent | undefined
      try {
        await blocker.query('BEGIN')
        await blocker.query('UPDATE meta_fields SET name=$1 WHERE id=$2', ['Uncommitted schema', F_TEXT])
        schemaLockObservation = { conflicts: 0, savepointRollbacks: 0 }
        expect((await executeProducer(actionType)).status).toBe('success')
        expect(schemaLockObservation).toEqual({ conflicts: 1, savepointRollbacks: 1 })
        expect(await counts()).toEqual({ records: 1, revisions: 1, events: 1, consumers: 2, images: 1 })
        const recordId = await onlyRecordId()
        event = await eventFor(recordId)
        expect((await images())[0]).toMatchObject({ record_id: recordId, status: 'captured', schema_revision: null,
          record_version: actionType === 'create_record' ? '1' : '2',
          after_image: { [F_TEXT]: 'submitted', [F_KEEP]: 'untouched' } })
        expect(emit).not.toHaveBeenCalled()
      } finally { await blocker.query('ROLLBACK'); blocker.release() }
      expect(await schemaRevision()).toBe(previousRevision)
      await rule(conditionTree(F_TEXT, 'equals', 'submitted'), actionType === 'create_record' ? 'record.created' : 'record.updated')
      if (!event) throw new Error('SYNTHETIC_EXECUTOR_EVENT_MISSING')
      expect(await evaluateEvent(event)).toEqual({ kind: 'unreadable', reason: 'AFTER_IMAGE_UNAVAILABLE' })
    })

    it.each(actionTypes)('%s rolls back source, revision, consumers, outbox and ClassA claim when actual image INSERT fails', async actionType => {
      await prepareProducer(actionType)
      vi.stubEnv('AUTOMATION_CLASSA_CLAIM_ENABLED', 'true')
      await admin.query(`CREATE FUNCTION synthetic_executor_image_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'SYNTHETIC_EXECUTOR_IMAGE_FAILURE'; END $$;
        CREATE TRIGGER synthetic_executor_image_failure BEFORE INSERT ON meta_automation_record_after_images
        FOR EACH ROW EXECUTE FUNCTION synthetic_executor_image_failure()`)
      try {
        const result = await executeProducer(actionType, undefined, 'synthetic-failure-root')
        expect(result.status).toBe('failed')
        expect(result.steps[0]).toMatchObject({ actionType, status: 'failed', error: 'SYNTHETIC_EXECUTOR_IMAGE_FAILURE' })
        expect(await counts()).toEqual({ records: actionType === 'create_record' ? 0 : 1,
          revisions: 0, events: 0, consumers: 0, images: 0 })
        expect((await admin.query('SELECT count(*)::int AS n FROM meta_automation_action_applied')).rows).toEqual([{ n: 0 }])
        if (actionType === 'update_record') expect((await admin.query('SELECT version,data FROM meta_records')).rows)
          .toEqual([{ version: 1, data: { [F_TEXT]: 'old', [F_KEEP]: 'untouched' } }])
        expect(emit).not.toHaveBeenCalled()
      } finally {
        await admin.query('DROP TRIGGER synthetic_executor_image_failure ON meta_automation_record_after_images; DROP FUNCTION synthetic_executor_image_failure()')
      }
      // The rolled-back real claim must not turn a legitimate retry into alreadyApplied.
      const retry = await executeProducer(actionType, undefined, 'synthetic-failure-root')
      expect(retry.status).toBe('success')
      expect(retry.steps[0].alreadyApplied).toBeUndefined()
      expect(await counts()).toEqual({ records: 1, revisions: 1, events: 1, consumers: 2, images: 1 })
    })

    it('missing update_record keeps its public no-op contract and emits no revision, outbox or image', async () => {
      const result = await executeProducer('update_record')
      expect(result.status).toBe('success')
      expect(result.steps[0]).toMatchObject({ actionType: 'update_record', status: 'success', output: { noop: true } })
      expect(await counts()).toEqual({ records: 0, revisions: 0, events: 0, consumers: 0, images: 0 })
      expect(emit).not.toHaveBeenCalled()
    })

    it.each(actionTypes)('%s with durable OFF keeps real source/revision writes and the legacy emitted patch', async actionType => {
      await prepareProducer(actionType)
      vi.stubEnv(FLAG, 'false')
      executorObservation = { schemaCaptures: 0, sourceWrites: 0, privateInserts: 0 }
      expect((await executeProducer(actionType)).status).toBe('success')
      const recordId = await onlyRecordId()
      expect((await admin.query('SELECT version,data FROM meta_records')).rows).toEqual([{
        version: actionType === 'create_record' ? 1 : 2, data: { [F_TEXT]: 'submitted', [F_KEEP]: 'untouched' },
      }])
      expect(await counts()).toEqual({ records: 1, revisions: 1, events: 0, consumers: 0, images: 0 })
      expect(executorObservation).toEqual({ schemaCaptures: 0, sourceWrites: 1, privateInserts: 0 })
      expect(emit).toHaveBeenCalledTimes(1)
      expect(emit).toHaveBeenCalledWith(actionType === 'create_record' ? createdEvent : updatedEvent,
        { sheetId: SHEET, recordId, actorId: ACTOR, _automationDepth: 2, _eventId: expect.any(String),
          ...(actionType === 'create_record' ? { data: { [F_KEEP]: 'untouched', [F_TEXT]: 'submitted' } }
            : { changes: { [F_TEXT]: 'submitted' } }) })
    })

    it.each(actionTypes)('%s same-root replay uses the real ClassA claim and performs no schema capture or producer side effects', async actionType => {
      await prepareProducer(actionType)
      vi.stubEnv('AUTOMATION_CLASSA_CLAIM_ENABLED', 'true')
      executorObservation = { schemaCaptures: 0, sourceWrites: 0, privateInserts: 0 }
      const first = await executeProducer(actionType, undefined, 'synthetic-replay-root')
      expect(first.status).toBe('success')
      expect(first.steps[0].alreadyApplied).toBeUndefined()
      expect(executorObservation).toEqual({ schemaCaptures: 1, sourceWrites: 1, privateInserts: 1 })
      const baseline = await counts(), before = await images()
      expect(baseline).toEqual({ records: 1, revisions: 1, events: 1, consumers: 2, images: 1 })
      expect((await admin.query('SELECT kind,root_execution_id,action_type FROM meta_automation_action_applied')).rows)
        .toEqual([{ kind: 'execution', root_execution_id: 'synthetic-replay-root', action_type: actionType }])
      executorObservation = { schemaCaptures: 0, sourceWrites: 0, privateInserts: 0 }
      const replay = await executeProducer(actionType, undefined, 'synthetic-replay-root')
      expect(replay.status).toBe('success')
      expect(replay.steps[0]).toMatchObject({ actionType, status: 'success', alreadyApplied: true })
      expect(executorObservation).toEqual({ schemaCaptures: 0, sourceWrites: 0, privateInserts: 0 })
      expect(await counts()).toEqual(baseline)
      expect(await images()).toEqual(before)
      expect(emit).not.toHaveBeenCalled()
    })

    it('create_record rejected by a real BEFORE trigger produces no fabricated RETURNING receipt or durable evidence', async () => {
      await admin.query(`CREATE FUNCTION synthetic_executor_skip_create() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RETURN NULL; END $$;
        CREATE TRIGGER synthetic_executor_skip_create BEFORE INSERT ON meta_records
        FOR EACH ROW EXECUTE FUNCTION synthetic_executor_skip_create()`)
      try {
        const result = await executeProducer('create_record')
        expect(result.status).toBe('failed')
        expect(result.steps[0]).toMatchObject({ status: 'failed', error: 'AUTOMATION_RECORD_CREATE_RECEIPT_INVALID' })
        expect(await counts()).toEqual({ records: 0, revisions: 0, events: 0, consumers: 0, images: 0 })
        expect(emit).not.toHaveBeenCalled()
      } finally {
        await admin.query('DROP TRIGGER synthetic_executor_skip_create ON meta_records; DROP FUNCTION synthetic_executor_skip_create()')
      }
    })
  })

  describe('condition evidence: actual producer, permission services, schema and private image (not admission)', () => {
    const makeConditions = () => createAutomationReadRecordConditions({ businessTimeZone: 'Asia/Shanghai' })

    it('matches a real REST-created image after the current record changes, without querying the latest record', async () => {
      const created = await service.createRecord({ sheetId: SHEET, data: { [F_TEXT]: 'at-event' }, actorId: ACTOR, capabilities })
      const event = await eventFor(created.recordId)
      await rule(conditionTree(F_TEXT, 'equals', 'at-event'))
      await admin.query('UPDATE meta_records SET data=$1::jsonb,version=2 WHERE id=$2', [JSON.stringify({ [F_TEXT]: 'later' }), created.recordId])
      const conditions = makeConditions()
      await transaction(async actual => {
        const statements: string[] = []
        const trx: TransactionalQueryable = { isTransaction: true, query: async (sql, params) => {
          statements.push(sql)
          return actual.query(sql, params)
        } }
        const context = await conditions.lock(trx, conditionScope)
        expect(context.fieldIds).toEqual([F_TEXT])
        expect(Object.isFrozen(context)).toBe(true)
        expect(await conditions.evaluate(trx, context, event)).toEqual({ kind: 'match' })
        expect(statements.some(sql => /\b(?:FROM|JOIN)\s+meta_records\b/iu.test(sql))).toBe(false)
      })
    })

    it('evaluates an untouched field from an actual PATCH image, rather than its public patch payload', async () => {
      const recordId = await seed()
      await service.patchRecord({ recordId, sheetId: SHEET, data: { [F_TEXT]: 'after' }, actorId: ACTOR, access, capabilities })
      const event = await eventFor(recordId)
      await rule(conditionTree(F_KEEP, 'equals', 'untouched'), 'record.updated')
      const conditions = makeConditions()
      await transaction(async trx => {
        const context = await conditions.lock(trx, conditionScope)
        expect(await conditions.evaluate(trx, context, event)).toEqual({ kind: 'match' })
      })
      expect((await images())[0].payload.data).toEqual({ [F_TEXT]: 'after' })
    })

    it('returns no_match for a readable nonmatching actual saved value', async () => {
      const created = await service.createRecord({ sheetId: SHEET, data: { [F_TEXT]: 'saved' }, actorId: ACTOR, capabilities })
      const event = await eventFor(created.recordId)
      await rule(conditionTree(F_TEXT, 'equals', 'different'))
      const conditions = makeConditions()
      await transaction(async trx => expect(await conditions.evaluate(trx, await conditions.lock(trx, conditionScope), event))
        .toEqual({ kind: 'no_match' }))
    })

    it.each([false, true])('missing is unreadable, explicit NULL is empty (present=%s)', async present => {
      const created = await service.createRecord({ sheetId: SHEET, data: { [F_TEXT]: 'saved', ...(present ? { [F_KEEP]: null } : {}) }, actorId: ACTOR, capabilities })
      const event = await eventFor(created.recordId)
      await rule(conditionTree(F_KEEP, 'is_empty'))
      const conditions = makeConditions()
      await transaction(async trx => expect(await conditions.evaluate(trx, await conditions.lock(trx, conditionScope), event))
        .toEqual(present ? { kind: 'match' } : { kind: 'unreadable', reason: 'VALUE_UNREADABLE' }))
    })

    it.each(['missing', 'null-schema', 'unavailable'] as const)('does not infer evidence from a public payload (%s)', async mode => {
      await rule(conditionTree(F_TEXT, 'equals', 'public-is-not-proof'))
      const receipt = await transaction(async trx => {
        const event = await enqueueOutboxEvent(trx, { eventType: createdEvent, eventId: randomUUID(),
          payload: { sheetId: SHEET, recordId: 'synthetic-record', data: { [F_TEXT]: 'public-is-not-proof' } } })
        if (mode !== 'missing') await persistAutomationRecordAfterImage(trx, event, { sheetId: SHEET,
          recordId: 'synthetic-record', recordVersion: 1, data: { [F_TEXT]: 'public-is-not-proof' },
          ...(mode === 'unavailable' ? { oversized: true, schema: await captureAutomationRecordSchema(trx, SHEET) } : {}) })
        return event
      })
      const conditions = makeConditions()
      await transaction(async trx => expect(await conditions.evaluate(trx, await conditions.lock(trx, conditionScope),
        { outboxId: receipt.outboxId, eventId: receipt.eventId, eventType: createdEvent }))
        .toEqual({ kind: 'unreadable', reason: 'AFTER_IMAGE_UNAVAILABLE' }))
    })

    it.each(['outboxId', 'eventId', 'eventType'] as const)('requires exact persisted event %s', async key => {
      const created = await service.createRecord({ sheetId: SHEET, data: { [F_TEXT]: 'saved' }, actorId: ACTOR, capabilities })
      const event = await eventFor(created.recordId)
      await rule(conditionTree(F_TEXT, 'equals', 'saved'))
      const changed = { ...event, [key]: key === 'eventType' ? updatedEvent : randomUUID() }
      const conditions = makeConditions()
      await transaction(async trx => expect(await conditions.evaluate(trx, await conditions.lock(trx, conditionScope), changed))
        .toEqual({ kind: 'unreadable', reason: 'AFTER_IMAGE_UNAVAILABLE' }))
    })

    it('rejects an old image after real schema A to B to A, despite identical current field contents', async () => {
      const created = await service.createRecord({ sheetId: SHEET, data: { [F_TEXT]: 'saved' }, actorId: ACTOR, capabilities })
      const event = await eventFor(created.recordId)
      await rule(conditionTree(F_TEXT, 'equals', 'saved'))
      await admin.query('UPDATE meta_fields SET name=$1 WHERE id=$2', ['B', F_TEXT])
      await admin.query('UPDATE meta_fields SET name=$1 WHERE id=$2', ['Text', F_TEXT])
      const conditions = makeConditions()
      await transaction(async trx => expect(await conditions.evaluate(trx, await conditions.lock(trx, conditionScope), event))
        .toEqual({ kind: 'unreadable', reason: 'AFTER_IMAGE_UNAVAILABLE' }))
    })

    it('fresh condition preparation rejects revoked field access even when snapshot/schema remain unchanged', async () => {
      const created = await service.createRecord({ sheetId: SHEET, data: { [F_TEXT]: 'saved' }, actorId: ACTOR, capabilities })
      const event = await eventFor(created.recordId)
      await rule(conditionTree(F_TEXT, 'equals', 'saved'))
      const conditions = makeConditions()
      await transaction(async trx => expect(await conditions.evaluate(trx, await conditions.lock(trx, conditionScope), event))
        .toEqual({ kind: 'match' }))
      const previousRevision = await schemaRevision()
      await admin.query('INSERT INTO field_permissions VALUES($1,$2,$3,$4,false,false)', [SHEET, F_TEXT, 'user', ACTOR])
      expect(await schemaRevision()).toBe(previousRevision)
      await expect(transaction(trx => conditions.lock(trx, conditionScope)))
        .rejects.toMatchObject({ code: 'AUTOMATION_READ_RECORD_CONDITIONS_DENIED' })
    })

    it('never short-circuits unreadable dependencies behind a matching OR branch', async () => {
      const created = await service.createRecord({ sheetId: SHEET, data: { [F_TEXT]: 'saved' }, actorId: ACTOR, capabilities })
      const event = await eventFor(created.recordId)
      await rule({ logic: 'or', conditions: [{ fieldId: F_TEXT, operator: 'equals', value: 'saved' },
        { fieldId: F_KEEP, operator: 'not_equals', value: 'secret' }] })
      const conditions = makeConditions()
      await transaction(async trx => expect(await conditions.evaluate(trx, await conditions.lock(trx, conditionScope), event))
        .toEqual({ kind: 'unreadable', reason: 'VALUE_UNREADABLE' }))
    })

    it.each(['own-transaction', 'savepoint-released-locks'] as const)('rechecks actual field read access before snapshot evaluation (%s)', async mode => {
      const created = await service.createRecord({ sheetId: SHEET, data: { [F_TEXT]: 'saved' }, actorId: ACTOR, capabilities })
      const event = await eventFor(created.recordId)
      await rule(conditionTree(F_TEXT, 'equals', 'saved'))
      const conditions = makeConditions()
      await transaction(async actual => {
        const statements: string[] = []
        const trx: TransactionalQueryable = { isTransaction: true, query: async (sql, params) => {
          statements.push(sql)
          return actual.query(sql, params)
        } }
        if (mode === 'savepoint-released-locks') {
          // Preserve the schema fence while rolling back only the later condition/ACL locks.
          expect(await captureAutomationRecordSchema(trx, SHEET)).toBeDefined()
          await trx.query('SAVEPOINT before_condition_permissions')
        }
        const context = await conditions.lock(trx, conditionScope)
        if (mode === 'savepoint-released-locks') await trx.query('ROLLBACK TO SAVEPOINT before_condition_permissions')
        const writer = mode === 'own-transaction' ? trx : admin
        await writer.query('INSERT INTO field_permissions VALUES($1,$2,$3,$4,false,false)', [SHEET, F_TEXT, 'user', ACTOR])
        expect(await schemaRevision()).toBe(context.schemaRevision)
        statements.length = 0
        expect(await conditions.evaluate(trx, context, event)).toEqual({ kind: 'unreadable', reason: 'FIELD_ACCESS_DENIED' })
        expect(statements.some(sql => sql.includes('meta_automation_record_after_images'))).toBe(false)
      })
    })

    it.each(['9007199254740993', '1.0000000000000001', '1e-400'])('rejects loss of raw JSON numeric precision after actual PATCH (%s)', async numberText => {
      const recordId = 'synthetic-precision-consumer'
      const raw = '{' + JSON.stringify(F_NUM) + ':' + numberText + ',' + JSON.stringify(F_TEXT) + ':"before"}'
      await admin.query('INSERT INTO meta_records(id,sheet_id,data,version,created_by) VALUES($1,$2,$3::jsonb,1,$4)', [recordId, SHEET, raw, ACTOR])
      await service.patchRecord({ recordId, sheetId: SHEET, data: { [F_TEXT]: 'after' }, actorId: ACTOR, access, capabilities })
      const event = await eventFor(recordId)
      await rule(conditionTree(F_NUM, 'not_equals', -1), 'record.updated')
      const conditions = makeConditions()
      await transaction(async trx => expect(await conditions.evaluate(trx, await conditions.lock(trx, conditionScope), event))
        .toEqual({ kind: 'unreadable', reason: 'VALUE_UNREADABLE' }))
    })

    it('does not read or reject an irrelevant high-precision field outside the complete dependency set', async () => {
      const recordId = 'synthetic-unrelated-precision'
      await admin.query(`INSERT INTO meta_records(id,sheet_id,data,version,created_by)
        VALUES($1,$2,jsonb_build_object($4::text,'before') || '{"unrelatedPrecision":9007199254740993}'::jsonb,1,$3)`, [recordId, SHEET, ACTOR, F_TEXT])
      await service.patchRecord({ recordId, sheetId: SHEET, data: { [F_TEXT]: 'after' }, actorId: ACTOR, access, capabilities })
      const event = await eventFor(recordId)
      await rule(conditionTree(F_TEXT, 'equals', 'after'), 'record.updated')
      const conditions = makeConditions()
      await transaction(async trx => expect(await conditions.evaluate(trx, await conditions.lock(trx, conditionScope), event)).toEqual({ kind: 'match' }))
    })

    it.each(['9007199254740993', '1.0000000000000001', '1e-400'])('rejects a stored numeric string whose conversion changes its value (%s)', async numericString => {
      const recordId = await seed('synthetic-string-precision', { [F_TEXT]: 'before', [F_NUM]: numericString })
      await service.patchRecord({ recordId, sheetId: SHEET, data: { [F_TEXT]: 'after' }, actorId: ACTOR, access, capabilities })
      const event = await eventFor(recordId)
      await rule(conditionTree(F_NUM, 'not_equals', -1), 'record.updated')
      const conditions = makeConditions()
      await transaction(async trx => expect(await conditions.evaluate(trx, await conditions.lock(trx, conditionScope), event))
        .toEqual({ kind: 'unreadable', reason: 'VALUE_UNREADABLE' }))
    })

    it.each([['0.1', 0.1], ['1.00', 1], ['1e3', 1000]] as const)('preserves existing exact numeric spelling %s', async (numericString, literal) => {
      const recordId = await seed('synthetic-string-exact', { [F_TEXT]: 'before', [F_NUM]: numericString })
      await service.patchRecord({ recordId, sheetId: SHEET, data: { [F_TEXT]: 'after' }, actorId: ACTOR, access, capabilities })
      const event = await eventFor(recordId)
      await rule(conditionTree(F_NUM, 'equals', literal), 'record.updated')
      const conditions = makeConditions()
      await transaction(async trx => expect(await conditions.evaluate(trx, await conditions.lock(trx, conditionScope), event))
        .toEqual({ kind: 'match' }))
    })

    it.each(['9007199254740993', '1.0000000000000001', '1e-400'])('rejects raw rule literal precision loss at preparation (%s)', async numberText => {
      await rule(conditionTree(F_NUM, 'equals', 1))
      const raw = '{"logic":"and","conditions":[{"fieldId":' + JSON.stringify(F_NUM) + ',"operator":"equals","value":' + numberText + '}]}'
      await admin.query('UPDATE automation_rules SET conditions=$1::jsonb WHERE id=$2', [raw, RULE])
      await expect(transaction(trx => makeConditions().lock(trx, conditionScope)))
        .rejects.toMatchObject({ code: 'AUTOMATION_READ_RECORD_CONDITIONS_DENIED' })
    })

    it('a metadata document cannot silently round through the JSON driver before strict compilation', async () => {
      await rule(conditionTree(F_NUM, 'equals', 1))
      try {
        await admin.query(`UPDATE meta_fields SET property='{"syntheticPrecision":1.0000000000000001}'::jsonb WHERE id=$1`, [F_NUM])
        await expect(transaction(trx => makeConditions().lock(trx, conditionScope)))
          .rejects.toMatchObject({ code: 'AUTOMATION_READ_RECORD_CONDITIONS_DENIED' })
      } finally { await admin.query("UPDATE meta_fields SET property='{}' WHERE id=$1", [F_NUM]) }
    })

    it('a context cannot be copied, borrowed from another factory or used with another handle', async () => {
      const created = await service.createRecord({ sheetId: SHEET, data: { [F_TEXT]: 'saved' }, actorId: ACTOR, capabilities })
      const event = await eventFor(created.recordId)
      await rule(conditionTree(F_TEXT, 'equals', 'saved'))
      const conditions = makeConditions()
      await transaction(async trx => {
        const context = await conditions.lock(trx, conditionScope)
        for (const attempt of [conditions.evaluate(trx, { ...context }, event),
          makeConditions().evaluate(trx, context, event), conditions.evaluate({ ...trx }, context, event)])
          expect(await attempt).toEqual({ kind: 'unreadable', reason: 'CONTEXT_INVALID' })
      })
    })

    it('same handle cannot carry a condition context into a different database transaction', async () => {
      const created = await service.createRecord({ sheetId: SHEET, data: { [F_TEXT]: 'saved' }, actorId: ACTOR, capabilities })
      const event = await eventFor(created.recordId)
      await rule(conditionTree(F_TEXT, 'equals', 'saved'))
      const conditions = makeConditions(), client = await pool.connect()
      const trx: TransactionalQueryable = { isTransaction: true, query: (sql, params) => client.query(sql, params) }
      try {
        await client.query('BEGIN')
        const context = await conditions.lock(trx, conditionScope)
        await client.query('COMMIT'); await client.query('BEGIN')
        expect(await conditions.evaluate(trx, context, event)).toEqual({ kind: 'unreadable', reason: 'CONTEXT_INVALID' })
      } finally { await client.query('ROLLBACK'); client.release() }
    })

    it('real outbox row lock failure stays a retryable error rather than an ACK-able non-match', async () => {
      const created = await service.createRecord({ sheetId: SHEET, data: { [F_TEXT]: 'saved' }, actorId: ACTOR, capabilities })
      const event = await eventFor(created.recordId)
      await rule(conditionTree(F_TEXT, 'equals', 'saved'))
      const conditions = makeConditions(), blocker = await pool.connect()
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT id FROM meta_automation_outbox WHERE id=$1 FOR UPDATE', [event.outboxId])
        await expect(transaction(async trx => conditions.evaluate(trx, await conditions.lock(trx, conditionScope), event)))
          .rejects.toMatchObject({ code: 'AUTOMATION_READ_RECORD_CONDITIONS_UNAVAILABLE' })
      } finally { await blocker.query('ROLLBACK'); blocker.release() }
    })
  })

  it('durable OFF retains actual create/grid legacy events and does not persist private images', async () => {
    vi.stubEnv(FLAG, 'false')
    const result = await service.createRecord({ sheetId: SHEET, data: { [F_TEXT]: 'off' }, actorId: ACTOR, capabilities })
    await writer.patchRecords(bulk(result.recordId, [{ fieldId: F_NUM, value: '4' }]))
    expect(emit).toHaveBeenCalledTimes(2)
    expect(await counts()).toEqual({ records: 1, revisions: 2, events: 0, consumers: 0, images: 0 })
  })
})
