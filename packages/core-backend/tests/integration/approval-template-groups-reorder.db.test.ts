import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { Client } from 'pg'
import { MetaSheetServer } from '../../src/index'
import { query } from '../../src/db/pg'

/**
 * Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18), §6 phase 3 (A-4) real-DB
 * acceptance: E's phase-3 leg ("分期 3 并发两次重排 ⇒ 终态是其中一方的完整排列 1..n,构造真并
 * 发") and §3 I3 ("分期 3 拖拽后整体重排 1..n"). This is the FOURTH `.db.test.ts` for this
 * feature (lifecycle/serialization from phase 1, sections from this phase) — a NORMAL pool, same
 * as lifecycle/sections: the reorder transaction sets `READ COMMITTED` itself
 * (`ApprovalTemplateGroupReorderService.ts`'s own header) rather than depending on the pool's
 * default, so unlike phase 1's E/K file this needs no RR-default `DATABASE_URL` amendment.
 *
 * The concurrent-reorder case constructs REAL concurrency the same way the phase-1 siblings'
 * B / K cases do (`approval-template-groups-lifecycle.db.test.ts`): a raw, non-pool connection
 * takes the SAME `atg:${org}` advisory lock the production path takes (L0) BEFORE either
 * production request is sent, so both production reorder requests are FORCED to queue behind it
 * — `waitUntilBackendBlockedByHolder` (singular) proves the first is genuinely parked on the
 * holder, then a second poll (`waitUntilNBackendsBlockedByHolder`, this file's own generalization
 * — no existing sibling needed to prove TWO concurrent blockers) proves the second is ALSO parked
 * before the holder ever releases; releasing it is therefore the only thing that lets either
 * production request proceed, and whichever of the two later reorder transactions commits LAST is
 * the one whose full permutation survives (both write the SAME active id set 1..n, so neither can
 * 400 against the other's already-written order — this is what makes "终态是其中一方的完整排列"
 * true rather than a torn mix of the two orderings).
 *
 * Mutation probes (cp backup → edit → re-run the ONE affected test → restore → `cmp`
 * byte-identical, recorded here rather than encoded as permanent code — same convention as every
 * sibling `.db.test.ts` in this feature):
 *   (1) delete `pg_advisory_xact_lock` from `reorderApprovalTemplateGroups` → the concurrent test's
 *       `waitUntilBackendBlockedByHolder` call times out (a hard failure, not a silent pass) —
 *       neither production request would ever engage the holder's lock at all;
 *   (2) drop the `archived_at IS NULL` half of the `activeRows` query → the archived-id-in-
 *       permutation case stops raising `GROUP_REORDER_SET_MISMATCH` at all (an archived group's id
 *       now passes set-equality against the unfiltered read), so the loop proceeds to WRITE
 *       `sort_order` onto the archived row — VERIFIED (2026-09-18, cp → edit → re-run → restore →
 *       `cmp` byte-identical): the observable status is 500, not a silent 200, because the DB's
 *       OWN `atg_sort_archived_pair` CHECK (I8's paired constraint, the same one row E's own
 *       "archiving without clearing sort_order hits the paired CHECK" positive control exercises)
 *       rejects an archived row getting a non-NULL `sort_order` — a second, independent layer this
 *       mutation exposes rather than silently defeats. Either way the test goes red (400 expected,
 *       500 observed), so the assertion still discriminates the mutation correctly;
 *   (3) drop the `ORDER BY id` … `index + 1` composition (write `sortOrder: index` instead of
 *       `index + 1`) → the happy-path test's exact `{id, sortOrder}` assertions catch the
 *       off-by-one directly.
 *
 * DISCLOSED RESIDUAL (carried forward from the sections file, same reason): no dedicated
 * `*-ci-wiring.test.mjs` closed-world guard exists for this feature's `.db.test.ts` family —
 * `grep -rl "approval-template-groups-lifecycle" --include=*.ts --include=*.mjs --include=*.yml .`
 * (run 2026-09-18, excluding node_modules) returns exactly the three files that ALREADY carry the
 * two-point wiring (`vitest.config.ts`, `plugin-tests.yml`, and the sibling `.db.test.ts` files'
 * own header prose) and no fourth guard file. Building one requires its own additional
 * `plugin-tests.yml` step (guards are matched by an explicit `run:` invocation, not
 * auto-discovered) — out of this slice's scope for the same reason the two earlier phase-3/phase-1
 * files gave.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip
const TS = Date.now()

async function canListen(): Promise<boolean> {
  return await new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

/** Same name/shape as the phase-1/phase-3 siblings — NOT imported (neither exports it; see their
 * own header notes on why this helper is duplicated rather than shared). */
async function tok(
  base: string,
  userId: string,
  opts: { roles?: string; perms?: string; tenantId?: string } = {},
): Promise<string> {
  const params = new URLSearchParams({
    userId,
    roles: opts.roles ?? 'user',
    perms: opts.perms ?? '',
  })
  if (opts.tenantId) params.set('tenantId', opts.tenantId)
  const res = await fetch(`${base}/api/auth/dev-token?${params.toString()}`)
  return ((await res.json()) as { token: string }).token
}

async function httpReq(
  base: string,
  path: string,
  token: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
}

/** Same shape/name as every sibling `.db.test.ts` for this feature. */
async function waitUntilBackendBlockedByHolder(
  holderPid: number,
  opts: { queryFragment?: string; timeoutMs?: number } = {},
): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const blocked = opts.queryFragment
      ? await query(
          `SELECT pid FROM pg_stat_activity
            WHERE state = 'active'
              AND wait_event_type = 'Lock'
              AND $1 = ANY(pg_blocking_pids(pid))
              AND query ILIKE $2
            ORDER BY pid
            LIMIT 1`,
          [holderPid, `%${opts.queryFragment}%`],
        )
      : await query(
          `SELECT pid FROM pg_stat_activity
            WHERE state = 'active'
              AND wait_event_type = 'Lock'
              AND $1 = ANY(pg_blocking_pids(pid))
            ORDER BY pid
            LIMIT 1`,
          [holderPid],
        )
    const pid = Number((blocked.rows[0] as { pid?: unknown } | undefined)?.pid ?? 0)
    if (pid > 0) return pid
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(
    `timed out waiting for backend blocked by holder pid ${holderPid}`
      + (opts.queryFragment ? ` on query ~${opts.queryFragment}` : '')
      + ' (never engaged the production lock — race golden would be vacuous)',
  )
}

/**
 * THIS FILE'S OWN generalization of the helper above — no existing sibling needed to prove TWO
 * concurrent backends blocked on the SAME holder at once (every sibling's concurrency case pits
 * exactly one production request against one raw holder). Polls until `pg_blocking_pids(pid)`
 * reports at least `count` distinct waiters on `holderPid`, so the second production reorder
 * request is provably parked BEFORE the holder ever releases — without this, releasing the holder
 * right after the first `waitUntilBackendBlockedByHolder` call could let the first request finish
 * and commit before the second is even sent, degrading "两次并发重排" into two sequential ones.
 */
async function waitUntilNBackendsBlockedByHolder(
  holderPid: number,
  count: number,
  opts: { timeoutMs?: number } = {},
): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const blocked = await query<{ n: number }>(
      `SELECT count(DISTINCT pid)::int AS n FROM pg_stat_activity
        WHERE state = 'active'
          AND wait_event_type = 'Lock'
          AND $1 = ANY(pg_blocking_pids(pid))`,
      [holderPid],
    )
    const n = Number(blocked.rows[0]?.n ?? 0)
    if (n >= count) return n
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(
    `timed out waiting for ${count} backends blocked by holder pid ${holderPid}`
      + ' (never reached genuine two-way concurrency — race golden would be vacuous)',
  )
}

/** Dedicated raw connection — never from the service pool (so its held lock is observable). */
async function withRawClient<T>(fn: (c: Client, pid: number) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  try {
    const pidRow = await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    return await fn(c, pidRow.rows[0].pid)
  } finally {
    try {
      await c.query('ROLLBACK')
    } catch {
      /* already closed/committed */
    }
    await c.end()
  }
}

describeIfDatabase('Approval template groups — §6 phase 3 reorder endpoint (lock v2.13, acceptance E phase-3 leg / I3)', () => {
  let server: MetaSheetServer
  let base: string
  const orgTags: string[] = []

  itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
  })

  afterAll(async () => {
    for (const org of orgTags.splice(0)) {
      await query(`DELETE FROM approval_template_group_links WHERE org_id = $1`, [org])
      await query(`DELETE FROM approval_template_groups WHERE org_id = $1`, [org])
    }
    await server?.stop()
  })

  function trackOrg(org: string): string {
    orgTags.push(org)
    return org
  }

  async function createGroup(base: string, admin: string, name: string): Promise<{ id: string; sortOrder: number }> {
    const res = await httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name } })
    expect(res.status).toBe(201)
    return (await res.json()).group
  }

  // ── happy path ─────────────────────────────────────────────────────────────────────────────
  it('writes sort_order = 1..n in the SUBMITTED order, not the pre-existing creation order', async () => {
    const org = trackOrg(`atg-reorder-happy-${TS}`)
    const admin = await tok(base, `reorder-happy-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })

    const g1 = await createGroup(base, admin, `Reorder Happy G1 ${TS}`)
    const g2 = await createGroup(base, admin, `Reorder Happy G2 ${TS}`)
    const g3 = await createGroup(base, admin, `Reorder Happy G3 ${TS}`)
    expect([g1.sortOrder, g2.sortOrder, g3.sortOrder]).toEqual([1, 2, 3])

    const res = await httpReq(base, '/api/approval-template-groups/reorder', admin, {
      method: 'POST',
      body: { groupIds: [g3.id, g1.id, g2.id] },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { groups: Array<{ id: string; sortOrder: number }> }
    expect(body.groups).toEqual([
      { id: g3.id, sortOrder: 1 },
      { id: g1.id, sortOrder: 2 },
      { id: g2.id, sortOrder: 3 },
    ])

    const rows = await query<{ id: string; sort_order: number }>(
      `SELECT id, sort_order FROM approval_template_groups WHERE org_id = $1 ORDER BY sort_order`,
      [org],
    )
    expect(rows.rows.map((r) => r.id)).toEqual([g3.id, g1.id, g2.id])
    expect(rows.rows.map((r) => Number(r.sort_order))).toEqual([1, 2, 3])
  })

  // ── set-equality wiring (pure-function logic is unit-tested; this proves the SERVICE reads
  //    only `archived_at IS NULL` ids into `activeIds`, end to end through the route) ──────────
  it('400 GROUP_REORDER_SET_MISMATCH when the permutation includes a since-archived group id, and leaves sort_order untouched', async () => {
    const org = trackOrg(`atg-reorder-mismatch-${TS}`)
    const admin = await tok(base, `reorder-mismatch-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })

    const a = await createGroup(base, admin, `Reorder Mismatch A ${TS}`)
    const b = await createGroup(base, admin, `Reorder Mismatch B ${TS}`)
    const c = await createGroup(base, admin, `Reorder Mismatch C ${TS}`)
    expect((await httpReq(base, `/api/approval-template-groups/${c.id}/archive`, admin, { method: 'POST' })).status).toBe(200)

    // Archived id present alongside the two still-active ones (extra id, and specifically an
    // archived one — not just any foreign string).
    const withArchived = await httpReq(base, '/api/approval-template-groups/reorder', admin, {
      method: 'POST',
      body: { groupIds: [a.id, b.id, c.id] },
    })
    expect(withArchived.status).toBe(400)
    expect((await withArchived.json()).error.code).toBe('GROUP_REORDER_SET_MISMATCH')

    // Missing id (only one of the two active groups).
    const missing = await httpReq(base, '/api/approval-template-groups/reorder', admin, {
      method: 'POST',
      body: { groupIds: [a.id] },
    })
    expect(missing.status).toBe(400)
    expect((await missing.json()).error.code).toBe('GROUP_REORDER_SET_MISMATCH')

    // Neither rejected attempt touched sort_order — scoped to the still-ACTIVE rows (the query
    // above would also return `c`, archived with `sort_order NULL` per I8, which is not what this
    // assertion is about).
    const rows = await query<{ id: string; sort_order: number | null }>(
      `SELECT id, sort_order FROM approval_template_groups WHERE org_id = $1 AND archived_at IS NULL ORDER BY sort_order`,
      [org],
    )
    expect(rows.rows.map((r) => [r.id, r.sort_order === null ? null : Number(r.sort_order)])).toEqual([
      [a.id, 1],
      [b.id, 2],
    ])
  })

  it('400 GROUP_REORDER_IDS_REQUIRED before any DB access when groupIds is not an array of non-blank strings', async () => {
    const org = trackOrg(`atg-reorder-shape-${TS}`)
    const admin = await tok(base, `reorder-shape-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })

    const notArray = await httpReq(base, '/api/approval-template-groups/reorder', admin, {
      method: 'POST',
      body: { groupIds: 'not-an-array' },
    })
    expect(notArray.status).toBe(400)
    expect((await notArray.json()).error.code).toBe('GROUP_REORDER_IDS_REQUIRED')

    const blankEntry = await httpReq(base, '/api/approval-template-groups/reorder', admin, {
      method: 'POST',
      body: { groupIds: ['   ', 'x'] },
    })
    expect(blankEntry.status).toBe(400)
    expect((await blankEntry.json()).error.code).toBe('GROUP_REORDER_IDS_REQUIRED')
  })

  // ── E phase-3 leg: two concurrent production reorders, constructed real concurrency ─────────
  it('E (phase 3): two concurrent reorders of the SAME org both succeed; the final state is exactly ONE side\'s complete 1..n permutation, never a torn mix', async () => {
    const org = trackOrg(`atg-reorder-concurrent-${TS}`)
    const admin = await tok(base, `reorder-concurrent-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })

    const gA = await createGroup(base, admin, `Reorder Concurrent A ${TS}`)
    const gB = await createGroup(base, admin, `Reorder Concurrent B ${TS}`)
    const gC = await createGroup(base, admin, `Reorder Concurrent C ${TS}`)

    const orderX = [gC.id, gA.id, gB.id]
    const orderY = [gB.id, gC.id, gA.id]

    const [resX, resY] = await withRawClient(async (holder, holderPid) => {
      await holder.query('BEGIN')
      await holder.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`atg:${org}`])

      const reorderXPromise = httpReq(base, '/api/approval-template-groups/reorder', admin, {
        method: 'POST',
        body: { groupIds: orderX },
      })
      await waitUntilBackendBlockedByHolder(holderPid)

      const reorderYPromise = httpReq(base, '/api/approval-template-groups/reorder', admin, {
        method: 'POST',
        body: { groupIds: orderY },
      })
      // Both production requests genuinely queued behind the SAME holder before it releases —
      // not one finishing before the second is even sent.
      await waitUntilNBackendsBlockedByHolder(holderPid, 2)

      await holder.query('COMMIT')

      return await Promise.all([reorderXPromise, reorderYPromise])
    })

    expect(resX.status).toBe(200)
    expect(resY.status).toBe(200)

    const rows = await query<{ id: string; sort_order: number }>(
      `SELECT id, sort_order FROM approval_template_groups WHERE org_id = $1 ORDER BY sort_order`,
      [org],
    )
    const finalIds = rows.rows.map((r) => r.id)
    expect(rows.rows.map((r) => Number(r.sort_order))).toEqual([1, 2, 3])
    const matchesX = orderX.every((id, i) => id === finalIds[i])
    const matchesY = orderY.every((id, i) => id === finalIds[i])
    // Exactly one side's FULL permutation, never neither (a torn mix) and never — by construction,
    // since orderX !== orderY — both at once.
    expect(matchesX || matchesY).toBe(true)
    expect(matchesX && matchesY).toBe(false)
  })
})
