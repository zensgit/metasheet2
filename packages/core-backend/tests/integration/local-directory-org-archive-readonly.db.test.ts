import { Client } from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import { setLocalMembershipManager } from '../../src/directory/directory-sync'
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
 * PB4-2 — archive → FULL read-only, enforced at the WRITE POINT (real DB, service layer).
 *
 * The owner rejected the prior check-then-write version as TOCTOU-vulnerable and fixed the design:
 * every B2 write locks its target rows `SELECT ... FOR UPDATE`, classifies active/archived/missing,
 * and writes — all in ONE transaction. This file proves BOTH halves the owner named:
 *
 *   A. DIRECT-WRITER — call each service function directly against an archived target and assert
 *      the archived outcome (thrown Conflict). HTTP-only tests do NOT prove the writer enforces it;
 *      these call the writers with no route in front.
 *   B. TWO-CONNECTION BARRIER — a raw `pg.Client` holds a row lock while the pooled service write
 *      runs on a SEPARATE connection. Coverage is honest, not uniform:
 *        (ii) archive-first (archive holds the lock → the service write parks → on release it sees
 *             is_active=false → 409, NO partial write) is proven for EVERY write point via the REAL
 *             service function (update dept/account, add membership, create/reparent, primary switch,
 *             and — in directory-normalized-manager.db.test.ts — the manager writer);
 *        (i)  write-first (the write holds the lock → a concurrent archive parks → write wins,
 *             archive applies after) is proven with the REAL service on the write-holder side for
 *             update dept/account, add membership, and primary switch. For create/reparent AND the
 *             manager writer the lock-holder is a SQL STAND-IN performing the identical
 *             `SELECT FOR UPDATE` + write — those services each open+commit their own transaction, so
 *             their lock cannot be held open while the real archive runs concurrently; the stand-in
 *             reproduces the exact lock they take and proves the archive parks behind it.
 *      A poll on `pg_stat_activity` proves the parked party is genuinely BLOCKED on the row lock
 *      (not merely running after) before the holder releases — a real barrier, not a sleep race.
 *   E. deadlock-freedom — the manager writer runs concurrently with a primary switch AND with an
 *      add, many rounds, asserting no 40P01 (a department-first lock order in the manager writer
 *      reintroduces a real deadlock — proven by mutation).
 *   F. primary-switch cross-scope — a legal local target still 409s (and demotes NOTHING) when the
 *      account carries a cross-integration or provider-mislabeled foreign membership.
 *   C. primary-switch FULL read-only combinations — an ACTIVE target still 409s when ANY OTHER
 *      membership department (or the account) is archived; old-primary-archived is likewise rejected.
 *   D. 404-vs-409 discipline + duplicate-archive idempotent 200.
 *
 * Fixture IDs are namespaced with this file's own STAMP — integration specs share ONE real Postgres
 * in CI (plugin-tests.yml), so a bare `Date.now()` can collide with another file's fixtures.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const STAMP = Date.now()

function orgId(suffix: string): string {
  return `pb42-${STAMP}-${suffix}`
}
function newUserId(suffix: string): string {
  return `pb42-user-${STAMP}-${suffix}`
}

async function seedUser(id: string, name: string): Promise<void> {
  await query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, 'x')`, [id, `${id}@example.test`, name])
}

/** A dedicated raw connection for the barrier lock-holder — never drawn from the service pool, so
 *  the two sides of every barrier are guaranteed to be distinct connections. */
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
 * Deterministic barrier: poll `pg_stat_activity` until at least `min` backends are BLOCKED on a
 * lock (`wait_event_type = 'Lock'`, `state = 'active'`) while executing a statement against a
 * `directory_` table — i.e. the service write is genuinely parked behind the holder's row lock.
 * File-level serial execution (`fileParallelism: false`) means our write is the only such waiter,
 * so this observes the barrier without a fixed sleep.
 */
async function waitForBlockedDirectoryWriter(min = 1): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const r = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE '%directory_%'`,
    )
    if ((r.rows[0]?.n ?? 0) >= min) return
    await new Promise((res) => setTimeout(res, 20))
  }
  throw new Error('timed out waiting for a blocked directory writer (barrier never engaged)')
}

/** Swallows a settled promise so a leaked barrier promise can never surface as an unhandled rejection. */
function settled<T>(p: Promise<T>): Promise<unknown> {
  return p.then(
    (v) => v,
    (e) => e,
  )
}

describeIfDatabase('PB4-2 — archive → full read-only at the WRITE POINT (real DB, service layer)', () => {
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

  async function seedAccount(org: string, tag: string): Promise<{ id: string; localUserId: string }> {
    const uid = newUserId(tag)
    seededUserIds.push(uid)
    await seedUser(uid, `Member ${tag}`)
    const account = await createLocalAccount({ orgId: org, localUserId: uid })
    return { id: account.id, localUserId: uid }
  }

  // The org's active local integration id (for raw fixtures below). getOrCreateLocalIntegration is
  // idempotent; created by the first createLocalAccount/createLocalDepartment above.
  async function localIntegrationId(org: string): Promise<string> {
    const r = await query<{ id: string }>(
      `SELECT id FROM directory_integrations WHERE org_id = $1 AND provider = 'local' AND status = 'active'`,
      [org],
    )
    return r.rows[0].id
  }
  // Raw-seed a department + membership OUTSIDE the local writers so we can construct the malformed
  // rows the schema does not yet forbid (a cross-integration or provider-mislabeled membership that
  // a provider sync could produce). Not reachable via the B2 API — that is exactly the point.
  async function rawDept(integrationId: string, provider: string, tag: string): Promise<string> {
    const r = await query<{ id: string }>(
      `INSERT INTO directory_departments (integration_id, provider, external_department_id, name, is_active, raw)
       VALUES ($1, $2, $3, $4, true, '{}'::jsonb) RETURNING id`,
      [integrationId, provider, `${provider}:${STAMP}:${tag}`, `Raw ${tag}`],
    )
    return r.rows[0].id
  }
  async function rawMembership(accountId: string, departmentId: string, isPrimary: boolean): Promise<void> {
    await query(
      `INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary)
       VALUES ($1, $2, $3)`,
      [accountId, departmentId, isPrimary],
    )
  }
  async function isPrimaryOf(accountId: string, departmentId: string): Promise<boolean> {
    const r = await query<{ is_primary: boolean }>(
      `SELECT is_primary FROM directory_account_departments WHERE directory_account_id = $1 AND directory_department_id = $2`,
      [accountId, departmentId],
    )
    return r.rows[0].is_primary
  }

  // -------------------------------------------------------------------------------------------
  // F. primary-switch must not silently write a cross-integration / provider-mislabeled membership
  //    (owner P1). The lock/classify collects EVERY membership department (unfiltered); if any is
  //    foreign, the whole switch is 409 with ZERO write — the foreign old-primary is never demoted.
  // -------------------------------------------------------------------------------------------
  describe('F. primary-switch cross-scope safety', () => {
    it('a legal LOCAL target 409s (and demotes nothing) when a FOREIGN old-primary membership exists (different integration)', async () => {
      const org = orgId('f-foreign')
      seededOrgIds.push(org)
      const account = await seedAccount(org, 'f-foreign')
      const localDept = await createLocalDepartment({ orgId: org, name: 'F-Local' })
      await addLocalMembership({ orgId: org, accountId: account.id, departmentId: localDept.id })

      // A foreign membership: a LOCAL-provider department under a DIFFERENT integration, primary.
      const foreignIntegration = await query<{ id: string }>(
        `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
         VALUES ($1, 'local', $2, 'active', $3, '{"mode":"editable","source":"local"}'::jsonb) RETURNING id`,
        [`${org}-other`, `Other ${STAMP}`, `local:${org}-other`],
      )
      seededOrgIds.push(`${org}-other`)
      const foreignDept = await rawDept(foreignIntegration.rows[0].id, 'local', 'f-foreign-dept')
      await rawMembership(account.id, foreignDept, true)

      await expect(switchLocalPrimaryDepartment(org, account.id, localDept.id)).rejects.toBeInstanceOf(LocalDirectoryConflictError)
      // The foreign old-primary is untouched (NOT demoted) and the local target was NOT promoted.
      expect(await isPrimaryOf(account.id, foreignDept)).toBe(true)
      expect(await isPrimaryOf(account.id, localDept.id)).toBe(false)
    })

    it('a legal LOCAL target 409s (and demotes nothing) when a PROVIDER-MISLABELED old-primary membership exists (dingtalk dept under the local integration)', async () => {
      const org = orgId('f-mislabel')
      seededOrgIds.push(org)
      const account = await seedAccount(org, 'f-mislabel')
      const localDept = await createLocalDepartment({ orgId: org, name: 'F-Local2' })
      await addLocalMembership({ orgId: org, accountId: account.id, departmentId: localDept.id })

      const intg = await localIntegrationId(org)
      const mislabeledDept = await rawDept(intg, 'dingtalk', 'f-mislabel-dept') // same integration, wrong provider
      await rawMembership(account.id, mislabeledDept, true)

      await expect(switchLocalPrimaryDepartment(org, account.id, localDept.id)).rejects.toBeInstanceOf(LocalDirectoryConflictError)
      expect(await isPrimaryOf(account.id, mislabeledDept)).toBe(true)
      expect(await isPrimaryOf(account.id, localDept.id)).toBe(false)
    })

    it('owner P2: a switch whose TARGET is itself cross-integration is a 404 (not 409), zero audit, all primary bits unchanged', async () => {
      const org = orgId('f-foreign-target')
      seededOrgIds.push(org)
      const account = await seedAccount(org, 'f-foreign-target')
      // a legitimate local membership that is the current primary — must NOT be demoted by the reject.
      const localDept = await createLocalDepartment({ orgId: org, name: 'F-Local-primary' })
      await addLocalMembership({ orgId: org, accountId: account.id, departmentId: localDept.id })
      await switchLocalPrimaryDepartment(org, account.id, localDept.id) // localDept is primary now

      // the SWITCH TARGET is a department in a DIFFERENT integration (a foreign membership).
      const foreignIntegration = await query<{ id: string }>(
        `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
         VALUES ($1, 'local', $2, 'active', $3, '{"mode":"editable","source":"local"}'::jsonb) RETURNING id`,
        [`${org}-tgt`, `Tgt ${STAMP}`, `local:${org}-tgt`],
      )
      seededOrgIds.push(`${org}-tgt`)
      const foreignTarget = await rawDept(foreignIntegration.rows[0].id, 'local', 'f-foreign-target-dept')
      await rawMembership(account.id, foreignTarget, false)

      const auditBefore = await query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_logs WHERE resource_type = 'directory-account-department'`)
      // A foreign target is "not a valid local membership to make primary" → 404, NOT 409.
      await expect(switchLocalPrimaryDepartment(org, account.id, foreignTarget)).rejects.toBeInstanceOf(LocalDirectoryNotFoundError)
      const auditAfter = await query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_logs WHERE resource_type = 'directory-account-department'`)
      expect(auditAfter.rows[0]?.n).toBe(auditBefore.rows[0]?.n) // zero audit on the rejected path
      // all primary bits unchanged: the legit local primary stays primary, the foreign membership stays non-primary.
      expect(await isPrimaryOf(account.id, localDept.id)).toBe(true)
      expect(await isPrimaryOf(account.id, foreignTarget)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------------------------
  // A. DIRECT-WRITER archived enforcement (no route in front)
  // -------------------------------------------------------------------------------------------
  describe('A. direct-writer archived enforcement', () => {
    it('updateLocalDepartment on an ARCHIVED department throws Conflict — no write applied', async () => {
      const org = orgId('a-dept-update')
      seededOrgIds.push(org)
      const dept = await createLocalDepartment({ orgId: org, name: 'Engineering' })
      await archiveLocalDepartment(org, dept.id)

      await expect(updateLocalDepartment(org, dept.id, { name: 'RENAMED' })).rejects.toBeInstanceOf(LocalDirectoryConflictError)

      const row = await query<{ name: string; is_active: boolean }>(
        `SELECT name, is_active FROM directory_departments WHERE id = $1`,
        [dept.id],
      )
      expect(row.rows[0]).toEqual({ name: 'Engineering', is_active: false })
    })

    it('updateLocalAccount on an ARCHIVED account throws Conflict — no write applied', async () => {
      const org = orgId('a-acct-update')
      seededOrgIds.push(org)
      const account = await seedAccount(org, 'a-acct-update')
      await archiveLocalAccount(org, account.id)

      await expect(updateLocalAccount(org, account.id, { title: 'CHANGED' })).rejects.toBeInstanceOf(LocalDirectoryConflictError)

      const row = await query<{ title: string | null; is_active: boolean }>(
        `SELECT title, is_active FROM directory_accounts WHERE id = $1`,
        [account.id],
      )
      expect(row.rows[0]).toEqual({ title: null, is_active: false })
    })

    it('addLocalMembership throws Conflict when the ACCOUNT is archived — no membership row', async () => {
      const org = orgId('a-add-acct')
      seededOrgIds.push(org)
      const account = await seedAccount(org, 'a-add-acct')
      const dept = await createLocalDepartment({ orgId: org, name: 'Dept' })
      await archiveLocalAccount(org, account.id)

      await expect(addLocalMembership({ orgId: org, accountId: account.id, departmentId: dept.id })).rejects.toBeInstanceOf(
        LocalDirectoryConflictError,
      )
      const rows = await query(
        `SELECT 1 FROM directory_account_departments WHERE directory_account_id = $1 AND directory_department_id = $2`,
        [account.id, dept.id],
      )
      expect(rows.rows.length).toBe(0)
    })

    it('addLocalMembership throws Conflict when the DEPARTMENT is archived — no membership row', async () => {
      const org = orgId('a-add-dept')
      seededOrgIds.push(org)
      const account = await seedAccount(org, 'a-add-dept')
      const dept = await createLocalDepartment({ orgId: org, name: 'Dept' })
      await archiveLocalDepartment(org, dept.id)

      await expect(addLocalMembership({ orgId: org, accountId: account.id, departmentId: dept.id })).rejects.toBeInstanceOf(
        LocalDirectoryConflictError,
      )
      const rows = await query(
        `SELECT 1 FROM directory_account_departments WHERE directory_account_id = $1 AND directory_department_id = $2`,
        [account.id, dept.id],
      )
      expect(rows.rows.length).toBe(0)
    })

    it('createLocalDepartment under an ARCHIVED parent throws Conflict — no child row created', async () => {
      const org = orgId('a-create-parent')
      seededOrgIds.push(org)
      const parent = await createLocalDepartment({ orgId: org, name: 'Parent' })
      await archiveLocalDepartment(org, parent.id)

      await expect(createLocalDepartment({ orgId: org, name: 'Child', parentDepartmentId: parent.id })).rejects.toBeInstanceOf(
        LocalDirectoryConflictError,
      )
      const children = await query(
        `SELECT 1 FROM directory_departments d
           JOIN directory_departments p ON p.integration_id = d.integration_id
              AND p.external_department_id = d.external_parent_department_id
          WHERE p.id = $1`,
        [parent.id],
      )
      expect(children.rows.length).toBe(0)
    })

    it('reparent to an ARCHIVED new parent throws Conflict — child parent unchanged', async () => {
      const org = orgId('a-reparent')
      seededOrgIds.push(org)
      const child = await createLocalDepartment({ orgId: org, name: 'Child' })
      const parent = await createLocalDepartment({ orgId: org, name: 'Parent' })
      await archiveLocalDepartment(org, parent.id)

      await expect(updateLocalDepartment(org, child.id, { parentDepartmentId: parent.id })).rejects.toBeInstanceOf(
        LocalDirectoryConflictError,
      )
      const row = await query<{ external_parent_department_id: string | null }>(
        `SELECT external_parent_department_id FROM directory_departments WHERE id = $1`,
        [child.id],
      )
      expect(row.rows[0].external_parent_department_id).toBeNull()
    })

    it('switchLocalPrimaryDepartment throws Conflict when the ACCOUNT is archived', async () => {
      const org = orgId('a-switch-acct')
      seededOrgIds.push(org)
      const account = await seedAccount(org, 'a-switch-acct')
      const deptA = await createLocalDepartment({ orgId: org, name: 'A' })
      await addLocalMembership({ orgId: org, accountId: account.id, departmentId: deptA.id })
      await archiveLocalAccount(org, account.id)

      await expect(switchLocalPrimaryDepartment(org, account.id, deptA.id)).rejects.toBeInstanceOf(LocalDirectoryConflictError)
    })
  })

  // -------------------------------------------------------------------------------------------
  // C. primary-switch FULL read-only combinations (design lock §4)
  // -------------------------------------------------------------------------------------------
  describe('C. primary-switch full read-only combinations', () => {
    it('ACTIVE target still 409s when the account has ANOTHER, ARCHIVED membership department', async () => {
      const org = orgId('c-other-archived')
      seededOrgIds.push(org)
      const account = await seedAccount(org, 'c-other-archived')
      const deptA = await createLocalDepartment({ orgId: org, name: 'A' })
      const deptB = await createLocalDepartment({ orgId: org, name: 'B' })
      await addLocalMembership({ orgId: org, accountId: account.id, departmentId: deptA.id })
      await addLocalMembership({ orgId: org, accountId: account.id, departmentId: deptB.id })
      // deptA is the ACTIVE switch target; deptB (another membership) is archived → whole switch 409.
      await archiveLocalDepartment(org, deptB.id)

      await expect(switchLocalPrimaryDepartment(org, account.id, deptA.id)).rejects.toBeInstanceOf(LocalDirectoryConflictError)
      // No partial write: no membership flipped to primary.
      const primaries = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM directory_account_departments WHERE directory_account_id = $1 AND is_primary = true`,
        [account.id],
      )
      expect(primaries.rows[0].n).toBe('0')
    })

    it('old-primary-archived is likewise rejected (migrating OUT of an archived primary is NOT an exception)', async () => {
      const org = orgId('c-old-primary')
      seededOrgIds.push(org)
      const account = await seedAccount(org, 'c-old-primary')
      const deptA = await createLocalDepartment({ orgId: org, name: 'A' })
      const deptB = await createLocalDepartment({ orgId: org, name: 'B' })
      await addLocalMembership({ orgId: org, accountId: account.id, departmentId: deptA.id })
      await addLocalMembership({ orgId: org, accountId: account.id, departmentId: deptB.id })
      await switchLocalPrimaryDepartment(org, account.id, deptA.id) // deptA becomes primary
      await archiveLocalDepartment(org, deptA.id) // the (now-archived) old primary

      // Switching to the still-active deptB is rejected — that path goes through PB4-4 first.
      await expect(switchLocalPrimaryDepartment(org, account.id, deptB.id)).rejects.toBeInstanceOf(LocalDirectoryConflictError)
      // deptA is still the primary (no partial write).
      const primary = await query<{ directory_department_id: string }>(
        `SELECT directory_department_id FROM directory_account_departments WHERE directory_account_id = $1 AND is_primary = true`,
        [account.id],
      )
      expect(primary.rows.map((r) => r.directory_department_id)).toEqual([deptA.id])
    })
  })

  // -------------------------------------------------------------------------------------------
  // D. 404-vs-409 discipline + duplicate-archive idempotent 200
  // -------------------------------------------------------------------------------------------
  describe('D. 404-vs-409 discipline + idempotent archive', () => {
    it('missing department → updateLocalDepartment returns null (404 upstream); missing account → null', async () => {
      const org = orgId('d-missing')
      seededOrgIds.push(org)
      const missingId = '00000000-0000-0000-0000-000000000000'
      expect(await updateLocalDepartment(org, missingId, { name: 'X' })).toBeNull()
      expect(await updateLocalAccount(org, missingId, { title: 'X' })).toBeNull()
    })

    it('addLocalMembership on a missing account/department is 404 (NotFound), archived target is 409 (Conflict)', async () => {
      const org = orgId('d-add-404-409')
      seededOrgIds.push(org)
      const account = await seedAccount(org, 'd-add')
      const dept = await createLocalDepartment({ orgId: org, name: 'Dept' })
      const missingId = '00000000-0000-0000-0000-000000000000'

      await expect(addLocalMembership({ orgId: org, accountId: missingId, departmentId: dept.id })).rejects.toBeInstanceOf(
        LocalDirectoryNotFoundError,
      )
      await expect(addLocalMembership({ orgId: org, accountId: account.id, departmentId: missingId })).rejects.toBeInstanceOf(
        LocalDirectoryNotFoundError,
      )

      await archiveLocalDepartment(org, dept.id)
      await expect(addLocalMembership({ orgId: org, accountId: account.id, departmentId: dept.id })).rejects.toBeInstanceOf(
        LocalDirectoryConflictError,
      )
    })

    it('duplicate archive stays idempotent 200 — a second archive is a no-op success, never a 409', async () => {
      const org = orgId('d-dup-archive')
      seededOrgIds.push(org)
      const dept = await createLocalDepartment({ orgId: org, name: 'Dept' })
      const account = await seedAccount(org, 'd-dup-archive')

      const d1 = await archiveLocalDepartment(org, dept.id)
      const d2 = await archiveLocalDepartment(org, dept.id)
      expect(d1?.isActive).toBe(false)
      expect(d2?.isActive).toBe(false)

      const a1 = await archiveLocalAccount(org, account.id)
      const a2 = await archiveLocalAccount(org, account.id)
      expect(a1?.isActive).toBe(false)
      expect(a2?.isActive).toBe(false)
    })
  })

  // -------------------------------------------------------------------------------------------
  // B. TWO-CONNECTION BARRIER — both linearizations, deterministically
  // -------------------------------------------------------------------------------------------
  describe('B. two-connection deterministic barrier', () => {
    it('update dept — (ii) archive holds the lock first → the write sees is_active=false → 409, no partial write', async () => {
      const org = orgId('b-dept-ii')
      seededOrgIds.push(org)
      const dept = await createLocalDepartment({ orgId: org, name: 'Origin' })

      await withHolder(async (holder) => {
        await holder.query('BEGIN')
        await holder.query(`UPDATE directory_departments SET is_active = false, updated_at = NOW() WHERE id = $1`, [dept.id])
        const writePromise = updateLocalDepartment(org, dept.id, { name: 'BLOCKED' })
        void settled(writePromise)
        await waitForBlockedDirectoryWriter() // the write is parked behind the holder's row lock
        await holder.query('COMMIT') // archive commits first
        await expect(writePromise).rejects.toBeInstanceOf(LocalDirectoryConflictError)
      })

      const row = await query<{ name: string; is_active: boolean }>(
        `SELECT name, is_active FROM directory_departments WHERE id = $1`,
        [dept.id],
      )
      expect(row.rows[0]).toEqual({ name: 'Origin', is_active: false })
    })

    it('update dept — (i) the write holds the lock first → a concurrent archive parks → write wins, archive applies after', async () => {
      const org = orgId('b-dept-i')
      seededOrgIds.push(org)
      const dept = await createLocalDepartment({ orgId: org, name: 'Origin' })

      await withHolder(async (holder) => {
        await holder.query('BEGIN')
        // The write's stand-in acquires the SAME row lock the service write would, then writes.
        await holder.query(`SELECT id FROM directory_departments WHERE id = $1 FOR UPDATE`, [dept.id])
        await holder.query(`UPDATE directory_departments SET name = $2, updated_at = NOW() WHERE id = $1`, [dept.id, 'WriteWon'])
        const archivePromise = archiveLocalDepartment(org, dept.id)
        void settled(archivePromise)
        await waitForBlockedDirectoryWriter() // the archive is parked behind the write's row lock
        await holder.query('COMMIT') // the write commits first
        await archivePromise // archive applies AFTER
      })

      const row = await query<{ name: string; is_active: boolean }>(
        `SELECT name, is_active FROM directory_departments WHERE id = $1`,
        [dept.id],
      )
      expect(row.rows[0]).toEqual({ name: 'WriteWon', is_active: false })
    })

    it('update account — (ii) archive-first → write sees is_active=false → 409, no partial write', async () => {
      const org = orgId('b-acct-ii')
      seededOrgIds.push(org)
      const account = await seedAccount(org, 'b-acct-ii')

      await withHolder(async (holder) => {
        await holder.query('BEGIN')
        await holder.query(`UPDATE directory_accounts SET is_active = false, updated_at = NOW() WHERE id = $1`, [account.id])
        const writePromise = updateLocalAccount(org, account.id, { title: 'BLOCKED' })
        void settled(writePromise)
        await waitForBlockedDirectoryWriter()
        await holder.query('COMMIT')
        await expect(writePromise).rejects.toBeInstanceOf(LocalDirectoryConflictError)
      })

      const row = await query<{ title: string | null; is_active: boolean }>(
        `SELECT title, is_active FROM directory_accounts WHERE id = $1`,
        [account.id],
      )
      expect(row.rows[0]).toEqual({ title: null, is_active: false })
    })

    it('update account — (i) write-first → concurrent archive parks → write wins, archive applies after', async () => {
      const org = orgId('b-acct-i')
      seededOrgIds.push(org)
      const account = await seedAccount(org, 'b-acct-i')

      await withHolder(async (holder) => {
        await holder.query('BEGIN')
        await holder.query(`SELECT id FROM directory_accounts WHERE id = $1 FOR UPDATE`, [account.id])
        await holder.query(`UPDATE directory_accounts SET title = $2, updated_at = NOW() WHERE id = $1`, [account.id, 'WriteWon'])
        const archivePromise = archiveLocalAccount(org, account.id)
        void settled(archivePromise)
        await waitForBlockedDirectoryWriter()
        await holder.query('COMMIT')
        await archivePromise
      })

      const row = await query<{ title: string | null; is_active: boolean }>(
        `SELECT title, is_active FROM directory_accounts WHERE id = $1`,
        [account.id],
      )
      expect(row.rows[0]).toEqual({ title: 'WriteWon', is_active: false })
    })

    it('add membership — (ii) archive DEPARTMENT first → add sees is_active=false → 409, no membership row', async () => {
      const org = orgId('b-add-dept-ii')
      seededOrgIds.push(org)
      const account = await seedAccount(org, 'b-add-dept-ii')
      const dept = await createLocalDepartment({ orgId: org, name: 'Dept' })

      await withHolder(async (holder) => {
        await holder.query('BEGIN')
        await holder.query(`UPDATE directory_departments SET is_active = false, updated_at = NOW() WHERE id = $1`, [dept.id])
        const addPromise = addLocalMembership({ orgId: org, accountId: account.id, departmentId: dept.id })
        void settled(addPromise)
        await waitForBlockedDirectoryWriter()
        await holder.query('COMMIT')
        await expect(addPromise).rejects.toBeInstanceOf(LocalDirectoryConflictError)
      })

      const rows = await query(
        `SELECT 1 FROM directory_account_departments WHERE directory_account_id = $1 AND directory_department_id = $2`,
        [account.id, dept.id],
      )
      expect(rows.rows.length).toBe(0)
    })

    it('add membership — (ii) archive ACCOUNT first → add blocks on the account lock → 409, no membership row', async () => {
      const org = orgId('b-add-acct-ii')
      seededOrgIds.push(org)
      const account = await seedAccount(org, 'b-add-acct-ii')
      const dept = await createLocalDepartment({ orgId: org, name: 'Dept' })

      await withHolder(async (holder) => {
        await holder.query('BEGIN')
        await holder.query(`UPDATE directory_accounts SET is_active = false, updated_at = NOW() WHERE id = $1`, [account.id])
        const addPromise = addLocalMembership({ orgId: org, accountId: account.id, departmentId: dept.id })
        void settled(addPromise)
        await waitForBlockedDirectoryWriter()
        await holder.query('COMMIT')
        await expect(addPromise).rejects.toBeInstanceOf(LocalDirectoryConflictError)
      })

      const rows = await query(
        `SELECT 1 FROM directory_account_departments WHERE directory_account_id = $1 AND directory_department_id = $2`,
        [account.id, dept.id],
      )
      expect(rows.rows.length).toBe(0)
    })

    it('add membership — (i) add-wins → concurrent archive parks → membership added, dept archived after', async () => {
      const org = orgId('b-add-i')
      seededOrgIds.push(org)
      const account = await seedAccount(org, 'b-add-i')
      const dept = await createLocalDepartment({ orgId: org, name: 'Dept' })

      await withHolder(async (holder) => {
        await holder.query('BEGIN')
        // The add's stand-in acquires the account+dept locks (fixed order) and inserts the membership.
        await holder.query(`SELECT id FROM directory_accounts WHERE id = $1 FOR UPDATE`, [account.id])
        await holder.query(`SELECT id FROM directory_departments WHERE id = $1 FOR UPDATE`, [dept.id])
        await holder.query(
          `INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary, created_at)
           VALUES ($1, $2, false, NOW()) ON CONFLICT DO NOTHING`,
          [account.id, dept.id],
        )
        const archivePromise = archiveLocalDepartment(org, dept.id)
        void settled(archivePromise)
        await waitForBlockedDirectoryWriter()
        await holder.query('COMMIT')
        await archivePromise
      })

      const membership = await query(
        `SELECT 1 FROM directory_account_departments WHERE directory_account_id = $1 AND directory_department_id = $2`,
        [account.id, dept.id],
      )
      expect(membership.rows.length).toBe(1)
      const drow = await query<{ is_active: boolean }>(`SELECT is_active FROM directory_departments WHERE id = $1`, [dept.id])
      expect(drow.rows[0].is_active).toBe(false)
    })

    it('create dept — (ii) archive the PARENT first → create sees it archived → 409, no child row', async () => {
      const org = orgId('b-create-ii')
      seededOrgIds.push(org)
      const parent = await createLocalDepartment({ orgId: org, name: 'Parent' })

      await withHolder(async (holder) => {
        await holder.query('BEGIN')
        await holder.query(`UPDATE directory_departments SET is_active = false, updated_at = NOW() WHERE id = $1`, [parent.id])
        const createPromise = createLocalDepartment({ orgId: org, name: 'Child', parentDepartmentId: parent.id })
        void settled(createPromise)
        await waitForBlockedDirectoryWriter()
        await holder.query('COMMIT')
        await expect(createPromise).rejects.toBeInstanceOf(LocalDirectoryConflictError)
      })

      const children = await query(
        `SELECT 1 FROM directory_departments d
           JOIN directory_departments p ON p.integration_id = d.integration_id
              AND p.external_department_id = d.external_parent_department_id
          WHERE p.id = $1`,
        [parent.id],
      )
      expect(children.rows.length).toBe(0)
    })

    it('reparent — (ii) archive the NEW PARENT first → reparent sees it archived → 409, child parent unchanged', async () => {
      const org = orgId('b-reparent-ii')
      seededOrgIds.push(org)
      const child = await createLocalDepartment({ orgId: org, name: 'Child' })
      const parent = await createLocalDepartment({ orgId: org, name: 'Parent' })

      await withHolder(async (holder) => {
        await holder.query('BEGIN')
        await holder.query(`UPDATE directory_departments SET is_active = false, updated_at = NOW() WHERE id = $1`, [parent.id])
        const reparentPromise = updateLocalDepartment(org, child.id, { parentDepartmentId: parent.id })
        void settled(reparentPromise)
        await waitForBlockedDirectoryWriter()
        await holder.query('COMMIT')
        await expect(reparentPromise).rejects.toBeInstanceOf(LocalDirectoryConflictError)
      })

      const row = await query<{ external_parent_department_id: string | null }>(
        `SELECT external_parent_department_id FROM directory_departments WHERE id = $1`,
        [child.id],
      )
      expect(row.rows[0].external_parent_department_id).toBeNull()
    })

    it('primary switch — (ii) archive a membership dept first → whole switch sees it archived → 409, no primary flipped', async () => {
      const org = orgId('b-switch-ii')
      seededOrgIds.push(org)
      const account = await seedAccount(org, 'b-switch-ii')
      const deptA = await createLocalDepartment({ orgId: org, name: 'A' })
      const deptB = await createLocalDepartment({ orgId: org, name: 'B' })
      await addLocalMembership({ orgId: org, accountId: account.id, departmentId: deptA.id })
      await addLocalMembership({ orgId: org, accountId: account.id, departmentId: deptB.id })

      await withHolder(async (holder) => {
        await holder.query('BEGIN')
        await holder.query(`UPDATE directory_departments SET is_active = false, updated_at = NOW() WHERE id = $1`, [deptB.id])
        const switchPromise = switchLocalPrimaryDepartment(org, account.id, deptA.id) // deptA is ACTIVE
        void settled(switchPromise)
        await waitForBlockedDirectoryWriter()
        await holder.query('COMMIT')
        await expect(switchPromise).rejects.toBeInstanceOf(LocalDirectoryConflictError)
      })

      const primaries = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM directory_account_departments WHERE directory_account_id = $1 AND is_primary = true`,
        [account.id],
      )
      expect(primaries.rows[0].n).toBe('0')
    })

    it('primary switch — (i) switch-wins → concurrent archive of a member dept parks → switch applies, archive after', async () => {
      const org = orgId('b-switch-i')
      seededOrgIds.push(org)
      const account = await seedAccount(org, 'b-switch-i')
      const deptA = await createLocalDepartment({ orgId: org, name: 'A' })
      const deptB = await createLocalDepartment({ orgId: org, name: 'B' })
      await addLocalMembership({ orgId: org, accountId: account.id, departmentId: deptA.id })
      await addLocalMembership({ orgId: org, accountId: account.id, departmentId: deptB.id })

      await withHolder(async (holder) => {
        await holder.query('BEGIN')
        // The switch's stand-in locks the account + both member depts (fixed order) and flips primary.
        await holder.query(`SELECT id FROM directory_accounts WHERE id = $1 FOR UPDATE`, [account.id])
        await holder.query(
          `SELECT d.id FROM directory_account_departments ad JOIN directory_departments d ON d.id = ad.directory_department_id
            WHERE ad.directory_account_id = $1 ORDER BY d.id FOR UPDATE OF d`,
          [account.id],
        )
        await holder.query(
          `UPDATE directory_account_departments SET is_primary = (directory_department_id = $2) WHERE directory_account_id = $1`,
          [account.id, deptA.id],
        )
        const archivePromise = archiveLocalDepartment(org, deptB.id)
        void settled(archivePromise)
        await waitForBlockedDirectoryWriter()
        await holder.query('COMMIT')
        await archivePromise
      })

      const primary = await query<{ directory_department_id: string }>(
        `SELECT directory_department_id FROM directory_account_departments WHERE directory_account_id = $1 AND is_primary = true`,
        [account.id],
      )
      expect(primary.rows.map((r) => r.directory_department_id)).toEqual([deptA.id])
      const drow = await query<{ is_active: boolean }>(`SELECT is_active FROM directory_departments WHERE id = $1`, [deptB.id])
      expect(drow.rows[0].is_active).toBe(false)
    })
  })

  // -------------------------------------------------------------------------------------------
  // E. Deadlock-freedom (design lock §2): every locked write acquires ACCOUNT before DEPARTMENT.
  //    setLocalMembershipManager used to lock via a single `FOR UPDATE OF a, d` whose order is
  //    plan-dependent; if it grabbed the department before the account, a concurrent switch/add
  //    (which locks account-then-department) could take the same pair in the opposite order and
  //    deadlock (40P01). It now locks account-then-department in two explicit statements. This runs
  //    the manager writer concurrently with a primary switch on the SAME account + overlapping
  //    departments, many rounds — with a plan that locked department-first this deadlocks; with the
  //    fixed order every round completes with no 40P01.
  // -------------------------------------------------------------------------------------------
  describe('E. deadlock-freedom under fixed account-before-department lock order', () => {
    it('concurrent setLocalMembershipManager + switchLocalPrimaryDepartment on the same account never deadlock (20 rounds)', async () => {
      const org = orgId('e-deadlock')
      seededOrgIds.push(org)
      const account = await seedAccount(org, 'e-deadlock')
      const deptA = await createLocalDepartment({ orgId: org, name: 'DL-A' })
      const deptB = await createLocalDepartment({ orgId: org, name: 'DL-B' })
      await addLocalMembership({ orgId: org, accountId: account.id, departmentId: deptA.id })
      await addLocalMembership({ orgId: org, accountId: account.id, departmentId: deptB.id })

      for (let round = 0; round < 20; round++) {
        // Both operations lock the account row first; a plan that locked a department first in the
        // manager writer would deadlock against the switch here. rejects on either side would be a
        // 40P01 (deadlock_detected) or a legitimate outcome — assert NEITHER call throws.
        const results = await Promise.allSettled([
          setLocalMembershipManager(org, { directoryAccountId: account.id, directoryDepartmentId: deptA.id }, round % 2 === 0),
          switchLocalPrimaryDepartment(org, account.id, round % 2 === 0 ? deptB.id : deptA.id),
        ])
        for (const r of results) {
          if (r.status === 'rejected') {
            const code = (r.reason as { code?: string })?.code
            expect(code).not.toBe('40P01') // deadlock_detected must never occur
            throw r.reason // any other unexpected error also fails the test
          }
        }
      }
      // Both writers still function after the concurrency: manager set holds, exactly one primary.
      const mgr = await setLocalMembershipManager(org, { directoryAccountId: account.id, directoryDepartmentId: deptA.id }, true)
      expect(mgr.outcome).toBe('updated')
      const primaries = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM directory_account_departments WHERE directory_account_id = $1 AND is_primary = true`,
        [account.id],
      )
      expect(Number(primaries.rows[0]?.n)).toBe(1)
    })

    it('concurrent setLocalMembershipManager + addLocalMembership on the same account linearize with no deadlock, both effects land (15 rounds)', async () => {
      const org = orgId('e-mgr-add')
      seededOrgIds.push(org)
      const account = await seedAccount(org, 'e-mgr-add')
      const deptA = await createLocalDepartment({ orgId: org, name: 'MA-A' })
      await addLocalMembership({ orgId: org, accountId: account.id, departmentId: deptA.id })

      for (let round = 0; round < 15; round++) {
        const deptB = await createLocalDepartment({ orgId: org, name: `MA-B-${round}` })
        // manager toggles on the existing membership; add attaches a fresh department — both lock the
        // account row first (fixed order), so they serialize on it rather than deadlock.
        const [mgrRes, addRes] = await Promise.allSettled([
          setLocalMembershipManager(org, { directoryAccountId: account.id, directoryDepartmentId: deptA.id }, round % 2 === 0),
          addLocalMembership({ orgId: org, accountId: account.id, departmentId: deptB.id }),
        ])
        for (const r of [mgrRes, addRes]) {
          if (r.status === 'rejected') {
            expect((r.reason as { code?: string })?.code).not.toBe('40P01')
            throw r.reason
          }
        }
        // both effects landed: the manager result is a real outcome, and the new membership exists.
        expect((mgrRes as PromiseFulfilledResult<{ outcome: string }>).value.outcome).toBe('updated')
        const added = await query(
          `SELECT 1 FROM directory_account_departments WHERE directory_account_id = $1 AND directory_department_id = $2`,
          [account.id, deptB.id],
        )
        expect(added.rows.length).toBe(1)
      }
    })
  })
})
