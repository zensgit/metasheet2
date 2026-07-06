/**
 * W1-2 permission matrix — B2 / G-4: OAPI read-mask PARITY, per-route differential (real DB).
 * Spec: docs/development/multitable-w1-2-permission-matrix-spec-20260705.md §3 G-4.
 *
 * G-4 in one line: an `mst_` API-token read must produce output EQUIVALENT to the SAME creator's
 * interactive-channel (session) masked output — never more — across all 5 `records:read` OAPI-1 routes
 * (oapi-read-allowlist.ts docstring: "records:read — GET /records (list), /records/:id (single), /view,
 * /sheets/:sheetId/view-aggregate, /records-summary... apply the creator's row-deny + field-permission
 * stack per-request (Option A)"). `multitable-oapi1-token-read-realdb.test.ts` already proves auth
 * mechanics (guards mounted, scope enforcement) and a PARTIAL semantic property (a row-deny doesn't leak
 * through the token on 2 of the 5 routes, via conditional_read_rules) — but no existing golden performs
 * a direct per-route DIFFERENTIAL: the same two requests (token vs interactive) for the SAME creator, on
 * the SAME data, with BOTH a field_permissions mask (M1) and a row-level read-deny (M2) live, asserting
 * the two channel outputs are the SAME masked shape. That differential is what this file adds, once per
 * route (not re-deriving the auth-mechanics matrix already covered).
 *
 * Fixture: one creator (real `users` row, `multitable:read` only — non-admin) with:
 *   - a `field_permissions` deny on FLD_SECRET (M1) — must be masked identically via both channels;
 *   - a `record_permissions` 'none' scope + `row_level_read_permissions_enabled` flag ON on REC_DENIED
 *     (M2) — must be absent identically via both channels (except the single-GET route, whose LOCKED
 *     contract is 403 + no `data`, unchanged by this file — see
 *     multitable-permmatrix-b2-g5-collection-noleak-realdb.test.ts's header for that contract).
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { db } from '../../src/db/db'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ApiTokenService } from '../../src/multitable/api-token-service'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE_ID = `base_b2g4_${TS}`
const SHEET_ID = `sheet_b2g4_${TS}`
const FLD_STATUS = `fld_b2g4_status_${TS}` // readable — the non-vacuous positive control
const FLD_SECRET = `fld_b2g4_secret_${TS}` // field_permissions-denied for CREATOR (M1)
const REC_OPEN = `rec_b2g4_open_${TS}`
const REC_DENIED = `rec_b2g4_denied_${TS}` // record_permissions 'none' for CREATOR (M2)
const CREATOR = `user_b2g4_${TS}`
const SECRET_OPEN = 'topsecret_open_value'
const SECRET_DENIED = 'topsecret_denied_value'

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

let tokenApp: Express // NO fake middleware — apiTokenAuth must resolve the actor from the Bearer token
let interactiveApp: Express // fake middleware injecting the SAME creator as an interactive session
let token = ''

const viaToken = (path: string) => request(tokenApp).get(path).set('Authorization', `Bearer ${token}`)
const viaInteractive = (path: string) => request(interactiveApp).get(path)

// Sort-stable projection helpers so array-order differences between the two channels never cause a
// false mismatch (both SHOULD be identically ordered — deterministic queries — but this keeps the
// comparison honest about WHAT it's proving: mask parity, not incidental ordering).
const byId = <T extends { id: string }>(arr: T[]) => [...arr].sort((a, b) => a.id.localeCompare(b.id))

describeIfDatabase('W1-2 B2 G-4 — OAPI read-mask parity: token output ≡ creator interactive output (real DB)', () => {
  beforeAll(async () => {
    tokenApp = express()
    tokenApp.use(express.json())
    tokenApp.use('/api/multitable', univerMetaRouter())

    interactiveApp = express()
    interactiveApp.use(express.json())
    interactiveApp.use((req, _res, next) => {
      ;(req as any).user = { id: CREATOR, roles: [], perms: ['multitable:read'], permissions: ['multitable:read'] }
      next()
    })
    interactiveApp.use('/api/multitable', univerMetaRouter())

    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1,$2,$3,'x','member',$4::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
      [CREATOR, `${CREATOR}@t.local`, 'B2 G4 Creator', JSON.stringify(['multitable:read'])],
    )
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'B2 G4 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name, row_level_read_permissions_enabled) VALUES ($1,$2,$3,TRUE)', [SHEET_ID, BASE_ID, 'B2 G4 Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_STATUS, SHEET_ID, 'Status', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SECRET, SHEET_ID, 'Secret', 'string', '{}', 2])

    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
      REC_OPEN, SHEET_ID, JSON.stringify({ [FLD_STATUS]: 'open', [FLD_SECRET]: SECRET_OPEN }),
    ])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
      REC_DENIED, SHEET_ID, JSON.stringify({ [FLD_STATUS]: 'secret_row', [FLD_SECRET]: SECRET_DENIED }),
    ])

    // M1: field_permissions denies FLD_SECRET for CREATOR.
    await q(
      `INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,'user',$3,false,false)`,
      [SHEET_ID, FLD_SECRET, CREATOR],
    )
    // M2: record_permissions 'none' scope for CREATOR on REC_DENIED (flag already ON on the sheet row above).
    await q('INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1,$2,$3,$4,$5)', [SHEET_ID, REC_DENIED, 'user', CREATOR, 'none'])

    const svc = new ApiTokenService(db)
    token = (await svc.createToken(CREATOR, { name: 'b2-g4-read', scopes: ['records:read'] })).plainTextToken
  })

  afterAll(async () => {
    await db.deleteFrom('multitable_api_tokens').where('created_by', '=', CREATOR).execute().catch(() => {})
    await q('DELETE FROM record_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [CREATOR]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── Route 1/5: GET /records (list) ──────────────────────────────────────────────────────────────
  test('route 1/5 — GET /records: token output ≡ interactive output (M1 field mask + M2 row-deny parity)', async () => {
    const t = await viaToken('/api/multitable/records').query({ sheetId: SHEET_ID, limit: 100 })
    const i = await viaInteractive('/api/multitable/records').query({ sheetId: SHEET_ID, limit: 100 })
    expect(t.status).toBe(200)
    expect(i.status).toBe(200)

    const tRecords = byId((t.body?.data?.records ?? []) as Array<{ id: string; data: Record<string, unknown> }>)
    const iRecords = byId((i.body?.data?.records ?? []) as Array<{ id: string; data: Record<string, unknown> }>)
    const tPairs = tRecords.map((r) => ({ id: r.id, data: r.data }))
    const iPairs = iRecords.map((r) => ({ id: r.id, data: r.data }))
    expect(tPairs).toEqual(iPairs) // byte-for-byte parity of the masked projection

    // non-vacuous: both contain the visible record, with the readable field intact
    expect(tPairs.some((r) => r.id === REC_OPEN && r.data[FLD_STATUS] === 'open')).toBe(true)
    // leak-free (M1): neither channel exposes the denied field's value anywhere
    expect(JSON.stringify(t.body)).not.toContain(SECRET_OPEN)
    expect(JSON.stringify(i.body)).not.toContain(SECRET_OPEN)
    // zero presence (M2): the row-denied record is absent from BOTH channels
    expect(tPairs.some((r) => r.id === REC_DENIED)).toBe(false)
    expect(iPairs.some((r) => r.id === REC_DENIED)).toBe(false)
  })

  // ── Route 2/5: GET /records/:recordId (single) ──────────────────────────────────────────────────
  test('route 2/5 — GET /records/:id: token ≡ interactive for the readable record (M1), and the SAME 403+no-data shape for the denied one (M2)', async () => {
    const tOpen = await viaToken(`/api/multitable/records/${REC_OPEN}`).query({ sheetId: SHEET_ID })
    const iOpen = await viaInteractive(`/api/multitable/records/${REC_OPEN}`).query({ sheetId: SHEET_ID })
    expect(tOpen.status).toBe(200)
    expect(iOpen.status).toBe(200)
    expect(tOpen.body?.data?.record?.data).toEqual(iOpen.body?.data?.record?.data)
    expect(tOpen.body?.data?.record?.data?.[FLD_STATUS]).toBe('open') // non-vacuous
    expect(tOpen.body?.data?.record?.data?.[FLD_SECRET]).toBeUndefined() // M1 masked
    expect(iOpen.body?.data?.record?.data?.[FLD_SECRET]).toBeUndefined()

    // The single-GET LOCKED contract (403 + no `data`) is unchanged — proven identical on BOTH channels.
    const tDenied = await viaToken(`/api/multitable/records/${REC_DENIED}`).query({ sheetId: SHEET_ID })
    const iDenied = await viaInteractive(`/api/multitable/records/${REC_DENIED}`).query({ sheetId: SHEET_ID })
    expect(tDenied.status).toBe(403)
    expect(iDenied.status).toBe(403)
    expect(JSON.stringify(tDenied.body)).not.toContain('"data"')
    expect(JSON.stringify(iDenied.body)).not.toContain('"data"')
  })

  // ── Route 3/5: GET /view ─────────────────────────────────────────────────────────────────────────
  test('route 3/5 — GET /view: token output ≡ interactive output (M1 field mask + M2 row-deny parity)', async () => {
    const t = await viaToken('/api/multitable/view').query({ sheetId: SHEET_ID })
    const i = await viaInteractive('/api/multitable/view').query({ sheetId: SHEET_ID })
    expect(t.status).toBe(200)
    expect(i.status).toBe(200)

    const tRows = byId((t.body?.data?.rows ?? []) as Array<{ id: string; data: Record<string, unknown> }>)
    const iRows = byId((i.body?.data?.rows ?? []) as Array<{ id: string; data: Record<string, unknown> }>)
    const tPairs = tRows.map((r) => ({ id: r.id, data: r.data }))
    const iPairs = iRows.map((r) => ({ id: r.id, data: r.data }))
    expect(tPairs).toEqual(iPairs)

    expect(tPairs.some((r) => r.id === REC_OPEN && r.data[FLD_STATUS] === 'open')).toBe(true) // non-vacuous
    expect(JSON.stringify(t.body)).not.toContain(SECRET_OPEN) // M1 leak-free
    expect(JSON.stringify(i.body)).not.toContain(SECRET_OPEN)
    expect(tPairs.some((r) => r.id === REC_DENIED)).toBe(false) // M2 zero presence
    expect(iPairs.some((r) => r.id === REC_DENIED)).toBe(false)
  })

  // ── Route 4/5: GET /sheets/:sheetId/view-aggregate ──────────────────────────────────────────────
  test('route 4/5 — GET /view-aggregate: token total ≡ interactive total (M2 row-deny excluded identically from both)', async () => {
    const t = await viaToken(`/api/multitable/sheets/${SHEET_ID}/view-aggregate`).query({ sheetId: SHEET_ID })
    const i = await viaInteractive(`/api/multitable/sheets/${SHEET_ID}/view-aggregate`).query({ sheetId: SHEET_ID })
    expect(t.status).toBe(200)
    expect(i.status).toBe(200)
    expect(t.body?.data?.total).toBe(i.body?.data?.total)
    expect(t.body?.data?.total).toBe(1) // REC_DENIED excluded from both — not 2
  })

  // ── Route 5/5: GET /records-summary ─────────────────────────────────────────────────────────────
  test('route 5/5 — GET /records-summary: token output ≡ interactive output (M1 display value + M2 row-deny parity)', async () => {
    const t = await viaToken('/api/multitable/records-summary').query({ sheetId: SHEET_ID, displayFieldId: FLD_STATUS, limit: 100 })
    const i = await viaInteractive('/api/multitable/records-summary').query({ sheetId: SHEET_ID, displayFieldId: FLD_STATUS, limit: 100 })
    expect(t.status).toBe(200)
    expect(i.status).toBe(200)

    const tRecords = byId((t.body?.data?.records ?? []) as Array<{ id: string; display: unknown }>)
    const iRecords = byId((i.body?.data?.records ?? []) as Array<{ id: string; display: unknown }>)
    expect(tRecords).toEqual(iRecords)

    expect(tRecords.some((r) => r.id === REC_OPEN && r.display === 'open')).toBe(true) // non-vacuous
    expect(tRecords.some((r) => r.id === REC_DENIED)).toBe(false) // M2 zero presence
    expect(iRecords.some((r) => r.id === REC_DENIED)).toBe(false)
  })
})
