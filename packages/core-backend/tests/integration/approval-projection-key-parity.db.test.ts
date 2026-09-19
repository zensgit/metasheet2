/**
 * Approval-projection PARTICIPANT KEY PARITY — real reconcile output, four consumer surfaces.
 *
 * THE DEFECT THIS LOCKS: the projection WRITER (`ApprovalRecordProjectionService.buildRecordData`,
 * `approval-record-projection-service.ts`) namespaces every column by the row's OWN sheet id —
 * `deriveProjectionFieldId(sheetId, columnKey)` = `${sheetId}__${columnKey}` — because one
 * projection BASE holds one sheet PER TEMPLATE FAMILY. But the shared READ consumers
 * (`permission-service.ts`'s participant carve-out + both per-row deny arms, and
 * `sheet-capabilities.ts`'s own copy) used to compare against the BARE column name
 * (`data->>'requesterId'`), a key the writer never stores a row under. The read path matched
 * NOTHING `reconcile()` actually writes: every genuine participant (requester / decider) was
 * excluded from their own approval-projection rows — fail-CLOSED (over-strict), not a leak, but
 * the whole per-row participant feature was dead for every non-admin. Fixed by moving the key
 * derivation + a single shared SQL predicate into the side-effect-free
 * `approval-projection-constants.ts`, which both the writer (via re-export) and every reader now
 * derive from.
 *
 * WHY THIS FILE EXISTS ALONGSIDE THE SIBLING `approval-projection-participant-read.db.test.ts`:
 * that suite hand-seeds `meta_records` rows directly (necessarily so — two of its fixtures are
 * synthetic edge shapes `reconcile()` can never be made to produce: a corrupt row with NO
 * participant fields at all, and a completely unrelated stranger's row). This suite instead drives
 * the REAL production chain — `ApprovalProductService.createApproval` (create hook → reconcile) and
 * `.dispatchAction('approve', …)` (completion event → reconcile) — so the row shapes asserted
 * against are BY CONSTRUCTION whatever production actually writes; they cannot drift from it. A
 * predicate that regresses to reading a bare key can never make this suite silently pass, because
 * nothing here ever inserts a bare-keyed row.
 *
 * FOUR SURFACES asserted to route through the ONE shared predicate
 * (`approvalProjectionParticipantPredicateSql` in `approval-projection-constants.ts`):
 *   1. ENTRY LISTING     — GET /api/multitable/sheets (→ `filterReadableSheetRowsForAccess` →
 *                           `loadApprovalProjectionParticipantSheetIds`, permission-service.ts).
 *   2. ROW READ          — `requireRecordReadable` (univer-meta.ts), which row-filters via
 *                           `loadRecordPermissionScopeMap` → `loadApprovalProjectionDeniedRecordIds`'s
 *                           BOUNDED arm (recordIds present).
 *   3. EXPORT            — GET /api/multitable/sheets/:sheetId/export-xlsx?format=csv, which
 *                           row-filters via `loadDeniedRecordIds` → the SAME function's UNBOUNDED
 *                           arm (no recordIds).
 *   4. Yjs/API-TOKEN CHOKE — `resolveSheetCapabilitiesForUser` (sheet-capabilities.ts), which has
 *                           its OWN independent inline copy of the predicate (not a call into
 *                           permission-service.ts) — the second hand-rolled copy the fix collapsed.
 *
 * `GET /api/multitable/context` is DELIBERATELY OMITTED from the "surfaces this fix reaches" list —
 * this key-derivation fix (namespacing the predicate's key comparison) never touched /context, which
 * at THIS commit (7c73f5276) still applied no projection predicate there at all: a separate,
 * already-confirmed defect (`docs`/memory `finding_context_endpoint_skips_projection_fence.md`), with
 * its own in-flight fix on branch `fix/multitable-context-fenced-capabilities`.
 *
 * REBASE ABSORPTION: that /context branch has since rebased onto this commit and wires /context
 * through the SAME canonical predicate this file locks (`filterReadableSheetRowsForAccess` /
 * `resolveSheetCapabilitiesForAccess`, permission-service.ts — no private copy). On a worktree that
 * has absorbed both, /context is NO LONGER vacuous: it is a FIFTH consumer surface, and the dedicated
 * test below now asserts the real, no-longer-vacuous behavior — see that test's own comment for the
 * updated claim. This file's own scope is unchanged: it still locks the namespaced-key fix, not the
 * /context fence itself (that fence's own acceptance lives in
 * `multitable-context-approval-projection-fence-realdb.test.ts`).
 *
 * FIXTURE SHAPE (one template, ONE assignee P1, three instances on the SAME projection sheet — a
 * template's projection sheet id is deterministic per templateId, `deriveProjectionSheetId`):
 *   I1 — requester R1, approved by P1 (terminal: requesterId=R1, approverId=P1)
 *   I2 — requester R2, approved by P1 (terminal: requesterId=R2, approverId=P1)
 *   I3 — requester R3, left PENDING  (requesterId=R3, approverId='' — never decided)
 * This gives, in ONE fixture: a requester-only participant (R1, and per-row control against I2/I3),
 * a decider-only participant who is NOT the requester of anything they decide (P1, participant on
 * I1+I2, and per-row control against I3 — P1 is not yet anyone's decider there, and I3's
 * `approverId` is the EMPTY STRING, which must never match a real user id), and a genuine
 * non-participant (STRANGER, ordinary `multitable:read`, participates in nothing) whose exclusion
 * on every surface is the anti-widening control — this bug is fail-closed, so STRANGER's results
 * must be IDENTICAL before and after the fix (asserted directly against the pre-fix build in the
 * mutation-grid report, not in this file).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Request } from 'express'
import express, { type Express } from 'express'
import request from 'supertest'

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  ApprovalRecordProjectionService,
  APPROVAL_PROJECTION_BASE_ID,
  deriveProjectionFieldId,
  deriveProjectionRecordId,
  deriveProjectionSheetId,
  setApprovalRecordProjectionServiceForTests,
} from '../../src/multitable/approval-record-projection-service'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { eventBus as integrationEventBus } from '../../src/integration/events/event-bus'
import { requireRecordReadable, univerMetaRouter } from '../../src/routes/univer-meta'
import { resolveSheetCapabilitiesForUser } from '../../src/multitable/sheet-capabilities'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

// Non-negotiable rule #3 (CI wiring): module-top-level anti-skip-green sentinel, OUTSIDE
// `describeIfDatabase`, copied in shape from tests/integration/approval-can-decide-current-node.db.test.ts.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const TS = Date.now()
const R1 = `u_pkp_r1_${TS}`
const R2 = `u_pkp_r2_${TS}`
const R3 = `u_pkp_r3_${TS}`
const P1 = `u_pkp_p1_${TS}`
const STRANGER = `u_pkp_stranger_${TS}`
const ADMIN = `u_pkp_admin_${TS}`

const q = (sqlText: string, params?: unknown[]) => poolManager.get().query(sqlText, params)

let approvals: ApprovalProductService
let projection: ApprovalRecordProjectionService
let templateId = ''
let sheetId = ''
let i1 = ''
let i2 = ''
let i3 = ''

function templateRequest() {
  return {
    key: `pkp-${TS}`,
    name: 'Key Parity Template',
    formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
    approvalGraph: {
      nodes: [
        { key: 'start', type: 'start', name: 'Start', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          name: 'Approver',
          config: { assigneeType: 'user', assigneeIds: [P1], approvalMode: 'single' },
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

async function createAsRequester(requesterId: string): Promise<string> {
  const dto = await approvals.createApproval(
    { templateId, formData: { summary: 's' } } as never,
    { userId: requesterId, userName: requesterId } as never,
  )
  return (dto as { id: string }).id
}

async function getRecordData(instanceId: string): Promise<Record<string, unknown> | null> {
  const r = await q('SELECT data FROM meta_records WHERE id = $1', [deriveProjectionRecordId(instanceId)])
  return (r.rows[0] as { data: Record<string, unknown> } | undefined)?.data ?? null
}

function col(data: Record<string, unknown>, key: string): string {
  const value = data[deriveProjectionFieldId(sheetId, key)]
  return typeof value === 'string' ? value : ''
}

async function waitForProjectedStatus(instanceId: string, expected: string, timeoutMs = 6000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const data = await getRecordData(instanceId)
    if (data && col(data, 'status') === expected) return data
    if (Date.now() > deadline) return data ?? {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const reqOf = (userId: string, extra: Record<string, unknown> = {}): Request =>
  ({ user: { id: userId, ...extra } }) as unknown as Request

let app: Express
let currentUserId = ''
let currentIsAdmin = false

const asUser = (userId: string, isAdmin = false) => {
  currentUserId = userId
  currentIsAdmin = isAdmin
}

describeIfDatabase('approval-projection key parity — real reconcile output, four surfaces', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as unknown as { user?: unknown }).user = currentUserId
        ? { id: currentUserId, roles: currentIsAdmin ? ['admin'] : [], perms: currentIsAdmin ? [] : ['multitable:read'] }
        : undefined
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q(
      `INSERT INTO permissions (code, name, description)
       VALUES ('approvals:read','Approvals Read','pkp'),('approvals:write','Approvals Write','pkp'),('approvals:act','Approvals Act','pkp')
       ON CONFLICT (code) DO NOTHING`,
    )
    for (const uid of [R1, R2, R3, P1]) {
      await q(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
         ON CONFLICT (id) DO UPDATE SET is_active = TRUE`,
        [uid, `${uid}@pkp.test`],
      )
    }
    for (const uid of [R1, R2, R3]) {
      await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'approvals:write') ON CONFLICT DO NOTHING`, [uid])
      // createApproval 422s (APPROVAL_ORG_UNRESOLVED) without exactly one active org membership.
      await q(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, 'default', TRUE) ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = TRUE`, [uid])
    }
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'approvals:act') ON CONFLICT DO NOTHING`, [P1])
    // The Yjs/OAPI choke (resolveSheetCapabilitiesForUser) derives base capabilities from RBAC
    // `user_permissions`, not from a req mock — the projection participant restriction only ever
    // DOWNGRADES capabilities, so `canRead` needs the ordinary `multitable:read` grant underneath
    // it for R1/P1 (matching what an HTTP request with `perms: ['multitable:read']` supplies on
    // the other three surfaces).
    for (const uid of [R1, P1, STRANGER]) {
      await q(`INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
               VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
               ON CONFLICT (id) DO UPDATE SET is_active = TRUE`, [uid, `${uid}@pkp.test`])
      await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'multitable:read') ON CONFLICT DO NOTHING`, [uid])
    }
    // resolveSheetCapabilitiesForUser resolves admin via isAdmin(userId) -> `user_roles`, not from a
    // req mock — a real `user_roles` row is required for the site-4 admin assertion to be real
    // (not merely unlabeled-because-untested).
    await q(`INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
             VALUES ($1, $2, $1, 'x', 'admin', '[]'::jsonb, TRUE, TRUE)
             ON CONFLICT (id) DO UPDATE SET is_active = TRUE`, [ADMIN, `${ADMIN}@pkp.test`])
    await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`, [ADMIN])

    approvals = new ApprovalProductService()
    const created = await approvals.createTemplate(templateRequest() as never)
    templateId = (created as { id: string }).id
    await approvals.publishTemplate(templateId, { policy: { allowRevoke: true } } as never)
    sheetId = deriveProjectionSheetId(templateId)

    // The projection service is the module singleton the create hook uses — wire the SAME instance
    // to the completion bus so the terminal reconcile (approve) actually fires in this process.
    projection = new ApprovalRecordProjectionService()
    setApprovalRecordProjectionServiceForTests(projection)
    projection.subscribe(integrationEventBus)

    i1 = await createAsRequester(R1)
    i2 = await createAsRequester(R2)
    i3 = await createAsRequester(R3) // left pending — P1 never decides this one

    await approvals.dispatchAction(i1, { action: 'approve', comment: 'ok' } as never, { userId: P1, userName: P1 } as never)
    await waitForProjectedStatus(i1, 'approved')
    await approvals.dispatchAction(i2, { action: 'approve', comment: 'ok' } as never, { userId: P1, userName: P1 } as never)
    await waitForProjectedStatus(i2, 'approved')
  })

  afterAll(async () => {
    try { projection?.unsubscribe(integrationEventBus) } catch { /* noop */ }
    setApprovalRecordProjectionServiceForTests(null)
    const instanceIds = [i1, i2, i3].filter(Boolean)
    for (const id of instanceIds) {
      await q('DELETE FROM approval_record_projection WHERE instance_id = $1', [id]).catch(() => {})
      await q('DELETE FROM approval_assignments WHERE instance_id = $1', [id]).catch(() => {})
      await q('DELETE FROM approval_records WHERE instance_id = $1', [id]).catch(() => {})
      await q('DELETE FROM approval_instances WHERE id = $1', [id]).catch(() => {})
    }
    if (sheetId) {
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheetId]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [sheetId]).catch(() => {})
    }
    if (templateId) await q('DELETE FROM approval_templates WHERE id = $1', [templateId]).catch(() => {})
    await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[R1, R2, R3, P1, STRANGER]]).catch(() => {})
    await q('DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [[R1, R2, R3]]).catch(() => {})
    await q('DELETE FROM user_roles WHERE user_id = $1', [ADMIN]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[R1, R2, R3, P1, STRANGER, ADMIN]]).catch(() => {})
  })

  it('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  it('setup sanity: reconcile wrote NAMESPACED keys (not bare) — the shape this whole suite depends on', async () => {
    const d1 = await getRecordData(i1)
    expect(d1).toBeTruthy()
    // The bare key must be ABSENT — this is the exact shape the pre-fix predicate matched against
    // and that reconcile() never actually writes.
    expect(Object.prototype.hasOwnProperty.call(d1, 'requesterId')).toBe(false)
    expect(col(d1!, 'requesterId')).toBe(R1)
    expect(col(d1!, 'approverId')).toBe(P1)
    const d3 = await getRecordData(i3)
    expect(col(d3!, 'requesterId')).toBe(R3)
    expect(col(d3!, 'approverId')).toBe('') // pending — never decided
  })

  // ── 1. ENTRY LISTING (GET /api/multitable/sheets) ──────────────────────────────────────────

  it('ENTRY LISTING: requester participant (R1) sees the projection sheet', async () => {
    asUser(R1)
    const res = await request(app).get('/api/multitable/sheets')
    expect(res.status).toBe(200)
    expect((res.body.data.sheets as Array<{ id: string }>).some((s) => s.id === sheetId)).toBe(true)
  })

  it('ENTRY LISTING: decider participant (P1) sees the projection sheet', async () => {
    asUser(P1)
    const res = await request(app).get('/api/multitable/sheets')
    expect(res.status).toBe(200)
    expect((res.body.data.sheets as Array<{ id: string }>).some((s) => s.id === sheetId)).toBe(true)
  })

  it('ENTRY LISTING: non-participant STRANGER is excluded (anti-widening control)', async () => {
    asUser(STRANGER)
    const res = await request(app).get('/api/multitable/sheets')
    expect(res.status).toBe(200)
    expect((res.body.data.sheets as Array<{ id: string }>).some((s) => s.id === sheetId)).toBe(false)
  })

  it('ENTRY LISTING: admin sees the projection sheet unconditionally', async () => {
    asUser(ADMIN, true)
    const res = await request(app).get('/api/multitable/sheets')
    expect(res.status).toBe(200)
    expect((res.body.data.sheets as Array<{ id: string }>).some((s) => s.id === sheetId)).toBe(true)
  })

  // ── 2. ROW READ (requireRecordReadable — the shared record-addressed gate) ────────────────

  it('ROW READ: requester R1 reads own row, denied on both sibling instances (per-row control)', async () => {
    const req = reqOf(R1, { perms: ['multitable:read'] })
    const own = await requireRecordReadable(req, q, sheetId, deriveProjectionRecordId(i1))
    expect('status' in own).toBe(false)
    const other1 = await requireRecordReadable(req, q, sheetId, deriveProjectionRecordId(i2))
    expect('status' in other1 && (other1 as { status: number }).status).toBe(403)
    const other2 = await requireRecordReadable(req, q, sheetId, deriveProjectionRecordId(i3))
    expect('status' in other2 && (other2 as { status: number }).status).toBe(403)
  })

  // P1's denial on I3 is NOT isolated proof that an empty approverId can never match (I3's
  // requesterId is R3, so P1 also fails that arm) — the sibling suite's
  // `loadApprovalProjectionParticipantSheetIds(..., '')).size).toBe(0)` assertion is what actually
  // isolates the empty-string-never-matches property. This test's claim is only the per-row control.
  it('ROW READ: decider P1 reads rows they decided (I1,I2), denied on the undecided sibling I3 (per-row control)', async () => {
    const req = reqOf(P1, { perms: ['multitable:read'] })
    const decided1 = await requireRecordReadable(req, q, sheetId, deriveProjectionRecordId(i1))
    expect('status' in decided1).toBe(false)
    const decided2 = await requireRecordReadable(req, q, sheetId, deriveProjectionRecordId(i2))
    expect('status' in decided2).toBe(false)
    const pending = await requireRecordReadable(req, q, sheetId, deriveProjectionRecordId(i3))
    expect('status' in pending && (pending as { status: number }).status).toBe(403)
  })

  it('ROW READ: non-participant STRANGER denied on every row (anti-widening control)', async () => {
    const req = reqOf(STRANGER, { perms: ['multitable:read'] })
    for (const instanceId of [i1, i2, i3]) {
      const result = await requireRecordReadable(req, q, sheetId, deriveProjectionRecordId(instanceId))
      expect('status' in result && (result as { status: number }).status).toBe(403)
    }
  })

  it('ROW READ: admin reads every row unconditionally', async () => {
    const req = reqOf(ADMIN, { roles: ['admin'] })
    for (const instanceId of [i1, i2, i3]) {
      const result = await requireRecordReadable(req, q, sheetId, deriveProjectionRecordId(instanceId))
      expect('status' in result).toBe(false)
    }
  })

  // ── 3. EXPORT (GET /sheets/:sheetId/export-xlsx?format=csv — the unbounded deny arm) ──────

  it('EXPORT: requester R1 export contains only their own row', async () => {
    asUser(R1)
    const res = await request(app).get(`/api/multitable/sheets/${sheetId}/export-xlsx`).query({ format: 'csv' })
    expect(res.status).toBe(200)
    const body = res.text
    expect(body).toContain(R1)
    expect(body).not.toContain(R2)
    expect(body).not.toContain(R3)
  })

  it('EXPORT: decider P1 export contains both rows they decided, not the undecided one', async () => {
    asUser(P1)
    const res = await request(app).get(`/api/multitable/sheets/${sheetId}/export-xlsx`).query({ format: 'csv' })
    expect(res.status).toBe(200)
    const body = res.text
    expect(body).toContain(R1)
    expect(body).toContain(R2)
    expect(body).not.toContain(R3)
  })

  it('EXPORT: non-participant STRANGER is forbidden (anti-widening control)', async () => {
    asUser(STRANGER)
    const res = await request(app).get(`/api/multitable/sheets/${sheetId}/export-xlsx`).query({ format: 'csv' })
    expect(res.status).toBe(403)
  })

  it('EXPORT: admin export contains every row', async () => {
    asUser(ADMIN, true)
    const res = await request(app).get(`/api/multitable/sheets/${sheetId}/export-xlsx`).query({ format: 'csv' })
    expect(res.status).toBe(200)
    const body = res.text
    expect(body).toContain(R1)
    expect(body).toContain(R2)
    expect(body).toContain(R3)
  })

  // ── 4. Yjs / API-token CHOKE (sheet-capabilities.ts's OWN copy of the predicate) ───────────

  it('SHEET-CAPABILITIES CHOKE (site 4): requester + decider get canRead, stranger does not, admin unaffected', async () => {
    const r1 = await resolveSheetCapabilitiesForUser(q, sheetId, R1)
    expect(r1.capabilities.canRead).toBe(true)
    const p1 = await resolveSheetCapabilitiesForUser(q, sheetId, P1)
    expect(p1.capabilities.canRead).toBe(true)
    const stranger = await resolveSheetCapabilitiesForUser(q, sheetId, STRANGER)
    expect(stranger.capabilities.canRead).toBe(false)
    // resolveSheetCapabilitiesForUser resolves admin via isAdmin(userId) -> `user_roles` (never a
    // req mock) — ADMIN carries a real `user_roles` row (beforeAll) so this is a genuine admin-path
    // assertion, not merely an unlabeled gap in the test name.
    const admin = await resolveSheetCapabilitiesForUser(q, sheetId, ADMIN)
    expect(admin.isAdminRole).toBe(true)
    expect(admin.capabilities.canRead).toBe(true)
  })

  // ── /context: no longer vacuous (C1 merged) — participant 200, non-participant 404 ───────

  it('/context: absorbs the C1 fence (fix/multitable-context-fenced-capabilities, rebased onto this commit) — participant still 200, non-participant STRANGER gets the anti-oracle 404, not a leak', async () => {
    // HISTORY: at 7c73f5276 (this file's own commit) /context built its OWN `readableSheetRows` from
    // `canReadWithSheetGrant` only and never called `filterReadableSheetRowsForAccess` /
    // `loadApprovalProjectionSheetIds` — every actor with plain `multitable:read`, participant or
    // not, got 200. That was documented here as a VACUOUS control specifically so a future reader
    // would not mistake "200 for a participant" as evidence of THIS file's key-derivation fix.
    //
    // ABSORBED: the separate, already-confirmed /context defect that made it vacuous now has its fix
    // rebased onto this commit (`fix/multitable-context-fenced-capabilities`): /context routes
    // through the SAME canonical resolvers (`filterReadableSheetRowsForAccess` /
    // `resolveSheetCapabilitiesForAccess`, permission-service.ts — no private predicate copy in
    // univer-meta.ts) every other sheet-addressed route already uses. So on a worktree carrying both
    // fixes, /context is a genuine FIFTH consumer surface: a participant (R1) still reads 200, and
    // STRANGER — a genuine non-participant with only global `multitable:read`, proven excluded on
    // all four other surfaces above — now gets the byte-identical 404 anti-oracle
    // (`multitable-context-approval-projection-fence-realdb.test.ts` pins the same shape), not the
    // stale 200 this test used to assert. This is the negative control the task requires of /context:
    // a non-participant must still get 404 through it, never a leak.
    asUser(R1)
    const participantRes = await request(app).get('/api/multitable/context').query({ sheetId })
    expect(participantRes.status).toBe(200)
    expect(participantRes.body.data.sheet?.id).toBe(sheetId)

    asUser(STRANGER)
    const strangerRes = await request(app).get('/api/multitable/context').query({ sheetId })
    expect(strangerRes.status).toBe(404)
    expect(strangerRes.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
  })
})
