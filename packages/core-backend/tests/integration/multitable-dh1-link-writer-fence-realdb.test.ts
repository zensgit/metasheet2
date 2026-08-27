import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

import express, { type Request } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import type { EventBus } from '../../src/integration/events/event-bus'
import {
  SheetWriterBlockedError,
  __resetRecoveryWriterStateColumnProbe,
  canonicalSheetFenceKey,
} from '../../src/multitable/canonical-sheet-fence'
import {
  AutomationExecutor,
  type AutomationDeps,
  type AutomationRule,
} from '../../src/multitable/automation-executor'
import {
  LinkWriterFencePlanChangedError,
  enterLinkWriterFencePlan,
  prepareRecordLinkDeleteFencePlan,
  prepareRecordLinkRestoreFencePlan,
  prepareLinkWriterFencePlan,
} from '../../src/multitable/link-writer-fence'
import { RecordPatchFieldValidationError, RecordService } from '../../src/multitable/record-service'
import {
  RecordWriteService,
  type RecordPatchInput as WriteRecordPatchInput,
} from '../../src/multitable/record-write-service'
import {
  createRecord as createPluginRecord,
  deleteRecord as deletePluginRecord,
  patchRecord as patchPluginRecord,
} from '../../src/multitable/records'
import { deriveCapabilities, type AccessInfo } from '../../src/multitable/sheet-capabilities'
import { createRecordWriteHelpers, univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'
const CAPTURE_FLAG = 'MULTITABLE_TOMBSTONE_CAPTURE_ENABLED'
const INBOUND_FLAG = 'MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND'
const TS = Date.now()
const ACTOR = `u_dh1_lwf_${TS}`
const BASE = `base_dh1_lwf_${TS}`
const SOURCE = `sheet_dh1_lwf_s_${TS}`
const TARGET = `sheet_dh1_lwf_t_${TS}`
const DECOY = `sheet_dh1_lwf_d_${TS}`
const F_NOTE = `fld_dh1_lwf_note_${TS}`
const F_LINK = `fld_dh1_lwf_link_${TS}`
const F_BACK = `fld_dh1_lwf_back_${TS}`
const VIEW = `view_dh1_lwf_${TS}`
const R_SOURCE = `rec_dh1_lwf_source_${TS}`
const R_TARGET = `rec_dh1_lwf_target_${TS}`
const R_DECOY = `rec_dh1_lwf_decoy_${TS}`
const createdRecordIds = new Set<string>()
const trashedRecordIds = new Set<string>()

type Client = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>
  release: () => void
}

const q = (sql: string, params: unknown[] = []) => poolManager.get().query(sql, params)
const eventBus = new EventEmitter() as unknown as EventBus
const access: AccessInfo = {
  userId: ACTOR,
  permissions: ['multitable:read', 'multitable:write'],
  isAdminRole: false,
}
const capabilities = deriveCapabilities(access.permissions, access.isAdminRole)
const linkConfig = { foreignSheetId: TARGET, limitSingleRecord: false }

const buildApp = () => {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as Request & { user?: unknown }).user = {
      id: ACTOR,
      roles: ['member'],
      perms: ['multitable:read', 'multitable:write'],
      permissions: ['multitable:read', 'multitable:write'],
    }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return app
}

const connect = async (): Promise<Client> => {
  const internal = poolManager.get().getInternalPool()
  if (!internal) throw new Error('no internal pool')
  return await internal.connect() as unknown as Client
}

const makeRecordService = (
  pool: ConstructorParameters<typeof RecordService>[0] = poolManager.get() as unknown as ConstructorParameters<typeof RecordService>[0],
) => new RecordService(pool, eventBus)

const makeWriteService = () => {
  const req = {
    user: { id: ACTOR, roles: [], perms: ['multitable:read', 'multitable:write'] },
  } as unknown as Request
  const helpers = createRecordWriteHelpers(
    req,
    poolManager.get() as unknown as {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>
    },
  )
  return new RecordWriteService(
    poolManager.get() as unknown as ConstructorParameters<typeof RecordWriteService>[0],
    eventBus,
    helpers,
  )
}

const resolveSheetAccess = async () => ({ capabilities })

const makeAutomationExecutor = () => {
  const deps: AutomationDeps = {
    eventBus,
    queryFn: (sql, params) => q(sql, params),
    transaction: async (handler) => poolManager.get().transaction(async ({ query }) => handler({ query } as never)),
  } as unknown as AutomationDeps
  return new AutomationExecutor(deps)
}

const deleteAutomationRule = (): AutomationRule => ({
  id: `rule_dh1_lwf_delete_${TS}`,
  name: 'D-H1 delete',
  sheetId: TARGET,
  trigger: { type: 'record.updated', config: {} },
  actions: [{ type: 'delete_record', config: {} }],
  enabled: true,
  createdBy: ACTOR,
  createdAt: new Date().toISOString(),
}) as unknown as AutomationRule

const writeInput = (value: string[]): WriteRecordPatchInput => ({
  sheetId: SOURCE,
  changesByRecord: new Map([[R_SOURCE, [{ fieldId: F_LINK, value }]]]),
  actorId: ACTOR,
  fields: [{
    id: F_LINK,
    name: 'Related',
    type: 'link',
    property: { foreignSheetId: TARGET },
    order: 2,
  }],
  visiblePropertyFields: [{
    id: F_LINK,
    name: 'Related',
    type: 'link',
    property: { foreignSheetId: TARGET },
    order: 2,
  }],
  visiblePropertyFieldIds: new Set([F_LINK]),
  attachmentFields: [],
  fieldById: new Map([[
    F_LINK,
    { type: 'link', readOnly: false, hidden: false, link: linkConfig },
  ]]),
  capabilities,
  access,
})

const setBlock = (sheetId: string, state: 'applying' | null) =>
  q('UPDATE meta_sheets SET recovery_writer_state = $2 WHERE id = $1', [sheetId, state])

const readSource = async (): Promise<{ data: Record<string, unknown>; version: number }> =>
  (await q('SELECT data, version FROM meta_records WHERE id = $1 AND sheet_id = $2', [R_SOURCE, SOURCE]))
    .rows[0] as { data: Record<string, unknown>; version: number }

const edgeCount = async (recordId: string): Promise<number> =>
  Number(((await q('SELECT count(*)::int AS n FROM meta_links WHERE field_id = $1 AND record_id = $2', [F_LINK, recordId])).rows[0] as { n: number }).n)

const exactEdgeCount = async (fieldId: string, recordId: string, foreignRecordId: string): Promise<number> =>
  Number(((await q(
    'SELECT count(*)::int AS n FROM meta_links WHERE field_id = $1 AND record_id = $2 AND foreign_record_id = $3',
    [fieldId, recordId, foreignRecordId],
  )).rows[0] as { n: number }).n)

const trashCount = async (recordId: string): Promise<number> =>
  Number(((await q('SELECT count(*)::int AS n FROM meta_records_trash WHERE record_id = $1', [recordId])).rows[0] as { n: number }).n)

const deletedRecordId = (label: string) => `rec_dh1_rr_${label}_${TS}`

const deleteRestoreFixture = async (input: {
  label: string
  outbound?: boolean
  inbound?: boolean
}): Promise<string> => {
  const recordId = deletedRecordId(input.label)
  const data = input.outbound ? { [F_LINK]: [R_TARGET] } : {}
  createdRecordIds.add(recordId)
  trashedRecordIds.add(recordId)
  await q(
    'INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)',
    [recordId, SOURCE, JSON.stringify(data), ACTOR],
  )
  if (input.outbound) {
    await q(
      'INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)',
      [`lnk_dh1_rr_out_${input.label}_${TS}`.slice(0, 50), F_LINK, recordId, R_TARGET],
    )
  }
  if (input.inbound) {
    await q(
      'UPDATE meta_records SET data = $3::jsonb WHERE id = $1 AND sheet_id = $2',
      [R_TARGET, TARGET, JSON.stringify({ [F_BACK]: [recordId] })],
    )
    await q(
      'INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)',
      [`lnk_dh1_rr_in_${input.label}_${TS}`.slice(0, 50), F_BACK, R_TARGET, recordId],
    )
  }
  await makeRecordService().deleteRecord({
    recordId,
    actorId: ACTOR,
    access,
    resolveSheetAccess,
  })
  expect(await trashCount(recordId)).toBe(1)
  return recordId
}

const waitForAdvisoryWaiter = async (blockerPid: number): Promise<void> => {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await q(
      `SELECT count(*)::int AS n
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
          AND $1::int = ANY(pg_blocking_pids(pid))`,
      [blockerPid],
    )
    if (Number((result.rows[0] as { n: number }).n) > 0) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('route did not park on the canonical fence')
}

const settleWhileMutationLockHeld = async <T>(promise: Promise<T>, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} waited on an unfenced row lock`)), 3_000)
    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })

test('sentinel: D-H1 link writer fence real-DB lane must not skip-green', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('D-H1 link writer fence real-DB step is missing DATABASE_URL')
  }
  expect(true).toBe(true)
})

describeIfDatabase.sequential('D-H1 cross-sheet meta_links writer fence', () => {
  beforeAll(async () => {
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [BASE, 'D-H1 link fence', ACTOR])
    for (const [id, name] of [[SOURCE, 'Source'], [TARGET, 'Target'], [DECOY, 'Decoy']] as const) {
      await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [id, BASE, name])
    }
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_NOTE, SOURCE, 'Note', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_LINK, SOURCE, 'Related', 'link', JSON.stringify({ foreignSheetId: TARGET }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_BACK, TARGET, 'Back', 'link', JSON.stringify({ foreignSheetId: SOURCE }), 1])
    await q('INSERT INTO meta_views (id, sheet_id, name, type, config) VALUES ($1,$2,$3,$4,$5::jsonb)', [VIEW, SOURCE, 'D-H1 form', 'form', '{}'])
    await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [R_SOURCE, SOURCE, JSON.stringify({ [F_NOTE]: 'before', [F_LINK]: [] }), ACTOR])
    await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [R_TARGET, TARGET, '{}', ACTOR])
    await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [R_DECOY, DECOY, '{}', ACTOR])
  })

  afterEach(async () => {
    delete process.env[FLAG]
    delete process.env[CAPTURE_FLAG]
    delete process.env[INBOUND_FLAG]
    __resetRecoveryWriterStateColumnProbe()
    await setBlock(SOURCE, null)
    await setBlock(TARGET, null)
    await setBlock(DECOY, null)
    if (createdRecordIds.size > 0) {
      const ids = [...createdRecordIds]
      await q('DELETE FROM meta_links WHERE record_id = ANY($1::text[]) OR foreign_record_id = ANY($1::text[])', [ids])
      await q('DELETE FROM meta_record_revisions WHERE record_id = ANY($1::text[])', [ids]).catch(() => {})
      await q('DELETE FROM meta_records WHERE id = ANY($1::text[])', [ids])
      createdRecordIds.clear()
    }
    await q('DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2', [F_LINK, R_SOURCE])
    if (trashedRecordIds.size > 0) {
      const ids = [...trashedRecordIds]
      await q('DELETE FROM meta_link_tombstones WHERE record_id = ANY($1::text[]) OR foreign_record_id = ANY($1::text[])', [ids]).catch(() => {})
      await q('DELETE FROM meta_records_trash WHERE record_id = ANY($1::text[])', [ids]).catch(() => {})
      trashedRecordIds.clear()
    }
    await q(
      'INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4) ON CONFLICT (id) DO NOTHING',
      [R_TARGET, TARGET, '{}', ACTOR],
    )
    await q('UPDATE meta_records SET sheet_id = $2, data = $3::jsonb, version = 1 WHERE id = $1', [R_TARGET, TARGET, '{}'])
    await q('UPDATE meta_records SET data = $3::jsonb, version = 1 WHERE id = $1 AND sheet_id = $2', [R_SOURCE, SOURCE, JSON.stringify({ [F_NOTE]: 'before', [F_LINK]: [] })])
    await q('UPDATE meta_fields SET property = $2::jsonb WHERE id = $1', [F_LINK, JSON.stringify({ foreignSheetId: TARGET })])
    await q('UPDATE meta_fields SET sheet_id = $2, property = $3::jsonb WHERE id = $1', [F_BACK, TARGET, JSON.stringify({ foreignSheetId: SOURCE })])
  })

  afterAll(async () => {
    delete process.env[FLAG]
    await q('DELETE FROM meta_links WHERE field_id = ANY($1::text[])', [[F_LINK, F_BACK]]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = ANY($1::text[])', [[SOURCE, TARGET, DECOY]]).catch(() => {})
    await q('DELETE FROM meta_record_history_operations WHERE sheet_id = ANY($1::text[])', [[SOURCE, TARGET, DECOY]]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[SOURCE, TARGET, DECOY]]).catch(() => {})
    await q('DELETE FROM meta_views WHERE id = $1', [VIEW]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SOURCE, TARGET, DECOY]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SOURCE, TARGET, DECOY]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })

  test('flag OFF adds no target-plan query and preserves create first-statement source fence', async () => {
    delete process.env[FLAG]
    await setBlock(TARGET, 'applying')
    const poolSql: string[] = []
    const transactionSql: string[] = []
    const rawPool = poolManager.get()
    const observedPool = {
      query: async (sql: string, params?: unknown[]) => {
        poolSql.push(sql)
        return rawPool.query(sql, params)
      },
      transaction: async <T>(handler: (client: { query: typeof q }) => Promise<T>): Promise<T> =>
        rawPool.transaction(async ({ query }) => handler({
          query: async (sql: string, params?: unknown[]) => {
            transactionSql.push(sql)
            return query(sql, params)
          },
        })),
    }
    const result = await makeRecordService(observedPool as never).createRecord({
      sheetId: SOURCE,
      data: { [F_LINK]: [R_TARGET] },
      actorId: ACTOR,
      capabilities,
    })
    createdRecordIds.add(result.recordId)
    expect(poolSql.some((sql) => /meta_fields[\s\S]+id = ANY/i.test(sql))).toBe(false)
    expect(transactionSql[0]).toMatch(/pg_advisory_xact_lock/)
    expect(await edgeCount(result.recordId)).toBe(1)
  })

  test('REST create fences the actual target, ignores a blocked decoy, and writes no row when target is blocked', async () => {
    process.env[FLAG] = 'true'
    await setBlock(TARGET, 'applying')
    const before = Number(((await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id = $1', [SOURCE])).rows[0] as { n: number }).n)
    await expect(makeRecordService().createRecord({
      sheetId: SOURCE,
      data: { [F_LINK]: [R_TARGET] },
      actorId: ACTOR,
      capabilities,
    })).rejects.toBeInstanceOf(SheetWriterBlockedError)
    expect(Number(((await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id = $1', [SOURCE])).rows[0] as { n: number }).n)).toBe(before)

    await setBlock(TARGET, null)
    await setBlock(DECOY, 'applying')
    const result = await makeRecordService().createRecord({
      sheetId: SOURCE,
      data: { [F_LINK]: [R_TARGET] },
      actorId: ACTOR,
      capabilities,
    })
    createdRecordIds.add(result.recordId)
    expect(await edgeCount(result.recordId)).toBe(1)
  })

  test('flag OFF keeps plugin create query-inert before its legacy source fence', async () => {
    delete process.env[FLAG]
    const observedSql: string[] = []
    const result = await poolManager.get().transaction(async ({ query }) => createPluginRecord({
      query: (async (sql: string, params?: unknown[]) => {
        observedSql.push(sql)
        return query(sql, params)
      }) as never,
      sheetId: SOURCE,
      data: { [F_LINK]: [R_TARGET] },
    }))
    createdRecordIds.add(result.id)
    expect(observedSql[0]).toMatch(/pg_advisory_xact_lock/)
    expect(observedSql.some((sql) => /meta_fields[\s\S]+id = ANY/i.test(sql))).toBe(false)
    expect(await edgeCount(result.id)).toBe(1)
  })

  test('flag ON keeps plugin and public-form link writers usable when only a decoy is blocked', async () => {
    process.env[FLAG] = 'true'
    await setBlock(DECOY, 'applying')

    const pluginCreated = await poolManager.get().transaction(async ({ query }) => createPluginRecord({
      query: query as never,
      sheetId: SOURCE,
      data: { [F_LINK]: [R_TARGET] },
    }))
    createdRecordIds.add(pluginCreated.id)
    expect(await edgeCount(pluginCreated.id)).toBe(1)

    const pluginPatched = await poolManager.get().transaction(async ({ query }) => patchPluginRecord({
      query: query as never,
      sheetId: SOURCE,
      recordId: R_SOURCE,
      changes: { [F_LINK]: [R_TARGET] },
    }))
    expect(pluginPatched).toMatchObject({ version: 2, data: { [F_LINK]: [R_TARGET] } })
    expect(await edgeCount(R_SOURCE)).toBe(1)

    const formCreate = await request(buildApp())
      .post(`/api/multitable/views/${VIEW}/submit`)
      .send({ data: { [F_LINK]: [R_TARGET] } })
    expect(formCreate.status).toBe(200)
    expect(formCreate.body.data.mode).toBe('create')
    const formRecordId = String(formCreate.body.data.record.id)
    createdRecordIds.add(formRecordId)
    expect(await edgeCount(formRecordId)).toBe(1)

    const formEdit = await request(buildApp())
      .post(`/api/multitable/views/${VIEW}/submit`)
      .send({
        recordId: formRecordId,
        expectedVersion: 1,
        data: { [F_LINK]: [] },
      })
    expect(formEdit.status).toBe(200)
    expect(formEdit.body.data).toMatchObject({
      mode: 'update',
      record: { id: formRecordId, version: 2 },
    })
    expect(await edgeCount(formRecordId)).toBe(0)
  })

  test('plugin create and patch both refuse a blocked target before record or edge mutation', async () => {
    process.env[FLAG] = 'true'
    await setBlock(TARGET, 'applying')
    const before = Number(((await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id = $1', [SOURCE])).rows[0] as { n: number }).n)

    await expect(poolManager.get().transaction(async ({ query }) => createPluginRecord({
      query: query as never,
      sheetId: SOURCE,
      data: { [F_LINK]: [R_TARGET] },
    }))).rejects.toBeInstanceOf(SheetWriterBlockedError)
    await expect(poolManager.get().transaction(async ({ query }) => patchPluginRecord({
      query: query as never,
      sheetId: SOURCE,
      recordId: R_SOURCE,
      changes: { [F_LINK]: [R_TARGET] },
    }))).rejects.toBeInstanceOf(SheetWriterBlockedError)

    expect(Number(((await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id = $1', [SOURCE])).rows[0] as { n: number }).n)).toBe(before)
    expect(await readSource()).toMatchObject({ version: 1, data: { [F_LINK]: [] } })
    expect(await edgeCount(R_SOURCE)).toBe(0)
  })

  test('public form create and edit both refuse a blocked target with the shared values-free 409', async () => {
    process.env[FLAG] = 'true'
    await setBlock(TARGET, 'applying')

    for (const body of [
      { data: { [F_LINK]: [R_TARGET] } },
      { recordId: R_SOURCE, expectedVersion: 1, data: { [F_LINK]: [R_TARGET] } },
    ]) {
      const response = await request(buildApp())
        .post(`/api/multitable/views/${VIEW}/submit`)
        .send(body)
      expect(response.status).toBe(409)
      expect(response.body).toEqual({
        ok: false,
        error: {
          code: 'RECOVERY_IN_PROGRESS',
          message: 'Another recovery operation is in progress on this sheet; retry shortly.',
        },
      })
    }

    expect(await readSource()).toMatchObject({ version: 1, data: { [F_LINK]: [] } })
    expect(await edgeCount(R_SOURCE)).toBe(0)
  })

  test('REST patch and bulk patch both refuse a blocked target before record or edge mutation', async () => {
    process.env[FLAG] = 'true'
    await setBlock(TARGET, 'applying')
    await expect(makeRecordService().patchRecord({
      recordId: R_SOURCE,
      sheetId: SOURCE,
      data: { [F_LINK]: [R_TARGET] },
      actorId: ACTOR,
      access,
      capabilities,
    })).rejects.toBeInstanceOf(SheetWriterBlockedError)
    expect(await readSource()).toMatchObject({ version: 1, data: { [F_LINK]: [] } })
    expect(await edgeCount(R_SOURCE)).toBe(0)

    await expect(makeWriteService().patchRecords(writeInput([R_TARGET]))).rejects.toBeInstanceOf(SheetWriterBlockedError)
    expect(await readSource()).toMatchObject({ version: 1, data: { [F_LINK]: [] } })
    expect(await edgeCount(R_SOURCE)).toBe(0)
  })

  test('record-delete plan is query-inert while the writer fence is off', async () => {
    delete process.env[FLAG]
    let queries = 0
    const plan = await prepareRecordLinkDeleteFencePlan(async () => {
      queries += 1
      return { rows: [] }
    }, TARGET, R_TARGET)
    expect(plan).toBeNull()
    expect(queries).toBe(0)
  })

  test('record-restore plan is query-inert while the writer fence is off', async () => {
    delete process.env[FLAG]
    let queries = 0
    const plan = await prepareRecordLinkRestoreFencePlan(async () => {
      queries += 1
      return { rows: [] }
    }, {
      sourceSheetId: SOURCE,
      deleteRevisionId: null,
      candidateFieldIds: [F_LINK],
      outboundTargets: [{ fieldId: F_LINK, recordIds: [R_TARGET] }],
    })
    expect(plan).toBeNull()
    expect(queries).toBe(0)
  })

  test('trash restore fences outbound and inbound participants, then rebuilds both edge directions', async () => {
    process.env[FLAG] = 'true'
    process.env[CAPTURE_FLAG] = 'true'
    process.env[INBOUND_FLAG] = 'true'
    const recordId = await deleteRestoreFixture({ label: 'ok', outbound: true, inbound: true })

    const restored = await makeRecordService().restoreRecord({
      recordId,
      actorId: ACTOR,
      access,
      resolveSheetAccess,
    })

    expect(restored.inbound).toMatchObject({ replayed: 1, recoverable: true })
    expect(await exactEdgeCount(F_LINK, recordId, R_TARGET)).toBe(1)
    expect(await exactEdgeCount(F_BACK, R_TARGET, recordId)).toBe(1)
    expect(await trashCount(recordId)).toBe(0)
  })

  test('trash restore inserts the restored row before target liveness so an outbound self-link remains valid', async () => {
    process.env[FLAG] = 'true'
    const recordId = deletedRecordId('self')
    createdRecordIds.add(recordId)
    trashedRecordIds.add(recordId)
    await q('UPDATE meta_fields SET property = $2::jsonb WHERE id = $1', [F_LINK, JSON.stringify({ foreignSheetId: SOURCE })])
    await q(
      'INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)',
      [recordId, SOURCE, JSON.stringify({ [F_LINK]: [recordId] }), ACTOR],
    )
    await q(
      'INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$3)',
      [`lnk_dh1_rr_self_${TS}`.slice(0, 50), F_LINK, recordId],
    )
    await makeRecordService().deleteRecord({ recordId, actorId: ACTOR, access, resolveSheetAccess })

    await makeRecordService().restoreRecord({ recordId, actorId: ACTOR, access, resolveSheetAccess })

    expect(await exactEdgeCount(F_LINK, recordId, recordId)).toBe(1)
    expect(await trashCount(recordId)).toBe(0)
  })

  test('trash restore refuses a blocked outbound target before recreating the record or edge', async () => {
    process.env[FLAG] = 'true'
    const recordId = await deleteRestoreFixture({ label: 'blocked', outbound: true })
    await setBlock(TARGET, 'applying')

    const response = await request(buildApp())
      .post(`/api/multitable/records/${recordId}/restore`)

    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'RECOVERY_IN_PROGRESS',
        message: 'Another recovery operation is in progress on this sheet; retry shortly.',
      },
    })
    expect(JSON.stringify(response.body)).not.toContain(recordId)
    expect(JSON.stringify(response.body)).not.toContain(TARGET)

    expect((await q('SELECT 1 FROM meta_records WHERE id = $1', [recordId])).rows).toHaveLength(0)
    expect(await exactEdgeCount(F_LINK, recordId, R_TARGET)).toBe(0)
    expect(await trashCount(recordId)).toBe(1)
  })

  test('trash restore rechecks target liveness after a concurrent target delete and returns values-free 409', async () => {
    process.env[FLAG] = 'true'
    const recordId = await deleteRestoreFixture({ label: 'target_race', outbound: true })
    const blocker = await connect()
    try {
      await blocker.query('BEGIN')
      const blockerPid = Number(((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid)
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(TARGET)])
      await blocker.query('DELETE FROM meta_records WHERE id = $1 AND sheet_id = $2', [R_TARGET, TARGET])

      const responsePromise = request(buildApp())
        .post(`/api/multitable/records/${recordId}/restore`)
        .then((response) => response)
      await waitForAdvisoryWaiter(blockerPid)
      await blocker.query('COMMIT')

      const response = await responsePromise
      expect(response.status).toBe(409)
      expect(response.body).toEqual({
        ok: false,
        error: {
          code: 'CONFLICT',
          message: 'Cannot restore: linked records changed concurrently; retry',
        },
      })
      expect(JSON.stringify(response.body)).not.toContain(recordId)
      expect(JSON.stringify(response.body)).not.toContain(R_TARGET)
      expect((await q('SELECT 1 FROM meta_records WHERE id = $1', [recordId])).rows).toHaveLength(0)
      expect(await exactEdgeCount(F_LINK, recordId, R_TARGET)).toBe(0)
      expect(await trashCount(recordId)).toBe(1)
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
    }
  })

  test('trash restore fails closed without waiting on an in-flight outbound target move', async () => {
    process.env[FLAG] = 'true'
    const recordId = await deleteRestoreFixture({ label: 'target_move_lock', outbound: true })
    const mover = await connect()
    let responsePromise: Promise<request.Response> | undefined
    try {
      await mover.query('BEGIN')
      await mover.query('UPDATE meta_records SET sheet_id = $2 WHERE id = $1', [R_TARGET, DECOY])
      responsePromise = request(buildApp())
        .post(`/api/multitable/records/${recordId}/restore`)
        .then((response) => response)

      const response = await settleWhileMutationLockHeld(responsePromise, 'outbound target recheck')
      expect(response.status).toBe(409)
      expect(response.body).toEqual({
        ok: false,
        error: {
          code: 'CONFLICT',
          message: 'Cannot restore: linked records changed concurrently; retry',
        },
      })
      expect((await q('SELECT 1 FROM meta_records WHERE id = $1', [recordId])).rows).toHaveLength(0)
      expect(await exactEdgeCount(F_LINK, recordId, R_TARGET)).toBe(0)
      expect(await trashCount(recordId)).toBe(1)
    } finally {
      await mover.query('ROLLBACK').catch(() => {})
      await responsePromise?.catch(() => {})
      mover.release()
    }
  })

  test('trash restore rejects an outbound field target change after preflight', async () => {
    process.env[FLAG] = 'true'
    const recordId = await deleteRestoreFixture({ label: 'field_race', outbound: true })
    const blocker = await connect()
    const firstFenceSheet = [SOURCE, TARGET].sort()[0]
    try {
      await blocker.query('BEGIN')
      const blockerPid = Number(((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid)
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(firstFenceSheet)])

      const responsePromise = request(buildApp())
        .post(`/api/multitable/records/${recordId}/restore`)
        .then((response) => response)
      await waitForAdvisoryWaiter(blockerPid)
      await q('UPDATE meta_fields SET property = $2::jsonb WHERE id = $1', [F_LINK, JSON.stringify({ foreignSheetId: DECOY })])
      await blocker.query('COMMIT')

      const response = await responsePromise
      expect(response.status).toBe(409)
      expect(response.body).toEqual({
        ok: false,
        error: {
          code: 'CONFLICT',
          message: 'Cannot restore: linked records changed concurrently; retry',
        },
      })
      expect(JSON.stringify(response.body)).not.toContain(DECOY)
      expect((await q('SELECT 1 FROM meta_records WHERE id = $1', [recordId])).rows).toHaveLength(0)
      expect(await trashCount(recordId)).toBe(1)
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
    }
  })

  test('trash restore rejects an outbound field becoming read-only after preflight', async () => {
    process.env[FLAG] = 'true'
    const recordId = await deleteRestoreFixture({ label: 'field_readonly_race', outbound: true })
    const blocker = await connect()
    const firstFenceSheet = [SOURCE, TARGET].sort()[0]
    try {
      await blocker.query('BEGIN')
      const blockerPid = Number(((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid)
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(firstFenceSheet)])

      const responsePromise = request(buildApp())
        .post(`/api/multitable/records/${recordId}/restore`)
        .then((response) => response)
      await waitForAdvisoryWaiter(blockerPid)
      await q('UPDATE meta_fields SET property = $2::jsonb WHERE id = $1', [
        F_LINK,
        JSON.stringify({ foreignSheetId: TARGET, mirrorOf: 'field_source' }),
      ])
      await blocker.query('COMMIT')

      const response = await responsePromise
      expect(response.status).toBe(409)
      expect(response.body).toEqual({
        ok: false,
        error: {
          code: 'CONFLICT',
          message: 'Cannot restore: linked records changed concurrently; retry',
        },
      })
      expect(JSON.stringify(response.body)).not.toContain(recordId)
      expect((await q('SELECT 1 FROM meta_records WHERE id = $1', [recordId])).rows).toHaveLength(0)
      expect(await trashCount(recordId)).toBe(1)
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
    }
  })

  test('trash restore refuses a blocked inbound owner sheet before replay mutation', async () => {
    process.env[FLAG] = 'true'
    process.env[CAPTURE_FLAG] = 'true'
    process.env[INBOUND_FLAG] = 'true'
    const recordId = await deleteRestoreFixture({ label: 'in_blocked', inbound: true })
    await setBlock(TARGET, 'applying')

    await expect(makeRecordService().restoreRecord({
      recordId,
      actorId: ACTOR,
      access,
      resolveSheetAccess,
    })).rejects.toBeInstanceOf(SheetWriterBlockedError)

    expect((await q('SELECT 1 FROM meta_records WHERE id = $1', [recordId])).rows).toHaveLength(0)
    expect(await exactEdgeCount(F_BACK, R_TARGET, recordId)).toBe(0)
    expect(await trashCount(recordId)).toBe(1)
  })

  test('trash restore rejects inbound participant growth after its preflight', async () => {
    process.env[FLAG] = 'true'
    process.env[CAPTURE_FLAG] = 'true'
    process.env[INBOUND_FLAG] = 'true'
    const recordId = await deleteRestoreFixture({ label: 'in_growth', inbound: true })
    const blocker = await connect()
    const firstFenceSheet = [SOURCE, TARGET].sort()[0]
    try {
      await blocker.query('BEGIN')
      const blockerPid = Number(((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid)
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(firstFenceSheet)])

      const responsePromise = request(buildApp())
        .post(`/api/multitable/records/${recordId}/restore`)
        .then((response) => response)
      await waitForAdvisoryWaiter(blockerPid)
      await q('UPDATE meta_fields SET sheet_id = $2 WHERE id = $1', [F_BACK, DECOY])
      await blocker.query('COMMIT')

      const response = await responsePromise
      expect(response.status).toBe(409)
      expect(response.body).toEqual({
        ok: false,
        error: {
          code: 'CONFLICT',
          message: 'Cannot restore: linked records changed concurrently; retry',
        },
      })
      expect(JSON.stringify(response.body)).not.toContain(DECOY)
      expect((await q('SELECT 1 FROM meta_records WHERE id = $1', [recordId])).rows).toHaveLength(0)
      expect(await trashCount(recordId)).toBe(1)
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
    }
  })

  test('trash restore fails closed without waiting on an in-flight inbound field move', async () => {
    process.env[FLAG] = 'true'
    process.env[CAPTURE_FLAG] = 'true'
    process.env[INBOUND_FLAG] = 'true'
    const recordId = await deleteRestoreFixture({ label: 'in_field_move_lock', inbound: true })
    const mover = await connect()
    let responsePromise: Promise<request.Response> | undefined
    try {
      await mover.query('BEGIN')
      await mover.query('UPDATE meta_fields SET sheet_id = $2 WHERE id = $1', [F_BACK, DECOY])
      responsePromise = request(buildApp())
        .post(`/api/multitable/records/${recordId}/restore`)
        .then((response) => response)

      const response = await settleWhileMutationLockHeld(responsePromise, 'inbound participant recheck')
      expect(response.status).toBe(409)
      expect(response.body).toEqual({
        ok: false,
        error: {
          code: 'CONFLICT',
          message: 'Cannot restore: linked records changed concurrently; retry',
        },
      })
      expect((await q('SELECT 1 FROM meta_records WHERE id = $1', [recordId])).rows).toHaveLength(0)
      expect(await exactEdgeCount(F_BACK, R_TARGET, recordId)).toBe(0)
      expect(await trashCount(recordId)).toBe(1)
    } finally {
      await mover.query('ROLLBACK').catch(() => {})
      await responsePromise?.catch(() => {})
      mover.release()
    }
  })

  test('trash restore skips an inbound neighbor resurrected on an unfenced sheet after plan entry', async () => {
    process.env[FLAG] = 'true'
    process.env[CAPTURE_FLAG] = 'true'
    process.env[INBOUND_FLAG] = 'true'
    const recordId = await deleteRestoreFixture({ label: 'late_neighbor_sheet', inbound: true })
    await q('DELETE FROM meta_records WHERE id = $1 AND sheet_id = $2', [R_TARGET, TARGET])
    const rawPool = poolManager.get()
    let decoyInserted = false
    const racingPool = {
      query: rawPool.query.bind(rawPool),
      transaction: async <T>(handler: (client: { query: typeof q }) => Promise<T>): Promise<T> =>
        rawPool.transaction(async ({ query }) => handler({
          query: async (sql: string, params?: unknown[]) => {
            const result = await query(sql, params)
            if (
              !decoyInserted &&
              params?.[0] === recordId &&
              /INSERT INTO meta_records[\s\S]+RETURNING version/.test(sql)
            ) {
              await q(
                'INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)',
                [R_TARGET, DECOY, JSON.stringify({ [F_BACK]: [recordId] }), ACTOR],
              )
              decoyInserted = true
            }
            return result
          },
        })),
    }

    const restored = await makeRecordService(racingPool as never).restoreRecord({
      recordId,
      actorId: ACTOR,
      access,
      resolveSheetAccess,
    })

    expect(decoyInserted).toBe(true)
    expect(restored.inbound).toMatchObject({
      replayed: 0,
      recoverable: true,
      skipped: { alreadyPresent: 1 },
    })
    expect(await exactEdgeCount(F_BACK, R_TARGET, recordId)).toBe(0)
    expect(await trashCount(recordId)).toBe(0)
  })

  test('trash restore rejects a changed locked trash anchor instead of replaying an unfenced vintage', async () => {
    process.env[FLAG] = 'true'
    process.env[CAPTURE_FLAG] = 'true'
    process.env[INBOUND_FLAG] = 'true'
    const recordId = await deleteRestoreFixture({ label: 'anchor', inbound: true })
    const blocker = await connect()
    const firstFenceSheet = [SOURCE, TARGET].sort()[0]
    try {
      await blocker.query('BEGIN')
      const blockerPid = Number(((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid)
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(firstFenceSheet)])

      const responsePromise = request(buildApp())
        .post(`/api/multitable/records/${recordId}/restore`)
        .then((response) => response)
      await waitForAdvisoryWaiter(blockerPid)
      await q('UPDATE meta_records_trash SET delete_revision_id = $2 WHERE record_id = $1', [recordId, randomUUID()])
      await blocker.query('COMMIT')

      const response = await responsePromise
      expect(response.status).toBe(409)
      expect(response.body).toEqual({
        ok: false,
        error: {
          code: 'CONFLICT',
          message: 'Cannot restore: linked records changed concurrently; retry',
        },
      })
      expect((await q('SELECT 1 FROM meta_records WHERE id = $1', [recordId])).rows).toHaveLength(0)
      expect(await trashCount(recordId)).toBe(1)
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
    }
  })

  test('trash restore keeps the existing inbound neighbor-gone skip semantics under the writer fence', async () => {
    process.env[FLAG] = 'true'
    process.env[CAPTURE_FLAG] = 'true'
    process.env[INBOUND_FLAG] = 'true'
    const recordId = await deleteRestoreFixture({ label: 'neighbor_gone', inbound: true })
    await q('DELETE FROM meta_records WHERE id = $1 AND sheet_id = $2', [R_TARGET, TARGET])

    const restored = await makeRecordService().restoreRecord({
      recordId,
      actorId: ACTOR,
      access,
      resolveSheetAccess,
    })

    expect(restored.inbound).toMatchObject({
      replayed: 0,
      recoverable: true,
      skipped: { neighborGone: 1 },
    })
    expect(await exactEdgeCount(F_BACK, R_TARGET, recordId)).toBe(0)
    expect(await trashCount(recordId)).toBe(0)
  })

  test('REST, plugin, and automation hard deletes all refuse a blocked inbound owner sheet', async () => {
    process.env[FLAG] = 'true'
    await q('UPDATE meta_records SET data = $3::jsonb WHERE id = $1 AND sheet_id = $2', [R_SOURCE, SOURCE, JSON.stringify({ [F_NOTE]: 'before', [F_LINK]: [R_TARGET] })])
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_dh1_delete_${TS}`, F_LINK, R_SOURCE, R_TARGET])
    await setBlock(SOURCE, 'applying')

    await expect(makeRecordService().deleteRecord({
      recordId: R_TARGET,
      actorId: ACTOR,
      access,
      resolveSheetAccess,
    })).rejects.toBeInstanceOf(SheetWriterBlockedError)

    await expect(poolManager.get().transaction(async ({ query }) => deletePluginRecord({
      query: query as never,
      sheetId: TARGET,
      recordId: R_TARGET,
    }))).rejects.toBeInstanceOf(SheetWriterBlockedError)

    const execution = await makeAutomationExecutor().execute(deleteAutomationRule(), {
      sheetId: TARGET,
      recordId: R_TARGET,
      actorId: ACTOR,
      data: {},
    })
    expect(execution.steps[0]).toMatchObject({
      status: 'failed',
      error: 'Sheet is temporarily locked for writes by a recovery operation',
    })
    expect((await q('SELECT count(*)::int AS n FROM meta_records WHERE id = $1 AND sheet_id = $2', [R_TARGET, TARGET])).rows[0]).toEqual({ n: 1 })
    expect(await edgeCount(R_SOURCE)).toBe(1)
  })

  test('HTTP record delete maps a newly committed participant to values-free 409 before destruction', async () => {
    process.env[FLAG] = 'true'
    const blocker = await connect()
    try {
      await blocker.query('BEGIN')
      const blockerPid = Number(((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid)
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(TARGET)])

      const responsePromise = request(buildApp())
        .delete(`/api/multitable/records/${R_TARGET}`)
        .then((response) => response)
      await waitForAdvisoryWaiter(blockerPid)
      await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_dh1_drift_${TS}`, F_LINK, R_SOURCE, R_TARGET])
      await blocker.query('COMMIT')

      const response = await responsePromise
      expect(response.status).toBe(409)
      expect(response.body).toEqual({
        ok: false,
        error: {
          code: 'LINK_WRITER_FENCE_PLAN_CHANGED',
          message: 'Link relation participants changed concurrently; retry the write',
        },
      })
      expect(JSON.stringify(response.body)).not.toContain(R_TARGET)
      expect(JSON.stringify(response.body)).not.toContain(SOURCE)
      expect((await q('SELECT count(*)::int AS n FROM meta_records WHERE id = $1 AND sheet_id = $2', [R_TARGET, TARGET])).rows[0]).toEqual({ n: 1 })
      expect(await edgeCount(R_SOURCE)).toBe(1)
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
    }
  })

  test('partial-success bulk patch preserves the whole-request 409 contract for a blocked target', async () => {
    process.env[FLAG] = 'true'
    await setBlock(TARGET, 'applying')
    const response = await request(buildApp())
      .post('/api/multitable/patch')
      .send({
        sheetId: SOURCE,
        partialSuccess: true,
        changes: [{ recordId: R_SOURCE, fieldId: F_LINK, value: [R_TARGET] }],
      })
    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'RECOVERY_IN_PROGRESS',
        message: 'Another recovery operation is in progress on this sheet; retry shortly.',
      },
    })
    expect(await readSource()).toMatchObject({ version: 1, data: { [F_LINK]: [] } })
    expect(await edgeCount(R_SOURCE)).toBe(0)
  })

  test('single-record patch rechecks target existence after a concurrent target delete releases its fence', async () => {
    process.env[FLAG] = 'true'
    const blocker = await connect()
    try {
      await blocker.query('BEGIN')
      const blockerPid = Number(((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid)
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(TARGET)])
      await blocker.query('DELETE FROM meta_records WHERE id = $1 AND sheet_id = $2', [R_TARGET, TARGET])

      const patchPromise = makeRecordService().patchRecord({
        recordId: R_SOURCE,
        sheetId: SOURCE,
        data: { [F_LINK]: [R_TARGET] },
        actorId: ACTOR,
        access,
        capabilities,
      })
      await waitForAdvisoryWaiter(blockerPid)
      await blocker.query('COMMIT')

      await expect(patchPromise).rejects.toBeInstanceOf(RecordPatchFieldValidationError)
      expect(await readSource()).toMatchObject({ version: 1, data: { [F_LINK]: [] } })
      expect(await edgeCount(R_SOURCE)).toBe(0)
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
    }
  })

  test('plugin patch rechecks target existence after a concurrent target delete releases its fence', async () => {
    process.env[FLAG] = 'true'
    const blocker = await connect()
    try {
      await blocker.query('BEGIN')
      const blockerPid = Number(((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid)
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(TARGET)])
      await blocker.query('DELETE FROM meta_records WHERE id = $1 AND sheet_id = $2', [R_TARGET, TARGET])

      const patchPromise = poolManager.get().transaction(async ({ query }) => patchPluginRecord({
        query: query as never,
        sheetId: SOURCE,
        recordId: R_SOURCE,
        changes: { [F_LINK]: [R_TARGET] },
      }))
      await waitForAdvisoryWaiter(blockerPid)
      await blocker.query('COMMIT')

      const error = await patchPromise.catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(LinkWriterFencePlanChangedError)
      expect((error as Error).message).toBe('Linked records changed concurrently; retry the write')
      expect(JSON.stringify({ message: (error as Error).message })).not.toContain(R_TARGET)
      expect(await readSource()).toMatchObject({ version: 1, data: { [F_LINK]: [] } })
      expect(await edgeCount(R_SOURCE)).toBe(0)
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
    }
  })

  test('public form rechecks target existence after a concurrent delete and returns values-free 409', async () => {
    process.env[FLAG] = 'true'
    const blocker = await connect()
    try {
      await blocker.query('BEGIN')
      const blockerPid = Number(((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid)
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(TARGET)])
      await blocker.query('DELETE FROM meta_records WHERE id = $1 AND sheet_id = $2', [R_TARGET, TARGET])

      const responsePromise = request(buildApp())
        .post(`/api/multitable/views/${VIEW}/submit`)
        .send({ data: { [F_LINK]: [R_TARGET] } })
        .then((response) => response)
      await waitForAdvisoryWaiter(blockerPid)
      await blocker.query('COMMIT')

      const response = await responsePromise
      expect(response.status).toBe(409)
      expect(response.body).toEqual({
        ok: false,
        error: {
          code: 'LINK_WRITER_FENCE_PLAN_CHANGED',
          message: 'Linked records changed concurrently; retry the write',
        },
      })
      expect(JSON.stringify(response.body)).not.toContain(R_TARGET)
      expect(Number(((await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id = $1', [SOURCE])).rows[0] as { n: number }).n)).toBe(1)
      expect(await edgeCount(R_SOURCE)).toBe(0)
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
    }
  })

  test('in-transaction field-definition drift is values-free and aborts before mint or write', async () => {
    process.env[FLAG] = 'true'
    const rawPool = poolManager.get()
    let drifted = false
    const driftingPool = {
      query: rawPool.query.bind(rawPool),
      transaction: async <T>(handler: (client: { query: typeof q }) => Promise<T>): Promise<T> => {
        if (!drifted) {
          drifted = true
          await rawPool.query('UPDATE meta_fields SET property = $2::jsonb WHERE id = $1', [F_LINK, JSON.stringify({ foreignSheetId: DECOY })])
        }
        return rawPool.transaction(handler)
      },
    }
    const error = await makeRecordService(driftingPool as never).patchRecord({
      recordId: R_SOURCE,
      sheetId: SOURCE,
      data: { [F_LINK]: [R_TARGET] },
      actorId: ACTOR,
      access,
      capabilities,
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LinkWriterFencePlanChangedError)
    expect(String((error as Error).message)).not.toContain(F_LINK)
    expect(String((error as Error).message)).not.toContain(TARGET)
    expect(String((error as Error).message)).not.toContain(DECOY)
    expect(await readSource()).toMatchObject({ version: 1, data: { [F_LINK]: [] } })
    expect(await edgeCount(R_SOURCE)).toBe(0)
  })

  test('HTTP patch maps an in-flight target-plan drift to a values-free 409 with zero write', async () => {
    process.env[FLAG] = 'true'
    const blocker = await connect()
    const firstFenceSheet = [SOURCE, TARGET].sort()[0]
    try {
      await blocker.query('BEGIN')
      const blockerPid = Number(((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid)
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(firstFenceSheet)])
      const responsePromise = request(buildApp())
        .patch(`/api/multitable/records/${R_SOURCE}`)
        .send({ sheetId: SOURCE, data: { [F_LINK]: [R_TARGET] } })
        .then((response) => response)
      await waitForAdvisoryWaiter(blockerPid)
      await q('UPDATE meta_fields SET property = $2::jsonb WHERE id = $1', [F_LINK, JSON.stringify({ foreignSheetId: DECOY })])
      await blocker.query('COMMIT')
      const response = await responsePromise
      expect(response.status).toBe(409)
      expect(response.body).toEqual({
        ok: false,
        error: {
          code: 'LINK_WRITER_FENCE_PLAN_CHANGED',
          message: 'Link field configuration changed concurrently; retry the write',
        },
      })
      expect(await readSource()).toMatchObject({ version: 1, data: { [F_LINK]: [] } })
      expect(await edgeCount(R_SOURCE)).toBe(0)
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
    }
  })

  test('bulk patch refuses a stale caller field guard that would write to an unfenced target', async () => {
    process.env[FLAG] = 'true'
    const input = writeInput([R_DECOY])
    input.fields = input.fields.map((field) => ({
      ...field,
      property: { foreignSheetId: DECOY },
    }))
    input.fieldById = new Map([[
      F_LINK,
      {
        type: 'link',
        readOnly: false,
        hidden: false,
        link: { foreignSheetId: DECOY, limitSingleRecord: false },
      },
    ]])
    await expect(makeWriteService().patchRecords(input)).rejects.toBeInstanceOf(LinkWriterFencePlanChangedError)
    expect(await readSource()).toMatchObject({ version: 1, data: { [F_LINK]: [] } })
    expect(await edgeCount(R_SOURCE)).toBe(0)
  })

  test('single-record patch refuses a stale field snapshot that would write to an unfenced target', async () => {
    process.env[FLAG] = 'true'
    const rawPool = poolManager.get()
    const staleFieldPool = {
      query: async (sql: string, params?: unknown[]) => {
        const result = await rawPool.query(sql, params)
        if (/FROM meta_fields WHERE sheet_id = \$1 ORDER BY "order"/i.test(sql)) {
          return {
            ...result,
            rows: result.rows.map((raw) => {
              const row = raw as Record<string, unknown>
              return row.id === F_LINK
                ? { ...row, property: { foreignSheetId: DECOY } }
                : row
            }),
          }
        }
        return result
      },
      transaction: rawPool.transaction.bind(rawPool),
    }
    await expect(makeRecordService(staleFieldPool as never).patchRecord({
      recordId: R_SOURCE,
      sheetId: SOURCE,
      data: { [F_LINK]: [R_DECOY] },
      actorId: ACTOR,
      access,
      capabilities,
    })).rejects.toBeInstanceOf(LinkWriterFencePlanChangedError)
    expect(await readSource()).toMatchObject({ version: 1, data: { [F_LINK]: [] } })
    expect(await edgeCount(R_SOURCE)).toBe(0)
  })

  test('mirrored source/target plans acquire the same order and complete without 40P01', async () => {
    process.env[FLAG] = 'true'
    const forward = await prepareLinkWriterFencePlan(q as never, SOURCE, [F_LINK])
    const reverse = await prepareLinkWriterFencePlan(q as never, TARGET, [F_BACK])
    expect(forward).not.toBeNull()
    expect(reverse).not.toBeNull()

    const observedOrders: string[][] = []
    for (const plan of [forward!, reverse!]) {
      const order: string[] = []
      await poolManager.get().transaction(async ({ query }) => {
        await enterLinkWriterFencePlan((async (sql: string, params?: unknown[]) => {
          if (/pg_advisory_xact_lock/.test(sql)) order.push(String(params?.[0] ?? ''))
          return query(sql, params)
        }) as never, plan)
      })
      observedOrders.push(order)
    }
    const expectedOrder = [SOURCE, TARGET].sort().map(canonicalSheetFenceKey)
    expect(observedOrders).toEqual([expectedOrder, expectedOrder])

    const first = await connect()
    const second = await connect()
    const firstPid = Number(((await first.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid)
    const secondPid = Number(((await second.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid)
    try {
      await first.query('BEGIN')
      await enterLinkWriterFencePlan(first.query.bind(first) as never, forward!)
      await second.query('BEGIN')
      const secondEntry = enterLinkWriterFencePlan(second.query.bind(second) as never, reverse!)

      const deadline = Date.now() + 3_000
      let blocked = false
      while (Date.now() < deadline) {
        const row = (await q(
          `SELECT wait_event_type, pg_blocking_pids(pid) AS blockers
             FROM pg_stat_activity WHERE pid = $1`,
          [secondPid],
        )).rows[0] as { wait_event_type?: unknown; blockers?: unknown } | undefined
        const blockers = Array.isArray(row?.blockers) ? row?.blockers.map(Number) : []
        if (row?.wait_event_type === 'Lock' && blockers.includes(firstPid)) {
          blocked = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(blocked).toBe(true)
      await first.query('COMMIT')
      await expect(secondEntry).resolves.toBeUndefined()
      await second.query('COMMIT')
    } finally {
      await first.query('ROLLBACK').catch(() => {})
      await second.query('ROLLBACK').catch(() => {})
      first.release()
      second.release()
    }
  })
})
