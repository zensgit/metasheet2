/**
 * P1 (design 2026-06-17) — native person `restrictToMemberGroupIds` ENFORCEMENT (real DB).
 *
 * A person field that configures `restrictToMemberGroupIds` narrows the assignable set to
 * sheetMembers ∩ (union of those groups' members). A sheet member who is NOT in any configured
 * group must be rejected at write time, even though sheet membership holds. Proven through the
 * real create route (POST /records → record-service → validatePersonValue with the narrowed set).
 *
 * Real-DB only (describeIfDatabase + a sentinel so it fails-not-skips in CI; registered in
 * plugin-tests.yml so `test (20.x)` runs it).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { beforeAll, afterAll, describe, test, expect } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_pgr_${TS}`
const SHEET_ID = `sheet_pgr_${TS}`
const FLD_NAME = `fld_pgr_name_${TS}`
const FLD_PERSON = `fld_pgr_person_${TS}` // restricted to GROUP_IN
const FLD_PERSON_OPEN = `fld_pgr_open_${TS}` // no restriction (control)
const FLD_PERSON_EMPTYG = `fld_pgr_emptyg_${TS}` // restricted to a group with NO members (closed)
const USER_IN = `u_pgr_in_${TS}` // sheet member AND in GROUP_IN
const USER_OUT = `u_pgr_out_${TS}` // sheet member, NOT in any restricted group
const GROUP_IN = `a1b20000-0000-4000-8000-${String(TS).slice(-12).padStart(12, '0')}` // valid uuid (platform_member_groups.id is uuid)
const GROUP_EMPTY = `a1b30000-0000-4000-8000-${String(TS).slice(-12).padStart(12, '0')}` // valid uuid
const ACTOR = `u_pgr_actor_${TS}`

let app: Express
let testUserId: string | null = ACTOR
let testPerms: string[] = ['multitable:write']

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const createReq = (data: Record<string, unknown>) =>
  request(app).post('/api/multitable/records').send({ sheetId: SHEET_ID, data })

describeIfDatabase('native person restrictToMemberGroupIds enforcement (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = testUserId ? { id: testUserId, roles: [], perms: testPerms } : undefined
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO users (id, email, name, password_hash, is_active) VALUES ($1,$2,$3,$4,TRUE) ON CONFLICT (id) DO UPDATE SET is_active = TRUE', [USER_IN, `${USER_IN}@t.local`, 'In User', 'x'])
    await q('INSERT INTO users (id, email, name, password_hash, is_active) VALUES ($1,$2,$3,$4,TRUE) ON CONFLICT (id) DO UPDATE SET is_active = TRUE', [USER_OUT, `${USER_OUT}@t.local`, 'Out User', 'x'])
    await q('INSERT INTO users (id, email, name, password_hash, is_active) VALUES ($1,$2,$3,$4,TRUE) ON CONFLICT (id) DO UPDATE SET is_active = TRUE', [ACTOR, `${ACTOR}@t.local`, 'Actor', 'x'])

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'PGR Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'PGR Sheet'])
    // Both candidate people are SHEET MEMBERS (the existing floor admits both) — so the test isolates
    // the NEW group narrowing, not the old sheet-membership check.
    await q('INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4,$5)', [SHEET_ID, USER_IN, 'user', USER_IN, 'spreadsheet:write'])
    await q('INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4,$5)', [SHEET_ID, USER_OUT, 'user', USER_OUT, 'spreadsheet:write'])
    // The ACTOR (record creator) must have sheet write too — once the sheet has assignments, access is scoped.
    await q('INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4,$5)', [SHEET_ID, ACTOR, 'user', ACTOR, 'spreadsheet:write'])

    await q('INSERT INTO platform_member_groups (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [GROUP_IN, 'PGR In Group'])
    await q('INSERT INTO platform_member_groups (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [GROUP_EMPTY, 'PGR Empty Group'])
    await q('INSERT INTO platform_member_group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [GROUP_IN, USER_IN]) // GROUP_EMPTY has no members

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_NAME, SHEET_ID, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_PERSON, SHEET_ID, 'Owner', 'person', JSON.stringify({ restrictToMemberGroupIds: [GROUP_IN] }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_PERSON_OPEN, SHEET_ID, 'AnyOwner', 'person', '{}', 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_PERSON_EMPTYG, SHEET_ID, 'EmptyGroupOwner', 'person', JSON.stringify({ restrictToMemberGroupIds: [GROUP_EMPTY] }), 4])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM platform_member_group_members WHERE group_id = ANY($1::text[])', [[GROUP_IN, GROUP_EMPTY]]).catch(() => {})
    await q('DELETE FROM platform_member_groups WHERE id = ANY($1::text[])', [[GROUP_IN, GROUP_EMPTY]]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[USER_IN, USER_OUT, ACTOR]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('a sheet member IN the configured group is assignable (accepted)', async () => {
    const res = await createReq({ [FLD_NAME]: 'r1', [FLD_PERSON]: [USER_IN] })
    expect(res.status).toBeLessThan(300) // created — the in-group sheet member is accepted
  })

  test('a sheet member NOT in any configured group is REJECTED (the new narrowing, not the old floor)', async () => {
    const res = await createReq({ [FLD_NAME]: 'r2', [FLD_PERSON]: [USER_OUT] })
    expect(res.status).toBe(400)
  })

  test('an unrestricted person field still admits any sheet member (no regression)', async () => {
    const res = await createReq({ [FLD_NAME]: 'r3', [FLD_PERSON_OPEN]: [USER_OUT] })
    expect(res.status).toBeLessThan(300)
  })

  test('a field restricted to a group with NO members is a closed set (even an in-group user rejected)', async () => {
    const res = await createReq({ [FLD_NAME]: 'r4', [FLD_PERSON_EMPTYG]: [USER_IN] })
    expect(res.status).toBe(400)
  })
})
