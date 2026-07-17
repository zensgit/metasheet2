import { afterEach, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import { getOrCreateLocalIntegration } from '../../src/directory/directory-sync'

/**
 * Canonical Org MVP — B1 (local-provider bootstrap), #4215 §5.1, real DB.
 *
 * `getOrCreateLocalIntegration` is the get-or-create for the ONE editable `provider='local'`
 * directory integration that anchors an org's canonical organization data. This proves, against
 * real Postgres:
 *   (a) constructed concurrency — two simultaneous bootstraps for the same org converge to the
 *       SAME row and emit exactly ONE creation audit event (the partial unique index
 *       `one_active_local_integration_per_org` makes the loser's INSERT raise unique_violation,
 *       which the service catches and resolves by re-reading the winner — the loser never audits);
 *   (b) the DB itself enforces the cap — two raw INSERTs with DIFFERENT names (so the pre-existing
 *       UNIQUE(org_id, provider, name) cannot be what rejects the second one) still collide on the
 *       new partial index;
 *   (c) idempotent re-call returns the same row and does not audit a second time;
 *   (d) the created row's shape: corp_id = 'local:<org_id>', status='active', sync_enabled=false,
 *       config.source='local', config.mode='editable';
 *   (e) the index is ACTIVE-only: marking the row inactive lets a fresh bootstrap create a new
 *       active row (inactive history is preserved, not blocked);
 *   (f) the index is provider-scoped: an org with an active 'dingtalk' integration can still get
 *       an active 'local' one;
 *   (g)/(h) owner round P2-1 — the `local_integration_corp_id_shape` CHECK constraint (not the
 *       #4181 `updateDirectoryIntegration` guard, which never sees a local row's id — see the
 *       comment on `getOrCreateLocalIntegration`) rejects a raw INSERT/UPDATE that gives a
 *       'local' row a corp_id other than 'local:<org_id>'.
 *
 * Audit is asserted directly against `audit_logs` (the table `auditLog()` in
 * `../audit/audit` -> `AuditService.logEvent` -> `AuditRepository.createAuditLog` writes to).
 * That table is a partitioned table that lazily creates its own current-month partition on first
 * insert (`AuditRepository.ensureCurrentMonthPartition`), so no extra fixture setup is needed here.
 *
 * Fixture IDs are namespaced with this file's own STAMP + a per-test suffix — integration specs
 * share one real Postgres in CI (plugin-tests.yml), so a bare `Date.now()` can collide with
 * another file's fixtures in the same run.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const STAMP = Date.now()
const AUDIT_ACTION = 'directory.local_integration.bootstrap'

function orgId(suffix: string): string {
  return `b1-local-${STAMP}-${suffix}`
}

interface LocalIntegrationRow {
  id: string
  org_id: string
  provider: string
  name: string
  status: string
  corp_id: string
  config: unknown
  sync_enabled: boolean
}

async function readIntegrations(orgId: string, provider?: string): Promise<LocalIntegrationRow[]> {
  const result = provider
    ? await query<LocalIntegrationRow>(
        `SELECT id, org_id, provider, name, status, corp_id, config, sync_enabled
         FROM directory_integrations WHERE org_id = $1 AND provider = $2 ORDER BY created_at`,
        [orgId, provider],
      )
    : await query<LocalIntegrationRow>(
        `SELECT id, org_id, provider, name, status, corp_id, config, sync_enabled
         FROM directory_integrations WHERE org_id = $1 ORDER BY created_at`,
        [orgId],
      )
  return result.rows
}

async function readActiveLocalRows(orgId: string): Promise<LocalIntegrationRow[]> {
  return (await readIntegrations(orgId, 'local')).filter((row) => row.status === 'active')
}

async function insertLocalRow(orgId: string, name: string, status: 'active' | 'inactive' = 'active'): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config, sync_enabled)
     VALUES ($1, 'local', $2, $3, $4, $5::jsonb, false)
     RETURNING id`,
    [orgId, name, status, `local:${orgId}`, JSON.stringify({ mode: 'editable', source: 'local' })],
  )
  return result.rows[0].id
}

async function insertDingTalkRow(orgId: string, name: string): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
     VALUES ($1, 'dingtalk', $2, 'active', $3, '{}'::jsonb)
     RETURNING id`,
    [orgId, name, `corp-${STAMP}`],
  )
  return result.rows[0].id
}

async function readBootstrapAuditRows(resourceId: string): Promise<Array<{ action: string; resource_type: string; resource_id: string }>> {
  const result = await query<{ action: string; resource_type: string; resource_id: string }>(
    `SELECT action, resource_type, resource_id FROM audit_logs
     WHERE action = $1 AND resource_type = 'directory-integration' AND resource_id = $2`,
    [AUDIT_ACTION, resourceId],
  )
  return result.rows
}

describeIfDatabase('Canonical Org MVP — B1 local provider bootstrap (real DB)', () => {
  const seededOrgIds: string[] = []

  afterEach(async () => {
    const ids = seededOrgIds.splice(0)
    for (const id of ids) {
      await query(
        `DELETE FROM audit_logs WHERE resource_type = 'directory-integration'
           AND resource_id IN (SELECT id::text FROM directory_integrations WHERE org_id = $1)`,
        [id],
      )
      await query(`DELETE FROM directory_integrations WHERE org_id = $1`, [id])
    }
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('(a) two concurrent bootstraps for the same org converge to one row and exactly one audit event', async () => {
    const org = orgId('concurrent')
    seededOrgIds.push(org)

    const [first, second] = await Promise.all([getOrCreateLocalIntegration(org), getOrCreateLocalIntegration(org)])

    expect(first.id).toBe(second.id)

    const activeRows = await readActiveLocalRows(org)
    expect(activeRows.length).toBe(1)
    expect(activeRows[0].id).toBe(first.id)

    const auditRows = await readBootstrapAuditRows(first.id)
    expect(auditRows.length).toBe(1)
  })

  it('(b) DB-level cap: two raw INSERTs with different names — the second is rejected by the partial index, not the (org,provider,name) constraint', async () => {
    const org = orgId('db-cap')
    seededOrgIds.push(org)

    await insertLocalRow(org, 'Local organization A')
    await expect(insertLocalRow(org, 'Local organization B')).rejects.toMatchObject({
      code: '23505',
      constraint: 'one_active_local_integration_per_org',
    })

    const activeRows = await readActiveLocalRows(org)
    expect(activeRows.length).toBe(1)
    expect(activeRows[0].name).toBe('Local organization A')
  })

  it('(c) idempotent re-call returns the same row and does not audit a second time', async () => {
    const org = orgId('idempotent')
    seededOrgIds.push(org)

    const first = await getOrCreateLocalIntegration(org)
    const second = await getOrCreateLocalIntegration(org)

    expect(second.id).toBe(first.id)

    const activeRows = await readActiveLocalRows(org)
    expect(activeRows.length).toBe(1)

    const auditRows = await readBootstrapAuditRows(first.id)
    expect(auditRows.length).toBe(1)
  })

  it('(d) created row shape: corp_id, status, sync_enabled, config.mode/source', async () => {
    const org = orgId('shape')
    seededOrgIds.push(org)

    const created = await getOrCreateLocalIntegration(org)

    const rows = await readIntegrations(org, 'local')
    expect(rows.length).toBe(1)
    const row = rows[0]
    expect(row.id).toBe(created.id)
    expect(row.corp_id).toBe(`local:${org}`)
    expect(row.status).toBe('active')
    expect(row.sync_enabled).toBe(false)
    const config = row.config as { mode?: string; source?: string }
    expect(config.mode).toBe('editable')
    expect(config.source).toBe('local')
  })

  it('(e) active-only cap: the index permits inactive history — an inactive local row does not block a new active one, but a second ACTIVE one is still rejected', async () => {
    // Raw inserts (not getOrCreateLocalIntegration): getOrCreateLocalIntegration always writes
    // the constant name 'Local organization', so driving this through the service would collide
    // on the pre-existing UNIQUE(org_id, provider, name) index — the SAME confound test (b) is
    // written to dodge — and prove nothing about `one_active_local_integration_per_org` itself.
    // How the SERVICE handles a deactivated anchor is answered separately by PB4-4: getOrCreate now
    // REACTIVATES the canonical `name='Local organization'` anchor in place (same id) rather than
    // bootstrapping a second row — see directory-local-integration-reactivation.db.test.ts. This
    // test isolates the INDEX alone (raw inserts, differently-named rows), which is unchanged.
    const org = orgId('active-only')
    seededOrgIds.push(org)

    const inactiveId = await insertLocalRow(org, 'Local organization (archived)', 'inactive')
    // A new ACTIVE row with a different name succeeds — the partial index ignores inactive rows.
    const activeId = await insertLocalRow(org, 'Local organization (current)', 'active')
    expect(activeId).not.toBe(inactiveId)

    const rows = await readIntegrations(org, 'local')
    expect(rows.length).toBe(2)
    expect(rows.find((r) => r.id === inactiveId)?.status).toBe('inactive')
    expect(rows.find((r) => r.id === activeId)?.status).toBe('active')

    // But a SECOND active row (yet another different name) is still rejected — the cap is
    // active-only, not a one-time allowance.
    await expect(insertLocalRow(org, 'Local organization (second-active)', 'active')).rejects.toMatchObject({
      code: '23505',
      constraint: 'one_active_local_integration_per_org',
    })

    const activeRows = await readActiveLocalRows(org)
    expect(activeRows.length).toBe(1)
    expect(activeRows[0].id).toBe(activeId)
  })

  it('(f) provider-scoped: an org with an active dingtalk integration can still get an active local one', async () => {
    const org = orgId('coexist')
    seededOrgIds.push(org)

    const dingtalkId = await insertDingTalkRow(org, `DingTalk org ${STAMP}`)

    const local = await getOrCreateLocalIntegration(org)

    expect(local.id).not.toBe(dingtalkId)

    const allRows = await readIntegrations(org)
    expect(allRows.length).toBe(2)
    expect(allRows.every((r) => r.status === 'active')).toBe(true)
    expect(allRows.map((r) => r.provider).sort()).toEqual(['dingtalk', 'local'])
  })

  // Owner round P2-1: `getIntegrationRow` (the precursor to `updateDirectoryIntegration`'s
  // corp_id-immutable guard) hard-filters `provider = 'dingtalk'`, so a `provider='local'` row's
  // id never reaches that guard — it cannot be what protects a local row's corp_id shape. These
  // two tests prove the REAL backstop is the `local_integration_corp_id_shape` DB CHECK
  // constraint, independent of any application-layer guard, via raw INSERT/UPDATE that never go
  // through `updateDirectoryIntegration` at all.
  it('(g) DB CHECK: a raw INSERT of a local row whose corp_id does not equal local:<org_id> is rejected', async () => {
    const org = orgId('check-insert')
    seededOrgIds.push(org)

    await expect(
      query(
        `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config, sync_enabled)
         VALUES ($1, 'local', $2, 'active', $3, $4::jsonb, false)`,
        [org, 'Local organization', `local:${org}-wrong`, JSON.stringify({ mode: 'editable', source: 'local' })],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'local_integration_corp_id_shape',
    })

    const rows = await readIntegrations(org, 'local')
    expect(rows.length).toBe(0)
  })

  it('(h) DB CHECK: a raw UPDATE that rewrites an existing local row\'s corp_id alone is rejected', async () => {
    const org = orgId('check-update')
    seededOrgIds.push(org)

    const id = await insertLocalRow(org, 'Local organization')

    await expect(
      query(`UPDATE directory_integrations SET corp_id = $1 WHERE id = $2`, [`local:${org}-retagged`, id]),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'local_integration_corp_id_shape',
    })

    const rows = await readIntegrations(org, 'local')
    expect(rows.length).toBe(1)
    expect(rows[0].corp_id).toBe(`local:${org}`)
  })
})
