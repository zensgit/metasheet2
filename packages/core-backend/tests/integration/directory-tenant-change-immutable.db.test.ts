import { afterEach, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import { DirectoryTenantChangeBlockedError, updateDirectoryIntegration } from '../../src/directory/directory-sync'

/**
 * org-transfer Phase 1 §12.1 — corp_id is IMMUTABLE once set, proved against REAL Postgres.
 *
 * tests/unit/directory-tenant-change-guard.test.ts pins this against a mocked pg client: it
 * proves the guard issues no probe query and no UPDATE call, but a mock cannot show whether a
 * real UPDATE run through this path would actually leave the row untouched, and it cannot
 * reproduce the exact first-sync TOCTOU window this guard exists to close — an interleaved
 * corp_id edit landing on an integration whose corp_id is already set but which has ZERO
 * synced directory_accounts/directory_departments rows yet (the very first sync is still in
 * flight; nothing has been written). A "block only if synced records already exist" rule
 * would let that swap through. These goldens seed that real row shape directly against the
 * migrated schema and re-SELECT after every rejected call to prove zero mutation, not just a
 * thrown error — plus the paths that must NOT be blocked (same-corp resend, initial set).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const STAMP = Date.now()

function config(): Record<string, unknown> {
  return {
    appKey: `app-key-${STAMP}`,
    appSecret: `app-secret-${STAMP}`,
    rootDepartmentId: '1',
  }
}

async function insertIntegration(name: string, corpId: string): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO directory_integrations (name, corp_id, provider, config)
     VALUES ($1, $2, 'dingtalk', $3::jsonb)
     RETURNING id`,
    [name, corpId, JSON.stringify(config())],
  )
  return result.rows[0].id
}

async function readIntegration(id: string): Promise<{ corp_id: string; name: string }> {
  const result = await query<{ corp_id: string; name: string }>(
    `SELECT corp_id, name FROM directory_integrations WHERE id = $1`,
    [id],
  )
  return result.rows[0]
}

function updateInput(overrides: { name: string; corpId: string }) {
  return {
    name: overrides.name,
    corpId: overrides.corpId,
    appKey: `app-key-${STAMP}`,
    appSecret: `app-secret-${STAMP}`,
    rootDepartmentId: '1',
  }
}

describeIfDatabase('org-transfer Phase 1 §12.1 corp_id immutable-once-set guard (real DB)', () => {
  const integrationIds: string[] = []

  afterEach(async () => {
    const ids = integrationIds.splice(0)
    for (const id of ids) {
      await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [id])
      await query(`DELETE FROM directory_departments WHERE integration_id = $1`, [id])
      await query(`DELETE FROM directory_integrations WHERE id = $1`, [id])
    }
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('blocks the first-sync TOCTOU window: corp_id set, zero synced records, swap is rejected and the row is unchanged', async () => {
    const id = await insertIntegration(`first-sync-${STAMP}`, 'corpA')
    integrationIds.push(id)

    // Nothing else seeded: zero directory_accounts / directory_departments rows for this
    // integration — the exact "first sync claimed the corp config but hasn't written a single
    // row yet" window a synced-records probe would miss.
    await expect(
      updateDirectoryIntegration(id, updateInput({ name: `swap-attempt-${STAMP}-a`, corpId: 'corpB' })),
    ).rejects.toBeInstanceOf(DirectoryTenantChangeBlockedError)

    const row = await readIntegration(id)
    expect(row.corp_id).toBe('corpA')
    expect(row.name).toBe(`first-sync-${STAMP}`) // whole UPDATE never ran — not even the name changed
  })

  it('still blocked when synced records DO exist, and the row remains unchanged', async () => {
    const id = await insertIntegration(`has-records-${STAMP}`, 'corpA')
    integrationIds.push(id)
    await query(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, raw)
       VALUES ($1, $2, $3, 'Someone', '{}'::jsonb)`,
      [id, `ext-${STAMP}`, `key-${STAMP}`],
    )

    await expect(
      updateDirectoryIntegration(id, updateInput({ name: `swap-attempt-${STAMP}-b`, corpId: 'corpB' })),
    ).rejects.toBeInstanceOf(DirectoryTenantChangeBlockedError)

    const row = await readIntegration(id)
    expect(row.corp_id).toBe('corpA')
    expect(row.name).toBe(`has-records-${STAMP}`)
  })

  it('same-corp resend is allowed: the edit applies and corp_id is untouched', async () => {
    const id = await insertIntegration(`resend-${STAMP}`, 'corpA')
    integrationIds.push(id)

    const result = await updateDirectoryIntegration(id, updateInput({ name: `renamed-${STAMP}`, corpId: 'corpA' }))

    expect(result?.corpId).toBe('corpA')
    const row = await readIntegration(id)
    expect(row.corp_id).toBe('corpA')
    expect(row.name).toBe(`renamed-${STAMP}`)
  })

  it('initial set is allowed: empty corp_id becomes a value', async () => {
    const id = await insertIntegration(`initial-set-${STAMP}`, '')
    integrationIds.push(id)

    const result = await updateDirectoryIntegration(
      id,
      updateInput({ name: `initial-set-named-${STAMP}`, corpId: 'corpB' }),
    )

    expect(result?.corpId).toBe('corpB')
    const row = await readIntegration(id)
    expect(row.corp_id).toBe('corpB')
  })
})
