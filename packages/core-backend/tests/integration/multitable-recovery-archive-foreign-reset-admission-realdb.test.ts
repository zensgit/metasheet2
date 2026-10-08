import { executeRecoveryArchiveAsyncRestoreChunk } from '../../src/multitable/recovery-archive-async-restore'
import { createRecoveryArchiveRestoreWorker } from '../../src/multitable/recovery-archive-restore-worker'
import { pauseRecoveryArchiveRestoreJob, resumeRecoveryArchiveRestoreJob, selectRecoveryArchiveRestoreJobCandidate, claimRecoveryArchiveRestoreJob } from '../../src/multitable/recovery-archive-restore-jobs'
import { acquireRecoveryAuthorityLease } from '../../src/multitable/recovery-authorization-stability'
import { randomUUID } from 'node:crypto'
import express, { type Express } from 'express'
import { Pool } from 'pg'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { bindRecoveryArchiveOwnedClaim, readRecoveryArchiveCommittedClaim } from '../../src/multitable/recovery-archive-owned-claim'
import { canonicalSheetFenceKey, __resetRecoveryWriterStateColumnProbe } from '../../src/multitable/canonical-sheet-fence'
import { createForeignResetFixture, type ForeignResetFixture } from '../utils/recovery-archive-foreign-reset-admission-fixture'

const armed = process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const describeRealDb = armed && process.env.DATABASE_URL ? describe : describe.skip
test('sentinel: foreign reset admission real-DB lane requires DATABASE_URL', () => {
  if (armed && !process.env.DATABASE_URL) throw new Error('recovery_archive_foreign_reset_admission_realdb_harness_missing_database_url')
})
const blocked = { ok: false, error: { code: 'RECOVERY_IN_PROGRESS', message: 'Another recovery operation is in progress on this sheet; retry shortly.' } }
const flags = ['MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'MULTITABLE_ENABLE_WRITER_FENCE', 'MULTITABLE_HISTORY_CONTIGUITY_STRICT',
  'MULTITABLE_ENABLE_PIT_RESET', 'MULTITABLE_TOMBSTONE_CAPTURE_ENABLED', 'JWT_SECRET']
let savedFlags: Array<string | undefined>
let admin: Pool
let fixture: ForeignResetFixture
let app: Express
let route: typeof import('../../src/routes/univer-meta')
let sqlCalls: Array<{ sql: string; params?: unknown[] }>
let gates = new Set<() => void>()
function barrier() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve }); gates.add(release); return { promise, release } }
async function waitBarrier(gate: ReturnType<typeof barrier>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { expect(await Promise.race([gate.promise.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 2000) })])).toBe(true) }
  finally { if (timer) clearTimeout(timer) }
}
async function createApp(runtime?: Awaited<ReturnType<ForeignResetFixture['seedArchive']>>['runtime']) {
  vi.resetModules()
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const adapter = { getInternalPool: () => fixture.pool, query: fixture.query,
    transaction: <T>(work: (client: { query: ForeignResetFixture['query'] }) => Promise<T>) => fixture.transaction((query) => work({ query })) }
  vi.spyOn(poolManager, 'get').mockReturnValue(adapter as unknown as ReturnType<typeof poolManager.get>)
  route = await import('../../src/routes/univer-meta')
  app = express(); app.use(express.json())
  app.use((req, _res, next) => { req.user = { id: fixture.identity.actorId, roles: ['admin'], perms: ['multitable:read', 'multitable:write', 'multitable:share', 'multitable:manage-schema'] }; next() })
  app.use('/api/multitable', route.univerMetaRouter(runtime ? { recoveryArchiveRuntime: runtime, recoveryArchiveDatabaseRuntime: { query: fixture.query, transaction: fixture.transaction, transactionDepthProbe: runtime.transactionDepth }, recoveryArchiveAuditedReplayHorizonMs: 300000, recoveryArchiveAsyncResumeHorizonMs: 300000 } : undefined))
}
async function hotToken() {
  const response = await request(app).post(`/api/multitable/sheets/${fixture.sheetId}/reset-preview`).send({ anchorOperationId: fixture.anchorOperationId })
  expect(response.status, response.body.error?.code).toBe(200)
  expect(response.body.ok).toBe(true)
  expect(typeof response.body.data.previewIdentity).toBe('string')
  return response.body.data.previewIdentity as string
}
function hotExecute(token: string) { return request(app).post(`/api/multitable/sheets/${fixture.sheetId}/reset-execute`).send({ previewIdentity: token, confirm: 'reset' }) }
async function claim(pool: Pick<Pool, 'connect' | 'options'> = fixture.pool, leaseSeconds = 60, identity = fixture.identity) {
  const run = bindRecoveryArchiveOwnedClaim(pool, async (query, identity) => (await query('SELECT 1 FROM meta_bases WHERE id=$1 AND owner_id=$2', [identity.baseId, identity.actorId])).rows.length === 1,
    { keyId: fixture.keyId, keyRowVersion: '1', leaseSeconds, expiresAfterSeconds: 3600 }, { maxBytes: 1048576, timeoutMs: 10000 })
  const token = (await run(identity)).claim!
  expect(readRecoveryArchiveCommittedClaim(token).sourcePinIds).toEqual(fixture.pins)
  expect(fixture.pins).toHaveLength(1)
  return token
}
const tables = ['meta_sheets', 'meta_links', 'meta_link_tombstones', 'meta_field_value_tombstones', 'meta_records', 'meta_records_trash',
  'meta_recovery_token_burns', 'meta_record_revisions', 'meta_record_history_operations', 'meta_sheet_section_revisions',
  'meta_recovery_archives', 'meta_recovery_archive_snapshot_reservations', 'meta_recovery_archive_attachment_refs',
  'multitable_attachments', 'meta_recovery_archive_jobs', 'meta_recovery_archive_job_chunks', 'meta_recovery_archive_restore_plans',
  'meta_recovery_archive_sync_receipts', 'meta_recovery_archive_derived_effects']
async function snapshot() {
  const result: Record<string, string[]> = {}
  for (const table of tables) result[table] = (await fixture.query(`SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY to_jsonb(t)::text COLLATE "C"`)).rows.map((row) => row.row)
  return result
}
function noPrivate(response: { body: unknown }) {
  const body = JSON.stringify(response.body)
  for (const value of [fixture.identity.sheetId, fixture.sheetId, fixture.deleteId, fixture.identity.actorId, fixture.linkId]) expect(body).not.toContain(value)
}
async function waitBlocking(pid: number) {
  const until = performance.now() + 2000
  while (performance.now() < until) {
    const rows = await fixture.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) AND wait_event_type=\'Lock\'', [pid])
    if (rows.rows[0].count === 1) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  expect('actual fence waiter').toBe('observed')
}


function gatedClaimPool(entered: ReturnType<typeof barrier>, resume: ReturnType<typeof barrier>) {
  let pid = 0
  const pool = { options: fixture.pool.options, connect: async () => {
    const client = await fixture.pool.connect()
    pid = Reflect.get(client, 'processID') as number
    return { query: async (sql: string, params?: unknown[]) => {
      const result = await client.query(sql, params)
      if (sql.includes('pg_advisory_xact_lock') && params?.[0] === canonicalSheetFenceKey(fixture.identity.sheetId)) {
        entered.release(); await resume.promise
      }
      return result
    }, release: (discard?: boolean) => client.release(discard) }
  } } as unknown as Pick<Pool, 'connect' | 'options'>
  return { pool, get pid() { return pid } }
}
const mutationSql = (sql: string) => /\b(INSERT|UPDATE|DELETE)\s/i.test(sql)
async function archiveToken(generationId: string) {
  const response = await request(app).post(`/api/multitable/sheets/${fixture.sheetId}/recovery-archive/preview`)
    .send({ generationId, mode: 'reset', scope: { kind: 'whole_sheet' } })
  expect(response.status, response.body.error?.code).toBe(200)
  expect(response.body.ok).toBe(true)
  return response.body.data.previewIdentity as string
}
function archiveExecute(token: string) { return request(app).post(`/api/multitable/sheets/${fixture.sheetId}/recovery-archive/execute`).send({ previewIdentity: token, scope: { kind: 'whole_sheet' } }) }

describeRealDb('G2 actual foreign reset admission (real DB)', () => {
  beforeAll(() => {
    savedFlags = flags.map((flag) => process.env[flag])
    admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 500 })
  })
  beforeEach(async () => {
    for (const flag of flags) process.env[flag] = flag === 'JWT_SECRET' ? 'synthetic_g2_secret_not_a_credential_123456789' : 'true'
    __resetRecoveryWriterStateColumnProbe(); gates = new Set(); sqlCalls = []
    fixture = await createForeignResetFixture(admin)
    fixture.control.hook = async (sql, params, _client, execute) => { sqlCalls.push({ sql, params }); return execute() }
    await createApp()
  })
  afterEach(async () => { for (const release of gates) release(); vi.restoreAllMocks(); vi.resetModules(); await fixture?.dispose() })
  afterAll(async () => {
    flags.forEach((flag, index) => { if (savedFlags[index] === undefined) delete process.env[flag]; else process.env[flag] = savedFlags[index] })
    __resetRecoveryWriterStateColumnProbe(); await admin?.end()
  })

  test('unblocked actual reset preview and execute remove the foreign-owned edge and commit legitimate burn and seal', async () => {
    expect(await fixture.transaction((query) => acquireRecoveryAuthorityLease(query, [fixture.identity.actorId]))).toBe('ready')
    const token = await hotToken()
    const response = await hotExecute(token)
    if (response.status !== 200) console.log({ failureCode: response.body.error?.code, lastActualSql: sqlCalls.slice(-4).map((call) => call.sql) })
    expect(response.status, response.body.error?.code).toBe(200)
    expect(response.body.ok).toBe(true)
    expect(response.body.data.deletedCount).toBe(1)
    expect((await fixture.query('SELECT id FROM meta_links WHERE id=$1', [fixture.linkId])).rows).toEqual([])
    expect((await fixture.query('SELECT record_id FROM meta_records_trash WHERE record_id=$1', [fixture.deleteId])).rows).toEqual([{ record_id: fixture.deleteId }])
    expect((await fixture.query('SELECT count(*)::int AS count FROM meta_recovery_token_burns')).rows).toEqual([{ count: 1 }])
    expect((await fixture.query(`SELECT count(*)::int AS count FROM meta_record_history_operations WHERE sheet_id=$1 AND operation_kind='ordinary'`, [fixture.sheetId])).rows).toEqual([{ count: 3 }])
    expect((await fixture.query('SELECT foreign_record_id FROM meta_link_tombstones WHERE foreign_record_id=$1', [fixture.deleteId])).rows).toEqual([{ foreign_record_id: fixture.deleteId }])
  })

  test.each([true, false])('genuine nonempty foreign claim refuses actual hot HTTP reset with complete state unchanged, foreign-first=%s', async (foreignFirst) => {
    if (!foreignFirst) { await fixture.dispose(); fixture = await createForeignResetFixture(admin, false); await createApp() }
    const token = await hotToken()
    await claim()
    const before = await snapshot()
    const response = await hotExecute(token)
    expect(response.status).toBe(409)
    expect(response.body).toEqual(blocked)
    noPrivate(response)
    expect(await snapshot()).toEqual(before)
  })

  test.each([true, false])('genuine claim wins actual fence wait and inherited RR reset sees committed foreign block, foreign-first=%s', async (foreignFirst) => {
    if (!foreignFirst) { await fixture.dispose(); fixture = await createForeignResetFixture(admin, false); await createApp() }
    const token = await hotToken()
    fixture.control.defaultRR = true
    const entered = barrier(), resume = barrier()
    const native = gatedClaimPool(entered, resume)
    const claimPending = claim(native.pool)
    let resetPending: Promise<request.Response> | undefined
    try {
      await waitBarrier(entered)
      resetPending = hotExecute(token).then((response) => response)
      await waitBlocking(native.pid)
      resume.release()
      await claimPending
      const response = await resetPending
      expect(response.status).toBe(409)
      expect(response.body).toEqual(blocked)
      expect(fixture.control.inherited).toContain('repeatable read')
      expect((await fixture.query('SELECT id FROM meta_links WHERE id=$1', [fixture.linkId])).rows).toEqual([{ id: fixture.linkId }])
      expect((await fixture.query('SELECT count(*)::int AS count FROM meta_recovery_token_burns')).rows).toEqual([{ count: 0 }])
    } finally { resume.release(); await Promise.allSettled([claimPending, ...(resetPending ? [resetPending] : [])]) }
  })

  test.each([true, false])('reset wins complete sorted fences before genuine foreign claim and claim follows committed link removal, foreign-first=%s', async (foreignFirst) => {
    if (!foreignFirst) { await fixture.dispose(); fixture = await createForeignResetFixture(admin, false); await createApp() }
    const token = await hotToken()
    const entered = barrier(), resume = barrier()
    let ownerPid = 0
    const acquired: string[] = []
    fixture.control.hook = async (sql, params, client, execute) => {
      sqlCalls.push({ sql, params }); const result = await execute()
      if (sql.includes('pg_advisory_xact_lock')) {
        acquired.push(params![0] as string)
        if (params?.[0] === canonicalSheetFenceKey(fixture.identity.sheetId)) {
          ownerPid = Reflect.get(client, 'processID') as number; entered.release(); await resume.promise
        }
      }
      return result
    }
    const resetPending = hotExecute(token).then((response) => response)
    let claimPending: ReturnType<typeof claim> | undefined
    try {
      await waitBarrier(entered); claimPending = claim()
      await waitBlocking(ownerPid)
      resume.release()
      const response = await resetPending
      expect(response.status).toBe(200)
      await claimPending
      expect(acquired).toEqual([fixture.identity.sheetId, fixture.sheetId].sort().map(canonicalSheetFenceKey))
      expect((await fixture.query('SELECT id FROM meta_links WHERE id=$1', [fixture.linkId])).rows).toEqual([])
      expect((await fixture.query('SELECT attachment_id FROM meta_recovery_archive_attachment_refs WHERE attachment_id=$1', [fixture.pins[0]])).rows).toEqual([{ attachment_id: fixture.pins[0] }])
    } finally { resume.release(); await Promise.allSettled([resetPending, ...(claimPending ? [claimPending] : [])]) }
  })

  test('self link deduplicates canonical fences and actual hot reset removes both inbound edges', async () => {
    const fieldId = `${fixture.sheetId}_self`
    await fixture.query("INSERT INTO meta_fields(id,sheet_id,name,type,property) VALUES($1,$2,'Self','link',$3::jsonb)", [fieldId, fixture.sheetId, JSON.stringify({ foreignSheetId: fixture.sheetId })])
    await fixture.query('INSERT INTO meta_links(id,field_id,record_id,foreign_record_id) VALUES($1,$2,$3,$4)', [`${fieldId}_edge`, fieldId, fixture.keepId, fixture.deleteId])
    const token = await hotToken(); sqlCalls.length = 0
    const response = await hotExecute(token)
    expect(response.status).toBe(200)
    expect(sqlCalls.filter((call) => call.sql.includes('pg_advisory_xact_lock')).map((call) => call.params![0])).toEqual([fixture.identity.sheetId, fixture.sheetId].sort().map(canonicalSheetFenceKey))
    expect((await fixture.query('SELECT id FROM meta_links')).rows).toEqual([])
  })

  test('actual new C link and genuine C claim between discovery and fence refuses before burn or mint without late C fence', async () => {
    const token = await hotToken()
    const entered = barrier(), resume = barrier()
    let first = true
    fixture.control.hook = async (sql, params, _client, execute) => {
      sqlCalls.push({ sql, params })
      if (first && sql.includes('pg_advisory_xact_lock')) { first = false; entered.release(); await resume.promise }
      return execute()
    }
    sqlCalls.length = 0
    const pending = hotExecute(token).then((response) => response)
    try {
      await waitBarrier(entered)
      const c = `${fixture.identity.sheetId}_new_c`, field = `${c}_link`, record = `${c}_record`
      await fixture.transaction(async (q) => {
        await q('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(c)])
        await q("INSERT INTO meta_sheets(id,base_id,name) VALUES($1,$2,'Synthetic C')", [c, fixture.identity.baseId])
        await q("INSERT INTO meta_history_trust_checkpoints(id,sheet_id,state,trusted_since_seq) VALUES($1,$2,'active',1)", [`${c}_checkpoint`, c])
        await q("INSERT INTO meta_records(id,sheet_id,data,created_by) VALUES($1,$2,'{}',$3)", [record, c, fixture.identity.actorId])
        await q("INSERT INTO meta_fields(id,sheet_id,name,type,property) VALUES($1,$2,'Incoming C','link',$3::jsonb)", [field, c, JSON.stringify({ foreignSheetId: fixture.sheetId })])
        await q('INSERT INTO meta_links(id,field_id,record_id,foreign_record_id) VALUES($1,$2,$3,$4)', [`${c}_edge`, field, record, fixture.deleteId])
      })
      const run = bindRecoveryArchiveOwnedClaim(fixture.pool, async (q, id) => (await q('SELECT 1 FROM meta_bases WHERE id=$1 AND owner_id=$2', [id.baseId, id.actorId])).rows.length === 1,
        { keyId: fixture.keyId, keyRowVersion: '1', leaseSeconds: 60, expiresAfterSeconds: 3600 }, { maxBytes: 1048576, timeoutMs: 10000 })
      expect((await run({ ...fixture.identity, sheetId: c, requestId: randomUUID() })).claim).not.toBeNull()
      const before = await snapshot(); sqlCalls.length = 0
      resume.release()
      const response = await pending
      expect(response.status).toBe(409)
      expect(response.body).toEqual({ ok: false, error: { code: 'PREVIEW_IDENTITY_INVALID', message: 'The sheet changed since preview; nothing written — re-preview.' } })
      expect(await snapshot()).toEqual(before)
      expect(sqlCalls.filter((call) => mutationSql(call.sql))).toEqual([])
      expect(sqlCalls.filter((call) => call.sql.includes('pg_advisory_xact_lock')).map((call) => call.params![0])).not.toContain(canonicalSheetFenceKey(c))
    } finally { resume.release(); await Promise.allSettled([pending]) }
  })

  test('actual autocommit adapter cannot establish owned TX and refuses before fence or write', async () => {
    const token = await hotToken()
    const { poolManager } = await import('../../src/integration/db/connection-pool')
    vi.mocked(poolManager.get).mockReturnValue({ getInternalPool: () => fixture.pool, query: fixture.query,
      transaction: async (work: (client: { query: ForeignResetFixture['query'] }) => Promise<unknown>) => work({ query: async (sql, params) => { sqlCalls.push({ sql, params }); return fixture.query(sql, params) } }) } as unknown as ReturnType<typeof poolManager.get>)
    sqlCalls.length = 0; const before = await snapshot()
    const response = await hotExecute(token)
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('RECOVERY_TRUST_REQUIRED')
    expect(sqlCalls.filter((call) => call.sql.includes('pg_advisory_xact_lock') || mutationSql(call.sql))).toEqual([])
    expect(await snapshot()).toEqual(before)
  })

  test('actual archive sync HTTP reset positive removes foreign edge and commits a sealed receipt', async () => {
    const seeded = await fixture.seedArchive(); await createApp(seeded.runtime)
    const token = await archiveToken(seeded.archive.generationId)
    const response = await archiveExecute(token)
    expect(response.status, response.body.error?.code).toBe(200)
    expect((await fixture.query('SELECT id FROM meta_links WHERE id=$1', [fixture.linkId])).rows).toEqual([])
    expect((await fixture.query('SELECT count(*)::int AS count FROM meta_recovery_archive_sync_receipts')).rows).toEqual([{ count: 1 }])
  })

  test('genuine nonempty foreign claim refuses actual archive sync HTTP reset with complete final-kernel state unchanged', async () => {
    const seeded = await fixture.seedArchive(); await createApp(seeded.runtime)
    const token = await archiveToken(seeded.archive.generationId); await claim()
    const before = await snapshot()
    const response = await archiveExecute(token)
    expect(response.status).toBe(409); expect(response.body).toEqual(blocked)
    noPrivate(response); expect(await snapshot()).toEqual(before)
  })


  test('actual accepted 5001-row async facade preserves matching source restore_job owner and commits first one-row chunk', async () => {
    const authorization = route.createRecoveryArchiveWorkerAuthorization()
    const seeded = await fixture.seedAsyncJob((q, identity) => authorization.recheckAuthority(q, { ...identity, jobId: 'synthetic_pending_accept' }))
    expect(seeded.actualRows).toBe(5001); expect(seeded.actualOperations).toBe(5001); expect(seeded.chunks).toEqual([1, 5000])
    const callbacks = route.createRecoveryArchiveWorkerCallbacks({ query: fixture.query, transaction: fixture.transaction })
    const before = (await fixture.query('SELECT recovery_writer_state,recovery_writer_owner_id,recovery_writer_owner_fence::text FROM meta_sheets WHERE id=$1', [fixture.sheetId])).rows
    expect(before[0].recovery_writer_state).toBe('archiving')
    sqlCalls.length = 0
    let facadeTransactions = 0
    const chunkTransaction: ForeignResetFixture['transaction'] = (work) => {
      facadeTransactions += 1
      if (facadeTransactions === 2) { fixture.control.defaultRR = true; fixture.control.rrOnce = true }
      return fixture.transaction(work)
    }
    await expect(executeRecoveryArchiveAsyncRestoreChunk({ query: fixture.query, transaction: chunkTransaction,
      runtime: seeded.runtime, claim: seeded.worker, ...callbacks })).resolves.toMatchObject({ kind: 'committed' })
    expect(fixture.control.inherited).toEqual(['repeatable read'])
    expect(facadeTransactions).toBe(2)
    const setupIndex = sqlCalls.findIndex((call) => call.sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    expect(sqlCalls[setupIndex + 1].sql).toBe('SHOW transaction_isolation')
    expect(sqlCalls.filter((call) => call.sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED')).toHaveLength(1)
    expect((await fixture.query('SELECT count(*)::int AS count FROM meta_records WHERE sheet_id=$1', [fixture.sheetId])).rows).toEqual([{ count: 5000 }])
    expect((await fixture.query('SELECT id FROM meta_links WHERE id=$1', [fixture.linkId])).rows).toEqual([])
    expect((await fixture.query('SELECT recovery_writer_state,recovery_writer_owner_id,recovery_writer_owner_fence::text FROM meta_sheets WHERE id=$1', [fixture.sheetId])).rows).toEqual(before)
    expect((await fixture.query("SELECT count(*)::int AS count FROM meta_record_history_operations WHERE sheet_id=$1 AND operation_kind='restore_chunk'", [fixture.sheetId])).rows).toEqual([{ count: 1 }])
  })

  test('actual async facade rejects genuine foreign claim before job progress chunk receipt seal or link mutation', async () => {
    const authorization = route.createRecoveryArchiveWorkerAuthorization()
    const seeded = await fixture.seedAsyncJob((q, identity) => authorization.recheckAuthority(q, { ...identity, jobId: 'synthetic_pending_accept' }))
    await claim()
    const before = await snapshot(); sqlCalls.length = 0
    const callbacks = route.createRecoveryArchiveWorkerCallbacks({ query: fixture.query, transaction: fixture.transaction })
    let error: unknown
    try { await executeRecoveryArchiveAsyncRestoreChunk({ query: fixture.query, transaction: fixture.transaction, runtime: seeded.runtime, claim: seeded.worker, ...callbacks }) }
    catch (caught) { error = caught }
    expect(error).toMatchObject({ code: 'SHEET_WRITER_BLOCKED' })
    expect(await snapshot()).toEqual(before)
    expect(sqlCalls.filter((call) => mutationSql(call.sql))).toEqual([])
  })

  test('production async worker actual foreign refusal pauses retryable with zero chunk progress and preserves source owner', async () => {
    const authorization = route.createRecoveryArchiveWorkerAuthorization()
    const seeded = await fixture.seedAsyncJob((q, identity) => authorization.recheckAuthority(q, { ...identity, jobId: 'synthetic_pending_accept' }))
    await pauseRecoveryArchiveRestoreJob(fixture.transaction, seeded.worker)
    const owner = { workspaceId: seeded.archive.workspaceId, baseId: seeded.archive.baseId, sheetId: fixture.sheetId, actorId: fixture.identity.actorId, jobId: seeded.accepted.id }
    await resumeRecoveryArchiveRestoreJob(fixture.transaction, { ...owner, recheckAuthority: (q) => authorization.recheckAuthority(q, owner) })
    await claim()
    const stableTables = tables.filter((table) => table !== 'meta_recovery_archive_jobs')
    const before = await snapshot()
    const callbacks = route.createRecoveryArchiveWorkerCallbacks({ query: fixture.query, transaction: fixture.transaction })
    const runner = createRecoveryArchiveRestoreWorker({ query: fixture.query, transaction: fixture.transaction, runtime: seeded.runtime,
      ...callbacks, leaseMs: 60000, replayHorizonMs: 300000, maxChunksPerRun: 1, workerOwnerId: 'synthetic_g2_retry_worker' })
    expect(await runner.runOnce()).toEqual({ kind: 'paused_retryable', swept: 0, chunks: 0 })
    const after = await snapshot()
    for (const table of stableTables) expect(after[table], table).toEqual(before[table])
    expect((await fixture.query('SELECT state,completed_count::text FROM meta_recovery_archive_jobs WHERE id=$1::uuid', [seeded.accepted.id])).rows).toEqual([{ state: 'paused_retryable', completed_count: '0' }])
    expect((await fixture.query('SELECT recovery_writer_state,recovery_writer_owner_id FROM meta_sheets WHERE id=$1', [fixture.sheetId])).rows).toEqual([{ recovery_writer_state: 'archiving', recovery_writer_owner_id: seeded.accepted.id }])
  })

  test('async cloned worker claim cannot borrow the source owner exception and changes no native state', async () => {
    const authorization = route.createRecoveryArchiveWorkerAuthorization()
    const seeded = await fixture.seedAsyncJob((q, identity) => authorization.recheckAuthority(q, { ...identity, jobId: 'synthetic_pending_accept' }))
    const before = await snapshot(); sqlCalls.length = 0
    const callbacks = route.createRecoveryArchiveWorkerCallbacks({ query: fixture.query, transaction: fixture.transaction })
    let error: unknown
    try { await executeRecoveryArchiveAsyncRestoreChunk({ query: fixture.query, transaction: fixture.transaction, runtime: seeded.runtime, claim: { ...seeded.worker }, ...callbacks }) }
    catch (caught) { error = caught }
    expect(error).toMatchObject({ code: 'RECOVERY_ARCHIVE_RESTORE_JOB_INVALID_INPUT' })
    expect(await snapshot()).toEqual(before)
    expect(sqlCalls.filter((call) => mutationSql(call.sql))).toEqual([])
  })


  test('expired but durable genuine foreign archiving block still refuses HTTP reset with zero state change', async () => {
    const token = await hotToken(); await claim(fixture.pool, 1)
    await fixture.query('SELECT pg_sleep(1.1)')
    expect((await fixture.query('SELECT recovery_writer_lease_until < clock_timestamp() AS expired FROM meta_sheets WHERE id=$1', [fixture.identity.sheetId])).rows).toEqual([{ expired: true }])
    const before = await snapshot(); const response = await hotExecute(token)
    expect(response.status).toBe(409); expect(response.body).toEqual(blocked); expect(await snapshot()).toEqual(before)
  })

  test('real declared missing foreign sheet refuses closed before burn or link writes', async () => {
    await fixture.query("INSERT INTO meta_fields(id,sheet_id,name,type,property) VALUES($1,$2,'Missing foreign','link',$3::jsonb)", [`${fixture.sheetId}_missing`, fixture.sheetId, JSON.stringify({ foreignSheetId: `${fixture.sheetId}_absent` })])
    const token = await hotToken(); const before = await snapshot(); sqlCalls.length = 0
    const response = await hotExecute(token)
    expect(response.status).toBe(409); expect(response.body.error.code).toBe('RECOVERY_TRUST_REQUIRED')
    expect(await snapshot()).toEqual(before); expect(sqlCalls.filter((call) => mutationSql(call.sql))).toEqual([])
  })

  test('actual native SHOW RR after SET interference refuses isolation before discovery fence or burn', async () => {
    const token = await hotToken(); const before = await snapshot(); sqlCalls.length = 0
    fixture.control.defaultRR = true
    fixture.control.hook = async (sql, params, client, execute) => {
      sqlCalls.push({ sql, params }); const result = await execute()
      if (sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED') await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      return result
    }
    const response = await hotExecute(token)
    expect(response.status).toBe(409); expect(response.body.error.code).toBe('RECOVERY_TRUST_REQUIRED')
    expect(fixture.control.inherited).toEqual(['repeatable read'])
    expect(sqlCalls.map((call) => call.sql)).toEqual(['SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'SHOW transaction_isolation'])
    expect(await snapshot()).toEqual(before)
  })

  test.each(['false', 'TRUE', undefined])('archive flag nonexact %s retains actual legacy foreign link behavior and zero selected setup reads', async (archiveFlag) => {
    const token = await hotToken(); await claim()
    if (archiveFlag === undefined) delete process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED
    else process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = archiveFlag
    sqlCalls.length = 0
    const response = await hotExecute(token)
    expect(response.status).toBe(200)
    expect(sqlCalls.filter((call) => call.sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED' || call.sql === 'SHOW transaction_isolation')).toEqual([])
    expect(sqlCalls.filter((call) => call.sql === 'SELECT recovery_writer_state FROM meta_sheets WHERE id = $1').map((call) => call.params)).toEqual([[fixture.sheetId]])
    expect((await fixture.query('SELECT id FROM meta_links WHERE id=$1', [fixture.linkId])).rows).toEqual([])
  })


  test('actual expired genuine async worker lease cannot reuse the source owner exception', async () => {
    const authorization = route.createRecoveryArchiveWorkerAuthorization()
    const seeded = await fixture.seedAsyncJob((q, identity) => authorization.recheckAuthority(q, { ...identity, jobId: 'synthetic_pending_accept' }), 1000)
    await fixture.query('SELECT pg_sleep(1.1)')
    const before = await snapshot(); sqlCalls.length = 0
    const callbacks = route.createRecoveryArchiveWorkerCallbacks({ query: fixture.query, transaction: fixture.transaction })
    let error: unknown
    try { await executeRecoveryArchiveAsyncRestoreChunk({ query: fixture.query, transaction: fixture.transaction, runtime: seeded.runtime, claim: seeded.worker, ...callbacks }) }
    catch (caught) { error = caught }
    expect(error).toMatchObject({ code: 'RECOVERY_ARCHIVE_RESTORE_JOB_LEASE_LOST' })
    expect(await snapshot()).toEqual(before)
    expect(sqlCalls.filter((call) => mutationSql(call.sql))).toEqual([])
  })

  test('actual legal async worker takeover makes old private claim stale without borrowing matching source job owner', async () => {
    const authorization = route.createRecoveryArchiveWorkerAuthorization()
    const seeded = await fixture.seedAsyncJob((q, identity) => authorization.recheckAuthority(q, { ...identity, jobId: 'synthetic_pending_accept' }))
    const owner = { workspaceId: seeded.archive.workspaceId, baseId: seeded.archive.baseId, sheetId: fixture.sheetId, actorId: fixture.identity.actorId, jobId: seeded.accepted.id }
    await pauseRecoveryArchiveRestoreJob(fixture.transaction, seeded.worker)
    await resumeRecoveryArchiveRestoreJob(fixture.transaction, { ...owner, recheckAuthority: (q) => authorization.recheckAuthority(q, owner) })
    const candidate = await selectRecoveryArchiveRestoreJobCandidate(fixture.transaction)
    expect(candidate).not.toBeNull()
    const replacement = await claimRecoveryArchiveRestoreJob(fixture.transaction, candidate!, { workerOwnerId: 'synthetic_replacement', leaseUntil: new Date(Date.now() + 60000).toISOString() })
    expect(BigInt(replacement.workerFence)).toBeGreaterThan(BigInt(seeded.worker.workerFence))
    const before = await snapshot(); sqlCalls.length = 0
    const callbacks = route.createRecoveryArchiveWorkerCallbacks({ query: fixture.query, transaction: fixture.transaction })
    let error: unknown
    try { await executeRecoveryArchiveAsyncRestoreChunk({ query: fixture.query, transaction: fixture.transaction, runtime: seeded.runtime, claim: seeded.worker, ...callbacks }) }
    catch (caught) { error = caught }
    expect(error).toMatchObject({ code: 'RECOVERY_ARCHIVE_RESTORE_JOB_LEASE_LOST' })
    expect(await snapshot()).toEqual(before)
    expect(sqlCalls.filter((call) => mutationSql(call.sql))).toEqual([])
  })

})
