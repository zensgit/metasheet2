import { Client } from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import { getOrCreateLocalIntegration } from '../../src/directory/directory-sync'
import { createLocalAccount, createLocalDepartment } from '../../src/directory/local-directory-org'

/**
 * PB4-4 — local integration REACTIVATION (revive the same stable anchor), real DB.
 *
 * After a `provider='local'` integration is deactivated, the old B1 get-or-create was bricked: a
 * fresh `getOrCreateLocalIntegration` INSERTs the fixed name 'Local organization', collides on
 * `idx_directory_integrations_org_provider_name`, and the B1 catch (which only re-selects ACTIVE
 * rows) cannot recover — so it throws on EVERY call. PB4-4 makes get-or-create instead REACTIVATE
 * the canonical anchor IN PLACE (same id), so its departments, accounts, and future B4 binding refs
 * (all FK'd to integration_id) survive, and emits exactly ONE reactivation audit.
 *
 * Proven against real Postgres:
 *   (a) basic — deactivate → getOrCreate returns the SAME id, status active again, and the seeded
 *       department + account still hang off that id; exactly ONE `…reactivate` audit.
 *   (b) idempotent — when already active, getOrCreate does NOT emit a reactivate audit (fast path).
 *   (c) 2-way and (d) 5-way concurrency — behind a DETERMINISTIC barrier (a raw holder locks the
 *       inactive anchor `FOR UPDATE`; all N reactivation UPDATEs are confirmed parked behind it via
 *       `pg_blocking_pids()`; the lock is released so they race for real), the N callers converge on
 *       the SAME id with exactly ONE reactivate audit — the `status <> 'active'` conditional UPDATE is
 *       a race-safe latch: only the caller whose UPDATE actually flips the row audits; the rest match
 *       zero rows and re-select the winner. (A bare `Promise.all` is NOT a reliable mutation detector
 *       here — the first caller can commit before the others reach the UPDATE, letting them take the
 *       fast-path; the barrier removes that escape so the mutation below reds STABLY.)
 *   (e) first-bootstrap regression — a brand-new org still bootstraps (one bootstrap audit, ZERO
 *       reactivate audits).
 *   (f) name-filter safety — an EXTRA differently-named inactive local row (raw) is left untouched;
 *       reactivation flips only the canonical `name='Local organization'` anchor, so it never
 *       double-activates into a `one_active_local_integration_per_org` violation.
 *
 * Load-bearing mutations (out-of-band, each reds this file):
 *   - delete the reactivation block            → (a) reds (getOrCreate throws after deactivation).
 *   - delete `AND status <> 'active'`          → (c)/(d) red STABLY (behind the barrier every one of
 *                                                 the N released UPDATEs flips + audits → N audits).
 *   - delete `AND name = $2`                    → (f) reds (both inactive rows flip → one_active
 *                                                 unique_violation → getOrCreate throws).
 *
 * Fixture IDs are namespaced with this file's STAMP — integration specs share one Postgres in CI.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const STAMP = Date.now()
const REACTIVATE_ACTION = 'directory.local_integration.reactivate'
const BOOTSTRAP_ACTION = 'directory.local_integration.bootstrap'

const orgId = (suffix: string): string => `pb44-${STAMP}-${suffix}`
const newUserId = (suffix: string): string => `pb44-user-${STAMP}-${suffix}`

async function seedUser(id: string, name: string): Promise<void> {
  await query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, 'x')`, [id, `${id}@example.test`, name])
}

async function localIntegrationRow(org: string): Promise<{ id: string; status: string } | null> {
  const r = await query<{ id: string; status: string }>(
    `SELECT id, status FROM directory_integrations WHERE org_id = $1 AND provider = 'local' AND name = 'Local organization'`,
    [org],
  )
  return r.rows[0] ?? null
}

async function deactivate(integrationId: string): Promise<void> {
  await query(`UPDATE directory_integrations SET status = 'inactive', updated_at = NOW() WHERE id = $1`, [integrationId])
}

async function auditCount(action: string, resourceId: string): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs
      WHERE action = $1 AND resource_type = 'directory-integration' AND resource_id = $2`,
    [action, resourceId],
  )
  return r.rows[0]?.n ?? 0
}

/**
 * DETERMINISTIC concurrency barrier (owner P2 fix). A bare `Promise.all` of N reactivations is NOT a
 * reliable mutation detector: the first caller can reactivate and COMMIT before the others reach the
 * UPDATE, so they take the active fast-path and never collide — deleting the `status<>'active'` latch
 * then leaves the test green (a false mutation-red). This forces a genuine collision instead: a raw
 * holder locks the inactive anchor row `FOR UPDATE`, we start N service calls (each parks on the
 * reactivation UPDATE behind that lock), confirm via `pg_blocking_pids()` that ALL N are blocked BY
 * the holder, then release — so all N UPDATEs are released into the row simultaneously and race the
 * latch for real. With the latch, exactly one flips (RETURNING a row → one audit); the rest see the
 * now-active row and match zero rows. WITHOUT the latch, every one of the N flips (idempotent) and
 * RETURNs a row → N audits, stably. `holder` only SELECTs FOR UPDATE (never mutates), so on release
 * the row is still inactive and the service calls do the reactivation.
 */
async function reactivateConcurrentlyBehindLock(org: string, integrationId: string, n: number): Promise<unknown[]> {
  const holder = new Client({ connectionString: process.env.DATABASE_URL })
  await holder.connect()
  try {
    await holder.query('BEGIN')
    const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
    await holder.query('SELECT id FROM directory_integrations WHERE id = $1 FOR UPDATE', [integrationId])

    const calls = Array.from({ length: n }, () =>
      getOrCreateLocalIntegration(org).then(
        (v) => v,
        (e) => e,
      ),
    )
    await waitForNBlockedBy(holderPid, n)

    await holder.query('COMMIT') // release the row lock — still inactive; the N UPDATEs now race
    return await Promise.all(calls)
  } finally {
    await holder.end()
  }
}

/** Poll until all N reactivation UPDATEs are genuinely parked behind the holder's row lock (via
 *  `pg_blocking_pids()`, not a sleep). NOTE: concurrent UPDATEs on one row form a LOCK QUEUE — only
 *  the queue HEAD waits directly on the holder (`wait_event='transactionid'`); the rest wait on the
 *  txn ahead of them (`wait_event='tuple'`), so the holder is NOT in their direct `pg_blocking_pids`.
 *  So we require BOTH: (a) N reactivation UPDATEs are Lock-blocked (the whole queue), AND (b) the
 *  queue is ROOTED at the holder (≥1 UPDATE has the holder as a direct blocker). Together these prove
 *  all N are behind the holder — no fast-path escape. */
async function waitForNBlockedBy(holderPid: number, n: number): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const r = await query<{ blocked: number; rooted: number }>(
      `SELECT
         count(*) FILTER (WHERE wait_event_type = 'Lock'
                           AND query ILIKE '%directory_integrations%'
                           AND query ILIKE '%set status%')::int AS blocked,
         count(*) FILTER (WHERE $1 = ANY(pg_blocking_pids(pid)))::int AS rooted
       FROM pg_stat_activity
       WHERE state = 'active' AND datname = current_database() AND pid <> pg_backend_pid()`,
      [holderPid],
    )
    const blocked = r.rows[0]?.blocked ?? 0
    const rooted = r.rows[0]?.rooted ?? 0
    if (blocked >= n && rooted >= 1) return
    await new Promise((res) => setTimeout(res, 20))
  }
  throw new Error(`timed out waiting for ${n} reactivation UPDATEs queued behind the holder (barrier never engaged)`)
}

describeIfDatabase('PB4-4 — local integration reactivation (real DB)', () => {
  const seededOrgIds: string[] = []
  const seededUserIds: string[] = []

  afterEach(async () => {
    for (const org of seededOrgIds.splice(0)) {
      await query(
        `DELETE FROM audit_logs WHERE resource_type = 'directory-integration'
           AND resource_id IN (SELECT id::text FROM directory_integrations WHERE org_id = $1)`,
        [org],
      )
      await query(`DELETE FROM directory_integrations WHERE org_id = $1`, [org])
    }
    for (const uid of seededUserIds.splice(0)) {
      await query(`DELETE FROM users WHERE id = $1`, [uid])
    }
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  async function seedAnchorWithChildren(org: string): Promise<{ integrationId: string; deptId: string; accountId: string }> {
    const uid = newUserId(org)
    seededUserIds.push(uid)
    await seedUser(uid, 'Anchor Member')
    const dept = await createLocalDepartment({ orgId: org, name: 'Anchor Dept' }) // bootstraps the anchor
    const account = await createLocalAccount({ orgId: org, localUserId: uid })
    const row = await localIntegrationRow(org)
    if (!row) throw new Error('anchor not bootstrapped')
    return { integrationId: row.id, deptId: dept.id, accountId: account.id }
  }

  it('(a) deactivate → getOrCreate revives the SAME id (status active), children survive, exactly one reactivate audit', async () => {
    const org = orgId('a')
    seededOrgIds.push(org)
    const { integrationId, deptId, accountId } = await seedAnchorWithChildren(org)

    await deactivate(integrationId)
    expect((await localIntegrationRow(org))?.status).toBe('inactive')

    const revived = await getOrCreateLocalIntegration(org)
    expect(revived.id).toBe(integrationId) // SAME stable anchor, not a new row
    expect(revived.status).toBe('active')

    // exactly one local row for the org (no duplicate anchor was minted)
    const allLocal = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM directory_integrations WHERE org_id = $1 AND provider = 'local'`,
      [org],
    )
    expect(allLocal.rows[0].n).toBe(1)

    // children still hang off the SAME integration id (future B4 binding refs survive)
    const dept = await query<{ integration_id: string }>(`SELECT integration_id FROM directory_departments WHERE id = $1`, [deptId])
    const account = await query<{ integration_id: string }>(`SELECT integration_id FROM directory_accounts WHERE id = $1`, [accountId])
    expect(dept.rows[0].integration_id).toBe(integrationId)
    expect(account.rows[0].integration_id).toBe(integrationId)

    expect(await auditCount(REACTIVATE_ACTION, integrationId)).toBe(1)
  })

  it('(b) idempotent: getOrCreate on an already-active anchor does NOT emit a reactivate audit', async () => {
    const org = orgId('b')
    seededOrgIds.push(org)
    const first = await getOrCreateLocalIntegration(org)
    const second = await getOrCreateLocalIntegration(org)
    expect(second.id).toBe(first.id)
    expect(await auditCount(REACTIVATE_ACTION, first.id)).toBe(0)
  })

  it('(c) 2-way concurrency (deterministic barrier): both reactivation UPDATEs block on the locked anchor, then converge to one id with exactly one audit', async () => {
    const org = orgId('c')
    seededOrgIds.push(org)
    const { integrationId } = await seedAnchorWithChildren(org)
    await deactivate(integrationId)

    const results = await reactivateConcurrentlyBehindLock(org, integrationId, 2)
    for (const r of results) {
      expect(r).not.toBeInstanceOf(Error)
      expect((r as { id: string }).id).toBe(integrationId)
    }
    expect(await auditCount(REACTIVATE_ACTION, integrationId)).toBe(1)
  })

  it('(d) 5-way concurrency (deterministic barrier): all 5 reactivation UPDATEs block on the locked anchor via pg_blocking_pids, then converge to one id with exactly one audit', async () => {
    const org = orgId('d')
    seededOrgIds.push(org)
    const { integrationId } = await seedAnchorWithChildren(org)
    await deactivate(integrationId)

    const results = await reactivateConcurrentlyBehindLock(org, integrationId, 5)
    for (const r of results) {
      expect(r).not.toBeInstanceOf(Error)
      expect((r as { id: string }).id).toBe(integrationId)
    }
    expect(await auditCount(REACTIVATE_ACTION, integrationId)).toBe(1)
  })

  it('(e) first-bootstrap regression: a brand-new org bootstraps (one bootstrap audit, zero reactivate audits)', async () => {
    const org = orgId('e')
    seededOrgIds.push(org)
    const created = await getOrCreateLocalIntegration(org)
    expect(await auditCount(BOOTSTRAP_ACTION, created.id)).toBe(1)
    expect(await auditCount(REACTIVATE_ACTION, created.id)).toBe(0)
  })

  it('(f) name-filter safety: an extra differently-named inactive local row is left untouched — reactivation flips only the canonical anchor, never double-activating', async () => {
    const org = orgId('f')
    seededOrgIds.push(org)
    const { integrationId } = await seedAnchorWithChildren(org)
    await deactivate(integrationId)

    // raw-insert a SECOND inactive local row with a DIFFERENT name (only possible via raw ops)
    const extra = await query<{ id: string }>(
      `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config, sync_enabled)
       VALUES ($1, 'local', 'Local organization (old)', 'inactive', $2, '{"mode":"editable","source":"local"}'::jsonb, false)
       RETURNING id`,
      [org, `local:${org}`],
    )
    const extraId = extra.rows[0].id

    const revived = await getOrCreateLocalIntegration(org)
    expect(revived.id).toBe(integrationId) // the canonical anchor, not the extra row
    expect(revived.status).toBe('active')

    // the extra differently-named row is STILL inactive (not double-activated)
    const extraRow = await query<{ status: string }>(`SELECT status FROM directory_integrations WHERE id = $1`, [extraId])
    expect(extraRow.rows[0].status).toBe('inactive')

    expect(await auditCount(REACTIVATE_ACTION, integrationId)).toBe(1)
    expect(await auditCount(REACTIVATE_ACTION, extraId)).toBe(0)
  })
})
