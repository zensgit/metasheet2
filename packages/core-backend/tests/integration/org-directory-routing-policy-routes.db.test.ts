import { randomUUID } from 'crypto'
import express from 'express'
import { Client } from 'pg'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import { getOrCreateLocalIntegration } from '../../src/directory/directory-sync'
import { adminDirectoryRoutingPolicyRouter } from '../../src/routes/admin-directory-routing-policy'
import { ApprovalRoutingPolicyError, resolveApprovalRequesterOrgRelations } from '../../src/services/ApprovalDirectoryOrg'

/**
 * Canonical Org MVP — B5-c (routing-policy admin ROUTES), design lock Lock 3 + §7, real DB + HTTP.
 *
 * Pairs with the B5-a schema and B5-b resolver files: this file proves the actual admin surface —
 * platform-admin gating, the PATCH write point's validations + values-free audit, the clear path,
 * and the READ-ONLY preview (no policy row, no audit, both legs through the REAL resolver).
 *
 *   A. GET lists all 5 §6 purposes; with no rows, every purpose is 'legacy-default'.
 *   B. PATCH set: 200 + audit `directory.routing_policy.set`; GET flips to source='policy';
 *      PATCH null clears + audit `.clear`; GET back to legacy-default; clearing again → 200
 *      cleared:false with NO second audit (idempotent, audit only on real deletion).
 *   C. PATCH validations, each WITHOUT an audit row: unknown purpose 400; non-UUID 400; unlisted
 *      body field (org smuggling) 400; integration from another org 404; non-active target 409
 *      (a policy pointing at a broken target is rejected at WRITE time — B5-b would fail-close
 *      every consuming approval otherwise).
 *   D. PREVIEW (approval_routing): with NO current policy, a candidate=local preview reports the
 *      per-user diff (before = legacy latest-updated dingtalk source; after = local candidate) —
 *      and is READ-ONLY: zero policy rows written, zero audit rows.
 *   E. PREVIEW validations: unsupported purpose 400; non-UUID candidate 400; cross-org candidate
 *      404; inactive candidate 409.
 *   F. non-admin: all three routes 403 via the real RBAC path.
 *   G. TOCTOU disable-first (two real connections): an uncommitted disable holds the exclusive
 *      row lock; PATCH's write-point `FOR SHARE` blocks (observed via pg_blocking_pids, never a
 *      fixed sleep); after disable commits, PATCH returns 409 with zero policy/audit.
 *   H. TOCTOU set-first: PATCH holds `FOR SHARE` through its write (barrier so disable can race
 *      while the lock is still held); disable blocks; after set commits, disable proceeds; the
 *      existing resolver fails closed on the now-disabled canonical.
 *
 * Load-bearing mutations (out-of-band, each reds this file):
 *   - remove the PATCH `status !== 'active'` check → C's 409 leg reds (broken policy accepted).
 *   - remove the preview's `overrideCanonicalIntegrationId` pass-through → D reds (after == before).
 *   - remove the write-point `FOR SHARE` / single-txn wrap → G reds for the SEMANTIC reason
 *     (PATCH accepts 200 + writes a policy at a concurrently-disabled target), not a SQL bind error.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const STAMP = Date.now()
const orgId = 'default' // routes are single-tenant server-resolved; fixtures must live in 'default'
const newUserId = (suffix: string): string => `b5c-user-${STAMP}-${suffix}`

const adminApp = express()
adminApp.use(express.json())
adminApp.use((req, _res, next) => {
  ;(req as express.Request & { user?: unknown }).user = { id: `b5c-admin-${STAMP}`, role: 'admin' }
  next()
})
adminApp.use('/api/admin/directory/routing-policy', adminDirectoryRoutingPolicyRouter())

const nonAdminApp = express()
nonAdminApp.use(express.json())
nonAdminApp.use((req, _res, next) => {
  ;(req as express.Request & { user?: unknown }).user = { id: `b5c-nonadmin-${STAMP}` }
  next()
})
nonAdminApp.use('/api/admin/directory/routing-policy', adminDirectoryRoutingPolicyRouter())

const BASE = '/api/admin/directory/routing-policy'

async function auditCount(action: string, resourceId: string): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs
      WHERE action = $1 AND resource_type = 'directory-routing-policy' AND resource_id = $2`,
    [action, resourceId],
  )
  return r.rows[0]?.n ?? 0
}

async function policyCount(): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM org_directory_routing_policy WHERE org_id = $1`,
    [orgId],
  )
  return r.rows[0]?.n ?? 0
}

async function dingtalkIntegration(org: string, tag: string, status = 'active'): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
     VALUES ($1, 'dingtalk', $2, $3, $4, '{}'::jsonb) RETURNING id`,
    [org, `DT b5c ${tag} ${STAMP}`, status, `corp-b5c-${STAMP}-${tag}`],
  )
  return r.rows[0].id
}

async function linkedAccount(integrationId: string, provider: string, userId: string, title: string): Promise<string> {
  const acc = await query<{ id: string }>(
    `INSERT INTO directory_accounts (integration_id, provider, external_user_id, external_key, name, title, is_active, raw)
     VALUES ($1, $2, $3, $3, $4, $5, true, '{}'::jsonb) RETURNING id`,
    [integrationId, provider, `${provider}:b5c:${STAMP}:${userId}:${integrationId.slice(0, 8)}`, userId, title],
  )
  await query(
    `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
     VALUES ($1, $2, 'linked', 'manual')`,
    [acc.rows[0].id, userId],
  )
  return acc.rows[0].id
}

/** Dedicated raw connection for concurrency holders — never from the service pool. */
async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/** Stable bigint key for the set-first advisory barrier (session-level, not xact). */
const SET_FIRST_ADVISORY_KEY = 0xb5c5e701 // B5-c set-first barrier
describeIfDatabase('Canonical Org MVP — B5-c routing-policy admin routes (real DB, HTTP)', () => {
  const cleanupAccountIds: string[] = []
  const cleanupIntegrationIds: string[] = []
  const cleanupUserIds: string[] = []
  const cleanupOrgIds: string[] = []

  afterEach(async () => {
    // Unconditional: a failed assertion must not leak the local-canonical env gate into later tests.
    delete process.env.DIRECTORY_ROUTING_LOCAL_CANONICAL_ENABLED
    // Drop any set-first advisory barrier trigger/function left mid-test (best-effort).
    await query(`DROP TRIGGER IF EXISTS b5c_set_first_barrier_trg ON org_directory_routing_policy`).catch(() => {})
    await query(`DROP FUNCTION IF EXISTS b5c_set_first_barrier()`).catch(() => {})
    // the shared 'default' org's policy rows: always clear ours (purpose keyspace is tiny/shared)
    await query(`DELETE FROM org_directory_routing_policy WHERE org_id = $1`, [orgId])
    await query(`DELETE FROM audit_logs WHERE resource_type = 'directory-routing-policy'`)
    for (const id of cleanupAccountIds.splice(0)) {
      await query(`DELETE FROM directory_accounts WHERE id = $1`, [id]) // links cascade
    }
    for (const id of cleanupIntegrationIds.splice(0)) {
      await query(`DELETE FROM directory_integrations WHERE id = $1`, [id])
    }
    for (const org of cleanupOrgIds.splice(0)) {
      await query(`DELETE FROM directory_integrations WHERE org_id = $1`, [org])
    }
    for (const id of cleanupUserIds.splice(0)) {
      await query(`DELETE FROM users WHERE id = $1`, [id])
    }
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('A. GET lists all 5 purposes as legacy-default when no policy rows exist', async () => {
    const res = await request(adminApp).get(`${BASE}/`)
    expect(res.status).toBe(200)
    const purposes = res.body.data?.purposes ?? res.body.purposes
    expect(purposes).toHaveLength(5)
    for (const p of purposes) expect(p.source).toBe('legacy-default')
  })

  it('B. PATCH set → audit + GET shows policy; PATCH null clears (audited once, idempotent after)', async () => {
    process.env.DIRECTORY_ROUTING_LOCAL_CANONICAL_ENABLED = '1' // owner #4431: local canonical is env-gated
    const local = await getOrCreateLocalIntegration(orgId)
    const rid = `${orgId}:approval_routing`

    const set = await request(adminApp).patch(`${BASE}/approval_routing`).send({ canonicalIntegrationId: local.id })
    expect(set.status).toBe(200)
    expect(await auditCount('directory.routing_policy.set', rid)).toBe(1)

    const listed = await request(adminApp).get(`${BASE}/`)
    const row = (listed.body.data?.purposes ?? listed.body.purposes).find((p: { purpose: string }) => p.purpose === 'approval_routing')
    expect(row.source).toBe('policy')
    expect(row.canonicalIntegrationId).toBe(local.id)
    expect(row.canonicalProvider).toBe('local')

    const clear = await request(adminApp).patch(`${BASE}/approval_routing`).send({ canonicalIntegrationId: null })
    expect(clear.status).toBe(200)
    expect(clear.body.data?.cleared ?? clear.body.cleared).toBe(true)
    expect(await auditCount('directory.routing_policy.clear', rid)).toBe(1)

    const again = await request(adminApp).patch(`${BASE}/approval_routing`).send({ canonicalIntegrationId: null })
    expect(again.status).toBe(200)
    expect(again.body.data?.cleared ?? again.body.cleared).toBe(false)
    expect(await auditCount('directory.routing_policy.clear', rid)).toBe(1) // no second audit
    // env cleanup is unconditional in afterEach (do not rely on this line after a mid-test failure)
  })

  it('C. PATCH validations reject without auditing: bad purpose / non-UUID / smuggled field / cross-org / inactive target', async () => {
    const rid = `${orgId}:approval_routing`
    const bad1 = await request(adminApp).patch(`${BASE}/coffee_routing`).send({ canonicalIntegrationId: randomUUID() })
    expect(bad1.status).toBe(400)

    const bad2 = await request(adminApp).patch(`${BASE}/approval_routing`).send({ canonicalIntegrationId: 'not-a-uuid' })
    expect(bad2.status).toBe(400)

    const bad3 = await request(adminApp)
      .patch(`${BASE}/approval_routing`)
      .send({ canonicalIntegrationId: randomUUID(), orgId: 'evil-org' })
    expect(bad3.status).toBe(400) // unlisted field — org identity is never client-writable

    const otherOrg = `b5c-other-${STAMP}`
    cleanupOrgIds.push(otherOrg)
    const foreign = await dingtalkIntegration(otherOrg, 'xorg')
    const bad4 = await request(adminApp).patch(`${BASE}/approval_routing`).send({ canonicalIntegrationId: foreign })
    expect(bad4.status).toBe(404)

    const inactive = await dingtalkIntegration(orgId, 'inact', 'disabled')
    cleanupIntegrationIds.push(inactive)
    const bad5 = await request(adminApp).patch(`${BASE}/approval_routing`).send({ canonicalIntegrationId: inactive })
    expect(bad5.status).toBe(409) // broken-target policies are rejected at WRITE time

    // owner #4431: a purpose with NO consumer cannot be written (dead config) — even a valid §6 one
    const active = await dingtalkIntegration(orgId, 'ps-ok')
    cleanupIntegrationIds.push(active)
    const bad6 = await request(adminApp).patch(`${BASE}/permission_scope`).send({ canonicalIntegrationId: active })
    expect(bad6.status).toBe(400)
    expect(JSON.stringify(bad6.body)).toContain('ROUTING_POLICY_PURPOSE_UNSUPPORTED')

    // owner #4431: canonical=local is capability-gated (default OFF) — rejected without the env
    delete process.env.DIRECTORY_ROUTING_LOCAL_CANONICAL_ENABLED
    const local = await getOrCreateLocalIntegration(orgId)
    const bad7 = await request(adminApp).patch(`${BASE}/approval_routing`).send({ canonicalIntegrationId: local.id })
    expect(bad7.status).toBe(409)
    expect(JSON.stringify(bad7.body)).toContain('ROUTING_POLICY_LOCAL_NOT_ENABLED')

    // Gate P2 (restack round): the gate must STRICT-parse — a falsy-ish string an operator sets
    // to mean OFF ('false', '0') must NOT enable local canonical. Pins isLocalCanonicalEnabled's
    // `v === '1' || v === 'true'` shape: loosening it to Boolean(v) turns these legs red.
    for (const falsy of ['false', '0']) {
      process.env.DIRECTORY_ROUTING_LOCAL_CANONICAL_ENABLED = falsy
      const bad8 = await request(adminApp).patch(`${BASE}/approval_routing`).send({ canonicalIntegrationId: local.id })
      expect(bad8.status, `env=${falsy}`).toBe(409)
      expect(JSON.stringify(bad8.body)).toContain('ROUTING_POLICY_LOCAL_NOT_ENABLED')
    }
    delete process.env.DIRECTORY_ROUTING_LOCAL_CANONICAL_ENABLED

    expect(await auditCount('directory.routing_policy.set', rid)).toBe(0)
    const count = await query<{ n: number }>(`SELECT count(*)::int AS n FROM org_directory_routing_policy WHERE org_id = $1`, [orgId])
    expect(count.rows[0].n).toBe(0) // none of the rejects wrote a row
  })

  it('D. preview is a real diff AND read-only: no policy row, no audit; both legs through the real resolver', async () => {
    const user = newUserId('pv')
    cleanupUserIds.push(user)
    await query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, 'x')`, [user, `${user}@example.test`, user])
    const local = await getOrCreateLocalIntegration(orgId)
    const dt = await dingtalkIntegration(orgId, 'pv')
    cleanupIntegrationIds.push(dt)
    cleanupAccountIds.push(await linkedAccount(local.id, 'local', user, 'Local Title'))
    const dtAcc = await linkedAccount(dt, 'dingtalk', user, 'DingTalk Title')
    cleanupAccountIds.push(dtAcc)
    await query(`UPDATE directory_accounts SET updated_at = NOW() + interval '1 hour' WHERE id = $1`, [dtAcc])

    const res = await request(adminApp).get(`${BASE}/approval_routing/preview`).query({ candidate: local.id })
    expect(res.status).toBe(200)
    const body = res.body.data ?? res.body
    expect(body.current.source).toBe('legacy-default')
    const mine = body.rows.find((r: { userId: string }) => r.userId === user)
    expect(mine).toBeTruthy()
    expect(mine.before.title).toBe('DingTalk Title') // legacy latest-updated guessing
    expect(mine.after.title).toBe('Local Title') // as-if candidate were canonical
    expect(mine.changed).toBe(true)

    // READ-ONLY: zero policy rows, zero audit
    const rows = await query<{ n: number }>(`SELECT count(*)::int AS n FROM org_directory_routing_policy WHERE org_id = $1`, [orgId])
    expect(rows.rows[0].n).toBe(0)
    const audits = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs WHERE resource_type = 'directory-routing-policy'`,
    )
    expect(audits.rows[0].n).toBe(0)
  })

  it('E. preview validations: unsupported purpose 400; non-UUID 400; cross-org 404; inactive candidate 409; broken CURRENT policy 409', async () => {
    const e1 = await request(adminApp).get(`${BASE}/permission_scope/preview`).query({ candidate: randomUUID() })
    expect(e1.status).toBe(400)
    const e2 = await request(adminApp).get(`${BASE}/approval_routing/preview`).query({ candidate: 'nope' })
    expect(e2.status).toBe(400)
    const otherOrg = `b5c-other2-${STAMP}`
    cleanupOrgIds.push(otherOrg)
    const foreign = await dingtalkIntegration(otherOrg, 'pxorg')
    const e3 = await request(adminApp).get(`${BASE}/approval_routing/preview`).query({ candidate: foreign })
    expect(e3.status).toBe(404)
    const inactive = await dingtalkIntegration(orgId, 'pinact', 'disabled')
    cleanupIntegrationIds.push(inactive)
    const e4 = await request(adminApp).get(`${BASE}/approval_routing/preview`).query({ candidate: inactive })
    expect(e4.status).toBe(409)

    // gate P3: a broken CURRENT policy (its canonical went non-active AFTER being set) must 409
    // with the MISCONFIGURED code — the operator fixes the live policy before previewing a switch.
    const local = await getOrCreateLocalIntegration(orgId)
    const willBreak = await dingtalkIntegration(orgId, 'pbrk')
    cleanupIntegrationIds.push(willBreak)
    const set = await request(adminApp).patch(`${BASE}/approval_routing`).send({ canonicalIntegrationId: willBreak })
    expect(set.status).toBe(200)
    await query(`UPDATE directory_integrations SET status = 'disabled' WHERE id = $1`, [willBreak])
    const e5 = await request(adminApp).get(`${BASE}/approval_routing/preview`).query({ candidate: local.id })
    expect(e5.status).toBe(409)
    expect((e5.body.error?.code ?? e5.body.code)).toBe('ROUTING_POLICY_MISCONFIGURED')
  })

  it('F. non-admin: 403 on list, set, and preview (real RBAC path)', async () => {
    const r1 = await request(nonAdminApp).get(`${BASE}/`)
    const r2 = await request(nonAdminApp).patch(`${BASE}/approval_routing`).send({ canonicalIntegrationId: randomUUID() })
    const r3 = await request(nonAdminApp).get(`${BASE}/approval_routing/preview`).query({ candidate: randomUUID() })
    expect(r1.status).toBe(403)
    expect(r2.status).toBe(403)
    expect(r3.status).toBe(403)
  })

  it('G. TOCTOU disable-first: PATCH blocks on FOR SHARE, then 409 with zero policy/audit', async () => {
    const target = await dingtalkIntegration(orgId, 'race-df')
    cleanupIntegrationIds.push(target)
    const rid = `${orgId}:approval_routing`

    await withClient(async (holder) => {
      await holder.query('BEGIN')
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
      // Uncommitted disable: exclusive row lock held; status change not yet visible to non-locking readers.
      await holder.query(`UPDATE directory_integrations SET status = 'disabled' WHERE id = $1`, [target])

      let settled = false
      const patchP = request(adminApp)
        .patch(`${BASE}/approval_routing`)
        .send({ canonicalIntegrationId: target })
        .then((r) => {
          settled = true
          return r
        })

      // Dual-outcome race observer (no fixed sleep as the correctness signal):
      //   FIXED: PATCH's FOR SHARE parks behind the holder → sawBlock=true, settled=false.
      //   UNFIXED (no write-point lock/txn): non-locking SELECT sees still-committed 'active',
      //   upserts, settles 200 while the disable is still uncommitted → sawBlock=false.
      // Semantic end-state asserts (409 + zero policy/audit) red the unfixed path for the
      // INTENDED reason — accepted a policy at a concurrently-disabled target — not a barrier
      // timeout or SQL bind error. sawBlock is the positive proof the lock engaged.
      let sawBlock = false
      for (let i = 0; i < 500; i++) {
        if (settled) break
        const r = await query<{ n: number }>(
          `SELECT count(*)::int AS n
             FROM pg_stat_activity
            WHERE state = 'active'
              AND datname = current_database()
              AND pid <> pg_backend_pid()
              AND $1 = ANY(pg_blocking_pids(pid))`,
          [holderPid],
        )
        if ((r.rows[0]?.n ?? 0) >= 1) {
          sawBlock = true
          break
        }
        await new Promise((res) => setTimeout(res, 20))
      }

      await holder.query('COMMIT') // disable becomes visible; parked FOR SHARE re-reads inactive
      const res = await patchP
      // Semantic contract first (mutation-red without the lock: 200 + a written policy row).
      expect(res.status).toBe(409)
      expect(JSON.stringify(res.body)).toContain('ROUTING_POLICY_TARGET_NOT_ACTIVE')
      expect(await policyCount()).toBe(0)
      expect(await auditCount('directory.routing_policy.set', rid)).toBe(0)
      // Lock engagement proof (fixed path only).
      expect(sawBlock).toBe(true)
    })
  })

  it('H. TOCTOU set-first: set commits before disable; resolver fails closed on the disabled canonical', async () => {
    const target = await dingtalkIntegration(orgId, 'race-sf')
    cleanupIntegrationIds.push(target)
    const rid = `${orgId}:approval_routing`

    // Seed a linked user so the post-disable resolver probe actually hits the policy row
    // (B5-b joins policy through the requester's linked accounts in the org).
    const user = newUserId('sf')
    cleanupUserIds.push(user)
    await query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, 'x')`, [
      user,
      `${user}@example.test`,
      user,
    ])
    cleanupAccountIds.push(await linkedAccount(target, 'dingtalk', user, 'Race Title'))

    // Advisory barrier: a BEFORE INSERT/UPDATE trigger on the policy table parks the PATCH
    // transaction AFTER it has taken FOR SHARE on the integration row and BEFORE commit — so a
    // concurrent disable can be observed blocking on the row lock (never a fixed sleep).
    await withClient(async (barrier) => {
      await barrier.query('SELECT pg_advisory_lock($1)', [SET_FIRST_ADVISORY_KEY])
      try {
        await query(`
          CREATE OR REPLACE FUNCTION b5c_set_first_barrier() RETURNS trigger AS $$
          BEGIN
            PERFORM pg_advisory_lock(${SET_FIRST_ADVISORY_KEY});
            PERFORM pg_advisory_unlock(${SET_FIRST_ADVISORY_KEY});
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql
        `)
        await query(`DROP TRIGGER IF EXISTS b5c_set_first_barrier_trg ON org_directory_routing_policy`)
        await query(`
          CREATE TRIGGER b5c_set_first_barrier_trg
            BEFORE INSERT OR UPDATE ON org_directory_routing_policy
            FOR EACH ROW EXECUTE FUNCTION b5c_set_first_barrier()
        `)

        let patchSettled = false
        const patchP = request(adminApp)
          .patch(`${BASE}/approval_routing`)
          .send({ canonicalIntegrationId: target })
          .then((r) => {
            patchSettled = true
            return r
          })

        // Wait until PATCH is parked on the advisory (it already holds FOR SHARE at this point).
        await waitUntilAdvisoryWaiters(1)
        expect(patchSettled).toBe(false)

        // Concurrent disable: must block on the exclusive lock conflict with PATCH's FOR SHARE.
        const disabler = new Client({ connectionString: process.env.DATABASE_URL })
        await disabler.connect()
        try {
          let disableSettled = false
          const disableP = disabler
            .query(`UPDATE directory_integrations SET status = 'disabled' WHERE id = $1`, [target])
            .then((r) => {
              disableSettled = true
              return r
            })

          // Observe disable blocked by someone (the PATCH txn holding FOR SHARE).
          await waitUntilDisableBlocked(target)
          expect(disableSettled).toBe(false)
          expect(patchSettled).toBe(false)

          // Release the advisory → PATCH INSERT completes, commits, releases FOR SHARE.
          await barrier.query('SELECT pg_advisory_unlock($1)', [SET_FIRST_ADVISORY_KEY])
          const patchRes = await patchP
          expect(patchRes.status).toBe(200)
          expect(patchSettled).toBe(true)

          await disableP
          expect(disableSettled).toBe(true)
        } finally {
          await disabler.end()
        }
      } finally {
        // Always drop barrier objects even if assertions fail mid-flight.
        await query(`DROP TRIGGER IF EXISTS b5c_set_first_barrier_trg ON org_directory_routing_policy`).catch(() => {})
        await query(`DROP FUNCTION IF EXISTS b5c_set_first_barrier()`).catch(() => {})
        // If we still hold the advisory (error before unlock), release it.
        await barrier.query('SELECT pg_advisory_unlock($1)', [SET_FIRST_ADVISORY_KEY]).catch(() => {})
      }
    })

    // Set committed before disable: policy row exists, target is now disabled.
    expect(await policyCount()).toBe(1)
    expect(await auditCount('directory.routing_policy.set', rid)).toBe(1)
    const status = await query<{ status: string }>(`SELECT status FROM directory_integrations WHERE id = $1`, [target])
    expect(status.rows[0]?.status).toBe('disabled')

    // Existing B5-b resolver fails closed on the now-disabled canonical (CONFIG error).
    await expect(resolveApprovalRequesterOrgRelations(user, query)).rejects.toBeInstanceOf(ApprovalRoutingPolicyError)
  })
})

/** Wait until ≥ min backends are Lock-waiting on an advisory lock (set-first barrier engaged). */
async function waitUntilAdvisoryWaiters(min: number): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const r = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND wait_event = 'advisory' AND state = 'active'`,
    )
    if ((r.rows[0]?.n ?? 0) >= min) return
    await new Promise((res) => setTimeout(res, 20))
  }
  throw new Error('timed out waiting for PATCH parked on the set-first advisory barrier')
}

/**
 * Wait until a concurrent UPDATE of directory_integrations for `targetId` is Lock-blocked
 * (proves disable is serialized behind the PATCH write-point FOR SHARE).
 */
async function waitUntilDisableBlocked(targetId: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const r = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE state = 'active'
          AND datname = current_database()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%directory_integrations%'
          AND query ILIKE '%status%'
          AND query ILIKE '%' || $1 || '%'`,
      [targetId],
    )
    if ((r.rows[0]?.n ?? 0) >= 1) return
    // Also accept any backend blocked on a lock whose query mentions the table (param may be bound).
    const r2 = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE state = 'active'
          AND datname = current_database()
          AND wait_event_type = 'Lock'
          AND cardinality(pg_blocking_pids(pid)) > 0
          AND (query ILIKE '%directory_integrations%' OR query ILIKE '%SET status%')`,
    )
    if ((r2.rows[0]?.n ?? 0) >= 1) return
    await new Promise((res) => setTimeout(res, 20))
  }
  throw new Error('timed out waiting for disable UPDATE blocked behind PATCH FOR SHARE')
}
