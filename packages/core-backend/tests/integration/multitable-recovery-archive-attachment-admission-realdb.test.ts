import { createHash, randomUUID } from 'node:crypto'
import express, { type Express } from 'express'
import { Pool, type PoolClient, type QueryResult } from 'pg'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { bindRecoveryArchiveOwnedClaim, readRecoveryArchiveCommittedClaim } from '../../src/multitable/recovery-archive-owned-claim'
import { __resetRecoveryWriterStateColumnProbe } from '../../src/multitable/canonical-sheet-fence'
import { createAttachmentAdmissionFixture, type AttachmentAdmissionFixture } from '../utils/recovery-archive-attachment-admission-fixture'

const armed = process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const describeRealDb = armed && process.env.DATABASE_URL ? describe : describe.skip
test('sentinel: attachment admission real-DB lane requires DATABASE_URL', () => {
  if (armed && !process.env.DATABASE_URL) throw new Error('recovery_archive_attachment_admission_realdb_harness_missing_database_url')
})
const blocked = { ok: false, error: { code: 'RECOVERY_IN_PROGRESS', message: 'Another recovery operation is in progress on this sheet; retry shortly.' } }
const flags = ['MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'MULTITABLE_ENABLE_WRITER_FENCE']
let savedFlags: Array<string | undefined>
let admin: Pool
let fixture: AttachmentAdmissionFixture
let app: Express
let transactions = 0
let activeTransactions = 0
let metadataPid = 0
let sqlCalls: Array<{ sql: string; transaction: boolean; params?: unknown[] }>
let hook: ((sql: string, params: unknown[] | undefined, client: PoolClient, execute: () => Promise<QueryResult>) => Promise<QueryResult>) | undefined
let uploadHook: (() => Promise<void>) | undefined
let deleteFails = false
let uploadFails = false
let providerObjects: Set<string>
let providerCalls: Array<{ method: string; id: string; transaction: boolean }>
let latestObject = ''
let commitHook: (() => Promise<void>) | undefined
let tokenRoles: string[] = []
let tokenPermissions = ['multitable:read']
let inheritedRR = false
let inheritedDefaults: string[] = []
let gates = new Set<() => void>()
function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  gates.add(release)
  return { promise, release }
}
async function expectBarrier(gate: ReturnType<typeof barrier>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const observed = await Promise.race([gate.promise.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 2000) })])
    expect(observed).toBe(true)
  } finally { if (timer) clearTimeout(timer) }
}
async function createApp() {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({ isAdmin: async () => false, listUserPermissions: async () => [],
    userHasPermission: async () => false, invalidateUserPerms() {}, getPermCacheStatus() {} }))
  const upload = (method: string) => async (bytes: Buffer) => {
    expect(activeTransactions).toBe(0)
    const id = randomUUID()
    latestObject = id
    providerCalls.push({ method, id, transaction: activeTransactions !== 0 })
    if (uploadFails) throw new Error('synthetic_provider_upload_failure')
    providerObjects.add(id)
    await uploadHook?.()
    const digest = createHash('sha256').update(bytes).digest('hex')
    return { id, path: `${id}/sha256-${digest}`, url: `/synthetic/${id}`, size: bytes.length }
  }
  vi.doMock('../../src/services/StorageService', async () => {
    const actual = await vi.importActual<typeof import('../../src/services/StorageService')>('../../src/services/StorageService')
    return { ...actual, StorageServiceImpl: { ...actual.StorageServiceImpl, createLocalService: () => ({
      upload: upload('upload'), uploadContentAddressed: upload('uploadContentAddressed'),
      async delete(id: string) {
        expect(activeTransactions).toBe(0)
        providerCalls.push({ method: 'delete', id, transaction: activeTransactions !== 0 })
        if (deleteFails) throw new Error('synthetic_provider_delete_failure')
        providerObjects.delete(id)
      },
    }) } }
  })
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const adapter = {
    getInternalPool: () => fixture.pool,
    query: async (sql: string, params?: unknown[]) => {
      sqlCalls.push({ sql, params, transaction: false })
      return fixture.pool.query(sql, params)
    },
    async transaction<T>(work: (client: { query: (sql: string, params?: unknown[]) => Promise<QueryResult>; __rawClient: PoolClient }) => Promise<T>) {
      transactions += 1
      const client = await fixture.pool.connect()
      metadataPid = Reflect.get(client, 'processID') as number
      let priorDefault: string | undefined
      try {
        if (inheritedRR) {
          priorDefault = (await client.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation
          await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ')
          const actualDefault = (await client.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation
          inheritedDefaults.push(actualDefault)
          expect(actualDefault).toBe('repeatable read')
        }
        await client.query('BEGIN')
        activeTransactions += 1
        const query = async (sql: string, params?: unknown[]) => {
          sqlCalls.push({ sql, params, transaction: true })
          const execute = () => client.query(sql, params)
          return hook ? hook(sql, params, client, execute) : execute()
        }
        const result = await work({ query, __rawClient: client })
        await client.query('COMMIT')
        await commitHook?.()
        return result
      } catch (error) { await client.query('ROLLBACK'); throw error }
      finally {
        activeTransactions -= 1
        if (priorDefault !== undefined) await client.query("SELECT set_config('default_transaction_isolation',$1,false)", [priorDefault])
        client.release()
      }
    },
  }
  vi.spyOn(poolManager, 'get').mockReturnValue(adapter as unknown as ReturnType<typeof poolManager.get>)
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.user = { id: fixture.identity.actorId, roles: tokenRoles, perms: tokenPermissions }; next() })
  app.use('/api/multitable', univerMetaRouter())
}
function post(recordBound = false) {
  const req = request(app).post('/api/multitable/attachments').set('Host', 'synthetic.invalid')
    .field('sheetId', fixture.identity.sheetId).field('fieldId', fixture.fieldId)
  if (recordBound) req.field('recordId', fixture.recordId)
  return req.attach('file', Buffer.from('synthetic attachment'), { filename: 'synthetic.txt', contentType: 'text/plain' })
}
async function claim(leaseSeconds = 60, pool: Pick<Pool, 'connect' | 'options'> = fixture.pool) {
  const run = bindRecoveryArchiveOwnedClaim(pool, async (query, identity) => {
    const rows = await query('SELECT 1 FROM meta_bases WHERE id=$1 AND owner_id=$2', [identity.baseId, identity.actorId])
    return rows.rows.length === 1
  }, { keyId: fixture.keyId, keyRowVersion: '1', leaseSeconds, expiresAfterSeconds: 3600 }, { maxBytes: 1024 * 1024, timeoutMs: 10_000 })
  return (await run(fixture.identity)).claim!
}
async function snapshot() {
  const attachments = await fixture.pool.query('SELECT * FROM multitable_attachments ORDER BY id')
  const records = await fixture.pool.query('SELECT * FROM meta_records ORDER BY id')
  const pins = fixture.missingProtectionSchema ? { rows: [] } : await fixture.pool.query('SELECT * FROM meta_recovery_archive_attachment_refs ORDER BY attachment_id')
  return { attachments: attachments.rows, records: records.rows, pins: pins.rows }
}
async function waitForBlocking(blocker: number) {
  const deadline = performance.now() + 2000
  while (performance.now() < deadline) {
    const result = await fixture.pool.query(`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE pid<>pg_backend_pid() AND $1::int=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'`, [blocker])
    if (result.rows[0].count === 1) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  expect('actual_native_fence_wait').toBe('observed')
}
function assertPrivateFree(response: { body: unknown }) {
  const serialized = JSON.stringify(response.body)
  for (const value of [fixture.identity.actorId, fixture.identity.sheetId, fixture.fieldId, fixture.recordId, latestObject]) {
    expect(serialized).not.toContain(value)
  }
}

describeRealDb('G1 actual attachment metadata admission (real DB)', () => {
  beforeAll(() => {
    savedFlags = flags.map((flag) => process.env[flag])
    admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 500 })
  })
  beforeEach(async () => {
    flags.forEach((flag) => { process.env[flag] = 'true' })
    __resetRecoveryWriterStateColumnProbe()
    fixture = await createAttachmentAdmissionFixture(admin)
    transactions = 0; activeTransactions = 0; metadataPid = 0; sqlCalls = []; hook = undefined
    uploadHook = undefined; uploadFails = false; deleteFails = false; providerObjects = new Set(); providerCalls = []; latestObject = ''; commitHook = undefined; tokenRoles = []; tokenPermissions = ['multitable:read']; inheritedRR = false; inheritedDefaults = []; gates = new Set()
    await createApp()
  })
  afterEach(async () => { for (const release of gates) release(); vi.restoreAllMocks(); vi.resetModules(); await fixture?.dispose() })
  afterAll(async () => {
    flags.forEach((flag, index) => { if (savedFlags[index] === undefined) delete process.env[flag]; else process.env[flag] = savedFlags[index] })
    __resetRecoveryWriterStateColumnProbe()
    await admin?.end()
  })

  test.each([false, true])('genuine committed claim refuses record-bound=%s POST with exact values-free409 and zero source changes', async (recordBound) => {
    const older = await post(true).expect(201)
    const olderObject = latestObject
    const token = await claim()
    expect(readRecoveryArchiveCommittedClaim(token).sourcePinIds).toEqual([older.body.data.attachment.id])
    const before = await snapshot()
    const refusal = await post(recordBound)
    expect(refusal.status).toBe(409)
    expect(refusal.body).toEqual(blocked)
    assertPrivateFree(refusal)
    expect(await snapshot()).toEqual(before)
    expect(providerCalls.filter((call) => call.method === 'delete')).toEqual([{ method: 'delete', id: latestObject, transaction: false }])
    expect(providerObjects).toEqual(new Set([olderObject]))
    expect(transactions).toBe(2)
    expect(activeTransactions).toBe(0)
  })

  test('claim committed during provider upload wins admission without provider IO holding the canonical fence', async () => {
    const entered = barrier(); const finish = barrier()
    uploadHook = async () => { entered.release(); await finish.promise }
    const pending = post(true).then((response) => response)
    await expectBarrier(entered)
    expect(transactions).toBe(0)
    const token = await claim()
    expect(readRecoveryArchiveCommittedClaim(token).sourcePinIds).toEqual([])
    const before = await snapshot()
    finish.release()
    const response = await pending
    expect(response.status).toBe(409)
    expect(response.body).toEqual(blocked)
    expect(await snapshot()).toEqual(before)
    expect(providerObjects.size).toBe(0)
    expect(providerCalls.every((call) => !call.transaction)).toBe(true)
  })

  test('metadata writer holding the real canonical fence commits first and enters the next genuine claim complete pin set', async () => {
    const entered = barrier(); const finish = barrier()
    let held = false
    hook = async (sql, _params, _client, execute) => {
      const rows = await execute()
      if (!held && sql.includes('pg_advisory_xact_lock')) { held = true; entered.release(); await finish.promise }
      return rows
    }
    const pending = post(true).then((response) => response)
    await expectBarrier(entered)
    expect(providerObjects.size).toBe(1)
    expect(providerCalls.every((call) => !call.transaction)).toBe(true)
    const nextClaim = claim()
    try { await waitForBlocking(metadataPid) } finally { finish.release() }
    const response = await pending
    expect(response.status).toBe(201)
    const token = await nextClaim
    expect(readRecoveryArchiveCommittedClaim(token).sourcePinIds).toEqual([response.body.data.attachment.id])
    expect((await snapshot()).attachments).toHaveLength(1)
  })

  test('claim transaction holding the canonical fence makes completed upload actually wait then refuse after claim COMMIT', async () => {
    inheritedRR = true
    const entered = barrier(); const finish = barrier()
    let claimPid = 0
    let held = false
    const pool = { options: fixture.pool.options, connect: (async () => {
      const client = await fixture.pool.connect()
      claimPid = Reflect.get(client, 'processID') as number
      const query = client.query.bind(client)
      return new Proxy(client, { get(target, key) {
        if (key === 'query') return async (sql: string, params?: unknown[]) => {
          const result = await query(sql, params)
          if (!held && sql.includes('pg_advisory_xact_lock')) { held = true; entered.release(); await finish.promise }
          return result
        }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    }) as Pool['connect'] }
    const pendingClaim = claim(60, pool)
    await expectBarrier(entered)
    const pending = post().then((response) => response)
    try { await waitForBlocking(claimPid) } finally { finish.release() }
    const token = await pendingClaim
    expect(readRecoveryArchiveCommittedClaim(token).sourcePinIds).toEqual([])
    const response = await pending
    expect(response.status).toBe(409)
    expect(response.body).toEqual(blocked)
    expect(inheritedDefaults).toEqual(['repeatable read'])
    expect((await snapshot()).attachments).toEqual([])
  })

  test.each(['sheet', 'field', 'field type', 'record', 'permission', 'row creator'])('post-upload %s drift is revalidated inside the owned native transaction', async (mode) => {
    if (mode === 'row creator') {
      await fixture.pool.query(`UPDATE spreadsheet_permissions SET perm_code='spreadsheet:write-own' WHERE sheet_id=$1`, [fixture.identity.sheetId])
    }
    uploadHook = async () => {
      if (mode === 'sheet') await fixture.pool.query('UPDATE meta_sheets SET deleted_at=clock_timestamp() WHERE id=$1', [fixture.identity.sheetId])
      if (mode === 'field') await fixture.pool.query('DELETE FROM meta_fields WHERE id=$1', [fixture.fieldId])
      if (mode === 'field type') await fixture.pool.query(`UPDATE meta_fields SET type='string' WHERE id=$1`, [fixture.fieldId])
      if (mode === 'record') await fixture.pool.query('DELETE FROM meta_records WHERE id=$1', [fixture.recordId])
      if (mode === 'permission') await fixture.pool.query('DELETE FROM spreadsheet_permissions WHERE sheet_id=$1', [fixture.identity.sheetId])
      if (mode === 'row creator') await fixture.pool.query('UPDATE meta_records SET created_by=$2 WHERE id=$1', [fixture.recordId, randomUUID()])
    }
    const response = await post(true)
    expect(response.status).toBe(['permission', 'row creator'].includes(mode) ? 403 : mode === 'field type' ? 400 : 404)
    expect(response.body.ok).toBe(false)
    assertPrivateFree(response)
    expect((await fixture.pool.query('SELECT count(*)::int AS count FROM multitable_attachments')).rows).toEqual([{ count: 0 }])
    expect(providerCalls.filter((call) => call.method === 'delete')).toEqual([{ method: 'delete', id: latestObject, transaction: false }])
    expect(activeTransactions).toBe(0)
    expect(sqlCalls.filter((call) => call.transaction).at(-1)?.sql).not.toContain('INSERT INTO multitable_attachments')
  })

  test.each(['fencing', 'applying', 'paused_retryable'])('all durable %s writer blocks refuse metadata admission', async (state) => {
    await fixture.pool.query('UPDATE meta_sheets SET recovery_writer_state=$2 WHERE id=$1', [fixture.identity.sheetId, state])
    const before = await snapshot()
    const response = await post()
    expect(response.status).toBe(409)
    expect(response.body).toEqual(blocked)
    expect(await snapshot()).toEqual(before)
  })

  test('expired genuine archiving lease remains a durable block for an ordinary upload', async () => {
    await claim(1)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect((await fixture.pool.query('SELECT recovery_writer_lease_until<clock_timestamp() AS expired FROM meta_sheets WHERE id=$1', [fixture.identity.sheetId])).rows).toEqual([{ expired: true }])
    const response = await post()
    expect(response.status).toBe(409)
    expect(response.body).toEqual(blocked)
  })

  test('provider upload failure starts no owned transaction or metadata cleanup', async () => {
    uploadFails = true
    const response = await post().expect(500)
    expect(response.body).toEqual({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to upload attachment' } })
    expect(transactions).toBe(0)
    expect(providerCalls.map((call) => call.method)).toEqual(['uploadContentAddressed'])
    expect((await snapshot()).attachments).toEqual([])
  })

  test('existing best-effort cleanup failure preserves exact refusal and does not delete older pinned object', async () => {
    const older = await post().expect(201)
    const olderObject = latestObject
    const token = await claim()
    expect(readRecoveryArchiveCommittedClaim(token).sourcePinIds).toEqual([older.body.data.attachment.id])
    deleteFails = true
    const before = await snapshot()
    const response = await post()
    expect(response.status).toBe(409)
    expect(response.body).toEqual(blocked)
    expect(await snapshot()).toEqual(before)
    expect(providerObjects).toEqual(new Set([olderObject, latestObject]))
    expect(providerCalls.filter((call) => call.method === 'delete')).toEqual([{ method: 'delete', id: latestObject, transaction: false }])
  })

  test.each(['inactive user', 'legacy global permission', 'direct global permission', 'role global permission', 'admin role'])(
    'fresh current principal refuses post-upload %s revocation despite unchanged authenticated claims', async (mode) => {
      if (mode !== 'inactive user') {
        await fixture.pool.query('DELETE FROM spreadsheet_permissions WHERE sheet_id=$1', [fixture.identity.sheetId])
        tokenPermissions = ['multitable:read', 'multitable:write']
        await fixture.pool.query(`INSERT INTO permissions(code,name) VALUES('multitable:write','Synthetic') ON CONFLICT DO NOTHING`)
      }
      if (mode === 'legacy global permission') await fixture.pool.query(`UPDATE users SET permissions='["multitable:write"]' WHERE id=$1`, [fixture.identity.actorId])
      if (mode === 'direct global permission') await fixture.pool.query(`INSERT INTO user_permissions(user_id,permission_code) VALUES($1,'multitable:write')`, [fixture.identity.actorId])
      if (mode === 'role global permission') {
        await fixture.pool.query(`INSERT INTO user_roles(user_id,role_id) VALUES($1,'synthetic_writer')`, [fixture.identity.actorId])
        await fixture.pool.query(`INSERT INTO role_permissions(role_id,permission_code) VALUES('synthetic_writer','multitable:write')`)
      }
      if (mode === 'admin role') {
        tokenRoles = ['admin']
        await fixture.pool.query(`INSERT INTO user_roles(user_id,role_id) VALUES($1,'admin')`, [fixture.identity.actorId])
      }
      uploadHook = async () => {
        if (mode === 'inactive user') await fixture.pool.query('UPDATE users SET is_active=false WHERE id=$1', [fixture.identity.actorId])
        if (mode === 'legacy global permission') await fixture.pool.query(`UPDATE users SET permissions='[]' WHERE id=$1`, [fixture.identity.actorId])
        if (mode === 'direct global permission') await fixture.pool.query('DELETE FROM user_permissions WHERE user_id=$1', [fixture.identity.actorId])
        if (mode === 'role global permission') await fixture.pool.query(`DELETE FROM role_permissions WHERE role_id='synthetic_writer'`)
        if (mode === 'admin role') await fixture.pool.query(`DELETE FROM user_roles WHERE user_id=$1 AND role_id='admin'`, [fixture.identity.actorId])
      }
      const response = await post(true)
      expect(response.status).toBe(403)
      expect(response.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
      assertPrivateFree(response)
      expect((await snapshot()).attachments).toEqual([])
      expect(providerObjects.size).toBe(0)
      expect(sqlCalls.some((call) => call.transaction && call.sql.includes('FROM users'))).toBe(true)
    },
  )

  test('stale authenticated admin narrowed to fresh write-own cannot upload against another creator row', async () => {
    tokenRoles = ['admin']
    await fixture.pool.query(`INSERT INTO user_roles(user_id,role_id) VALUES($1,'admin')`, [fixture.identity.actorId])
    await fixture.pool.query(`UPDATE spreadsheet_permissions SET perm_code='spreadsheet:write-own' WHERE sheet_id=$1`, [fixture.identity.sheetId])
    await fixture.pool.query('UPDATE meta_records SET created_by=$2 WHERE id=$1', [fixture.recordId, randomUUID()])
    uploadHook = async () => { await fixture.pool.query(`DELETE FROM user_roles WHERE user_id=$1 AND role_id='admin'`, [fixture.identity.actorId]) }
    const response = await post(true)
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Record editing is not allowed for this row' } })
    expect((await snapshot()).attachments).toEqual([])
    expect(providerObjects.size).toBe(0)
  })

  test('actual metadata COMMIT followed by lost acknowledgement keeps the newly pinned object and returns closed503', async () => {
    const committed = barrier(); const finish = barrier()
    commitHook = async () => { committed.release(); await finish.promise; throw new Error('synthetic_commit_ack_lost_after_actual_commit') }
    let settled = false
    const pending = post(true).then((response) => { settled = true; return response })
    let token: Awaited<ReturnType<typeof claim>> | undefined
    let attachmentId = ''
    try {
      await expectBarrier(committed)
      expect(settled).toBe(false)
      const rows = await fixture.pool.query('SELECT id FROM multitable_attachments')
      expect(rows.rows).toHaveLength(1)
      attachmentId = rows.rows[0].id
      expect((await fixture.pool.query(`SELECT state FROM pg_stat_activity WHERE pid=$1`, [metadataPid])).rows).toEqual([{ state: 'idle' }])
      token = await claim()
      expect(readRecoveryArchiveCommittedClaim(token).sourcePinIds).toEqual([attachmentId])
    } finally { finish.release() }
    const response = await pending
    expect(response.status).toBe(503)
    expect(response.body).toEqual({ ok: false, error: { code: 'DB_NOT_READY', message: 'Attachment metadata admission unavailable' } })
    assertPrivateFree(response)
    expect((await fixture.pool.query('SELECT id FROM multitable_attachments')).rows).toEqual([{ id: attachmentId }])
    expect(providerCalls.filter((call) => call.method === 'delete')).toEqual([])
    expect(providerObjects).toEqual(new Set([latestObject]))
    expect(token).toBeDefined()
    expect(activeTransactions).toBe(0)
  })

  const unselected = [undefined, 'false', 'TRUE', 'true'].flatMap((archive) =>
    [undefined, 'false', 'TRUE', 'true'].filter((fence) => archive !== 'true' || fence !== 'true').map((fence) => [archive, fence]))
  test.each(unselected)('unselected archive=%s fence=%s retains old provider/query/response and zero new transactions', async (archive, fence) => {
    await claim()
    if (archive === undefined) delete process.env[flags[0]]; else process.env[flags[0]] = archive
    if (fence === undefined) delete process.env[flags[1]]; else process.env[flags[1]] = fence
    const response = await post(true).expect(201)
    expect(transactions).toBe(0)
    expect(sqlCalls.every((call) => !call.transaction)).toBe(true)
    expect(sqlCalls.some((call) => /pg_advisory|recovery_writer_state|transaction_isolation/.test(call.sql))).toBe(false)
    expect(providerCalls.map((call) => call.method)).toEqual(['upload'])
    expect(sqlCalls.filter((call) => call.sql.includes('INSERT INTO multitable_attachments'))).toHaveLength(1)
    expect(sqlCalls.filter((call) => call.sql.includes('FROM spreadsheet_permissions'))).toHaveLength(1)
    expect(sqlCalls.filter((call) => call.sql.includes('SELECT id, type FROM meta_fields'))).toHaveLength(1)
    expect(sqlCalls.filter((call) => call.sql.includes('SELECT id, created_by FROM meta_records'))).toHaveLength(1)
    const row = (await fixture.pool.query('SELECT * FROM multitable_attachments')).rows[0]
    expect(response.body).toEqual({ ok: true, data: { attachment: { id: row.id, filename: 'synthetic.txt', mimeType: 'text/plain',
      size: 20, url: `http://synthetic.invalid/api/multitable/attachments/${row.id}`, thumbnailUrl: null, uploadedAt: row.created_at.toISOString() } } })
  })

  test('actual session default RR is explicitly changed to RC before the canonical fence', async () => {
    inheritedRR = true
    let isolationReads = 0
    hook = async (sql, _params, _client, execute) => {
      const result = await execute()
      if (sql === 'SHOW transaction_isolation') {
        isolationReads += 1
        expect(result.rows).toEqual([{ transaction_isolation: 'read committed' }])
      }
      return result
    }
    const response = await post()
    expect(response.status).toBe(201)
    expect(response.body.ok).toBe(true)
    expect(inheritedDefaults).toEqual(['repeatable read'])
    expect(isolationReads).toBe(1)
    const restored = await fixture.pool.query(`SELECT current_setting('default_transaction_isolation') AS isolation, pg_backend_pid() AS pid`)
    expect(restored.rows).toEqual([{ isolation: 'read committed', pid: metadataPid }])
  })

  test('actual RR isolation after setup refuses closed before acquiring the canonical fence', async () => {
    hook = async (sql, _params, client, execute) => {
      if (sql === 'SHOW transaction_isolation') await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      return execute()
    }
    const response = await post()
    expect(response.status).toBe(409)
    expect(response.body).toEqual(blocked)
    expect(sqlCalls.some((call) => call.sql.includes('pg_advisory'))).toBe(false)
    expect((await snapshot()).attachments).toEqual([])
    expect(providerObjects.size).toBe(0)
  })

  test('early actual migration schema without writer-state column refuses the protected metadata INSERT', async () => {
    await fixture.dispose()
    fixture = await createAttachmentAdmissionFixture(admin, true)
    await createApp()
    expect((await fixture.pool.query(`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name='meta_sheets' AND column_name='recovery_writer_state'`)).rows).toEqual([{ count: 0 }])
    const response = await post()
    expect(response.status).toBe(409)
    expect(response.body).toEqual(blocked)
    expect((await snapshot()).attachments).toEqual([])
    expect(providerObjects.size).toBe(0)
  })
})
