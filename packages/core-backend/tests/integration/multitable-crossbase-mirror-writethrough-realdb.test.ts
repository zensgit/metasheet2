/**
 * C2 cross-base editable-mirror write-through — real-DB goldens (#3440 design-lock §6 / #3441 build spec §5).
 *
 * The ONE flag-gated op (`POST /crossbase/mirror-link`, MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE) that lets a
 * base-B actor edit a cross-base mirror M_B by mutating the single canonical FORWARD edge (F_A, rec_A, rec_B)
 * through the forward link-write service. Matrix:
 *
 *   W-flag  — flag unset ⇒ op refused, no write (mirror read-only exactly as today).
 *   W-A     — spine + dedup: happy add ⇒ exactly one (F_A, rec_A, rec_B) row and count(M_B rows) === 0;
 *             re-add of an edge that already exists from base-A's side ⇒ no-op, still exactly one row;
 *             remove ⇒ edge gone. Floor regression: a mirror write via the general /patch is still rejected.
 *             Fail-first (instrument proof): a directly-seeded M_B row IS detected by the spine probe.
 *   W-B     — asymmetric authority: happy path needs base-A C1 (claim==truth + base-writable) AND base-B
 *             record-level rec_B eligibility. Denials, each with NO edge: wrong claim; absent claim (400);
 *             base-A not writable; base-B rec_B row-denied (record-level, NOT base-level); read-only actor;
 *             quota N+1 (base-A-keyed). Asymmetry: a base-B-only denial consumes NO base-A quota slot, and
 *             an actor WITHOUT base-B base-write authority still passes (C1 is invoked for base-A only).
 *   W-C     — no-oracle (LOAD-BEARING): with base-A write authority but row-denied read on the named rec_A,
 *             ADD is byte-identical (status + body) to ADD of a non-existent rec_A′, and REMOVE of the
 *             masked-but-actually-linked rec_A is byte-identical to REMOVE of non-existent rec_A′ — with the
 *             edge still present afterwards (no success/no-op signal distinguishes "was linked" from "never
 *             existed"). These byte-identity assertions are themselves the fail-first detector for the
 *             mask-after-edge-existence regression: moving the mask after the existence branch makes the two
 *             responses diverge and turns these goldens RED.
 *
 * The spine assertion (count(meta_links WHERE field_id = M_B) === 0) runs after EVERY case.
 * Decision-F (forward link-edit ↔ this op concurrency) is a SEPARATE enablement-gate golden — flag stays
 * default-off; this suite sets the flag per-request-window explicitly and restores it.
 *
 * Runs only with DATABASE_URL (describeIfDatabase) via the plugin-tests.yml real-DB runner list.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { __resetSharedCrossBaseWriteQuotaForTest } from '../../src/multitable/automation-executor'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_A = `base_c2w_a_${TS}` // canonical-edge owner base (forward field's base)
const BASE_B = `base_c2w_b_${TS}` // acting base (mirror field's base)
const SA = `sheet_c2w_a_${TS}`
const SB = `sheet_c2w_b_${TS}`
const F_A = `fld_c2w_fwd_${TS}` // forward twoWay link A→B (the canonical edge key)
const M_B = `fld_c2w_mir_${TS}` // mirror twoWay link B→A, mirrorOf=F_A (read-only on all non-op paths)
const F_B_NAME = `fld_c2w_bname_${TS}`
const REC_A1 = `rec_c2w_a1_${TS}`
const REC_A2 = `rec_c2w_a2_${TS}` // the masked target (W-C)
const REC_B1 = `rec_c2w_b1_${TS}`
const REC_A_MISSING = `rec_c2w_missing_${TS}` // never inserted

const OWNER = `u_c2w_owner_${TS}` // owns BASE_A (base-A writable) + full multitable perms
const READONLY = `u_c2w_ro_${TS}` // multitable:read only (base-B leg: canEditRecord=false)
const NOBASEA = `u_c2w_nba_${TS}` // full sheet perms but NOT base-A writable (no ownership, no base codes)

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

let app: Express
let currentUser: { id: string; roles: string[]; perms: string[] } = {
  id: OWNER,
  roles: ['member'],
  perms: ['multitable:read', 'multitable:write'],
}
const asUser = (id: string, perms: string[]) => { currentUser = { id, roles: ['member'], perms } }
const asOwner = () => asUser(OWNER, ['multitable:read', 'multitable:write'])

/** Spine assertion: the mirror field must NEVER own a meta_links row. */
const mirrorRows = async (): Promise<number> =>
  Number(((await q('SELECT count(*)::int AS n FROM meta_links WHERE field_id = $1', [M_B])).rows[0] as { n: number }).n)
/** Canonical forward edge count for (F_A, recA, recB). */
const forwardEdgeCount = async (recA: string, recB: string): Promise<number> =>
  Number(((await q('SELECT count(*)::int AS n FROM meta_links WHERE field_id = $1 AND record_id = $2 AND foreign_record_id = $3', [F_A, recA, recB])).rows[0] as { n: number }).n)

type MirrorOpBody = {
  sheetId?: string
  recordId?: string
  fieldId?: string
  action?: 'add' | 'remove'
  foreignRecordId?: string
  targetBaseId?: string
}
const mirrorOp = (overrides: MirrorOpBody = {}) =>
  request(app).post('/api/multitable/crossbase/mirror-link').send({
    sheetId: SB,
    recordId: REC_B1,
    fieldId: M_B,
    action: 'add',
    foreignRecordId: REC_A1,
    targetBaseId: BASE_A,
    ...overrides,
  })

describeIfDatabase('C2 cross-base mirror write-through — op runtime goldens (real DB)', () => {
  beforeAll(async () => {
    process.env.MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE = 'true'
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as express.Request & { user?: unknown }).user = currentUser; next() })
    app.use('/api/multitable', univerMetaRouter())

    for (const u of [OWNER, READONLY, NOBASEA]) {
      await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [u])
    }
    // OWNER owns BASE_A ⇒ resolveBaseWritable(BASE_A) true for OWNER; nobody owns BASE_B and no actor holds
    // base codes for it ⇒ an op success ALSO proves C1 is not invoked for the base-B leg (it would fail).
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [BASE_A, 'C2W A', OWNER])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_B, 'C2W B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3),($4,$5,$6)', [SA, BASE_A, 'A', SB, BASE_B, 'B'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [F_A, SA, 'Fwd', 'link', JSON.stringify({ foreignSheetId: SB, foreignBaseId: BASE_B, twoWay: true, mirrorFieldId: M_B }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [M_B, SB, 'Mir', 'link', JSON.stringify({ foreignSheetId: SA, foreignBaseId: BASE_A, twoWay: true, mirrorFieldId: F_A, mirrorOf: F_A }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [F_B_NAME, SB, 'BName', 'string', '{}', 2])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1),($4,$5,$6::jsonb,1),($7,$8,$9::jsonb,1)',
      [REC_A1, SA, '{}', REC_A2, SA, '{}', REC_B1, SB, JSON.stringify({ [F_B_NAME]: 'b1' })])
  })

  afterAll(async () => {
    delete process.env.MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE
    delete process.env.CROSS_BASE_WRITE_QUOTA_LIMIT
    await q('DELETE FROM meta_links WHERE field_id = ANY($1::text[])', [[F_A, M_B]]).catch(() => {})
    await q('DELETE FROM record_permissions WHERE sheet_id = ANY($1::text[])', [[SA, SB]]).catch(() => {})
    for (const t of ['meta_record_revisions', 'meta_records']) await q(`DELETE FROM ${t} WHERE sheet_id = ANY($1::text[])`, [[SA, SB]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SA, SB]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SA, SB]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_A, BASE_B]]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[OWNER, READONLY, NOBASEA]]).catch(() => {})
    await poolManager.get().end?.()
  })

  afterEach(async () => {
    // The spine invariant holds after EVERY case, whatever the outcome (allow / deny / error).
    expect(await mirrorRows()).toBe(0)
    asOwner()
  })

  // ── W-flag ────────────────────────────────────────────────────────────────
  test('W-flag: flag unset ⇒ op refused, no edge written', async () => {
    process.env.MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE = 'false'
    try {
      const res = await mirrorOp()
      expect(res.status).toBe(403)
      expect(res.body?.error?.code).toBe('MIRROR_WRITE_DISABLED')
      expect(await forwardEdgeCount(REC_A1, REC_B1)).toBe(0)
    } finally {
      process.env.MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE = 'true'
    }
  })

  // ── W-A: spine + dedup + floor ───────────────────────────────────────────
  test('W-A: happy add writes exactly ONE canonical forward edge; mirror owns no row', async () => {
    const res = await mirrorOp()
    expect(res.status).toBe(200)
    expect(res.body?.data?.forward?.fieldId).toBe(F_A)
    expect(await forwardEdgeCount(REC_A1, REC_B1)).toBe(1)
    expect(await mirrorRows()).toBe(0)
  })

  test('W-A: re-add of an edge that already exists is a NO-OP — still exactly one (F_A,…) row', async () => {
    expect(await forwardEdgeCount(REC_A1, REC_B1)).toBe(1) // seeded by the previous golden via the op itself
    const res = await mirrorOp()
    expect(res.status).toBe(200)
    expect(await forwardEdgeCount(REC_A1, REC_B1)).toBe(1) // dedup via the forward service, no duplicate row
  })

  test('W-A: remove deletes the canonical edge', async () => {
    const res = await mirrorOp({ action: 'remove' })
    expect(res.status).toBe(200)
    expect(await forwardEdgeCount(REC_A1, REC_B1)).toBe(0)
  })

  test('W-A floor regression: a mirror write via the general /patch is STILL rejected (C2/I-1 intact)', async () => {
    const res = await request(app).post('/api/multitable/patch').send({
      sheetId: SB,
      changes: [{ recordId: REC_B1, fieldId: M_B, value: [REC_A1] }],
    })
    expect(res.status).toBe(403)
    expect(await mirrorRows()).toBe(0)
  })

  test('W-A fail-first instrument proof: a directly-seeded M_B row IS detected by the spine probe', async () => {
    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [M_B, REC_B1, REC_A1])
    expect(await mirrorRows()).toBe(1) // the probe that guards every other golden really can go red
    await q('DELETE FROM meta_links WHERE field_id = $1', [M_B])
  })

  // ── W-B: asymmetric two-leg authority ────────────────────────────────────
  test('W-B: wrong base-A claim ⇒ deny, no edge (claim==truth is load-bearing)', async () => {
    const res = await mirrorOp({ targetBaseId: BASE_B }) // truthful-looking but WRONG (must equal F_A's base)
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('CLAIM_MISMATCH')
    expect(await forwardEdgeCount(REC_A1, REC_B1)).toBe(0)
  })

  test('W-B: absent claim ⇒ fail-closed 400, no edge', async () => {
    const res = await mirrorOp({ targetBaseId: undefined })
    expect(res.status).toBe(400)
    expect(await forwardEdgeCount(REC_A1, REC_B1)).toBe(0)
  })

  test('W-B: base-A not writable ⇒ deny, no edge — while base-B base-write is NEVER required (asymmetry)', async () => {
    asUser(NOBASEA, ['multitable:read', 'multitable:write'])
    const res = await mirrorOp()
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('BASE_NOT_WRITABLE')
    expect(await forwardEdgeCount(REC_A1, REC_B1)).toBe(0)
    // Asymmetry positive proof: OWNER holds NO base-write authority on BASE_B (not owner, no base codes) —
    // if the C1 primitive were (wrongly) invoked for the base-B leg the happy path could never pass; it
    // passes in W-A above purely on record-level rec_B eligibility.
  })

  test('W-B: read-only actor fails the base-B record-edit leg ⇒ deny, no edge', async () => {
    asUser(READONLY, ['multitable:read'])
    const res = await mirrorOp()
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('RECORD_EDIT_DENIED')
    expect(await forwardEdgeCount(REC_A1, REC_B1)).toBe(0)
  })

  test('W-B: rec_B row-denied actor cannot use the mirror op as a bypass (RECORD-level, not base-level) — and the denial consumes NO base-A quota', async () => {
    // Row-level read deny on rec_B for OWNER: record-edit eligibility on the SPECIFIC rec_B fails even
    // though OWNER's sheet/base-level authority is intact — the record-level upgrade the lock ratified.
    await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = true WHERE id = $1', [SB])
    await q('INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1,$2,$3,$4,$5)',
      [SB, REC_B1, 'user', OWNER, 'none'])
    __resetSharedCrossBaseWriteQuotaForTest() // absolute boundary: ignore prior tests' accumulation on the shared singleton
    process.env.CROSS_BASE_WRITE_QUOTA_LIMIT = '1' // ONE slot in the window for BASE_A
    try {
      const denied = await mirrorOp()
      expect(denied.status).toBe(403)
      expect(denied.body?.error?.code).toBe('RECORD_EDIT_DENIED')
      expect(await forwardEdgeCount(REC_A1, REC_B1)).toBe(0)

      // The base-B-only denial above must NOT have consumed the single base-A quota slot: after lifting
      // the rec_B deny, the very next authorized write still fits the limit-1 budget.
      await q('DELETE FROM record_permissions WHERE sheet_id = $1 AND record_id = $2', [SB, REC_B1])
      await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = false WHERE id = $1', [SB])
      const allowed = await mirrorOp()
      expect(allowed.status).toBe(200)
      expect(await forwardEdgeCount(REC_A1, REC_B1)).toBe(1)

      // Quota N+1 (base-A-keyed): the SECOND authorized attempt in the same window exceeds limit 1.
      const overQuota = await mirrorOp({ action: 'remove' })
      expect(overQuota.status).toBe(429)
      expect(overQuota.body?.error?.code).toBe('CROSS_BASE_WRITE_QUOTA_EXCEEDED')
      expect(await forwardEdgeCount(REC_A1, REC_B1)).toBe(1) // denied attempt wrote/removed nothing
    } finally {
      delete process.env.CROSS_BASE_WRITE_QUOTA_LIMIT
      await q('DELETE FROM record_permissions WHERE sheet_id = $1', [SB]).catch(() => {})
      await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = false WHERE id = $1', [SB])
      // leave state clean for W-C: remove the edge minted above (fresh window after env delete)
      const cleanup = await mirrorOp({ action: 'remove' })
      expect(cleanup.status).toBe(200)
      expect(await forwardEdgeCount(REC_A1, REC_B1)).toBe(0)
    }
  })

  // ── W-C: per-record no-oracle on rec_A (LOAD-BEARING) ────────────────────
  test('W-C ADD: masked rec_A is BYTE-IDENTICAL to missing rec_A′ — uniform deny, no edge either way', async () => {
    // OWNER has base-A write (owner) but is row-denied READ on the specific REC_A2.
    await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = true WHERE id = $1', [SA])
    await q('INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1,$2,$3,$4,$5)',
      [SA, REC_A2, 'user', OWNER, 'none'])
    try {
      const masked = await mirrorOp({ foreignRecordId: REC_A2 })
      const missing = await mirrorOp({ foreignRecordId: REC_A_MISSING })
      expect(masked.status).toBe(missing.status)
      expect(masked.body).toEqual(missing.body) // byte-identity: same status, same body, no divergence
      expect(masked.status).toBe(403)
      expect(await forwardEdgeCount(REC_A2, REC_B1)).toBe(0)
      expect(await forwardEdgeCount(REC_A_MISSING, REC_B1)).toBe(0)
    } finally {
      await q('DELETE FROM record_permissions WHERE sheet_id = $1', [SA]).catch(() => {})
      await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = false WHERE id = $1', [SA])
    }
  })

  test('W-C REMOVE: removing a masked-but-LINKED rec_A is BYTE-IDENTICAL to removing a missing rec_A′ — the edge survives (no linkage oracle)', async () => {
    // Seed the canonical edge from base-A's side (the forward field's own write path is out of band here;
    // direct seed keeps this golden independent of the ADD goldens).
    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [F_A, REC_A2, REC_B1])
    await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = true WHERE id = $1', [SA])
    await q('INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1,$2,$3,$4,$5)',
      [SA, REC_A2, 'user', OWNER, 'none'])
    try {
      const maskedLinked = await mirrorOp({ action: 'remove', foreignRecordId: REC_A2 })
      const missing = await mirrorOp({ action: 'remove', foreignRecordId: REC_A_MISSING })
      expect(maskedLinked.status).toBe(missing.status)
      expect(maskedLinked.body).toEqual(missing.body) // "was linked" is indistinguishable from "never existed"
      expect(maskedLinked.status).toBe(403)
      expect(await forwardEdgeCount(REC_A2, REC_B1)).toBe(1) // the masked remove removed NOTHING
    } finally {
      await q('DELETE FROM record_permissions WHERE sheet_id = $1', [SA]).catch(() => {})
      await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = false WHERE id = $1', [SA])
      await q('DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2', [F_A, REC_A2])
    }
  })

  test('W-C: authorized-and-readable rec_A still flows normally after the mask goldens (no over-deny)', async () => {
    const add = await mirrorOp({ foreignRecordId: REC_A2 })
    expect(add.status).toBe(200)
    expect(await forwardEdgeCount(REC_A2, REC_B1)).toBe(1)
    const remove = await mirrorOp({ action: 'remove', foreignRecordId: REC_A2 })
    expect(remove.status).toBe(200)
    expect(await forwardEdgeCount(REC_A2, REC_B1)).toBe(0)
  })

  // ── Decision D guard: the op refuses a SAME-base pairing ─────────────────
  test('same-base pairing is refused (same-base mirror stays read-only, Decision D)', async () => {
    // Re-point sheet B into BASE_A temporarily: pairing becomes same-base.
    await q('UPDATE meta_sheets SET base_id = $2 WHERE id = $1', [SB, BASE_A])
    try {
      const res = await mirrorOp()
      expect(res.status).toBe(403)
      expect(res.body?.error?.code).toBe('MIRROR_WRITE_CROSSBASE_ONLY')
      expect(await forwardEdgeCount(REC_A1, REC_B1)).toBe(0)
    } finally {
      await q('UPDATE meta_sheets SET base_id = $2 WHERE id = $1', [SB, BASE_B])
    }
  })
})
