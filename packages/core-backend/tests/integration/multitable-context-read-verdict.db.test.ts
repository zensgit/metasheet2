/**
 * GET /api/multitable/context — the sheet read verdict, the sibling list and the capability block come
 * from the SHARED fenced resolvers (`resolveSheetCapabilitiesForAccess` / `filterReadableSheetRowsForAccess`
 * in multitable/permission-service.ts), the same ones GET /sheets, GET /bases and every other
 * sheet-addressed route use. Real PostgreSQL, real provisioning.
 *
 * THE RULE THIS FILE PINS
 *   - A sheet the shared resolver does not let the caller read answers EXACTLY like a sheet that does
 *     not exist answers that same caller: same status, same body bytes, no id echoed — whether it is
 *     addressed by sheet id or through one of its views, and whatever its liveness. For a caller whose
 *     global grants include read that is the shared values-free refusal from
 *     multitable/sheet-refusals.ts (captured from the helper itself, never hand-typed); for a caller who
 *     reads only through sheet grants it is the shared 403.
 *   - A system read-model base in which the caller can read no sheet answers exactly like an absent
 *     base.
 *   - The sibling list and the capability booleans follow the same verdict, whether the sheet is
 *     addressed or chosen from the base: a participant sees only the read-model sheets they participate
 *     in and only the read plane on them. The base form is never wider than the sheet form.
 *   - Authority still comes first: a caller with no read authority gets the shared 403, identical for a
 *     read-model sheet and an absent one.
 *   - Ordinary sheets answer byte-for-byte as before; sheet-scoped grant holders on their sheets, the
 *     stock-preparation overview clamp, admins and e-learning administrators of their own organisation
 *     keep their access.
 *
 * FIXTURES
 *   - approval read model: two template families provisioned through the real product path
 *     (ApprovalProductService.createTemplate / publishTemplate / createApproval → reconcile()), so two
 *     sibling read-model sheets exist; R1 is the requester on family A only, W1 (who also holds
 *     multitable:write) likewise; NONPART holds global multitable:read and participates in nothing.
 *   - e-learning read model: one organisation's base / sheet / mapping row in the migration's shape.
 *   - stock-preparation overview: one sheet with the derived-id shape and the overview kind.
 *   - ordinary base with a sheet, a field, a view, the People sentinel sheet, and a second base for
 *     the cross-base pairing control; a sheet-scoped grant holder on its own base.
 *
 * WIRING: DATABASE_URL-gated (describeIfDatabase) and excluded from the no-DB vitest config; run as a
 * whole file with EXPECT_DB=1 by .github/workflows/multitable-realdb-context-read-verdict.yml.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  ApprovalRecordProjectionService,
  APPROVAL_PROJECTION_BASE_ID,
  deriveProjectionSheetId,
  setApprovalRecordProjectionServiceForTests,
} from '../../src/multitable/approval-record-projection-service'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { eventBus as integrationEventBus } from '../../src/integration/events/event-bus'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import {
  deriveElearningProjectionBaseId,
  deriveElearningProjectionSheetId,
  ELEARNING_PROJECTION_SYSTEM_KIND,
  ELEARNING_PROJECTION_SYSTEM_OWNER,
} from '../../src/multitable/elearning-projection-constants'
import { STOCK_PREP_OVERVIEW_SHEET_KIND, SYSTEM_PEOPLE_SHEET_DESCRIPTION } from '../../src/multitable/system-sheet-predicate'
import { resolveSheetCapabilitiesForAccess } from '../../src/multitable/permission-service'
import { resolveMultitableBusinessTimezone } from '../../src/multitable/business-timezone'
import { isPersonalViewsEnabled } from '../../src/multitable/personal-view-config'
import {
  FORBIDDEN,
  FORBIDDEN_STATUS,
  SHEET_ABSENT_BODY,
  SHEET_DELETED_BODY,
  SHEET_NOT_LIVE_STATUS,
} from '../utils/sheet-existence-oracle'
import { usePinnedServer } from '../utils/pinned-server'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

// Module-top-level anti-skip-green sentinel, OUTSIDE describeIfDatabase.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const TS = Date.now()
const q = (sqlText: string, params?: unknown[]) => poolManager.get().query(sqlText, params)

// ── actors ────────────────────────────────────────────────────────────────────
const NONPART = `u_ctxv_nonpart_${TS}` // global multitable:read (user_permissions row), participates in nothing
const R1 = `u_ctxv_r1_${TS}` // requester on family A (multitable:read)
const W1 = `u_ctxv_w1_${TS}` // requester on family A (multitable:read + multitable:write)
const R2 = `u_ctxv_r2_${TS}` // requester on family B (no multitable grant)
const DECIDER = `u_ctxv_decider_${TS}`
const BARE = `u_ctxv_bare_${TS}` // zero multitable grants
const GRANTEE = `u_ctxv_grantee_${TS}` // zero global multitable grants; one sheet-scoped grant
const WRITER = `u_ctxv_writer_${TS}` // global multitable:read + multitable:write, participates in nothing
const ADMIN = `u_ctxv_admin_${TS}`
const OWNER = `u_ctxv_owner_${TS}` // owner id of the ordinary bases; never a caller

// ── ordinary fixtures ─────────────────────────────────────────────────────────
const ORD_BASE = `base_ctxv_ord_${TS}`
const ORD_SHEET = `sheet_ctxv_ord_${TS}`
const ORD_FIELD = `fld_ctxv_ord_${TS}`
const ORD_VIEW = `view_ctxv_ord_${TS}`
const PEOPLE_SHEET = `sheet_ctxv_people_${TS}`
const OTHER_BASE = `base_ctxv_other_${TS}`
const GRANT_BASE = `base_ctxv_grant_${TS}`
const GRANT_SHEET = `sheet_ctxv_grant_${TS}`

// ── stock-preparation overview (derived-id shape: sheet_ + 24 hex) ─────────────
const OVERVIEW_SHEET = `sheet_${(TS.toString(16) + '0'.repeat(24)).slice(0, 24)}`

// ── e-learning read model ─────────────────────────────────────────────────────
const EL_ORG = `org_ctxv_${TS}`
const EL_BASE = deriveElearningProjectionBaseId(EL_ORG)
const EL_SHEET = deriveElearningProjectionSheetId(EL_ORG)

// ── approval read model ───────────────────────────────────────────────────────
let approvals: ApprovalProductService
let projection: ApprovalRecordProjectionService
let templateA = ''
let templateB = ''
let SHEET_A = ''
let SHEET_B = ''
const VIEW_A = `view_ctxv_a_${TS}`
const VIEW_B = `view_ctxv_b_${TS}`
const instanceIds: string[] = []

// ── ids that do not exist ─────────────────────────────────────────────────────
const ABSENT_SHEET = `sheet_ctxv_absent_${TS}`
const ABSENT_VIEW = `view_ctxv_absent_${TS}`
const ABSENT_BASE = `base_ctxv_absent_${TS}`

type Caller = { user: Record<string, unknown>; tenant?: string } | null
let caller: Caller = null
const pinned = usePinnedServer()

/** DB-fallback identity: `req.user = { id }` only, grants come from user_permissions like a login. */
const asDbUser = (id: string): Caller => ({ user: { id } })
const asAdmin = (): Caller => ({ user: { id: ADMIN, roles: ['admin'], perms: [] } })

async function ctx(callerToUse: Caller, query: Record<string, string>) {
  caller = callerToUse
  const res = await request(pinned.url()).get('/api/multitable/context').query(query)
  return { status: res.status, body: res.body as any, text: res.text }
}

function templateRequest(key: string, name: string) {
  return {
    key,
    name,
    formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
    approvalGraph: {
      nodes: [
        { key: 'start', type: 'start', name: 'Start', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          name: 'Approver',
          config: { assigneeType: 'user', assigneeIds: [DECIDER], approvalMode: 'single' },
        },
        { key: 'end', type: 'end', name: 'End', config: {} },
      ],
      edges: [
        { key: 'e-start-a', source: 'start', target: 'approval_1' },
        { key: 'e-a-end', source: 'approval_1', target: 'end' },
      ],
    },
  }
}

async function createAsRequester(templateId: string, requesterId: string): Promise<string> {
  const dto = await approvals.createApproval(
    { templateId, formData: { summary: 's' } } as never,
    { userId: requesterId, userName: requesterId } as never,
  )
  const id = (dto as { id: string }).id
  instanceIds.push(id)
  return id
}

const WRITE_PLANE_KEYS = [
  'canCreateRecord',
  'canEditRecord',
  'canDeleteRecord',
  'canManageFields',
  'canManageSheetAccess',
  'canManageAutomation',
  'canSendNotification',
  'canComment',
  'canDeleteSheet',
  'canCopySheet',
] as const

describeIfDatabase('GET /context — sheet read verdict from the shared fenced resolver (real DB)', () => {
  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      if (caller) {
        ;(req as unknown as { user?: unknown }).user = caller.user
        if (caller.tenant) (req as unknown as { authenticatedTenantId?: string }).authenticatedTenantId = caller.tenant
      }
      next()
    })
    app.use('/api/multitable', univerMetaRouter())
    pinned.setApp(app)

    await q(
      `INSERT INTO permissions (code, name, description)
       VALUES ('approvals:read','Approvals Read','ctxv'),('approvals:write','Approvals Write','ctxv'),('approvals:act','Approvals Act','ctxv')
       ON CONFLICT (code) DO NOTHING`,
    )
    const grants: Array<[string, string[]]> = [
      [NONPART, ['multitable:read']],
      [R1, ['multitable:read', 'approvals:write']],
      [W1, ['multitable:read', 'multitable:write', 'approvals:write']],
      [R2, ['approvals:write']],
      [DECIDER, ['approvals:act']],
      [BARE, []],
      [GRANTEE, []],
      [WRITER, ['multitable:read', 'multitable:write']],
    ]
    for (const [uid, perms] of grants) {
      await q(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
         ON CONFLICT (id) DO UPDATE SET is_active = TRUE`,
        [uid, `${uid}@ctxv.test`],
      )
      for (const perm of perms) {
        await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [uid, perm])
      }
    }
    for (const uid of [R1, W1, R2]) {
      // createApproval needs exactly one active org membership for the requester.
      await q(
        `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, 'default', TRUE)
         ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = TRUE`,
        [uid],
      )
    }

    // Approval read model through the real product path.
    approvals = new ApprovalProductService()
    projection = new ApprovalRecordProjectionService()
    setApprovalRecordProjectionServiceForTests(projection)
    projection.subscribe(integrationEventBus)
    templateA = (await approvals.createTemplate(templateRequest(`ctxv-a-${TS}`, 'Ctxv Family A') as never) as { id: string }).id
    templateB = (await approvals.createTemplate(templateRequest(`ctxv-b-${TS}`, 'Ctxv Family B') as never) as { id: string }).id
    await approvals.publishTemplate(templateA, { policy: { allowRevoke: true } } as never)
    await approvals.publishTemplate(templateB, { policy: { allowRevoke: true } } as never)
    SHEET_A = deriveProjectionSheetId(templateA)
    SHEET_B = deriveProjectionSheetId(templateB)
    await createAsRequester(templateA, R1)
    await createAsRequester(templateA, W1)
    await createAsRequester(templateB, R2)
    await q(`INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1,$2,'Grid','grid')`, [VIEW_A, SHEET_A])
    await q(`INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1,$2,'Grid','grid')`, [VIEW_B, SHEET_B])

    // Ordinary fixtures.
    await q(`INSERT INTO meta_bases (id, name, icon, color, owner_id) VALUES ($1,'Ctxv Ordinary','table','#1677ff',$2)`, [ORD_BASE, OWNER])
    await q(`INSERT INTO meta_sheets (id, base_id, name, description) VALUES ($1,$2,'Ctxv Ordinary Sheet',NULL)`, [ORD_SHEET, ORD_BASE])
    await q(`INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,'Title','string','{}'::jsonb,0)`, [ORD_FIELD, ORD_SHEET])
    await q(`INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1,$2,'Grid','grid')`, [ORD_VIEW, ORD_SHEET])
    await q(`INSERT INTO meta_sheets (id, base_id, name, description) VALUES ($1,$2,'People',$3)`, [PEOPLE_SHEET, ORD_BASE, SYSTEM_PEOPLE_SHEET_DESCRIPTION])
    await q(`INSERT INTO meta_bases (id, name, icon, color, owner_id) VALUES ($1,'Ctxv Other','table','#1677ff',$2)`, [OTHER_BASE, OWNER])
    await q(`INSERT INTO meta_bases (id, name, icon, color, owner_id) VALUES ($1,'Ctxv Grant','table','#1677ff',$2)`, [GRANT_BASE, OWNER])
    await q(`INSERT INTO meta_sheets (id, base_id, name, description) VALUES ($1,$2,'Ctxv Grant Sheet',NULL)`, [GRANT_SHEET, GRANT_BASE])
    await q(
      `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,'user',$2,'spreadsheet:write')`,
      [GRANT_SHEET, GRANTEE],
    )
    await q(
      `INSERT INTO meta_sheets (id, base_id, name, description, system_kind) VALUES ($1,$2,'Ctxv Overview',NULL,$3)`,
      [OVERVIEW_SHEET, OTHER_BASE, STOCK_PREP_OVERVIEW_SHEET_KIND],
    )

    // E-learning read model, in the mapping migration's shape.
    await q(`INSERT INTO meta_bases (id, name, icon, color, owner_id) VALUES ($1,'Ctxv Learning','table','#1677ff',$2)`, [EL_BASE, ELEARNING_PROJECTION_SYSTEM_OWNER])
    await q(
      `INSERT INTO meta_sheets (id, base_id, name, description, system_kind) VALUES ($1,$2,'Ctxv Learning Sheet',NULL,$3)`,
      [EL_SHEET, EL_BASE, ELEARNING_PROJECTION_SYSTEM_KIND],
    )
    await q(
      `INSERT INTO elearning_stats_multitable_sheets (org_id, base_id, sheet_id) VALUES ($1,$2,$3)`,
      [EL_ORG, EL_BASE, EL_SHEET],
    )
  })

  afterAll(async () => {
    try { projection?.unsubscribe(integrationEventBus) } catch { /* noop */ }
    setApprovalRecordProjectionServiceForTests(null)
    for (const id of instanceIds) {
      await q('DELETE FROM approval_record_projection WHERE instance_id = $1', [id]).catch(() => {})
      await q('DELETE FROM approval_assignments WHERE instance_id = $1', [id]).catch(() => {})
      await q('DELETE FROM approval_records WHERE instance_id = $1', [id]).catch(() => {})
      await q('DELETE FROM approval_instances WHERE id = $1', [id]).catch(() => {})
    }
    const projectionSheets = [SHEET_A, SHEET_B].filter(Boolean)
    await q('DELETE FROM meta_views WHERE sheet_id = ANY($1::text[])', [[...projectionSheets, ORD_SHEET]]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [projectionSheets]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[...projectionSheets, ORD_SHEET]]).catch(() => {})
    await q('DELETE FROM elearning_stats_multitable_sheets WHERE org_id = $1', [EL_ORG]).catch(() => {})
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = ANY($1::text[])', [[GRANT_SHEET, SHEET_B].filter(Boolean)]).catch(() => {})
    await q(
      'DELETE FROM meta_sheets WHERE id = ANY($1::text[])',
      [[...projectionSheets, ORD_SHEET, PEOPLE_SHEET, GRANT_SHEET, OVERVIEW_SHEET, EL_SHEET]],
    ).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[ORD_BASE, OTHER_BASE, GRANT_BASE, EL_BASE]]).catch(() => {})
    for (const id of [templateA, templateB].filter(Boolean)) {
      await q('DELETE FROM approval_templates WHERE id = $1', [id]).catch(() => {})
    }
    const users = [NONPART, R1, W1, R2, DECIDER, BARE, GRANTEE, WRITER]
    await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [users]).catch(() => {})
    await q('DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [users]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [users]).catch(() => {})
  })

  it('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('fixture sanity: two sibling read-model sheets under the approval base, one row each per requester', async () => {
    const sheets = await q('SELECT id, base_id FROM meta_sheets WHERE id = ANY($1::text[])', [[SHEET_A, SHEET_B]])
    expect((sheets.rows as Array<{ id: string }>).map((r) => r.id).sort()).toEqual([SHEET_A, SHEET_B].sort())
    for (const row of sheets.rows as Array<{ base_id: string }>) expect(row.base_id).toBe(APPROVAL_PROJECTION_BASE_ID)
    const records = await q('SELECT sheet_id, count(*)::int AS n FROM meta_records WHERE sheet_id = ANY($1::text[]) GROUP BY sheet_id', [[SHEET_A, SHEET_B]])
    const bySheet = Object.fromEntries((records.rows as Array<{ sheet_id: string; n: number }>).map((r) => [r.sheet_id, r.n]))
    expect(bySheet[SHEET_A]).toBe(2)
    expect(bySheet[SHEET_B]).toBe(1)
  })

  // ── the refused sheet answers exactly like an absent one ─────────────────────────────────

  it('a read-model sheet the caller may not read answers byte-identically to an absent sheet', async () => {
    const refused = await ctx(asDbUser(NONPART), { sheetId: SHEET_A })
    const sibling = await ctx(asDbUser(NONPART), { sheetId: SHEET_B })
    const absent = await ctx(asDbUser(NONPART), { sheetId: ABSENT_SHEET })
    expect([absent.status, absent.body]).toEqual([SHEET_NOT_LIVE_STATUS, SHEET_ABSENT_BODY])
    expect(refused.status).toBe(absent.status)
    expect(refused.text).toBe(absent.text)
    expect(sibling.text).toBe(absent.text)
    expect(refused.text).not.toContain(SHEET_A)
    expect(refused.text).not.toContain('Ctxv Family')
  })

  it('the same answer when the refused sheet is addressed through one of its views', async () => {
    const refused = await ctx(asDbUser(NONPART), { viewId: VIEW_A })
    const absent = await ctx(asDbUser(NONPART), { viewId: ABSENT_VIEW })
    expect([absent.status, absent.body]).toEqual([SHEET_NOT_LIVE_STATUS, SHEET_ABSENT_BODY])
    expect(refused.status).toBe(absent.status)
    expect(refused.text).toBe(absent.text)
  })

  it('the refused verdict does not depend on the sheet’s liveness', async () => {
    await q('UPDATE meta_sheets SET deleted_at = now() WHERE id = $1', [SHEET_B])
    try {
      const refused = await ctx(asDbUser(NONPART), { sheetId: SHEET_B })
      const absent = await ctx(asDbUser(NONPART), { sheetId: ABSENT_SHEET })
      expect(refused.status).toBe(absent.status)
      expect(refused.text).toBe(absent.text)
      // Control: a caller who may read it still gets the liveness answer.
      const admin = await ctx(asAdmin(), { sheetId: SHEET_B })
      expect([admin.status, admin.body]).toEqual([SHEET_NOT_LIVE_STATUS, SHEET_DELETED_BODY])
    } finally {
      await q('UPDATE meta_sheets SET deleted_at = NULL WHERE id = $1', [SHEET_B])
    }
  })

  it('a participant is refused on a sibling family they do not participate in, like an absent sheet', async () => {
    const refused = await ctx(asDbUser(R1), { sheetId: SHEET_B })
    const absent = await ctx(asDbUser(R1), { sheetId: ABSENT_SHEET })
    expect(refused.status).toBe(absent.status)
    expect(refused.text).toBe(absent.text)
  })

  it('the approval read-model base answers like an absent base when the caller can read none of its sheets', async () => {
    const refused = await ctx(asDbUser(NONPART), { baseId: APPROVAL_PROJECTION_BASE_ID })
    const absent = await ctx(asDbUser(NONPART), { baseId: ABSENT_BASE })
    expect(absent.status).toBe(200)
    expect(absent.body.data.base).toBeNull()
    expect(absent.body.data.sheets).toEqual([])
    expect(refused.status).toBe(absent.status)
    expect(refused.body).toEqual(absent.body)
  })

  it('an e-learning read-model sheet and base answer like absent ones for a reader outside that organisation’s administrators', async () => {
    const refusedSheet = await ctx(asDbUser(NONPART), { sheetId: EL_SHEET })
    const absentSheet = await ctx(asDbUser(NONPART), { sheetId: ABSENT_SHEET })
    expect(refusedSheet.status).toBe(absentSheet.status)
    expect(refusedSheet.text).toBe(absentSheet.text)

    const refusedBase = await ctx(asDbUser(NONPART), { baseId: EL_BASE })
    const absentBase = await ctx(asDbUser(NONPART), { baseId: ABSENT_BASE })
    expect(refusedBase.status).toBe(absentBase.status)
    expect(refusedBase.body).toEqual(absentBase.body)

    // An e-learning administrator of ANOTHER organisation is refused the same way.
    const otherOrgAdmin: Caller = { user: { id: NONPART, perms: ['multitable:read', 'elearning:admin'] }, tenant: `${EL_ORG}_other` }
    const refusedOther = await ctx(otherOrgAdmin, { sheetId: EL_SHEET })
    const absentOther = await ctx(otherOrgAdmin, { sheetId: ABSENT_SHEET })
    expect(refusedOther.status).toBe(absentOther.status)
    expect(refusedOther.text).toBe(absentOther.text)
  })

  it('authority comes first: a caller with no read authority gets the same 403 for a read-model sheet and an absent one', async () => {
    const answers = []
    for (const sheetId of [SHEET_A, EL_SHEET, ABSENT_SHEET]) {
      const res = await ctx(asDbUser(BARE), { sheetId })
      answers.push([res.status, res.body])
    }
    expect(answers[0]).toEqual([FORBIDDEN_STATUS, FORBIDDEN])
    expect(answers[1]).toEqual(answers[0])
    expect(answers[2]).toEqual(answers[0])
  })

  // ── participants: their own sheet, the read plane only, no sibling ───────────────────────

  it('a participant reads their own read-model sheet; the sibling list and capabilities follow the shared verdict', async () => {
    const res = await ctx(asDbUser(R1), { sheetId: SHEET_A })
    expect(res.status, res.text).toBe(200)
    expect(res.body.data.sheet?.id).toBe(SHEET_A)
    expect(res.body.data.base?.id).toBe(APPROVAL_PROJECTION_BASE_ID)
    const ids = (res.body.data.sheets as Array<{ id: string }>).map((s) => s.id)
    expect(ids).toContain(SHEET_A)
    expect(ids).not.toContain(SHEET_B)
    expect(res.text).not.toContain('Ctxv Family B')
    expect(res.body.data.capabilities.canRead).toBe(true)
    expect(res.body.data.capabilities.canExport).toBe(true)
    for (const key of WRITE_PLANE_KEYS) expect(res.body.data.capabilities[key], key).toBe(false)
    // Through a view of their own sheet: the same sheet, readable.
    const viaView = await ctx(asDbUser(R1), { viewId: VIEW_A })
    expect(viaView.status, viaView.text).toBe(200)
    expect(viaView.body.data.sheet?.id).toBe(SHEET_A)
  })

  it('a participant addressing the read-model base sees only the sheets they participate in', async () => {
    const res = await ctx(asDbUser(R1), { baseId: APPROVAL_PROJECTION_BASE_ID })
    expect(res.status, res.text).toBe(200)
    expect(res.body.data.base?.id).toBe(APPROVAL_PROJECTION_BASE_ID)
    const ids = (res.body.data.sheets as Array<{ id: string }>).map((s) => s.id)
    expect(ids).toContain(SHEET_A)
    expect(ids).not.toContain(SHEET_B)
  })

  it('a participant who also holds multitable:write is advertised the read plane only — the capabilities the shared resolver gives', async () => {
    const res = await ctx(asDbUser(W1), { sheetId: SHEET_A })
    expect(res.status, res.text).toBe(200)
    const shared = await resolveSheetCapabilitiesForAccess(q as never, SHEET_A, {
      userId: W1,
      permissions: ['multitable:read', 'multitable:write', 'approvals:write'],
      isAdminRole: false,
    })
    for (const [key, value] of Object.entries(shared.capabilities)) {
      expect(res.body.data.capabilities[key], key).toBe(value)
    }
    expect(res.body.data.capabilities.canRead).toBe(true)
    for (const key of WRITE_PLANE_KEYS) expect(res.body.data.capabilities[key], key).toBe(false)
    expect(res.body.data.capabilities.canManageViews).toBe(false)
    // The same capabilities when the sheet is chosen from the base rather than addressed directly.
    const viaBase = await ctx(asDbUser(W1), { baseId: APPROVAL_PROJECTION_BASE_ID })
    expect(viaBase.status, viaBase.text).toBe(200)
    expect(viaBase.body.data.sheet?.id).toBe(SHEET_A)
    for (const [key, value] of Object.entries(shared.capabilities)) {
      expect(viaBase.body.data.capabilities[key], `viaBase ${key}`).toBe(value)
    }
    for (const key of WRITE_PLANE_KEYS) expect(viaBase.body.data.capabilities[key], `viaBase ${key}`).toBe(false)
  })

  // ── callers who can read keep their access ────────────────────────────────────────────

  it('an admin reads the read-model sheet with both siblings listed', async () => {
    const res = await ctx(asAdmin(), { sheetId: SHEET_A })
    expect(res.status, res.text).toBe(200)
    expect(res.body.data.sheet?.id).toBe(SHEET_A)
    const ids = (res.body.data.sheets as Array<{ id: string }>).map((s) => s.id)
    expect(ids).toEqual(expect.arrayContaining([SHEET_A, SHEET_B]))
    expect(res.body.data.capabilityOrigin).toEqual({ source: 'admin', hasSheetAssignments: false })
  })

  it('an e-learning administrator of the sheet’s organisation reads it with the read-model capability set', async () => {
    const elAdmin: Caller = { user: { id: NONPART, perms: ['multitable:read', 'elearning:admin'] }, tenant: EL_ORG }
    const res = await ctx(elAdmin, { sheetId: EL_SHEET })
    expect(res.status, res.text).toBe(200)
    expect(res.body.data.sheet?.id).toBe(EL_SHEET)
    expect(res.body.data.base?.id).toBe(EL_BASE)
    expect(res.body.data.capabilities.canRead).toBe(true)
    expect(res.body.data.capabilities.canExport).toBe(true)
    for (const key of WRITE_PLANE_KEYS) expect(res.body.data.capabilities[key], key).toBe(false)
    const viaBase = await ctx(elAdmin, { baseId: EL_BASE })
    expect(viaBase.status, viaBase.text).toBe(200)
    expect((viaBase.body.data.sheets as Array<{ id: string }>).map((s) => s.id)).toEqual([EL_SHEET])
    const shared = await resolveSheetCapabilitiesForAccess(q as never, EL_SHEET, {
      userId: NONPART,
      permissions: ['multitable:read', 'elearning:admin'],
      isAdminRole: false,
      authenticatedTenantId: EL_ORG,
    })
    expect(shared.capabilities.canRead).toBe(true)
    for (const [key, value] of Object.entries(shared.capabilities)) {
      expect(res.body.data.capabilities[key], key).toBe(value)
      expect(viaBase.body.data.capabilities[key], `viaBase ${key}`).toBe(value)
    }
  })

  it('the base form is no wider than the sheet form: an e-learning administrator without multitable read gets the shared 403 on both', async () => {
    const elAdminNoRead: Caller = { user: { id: NONPART, perms: ['elearning:admin'] }, tenant: EL_ORG }
    const answers = []
    for (const query of [{ sheetId: EL_SHEET }, { baseId: EL_BASE }, { sheetId: ABSENT_SHEET }]) {
      const res = await ctx(elAdminNoRead, query)
      answers.push([res.status, res.body])
    }
    expect(answers[0]).toEqual([FORBIDDEN_STATUS, FORBIDDEN])
    expect(answers[1]).toEqual(answers[0])
    expect(answers[2]).toEqual(answers[0])
  })

  it('the stock-preparation overview keeps its read-only clamp for a writer and for an admin', async () => {
    for (const who of [asDbUser(WRITER), asAdmin()]) {
      const res = await ctx(who, { sheetId: OVERVIEW_SHEET })
      expect(res.status, res.text).toBe(200)
      expect(res.body.data.sheet?.id).toBe(OVERVIEW_SHEET)
      expect(res.body.data.capabilities.canRead).toBe(true)
      expect(res.body.data.capabilities.canExport).toBe(true)
      for (const key of ['canCreateRecord', 'canEditRecord', 'canDeleteRecord', 'canManageFields', 'canManageViews', 'canManageAutomation', 'canComment']) {
        expect(res.body.data.capabilities[key], key).toBe(false)
      }
    }
  })

  it('a sheet-scoped grant holder with no global grant still reads their sheet', async () => {
    const res = await ctx(asDbUser(GRANTEE), { sheetId: GRANT_SHEET })
    expect(res.status, res.text).toBe(200)
    expect(res.body.data.sheet?.id).toBe(GRANT_SHEET)
    expect(res.body.data.capabilities.canRead).toBe(true)
    expect(res.body.data.capabilities.canEditRecord).toBe(true)
    expect(res.body.data.capabilities.canDeleteSheet).toBe(false)
    expect(res.body.data.capabilityOrigin).toEqual({ source: 'sheet-grant', hasSheetAssignments: true })
  })

  it('a caller who reads only through sheet grants gets their own absent answer for a read-model sheet they hold a grant on', async () => {
    await q(
      `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,'user',$2,'spreadsheet:read')`,
      [SHEET_B, GRANTEE],
    )
    try {
      const pairs: Array<[Record<string, string>, Record<string, string>]> = [
        [{ sheetId: SHEET_B }, { sheetId: ABSENT_SHEET }],
        [{ viewId: VIEW_B }, { viewId: ABSENT_VIEW }],
      ]
      for (const [refusedQuery, absentQuery] of pairs) {
        const refused = await ctx(asDbUser(GRANTEE), refusedQuery)
        const absent = await ctx(asDbUser(GRANTEE), absentQuery)
        expect([absent.status, absent.body]).toEqual([FORBIDDEN_STATUS, FORBIDDEN])
        expect(refused.status).toBe(absent.status)
        expect(refused.text).toBe(absent.text)
      }
    } finally {
      await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1 AND subject_id = $2', [SHEET_B, GRANTEE])
    }
    // Control: the same caller still gets the liveness answer on the ordinary sheet their grant names.
    await q('UPDATE meta_sheets SET deleted_at = now() WHERE id = $1', [GRANT_SHEET])
    try {
      const deleted = await ctx(asDbUser(GRANTEE), { sheetId: GRANT_SHEET })
      expect([deleted.status, deleted.body]).toEqual([SHEET_NOT_LIVE_STATUS, SHEET_DELETED_BODY])
    } finally {
      await q('UPDATE meta_sheets SET deleted_at = NULL WHERE id = $1', [GRANT_SHEET])
    }
  })

  it('refusals that are not about the read verdict keep their 403: the People sentinel sheet and a cross-base pairing', async () => {
    const people = await ctx(asDbUser(NONPART), { baseId: ORD_BASE, sheetId: PEOPLE_SHEET })
    expect([people.status, people.body]).toEqual([FORBIDDEN_STATUS, FORBIDDEN])
    const plain = await ctx(asDbUser(NONPART), { sheetId: ORD_SHEET })
    expect(plain.status).toBe(200)
    const mismatched = await ctx(asDbUser(NONPART), { baseId: OTHER_BASE, sheetId: ORD_SHEET })
    expect([mismatched.status, mismatched.body]).toEqual([FORBIDDEN_STATUS, FORBIDDEN])
  })

  it('an ordinary sheet’s response is unchanged, byte-for-byte', async () => {
    const res = await ctx(asDbUser(NONPART), { sheetId: ORD_SHEET })
    expect(res.status, res.text).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      data: {
        base: { id: ORD_BASE, name: 'Ctxv Ordinary', icon: 'table', color: '#1677ff', ownerId: OWNER, workspaceId: null },
        sheet: { id: ORD_SHEET, baseId: ORD_BASE, name: 'Ctxv Ordinary Sheet', description: null, copiedFrom: null },
        sheets: [{ id: ORD_SHEET, baseId: ORD_BASE, name: 'Ctxv Ordinary Sheet', description: null, copiedFrom: null }],
        views: [{
          id: ORD_VIEW,
          sheetId: ORD_SHEET,
          name: 'Grid',
          type: 'grid',
          filterInfo: {},
          sortInfo: {},
          groupInfo: {},
          hiddenFieldIds: [],
          config: {},
        }],
        personalOverrideViewIds: [],
        businessTimezone: resolveMultitableBusinessTimezone(),
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
          canSubmitApproval: false,
          canExport: true,
          pitResetEnabled: false,
          sheetRevertEnabled: false,
          personalViewsEnabled: isPersonalViewsEnabled(),
          canDeleteSheet: false,
          canCopySheet: false,
        },
        capabilityOrigin: { source: 'global-rbac', hasSheetAssignments: false },
        fieldPermissions: { [ORD_FIELD]: { visible: true, readOnly: true } },
        viewPermissions: { [ORD_VIEW]: { canAccess: true, canConfigure: false, canDelete: false } },
      },
    })
    // The base-addressed request selects the same sheet and lists the same siblings.
    const viaBase = await ctx(asDbUser(NONPART), { baseId: ORD_BASE })
    expect(viaBase.status, viaBase.text).toBe(200)
    expect(viaBase.body).toEqual(res.body)
  })
})
