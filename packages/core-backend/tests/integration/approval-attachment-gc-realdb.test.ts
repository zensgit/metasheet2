/**
 * Approval attachments slice ③ — GC worker + TTL sweep (real DB, #4195 §3/§7/O2).
 *
 * Constructs: TTL sweep flips ONLY expired unbound rows (bound/fresh untouched) and writes the purge intent
 * atomically; drain deletes unreferenced blobs (intent → done), leaves failures pending (at-least-once),
 * and NEVER deletes a blob a live row still references (skip + surface). Two-point wired.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { afterAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { drainPurgeIntents, PURGE_MAX_ATTEMPTS, sweepUnboundAttachments } from '../../src/services/approval-attachment-gc'
import { LocalFsApprovalAttachmentStore } from '../../src/services/approval-attachment-storage'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const db = () => poolManager.get()
const RUN = randomUUID()
const ids: string[] = []
const instanceIds = new Set<string>()

/** instance_id is an FK to approval_instances (ON DELETE CASCADE) — a bound row needs a real instance. */
async function ensureInstance(id: string | null | undefined) {
  if (!id || instanceIds.has(id)) return
  instanceIds.add(id)
  await db().query(`INSERT INTO approval_instances (id, status) VALUES ($1,'pending') ON CONFLICT (id) DO NOTHING`, [id])
}

async function seed(over: { status?: string; ageHours?: number; instance?: string | null; key?: string } = {}) {
  const id = `att_${RUN}_${ids.length}`
  ids.push(id)
  await ensureInstance(over.instance)
  await db().query(
    `INSERT INTO approval_attachments (id, org_id, uploader_id, instance_id, field_id, storage_key, file_name, mime_type, size_bytes, status, created_at)
     VALUES ($1,'org1','u1',$2,'fld',$3,'a.pdf','application/pdf',1024,$4, now() - ($5::int * interval '1 hour'))`,
    [id, over.instance ?? null, over.key ?? `key_${id}`, over.status ?? 'unbound', over.ageHours ?? 0],
  )
  return id
}

describeIfDatabase('approval attachment GC (real DB)', () => {
  afterAll(async () => {
    // delete attachments first (fires the row-delete trigger, enqueuing RUN-scoped intents), then the
    // instances (no attachments left to cascade), then the RUN-scoped intents.
    await db().query('DELETE FROM approval_attachments WHERE id = ANY($1)', [ids]).catch(() => {})
    await db().query('DELETE FROM approval_instances WHERE id = ANY($1)', [[...instanceIds]]).catch(() => {})
    await db().query('DELETE FROM approval_attachment_purge_intents WHERE storage_key LIKE $1', [`key_att_${RUN}%`]).catch(() => {})
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
    const key = `key_att_${RUN}_dl`
    await db().query(
      `INSERT INTO approval_attachment_purge_intents (id, storage_key, reason) VALUES ($1,$2,'reconciler_orphan')`,
      [`pi_dl_${RUN}`, key],
    )
    const intentId = String((await db().query(
      'SELECT id FROM approval_attachment_purge_intents WHERE storage_key=$1',
      [key],
    )).rows[0].id)
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
      const st = (await db().query('SELECT status FROM approval_attachment_purge_intents WHERE id=$1', [intentId])).rows[0]
      if (st.status === 'dead_letter') break
    }
    const final = (await db().query('SELECT status, last_error FROM approval_attachment_purge_intents WHERE id=$1', [intentId])).rows[0]
    expect(final.status).toBe('dead_letter')
    expect(final.last_error).toBe('EACCES') // values-free code — NOT the raw message with the path
    expect(alerts.some(([, code]) => code === 'EACCES')).toBe(true) // alert seam fired once
    // a dead_letter intent is NEVER re-claimed by a later drain (no unbounded retry)
    const before = final.status
    await drainPurgeIntents(db(), persistentDeleter, { maxAttempts: 2 })
    const after = (await db().query('SELECT status FROM approval_attachment_purge_intents WHERE id=$1', [intentId])).rows[0].status
    expect(after).toBe(before)
    await db().query('DELETE FROM approval_attachment_purge_intents WHERE id=$1', [intentId]).catch(() => {})
    void deadRow
  })

  // §3-bis POISON AT CLAIM golden: an expired in_progress intent already AT the attempts ceiling (the
  // durable footprint of a worker that crashed after claim, before any outcome write) is transitioned to
  // terminal dead_letter BY THE CLAIM ITSELF — the blob deleter is never invoked for it. Removing the
  // claim's poison CASE turns this RED (the row would be re-claimed, the deleter called, the intent done).
  test('poison-at-claim: expired in_progress at the attempts cap → dead_letter WITHOUT invoking the deleter; terminal', async () => {
    const key = `key_att_${RUN}_poison`
    await seed({ status: 'deleted', key }) // deleted ⇒ unreferenced ⇒ inside the claimable set
    await db().query(
      `INSERT INTO approval_attachment_purge_intents (id, storage_key, reason, status, attempts, fence, lease_expires_at)
       VALUES ($1,$2,'reconciler_orphan','in_progress',$3,7, now() - interval '1 hour')`,
      [`pi_poison_${RUN}`, key, PURGE_MAX_ATTEMPTS],
    )
    const intentId = String((await db().query(
      'SELECT id FROM approval_attachment_purge_intents WHERE storage_key=$1',
      [key],
    )).rows[0].id)
    const deleterKeys: string[] = []
    const alerts: Array<[string, string, string]> = []
    const r = await drainPurgeIntents(db(), async (k) => (deleterKeys.push(k), true), {
      onDeadLetter: (id, k, code) => alerts.push([id, k, code]),
    })
    expect(r.deadLettered).toBeGreaterThanOrEqual(1)
    expect(deleterKeys).not.toContain(key) // the deleter was NEVER called for the poisoned intent
    expect(alerts.some(([id, , code]) => id === intentId && code === 'max_attempts_exhausted')).toBe(true)
    const row = (await db().query(
      'SELECT status, attempts, fence::text AS fence, last_error, lease_expires_at FROM approval_attachment_purge_intents WHERE id=$1',
      [intentId],
    )).rows[0]
    expect(row.status).toBe('dead_letter')
    expect(Number(row.attempts)).toBe(PURGE_MAX_ATTEMPTS) // NOT bumped by the poison transition
    expect(Number(row.fence)).toBe(7) // fence unchanged — no live claim was handed out
    expect(row.last_error).toBe('max_attempts_exhausted')
    expect(row.lease_expires_at).toBeNull()
    // terminal: a later drain never re-claims a dead_letter intent
    const again = await drainPurgeIntents(db(), async (k) => (deleterKeys.push(k), true))
    void again
    expect(deleterKeys).not.toContain(key)
    expect((await db().query('SELECT status FROM approval_attachment_purge_intents WHERE id=$1', [intentId])).rows[0].status).toBe('dead_letter')
    await db().query('DELETE FROM approval_attachment_purge_intents WHERE id=$1', [intentId]).catch(() => {})
  })

  // CONSTRUCTED crash-at-claim loop (the P1 scenario): a worker that dies after EVERY claim — before the
  // deleter or any outcome write — still terminates. Each crashed claim consumed an attempt (attempts is
  // bumped IN the claim statement), so after PURGE_MAX_ATTEMPTS crashes the next claim poisons the intent
  // to dead_letter instead of handing it out again. Without claim-time poison this loop never ends
  // (attempts rise forever, no terminal state — dead-letter only lived in the deleter's catch).
  test('crash-at-claim loop terminates: repeated claims with NO outcome → attempts rise → claim poisons at the cap', async () => {
    const key = `key_att_${RUN}_crash`
    await seed({ status: 'deleted', key })
    await db().query(
      `INSERT INTO approval_attachment_purge_intents (id, storage_key, reason) VALUES ($1,$2,'reconciler_orphan')`,
      [`pi_crash_${RUN}`, key],
    )
    const intentId = String((await db().query(
      'SELECT id FROM approval_attachment_purge_intents WHERE storage_key=$1',
      [key],
    )).rows[0].id)
    // A db wrapper that dies on any post-claim outcome write (SET status='…' — the claim's SET is a
    // spaced CASE, so only the three fence-CAS outcome writes match): the claim COMMITS (autocommit
    // statement), then the "process" is gone before recording anything — exactly the crash window.
    const crashingDb = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("SET status='")) throw new Error('simulated worker death after claim')
        return db().query(sql, params)
      },
    }
    for (let i = 1; i <= PURGE_MAX_ATTEMPTS; i++) {
      await expect(
        drainPurgeIntents(crashingDb, async () => {
          throw new Error('simulated worker death before the deleter ran to completion')
        }),
      ).rejects.toThrow(/simulated worker death/)
      const st = (await db().query('SELECT status, attempts FROM approval_attachment_purge_intents WHERE id=$1', [intentId])).rows[0]
      expect(st.status).toBe('in_progress') // the crashed claim left no outcome…
      expect(Number(st.attempts)).toBe(i) // …but DID durably consume an attempt (bumped at claim)
      // the crashed worker's lease eventually expires
      await db().query(`UPDATE approval_attachment_purge_intents SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, [intentId])
    }
    // next (healthy) drain: the claim poisons the at-ceiling row — the deleter is NOT called for it
    const deleterKeys: string[] = []
    const r = await drainPurgeIntents(db(), async (k) => (deleterKeys.push(k), true))
    expect(r.deadLettered).toBeGreaterThanOrEqual(1)
    expect(deleterKeys).not.toContain(key)
    const final = (await db().query('SELECT status, attempts, last_error FROM approval_attachment_purge_intents WHERE id=$1', [intentId])).rows[0]
    expect(final.status).toBe('dead_letter') // the loop TERMINATED in a surfaced terminal state
    expect(Number(final.attempts)).toBe(PURGE_MAX_ATTEMPTS)
    expect(final.last_error).toBe('max_attempts_exhausted')
    await db().query('DELETE FROM approval_attachment_purge_intents WHERE id=$1', [intentId]).catch(() => {})
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
    const pi = await db().query(`SELECT status FROM approval_attachment_purge_intents WHERE storage_key=$1`, [`key_shared_${RUN}`])
    expect(pi.rows[0].status).toBe('pending') // left for the reconciler
    void live
  })

  // §12 item 14 / G12 — prove the whole path, not just the DB intent: cascade enqueues, the real local
  // store deleter drains the intent, the dead blob disappears, and the live sibling blob remains.
  test('cascade blob cleanup (G12): instance delete drains through LocalFs store; dead blob gone, live blob retained', async () => {
    const storageRoot = mkdtempSync(path.join(tmpdir(), 'approval-attachment-gc-'))
    const localStore = new LocalFsApprovalAttachmentStore(storageRoot)
    try {
      const deadInst = `apr_${RUN}_dead`
      const liveInst = `apr_${RUN}_live`
      const deadKey = `key_att_${RUN}_cascade_dead`
      const liveKey = `key_att_${RUN}_cascade_live`
      const deadBytes = Buffer.from('dead attachment blob')
      const liveBytes = Buffer.from('live attachment blob')
      await localStore.put(deadKey, deadBytes)
      await localStore.put(liveKey, liveBytes)
      const deadAtt = await seed({ status: 'bound', instance: deadInst, key: deadKey })
      const liveAtt = await seed({ status: 'bound', instance: liveInst, key: liveKey })
      expect(await localStore.get(deadKey)).toEqual(deadBytes)
      expect(await localStore.get(liveKey)).toEqual(liveBytes)
      // delete the instance → ON DELETE CASCADE drops the bound row → the trigger enqueues its purge intent
      await db().query('DELETE FROM approval_instances WHERE id=$1', [deadInst])
      const dead = await db().query(
        `SELECT count(*)::int AS c FROM approval_attachment_purge_intents WHERE storage_key=$1 AND reason='row_deleted'`,
        [deadKey],
      )
      expect(Number(dead.rows[0].c)).toBe(1) // enqueued by the cascade path, no application code involved
      const deadRow = await db().query('SELECT count(*)::int AS c FROM approval_attachments WHERE id=$1', [deadAtt])
      expect(Number(deadRow.rows[0].c)).toBe(0) // the row is gone (cascade)

      const drained = await drainPurgeIntents(db(), (storageKey) => localStore.delete(storageKey), { batchSize: 10_000 })
      expect(drained.purged).toBeGreaterThanOrEqual(1)
      await expect(localStore.get(deadKey)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await localStore.get(liveKey)).toEqual(liveBytes)
      const deadIntent = await db().query(
        'SELECT status FROM approval_attachment_purge_intents WHERE storage_key=$1',
        [deadKey],
      )
      expect(deadIntent.rows[0]?.status).toBe('done')

      // positive control: the LIVE instance's bound blob is NEVER enqueued/purged
      const liveIntent = await db().query('SELECT count(*)::int AS c FROM approval_attachment_purge_intents WHERE storage_key=$1', [liveKey])
      expect(Number(liveIntent.rows[0].c)).toBe(0)
      void liveAtt
    } finally {
      rmSync(storageRoot, { recursive: true, force: true })
    }
  })
})
