/**
 * A — T3-6 approval projection base is admin-only readable.
 *
 * Proves, per read choke, that a non-admin holding global `multitable:read` is DENIED on the projection
 * base's sheet + records + listings, while an admin is allowed and an ORDINARY base is unaffected. The three
 * chokes cover every content-read path: `resolveSheetCapabilities` (single sheet + record read via
 * `resolveSheetReadableCapabilities`), `filterReadableSheetRowsForAccess` (base list + sheet lists — a base
 * surfaces only if it has ≥1 readable sheet), and `resolveReadableSheetIds` (a listing path).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Request } from 'express'
import { pool } from '../../src/db/pg'
import {
  resolveSheetCapabilities,
  filterReadableSheetRowsForAccess,
  resolveReadableSheetIds,
  loadApprovalProjectionSheetIds,
} from '../../src/multitable/permission-service'
import { resolveRequestAccess } from '../../src/multitable/access'
import { APPROVAL_PROJECTION_BASE_ID } from '../../src/multitable/approval-projection-constants'

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => pool.query(sql, params)

const PROJ_SHEET = `sheet_apr_proj_test_${Date.now()}`
const NORMAL_BASE = `base_normal_test_${Date.now()}`
const NORMAL_SHEET = `sheet_normal_test_${Date.now()}`
const PROJ_RECORD = `rec_proj_${Date.now()}`

// Non-admin actor holding global multitable:read; and an admin actor.
const readerReq = { user: { id: 'A-reader', perms: ['multitable:read'] } } as unknown as Request
const adminReq = { user: { id: 'A-admin', roles: ['admin'] } } as unknown as Request
// A non-admin WRITER (multitable:write + workflow:write) — has write/manage caps that the fence must also deny.
const writerReq = { user: { id: 'A-writer', perms: ['multitable:write', 'workflow:write'] } } as unknown as Request

describeIfDb('A — approval projection base admin-only read guard', () => {
  beforeAll(async () => {
    await q(`INSERT INTO meta_bases (id, name, icon, color, owner_id, workspace_id)
             VALUES ($1,'Approval Projection','','', 'system:approval-projection', NULL) ON CONFLICT (id) DO NOTHING`,
      [APPROVAL_PROJECTION_BASE_ID])
    await q(`INSERT INTO meta_sheets (id, base_id, name, description) VALUES ($1,$2,'Proj','') ON CONFLICT (id) DO NOTHING`,
      [PROJ_SHEET, APPROVAL_PROJECTION_BASE_ID])
    await q(`INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by)
             VALUES ($1,$2,'{"status":"approved"}'::jsonb,1,'system:approval-projection','system:approval-projection') ON CONFLICT (id) DO NOTHING`,
      [PROJ_RECORD, PROJ_SHEET])
    await q(`INSERT INTO meta_bases (id, name, icon, color, owner_id, workspace_id) VALUES ($1,'Normal','','', 'A-reader', NULL) ON CONFLICT (id) DO NOTHING`,
      [NORMAL_BASE])
    await q(`INSERT INTO meta_sheets (id, base_id, name, description) VALUES ($1,$2,'Normal','') ON CONFLICT (id) DO NOTHING`,
      [NORMAL_SHEET, NORMAL_BASE])
  })

  afterAll(async () => {
    await q(`DELETE FROM meta_records WHERE id = $1`, [PROJ_RECORD]).catch(() => {})
    await q(`DELETE FROM meta_sheets WHERE id = ANY($1::text[])`, [[PROJ_SHEET, NORMAL_SHEET]]).catch(() => {})
    await q(`DELETE FROM meta_bases WHERE id = $1`, [NORMAL_BASE]).catch(() => {})
    // leave the shared projection base row (idempotent ON CONFLICT); remove only if this test created it fresh
  })

  it('sentinel: DATABASE_URL is set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  it('helper: identifies projection sheets, not ordinary ones', async () => {
    const set = await loadApprovalProjectionSheetIds(q, [PROJ_SHEET, NORMAL_SHEET])
    expect(set.has(PROJ_SHEET)).toBe(true)
    expect(set.has(NORMAL_SHEET)).toBe(false)
  })

  it('single sheet/record read: a non-admin (multitable:read) is DENIED on the projection sheet', async () => {
    const proj = await resolveSheetCapabilities(readerReq, q, PROJ_SHEET)
    expect(proj.capabilities.canRead).toBe(false) // RED-before: was true (the leak)
    // control: the SAME non-admin CAN read an ordinary sheet
    const normal = await resolveSheetCapabilities(readerReq, q, NORMAL_SHEET)
    expect(normal.capabilities.canRead).toBe(true)
  })

  it('single sheet/record read: an admin CAN read the projection sheet', async () => {
    const proj = await resolveSheetCapabilities(adminReq, q, PROJ_SHEET)
    expect(proj.capabilities.canRead).toBe(true)
  })

  it('admin-only capability fence: a non-admin WRITER is denied read AND write/manage on the projection sheet', async () => {
    const proj = await resolveSheetCapabilities(writerReq, q, PROJ_SHEET)
    for (const cap of ['canRead', 'canExport', 'canCreateRecord', 'canEditRecord', 'canDeleteRecord', 'canManageFields', 'canManageSheetAccess', 'canManageViews', 'canManageAutomation', 'canSendNotification'] as const) {
      expect(proj.capabilities[cap]).toBe(false)
    }
    // control: the SAME writer keeps write/manage caps on an ordinary sheet
    const normal = await resolveSheetCapabilities(writerReq, q, NORMAL_SHEET)
    expect(normal.capabilities.canEditRecord).toBe(true)
    expect(normal.capabilities.canDeleteRecord).toBe(true)
    expect(normal.capabilities.canManageAutomation).toBe(true)
  })

  it('listing (base list + sheet lists): projection sheet filtered out for a non-admin, kept for admin', async () => {
    const rows = [{ id: PROJ_SHEET, base_id: APPROVAL_PROJECTION_BASE_ID }, { id: NORMAL_SHEET, base_id: NORMAL_BASE }]
    const readerAccess = await resolveRequestAccess(readerReq)
    const readerVisible = await filterReadableSheetRowsForAccess(q, rows, readerAccess)
    expect(readerVisible.map((r) => r.id)).toEqual([NORMAL_SHEET]) // projection base thus absent from base list
    const adminAccess = await resolveRequestAccess(adminReq)
    const adminVisible = await filterReadableSheetRowsForAccess(q, rows, adminAccess)
    expect(adminVisible.map((r) => r.id).sort()).toEqual([NORMAL_SHEET, PROJ_SHEET].sort())
  })

  it('resolveReadableSheetIds: excludes the projection sheet for a non-admin', async () => {
    const ids = await resolveReadableSheetIds(readerReq, q, [PROJ_SHEET, NORMAL_SHEET])
    expect(ids.has(PROJ_SHEET)).toBe(false)
    expect(ids.has(NORMAL_SHEET)).toBe(true)
  })
})
