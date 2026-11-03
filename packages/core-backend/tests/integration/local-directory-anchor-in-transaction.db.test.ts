import { Client } from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import {
  LocalDirectoryConflictError,
  LocalDirectoryNotFoundError,
  addLocalMembership,
  archiveLocalAccount,
  archiveLocalDepartment,
  createLocalAccount,
  createLocalDepartment,
  switchLocalPrimaryDepartment,
  updateLocalAccount,
  updateLocalDepartment,
} from '../../src/directory/local-directory-org'

/**
 * W1-6 (owner ruling 2026-10-10, "锚点进事务"), real DB, SERVICE layer.
 *
 * Every local-directory writer now gets-or-creates the org's `provider='local'` anchor INSIDE the
 * same transaction that writes its department / account / link / membership rows. Proved here:
 *
 *   (1) per writer (all eight), a failure inside the transaction on a FRESH org leaves ZERO anchors
 *       and ZERO bootstrap audits — before this change each of these left one bare, committed anchor
 *       (the anchor was auto-committed before the writer's transaction began). The failures are the
 *       writers' own product failures (404 / 409 / null → 404), plus two injected faults:
 *         - a fault on `directory_departments` INSERT (inside createLocalDepartment's transaction);
 *         - a fault on `directory_account_links` INSERT — AFTER the account row is written and
 *           BEFORE the org membership — so the anchor, the account and the membership must all
 *           roll back together.
 *       Each injected fault is a trigger that raises ONLY for this file's stamped rows (integration
 *       specs share one Postgres in CI), dropped in `finally`.
 *   (2) positive controls: each success path still yields exactly one active anchor and exactly one
 *       bootstrap audit (now written after COMMIT).
 *   (3) concurrency: a deterministic barrier — a raw holder transaction inserts the anchor and keeps
 *       it uncommitted; a service writer parks on the anchor's unique index (asserted through
 *       `pg_blocking_pids`, not a sleep). If the holder COMMITS, the writer adopts the holder's
 *       anchor (one anchor, the writer audits nothing); if the holder ROLLS BACK, the writer creates
 *       its own (one anchor, one audit). Plus an un-barriered mixed burst (writers that fail and
 *       writers that succeed, all first callers) that must end with exactly one anchor and one audit.
 *
 * Mutation check (recorded in the private implementation note, not asserted here): with the
 * writers reverted to the auto-committed `getOrCreateLocalIntegration(orgId)` call, every (1) case
 * turns red with `anchors = 1`.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const STAMP = Date.now()
const ORG_PREFIX = `w16tx-${STAMP}-`
const orgId = (suffix: string): string => `${ORG_PREFIX}${suffix}`
const newUserId = (suffix: string): string => `w16tx-user-${STAMP}-${suffix}`
const MISSING_ID = '00000000-0000-0000-0000-000000000000'
const BOOTSTRAP_ACTION = 'directory.local_integration.bootstrap'

async function seedUser(id: string, isActive = true): Promise<void> {
  await query(
    `INSERT INTO users (id, email, name, password_hash, is_active) VALUES ($1, $2, $3, 'x', $4)`,
    [id, `${id}@example.test`, `User ${id}`, isActive],
  )
}

interface OrgFootprint {
  anchors: number
  integrations: number
  departments: number
  accounts: number
  links: number
  memberships: number
  bootstrapAudits: number
}

async function footprint(org: string, userId?: string): Promise<OrgFootprint> {
  const r = await query<{
    anchors: number
    integrations: number
    departments: number
    accounts: number
    links: number
    memberships: number
    audits: number
  }>(
    `SELECT
       (SELECT count(*)::int FROM directory_integrations
         WHERE org_id = $1 AND provider = 'local' AND status = 'active') AS anchors,
       (SELECT count(*)::int FROM directory_integrations WHERE org_id = $1) AS integrations,
       (SELECT count(*)::int FROM directory_departments d
          JOIN directory_integrations i ON i.id = d.integration_id WHERE i.org_id = $1) AS departments,
       (SELECT count(*)::int FROM directory_accounts a
          JOIN directory_integrations i ON i.id = a.integration_id WHERE i.org_id = $1) AS accounts,
       (SELECT count(*)::int FROM directory_account_links l WHERE l.local_user_id = $2) AS links,
       (SELECT count(*)::int FROM user_orgs WHERE org_id = $1) AS memberships,
       (SELECT count(*)::int FROM audit_logs
         WHERE action = $3 AND resource_type = 'directory-integration'
           AND action_details ->> 'orgId' = $1) AS audits`,
    [org, userId ?? '', BOOTSTRAP_ACTION],
  )
  const row = r.rows[0]
  return {
    anchors: row.anchors,
    integrations: row.integrations,
    departments: row.departments,
    accounts: row.accounts,
    links: row.links,
    memberships: row.memberships,
    bootstrapAudits: row.audits,
  }
}

const EMPTY: OrgFootprint = {
  anchors: 0,
  integrations: 0,
  departments: 0,
  accounts: 0,
  links: 0,
  memberships: 0,
  bootstrapAudits: 0,
}

async function settle<T>(p: Promise<T>): Promise<T | unknown> {
  return p.then((v) => v, (e: unknown) => e)
}

/**
 * Install a fault trigger on `table` that raises only for rows whose `column` starts with `prefix`
 * (this file's stamp), run `fn`, and always drop it again.
 */
async function withStampedFault<T>(
  table: 'directory_departments' | 'directory_account_links',
  column: 'name' | 'local_user_id',
  prefix: string,
  fn: () => Promise<T>,
): Promise<T> {
  const name = `w16tx_fault_${STAMP}_${table}`
  await query(
    `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $fn$
     BEGIN
       IF NEW.${column} LIKE '${prefix}%' THEN
         RAISE EXCEPTION 'w16tx injected fault';
       END IF;
       RETURN NEW;
     END
     $fn$`,
  )
  try {
    await query(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`)
    try {
      return await fn()
    } finally {
      await query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`)
    }
  } finally {
    await query(`DROP FUNCTION IF EXISTS ${name}()`)
  }
}

/** Poll until a service statement is parked on a lock held by `holderPid` (no sleeps as proof). */
async function waitUntilBlockedBy(holderPid: number): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const r = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND $1 = ANY(pg_blocking_pids(pid))`,
      [holderPid],
    )
    if ((r.rows[0]?.n ?? 0) >= 1) return
    await new Promise((res) => setTimeout(res, 20))
  }
  throw new Error('timed out waiting for the service writer to park behind the holder (barrier never engaged)')
}

describeIfDatabase('W1-6 — the local org anchor is created inside each writer\'s transaction (real DB)', () => {
  const seededOrgIds: string[] = []
  const seededUserIds: string[] = []

  afterEach(async () => {
    for (const org of seededOrgIds.splice(0)) {
      await query(
        `DELETE FROM audit_logs WHERE resource_type = 'directory-integration' AND action_details ->> 'orgId' = $1`,
        [org],
      )
      await query(`DELETE FROM user_orgs WHERE org_id = $1`, [org])
      await query(`DELETE FROM directory_integrations WHERE org_id = $1`, [org])
    }
    for (const uid of seededUserIds.splice(0)) {
      await query(`DELETE FROM users WHERE id = $1`, [uid])
    }
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  describe('(1) a failure inside the transaction leaves no anchor — every writer', () => {
    it('createLocalDepartment: missing parent (404) → no anchor', async () => {
      const org = orgId('dept-missing-parent')
      seededOrgIds.push(org)
      const outcome = await settle(createLocalDepartment({ orgId: org, name: 'Orphan', parentDepartmentId: MISSING_ID }))
      expect(outcome).toBeInstanceOf(LocalDirectoryNotFoundError)
      expect(await footprint(org)).toEqual(EMPTY)
    })

    it('createLocalDepartment: injected fault on the department INSERT → no anchor, no department', async () => {
      const org = orgId('dept-fault')
      seededOrgIds.push(org)
      const faultName = `${ORG_PREFIX}fault-dept`
      const outcome = await withStampedFault('directory_departments', 'name', ORG_PREFIX, () =>
        settle(createLocalDepartment({ orgId: org, name: faultName })),
      )
      expect(outcome).toBeInstanceOf(Error)
      expect(String((outcome as Error).message)).toContain('w16tx injected fault')
      expect(await footprint(org)).toEqual(EMPTY)
    })

    it('updateLocalDepartment: missing department (null → 404) → no anchor', async () => {
      const org = orgId('dept-update-missing')
      seededOrgIds.push(org)
      expect(await updateLocalDepartment(org, MISSING_ID, { name: 'Nope' })).toBeNull()
      expect(await footprint(org)).toEqual(EMPTY)
    })

    it('updateLocalDepartment (reparent branch): missing department → no anchor', async () => {
      const org = orgId('dept-reparent-missing')
      seededOrgIds.push(org)
      expect(await updateLocalDepartment(org, MISSING_ID, { parentDepartmentId: '11111111-1111-1111-1111-111111111111' })).toBeNull()
      expect(await footprint(org)).toEqual(EMPTY)
    })

    it('archiveLocalDepartment: missing department (null → 404) → no anchor', async () => {
      const org = orgId('dept-archive-missing')
      seededOrgIds.push(org)
      expect(await archiveLocalDepartment(org, MISSING_ID)).toBeNull()
      expect(await footprint(org)).toEqual(EMPTY)
    })

    it('createLocalAccount: user does not exist (404) → no anchor', async () => {
      const org = orgId('acct-missing-user')
      seededOrgIds.push(org)
      const uid = newUserId('never-seeded')
      const outcome = await settle(createLocalAccount({ orgId: org, localUserId: uid }))
      expect(outcome).toBeInstanceOf(LocalDirectoryNotFoundError)
      expect(await footprint(org, uid)).toEqual(EMPTY)
    })

    it('createLocalAccount: inactive user (409) → no anchor', async () => {
      const org = orgId('acct-inactive-user')
      seededOrgIds.push(org)
      const uid = newUserId('inactive')
      seededUserIds.push(uid)
      await seedUser(uid, false)
      const outcome = await settle(createLocalAccount({ orgId: org, localUserId: uid }))
      expect(outcome).toBeInstanceOf(LocalDirectoryConflictError)
      expect(await footprint(org, uid)).toEqual(EMPTY)
    })

    it('createLocalAccount: injected fault on the link INSERT (after the account row) → no anchor, account, link or membership', async () => {
      const org = orgId('acct-link-fault')
      seededOrgIds.push(org)
      const uid = newUserId('link-fault')
      seededUserIds.push(uid)
      await seedUser(uid)
      const outcome = await withStampedFault('directory_account_links', 'local_user_id', `w16tx-user-${STAMP}-`, () =>
        settle(createLocalAccount({ orgId: org, localUserId: uid })),
      )
      expect(outcome).toBeInstanceOf(Error)
      expect(String((outcome as Error).message)).toContain('w16tx injected fault')
      expect(await footprint(org, uid)).toEqual(EMPTY)
    })

    it('updateLocalAccount: missing account (null → 404) → no anchor', async () => {
      const org = orgId('acct-update-missing')
      seededOrgIds.push(org)
      expect(await updateLocalAccount(org, MISSING_ID, { name: 'Nope' })).toBeNull()
      expect(await footprint(org)).toEqual(EMPTY)
    })

    it('archiveLocalAccount: missing account (null → 404) → no anchor', async () => {
      const org = orgId('acct-archive-missing')
      seededOrgIds.push(org)
      expect(await archiveLocalAccount(org, MISSING_ID)).toBeNull()
      expect(await footprint(org)).toEqual(EMPTY)
    })

    it('addLocalMembership: missing account (404) → no anchor', async () => {
      const org = orgId('mship-missing')
      seededOrgIds.push(org)
      const outcome = await settle(addLocalMembership({ orgId: org, accountId: MISSING_ID, departmentId: MISSING_ID }))
      expect(outcome).toBeInstanceOf(LocalDirectoryNotFoundError)
      expect(await footprint(org)).toEqual(EMPTY)
    })

    it('switchLocalPrimaryDepartment: missing account (404) → no anchor', async () => {
      const org = orgId('primary-missing')
      seededOrgIds.push(org)
      const outcome = await settle(switchLocalPrimaryDepartment(org, MISSING_ID, MISSING_ID))
      expect(outcome).toBeInstanceOf(LocalDirectoryNotFoundError)
      expect(await footprint(org)).toEqual(EMPTY)
    })
  })

  describe('(2) positive controls — success still creates exactly one anchor and one audit', () => {
    it('createLocalAccount writes anchor + account + link + membership together, audited once after commit', async () => {
      const org = orgId('acct-ok')
      seededOrgIds.push(org)
      const uid = newUserId('ok')
      seededUserIds.push(uid)
      await seedUser(uid)
      const created = await createLocalAccount({ orgId: org, localUserId: uid })
      expect(created.localUserId).toBe(uid)
      expect(created.isActive).toBe(true)
      expect(await footprint(org, uid)).toEqual({
        anchors: 1,
        integrations: 1,
        departments: 0,
        accounts: 1,
        links: 1,
        memberships: 1,
        bootstrapAudits: 1,
      })
    })

    it('a failed call on an org that already has an anchor keeps that anchor (nothing else is touched)', async () => {
      const org = orgId('existing-anchor')
      seededOrgIds.push(org)
      const dept = await createLocalDepartment({ orgId: org, name: 'Ops' })
      expect(await updateLocalAccount(org, MISSING_ID, { name: 'Nope' })).toBeNull()
      const after = await footprint(org)
      expect(after.anchors).toBe(1)
      expect(after.departments).toBe(1)
      expect(after.bootstrapAudits).toBe(1)
      const integration = await query<{ id: string }>(
        `SELECT integration_id AS id FROM directory_departments WHERE id = $1`,
        [dept.id],
      )
      expect(integration.rows[0].id).toBe(dept.integrationId)
    })

    it('each writer\'s success path on a fresh org creates one anchor and one audit', async () => {
      const org = orgId('all-writers-ok')
      seededOrgIds.push(org)
      const uid = newUserId('all-writers')
      seededUserIds.push(uid)
      await seedUser(uid)

      const a = await createLocalDepartment({ orgId: org, name: 'A' })
      const b = await createLocalDepartment({ orgId: org, name: 'B' })
      expect((await updateLocalDepartment(org, b.id, { parentDepartmentId: a.id }))?.parentDepartmentId).toBe(a.id)
      const account = await createLocalAccount({ orgId: org, localUserId: uid })
      expect((await updateLocalAccount(org, account.id, { title: 'Lead' }))?.title).toBe('Lead')
      await addLocalMembership({ orgId: org, accountId: account.id, departmentId: a.id })
      expect((await switchLocalPrimaryDepartment(org, account.id, a.id)).isPrimary).toBe(true)
      expect((await archiveLocalAccount(org, account.id))?.isActive).toBe(false)
      expect((await archiveLocalDepartment(org, b.id))?.isActive).toBe(false)

      const after = await footprint(org, uid)
      expect(after.anchors).toBe(1)
      expect(after.integrations).toBe(1)
      expect(after.bootstrapAudits).toBe(1)
    })
  })

  describe('(3) concurrency — exactly one anchor', () => {
    async function holderInsertsAnchor(org: string): Promise<{ holder: Client; pid: number }> {
      const holder = new Client({ connectionString: process.env.DATABASE_URL })
      await holder.connect()
      await holder.query('BEGIN')
      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await holder.query(
        `INSERT INTO directory_integrations (
           org_id, provider, name, status, corp_id, config, sync_enabled, default_deprovision_policy, created_at, updated_at
         )
         VALUES ($1, 'local', 'Local organization', 'active', $2, '{"mode":"editable","source":"local"}'::jsonb, false, 'mark_inactive', NOW(), NOW())`,
        [org, `local:${org}`],
      )
      return { holder, pid }
    }

    it('holder commits first: the parked writer adopts the holder\'s anchor (one anchor, the writer audits nothing)', async () => {
      const org = orgId('race-commit')
      seededOrgIds.push(org)
      const { holder, pid } = await holderInsertsAnchor(org)
      try {
        const call = settle(createLocalDepartment({ orgId: org, name: 'Racer' }))
        await waitUntilBlockedBy(pid)
        await holder.query('COMMIT')
        const outcome = await call
        expect(outcome).not.toBeInstanceOf(Error)
      } finally {
        await holder.end()
      }
      const after = await footprint(org)
      expect(after.anchors).toBe(1)
      expect(after.integrations).toBe(1)
      expect(after.departments).toBe(1)
      expect(after.bootstrapAudits).toBe(0) // the holder's raw INSERT is not a service bootstrap
    })

    it('holder rolls back: the parked writer creates the one anchor itself (one anchor, one audit)', async () => {
      const org = orgId('race-rollback')
      seededOrgIds.push(org)
      const { holder, pid } = await holderInsertsAnchor(org)
      try {
        const call = settle(createLocalDepartment({ orgId: org, name: 'Racer' }))
        await waitUntilBlockedBy(pid)
        await holder.query('ROLLBACK')
        const outcome = await call
        expect(outcome).not.toBeInstanceOf(Error)
      } finally {
        await holder.end()
      }
      const after = await footprint(org)
      expect(after.anchors).toBe(1)
      expect(after.integrations).toBe(1)
      expect(after.departments).toBe(1)
      expect(after.bootstrapAudits).toBe(1)
    })

    it('two simultaneous first calls both succeed and share exactly one anchor and one audit', async () => {
      const org = orgId('race-two-ok')
      seededOrgIds.push(org)
      const [x, y] = await Promise.all([
        createLocalDepartment({ orgId: org, name: 'X' }),
        createLocalDepartment({ orgId: org, name: 'Y' }),
      ])
      expect(x.integrationId).toBe(y.integrationId)
      const after = await footprint(org)
      expect(after.anchors).toBe(1)
      expect(after.departments).toBe(2)
      expect(after.bootstrapAudits).toBe(1)
    })

    it('a mixed burst of first calls (some fail, some succeed) ends with exactly one anchor and one audit', async () => {
      const org = orgId('race-mixed')
      seededOrgIds.push(org)
      const outcomes = await Promise.all([
        settle(createLocalAccount({ orgId: org, localUserId: newUserId('mixed-missing-1') })),
        settle(createLocalDepartment({ orgId: org, name: 'M1' })),
        settle(updateLocalAccount(org, MISSING_ID, { name: 'Nope' })),
        settle(createLocalDepartment({ orgId: org, name: 'M2' })),
        settle(createLocalDepartment({ orgId: org, name: 'Orphan', parentDepartmentId: MISSING_ID })),
      ])
      expect(outcomes[0]).toBeInstanceOf(LocalDirectoryNotFoundError)
      expect(outcomes[2]).toBeNull()
      expect(outcomes[4]).toBeInstanceOf(LocalDirectoryNotFoundError)
      const after = await footprint(org)
      expect(after.anchors).toBe(1)
      expect(after.departments).toBe(2)
      expect(after.bootstrapAudits).toBe(1)
    })
  })
})
