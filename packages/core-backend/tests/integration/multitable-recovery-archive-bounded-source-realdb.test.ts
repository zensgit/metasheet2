import { randomUUID } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import * as core from '../../src/db/migrations/zzz20251231_create_meta_schema'
import * as bases from '../../src/db/migrations/zzzz20260318110000_add_multitable_bases_and_permissions'
import * as attachments from '../../src/db/migrations/zzzz20260319103000_create_multitable_attachments'
import * as viewConfig from '../../src/db/migrations/zzzz20260326124000_add_config_to_meta_views'
import * as autoNumber from '../../src/db/migrations/zzzz20260505110000_create_meta_field_auto_number_sequences'
import * as tombstones from '../../src/db/migrations/zzzz20260708090000_create_meta_tombstone_tables'
import * as blobPurged from '../../src/db/migrations/zzzz20260711090000_add_multitable_attachments_blob_purged_at'
import { canonicalSheetFenceKey } from '../../src/multitable/canonical-sheet-fence'
import { readRecoveryArchiveBoundedCaptureSource } from '../../src/multitable/recovery-archive-bounded-source'
import { captureRecoveryArchiveBoundedDatabaseSource } from '../../src/multitable/recovery-archive-capture-executor'
import {
  readRecoveryArchiveCaptureSource,
  type RecoveryArchiveSourceQuery,
} from '../../src/multitable/recovery-archive-relational-source'
import { dropScratchDatabase, formatScratchDropOutcome } from '../helpers/scratch-database'

const runRealDb = Boolean(process.env.DATABASE_URL) && process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const describeRealDb = runRealDb ? describe : describe.skip
test('sentinel: bounded-source real-DB step requires DATABASE_URL', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('recovery_archive_bounded_source_realdb_harness_missing_database_url')
  }
})

const PREFIX = `tm_bounded_${randomUUID().replaceAll('-', '').slice(0, 16)}`
const DATABASE = `${PREFIX}_db`
const scope = { workspaceId: `${PREFIX}_workspace`, baseId: `${PREFIX}_base`, sheetId: `${PREFIX}_sheet` }
const FIELD = `${PREFIX}_field`
const FILE_FIELD = `${PREFIX}_files`
const RECORD = `${PREFIX}_record`
const ATTACHMENT = `${PREFIX}_attachment`
const limits = { maxBytes: 1024 * 1024, timeoutMs: 10_000 }
const REFUSAL = 'RECOVERY_ARCHIVE_CAPTURE_UNAVAILABLE'
let admin: Pool | undefined
let pool: Pool
let db: Kysely<unknown> | undefined
let created = false

function queryFor(client: PoolClient): RecoveryArchiveSourceQuery {
  return (sql, params) => client.query(sql, params)
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>, isolation = 'REPEATABLE READ'): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`)
    return await work(client)
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

async function backendState(pid: number) {
  return (await admin!.query('SELECT state,xact_start IS NOT NULL AS in_transaction FROM pg_stat_activity WHERE pid=$1',
    [pid])).rows
}

async function expectBackendClosed(pid: number): Promise<void> {
  const deadline = performance.now() + 2000
  let state = await backendState(pid)
  while (state.length > 0 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    state = await backendState(pid)
  }
  expect(state).toEqual([])
}

async function seed(): Promise<void> {
  await pool.query(`INSERT INTO meta_bases (id,name,workspace_id) VALUES ($1,'Synthetic',$2)`,
    [scope.baseId, scope.workspaceId])
  await pool.query(`INSERT INTO meta_sheets (id,base_id,name) VALUES ($1,$2,'Synthetic')`, [scope.sheetId, scope.baseId])
  await pool.query(`INSERT INTO meta_fields (id,sheet_id,name,type,property,"order")
    VALUES ($1,$3,'Note','string','{}',1),($2,$3,'Files','attachment','{}',2)`, [FIELD, FILE_FIELD, scope.sheetId])
  await pool.query(`INSERT INTO meta_records (id,sheet_id,data) VALUES ($1,$2,$3::jsonb)`,
    [RECORD, scope.sheetId, JSON.stringify({ [FIELD]: 'original', [FILE_FIELD]: [ATTACHMENT] })])
  await pool.query(`INSERT INTO meta_links (id,field_id,record_id,foreign_record_id) VALUES ($1,$2,$3,$4)`,
    [`${PREFIX}_link`, FIELD, RECORD, `${PREFIX}_foreign`])
  await pool.query(`INSERT INTO meta_field_value_tombstones
    (sheet_id,field_id,record_id,value,reason,config_revision_id)
    VALUES ($1,$2,$3,'{"old":true}','field_delete',$4::uuid)`, [scope.sheetId, FIELD, RECORD, randomUUID()])
  await pool.query(`INSERT INTO meta_link_tombstones
    (sheet_id,field_id,record_id,foreign_record_id,reason,source_revision_id)
    VALUES ($1,$2,$3,$4,'record_delete',$5::uuid)`, [scope.sheetId, FIELD, RECORD, `${PREFIX}_foreign`, randomUUID()])
  await pool.query(`INSERT INTO meta_field_auto_number_sequences (field_id,sheet_id,next_value)
    VALUES ($1,$2,9007199254740993)`, [FIELD, scope.sheetId])
  await pool.query(`INSERT INTO meta_views (id,sheet_id,name,type,config)
    VALUES ($1,$2,'Synthetic','grid','{"frozen":true}')`, [`${PREFIX}_view`, scope.sheetId])
  await pool.query(`INSERT INTO multitable_attachments
    (id,sheet_id,record_id,field_id,storage_file_id,filename,mime_type,size,storage_path)
    VALUES ($1,$2,$3,$4,$5,'synthetic','application/octet-stream',7,$6)`,
  [ATTACHMENT, scope.sheetId, RECORD, FILE_FIELD, `${PREFIX}_storage`, `${PREFIX}_opaque`])
  // Deleted, unreferenced metadata is still captured rather than silently omitted.
  await pool.query(`INSERT INTO multitable_attachments
    (id,sheet_id,storage_file_id,filename,mime_type,size,storage_path,deleted_at,blob_purged_at)
    VALUES ($1,$2,$3,'synthetic','application/octet-stream',9007199254740993,$4,now(),now())`,
  [`${ATTACHMENT}_deleted`, scope.sheetId, `${PREFIX}_deleted_storage`, `${PREFIX}_deleted_opaque`])
}

describeRealDb('D-H2 bounded RR source prerequisite (real DB)', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
    await admin.query(`CREATE DATABASE "${DATABASE}"`)
    created = true
    const url = new URL(process.env.DATABASE_URL!)
    url.pathname = `/${DATABASE}`
    pool = new Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 100 })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    for (const migration of [core, bases, attachments, viewConfig, autoNumber, tombstones, blobPurged]) {
      await migration.up(db)
    }
  })

  beforeEach(async () => {
    await pool.query(`TRUNCATE multitable_attachments,meta_link_tombstones,meta_field_value_tombstones,
      meta_field_auto_number_sequences,meta_links,meta_records,meta_views,meta_fields,meta_sheets,meta_bases`)
    await seed()
  })

  afterAll(async () => {
    try {
      await db?.destroy()
      if (created && admin) {
        const outcome = await dropScratchDatabase(admin, DATABASE)
        console.log(formatScratchDropOutcome('recovery-archive-bounded-source', outcome))
        expect(outcome.forced).toBe(false)
        expect(outcome.residualBackends).toBe(0)
        const remaining = await admin.query(`SELECT
          (SELECT count(*)::int FROM pg_database WHERE datname=$1) AS databases,
          (SELECT count(*)::int FROM pg_stat_activity WHERE datname=$1) AS connections`, [DATABASE])
        expect(remaining.rows).toEqual([{ databases: 0, connections: 0 }])
      }
    } finally { await admin?.end() }
  })

  test('matches the canonical one-query reader for all seven populated sections and attachment metadata', async () => {
    await inTransaction(async (client) => {
      const expected = await readRecoveryArchiveCaptureSource(queryFor(client), scope)
      expect(Object.keys(expected.sections)).toHaveLength(7)
      for (const rows of Object.values(expected.sections)) expect(rows.length).toBeGreaterThan(0)
      expect(expected.attachmentCandidates).toHaveLength(2)
      expect(expected.sections.auto_number).toEqual([{ field_id: FIELD, next_value: '9007199254740993' }])
      expect(await readRecoveryArchiveBoundedCaptureSource(queryFor(client), scope, limits)).toEqual(expected)
    })
  })

  test('distinguishes a proven empty sheet from missing and cross-scope sheets', async () => {
    const empty = `${PREFIX}_empty`
    await pool.query(`INSERT INTO meta_sheets (id,base_id,name) VALUES ($1,$2,'Empty')`, [empty, scope.baseId])
    await inTransaction(async (client) => {
      const query = queryFor(client)
      const emptyScope = { ...scope, sheetId: empty }
      const actual = await readRecoveryArchiveBoundedCaptureSource(query, emptyScope, limits)
      expect(actual).toEqual({ sections: { schema: [], records: [], links: [], field_value_tombstones: [],
        link_tombstones: [], auto_number: [], views_config: [] }, attachmentCandidates: [] })
      for (const wrong of [{ ...scope, sheetId: `${PREFIX}_missing` },
        { ...scope, baseId: `${PREFIX}_other_base` }, { ...scope, workspaceId: `${PREFIX}_other_workspace` }]) {
        await expect(readRecoveryArchiveBoundedCaptureSource(query, wrong, limits)).rejects.toThrow(REFUSAL)
      }
    })
  })

  test('withholds an oversized individual row in SQL before payload transfer', async () => {
    const secret = 'synthetic-private-value'.repeat(4096)
    await pool.query(`UPDATE meta_records SET data=$2::jsonb WHERE id=$1`,
      [RECORD, JSON.stringify({ [FIELD]: secret, [FILE_FIELD]: [ATTACHMENT] })])
    await inTransaction(async (client) => {
      const returned: unknown[] = []
      const query: RecoveryArchiveSourceQuery = async (sql, params) => {
        const result = await client.query(sql, params)
        if (sql.includes('meta_records')) returned.push(...result.rows)
        return result
      }
      await expect(readRecoveryArchiveBoundedCaptureSource(query, scope, { ...limits, maxBytes: 4096 }))
        .rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_BYTES_EXCEEDED', message: 'RECOVERY_ARCHIVE_CAPTURE_BYTES_EXCEEDED' })
      expect(returned.length).toBeGreaterThan(0)
      expect(returned.some((row) => {
        const value = row as { payload?: unknown; entity_key?: unknown; payload_bytes?: number }
        return value.payload === null && value.entity_key === null && Number(value.payload_bytes) > 4096
      })).toBe(true)
      expect(JSON.stringify(returned)).not.toContain(secret)
    })
  })

  test('refuses a cumulative byte budget even when every individual row fits', async () => {
    await pool.query(`INSERT INTO meta_records (id,sheet_id,data)
      SELECT $1||ordinal::text,$2,jsonb_build_object($3::text,repeat('x',700)) FROM generate_series(1,8) ordinal`,
    [`${PREFIX}_extra_`, scope.sheetId, FIELD])
    await inTransaction(async (client) => {
      const observed: { payload: string | null; payload_bytes: number }[] = []
      const query: RecoveryArchiveSourceQuery = async (sql, params) => {
        const result = await client.query(sql, params)
        for (const row of result.rows) if (typeof row.payload_bytes === 'number') observed.push(row)
        return result
      }
      await expect(readRecoveryArchiveBoundedCaptureSource(query, scope, { ...limits, maxBytes: 4096 }))
        .rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_BYTES_EXCEEDED' })
      expect(observed.every((row) => row.payload_bytes < 4096)).toBe(true)
      expect(observed.at(-1)?.payload).toBeNull()
      expect(observed.reduce((sum, row) => sum + row.payload_bytes, 0)).toBeGreaterThan(4096)
      expect(observed.filter((row) => row.payload !== null).reduce((sum, row) => sum + row.payload_bytes, 0)).toBeLessThanOrEqual(4096)
    })
    await inTransaction(async (client) => {
      const actual = await readRecoveryArchiveBoundedCaptureSource(queryFor(client), scope, limits)
      expect(actual.sections.records).toHaveLength(9)
    })
  })

  test('cancels a real blocked source query at its elapsed-time limit with values-free refusal', async () => {
    const blocker = await pool.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE meta_records IN ACCESS EXCLUSIVE MODE')
      let sqlState: unknown
      const started = performance.now()
      await inTransaction(async (client) => {
        const query: RecoveryArchiveSourceQuery = async (sql, params) => {
          try { return await client.query(sql, params) } catch (error) {
            // Cleanup may encounter 25P02 after cancellation; retain the causal database error.
            sqlState ??= (error as { code?: string }).code
            throw error
          }
        }
        await expect(readRecoveryArchiveBoundedCaptureSource(query, scope, { ...limits, timeoutMs: 500 }))
          .rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED', message: 'RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED' })
      })
      expect(sqlState).toBe('57014')
      expect(performance.now() - started).toBeLessThan(5000)
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
    }
  })

  test('refuses READ COMMITTED and autocommit rather than treating either as a stable RR transaction', async () => {
    await inTransaction(async (client) => {
      await expect(readRecoveryArchiveBoundedCaptureSource(queryFor(client), scope, limits))
        .rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_TRANSACTION_REQUIRED' })
    }, 'READ COMMITTED')
    const client = await pool.connect()
    try {
      await client.query("SET default_transaction_isolation = 'repeatable read'")
      await expect(readRecoveryArchiveBoundedCaptureSource(queryFor(client), scope, limits))
        .rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_TRANSACTION_REQUIRED' })
    } finally {
      await client.query('RESET default_transaction_isolation')
      client.release()
    }
  })

  test('refuses a real transaction replacement midway through capture', async () => {
    await inTransaction(async (client) => {
      let replaced = false
      let previousXid: string | undefined
      let replacementXid: string | undefined
      const query: RecoveryArchiveSourceQuery = async (sql, params) => {
        if (!replaced && sql.includes('meta_records')) {
          replaced = true
          previousXid = (await client.query('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid
          await client.query('COMMIT')
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
          replacementXid = (await client.query('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid
        }
        return client.query(sql, params)
      }
      await expect(readRecoveryArchiveBoundedCaptureSource(query, scope, limits))
        .rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_TRANSACTION_REQUIRED' })
      expect(replaced).toBe(true)
      expect(previousXid).toMatch(/^[0-9]+$/)
      expect(replacementXid).toMatch(/^[0-9]+$/)
      expect(replacementXid).not.toBe(previousXid)
    })
  })

  test.each(['success', 'byte refusal'] as const)('restores the caller statement timeout after %s', async (outcome) => {
    await inTransaction(async (client) => {
      await client.query("SET LOCAL statement_timeout = '4321ms'")
      const before = (await client.query('SHOW statement_timeout')).rows
      if (outcome === 'success') {
        await readRecoveryArchiveBoundedCaptureSource(queryFor(client), scope, limits)
      } else {
        await expect(readRecoveryArchiveBoundedCaptureSource(queryFor(client), scope, { ...limits, maxBytes: 1 }))
          .rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_BYTES_EXCEEDED' })
      }
      expect((await client.query('SHOW statement_timeout')).rows).toEqual(before)
    })
  })

  test('keeps the RR snapshot after a concurrent writer commits and holds no canonical fence', async () => {
    const reached = barrier()
    const resume = barrier()
    let paused = false
    const expected = await readRecoveryArchiveCaptureSource((sql, params) => pool.query(sql, params), scope)
    const capture = inTransaction(async (client) => {
      const query: RecoveryArchiveSourceQuery = async (sql, params) => {
        expect(sql).not.toMatch(/pg_advisory_(?:xact_)?lock\s*\(/)
        if (!paused && sql.includes('meta_records')) {
          paused = true
          reached.release()
          await resume.promise
        }
        return client.query(sql, params)
      }
      return readRecoveryArchiveBoundedCaptureSource(query, scope, limits)
    })
    // If capture fails before reaching the barrier, propagate instead of waiting forever.
    await Promise.race([reached.promise, capture.then(() => { throw new Error('SOURCE_BARRIER_NOT_REACHED') })])
    try {
      const writer = await pool.connect()
      try {
        await writer.query('BEGIN')
        const fence = await writer.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired',
          [canonicalSheetFenceKey(scope.sheetId)])
        expect(fence.rows).toEqual([{ acquired: true }])
        await writer.query(`UPDATE meta_records SET data=data||jsonb_build_object($2::text,'committed') WHERE id=$1`, [RECORD, FIELD])
        await writer.query(`UPDATE meta_views SET config='{"frozen":false}' WHERE sheet_id=$1`, [scope.sheetId])
        await writer.query('COMMIT')
      } finally {
        await writer.query('ROLLBACK')
        writer.release()
      }
    } finally { resume.release() }
    expect(await capture).toEqual(expected)
    const fresh = await readRecoveryArchiveCaptureSource((sql, params) => pool.query(sql, params), scope)
    expect(fresh.sections.records).not.toEqual(expected.sections.records)
    expect(fresh.sections.views_config).not.toEqual(expected.sections.views_config)
  })

  test('proves the canonical fence excludes an independent connection until rollback', async () => {
    await inTransaction(async (holder) => {
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(scope.sheetId)])
      await inTransaction(async (contender) => {
        const result = await contender.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired',
          [canonicalSheetFenceKey(scope.sheetId)])
        expect(result.rows).toEqual([{ acquired: false }])
      })
    })
    await inTransaction(async (contender) => {
      const result = await contender.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired',
        [canonicalSheetFenceKey(scope.sheetId)])
      expect(result.rows).toEqual([{ acquired: true }])
    })
  })

  test('returns wrapper parity only after COMMIT and releases an idle healthy connection', async () => {
    const expected = await readRecoveryArchiveCaptureSource((sql, params) => pool.query(sql, params), scope)
    let pid = 0
    let nativeClient: PoolClient | undefined
    const releases: (boolean | undefined)[] = []
    const adapter = {
      options: pool.options,
      connect: async () => {
        const native = await pool.connect()
        nativeClient = native
        pid = (await native.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        return {
          query: async (sql: string, params: unknown[]) => {
            if (sql.startsWith('SELECT pg_current_xact_id()')) {
              expect((await native.query('SHOW transaction_read_only')).rows).toEqual([{ transaction_read_only: 'on' }])
            }
            return native.query(sql, params)
          },
          release: (destroy?: boolean) => { releases.push(destroy); native.release(destroy) },
        }
      },
    } as unknown as Pick<Pool, 'connect' | 'options'>
    try {
      expect(await captureRecoveryArchiveBoundedDatabaseSource(adapter, scope, limits)).toEqual(expected)
      expect(releases).toEqual([undefined])
      expect(await backendState(pid)).toEqual([{ state: 'idle', in_transaction: false }])
    } finally {
      if (releases.length === 0) nativeClient?.release(true)
    }
  })

  test('discards the wrapper connection when a real source query is blocked past the deadline', async () => {
    const blocker = await pool.connect()
    let pid = 0
    let nativeClient: PoolClient | undefined
    const releases: (boolean | undefined)[] = []
    let sourceSent = false
    const adapter = {
      options: pool.options,
      connect: async () => {
        const native = await pool.connect()
        nativeClient = native
        pid = (await native.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        return {
          query: (sql: string, params: unknown[]) => {
            if (sql.includes('meta_records')) sourceSent = true
            return native.query(sql, params)
          },
          release: (destroy?: boolean) => { releases.push(destroy); native.release(destroy) },
        }
      },
    } as unknown as Pick<Pool, 'connect' | 'options'>
    try {
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE meta_records IN ACCESS EXCLUSIVE MODE')
      await expect(captureRecoveryArchiveBoundedDatabaseSource(adapter, scope, { ...limits, timeoutMs: 300 }))
        .rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED' })
      expect(sourceSent).toBe(true)
      expect(releases).toEqual([true])
      await expectBackendClosed(pid)
    } finally {
      if (releases.length === 0) nativeClient?.release(true)
      await blocker.query('ROLLBACK')
      blocker.release()
    }
  })

  test.each(['prelude', 'timeout install', 'source', 'restoration', 'COMMIT'] as const)(
    'discards the real transaction after stalled %s transport and refuses late SQL', async (stage) => {
      const reached = barrier()
      const resume = barrier()
      let pid = 0
      let nativeClient: PoolClient | undefined
      let paused = false
      let nativeQueries = 0
      const releases: (boolean | undefined)[] = []
      const adapter = {
        options: pool.options,
        connect: async () => {
          const native = await pool.connect()
          nativeClient = native
          pid = (await native.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
          return {
            query: async (sql: string, params: unknown[]) => {
              const matches = stage === 'prelude' ? sql.startsWith('SELECT pg_current_xact_id()')
                : stage === 'timeout install' ? sql.includes("set_config('statement_timeout'")
                  : stage === 'source' ? sql.includes('meta_records')
                    : stage === 'restoration' ? sql.includes("set_config('statement_timeout'") && params[0] === '0'
                      : sql === 'COMMIT'
              if (!paused && matches) {
                paused = true
                // Hold COMMIT before sending it so the actual backend retains its RR transaction.
                const result = sql === 'COMMIT' ? { rows: [] } : await native.query(sql, params)
                if (sql !== 'COMMIT') nativeQueries += 1
                reached.release()
                await resume.promise
                return result
              }
              nativeQueries += 1
              return native.query(sql, params)
            },
            release: (destroy?: boolean) => { releases.push(destroy); native.release(destroy) },
          }
        },
      } as unknown as Pick<Pool, 'connect' | 'options'>
      let returnedSnapshot = false
      const capture = captureRecoveryArchiveBoundedDatabaseSource(adapter, scope, { ...limits, timeoutMs: 500 })
        .then((value) => { returnedSnapshot = true; return value })
      const refusal = expect(capture).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED' })
      try {
        await Promise.race([reached.promise, capture.then(() => { throw new Error('TRANSPORT_BARRIER_NOT_REACHED') })])
        expect(await backendState(pid)).toEqual([{ state: 'idle in transaction', in_transaction: true }])
        await refusal
        expect(releases).toEqual([true])
        await expectBackendClosed(pid)
        const sentAtDeadline = nativeQueries
        resume.release()
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(nativeQueries).toBe(sentAtDeadline)
        expect(releases).toEqual([true])
        expect(returnedSnapshot).toBe(false)
      } finally {
        resume.release()
        if (releases.length === 0) nativeClient?.release(true)
      }
    },
  )

  test('discards a late acquired real client without BEGIN or source SQL', async () => {
    const native = await pool.connect()
    const pid = (await native.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const acquired = barrier()
    const releases: (boolean | undefined)[] = []
    let nativeQueries = 0
    const adapter = {
      options: pool.options,
      connect: async () => {
        await acquired.promise
        return {
          query: (sql: string, params: unknown[]) => { nativeQueries += 1; return native.query(sql, params) },
          release: (destroy?: boolean) => { releases.push(destroy); native.release(destroy) },
        }
      },
    } as unknown as Pick<Pool, 'connect' | 'options'>
    try {
      await expect(captureRecoveryArchiveBoundedDatabaseSource(adapter, scope, { ...limits, timeoutMs: 100 }))
        .rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED' })
      expect(releases).toEqual([])
      expect(await backendState(pid)).toEqual([{ state: 'idle', in_transaction: false }])
      acquired.release()
      const deadline = performance.now() + 2000
      while (releases.length === 0 && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(releases).toEqual([true])
      expect(nativeQueries).toBe(0)
      await expectBackendClosed(pid)
    } finally {
      acquired.release()
      if (releases.length === 0) native.release(true)
    }
  })

  test('native acquisition timeout removes its queued waiter while preserving the independent owner', async () => {
    const dedicated = new Pool({ connectionString: pool.options.connectionString, max: 1, connectionTimeoutMillis: 100 })
    const owner = await dedicated.connect()
    const pid = (await owner.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    try {
      const started = performance.now()
      const capture = captureRecoveryArchiveBoundedDatabaseSource(dedicated, scope, { ...limits, timeoutMs: 1000 })
      const refusal = expect(capture).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_UNAVAILABLE' })
      expect(dedicated.waitingCount).toBe(1)
      await refusal
      expect(performance.now() - started).toBeLessThan(800)
      expect(dedicated.waitingCount).toBe(0)
      expect(dedicated.totalCount).toBe(1)
      expect(await backendState(pid)).toEqual([{ state: 'idle', in_transaction: false }])
      expect((await owner.query('SELECT 1 AS usable')).rows).toEqual([{ usable: 1 }])
    } finally {
      owner.release()
      await dedicated.end()
      await expectBackendClosed(pid)
    }
  })

  test('native acquisition timeout closes an accepted synthetic connection with a stalled PostgreSQL handshake', async () => {
    const sockets = new Set<Socket>()
    let accepted = 0
    let closed = 0
    const server = createServer((socket) => {
      accepted += 1
      sockets.add(socket)
      socket.on('error', () => {})
      socket.on('close', () => { closed += 1; sockets.delete(socket) })
      socket.on('data', () => {})
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('SYNTHETIC_HANDSHAKE_ADDRESS_UNAVAILABLE')
    const dedicated = new Pool({ host: '127.0.0.1', port: address.port, database: DATABASE,
      user: 'synthetic', password: 'synthetic', max: 1, ssl: false, connectionTimeoutMillis: 100 })
    try {
      const started = performance.now()
      await expect(captureRecoveryArchiveBoundedDatabaseSource(dedicated, scope, { ...limits, timeoutMs: 1000 }))
        .rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_UNAVAILABLE' })
      expect(performance.now() - started).toBeLessThan(800)
      expect(accepted).toBe(1)
      expect(dedicated.totalCount).toBe(0)
      expect(dedicated.waitingCount).toBe(0)
      const deadline = performance.now() + 2000
      while (sockets.size > 0 && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(closed).toBe(1)
      expect(sockets.size).toBe(0)
    } finally {
      for (const socket of sockets) socket.destroy()
      await dedicated.end()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  test.each(['canonical', 'unrelated'] as const)('refuses a transaction already holding a %s advisory fence', async (kind) => {
    await inTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
        [kind === 'canonical' ? canonicalSheetFenceKey(scope.sheetId) : `${PREFIX}_unrelated`])
      await expect(readRecoveryArchiveBoundedCaptureSource(queryFor(client), scope, limits))
        .rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_FENCE_HELD' })
    })
  })
})
