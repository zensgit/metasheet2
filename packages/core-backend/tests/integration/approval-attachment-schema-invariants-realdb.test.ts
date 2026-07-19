/**
 * DB invariants: UNIQUE(storage_key); purge attempts>=0, fence>=0; lease/status biconditional.
 * Real-DB positive + negative controls. Two-point wired.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const db = () => poolManager.get()
const RUN = randomUUID()
const ids: string[] = []
const piIds: string[] = []

async function seedAtt(key: string) {
  const id = `att_inv_${RUN}_${ids.length}`
  ids.push(id)
  await db().query(
    `INSERT INTO approval_attachments (id, org_id, uploader_id, field_id, storage_key, file_name, mime_type, size_bytes, status)
     VALUES ($1,'org1','u1','fld',$2,'a.pdf','application/pdf',100,'unbound')`,
    [id, key],
  )
  return id
}

describeIfDatabase('approval attachment schema invariants (real DB)', () => {
  afterAll(async () => {
    await db().query('DELETE FROM approval_attachments WHERE id = ANY($1)', [ids]).catch(() => {})
    await db().query('DELETE FROM approval_attachment_purge_intents WHERE id = ANY($1)', [piIds]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('UNIQUE(storage_key): second insert with same key fails; distinct keys succeed', async () => {
    const key = `key_unique_${RUN}`
    await seedAtt(key)
    await expect(seedAtt(key)).rejects.toThrow()
    // Positive control
    await seedAtt(`key_unique_${RUN}_other`)
  })

  test('purge attempts>=0 and fence>=0: negative inserts fail; zero succeeds', async () => {
    const okId = `pi_ok_${RUN}`
    piIds.push(okId)
    await db().query(
      `INSERT INTO approval_attachment_purge_intents (id, storage_key, reason, status, attempts, fence)
       VALUES ($1, $2, 'unbound_ttl', 'pending', 0, 0)`,
      [okId, `k_${okId}`],
    )
    await expect(
      db().query(
        `INSERT INTO approval_attachment_purge_intents (id, storage_key, reason, status, attempts, fence)
         VALUES ($1, $2, 'unbound_ttl', 'pending', -1, 0)`,
        [`pi_neg_a_${RUN}`, `k_neg_a_${RUN}`],
      ),
    ).rejects.toThrow()
    await expect(
      db().query(
        `INSERT INTO approval_attachment_purge_intents (id, storage_key, reason, status, attempts, fence)
         VALUES ($1, $2, 'unbound_ttl', 'pending', 0, -1)`,
        [`pi_neg_f_${RUN}`, `k_neg_f_${RUN}`],
      ),
    ).rejects.toThrow()
  })

  test('lease/status biconditional: in_progress requires lease; pending forbids lease', async () => {
    // in_progress without lease → fail
    await expect(
      db().query(
        `INSERT INTO approval_attachment_purge_intents (id, storage_key, reason, status, attempts, fence, lease_expires_at)
         VALUES ($1, $2, 'unbound_ttl', 'in_progress', 1, 1, NULL)`,
        [`pi_bad_ip_${RUN}`, `k_bad_ip_${RUN}`],
      ),
    ).rejects.toThrow()
    // pending WITH lease → fail
    await expect(
      db().query(
        `INSERT INTO approval_attachment_purge_intents (id, storage_key, reason, status, attempts, fence, lease_expires_at)
         VALUES ($1, $2, 'unbound_ttl', 'pending', 0, 0, now() + interval '5 minutes')`,
        [`pi_bad_pend_${RUN}`, `k_bad_pend_${RUN}`],
      ),
    ).rejects.toThrow()
    // Positive: in_progress with lease
    const good = `pi_good_ip_${RUN}`
    piIds.push(good)
    await db().query(
      `INSERT INTO approval_attachment_purge_intents (id, storage_key, reason, status, attempts, fence, lease_expires_at)
       VALUES ($1, $2, 'unbound_ttl', 'in_progress', 1, 1, now() + interval '5 minutes')`,
      [good, `k_${good}`],
    )
    // Positive: pending with null lease
    const pend = `pi_good_pend_${RUN}`
    piIds.push(pend)
    await db().query(
      `INSERT INTO approval_attachment_purge_intents (id, storage_key, reason, status, attempts, fence, lease_expires_at)
       VALUES ($1, $2, 'unbound_ttl', 'pending', 0, 0, NULL)`,
      [pend, `k_${pend}`],
    )
  })
})
