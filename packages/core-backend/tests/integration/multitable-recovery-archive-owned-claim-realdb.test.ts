import { randomUUID } from 'node:crypto'

import { Pool, type PoolClient, type QueryResult } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { __resetRecoveryWriterStateColumnProbe, acquireCanonicalSheetFence, fenceWriterEntry } from '../../src/multitable/canonical-sheet-fence'
import { bindRecoveryArchiveManualAdmission } from '../../src/multitable/recovery-archive-manual-admission'
import { bindRecoveryArchiveOwnedClaim, readRecoveryArchiveCommittedClaim as readCommittedClaim,
  type RecoveryArchiveCommittedClaim } from '../../src/multitable/recovery-archive-owned-claim'
import { consumeRecoveryArchiveBootstrapReservations } from '../../src/multitable/recovery-archive-section-bootstrap'
import { SECTION_CAUSALITY_DATA_SECTION_KINDS, type SealQuery } from '../../src/multitable/recovery-archive-seals'
import { releaseArchiveWriterBlock } from '../../src/multitable/recovery-archive-writer-block'
import { createOwnedClaimFixture, type OwnedClaimFixture } from '../utils/recovery-archive-owned-claim-fixture'

const armed = process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const describeRealDb = armed && process.env.DATABASE_URL ? describe : describe.skip
test('sentinel: committed owned-claim real-DB lane requires DATABASE_URL', () => {
  if (armed && !process.env.DATABASE_URL) throw new Error('recovery_archive_owned_claim_realdb_harness_missing_database_url')
})

const limits = { maxBytes: 1024 * 1024, timeoutMs: 10_000 }
const code = (suffix: string) => ({ code: `RECOVERY_ARCHIVE_CLAIM_${suffix}`, message: `RECOVERY_ARCHIVE_CLAIM_${suffix}` })
let admin: Pool
let fixture: OwnedClaimFixture
let savedFlags: (string | undefined)[]
const flags = ['MULTITABLE_ENABLE_WRITER_FENCE', 'MULTITABLE_RECOVERY_ARCHIVE_ENABLED']

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

type QueryHook = (sql: string, params: unknown[] | undefined, run: (replacement?: string) => Promise<QueryResult>) => Promise<QueryResult>

// Preserve real native PG connections and every SQL result. Only barriers/transport failures are injected.
function readRecoveryArchiveCommittedClaim(token: unknown) {
  return readCommittedClaim(token as RecoveryArchiveCommittedClaim)
}

function interceptedPool(hook: QueryHook, onRelease?: (discarded: unknown) => void,
  onConnect?: (pid: number) => void): Pick<Pool, 'connect' | 'options'> {
  const connect = async () => {
    const client = await fixture.pool.connect()
    onConnect?.(Reflect.get(client, 'processID') as number)
    const nativeQuery = client.query.bind(client)
    return new Proxy(client, {
      get(target, member) {
        if (member === 'query') return (sql: string, params?: unknown[]) => hook(sql, params, (replacement) => nativeQuery(replacement ?? sql, params))
        if (member === 'release') return (discarded?: boolean) => { onRelease?.(discarded); client.release(discarded) }
        const value = Reflect.get(target, member)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
  return { options: fixture.pool.options, connect: connect as Pool['connect'] }
}

function bind(pool: Pick<Pool, 'connect' | 'options'> = fixture.pool, override = {}, budget = limits) {
  return bindRecoveryArchiveOwnedClaim(pool, async (query, identity) => {
    const found = await query(`SELECT 1 FROM public.meta_sheets s JOIN public.meta_bases b ON b.id=s.base_id
      WHERE s.id=$1 AND b.id=$2 AND b.workspace_id=$3 AND b.owner_id=$4`,
    [identity.sheetId, identity.baseId, identity.workspaceId, identity.actorId])
    return found.rows.length === 1
  }, { keyId: fixture.keyId, keyRowVersion: '1', leaseSeconds: 60, expiresAfterSeconds: 3600, ...override }, budget)
}

async function counts() {
  return (await fixture.pool.query(`SELECT
    (SELECT count(*)::int FROM meta_recovery_archives) AS generations,
    (SELECT count(*)::int FROM meta_recovery_archive_snapshot_reservations) AS reservations,
    (SELECT count(*)::int FROM meta_recovery_archive_attachment_refs) AS pins,
    (SELECT count(*)::int FROM meta_recovery_archive_manual_requests) AS requests,
    (SELECT recovery_writer_state FROM meta_sheets WHERE id=$1) AS block`, [fixture.identity.sheetId])).rows[0]
}

async function expectEmpty() {
  expect(await counts()).toEqual({ generations: 0, reservations: 0, pins: 0, requests: 0, block: null })
}

async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await fixture.pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

async function waitForAdvisoryWait() {
  const deadline = performance.now() + 3000
  while (performance.now() < deadline) {
    const result = await fixture.pool.query(`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event='advisory' AND state='active'`)
    if (result.rows[0].count > 0) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('owned_claim_expected_advisory_wait')
}

describeRealDb('D-H2 committed READ COMMITTED owned claim (real DB)', () => {
  beforeAll(() => {
    admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 500 })
    savedFlags = flags.map((flag) => process.env[flag])
  })
  beforeEach(async () => {
    fixture = await createOwnedClaimFixture(admin)
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

  test('commits the exact ten reservations, owner block 7/build 1, zero pins and immutable capability', async () => {
    const result = await bind()(fixture.identity)
    expect(result.replayed).toBe(false)
    expect(result.claim).not.toBeNull()
    const snapshot = readRecoveryArchiveCommittedClaim(result.claim)
    expect(snapshot.identity).toEqual(fixture.identity)
    expect(snapshot.generationOwner).toMatchObject({ generationId: result.generationId, ownerKind: 'archive_builder', ownerFence: '1' })
    expect(snapshot.writerBlock).toMatchObject({ state: 'archiving', ownerKind: 'archive_generation', ownerId: result.generationId, fence: '7' })
    expect(snapshot.key).toEqual({ keyId: fixture.keyId, rowVersion: '1' })
    expect(snapshot.observedHeads).toEqual({ operationHead: null, sectionHeads: [] })
    expect(snapshot.sourcePinIds).toEqual([])
    expect(snapshot.repeat).toBe(false)
    expect(snapshot.reservationPlan.sections).toHaveLength(9)
    expect(await counts()).toEqual({ generations: 1, reservations: 10, pins: 0, requests: 1, block: 'archiving' })
    const leases = (await fixture.pool.query(`SELECT g.lease_expires_at=s.recovery_writer_lease_until AS exact,
      g.owner_fence::text AS build_fence,s.recovery_writer_owner_fence::text AS block_fence
      FROM meta_recovery_archives g JOIN meta_sheets s ON s.id=g.sheet_id`)).rows
    expect(leases).toEqual([{ exact: true, build_fence: '1', block_fence: '7' }])
    expect((await fixture.pool.query(`SELECT bool_and(g.created_at=r.created_at) AS same_claimed_at,
      count(*)::int AS reservations FROM meta_recovery_archives g
      JOIN meta_recovery_archive_snapshot_reservations r USING(generation_id)`)).rows)
      .toEqual([{ same_claimed_at: true, reservations: 10 }])
    expect((await fixture.pool.query(`SELECT created_at=$1::timestamptz AS exact_claimed_at,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS display
      FROM meta_recovery_archives`, [snapshot.generationClaimedAt])).rows)
      .toEqual([{ exact_claimed_at: true, display: snapshot.generationCreatedAt }])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.identity)).toBe(true)
    expect(Object.isFrozen(snapshot.reservationPlan.sections)).toBe(true)
    expect(readRecoveryArchiveCommittedClaim(result.claim)).toEqual(snapshot)
    expect(readRecoveryArchiveCommittedClaim(result.claim)).not.toBe(snapshot)
    for (const forged of [{}, { ...result.claim! }, structuredClone(result.claim), structuredClone(snapshot)]) {
      expect(() => readRecoveryArchiveCommittedClaim(forged)).toThrow('RECOVERY_ARCHIVE_CLAIM_CAPABILITY_UNAVAILABLE')
    }
  })

  test('COMMIT barrier withholds every row and capability, then exposes complete pins and reservations atomically', async () => {
    const ids = await fixture.addAttachments(3)
    const reached = barrier()
    const resume = barrier()
    let settled = false
    const pending = bind(interceptedPool(async (sql, _params, run) => {
      if (sql.trim() === 'COMMIT') { reached.release(); await resume.promise }
      return run()
    }))(fixture.identity).then((value) => { settled = true; return value })
    try {
      await Promise.race([reached.promise, pending.then(() => { throw new Error('owned_claim_commit_barrier_not_reached') })])
      await expectEmpty()
      expect(settled).toBe(false)
    } finally { resume.release() }
    const result = await pending
    const snapshot = readRecoveryArchiveCommittedClaim(result.claim)
    expect([...snapshot.sourcePinIds].sort()).toEqual([...ids].sort())
    expect(await counts()).toEqual({ generations: 1, reservations: 10, pins: 3, requests: 1, block: 'archiving' })
    expect((await fixture.pool.query(`SELECT reference_class,reference_state,availability,
      source_owner_kind,source_owner_fence::text,source_lease_until=g.lease_expires_at AS exact_lease
      FROM meta_recovery_archive_attachment_refs p JOIN meta_recovery_archives g USING(generation_id)
      ORDER BY attachment_id`)).rows).toEqual(ids.map(() => ({ reference_class: 'source', reference_state: 'building',
      availability: 'mutable', source_owner_kind: 'archive_builder', source_owner_fence: '1', exact_lease: true })))
  })

  test('reads the writer newly committed head after waiting in the canonical fence', async () => {
    const writer = await fixture.pool.connect()
    let pending: ReturnType<ReturnType<typeof bind>> | undefined
    let head!: { operationId: string; endpointSeq: string }
    try {
      await writer.query('BEGIN')
      await fenceWriterEntry((sql, params) => writer.query(sql, params), fixture.identity.sheetId)
      pending = bind()(fixture.identity)
      await waitForAdvisoryWait()
      head = await fixture.addHead(writer)
      await writer.query('COMMIT')
    } finally { await writer.query('ROLLBACK'); writer.release() }
    const result = await pending!
    expect(readRecoveryArchiveCommittedClaim(result.claim).observedHeads.operationHead).toEqual(head)
  })

  test('isolation guard refuses a native RR-before-fence transaction instead of minting its stale claim', async () => {
    const writer = await fixture.pool.connect()
    let pending: ReturnType<ReturnType<typeof bind>> | undefined
    let head!: { operationId: string; endpointSeq: string }
    try {
      await writer.query('BEGIN')
      await acquireCanonicalSheetFence((sql, params) => writer.query(sql, params), fixture.identity.sheetId)
      pending = bind(interceptedPool(async (sql, _params, run) => {
        if (sql.startsWith('BEGIN')) return run('BEGIN ISOLATION LEVEL REPEATABLE READ')
        return run()
      }))(fixture.identity)
      pending.catch(() => {})
      await waitForAdvisoryWait()
      head = await fixture.addHead(writer)
      await writer.query('COMMIT')
    } finally { await writer.query('ROLLBACK'); writer.release() }
    expect(head.operationId).toBeTruthy()
    await expect(pending!).rejects.toMatchObject(code('UNAVAILABLE'))
    await expectEmpty()
  })

  test('PostgreSQL barrier golden proves RR snapshot established before fence wait reads the old head', async () => {
    const writer = await fixture.pool.connect()
    const mutant = await fixture.pool.connect()
    try {
      await writer.query('BEGIN')
      await acquireCanonicalSheetFence((sql, params) => writer.query(sql, params), fixture.identity.sheetId)
      await mutant.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      const wait = acquireCanonicalSheetFence((sql, params) => mutant.query(sql, params), fixture.identity.sheetId)
      await waitForAdvisoryWait()
      const committedHead = await fixture.addHead(writer)
      await writer.query('COMMIT')
      await wait
      const sql = `SELECT operation_id::text AS "operationId",endpoint_seq::text AS "endpointSeq"
        FROM meta_record_history_operations WHERE sheet_id=$1 ORDER BY endpoint_seq DESC LIMIT 1`
      const stale = await mutant.query(sql, [fixture.identity.sheetId])
      const fresh = await fixture.pool.query(sql, [fixture.identity.sheetId])
      expect(fresh.rows).toEqual([committedHead])
      expect(stale.rows).toEqual([])
      expect(stale.rows[0] ?? null).not.toEqual(committedHead)
    } finally {
      await mutant.query('ROLLBACK'); mutant.release()
      await writer.query('ROLLBACK'); writer.release()
    }
  })

  test('a deferred COMMIT failure rolls back every claim surface and returns no capability', async () => {
    await fixture.pool.query(`CREATE FUNCTION owned_claim_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='owned_claim_deferred_failure'; END $$;
      CREATE CONSTRAINT TRIGGER owned_claim_commit_failure AFTER INSERT ON meta_recovery_archive_manual_requests
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION owned_claim_commit_failure()`)
    await expect(bind()(fixture.identity)).rejects.toMatchObject(code('UNAVAILABLE'))
    await expectEmpty()
  })

  test('lost COMMIT acknowledgement leaves committed rows but no capability and never retries the transaction', async () => {
    let commits = 0
    const run = bind(interceptedPool(async (sql, _params, execute) => {
      const result = await execute()
      if (sql.trim() === 'COMMIT') { commits += 1; throw new Error('synthetic_commit_ack_lost') }
      return result
    }))
    await expect(run(fixture.identity)).rejects.toMatchObject(code('UNAVAILABLE'))
    expect(commits).toBe(1)
    expect(await counts()).toEqual({ generations: 1, reservations: 10, pins: 0, requests: 1, block: 'archiving' })
    await expect(bind()(fixture.identity)).resolves.toEqual({ generationId: expect.any(String), replayed: true, claim: null })
  })

  test('replays only the same actor/request/scope without minting another capability, and rejects scope conflict', async () => {
    const first = await bind()(fixture.identity)
    const before = await counts()
    expect(await bind()(fixture.identity)).toEqual({ generationId: first.generationId, replayed: true, claim: null })
    const otherSheet = `${fixture.identity.sheetId}_other`
    await fixture.pool.query(`INSERT INTO meta_sheets (id,base_id,name) VALUES ($1,$2,'Synthetic other')`, [otherSheet, fixture.identity.baseId])
    await expect(bind()({ ...fixture.identity, sheetId: otherSheet })).rejects.toMatchObject(code('UNAVAILABLE'))
    expect(await counts()).toEqual(before)
  })

  test.each(['retiring', 'wrong-version'])('rejects %s key with no residual generation or block', async (mode) => {
    if (mode === 'retiring') await fixture.pool.query(`UPDATE meta_recovery_archive_keys
      SET state='retiring',row_version=row_version+1 WHERE key_id=$1`, [fixture.keyId])
    await expect(bind(fixture.pool, mode === 'wrong-version' ? { keyRowVersion: '2' } : {})(fixture.identity))
      .rejects.toMatchObject(code('UNAVAILABLE'))
    await expectEmpty()
  })

  test.each(['false', 'throw'])('refuses authorization %s before any durable claim', async (mode) => {
    const run = bindRecoveryArchiveOwnedClaim(fixture.pool, async () => {
      if (mode === 'throw') throw new Error('synthetic_private_authorization_error')
      return false
    }, { keyId: fixture.keyId, keyRowVersion: '1', leaseSeconds: 60, expiresAfterSeconds: 3600 }, limits)
    await expect(run(fixture.identity)).rejects.toMatchObject(code('AUTHORITY_UNAVAILABLE'))
    await expectEmpty()
  })

  test('real owner ACL rejects a different actor; wrong workspace/base/sheet identities refuse without residue', async () => {
    await expect(bind()({ ...fixture.identity, actorId: randomUUID() })).rejects.toMatchObject(code('AUTHORITY_UNAVAILABLE'))
    for (const key of ['workspaceId', 'baseId', 'sheetId']) {
      await expect(bind()({ ...fixture.identity, [key]: `synthetic_other_${key}` })).rejects.toMatchObject(code('AUTHORITY_UNAVAILABLE'))
    }
    await expectEmpty()
  })

  test.each(['blob_purged_at', 'blob_purge_claimed_at'])('refuses attachment %s atomically', async (column) => {
    const [id] = await fixture.addAttachments(1)
    await fixture.pool.query(`UPDATE multitable_attachments SET ${column}=clock_timestamp() WHERE id=$1`, [id])
    await expect(bind()(fixture.identity)).rejects.toMatchObject(code('ATTACHMENT_UNAVAILABLE'))
    await expectEmpty()
  })

  test.each(['applying', 'archiving'])('refuses active %s block; ordinary writers cannot enter after claim commit', async (state) => {
    await fixture.pool.query(state === 'applying'
      ? `UPDATE meta_sheets SET recovery_writer_state='applying' WHERE id=$1`
      : `UPDATE meta_sheets SET recovery_writer_state='archiving',recovery_writer_owner_kind='archive_generation',
          recovery_writer_owner_id='synthetic_other_owner',recovery_writer_lease_until=clock_timestamp()+interval '1 hour',
          recovery_writer_updated_at=clock_timestamp() WHERE id=$1`, [fixture.identity.sheetId])
    await expect(bind()(fixture.identity)).rejects.toMatchObject(code('UNAVAILABLE'))
    expect(await counts()).toEqual({ generations: 0, reservations: 0, pins: 0, requests: 0, block: state })
    await fixture.pool.query(`UPDATE meta_sheets SET recovery_writer_state=NULL,recovery_writer_owner_kind=NULL,
      recovery_writer_owner_id=NULL,recovery_writer_lease_until=NULL,recovery_writer_updated_at=NULL WHERE id=$1`, [fixture.identity.sheetId])
    await bind()(fixture.identity)
    await expect(transaction(async (client) => {
      await fenceWriterEntry((sql, params) => client.query(sql, params), fixture.identity.sheetId)
      await fixture.addHead(client)
    })).rejects.toMatchObject({ code: 'SHEET_WRITER_BLOCKED' })
    expect((await fixture.pool.query('SELECT count(*)::int AS count FROM meta_record_history_operations')).rows).toEqual([{ count: 0 }])
  })

  test('reclaims an expired block only by its previous owner/fence, preserving the monotonic block fence', async () => {
    await fixture.pool.query(`UPDATE meta_sheets SET recovery_writer_state='archiving',
      recovery_writer_owner_kind='archive_generation',recovery_writer_owner_id='synthetic_expired_owner',
      recovery_writer_lease_until=clock_timestamp()-interval '1 second',recovery_writer_updated_at=clock_timestamp()
      WHERE id=$1`, [fixture.identity.sheetId])
    const result = await bind()(fixture.identity)
    expect(readRecoveryArchiveCommittedClaim(result.claim).writerBlock)
      .toMatchObject({ ownerId: result.generationId, fence: '7' })
  })

  test('attachment pin metadata enforces cumulative bytes in SQL and rolls back all partially inserted intents', async () => {
    await fixture.addAttachments(32)
    await expect(bind(fixture.pool, {}, { ...limits, maxBytes: 512 })(fixture.identity))
      .rejects.toMatchObject(code('BYTE_LIMIT_EXCEEDED'))
    await expectEmpty()
  })

  test('an individual oversized attachment id is withheld before transfer and refuses without values', async () => {
    const [id] = await fixture.addAttachments(1)
    const oversized = 'synthetic_private_attachment'.repeat(256)
    await fixture.pool.query('UPDATE multitable_attachments SET id=$2 WHERE id=$1', [id, oversized])
    const transferred: unknown[] = []
    const pool = interceptedPool(async (sql, _params, run) => {
      const result = await run()
      if (sql.includes('multitable_attachments')) transferred.push(...result.rows)
      return result
    })
    await expect(bind(pool, {}, { ...limits, maxBytes: 5 })(fixture.identity))
      .rejects.toMatchObject(code('BYTE_LIMIT_EXCEEDED'))
    expect(transferred).toHaveLength(1)
    expect(transferred[0]).toEqual({ payload_bytes: expect.any(Number), payload: null, entity_key: null })
    expect((transferred[0] as { payload_bytes: number }).payload_bytes).toBeGreaterThan(5)
    expect(JSON.stringify(transferred)).not.toContain(oversized)
    await expectEmpty()
  })

  test('deadline discards the real connection while a canonical fence acquisition is blocked', async () => {
    const writer = await fixture.pool.connect()
    const started = performance.now()
    const releases: unknown[] = []
    let claimPid = 0
    try {
      await writer.query('BEGIN')
      await acquireCanonicalSheetFence((sql, params) => writer.query(sql, params), fixture.identity.sheetId)
      const failure = await bind(interceptedPool((_sql, _params, run) => run(),
        (discarded) => { releases.push(discarded) }, (pid) => { claimPid = pid }),
      {}, { ...limits, timeoutMs: 750 })(fixture.identity).then(() => {
        throw new Error('owned_claim_deadline_did_not_refuse')
      }, (error: unknown) => error)
      expect(failure).toMatchObject({ code: expect.stringMatching(/^RECOVERY_ARCHIVE_CLAIM_(TIME_EXCEEDED|UNAVAILABLE)$/) })
      expect(performance.now() - started).toBeLessThan(3000)
      expect(releases).toEqual([true])
      expect(claimPid).toBeGreaterThan(0)
      const deadline = performance.now() + 2000
      let count = 1
      while (count > 0 && performance.now() < deadline) {
        count = (await fixture.pool.query(`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname=current_database() AND pid=$1`, [claimPid])).rows[0].count
        if (count > 0) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(count).toBe(0)
      expect((await writer.query(`SELECT count(*)::int AS count FROM pg_locks
        WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted`)).rows).toEqual([{ count: 1 }])
      await expectEmpty()
    } finally { await writer.query('ROLLBACK'); writer.release() }
  })

  test('successful COMMIT restores the original session timeout and returns the same healthy native connection', async () => {
    const seeded = await fixture.pool.connect()
    const pid = (await seeded.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    await seeded.query("SET statement_timeout='4321ms'")
    seeded.release()
    const releases: unknown[] = []
    let claimPid = 0
    await bind(interceptedPool((_sql, _params, run) => run(),
      (discarded) => { releases.push(discarded) }, (connectedPid) => { claimPid = connectedPid }))(fixture.identity)
    expect(claimPid).toBe(pid)
    expect(releases).toEqual([undefined])
    const reused = await fixture.pool.connect()
    try {
      expect((await reused.query('SELECT pg_backend_pid() AS pid')).rows).toEqual([{ pid }])
      expect((await reused.query('SHOW statement_timeout')).rows).toEqual([{ statement_timeout: '4321ms' }])
      expect((await reused.query('SELECT 1 AS healthy')).rows).toEqual([{ healthy: 1 }])
    } finally { reused.release() }
  })

  test('an authorizer retained query cannot use the native connection after successful COMMIT and release', async () => {
    let retained: SealQuery | undefined
    let statements = 0
    const run = bindRecoveryArchiveOwnedClaim(interceptedPool((_sql, _params, execute) => {
      statements += 1
      return execute()
    }), async (query, identity) => {
      retained = query
      const allowed = await query('SELECT 1 FROM meta_bases WHERE id=$1 AND owner_id=$2', [identity.baseId, identity.actorId])
      return allowed.rows.length === 1
    }, { keyId: fixture.keyId, keyRowVersion: '1', leaseSeconds: 60, expiresAfterSeconds: 3600 }, limits)
    const result = await run(fixture.identity)
    expect(result.claim).not.toBeNull()
    const before = statements
    await expect(retained!('SELECT 1 AS escaped')).rejects.toMatchObject({ code: expect.stringMatching(/^RECOVERY_ARCHIVE_CLAIM_/) })
    expect(statements).toBe(before)
    expect((await fixture.pool.query('SELECT 1 AS healthy')).rows).toEqual([{ healthy: 1 }])
  })

  test('legacy manual admission and owned claim serialize the actual request lock before taking the actual key row', async () => {
    const otherSheet = `${fixture.identity.sheetId}_lock_order`
    await fixture.pool.query(`INSERT INTO meta_sheets (id,base_id,name,recovery_writer_owner_fence)
      VALUES ($1,$2,'Synthetic lock order',6)`, [otherSheet, fixture.identity.baseId])
    await fixture.pool.query(`INSERT INTO meta_history_trust_checkpoints (id,sheet_id,state,trusted_since_seq)
      VALUES ($1,$2,'active',1)`, [`${fixture.checkpointId}_lock_order`, otherSheet])
    const reached = barrier()
    const resume = barrier()
    const marker = 'synthetic_after_key_abort'
    let manualPid = 0
    let ownedPid = 0
    let manualKeyAcquired = 0
    let ownedKeyAttempts = 0
    const manual = bindRecoveryArchiveManualAdmission((work) => transaction(async (client) => {
      manualPid = Reflect.get(client, 'processID') as number
      return work(async (sql, params) => {
        const result = await client.query(sql, params)
        if (sql.includes('FROM public.meta_recovery_archive_keys') && sql.includes('FOR UPDATE')) {
          manualKeyAcquired += 1
          throw new Error(marker)
        }
        return result
      })
    }), async (query, identity) => {
      const allowed = await query('SELECT 1 FROM meta_bases WHERE id=$1 AND owner_id=$2', [identity.baseId, identity.actorId])
      reached.release()
      await resume.promise
      return allowed.rows.length === 1
    }, { keyId: fixture.keyId, keyRowVersion: '1', leaseSeconds: 60, expiresAfterSeconds: 3600 })(fixture.identity)
    manual.catch(() => {})
    let owned: ReturnType<ReturnType<typeof bind>> | undefined
    try {
      await Promise.race([reached.promise, manual.then(() => { throw new Error('owned_claim_legacy_barrier_not_reached') })])
      owned = bind(interceptedPool((sql, _params, execute) => {
        if (sql.includes('FROM public.meta_recovery_archive_keys') && sql.includes('FOR UPDATE')) ownedKeyAttempts += 1
        return execute()
      }, undefined, (pid) => { ownedPid = pid }))({ ...fixture.identity, sheetId: otherSheet })
      owned.catch(() => {})
      const deadline = performance.now() + 3000
      let blockers: number[] = []
      while (!blockers.length && performance.now() < deadline) {
        blockers = (await fixture.pool.query('SELECT pg_blocking_pids($1::int) AS blockers', [ownedPid])).rows[0].blockers
        if (!blockers.length) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(blockers).toEqual([manualPid])
      expect(ownedKeyAttempts).toBe(0)
      resume.release()
      await expect(manual).rejects.toThrow(marker)
      expect(manualKeyAcquired).toBe(1)
      const result = await owned
      expect(result.claim).not.toBeNull()
      expect(ownedKeyAttempts).toBe(1)
      expect((await fixture.pool.query(`SELECT sheet_id FROM meta_recovery_archives`)).rows).toEqual([{ sheet_id: otherSheet }])
    } finally {
      resume.release()
      await Promise.allSettled([manual, ...(owned ? [owned] : [])])
    }
  })

  test('synchronous candidate freezing beyond the real deadline refuses capability after the actual COMMIT', async () => {
    const original = Object.freeze
    let delayed = false
    Object.freeze = ((value: unknown) => {
      if (!delayed && value !== null && typeof value === 'object'
        && Object.hasOwn(value, 'generationClaimedAt')) {
        delayed = true
        const until = performance.now() + 1100
        while (performance.now() < until) { /* Only the final candidate is delayed; clocks remain real. */ }
      }
      return original(value)
    }) as typeof Object.freeze
    try {
      await expect(bind(fixture.pool, {}, { ...limits, timeoutMs: 1000 })(fixture.identity))
        .rejects.toMatchObject(code('TIME_EXCEEDED'))
    } finally { Object.freeze = original }
    expect(delayed).toBe(true)
    expect(Object.freeze).toBe(original)
    expect(await counts()).toEqual({ generations: 1, reservations: 10, pins: 0, requests: 1, block: 'archiving' })
    expect(await bind()(fixture.identity)).toEqual({ generationId: expect.any(String), replayed: true, claim: null })
  })

  test('deadline covers COMMIT acknowledgement and discards without publishing any capability', async () => {
    const reached = barrier()
    const resume = barrier()
    const releases: unknown[] = []
    const pending = bind(interceptedPool(async (sql, _params, run) => {
      if (sql.trim() === 'COMMIT') { reached.release(); await resume.promise }
      return run()
    }, (discarded) => { releases.push(discarded) }), {}, { ...limits, timeoutMs: 750 })(fixture.identity)
    pending.catch(() => {})
    try {
      await Promise.race([reached.promise, pending.then(() => { throw new Error('owned_claim_commit_deadline_barrier_not_reached') })])
      await expect(pending).rejects.toMatchObject(code('TIME_EXCEEDED'))
      expect(releases).toEqual([true])
      await expectEmpty()
    } finally { resume.release() }
  })

  test('native pool acquisition timeout is bounded with no started transaction or claim', async () => {
    const held = await Promise.all(Array.from({ length: 6 }, () => fixture.pool.connect()))
    const started = performance.now()
    try {
      await expect(bind(fixture.pool, {}, { ...limits, timeoutMs: 750 })(fixture.identity))
        .rejects.toMatchObject(code('UNAVAILABLE'))
      expect(performance.now() - started).toBeLessThan(3000)
    } finally { held.forEach((client) => client.release()) }
    await expectEmpty()
  })

  test('concurrent requests with the same durable identity issue one capability and one read-only replay', async () => {
    const run = bind()
    const results = await Promise.all([run(fixture.identity), run(fixture.identity)])
    expect(results.map((result) => result.generationId)).toEqual([results[0].generationId, results[0].generationId])
    expect(results.filter((result) => result.claim !== null)).toHaveLength(1)
    expect(results.filter((result) => result.replayed && result.claim === null)).toHaveLength(1)
    expect(await counts()).toEqual({ generations: 1, reservations: 10, pins: 0, requests: 1, block: 'archiving' })
  })

  test('selects checkpoint reservations only after a genuinely consumed immutable bootstrap marker', async () => {
    const initial = await bind()(fixture.identity)
    const snapshot = readRecoveryArchiveCommittedClaim(initial.claim)
    await transaction(async (client) => {
      await acquireCanonicalSheetFence((sql, params) => client.query(sql, params), fixture.identity.sheetId)
      await consumeRecoveryArchiveBootstrapReservations((sql, params) => client.query(sql, params), {
        ...snapshot.generationOwner, sheetId: fixture.identity.sheetId,
        sections: SECTION_CAUSALITY_DATA_SECTION_KINDS.map((sectionKind) => ({ sectionKind, rowCount: '0', sourceHash: 'a'.repeat(64) })),
      })
    })
    await releaseArchiveWriterBlock(async (work) => transaction((client) => work((sql, params) => client.query(sql, params))),
      fixture.identity.sheetId, snapshot.writerBlock)
    const next = await bind()({ ...fixture.identity, requestId: randomUUID() })
    const repeated = readRecoveryArchiveCommittedClaim(next.claim)
    expect(repeated.repeat).toBe(true)
    expect(repeated.observedHeads.sectionHeads).toHaveLength(9)
    expect((await fixture.pool.query(`SELECT reservation_kind,count(*)::int AS count
      FROM meta_recovery_archive_snapshot_reservations WHERE generation_id=$1 GROUP BY reservation_kind ORDER BY reservation_kind`,
    [next.generationId])).rows).toEqual([{ reservation_kind: 'archive_snapshot', count: 1 }, { reservation_kind: 'section_checkpoint', count: 9 }])
  })
})
