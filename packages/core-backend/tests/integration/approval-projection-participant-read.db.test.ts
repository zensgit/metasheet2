/**
 * T36-1 — approval projection per-row participant read (design-lock RATIFIED Plan A, 2026-07-07).
 *
 * The #3537 fence made the projection base admin-only at three chokes. Plan A opens the READ plane
 * per-row to PARTICIPANTS (a row carries their id as requesterId or approverId) while keeping:
 * the full fence for non-participants (no drift), the write/manage denial for every non-admin, and
 * fail-closed handling of rows with missing/corrupt participant fields. Row narrowing rides the
 * W1-2-locked deny choke (loadRowLevelReadDenyEnabled + loadDeniedRecordIds), so every consumer
 * surface (records:read routes, export, history) inherits it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Request } from 'express'
import { pool } from '../../src/db/pg'
import {
  resolveSheetCapabilities,
  filterReadableSheetRowsForAccess,
  loadRowLevelReadDenyEnabled,
  loadDeniedRecordIds,
  loadRecordPermissionScopeMap,
  loadApprovalProjectionParticipantSheetIds,
} from '../../src/multitable/permission-service'
import { resolveSheetCapabilitiesForUser } from '../../src/multitable/sheet-capabilities'
import { resolveRequestAccess } from '../../src/multitable/access'
import { APPROVAL_PROJECTION_BASE_ID } from '../../src/multitable/approval-projection-constants'

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => pool.query(sql, params)

const TS = Date.now()
const PROJ_SHEET = `sheet_apr_proj_t361_${TS}`
const REC_MINE_REQ = `rec_t361_mine_req_${TS}` // requester = participant actor
const REC_MINE_DEC = `rec_t361_mine_dec_${TS}` // terminal decider = participant actor
const REC_OTHER = `rec_t361_other_${TS}` // someone else's row
const REC_CORRUPT = `rec_t361_corrupt_${TS}` // no participant fields at all (fail-closed)

const PARTICIPANT = `u_t361_part_${TS}`
const STRANGER = `u_t361_stranger_${TS}`

const participantReq = { user: { id: PARTICIPANT, perms: ['multitable:read'] } } as unknown as Request
const strangerReq = { user: { id: STRANGER, perms: ['multitable:read'] } } as unknown as Request
const adminReq = { user: { id: `u_t361_admin_${TS}`, roles: ['admin'] } } as unknown as Request
// A participant who ALSO holds write perms — write/manage must still be denied (system read-model).
const writerParticipantReq = { user: { id: PARTICIPANT, perms: ['multitable:write', 'workflow:write'] } } as unknown as Request

describeIfDb('T36-1 — projection per-row participant read (Plan A)', () => {
  beforeAll(async () => {
    await q(`INSERT INTO meta_bases (id, name, icon, color, owner_id, workspace_id)
             VALUES ($1,'Approval Projection','','', 'system:approval-projection', NULL) ON CONFLICT (id) DO NOTHING`,
      [APPROVAL_PROJECTION_BASE_ID])
    await q(`INSERT INTO meta_sheets (id, base_id, name, description) VALUES ($1,$2,'ProjT361','') ON CONFLICT (id) DO NOTHING`,
      [PROJ_SHEET, APPROVAL_PROJECTION_BASE_ID])
    const insert = (id: string, data: Record<string, unknown>) =>
      q(`INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by)
         VALUES ($1,$2,$3::jsonb,1,'system:approval-projection','system:approval-projection') ON CONFLICT (id) DO NOTHING`,
        [id, PROJ_SHEET, JSON.stringify(data)])
    await insert(REC_MINE_REQ, { status: 'approved', requesterId: PARTICIPANT, approverId: 'someone_else' })
    await insert(REC_MINE_DEC, { status: 'rejected', requesterId: 'someone_else', approverId: PARTICIPANT })
    await insert(REC_OTHER, { status: 'approved', requesterId: 'someone_else', approverId: 'another_one' })
    await insert(REC_CORRUPT, { status: 'approved' })
    // The Yjs/OAPI choke (resolveSheetCapabilitiesForUser) loads permissions from rbac, not from a
    // req mock — seed REAL users + multitable:read grants for both actors (file-namespaced ids).
    for (const uid of [PARTICIPANT, STRANGER]) {
      await q(`INSERT INTO users (id, name, password_hash, role) VALUES ($1,$1,'x','user') ON CONFLICT (id) DO NOTHING`, [uid])
      await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'multitable:read') ON CONFLICT DO NOTHING`, [uid])
    }
  })

  afterAll(async () => {
    await q(`DELETE FROM meta_records WHERE sheet_id = $1`, [PROJ_SHEET]).catch(() => {})
    await q(`DELETE FROM meta_sheets WHERE id = $1`, [PROJ_SHEET]).catch(() => {})
    await q(`DELETE FROM user_permissions WHERE user_id = ANY($1::text[])`, [[PARTICIPANT, STRANGER]]).catch(() => {})
    await q(`DELETE FROM users WHERE id = ANY($1::text[])`, [[PARTICIPANT, STRANGER]]).catch(() => {})
  })

  it('sentinel: DATABASE_URL is set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  it('participant helper: participant detected, stranger not, fail-closed on empty user', async () => {
    expect((await loadApprovalProjectionParticipantSheetIds(q, [PROJ_SHEET], PARTICIPANT)).has(PROJ_SHEET)).toBe(true)
    expect((await loadApprovalProjectionParticipantSheetIds(q, [PROJ_SHEET], STRANGER)).has(PROJ_SHEET)).toBe(false)
    expect((await loadApprovalProjectionParticipantSheetIds(q, [PROJ_SHEET], '')).size).toBe(0)
  })

  it('capabilities: participant gets READ (+export) only; stranger keeps the full #3537 fence', async () => {
    const part = await resolveSheetCapabilities(participantReq, q, PROJ_SHEET)
    expect(part.capabilities.canRead).toBe(true)
    expect(part.capabilities.canExport).toBe(true)
    const stranger = await resolveSheetCapabilities(strangerReq, q, PROJ_SHEET)
    expect(stranger.capabilities.canRead).toBe(false) // RED-before: flipping the predicate off must restore this
    expect(stranger.capabilities.canExport).toBe(false)
  })

  it('capabilities: a PARTICIPANT with write perms still has zero write/manage plane (#3537 not weakened)', async () => {
    const cap = await resolveSheetCapabilities(writerParticipantReq, q, PROJ_SHEET)
    for (const key of ['canCreateRecord', 'canEditRecord', 'canDeleteRecord', 'canManageFields', 'canManageSheetAccess', 'canManageViews', 'canManageAutomation', 'canSendNotification'] as const) {
      expect(cap.capabilities[key]).toBe(false)
    }
    expect(cap.capabilities.canRead).toBe(true)
  })

  it('row-deny choke: projection sheet is ALWAYS row-level gated; denied set = every non-participant row', async () => {
    expect(await loadRowLevelReadDenyEnabled(q, PROJ_SHEET)).toBe(true)
    const denied = await loadDeniedRecordIds(q, PROJ_SHEET, PARTICIPANT)
    expect(denied.has(REC_MINE_REQ)).toBe(false) // my request — readable
    expect(denied.has(REC_MINE_DEC)).toBe(false) // my terminal decision — readable
    expect(denied.has(REC_OTHER)).toBe(true) // someone else's — denied
    expect(denied.has(REC_CORRUPT)).toBe(true) // missing participant fields — fail-closed denied
  })

  it('scope map: non-participant rows carry a synthetic none (DENY-WINS) for the derive read paths', async () => {
    const scopes = await loadRecordPermissionScopeMap(q, PROJ_SHEET, [REC_MINE_REQ, REC_OTHER, REC_CORRUPT], PARTICIPANT)
    expect(scopes.get(REC_OTHER)?.accessLevel).toBe('none')
    expect(scopes.get(REC_CORRUPT)?.accessLevel).toBe('none')
    expect(scopes.get(REC_MINE_REQ)?.accessLevel ?? 'unset').not.toBe('none')
  })

  it('listing: participant sees the projection sheet (base surfaces); stranger does not', async () => {
    const rows = [{ id: PROJ_SHEET, base_id: APPROVAL_PROJECTION_BASE_ID }]
    const partVisible = await filterReadableSheetRowsForAccess(q, rows, await resolveRequestAccess(participantReq))
    expect(partVisible.map((r) => r.id)).toEqual([PROJ_SHEET])
    const strangerVisible = await filterReadableSheetRowsForAccess(q, rows, await resolveRequestAccess(strangerReq))
    expect(strangerVisible).toEqual([])
  })

  it('Yjs/OAPI choke (resolveSheetCapabilitiesForUser): read parity with the REST choke', async () => {
    const part = await resolveSheetCapabilitiesForUser(q, PROJ_SHEET, PARTICIPANT)
    expect(part.capabilities.canRead).toBe(true)
    expect(part.capabilities.canEditRecord).toBe(false)
    const stranger = await resolveSheetCapabilitiesForUser(q, PROJ_SHEET, STRANGER)
    expect(stranger.capabilities.canRead).toBe(false)
  })

  it('admin: full read, no row denial (regression of the #3537 admin path)', async () => {
    const cap = await resolveSheetCapabilities(adminReq, q, PROJ_SHEET)
    expect(cap.capabilities.canRead).toBe(true)
    // Admin bypass happens at the choke call sites; the raw denied set is actor-relative by design.
  })
})
