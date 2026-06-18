import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import {
  capturePriorDeptManagers,
  enrichDepartmentsWithManagers,
  mergeDeptManagerIntoRaw,
  resolveManagerListForDept,
} from '../../src/directory/department-manager-enrichment'
import type { DingTalkDepartment } from '../../src/integrations/dingtalk/client'

/**
 * dept-head sync-plumbing — real-DB proof that the last-known-good carry-forward
 * survives the whole-column upsert (`raw = EXCLUDED.raw`). Drives the actual seam
 * (`enrichDepartmentsWithManagers` with a throwing `getDetail`) + capture-prior +
 * compose + upsert, end to end.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

async function upsertDept(integrationId: string, externalId: string, name: string, raw: Record<string, unknown>): Promise<void> {
  await query(
    `INSERT INTO directory_departments (integration_id, external_department_id, name, is_active, raw, last_seen_at, created_at, updated_at)
     VALUES ($1, $2, $3, true, $4::jsonb, NOW(), NOW(), NOW())
     ON CONFLICT (integration_id, external_department_id)
     DO UPDATE SET name = EXCLUDED.name, raw = EXCLUDED.raw, updated_at = NOW()`,
    [integrationId, externalId, name, JSON.stringify(raw)],
  )
}
async function readRaw(integrationId: string, externalId: string): Promise<Record<string, unknown>> {
  const r = await query<{ raw: Record<string, unknown> }>(
    `SELECT raw FROM directory_departments WHERE integration_id = $1 AND external_department_id = $2`,
    [integrationId, externalId],
  )
  return r.rows[0].raw
}

describeIfDatabase('dept-head sync-plumbing (real DB)', () => {
  let integrationId = ''

  beforeAll(async () => {
    const r = await query<{ id: string }>(
      `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`,
      [`dhsync-${TS}`, `dhsync-corp-${TS}`],
    )
    integrationId = r.rows[0].id
    // D1: a department that already has a previously-synced manager list.
    await upsertDept(integrationId, 'D1', 'Eng', { name: 'Eng', dept_manager_userid_list: ['mgr-x'] })
    // D2: a department with no prior manager data.
    await upsertDept(integrationId, 'D2', 'Sales', { name: 'Sales' })
  })
  afterAll(async () => {
    if (integrationId) {
      await query(`DELETE FROM directory_departments WHERE integration_id = $1`, [integrationId])
      await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
    }
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('a department/get FAILURE on re-sync preserves the prior dept_manager_userid_list (carried forward, not wiped)', async () => {
    // capture prior BEFORE the re-sync upsert overwrites the whole raw column
    const prior = await capturePriorDeptManagers(integrationId, query)
    expect(prior.get('D1')).toEqual(['mgr-x'])

    // the seam: department/get throws → managerUserIds stays undefined (NOT [])
    const d1: DingTalkDepartment = { id: 'D1', parentId: null, name: 'Eng v2', order: 0, source: { name: 'Eng v2' } }
    await enrichDepartmentsWithManagers([d1], async () => { throw new Error('429 rate limited') })
    expect(d1.managerUserIds).toBeUndefined()

    // compose (carry forward) + whole-column upsert
    await upsertDept(integrationId, 'D1', 'Eng v2', mergeDeptManagerIntoRaw(d1.source, resolveManagerListForDept(d1.managerUserIds, prior.get('D1'))))

    const raw = await readRaw(integrationId, 'D1')
    expect(raw.dept_manager_userid_list).toEqual(['mgr-x']) // PRESERVED — the bug would have wiped this
    expect(raw.name).toBe('Eng v2') // listsub field still refreshed
  })

  it('a department/get SUCCESS writes the fresh manager list into raw (data lands)', async () => {
    const prior = await capturePriorDeptManagers(integrationId, query)
    const d2: DingTalkDepartment = { id: 'D2', parentId: null, name: 'Sales', order: 0, source: { name: 'Sales' } }
    await enrichDepartmentsWithManagers([d2], async () => ({ deptManagerUserIdList: ['mgr-y'] }))
    expect(d2.managerUserIds).toEqual(['mgr-y'])

    await upsertDept(integrationId, 'D2', 'Sales', mergeDeptManagerIntoRaw(d2.source, resolveManagerListForDept(d2.managerUserIds, prior.get('D2'))))

    const raw = await readRaw(integrationId, 'D2')
    expect(raw.dept_manager_userid_list).toEqual(['mgr-y']) // fresh data landed
  })
})
