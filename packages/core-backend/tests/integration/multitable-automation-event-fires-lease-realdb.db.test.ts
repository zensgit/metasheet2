/**
 * S6 event_fires LEASE claim/reclaim (real DB, isolated schema).
 *
 * Proves the window-2 fix at the load-bearing SQL layer: a fresh claim leases the (rule, dedup); a crash
 * (no markEventFiresDone) leaves an EXPIRED in_progress row the NEXT claim RECLAIMS (redelivers) — vs the
 * legacy tombstone which dropped the work; a `done` row and a LIVE lease both `skip`; markEventFiresDone is
 * a fence-CAS so a stale-fence "zombie" hits 0 rows (single-writer). Uses the #4413 lease schema in an
 * isolated schema (house rule for shared-DB integration).
 */
import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { claimEventFiresLease, markEventFiresDone } from '../../src/multitable/automation-event-fires-lease'

const dbUrl = process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

describeDb('S6 event_fires lease claim/reclaim (real DB, isolated schema)', () => {
  let adminPool: Pool
  let schema: string
  let testPool: Pool
  let db: Kysely<unknown>
  const RULE = `rule_${randomUUID().slice(0, 8)}`

  beforeEach(async () => {
    adminPool = new Pool({ connectionString: dbUrl })
    schema = `s6lease_${randomUUID().replace(/-/g, '')}`
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    testPool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema}` })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: testPool }) })
    // the #4413 lease schema (upgraded shape)
    await sql`
      CREATE TABLE meta_automation_event_fires (
        rule_id text NOT NULL, dedup_key text NOT NULL, fired_at timestamptz NOT NULL DEFAULT now(),
        status text NOT NULL DEFAULT 'done' CHECK (status IN ('pending','in_progress','done','outcome_unknown','failed','dead_letter')),
        lease_expires_at timestamptz, attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
        PRIMARY KEY (rule_id, dedup_key),
        CONSTRAINT lease_iff_in_progress CHECK ((status = 'in_progress') = (lease_expires_at IS NOT NULL)))
    `.execute(db)
  })

  afterEach(async () => {
    await db.destroy()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool.end()
  })

  const row = async (dedup: string) =>
    (
      await sql<{ status: string; fence: string; lease: string | null; attempts: number }>`
        SELECT status, fence::text AS fence, lease_expires_at::text AS lease, attempts
        FROM meta_automation_event_fires WHERE rule_id = ${RULE} AND dedup_key = ${dedup}
      `.execute(db)
    ).rows[0]

  it('fresh claim leases the row (in_progress, fence 1); markDone fence-CAS → done, lease cleared', async () => {
    const c = await claimEventFiresLease(db, RULE, 'e1', 60_000)
    expect(typeof c).toBe('object')
    const r = await row('e1')
    expect(r).toMatchObject({ status: 'in_progress', fence: '1', attempts: 1 })
    expect(r.lease).not.toBeNull()
    expect(await markEventFiresDone(db, RULE, 'e1', (c as { fence: string }).fence)).toBe(true)
    expect(await row('e1')).toMatchObject({ status: 'done', lease: null })
  })

  it("a DONE delivery re-claims as 'done' (at-most-once for a completed event — resolve-permitting skip)", async () => {
    const c = await claimEventFiresLease(db, RULE, 'e2', 60_000)
    await markEventFiresDone(db, RULE, 'e2', (c as { fence: string }).fence)
    expect(await claimEventFiresLease(db, RULE, 'e2', 60_000)).toBe('done')
  })

  it("a LIVE (unexpired) lease claims as 'busy' — a second worker neither double-runs NOR resolves done (the composed-timing hole: a silent skip here would let an early outbox redelivery mark the crashed holder's work done forever)", async () => {
    await claimEventFiresLease(db, RULE, 'e3', 60_000) // long lease, still live
    expect(await claimEventFiresLease(db, RULE, 'e3', 60_000)).toBe('busy')
  })

  it('WINDOW-2: a crash (claim but no markDone) leaves an EXPIRED lease the next claim RECLAIMS (redelivers)', async () => {
    const first = await claimEventFiresLease(db, RULE, 'e4', 1) // 1ms lease → expires immediately
    expect(typeof first).toBe('object')
    // "crash": executeRule never finished, markEventFiresDone never called → the row is in_progress + expired.
    await new Promise((r) => setTimeout(r, 20))
    const reclaim = await claimEventFiresLease(db, RULE, 'e4', 60_000)
    expect(typeof reclaim).toBe('object') // the work is RECLAIMED, not dropped (legacy tombstone would have skipped)
    expect(Number((reclaim as { fence: string }).fence)).toBe(2) // fence bumped on reclaim
    expect(await row('e4')).toMatchObject({ status: 'in_progress', attempts: 2 })
  })

  it('fence-CAS: after a reclaim (fence 2), the ZOMBIE (fence 1) markDone hits 0 rows; the reclaimer (fence 2) wins', async () => {
    const z = await claimEventFiresLease(db, RULE, 'e5', 1)
    await new Promise((r) => setTimeout(r, 20))
    const rr = await claimEventFiresLease(db, RULE, 'e5', 60_000)
    expect(Number((rr as { fence: string }).fence)).toBe(2)
    // the zombie holding fence 1 finally tries to mark done → stale fence, 0 rows (single-writer)
    expect(await markEventFiresDone(db, RULE, 'e5', (z as { fence: string }).fence)).toBe(false)
    expect(await row('e5')).toMatchObject({ status: 'in_progress' }) // still owned by the reclaimer
    // the reclaimer marks done → wins
    expect(await markEventFiresDone(db, RULE, 'e5', (rr as { fence: string }).fence)).toBe(true)
    expect(await row('e5')).toMatchObject({ status: 'done', lease: null })
  })

  it('interoperates with a legacy tombstone row: a flag-OFF INSERT lands as done (default) → lease claim skips it', async () => {
    // legacy path: bare INSERT (status defaults to done)
    await sql`INSERT INTO meta_automation_event_fires (rule_id, dedup_key) VALUES (${RULE}, 'e6')`.execute(db)
    expect(await row('e6')).toMatchObject({ status: 'done', fence: '0' })
    expect(await claimEventFiresLease(db, RULE, 'e6', 60_000)).toBe('done') // already delivered under the old path
  })
})
