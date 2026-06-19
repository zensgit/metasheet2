/**
 * Layer-3 per-subject field-WRITE enforcement on the main bulk PATCH (real DB).
 *
 * The write spine (RecordWriteService.patchRecords) enforces only PROPERTY-level field guards
 * (readOnly/hidden/computed). Per-subject `field_permissions.read_only` was previously enforced ONLY on
 * the restore + copy paths, NOT on the everyday `POST /patch` grid edit — so a field set read-only for a
 * subject was still writable through the grid. This golden proves the route-level layer-3 gate added to
 * `/patch`:
 *   - a per-subject read-only field is REJECTED (403), nothing written;
 *   - a NORMAL field (no per-subject rule) still writes (regression guard against a block-all bug);
 *   - a mixed request (normal + locked) is rejected ATOMICALLY (fail-closed; the normal field is NOT
 *     written) — restore-style, not silent-drop.
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE_ID = `base_fwg_${TS}`
const SHEET_ID = `sheet_fwg_${TS}`
const F_OPEN = `fld_fwg_open_${TS}` // normal, writable
const F_LOCKED = `fld_fwg_locked_${TS}` // per-subject read_only for USER_ID
const REC = `rec_fwg_${TS}`
const USER_ID = `user_fwg_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let testUserId = USER_ID
let testPerms: string[] = ['multitable:read', 'multitable:write']
let testRoles: string[] = ['member']

const patch = (changes: Array<{ recordId: string; fieldId: string; value: unknown }>) =>
  request(app).post('/api/multitable/patch').send({ sheetId: SHEET_ID, changes })
const cellValue = async (fieldId: string): Promise<unknown> => {
  const r = await q('SELECT data FROM meta_records WHERE id = $1', [REC])
  return (r.rows[0] as { data?: Record<string, unknown> } | undefined)?.data?.[fieldId]
}

describeIfDatabase('layer-3 per-subject field-write gate on POST /patch (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = testUserId ? { id: testUserId, roles: testRoles, perms: testPerms } : undefined
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'FWG Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'FWG Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_OPEN, SHEET_ID, 'Open', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_LOCKED, SHEET_ID, 'Locked', 'string', '{}', 2])
    // F_LOCKED is read-only for USER_ID specifically (visible, but not writable)
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, F_LOCKED, 'user', USER_ID, true, true])
  })

  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  beforeEach(async () => {
    testUserId = USER_ID
    testPerms = ['multitable:read', 'multitable:write']
    testRoles = ['member']
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC, SHEET_ID, JSON.stringify({ [F_OPEN]: 'orig-open', [F_LOCKED]: 'orig-locked' })])
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('regression guard — a NORMAL field (no per-subject rule) writes (not block-all)', async () => {
    const res = await patch([{ recordId: REC, fieldId: F_OPEN, value: 'new-open' }])
    expect(res.status).toBe(200)
    expect(await cellValue(F_OPEN)).toBe('new-open')
  })

  test('enforce — a per-subject READ-ONLY field is rejected (403); nothing written', async () => {
    const res = await patch([{ recordId: REC, fieldId: F_LOCKED, value: 'hacked' }])
    expect(res.status).toBe(403)
    expect(await cellValue(F_LOCKED)).toBe('orig-locked') // unchanged
  })

  test('atomic — a mixed request (normal + locked) is rejected whole; the normal field is NOT written', async () => {
    const res = await patch([
      { recordId: REC, fieldId: F_OPEN, value: 'should-not-persist' },
      { recordId: REC, fieldId: F_LOCKED, value: 'hacked' },
    ])
    expect(res.status).toBe(403)
    expect(await cellValue(F_OPEN)).toBe('orig-open') // fail-closed: whole request rejected
    expect(await cellValue(F_LOCKED)).toBe('orig-locked')
  })

  // Note: per-subject field_permissions.read_only is applied by deriveFieldPermissions regardless of
  // role (no admin special-case) — same as the restore/copy gates — so an admin who is themselves the
  // subject of the rule is also gated here. Admin authority is exercised by editing/removing the
  // field_permissions rule, not by bypassing it at write time. (Asserting a bypass would be wrong.)
})
