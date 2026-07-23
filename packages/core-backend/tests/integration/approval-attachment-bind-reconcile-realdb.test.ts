/**
 * Attachment slice ⑥ — submit-time bind (form-freeze) + bucket reconciler (real DB, #4195 §7).
 * Constructs: bind flips ONLY the submitter's unbound rows (foreign/bound/missing → whole submission
 * throws → txn rollback leaves nothing); caps re-checked at bind; reconciler queues orphan blobs
 * idempotently and surfaces (never deletes) missing blobs. Two-point wired.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  bindAttachmentsOnSubmit,
  reconcileBucket,
  RECONCILER_ORPHAN_GRACE_MS,
  type ReconcilerBlob,
  type ReconcilerBlobSource,
} from '../../src/services/approval-attachment-reconciler'
import { sweepUnboundAttachments } from '../../src/services/approval-attachment-gc'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const db = () => poolManager.get()
const RUN = randomUUID()
const ids: string[] = []
const instanceIds = new Set<string>()
const BOUND_INSTANCE = `apr6_${RUN}_pre`

/** instance_id is an FK to approval_instances (ON DELETE CASCADE) — bind/bound rows need a real instance. */
async function ensureInstance(id: string) {
  if (instanceIds.has(id)) return
  instanceIds.add(id)
  await db().query(`INSERT INTO approval_instances (id, status) VALUES ($1,'pending') ON CONFLICT (id) DO NOTHING`, [id])
}

async function waitUntilBlockedBy(waiterPid: number, blockerPid: number, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const blocked = await db().query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE pid = $1
          AND state = 'active'
          AND wait_event_type = 'Lock'
          AND $2 = ANY(pg_blocking_pids(pid))`,
      [waiterPid, blockerPid],
    )
    if (Number(blocked.rows[0]?.n ?? 0) === 1) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for backend ${waiterPid} to block on ${blockerPid}`)
}

async function findBackendBlockedBy(holderPid: number, queryFragment: string, timeoutMs = 8_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const blocked = await db().query(
      `SELECT pid FROM pg_stat_activity
        WHERE state = 'active'
          AND wait_event_type = 'Lock'
          AND $1 = ANY(pg_blocking_pids(pid))
          AND query ILIKE $2
        ORDER BY pid
        LIMIT 1`,
      [holderPid, `%${queryFragment}%`],
    )
    if (blocked.rows[0]?.pid) return Number(blocked.rows[0].pid)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${queryFragment} to block on holder ${holderPid}`)
}

async function seed(over: { uploader?: string; status?: string; key?: string; size?: number; ageHours?: number; scanState?: string } = {}) {
  const id = `att6_${RUN}_${ids.length}`
  ids.push(id)
  if (over.status === 'bound') await ensureInstance(BOUND_INSTANCE)
  await db().query(
    `INSERT INTO approval_attachments (id, org_id, uploader_id, field_id, storage_key, file_name, mime_type, size_bytes, status, instance_id, scan_state, created_at)
     VALUES ($1,'org1',$2,'fldA',$3,'a.pdf','application/pdf',$4,$5,$6,$7, now() - ($8::int * interval '1 hour'))`,
    [id, over.uploader ?? 'u1', over.key ?? `key_${id}`, over.size ?? 1024, over.status ?? 'unbound', over.status === 'bound' ? BOUND_INSTANCE : null, over.scanState ?? 'unscanned', over.ageHours ?? 0],
  )
  return id
}

function blobSource(blobs: ReconcilerBlob[]): ReconcilerBlobSource {
  const existing = new Set(blobs.map((blob) => blob.key))
  return {
    listPage: async (cursor, limit) => {
      const offset = cursor === undefined ? 0 : Number(cursor)
      const page = blobs.slice(offset, offset + limit)
      const next = offset + page.length
      return { blobs: page, ...(next < blobs.length ? { nextCursor: String(next) } : {}) }
    },
    hasBlob: async (storageKey) => existing.has(storageKey),
  }
}

describeIfDatabase('attachment bind (form-freeze) + reconciler (real DB)', () => {
  afterAll(async () => {
    await db().query('DELETE FROM approval_attachments WHERE id = ANY($1)', [ids]).catch(() => {})
    await db().query('DELETE FROM approval_instances WHERE id = ANY($1)', [[...instanceIds]]).catch(() => {})
    await db().query('DELETE FROM approval_attachment_purge_intents WHERE storage_key LIKE $1', [`key_att6_${RUN}%`]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('bind: submitter-owned unbound rows freeze to bound+instance; a FOREIGN row fails the WHOLE submission (rollback)', async () => {
    const mine = await seed()
    const theirs = await seed({ uploader: 'u2' })
    await ensureInstance(`apr_${RUN}`)
    const raw = db().getInternalPool()
    const c = await raw.connect()
    try {
      await c.query('BEGIN')
      await expect(bindAttachmentsOnSubmit(c, 'u1', 'org1', `apr_${RUN}`, { fldA: [mine, theirs] })).rejects.toThrow(/1\/2.*rejected/)
      await c.query('ROLLBACK')
    } finally {
      c.release()
    }
    // rollback → NOTHING bound (mine untouched too — all-or-nothing submission)
    const st = await db().query('SELECT status FROM approval_attachments WHERE id=$1', [mine])
    expect(st.rows[0].status).toBe('unbound')
    // clean bind of just mine succeeds
    const c2 = await raw.connect()
    try {
      await c2.query('BEGIN')
      expect(await bindAttachmentsOnSubmit(c2, 'u1', 'org1', `apr_${RUN}`, { fldA: [mine] })).toEqual({ bound: 1 })
      await c2.query('COMMIT')
    } finally {
      c2.release()
    }
    const st2 = await db().query('SELECT status, instance_id FROM approval_attachments WHERE id=$1', [mine])
    expect(st2.rows[0]).toMatchObject({ status: 'bound', instance_id: `apr_${RUN}` })
  })

  test('bind is org-pinned: the same uploader cannot capture a staged row from another tenant', async () => {
    const id = await seed()
    const instanceId = `apr_${RUN}_cross_org`
    await ensureInstance(instanceId)
    const raw = db().getInternalPool()
    const client = await raw.connect()
    try {
      await client.query('BEGIN')
      await expect(bindAttachmentsOnSubmit(client, 'u1', 'org2', instanceId, { fldA: [id] }))
        .rejects.toThrow(/bindable|rejected/)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
    const row = await db().query('SELECT status, instance_id FROM approval_attachments WHERE id=$1', [id])
    expect(row.rows[0]).toMatchObject({ status: 'unbound', instance_id: null })
  })

  test('bind refuses an infected staged row and rolls the whole submission back', async () => {
    const clean = await seed({ scanState: 'clean' })
    const infected = await seed({ scanState: 'infected' })
    const instanceId = `apr_${RUN}_infected`
    await ensureInstance(instanceId)
    const raw = db().getInternalPool()
    const client = await raw.connect()
    try {
      await client.query('BEGIN')
      await expect(bindAttachmentsOnSubmit(client, 'u1', 'org1', instanceId, { fldA: [clean, infected] }))
        .rejects.toThrow(/1\/2.*rejected/)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
    const rows = await db().query(
      'SELECT id, status, instance_id FROM approval_attachments WHERE id = ANY($1) ORDER BY id',
      [[clean, infected]],
    )
    expect(rows.rows).toEqual([
      { id: clean, status: 'unbound', instance_id: null },
      { id: infected, status: 'unbound', instance_id: null },
    ].sort((a, b) => a.id.localeCompare(b.id)))
  })

  test('bind re-checks the ratified caps: total-bytes violation throws (defense vs parallel-upload race)', async () => {
    const a = await seed({ size: 18 * 1024 * 1024 })
    const b = await seed({ size: 18 * 1024 * 1024 })
    const c3 = await seed({ size: 18 * 1024 * 1024 })
    await ensureInstance(`apr_${RUN}_big`)
    const raw = db().getInternalPool()
    const c = await raw.connect()
    try {
      await c.query('BEGIN')
      await expect(bindAttachmentsOnSubmit(c, 'u1', 'org1', `apr_${RUN}_big`, { fldA: [a, b, c3] })).rejects.toThrow(/total-bytes cap/)
      await c.query('ROLLBACK')
    } finally {
      c.release()
    }
  })

  test('reconciler: orphan blob PAST grace → idempotent purge intent; live row missing its blob → surfaced, never deleted', async () => {
    const live = await seed({ key: `key_att6_${RUN}_live` })
    const orphanKey = `key_att6_${RUN}_orphan`
    const OLD = 2 * 60 * 60 * 1000 // 2h, past the 1h default grace
    // bucket has the orphan (past grace) but NOT the live row's blob
    const source = blobSource([{ key: orphanKey, ageMs: OLD }])
    const r1 = await reconcileBucket(db(), source)
    expect(r1.orphanBlobsQueued).toBe(1)
    expect(r1.missingBlobs).toContain(`key_att6_${RUN}_live`)
    const r2 = await reconcileBucket(db(), source)
    expect(r2.orphanBlobsQueued).toBe(0) // idempotent — no duplicate intents
    const row = await db().query('SELECT status FROM approval_attachments WHERE id=$1', [live])
    expect(row.rows[0].status).toBe('unbound') // never auto-deleted
    const pi = await db().query('SELECT count(*)::int AS c FROM approval_attachment_purge_intents WHERE storage_key=$1', [orphanKey])
    expect(Number(pi.rows[0].c)).toBe(1)
  })

  test('reconciler grace window (G15): an in-flight upload YOUNGER than the grace is NEVER purged', async () => {
    const inflightKey = `key_att6_${RUN}_inflight`
    const YOUNG = 5 * 60 * 1000 // 5m, well inside the 1h default grace — a blob still mid-upload/commit
    const r = await reconcileBucket(db(), blobSource([{ key: inflightKey, ageMs: YOUNG }]))
    expect(r.orphanBlobsQueued).toBe(0) // positive control: the just-uploaded blob is left alone
    const pi = await db().query('SELECT count(*)::int AS c FROM approval_attachment_purge_intents WHERE storage_key=$1', [inflightKey])
    expect(Number(pi.rows[0].c)).toBe(0)
  })

  test('G15 dead-letter shield: an existing terminal intent blocks every reconciler re-entry for that blob', async () => {
    const key = `key_att6_${RUN}_dead_letter_shield`
    await db().query(
      `INSERT INTO approval_attachment_purge_intents
         (id, storage_key, reason, status, attempts, fence, last_error)
       VALUES ($1,$2,'row_deleted','dead_letter',9,9,'delete_failed')`,
      [`pi_att6_${RUN}_dead`, key],
    )

    const result = await reconcileBucket(db(), blobSource([{ key, ageMs: RECONCILER_ORPHAN_GRACE_MS + 1 }]))
    expect(result.orphanBlobsQueued).toBe(0)
    const intents = await db().query(
      'SELECT id, status FROM approval_attachment_purge_intents WHERE storage_key=$1',
      [key],
    )
    expect(intents.rows).toHaveLength(1)
    expect(intents.rows[0]).toMatchObject({ status: 'dead_letter' })
    expect(String(intents.rows[0].id)).toMatch(/^pi_key_[a-f0-9]{32}$/)

    await expect(db().query(
      `INSERT INTO approval_attachment_purge_intents (id, storage_key, reason)
       VALUES ($1,$2,'reconciler_orphan')`,
      [`pi_att6_${RUN}_duplicate`, key],
    )).rejects.toMatchObject({ constraint: 'approval_attachment_purge_intents_pkey' })
  })

  // §12 item 4 / G4 — CONSTRUCTED concurrent double-submit: two create-instance binds RACE on the same
  // unbound id. The row-locked `WHERE status='unbound'` serializes them → EXACTLY ONE binds; the loser
  // sees a bound row (0 rows updated) and its whole submission throws. A sequential rebind-refused check
  // does NOT satisfy G4 — this holds A's row lock open while B blocks, then commits A to release B.
  test('double-submit race (G4): exactly one create binds the shared id; the loser fails whole', async () => {
    const id = await seed()
    const instA = `apr_${RUN}_raceA`
    const instB = `apr_${RUN}_raceB`
    await ensureInstance(instA)
    await ensureInstance(instB)
    const raw = db().getInternalPool()
    const a = await raw.connect()
    const b = await raw.connect()
    try {
      await a.query('BEGIN')
      // A binds first: acquires the row lock and sets status='bound' in A's uncommitted txn
      expect(await bindAttachmentsOnSubmit(a, 'u1', 'org1', instA, { fldA: [id] })).toEqual({ bound: 1 })
      await b.query('BEGIN')
      // B races on the SAME id — its UPDATE blocks on A's row lock (promise stays pending)
      const bBind = bindAttachmentsOnSubmit(b, 'u1', 'org1', instB, { fldA: [id] })
      // release A → B unblocks, re-reads the now-committed bound row, matches 0 rows, throws
      await a.query('COMMIT')
      await expect(bBind).rejects.toThrow(/bindable|rejected/)
      await b.query('ROLLBACK')
    } finally {
      a.release()
      b.release()
    }
    // exactly one winner: the row is bound to A, never to B, never double-bound
    const row = await db().query('SELECT status, instance_id FROM approval_attachments WHERE id=$1', [id])
    expect(row.rows[0]).toMatchObject({ status: 'bound', instance_id: instA })
  })

  // §12 item 13 / G11 — CONSTRUCTED GC↔bind race, BOTH interleavings.
  test('GC↔bind race (G11): (i) bind wins → blob survives, no intent; (ii) GC wins → bind fails closed', async () => {
    // (i) BIND WINS: bind holds the row lock; a concurrent sweep SKIP-LOCKS past it → the just-bound row
    //     is NOT swept, NO purge intent is written, the blob survives.
    const winId = await seed({ ageHours: 200 }) // old enough that the sweep WOULD claim it if unlocked
    const winInst = `apr_${RUN}_bindwins`
    await ensureInstance(winInst)
    const raw = db().getInternalPool()
    const conn = await raw.connect()
    try {
      await conn.query('BEGIN')
      await bindAttachmentsOnSubmit(conn, 'u1', 'org1', winInst, { fldA: [winId] }) // row locked + bound (uncommitted)
      const swept = await sweepUnboundAttachments(db(), 168) // separate connection → SKIP LOCKED skips the locked row
      void swept
      await conn.query('COMMIT')
    } finally {
      conn.release()
    }
    const winRow = await db().query('SELECT status FROM approval_attachments WHERE id=$1', [winId])
    expect(winRow.rows[0].status).toBe('bound') // bind won; never soft-deleted
    const winIntent = await db().query('SELECT count(*)::int AS c FROM approval_attachment_purge_intents WHERE storage_key=$1', [`key_${winId}`])
    expect(Number(winIntent.rows[0].c)).toBe(0) // NO purge intent for the just-bound blob

    // (ii) GC WINS: a test-only advisory-lock trigger parks the REAL sweep after it has acquired the
    //      attachment row lock. The bind is then started and is proven blocked on the sweep backend.
    //      Releasing the advisory barrier lets GC commit first; bind resumes and fails closed.
    const loseId = await seed({ ageHours: 200 })
    const loseInst = `apr_${RUN}_gcwins`
    await ensureInstance(loseInst)
    const suffix = RUN.replace(/-/g, '')
    const barrierFn = `aatt_gcw_fn_${suffix}`
    const barrierTrigger = `aatt_gcw_trg_${suffix}`
    const advisoryClass = 4195
    const advisoryObject = 11
    await db().query(
      `CREATE FUNCTION ${barrierFn}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         PERFORM pg_advisory_xact_lock(${advisoryClass}, ${advisoryObject});
         RETURN NEW;
       END $$`,
    )
    await db().query(
      `CREATE TRIGGER ${barrierTrigger}
         BEFORE UPDATE ON approval_attachments
         FOR EACH ROW
         WHEN (OLD.id = '${loseId}' AND OLD.status = 'unbound' AND NEW.status = 'deleted')
         EXECUTE FUNCTION ${barrierFn}()`,
    )
    const holder = await raw.connect()
    const conn2 = await raw.connect()
    let sweepPromise: Promise<unknown> | undefined
    let bindPromise: Promise<unknown> | undefined
    try {
      await holder.query('BEGIN')
      const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      await holder.query('SELECT pg_advisory_xact_lock($1, $2)', [advisoryClass, advisoryObject])
      sweepPromise = sweepUnboundAttachments(db(), 168)
      const sweepPid = await findBackendBlockedBy(holderPid, 'UPDATE approval_attachments')

      await conn2.query('BEGIN')
      const bindPid = Number((await conn2.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      bindPromise = bindAttachmentsOnSubmit(conn2, 'u1', 'org1', loseInst, { fldA: [loseId] })
      await waitUntilBlockedBy(bindPid, sweepPid)

      await holder.query('COMMIT')
      await sweepPromise
      await expect(bindPromise).rejects.toThrow(/bindable|rejected/)
      await conn2.query('ROLLBACK')
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      holder.release()
      await sweepPromise?.catch(() => {})
      await bindPromise?.catch(() => {})
      await conn2.query('ROLLBACK').catch(() => {})
      conn2.release()
      await db().query(`DROP TRIGGER IF EXISTS ${barrierTrigger} ON approval_attachments`).catch(() => {})
      await db().query(`DROP FUNCTION IF EXISTS ${barrierFn}()`).catch(() => {})
    }
    const loseRow = await db().query('SELECT status, instance_id FROM approval_attachments WHERE id=$1', [loseId])
    expect(loseRow.rows[0].status).toBe('deleted') // GC won; the bind did NOT resurrect it
    expect(loseRow.rows[0].instance_id).toBeNull() // never "bound but blob gone"
    const loseIntent = await db().query('SELECT count(*)::int AS c FROM approval_attachment_purge_intents WHERE storage_key=$1', [`key_${loseId}`])
    expect(Number(loseIntent.rows[0].c)).toBe(1) // GC's intent is durable
  })
})
