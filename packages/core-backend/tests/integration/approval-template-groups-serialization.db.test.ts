import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import net from 'net'
import { Client } from 'pg'

/**
 * Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18), §6 phase 1 real-DB
 * acceptance: E (sort_order serialization + COMMIT-time DEFERRABLE mapping) and K (L0 blocks
 * create/rename/unarchive — mechanical stall assertions).
 *
 * HARNESS: this file runs the ENTIRE service pool with REPEATABLE READ default AND a 5000ms
 * `lock_timeout` (`vi.hoisted` amends `DATABASE_URL` with `options=-c default_transaction_
 * isolation=repeatable\ read -c lock_timeout=5000` BEFORE the static imports below —
 * `PoolManager` is constructed at first import of the db module). BOTH options apply to every
 * connection the pool ever opens for this file's run AND to every `withRawClient` raw connection
 * below (they read the SAME amended `process.env.DATABASE_URL`) — a test elsewhere in this file
 * that unexpectedly blocks on a lock for 5s+ will hit `lock_timeout`, not hang forever; the
 * REVERSE positive control test (changesRequired #13 item 1, added 2026-09-18) is the only one of
 * this file's tests whose blocked path is EXPECTED to run into that ceiling — every other test's
 * holder commits within tens of ms of `waitUntilBackendBlockedByHolder` returning, well under it.
 * Precedent: `directory-source-freeze-lock-correctness.db.test.ts:43-53`. `vitest.integration.
 * config.ts` runs files in isolated forks with `fileParallelism:false`, so neither option can leak
 * into any other suite. A sentinel test asserts the RR posture is actually active (a silently-RC
 * harness would make every pin test below vacuous).
 *
 * A/A′/A″/A‴/B/B′/B″/F/G/H/I′ live in the SEPARATE normal-pool file
 * (`approval-template-groups-lifecycle.db.test.ts`) per §6's "两个新 .db.test.ts" split.
 *
 * Mutation probes for this file (run manually against the private `metasheet2_lock_a` database
 * via the required cp-backup → edit → re-run the ONE affected test → restore → `cmp` workflow;
 * recorded in the implementation PR's verification notes, not encoded as permanent code here —
 * same convention `directory-source-freeze-lock-correctness.db.test.ts`'s own header footnotes
 * follow ("Mutation proofs... exact signatures in PR body")):
 *   (1) delete the `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` line from
 *       `createApprovalTemplateGroup` → the "two concurrent creates" test's blocked connection's
 *       RR snapshot is fixed BEFORE it parks on the L0 lock (the advisory-lock SELECT is then the
 *       first statement), so it reads a stale MAX after the holder commits and its own COMMIT
 *       raises 23505 unmapped-to-500 (or, since the service DOES still map 23505→
 *       GROUP_SORT_CONFLICT even without the SET, the OBSERVABLE red signature is instead a
 *       DUPLICATE sort_order surviving — this file's assertion on the exact {1,2} sort_order set
 *       catches that);
 *   (2) delete the `pg_advisory_xact_lock` line → the second connection no longer blocks on the
 *       first at all (`waitUntilBackendBlockedByHolder` times out — a hard failure, not a silent
 *       pass);
 *   (3) delete the try/catch around `transaction(...)` in `createApprovalTemplateGroup` (the
 *       COMMIT-time-mapping mutation target) → the whole route handler's response never resolves
 *       (Express 4 does not catch an async rejection; `routes/approvals.ts` mounts via `app.use`,
 *       outside the plugin host's per-route wrapper) — the COMMIT-mapping test times out instead
 *       of asserting 500/GROUP_SORT_CONFLICT;
 *   (4) K's barrier for the rename leg is the L0 advisory lock itself (the holder takes no L1 row
 *       lock — see the K helper's own doc comment), so the discriminating mutation is deleting
 *       the `pg_advisory_xact_lock` line from `renameApprovalTemplateGroup` (mirrors mutation (2)
 *       for the rename path — round-3 gate P3-2: this recipe previously named a non-existent
 *       `takeOrgLock` helper and "two lines"; the lock call is a single inline
 *       `client.query('SELECT pg_advisory_xact_lock(...))` statement, same shape as mutation (2))
 *       → the rename request no longer blocks on the L0-only holder at all
 *       (`waitUntilBackendBlockedByHolder` times out — a hard failure, not a silent pass);
 *   (5) [changesRequired #13 item 1, REVERSE positive control] delete the
 *       `pg_advisory_xact_lock` line from `createApprovalTemplateGroupWithClient` → the test
 *       passed UNCHANGED on a first attempt without the `queryFragment` pin (the inner INSERT
 *       instead waits on the DEFERRABLE `atg_sort_unique` index's tuple lock against the outer's
 *       uncommitted row, raising the SAME 55P03 for a DIFFERENT reason — a confounded mutation,
 *       memory `feedback_confounded_mutation_needs_isolated_variant_grid`); pinning
 *       `waitUntilBackendBlockedByHolder`'s `queryFragment` to `pg_advisory_xact_lock` fixed this
 *       — the same mutation then times out (hard failure) as it should;
 *   (6) [changesRequired #13 item 3, execute lock-order] revert
 *       `executeApprovalTemplateGroupBackfillWithClient`'s single `id = ANY($2) ORDER BY id
 *       FOR UPDATE` pre-lock statement to a design-gate-M2 pre-fix per-category `id = $2 FOR
 *       UPDATE` loop → `waitUntilBackendBlockedByHolder`'s `queryFragment` pin to the batched
 *       statement's literal text never matches (hard timeout failure, not a silent pass);
 *   (7) [changesRequired #13 item 3, rollback lock-order] the SAME mutation shape in
 *       `rollbackApprovalTemplateGroupBackfillWithClient` (§4.2 unlink FIRST, then a fresh
 *       per-group `id = $2 FOR UPDATE`, design-gate M3 pre-fix order) → same hard timeout failure.
 *       An EARLIER draft of (6)/(7) asserted "the batch's link row is not yet written/unlinked"
 *       from a SEPARATE connection while blocked — that assertion was VACUOUS (an open
 *       transaction's writes are invisible to any other session regardless of statement order,
 *       ordinary MVCC visibility) and stayed GREEN under both mutations, catching nothing; the
 *       `queryFragment` pin on the blocked backend's own query TEXT (visible externally
 *       regardless of commit state, via `pg_stat_activity`) replaced it. (6)/(7) prove the
 *       STATEMENT SHAPE the fix requires is what execute/rollback actually stall on, NOT the
 *       L1-before-L2 acquisition ordering itself — that needs the two-party 40P01 construction
 *       from `reviews/a3-probe/{execute,rollback}-lockorder-probe.cjs` and remains open (see
 *       design doc remaining).
 */
vi.hoisted(() => {
  const base = process.env.DATABASE_URL
  if (base) {
    const sep = base.includes('?') ? '&' : '?'
    process.env.DATABASE_URL = `${base}${sep}options=${encodeURIComponent(
      // `lock_timeout` (added for changesRequired #13 item 1's reverse positive control, this
      // step): ONLY `lock_timeout` fires while a backend is actively WAITING ON A LOCK — a
      // pool-exhaustion stall or an ordinary slow statement never trips it (`statement_timeout`
      // would not distinguish the two), so a rejection under this setting is structurally
      // attributable to a lock wait, not some other cause. 5000ms is far above every OTHER test in
      // this file's actual block duration (each holder commits within tens of ms of
      // `waitUntilBackendBlockedByHolder` returning — see E/K below) so it cannot false-trip an
      // existing assertion, and far below this file's 30s `testTimeout`
      // (`vitest.integration.config.ts`).
      '-c default_transaction_isolation=repeatable\\ read -c lock_timeout=5000',
    )}`
  }
})

import { MetaSheetServer } from '../../src/index'
import { query, transaction } from '../../src/db/pg'
import {
  beginApprovalTemplateGroupTxn,
  createApprovalTemplateGroup,
  createApprovalTemplateGroupWithClient,
} from '../../src/services/ApprovalTemplateGroupService'

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

async function tok(base: string, userId: string, tenantId: string): Promise<string> {
  const params = new URLSearchParams({ userId, roles: 'admin', perms: '*:*', tenantId })
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

/** Same shape/name as `approval-record-link.db.test.ts`'s own helper — see that file's precedent. */
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

describeIfDatabase('approval template groups — L0 serialization + DEFERRABLE COMMIT mapping (lock v2.13 phase 1, E/K, RR-default pool harness)', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  const orgTags: string[] = []

  itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('sentinel: the service pool REALLY runs repeatable-read default — a bare-BEGIN generic transaction is RR', async () => {
    const def = await query<{ iso: string }>(`SELECT current_setting('default_transaction_isolation') AS iso`)
    expect(def.rows[0].iso).toBe('repeatable read')
    const inTxn = await transaction(async (client) => {
      const r = (await client.query(`SELECT current_setting('transaction_isolation') AS iso`)) as {
        rows: Array<{ iso: string }>
      }
      return r.rows[0].iso
    })
    expect(inTxn).toBe('repeatable read')
  })

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
  })

  afterAll(async () => {
    for (const org of orgTags.splice(0)) {
      // Deleting the batch header cascades to both child tables (`atgbbg_batch_fk` /
      // `atgbbl_batch_fk` are `ON DELETE CASCADE` — design-gate-A3-phase2 §Q5) — a no-op for every
      // org this file's OTHER tests track (only the new A-3 SET-obligation test below writes these
      // tables), and must run BEFORE the groups delete: `atgbbg_group_fk` is `ON DELETE NO ACTION`.
      await query(`DELETE FROM approval_template_group_backfill_batches WHERE org_id = $1`, [org])
      await query(`DELETE FROM approval_template_group_links WHERE org_id = $1`, [org])
      await query(`DELETE FROM approval_template_groups WHERE org_id = $1`, [org])
    }
    await server?.stop()
  })

  function trackOrg(org: string): string {
    orgTags.push(org)
    return org
  }

  // ── E: raw-SQL positive controls (DDL-level, no HTTP / no barrier needed) ─────────────────
  it('E positive control: two same-org active groups committing the SAME sort_order hit 23505 on atg_sort_unique at COMMIT, not at INSERT', async () => {
    const org = trackOrg(`atg-epc-${TS}`)
    await withRawClient(async (c1) => {
      await c1.query('BEGIN')
      await c1.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await c1.query(
        `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by) VALUES ($1,$2,$3,1,'probe')`,
        [`atg_epc1_${TS}`, org, `EPC1 ${TS}`],
      )
      await withRawClient(async (c2) => {
        await c2.query('BEGIN')
        await c2.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
        // Statement-time: NO error — the constraint is DEFERRABLE, so a duplicate may exist
        // transiently. This is the load-bearing shape §2 depends on for a multi-row reorder.
        await expect(
          c2.query(
            `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by) VALUES ($1,$2,$3,1,'probe')`,
            [`atg_epc2_${TS}`, org, `EPC2 ${TS}`],
          ),
        ).resolves.toBeDefined()

        await c1.query('COMMIT') // first committer: succeeds (nothing else committed yet).
        await expect(c2.query('COMMIT')).rejects.toMatchObject({ code: '23505', constraint: 'atg_sort_unique' })
      })
    })
  })

  it('E positive control: archiving without clearing sort_order hits the paired CHECK (atg_sort_archived_pair) immediately', async () => {
    const org = trackOrg(`atg-epc2-${TS}`)
    const row = await query<{ id: string }>(
      `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by) VALUES ($1,$2,$3,1,'probe') RETURNING id`,
      [`atg_epcheck_${TS}`, org, `EPCheck ${TS}`],
    )
    await expect(
      query(`UPDATE approval_template_groups SET archived_at = now() WHERE id = $1`, [row.rows[0].id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'atg_sort_archived_pair' })
  })

  // ── E: main behavior (production path, L0 barrier) ────────────────────────────────────────
  it('E: two concurrent creates via the PRODUCTION path get sort_order n+1/n+2 — the RC pin lets the second read the freshly-committed MAX', async () => {
    const org = trackOrg(`atg-e-${TS}`)
    const admin = await tok(base, `e-admin-${TS}`, org)

    await withRawClient(async (holder, holderPid) => {
      await holder.query('BEGIN')
      await holder.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`atg:${org}`])
      const maxRow = await holder.query<{ next: number }>(
        `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM approval_template_groups WHERE org_id = $1`,
        [org],
      )
      const holderNext = Number(maxRow.rows[0].next)
      await holder.query(
        `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by) VALUES ($1,$2,$3,$4,'holder')`,
        [`atg_e_holder_${TS}`, org, `E Holder ${TS}`, holderNext],
      )

      const createPromise = httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: `E B ${TS}` } })
      await waitUntilBackendBlockedByHolder(holderPid)

      await holder.query('COMMIT')

      const res = await createPromise
      expect(res.status).toBe(201)
      const created = (await res.json()).group
      expect(created.sortOrder).toBe(holderNext + 1)
    })

    const rows = await query<{ sort_order: number }>(
      `SELECT sort_order FROM approval_template_groups WHERE org_id = $1 ORDER BY sort_order`,
      [org],
    )
    expect(rows.rows.map((r) => Number(r.sort_order))).toEqual([1, 2])
  })

  // CORRECTED LABEL (prior title/comment overclaimed): this does NOT probe mutation-2 ("去掉 L0
  // 顾问锁 ⇒ B 不停车") — it asserts that an UNRELATED advisory key never blocks a concurrent
  // create, which is true regardless of whether the production path takes L0 on the correct
  // `atg:${org}` key or takes no lock at all, so it has zero power to discriminate mutation-2's
  // removal. Its actual job is a negative control on the `pg_blocking_pids` polling query itself
  // (proving it does not false-positive on an unrelated holder). Mutation-2's real, verified
  // discriminator is the three K it()s below (`waitUntilBackendBlockedByHolder` against a holder
  // that DOES take the real `atg:${org}` L0 key): if production dropped its own L0 acquisition,
  // those three would stall waiting for a block that production never causes and fail on timeout.
  it('E: negative control — an unrelated advisory key never blocks a concurrent create (sanity check on the pg_blocking_pids probe, not a mutation-2 gate — see K below for that)', async () => {
    const org = trackOrg(`atg-enol0-${TS}`)
    const admin = await tok(base, `enol0-admin-${TS}`, org)

    await withRawClient(async (holder, holderPid) => {
      await holder.query('BEGIN')
      // Deliberately NOT pg_advisory_xact_lock — a plain, unrelated advisory key.
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`unrelated:${org}`])

      const createPromise = httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: `NoL0 ${TS}` } })
      const res = await createPromise
      expect(res.status).toBe(201)

      const blocked = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
        [holderPid],
      )
      expect(blocked.rows[0].n).toBe(0)
      await holder.query('COMMIT')
    })
  })

  it('E: COMMIT-time (not statement-time) DEFERRABLE violation on the production create path maps to 500 GROUP_SORT_CONFLICT', async () => {
    const org = trackOrg(`atg-ecommit-${TS}`)
    const admin = await tok(base, `ecommit-admin-${TS}`, org)

    await withRawClient(async (c, cPid) => {
      // The value the endpoint is ABOUT to compute for a fresh org: MAX+1 == 1. This connection
      // deliberately does NOT take L0 (§2: "otherwise 端点停在 L0, 正向格自己红").
      await c.query('BEGIN')
      await c.query(
        `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by) VALUES ($1,$2,$3,1,'c-holder')`,
        [`atg_ec_${TS}`, org, `EC Holder ${TS}`],
      )

      // Fire-and-do-not-await: awaiting the response before committing C would deadlock (the
      // endpoint's COMMIT waits on C; C's commit is what this test controls).
      const createPromise = httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: `EC B ${TS}` } })
      const blockedPid = await waitUntilBackendBlockedByHolder(cPid, { queryFragment: 'COMMIT', timeoutMs: 15_000 })
      expect(blockedPid).toBeGreaterThan(0)

      await c.query('COMMIT')

      const res = await createPromise
      expect(res.status).toBe(500)
      expect((await res.json()).error.code).toBe('GROUP_SORT_CONFLICT')
    })
  })

  // ── K: L0-only holder stalls create / rename / unarchive (mechanical, not result-based) ────
  it('K: an L0-only holder (no L1 row lock) stalls a concurrent CREATE in the same org', async () => {
    const org = trackOrg(`atg-k-create-${TS}`)
    const admin = await tok(base, `k-create-admin-${TS}`, org)

    await withRawClient(async (holder, holderPid) => {
      await holder.query('BEGIN')
      await holder.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`atg:${org}`])
      // Explicit precondition (lock's own footnote — an L1 hold would let a mutant stall too):
      // this connection takes ONLY the advisory lock, never a groups-row FOR UPDATE.

      const createPromise = httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: `K Create ${TS}` } })
      const blockedPid = await waitUntilBackendBlockedByHolder(holderPid)
      expect(blockedPid).toBeGreaterThan(0)

      await holder.query('COMMIT')

      const res = await createPromise
      expect(res.status).toBe(201)
    })
  })

  it('K: an L0-only holder stalls a concurrent RENAME of an existing group in the same org', async () => {
    const org = trackOrg(`atg-k-rename-${TS}`)
    const admin = await tok(base, `k-rename-admin-${TS}`, org)
    const group = (await (await httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: `K Rename Before ${TS}` } })).json()).group

    await withRawClient(async (holder, holderPid) => {
      await holder.query('BEGIN')
      await holder.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`atg:${org}`])

      const renamePromise = httpReq(base, `/api/approval-template-groups/${group.id}`, admin, { method: 'PATCH', body: { name: `K Rename After ${TS}` } })
      const blockedPid = await waitUntilBackendBlockedByHolder(holderPid)
      expect(blockedPid).toBeGreaterThan(0)

      await holder.query('COMMIT')

      const res = await renamePromise
      expect(res.status).toBe(200)
      expect((await res.json()).group.name).toBe(`K Rename After ${TS}`)
    })
  })

  it('K: an L0-only holder stalls a concurrent UNARCHIVE of an archived group in the same org', async () => {
    const org = trackOrg(`atg-k-unarchive-${TS}`)
    const admin = await tok(base, `k-unarchive-admin-${TS}`, org)
    const group = (await (await httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: `K Unarchive ${TS}` } })).json()).group
    const archived = await httpReq(base, `/api/approval-template-groups/${group.id}/archive`, admin, { method: 'POST' })
    expect(archived.status).toBe(200)

    await withRawClient(async (holder, holderPid) => {
      await holder.query('BEGIN')
      await holder.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`atg:${org}`])

      const unarchivePromise = httpReq(base, `/api/approval-template-groups/${group.id}/unarchive`, admin, { method: 'POST' })
      const blockedPid = await waitUntilBackendBlockedByHolder(holderPid)
      expect(blockedPid).toBeGreaterThan(0)

      await holder.query('COMMIT')

      const res = await unarchivePromise
      expect(res.status).toBe(200)
      expect((await res.json()).group.archivedAt).toBeNull()
    })
  })

  // ── A-3 combined-caller SET obligation (design-gate-A3-phase2 changesRequired #13, item 2) ──
  // This file's own header + K's four documented mutations only ever probed SINGLE-primitive
  // callers (`createApprovalTemplateGroup` etc., each opening its OWN `transaction()` and calling
  // `beginApprovalTemplateGroupTxn` once). The gate's changesRequired #13 point 2 requires the SAME
  // RR-pool discriminating shape for a COMPOSED caller — `executeApprovalTemplateGroupBackfill`,
  // which calls `beginApprovalTemplateGroupTxn` once and threads the branded client into TWO
  // `...WithClient` primitives — because a regression that drops the composed caller's own SET call
  // (while leaving every single-primitive wrapper untouched) would be invisible to every existing
  // `it()` in this file.
  it('A-3 execute (composed caller): under the RR-default pool, execute still reads a concurrently-committed holder row at MAX(sort_order) — proving the SET this composed transaction issues is not a single-primitive-only obligation', async () => {
    const org = trackOrg(`atg-a3set-${TS}`)
    const admin = await tok(base, `a3set-admin-${TS}`, org)
    const category = `ExecCat-${TS}`
    const tplRow = await query<{ id: string }>(
      `INSERT INTO approval_templates (key, name, status, category, visibility_scope)
       VALUES ($1, $1, 'draft', $2, $3) RETURNING id`,
      [`atg-a3set-tpl-${TS}`, category, JSON.stringify({ type: 'all', ids: [] })],
    )
    const templateId = tplRow.rows[0].id

    try {
      await withRawClient(async (holder, holderPid) => {
        await holder.query('BEGIN')
        await holder.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
        await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`atg:${org}`])
        await holder.query(
          `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by) VALUES ($1,$2,$3,1,'holder')`,
          [`atg_a3set_holder_${TS}`, org, `HolderCat ${TS}`],
        )

        // Same shape as E above: execute's own L0 acquisition parks behind holder's; under the
        // correct (SET-issued) path, once granted, execute's SUBSEQUENT reads (including the
        // create-primitive's `MAX(sort_order)+1`) see holder's now-committed row per-statement
        // (READ COMMITTED). Under the mutant (no SET ⇒ this connection runs under the pool's
        // REPEATABLE READ default), the whole transaction's snapshot is fixed at execute's FIRST
        // statement — the L0 `pg_advisory_xact_lock` SELECT — BEFORE it parks, so it never sees
        // holder's row at all: the create-primitive computes sort_order=1 again, and holder's
        // ALREADY-COMMITTED row of the same value collides with it at COMMIT (`atg_sort_unique`,
        // DEFERRABLE) — the whole execute() transaction rolls back, surfacing as 500, not 201.
        const executePromise = httpReq(base, '/api/approval-template-groups/backfill/execute', admin, { method: 'POST' })
        await waitUntilBackendBlockedByHolder(holderPid)

        await holder.query('COMMIT')

        const res = await executePromise
        expect(res.status).toBe(201)
        const body = (await res.json()) as {
          groups: Array<{ category: string; action: string; templateIds: string[] }>
        }
        const own = body.groups.find((g) => g.category === category)
        expect(own).toBeDefined()
        expect(own!.action).toBe('create')
        expect(own!.templateIds).toEqual([templateId])
      })

      const ownGroup = await query<{ sort_order: number }>(
        `SELECT sort_order FROM approval_template_groups WHERE org_id = $1 AND name = $2`,
        [org, category],
      )
      expect(ownGroup.rowCount).toBe(1)
      // Strictly greater than holder's committed sort_order=1 — the RR mutant's failure mode is
      // NOT a smaller/duplicate value surviving (that scenario rolls back at COMMIT, see above and
      // this file's own header note (1)); this assertion is belt-and-suspenders on top of the
      // res.status check, not a substitute for it.
      expect(Number(ownGroup.rows[0].sort_order)).toBeGreaterThan(1)
    } finally {
      await query(`DELETE FROM approval_templates WHERE id = $1`, [templateId])
    }
  })

  // ── A-3 changesRequired #13 item 1: reverse positive control for §3.0's ...WithClient split ──
  // §3.0's file-header note predicts a SPECIFIC failure mode for a composed caller that misuses
  // the API — awaiting a non-`WithClient` exported function (which opens its OWN `transaction()`,
  // i.e. draws a SECOND connection from the pool) from INSIDE an already-open `transaction()`
  // callback that already holds this org's L0 advisory lock. This test reproduces that misuse
  // against the REAL exported `createApprovalTemplateGroup` (not a synthetic replay of the
  // mechanism) and pins the failure to the predicted mechanism, not a lookalike one:
  //   - the pool (`DB_POOL_MAX` default 20 — `connection-pool.ts`) has ample headroom for a
  //     second connection, so a rejection here cannot be pool-exhaustion;
  //   - `lock_timeout` (file-wide, see the `vi.hoisted` block above) fires ONLY while a backend is
  //     actively WAITING ON A LOCK — it structurally excludes both pool-acquire and an ordinary
  //     slow query as the cause;
  //   - `pg_blocking_pids` independently names the OUTER transaction's own backend as the thing
  //     the inner call is blocked on, AT THE MOMENT it is blocked — not inferred after the fact
  //     from the error alone (verified against a standalone two-connection probe — 55P03,
  //     "canceling statement due to lock timeout" — before this assertion was written);
  //   - the blocked backend's OWN active query text is asserted to contain `pg_advisory_xact_lock`
  //     (`waitUntilBackendBlockedByHolder`'s `queryFragment` option, same technique as the E
  //     COMMIT-mapping test above) — naming the specific statement it is parked on, not merely
  //     "some statement". This was NOT decorative: an early draft of this test removed L0 from
  //     `createApprovalTemplateGroupWithClient` as its mutation and found the test STILL passed —
  //     without L0, the inner INSERT instead waits on the (also real, also documented — see this
  //     file's header note (1)) DEFERRABLE `atg_sort_unique` index's tuple lock against the outer's
  //     uncommitted row, which raises the SAME 55P03 for a DIFFERENT reason. Only pinning the
  //     blocked query's TEXT to the advisory-lock statement isolates the claim this test is
  //     actually about (memory `feedback_confounded_mutation_needs_isolated_variant_grid`).
  // The "组合正例" half of changesRequired #13 item 1 is the existing A-3 execute (composed
  // caller) test directly above — a composed caller correctly using the `...WithClient` split
  // succeeding under contention. This test is its REVERSE: proving the split is load-bearing, not
  // stylistic, by showing what happens when a composed caller does NOT use it.
  it('REVERSE positive control (§3.0, changesRequired #13 item 1): awaiting a non-WithClient exported function from inside an already-open transaction() self-deadlocks at the L0 lock wait, not at connection-pool acquisition', async () => {
    const org = trackOrg(`atg-revctl-${TS}`)
    let blockedByOuter = 0

    const outerReturn = await transaction(async (client) => {
      const txClient = await beginApprovalTemplateGroupTxn(client)
      // Outer takes L0 for `org` itself, via the SAME real primitive a composed caller's first
      // `...WithClient` call would use — not a raw `pg_advisory_xact_lock` stand-in.
      await createApprovalTemplateGroupWithClient(txClient, org, `Outer ${TS}`, 'outer')
      const pidRow = await client.query('SELECT pg_backend_pid() AS pid')
      const outerPid = Number((pidRow.rows[0] as { pid: number }).pid)

      // MISUSE under test: the thin, non-WithClient wrapper, awaited from inside this already-open
      // transaction() — exactly the shape §3.0's file header names, not a paraphrase of it.
      const innerPromise = createApprovalTemplateGroup(org, `Inner ${TS}`, 'inner').then(
        () => ({ ok: true as const }),
        (e: unknown) => ({
          ok: false as const,
          code: (e as { code?: string } | undefined)?.code,
          message: String((e as { message?: unknown } | undefined)?.message ?? e),
        }),
      )

      blockedByOuter = await waitUntilBackendBlockedByHolder(outerPid, { queryFragment: 'pg_advisory_xact_lock' })
      return await innerPromise
    })

    expect(blockedByOuter).toBeGreaterThan(0)
    expect(outerReturn.ok).toBe(false)
    if (!outerReturn.ok) {
      // 55P03 = lock_not_available (PostgreSQL's code when `lock_timeout` cancels a lock wait).
      expect(outerReturn.code).toBe('55P03')
    }

    // The outer transaction's OWN work (creating "Outer") must have committed — `transaction()`
    // only rolls back on a THROWN error, and the outer callback caught the inner misuse's
    // rejection and returned it as a value, so it never threw.
    const rows = await query<{ name: string }>(`SELECT name FROM approval_template_groups WHERE org_id = $1`, [org])
    expect(rows.rows.map((r) => r.name)).toEqual([`Outer ${TS}`])
  })

  // ── A-3 changesRequired #13 item 3: execute/rollback lock-order format, parking point only ────
  // §13.2's fix for design-gate M2/M3 replaced a PER-CATEGORY/PER-GROUP `id = $2 FOR UPDATE` loop
  // (pre-fix: L1→L2→L1→L2…, deadlocking against a concurrent plain link/unlink request's own
  // L1→L2 order — `reviews/a3-probe/execute-lockorder-probe.cjs` /
  // `rollback-lockorder-probe.cjs` demonstrated the pre-fix 40P01) with ONE deterministic
  // `id = ANY($2) ORDER BY id FOR UPDATE` statement that pre-locks EVERY existing group a call
  // touches BEFORE any L2 write. The gate's instruction is to assert the PARKING POINT, not the
  // terminal state.
  //
  // An earlier draft of these two tests tried to assert "the batch's L2 write has not happened
  // yet" by reading `approval_template_group_links` from a SEPARATE connection while the holder
  // blocks execute/rollback — and that assertion was VACUOUS: a still-open transaction's writes
  // are invisible to any other session regardless of statement order (ordinary MVCC visibility),
  // so it read zero rows whether or not the write had actually happened inside the blocked
  // transaction. The mutation below is what caught this: the vacuous version passed unchanged
  // under the pre-fix mutant, proving it had zero discriminating power (memory
  // `feedback_confounded_mutation_needs_isolated_variant_grid` — the fix here is analogous:
  // isolate to a signal an outside observer CAN actually see).
  //
  // `pg_stat_activity.query` sidesteps this: it shows the blocked backend's OWN currently-
  // executing statement TEXT, which is visible to any observer regardless of whether that
  // statement's transaction has committed. `waitUntilBackendBlockedByHolder`'s `queryFragment`
  // pins the blocked query to the literal `id = ANY($2) ORDER BY id FOR UPDATE` fragment — proven
  // present verbatim in `pg_stat_activity.query` for this exact statement shape via a standalone
  // two-connection probe before this assertion was written (node-postgres sends the parameterized
  // text as-is; PG 15 does not rewrite or truncate it for a statement this short). Under a
  // reverted-to-pre-fix mutant (per-category `id = $2 FOR UPDATE`, no `ANY`, no `ORDER BY`), the
  // blocked query would have a DIFFERENT text and the fragment would never match — a hard timeout
  // failure, not a silent pass (verified below). This proves the STATEMENT SHAPE the fix requires
  // is what execute/rollback actually stall on — not proof of the L1-before-L2 write ordering
  // itself (that requires the two-party 40P01 construction the probes above used, out of scope
  // for this step — see remaining).
  it('execute lock-order (design-gate M2, §13.2 fix): stalls on the batched deterministic pre-lock statement, not a per-category one', async () => {
    const org = trackOrg(`atg-lo-exec-${TS}`)
    const admin = await tok(base, `lo-exec-admin-${TS}`, org)
    const category = `LOExec-${TS}`
    const groupId = `atg_loexec_${TS}`
    await query(
      `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by) VALUES ($1,$2,$3,1,'seed')`,
      [groupId, org, category],
    )
    const tplRow = await query<{ id: string }>(
      `INSERT INTO approval_templates (key, name, status, category, visibility_scope)
       VALUES ($1, $1, 'draft', $2, $3) RETURNING id`,
      [`atg-loexec-tpl-${TS}`, category, JSON.stringify({ type: 'all', ids: [] })],
    )
    const templateId = tplRow.rows[0].id

    try {
      await withRawClient(async (holder, holderPid) => {
        await holder.query('BEGIN')
        // Holder takes L1 on the ONE existing group — no L0.
        await holder.query(`SELECT archived_at FROM approval_template_groups WHERE org_id = $1 AND id = $2 FOR UPDATE`, [
          org,
          groupId,
        ])

        const executePromise = httpReq(base, '/api/approval-template-groups/backfill/execute', admin, { method: 'POST' })
        const blockedPid = await waitUntilBackendBlockedByHolder(holderPid, {
          queryFragment: 'id = ANY($2) ORDER BY id FOR UPDATE',
        })
        expect(blockedPid).toBeGreaterThan(0)

        await holder.query('COMMIT')

        const res = await executePromise
        expect(res.status).toBe(201)
      })

      const linkAfter = await query<{ group_id: string }>(
        `SELECT group_id FROM approval_template_group_links WHERE org_id = $1 AND template_id = $2`,
        [org, templateId],
      )
      expect(linkAfter.rows[0]?.group_id).toBe(groupId)
    } finally {
      await query(`DELETE FROM approval_templates WHERE id = $1`, [templateId])
    }
  })

  // Sibling of the execute format above, for rollback (design-gate M3). Rollback's fix pre-locks
  // its target group with the SAME `id = ANY($2) ORDER BY id FOR UPDATE` shape — see
  // `ApprovalTemplateGroupService.ts`'s `rollbackApprovalTemplateGroupBackfillWithClient` — before
  // its §4.2 unlink runs, replacing a pre-fix order that unlinked FIRST, then took a fresh
  // `id = $2 FOR UPDATE` per group.
  it('rollback lock-order (design-gate M3, §13.2 fix): stalls on the batched deterministic pre-lock statement, not a per-group one', async () => {
    const org = trackOrg(`atg-lo-rb-${TS}`)
    const admin = await tok(base, `lo-rb-admin-${TS}`, org)
    const category = `LORollback-${TS}`
    const tplRow = await query<{ id: string }>(
      `INSERT INTO approval_templates (key, name, status, category, visibility_scope)
       VALUES ($1, $1, 'draft', $2, $3) RETURNING id`,
      [`atg-lorb-tpl-${TS}`, category, JSON.stringify({ type: 'all', ids: [] })],
    )
    const templateId = tplRow.rows[0].id

    try {
      const executeRes = await httpReq(base, '/api/approval-template-groups/backfill/execute', admin, { method: 'POST' })
      expect(executeRes.status).toBe(201)
      const executeBody = (await executeRes.json()) as {
        batchId: string | null
        groups: Array<{ groupId: string; category: string; templateIds: string[] }>
      }
      const own = executeBody.groups.find((g) => g.category === category)
      expect(own).toBeDefined()
      const groupId = own!.groupId
      const batchId = executeBody.batchId
      expect(batchId).not.toBeNull()

      await withRawClient(async (holder, holderPid) => {
        await holder.query('BEGIN')
        // Holder takes L1 on the SAME group rollback will need for its archive check — no L0
        // (this format is specifically about the L1<->L2 ORDER, not about L0 contention, which K
        // above already covers).
        await holder.query(`SELECT archived_at FROM approval_template_groups WHERE org_id = $1 AND id = $2 FOR UPDATE`, [
          org,
          groupId,
        ])

        const rollbackPromise = httpReq(base, `/api/approval-template-groups/backfill/batches/${batchId}/rollback`, admin, {
          method: 'POST',
        })
        const blockedPid = await waitUntilBackendBlockedByHolder(holderPid, {
          queryFragment: 'id = ANY($2) ORDER BY id FOR UPDATE',
        })
        expect(blockedPid).toBeGreaterThan(0)

        await holder.query('COMMIT')

        const res = await rollbackPromise
        expect(res.status).toBe(200)
      })

      const linkAfter = await query<{ group_id: string | null; unlinked_at: string | null }>(
        `SELECT group_id, unlinked_at FROM approval_template_group_links WHERE org_id = $1 AND template_id = $2`,
        [org, templateId],
      )
      expect(linkAfter.rows[0].group_id).toBeNull()
      expect(linkAfter.rows[0].unlinked_at).not.toBeNull()

      const groupAfter = await query<{ archived_at: string | null }>(
        `SELECT archived_at FROM approval_template_groups WHERE org_id = $1 AND id = $2`,
        [org, groupId],
      )
      expect(groupAfter.rows[0].archived_at).not.toBeNull()
    } finally {
      await query(`DELETE FROM approval_templates WHERE id = $1`, [templateId])
    }
  })
})
