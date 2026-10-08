import { randomUUID } from 'node:crypto'

import { Pool, type PoolClient, type QueryResult } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { __resetRecoveryWriterStateColumnProbe, acquireCanonicalSheetFence, fenceWriterEntry } from '../../src/multitable/canonical-sheet-fence'
import { bindRecoveryArchiveOwnedClaim, readRecoveryArchiveCommittedClaim, type RecoveryArchiveCommittedClaim } from '../../src/multitable/recovery-archive-owned-claim'
import { bindRecoveryArchiveOwnedCapture, readRecoveryArchiveCapturedSource, type RecoveryArchiveCapturedSource } from '../../src/multitable/recovery-archive-owned-capture'
import { readRecoveryArchiveCaptureSource } from '../../src/multitable/recovery-archive-relational-source'
import { consumeRecoveryArchiveBootstrapReservations } from '../../src/multitable/recovery-archive-section-bootstrap'
import { SECTION_CAUSALITY_DATA_SECTION_KINDS, type SealQuery } from '../../src/multitable/recovery-archive-seals'
import { claimRecoveryArchiveSourcePinIntent, verifyRecoveryArchiveSourcePin } from '../../src/multitable/recovery-archive-source-pin'
import { heartbeatArchiveWriterBlock, releaseArchiveWriterBlock } from '../../src/multitable/recovery-archive-writer-block'
import { createOwnedCaptureFixture, type OwnedCaptureFixture } from '../utils/recovery-archive-owned-capture-fixture'

const armed = process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const describeRealDb = armed && process.env.DATABASE_URL ? describe : describe.skip
test('sentinel: owned-capture real-DB lane requires DATABASE_URL', () => {
  if (armed && !process.env.DATABASE_URL) throw new Error('recovery_archive_owned_capture_realdb_harness_missing_database_url')
})
const limits = { maxBytes: 1024 * 1024, timeoutMs: 10_000 }
const unavailable = { code: 'RECOVERY_ARCHIVE_CAPTURE_UNAVAILABLE', message: 'RECOVERY_ARCHIVE_CAPTURE_UNAVAILABLE' }
const burned = { code: 'RECOVERY_ARCHIVE_CLAIM_CAPABILITY_UNAVAILABLE', message: 'RECOVERY_ARCHIVE_CLAIM_CAPABILITY_UNAVAILABLE' }
let admin: Pool
let fixture: OwnedCaptureFixture
let savedFlags: (string | undefined)[]
const flags = ['MULTITABLE_ENABLE_WRITER_FENCE', 'MULTITABLE_RECOVERY_ARCHIVE_ENABLED']

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}
type Hook = (sql: string, params: unknown[] | undefined, execute: (replacement?: string, replacementParams?: unknown[]) => Promise<QueryResult>) => Promise<QueryResult>
function nativePool(hook: Hook, onRelease?: (discarded: unknown) => void, onConnect?: (pid: number) => void): Pick<Pool, 'connect' | 'options'> {
  const connect = async () => {
    const client = await fixture.pool.connect()
    onConnect?.(Reflect.get(client, 'processID') as number)
    const query = client.query.bind(client)
    return new Proxy(client, { get(target, member) {
      if (member === 'query') return (sql: string, params?: unknown[]) => hook(sql, params,
        (replacement, replacementParams) => query(replacement ?? sql, replacementParams ?? params))
      if (member === 'release') return (discarded?: boolean) => { onRelease?.(discarded); client.release(discarded) }
      const value = Reflect.get(target, member)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }
  return { options: fixture.pool.options, connect: connect as Pool['connect'] }
}
const authorize: Parameters<typeof bindRecoveryArchiveOwnedCapture>[1] = async (query, identity) => {
  const result = await query(`SELECT 1 FROM meta_bases WHERE id=$1 AND owner_id=$2`, [identity.baseId, identity.actorId])
  return result.rows.length === 1
}
function capture(pool: Pick<Pool, 'connect' | 'options'> = fixture.pool, budget = limits,
  auth = authorize) { return bindRecoveryArchiveOwnedCapture(pool, auth, budget) }
async function claim(leaseSeconds = 60): Promise<RecoveryArchiveCommittedClaim> {
  const run = bindRecoveryArchiveOwnedClaim(fixture.pool, authorize,
    { keyId: fixture.keyId, keyRowVersion: '1', leaseSeconds, expiresAfterSeconds: 3600 }, limits)
  return (await run(fixture.identity)).claim!
}
function read(token: unknown) { return readRecoveryArchiveCapturedSource(token as RecoveryArchiveCapturedSource) }
async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await fixture.pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    const value = await work(client)
    await client.query('COMMIT')
    return value
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
  finally { client.release() }
}
const runner = <T>(work: (query: SealQuery) => Promise<T>) => transaction((client) => work((sql, params) => client.query(sql, params)))
async function source() { return readRecoveryArchiveCaptureSource((sql, params) => fixture.pool.query(sql, params), fixture.identity) }
async function counts() {
  return (await fixture.pool.query(`SELECT (SELECT count(*)::int FROM meta_recovery_archives) AS generations,
    (SELECT count(*)::int FROM meta_recovery_archive_snapshot_reservations) AS reservations,
    (SELECT count(*)::int FROM meta_recovery_archive_manual_requests) AS requests,
    (SELECT count(*)::int FROM meta_recovery_archive_attachment_refs) AS pins`)).rows[0]
}
async function rejectedThenBurned(token: RecoveryArchiveCommittedClaim) {
  const before = await counts()
  let sourceQueries = 0
  const pool = nativePool((sql, _params, execute) => {
    if (sql.includes('candidate AS') && sql.includes('meta_records')) sourceQueries += 1
    return execute()
  })
  await expect(capture(pool)(token)).rejects.toMatchObject(unavailable)
  expect(sourceQueries).toBe(0)
  await expect(capture()(token)).rejects.toMatchObject(burned)
  expect(await counts()).toEqual(before)
}

describeRealDb('D-H2 fresh RR owned capture (real DB)', () => {
  beforeAll(() => {
    admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 500 })
    savedFlags = flags.map((flag) => process.env[flag])
  })
  beforeEach(async () => {
    fixture = await createOwnedCaptureFixture(admin)
    flags.forEach((flag) => { process.env[flag] = 'true' })
    __resetRecoveryWriterStateColumnProbe()
  })
  afterEach(async () => { await fixture?.dispose() })
  afterAll(async () => {
    flags.forEach((flag, index) => {
      if (savedFlags[index] === undefined) delete process.env[flag]
      else process.env[flag] = savedFlags[index]
    })
    __resetRecoveryWriterStateColumnProbe()
    await admin?.end()
  })

  test('captures all seven populated sections and immutable local descriptors under one read-only xid, without locks', async () => {
    await fixture.populate()
    const token = await claim()
    const binding = readRecoveryArchiveCommittedClaim(token)
    const expected = await source()
    const before = await counts()
    const xids: string[] = []
    const authorityRows: unknown[] = []
    let inTransaction = false
    const releases: unknown[] = []
    const result = await capture(nativePool(async (sql, _params, execute) => {
      if (sql.startsWith('BEGIN')) inTransaction = true
      if (inTransaction) {
        expect(sql).not.toMatch(/pg_advisory_(?:xact_)?lock\s*\(|FOR\s+(?:UPDATE|SHARE)\b/i)
        expect(sql).not.toMatch(/^\s*(?:INSERT|UPDATE|DELETE|ALTER|CREATE|TRUNCATE)\b/i)
      }
      const rows = await execute()
      for (const row of rows.rows) if (typeof row.xid === 'string') xids.push(row.xid)
      if (/owned-capture:(?:binding|heads|reservations|pins)/.test(sql)) authorityRows.push(...rows.rows)
      if (sql === 'COMMIT') inTransaction = false
      return rows
    }, (value) => { releases.push(value) }))(token)
    const snapshot = read(result)
    expect(snapshot.claim).toEqual(binding)
    expect(snapshot.source).toEqual(expected)
    expect(Object.keys(snapshot.source.sections)).toHaveLength(7)
    for (const rows of Object.values(snapshot.source.sections)) expect(rows.length).toBeGreaterThan(0)
    expect(snapshot.attachmentDescriptors).toEqual(fixture.descriptors)
    expect(snapshot.source.sections.auto_number).toEqual([{ field_id: fixture.noteField, next_value: '9007199254740993' }])
    expect(snapshot.snapshotXid).toMatch(/^[1-9][0-9]*$/)
    expect(new Set(xids)).toEqual(new Set([snapshot.snapshotXid]))
    expect(authorityRows.length).toBeGreaterThan(4)
    for (const row of authorityRows) expect(row).toEqual({ xid: snapshot.snapshotXid, matches: true })
    expect(releases).toEqual([undefined])
    expect(await counts()).toEqual(before)
    expect(Object.isFrozen(snapshot.source.sections)).toBe(true)
    expect(Object.isFrozen(snapshot.attachmentDescriptors)).toBe(true)
    expect(read(result)).not.toBe(snapshot)
    expect(read(result)).toEqual(snapshot)
    for (const forged of [{}, { ...result }, structuredClone(result), structuredClone(snapshot)]) {
      expect(() => read(forged)).toThrow('RECOVERY_ARCHIVE_CAPTURE_UNAVAILABLE')
    }
    await expect(capture()(token)).rejects.toMatchObject(burned)
  })

  test('captures a genuine empty sheet with null head, zero pins, and ten future bootstrap reservations', async () => {
    const token = await claim()
    const result = read(await capture()(token))
    expect(result.claim.observedHeads).toEqual({ operationHead: null, sectionHeads: [] })
    expect(result.claim.repeat).toBe(false)
    expect(result.source).toEqual({ sections: { schema: [], records: [], links: [], field_value_tombstones: [],
      link_tombstones: [], auto_number: [], views_config: [] }, attachmentCandidates: [] })
    expect(result.attachmentDescriptors).toEqual([])
    expect(await counts()).toEqual({ generations: 1, reservations: 10, requests: 1, pins: 0 })
  })

  test('private DTO, clone and forged claims refuse before acquiring a native connection', async () => {
    const token = await claim()
    let acquisitions = 0
    const pool = nativePool((_sql, _params, execute) => execute(), undefined, () => { acquisitions += 1 })
    for (const fake of [{}, { ...token }, structuredClone(token), readRecoveryArchiveCommittedClaim(token), null]) {
      await expect(capture(pool)(fake as RecoveryArchiveCommittedClaim)).rejects.toMatchObject(burned)
    }
    expect(acquisitions).toBe(0)
    expect(read(await capture()(token)).claim).toEqual(readRecoveryArchiveCommittedClaim(token))
  })

  test('concurrent attempts burn before the first await and allow only one actual RR capture', async () => {
    const token = await claim()
    let acquisitions = 0
    const run = capture(nativePool((_sql, _params, execute) => execute(), undefined, () => { acquisitions += 1 }))
    const results = await Promise.allSettled([run(token), run(token)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const failed = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(failed.reason).toMatchObject(burned)
    expect(acquisitions).toBe(1)
  })

  test('claim COMMIT precedes the first fresh RR snapshot, while a pre-claim old snapshot cannot be silently accepted', async () => {
    await fixture.populate()
    const old = await fixture.pool.connect()
    let released = false
    try {
      await old.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const oldXid = (await old.query('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid
      expect((await old.query('SELECT count(*)::int AS count FROM meta_recovery_archives')).rows).toEqual([{ count: 0 }])
      await transaction(async (writer) => {
        await fenceWriterEntry((sql, params) => writer.query(sql, params), fixture.identity.sheetId)
        await writer.query(`UPDATE meta_records SET data=data||jsonb_build_object($2::text,'before-claim-commit') WHERE id=$1`,
          [fixture.recordId, fixture.noteField])
        await fixture.addHead(writer)
      })
      const token = await claim()
      expect((await old.query('SELECT count(*)::int AS count FROM meta_recovery_archives')).rows).toEqual([{ count: 0 }])
      expect((await fixture.pool.query('SELECT count(*)::int AS count FROM meta_recovery_archives')).rows).toEqual([{ count: 1 }])
      const reused = new Proxy(old, { get(target, member) {
        if (member === 'release') return (discarded?: boolean) => { released = true; old.release(discarded) }
        const value = Reflect.get(target, member)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      const connect = async () => reused
      const outcome = await capture({ options: fixture.pool.options, connect: connect as Pool['connect'] })(token)
        .then((value) => ({ value }), (error: unknown) => ({ error }))
      expect('value' in outcome).toBe(true)
      if ('value' in outcome) {
        expect(read(outcome.value).snapshotXid).not.toBe(oldXid)
        expect(read(outcome.value).claim).toEqual(readRecoveryArchiveCommittedClaim(token))
        expect(read(outcome.value).source).toEqual(await source())
      }
    } finally {
      if (!released) { await old.query('ROLLBACK'); old.release() }
    }
  })

  test('holds the captured token until actual RR COMMIT acknowledgement and healthy release', async () => {
    const token = await claim()
    const reached = barrier()
    const resume = barrier()
    let settled = false
    const releases: unknown[] = []
    const pending = capture(nativePool(async (sql, _params, execute) => {
      if (sql === 'COMMIT') { reached.release(); await resume.promise }
      return execute()
    }, (value) => { releases.push(value) }))(token).then((value) => { settled = true; return value })
    try {
      await Promise.race([reached.promise, pending.then(() => { throw new Error('owned_capture_commit_barrier_not_reached') })])
      expect(settled).toBe(false)
      expect(releases).toEqual([])
      expect(await counts()).toEqual({ generations: 1, reservations: 10, requests: 1, pins: 0 })
    } finally { resume.release() }
    expect(read(await pending).source.attachmentCandidates).toEqual([])
    expect(releases).toEqual([undefined])
  })

  test('lost actual RR COMMIT acknowledgement returns no captured capability and permanently burns the claim', async () => {
    const token = await claim()
    let commits = 0
    await expect(capture(nativePool(async (sql, _params, execute) => {
      const value = await execute()
      if (sql === 'COMMIT') { commits += 1; throw new Error('synthetic_rr_ack_lost') }
      return value
    }))(token)).rejects.toMatchObject(unavailable)
    expect(commits).toBe(1)
    await expect(capture()(token)).rejects.toMatchObject(burned)
  })

  test.each(['owner ACL', 'workspace', 'deleted sheet', 'deleted base', 'retiring key', 'abandoned generation', 'superseded checkpoint'])(
    'refuses legal %s drift before source transfer and never revives a burned claim', async (mode) => {
      const token = await claim()
      if (mode === 'owner ACL') await fixture.pool.query('UPDATE meta_bases SET owner_id=$2 WHERE id=$1', [fixture.identity.baseId, randomUUID()])
      if (mode === 'workspace') await fixture.pool.query('UPDATE meta_bases SET workspace_id=$2 WHERE id=$1', [fixture.identity.baseId, `${fixture.identity.workspaceId}_other`])
      if (mode === 'deleted sheet') await fixture.pool.query('UPDATE meta_sheets SET deleted_at=clock_timestamp() WHERE id=$1', [fixture.identity.sheetId])
      if (mode === 'deleted base') await fixture.pool.query('UPDATE meta_bases SET deleted_at=clock_timestamp() WHERE id=$1', [fixture.identity.baseId])
      if (mode === 'retiring key') await fixture.pool.query(`UPDATE meta_recovery_archive_keys SET state='retiring',row_version=row_version+1 WHERE key_id=$1`, [fixture.keyId])
      if (mode === 'abandoned generation') await fixture.pool.query(`UPDATE meta_recovery_archives SET build_status='abandoned'
        WHERE generation_id=$1::uuid`, [readRecoveryArchiveCommittedClaim(token).generationOwner.generationId])
      if (mode === 'superseded checkpoint') await fixture.pool.query(`UPDATE meta_history_trust_checkpoints SET state='superseded' WHERE id=$1`, [fixture.checkpointId])
      await rejectedThenBurned(token)
    },
  )

  test.each(['generation', 'reservation'])('exact raw %s timestamp rejects a genuine claim despite equal UTC millisecond display', async (variant) => {
    let shifted = 0
    const pool = nativePool((sql, _params, execute) => {
      if (sql.includes('SELECT clock_timestamp() AS claimed_at')) {
        return execute(sql.replace('clock_timestamp() AS claimed_at',
          "date_trunc('milliseconds',clock_timestamp())+interval '100 microseconds' AS claimed_at"))
      }
      if (variant === 'generation' && sql.startsWith('INSERT INTO public.meta_recovery_archives (')) {
        shifted += 1
        return execute(sql.replace('$12::timestamptz)', "$12::timestamptz+interval '1 microsecond')"))
      }
      if (variant === 'reservation' && sql.startsWith('INSERT INTO public.meta_recovery_archive_snapshot_reservations')) {
        shifted += 1
        return execute(sql.replace('$9::timestamptz)', "$9::timestamptz+interval '1 microsecond')"))
      }
      return execute()
    })
    const run = bindRecoveryArchiveOwnedClaim(pool, authorize,
      { keyId: fixture.keyId, keyRowVersion: '1', leaseSeconds: 60, expiresAfterSeconds: 3600 }, limits)
    const token = (await run(fixture.identity)).claim!
    const binding = readRecoveryArchiveCommittedClaim(token)
    const table = variant === 'generation' ? 'meta_recovery_archives' : 'meta_recovery_archive_snapshot_reservations'
    const rows = await fixture.pool.query(`SELECT created_at=$2::timestamptz AS exact,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS display,
      (extract(epoch FROM created_at-$2::timestamptz)*1000000)::integer AS delta_us
      FROM ${table} WHERE generation_id=$1::uuid`, [binding.generationOwner.generationId, binding.generationClaimedAt])
    expect(shifted).toBe(variant === 'generation' ? 1 : 10)
    expect(rows.rows).toEqual(Array.from({ length: shifted }, () => ({ exact: false, display: binding.generationCreatedAt, delta_us: 1 })))
    let sourceQueries = 0
    const consumerPool = nativePool((sql, _params, execute) => {
      if (sql.includes('candidate AS')) sourceQueries += 1
      return execute()
    })
    await expect(capture(consumerPool)(token)).rejects.toMatchObject(unavailable)
    expect(sourceQueries).toBe(0)
    await expect(capture()(token)).rejects.toMatchObject(burned)
    expect(await counts()).toEqual({ generations: 1, reservations: 10, requests: 1, pins: 0 })
  })

  test('an exact block heartbeat creates a newer raw lease/updated tuple and invalidates the old claim binding', async () => {
    const token = await claim()
    const binding = readRecoveryArchiveCommittedClaim(token)
    const next = await heartbeatArchiveWriterBlock(runner, fixture.identity.sheetId, binding.writerBlock, '2099-01-01T00:00:00Z')
    expect(next.fence).toBe(binding.writerBlock.fence)
    expect(next.leaseUntil).not.toBe(binding.writerBlock.leaseUntil)
    await rejectedThenBurned(token)
  })

  test('released block rejects the genuine old token rather than confusing build fence 1 with block fence 7', async () => {
    const token = await claim()
    const binding = readRecoveryArchiveCommittedClaim(token)
    expect(binding.writerBlock.fence).toBe('7')
    expect(binding.generationOwner.ownerFence).toBe('1')
    await releaseArchiveWriterBlock(runner, fixture.identity.sheetId, binding.writerBlock)
    await rejectedThenBurned(token)
  })

  test('complete source-pin sets reject an extra genuine generation-owned intent', async () => {
    await fixture.populate()
    const token = await claim()
    const binding = readRecoveryArchiveCommittedClaim(token)
    await transaction(async (client) => {
      await acquireCanonicalSheetFence((sql, params) => client.query(sql, params), fixture.identity.sheetId)
      await claimRecoveryArchiveSourcePinIntent((sql, params) => client.query(sql, params), {
        ...binding.generationOwner, keyId: fixture.keyId, attachmentId: `${fixture.identity.sheetId}_extra_pin`, leaseUntil: binding.leaseUntil,
      })
    })
    await rejectedThenBurned(token)
  })

  test('a legally verified source pin cannot stand in for the exact mutable intent snapshot', async () => {
    await fixture.populate()
    const token = await claim()
    const binding = readRecoveryArchiveCommittedClaim(token)
    await transaction(async (client) => {
      await acquireCanonicalSheetFence((sql, params) => client.query(sql, params), fixture.identity.sheetId)
      await verifyRecoveryArchiveSourcePin((sql, params) => client.query(sql, params), {
        ...binding.generationOwner, keyId: fixture.keyId, attachmentId: fixture.descriptors[0]!.attachmentId,
        leaseUntil: binding.leaseUntil, immutableVersion: fixture.descriptors[0]!.immutableVersion,
        contentSha256: fixture.descriptors[0]!.contentSha256, contentSizeBytes: '17',
      })
    })
    await rejectedThenBurned(token)
  })

  test('SQL-only fault appending a valid sealed head is detected without disabling any database guard', async () => {
    const token = await claim()
    // An intentionally uncooperative synthetic writer tests detection; it does not prove writer census.
    await fixture.addHead()
    await rejectedThenBurned(token)
  })

  test('real clock lease expiry refuses even though the RR snapshot still contains the original tuple', async () => {
    await fixture.populate()
    const token = await claim(1)
    let paused = false
    await expect(capture(nativePool(async (sql, _params, execute) => {
      if (!paused && sql.includes('candidate AS') && sql.includes('meta_records')) {
        paused = true
        await new Promise((resolve) => setTimeout(resolve, 1100))
      }
      return execute()
    }))(token)).rejects.toMatchObject(unavailable)
    expect(paused).toBe(true)
    await expect(capture()(token)).rejects.toMatchObject(burned)
  })

  test('all sections retain one RR snapshot after an explicitly uncooperative external SQL commit', async () => {
    await fixture.populate()
    const token = await claim()
    const expected = await source()
    const reached = barrier()
    const resume = barrier()
    let paused = false
    const pending = capture(nativePool(async (sql, _params, execute) => {
      if (!paused && sql.includes('candidate AS') && sql.includes('meta_records')) {
        paused = true; reached.release(); await resume.promise
      }
      return execute()
    }))(token)
    try {
      await Promise.race([reached.promise, pending.then(() => { throw new Error('owned_capture_source_barrier_not_reached') })])
      await transaction(async (writer) => {
        // Fault injection keeps FK/DB guards enabled; deliberately bypasses the application entry.
        await writer.query(`UPDATE meta_records SET data=data||jsonb_build_object($2::text,'later-commit') WHERE id=$1`, [fixture.recordId, fixture.noteField])
        await writer.query(`UPDATE meta_views SET config='{"later":true}' WHERE id=$1`, [fixture.viewId])
      })
    } finally { resume.release() }
    expect(read(await pending).source).toEqual(expected)
    const fresh = await source()
    expect(fresh.sections.records).not.toEqual(expected.sections.records)
    expect(fresh.sections.views_config).not.toEqual(expected.sections.views_config)
  })

  test('repeat claims capture the exact checkpoint branch and existing section heads', async () => {
    const bootstrap = await claim()
    const binding = readRecoveryArchiveCommittedClaim(bootstrap)
    await transaction(async (client) => {
      await acquireCanonicalSheetFence((sql, params) => client.query(sql, params), fixture.identity.sheetId)
      await consumeRecoveryArchiveBootstrapReservations((sql, params) => client.query(sql, params), {
        ...binding.generationOwner, sheetId: fixture.identity.sheetId,
        sections: SECTION_CAUSALITY_DATA_SECTION_KINDS.map((sectionKind) => ({ sectionKind, rowCount: '0', sourceHash: 'a'.repeat(64) })),
      })
    })
    await releaseArchiveWriterBlock(runner, fixture.identity.sheetId, binding.writerBlock)
    const repeated = await bindRecoveryArchiveOwnedClaim(fixture.pool, authorize,
      { keyId: fixture.keyId, keyRowVersion: '1', leaseSeconds: 60, expiresAfterSeconds: 3600 }, limits)
    ({ ...fixture.identity, requestId: randomUUID() })
    const result = read(await capture()(repeated.claim!))
    expect(result.claim.repeat).toBe(true)
    expect(result.claim.observedHeads.sectionHeads).toHaveLength(9)
    expect((await fixture.pool.query(`SELECT reservation_kind,count(*)::int AS count FROM meta_recovery_archive_snapshot_reservations
      WHERE generation_id=$1 GROUP BY reservation_kind ORDER BY reservation_kind`, [repeated.generationId])).rows)
      .toEqual([{ reservation_kind: 'archive_snapshot', count: 1 }, { reservation_kind: 'section_checkpoint', count: 9 }])
  })

  test.each(['opaque key', 'external provider'])('refuses %s descriptors without reading attachment bytes', async (mode) => {
    await fixture.populate()
    if (mode === 'opaque key') await fixture.pool.query('UPDATE multitable_attachments SET storage_path=$2 WHERE id=$1', [fixture.descriptors[0]!.attachmentId, 'synthetic/opaque'])
    else await fixture.pool.query(`UPDATE multitable_attachments SET storage_provider='synthetic-external' WHERE id=$1`, [fixture.descriptors[0]!.attachmentId])
    const token = await claim()
    await expect(capture()(token)).rejects.toMatchObject(unavailable)
    await expect(capture()(token)).rejects.toMatchObject(burned)
  })

  test('the authorizer retained query cannot escape the released native RR connection', async () => {
    const token = await claim()
    let retained: SealQuery | undefined
    let sent = 0
    const run = capture(nativePool((_sql, _params, execute) => { sent += 1; return execute() }), limits, async (query, identity) => {
      retained = query
      return authorize(query, identity)
    })
    await run(token)
    const before = sent
    await expect(retained!('SELECT 1 AS escaped')).rejects.toMatchObject(unavailable)
    expect(sent).toBe(before)
    expect((await fixture.pool.query('SELECT 1 AS healthy')).rows).toEqual([{ healthy: 1 }])
  })

  test('oversized relational rows withhold native payload and entity key before transfer', async () => {
    await fixture.populate()
    const oversized = 'synthetic-private-record'.repeat(2048)
    await fixture.pool.query('UPDATE meta_records SET data=data||jsonb_build_object($2::text,$3::text) WHERE id=$1', [fixture.recordId, fixture.noteField, oversized])
    const token = await claim()
    const transferred: unknown[] = []
    await expect(capture(nativePool(async (sql, _params, execute) => {
      const result = await execute()
      if (sql.includes('candidate AS') && sql.includes('meta_records')) transferred.push(...result.rows)
      return result
    }), { ...limits, maxBytes: 4096 })(token)).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_BYTES_EXCEEDED' })
    expect(transferred).toHaveLength(1)
    expect(transferred[0]).toMatchObject({ payload: null, entity_key: null })
    expect((transferred[0] as { payload_bytes: number }).payload_bytes).toBeGreaterThan(4096)
    expect(JSON.stringify(transferred)).not.toContain(oversized)
    await expect(capture()(token)).rejects.toMatchObject(burned)
  })

  test('one cumulative metadata budget applies across section boundaries', async () => {
    await fixture.populate(0)
    await fixture.pool.query(`INSERT INTO meta_records (id,sheet_id,data)
      SELECT $1||i::text,$2,jsonb_build_object($3::text,repeat('x',700)) FROM generate_series(1,8) i`,
    [`${fixture.recordId}_extra_`, fixture.identity.sheetId, fixture.noteField])
    const token = await claim()
    const bytes: number[] = []
    await expect(capture(nativePool(async (sql, _params, execute) => {
      const result = await execute()
      if (sql.includes('candidate AS')) for (const row of result.rows) if (typeof row.payload_bytes === 'number') bytes.push(row.payload_bytes)
      return result
    }), { ...limits, maxBytes: 4096 })(token)).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_BYTES_EXCEEDED' })
    expect(bytes.every((value) => value < 4096)).toBe(true)
    expect(bytes.reduce((sum, value) => sum + value, 0)).toBeGreaterThan(4096)
  })

  test('finite native acquisition policy is required and failure still burns the genuine claim', async () => {
    const token = await claim()
    let acquisitions = 0
    const pool = nativePool((_sql, _params, execute) => execute(), undefined, () => { acquisitions += 1 })
    await expect(capture({ ...pool, options: { ...pool.options, connectionTimeoutMillis: 0 } })(token))
      .rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_POLICY_INVALID' })
    expect(acquisitions).toBe(0)
    await expect(capture()(token)).rejects.toMatchObject(burned)
  })

  test('a blocked real source SELECT ends by deadline with discarded backend while its table lock remains held', async () => {
    await fixture.populate()
    const token = await claim()
    const blocker = await fixture.pool.connect()
    const releases: unknown[] = []
    let pid = 0
    let sent = false
    try {
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE meta_records IN ACCESS EXCLUSIVE MODE')
      await expect(capture(nativePool((sql, _params, execute) => {
        if (sql.includes('candidate AS') && sql.includes('meta_records')) sent = true
        return execute()
      }, (value) => { releases.push(value) }, (value) => { pid = value }), { ...limits, timeoutMs: 750 })(token))
        .rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED' })
      expect(sent).toBe(true)
      expect(releases).toEqual([true])
      const deadline = performance.now() + 2000
      let live = 1
      while (live > 0 && performance.now() < deadline) {
        live = (await fixture.pool.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0].count
        if (live > 0) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(live).toBe(0)
      expect((await blocker.query(`SELECT count(*)::int AS count FROM pg_locks WHERE pid=pg_backend_pid()
        AND relation='meta_records'::regclass AND mode='AccessExclusiveLock' AND granted`)).rows).toEqual([{ count: 1 }])
    } finally { await blocker.query('ROLLBACK'); blocker.release() }
    await expect(capture()(token)).rejects.toMatchObject(burned)
  })

  test('deadline covers a stalled actual RR COMMIT path and returns no captured authority', async () => {
    const token = await claim()
    const reached = barrier()
    const resume = barrier()
    const releases: unknown[] = []
    const pending = capture(nativePool(async (sql, _params, execute) => {
      if (sql === 'COMMIT') { reached.release(); await resume.promise }
      return execute()
    }, (value) => { releases.push(value) }), { ...limits, timeoutMs: 750 })(token)
    pending.catch(() => {})
    try {
      await Promise.race([reached.promise, pending.then(() => { throw new Error('owned_capture_commit_timeout_barrier_not_reached') })])
      await expect(pending).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED' })
      expect(releases).toEqual([true])
    } finally { resume.release() }
    await expect(capture()(token)).rejects.toMatchObject(burned)
  })

  test('successful capture restores the prior native statement timeout and returns the same healthy connection', async () => {
    const token = await claim()
    const seed = await fixture.pool.connect()
    const pid = (await seed.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    await seed.query("SET statement_timeout='4321ms'")
    seed.release()
    let capturePid = 0
    const releases: unknown[] = []
    await capture(nativePool((_sql, _params, execute) => execute(), (value) => { releases.push(value) }, (value) => { capturePid = value }))(token)
    expect(capturePid).toBe(pid)
    expect(releases).toEqual([undefined])
    const healthy = await fixture.pool.connect()
    try {
      expect((await healthy.query('SELECT pg_backend_pid() AS pid')).rows).toEqual([{ pid }])
      expect((await healthy.query('SHOW statement_timeout')).rows).toEqual([{ statement_timeout: '4321ms' }])
    } finally { healthy.release() }
  })

  test('final detached snapshot freezing beyond the real deadline cannot mint captured authority', async () => {
    const token = await claim()
    const original = Object.freeze
    let delayed = false
    Object.freeze = ((value: unknown) => {
      if (!delayed && value !== null && typeof value === 'object'
        && Object.hasOwn(value, 'attachmentDescriptors') && Object.hasOwn(value, 'snapshotXid')) {
        delayed = true
        const until = performance.now() + 1100
        while (performance.now() < until) { /* The actual wall clock and committed database remain real. */ }
      }
      return original(value)
    }) as typeof Object.freeze
    try {
      await expect(capture(fixture.pool, { ...limits, timeoutMs: 1000 })(token))
        .rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED' })
    } finally { Object.freeze = original }
    expect(delayed).toBe(true)
    expect(Object.freeze).toBe(original)
    await expect(capture()(token)).rejects.toMatchObject(burned)
    expect(await counts()).toEqual({ generations: 1, reservations: 10, requests: 1, pins: 0 })
  })

  test('real transaction replacement between sections refuses before returning a captured token', async () => {
    await fixture.populate()
    const token = await claim()
    let replaced = false
    const pool = nativePool(async (sql, _params, execute) => {
      if (!replaced && sql.includes('candidate AS') && sql.includes('meta_records')) {
        replaced = true
        await execute('COMMIT', [])
        await execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', [])
      }
      return execute()
    })
    await expect(capture(pool)(token)).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_TRANSACTION_REQUIRED' })
    expect(replaced).toBe(true)
    await expect(capture()(token)).rejects.toMatchObject(burned)
  })
})
