/**
 * Attachment slice ⑥ — submit-time bind (form-freeze) + bucket reconciler (real DB, #4195 §7).
 * Constructs: bind flips ONLY the submitter's unbound rows (foreign/bound/missing → whole submission
 * throws → txn rollback leaves nothing); caps re-checked at bind; reconciler queues orphan blobs
 * idempotently and surfaces (never deletes) missing blobs. Two-point wired.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { bindAttachmentsOnSubmit, reconcileBucket } from '../../src/services/approval-attachment-reconciler'

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

async function seed(over: { uploader?: string; status?: string; key?: string; size?: number } = {}) {
  const id = `att6_${RUN}_${ids.length}`
  ids.push(id)
  if (over.status === 'bound') await ensureInstance(BOUND_INSTANCE)
  await db().query(
    `INSERT INTO approval_attachments (id, org_id, uploader_id, field_id, storage_key, file_name, mime_type, size_bytes, status, instance_id)
     VALUES ($1,'org1',$2,'fldA',$3,'a.pdf','application/pdf',$4,$5,$6)`,
    [id, over.uploader ?? 'u1', over.key ?? `key_${id}`, over.size ?? 1024, over.status ?? 'unbound', over.status === 'bound' ? BOUND_INSTANCE : null],
  )
  return id
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
      await expect(bindAttachmentsOnSubmit(c, 'u1', `apr_${RUN}`, { fldA: [mine, theirs] })).rejects.toThrow(/1\/2.*rejected/)
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
      expect(await bindAttachmentsOnSubmit(c2, 'u1', `apr_${RUN}`, { fldA: [mine] })).toEqual({ bound: 1 })
      await c2.query('COMMIT')
    } finally {
      c2.release()
    }
    const st2 = await db().query('SELECT status, instance_id FROM approval_attachments WHERE id=$1', [mine])
    expect(st2.rows[0]).toMatchObject({ status: 'bound', instance_id: `apr_${RUN}` })
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
      await expect(bindAttachmentsOnSubmit(c, 'u1', `apr_${RUN}_big`, { fldA: [a, b, c3] })).rejects.toThrow(/total-bytes cap/)
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
    const listBlobs = async () => [{ key: orphanKey, ageMs: OLD }]
    const r1 = await reconcileBucket(db(), listBlobs)
    expect(r1.orphanBlobsQueued).toBe(1)
    expect(r1.missingBlobs).toContain(`key_att6_${RUN}_live`)
    const r2 = await reconcileBucket(db(), listBlobs)
    expect(r2.orphanBlobsQueued).toBe(0) // idempotent — no duplicate intents
    const row = await db().query('SELECT status FROM approval_attachments WHERE id=$1', [live])
    expect(row.rows[0].status).toBe('unbound') // never auto-deleted
    const pi = await db().query('SELECT count(*)::int AS c FROM approval_attachment_purge_intents WHERE storage_key=$1', [orphanKey])
    expect(Number(pi.rows[0].c)).toBe(1)
  })

  test('reconciler grace window (G15): an in-flight upload YOUNGER than the grace is NEVER purged', async () => {
    const inflightKey = `key_att6_${RUN}_inflight`
    const YOUNG = 5 * 60 * 1000 // 5m, well inside the 1h default grace — a blob still mid-upload/commit
    const r = await reconcileBucket(db(), async () => [{ key: inflightKey, ageMs: YOUNG }])
    expect(r.orphanBlobsQueued).toBe(0) // positive control: the just-uploaded blob is left alone
    const pi = await db().query('SELECT count(*)::int AS c FROM approval_attachment_purge_intents WHERE storage_key=$1', [inflightKey])
    expect(Number(pi.rows[0].c)).toBe(0)
  })
})
