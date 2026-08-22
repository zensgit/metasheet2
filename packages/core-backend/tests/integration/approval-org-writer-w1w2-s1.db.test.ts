import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { db } from '../../src/db/db'
import { eventBus } from '../../src/integration/events/event-bus'
import { AutomationService } from '../../src/multitable/automation-service'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import {
  ensureApprovalSchemaReady,
  grantApprovalWriteForIntegrationActor,
  grantApprovalOrgMembership,
} from '../helpers/approval-schema-bootstrap'

// Real-DB spec: runs only with a Postgres DATABASE_URL. Excluded from the no-DB default test job
// -> the whole describe below skips there (two-point wiring: also excluded from
// packages/core-backend/vitest.config.ts so the required no-DB job cannot collect-and-skip-green
// it, and wired as a WHOLE FILE into the standalone
// .github/workflows/approval-realdb-org-writer-w1w2-s1.yml lane).
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

// Sentinel deliberately lives OUTSIDE describeIfDatabase (top-level `it`, gated only on
// EXPECT_DB): a sentinel nested inside `describeIfDatabase` would itself be skipped whenever
// DATABASE_URL is absent, so it could never catch the failure mode it exists to catch — a
// DB-expected CI lane (EXPECT_DB=1) whose DATABASE_URL is missing or broken silently reporting
// this whole file as skipped-green instead of red (feedback_triggered_is_not_verified). Matches
// the landed pattern in approval-instance-readability-s1.db.test.ts /
// approval-org-writer-plm-mirror-s1.db.test.ts.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

/**
 * Lock-11 §10 W-1/W-2 org derivation — real-DB acceptance (G-L11-0/1/2/3/10 + refusal-precedence).
 *
 * Ratified design: docs/development/approval-lock11-writer-org-derivation-20260822.md (RATIFIED
 * 2026-08-22, design only — see §10 for the binding rulings this file gates). Spec baseline
 * `fb9f559dc0`. Implements arm (a) for the shared derivation
 * (`services/approval-instance-org-derivation.ts`'s `deriveApprovalInstanceOrgId`), wired into
 * `ApprovalProductService.createApproval` immediately after the final `approvals:write` DB
 * recheck and before the `approval_instances` INSERT.
 *
 * W-1 = `POST /api/approvals` (routes/approvals.ts). W-2 = the multitable automation
 * `start_approval` bridge (`AutomationApprovalBridgeService.startApproval`, reached through
 * `AutomationService.executeRule`) — choice (A) "propagate": the bridge's existing
 * `createApproval` catch (`:275-277`) already calls `markBridgeFailed` then rethrows, so the
 * shared derivation's `ServiceError(…, 422, 'APPROVAL_ORG_UNRESOLVED')` surfaces unchanged; no new
 * failure plumbing was added on the W-2 side.
 *
 * EXPLICITLY EXCLUDED from this file (per the implementation spec §9):
 *   - G-L11-6 (actor≠requester) — cannot be constructed against either shipped writer at this
 *     baseline (both collapse requester onto actor inside assembleCreationContext); would be
 *     vacuously green. W-4-only.
 *   - G-L11-5 (reader∘writer round-trip) — assigned to W-4; the lock assigns no reader∘writer
 *     gate to W-1/W-2. Not filled here under a borrowed name.
 *   - G-L11-4, G-L11-8, G-L11-9 — W-4 only (attendance_requests twin / DO UPDATE / operationId
 *     legs). No such surface exists on the W-1/W-2 INSERT.
 *   - G-L11-7 (boot-assert) — W-3 arm (c) only.
 *   - G-L11-11 (OpenAPI contract regeneration) — verified manually per the spec's four-step
 *     procedure (source edit -> generate:sdk -> git diff on dist/+dist-sdk/ -> guard:codegen);
 *     not a vitest assertion, matching the repo's existing precedent (no other slice gates
 *     codegen inside a real-DB suite).
 */
describeIfDatabase('Lock-11 §10 W-1/W-2 org derivation — real-DB acceptance (G-L11-0/1/2/3/10 + refusal-precedence)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let adminToken: string
  let templateId: string
  const pool = () => poolManager.get()
  const TS = Date.now()

  const createdInstanceIds: string[] = []
  const createdUserIds: string[] = []
  const createdTemplateIds = new Set<string>()
  const grantedWriteUserIds = new Set<string>()
  const membershipUserIds = new Set<string>()

  // W-2 fixtures
  const BASE = `w1w2s1_base_${TS}`
  const SHEET = `w1w2s1_sheet_${TS}`
  const executionIds: string[] = []
  const w2TemplateIds: string[] = []
  const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

  function makeAutomationService(): AutomationService {
    const svc = new AutomationService(eventBus, db as never, q as never)
    svc.init()
    return svc
  }

  async function seedSheetRecord(recordId: string, title: string): Promise<void> {
    await q(`INSERT INTO meta_bases (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [BASE, 'W1W2-S1 Base'])
    await q(`INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [SHEET, BASE, 'W1W2-S1 Sheet'])
    await q(
      `INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1, $2, $3::jsonb, 1)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, version = meta_records.version + 1`,
      [recordId, SHEET, JSON.stringify({ title })],
    )
  }

  async function createPublishedTemplate(): Promise<string> {
    const approvals = new ApprovalProductService()
    const template = await approvals.createTemplate({
      key: `w1w2s1-tpl-${TS}-${Math.random().toString(36).slice(2, 8)}`,
      name: 'W1W2 S1 gate template',
      visibilityScope: { type: 'all', ids: [] },
      formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: 'Start', config: {} },
          {
            key: 'approval_1',
            type: 'approval',
            name: 'Approver',
            config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' },
          },
          { key: 'end', type: 'end', name: 'End', config: {} },
        ],
        edges: [
          { key: 'e1', source: 'start', target: 'approval_1' },
          { key: 'e2', source: 'approval_1', target: 'end' },
        ],
      },
    } as never)
    w2TemplateIds.push(template.id)
    createdTemplateIds.add(template.id)
    await approvals.publishTemplate(template.id, { policy: { allowRevoke: true } } as never)
    return template.id
  }

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    const port = address && typeof address === 'object' ? address.port : undefined
    expect(port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${port}`
    adminToken = await authToken(freshId('w1w2s1-admin'), 'admin', '*:*')
    templateId = await publishSimpleTemplate(adminToken, 'shared')
  })

  afterAll(async () => {
    try {
      if (createdInstanceIds.length > 0) {
        await pool().query(`DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])`, [createdInstanceIds])
        await pool().query(`DELETE FROM approval_records WHERE instance_id = ANY($1::text[])`, [createdInstanceIds])
        await pool().query(`DELETE FROM approval_instances WHERE id = ANY($1::text[])`, [createdInstanceIds])
      }
      if (executionIds.length > 0) {
        await pool().query(`DELETE FROM multitable_automation_approval_bridges WHERE execution_id = ANY($1::text[])`, [executionIds])
      }
      if (w2TemplateIds.length > 0) {
        await pool().query('DELETE FROM approval_published_definitions WHERE template_id = ANY($1::uuid[])', [w2TemplateIds])
        await pool().query('DELETE FROM approval_template_versions WHERE template_id = ANY($1::uuid[])', [w2TemplateIds])
        await pool().query('DELETE FROM approval_templates WHERE id = ANY($1::uuid[])', [w2TemplateIds])
      }
      if (createdTemplateIds.size > 0) {
        const templateIds = [...createdTemplateIds]
        await pool().query('DELETE FROM approval_published_definitions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool().query('DELETE FROM approval_template_versions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool().query('DELETE FROM approval_templates WHERE id = ANY($1::uuid[])', [templateIds])
      }
      if (membershipUserIds.size > 0) {
        await pool().query('DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [[...membershipUserIds]])
      }
      if (grantedWriteUserIds.size > 0) {
        await pool().query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[...grantedWriteUserIds]])
      }
      if (createdUserIds.length > 0) {
        await pool().query('DELETE FROM users WHERE id = ANY($1::text[])', [createdUserIds])
      }
    } finally {
      await server?.stop()
    }
  })

  function freshId(prefix: string): string {
    return `${prefix}-${TS}-${Math.random().toString(36).slice(2, 8)}`
  }

  async function canListenOnEphemeralPort(): Promise<boolean> {
    return await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
  }

  async function req(
    path: string,
    token: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers ?? {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    })
  }

  async function authToken(userId: string, roles = 'user', perms = 'approvals:write,approvals:read'): Promise<string> {
    const response = await fetch(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`,
    )
    expect(response.status).toBe(200)
    return ((await response.json()) as { token: string }).token
  }

  async function grantWrite(userId: string): Promise<void> {
    grantedWriteUserIds.add(userId)
    await grantApprovalWriteForIntegrationActor(userId)
  }

  /** Membership cardinality helper, used at ASSERTION time (G-L11-0) — never trusted from setup alone. */
  async function activeMembershipCount(userId: string): Promise<number> {
    const result = await pool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM user_orgs WHERE user_id = $1 AND is_active = TRUE`,
      [userId],
    )
    return Number(result.rows[0]?.count ?? '0')
  }

  async function setSingleMembership(userId: string, orgId: string): Promise<void> {
    membershipUserIds.add(userId)
    // Explicit control (not the corpus-wide grantApprovalOrgMembership fold-in): DELETE first so
    // this fixture's cardinality is authoritative regardless of what any shared default seeded.
    await pool().query(`DELETE FROM user_orgs WHERE user_id = $1`, [userId])
    await grantApprovalOrgMembership(userId, orgId)
  }

  async function setZeroMembership(userId: string): Promise<void> {
    membershipUserIds.add(userId)
    await pool().query(`DELETE FROM user_orgs WHERE user_id = $1`, [userId])
  }

  async function setMultiMembership(userId: string, orgIds: string[]): Promise<void> {
    membershipUserIds.add(userId)
    await pool().query(`DELETE FROM user_orgs WHERE user_id = $1`, [userId])
    for (const orgId of orgIds) {
      await grantApprovalOrgMembership(userId, orgId)
    }
  }

  async function publishSimpleTemplate(adminToken: string, label: string): Promise<string> {
    const templateKey = `w1w2s1-${TS}-${label}-${Math.random().toString(36).slice(2, 8)}`
    const approverId = freshId('w1w2s1-approver')
    const created = await req('/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'W1W2 S1 gate',
        description: 'lock11-w1w2-s1',
        formSchema: { fields: [{ id: 'reason', type: 'text', label: 'reason', required: true }] },
        approvalGraph: {
          nodes: [
            { key: 'start', type: 'start', config: {} },
            { key: 'approval_1', type: 'approval', config: { assigneeType: 'user', assigneeIds: [approverId], approvalMode: 'single' } },
            { key: 'end', type: 'end', config: {} },
          ],
          edges: [
            { key: 'e1', source: 'start', target: 'approval_1' },
            { key: 'e2', source: 'approval_1', target: 'end' },
          ],
        },
      },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const template = (await created.json()) as { id: string }
    createdTemplateIds.add(template.id)
    const published = await req(`/api/approval-templates/${template.id}/publish`, adminToken, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect(published.status, await published.clone().text()).toBe(200)
    return template.id
  }

  async function createViaApi(
    requesterToken: string,
    templateId: string,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    return req('/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'w1w2-s1' } },
      headers: extraHeaders,
    })
  }

  // =============================================================================================
  // G-L11-1 (W-1) — POST /api/approvals, exactly-one / zero / multi active memberships.
  // =============================================================================================
  describe('G-L11-1 (W-1): POST /api/approvals org derivation', () => {
    it('POSITIVE: exactly one active membership (non-"default" org) stamps org_id — G-L11-0 cardinality asserted at assertion time', async () => {
      const requesterId = freshId('g111-pos')
      await grantWrite(requesterId)
      await setSingleMembership(requesterId, 'O1')
      // G-L11-0: prove the fixture really has 1 — not 0 (which would 422 for the WRONG reason and
      // misread as a passing negative).
      expect(await activeMembershipCount(requesterId)).toBe(1)

      const token = await authToken(requesterId)
      const created = await createViaApi(token, templateId)
      expect(created.status, await created.clone().text()).toBe(201)
      const body = (await created.json()) as { id: string }
      createdInstanceIds.push(body.id)

      const row = await pool().query<{ org_id: string | null }>(
        `SELECT org_id FROM approval_instances WHERE id = $1`,
        [body.id],
      )
      expect(row.rows[0]?.org_id).toBe('O1')
    })

    it('NEGATIVE (multi): two-or-more active memberships → 422 APPROVAL_ORG_UNRESOLVED, values-free, no row written — G-L11-0 cardinality asserted at assertion time', async () => {
      const requesterId = freshId('g111-multi')
      await grantWrite(requesterId)
      await setMultiMembership(requesterId, ['default', 'O2'])
      expect(await activeMembershipCount(requesterId)).toBeGreaterThanOrEqual(2)

      const countBefore = (await pool().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM approval_instances`,
      )).rows[0].count

      const token = await authToken(requesterId)
      const res = await createViaApi(token, templateId)
      expect(res.status).toBe(422)
      const body = (await res.json()) as { error: { code: string; message: string; details?: unknown } }
      expect(body.error.code).toBe('APPROVAL_ORG_UNRESOLVED')
      // Values-free: no details, and the body text never leaks the org ids or the user id.
      expect(body.error.details).toBeUndefined()
      const bodyText = JSON.stringify(body)
      expect(bodyText).not.toContain('O2')
      expect(bodyText).not.toContain(requesterId)

      const countAfter = (await pool().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM approval_instances`,
      )).rows[0].count
      expect(countAfter).toBe(countBefore)
    })

    it('NEGATIVE (zero): zero active memberships → 422 APPROVAL_ORG_UNRESOLVED, values-free, no row written — G-L11-0 cardinality asserted at assertion time', async () => {
      const requesterId = freshId('g111-zero')
      await grantWrite(requesterId)
      await setZeroMembership(requesterId)
      expect(await activeMembershipCount(requesterId)).toBe(0)

      const countBefore = (await pool().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM approval_instances`,
      )).rows[0].count

      const token = await authToken(requesterId)
      const res = await createViaApi(token, templateId)
      expect(res.status).toBe(422)
      const body = (await res.json()) as { error: { code: string; details?: unknown } }
      expect(body.error.code).toBe('APPROVAL_ORG_UNRESOLVED')
      expect(body.error.details).toBeUndefined()

      const countAfter = (await pool().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM approval_instances`,
      )).rows[0].count
      expect(countAfter).toBe(countBefore)
    })
  })

  // =============================================================================================
  // G-L11-2 (W-1) — the header-forgery trap (routes/approvals.ts's resolveApprovalTenantId /
  // jwt-middleware.ts's x-tenant-id back-fill). The derivation must NEVER consult
  // actor.tenantId / the x-tenant-id header.
  // =============================================================================================
  describe('G-L11-2 (W-1): org derivation ignores x-tenant-id / actor.tenantId entirely', () => {
    it('POSITIVE: no x-tenant-id header at all → org_id derived from user_orgs (O1) — establishes the baseline the forgery negative is measured against', async () => {
      const requesterId = freshId('g112-pos')
      await grantWrite(requesterId)
      await setSingleMembership(requesterId, 'O1')
      const token = await authToken(requesterId)

      const created = await createViaApi(token, templateId)
      expect(created.status, await created.clone().text()).toBe(201)
      const body = (await created.json()) as { id: string }
      createdInstanceIds.push(body.id)
      const row = await pool().query<{ org_id: string | null }>(
        `SELECT org_id FROM approval_instances WHERE id = $1`,
        [body.id],
      )
      expect(row.rows[0]?.org_id).toBe('O1')
    })

    it('NEGATIVE: x-tenant-id: O-EVIL header (no membership in O-EVIL) → org_id stays O1, NEVER O-EVIL', async () => {
      const requesterId = freshId('g112-evil')
      await grantWrite(requesterId)
      await setSingleMembership(requesterId, 'O1')
      const token = await authToken(requesterId)

      const created = await createViaApi(token, templateId, { 'x-tenant-id': 'O-EVIL' })
      expect(created.status, await created.clone().text()).toBe(201)
      const body = (await created.json()) as { id: string }
      createdInstanceIds.push(body.id)
      const row = await pool().query<{ org_id: string | null }>(
        `SELECT org_id FROM approval_instances WHERE id = $1`,
        [body.id],
      )
      // This is the whole point of the gate: the header must be completely inert here.
      expect(row.rows[0]?.org_id).toBe('O1')
      expect(row.rows[0]?.org_id).not.toBe('O-EVIL')
    })
  })

  // =============================================================================================
  // G-L11-10 (W-1 half) — zero-membership fixture, verified zero AT ASSERTION TIME via a direct
  // SQL count (not merely "we didn't seed one"), then the create refuses values-free.
  // =============================================================================================
  describe('G-L11-10: zero-membership fixture verified zero at assertion time, then refuses values-free', () => {
    it('zero active memberships confirmed by direct COUNT query, then create → 422, no org id / count / user id in the response', async () => {
      const requesterId = freshId('g1110-zero')
      await grantWrite(requesterId)
      await setZeroMembership(requesterId)

      const countRow = await pool().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM user_orgs WHERE user_id = $1 AND is_active = TRUE`,
        [requesterId],
      )
      expect(Number(countRow.rows[0].count)).toBe(0)

      const token = await authToken(requesterId)
      const res = await createViaApi(token, templateId)
      expect(res.status).toBe(422)
      const bodyText = await res.clone().text()
      expect(bodyText).not.toContain(requesterId)
      expect(bodyText).not.toMatch(/"count"\s*:/)
      const body = JSON.parse(bodyText) as { error: { code: string; details?: unknown } }
      expect(body.error.code).toBe('APPROVAL_ORG_UNRESOLVED')
      expect(body.error.details).toBeUndefined()
    })
  })

  // =============================================================================================
  // Refusal precedence — a requester failing BOTH approvals:write and the org derivation must get
  // 403 (authorization first), never 422. Pins that the derivation slot sits AFTER the write
  // boundary (ApprovalProductService.ts's :7555 recheck), not before it.
  // =============================================================================================
  describe('refusal precedence: 403 (not 422) when both approvals:write AND org derivation would refuse', () => {
    it('requester with NO approvals:write grant and ZERO org memberships gets 403 FORBIDDEN, never 422', async () => {
      const requesterId = freshId('g1prec-both')
      // The JWT claim itself carries approvals:write (RBAC_TOKEN_TRUST is on in the integration
      // test config, so this is what satisfies the OUTER rbacGuard) — but this suite's helper
      // never grants any DB-backed permission (no user_permissions / role_permissions / admin
      // row), which is what the INNER, DB-only recheck at the final write boundary
      // (userHasApprovalsWriteOnQuery — intentionally does NOT trust JWT/actor.permissions)
      // actually consults. Without a token claiming approvals:write, the request would be
      // refused by the outer guard instead, which would not discriminate this ordering claim at
      // all — the point of this gate is specifically the INNER DB-only refusal winning over the
      // (also failing) org derivation.
      await setZeroMembership(requesterId)
      const token = await authToken(requesterId, 'user', 'approvals:write,approvals:read')

      const res = await createViaApi(token, templateId)
      expect(res.status, await res.clone().text()).toBe(403)
      const body = (await res.json()) as { error: { code?: string } | string }
      // Confirms this is the INNER DB-only boundary's ServiceError (nested {code,message}), not
      // the outer rbacGuard's flat {error: string} shape — i.e. the request DID pass rbacGuard
      // and WAS refused inside createApproval, at the derivation-adjacent boundary this gate
      // targets.
      expect(typeof body.error).toBe('object')
      expect((body.error as { code?: string }).code).toBe('FORBIDDEN')
    })
  })

  // =============================================================================================
  // G-L11-3 (W-2) — the multitable automation start_approval bridge, choice (A) propagate.
  // =============================================================================================
  describe('G-L11-3 (W-2): start_approval org derivation (AutomationService.executeRule -> AutomationApprovalBridgeService.startApproval)', () => {
    async function seedTriggerUser(userId: string): Promise<void> {
      createdUserIds.push(userId)
      await pool().query(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
         ON CONFLICT (id) DO UPDATE SET is_active = TRUE, email = EXCLUDED.email`,
        [userId, `${userId}@example.test`],
      )
      await grantWrite(userId)
    }

    it('POSITIVE: trigger actor with exactly one active membership stamps org_id on the bridged instance', async () => {
      const requesterId = freshId('g113-pos')
      await seedTriggerUser(requesterId)
      await setSingleMembership(requesterId, 'O3')
      expect(await activeMembershipCount(requesterId)).toBe(1)

      const svc = makeAutomationService()
      const tid = await createPublishedTemplate()
      const recordId = freshId('g113-rec')
      await seedSheetRecord(recordId, 'G-L11-3 positive')

      const execRule = {
        id: freshId('g113-rule'),
        name: 'G-L11-3 positive',
        sheetId: SHEET,
        trigger: { type: 'record.created', config: {} },
        actions: [
          { type: 'start_approval', config: { templateId: tid, formDataMapping: { summary: 'Record {{record.title}} needs approval' }, requester: { mode: 'trigger_actor' } } },
        ],
        enabled: true,
        createdBy: requesterId,
        createdAt: new Date(TS).toISOString(),
        executionMode: 'workflow_job_v1',
      }
      const execution = await svc.executeRule(execRule as never, {
        sheetId: SHEET,
        recordId,
        data: { title: 'G-L11-3 positive' },
        actorId: requesterId,
      })
      executionIds.push(execution.id)
      expect(execution.status).not.toBe('failed')

      const bridge = await q(
        `SELECT approval_instance_id, status FROM multitable_automation_approval_bridges WHERE execution_id = $1`,
        [execution.id],
      )
      expect(bridge.rows).toHaveLength(1)
      const instanceId = (bridge.rows[0] as { approval_instance_id: string }).approval_instance_id
      expect(instanceId).toBeTruthy()
      createdInstanceIds.push(instanceId)

      const row = await pool().query<{ org_id: string | null }>(
        `SELECT org_id FROM approval_instances WHERE id = $1`,
        [instanceId],
      )
      expect(row.rows[0]?.org_id).toBe('O3')
    })

    it('NEGATIVE: trigger actor with two-or-more active memberships → typed ServiceError (values-free), bridge row status=failed, NO approval_instances row', async () => {
      const requesterId = freshId('g113-multi')
      await seedTriggerUser(requesterId)
      await setMultiMembership(requesterId, ['default', 'O4'])
      expect(await activeMembershipCount(requesterId)).toBeGreaterThanOrEqual(2)

      const svc = makeAutomationService()
      const tid = await createPublishedTemplate()
      const recordId = freshId('g113-rec-neg')
      await seedSheetRecord(recordId, 'G-L11-3 negative')

      const countBefore = (await pool().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM approval_instances`,
      )).rows[0].count

      const execRule = {
        id: freshId('g113-rule-neg'),
        name: 'G-L11-3 negative',
        sheetId: SHEET,
        trigger: { type: 'record.created', config: {} },
        actions: [
          { type: 'start_approval', config: { templateId: tid, formDataMapping: { summary: 'Record {{record.title}} needs approval' }, requester: { mode: 'trigger_actor' } } },
        ],
        enabled: true,
        createdBy: requesterId,
        createdAt: new Date(TS).toISOString(),
        executionMode: 'workflow_job_v1',
      }
      const execution = await svc.executeRule(execRule as never, {
        sheetId: SHEET,
        recordId,
        data: { title: 'G-L11-3 negative' },
        actorId: requesterId,
      })
      executionIds.push(execution.id)

      expect(execution.status).toBe('failed')
      // Choice (A) propagate: the shared derivation's ServiceError message surfaces unchanged
      // through the bridge's existing catch/rethrow — values-free (no org id / count / user id).
      expect(execution.error).toContain('Approval instance org could not be resolved')
      expect(execution.error).not.toContain('O4')
      expect(execution.error).not.toContain(requesterId)

      const bridge = await q(
        `SELECT approval_instance_id, status FROM multitable_automation_approval_bridges WHERE execution_id = $1`,
        [execution.id],
      )
      expect(bridge.rows).toHaveLength(1)
      expect((bridge.rows[0] as { status: string }).status).toBe('failed')
      expect((bridge.rows[0] as { approval_instance_id: string | null }).approval_instance_id).toBeNull()

      // The row-count assertion itself (not merely the bridge's NULL FK proxy) — the rollback on
      // a mid-transaction 422 is asserted, never assumed (spec §3).
      const countAfter = (await pool().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM approval_instances`,
      )).rows[0].count
      expect(countAfter).toBe(countBefore)
    })
  })
})
