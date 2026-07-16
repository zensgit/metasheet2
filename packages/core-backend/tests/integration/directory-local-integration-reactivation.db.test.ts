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
 *   (c) 2-way and (d) 5-way concurrency — after deactivation, N simultaneous callers all converge on
 *       the SAME id with exactly ONE reactivate audit (the `status <> 'active'` conditional UPDATE is
 *       a race-safe latch: only the caller whose UPDATE actually flips the row audits; the rest match
 *       zero rows and re-select the winner).
 *   (e) first-bootstrap regression — a brand-new org still bootstraps (one bootstrap audit, ZERO
 *       reactivate audits).
 *   (f) name-filter safety — an EXTRA differently-named inactive local row (raw) is left untouched;
 *       reactivation flips only the canonical `name='Local organization'` anchor, so it never
 *       double-activates into a `one_active_local_integration_per_org` violation.
 *
 * Load-bearing mutations (out-of-band, each reds this file):
 *   - delete the reactivation block            → (a) reds (getOrCreate throws after deactivation).
 *   - delete `AND status <> 'active'`          → (d) reds (every concurrent caller audits → N audits).
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

  it('(c) 2-way concurrency: after deactivation, both callers converge to the same id with exactly one reactivate audit', async () => {
    const org = orgId('c')
    seededOrgIds.push(org)
    const { integrationId } = await seedAnchorWithChildren(org)
    await deactivate(integrationId)

    const [r1, r2] = await Promise.all([getOrCreateLocalIntegration(org), getOrCreateLocalIntegration(org)])
    expect(r1.id).toBe(integrationId)
    expect(r2.id).toBe(integrationId)
    expect(await auditCount(REACTIVATE_ACTION, integrationId)).toBe(1)
  })

  it('(d) 5-way concurrency: after deactivation, all callers converge to the same id with exactly one reactivate audit', async () => {
    const org = orgId('d')
    seededOrgIds.push(org)
    const { integrationId } = await seedAnchorWithChildren(org)
    await deactivate(integrationId)

    const results = await Promise.all(Array.from({ length: 5 }, () => getOrCreateLocalIntegration(org)))
    for (const r of results) expect(r.id).toBe(integrationId)
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
