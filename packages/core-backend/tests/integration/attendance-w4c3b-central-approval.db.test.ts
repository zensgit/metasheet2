/**
 * W4C-3b Stage R0 — real-PostgreSQL legs for central attendance classification,
 * bulk reassign auth matrix, fail-closed terminal/mutation guards, and
 * reassign-vs-decision serialization.
 *
 * Requires a fully migrated database (ATTENDANCE_TEST_DATABASE_URL || DATABASE_URL).
 * Seeds authoritative required columns on existing tables only — does not weaken
 * production schema into mini-table shapes.
 *
 * Env bootstrap MUST be the first import so product/bridge pools bind the scratch URL.
 */
import './attendance-w4c3b-central-approval.env'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import {
  ATTENDANCE_APPROVAL_WORKFLOW_KEY,
  ATTENDANCE_REQUEST_BUSINESS_KEY_PREFIX,
  W4C3B_CENTRAL_APPROVAL_ERROR_CODES,
  assertAttendanceCentralMutationFailClosed,
  authorizeAttendanceCentralReassign,
  classifyAndLockAttendanceRequestForInstance,
  filterBulkReassignDiscoveryForAttendance,
  lockAndValidateAttendanceReassignTarget,
} from '../../src/attendance/w4c3b-central-approval-hooks'
import {
  ApprovalBridgeService,
  ServiceError,
  __setW4c3bBridgeDispatchTestBarrierForTests,
} from '../../src/services/ApprovalBridgeService'
import {
  ApprovalProductService,
  __setW4c3bBulkReassignTestBarrierForTests,
} from '../../src/services/ApprovalProductService'
import { executeApprovalActionFromCardDelivery } from '../../src/services/ApprovalCardDeliveryAction'
import {
  insertDingTalkApprovalCardDelivery,
  markDingTalkApprovalCardDeliverySent,
} from '../../src/integrations/dingtalk/approval-card-deliveries'

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const RUN = crypto.randomUUID().slice(0, 8)
const NS = `w4c3b-r0-${RUN}`
const ORG_A = `${NS}-org-a`
const ORG_B = `${NS}-org-b`

function id(label: string): string {
  return `${NS}-${label}`
}

function emailFor(label: string): string {
  return `${NS}-${label}@example.test`
}

function uuid(): string {
  return crypto.randomUUID()
}

async function withClient<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // ignore
    }
    throw error
  } finally {
    client.release()
  }
}

describeIfDatabase('W4C-3b R0 central approval (real DB)', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const product = new ApprovalProductService()
  const bridge = new ApprovalBridgeService(null)

  const actorOrgAdmin = id('actor-org-admin')
  const actorMissingApprovals = id('actor-miss-appr')
  const actorMissingAttendance = id('actor-miss-att')
  const actorPlatform = id('actor-platform')
  const actorOtherOrg = id('actor-other-org')
  const targetOk = id('target-ok')
  const targetOtherOrg = id('target-other')
  /** is_active=true so global reassign precheck passes; pending_activation fails matrix. */
  const targetInactive = id('target-pending-act')
  const fromAssignee = id('from-assignee')
  const subjectUser = id('subject')

  const trackedUserIds: string[] = []
  const trackedInstanceIds: string[] = []
  const trackedTemplateIds: string[] = []
  const trackedPublishedDefIds: string[] = []

  async function assertFullSchema(): Promise<void> {
    const required = [
      'users',
      'user_orgs',
      'user_roles',
      'user_permissions',
      'permissions',
      'roles',
      'approval_instances',
      'approval_assignments',
      'approval_records',
      'dingtalk_approval_card_deliveries',
      'attendance_requests',
      'approval_templates',
      'approval_template_versions',
      'approval_published_definitions',
    ]
    const found = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])`,
      [required],
    )
    const names = new Set(found.rows.map((r) => r.table_name))
    const missing = required.filter((t) => !names.has(t))
    if (missing.length) {
      throw new Error(
        `W4C-3b R0 requires a fully migrated DB; missing tables: ${missing.join(', ')}`,
      )
    }
    // Reject mini-shape: password_hash must exist and be NOT NULL on full schema.
    const col = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'password_hash'`,
    )
    if (col.rows.length !== 1 || col.rows[0].is_nullable !== 'NO') {
      throw new Error('users.password_hash must be NOT NULL (fully migrated schema required)')
    }
  }

  async function upsertUser(opts: {
    id: string
    activation?: 'activated' | 'pending_activation'
    isActive?: boolean
    isAdmin?: boolean
  }): Promise<void> {
    const label = opts.id.slice(NS.length + 1) || opts.id
    await pool.query(
      `INSERT INTO users (
         id, email, username, name, password_hash, role, permissions,
         is_active, is_admin, activation_status, local_password_set,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, 'w4c3b-r0-test-hash', 'user', '[]'::jsonb,
         $5, $6, $7, TRUE,
         NOW(), NOW()
       )
       ON CONFLICT (id) DO UPDATE
         SET email = EXCLUDED.email,
             username = EXCLUDED.username,
             name = EXCLUDED.name,
             password_hash = EXCLUDED.password_hash,
             is_active = EXCLUDED.is_active,
             is_admin = EXCLUDED.is_admin,
             activation_status = EXCLUDED.activation_status,
             updated_at = NOW()`,
      [
        opts.id,
        emailFor(label),
        `${NS}_${label}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 60),
        `W4C3B R0 ${label}`,
        opts.isActive !== false,
        opts.isAdmin === true,
        opts.activation ?? 'activated',
      ],
    )
    if (!trackedUserIds.includes(opts.id)) trackedUserIds.push(opts.id)
  }

  async function cleanupNamespace(): Promise<void> {
    // Child → parent order; all ids / keys are NS-prefixed.
    await pool.query(`DELETE FROM dingtalk_approval_card_deliveries WHERE instance_id LIKE $1`, [`${NS}%`])
    await pool.query(`DELETE FROM approval_records WHERE instance_id LIKE $1`, [`${NS}%`])
    await pool.query(`DELETE FROM approval_assignments WHERE instance_id LIKE $1`, [`${NS}%`])
    await pool.query(
      `DELETE FROM attendance_requests
        WHERE approval_instance_id LIKE $1
           OR user_id LIKE $1
           OR org_id LIKE $1`,
      [`${NS}%`],
    )
    await pool.query(`DELETE FROM approval_instances WHERE id LIKE $1`, [`${NS}%`])
    if (trackedPublishedDefIds.length) {
      await pool.query(
        `DELETE FROM approval_published_definitions WHERE id = ANY($1::uuid[])`,
        [trackedPublishedDefIds],
      )
    }
    await pool.query(
      `DELETE FROM approval_published_definitions
        WHERE template_id IN (SELECT id FROM approval_templates WHERE key LIKE $1)`,
      [`${NS}%`],
    )
    await pool.query(
      `DELETE FROM approval_template_versions
        WHERE template_id IN (SELECT id FROM approval_templates WHERE key LIKE $1)`,
      [`${NS}%`],
    )
    await pool.query(`DELETE FROM approval_templates WHERE key LIKE $1`, [`${NS}%`])
    await pool.query(`DELETE FROM user_permissions WHERE user_id LIKE $1`, [`${NS}%`])
    await pool.query(`DELETE FROM user_roles WHERE user_id LIKE $1`, [`${NS}%`])
    await pool.query(`DELETE FROM user_orgs WHERE user_id LIKE $1 OR org_id LIKE $1`, [`${NS}%`])
    await pool.query(`DELETE FROM users WHERE id LIKE $1`, [`${NS}%`])
  }

  /**
   * Seed a real published_definition parent chain (FK-valid adversarial fixture).
   * Never invents a bare UUID for approval_instances.published_definition_id —
   * the full schema FK to approval_published_definitions must stay enforced.
   */
  async function seedPublishedDefinition(): Promise<string> {
    const templateId = uuid()
    const versionId = uuid()
    const publishedId = uuid()
    const key = `${NS}-tpl-${templateId.slice(0, 8)}`
    trackedTemplateIds.push(templateId)
    trackedPublishedDefIds.push(publishedId)
    await pool.query(
      `INSERT INTO approval_templates (id, key, name, status, visibility_scope)
       VALUES ($1, $2, $3, 'published', '{"type":"all","ids":[]}'::jsonb)`,
      [templateId, key, `W4C3B R0 ${key}`],
    )
    await pool.query(
      `INSERT INTO approval_template_versions
         (id, template_id, version, status, form_schema, approval_graph)
       VALUES ($1, $2, 1, 'published', '{}'::jsonb, '{}'::jsonb)`,
      [versionId, templateId],
    )
    // Unique partial index: only one is_active per template.
    await pool.query(
      `INSERT INTO approval_published_definitions
         (id, template_id, template_version_id, runtime_graph, is_active)
       VALUES ($1, $2, $3, '{}'::jsonb, TRUE)`,
      [publishedId, templateId, versionId],
    )
    const check = await pool.query(
      `SELECT 1 FROM approval_published_definitions WHERE id = $1::uuid`,
      [publishedId],
    )
    if (check.rows.length !== 1) {
      throw new Error('seedPublishedDefinition failed to materialize parent row')
    }
    return publishedId
  }

  beforeAll(async () => {
    await assertFullSchema()
    // Defensive: clear any prior interrupted run with same connection string.
    await cleanupNamespace()

    // Ensure catalog permission rows exist (FK on user_permissions); do not invent codes.
    for (const code of ['approvals:admin', 'attendance:admin']) {
      const exists = await pool.query(`SELECT 1 FROM permissions WHERE code = $1`, [code])
      if (exists.rows.length === 0) {
        throw new Error(`Fully migrated DB missing permissions.code=${code}`)
      }
    }
    const adminRole = await pool.query(`SELECT 1 FROM roles WHERE id = 'admin'`)
    if (adminRole.rows.length === 0) {
      throw new Error(`Fully migrated DB missing roles.id=admin`)
    }

    const users: Array<{
      id: string
      activation?: 'activated' | 'pending_activation'
      isAdmin?: boolean
    }> = [
      { id: actorOrgAdmin },
      { id: actorMissingApprovals },
      { id: actorMissingAttendance },
      { id: actorPlatform, isAdmin: true },
      { id: actorOtherOrg },
      { id: targetOk },
      { id: targetOtherOrg },
      { id: targetInactive, activation: 'pending_activation' },
      { id: fromAssignee },
      { id: subjectUser },
    ]
    for (const u of users) {
      await upsertUser(u)
    }

    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')
       ON CONFLICT DO NOTHING`,
      [actorPlatform],
    )

    const memberships: Array<[string, string]> = [
      [actorOrgAdmin, ORG_A],
      [actorMissingApprovals, ORG_A],
      [actorMissingAttendance, ORG_A],
      [actorOtherOrg, ORG_B],
      [targetOk, ORG_A],
      [targetOtherOrg, ORG_B],
      [targetInactive, ORG_A],
      [fromAssignee, ORG_A],
      [subjectUser, ORG_A],
    ]
    for (const [userId, orgId] of memberships) {
      await pool.query(
        `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)
         ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = TRUE`,
        [userId, orgId],
      )
    }

    async function grant(userId: string, codes: string[]) {
      for (const code of codes) {
        await pool.query(
          `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [userId, code],
        )
      }
    }
    await grant(actorOrgAdmin, ['approvals:admin', 'attendance:admin'])
    await grant(actorMissingApprovals, ['attendance:admin'])
    await grant(actorMissingAttendance, ['approvals:admin'])
  }, 120_000)

  afterAll(async () => {
    try {
      await cleanupNamespace()
      const residue = await pool.query<{ kind: string; n: string }>(
        `SELECT 'users' AS kind, count(*)::text AS n FROM users WHERE id LIKE $1
         UNION ALL
         SELECT 'user_orgs', count(*)::text FROM user_orgs WHERE user_id LIKE $1 OR org_id LIKE $1
         UNION ALL
         SELECT 'approval_instances', count(*)::text FROM approval_instances WHERE id LIKE $1
         UNION ALL
         SELECT 'attendance_requests', count(*)::text FROM attendance_requests
           WHERE approval_instance_id LIKE $1 OR user_id LIKE $1 OR org_id LIKE $1
         UNION ALL
         SELECT 'approval_templates', count(*)::text FROM approval_templates WHERE key LIKE $1`,
        [`${NS}%`],
      )
      const leftover = residue.rows.filter((r) => Number(r.n) > 0)
      if (leftover.length) {
        // Surface residue but still close the pool.
        console.error('W4C-3b R0 cleanup residue:', leftover)
      }
    } finally {
      await pool.end()
    }
  })

  async function seedAttendanceInstance(opts: {
    instanceId: string
    requestId?: string
    orgId?: string
    publishedDefinitionId?: string | null
    version?: number
    withAssignmentFrom?: string
    nodeKey?: string
    entryEpoch?: number
  }) {
    const requestId = opts.requestId ?? uuid()
    const orgId = opts.orgId ?? ORG_A
    const nodeKey = opts.nodeKey ?? 'node-1'
    const version = opts.version ?? 1
    if (!trackedInstanceIds.includes(opts.instanceId)) trackedInstanceIds.push(opts.instanceId)
    await pool.query(`DELETE FROM approval_records WHERE instance_id = $1`, [opts.instanceId])
    await pool.query(`DELETE FROM approval_assignments WHERE instance_id = $1`, [opts.instanceId])
    await pool.query(`DELETE FROM attendance_requests WHERE approval_instance_id = $1`, [opts.instanceId])
    await pool.query(`DELETE FROM approval_instances WHERE id = $1`, [opts.instanceId])

    // Adversarial published_definition_id must reference a real parent (FK enforced).
    if (opts.publishedDefinitionId) {
      const parent = await pool.query(
        `SELECT 1 FROM approval_published_definitions WHERE id = $1::uuid`,
        [opts.publishedDefinitionId],
      )
      if (parent.rows.length !== 1) {
        throw new Error(
          `published_definition_id ${opts.publishedDefinitionId} has no approval_published_definitions parent — call seedPublishedDefinition()`,
        )
      }
    }

    await pool.query(
      `INSERT INTO approval_instances
         (id, status, version, source_system, workflow_key, business_key, title,
          requester_snapshot, subject_snapshot, policy_snapshot, metadata,
          current_step, total_steps, sync_status, current_node_key, published_definition_id)
       VALUES
         ($1, 'pending', $2, 'platform', $3, $4, 'att',
          $5::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
          0, 1, 'ok', $6, $7)`,
      [
        opts.instanceId,
        version,
        ATTENDANCE_APPROVAL_WORKFLOW_KEY,
        `${ATTENDANCE_REQUEST_BUSINESS_KEY_PREFIX}${requestId}`,
        JSON.stringify({ id: subjectUser }),
        nodeKey,
        opts.publishedDefinitionId ?? null,
      ],
    )
    await pool.query(
      `INSERT INTO attendance_requests
         (id, user_id, org_id, work_date, request_type, status, approval_instance_id, metadata)
       VALUES ($1::uuid, $2, $3, CURRENT_DATE, 'leave', 'pending', $4, '{}'::jsonb)`,
      [requestId, subjectUser, orgId, opts.instanceId],
    )
    if (opts.withAssignmentFrom) {
      await pool.query(
        `INSERT INTO approval_assignments
           (instance_id, assignment_type, assignee_id, source_step, node_key, entry_epoch, is_active, metadata)
         VALUES ($1, 'user', $2, 0, $3, $4, TRUE, '{}'::jsonb)`,
        [
          opts.instanceId,
          opts.withAssignmentFrom,
          nodeKey,
          opts.entryEpoch ?? 7,
        ],
      )
    }
    return { requestId, orgId, nodeKey, version }
  }

  async function seedNonAttendanceInstance(instanceId: string, fromUser: string) {
    if (!trackedInstanceIds.includes(instanceId)) trackedInstanceIds.push(instanceId)
    await pool.query(`DELETE FROM approval_assignments WHERE instance_id = $1`, [instanceId])
    await pool.query(`DELETE FROM approval_records WHERE instance_id = $1`, [instanceId])
    await pool.query(`DELETE FROM approval_instances WHERE id = $1`, [instanceId])
    await pool.query(
      `INSERT INTO approval_instances
         (id, status, version, source_system, workflow_key, business_key,
          requester_snapshot, subject_snapshot, policy_snapshot, metadata,
          current_step, total_steps, sync_status, current_node_key)
       VALUES ($1, 'pending', 1, 'platform', 'generic.flow', $2,
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
          0, 1, 'ok', 'node-1')`,
      [instanceId, `${NS}-generic:${instanceId}`],
    )
    await pool.query(
      `INSERT INTO approval_assignments
         (instance_id, assignment_type, assignee_id, source_step, node_key, entry_epoch, is_active, metadata)
       VALUES ($1, 'user', $2, 0, 'node-1', 3, TRUE, '{}'::jsonb)`,
      [instanceId, fromUser],
    )
  }

  beforeEach(async () => {
    // Keep seeded users/permissions; instances are recreated per test.
  })

  it('classifies normal and published_definition_id adversarial attendance the same way', async () => {
    const normalId = id('cls-normal')
    const advId = id('cls-adv')
    const publishedDefinitionId = await seedPublishedDefinition()
    const normal = await seedAttendanceInstance({ instanceId: normalId })
    const adv = await seedAttendanceInstance({
      instanceId: advId,
      publishedDefinitionId,
    })

    await withClient(pool, async (client) => {
      const normalInst = (
        await client.query(`SELECT * FROM approval_instances WHERE id = $1 FOR UPDATE`, [normalId])
      ).rows[0]
      const advInst = (
        await client.query(`SELECT * FROM approval_instances WHERE id = $1 FOR UPDATE`, [advId])
      ).rows[0]
      const c1 = await classifyAndLockAttendanceRequestForInstance(client, normalInst)
      const c2 = await classifyAndLockAttendanceRequestForInstance(client, advInst)
      expect(c1.kind).toBe('attendance')
      expect(c2.kind).toBe('attendance')
      if (c1.kind === 'attendance' && c2.kind === 'attendance') {
        expect(c1.request?.orgId).toBe(ORG_A)
        expect(c2.request?.orgId).toBe(ORG_A)
        expect(c1.request?.requestId).toBe(normal.requestId)
        expect(c2.request?.requestId).toBe(adv.requestId)
      }
    })
  })

  it('fail-closed guards block legacy/bridge/product mutation before DML (normal + adversary)', async () => {
    const adversaryPub = await seedPublishedDefinition()
    for (const [label, pub] of [
      ['normal', null],
      ['adversary', adversaryPub],
    ] as const) {
      const instanceId = id(`fail-${label}`)
      await seedAttendanceInstance({
        instanceId,
        publishedDefinitionId: pub,
        withAssignmentFrom: fromAssignee,
      })
      const before = await pool.query(
        `SELECT version, status FROM approval_instances WHERE id = $1`,
        [instanceId],
      )

      await withClient(pool, async (client) => {
        const inst = (
          await client.query(`SELECT * FROM approval_instances WHERE id = $1 FOR UPDATE`, [instanceId])
        ).rows[0]
        await expect(assertAttendanceCentralMutationFailClosed(client, inst)).rejects.toMatchObject({
          code: W4C3B_CENTRAL_APPROVAL_ERROR_CODES.ATTENDANCE_CENTRAL_MUTATION_UNSUPPORTED,
        })
      })

      await expect(
        bridge.dispatchAction(
          instanceId,
          { action: 'approve', comment: 'x' },
          { userId: actorOrgAdmin, userName: 'admin' },
        ),
      ).rejects.toBeInstanceOf(ServiceError)

      await expect(
        product.dispatchAction(
          instanceId,
          { action: 'approve', comment: 'x' },
          { userId: fromAssignee, userName: 'assignee', roles: [] },
        ),
      ).rejects.toMatchObject({
        code: W4C3B_CENTRAL_APPROVAL_ERROR_CODES.ATTENDANCE_CENTRAL_MUTATION_UNSUPPORTED,
      })

      const after = await pool.query(
        `SELECT version, status FROM approval_instances WHERE id = $1`,
        [instanceId],
      )
      expect(after.rows[0]).toEqual(before.rows[0])
      const asg = await pool.query(
        `SELECT is_active FROM approval_assignments WHERE instance_id = $1`,
        [instanceId],
      )
      expect(asg.rows.every((r) => r.is_active === true)).toBe(true)
    }
  })

  it('keeps an actionable DingTalk attendance card fail-closed before decision DML', async () => {
    const instanceId = id('card-fail-closed')
    const seeded = await seedAttendanceInstance({
      instanceId,
      withAssignmentFrom: actorOrgAdmin,
      entryEpoch: 71,
    })
    const delivery = await insertDingTalkApprovalCardDelivery(
      (text, params) => pool.query(text, params),
      {
        instanceId,
        nodeKey: seeded.nodeKey,
        recipientUserId: actorOrgAdmin,
        recipientDingTalkUserId: `dd-${actorOrgAdmin}`,
        deliveryKind: 'work_notice_action_card',
        entryEpoch: 71,
      },
    )
    await markDingTalkApprovalCardDeliverySent(
      (text, params) => pool.query(text, params),
      delivery.id,
      `${NS}-card-task`,
    )

    const secret = `${NS}-card-secret`
    const priorSecret = process.env.APPROVAL_CARD_LINK_SECRET
    process.env.APPROVAL_CARD_LINK_SECRET = secret
    const token = crypto.createHmac('sha256', secret).update(delivery.id).digest('hex').slice(0, 32)

    try {
      const outcome = await executeApprovalActionFromCardDelivery(
        {
          query: (text, params) => pool.query(text, params),
          approvals: product,
        },
        {
          deliveryId: delivery.id,
          token,
          decision: 'reject',
          comment: 'attendance card must use the canonical request decision boundary',
          actor: { userId: actorOrgAdmin, userName: actorOrgAdmin },
        },
      )
      expect(outcome).toMatchObject({
        status: 'engine_rejected',
        code: W4C3B_CENTRAL_APPROVAL_ERROR_CODES.ATTENDANCE_CENTRAL_MUTATION_UNSUPPORTED,
        httpStatus: 409,
      })

      const state = await pool.query(
        `SELECT ai.status AS approval_status,
                ai.version AS approval_version,
                ar.status AS request_status,
                count(DISTINCT aa.id) FILTER (WHERE aa.is_active = TRUE)::int AS active_assignments,
                count(DISTINCT rec.id)::int AS approval_records,
                card.card_state,
                card.send_status,
                (SELECT count(*)::int
                   FROM attendance_result_operations op
                  WHERE op.org_id = ar.org_id
                    AND op.resolved_request_id = ar.id) AS operations,
                (SELECT count(*)::int
                   FROM attendance_result_event_outbox outbox
                   JOIN attendance_result_operations op
                     ON op.org_id = outbox.org_id
                    AND op.entrypoint = outbox.entrypoint
                    AND op.operation_id = outbox.operation_id
                  WHERE op.org_id = ar.org_id
                    AND op.resolved_request_id = ar.id) AS outbox
           FROM approval_instances ai
           JOIN attendance_requests ar ON ar.approval_instance_id = ai.id
           JOIN dingtalk_approval_card_deliveries card ON card.instance_id = ai.id
           LEFT JOIN approval_assignments aa ON aa.instance_id = ai.id
           LEFT JOIN approval_records rec ON rec.instance_id = ai.id
          WHERE ai.id = $1 AND card.id = $2
          GROUP BY ai.status, ai.version, ar.status, ar.org_id, ar.id,
                   card.card_state, card.send_status`,
        [instanceId, delivery.id],
      )
      expect(state.rows).toEqual([{
        approval_status: 'pending',
        approval_version: 1,
        request_status: 'pending',
        active_assignments: 1,
        approval_records: 0,
        card_state: 'sent',
        send_status: 'sent',
        operations: 0,
        outbox: 0,
      }])
    } finally {
      if (priorSecret === undefined) delete process.env.APPROVAL_CARD_LINK_SECRET
      else process.env.APPROVAL_CARD_LINK_SECRET = priorSecret
      await pool.query(`DELETE FROM dingtalk_approval_card_deliveries WHERE id = $1`, [delivery.id])
    }
  })

  it('bulk reassign: same-org success preserves entry_epoch and writes platform/org audit', async () => {
    const instanceId = id('reassign-ok')
    await seedAttendanceInstance({
      instanceId,
      withAssignmentFrom: fromAssignee,
      entryEpoch: 11,
    })

    const result = await product.bulkReassignApprovals(
      {
        fromUserId: fromAssignee,
        toUserId: targetOk,
        instanceIds: [instanceId],
        reason: 'handover',
      },
      { userId: actorOrgAdmin, userName: 'org-admin', roles: [], permissions: [] },
    )
    expect(result.succeeded).toContain(instanceId)
    expect(result.skipped).toEqual([])

    const seats = await pool.query(
      `SELECT assignee_id, entry_epoch, is_active, node_key
         FROM approval_assignments
        WHERE instance_id = $1
        ORDER BY is_active DESC, created_at ASC`,
      [instanceId],
    )
    const active = seats.rows.filter((r) => r.is_active)
    expect(active).toHaveLength(1)
    expect(active[0].assignee_id).toBe(targetOk)
    expect(Number(active[0].entry_epoch)).toBe(11)

    const records = await pool.query(
      `SELECT metadata FROM approval_records
        WHERE instance_id = $1 AND action = 'reassign'
        ORDER BY id DESC LIMIT 1`,
      [instanceId],
    )
    const meta = records.rows[0]?.metadata
    expect(meta?.attendanceW4c3bReassign?.actorPosture).toBe('org_admin')
    expect(meta?.attendanceW4c3bReassign?.orgId).toBe(ORG_A)
  })

  it('bulk reassign: platform-admin override audits platform_admin witness', async () => {
    const instanceId = id('reassign-plat')
    await seedAttendanceInstance({
      instanceId,
      withAssignmentFrom: fromAssignee,
    })
    const result = await product.bulkReassignApprovals(
      {
        fromUserId: fromAssignee,
        toUserId: targetOk,
        instanceIds: [instanceId],
        reason: 'platform-handover',
      },
      { userId: actorPlatform, userName: 'platform', roles: ['admin'], permissions: [] },
    )
    expect(result.succeeded).toContain(instanceId)
    const records = await pool.query(
      `SELECT metadata FROM approval_records
        WHERE instance_id = $1 AND action = 'reassign'
        ORDER BY id DESC LIMIT 1`,
      [instanceId],
    )
    expect(records.rows[0]?.metadata?.attendanceW4c3bReassign?.actorPosture).toBe('platform_admin')
  })

  it('bulk reassign: missing each permission / cross-org actor → not-found skip', async () => {
    for (const actorId of [actorMissingApprovals, actorMissingAttendance, actorOtherOrg]) {
      const instanceId = id(`deny-${actorId.slice(-6)}`)
      await seedAttendanceInstance({
        instanceId,
        withAssignmentFrom: fromAssignee,
      })
      const result = await product.bulkReassignApprovals(
        {
          fromUserId: fromAssignee,
          toUserId: targetOk,
          instanceIds: [instanceId],
          reason: 'deny',
        },
        { userId: actorId, userName: 'x', roles: [], permissions: [] },
      )
      expect(result.succeeded).toEqual([])
      expect(result.skipped).toEqual([{ id: instanceId, reason: 'not-found' }])
      const version = await pool.query(`SELECT version FROM approval_instances WHERE id = $1`, [
        instanceId,
      ])
      expect(Number(version.rows[0].version)).toBe(1)
    }
  })

  it('bulk reassign: pending_activation and cross-org targets → target-user-invalid', async () => {
    for (const [label, target] of [
      ['pending-activation', targetInactive],
      ['cross-org', targetOtherOrg],
    ] as const) {
      const instanceId = id(`tgt-${label}`)
      await seedAttendanceInstance({
        instanceId,
        withAssignmentFrom: fromAssignee,
      })
      const result = await product.bulkReassignApprovals(
        {
          fromUserId: fromAssignee,
          toUserId: target,
          instanceIds: [instanceId],
          reason: 'bad-target',
        },
        { userId: actorOrgAdmin, userName: 'org-admin', roles: [], permissions: [] },
      )
      expect(result.skipped).toEqual([{ id: instanceId, reason: 'target-user-invalid' }])
      expect(result.succeeded).toEqual([])
    }
  })

  it('discovery excludes unauthorized attendance; non-attendance remains', async () => {
    const attId = id('disc-att')
    const nonId = id('disc-non')
    await seedAttendanceInstance({ instanceId: attId, withAssignmentFrom: fromAssignee })
    await seedNonAttendanceInstance(nonId, fromAssignee)

    const filtered = await filterBulkReassignDiscoveryForAttendance(pool, actorMissingApprovals, [
      attId,
      nonId,
    ])
    expect(filtered).toEqual([nonId])

    const asOrgAdmin = await filterBulkReassignDiscoveryForAttendance(pool, actorOrgAdmin, [
      attId,
      nonId,
    ])
    expect(asOrgAdmin.sort()).toEqual([attId, nonId].sort())
  })

  it('production bulkReassign vs bridge decision race: exactly one claims original version (both orders)', async () => {
    // Non-attendance platform instance: bridge decision is a real terminal entrypoint;
    // bulkReassign uses the same instance FOR UPDATE + version predicate (mutation-sensitive).
    const oldVersion = 5
    const actor = {
      userId: actorOrgAdmin,
      userName: 'org-admin',
      roles: [] as string[],
      permissions: ['approvals:admin'],
    }

    for (const order of ['reassign-first', 'decision-first'] as const) {
      const instanceId = id(`prod-race-${order}`)
      await seedNonAttendanceInstance(instanceId, fromAssignee)
      await pool.query(`UPDATE approval_instances SET version = $2 WHERE id = $1`, [
        instanceId,
        oldVersion,
      ])

      __setW4c3bBulkReassignTestBarrierForTests(null)
      __setW4c3bBridgeDispatchTestBarrierForTests(null)

      try {
        if (order === 'reassign-first') {
          const releaseReassign = createDeferred()
          const reassignLocked = createDeferred()
          __setW4c3bBulkReassignTestBarrierForTests(async (point, info) => {
            if (info.instanceId !== instanceId) return
            if (point === 'after_instance_lock') {
              reassignLocked.resolve()
              await releaseReassign.promise
            }
          })

          const reassignP = product.bulkReassignApprovals(
            {
              fromUserId: fromAssignee,
              toUserId: targetOk,
              instanceIds: [instanceId],
              reason: 'race-reassign-first',
            },
            actor,
          )
          await reassignLocked.promise

          // Decision blocks on the same instance FOR UPDATE held by production reassign.
          const decisionP = bridge.dispatchAction(
            instanceId,
            { action: 'approve', comment: 'race' },
            { userId: actorOrgAdmin, userName: 'decider' },
          )
          await sleep(40)

          releaseReassign.resolve()
          const reassignResult = await reassignP
          expect(reassignResult.succeeded).toEqual([instanceId])
          expect(reassignResult.skipped).toEqual([])

          // After reassign commits, decision may proceed on the new version — but must NOT
          // also claim from_version=oldVersion. Await it (approve on still-pending is allowed).
          await decisionP

          const fromOld = await pool.query(
            `SELECT action, from_version, to_version
               FROM approval_records
              WHERE instance_id = $1 AND from_version = $2
              ORDER BY id ASC`,
            [instanceId, oldVersion],
          )
          // Exactly one record advances the original version (the reassign).
          expect(fromOld.rows).toHaveLength(1)
          expect(fromOld.rows[0].action).toBe('reassign')

          const reassignAudits = await pool.query(
            `SELECT metadata FROM approval_records
              WHERE instance_id = $1 AND action = 'reassign'`,
            [instanceId],
          )
          expect(reassignAudits.rows.length).toBeGreaterThanOrEqual(1)
          // No mixed seat state: source no longer active after reassign (and decision deactivates all).
          const activeSource = await pool.query(
            `SELECT 1 FROM approval_assignments
              WHERE instance_id = $1 AND assignee_id = $2 AND is_active = TRUE`,
            [instanceId, fromAssignee],
          )
          expect(activeSource.rows).toHaveLength(0)
        } else {
          const releaseDecision = createDeferred()
          const decisionLocked = createDeferred()
          __setW4c3bBridgeDispatchTestBarrierForTests(async (point, info) => {
            if (info.instanceId !== instanceId) return
            if (point === 'after_instance_lock') {
              decisionLocked.resolve()
              await releaseDecision.promise
            }
          })

          const decisionP = bridge.dispatchAction(
            instanceId,
            { action: 'approve', comment: 'race-decision-first' },
            { userId: actorOrgAdmin, userName: 'decider' },
          )
          await decisionLocked.promise

          const reassignP = product.bulkReassignApprovals(
            {
              fromUserId: fromAssignee,
              toUserId: targetOk,
              instanceIds: [instanceId],
              reason: 'race-decision-first',
            },
            actor,
          )
          await sleep(40)

          releaseDecision.resolve()
          await decisionP
          const reassignResult = await reassignP

          expect(reassignResult.succeeded).toEqual([])
          expect(reassignResult.skipped).toEqual([{ id: instanceId, reason: 'not-pending' }])

          const inst = await pool.query(
            `SELECT status, version FROM approval_instances WHERE id = $1`,
            [instanceId],
          )
          expect(inst.rows[0].status).toBe('approved')
          expect(Number(inst.rows[0].version)).toBe(oldVersion + 1)

          const reassignAudits = await pool.query(
            `SELECT 1 FROM approval_records
              WHERE instance_id = $1 AND action = 'reassign'`,
            [instanceId],
          )
          expect(reassignAudits.rows).toHaveLength(0)

          const fromOld = await pool.query(
            `SELECT action FROM approval_records
              WHERE instance_id = $1 AND from_version = $2`,
            [instanceId, oldVersion],
          )
          expect(fromOld.rows).toHaveLength(1)
          expect(fromOld.rows[0].action).toBe('approve')

          // Source seats deactivated by decision; target never inserted by reassign.
          const targetSeats = await pool.query(
            `SELECT 1 FROM approval_assignments
              WHERE instance_id = $1 AND assignee_id = $2`,
            [instanceId, targetOk],
          )
          expect(targetSeats.rows).toHaveLength(0)
        }
      } finally {
        __setW4c3bBulkReassignTestBarrierForTests(null)
        __setW4c3bBridgeDispatchTestBarrierForTests(null)
      }
    }
  }, 90_000)

  it('current-node validation is attendance-only: generic stale-node succeeds, attendance stale-node fails', async () => {
    const instanceId = id('non-att')
    await seedNonAttendanceInstance(instanceId, fromAssignee)
    await pool.query(
      `UPDATE approval_assignments SET node_key = 'stale-node' WHERE instance_id = $1`,
      [instanceId],
    )
    const result = await product.bulkReassignApprovals(
      {
        fromUserId: fromAssignee,
        toUserId: targetOk,
        instanceIds: [instanceId],
        reason: 'generic',
      },
      { userId: actorOrgAdmin, userName: 'org-admin', roles: [], permissions: ['approvals:admin'] },
    )
    expect(result.succeeded).toContain(instanceId)
    const records = await pool.query(
      `SELECT metadata FROM approval_records
        WHERE instance_id = $1 AND action = 'reassign'
        ORDER BY id DESC LIMIT 1`,
      [instanceId],
    )
    expect(records.rows[0]?.metadata?.attendanceW4c3bReassign).toBeUndefined()

    const attendanceId = id('att-stale-node')
    await seedAttendanceInstance({
      instanceId: attendanceId,
      withAssignmentFrom: fromAssignee,
    })
    await pool.query(
      `UPDATE approval_assignments SET node_key = 'stale-node' WHERE instance_id = $1`,
      [attendanceId],
    )
    const attendanceResult = await product.bulkReassignApprovals(
      {
        fromUserId: fromAssignee,
        toUserId: targetOk,
        instanceIds: [attendanceId],
        reason: 'attendance-stale-node',
      },
      { userId: actorOrgAdmin, userName: 'org-admin', roles: [], permissions: [] },
    )
    expect(attendanceResult.succeeded).toEqual([])
    expect(attendanceResult.skipped).toEqual([{ id: attendanceId, reason: 'not-assigned' }])

    const noCurrentNodeId = id('att-no-current-node')
    await seedAttendanceInstance({
      instanceId: noCurrentNodeId,
      withAssignmentFrom: fromAssignee,
    })
    await pool.query(
      `UPDATE approval_instances SET current_node_key = NULL WHERE id = $1`,
      [noCurrentNodeId],
    )
    const noCurrentNodeResult = await product.bulkReassignApprovals(
      {
        fromUserId: fromAssignee,
        toUserId: targetOk,
        instanceIds: [noCurrentNodeId],
        reason: 'attendance-no-current-node',
      },
      { userId: actorOrgAdmin, userName: 'org-admin', roles: [], permissions: [] },
    )
    expect(noCurrentNodeResult.succeeded).toEqual([])
    expect(noCurrentNodeResult.skipped).toEqual([
      { id: noCurrentNodeId, reason: 'not-assigned' },
    ])
  })

  it('production bulkReassign target lock serializes eligibility changes in both orders', async () => {
    const actor = {
      userId: actorOrgAdmin,
      userName: 'org-admin',
      roles: [] as string[],
      permissions: [] as string[],
    }

    // --- Order A: production reassign locks target → concurrent deactivation waits → reassign wins ---
    {
      const raceTarget = id('race-tgt-a')
      await upsertUser({ id: raceTarget })
      await pool.query(
        `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)
         ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = TRUE`,
        [raceTarget, ORG_A],
      )
      const instanceId = id('race-tgt-reassign-first')
      await seedAttendanceInstance({
        instanceId,
        withAssignmentFrom: fromAssignee,
        version: 2,
        entryEpoch: 11,
      })

      const releaseReassign = createDeferred()
      const targetLocked = createDeferred()
      __setW4c3bBulkReassignTestBarrierForTests(async (point, info) => {
        if (info.instanceId !== instanceId) return
        if (point === 'after_attendance_auth') {
          targetLocked.resolve()
          await releaseReassign.promise
        }
      })

      const cDeprov = await pool.connect()
      try {
        await cDeprov.query('BEGIN')
        const reassignP = product.bulkReassignApprovals(
          {
            fromUserId: fromAssignee,
            toUserId: raceTarget,
            instanceIds: [instanceId],
            reason: 'prod-target-lock',
          },
          actor,
        )
        await targetLocked.promise

        // Blocks on users FOR UPDATE held by production authorizeAttendanceCentralReassign.
        const deprovPromise = cDeprov.query(
          `UPDATE users SET is_active = FALSE, activation_status = 'pending_activation' WHERE id = $1`,
          [raceTarget],
        )
        await sleep(40)

        releaseReassign.resolve()
        const result = await reassignP
        expect(result.succeeded).toEqual([instanceId])
        expect(result.skipped).toEqual([])

        await deprovPromise
        await cDeprov.query('COMMIT')

        const seats = await pool.query(
          `SELECT assignee_id, entry_epoch, is_active FROM approval_assignments
            WHERE instance_id = $1 AND is_active = TRUE`,
          [instanceId],
        )
        expect(seats.rows).toHaveLength(1)
        expect(seats.rows[0].assignee_id).toBe(raceTarget)
        expect(Number(seats.rows[0].entry_epoch)).toBe(11)
        const audit = await pool.query(
          `SELECT metadata FROM approval_records
            WHERE instance_id = $1 AND action = 'reassign' ORDER BY id DESC LIMIT 1`,
          [instanceId],
        )
        expect(audit.rows[0]?.metadata?.attendanceW4c3bReassign?.orgId).toBe(ORG_A)
      } finally {
        __setW4c3bBulkReassignTestBarrierForTests(null)
        cDeprov.release()
      }
    }

    // --- Order B: membership removal commits first → production reassign fails target-user-invalid ---
    {
      const raceTarget = id('race-tgt-b')
      await upsertUser({ id: raceTarget })
      await pool.query(
        `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)
         ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = TRUE`,
        [raceTarget, ORG_A],
      )
      const instanceId = id('race-tgt-member-first')
      await seedAttendanceInstance({
        instanceId,
        withAssignmentFrom: fromAssignee,
        version: 3,
      })

      const cMember = await pool.connect()
      try {
        await cMember.query('BEGIN')
        // Same stable lock order as production target auth.
        await cMember.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [raceTarget])
        await cMember.query(
          `SELECT user_id FROM user_orgs WHERE user_id = $1 AND org_id = $2 FOR UPDATE`,
          [raceTarget, ORG_A],
        )

        // Reassign blocks inside after_attendance_auth target lock until membership txn ends.
        const reassignP = product.bulkReassignApprovals(
          {
            fromUserId: fromAssignee,
            toUserId: raceTarget,
            instanceIds: [instanceId],
            reason: 'prod-member-first',
          },
          actor,
        )
        await sleep(40)

        await cMember.query(
          `UPDATE user_orgs SET is_active = FALSE WHERE user_id = $1 AND org_id = $2`,
          [raceTarget, ORG_A],
        )
        await cMember.query('COMMIT')

        const result = await reassignP
        expect(result.succeeded).toEqual([])
        expect(result.skipped).toEqual([{ id: instanceId, reason: 'target-user-invalid' }])

        const version = await pool.query(`SELECT version FROM approval_instances WHERE id = $1`, [
          instanceId,
        ])
        expect(Number(version.rows[0].version)).toBe(3)
        const activeFrom = await pool.query(
          `SELECT 1 FROM approval_assignments
            WHERE instance_id = $1 AND assignee_id = $2 AND is_active = TRUE`,
          [instanceId, fromAssignee],
        )
        expect(activeFrom.rows).toHaveLength(1)
        const audits = await pool.query(
          `SELECT 1 FROM approval_records WHERE instance_id = $1 AND action = 'reassign'`,
          [instanceId],
        )
        expect(audits.rows).toHaveLength(0)
      } finally {
        cMember.release()
      }
    }
  }, 90_000)

  it('attendance timeout guard consumes only an exact due armed row; stale scanner calls preserve it', async () => {
    const service = new ApprovalProductService()

    for (const scenario of [
      {
        label: 'future',
        deadlineSql: `NOW() + INTERVAL '1 hour'`,
        armedEffect: 'transfer',
        scannedEffect: 'transfer' as const,
      },
      {
        label: 'effect-mismatch',
        deadlineSql: `NOW() - INTERVAL '1 minute'`,
        armedEffect: 'jump',
        scannedEffect: 'transfer' as const,
      },
    ]) {
      const instanceId = id(`timeout-stale-${scenario.label}`)
      await seedAttendanceInstance({ instanceId })
      await pool.query(
        `INSERT INTO approval_metrics
           (instance_id, started_at, current_node_deadline_at, current_node_timeout_effect)
         VALUES ($1, NOW(), ${scenario.deadlineSql}, $2)`,
        [instanceId, scenario.armedEffect],
      )

      expect(await service.applyNodeTimeoutEffect(instanceId, scenario.scannedEffect)).toBe(
        'skipped_stale',
      )
      const preserved = await pool.query<{
        current_node_deadline_at: Date | string | null
        current_node_timeout_effect: string | null
      }>(
        `SELECT current_node_deadline_at, current_node_timeout_effect
           FROM approval_metrics WHERE instance_id = $1`,
        [instanceId],
      )
      expect(preserved.rows[0]?.current_node_deadline_at).not.toBeNull()
      expect(preserved.rows[0]?.current_node_timeout_effect).toBe(scenario.armedEffect)
    }

    const dueInstanceId = id('timeout-due')
    await seedAttendanceInstance({ instanceId: dueInstanceId })
    await pool.query(
      `INSERT INTO approval_metrics
         (instance_id, started_at, current_node_deadline_at, current_node_timeout_effect)
       VALUES ($1, NOW(), NOW() - INTERVAL '1 minute', 'transfer')`,
      [dueInstanceId],
    )
    expect(await service.applyNodeTimeoutEffect(dueInstanceId, 'transfer')).toBe('skipped_stale')
    const consumed = await pool.query<{
      current_node_deadline_at: Date | string | null
      current_node_timeout_effect: string | null
    }>(
      `SELECT current_node_deadline_at, current_node_timeout_effect
         FROM approval_metrics WHERE instance_id = $1`,
      [dueInstanceId],
    )
    expect(consumed.rows[0]).toEqual({
      current_node_deadline_at: null,
      current_node_timeout_effect: null,
    })
  })

  /**
   * Transactional ROLLBACK proof only (not the production concurrency race).
   * The required product race is `production bulkReassign vs bridge decision race`
   * and `production bulkReassign target lock race` above.
   */
  it('txn ROLLBACK proof only: version bump rowCount=0 undoes seat DML (not product race)', async () => {
    const instanceId = id('ver-rollback')
    await seedAttendanceInstance({
      instanceId,
      withAssignmentFrom: fromAssignee,
      entryEpoch: 9,
      version: 4,
    })

    const beforeSeats = await pool.query(
      `SELECT assignee_id, entry_epoch, is_active
         FROM approval_assignments
        WHERE instance_id = $1
        ORDER BY assignee_id, is_active DESC`,
      [instanceId],
    )
    expect(beforeSeats.rows.filter((r) => r.is_active)).toHaveLength(1)
    expect(beforeSeats.rows.find((r) => r.is_active)?.assignee_id).toBe(fromAssignee)

    // Mirror product DML order (source FOR UPDATE → target FOR UPDATE → mutate seats →
    // conditional version bump). rowCount=0 must ROLLBACK every assignment write.
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const inst = (
        await client.query(`SELECT * FROM approval_instances WHERE id = $1 FOR UPDATE`, [instanceId])
      ).rows[0]
      await client.query(
        `SELECT * FROM approval_assignments
          WHERE instance_id = $1 AND assignment_type = 'user' AND assignee_id = $2 AND is_active = TRUE
          FOR UPDATE`,
        [instanceId, fromAssignee],
      )
      await client.query(
        `SELECT * FROM approval_assignments
          WHERE instance_id = $1 AND assignment_type = 'user' AND assignee_id = $2 AND is_active = TRUE
          FOR UPDATE`,
        [instanceId, targetOk],
      )
      await client.query(
        `UPDATE approval_assignments SET is_active = FALSE, updated_at = now()
          WHERE instance_id = $1 AND assignee_id = $2 AND is_active = TRUE`,
        [instanceId, fromAssignee],
      )
      await client.query(
        `INSERT INTO approval_assignments
           (instance_id, assignment_type, assignee_id, source_step, node_key, entry_epoch, is_active, metadata)
         VALUES ($1, 'user', $2, 0, 'node-1', 9, TRUE, '{}'::jsonb)`,
        [instanceId, targetOk],
      )
      // In-txn proof the seats look mutated before rollback.
      const mid = await client.query(
        `SELECT assignee_id FROM approval_assignments
          WHERE instance_id = $1 AND is_active = TRUE`,
        [instanceId],
      )
      expect(mid.rows.map((r) => r.assignee_id)).toEqual([targetOk])

      const bump = await client.query(
        `UPDATE approval_instances
            SET version = $2, updated_at = now()
          WHERE id = $1 AND version = $3 AND status = 'pending'`,
        // Stale expected version forces rowCount=0 (same branch product uses).
        [instanceId, Number(inst.version) + 1, Number(inst.version) - 1],
      )
      expect(bump.rowCount).toBe(0)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }

    const afterSeats = await pool.query(
      `SELECT assignee_id, entry_epoch, is_active
         FROM approval_assignments
        WHERE instance_id = $1
        ORDER BY assignee_id, is_active DESC`,
      [instanceId],
    )
    const active = afterSeats.rows.filter((r) => r.is_active)
    expect(active).toHaveLength(1)
    expect(active[0].assignee_id).toBe(fromAssignee)
    expect(Number(active[0].entry_epoch)).toBe(9)
    const version = await pool.query(`SELECT version FROM approval_instances WHERE id = $1`, [
      instanceId,
    ])
    expect(Number(version.rows[0].version)).toBe(4)
    expect(
      afterSeats.rows.some((r) => r.assignee_id === targetOk && r.is_active),
    ).toBe(false)
  })

  it('lockAndValidateAttendanceReassignTarget holds users then membership under FOR UPDATE', async () => {
    await withClient(pool, async (client) => {
      const ok = await lockAndValidateAttendanceReassignTarget(client, targetOk, ORG_A)
      expect(ok).toBe(true)
      // Locks still held: concurrent users.is_active=false must wait (schema-valid deprovision).
      // Do NOT use activation_status='deprovisioned' — closed set is pending_activation|activated.
      const c2 = await pool.connect()
      try {
        await c2.query('BEGIN')
        await c2.query(`SET LOCAL lock_timeout = '80ms'`)
        await expect(
          c2.query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [targetOk]),
        ).rejects.toThrow(/lock timeout|canceling statement/i)
        await c2.query('ROLLBACK')
      } finally {
        c2.release()
      }
    })
  })

  it('target eligibility rejects users.is_active=false and user_orgs.is_active=false separately', async () => {
    const uInactive = id('elig-user-inactive')
    const uMemInactive = id('elig-mem-inactive')
    await upsertUser({ id: uInactive, isActive: false, activation: 'activated' })
    await upsertUser({ id: uMemInactive, isActive: true, activation: 'activated' })
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)
       ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = TRUE`,
      [uInactive, ORG_A],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, FALSE)
       ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = FALSE`,
      [uMemInactive, ORG_A],
    )

    await withClient(pool, async (client) => {
      expect(await lockAndValidateAttendanceReassignTarget(client, uInactive, ORG_A)).toBe(false)
    })
    await withClient(pool, async (client) => {
      expect(await lockAndValidateAttendanceReassignTarget(client, uMemInactive, ORG_A)).toBe(false)
    })
    // Positive control still holds for the activated same-org target.
    await withClient(pool, async (client) => {
      expect(await lockAndValidateAttendanceReassignTarget(client, targetOk, ORG_A)).toBe(true)
    })
  })

  it('namespace cleanup leaves zero residue on fully migrated DB', async () => {
    await cleanupNamespace()
    const residue = await pool.query<{ kind: string; n: string }>(
      `SELECT 'users' AS kind, count(*)::text AS n FROM users WHERE id LIKE $1
       UNION ALL
       SELECT 'user_orgs', count(*)::text FROM user_orgs WHERE user_id LIKE $1 OR org_id LIKE $1
       UNION ALL
       SELECT 'user_permissions', count(*)::text FROM user_permissions WHERE user_id LIKE $1
       UNION ALL
       SELECT 'user_roles', count(*)::text FROM user_roles WHERE user_id LIKE $1
       UNION ALL
       SELECT 'approval_instances', count(*)::text FROM approval_instances WHERE id LIKE $1
       UNION ALL
       SELECT 'approval_assignments', count(*)::text FROM approval_assignments WHERE instance_id LIKE $1
       UNION ALL
       SELECT 'approval_records', count(*)::text FROM approval_records WHERE instance_id LIKE $1
       UNION ALL
       SELECT 'attendance_requests', count(*)::text FROM attendance_requests
         WHERE approval_instance_id LIKE $1 OR user_id LIKE $1 OR org_id LIKE $1
       UNION ALL
       SELECT 'approval_templates', count(*)::text FROM approval_templates WHERE key LIKE $1
       UNION ALL
       SELECT 'approval_published_definitions', count(*)::text FROM approval_published_definitions
         WHERE template_id IN (SELECT id FROM approval_templates WHERE key LIKE $1)`,
      [`${NS}%`],
    )
    expect(residue.rows.every((r) => Number(r.n) === 0)).toBe(true)
  })
})
