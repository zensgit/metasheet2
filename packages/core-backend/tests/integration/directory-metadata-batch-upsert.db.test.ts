import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { upsertDirectoryAccountMetadataRows, upsertDirectoryDepartmentMetadataRows } from '../../src/directory/directory-metadata-batch-upsert'

const url = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
if (!url) throw new Error('DIRECTORY_METADATA_REAL_DATABASE_REQUIRED')
const run = 'metadata_' + randomUUID().replaceAll('-', '')
const corpA = run + '_corp_a'
const corpB = run + '_corp_b'
let pool: Pool
let integrationA: string
let integrationB: string
const seen = '2026-10-26T01:00:00.000Z'
const raw = JSON.stringify({ literal: '$1, $8000, NOW()', source: 'synthetic' })
const query = (sql: string, params: unknown[]) => pool.query(sql, params)
function department(id: string, integration = integrationA): unknown[] {
  return [integration, 'dingtalk', id, null, 'Department ' + id, '/Synthetic/' + id, 7, raw, seen]
}
function account(id: string, integration = integrationA, corp: string | null = corpA): unknown[] {
  return [integration, 'dingtalk', corp, id, 'union_' + id, 'known_' + id, 'union_' + id,
    'Member ' + id, 'Nick', 'fixture@example.invalid', null, 'job', 'title', null, raw, seen]
}

beforeAll(async () => {
  pool = new Pool({ connectionString: url, max: 4 })
  integrationA = (await pool.query(`INSERT INTO directory_integrations(name,corp_id) VALUES($1,$2) RETURNING id`, [run + '_a', corpA])).rows[0].id
  integrationB = (await pool.query(`INSERT INTO directory_integrations(name,corp_id) VALUES($1,$2) RETURNING id`, [run + '_b', corpB])).rows[0].id
})
afterAll(async () => {
  if (!pool) return
  const ids = [integrationA, integrationB].filter(Boolean)
  try {
    await pool.query('DELETE FROM directory_accounts WHERE integration_id=ANY($1::uuid[])', [ids])
    await pool.query('DELETE FROM directory_departments WHERE integration_id=ANY($1::uuid[])', [ids])
    await pool.query('DELETE FROM directory_integrations WHERE id=ANY($1::uuid[])', [ids])
  } finally { await pool.end() }
})

describe('directory metadata batching on native PostgreSQL', () => {
  it('retains exact metadata, IDs and created/update counts including every openId CASE branch', async () => {
    let calls = 0
    const observed = async (sql: string, params: unknown[]) => { calls++; return query(sql, params) }
    expect(await upsertDirectoryDepartmentMetadataRows(observed, [])).toEqual({ createdCount: 0, updatedCount: 0 })
    expect(await upsertDirectoryAccountMetadataRows(observed, [])).toEqual({ createdCount: 0, updatedCount: 0 })
    expect(calls).toBe(0)
    const deps = [department('cold_a'), department('cold_b')]
    expect(await upsertDirectoryDepartmentMetadataRows(query, deps)).toEqual({ createdCount: 2, updatedCount: 0 })
    const departmentsBefore = (await pool.query(`SELECT id::text,external_department_id,created_at::text FROM directory_departments
      WHERE integration_id=$1 AND external_department_id LIKE 'cold_%' ORDER BY external_department_id`, [integrationA])).rows
    const rows = Array.from({ length: 6 }, (_, i) => account('identity_' + i))
    rows[2][4] = null
    rows[5][2] = null
    expect(await upsertDirectoryAccountMetadataRows(query, rows)).toEqual({ createdCount: 6, updatedCount: 0 })
    const before = (await pool.query(`SELECT id::text,external_user_id,created_at::text FROM directory_accounts
      WHERE integration_id=$1 AND external_user_id LIKE 'identity_%' ORDER BY external_user_id`, [integrationA])).rows
    const updates = rows.map(row => [...row])
    updates[0][5] = null
    updates[1][4] = 'changed_union'
    updates[1][5] = null
    updates[2][5] = null
    updates[3][2] = corpB
    updates[3][5] = null
    updates[4][4] = 'changed_union_explicit'
    updates[4][5] = 'explicit_new_open'
    updates[5][5] = null
    for (const row of updates) row[7] = 'Updated ' + row[3]
    expect(await upsertDirectoryAccountMetadataRows(query, updates)).toEqual({ createdCount: 0, updatedCount: 6 })
    expect((await pool.query(`SELECT id::text,external_user_id,created_at::text FROM directory_accounts
      WHERE integration_id=$1 AND external_user_id LIKE 'identity_%' ORDER BY external_user_id`, [integrationA])).rows).toEqual(before)
    expect((await pool.query(`SELECT external_user_id,open_id,name,nick,email,mobile,job_number,title,avatar_url,is_active,raw,
      last_seen_at=$2::timestamptz AS seen_matches FROM directory_accounts
      WHERE integration_id=$1 AND external_user_id LIKE 'identity_%' ORDER BY external_user_id`, [integrationA, seen])).rows)
      .toEqual(['known_identity_0', null, null, null, 'explicit_new_open', 'known_identity_5'].map((openId, i) => ({
        external_user_id: 'identity_' + i, open_id: openId, name: 'Updated identity_' + i,
        nick: 'Nick', email: 'fixture@example.invalid', mobile: null, job_number: 'job', title: 'title', avatar_url: null,
        is_active: true, raw: JSON.parse(raw), seen_matches: true,
      })))
    const updatedDeps = deps.map(row => [...row])
    for (const row of updatedDeps) row[4] = 'Updated ' + row[2]
    expect(await upsertDirectoryDepartmentMetadataRows(query, updatedDeps)).toEqual({ createdCount: 0, updatedCount: 2 })
    expect((await pool.query(`SELECT id::text,external_department_id,created_at::text FROM directory_departments
      WHERE integration_id=$1 AND external_department_id LIKE 'cold_%' ORDER BY external_department_id`, [integrationA])).rows).toEqual(departmentsBefore)
    expect((await pool.query(`SELECT external_department_id,external_parent_department_id,name,full_path,order_index,is_active,raw,
      last_seen_at=$2::timestamptz AS seen_matches FROM directory_departments
      WHERE integration_id=$1 AND external_department_id LIKE 'cold_%' ORDER BY external_department_id`, [integrationA, seen])).rows)
      .toEqual(['cold_a', 'cold_b'].map(id => ({ external_department_id: id, external_parent_department_id: null,
        name: 'Updated ' + id, full_path: '/Synthetic/' + id, order_index: 7, is_active: true, raw: JSON.parse(raw), seen_matches: true })))
  })

  it('writes 501 distinct rows per kind in two bounded statements without shifting bound data', async () => {
    const sizes: number[] = []
    const observed = async (sql: string, params: unknown[]) => { sizes.push(params.length); return query(sql, params) }
    expect(await upsertDirectoryDepartmentMetadataRows(observed, Array.from({ length: 501 }, (_, i) => department('chunk_' + i))))
      .toEqual({ createdCount: 501, updatedCount: 0 })
    expect(sizes).toEqual([4500, 9])
    sizes.length = 0
    expect(await upsertDirectoryAccountMetadataRows(observed, Array.from({ length: 501 }, (_, i) => account('chunk_' + i))))
      .toEqual({ createdCount: 501, updatedCount: 0 })
    expect(sizes).toEqual([8000, 16])
    expect((await pool.query(`SELECT external_user_id,name,raw FROM directory_accounts
      WHERE integration_id=$1 AND external_user_id=ANY($2::text[]) ORDER BY external_user_id`, [integrationA, ['chunk_0', 'chunk_500']])).rows)
      .toEqual(['chunk_0', 'chunk_500'].map(id => ({ external_user_id: id, name: 'Member ' + id, raw: JSON.parse(raw) })))
    expect((await pool.query(`SELECT
      (SELECT count(*)::int FROM directory_accounts WHERE integration_id=$1 AND external_user_id LIKE 'chunk_%') AS accounts,
      (SELECT count(*)::int FROM directory_departments WHERE integration_id=$1 AND external_department_id LIKE 'chunk_%') AS departments`, [integrationA])).rows)
      .toEqual([{ accounts: 501, departments: 501 }])
  })

  it('keeps the caller transaction aborted after a later chunk failure and caller rollback removes earlier chunks', async () => {
    const client = await pool.connect()
    const rows = Array.from({ length: 501 }, (_, i) => account('atomic_' + i))
    rows[500][0] = randomUUID()
    try {
      await client.query('BEGIN')
      await expect(upsertDirectoryAccountMetadataRows((sql, params) => client.query(sql, params), rows))
        .rejects.toMatchObject({ code: '23503' })
      await expect(client.query('SELECT 1')).rejects.toMatchObject({ code: '25P02' })
      expect((await pool.query(`SELECT count(*)::int AS n FROM directory_accounts
        WHERE integration_id=$1 AND external_user_id LIKE 'atomic_%'`, [integrationA])).rows).toEqual([{ n: 0 }])
      await client.query('ROLLBACK')
      expect((await pool.query(`SELECT count(*)::int AS n FROM directory_accounts
        WHERE integration_id=$1 AND external_user_id LIKE 'atomic_%'`, [integrationA])).rows).toEqual([{ n: 0 }])
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release() }
  })

  it('does not cross integration conflict targets even when external IDs are identical', async () => {
    await upsertDirectoryDepartmentMetadataRows(query, [department('shared')])
    await upsertDirectoryAccountMetadataRows(query, [account('shared')])
    const before = (await pool.query(`SELECT to_jsonb(a) AS row FROM directory_accounts a
      WHERE integration_id=$1 AND external_user_id='shared'`, [integrationA])).rows
    const departmentBefore = (await pool.query(`SELECT to_jsonb(d) AS row FROM directory_departments d
      WHERE integration_id=$1 AND external_department_id='shared'`, [integrationA])).rows
    const otherDepartment = department('shared', integrationB)
    otherDepartment[4] = 'Other integration department'
    expect(await upsertDirectoryDepartmentMetadataRows(query, [otherDepartment]))
      .toEqual({ createdCount: 1, updatedCount: 0 })
    expect(await upsertDirectoryAccountMetadataRows(query, [account('shared', integrationB, corpB)]))
      .toEqual({ createdCount: 1, updatedCount: 0 })
    expect((await pool.query(`SELECT to_jsonb(a) AS row FROM directory_accounts a
      WHERE integration_id=$1 AND external_user_id='shared'`, [integrationA])).rows).toEqual(before)
    expect((await pool.query(`SELECT to_jsonb(d) AS row FROM directory_departments d
      WHERE integration_id=$1 AND external_department_id='shared'`, [integrationA])).rows).toEqual(departmentBefore)
    const departmentScopes = (await pool.query(`SELECT id::text,integration_id::text,external_department_id,name
      FROM directory_departments WHERE integration_id=ANY($1::uuid[]) AND external_department_id='shared'
      ORDER BY integration_id`, [[integrationA, integrationB]])).rows
    expect(departmentScopes.map(({ integration_id, external_department_id, name }) => ({ integration_id, external_department_id, name })))
      .toEqual([{ integration_id: integrationA, external_department_id: 'shared', name: 'Department shared' },
        { integration_id: integrationB, external_department_id: 'shared', name: 'Other integration department' }]
        .sort((a, b) => a.integration_id.localeCompare(b.integration_id)))
    expect(departmentScopes[0].id).not.toBe(departmentScopes[1].id)
    expect((await pool.query(`SELECT integration_id::text,corp_id,external_user_id FROM directory_accounts
      WHERE integration_id=ANY($1::uuid[]) AND external_user_id='shared' ORDER BY corp_id`, [[integrationA, integrationB]])).rows)
      .toEqual([{ integration_id: integrationA, corp_id: corpA, external_user_id: 'shared' },
        { integration_id: integrationB, corp_id: corpB, external_user_id: 'shared' }])
  })
})
