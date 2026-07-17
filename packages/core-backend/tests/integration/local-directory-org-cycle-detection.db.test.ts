import { Client } from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import {
  LocalDirectoryConflictError,
  LocalDirectoryValidationError,
  addLocalMembership,
  createLocalAccount,
  createLocalDepartment,
  updateLocalDepartment,
} from '../../src/directory/local-directory-org'

/**
 * PB4-3 — department cycle detection (real DB, service layer).
 *
 * A reparent is the ONLY local write that can close a department cycle (create only ever adds a
 * fresh `local:<uuid>` LEAF that nothing pre-references, so it can never be an ancestor — out of
 * scope by construction). The design has two parts, both proven here:
 *
 *   1. ANCESTOR WALK (recursive CTE over the `external_parent_department_id` self-join): a reparent
 *      of child C under new parent P is rejected 409 when C is P itself or an ancestor of P (i.e. P
 *      is a descendant of C). Proven directly (A→B→A), multi-hop (A→B→C), and for a 4-cycle formed
 *      across two subtrees (A→D then C→B). A `path` accumulator makes the walk terminate even on
 *      pre-existing malformed loop data (T7).
 *   2. PER-INTEGRATION SERIALIZATION (advisory xact lock keyed on the integration): two DISJOINT
 *      reparents (A→D ∥ C→B, non-overlapping locked rows) can each pass the ancestor check on the
 *      stale committed tree yet jointly close a longer loop — the two-row FOR UPDATE does not
 *      serialize them. The advisory lock makes ALL reparents in an integration strictly serial, so
 *      each walk observes every prior reparent committed. Proven with a TWO-CONNECTION barrier: a
 *      raw holder takes the SAME advisory lock + the A→D edge (a SQL STAND-IN for a concurrent
 *      reparent — the real service commits its own txn, so its lock cannot be held open) while the
 *      service reparent(C→B) is observed genuinely PARKED on the advisory lock via `pg_stat_activity`
 *      before release; on release it sees A→D committed and rejects 409. No cycle is ever committed.
 *
 * Load-bearing mutations (run out-of-band, must red this file):
 *   - delete the `pg_advisory_xact_lock` line   → the concurrent-cross-mount barrier can no longer
 *     engage (the service reparent never parks) → T6 reds.
 *   - delete the `cycle.rows.length > 0` reject  → T2/T3/T5/T6 all red (the walk no longer bites).
 *   - delete the `NOT (... = ANY(a.path))` guard → T7 hangs on the raw loop → times out red.
 * The `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` line is defense-in-depth against a
 * `default_transaction_isolation` change; production default is RC so its effect is not observable
 * in this RC-run suite (deleting it stays green on a stock DB). Its MECHANISM is proven directly in
 * the "SET ... READ COMMITTED is effective" test below (a raw RR-default session); a service-level
 * RR mutation-guard is deliberately omitted — it would require altering the shared CI DB default.
 *
 * Positive control (fail-closed discipline): the un-raced C→B reparent SUCCEEDS (T6b) — the guard
 * rejects the RACE, not all reparents.
 *
 * Fixture IDs are namespaced with this file's STAMP — integration specs share ONE Postgres in CI.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const STAMP = Date.now()
const orgId = (suffix: string): string => `pb43-${STAMP}-${suffix}`
const newUserId = (suffix: string): string => `pb43-user-${STAMP}-${suffix}`

async function seedUser(id: string, name: string): Promise<void> {
  await query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, 'x')`, [id, `${id}@example.test`, name])
}

/** A dedicated raw connection for the barrier lock-holder — never from the service pool. */
async function withHolder(fn: (holder: Client) => Promise<void>): Promise<void> {
  const holder = new Client({ connectionString: process.env.DATABASE_URL })
  await holder.connect()
  try {
    await fn(holder)
  } finally {
    await holder.end()
  }
}

/**
 * Deterministic barrier: poll `pg_stat_activity` until at least `min` backends are BLOCKED on an
 * ADVISORY lock (`wait_event_type = 'Lock'`, `wait_event = 'advisory'`, `state = 'active'`) — i.e.
 * the service reparent is genuinely parked behind the holder's advisory lock. File-level serial
 * execution (`fileParallelism: false`) means our reparent is the only such waiter, so this observes
 * the barrier without a fixed sleep.
 */
async function waitForBlockedReparent(min = 1): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const r = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND wait_event = 'advisory' AND state = 'active'`,
    )
    if ((r.rows[0]?.n ?? 0) >= min) return
    await new Promise((res) => setTimeout(res, 20))
  }
  throw new Error('timed out waiting for a reparent parked on the advisory lock (serialization never engaged)')
}

function settled<T>(p: Promise<T>): Promise<unknown> {
  return p.then(
    (v) => v,
    (e) => e,
  )
}

describeIfDatabase('PB4-3 — department cycle detection (real DB, service layer)', () => {
  const seededOrgIds: string[] = []
  const seededUserIds: string[] = []

  afterEach(async () => {
    for (const org of seededOrgIds.splice(0)) {
      await query(`DELETE FROM directory_integrations WHERE org_id = $1`, [org])
    }
    for (const uid of seededUserIds.splice(0)) {
      await query(`DELETE FROM users WHERE id = $1`, [uid])
    }
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  async function dept(org: string, name: string, parentDepartmentId?: string): Promise<string> {
    const d = await createLocalDepartment({ orgId: org, name, parentDepartmentId })
    return d.id
  }
  async function extId(id: string): Promise<string> {
    const r = await query<{ e: string }>(`SELECT external_department_id AS e FROM directory_departments WHERE id = $1`, [id])
    return r.rows[0].e
  }
  async function parentExt(id: string): Promise<string | null> {
    const r = await query<{ e: string | null }>(`SELECT external_parent_department_id AS e FROM directory_departments WHERE id = $1`, [id])
    return r.rows[0].e
  }
  async function localIntegrationId(org: string): Promise<string> {
    const r = await query<{ id: string }>(
      `SELECT id FROM directory_integrations WHERE org_id = $1 AND provider = 'local' AND status = 'active'`,
      [org],
    )
    return r.rows[0].id
  }
  async function account(org: string, tag: string): Promise<string> {
    const uid = newUserId(tag)
    seededUserIds.push(uid)
    await seedUser(uid, `Member ${tag}`)
    const a = await createLocalAccount({ orgId: org, localUserId: uid })
    return a.id
  }

  it('A→B→A: reparenting A under its own child B is rejected 409; a fresh leaf under A still succeeds', async () => {
    const org = orgId('t2')
    seededOrgIds.push(org)
    const a = await dept(org, 'A')
    const b = await dept(org, 'B', a) // B under A

    await expect(updateLocalDepartment(org, a, { parentDepartmentId: b })).rejects.toBeInstanceOf(LocalDirectoryConflictError)

    // positive control: a fresh leaf under A is a legal reparent (no cycle)
    const c = await dept(org, 'C')
    const moved = await updateLocalDepartment(org, c, { parentDepartmentId: a })
    expect(moved?.parentDepartmentId).toBe(a)
    // A is untouched by the rejected reparent — still a root
    expect(await parentExt(a)).toBeNull()
  })

  it('A→B→C: reparenting A under grandchild C is rejected 409 (multi-hop ancestor)', async () => {
    const org = orgId('t3')
    seededOrgIds.push(org)
    const a = await dept(org, 'A')
    const b = await dept(org, 'B', a)
    const c = await dept(org, 'C', b) // C under B under A

    await expect(updateLocalDepartment(org, a, { parentDepartmentId: c })).rejects.toBeInstanceOf(LocalDirectoryConflictError)
    expect(await parentExt(a)).toBeNull()
  })

  it('self-parent stays a 400 validation error, not a 409 (PB4-1 regression, request-only check)', async () => {
    const org = orgId('t4')
    seededOrgIds.push(org)
    const a = await dept(org, 'A')
    await expect(updateLocalDepartment(org, a, { parentDepartmentId: a })).rejects.toBeInstanceOf(LocalDirectoryValidationError)
  })

  it('sequential multi-hop cross-mount: after A→D commits, C→B is rejected 409 (the walk catches the 4-cycle)', async () => {
    const org = orgId('t5')
    seededOrgIds.push(org)
    const a = await dept(org, 'A') // root
    const b = await dept(org, 'B', a) // B under A
    const c = await dept(org, 'C') // root
    const d = await dept(org, 'D', c) // D under C

    // legal on the current tree (D's ancestors: D→C; A not among them)
    const movedA = await updateLocalDepartment(org, a, { parentDepartmentId: d })
    expect(movedA?.parentDepartmentId).toBe(d)

    // chain is now C→D→A→B; reparenting C under B closes B→A→D→C→B
    await expect(updateLocalDepartment(org, c, { parentDepartmentId: b })).rejects.toBeInstanceOf(LocalDirectoryConflictError)
    expect(await parentExt(c)).toBeNull()
  })

  it('concurrent cross-mount: the service reparent parks on the per-integration advisory lock and, on release, rejects the cycle 409 — no cycle is committed', async () => {
    const org = orgId('t6')
    seededOrgIds.push(org)
    const a = await dept(org, 'A')
    const b = await dept(org, 'B', a) // B under A
    const c = await dept(org, 'C')
    const d = await dept(org, 'D', c)
    const int = await localIntegrationId(org)
    const dExt = await extId(d)

    await withHolder(async (holder) => {
      // SQL STAND-IN for a concurrent reparent(A under D): take the SAME advisory lock the service
      // takes and apply the A→D edge, holding the txn open.
      await holder.query('BEGIN')
      await holder.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`directory:reparent:${int}`])
      await holder.query('UPDATE directory_departments SET external_parent_department_id = $1, updated_at = NOW() WHERE id = $2', [dExt, a])

      // the real service reparent(C under B) must PARK on the advisory lock the stand-in holds
      const svc = settled(updateLocalDepartment(org, c, { parentDepartmentId: b }))
      await waitForBlockedReparent(1)

      // release: A→D commits; the parked reparent now walks a tree where A→D is visible
      await holder.query('COMMIT')

      const outcome = await svc
      expect(outcome).toBeInstanceOf(LocalDirectoryConflictError)
    })

    // no cycle was committed: C is still a root; A carries the stand-in's committed A→D edge
    expect(await parentExt(c)).toBeNull()
    expect(await parentExt(a)).toBe(dExt)
  })

  it('positive control: without a concurrent A→D reparent, C→B succeeds (the guard rejects the RACE, not all reparents)', async () => {
    const org = orgId('t6b')
    seededOrgIds.push(org)
    const a = await dept(org, 'A')
    const b = await dept(org, 'B', a)
    const c = await dept(org, 'C')
    await dept(org, 'D', c)
    const moved = await updateLocalDepartment(org, c, { parentDepartmentId: b })
    expect(moved?.parentDepartmentId).toBe(b)
  })

  it('the ancestor walk terminates on pre-existing malformed loop data; a fresh leaf under a looped node still succeeds', async () => {
    const org = orgId('t7')
    seededOrgIds.push(org)
    const x = await dept(org, 'X')
    const y = await dept(org, 'Y')
    const xExt = await extId(x)
    const yExt = await extId(y)
    // raw-insert a 2-cycle the service would never allow (X.parent=Y, Y.parent=X)
    await query('UPDATE directory_departments SET external_parent_department_id = $1 WHERE id = $2', [yExt, x])
    await query('UPDATE directory_departments SET external_parent_department_id = $1 WHERE id = $2', [xExt, y])

    const z = await dept(org, 'Z') // fresh leaf, not part of the loop
    // walk of X's ancestors hits the X↔Y loop but the path guard stops it; Z ∉ {X,Y} ⇒ no NEW cycle
    const moved = await updateLocalDepartment(org, z, { parentDepartmentId: x })
    expect(moved?.parentDepartmentId).toBe(x)
  })

  it('mechanism proof: `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` is effective — on a REPEATABLE-READ-default session the post-lock read still observes a concurrently-committed row', async () => {
    // The production default is READ COMMITTED, so line-250 `SET TRANSACTION ISOLATION LEVEL
    // READ COMMITTED` has no OBSERVABLE effect in the RC-run suite above — deleting it stays green
    // on a stock DB (the gate's P3). A full service-level RR mutation-guard is deliberately NOT
    // added: forcing the POOLED service connection to RR would require altering the shared CI DB's
    // default_transaction_isolation, which pollutes every other file sharing that DB. Instead this
    // proves the MECHANISM the guard relies on, on a dedicated raw connection whose SESSION default
    // is REPEATABLE READ — the exact hostile config the SET defends against:
    //   (a) pure RR (no SET): the reader's snapshot freezes at its first read, so a row a writer
    //       commits afterwards is INVISIBLE to a later read in the same txn — the stale-tree failure
    //       that would let the walk miss a just-committed concurrent reparent.
    //   (b) with the SET as the txn's first statement: the same later read SEES the committed row.
    // (a) is the negative control (proves RR really would defeat the walk); (b) proves the SET fixes
    // it. Together they show line 250 is not a no-op.
    const org = orgId('t9')
    seededOrgIds.push(org)
    const d = await dept(org, 'Probe')

    const reader = new Client({ connectionString: process.env.DATABASE_URL })
    await reader.connect()
    try {
      await reader.query(`SET SESSION default_transaction_isolation = 'repeatable read'`)

      // (a) pure REPEATABLE READ — the concurrent commit is NOT observed (stale snapshot)
      await reader.query('BEGIN')
      const a1 = (await reader.query('SELECT name FROM directory_departments WHERE id = $1', [d])).rows[0].name
      await query('UPDATE directory_departments SET name = $1 WHERE id = $2', ['changed-under-rr', d])
      const a2 = (await reader.query('SELECT name FROM directory_departments WHERE id = $1', [d])).rows[0].name
      await reader.query('COMMIT')
      expect(a1).not.toBe('changed-under-rr')
      expect(a2).toBe(a1) // frozen snapshot — RR really would let the walk read a stale tree

      // (b) WITH the SET — the concurrent commit IS observed (fresh snapshot per statement)
      await reader.query('BEGIN')
      await reader.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      const b1 = (await reader.query('SELECT name FROM directory_departments WHERE id = $1', [d])).rows[0].name
      await query('UPDATE directory_departments SET name = $1 WHERE id = $2', ['changed-under-rc', d])
      const b2 = (await reader.query('SELECT name FROM directory_departments WHERE id = $1', [d])).rows[0].name
      await reader.query('COMMIT')
      expect(b1).toBe('changed-under-rr') // starts from (a)'s committed value
      expect(b2).toBe('changed-under-rc') // the SET makes the concurrent commit visible
    } finally {
      await reader.end()
    }
  })

  it('deadlock-freedom: concurrent reparent × add-member × disjoint reparent, many rounds, never 40P01', async () => {
    const org = orgId('t8')
    seededOrgIds.push(org)
    for (let round = 0; round < 8; round++) {
      const p = await dept(org, `P${round}`)
      const q = await dept(org, `Q${round}`)
      const r = await dept(org, `R${round}`)
      const s = await dept(org, `S${round}`)
      const acct = await account(org, `t8-${round}`)

      const results = await Promise.all([
        settled(updateLocalDepartment(org, q, { parentDepartmentId: p })),
        settled(updateLocalDepartment(org, s, { parentDepartmentId: r })), // disjoint rows, serializes on advisory
        settled(addLocalMembership({ orgId: org, accountId: acct, departmentId: p })), // account-then-department order
      ])
      for (const res of results) {
        if (res instanceof Error) {
          expect(String(res.message)).not.toMatch(/deadlock|40P01/i)
        }
      }
    }
  })
})
