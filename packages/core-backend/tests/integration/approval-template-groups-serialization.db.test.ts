import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import net from 'net'
import { Client } from 'pg'

/**
 * Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18), §6 phase 1 real-DB
 * acceptance: E (sort_order serialization + COMMIT-time DEFERRABLE mapping) and K (L0 blocks
 * create/rename/unarchive — mechanical stall assertions).
 *
 * HARNESS: this file runs the ENTIRE service pool with REPEATABLE READ default (`vi.hoisted`
 * amends `DATABASE_URL` with `options=-c default_transaction_isolation=repeatable\ read` BEFORE
 * the static imports below — `PoolManager` is constructed at first import of the db module).
 * Precedent: `directory-source-freeze-lock-correctness.db.test.ts:43-53`. `vitest.integration.
 * config.ts` runs files in isolated forks with `fileParallelism:false`, so the RR default cannot
 * leak into any other suite. A sentinel test asserts the posture is actually active (a silently-RC
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
 *       (`waitUntilBackendBlockedByHolder` times out — a hard failure, not a silent pass).
 */
vi.hoisted(() => {
  const base = process.env.DATABASE_URL
  if (base) {
    const sep = base.includes('?') ? '&' : '?'
    process.env.DATABASE_URL = `${base}${sep}options=${encodeURIComponent(
      '-c default_transaction_isolation=repeatable\\ read',
    )}`
  }
})

import { MetaSheetServer } from '../../src/index'
import { query, transaction } from '../../src/db/pg'

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
})
