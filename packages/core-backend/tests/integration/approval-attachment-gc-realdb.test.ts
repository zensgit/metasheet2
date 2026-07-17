/**
 * Approval attachments slice ③ — GC worker + TTL sweep (real DB, #4195 §3/§7/O2).
 *
 * Constructs: TTL sweep flips ONLY expired unbound rows (bound/fresh untouched) and writes the purge intent
 * atomically; drain deletes unreferenced blobs (intent → done), leaves failures pending (at-least-once),
 * and NEVER deletes a blob a live row still references (skip + surface). Two-point wired.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { drainPurgeIntents, sweepUnboundAttachments } from '../../src/services/approval-attachment-gc'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const db = () => poolManager.get()
const RUN = randomUUID()
const ids: string[] = []

async function seed(over: { status?: string; ageHours?: number; instance?: string | null; key?: string } = {}) {
  const id = `att_${RUN}_${ids.length}`
  ids.push(id)
  await db().query(
    `INSERT INTO approval_attachments (id, org_id, uploader_id, instance_id, field_id, storage_key, file_name, mime_type, size_bytes, status, created_at)
     VALUES ($1,'org1','u1',$2,'fld',$3,'a.pdf','application/pdf',1024,$4, now() - ($5::int * interval '1 hour'))`,
    [id, over.instance ?? null, over.key ?? `key_${id}`, over.status ?? 'unbound', over.ageHours ?? 0],
  )
  return id
}

describeIfDatabase('approval attachment GC (real DB)', () => {
  afterAll(async () => {
    await db().query('DELETE FROM approval_attachment_purge_intents WHERE storage_key LIKE $1', [`key_att_${RUN}%`]).catch(() => {})
    await db().query('DELETE FROM approval_attachments WHERE id = ANY($1)', [ids]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('TTL sweep: only EXPIRED unbound rows flip to deleted + intent; bound and fresh rows untouched', async () => {
    const expired = await seed({ ageHours: 200 })
    const fresh = await seed({ ageHours: 1 })
    const bound = await seed({ status: 'bound', ageHours: 500, instance: 'apr_x' })
    const r = await sweepUnboundAttachments(db(), 168)
    expect(r.swept).toBeGreaterThanOrEqual(1)
    const st = async (id: string) => (await db().query('SELECT status FROM approval_attachments WHERE id=$1', [id])).rows[0].status
    expect(await st(expired)).toBe('deleted')
    expect(await st(fresh)).toBe('unbound')
    expect(await st(bound)).toBe('bound') // NEVER swept
    const pi = await db().query('SELECT reason, status FROM approval_attachment_purge_intents WHERE storage_key=$1', [`key_${expired}`])
    expect(pi.rows[0]).toMatchObject({ reason: 'unbound_ttl', status: 'pending' }) // intent written atomically
  })

  test('drain: unreferenced blob deleted → done; deleter throw → stays pending (at-least-once)', async () => {
    const deleted: string[] = []
    let failOnce = true
    const r1 = await drainPurgeIntents(db(), async (k) => {
      if (k.includes(`att_${RUN}`) && failOnce) {
        failOnce = false
        throw new Error('store down')
      }
      deleted.push(k)
      return true
    })
    expect(r1.failed).toBeGreaterThanOrEqual(1) // first attempt failed, intent kept pending
    const r2 = await drainPurgeIntents(db(), async (k) => (deleted.push(k), true))
    expect(r2.purged).toBeGreaterThanOrEqual(1) // retry converges
    expect(deleted.some((k) => k.includes(`att_${RUN}`))).toBe(true)
  })

  // §12 item 18 — a persistent non-not-found error dead-letters after the bounded cap (alert seam fired);
  // not-found stays terminal-success. The transient-recovers control is covered by the drain test above.
  test('purge-worker dead-letter: persistent EACCES → terminal dead_letter after the cap + values-free alert', async () => {
    const deadRow = await seed({ status: 'deleted', key: `key_att_${RUN}_dl` }) // deleted ⇒ unreferenced ⇒ claimable
    await db().query(
      `INSERT INTO approval_attachment_purge_intents (id, storage_key, reason) VALUES ($1,$2,'reconciler_orphan')`,
      [`pi_dl_${RUN}`, `key_att_${RUN}_dl`],
    )
    const alerts: Array<[string, string]> = []
    const persistentDeleter = async () => {
      throw Object.assign(new Error('permission denied /secret/blob/path'), { code: 'EACCES' })
    }
    // cap = 2 keeps the loop short; drive drains until the intent reaches dead_letter
    for (let i = 0; i < 6; i++) {
      await drainPurgeIntents(db(), persistentDeleter, {
        maxAttempts: 2,
        onDeadLetter: (id, key, code) => alerts.push([id, code]),
      })
      const st = (await db().query('SELECT status FROM approval_attachment_purge_intents WHERE id=$1', [`pi_dl_${RUN}`])).rows[0]
      if (st.status === 'dead_letter') break
    }
    const final = (await db().query('SELECT status, last_error FROM approval_attachment_purge_intents WHERE id=$1', [`pi_dl_${RUN}`])).rows[0]
    expect(final.status).toBe('dead_letter')
    expect(final.last_error).toBe('EACCES') // values-free code — NOT the raw message with the path
    expect(alerts.some(([, code]) => code === 'EACCES')).toBe(true) // alert seam fired once
    // a dead_letter intent is NEVER re-claimed by a later drain (no unbounded retry)
    const before = final.status
    await drainPurgeIntents(db(), persistentDeleter, { maxAttempts: 2 })
    const after = (await db().query('SELECT status FROM approval_attachment_purge_intents WHERE id=$1', [`pi_dl_${RUN}`])).rows[0].status
    expect(after).toBe(before)
    await db().query('DELETE FROM approval_attachment_purge_intents WHERE id=$1', [`pi_dl_${RUN}`]).catch(() => {})
    void deadRow
  })

  test('SAFETY: a blob still referenced by a live row is NEVER deleted — skipped and surfaced', async () => {
    const live = await seed({ status: 'bound', instance: 'apr_y', key: `key_shared_${RUN}` })
    await db().query(
      `INSERT INTO approval_attachment_purge_intents (id, storage_key, reason) VALUES ($1,$2,'reconciler_orphan')`,
      [`pi_manual_${RUN}`, `key_shared_${RUN}`],
    )
    const deleted: string[] = []
    const r = await drainPurgeIntents(db(), async (k) => (deleted.push(k), true))
    expect(r.skippedStillReferenced).toContain(`key_shared_${RUN}`)
    expect(deleted).not.toContain(`key_shared_${RUN}`) // live blob untouched
    const pi = await db().query(`SELECT status FROM approval_attachment_purge_intents WHERE id=$1`, [`pi_manual_${RUN}`])
    expect(pi.rows[0].status).toBe('pending') // left for the reconciler
    void live
  })
})
