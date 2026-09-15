import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'
import { deriveProjectionSheetId } from '../../src/multitable/approval-record-projection-service'
import { APPROVAL_PROJECTION_BASE_ID } from '../../src/multitable/approval-projection-constants'

/**
 * P3-2(a) — design-lock 2026-09-12 ("entry only; reuse the participant predicate; projection
 * form-content stays fenced behind O-4"). The approval detail response's `projectionEntry`
 * navigation handle, over REAL HTTP + REAL PostgreSQL.
 *
 * `tests/unit/approval-projection-entry.test.ts` covers the resolver function in isolation
 * (missing templateId/viewerId, no default view yet, the participant/view lookups throwing).
 * What ONLY a real database + a real HTTP round trip can prove:
 *
 *   - readability and projection-participancy are TWO DIFFERENT predicates that can diverge. The
 *     APPROVER below holds a real seat on the instance (S1 SEAT arm — `canReadApprovalInstance`
 *     admits them, 200) but is NOT yet a participant on the projection row, so `projectionEntry`
 *     is `null` — proving the field is not just an echo of "can this viewer see the approval at
 *     all";
 *   - the SAME instance, the SAME viewer, ONE fact changed (the projection row's `approverId` is
 *     updated to name them) flips `null` -> a handle — the positive control design-lock §3/B asks
 *     for, run against the REAL canonical predicate's REAL SQL (a join over `meta_sheets` +
 *     `meta_records`), not a stand-in;
 *   - the returned `viewId` is whatever this suite seeded as the sheet's (oldest) view row —
 *     nothing the client could have guessed or hardcoded;
 *   - a readable instance whose template has NO projection sheet materialized yet still returns
 *     `null`, not a 500 — the "reconcile hasn't run yet" case a live approval always starts in.
 *
 * Requires real PostgreSQL: the participant predicate's JOIN and the default-view lookup are
 * genuine SQL, not something a mocked pool can stand in for without re-implementing them.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const REQUESTER = `pe-req-${TS}`
const APPROVER = `pe-appr-${TS}`

// Top-level, NOT inside `describeIfDatabase` — a sentinel nested in a skipped describe skips
// WITH it (skip-green). An EXPECT_DB=1 lane failing to see DATABASE_URL must fail loudly instead
// of silently reporting zero tests as success (mirrors `approval-can-decide-current-node.db.test.ts`).
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

async function canListen(): Promise<boolean> {
  return await new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

async function tok(base: string, userId: string): Promise<string> {
  await grantApprovalWriteForIntegrationActor(userId)
  const res = await fetch(`${base}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`)
  return ((await res.json()) as { token: string }).token
}

async function req(base: string, path: string, token: string, opts: { method?: string; body?: unknown } = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
}

async function extractId(res: Response): Promise<string> {
  const body = (await res.json()) as { id?: string; data?: { id: string } }
  const id = body.id ?? body.data?.id
  if (!id) throw new Error(`no id in response: ${JSON.stringify(body)}`)
  return id
}

describeIfDatabase('approval detail projectionEntry (P3-2a) — real HTTP + real DB', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let requesterTok = ''
  let approverTok = ''
  let tid = ''
  let sheetId = ''
  const VIEW_ID = `view-pe-${TS}`

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    requesterTok = await tok(base, REQUESTER)
    approverTok = await tok(base, APPROVER)

    const graph = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          name: 'a',
          config: { assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }], approvalMode: 'single', emptyAssigneePolicy: 'error' },
        },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [{ key: 'e1', source: 'start', target: 'approval_1' }, { key: 'e2', source: 'approval_1', target: 'end' }],
    }
    const key = `pe-tpl-${TS}`
    const created = await req(base, '/api/approval-templates', requesterTok, {
      method: 'POST',
      body: {
        key,
        name: key,
        formSchema: { fields: [{ id: 'reason', type: 'text', label: '事由', required: true }] },
        approvalGraph: graph,
      },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    tid = ((await created.json()) as { id: string }).id
    const published = await req(base, `/api/approval-templates/${tid}/publish`, requesterTok, { method: 'POST', body: { policy: { allowRevoke: true } } })
    expect(published.status, await published.clone().text()).toBe(200)

    // Manually materialize the projection sheet + its default view, the way the real reconcile
    // pipeline eventually would (T36-1's own test does the same — see
    // `approval-projection-participant-read.db.test.ts`). Individual `meta_records` participant
    // rows are seeded PER TEST below, since that is exactly the fact under test.
    sheetId = deriveProjectionSheetId(tid)
    const pool = poolManager.get()
    await pool.query(
      `INSERT INTO meta_bases (id, name, icon, color, owner_id, workspace_id)
       VALUES ($1,'Approval Projection','','', 'system:approval-projection', NULL) ON CONFLICT (id) DO NOTHING`,
      [APPROVAL_PROJECTION_BASE_ID],
    )
    await pool.query(
      `INSERT INTO meta_sheets (id, base_id, name, description) VALUES ($1,$2,'ProjPE','') ON CONFLICT (id) DO NOTHING`,
      [sheetId, APPROVAL_PROJECTION_BASE_ID],
    )
    await pool.query(
      `INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1,$2,'Grid','grid') ON CONFLICT (id) DO NOTHING`,
      [VIEW_ID, sheetId],
    )
  })

  afterAll(async () => {
    try {
      const pool = poolManager.get()
      await pool.query(`DELETE FROM meta_records WHERE sheet_id = $1`, [sheetId]).catch(() => {})
      await pool.query(`DELETE FROM meta_views WHERE sheet_id = $1`, [sheetId]).catch(() => {})
      await pool.query(`DELETE FROM meta_sheets WHERE id = $1`, [sheetId]).catch(() => {})
      const tids = (await pool.query(`SELECT id FROM approval_templates WHERE key LIKE $1`, [`%-${TS}`])).rows.map((r) => r.id as string)
      if (tids.length > 0) {
        const iids = (await pool.query(`SELECT id FROM approval_instances WHERE template_id = ANY($1)`, [tids])).rows.map((r) => r.id as string)
        if (iids.length > 0) {
          await pool.query(`DELETE FROM approval_records WHERE instance_id = ANY($1)`, [iids])
          await pool.query(`DELETE FROM approval_assignments WHERE instance_id = ANY($1)`, [iids])
          await pool.query(`DELETE FROM approval_instances WHERE id = ANY($1)`, [iids])
        }
        await pool.query(`DELETE FROM approval_published_definitions WHERE template_id = ANY($1)`, [tids])
        await pool.query(`DELETE FROM approval_template_versions WHERE template_id = ANY($1)`, [tids])
        await pool.query(`DELETE FROM approval_templates WHERE id = ANY($1)`, [tids])
      }
      await pool.query(`DELETE FROM user_permissions WHERE user_id = ANY($1::text[])`, [[REQUESTER, APPROVER]]).catch(() => {})
    } catch {
      /* best effort */
    }
    if (server) await server.stop()
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('readable instance with NO projection row materialized yet: projectionEntry is null, not a 500', async () => {
    const created = await req(base, '/api/approvals', requesterTok, {
      method: 'POST',
      body: { templateId: tid, formData: { reason: 'no-projection-yet' } },
    })
    expect(created.status, await created.clone().text()).toBeLessThan(300)
    const aid = await extractId(created)
    const read = await req(base, `/api/approvals/${aid}`, requesterTok)
    expect(read.status).toBe(200)
    const dto = (await read.json()) as { projectionEntry?: unknown }
    expect(dto.projectionEntry ?? null).toBeNull()
  })

  it('B: the REQUESTER, seeded as the projection row participant, gets the handle with the SERVER-resolved sheetId/viewId', async () => {
    const created = await req(base, '/api/approvals', requesterTok, {
      method: 'POST',
      body: { templateId: tid, formData: { reason: 'req-is-participant' } },
    })
    const aid = await extractId(created)
    const pool = poolManager.get()
    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by)
       VALUES ($1,$2,$3::jsonb,1,'system:approval-projection','system:approval-projection')`,
      [`rec-pe-req-${aid}`, sheetId, JSON.stringify({ requesterId: REQUESTER, approverId: 'someone-unrelated' })],
    )
    const read = await req(base, `/api/approvals/${aid}`, requesterTok)
    expect(read.status).toBe(200)
    const dto = (await read.json()) as { projectionEntry?: { sheetId: string; viewId: string } | null }
    expect(dto.projectionEntry).toEqual({ sheetId, viewId: VIEW_ID })
  })

  it('B non-participant + positive control: a SEAT-HOLDING approver reads the instance (S1) but gets null until seeded as the projection approverId', async () => {
    const created = await req(base, '/api/approvals', requesterTok, {
      method: 'POST',
      body: { templateId: tid, formData: { reason: 'approver-not-participant-yet' } },
    })
    const aid = await extractId(created)
    const pool = poolManager.get()
    const recId = `rec-pe-appr-${aid}`
    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by)
       VALUES ($1,$2,$3::jsonb,1,'system:approval-projection','system:approval-projection')`,
      [recId, sheetId, JSON.stringify({ requesterId: 'someone-unrelated', approverId: 'also-unrelated' })],
    )

    // The APPROVER can read this instance at all (S1 SEAT arm — they hold the active assignment
    // `approval_1` was published with) — this proves the 404 instance-readability gate is OPEN for
    // them, so the null below is a PROJECTION-PARTICIPANT decision, not a readability refusal
    // wearing a null mask.
    const before = await req(base, `/api/approvals/${aid}`, approverTok)
    expect(before.status).toBe(200)
    const beforeDto = (await before.json()) as { projectionEntry?: unknown }
    expect(beforeDto.projectionEntry ?? null).toBeNull()

    // Positive control (design-lock §3/B): make APPROVER the projection row's approverId -> the
    // SAME instance, the SAME viewer now gets the handle.
    await pool.query(
      `UPDATE meta_records SET data = data || jsonb_build_object('approverId', $2::text) WHERE id = $1`,
      [recId, APPROVER],
    )
    const after = await req(base, `/api/approvals/${aid}`, approverTok)
    expect(after.status).toBe(200)
    const afterDto = (await after.json()) as { projectionEntry?: { sheetId: string; viewId: string } | null }
    expect(afterDto.projectionEntry).toEqual({ sheetId, viewId: VIEW_ID })
  })

  it('P3-1 regression: the DISPATCH ACTION response (POST .../actions) carries projectionEntry too, not only a fresh GET', async () => {
    // `GET /api/approvals/:id` and `POST /api/approvals/:id/actions` build their response DTOs
    // through TWO DIFFERENT methods (`ApprovalBridgeService.getApproval` for the GET; every
    // dispatch verb branch of `ApprovalProductService.dispatchAction` returns
    // `ApprovalProductService.getApproval`'s own DTO). Before the P3-1 fix, only the former set
    // `projectionEntry` — so the entry rendered on load and then EVAPORATED the moment a viewer
    // acted (approve/reject/etc.), reappearing only on a full reload. This pins the dispatch side
    // directly, over a real approve call, so a regression that stops populating it there reds here
    // even though the GET-based tests above stay green (they never exercise dispatchAction).
    const created = await req(base, '/api/approvals', requesterTok, {
      method: 'POST',
      body: { templateId: tid, formData: { reason: 'dispatch-carries-projection-entry' } },
    })
    const aid = await extractId(created)
    const pool = poolManager.get()
    // Seed the ACTING approver as the projection row's participant BEFORE they act, so the
    // dispatch response is checked against a viewer who SHOULD get the handle.
    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by)
       VALUES ($1,$2,$3::jsonb,1,'system:approval-projection','system:approval-projection')`,
      [`rec-pe-dispatch-${aid}`, sheetId, JSON.stringify({ requesterId: 'someone-unrelated', approverId: APPROVER })],
    )

    const approved = await req(base, `/api/approvals/${aid}/actions`, approverTok, {
      method: 'POST',
      body: { action: 'approve', comment: 'ok' },
    })
    expect(approved.status, await approved.clone().text()).toBe(200)
    const dto = (await approved.json()) as { projectionEntry?: { sheetId: string; viewId: string } | null }
    expect(dto.projectionEntry).toEqual({ sheetId, viewId: VIEW_ID })
  })
})
