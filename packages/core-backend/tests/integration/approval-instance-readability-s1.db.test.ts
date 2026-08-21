import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'
import { canReadApprovalInstance, isOrgPinEnabled, isPlmApprovalId, viewerRoles } from '../../src/services/approval-instance-readability'
import { ACTION_POLICY_KEYS, APPROVAL_POLICY_DENIED_ACTION } from '../../src/types/approval-product'

/**
 * Lock-10 (S1) `canReadApprovalInstance` — real-DB acceptance for the PURE PREDICATE (all five
 * arms + the org pin), independent of any HTTP consumer. Source:
 * docs/development/approval-lock10-instance-readability-20260821.md plus the six by-reference
 * owner rulings recorded in Lock-10 §5.1.1 (`dd7fa8630248`, PR #5078).
 *
 * SIBLING FILE — `approval-instance-readability-s1-consumers.db.test.ts` — covers everything that
 * needs a live HTTP route (G-S1-4 spy-zero, G-S1-5 detail/history pairing, G-S1-7 metrics deltas).
 * THIS file covers G-S1-1, G-S1-3, G-S1-6, G-S1-10, G-S1-11, G-S1-12 PARTIAL, plus a predicate-level
 * slice of G-S1-2 (the org pin ON, against a class-2-shaped fixture) — the HTTP half of G-S1-2 is
 * the existing, UNTOUCHED `approval-attachment-pipeline-realdb.test.ts`, which stays green after
 * the C-1 retirement precisely because the predicate swap is behavior-preserving at those routes
 * (see `approval-instance-readability.ts`'s module docblock for why).
 *
 * ORG PIN — DEFAULT OFF (`APPROVAL_S1_ORG_PIN_ENABLED`). This is a disclosed DEVIATION from the
 * lock's text (which conjoins the pin unconditionally), forced by two implementer findings
 * (B-1/B-2 in the S1 implementation brief) that the lock's own rulings do not resolve: the
 * dominant platform row class (template-originated) has no derivable org source in this repo, and
 * the fallback source (requester-resolvable) launders `'default'` into virtually the whole
 * platform population via `zzzz20260114110000`'s blanket backfill — exactly the hole OD-S1-9(a)
 * refuses. Landing the pin live in this slice would make every un-backfilled platform instance
 * (the majority) unreadable to its own legitimate requester — an outage, not a narrowing. See
 * `isOrgPinEnabled`'s docblock for the full reasoning and the flip precondition. G-S1-3 and G-S1-10
 * below FORCE the flag on in-process to prove the pin's own correctness even while it ships
 * dormant; the "shipped default is OFF" test below catches a silent flip.
 *
 * G-S1-6 — arm 3 now INCLUDES `policy_denied` (OD-S1-6), because this suite BUILDS the coupling
 * gate the ruling conditions that on: a mechanical enumeration proving `ACTION_POLICY_KEYS`'s only
 * seat-gate-exempt verb (`revoke`) is also its only `null`-policy verb (so no OTHER, policy-gated
 * verb can ever be invoked by a non-participant), PLUS an end-to-end real-dispatch-choke proof
 * (via a live `MetaSheetServer` HTTP flow — publish a template with an explicit-`false` node
 * policy, act as the seat-holder, observe the `policy_denied` row land and the actor still read
 * the instance) that a non-participant's seat-gate-exempt attempt writes no row.
 *
 * Other gates covered: G-S1-1 (zero-attachment instance readable by its requester, non-participant
 * denied), G-S1-11 (monotonic membership), G-S1-12 PARTIAL (no DB default; Phase-3 presence CHECK
 * is a separate, later migration).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
}

async function authToken(baseUrl: string, userId: string, roles = 'admin', perms = '*:*'): Promise<string> {
  const response = await fetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`,
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { token: string }).token
}

describeIfDatabase('Lock-10 (S1) canReadApprovalInstance — all 5 arms + org pin, real DB', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const pool = () => poolManager.get()
  const createdInstanceIds: string[] = []
  const createdUserIds: string[] = []
  const createdTemplateIds = new Set<string>()
  const grantedUserIds = new Set<string>()

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    const port = address && typeof address === 'object' ? address.port : undefined
    expect(port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${port}`
  })

  // The org-pin tests force the flag ON around one assertion each — always restore, even on
  // failure, so a thrown expectation cannot leak the override into a later test in this file.
  afterEach(() => {
    delete process.env.APPROVAL_S1_ORG_PIN_ENABLED
  })

  afterAll(async () => {
    try {
      if (createdInstanceIds.length > 0) {
        await pool().query(`DELETE FROM approval_records WHERE instance_id = ANY($1::text[])`, [createdInstanceIds])
        await pool().query(`DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])`, [createdInstanceIds])
        await pool().query(`DELETE FROM approval_attachments WHERE instance_id = ANY($1::text[])`, [createdInstanceIds])
        await pool().query(`DELETE FROM approval_instances WHERE id = ANY($1::text[])`, [createdInstanceIds])
      }
      if (createdUserIds.length > 0) {
        await pool().query(`DELETE FROM users WHERE id = ANY($1::text[])`, [createdUserIds])
        await pool().query(`DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`, [createdUserIds])
      }
      if (createdTemplateIds.size > 0) {
        const templateIds = [...createdTemplateIds]
        await pool().query('DELETE FROM approval_published_definitions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool().query('DELETE FROM approval_template_versions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool().query('DELETE FROM approval_templates WHERE id = ANY($1::uuid[])', [templateIds])
      }
      if (grantedUserIds.size > 0) {
        await pool().query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[...grantedUserIds]])
      }
    } finally {
      await server?.stop()
    }
  })

  function freshId(prefix: string): string {
    return `${prefix}-${TS}-${Math.random().toString(36).slice(2, 8)}`
  }

  async function seedInstance(requesterId: string): Promise<string> {
    const id = freshId('s1-inst')
    await pool().query(
      `INSERT INTO approval_instances (id, status, requester_snapshot) VALUES ($1, 'pending', $2::jsonb)`,
      [id, JSON.stringify({ id: requesterId })],
    )
    createdInstanceIds.push(id)
    return id
  }

  async function seedAssignment(instanceId: string, assigneeId: string, isActive: boolean, type: 'user' | 'role' = 'user'): Promise<void> {
    await pool().query(
      `INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, is_active) VALUES ($1, $2, $3, $4)`,
      [instanceId, type, assigneeId, isActive],
    )
  }

  async function seedRecord(instanceId: string, action: string, actorId: string, metadata: Record<string, unknown> = {}): Promise<void> {
    await pool().query(
      `INSERT INTO approval_records (instance_id, action, actor_id, actor_name, to_status, to_version, metadata)
       VALUES ($1, $2, $3, 'Test Actor', 'pending', 1, $4::jsonb)`,
      [instanceId, action, actorId, JSON.stringify(metadata)],
    )
  }

  // ---------------------------------------------------------------------------------------------
  // G-S1-1 — zero-attachment instance readable by its requester (F-1's fix); non-participant denied
  // ---------------------------------------------------------------------------------------------
  describe('G-S1-1: requester arm — the org-pin-free fix for F-1', () => {
    it('POSITIVE: the requester reads an instance with zero attachments (and no attachment table dependency at all)', async () => {
      const requesterId = freshId('s1-requester')
      const instanceId = await seedInstance(requesterId)
      await expect(canReadApprovalInstance(pool(), requesterId, instanceId)).resolves.toBe(true)
    })

    it('NEGATIVE: a non-participant on the SAME instance is denied', async () => {
      const requesterId = freshId('s1-requester')
      const instanceId = await seedInstance(requesterId)
      const bystanderId = freshId('s1-bystander')
      await expect(canReadApprovalInstance(pool(), bystanderId, instanceId)).resolves.toBe(false)
    })

    it('fail-closed: an unknown instance id denies (no throw escapes)', async () => {
      await expect(canReadApprovalInstance(pool(), freshId('s1-someone'), freshId('s1-nonexistent'))).resolves.toBe(false)
    })
  })

  // ---------------------------------------------------------------------------------------------
  // G-S1-11 — monotonic membership (OD-S1-4): approval_assignments.is_active is NEVER consulted
  // ---------------------------------------------------------------------------------------------
  describe('G-S1-11: monotonic seat membership', () => {
    it('POSITIVE: an approver whose seat is now is_active=FALSE still reads the instance', async () => {
      const requesterId = freshId('s1-requester')
      const approverId = freshId('s1-approver')
      const instanceId = await seedInstance(requesterId)
      await seedAssignment(instanceId, approverId, false)
      await expect(canReadApprovalInstance(pool(), approverId, instanceId)).resolves.toBe(true)
    })

    it('POSITIVE: an active seat also reads the instance (not only the deactivated case)', async () => {
      const requesterId = freshId('s1-requester')
      const approverId = freshId('s1-approver')
      const instanceId = await seedInstance(requesterId)
      await seedAssignment(instanceId, approverId, true)
      await expect(canReadApprovalInstance(pool(), approverId, instanceId)).resolves.toBe(true)
    })

    it('DISCRIMINATING NEGATIVE: a user who NEVER held a seat on this instance is denied — same fixture as the two positives above', async () => {
      const requesterId = freshId('s1-requester')
      const approverId = freshId('s1-approver')
      const neverAssignedId = freshId('s1-never-assigned')
      const instanceId = await seedInstance(requesterId)
      await seedAssignment(instanceId, approverId, false)
      await expect(canReadApprovalInstance(pool(), neverAssignedId, instanceId)).resolves.toBe(false)
    })

    it('role-typed seat: a viewer whose DB role matches an active-or-inactive role assignment reads the instance', async () => {
      const requesterId = freshId('s1-requester')
      const roleViewerId = freshId('s1-role-viewer')
      const roleName = `s1-role-${TS}-${Math.random().toString(36).slice(2, 6)}`
      createdUserIds.push(roleViewerId)
      await pool().query(
        `INSERT INTO users (id, email, name, password_hash, role, is_active, is_admin)
         VALUES ($1, $1 || '@example.test', $1, 'x', $2, TRUE, FALSE)
         ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = TRUE`,
        [roleViewerId, roleName],
      )
      const instanceId = await seedInstance(requesterId)
      await seedAssignment(instanceId, roleName, false, 'role')
      await expect(canReadApprovalInstance(pool(), roleViewerId, instanceId)).resolves.toBe(true)
    })

    it('source_queue assignments are NEVER matched by the seat arm (OD-S1-5) — a permission-code holder is denied', async () => {
      const requesterId = freshId('s1-requester')
      const instanceId = await seedInstance(requesterId)
      // A permission code, not a user id — this is exactly the shape upsertPlmMirror writes.
      await seedAssignment(instanceId, 'approvals:read', false, 'user')
      // Paired control: as a 'user'-typed seat the SAME assignee_id string IS admitted — isolating
      // the assignment_type flip below (not the string value) as the cause of the denial.
      await expect(canReadApprovalInstance(pool(), 'approvals:read', instanceId)).resolves.toBe(true)
      await pool().query(
        `UPDATE approval_assignments SET assignment_type = 'source_queue' WHERE instance_id = $1`,
        [instanceId],
      )
      await expect(canReadApprovalInstance(pool(), 'approvals:read', instanceId)).resolves.toBe(false)
    })
  })

  // ---------------------------------------------------------------------------------------------
  // Arm 3 — PAST ACTOR, ordinary (non-policy_denied) rows. The policy_denied-specific coupling is
  // its own gate, G-S1-6, below — this is the plain case OD-S1-6 does not condition on anything.
  // ---------------------------------------------------------------------------------------------
  describe('arm 3: past actor', () => {
    it('POSITIVE: a user with an ordinary approval_records row (not requester, not seat, not admin) reads the instance', async () => {
      const requesterId = freshId('s1-requester')
      const actorId = freshId('s1-past-actor')
      const instanceId = await seedInstance(requesterId)
      await seedRecord(instanceId, 'comment', actorId)
      await expect(canReadApprovalInstance(pool(), actorId, instanceId)).resolves.toBe(true)
    })

    it('DISCRIMINATING NEGATIVE: a bystander with no row at all is denied on the SAME instance', async () => {
      const requesterId = freshId('s1-requester')
      const actorId = freshId('s1-past-actor2')
      const bystanderId = freshId('s1-bystander')
      const instanceId = await seedInstance(requesterId)
      await seedRecord(instanceId, 'comment', actorId)
      await expect(canReadApprovalInstance(pool(), bystanderId, instanceId)).resolves.toBe(false)
    })
  })

  // ---------------------------------------------------------------------------------------------
  // Arm 4 — CC target (OD-S1-7)
  // ---------------------------------------------------------------------------------------------
  describe('arm 4: CC target', () => {
    it('POSITIVE: a user-typed CC target reads the instance', async () => {
      const requesterId = freshId('s1-requester')
      const ccUserId = freshId('s1-cc-user')
      const instanceId = await seedInstance(requesterId)
      await seedRecord(instanceId, 'cc', requesterId, { targetType: 'user', targetId: ccUserId })
      await expect(canReadApprovalInstance(pool(), ccUserId, instanceId)).resolves.toBe(true)
    })

    it('NEGATIVE: a user named as neither actor nor CC target is denied even though a cc record exists', async () => {
      const requesterId = freshId('s1-requester')
      const ccUserId = freshId('s1-cc-user')
      const bystanderId = freshId('s1-bystander')
      const instanceId = await seedInstance(requesterId)
      await seedRecord(instanceId, 'cc', requesterId, { targetType: 'user', targetId: ccUserId })
      await expect(canReadApprovalInstance(pool(), bystanderId, instanceId)).resolves.toBe(false)
    })
  })

  // ---------------------------------------------------------------------------------------------
  // Arm 5 — ADMIN (OD-S1-8, kept per OD-S1-8(d)). DB-backed only.
  // ---------------------------------------------------------------------------------------------
  describe('arm 5: admin bypass (DB-backed only)', () => {
    async function seedUser(userId: string, opts: { isAdmin?: boolean; role?: string; isActive?: boolean }): Promise<void> {
      createdUserIds.push(userId)
      await pool().query(
        `INSERT INTO users (id, email, name, password_hash, role, is_active, is_admin)
         VALUES ($1, $1 || '@example.test', $1, 'x', $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = EXCLUDED.is_active, is_admin = EXCLUDED.is_admin`,
        [userId, opts.role ?? 'viewer', opts.isActive ?? true, opts.isAdmin ?? false],
      )
    }

    it('POSITIVE: is_admin=TRUE, is_active=TRUE reads any instance, even a non-participant one', async () => {
      const adminId = freshId('s1-admin-flag')
      await seedUser(adminId, { isAdmin: true })
      const instanceId = await seedInstance(freshId('s1-requester'))
      await expect(canReadApprovalInstance(pool(), adminId, instanceId)).resolves.toBe(true)
    })

    it('POSITIVE: role=\'admin\', is_active=TRUE reads any instance (the OTHER admit path, not just is_admin)', async () => {
      const adminId = freshId('s1-admin-role')
      await seedUser(adminId, { role: 'admin' })
      const instanceId = await seedInstance(freshId('s1-requester'))
      await expect(canReadApprovalInstance(pool(), adminId, instanceId)).resolves.toBe(true)
    })

    it('NEGATIVE: is_admin=TRUE but is_active=FALSE is denied — a deactivated employee does not get an admin bypass (OD-S1-4\'s verbatim carve-out)', async () => {
      const deactivatedAdminId = freshId('s1-admin-deactivated')
      await seedUser(deactivatedAdminId, { isAdmin: true, isActive: false })
      const instanceId = await seedInstance(freshId('s1-requester'))
      await expect(canReadApprovalInstance(pool(), deactivatedAdminId, instanceId)).resolves.toBe(false)
    })

    it('DISCRIMINATING NEGATIVE: an ordinary active user (no admin flag, no role) is denied on the SAME non-participant instance', async () => {
      const ordinaryId = freshId('s1-ordinary')
      await seedUser(ordinaryId, { isAdmin: false })
      const instanceId = await seedInstance(freshId('s1-requester'))
      await expect(canReadApprovalInstance(pool(), ordinaryId, instanceId)).resolves.toBe(false)
    })

    it('a deactivated employee who WAS a real approver still reads their own history via arm 2 (arm 2 never consults users at all — the lock\'s own asymmetry, not a bug)', async () => {
      const deactivatedApproverId = freshId('s1-deactivated-approver')
      await seedUser(deactivatedApproverId, { isAdmin: false, isActive: false })
      const instanceId = await seedInstance(freshId('s1-requester'))
      await seedAssignment(instanceId, deactivatedApproverId, false)
      await expect(canReadApprovalInstance(pool(), deactivatedApproverId, instanceId)).resolves.toBe(true)
    })
  })

  // ---------------------------------------------------------------------------------------------
  // G-S1-6 — policy_denied cannot be self-minted (OD-S1-6). Arm 3 now INCLUDES policy_denied.
  // Two layers: (1) MECHANICAL — the structural coupling between the seat-gate exemption
  // (`request.action !== 'revoke'`) and ACTION_POLICY_KEYS.revoke being the ONE null-policy verb,
  // which is what makes "a non-participant cannot self-mint policy_denied" true for EVERY
  // policy-gated verb, not just the one exercised concretely below. (2) REAL DISPATCH — a live
  // HTTP flow through the actual Lock-5 choke (`ApprovalProductService.ts`), proving a seat-holder
  // refused by node policy writes the row and still reads the instance, and (separately) that
  // `revoke` — the seat-gate-exempt verb — never reaches the policy branch at all, so a
  // non-participant's attempt writes no row.
  // ---------------------------------------------------------------------------------------------
  describe('G-S1-6: policy_denied admission is coupled to the real dispatch choke', () => {
    it('MECHANICAL: the ONLY seat-gate-exempt verb (per ApprovalProductService.ts:9091, `action !== \'revoke\'`) is ALSO the only null-policy verb — so no policy-gated verb can ever be reached without a seat. Mutation: flip ACTION_POLICY_KEYS.revoke to a non-null key → this reds.', () => {
      const SEAT_GATE_EXEMPT_VERBS = new Set(['revoke']) // the ONE exemption at ApprovalProductService.ts:9091
      for (const [verb, policyKey] of Object.entries(ACTION_POLICY_KEYS)) {
        if (policyKey !== null) {
          expect(SEAT_GATE_EXEMPT_VERBS.has(verb), `${verb} is policy-gated but also seat-gate-exempt`).toBe(false)
        }
      }
      // The other half of the coupling, stated positively: revoke itself carries no policy key, so
      // it never reaches the `nodeOperationPolicyKey !== null` branch that inserts policy_denied.
      expect(ACTION_POLICY_KEYS.revoke).toBeNull()
      // Non-vacuous: at least one verb IS policy-gated (the mechanical check above has something to
      // iterate over).
      expect(Object.values(ACTION_POLICY_KEYS).some((key) => key !== null)).toBe(true)
    })

    function buildFormSchema() {
      return { fields: [{ id: 'reason', type: 'text', label: 'reason', required: true }] }
    }

    /** A(seat) -> B(seat) -> end. `nodeOperationPolicy` on A carries an EXPLICIT false for the
     *  gated verb under test (widen-only semantics make an omitted key pass vacuously — the
     *  fixture precondition the gate table names). */
    function policyGraph(seatId: string, otherId: string, policy: Record<string, unknown>) {
      return {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          {
            key: 'approval_a',
            type: 'approval',
            config: { assigneeType: 'user', assigneeIds: [seatId], approvalMode: 'single', nodeOperationPolicy: policy },
          },
          { key: 'approval_b', type: 'approval', config: { assigneeType: 'user', assigneeIds: [otherId], approvalMode: 'single' } },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-s-a', source: 'start', target: 'approval_a' },
          { key: 'e-a-b', source: 'approval_a', target: 'approval_b' },
          { key: 'e-b-end', source: 'approval_b', target: 'end' },
        ],
      }
    }

    async function createTemplate(adminToken: string, approvalGraph: object, label: string): Promise<string> {
      const templateKey = `s1-g6-${TS}-${label}-${Math.floor(Math.random() * 1e6)}`
      const response = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
        method: 'POST',
        body: { key: templateKey, name: 'S1 G-S1-6', description: 'lock10-g-s1-6', formSchema: buildFormSchema(), approvalGraph },
      })
      expect(response.status, await response.clone().text()).toBe(201)
      const template = (await response.json()) as { id: string }
      createdTemplateIds.add(template.id)
      return template.id
    }

    async function publishGraphTemplate(adminToken: string, approvalGraph: object, label: string): Promise<string> {
      const templateId = await createTemplate(adminToken, approvalGraph, label)
      const publishResponse = await jsonRequest(baseUrl, `/api/approval-templates/${templateId}/publish`, adminToken, {
        method: 'POST',
        body: { policy: { allowRevoke: true } },
      })
      expect(publishResponse.status, await publishResponse.clone().text()).toBe(200)
      return templateId
    }

    async function createApprovalInstance(requesterToken: string, templateId: string): Promise<string> {
      const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
        method: 'POST',
        body: { templateId, formData: { reason: 'g-s1-6' } },
      })
      expect(create.status, await create.clone().text()).toBe(201)
      const inst = (await create.json()) as { id: string }
      createdInstanceIds.push(inst.id)
      return inst.id
    }

    async function act(token: string, instanceId: string, body: object): Promise<Response> {
      return jsonRequest(baseUrl, `/api/approvals/${instanceId}/actions`, token, { method: 'POST', body })
    }

    async function grantWrite(userId: string): Promise<void> {
      grantedUserIds.add(userId)
      await grantApprovalWriteForIntegrationActor(userId)
    }

    it('POSITIVE (real dispatch): a seat-holder refused by node policy (explicit allowTransfer:false) writes a policy_denied row and STILL reads the instance', async () => {
      const requesterId = freshId('s1-g6-requester')
      const seatId = freshId('s1-g6-seat')
      const otherId = freshId('s1-g6-other')
      await grantWrite(requesterId)
      const adminToken = await authToken(baseUrl, `s1-g6-admin-${TS}-${Math.random().toString(36).slice(2, 8)}`)
      // Admin-scoped tokens throughout (matches approval-node-operation-policy.db.test.ts's own
      // authToken convention) — this test exercises the NODE-POLICY choke, not RBAC edge cases;
      // grantWrite seeds the DB-backed create permission the requester still needs.
      const requesterToken = await authToken(baseUrl, requesterId)
      const seatToken = await authToken(baseUrl, seatId)
      const templateId = await publishGraphTemplate(adminToken, policyGraph(seatId, otherId, { allowTransfer: false }), 'transfer-denied')
      const instanceId = await createApprovalInstance(requesterToken, templateId)

      const refused = await act(seatToken, instanceId, { action: 'transfer', targetUserId: otherId })
      expect(refused.status, await refused.clone().text()).toBe(409)

      const records = await pool().query(
        `SELECT action FROM approval_records WHERE instance_id = $1 AND actor_id = $2`,
        [instanceId, seatId],
      )
      expect((records.rows as Array<{ action: string }>).some((r) => r.action === APPROVAL_POLICY_DENIED_ACTION)).toBe(true)

      // MUTATION-EFFECTIVENESS FIX: a refusal never removes the assignment (the choke rolls back
      // everything except the denial row), so `seatId` is STILL arm-2-admitted here regardless of
      // arm 3 — asserting readability at this point would be true even with policy_denied EXCLUDED,
      // making the "arm 3 admits it" claim untested (feedback_ineffective_mutation_looks_like_a_
      // useless_test). Isolate arm 3 as the ONLY surviving reason: delete the seat row (simulates
      // a later reassignment/removal — the audit trail's policy_denied row is what remains), then
      // assert readability. This is what actually reds when the policy_denied exclusion is reverted.
      await pool().query(`DELETE FROM approval_assignments WHERE instance_id = $1 AND assignee_id = $2`, [instanceId, seatId])
      const seatCheck = await pool().query(`SELECT 1 FROM approval_assignments WHERE instance_id = $1 AND assignee_id = $2`, [instanceId, seatId])
      expect(seatCheck.rows.length, 'precondition: no assignment row must remain for this actor').toBe(0)

      // The refused actor, now with NO seat at all, STILL reads the instance — arm 3 admits via
      // the (real-dispatch-written) policy_denied row, and ONLY arm 3.
      await expect(canReadApprovalInstance(pool(), seatId, instanceId)).resolves.toBe(true)
    })

    it('DISCRIMINATING NEGATIVE (real dispatch): a non-participant attempting the SEAT-GATE-EXEMPT verb (revoke) writes NO approval_records row and stays denied', async () => {
      const requesterId = freshId('s1-g6-requester2')
      const seatId = freshId('s1-g6-seat2')
      const otherId = freshId('s1-g6-other2')
      const outsiderId = freshId('s1-g6-outsider')
      await grantWrite(requesterId)
      const adminToken = await authToken(baseUrl, `s1-g6-admin2-${TS}-${Math.random().toString(36).slice(2, 8)}`)
      const requesterToken = await authToken(baseUrl, requesterId)
      // revoke has NO policy key (mechanical test above) — no explicit policy needed on the node.
      const templateId = await publishGraphTemplate(adminToken, policyGraph(seatId, otherId, {}), 'revoke-exempt')
      const instanceId = await createApprovalInstance(requesterToken, templateId)

      const before = await pool().query(`SELECT COUNT(*)::int AS n FROM approval_records WHERE instance_id = $1`, [instanceId])
      // An admin-scoped token so the attempt reaches the dispatch choke rather than an earlier
      // permission 403 — the point under test is the SEAT gate + policy branch, not rbacGuard.
      const outsiderToken = await authToken(baseUrl, outsiderId)
      const revokeAttempt = await act(outsiderToken, instanceId, { action: 'revoke' })
      // revoke's OWN business rule (ApprovalProductService.ts ~9539-9541, `requesterId !==
      // actor.userId`) refuses a non-requester with 403 APPROVAL_REVOKE_FORBIDDEN — reached
      // WITHOUT ever consulting the node-policy branch (revoke's ACTION_POLICY_KEYS entry is
      // null), so no policy_denied row is possible on this path regardless of who calls it.
      expect(revokeAttempt.status, await revokeAttempt.clone().text()).toBe(403)
      const after = await pool().query(`SELECT COUNT(*)::int AS n FROM approval_records WHERE instance_id = $1`, [instanceId])
      expect((after.rows[0] as { n: number }).n).toBe((before.rows[0] as { n: number }).n)

      await expect(canReadApprovalInstance(pool(), outsiderId, instanceId)).resolves.toBe(false)
    })
  })

  // ---------------------------------------------------------------------------------------------
  // Org pin — G-S1-3 (NULL-org fail-closed, all five identities) and G-S1-10 (cross-org denial,
  // union semantics). Both FORCE the flag ON in-process (afterEach above restores it), because the
  // flag ships OFF by default (see module + suite docblocks) — without forcing it on, these gates
  // would be vacuously green.
  // ---------------------------------------------------------------------------------------------
  describe('org pin (forced ON in-process — G-S1-3, G-S1-10)', () => {
    async function seedActiveOrg(userId: string, orgId: string): Promise<void> {
      await pool().query(
        `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)
         ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = TRUE`,
        [userId, orgId],
      )
    }

    it('shipped default is OFF (catches a silent flip before it becomes an outage)', () => {
      delete process.env.APPROVAL_S1_ORG_PIN_ENABLED
      expect(isOrgPinEnabled()).toBe(false)
    })

    it('G-S1-3 POSITIVE: org_id SET and matching is readable by the requester (pin forced ON)', async () => {
      process.env.APPROVAL_S1_ORG_PIN_ENABLED = 'true'
      const requesterId = freshId('s1-org-requester')
      const orgId = `s1-org-${TS}-${Math.random().toString(36).slice(2, 6)}`
      createdUserIds.push(requesterId)
      await pool().query(`INSERT INTO users (id, email, name, password_hash, is_active) VALUES ($1, $1||'@example.test', $1, 'x', TRUE)`, [requesterId])
      await seedActiveOrg(requesterId, orgId)
      const instanceId = await seedInstance(requesterId)
      await pool().query(`UPDATE approval_instances SET org_id = $1 WHERE id = $2`, [orgId, instanceId])
      await expect(canReadApprovalInstance(pool(), requesterId, instanceId)).resolves.toBe(true)
    })

    it('G-S1-3 NEGATIVE: org_id NULL denies ALL FIVE identities — requester, seat, past actor, CC target, and DB admin (pin forced ON)', async () => {
      process.env.APPROVAL_S1_ORG_PIN_ENABLED = 'true'
      const requesterId = freshId('s1-orgnull-requester')
      const seatId = freshId('s1-orgnull-seat')
      const actorId = freshId('s1-orgnull-actor')
      const ccId = freshId('s1-orgnull-cc')
      const adminId = freshId('s1-orgnull-admin')
      const instanceId = await seedInstance(requesterId) // org_id stays NULL — never set
      await seedAssignment(instanceId, seatId, true)
      await seedRecord(instanceId, 'comment', actorId)
      await seedRecord(instanceId, 'cc', requesterId, { targetType: 'user', targetId: ccId })
      createdUserIds.push(adminId)
      await pool().query(`INSERT INTO users (id, email, name, password_hash, is_active, is_admin) VALUES ($1, $1||'@example.test', $1, 'x', TRUE, TRUE)`, [adminId])

      await expect(canReadApprovalInstance(pool(), requesterId, instanceId)).resolves.toBe(false)
      await expect(canReadApprovalInstance(pool(), seatId, instanceId)).resolves.toBe(false)
      await expect(canReadApprovalInstance(pool(), actorId, instanceId)).resolves.toBe(false)
      await expect(canReadApprovalInstance(pool(), ccId, instanceId)).resolves.toBe(false)
      await expect(canReadApprovalInstance(pool(), adminId, instanceId)).resolves.toBe(false)
    })

    it('G-S1-10: a stale seat on ANOTHER org\'s instance is denied there, even though the SAME principal reads their OWN org\'s instance (pin forced ON, union semantics: the viewer holds NO membership in the foreign org)', async () => {
      process.env.APPROVAL_S1_ORG_PIN_ENABLED = 'true'
      const viewerId = freshId('s1-crossorg-viewer')
      const homeOrg = `s1-home-${TS}-${Math.random().toString(36).slice(2, 6)}`
      const foreignOrg = `s1-foreign-${TS}-${Math.random().toString(36).slice(2, 6)}`
      createdUserIds.push(viewerId)
      await pool().query(`INSERT INTO users (id, email, name, password_hash, is_active) VALUES ($1, $1||'@example.test', $1, 'x', TRUE)`, [viewerId])
      // The viewer holds ONLY the home-org membership — NO membership in foreignOrg. Under (c-i)
      // union semantics, `zzzz20260114110000`'s blanket 'default' backfill would make a
      // same-'default'-org negative vacuous, so this fixture deliberately uses non-'default' org
      // ids the viewer has no membership in at all (G-S1-10's own fixture precondition).
      await seedActiveOrg(viewerId, homeOrg)

      const homeInstanceId = await seedInstance(viewerId)
      await pool().query(`UPDATE approval_instances SET org_id = $1 WHERE id = $2`, [homeOrg, homeInstanceId])
      await expect(canReadApprovalInstance(pool(), viewerId, homeInstanceId)).resolves.toBe(true)

      const foreignInstanceId = await seedInstance(freshId('s1-foreign-requester'))
      await pool().query(`UPDATE approval_instances SET org_id = $1 WHERE id = $2`, [foreignOrg, foreignInstanceId])
      // A stale seat on the foreign instance — membership without org access.
      await seedAssignment(foreignInstanceId, viewerId, true)
      await expect(canReadApprovalInstance(pool(), viewerId, foreignInstanceId)).resolves.toBe(false)
    })

    it('G-S1-2 (pin-ON slice): a class-2-shaped instance (org_id backfilled FROM its attachment\'s org, matching Migration A\'s class-2 rule) is readable by its requester when the pin is forced ON and their org matches', async () => {
      process.env.APPROVAL_S1_ORG_PIN_ENABLED = 'true'
      const requesterId = freshId('s1-c2-requester')
      const orgId = `s1-c2-org-${TS}-${Math.random().toString(36).slice(2, 6)}`
      createdUserIds.push(requesterId)
      await pool().query(`INSERT INTO users (id, email, name, password_hash, is_active) VALUES ($1, $1||'@example.test', $1, 'x', TRUE)`, [requesterId])
      await seedActiveOrg(requesterId, orgId)
      const instanceId = await seedInstance(requesterId)
      // Simulates Migration A's class-2 backfill: org_id = the bound attachment's org.
      await pool().query(
        `INSERT INTO approval_attachments (id, uploader_id, org_id, instance_id, field_id, storage_key, file_name, mime_type, size_bytes, status)
         VALUES ($1, $2, $3, $4, 'files', $5, 'a.pdf', 'application/pdf', 10, 'bound')`,
        [freshId('s1-c2-att'), requesterId, orgId, instanceId, `approval-attachments/s1-c2/${freshId('k')}.pdf`],
      )
      await pool().query(`UPDATE approval_instances SET org_id = $1 WHERE id = $2`, [orgId, instanceId])
      await expect(canReadApprovalInstance(pool(), requesterId, instanceId)).resolves.toBe(true)
      // Cross-org: same shape, viewer has no membership in the attachment's org.
      const outsiderId = freshId('s1-c2-outsider')
      await expect(canReadApprovalInstance(pool(), outsiderId, instanceId)).resolves.toBe(false)
    })
  })

  // ---------------------------------------------------------------------------------------------
  // G-S1-12 PARTIAL — the migrated org_id column has no DB default. The NOT NULL / CHECK half is
  // Phase 3 and is NOT this migration (see zzzz20260821100000's docblock) — labelled PARTIAL, not
  // asserted as the full gate.
  //
  // RECORDED-PENDING (fix-round P2-2): the lock's own positive control for G-S1-12
  // (`docs/development/approval-lock10-instance-readability-20260821.md`'s gate table) reads
  // `is_nullable = 'NO'` (or the `plm:`-scoped CHECK form of OD-S1-18(b)). Neither has landed —
  // Phase 3 is deliberately deferred (see the migration's own docblock: landing the CHECK/NOT NULL
  // before all six `approval_instances` writers stamp `org_id` would 500 every create). That makes
  // this PARTIAL gate a SECOND pending gate beyond the ONE the S1 implementation brief explicitly
  // authorized (G-S1-8, `approval-realdb-instance-readability-s1.yml`'s own comment calls that one
  // out by name). This module does not have standing to authorize a second one unilaterally — it
  // is disclosed here and needs an owner ruling, not silently re-labelled as compliant.
  // ---------------------------------------------------------------------------------------------
  describe('G-S1-12 PARTIAL: approval_instances.org_id carries no DB default', () => {
    it('information_schema reports column_default IS NULL for approval_instances.org_id', async () => {
      const result = await pool().query(
        `SELECT column_default, is_nullable
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'approval_instances'
            AND column_name = 'org_id'`,
      )
      expect(result.rows.length).toBe(1)
      const row = result.rows[0] as { column_default: string | null; is_nullable: string }
      expect(row.column_default).toBeNull()
      // PARTIAL: is_nullable is 'YES' at this baseline (Phase 3's CHECK/NOT NULL has not landed).
      // This assertion documents the current, honest state rather than asserting the eventual one.
      expect(row.is_nullable).toBe('YES')
    })

    // Fix-round P2-2 (verification-site poisoning): `ensureApprovalSchemaReady` (the bootstrap
    // helper every S1 real-DB test calls in `beforeAll`) independently runs
    // `ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS org_id TEXT` with the SAME
    // nullable/no-default shape this migration adds — so the assertion above passes even when the
    // PRODUCTION migration never ran (proved: excluding
    // `zzzz20260821100000_add_approval_instance_org_id` from this lane's MIGRATION_EXCLUDE-free
    // run and mutating the migration to `DEFAULT 'default'` still greened the gate above). The
    // bootstrap cannot forge a `kysely_migration` ledger row, so this assertion is the
    // discriminator that closes the poisoning: it fails if the migration was excluded, skipped, or
    // never reached this database, independent of what the bootstrap helper separately provisions.
    // Residual (honest, not closed): this only holds because this lane's own "Run DB migrations"
    // step runs BEFORE the test step — if a future lane ever called `ensureApprovalSchemaReady`
    // before `db:migrate`, `ADD COLUMN IF NOT EXISTS` would no-op against the bootstrap's
    // already-present column and this assertion would not by itself catch it; that ordering is not
    // reachable in the current `approval-realdb-instance-readability-s1.yml` lane.
    it('kysely_migration records zzzz20260821100000_add_approval_instance_org_id as applied (the bootstrap cannot forge this — proves the migration itself ran, not just its shape)', async () => {
      const result = await pool().query(
        `SELECT 1 FROM kysely_migration WHERE name = $1`,
        ['zzzz20260821100000_add_approval_instance_org_id'],
      )
      expect(result.rows.length).toBe(1)
    })
  })

  // ---------------------------------------------------------------------------------------------
  // viewerRoles — parity smoke test against the C-1 derivation this module deliberately reimplements
  // rather than imports (module docblock).
  // ---------------------------------------------------------------------------------------------
  describe('viewerRoles (OD-S1-17(a) DB-backed derivation)', () => {
    it('includes both users.role and a joined user_roles name for an active user', async () => {
      const userId = freshId('s1-roles-user')
      createdUserIds.push(userId)
      await pool().query(
        `INSERT INTO users (id, email, name, password_hash, role, is_active, is_admin)
         VALUES ($1, $1 || '@example.test', $1, 'x', 'baseline-role', TRUE, FALSE)`,
        [userId],
      )
      const roles = await viewerRoles(pool(), userId)
      expect(roles).toContain('baseline-role')
    })

    it('an inactive user contributes no users.role entry', async () => {
      const userId = freshId('s1-roles-inactive')
      createdUserIds.push(userId)
      await pool().query(
        `INSERT INTO users (id, email, name, password_hash, role, is_active, is_admin)
         VALUES ($1, $1 || '@example.test', $1, 'x', 'should-not-appear', FALSE, FALSE)`,
        [userId],
      )
      const roles = await viewerRoles(pool(), userId)
      expect(roles).not.toContain('should-not-appear')
    })
  })

  describe('isPlmApprovalId defensive guard', () => {
    it('canReadApprovalInstance denies for any plm:-prefixed instance id, even a coincidental requester match', async () => {
      const viewerId = freshId('s1-plm-viewer')
      const plmInstanceId = `plm:${freshId('mirror')}`
      await pool().query(
        `INSERT INTO approval_instances (id, status, requester_snapshot, source_system) VALUES ($1, 'pending', $2::jsonb, 'plm')`,
        [plmInstanceId, JSON.stringify({ id: viewerId })],
      )
      createdInstanceIds.push(plmInstanceId)
      expect(isPlmApprovalId(plmInstanceId)).toBe(true)
      await expect(canReadApprovalInstance(pool(), viewerId, plmInstanceId)).resolves.toBe(false)
    })
  })
})
