import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { sweepFieldValueTombstoneRetention, sweepLinkTombstoneRetention, type MetaRevisionRetentionConfig, type RetentionQueryFn } from '../../src/multitable/meta-revision-retention'
import { bindRecoveryArchiveOwnedClaim, readRecoveryArchiveCommittedClaim } from '../../src/multitable/recovery-archive-owned-claim'
import { bindRecoveryArchiveOwnedCapture, readRecoveryArchiveCapturedSource } from '../../src/multitable/recovery-archive-owned-capture'
import { canonicalSheetFenceKey, __resetRecoveryWriterStateColumnProbe } from '../../src/multitable/canonical-sheet-fence'
import { createRetentionFixture, createRetentionDeploymentFixture, tombstoneTable, anchorColumn, type RetentionFixture, type TombstoneKind } from '../utils/recovery-archive-retention-admission-fixture'

const armed = process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const describeRealDb = armed && process.env.DATABASE_URL ? describe : describe.skip
test('sentinel: retention admission real-DB lane requires DATABASE_URL', () => {
  if (armed && !process.env.DATABASE_URL) throw new Error('recovery_archive_retention_admission_realdb_harness_missing_database_url')
})
const config: MetaRevisionRetentionConfig = { enabled: true, policy: 'keep-last-n', keepN: 10, retentionDays: 30, batchSize: 100 }
const flagNames = ['MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'MULTITABLE_ENABLE_WRITER_FENCE']
let savedFlags: Array<string | undefined>, admin: Pool, fixture: RetentionFixture
let calls: Array<{ sql: string; params?: unknown[] }> = []
const sweep = (kind: TombstoneKind, q: RetentionQueryFn = fixture.query, runner = fixture.runner, cfg = config) =>
  (kind === 'field' ? sweepFieldValueTombstoneRetention : sweepLinkTombstoneRetention)(q, cfg, runner)
const authorize = async (query: RetentionQueryFn, identity: RetentionFixture['identity']) =>
  (await query('SELECT 1 FROM meta_bases WHERE id=$1 AND owner_id=$2', [identity.baseId, identity.actorId])).rows.length === 1
async function claim(pool: Pick<Pool, 'connect' | 'options'> = fixture.pool, leaseSeconds = 60) {
  const token = (await bindRecoveryArchiveOwnedClaim(pool, authorize, { keyId: fixture.keyId, keyRowVersion: '1', leaseSeconds, expiresAfterSeconds: 3600 }, { maxBytes: 1048576, timeoutMs: 10000 })(fixture.identity)).claim!
  expect(readRecoveryArchiveCommittedClaim(token).sourcePinIds).toEqual(fixture.pins)
  return token
}
async function captured(token: Awaited<ReturnType<typeof claim>>) {
  return readRecoveryArchiveCapturedSource(await bindRecoveryArchiveOwnedCapture(fixture.pool, authorize, { maxBytes: 1048576, timeoutMs: 10000 })(token))
}
const snapshotTables = ['meta_sheets', 'meta_field_value_tombstones', 'meta_link_tombstones', 'meta_records_trash', 'meta_records',
  'meta_recovery_archives', 'meta_recovery_archive_keys', 'meta_recovery_archive_snapshot_reservations', 'meta_recovery_archive_attachment_refs',
  'meta_recovery_archive_manual_requests', 'meta_record_history_operations', 'meta_record_revisions', 'meta_sheet_section_revisions', 'multitable_attachments']
async function snapshot() {
  const result: Record<string, string[]> = {}
  for (const table of snapshotTables) result[table] = (await fixture.query(`SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY to_jsonb(t)::text COLLATE "C"`)).rows.map((row) => row.row)
  return result
}
async function ids(kind: TombstoneKind) { return (await fixture.query(`SELECT id::text FROM ${tombstoneTable(kind)} ORDER BY id`)).rows.map((row) => row.id as string) }
const deletes = () => calls.filter((call) => /\bDELETE\s+FROM\b/i.test(call.sql))
let releases = new Set<() => void>()
function barrier() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve }); releases.add(release); return { promise, release } }
async function waitBarrier(gate: ReturnType<typeof barrier>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { expect(await Promise.race([gate.promise.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 2000) })])).toBe(true) }
  finally { if (timer) clearTimeout(timer) }
}
async function waitBlocking(pid: number) {
  const until = performance.now() + 2000
  while (performance.now() < until) {
    if ((await fixture.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'", [pid])).rows[0].n === 1) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  expect('actual native fence waiter').toBe('observed')
}
function gatedClaim(entered: ReturnType<typeof barrier>, resume: ReturnType<typeof barrier>) {
  let pid = 0
  const pool = { options: fixture.pool.options, connect: async () => {
    const client = await fixture.pool.connect(); pid = Reflect.get(client, 'processID') as number
    return { query: async (sql: string, params?: unknown[]) => {
      const result = await client.query(sql, params)
      if (sql.includes('pg_advisory_xact_lock') && params?.[0] === canonicalSheetFenceKey(fixture.identity.sheetId)) { entered.release(); await resume.promise }
      return result
    }, release: (discard?: boolean) => client.release(discard) }
  } } as unknown as Pick<Pool, 'connect' | 'options'>
  return { pool, get pid() { return pid } }
}

describeRealDb('G3 actual tombstone retention admission (real DB)', () => {
  beforeAll(() => { savedFlags = flagNames.map((flag) => process.env[flag]); admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 500 }) })
  beforeEach(async () => {
    for (const flag of flagNames) process.env[flag] = 'true'
    __resetRecoveryWriterStateColumnProbe(); calls = []; releases = new Set()
    fixture = await createRetentionFixture(admin)
    fixture.control.hook = async (sql, params, _client, execute) => { calls.push({ sql, params }); return execute() }
  })
  afterEach(async () => { for (const release of releases) release(); await fixture?.dispose() })
  afterAll(async () => { flagNames.forEach((flag, i) => { if (savedFlags[i] === undefined) delete process.env[flag]; else process.env[flag] = savedFlags[i] }); __resetRecoveryWriterStateColumnProbe(); await admin?.end() })

  test.each(['field', 'link'] as const)('actual %s old whole group and loose prune while mixed tagged fresh and floor survive', async (kind) => {
    const old = randomUUID(), mixed = randomUUID(), fresh = randomUUID()
    for (let index = 0; index < 3; index++) await fixture.insert(kind, { anchor: old })
    await fixture.insert(kind)
    const survive = [await fixture.insert(kind, { anchor: mixed }), await fixture.tagged(kind, { anchor: mixed }), await fixture.tagged(kind),
      await fixture.insert(kind, { anchor: fresh }), await fixture.insert(kind, { anchor: fresh, days: 2 }), await fixture.insert(kind, { days: 2 })]
    if (kind === 'link') { const floor = randomUUID(); survive.push(await fixture.insert(kind, { anchor: floor })); await fixture.floor(floor) }
    expect(await sweep(kind)).toBe(4)
    expect(await ids(kind)).toEqual(survive.sort())
  })

  test.each(['field', 'link'] as const)('genuine committed claim protects complete %s source and durable owner snapshot', async (kind) => {
    const rows = [await fixture.insert(kind, { anchor: randomUUID() }), await fixture.insert(kind)]
    const token = await claim(); const before = await snapshot(); calls.length = 0
    expect(await sweep(kind)).toBe(0); expect(deletes()).toEqual([]); expect(await snapshot()).toEqual(before)
    const source = (await captured(token)).source.sections[kind === 'field' ? 'field_value_tombstones' : 'link_tombstones']
    expect(source.map((row) => (row as { id: string }).id).sort()).toEqual(rows.sort())
  })

  test.each(['field', 'link'] as const)('expired genuine archiving still protects %s rows and exact owner/catalog/pin/head state', async (kind) => {
    await fixture.insert(kind, { anchor: randomUUID() }); await fixture.insert(kind)
    await claim(fixture.pool, 1); await fixture.query('SELECT pg_sleep(1.1)')
    expect((await fixture.query('SELECT recovery_writer_lease_until<clock_timestamp() AS expired FROM meta_sheets WHERE id=$1', [fixture.identity.sheetId])).rows).toEqual([{ expired: true }])
    const before = await snapshot(); calls.length = 0
    expect(await sweep(kind)).toBe(0); expect(deletes()).toEqual([]); expect(await snapshot()).toEqual(before)
  })

  test.each(['field', 'link'] as const)('genuine claim wins %s fence wait and retention inherited RR normalizes before observing committed block', async (kind) => {
    const row = await fixture.insert(kind)
    fixture.control.defaultRR = true
    const entered = barrier(), resume = barrier(), native = gatedClaim(entered, resume)
    const claimPending = claim(native.pool)
    let sweepPending: Promise<number> | undefined
    try {
      await waitBarrier(entered); sweepPending = sweep(kind)
      await waitBlocking(native.pid); resume.release(); const token = await claimPending
      expect(await sweepPending).toBe(0)
      expect(fixture.control.inherited).toEqual(['repeatable read'])
      expect(calls.slice(0, 2).map((call) => call.sql)).toEqual(['SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'SHOW transaction_isolation'])
      expect(deletes()).toEqual([]); expect(await ids(kind)).toEqual([row])
      const source = (await captured(token)).source.sections[kind === 'field' ? 'field_value_tombstones' : 'link_tombstones']
      expect(source.map((entry) => (entry as { id: string }).id)).toEqual([row])
    } finally { resume.release(); await Promise.allSettled([claimPending, ...(sweepPending ? [sweepPending] : [])]) }
  })

  test.each(['field', 'link'] as const)('retention wins %s fence and genuine claim waits until commit then capture sees post-prune source', async (kind) => {
    await fixture.insert(kind, { anchor: randomUUID() }); await fixture.insert(kind)
    const survivor = await fixture.insert(kind, { days: 2 })
    const entered = barrier(), resume = barrier(); let pid = 0
    fixture.control.hook = async (sql, params, client, execute) => {
      calls.push({ sql, params }); const result = await execute()
      if (sql.includes('pg_advisory_xact_lock') && params?.[0] === canonicalSheetFenceKey(fixture.identity.sheetId)) {
        pid = Reflect.get(client, 'processID') as number; entered.release(); await resume.promise
      }
      return result
    }
    const sweepPending = sweep(kind); let claimPending: ReturnType<typeof claim> | undefined
    try {
      await waitBarrier(entered); claimPending = claim(); await waitBlocking(pid); resume.release()
      expect(await sweepPending).toBe(2); const token = await claimPending
      expect(await ids(kind)).toEqual([survivor])
      const source = (await captured(token)).source.sections[kind === 'field' ? 'field_value_tombstones' : 'link_tombstones']
      expect(source.map((entry) => (entry as { id: string }).id)).toEqual([survivor])
    } finally { resume.release(); await Promise.allSettled([sweepPending, ...(claimPending ? [claimPending] : [])]) }
  })

  test.each(['field', 'link'] as const)('multi-sheet %s one global group and loose budget preserve whole groups larger than row batch', async (kind) => {
    const sheets = [fixture.identity.sheetId, fixture.sheetId]
    for (const sheetId of sheets) {
      const anchor = randomUUID()
      for (let index = 0; index < 3; index++) await fixture.insert(kind, { sheetId, anchor })
      for (let index = 0; index < 3; index++) await fixture.insert(kind, { sheetId })
    }
    const mixed = randomUUID(); await fixture.insert(kind, { anchor: mixed }); await fixture.tagged(kind, { anchor: mixed })
    const crossed = randomUUID(); for (const sheetId of sheets) await fixture.insert(kind, { sheetId, anchor: crossed })
    expect(await sweep(kind, fixture.query, fixture.runner, { ...config, batchSize: 1 })).toBe(4)
    const remainingGroups = (await fixture.query(`SELECT ${anchorColumn(kind)}::text AS anchor,count(*)::int AS n FROM ${tombstoneTable(kind)} WHERE ${anchorColumn(kind)} IS NOT NULL GROUP BY ${anchorColumn(kind)} ORDER BY anchor`)).rows
    expect(remainingGroups.map((group) => group.n).sort()).toEqual([2, 2, 3])
    expect((await fixture.query(`SELECT count(*)::int AS n FROM ${tombstoneTable(kind)} WHERE ${anchorColumn(kind)} IS NULL`)).rows).toEqual([{ n: 5 }])
  })

  test('link batch1 routes around the actual first floor group and prunes the other complete eligible group', async () => {
    const anchors = [randomUUID(), randomUUID()]
    for (const anchor of anchors) for (let index = 0; index < 3; index++) await fixture.insert('link', { anchor })
    // Actual native floorless initial discovery chooses the first candidate; the fixture then gives
    // that exact candidate a legitimate trash floor, so removal of initial floor filtering is load-bearing.
    const first = (await fixture.query(`SELECT g.anchor,g.sheet_id FROM (SELECT source_revision_id AS anchor,min(sheet_id) AS sheet_id,max(created_at) AS newest FROM meta_link_tombstones
      WHERE source_revision_id IS NOT NULL GROUP BY source_revision_id
      HAVING bool_and(operation_id IS NULL) AND count(DISTINCT sheet_id)=1) g
      WHERE g.newest<now()-($1::int*interval '1 day') LIMIT $2`, [30, 1])).rows[0].anchor as string
    await fixture.floor(first)
    expect(await sweep('link', fixture.query, fixture.runner, { ...config, batchSize: 1 })).toBe(3)
    expect((await fixture.query('SELECT DISTINCT source_revision_id::text AS anchor FROM meta_link_tombstones')).rows).toEqual([{ anchor: first }])
  })

  test.each((['field', 'link'] as const).flatMap((kind) => (['tagged', 'fresh', 'cross-sheet'] as const).map((drift) => ({ kind, drift }))))('fresh exact group requalification rejects legal $kind $drift drift after actual discovery', async ({ kind, drift }) => {
    const anchor = randomUUID(); await fixture.insert(kind, { anchor })
    const entered = barrier(), resume = barrier()
    const q: RetentionQueryFn = async (sql, params) => { const result = await fixture.query(sql, params); if (sql.includes('retention-admission:discover-loose')) { entered.release(); await resume.promise }; return result }
    const pending = sweep(kind, q)
    try {
      await waitBarrier(entered)
      if (drift === 'tagged') await fixture.tagged(kind, { anchor })
      else await fixture.transaction(async (query) => {
        for (const sheet of [fixture.identity.sheetId, ...(drift === 'cross-sheet' ? [fixture.sheetId] : [])].sort()) await query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(sheet)])
        await fixture.insert(kind, { anchor, days: drift === 'fresh' ? 2 : 40, sheetId: drift === 'cross-sheet' ? fixture.sheetId : fixture.identity.sheetId }, query)
      })
      const before = await snapshot(); resume.release()
      await expect(pending).resolves.toBe(0); expect(await snapshot()).toEqual(before)
    } finally { resume.release(); await Promise.allSettled([pending]) }
  })

  test('fresh link group eligibility observes actual new trash floor after initial routing', async () => {
    const anchor = randomUUID(); await fixture.insert('link', { anchor })
    const entered = barrier(), resume = barrier()
    const q: RetentionQueryFn = async (sql, params) => { const result = await fixture.query(sql, params); if (sql.includes('retention-admission:discover-loose')) { entered.release(); await resume.promise }; return result }
    const pending = sweep('link', q)
    try { await waitBarrier(entered); await fixture.floor(anchor); const before = await snapshot(); resume.release(); expect(await pending).toBe(0); expect(await snapshot()).toEqual(before) }
    finally { resume.release(); await Promise.allSettled([pending]) }
  })

  test.each(['field', 'link'] as const)('fresh %s group delete stays bound to the discovered anchor when another eligible anchor appears', async (kind) => {
    await fixture.insert(kind, { anchor: randomUUID() })
    const entered = barrier(), resume = barrier()
    const q: RetentionQueryFn = async (sql, params) => {
      const result = await fixture.query(sql, params)
      if (sql.includes('retention-admission:discover-loose')) { entered.release(); await resume.promise }
      return result
    }
    const pending = sweep(kind, q)
    try {
      await waitBarrier(entered)
      const survivor = await fixture.transaction(async (query) => {
        await query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(fixture.identity.sheetId)])
        return fixture.insert(kind, { anchor: randomUUID() }, query)
      })
      resume.release()
      await expect(pending).resolves.toBe(1)
      expect(await ids(kind)).toEqual([survivor])
    } finally { resume.release(); await Promise.allSettled([pending]) }
  })

  test.each((['field', 'link'] as const).flatMap((kind) => (['id', 'sheet', 'anchor', 'age', 'tagged replacement'] as const).map((drift) => ({ kind, drift }))))('fresh exact loose requalification rejects legal $kind $drift drift after actual discovery', async ({ kind, drift }) => {
    const id = await fixture.insert(kind)
    const entered = barrier(), resume = barrier()
    const q: RetentionQueryFn = async (sql, params) => { const result = await fixture.query(sql, params); if (sql.includes('retention-admission:discover-loose')) { entered.release(); await resume.promise }; return result }
    const pending = sweep(kind, q)
    try {
      await waitBarrier(entered)
      if (drift === 'tagged replacement') {
        await fixture.transaction(async (query) => {
          await query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(fixture.identity.sheetId)])
          await query(`DELETE FROM ${tombstoneTable(kind)} WHERE id=$1::uuid`, [id])
        })
        await fixture.tagged(kind, { id })
      } else await fixture.transaction(async (query) => {
        for (const sheet of [fixture.identity.sheetId, ...(drift === 'sheet' ? [fixture.sheetId] : [])].sort()) await query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(sheet)])
        const changed = drift === 'id' ? 'id=$2::uuid' : drift === 'sheet' ? 'sheet_id=$2' : drift === 'anchor' ? `${anchorColumn(kind)}=$2::uuid` : "created_at=clock_timestamp()-interval '2 days'"
        await query(`UPDATE ${tombstoneTable(kind)} SET ${changed} WHERE id=$1::uuid`, drift === 'age' ? [id] : [id, drift === 'sheet' ? fixture.sheetId : randomUUID()])
      })
      const before = await snapshot(); resume.release()
      await expect(pending).resolves.toBe(0); expect(await snapshot()).toEqual(before)
    } finally { resume.release(); await Promise.allSettled([pending]) }
  })

  test('actual deployment missing trash anchor uses native savepoint rollback fallback and commits eligible link group and loose', async () => {
    const stage = await createRetentionDeploymentFixture(admin, 'missing-floor')
    try {
      const anchor = randomUUID()
      await stage.query(`INSERT INTO meta_link_tombstones(sheet_id,field_id,record_id,foreign_record_id,reason,source_revision_id,created_at)
        VALUES($1,'synthetic_field','synthetic_record','synthetic_target','field_delete',$2::uuid,now()-interval '40 days'),
          ($1,'synthetic_field','synthetic_record2','synthetic_target','field_delete',NULL,now()-interval '40 days')`, [stage.sheetId, anchor])
      await expect(sweep('link', stage.query, stage.runner)).resolves.toBe(2)
      expect(stage.calls).toContain('SAVEPOINT retention_admission_floor')
      expect(stage.calls).toContain('ROLLBACK TO SAVEPOINT retention_admission_floor')
      expect(stage.calls).toContain('RELEASE SAVEPOINT retention_admission_floor')
      expect((await stage.query('SELECT count(*)::int AS n FROM meta_link_tombstones')).rows).toEqual([{ n: 0 }])
    } finally { await stage.dispose() }
  })

  test.each(['missing-operation', 'missing-table'] as const)('actual production deployment %s returns zero without guardless delete', async (mode) => {
    const stage = await createRetentionDeploymentFixture(admin, mode)
    try {
      if (mode === 'missing-operation') for (const kind of ['field', 'link'] as const) {
        const payload = kind === 'field' ? "value" : 'foreign_record_id', val = kind === 'field' ? "'{}'::jsonb" : "'synthetic_target'"
        await stage.query(`INSERT INTO ${tombstoneTable(kind)}(sheet_id,field_id,record_id,${payload},reason,created_at)
          VALUES($1,'synthetic_field','synthetic_record',${val},'field_delete',now()-interval '40 days')`, [stage.sheetId])
      }
      for (const kind of ['field', 'link'] as const) expect(await sweep(kind, stage.query, stage.runner)).toBe(0)
      expect(stage.calls.filter((sql) => /\bDELETE\s+FROM\b/i.test(sql))).toEqual([])
      if (mode === 'missing-operation') for (const kind of ['field', 'link'] as const) expect((await stage.query(`SELECT count(*)::int AS n FROM ${tombstoneTable(kind)}`)).rows).toEqual([{ n: 1 }])
    } finally { await stage.dispose() }
  })

  test('actual production deployment missing durable writer column refuses values-free with no delete', async () => {
    const stage = await createRetentionDeploymentFixture(admin, 'missing-state')
    try {
      await stage.query(`INSERT INTO meta_field_value_tombstones(sheet_id,field_id,record_id,value,reason,created_at)
        VALUES($1,'synthetic_field','synthetic_record','{}','field_delete',now()-interval '40 days')`, [stage.sheetId])
      await expect(sweep('field', stage.query, stage.runner)).rejects.toMatchObject({ code: 'TOMBSTONE_RETENTION_ADMISSION_REFUSED', message: 'TOMBSTONE_RETENTION_ADMISSION_REFUSED' })
      expect(stage.calls.filter((sql) => /\bDELETE\s+FROM\b/i.test(sql))).toEqual([])
      expect((await stage.query('SELECT count(*)::int AS n FROM meta_field_value_tombstones')).rows).toEqual([{ n: 1 }])
    } finally { await stage.dispose() }
  })

  test('actual tombstone orphan sheet routing refuses closed before delete', async () => {
    await fixture.insert('field', { sheetId: `${fixture.identity.sheetId}_absent` })
    const before = await snapshot(); calls.length = 0
    await expect(sweep('field')).rejects.toMatchObject({ code: 'TOMBSTONE_RETENTION_ADMISSION_REFUSED', message: 'TOMBSTONE_RETENTION_ADMISSION_REFUSED' })
    expect(deletes()).toEqual([]); expect(await snapshot()).toEqual(before)
  })

  test('selected native query without runner refuses before any native query or delete', async () => {
    await fixture.insert('field'); let queryCount = 0
    const q: RetentionQueryFn = (sql, params) => { queryCount++; return fixture.query(sql, params) }
    await expect(sweepFieldValueTombstoneRetention(q, config)).rejects.toMatchObject({ code: 'TOMBSTONE_RETENTION_ADMISSION_REFUSED' })
    expect(queryCount).toBe(0)
  })

  test('actual autocommit runner fails two xid probes before fence and DELETE', async () => {
    await fixture.insert('field'); const before = await snapshot(); calls.length = 0
    const runner = <T>(work: (client: { query: RetentionQueryFn }) => Promise<T>) => work({ query: async (sql, params) => { calls.push({ sql, params }); return fixture.query(sql, params) } })
    await expect(sweep('field', fixture.query, runner)).rejects.toMatchObject({ code: 'TOMBSTONE_RETENTION_ADMISSION_REFUSED' })
    expect(calls.filter((call) => call.sql.includes('pg_advisory_xact_lock'))).toEqual([])
    expect(deletes()).toEqual([]); expect(await snapshot()).toEqual(before)
  })

  test('actual driver SET RR interference makes native SHOW fail closed before xid discovery fence or delete', async () => {
    await fixture.insert('field'); const before = await snapshot(); calls.length = 0
    fixture.control.defaultRR = true
    fixture.control.hook = async (sql, params, client, execute) => {
      calls.push({ sql, params }); const result = await execute()
      if (sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED') await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      return result
    }
    await expect(sweep('field')).rejects.toMatchObject({ code: 'TOMBSTONE_RETENTION_ADMISSION_REFUSED' })
    expect(fixture.control.inherited).toEqual(['repeatable read'])
    expect(calls.map((call) => call.sql)).toEqual(['SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'SHOW transaction_isolation'])
    expect(await snapshot()).toEqual(before)
  })

  test.each([{ archive: 'false', writer: 'true' }, { archive: 'TRUE', writer: 'true' }, { archive: 'true', writer: 'TRUE' }, { archive: undefined, writer: 'true' }])('actual OFF $archive/$writer retains legacy pruning under committed claim without new TX', async ({ archive, writer }) => {
    await fixture.insert('field'); await claim()
    if (archive === undefined) delete process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED
    else process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = archive
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = writer
    let transactions = 0
    const runner = <T>(work: (client: { query: RetentionQueryFn }) => Promise<T>) => { transactions++; return fixture.runner(work) }
    expect(await sweep('field', fixture.query, runner)).toBe(1)
    expect(transactions).toBe(0); expect(calls).toEqual([])
  })

})
