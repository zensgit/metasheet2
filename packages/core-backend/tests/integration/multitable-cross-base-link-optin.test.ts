/**
 * ②b slice 1 — cross-base link `foreignBaseId` opt-in + base-read gating (real DB).
 *
 * Opens the §2a.2 wall for an EXPLICIT, CONSISTENT cross-base opt-in: a `link` field may span two
 * bases IFF it carries `foreignBaseId` EQUAL to the foreign sheet's actual `base_id` (claim == truth).
 * No flag, or a mismatched one → still rejected (the wall's current behavior). `foreignBaseId` is
 * IMMUTABLE after create (decision c). Cross-base READ derives from `resolveBaseReadable` (decision a):
 * a reader lacking foreign-base-read gets foreign data SILENTLY MASKED on hydration/summaries
 * (decision d) but a 403 on the explicit `GET /fields/:fieldId/link-options` pull (decision d).
 *
 * Drives the real POST/PATCH /fields + GET /view + GET /fields/:id/link-options wires (wire-vs-fixture
 * rule). Real DB (describeIfDatabase) — the field-permission + base-readability resolvers hit real
 * tables (meta_bases, field_permissions, user_roles, ...).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()

// Actors.
const OWNER = `u_xbo_owner_${TS}` // owns BASE_A AND BASE_B → base-read on both (owner derivation)
const READER_BASE = `u_xbo_rbase_${TS}` // member + multitable:base:read grant → base-read on any base
const READER_NOBASE = `u_xbo_rnobase_${TS}` // member + multitable:read only, owns nothing → NO base-read

// Bases.
const BASE_A = `base_xbo_a_${TS}` // source base
const BASE_B = `base_xbo_b_${TS}` // foreign base
const BASE_NULL_OWNER = `base_xbo_b2_${TS}` // alt foreign base (no special owner) for mismatch tests

// Sheets.
const SHEET_A = `sheet_xbo_a_${TS}` // source sheet (BASE_A)
const SHEET_A2 = `sheet_xbo_a2_${TS}` // same-base foreign target (BASE_A)
const SHEET_B = `sheet_xbo_b_${TS}` // cross-base foreign target (BASE_B)
const SHEET_NULL = `sheet_xbo_null_${TS}` // null base_id (legacy) foreign target
const SHEET_LATE = `sheet_xbo_late_${TS}` // TOCTOU: created late, targeted by a pre-seeded link

// Foreign fields on SHEET_B (the cross-base target).
const FLD_B_OK = `fld_xbo_bok_${TS}` // readable foreign field (value 41)
const FLD_B_DENIED = `fld_xbo_bden_${TS}` // field-permission denied for READER_BASE (value 43)

// Foreign records.
const REC_B = `rec_xbo_b_${TS}`
const REC_A = `rec_xbo_a_${TS}` // source record linking to REC_B

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function buildApp(userId: string, permissions: string[]): Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as { user?: unknown }).user = {
      id: userId,
      roles: ['member'],
      perms: permissions,
      permissions,
    }
    next()
  })
  a.use('/api/multitable', univerMetaRouter())
  return a
}

// Common permission sets.
const WRITE = ['multitable:read', 'multitable:write']
const READ_ONLY = ['multitable:read']
const READ_PLUS_BASE = ['multitable:read', 'multitable:base:read']

const fieldExists = async (fieldId: string): Promise<boolean> => {
  const r = await q('SELECT id FROM meta_fields WHERE id = $1', [fieldId])
  return (r.rows as unknown[]).length > 0
}
const fieldProperty = async (fieldId: string): Promise<Record<string, unknown> | undefined> => {
  const r = await q('SELECT property FROM meta_fields WHERE id = $1', [fieldId])
  const p = (r.rows as Array<{ property: unknown }>)[0]?.property
  if (p == null) return undefined
  return (typeof p === 'string' ? JSON.parse(p) : p) as Record<string, unknown>
}

describeIfDatabase('②b slice 1 — cross-base link foreignBaseId opt-in + base-read gating (real DB)', () => {
  beforeAll(async () => {
    // OWNER owns BASE_A and BASE_B; BASE_NULL_OWNER has no owner.
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3)', [BASE_A, 'XBO Base A', OWNER])
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3)', [BASE_B, 'XBO Base B', OWNER])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_NULL_OWNER, 'XBO Base B2'])

    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_A, BASE_A, 'Source A'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_A2, BASE_A, 'Foreign A2'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_B, BASE_B, 'Foreign B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, NULL, $2)', [SHEET_NULL, 'Foreign Null'])

    // Foreign target fields on SHEET_B.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_B_OK, SHEET_B, 'BOk', 'number', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_B_DENIED, SHEET_B, 'BDenied', 'number', '{}', 2])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_B, SHEET_B, JSON.stringify({ [FLD_B_OK]: 41, [FLD_B_DENIED]: 43 })])

    // READER_BASE is field-DENIED on FLD_B_DENIED (to prove the §2a.3 layering under an open base gate).
    await q(
      'INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
      [SHEET_B, FLD_B_DENIED, 'user', READER_BASE, false, false],
    )
  })

  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = ANY($1::text[])', [[SHEET_A, SHEET_B]]).catch(() => {})
    await q('DELETE FROM meta_links WHERE field_id IN (SELECT id FROM meta_fields WHERE sheet_id = ANY($1::text[]))', [[SHEET_A]]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[SHEET_A, SHEET_A2, SHEET_B, SHEET_NULL, SHEET_LATE]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SHEET_A, SHEET_A2, SHEET_B, SHEET_NULL, SHEET_LATE]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SHEET_A, SHEET_A2, SHEET_B, SHEET_NULL, SHEET_LATE]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_A, BASE_B, BASE_NULL_OWNER]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // ── XB-1: opt-in allow ────────────────────────────────────────────────────
  // CREATE a cross-base link with foreignBaseId == foreign sheet's real base → ALLOWED (was rejected).
  test('XB-1: CREATE cross-base link with correct foreignBaseId is ALLOWED (201) and persists', async () => {
    const fieldId = `fld_xbo_t1_${TS}`
    const res = await request(buildApp(OWNER, WRITE)).post('/api/multitable/fields').send({
      sheetId: SHEET_A,
      id: fieldId,
      name: 'XB Opt-in Link',
      type: 'link',
      property: { foreignSheetId: SHEET_B, foreignBaseId: BASE_B },
    })

    expect(res.status).toBe(201)
    expect(await fieldExists(fieldId)).toBe(true)
    // XB-4 (wire round-trip): foreignBaseId must persist (not dropped by sanitizer/codec).
    expect((await fieldProperty(fieldId))?.foreignBaseId).toBe(BASE_B)
  })

  // ── XB-1b: mismatch reject ────────────────────────────────────────────────
  test('XB-1b: CREATE cross-base link with WRONG foreignBaseId is rejected (4xx); field not created', async () => {
    const fieldId = `fld_xbo_t1b_${TS}`
    const res = await request(buildApp(OWNER, WRITE)).post('/api/multitable/fields').send({
      sheetId: SHEET_A,
      id: fieldId,
      name: 'XB Wrong Claim',
      type: 'link',
      property: { foreignSheetId: SHEET_B, foreignBaseId: BASE_A }, // claims source base, not SHEET_B's
    })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(await fieldExists(fieldId)).toBe(false)
  })

  // ── XB-1c: no-flag reject (regression — the wall's current behavior) ───────
  test('XB-1c: CREATE cross-base link WITHOUT foreignBaseId is still rejected (4xx)', async () => {
    const fieldId = `fld_xbo_t1c_${TS}`
    const res = await request(buildApp(OWNER, WRITE)).post('/api/multitable/fields').send({
      sheetId: SHEET_A,
      id: fieldId,
      name: 'XB Bare Cross',
      type: 'link',
      property: { foreignSheetId: SHEET_B },
    })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(await fieldExists(fieldId)).toBe(false)
  })

  // ── XB-1d (degenerate): null/legacy-base foreign sheet cannot be opted into ─
  test('XB-1d: CREATE cross-base link to a null-base foreign sheet with any foreignBaseId is rejected (4xx)', async () => {
    const fieldId = `fld_xbo_t1d_${TS}`
    const res = await request(buildApp(OWNER, WRITE)).post('/api/multitable/fields').send({
      sheetId: SHEET_A,
      id: fieldId,
      name: 'XB Null Foreign',
      type: 'link',
      property: { foreignSheetId: SHEET_NULL, foreignBaseId: BASE_B }, // null actual ≠ any claim
    })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(await fieldExists(fieldId)).toBe(false)
  })

  // ── XB-immut: foreignBaseId is IMMUTABLE after create (decision c) ─────────
  test('XB-immut: PATCH changing a stored foreignBaseId is rejected (4xx); stored value unchanged', async () => {
    const fieldId = `fld_xbo_immut_${TS}`
    // Create a valid cross-base opt-in.
    await request(buildApp(OWNER, WRITE)).post('/api/multitable/fields').send({
      sheetId: SHEET_A,
      id: fieldId,
      name: 'XB Immut Link',
      type: 'link',
      property: { foreignSheetId: SHEET_B, foreignBaseId: BASE_B },
    }).expect(201)

    // Attempt to change foreignBaseId to a different value → must be rejected.
    const res = await request(buildApp(OWNER, WRITE))
      .patch(`/api/multitable/fields/${fieldId}`)
      .send({ property: { foreignSheetId: SHEET_B, foreignBaseId: BASE_A } })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect((await fieldProperty(fieldId))?.foreignBaseId).toBe(BASE_B)
  })

  // ── XB-immut-noop: a PATCH that does NOT touch foreignBaseId preserves it (wire-vs-fixture) ─
  test('XB-immut-noop: a rename-only PATCH preserves the stored foreignBaseId', async () => {
    const fieldId = `fld_xbo_immutnoop_${TS}`
    await request(buildApp(OWNER, WRITE)).post('/api/multitable/fields').send({
      sheetId: SHEET_A,
      id: fieldId,
      name: 'XB Immut Noop',
      type: 'link',
      property: { foreignSheetId: SHEET_B, foreignBaseId: BASE_B },
    }).expect(201)

    const res = await request(buildApp(OWNER, WRITE))
      .patch(`/api/multitable/fields/${fieldId}`)
      .send({ name: 'XB Immut Noop Renamed' })

    expect(res.status).toBe(200)
    // foreignBaseId must SURVIVE an unrelated PATCH (not dropped by explicit codec handling).
    expect((await fieldProperty(fieldId))?.foreignBaseId).toBe(BASE_B)
  })

  // ── XB-immut-add: the named two-step bypass — same-base link, then PATCH ADDS foreignBaseId ──
  // §2.5(b)'s reason-for-being: create a same-base link (no foreignBaseId), then PATCH ONLY a
  // `foreignBaseId` (NO foreign-sheet key) to falsely claim cross-base. The immutability gate must fire
  // INDEPENDENTLY of the wall's foreign-key presence gate (the PATCH carries no foreign-sheet key, so
  // the wall would not re-run) — stored is null, payload claims X, X !== null → reject. This canary
  // locks that the two gates are independent; aligning immutability with the wall's gate would silently
  // reopen the bypass.
  test('XB-immut-add: same-base link → PATCH adding ONLY foreignBaseId (no foreign key) is rejected (4xx)', async () => {
    const fieldId = `fld_xbo_immutadd_${TS}`
    // Same-base link, no foreignBaseId.
    await request(buildApp(OWNER, WRITE)).post('/api/multitable/fields').send({
      sheetId: SHEET_A,
      id: fieldId,
      name: 'XB Immut Add',
      type: 'link',
      property: { foreignSheetId: SHEET_A2 },
    }).expect(201)

    // PATCH adds ONLY foreignBaseId (no foreignSheetId/datasheetId) → must be rejected (claim != stored null).
    const res = await request(buildApp(OWNER, WRITE))
      .patch(`/api/multitable/fields/${fieldId}`)
      .send({ property: { foreignBaseId: BASE_B } })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    // The stored config must NOT have gained a foreignBaseId.
    expect((await fieldProperty(fieldId))?.foreignBaseId).toBeUndefined()
  })

  // ── XB-immut-same: re-asserting the SAME foreignBaseId on PATCH is allowed ──
  test('XB-immut-same: PATCH re-sending the identical foreignBaseId is allowed (200)', async () => {
    const fieldId = `fld_xbo_immutsame_${TS}`
    await request(buildApp(OWNER, WRITE)).post('/api/multitable/fields').send({
      sheetId: SHEET_A,
      id: fieldId,
      name: 'XB Immut Same',
      type: 'link',
      property: { foreignSheetId: SHEET_B, foreignBaseId: BASE_B },
    }).expect(201)

    const res = await request(buildApp(OWNER, WRITE))
      .patch(`/api/multitable/fields/${fieldId}`)
      .send({ name: 'XB Immut Same Renamed', property: { foreignSheetId: SHEET_B, foreignBaseId: BASE_B } })

    expect(res.status).toBe(200)
    expect((await fieldProperty(fieldId))?.foreignBaseId).toBe(BASE_B)
  })

  // ── XB-3: same-base link unaffected (zero regression) ─────────────────────
  test('XB-3: CREATE same-base link (no foreignBaseId) still succeeds (201)', async () => {
    const fieldId = `fld_xbo_t3_${TS}`
    const res = await request(buildApp(OWNER, WRITE)).post('/api/multitable/fields').send({
      sheetId: SHEET_A,
      id: fieldId,
      name: 'Same Base Link',
      type: 'link',
      property: { foreignSheetId: SHEET_A2 },
    })

    expect(res.status).toBe(201)
    expect(await fieldExists(fieldId)).toBe(true)
  })

  test('XB-3b: CREATE same-base link with truthful own-base foreignBaseId succeeds', async () => {
    const fieldId = `fld_xbo_t3b_${TS}`
    const res = await request(buildApp(OWNER, WRITE)).post('/api/multitable/fields').send({
      sheetId: SHEET_A,
      id: fieldId,
      name: 'Same Base Truthful Claim',
      type: 'link',
      property: { foreignSheetId: SHEET_A2, foreignBaseId: BASE_A },
    })

    expect(res.status).toBe(201)
    expect((await fieldProperty(fieldId))?.foreignBaseId).toBe(BASE_A)
  })

  test('XB-3c: CREATE same-base link with a stale external foreignBaseId is rejected', async () => {
    const fieldId = `fld_xbo_t3c_${TS}`
    const res = await request(buildApp(OWNER, WRITE)).post('/api/multitable/fields').send({
      sheetId: SHEET_A,
      id: fieldId,
      name: 'Same Base Stale External Claim',
      type: 'link',
      property: { foreignSheetId: SHEET_A2, foreignBaseId: BASE_B },
    })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(await fieldExists(fieldId)).toBe(false)
  })

  test('XB-3d: CREATE same-base link drops empty and non-string foreignBaseId claims', async () => {
    const emptyFieldId = `fld_xbo_t3d_empty_${TS}`
    const nonStringFieldId = `fld_xbo_t3d_num_${TS}`

    await request(buildApp(OWNER, WRITE)).post('/api/multitable/fields').send({
      sheetId: SHEET_A,
      id: emptyFieldId,
      name: 'Same Base Empty Claim',
      type: 'link',
      property: { foreignSheetId: SHEET_A2, foreignBaseId: '   ' },
    }).expect(201)

    await request(buildApp(OWNER, WRITE)).post('/api/multitable/fields').send({
      sheetId: SHEET_A,
      id: nonStringFieldId,
      name: 'Same Base Non String Claim',
      type: 'link',
      property: { foreignSheetId: SHEET_A2, foreignBaseId: 42 },
    }).expect(201)

    expect((await fieldProperty(emptyFieldId))?.foreignBaseId).toBeUndefined()
    expect((await fieldProperty(nonStringFieldId))?.foreignBaseId).toBeUndefined()
  })

  test('XB-immut-orphan: PATCH re-sending only the stored foreignBaseId is rejected', async () => {
    const fieldId = `fld_xbo_immutorphan_${TS}`
    await request(buildApp(OWNER, WRITE)).post('/api/multitable/fields').send({
      sheetId: SHEET_A,
      id: fieldId,
      name: 'XB Immut Orphan',
      type: 'link',
      property: { foreignSheetId: SHEET_B, foreignBaseId: BASE_B },
    }).expect(201)

    const res = await request(buildApp(OWNER, WRITE))
      .patch(`/api/multitable/fields/${fieldId}`)
      .send({ property: { foreignBaseId: BASE_B } })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    const property = await fieldProperty(fieldId)
    expect(property?.foreignSheetId).toBe(SHEET_B)
    expect(property?.foreignBaseId).toBe(BASE_B)
  })

  // ── XB-6 (TOCTOU): an opted-in link does NOT block the legit late sheet-create ─
  test('XB-6: a pre-seeded foreignBaseId-matching link does NOT block creating its target sheet; a non-opted-in link still blocks', async () => {
    // Pre-seed a cross-base link from SHEET_A (BASE_A) targeting the not-yet-existent SHEET_LATE,
    // claiming foreignBaseId = BASE_B (the base the late sheet will be created in) → opted in.
    const fldOptIn = `fld_xbo_t6_optin_${TS}`
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [fldOptIn, SHEET_A, 'Late OptIn Link', 'link', JSON.stringify({ foreignSheetId: SHEET_LATE, foreignBaseId: BASE_B }), 90])

    // Creating SHEET_LATE in BASE_B must be ALLOWED (the link legitimately opted into BASE_B).
    // POST /sheets returns 200 on success (res.json default), unlike POST /fields (201).
    const okRes = await request(buildApp(OWNER, WRITE)).post('/api/multitable/sheets').send({
      id: SHEET_LATE,
      baseId: BASE_B,
      name: 'Late Target',
    })
    expect(okRes.status).toBe(200)

    // Now a SECOND pre-seeded link claiming a DIFFERENT base (BASE_A) targeting a fresh late sheet must
    // still block that sheet's creation in BASE_B (claim ≠ new base → not opted in).
    const lateMismatch = `sheet_xbo_late2_${TS}`
    const fldMismatch = `fld_xbo_t6_mismatch_${TS}`
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [fldMismatch, SHEET_A, 'Late Mismatch Link', 'link', JSON.stringify({ foreignSheetId: lateMismatch, foreignBaseId: BASE_A }), 91])
    const blockRes = await request(buildApp(OWNER, WRITE)).post('/api/multitable/sheets').send({
      id: lateMismatch,
      baseId: BASE_B,
      name: 'Late Mismatch Target',
    })
    expect(blockRes.status).toBe(400)
    expect(await q('SELECT id FROM meta_sheets WHERE id = $1', [lateMismatch]).then((r) => (r.rows as unknown[]).length)).toBe(0)

    // cleanup the extra fields
    await q('DELETE FROM meta_fields WHERE id = ANY($1::text[])', [[fldOptIn, fldMismatch]]).catch(() => {})
  })

  // ── XB-2 / XB-2b: base-read gating on the READ sinks ──────────────────────
  // We seed one stable opted-in cross-base link + lookup on SHEET_A pointing at SHEET_B, then read
  // through /view (Sink A hydration + Sink B summaries) and /link-options (Sink B-2 endpoint) as
  // three actors.
  describe('read-sink base gating (Sink A + Sink B)', () => {
    const FLD_LINK = `fld_xbo_link_${TS}`
    const FLD_LU_OK = `fld_xbo_luok_${TS}` // lookup over readable foreign field
    const FLD_LU_DEN = `fld_xbo_luden_${TS}` // lookup over field-denied foreign field

    beforeAll(async () => {
      // Opted-in cross-base link (seeded directly with a VALID foreignBaseId claim).
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
        [FLD_LINK, SHEET_A, 'XLink', 'link', JSON.stringify({ foreignSheetId: SHEET_B, foreignBaseId: BASE_B }), 50])
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
        [FLD_LU_OK, SHEET_A, 'XLookupOk', 'lookup', JSON.stringify({ linkFieldId: FLD_LINK, targetFieldId: FLD_B_OK, foreignSheetId: SHEET_B }), 51])
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
        [FLD_LU_DEN, SHEET_A, 'XLookupDen', 'lookup', JSON.stringify({ linkFieldId: FLD_LINK, targetFieldId: FLD_B_DENIED, foreignSheetId: SHEET_B }), 52])

      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
        [REC_A, SHEET_A, JSON.stringify({ [FLD_LINK]: [REC_B] })])
      await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)',
        [`lnk_xbo_${TS}`, FLD_LINK, REC_A, REC_B])
    })

    const readViewRow = async (app: Express): Promise<Record<string, unknown>> => {
      const res = await request(app).get('/api/multitable/view').query({ sheetId: SHEET_A })
      expect(res.status).toBe(200)
      const rows = res.body?.data?.rows as Array<{ id: string; data: Record<string, unknown> }>
      const row = rows.find((r) => r.id === REC_A)
      expect(row).toBeDefined()
      return row!.data
    }
    // Link summaries are emitted by /view ONLY when includeLinkSummaries=true, at data.linkSummaries
    // (recordId → fieldId → summaries[]). Fetch with the flag and read REC_A's FLD_LINK summary ids.
    const fetchLinkSummaryIds = async (app: Express): Promise<string[]> => {
      const res = await request(app)
        .get('/api/multitable/view')
        .query({ sheetId: SHEET_A, includeLinkSummaries: 'true' })
      expect(res.status).toBe(200)
      const linkSummaries = (res.body?.data?.linkSummaries ?? {}) as Record<string, Record<string, Array<{ id: string }>>>
      return (linkSummaries[REC_A]?.[FLD_LINK] ?? []).map((s) => s.id)
    }

    // XB-2: reader WITHOUT foreign-base-read → Sink A hydration empty + Sink B summary empty + endpoint 403.
    test('XB-2 (no base-read): lookup hydration MASKED, link summary EMPTY, /link-options 403', async () => {
      const app = buildApp(READER_NOBASE, READ_ONLY)
      const data = await readViewRow(app)
      // Sink A: both cross-base lookups masked (foreign sheet base unreadable).
      const ok = data[FLD_LU_OK]
      const den = data[FLD_LU_DEN]
      expect(Array.isArray(ok) ? ok : [ok].filter((x) => x != null)).toEqual([])
      expect(Array.isArray(den) ? den : [den].filter((x) => x != null)).toEqual([])
      // Sink B-1: the cross-base link summary must be empty (omitted).
      expect(await fetchLinkSummaryIds(app)).toEqual([])
      // Sink B-2: explicit pull → 403.
      const lo = await request(app).get(`/api/multitable/fields/${FLD_LINK}/link-options`).query({ recordId: REC_A })
      expect(lo.status).toBe(403)
    })

    // XB-2b: reader WITH foreign-base-read (grant code) → base gate passes; readable field visible,
    // field-DENIED foreign field STILL masked by §2a.3 (double layer); /link-options 200.
    test('XB-2b (base-read granted): base gate passes; readable field visible, denied field still §2a.3-masked; /link-options 200', async () => {
      const app = buildApp(READER_BASE, READ_PLUS_BASE)
      const data = await readViewRow(app)
      // readable foreign field flows.
      expect(data[FLD_LU_OK]).toEqual([41])
      // field-permission-denied foreign field STILL masked even with base-read (layering).
      const den = data[FLD_LU_DEN]
      expect(Array.isArray(den) ? den : [den].filter((x) => x != null)).toEqual([])
      // Sink B-1: summary visible (base gate open).
      expect(await fetchLinkSummaryIds(app)).toEqual([REC_B])
      // Sink B-2: explicit pull → 200 with candidate records.
      const lo = await request(app).get(`/api/multitable/fields/${FLD_LINK}/link-options`).query({ recordId: REC_A })
      expect(lo.status).toBe(200)
    })

    // base-read via OWNERSHIP (OWNER owns BASE_B) → same visibility as grant-code reader.
    test('XB-2c (base-read via ownership): owner of foreign base sees cross-base summary + /link-options 200', async () => {
      const app = buildApp(OWNER, WRITE)
      expect(await fetchLinkSummaryIds(app)).toEqual([REC_B])
      const lo = await request(app).get(`/api/multitable/fields/${FLD_LINK}/link-options`).query({ recordId: REC_A })
      expect(lo.status).toBe(200)
    })

    afterAll(async () => {
      await q('DELETE FROM meta_links WHERE field_id = $1', [FLD_LINK]).catch(() => {})
      await q('DELETE FROM meta_records WHERE id = $1', [REC_A]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE id = ANY($1::text[])', [[FLD_LINK, FLD_LU_OK, FLD_LU_DEN]]).catch(() => {})
    })
  })
})
