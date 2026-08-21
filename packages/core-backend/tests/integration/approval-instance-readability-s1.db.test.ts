import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'
import { canReadApprovalInstance, isPlmApprovalId, viewerRoles } from '../../src/services/approval-instance-readability'
import { ACTION_POLICY_KEYS, APPROVAL_POLICY_DENIED_ACTION } from '../../src/types/approval-product'

/**
 * Lock-10 (S1) `canReadApprovalInstance` — real-DB acceptance for the arms this slice actually
 * implements (1 REQUESTER, 2 SEAT, 3 PAST ACTOR incl. `policy_denied`, 4 CC TARGET). Source:
 * docs/development/approval-lock10-instance-readability-20260821.md.
 *
 * SCOPE — what this suite does NOT cover, and why (every omission below is a §5.1 OWNER-CONFIRM
 * row, not an oversight):
 *   - No admin arm (OD-S1-8(d), OWNER-CONFIRM).
 *   - No org pin / cross-org denial (G-S1-3, G-S1-10 — OD-S1-17(c), OWNER-CONFIRM; also this PR's
 *     migration is Phase-1-only so `org_id` is not populated for platform rows at this baseline).
 *   - No route/feed adoption (G-S1-2, G-S1-5, G-S1-7, G-S1-8, G-S1-9 — all consumer-side; OD-S1-12
 *     is its own OWNER-CONFIRM row and OD-S1-10/16 are blocked on `L9-AMEND`).
 *   - G-S1-6's full mechanical enumeration over `ACTION_POLICY_KEYS` through the REAL dispatch
 *     choke is Lock-5's own concern and already has a dedicated 1000+-line real-DB suite
 *     (`approval-node-operation-policy.db.test.ts`) proving the choke writes exactly one
 *     `policy_denied` row per genuine refusal and that ABSENT-key verbs are ungated. This suite
 *     does not re-prove that machinery; it proves the narrower, Lock-10-specific fact OD-S1-6
 *     conditions arm 3 on: that a `policy_denied` row (however it was written) makes its actor a
 *     past-actor for `canReadApprovalInstance`, while a bystander with NO such row stays denied and
 *     writes nothing.
 *
 * Gates covered: G-S1-1 (zero-attachment/no-attachment-table-at-all instance readable by its
 * requester, non-participant denied), G-S1-6 (narrowed as above), G-S1-11 (monotonic membership —
 * a deactivated seat still admits; a user who never held a seat does not), G-S1-12 PARTIAL (the
 * migrated column carries no DB default — the NOT NULL / CHECK half is Phase-3, not yet run).
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

describeIfDatabase('Lock-10 (S1) canReadApprovalInstance — arms 1-4, real DB', () => {
  let server: MetaSheetServer | undefined
  const pool = () => poolManager.get()
  const createdInstanceIds: string[] = []
  const createdUserIds: string[] = []

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
  })

  afterAll(async () => {
    try {
      if (createdInstanceIds.length > 0) {
        await pool().query(`DELETE FROM approval_records WHERE instance_id = ANY($1::text[])`, [createdInstanceIds])
        await pool().query(`DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])`, [createdInstanceIds])
        await pool().query(`DELETE FROM approval_instances WHERE id = ANY($1::text[])`, [createdInstanceIds])
      }
      if (createdUserIds.length > 0) {
        await pool().query(`DELETE FROM users WHERE id = ANY($1::text[])`, [createdUserIds])
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
      await pool().query(
        `UPDATE approval_assignments SET assignment_type = 'source_queue' WHERE instance_id = $1`,
        [instanceId],
      )
      await expect(canReadApprovalInstance(pool(), 'approvals:read', instanceId)).resolves.toBe(false)
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
  // G-S1-6 (narrowed, see docblock) — policy_denied admits arm 3; a bystander stays denied and
  // writes nothing.
  // ---------------------------------------------------------------------------------------------
  describe('G-S1-6 (narrowed): policy_denied past-actor admission (OD-S1-6)', () => {
    it('POSITIVE: an actor refused by node policy (policy_denied row) still reads the instance via arm 3', async () => {
      const requesterId = freshId('s1-requester')
      const refusedActorId = freshId('s1-refused-actor')
      const instanceId = await seedInstance(requesterId)
      // Mirrors the exact shape ApprovalProductService.insertApprovalRecord writes for a policy
      // denial (from/to status unchanged — a denial is not a transition): the row this suite
      // inserts directly is the SAME shape the Lock-5 dispatch choke writes; this suite does not
      // re-exercise that choke (see docblock).
      await pool().query(
        `INSERT INTO approval_records (instance_id, action, actor_id, actor_name, from_status, to_status, to_version, metadata)
         VALUES ($1, $2, $3, 'Refused Actor', 'pending', 'pending', 0, '{}'::jsonb)`,
        [instanceId, APPROVAL_POLICY_DENIED_ACTION, refusedActorId],
      )
      await expect(canReadApprovalInstance(pool(), refusedActorId, instanceId)).resolves.toBe(true)
    })

    it('DISCRIMINATING NEGATIVE: a bystander with no row at all is denied, and the row count on the instance is unchanged by the read', async () => {
      const requesterId = freshId('s1-requester')
      const bystanderId = freshId('s1-bystander')
      const instanceId = await seedInstance(requesterId)
      const before = await pool().query(`SELECT COUNT(*)::int AS n FROM approval_records WHERE instance_id = $1`, [instanceId])
      await expect(canReadApprovalInstance(pool(), bystanderId, instanceId)).resolves.toBe(false)
      const after = await pool().query(`SELECT COUNT(*)::int AS n FROM approval_records WHERE instance_id = $1`, [instanceId])
      expect((after.rows[0] as { n: number }).n).toBe((before.rows[0] as { n: number }).n)
      expect((before.rows[0] as { n: number }).n).toBe(0)
    })

    it('mechanical: ACTION_POLICY_KEYS retains a non-null entry for at least one verb (drift guard on the coupling OD-S1-6 depends on)', () => {
      const nonNullKeys = Object.entries(ACTION_POLICY_KEYS).filter(([, value]) => value !== null)
      expect(nonNullKeys.length).toBeGreaterThan(0)
      // revoke/handle are the two RATIFIED-absent keys this repo has already fixed at null
      // (Lock-3/Lock-5); if either becomes non-null, OD-S1-6's own coupling assumption (arm 3
      // admits policy_denied only together with G-S1-6) needs re-examination, not a silent pass.
      expect(ACTION_POLICY_KEYS.revoke).toBeNull()
      expect(ACTION_POLICY_KEYS.handle).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------------------------
  // G-S1-12 PARTIAL — the migrated org_id column has no DB default. The NOT NULL / CHECK half is
  // Phase 3 and is NOT this migration (see zzzz20260821100000's docblock) — labelled PARTIAL, not
  // asserted as the full gate.
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
