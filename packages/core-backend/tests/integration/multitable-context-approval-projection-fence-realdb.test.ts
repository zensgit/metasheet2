/**
 * C1 — GET /api/multitable/context routes through the SAME fenced capability resolution every other
 * sheet-addressed route in this file already uses (resolveSheetCapabilitiesForAccess /
 * filterReadableSheetRowsForAccess), instead of a bare deriveCapabilities + unfiltered SQL. Before this
 * change a non-admin holding only the global `multitable:read` grant could read the admin-only approval
 * projection base's metadata (sheet name, sibling sheet list, field ids) through /context alone, even
 * though every other read route (`/sheets`, `/bases`, `/records`, …) already fenced it off — see
 * docs/development (private repro, not linked here; PR body stays neutral).
 *
 * This file proves, against REAL provisioned projection data (getApprovalRecordProjectionService().reconcile()
 * on real approval_templates/approval_instances rows — not hand-typed projection rows):
 *   - a non-admin, non-participant actor with global multitable:read gets 404 for the projection sheet,
 *     byte-identical in shape to the 404 for a sheetId that does not exist at all (no 403-vs-404 signal
 *     that would confirm the sheet's existence);
 *   - the same actor's request for the projection BASE's sheet listing never names the sibling sheet;
 *   - the SAME entitled reader still gets the pre-existing 403 (not 404) for two refusals the fence must
 *     NOT touch: the People list-filter sentinel sheet, and a baseId/sheetId cross-base mismatch on a
 *     sheet that actually exists and is otherwise readable — the 404 anti-oracle treatment is scoped to
 *     the actual approval/elearning projection fence, not to "any sheet absent from the readable set";
 *   - an admin still gets 200;
 *   - an ordinary (non-projection) sheet's /context response is BYTE-IDENTICAL to a hand-typed fixed
 *     expectation captured from the pre-change route (not derived from the new code).
 *
 * KNOWN, PRE-EXISTING, OUT-OF-SCOPE GAP (characterized, not fixed, here): against REAL reconcile()
 * output, a genuine business participant on an approval-projection record is currently NOT recognized
 * as a participant by the shared participant carve-out (`loadApprovalProjectionParticipantSheetIds`,
 * permission-service.ts) — a fail-closed (over-strict, not a security hole) functionality gap tracked
 * on a separate line, not something this PR's routing fix touches or should paper over. This file
 * documents that gap with a real fixture (so it cannot silently regress into something worse) and
 * separately proves — using a fixture seeded in whatever shape the shared predicate itself currently
 * reads — that /context's OWN wiring correctly defers to whatever the shared predicate decides, once
 * that predicate recognizes the participant. Both facts matter to a reviewer and neither should be
 * conflated with the other.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import {
  getApprovalRecordProjectionService,
  deriveProjectionSheetId,
} from '../../src/multitable/approval-record-projection-service'
import { APPROVAL_PROJECTION_BASE_ID } from '../../src/multitable/approval-projection-constants'
import { SYSTEM_PEOPLE_SHEET_DESCRIPTION } from '../../src/multitable/system-sheet-predicate'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const itIfExpectDb = process.env.EXPECT_DB === '1' ? test : test.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const TS = Date.now()
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

// ── actors ────────────────────────────────────────────────────────────────────
const ADMIN_ID = `u_c1_admin_${TS}`
const NONPART_ID = `u_c1_nonpart_${TS}` // global multitable:read, participant of NOTHING
const BARE_ID = `u_c1_bare_${TS}` // zero multitable:* grants anywhere (token AND DB) — the ordinary-403 control
const GRANTEE_ID = `u_c1_grantee_${TS}` // zero GLOBAL multitable:* grants anywhere; the ONLY read
// authority this actor has is a sheet-scoped spreadsheet_permissions row on GRANT_SHEET below — the
// P2-01 remedy: this is the actor class the route's preloadedScopeMap hoist actually governs.
const PARTICIPANT_ID = `u_c1_participant_${TS}` // real requester on TPL_A's instance (see note above: the
// shared predicate does not currently recognize this — characterized below, not fixed here)

// ── approval templates / instances (real provisioning → real reconcile()) ─────
const TPL_A = randomUUID()
const TPL_B = randomUUID()
const INST_A1 = `inst_c1_a1_${TS}` // TPL_A, requester = PARTICIPANT_ID
const INST_B1 = `inst_c1_b1_${TS}` // TPL_B (sibling family), requester = someone else entirely
const SHEET_A = deriveProjectionSheetId(TPL_A)
const SHEET_B = deriveProjectionSheetId(TPL_B)

// ── ordinary (non-projection) sheet — the zero-behavior-change control ────────
const ORD_BASE = `base_c1_ord_${TS}`
const ORD_SHEET = `sheet_c1_ord_${TS}`
const ORD_FIELD = `fld_c1_ord_${TS}`
const ORD_VIEW = `view_c1_ord_${TS}`

// ── P3 scope fixtures — refusal paths the fence must NOT touch (round-2 remedy) ───
// A second, otherwise-empty base for the cross-base baseId/sheetId mismatch case, and a
// People-sentinel-description sheet IN ORD_BASE for the list-filter sentinel case. Both prove the
// 404 branch above (`wasVisibleForThisBase`) fires ONLY for the actual projection/elearning fence —
// not for "any sheet dropped for any reason" — by keeping these two refusals on the pre-existing 403.
const OTHER_BASE = `base_c1_other_${TS}`
const PEOPLE_SHEET = `sheet_c1_people_${TS}`

// ── P2-01 remedy fixture — a sheet-scoped-grant holder with ZERO global grants (gate-2 finding) ──
// A DEDICATED base (not ORD_BASE): NONPART_ID's global multitable:read would otherwise make this
// sheet readable to NONPART_ID too and leak it into the "ZERO BEHAVIOR CHANGE" fixed-shape
// assertion's sheets[] list below. Ordinary (non-projection) sheet — this test is about whether the
// CORRECT preloadedScopeMap reaches BOTH resolvers, not about the projection fence, so an ordinary
// sheet is the right fixture — the projection sheets above already exercise the fence itself.
const GRANT_BASE = `base_c1_grant_${TS}`
const GRANT_SHEET = `sheet_c1_grant_${TS}`

let app: Express
let currentUser: { id: string; roles?: string[]; perms?: string[] } | null = null

function contextRequest(query: Record<string, string>) {
  return request(app).get('/api/multitable/context').query(query)
}

describeIfDatabase('C1 — GET /context fenced capability resolution (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = currentUser ?? undefined
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    // Actors — real rows, real grants (not a hand-built req.permissions snapshot): resolveRequestAccess
    // for these ids goes through the DB fallback path exactly like a normal logged-in user.
    for (const [id, perms] of [
      [NONPART_ID, ['multitable:read']],
      [PARTICIPANT_ID, ['multitable:read']],
      [BARE_ID, []],
      [GRANTEE_ID, []],
    ] as const) {
      await q(`INSERT INTO users (id, name, password_hash, role) VALUES ($1,$1,'x','user') ON CONFLICT (id) DO NOTHING`, [id])
      for (const perm of perms) {
        await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, perm])
      }
    }

    // Two independent approval-template families → two SIBLING projection sheets in the SAME
    // admin-only base, so the sheets[] leak check has a real second sheet to hide.
    await q(
      `INSERT INTO approval_templates (id, key, name, status, category) VALUES ($1,$2,$3,'published','ops') ON CONFLICT (id) DO NOTHING`,
      [TPL_A, `c1-tpl-a-${TS}`, 'C1 Template A'],
    )
    await q(
      `INSERT INTO approval_templates (id, key, name, status, category) VALUES ($1,$2,$3,'published','ops') ON CONFLICT (id) DO NOTHING`,
      [TPL_B, `c1-tpl-b-${TS}`, 'C1 Template B'],
    )
    await q(
      `INSERT INTO approval_instances (id, status, version, template_id, request_no, current_node_key, requester_snapshot, title)
       VALUES ($1,'approved',1,$2,$3,'node_end',$4::jsonb,$5) ON CONFLICT (id) DO NOTHING`,
      [INST_A1, TPL_A, `REQ-C1-A1-${TS}`, JSON.stringify({ id: PARTICIPANT_ID, name: 'C1 Participant' }), 'C1 A1'],
    )
    await q(
      `INSERT INTO approval_instances (id, status, version, template_id, request_no, current_node_key, requester_snapshot, title)
       VALUES ($1,'approved',1,$2,$3,'node_end',$4::jsonb,$5) ON CONFLICT (id) DO NOTHING`,
      [INST_B1, TPL_B, `REQ-C1-B1-${TS}`, JSON.stringify({ id: `u_c1_stranger_${TS}` }), 'C1 B1'],
    )

    // The REAL service — not hand-typed projection rows — provisions base_apr_projection + the two
    // sheets + the projected records, exactly as production's completion-event subscription would.
    const svc = getApprovalRecordProjectionService()
    const outcomeA = await svc.reconcile(INST_A1)
    const outcomeB = await svc.reconcile(INST_B1)
    expect(outcomeA.status).toBe('projected')
    expect(outcomeB.status).toBe('projected')

    // Ordinary sheet fixture for the parity control.
    await q(`INSERT INTO meta_bases (id, name, icon, color, owner_id) VALUES ($1,'C1 Ordinary','table','#1677ff',$2)`, [ORD_BASE, NONPART_ID])
    await q(`INSERT INTO meta_sheets (id, base_id, name, description) VALUES ($1,$2,'C1 Ordinary Sheet',NULL)`, [ORD_SHEET, ORD_BASE])
    await q(`INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,'Title','string','{}'::jsonb,0)`, [ORD_FIELD, ORD_SHEET])
    await q(`INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1,$2,'Grid','grid')`, [ORD_VIEW, ORD_SHEET])

    // P3 scope fixtures: a second base (for the cross-base mismatch) and a People-sentinel sheet
    // living IN ORD_BASE (for the list-filter sentinel case) — seeded directly with the sentinel
    // description, same as the gate report's own reproduction.
    await q(`INSERT INTO meta_bases (id, name, icon, color, owner_id) VALUES ($1,'C1 Other','table','#1677ff',$2)`, [OTHER_BASE, NONPART_ID])
    await q(`INSERT INTO meta_sheets (id, base_id, name, description) VALUES ($1,$2,'People',$3)`, [
      PEOPLE_SHEET,
      ORD_BASE,
      SYSTEM_PEOPLE_SHEET_DESCRIPTION,
    ])

    // P2-01 remedy fixture: an ordinary sheet, in its OWN base, that the grantee can read ONLY via a
    // sheet-scoped spreadsheet_permissions row — no global multitable:* grant anywhere for this actor.
    await q(`INSERT INTO meta_bases (id, name, icon, color, owner_id) VALUES ($1,'C1 Grant','table','#1677ff',$2)`, [GRANT_BASE, GRANTEE_ID])
    await q(`INSERT INTO meta_sheets (id, base_id, name, description) VALUES ($1,$2,'C1 Grant Sheet',NULL)`, [GRANT_SHEET, GRANT_BASE])
    await q(
      `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,'user',$2,'spreadsheet:write')`,
      [GRANT_SHEET, GRANTEE_ID],
    )
  })

  afterAll(async () => {
    await q(`DELETE FROM approval_record_projection WHERE instance_id = ANY($1::text[])`, [[INST_A1, INST_B1]]).catch(() => {})
    await q(`DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])`, [[SHEET_A, SHEET_B]]).catch(() => {})
    await q(`DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])`, [[SHEET_A, SHEET_B]]).catch(() => {})
    await q(`DELETE FROM meta_sheets WHERE id = ANY($1::text[])`, [[SHEET_A, SHEET_B]]).catch(() => {})
    await q(`DELETE FROM approval_instances WHERE id = ANY($1::text[])`, [[INST_A1, INST_B1]]).catch(() => {})
    await q(`DELETE FROM approval_templates WHERE id = ANY($1::uuid[])`, [[TPL_A, TPL_B]]).catch(() => {})
    await q(`DELETE FROM meta_views WHERE sheet_id = $1`, [ORD_SHEET]).catch(() => {})
    await q(`DELETE FROM meta_fields WHERE sheet_id = $1`, [ORD_SHEET]).catch(() => {})
    await q(`DELETE FROM spreadsheet_permissions WHERE sheet_id = $1`, [GRANT_SHEET]).catch(() => {})
    await q(`DELETE FROM meta_sheets WHERE id = ANY($1::text[])`, [[ORD_SHEET, PEOPLE_SHEET, GRANT_SHEET]]).catch(() => {})
    await q(`DELETE FROM meta_bases WHERE id = ANY($1::text[])`, [[ORD_BASE, OTHER_BASE, GRANT_BASE]]).catch(() => {})
    await q(`DELETE FROM user_permissions WHERE user_id = ANY($1::text[])`, [[NONPART_ID, PARTICIPANT_ID, BARE_ID, GRANTEE_ID]]).catch(() => {})
    await q(`DELETE FROM users WHERE id = ANY($1::text[])`, [[NONPART_ID, PARTICIPANT_ID, BARE_ID, GRANTEE_ID]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('fixture sanity: reconcile really provisioned two distinct sibling sheets under the admin-only base', async () => {
    const rows = await q('SELECT id, base_id FROM meta_sheets WHERE id = ANY($1::text[]) ORDER BY id', [[SHEET_A, SHEET_B]])
    expect(rows.rows.map((r: any) => r.id).sort()).toEqual([SHEET_A, SHEET_B].sort())
    for (const row of rows.rows as Array<{ base_id: string }>) {
      expect(row.base_id).toBe(APPROVAL_PROJECTION_BASE_ID)
    }
  })

  test('ANTI-ORACLE: non-participant with global multitable:read gets 404 for the projection sheet, byte-identical to a sheetId that does not exist', async () => {
    currentUser = { id: NONPART_ID, perms: ['multitable:read'] }
    const realButFenced = await contextRequest({ sheetId: SHEET_A })
    const doesNotExist = `sheet_c1_does_not_exist_${TS}`
    const genuinelyMissing = await contextRequest({ sheetId: doesNotExist })

    expect(realButFenced.status).toBe(404)
    expect(genuinelyMissing.status).toBe(404)
    expect(realButFenced.body).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: `Sheet not found: ${SHEET_A}` },
    })
    expect(genuinelyMissing.body).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: `Sheet not found: ${doesNotExist}` },
    })
    // Same shape modulo the id each response necessarily echoes back (pre-existing /context contract,
    // unrelated to this fix): a viewer cannot tell "exists, fenced" from "never existed" from either
    // the status code or the error code/keys.
    expect(Object.keys(realButFenced.body).sort()).toEqual(Object.keys(genuinelyMissing.body).sort())
    expect(realButFenced.body.error.code).toBe(genuinelyMissing.body.error.code)
  })

  test('ANTI-ORACLE (control): a zero-grant actor still gets the ordinary FORBIDDEN shape (not 404) for a sheet an ordinary permission check refuses — pinned by THIS test, running in this lane (multitable-sheet-permissions.api.test.ts asserts the same no-grant-403 shape but is excluded from every workflow and does not run in CI)', async () => {
    // A bare-no-grant actor on an ORDINARY sheet is a different refusal reason entirely (no fence
    // involved) and must keep its existing 403 — only the projection/elearning fence gets the 404
    // anti-oracle treatment.
    currentUser = { id: BARE_ID }
    const res = await contextRequest({ sheetId: ORD_SHEET })
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
  })

  test('PROJECTION-FENCE SCOPE: the People list-filter sentinel sheet stays 403, NOT 404 — the fence is scoped to the actual approval/elearning projection, not to "any sheet filterVisibleSheetRows drops"', async () => {
    // An entitled reader (global multitable:read, same class of actor as the genuine 404 case above)
    // hitting a sheet that filterVisibleSheetRows excludes for an unrelated reason (the People
    // list-filter display sentinel) must NOT get the fence's 404 treatment — that would conflate two
    // different exclusion mechanisms and, per the round-1 gate finding, silently answered "not found"
    // for a sheet whose existence an ordinary permission check would have disclosed.
    currentUser = { id: NONPART_ID, perms: ['multitable:read'] }
    const res = await contextRequest({ baseId: ORD_BASE, sheetId: PEOPLE_SHEET })
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
  })

  test('PROJECTION-FENCE SCOPE: a baseId/sheetId cross-base mismatch stays 403, NOT 404 — the same actor gets 200 for this exact sheet without the mismatched baseId', async () => {
    // sheetPermissionScopeMap / visibleSheetRows are built over the RESOLVED base's sheet list; a
    // sheetId from a DIFFERENT base is simply absent from both, which reads identically to "the fence
    // excluded it" unless the 404 branch is scoped to sheets the fence actually saw. Per the round-1
    // gate finding, this previously flipped 403 -> 404 for a sheet that EXISTS and the caller CAN read.
    currentUser = { id: NONPART_ID, perms: ['multitable:read'] }
    const withoutMismatch = await contextRequest({ sheetId: ORD_SHEET })
    expect(withoutMismatch.status).toBe(200)

    const mismatched = await contextRequest({ baseId: OTHER_BASE, sheetId: ORD_SHEET })
    expect(mismatched.status).toBe(403)
    expect(mismatched.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
  })

  test('PRELOADED SCOPE MAP: an actor with ZERO global multitable grants, whose only read authority is a sheet-scoped grant on THIS sheet, still gets 200 with the granted capability shape — proves the readability gate and the capability resolver both receive the real scope map, not an empty one', async () => {
    // GRANTEE_ID has no row in user_permissions and no `perms` on currentUser at all — every capability
    // below can ONLY come from the sheet-scoped spreadsheet_permissions row on GRANT_SHEET, resolved
    // through the SAME preloadedScopeMap this fix passes into both filterReadableSheetRowsForAccess
    // (the readability gate) and resolveSheetCapabilitiesForAccess (the capability plane). If either
    // resolver were handed an empty/wrong map instead, this actor would be refused entirely.
    currentUser = { id: GRANTEE_ID }
    const res = await contextRequest({ sheetId: GRANT_SHEET })
    expect(res.status).toBe(200)
    expect(res.body.data.sheet?.id).toBe(GRANT_SHEET)
    expect(res.body.data.capabilities.canRead).toBe(true)
    // Closes the gate-1 canDeleteSheet-for-a-grant-holder window: global schema authority is absent
    // (zero global grants) and the sheet grant itself is `spreadsheet:write`, not `spreadsheet:admin` /
    // `multitable:admin` — sheetScope.canAdmin is false — so hasSheetLifecycleAuthority must stay false.
    expect(res.body.data.capabilities.canDeleteSheet).toBe(false)
    expect(res.body.data.capabilities.canManageSheetAccess).toBe(false)
  })

  test('sheets[] listing: the non-participant querying the projection BASE never sees either sibling sheet name', async () => {
    currentUser = { id: NONPART_ID, perms: ['multitable:read'] }
    const res = await contextRequest({ baseId: APPROVAL_PROJECTION_BASE_ID })
    expect(res.status).toBe(200)
    // base_apr_projection is a shared, singleton system base — other real-DB spec files provision and
    // clean up their own sheets in it, so this asserts no-leak of THIS test's two sheets specifically
    // (not "sheets is empty", which would be fragile against unrelated concurrent/leftover fixtures).
    const ids = (res.body.data.sheets as Array<{ id: string; name: string }>).map((s) => s.id)
    const names = (res.body.data.sheets as Array<{ name: string }>).map((s) => s.name)
    expect(ids).not.toContain(SHEET_A)
    expect(ids).not.toContain(SHEET_B)
    expect(names).not.toContain('C1 Template A')
    expect(names).not.toContain('C1 Template B')
    expect(JSON.stringify(res.body)).not.toContain(SHEET_A)
    expect(JSON.stringify(res.body)).not.toContain(SHEET_B)
    // KNOWN, DEFERRED GAP (repro §6.1, NOT fixed by this PR — scoped to the SHEET-level gate only):
    // the base's own metadata is still returned verbatim to a viewer who merely holds global
    // multitable:read; only the sheet-level fields above are closed by this fix. Narrowing base-level
    // metadata needs the same entitled-vs-fenced differential at BASE granularity (there is no
    // base-level readability filter today) — pinned here explicitly so the gap stays visible in the
    // suite, not silently covered by the sheets[] assertions above (which DO fully close the
    // sheet-metadata leak).
    expect(res.body.data.base?.id).toBe(APPROVAL_PROJECTION_BASE_ID)
    expect(res.body.data.base?.name).toBe('Approval Records (system)')
  })

  test('CHARACTERIZATION (pre-existing, out of scope for this PR): a REAL business participant (their id really is requester_snapshot.id on the reconciled instance) is currently 404\'d too against REAL reconcile() output — a separately tracked, pre-existing gap, not this PR\'s regression', async () => {
    currentUser = { id: PARTICIPANT_ID, perms: ['multitable:read'] }
    const res = await contextRequest({ sheetId: SHEET_A })
    // If/when the shared predicate's participant-recognition gap is fixed elsewhere, this
    // characterization is expected to flip to 200 — that is a DIFFERENT, already-tracked line, not this
    // PR's regression.
    expect(res.status).toBe(404)
  })

  test('WIRING positive control: when the shared predicate DOES report participant status, /context defers to it and returns 200 with the read-only projection capability set (not a locally reimplemented judgment)', async () => {
    // Seeded in whatever shape the shared predicate (loadApprovalProjectionParticipantSheetIds) itself
    // currently reads — same convention as approval-projection-participant-read.db.test.ts's own
    // fixtures, and NOT necessarily what production reconcile() writes today (see the characterization
    // test above). This isolates "does /context's NEW wiring correctly obey the shared resolver" from
    // "is the shared resolver's own predicate correct on real data" — two different questions, only the
    // first is this PR's claim.
    const wiredParticipant = `u_c1_wired_participant_${TS}`
    const rawRecordId = `rec_c1_raw_${TS}`
    await q(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by)
       VALUES ($1,$2,$3::jsonb,1,'system:approval-projection','system:approval-projection')`,
      [rawRecordId, SHEET_B, JSON.stringify({ status: 'approved', requesterId: wiredParticipant, approverId: 'someone_else' })],
    )
    try {
      currentUser = { id: wiredParticipant, perms: ['multitable:read'] }
      const res = await contextRequest({ sheetId: SHEET_B })
      expect(res.status).toBe(200)
      expect(res.body.data.sheet?.id).toBe(SHEET_B)
      expect(res.body.data.capabilities).toMatchObject({
        canRead: true,
        canExport: true,
        canCreateRecord: false,
        canEditRecord: false,
        canDeleteRecord: false,
        canManageFields: false,
        canManageSheetAccess: false,
        canManageViews: false,
        canManageAutomation: false,
        canSendNotification: false,
      })
      // The sibling sheet (SHEET_A, where this actor has no row at all) stays hidden from the list —
      // participant status is per-sheet, not per-base. (See the note above the previous test on why
      // this checks no-leak of THIS test's own sheet rather than exact-list equality.)
      const ids = (res.body.data.sheets as Array<{ id: string }>).map((s) => s.id)
      expect(ids).toContain(SHEET_B)
      expect(ids).not.toContain(SHEET_A)
    } finally {
      await q(`DELETE FROM meta_records WHERE id = $1`, [rawRecordId]).catch(() => {})
    }
  })

  test('CAPABILITY-PLANE discriminator: a WRITER participant (multitable:write + workflow:write, and a genuine row on this sheet) still gets zero write/manage capability from /context — the fence applies to the returned capability booleans, not only to the readability gate', async () => {
    // Distinguishes "capabilities came from the fenced resolver" from "capabilities came from the old
    // applyContextSheetSchemaWriteGrant(baseCapabilities,...) path": that path grants
    // canEditRecord/canManageAutomation/etc from bare multitable:write + workflow:write for a
    // system sheet with no sheet-scoped assignments, regardless of the projection fence — only
    // resolveSheetCapabilitiesForAccess's restrictApprovalProjectionCapabilitiesPerRow forces it back
    // to false. A non-participant already gets 404 before any capabilities are computed (proven
    // above), so this needs a real WRITER PARTICIPANT to exercise the capability-plane fence at all.
    const writerParticipant = `u_c1_writer_participant_${TS}`
    const rawRecordId = `rec_c1_writer_${TS}`
    await q(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by)
       VALUES ($1,$2,$3::jsonb,1,'system:approval-projection','system:approval-projection')`,
      [rawRecordId, SHEET_B, JSON.stringify({ status: 'approved', requesterId: writerParticipant, approverId: 'someone_else' })],
    )
    try {
      currentUser = { id: writerParticipant, perms: ['multitable:write', 'workflow:write'] }
      const res = await contextRequest({ sheetId: SHEET_B })
      expect(res.status).toBe(200)
      expect(res.body.data.capabilities).toMatchObject({
        canRead: true,
        canExport: true,
        canCreateRecord: false,
        canEditRecord: false,
        canDeleteRecord: false,
        canManageFields: false,
        canManageSheetAccess: false,
        canManageViews: false,
        canManageAutomation: false,
        canSendNotification: false,
      })
    } finally {
      await q(`DELETE FROM meta_records WHERE id = $1`, [rawRecordId]).catch(() => {})
    }
  })

  test('admin still gets 200 on the projection sheet (unaffected by the fence, unaffected by this fix)', async () => {
    currentUser = { id: ADMIN_ID, roles: ['admin'] }
    const res = await contextRequest({ sheetId: SHEET_A })
    expect(res.status).toBe(200)
    expect(res.body.data.sheet?.id).toBe(SHEET_A)
    expect(res.body.data.capabilities.canRead).toBe(true)
  })

  test('ZERO BEHAVIOR CHANGE: an ordinary sheet\'s /context response is byte-identical to the fixed pre-change shape (hand-typed, not derived from the new code)', async () => {
    currentUser = { id: NONPART_ID, perms: ['multitable:read'] }
    const res = await contextRequest({ sheetId: ORD_SHEET })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      data: {
        base: {
          id: ORD_BASE,
          name: 'C1 Ordinary',
          icon: 'table',
          color: '#1677ff',
          ownerId: NONPART_ID,
          workspaceId: null,
        },
        sheet: {
          id: ORD_SHEET,
          baseId: ORD_BASE,
          name: 'C1 Ordinary Sheet',
          description: null,
        },
        sheets: [
          {
            id: ORD_SHEET,
            baseId: ORD_BASE,
            name: 'C1 Ordinary Sheet',
            description: null,
          },
        ],
        views: [
          {
            id: ORD_VIEW,
            sheetId: ORD_SHEET,
            name: 'Grid',
            type: 'grid',
            filterInfo: {},
            sortInfo: {},
            groupInfo: {},
            hiddenFieldIds: [],
            config: {},
          },
        ],
        personalOverrideViewIds: [],
        // Bare multitable:read (no write, no sheet-scoped grant) ⇒ readOnly on every field
        // (deriveFieldPermissions: readOnly = !capabilities.canEditRecord).
        fieldPermissions: {
          [ORD_FIELD]: { visible: true, readOnly: true },
        },
        viewPermissions: {
          [ORD_VIEW]: { canAccess: true, canConfigure: false, canDelete: false },
        },
        capabilities: {
          canRead: true,
          canCreateRecord: false,
          canEditRecord: false,
          canDeleteRecord: false,
          canManageFields: false,
          canManageSheetAccess: false,
          canManageViews: false,
          canComment: false,
          canManageAutomation: false,
          canSendNotification: false,
          canExport: true,
          pitResetEnabled: false,
          sheetRevertEnabled: false,
          personalViewsEnabled: false,
          canDeleteSheet: false,
        },
        capabilityOrigin: { source: 'global-rbac', hasSheetAssignments: false },
      },
    })
  })
})
