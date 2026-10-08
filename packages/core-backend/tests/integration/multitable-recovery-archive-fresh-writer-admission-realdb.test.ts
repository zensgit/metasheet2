import express from 'express'
import { Pool } from 'pg'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { __resetRecoveryWriterStateColumnProbe, canonicalSheetFenceKey } from '../../src/multitable/canonical-sheet-fence'
import { bindRecoveryArchiveOwnedClaim, readRecoveryArchiveCommittedClaim } from '../../src/multitable/recovery-archive-owned-claim'
import { bindRecoveryArchiveOwnedCapture, readRecoveryArchiveCapturedSource } from '../../src/multitable/recovery-archive-owned-capture'
import { createFreshWriterFixture, type FreshWriterFixture } from '../utils/recovery-archive-fresh-writer-admission-fixture'
import { usePinnedServer } from '../utils/pinned-server'

const armed = process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const describeRealDb = armed && process.env.DATABASE_URL ? describe : describe.skip
const pinned = usePinnedServer()
test('sentinel: fresh writer admission real-DB lane requires DATABASE_URL', () => {
  if (armed && !process.env.DATABASE_URL) throw new Error('recovery_archive_fresh_writer_admission_realdb_harness_missing_database_url')
})
const blocked = { ok: false, error: { code: 'RECOVERY_IN_PROGRESS', message: 'Another recovery operation is in progress on this sheet; retry shortly.' } }
const flags = ['MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'MULTITABLE_ENABLE_WRITER_FENCE']
let saved: Array<string | undefined>, admin: Pool, fixture: FreshWriterFixture
let calls: Array<{ sql: string; params?: unknown[]; rows: unknown[] }> = []
const authorize: Parameters<typeof bindRecoveryArchiveOwnedClaim>[1] = async (query, identity) =>
  (await query('SELECT 1 FROM meta_bases WHERE id=$1 AND owner_id=$2', [identity.baseId, identity.actorId])).rows.length === 1
async function claim(pool: Pick<Pool, 'connect' | 'options'> = fixture.pool, leaseSeconds = 60) {
  const token = (await bindRecoveryArchiveOwnedClaim(pool, authorize, { keyId: fixture.keyId, keyRowVersion: '1', leaseSeconds, expiresAfterSeconds: 3600 }, { maxBytes: 1048576, timeoutMs: 10000 })(fixture.identity)).claim!
  expect(readRecoveryArchiveCommittedClaim(token).sourcePinIds).toEqual([fixture.attachmentId]); return token
}
async function capturedViewName(token: Awaited<ReturnType<typeof claim>>) {
  const source = readRecoveryArchiveCapturedSource(await bindRecoveryArchiveOwnedCapture(fixture.pool, authorize, { maxBytes: 1048576, timeoutMs: 10000 })(token)).source
  const rows = source.sections.views_config as Array<{ view_id: string; name: string }>
  expect(rows).toHaveLength(1); return rows[0].name
}
function patch(name = 'After') { return request(pinned.url()).patch(`/api/multitable/views/${fixture.viewId}`).set('Host', 'synthetic.invalid').send({ name }) }
async function viewName() { return (await fixture.query('SELECT name FROM meta_views WHERE id=$1', [fixture.viewId])).rows[0].name as string }
const tables = ['meta_views', 'meta_config_revisions', 'meta_sheets', 'meta_recovery_archives', 'meta_recovery_archive_keys', 'meta_recovery_archive_snapshot_reservations',
  'meta_recovery_archive_attachment_refs', 'meta_recovery_archive_manual_requests', 'meta_record_history_operations', 'meta_record_revisions', 'meta_sheet_section_revisions', 'multitable_attachments']
async function snapshot() {
  const result: Record<string, string[]> = {}
  for (const table of tables) result[table] = (await fixture.query(`SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY to_jsonb(t)::text COLLATE "C"`)).rows.map((row) => row.row)
  return result
}
function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}
async function waitFor(predicate: () => Promise<boolean>) {
  const until = Date.now() + 3000
  while (Date.now() < until) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(false, 'native barrier did not reach its required state').toBe(true)
}
function heldClaim() {
  const resume = barrier()
  let pid = 0
  const pool: Pick<Pool, 'connect' | 'options'> = { options: fixture.pool.options,
    connect: (async () => {
      const client = await fixture.pool.connect()
      pid = Reflect.get(client, 'processID') as number
      return { query: async (sql: string, params?: unknown[]) => {
        const result = await client.query(sql, params)
        if (sql.includes('pg_advisory_xact_lock(hashtext($1))') && params?.[0] === canonicalSheetFenceKey(fixture.sheetId)) {
          await resume.promise
        }
        return result
      }, release: (discard?: boolean) => client.release(discard) }
    }) as Pool['connect'] }
  const pending = claim(pool)
  // A failed pre-fence claim must settle without leaving an unhandled rejection.
  void pending.catch(() => {})
  return { pending, resume, pid: () => pid }
}
async function isBlocked(waiter: number, owner: number) {
  return (await fixture.query('SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked', [waiter, owner])).rows[0].blocked === true
}
async function viewHistory() {
  return { name: await viewName(), rows: (await fixture.query('SELECT to_jsonb(r)::text AS row FROM meta_config_revisions r ORDER BY id')).rows }
}
async function warmAndMigrate() {
  process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'false'
  const warm = await patch('Warm')
  expect(warm.status, warm.body.error?.code).toBe(200)
  expect(await viewName()).toBe('Warm')
  const probe = calls.find((call) => call.sql.includes('information_schema.columns') && call.sql.includes('recovery_writer_state'))
  expect(probe?.rows).toEqual([])
  expect((await fixture.query('SELECT count(*)::int AS n FROM meta_config_revisions WHERE entity_id=$1', [fixture.viewId])).rows).toEqual([{ n: 1 }])
  await fixture.completeMigrations()
  expect((await fixture.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='meta_sheets' AND column_name='recovery_writer_state'")).rows).toEqual([{ n: 1 }])
  process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'true'
  calls.length = 0
}

describeRealDb('G4 actual fresh ordinary writer admission (real DB)', () => {
  beforeAll(async () => {
    saved = flags.map((flag) => process.env[flag]); admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 500 })
  })
  beforeEach(async () => {
    for (const flag of flags) process.env[flag] = 'true'
    __resetRecoveryWriterStateColumnProbe(); calls = []
    fixture = await createFreshWriterFixture(admin)
    fixture.control.hook = async (sql, params, _client, execute) => { const result = await execute(); calls.push({ sql, params, rows: result.rows }); return result }
    vi.resetModules()
    const { poolManager } = await import('../../src/integration/db/connection-pool')
    const adapter = { getInternalPool: () => fixture.pool, query: (sql: string, params?: unknown[]) => fixture.query(sql, params),
      transaction: <T>(work: Parameters<FreshWriterFixture['transaction']>[0]) => fixture.transaction(work) as Promise<T> }
    vi.spyOn(poolManager, 'get').mockReturnValue(adapter as unknown as ReturnType<typeof poolManager.get>)
    const { univerMetaRouter } = await import('../../src/routes/univer-meta')
    const app = express(); app.use(express.json())
    app.use((req, _res, next) => { req.user = { id: fixture.identity.actorId, roles: ['admin'], perms: ['multitable:read', 'multitable:write', 'multitable:share', 'multitable:manage-schema'] }; next() })
    app.use('/api/multitable', univerMetaRouter()); pinned.setApp(app)
  })
  afterEach(async () => { vi.restoreAllMocks(); await fixture?.dispose() })
  afterAll(async () => { flags.forEach((flag, i) => { if (saved[i] === undefined) delete process.env[flag]; else process.env[flag] = saved[i] }); vi.restoreAllMocks(); __resetRecoveryWriterStateColumnProbe(); await admin?.end() })

  test('actual complete substrate unblocked view PATCH commits source and history', async () => {
    await fixture.completeMigrations()
    const response = await patch()
    expect(response.status, response.body.error?.code).toBe(200)
    expect(await viewName()).toBe('After')
    expect((await fixture.query('SELECT count(*)::int AS n FROM meta_config_revisions WHERE entity_id=$1', [fixture.viewId])).rows).toEqual([{ n: 1 }])
  })

  test('same-process false cache after real migration and genuine claim must refuse actual view PATCH without source or capture drift', async () => {
    await warmAndMigrate(); const token = await claim(); const before = await snapshot()
    const response = await patch(); const after = await snapshot(); const capturedName = await capturedViewName(token)
    const diagnostics = { actualStatus: response.status, sourceChanged: JSON.stringify(before.meta_views) !== JSON.stringify(after.meta_views),
      capturedChanged: capturedName !== 'Warm', historyRowsBefore: before.meta_config_revisions.length, historyRowsAfter: after.meta_config_revisions.length,
      sourcePinCount: readRecoveryArchiveCommittedClaim(token).sourcePinIds.length }
    console.log('g4_actual_same_process_diagnostics', JSON.stringify(diagnostics))
    // Diagnostics above finish all native SQL and capture before the first counterexample assertion.
    expect(response.status).toBe(409)
    expect(response.body).toEqual(blocked); expect(after).toEqual(before); expect(capturedName).toBe('Warm')
  })

  test('selected missing state column refuses actual view PATCH after legacy cache warm without writes', async () => {
    process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'false'
    expect((await patch('Warm')).status).toBe(200)
    expect(calls.find((call) => call.sql.includes('information_schema.columns'))?.rows).toEqual([])
    process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'true'; calls.length = 0
    const before = await viewHistory(), response = await patch()
    expect(response.status).toBe(409); expect(response.body).toEqual(blocked)
    expect(await viewHistory()).toEqual(before)
    expect(calls.some((call) => /^\s*UPDATE\s+meta_views/i.test(call.sql))).toBe(false)
  })

  test('selected NULL state admits RC writer after same-process false cache and real migration', async () => {
    await warmAndMigrate()
    const response = await patch()
    expect(response.status).toBe(200); expect(await viewName()).toBe('After')
    expect(calls.filter((call) => call.sql === 'SHOW transaction_isolation').map((call) => call.rows)).toEqual([[{ transaction_isolation: 'read committed' }]])
    const probes = calls.filter((call) => call.sql.includes('pg_current_xact_id()')).map((call) => call.rows)
    expect(probes).toHaveLength(2); expect(probes[0]).toEqual(probes[1])
    expect(calls.some((call) => call.sql.includes('information_schema.columns') && call.sql.includes('recovery_writer_state'))).toBe(false)
    expect((await fixture.query('SELECT count(*)::int AS n FROM meta_config_revisions')).rows).toEqual([{ n: 2 }])
  })

  test('genuine expired archiving lease still refuses actual view PATCH without durable changes', async () => {
    await warmAndMigrate(); const token = await claim(fixture.pool, 1)
    const lease = readRecoveryArchiveCommittedClaim(token).leaseUntil
    await waitFor(async () => (await fixture.query('SELECT clock_timestamp() > $1::timestamptz AS expired', [lease])).rows[0].expired === true)
    const before = await snapshot(), response = await patch()
    expect(response.status).toBe(409); expect(response.body).toEqual(blocked); expect(await snapshot()).toEqual(before)
  })

  test('genuine claim first holds canonical fence then commits and waiting RC view PATCH refuses', async () => {
    await warmAndMigrate(); const owner = heldClaim()
    let pending: ReturnType<typeof patch> | undefined
    try {
      await waitFor(async () => owner.pid() > 0 && (await fixture.query('SELECT count(*)::int AS n FROM pg_locks WHERE pid=$1 AND locktype=\'advisory\' AND granted', [owner.pid()])).rows[0].n > 0)
      pending = patch(); const responsePromise = Promise.resolve(pending)
      await waitFor(async () => fixture.control.pid !== owner.pid() && await isBlocked(fixture.control.pid, owner.pid()))
      owner.resume.release(); const token = await owner.pending
      const before = await snapshot(), response = await responsePromise
      expect(response.status).toBe(409); expect(response.body).toEqual(blocked)
      expect(await snapshot()).toEqual(before); expect(await capturedViewName(token)).toBe('Warm')
    } finally { owner.resume.release(); await Promise.allSettled([owner.pending, pending ? Promise.resolve(pending) : Promise.resolve()]) }
  })

  test('RC view writer first holds canonical fence and genuine claim captures its committed view and history', async () => {
    await warmAndMigrate(); const resume = barrier()
    const original = fixture.control.hook!
    fixture.control.hook = async (sql, params, client, execute) => {
      const result = await original(sql, params, client, execute)
      if (/^\s*UPDATE\s+meta_views/i.test(sql)) await resume.promise
      return result
    }
    const responsePromise = Promise.resolve(patch()); let owner: ReturnType<typeof heldClaim> | undefined
    try {
      await waitFor(async () => calls.some((call) => /^\s*UPDATE\s+meta_views/i.test(call.sql)))
      owner = heldClaim()
      await waitFor(async () => owner!.pid() > 0 && await isBlocked(owner!.pid(), fixture.control.pid))
      resume.release(); expect((await responsePromise).status).toBe(200)
      owner.resume.release(); const token = await owner.pending
      expect(await capturedViewName(token)).toBe('After')
      // This ordinary writer records untagged config history, without a sealed operation endpoint.
      expect(readRecoveryArchiveCommittedClaim(token).observedHeads.operationHead).toBeNull()
      expect((await fixture.query('SELECT count(*)::int AS n FROM meta_config_revisions')).rows).toEqual([{ n: 2 }])
    } finally { resume.release(); owner?.resume.release(); await Promise.allSettled([responsePromise, owner?.pending ?? Promise.resolve()]) }
  })

  test('inherited native RR snapshot before claim commit refuses waiting actual view PATCH', async () => {
    await warmAndMigrate(); const owner = heldClaim(); fixture.control.defaultRR = true
    const original = fixture.control.hook!
    let oldState: unknown
    fixture.control.hook = async (sql, params, client, execute) => {
      if (sql.includes('pg_advisory_xact_lock(hashtext($1))')) {
        oldState = (await client.query('SELECT recovery_writer_state FROM meta_sheets WHERE id=$1', [fixture.sheetId])).rows[0].recovery_writer_state
      }
      return original(sql, params, client, execute)
    }
    let responsePromise: Promise<Awaited<ReturnType<typeof patch>>> | undefined
    try {
      await waitFor(async () => owner.pid() > 0 && (await fixture.query('SELECT count(*)::int AS n FROM pg_locks WHERE pid=$1 AND locktype=\'advisory\' AND granted', [owner.pid()])).rows[0].n > 0)
      responsePromise = Promise.resolve(patch())
      await waitFor(async () => fixture.control.pid !== owner.pid() && await isBlocked(fixture.control.pid, owner.pid()))
      expect(fixture.control.inherited).toEqual(['repeatable read']); expect(oldState).toBeNull()
      owner.resume.release(); const token = await owner.pending, before = await snapshot(), response = await responsePromise
      expect(response.status).toBe(409); expect(response.body).toEqual(blocked); expect(await snapshot()).toEqual(before)
      expect(calls.filter((call) => call.sql === 'SHOW transaction_isolation').map((call) => call.rows)).toEqual([[{ transaction_isolation: 'repeatable read' }]])
      expect(await capturedViewName(token)).toBe('Warm')
    } finally { owner.resume.release(); await Promise.allSettled([owner.pending, responsePromise ?? Promise.resolve()]); fixture.control.defaultRR = false }
  })

  test('actual autocommit native client has distinct xids and refuses unblocked view PATCH', async () => {
    await warmAndMigrate(); fixture.control.autocommit = true
    const before = await snapshot(), response = await patch()
    expect(response.status).toBe(409); expect(response.body).toEqual(blocked); expect(await snapshot()).toEqual(before)
    const probes = calls.filter((call) => call.sql.includes('pg_current_xact_id()')).map((call) => call.rows)
    expect(probes).toHaveLength(2); expect(probes[0]).not.toEqual(probes[1])
    expect(calls.some((call) => /^\s*UPDATE\s+meta_views/i.test(call.sql))).toBe(false)
  })

  test.each([
    ['archive false', 'false', 'true'], ['archive absent', undefined, 'true'], ['archive uppercase', 'TRUE', 'true'],
    ['writer false', 'true', 'false'], ['writer uppercase', 'true', 'TRUE'], ['writer padded', 'true', ' true '],
  ])('legacy OFF parity %s retains warmed-cache view PATCH behavior after genuine claim', async (_label, archive, writer) => {
    await warmAndMigrate(); await claim()
    if (archive === undefined) delete process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED
    else process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = archive
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = writer!
    calls.length = 0
    const response = await patch()
    expect(response.status).toBe(200); expect(await viewName()).toBe('After')
    expect(calls.some((call) => call.sql === 'SHOW transaction_isolation' || call.sql.includes('SELECT recovery_writer_state') || call.sql.includes('pg_current_xact_id()'))).toBe(false)
    expect((await fixture.query('SELECT count(*)::int AS n FROM meta_config_revisions')).rows).toEqual([{ n: 2 }])
  })
})
