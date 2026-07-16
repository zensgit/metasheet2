import { afterEach, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import {
  LocalDirectoryConflictError,
  LocalDirectoryNotFoundError,
  LocalDirectoryValidationError,
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
 * Canonical Org MVP — B2 (local departments/accounts/memberships CRUD), MVP sequencing plan §1
 * row B2, design lock §5.2-5.4, real DB, SERVICE layer.
 *
 * Proves, against real Postgres:
 *   - departments: create / rename / archive-keeps-history (row remains, `is_active=false`,
 *     idempotent re-archive); parent resolves to the parent's `id` via its external key; `raw`
 *     never carries a manager (design lock owner fix).
 *   - accounts: create + link (`directory_account_departments` is untouched here — the LINK is
 *     `directory_account_links`) + deactivate keeps history; a local account NEVER produces a
 *     `user_external_identities` row (with a positive control proving the query mechanism itself
 *     works: `directory_account_links` DOES have a row for the same account); duplicate creation
 *     for the same (org, user) is a 409, not a silent second row; `raw` never carries
 *     `leader_in_dept`.
 *   - memberships: `addLocalMembership` is idempotent (same pair twice → one row, PK-backed);
 *     `switchLocalPrimaryDepartment` demotes the old primary — exactly one `is_primary=true` row
 *     per account at any point; a membership cannot straddle two orgs' local integrations.
 *
 * The HTTP write surface (route-level field allowlist, `org_id`/`corp_id` smuggling rejection,
 * audit-on-mutation) is proved separately in the paired
 * `local-directory-org-crud-route.db.test.ts` — this file exercises the service functions
 * directly, mirroring B1's `directory-local-provider-bootstrap.db.test.ts` convention.
 *
 * Fixture IDs are namespaced with this file's own STAMP + a per-test suffix — integration specs
 * share one real Postgres in CI (plugin-tests.yml), so a bare `Date.now()` can collide with
 * another file's fixtures in the same run.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const STAMP = Date.now()

function orgId(suffix: string): string {
  return `b2-local-${STAMP}-${suffix}`
}

function newUserId(suffix: string): string {
  return `b2-local-user-${STAMP}-${suffix}`
}

async function seedUser(id: string, name: string): Promise<void> {
  await query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, 'x')`, [id, `${id}@example.test`, name])
}

describeIfDatabase('Canonical Org MVP — B2 local departments/accounts/memberships CRUD (real DB, service layer)', () => {
  const seededOrgIds: string[] = []
  const seededUserIds: string[] = []

  afterEach(async () => {
    const orgs = seededOrgIds.splice(0)
    for (const org of orgs) {
      // directory_departments/directory_accounts (integration_id FK, ON DELETE CASCADE) and
      // their dependents (directory_account_departments, directory_account_links, both also
      // ON DELETE CASCADE) all fall out of deleting the integration row.
      await query(`DELETE FROM directory_integrations WHERE org_id = $1`, [org])
    }
    const users = seededUserIds.splice(0)
    for (const uid of users) {
      await query(`DELETE FROM users WHERE id = $1`, [uid])
    }
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  describe('departments', () => {
    it('create + rename + archive keeps history (row remains, is_active=false); re-archive is idempotent', async () => {
      const org = orgId('dept-lifecycle')
      seededOrgIds.push(org)

      const created = await createLocalDepartment({ orgId: org, name: 'Engineering' })
      expect(created.name).toBe('Engineering')
      expect(created.isActive).toBe(true)
      expect(created.parentDepartmentId).toBeNull()
      expect(created.externalDepartmentId.startsWith('local:')).toBe(true)

      const renamed = await updateLocalDepartment(org, created.id, { name: 'Platform Engineering' })
      expect(renamed?.name).toBe('Platform Engineering')
      expect(renamed?.isActive).toBe(true)

      const archived = await archiveLocalDepartment(org, created.id)
      expect(archived?.isActive).toBe(false)
      expect(archived?.name).toBe('Platform Engineering')

      const row = await query<{ id: string; is_active: boolean; name: string }>(
        `SELECT id, is_active, name FROM directory_departments WHERE id = $1`,
        [created.id],
      )
      expect(row.rows.length).toBe(1)
      expect(row.rows[0].is_active).toBe(false)
      expect(row.rows[0].name).toBe('Platform Engineering')

      const archivedAgain = await archiveLocalDepartment(org, created.id)
      expect(archivedAgain?.isActive).toBe(false)
    })

    it('parent department resolves to the PARENT id, and the stored key is the parent\'s external_department_id', async () => {
      const org = orgId('dept-parent')
      seededOrgIds.push(org)

      const parent = await createLocalDepartment({ orgId: org, name: 'Sales' })
      const child = await createLocalDepartment({ orgId: org, name: 'Sales APAC', parentDepartmentId: parent.id })

      expect(child.parentDepartmentId).toBe(parent.id)

      const row = await query<{ external_parent_department_id: string | null }>(
        `SELECT external_parent_department_id FROM directory_departments WHERE id = $1`,
        [child.id],
      )
      expect(row.rows[0].external_parent_department_id).toBe(parent.externalDepartmentId)
    })

    it('rejects an empty/whitespace-only name', async () => {
      const org = orgId('dept-empty-name')
      seededOrgIds.push(org)
      await expect(createLocalDepartment({ orgId: org, name: '   ' })).rejects.toBeInstanceOf(LocalDirectoryValidationError)
    })

    it('rejects a non-existent parent department id', async () => {
      const org = orgId('dept-bad-parent')
      seededOrgIds.push(org)
      await expect(
        createLocalDepartment({ orgId: org, name: 'Orphan', parentDepartmentId: '00000000-0000-0000-0000-000000000000' }),
      ).rejects.toBeInstanceOf(LocalDirectoryNotFoundError)
    })

    it('raw carries provenance ONLY — no manager field', async () => {
      const org = orgId('dept-raw')
      seededOrgIds.push(org)
      const created = await createLocalDepartment({ orgId: org, name: 'Legal' })
      const row = await query<{ raw: Record<string, unknown> }>(`SELECT raw FROM directory_departments WHERE id = $1`, [created.id])
      expect(row.rows[0].raw).toEqual({ source: 'local', metadata: {} })
    })
  })

  describe('accounts', () => {
    it('create + link + deactivate keeps history; NEVER touches user_external_identities (with a positive control)', async () => {
      const org = orgId('acct-lifecycle')
      seededOrgIds.push(org)
      const uid = newUserId('acct-lifecycle')
      seededUserIds.push(uid)
      await seedUser(uid, 'Ada Lovelace')

      const created = await createLocalAccount({ orgId: org, localUserId: uid, title: 'Engineer' })
      expect(created.externalUserId).toBe(uid)
      expect(created.externalKey).toBe(`${org}:${uid}`)
      expect(created.name).toBe('Ada Lovelace')
      expect(created.title).toBe('Engineer')
      expect(created.isActive).toBe(true)
      expect(created.localUserId).toBe(uid)

      const linkRow = await query<{ local_user_id: string; link_status: string }>(
        `SELECT local_user_id, link_status FROM directory_account_links WHERE directory_account_id = $1`,
        [created.id],
      )
      expect(linkRow.rows.length).toBe(1)
      expect(linkRow.rows[0].local_user_id).toBe(uid)
      expect(linkRow.rows[0].link_status).toBe('linked')

      const updated = await updateLocalAccount(org, created.id, { mobile: '13800000000' })
      expect(updated?.mobile).toBe('13800000000')
      expect(updated?.name).toBe('Ada Lovelace')

      const archived = await archiveLocalAccount(org, created.id)
      expect(archived?.isActive).toBe(false)

      const row = await query<{ is_active: boolean }>(`SELECT is_active FROM directory_accounts WHERE id = $1`, [created.id])
      expect(row.rows.length).toBe(1)
      expect(row.rows[0].is_active).toBe(false)

      // Positive control: directory_account_links DOES have a row for this account, proving the
      // zero-rows assertion below isn't vacuously true because of a broken query/table name.
      const linkStillThere = await query(`SELECT 1 FROM directory_account_links WHERE directory_account_id = $1`, [created.id])
      expect(linkStillThere.rows.length).toBe(1)

      const identityRows = await query(`SELECT 1 FROM user_external_identities WHERE provider = 'local'`)
      expect(identityRows.rows.length).toBe(0)
    })

    it('rejects a non-existent local user id', async () => {
      const org = orgId('acct-no-user')
      seededOrgIds.push(org)
      await expect(createLocalAccount({ orgId: org, localUserId: 'no-such-user' })).rejects.toBeInstanceOf(LocalDirectoryNotFoundError)
    })

    it('rejects a second local account for the same (org, user) pair — 409-shaped, not a silent duplicate', async () => {
      const org = orgId('acct-dup')
      seededOrgIds.push(org)
      const uid = newUserId('acct-dup')
      seededUserIds.push(uid)
      await seedUser(uid, 'Dup User')

      await createLocalAccount({ orgId: org, localUserId: uid })
      await expect(createLocalAccount({ orgId: org, localUserId: uid })).rejects.toBeInstanceOf(LocalDirectoryConflictError)

      const rows = await query(`SELECT 1 FROM directory_accounts WHERE external_user_id = $1`, [uid])
      expect(rows.rows.length).toBe(1)
    })

    it('raw carries provenance ONLY — no leader_in_dept field', async () => {
      const org = orgId('acct-raw')
      seededOrgIds.push(org)
      const uid = newUserId('acct-raw')
      seededUserIds.push(uid)
      await seedUser(uid, 'Raw Check')

      const created = await createLocalAccount({ orgId: org, localUserId: uid })
      const row = await query<{ raw: Record<string, unknown> }>(`SELECT raw FROM directory_accounts WHERE id = $1`, [created.id])
      expect(row.rows[0].raw).toEqual({ source: 'local', localUserId: uid })
    })
  })

  describe('memberships', () => {
    async function seedAccountAndDepartments(org: string, tag: string) {
      const uid = newUserId(tag)
      seededUserIds.push(uid)
      await seedUser(uid, `Member ${tag}`)
      const account = await createLocalAccount({ orgId: org, localUserId: uid })
      const deptA = await createLocalDepartment({ orgId: org, name: `Dept A ${tag}` })
      const deptB = await createLocalDepartment({ orgId: org, name: `Dept B ${tag}` })
      return { account, deptA, deptB }
    }

    it('add is idempotent — the same (account, department) pair twice yields exactly one row', async () => {
      const org = orgId('member-idempotent')
      seededOrgIds.push(org)
      const { account, deptA } = await seedAccountAndDepartments(org, 'idempotent')

      const first = await addLocalMembership({ orgId: org, accountId: account.id, departmentId: deptA.id })
      const second = await addLocalMembership({ orgId: org, accountId: account.id, departmentId: deptA.id })

      expect(first.isPrimary).toBe(false)
      expect(second.isPrimary).toBe(false)
      expect(second.accountId).toBe(first.accountId)
      expect(second.departmentId).toBe(first.departmentId)

      const rows = await query(
        `SELECT 1 FROM directory_account_departments WHERE directory_account_id = $1 AND directory_department_id = $2`,
        [account.id, deptA.id],
      )
      expect(rows.rows.length).toBe(1)
    })

    it('primary switch demotes the old primary — exactly one is_primary=true row per account, both directions', async () => {
      const org = orgId('member-primary-switch')
      seededOrgIds.push(org)
      const { account, deptA, deptB } = await seedAccountAndDepartments(org, 'primary-switch')

      await addLocalMembership({ orgId: org, accountId: account.id, departmentId: deptA.id })
      await addLocalMembership({ orgId: org, accountId: account.id, departmentId: deptB.id })

      const firstSwitch = await switchLocalPrimaryDepartment(org, account.id, deptA.id)
      expect(firstSwitch.isPrimary).toBe(true)

      const afterFirst = await query<{ directory_department_id: string; is_primary: boolean }>(
        `SELECT directory_department_id, is_primary FROM directory_account_departments WHERE directory_account_id = $1 ORDER BY directory_department_id`,
        [account.id],
      )
      expect(afterFirst.rows.filter((r) => r.is_primary).length).toBe(1)
      expect(afterFirst.rows.find((r) => r.directory_department_id === deptA.id)?.is_primary).toBe(true)
      expect(afterFirst.rows.find((r) => r.directory_department_id === deptB.id)?.is_primary).toBe(false)

      const secondSwitch = await switchLocalPrimaryDepartment(org, account.id, deptB.id)
      expect(secondSwitch.isPrimary).toBe(true)

      const afterSecond = await query<{ directory_department_id: string; is_primary: boolean }>(
        `SELECT directory_department_id, is_primary FROM directory_account_departments WHERE directory_account_id = $1 ORDER BY directory_department_id`,
        [account.id],
      )
      expect(afterSecond.rows.filter((r) => r.is_primary).length).toBe(1)
      expect(afterSecond.rows.find((r) => r.directory_department_id === deptA.id)?.is_primary).toBe(false)
      expect(afterSecond.rows.find((r) => r.directory_department_id === deptB.id)?.is_primary).toBe(true)
    })

    it('rejects switching primary to a department the account has no membership row for', async () => {
      const org = orgId('member-primary-missing')
      seededOrgIds.push(org)
      const { account, deptA } = await seedAccountAndDepartments(org, 'primary-missing')

      await expect(switchLocalPrimaryDepartment(org, account.id, deptA.id)).rejects.toBeInstanceOf(LocalDirectoryNotFoundError)
    })

    it('rejects a membership whose account and department belong to different orgs\' local integrations', async () => {
      const orgOne = orgId('member-cross-org-1')
      const orgTwo = orgId('member-cross-org-2')
      seededOrgIds.push(orgOne, orgTwo)

      const { account } = await seedAccountAndDepartments(orgOne, 'cross-org-account')
      const other = await seedAccountAndDepartments(orgTwo, 'cross-org-dept')

      await expect(
        addLocalMembership({ orgId: orgOne, accountId: account.id, departmentId: other.deptA.id }),
      ).rejects.toBeInstanceOf(LocalDirectoryNotFoundError)
    })
  })
})

// PB4-1 lock point 4 (owner): the single-UPDATE switch's exactly-one-primary invariant must be
// proven by REAL CONCURRENCY in the committed suite — a sequential test cannot stand in for it.
// Two simultaneous switches to different departments, 10 rounds; after each round exactly one
// membership is primary (whichever writer's statement committed last wins wholly — the UPDATE's
// own row locks serialize the two statements).
describeIfDatabase('PB4-1 — concurrent primary switches (real DB)', () => {
  const raceUserIds: string[] = []
  const raceOrgs: string[] = []

  afterEach(async () => {
    for (const org of raceOrgs.splice(0)) {
      await query(
        `DELETE FROM directory_accounts WHERE integration_id IN (SELECT id FROM directory_integrations WHERE org_id = $1 AND provider = 'local')`,
        [org],
      )
      await query(
        `DELETE FROM directory_departments WHERE integration_id IN (SELECT id FROM directory_integrations WHERE org_id = $1 AND provider = 'local')`,
        [org],
      )
      await query(
        `DELETE FROM audit_logs WHERE resource_type = 'directory-integration' AND resource_id IN (SELECT id::text FROM directory_integrations WHERE org_id = $1 AND provider = 'local')`,
        [org],
      )
      await query(`DELETE FROM directory_integrations WHERE org_id = $1 AND provider = 'local'`, [org])
    }
    for (const id of raceUserIds.splice(0)) await query(`DELETE FROM users WHERE id = $1`, [id])
  })

  it('two CONCURRENT switches to different departments end with exactly one primary, every round (10 rounds)', async () => {
    const org = orgId('race-switch')
    raceOrgs.push(org)
    const uid = newUserId('race-switch')
    raceUserIds.push(uid)
    await seedUser(uid, 'Race Switch')
    const account = await createLocalAccount({ orgId: org, localUserId: uid })
    const deptA = await createLocalDepartment({ orgId: org, name: 'Race A' })
    const deptB = await createLocalDepartment({ orgId: org, name: 'Race B' })
    await addLocalMembership({ orgId: org, accountId: account.id, departmentId: deptA.id })
    await addLocalMembership({ orgId: org, accountId: account.id, departmentId: deptB.id })

    for (let round = 0; round < 10; round++) {
      await Promise.all([
        switchLocalPrimaryDepartment(org, account.id, deptA.id),
        switchLocalPrimaryDepartment(org, account.id, deptB.id),
      ])
      const primaries = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM directory_account_departments WHERE directory_account_id = $1 AND is_primary = true`,
        [account.id],
      )
      expect(Number(primaries.rows[0]?.n)).toBe(1)
    }
  })
})
