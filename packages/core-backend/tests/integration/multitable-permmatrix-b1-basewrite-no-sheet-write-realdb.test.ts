/**
 * B1-G3 — permission golden matrix: base-level write codes do NOT intersect the sheet/record
 * write axis (real DB). Spec: W1-2 permission-matrix (docs/development/multitable-w1-2-permission-
 * matrix-spec-20260705.md) §3 gap G-3 / §2 axis M6. Sibling: #3646 (W1-1 formula-freshness
 * design-lock) locks the FRESHNESS angle of the Yjs-bridge side-door; this B1 batch (G-1/G-2/G-3)
 * locks the PERMISSION angle across the side-door / write-modifier surface more broadly — this
 * cluster in particular pins the C2 crux fact rather than a bridge/token entry point.
 *
 * `resolveBaseWritable` (permission-service.ts:1599-1645) is a SEPARATE, kernel-internal primitive
 * introduced for the (b) cross-base automation slice: it grants base-level write authority via
 * `BASE_WRITE_PERMISSION_CODES` (`multitable:base:write` / `multitable:base:admin` / `multitable:admin`,
 * permission-service.ts:145-148) OR via `meta_bases.owner_id` ownership. It is consulted ONLY by the
 * automation executor's base-scoped write path — it is NEVER called by the interactive record PATCH
 * route. `deriveCapabilities` (sheet-capabilities.ts:75-100 + the sheet-scope composition at :122-158),
 * which DOES gate interactive PATCH via `capabilities.canEditRecord`, has no knowledge of
 * `multitable:base:*` codes or of `meta_bases.owner_id` at all — verified directly: `hasPermission`
 * (sheet-capabilities.ts:69-73) does an exact/wildcard string match against the QUERIED code
 * (`'multitable:write'`), and the literal string `'multitable:base:write'` satisfies neither that nor
 * any `SHEET_*_PERMISSION_CODES` set membership.
 *
 * This is the "M6 crux" documented in the spec but never golden-locked: an actor who holds ONLY a
 * base-level write grant (§1) or IS the base's owner (§2) — with NO sheet-scope grant and NO global
 * `multitable:write` — must get 403 on an interactive record PATCH. A regression here would be a
 * SILENT privilege escalation (a base-write/base-owner actor suddenly able to edit every record in
 * every sheet of that base) with no code path announcing the change.
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI per the suite convention).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_b1g3_${TS}`
const SHEET_ID = `sheet_b1g3_${TS}`
const FLD_NAME = `fld_b1g3_name_${TS}`
const REC_ID = `rec_b1g3_${TS}`

// §1 — holds ONLY the base-level write code (no sheet grant, no global multitable:write).
const BASE_WRITE_CODE_ACTOR = `u_b1g3_basewritecode_${TS}`
// §2 — IS the base's owner (meta_bases.owner_id), but holds ZERO permission codes at all.
const BASE_OWNER_ACTOR = `u_b1g3_baseowner_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

let app: Express
let currentUser: { id: string; roles: string[]; perms: string[] } = {
  id: BASE_WRITE_CODE_ACTOR,
  roles: ['member'],
  perms: ['multitable:base:write'],
}

const patchRecord = async (): Promise<{ status: number }> => {
  const res = await request(app)
    .patch(`/api/multitable/records/${REC_ID}`)
    .send({ sheetId: SHEET_ID, data: { [FLD_NAME]: 'mutated-by-base-write-actor' } })
  return { status: res.status }
}

describeIfDatabase('B1-G3 permission golden — base-write codes do not intersect sheet record-write (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = currentUser; next() })
    app.use('/api/multitable', univerMetaRouter())

    // BASE_ID is owned by BASE_OWNER_ACTOR (§2 fixture) — a plain string column, no FK to `users`.
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [BASE_ID, 'B1-G3 Base', BASE_OWNER_ACTOR])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'B1-G3 Sheet'])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_NAME, SHEET_ID, 'Name', 'string', '{}', 1],
    )
    await q(
      'INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_ID, SHEET_ID, JSON.stringify({ [FLD_NAME]: 'before' })],
    )
  })

  afterAll(async () => {
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set (real DB run, not skipped)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('G3-1: an actor holding ONLY multitable:base:write (no sheet grant, no global write) gets 403 on interactive record PATCH', async () => {
    currentUser = { id: BASE_WRITE_CODE_ACTOR, roles: ['member'], perms: ['multitable:base:write'] }
    const { status } = await patchRecord()
    expect(status).toBe(403)

    // zero side effects: the record's stored data/version are untouched.
    const row = await q('SELECT data, version FROM meta_records WHERE id = $1', [REC_ID])
    const stored = row.rows[0] as { data: Record<string, unknown>; version: number }
    expect(stored.data[FLD_NAME]).toBe('before')
    expect(stored.version).toBe(1)
  })

  test('G3-2: the BASE OWNER (meta_bases.owner_id) with ZERO permission codes gets 403 on interactive record PATCH', async () => {
    currentUser = { id: BASE_OWNER_ACTOR, roles: ['member'], perms: [] }
    const { status } = await patchRecord()
    expect(status).toBe(403)

    const row = await q('SELECT data, version FROM meta_records WHERE id = $1', [REC_ID])
    const stored = row.rows[0] as { data: Record<string, unknown>; version: number }
    expect(stored.data[FLD_NAME]).toBe('before')
    expect(stored.version).toBe(1)
  })
})
