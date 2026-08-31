import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Request } from 'express'
import { pool } from '../../src/db/pg'
import { loadReadableAutomationSampleRecord } from '../../src/routes/automation-test-run-sample'

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip
const query = (sql: string, params?: unknown[]) => pool.query(sql, params)

const suffix = `${process.pid}_${Date.now()}`
const baseId = `base_auto_sample_${suffix}`
const sheetId = `sheet_auto_sample_${suffix}`
const recordId = `rec_auto_sample_${suffix}`
const adminId = `u_auto_sample_admin_${suffix}`
const adminReq = { user: { id: adminId, roles: ['admin'] } } as unknown as Request

describeIfDb('automation test-run sample record read gate', () => {
  beforeAll(async () => {
    await query(
      `INSERT INTO meta_bases (id, name, icon, color, owner_id, workspace_id)
       VALUES ($1, 'Automation Sample', '', '', $2, NULL)`,
      [baseId, adminId],
    )
    await query(
      `INSERT INTO meta_sheets (id, base_id, name, description)
       VALUES ($1, $2, 'Automation Sample', '')`,
      [sheetId, baseId],
    )
    await query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by)
       VALUES ($1, $2, $3::jsonb, 1, $4, $4)`,
      [recordId, sheetId, JSON.stringify({ tier: '金牌', amount: 12 }), adminId],
    )
  })

  afterAll(async () => {
    await query('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]).catch(() => {})
    await query('DELETE FROM meta_sheets WHERE id = $1', [sheetId]).catch(() => {})
    await query('DELETE FROM meta_bases WHERE id = $1', [baseId]).catch(() => {})
  })

  it('returns the exact readable JSONB snapshot and server-derived actor', async () => {
    const result = await loadReadableAutomationSampleRecord(adminReq, query, sheetId, recordId)

    expect(result).toEqual({
      ok: true,
      sampleRecord: {
        recordId,
        data: { tier: '金牌', amount: 12 },
        actorId: adminId,
      },
    })
  })

  it('fails closed when the requested row does not exist', async () => {
    const result = await loadReadableAutomationSampleRecord(adminReq, query, sheetId, `${recordId}_missing`)

    expect(result).toMatchObject({
      ok: false,
      status: 404,
      body: { error: { code: 'NOT_FOUND' } },
    })
  })
})
