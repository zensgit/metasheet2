/**
 * E-learning V0.1 ratified gate 1: real PostgreSQL authentication / tenant /
 * RBAC on the production pilot runtime.
 *
 * Import order is owned by tests/elearning-pilot-auth/setup.ts plus this
 * dedicated vitest config. Do not run this file under
 * vitest.integration.config.ts (that setup caches RBAC_TOKEN_TRUST true).
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import { Pool, type PoolClient } from 'pg'
import request from 'supertest'

import {
  SCOPE_REVISIONS_DENY_MUTATION_TRIGGER,
  SCOPE_RULES_DENY_MUTATION_TRIGGER,
} from '../../src/db/migrations/zzzz20260826150000_add_elearning_scope_access'
import {
  ELEARNING_OBJECT_ACL_STATE_TRIGGER,
} from '../../src/db/migrations/zzzz20260826200000_create_elearning_admin_scope_acl'
import { authenticate } from '../../src/middleware/auth'
import { ElearningAdminAccessError } from '../../src/services/elearning-admin-access'
import {
  produceElearningAssignmentReminder,
  type ProduceElearningAssignmentReminderInput,
} from '../../src/services/elearning-assignment-reminder'
import {
  settleExpiredElearningExamAttempt,
  type SettleExpiredElearningExamAttemptInput,
  type SettleExpiredElearningExamAttemptResult,
} from '../../src/services/elearning-exam'
import { createElearningPilotRuntime } from '../../src/services/elearning-pilot-runtime'
import type { ElearningLearnerCourse } from '../../src/services/elearning-learner-courses'
import { ELEARNING_MEDIA_PLAYBACK_SECRET_ENV } from '../../src/services/elearning-media-playback'
import {
  ElearningTrainingPlanError,
  type GetElearningTrainingPlanInput,
  type PublishElearningTrainingPlanInput,
} from '../../src/services/elearning-training-plan'
import type {
  AssignElearningTrainingPlanInput,
} from '../../src/services/elearning-training-plan-assignment'
import type {
  RevokeElearningTrainingPlanAssignmentInput,
} from '../../src/services/elearning-training-plan-revocation'
import { usePinnedServer } from '../utils/pinned-server'

if (process.env.ELEARNING_PILOT_AUTH_GATE_SETUP !== '1') {
  throw new Error('elearning auth gate must load dedicated setup before this file')
}
if (process.env.RBAC_BYPASS !== 'false' || process.env.RBAC_TOKEN_TRUST !== 'false') {
  throw new Error('elearning auth gate requires RBAC_BYPASS=false and RBAC_TOKEN_TRUST=false at import')
}
if (process.env.PRODUCT_MODE !== 'plm-workbench') {
  throw new Error('elearning auth gate requires PRODUCT_MODE=plm-workbench at import to keep attendance self-service backfill off')
}

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'elearning V0.1 auth/tenant/RBAC gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) {
  throw new Error('elearning V0.1 auth/tenant/RBAC gate requires JWT_SECRET')
}

const require = createRequire(import.meta.url)
const elearningPlugin = require('../../../../plugins/plugin-elearning/index.cjs') as {
  activate: (context: {
    api: {
      database?: unknown
      http: {
        addRoute: (method: string, path: string, handler: express.RequestHandler) => void
      }
    }
    services?: {
      elearningReminderProducer?: {
        produce: (input: ProduceElearningAssignmentReminderInput) => Promise<unknown>
      }
      elearningExamExpirySettlement?: {
        settle: (
          input: SettleExpiredElearningExamAttemptInput,
        ) => Promise<SettleExpiredElearningExamAttemptResult>
      }
    }
  }) => Promise<void>
  CANONICAL_METHOD: string
  CANONICAL_PATH: string
}

const READER_CAPABILITIES = {
  enabled: true,
  capabilities: {
    content: true,
    assignment: true,
    assessment: true,
    incentive: false,
    analytics: false,
    media: true,
    enrollment: false,
  },
} as const

const CLOSED_CAPABILITIES = {
  enabled: true,
  capabilities: {
    content: false,
    assignment: false,
    assessment: false,
    incentive: false,
    analytics: false,
    media: false,
    enrollment: false,
  },
} as const

const FLAG_EXAM_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_ASSIGNMENT_ENABLED: 'true',
  ELEARNING_ASSESSMENT_ENABLED: 'true',
  ELEARNING_MEDIA_ENABLED: 'true',
  [ELEARNING_MEDIA_PLAYBACK_SECRET_ENV]:
    process.env[ELEARNING_MEDIA_PLAYBACK_SECRET_ENV] || 'elearning-playback-signing-secret-min-32b!',
  JWT_SECRET,
} as unknown as NodeJS.ProcessEnv

const pool = new Pool({ connectionString: DATABASE_URL, max: 8 })
const STAMP = `${Date.now().toString(36)}-${randomUUID()}`
const NS = `el-auth-${STAMP}`
const ROLE_ID = `${NS}-reader`
const WRITE_ROLE_ID = `${NS}-writer`
const ADMIN_ROLE_ID = `${NS}-admin`
const ORG_A = `${NS}-org-a`
const ORG_B = `${NS}-org-b`
const FORGED_ORG = `${NS}-forged-org`
const SCOPE_COURSE_ID = randomUUID()
const TRAINING_PLAN_ID = randomUUID()
const TRAINING_PLAN_VERSION_ID = randomUUID()
const TRAINING_PLAN_COURSE_VERSION_ID = randomUUID()

const TRAINING_PLAN_BODY = {
  requestId: randomUUID(),
  title: 'Auth gate training plan',
  items: [{ courseVersionId: TRAINING_PLAN_COURSE_VERSION_ID, required: true }],
} as const

const TRAINING_PLAN_RESULT = {
  planId: TRAINING_PLAN_ID,
  planVersionId: TRAINING_PLAN_VERSION_ID,
  status: 'published' as const,
  itemCount: 1,
  duplicate: false,
}

const TRAINING_PLAN_READ_RESULT = {
  planId: TRAINING_PLAN_ID,
  title: TRAINING_PLAN_BODY.title,
  status: 'active' as const,
  activeVersion: {
    planVersionId: TRAINING_PLAN_VERSION_ID,
    version: 1,
    status: 'published' as const,
    items: [{
      courseVersionId: TRAINING_PLAN_COURSE_VERSION_ID,
      position: 1,
      required: true,
    }],
  },
}

const TRAINING_PLAN_ASSIGNMENT_BODY = {
  sourceKey: 'auth-gate-plan-run',
  deadline: '2030-01-01T00:00:00.000Z',
  rules: [{
    subjectType: 'user',
    subjectRef: 'auth-gate-learner',
    includeChildren: false,
  }],
} as const

const TRAINING_PLAN_ASSIGNMENT_RESULT = {
  planAssignmentId: randomUUID(),
  planVersionId: TRAINING_PLAN_VERSION_ID,
  assignmentCount: 1,
  memberCount: 1,
  duplicate: false,
}

const TRAINING_PLAN_REVOCATION_BODY = {
  reason: 'assigned in error',
} as const

const TRAINING_PLAN_REVOCATION_RESULT = {
  planAssignmentId: TRAINING_PLAN_ASSIGNMENT_RESULT.planAssignmentId,
  revoked: true as const,
  revokedMemberCount: 1,
  duplicate: false,
}

const LEARNER_COURSES: ElearningLearnerCourse[] = [{
  courseId: '11111111-1111-4111-8111-111111111111',
  courseVersionId: '22222222-2222-4222-8222-222222222222',
  title: 'Pilot course',
  access: {
    kind: 'assignment',
    required: true,
  },
  assignment: {
    deadline: null,
    assignedAt: '2026-01-02T03:04:05.000Z',
  },
  video: {
    itemId: '33333333-3333-4333-8333-333333333333',
    durationMs: 10_000,
    status: 'not_started',
    effectiveMs: 0,
    maxPositionMs: 0,
    completedAt: null,
  },
  exam: {
    itemId: '44444444-4444-4444-8444-444444444444',
    latestAttempt: null,
  },
  completed: false,
}]

async function queryWithClient(
  client: PoolClient,
  sql: string,
  params?: unknown[],
) {
  const result = await client.query(sql, params as never)
  return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
}

const database = {
  async query(sql: string, params?: unknown[]) {
    const result = await pool.query(sql, params as never)
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
  },
  async transaction<T>(handler: (tx: { query: typeof database.query }) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const tx = {
        query: (sql: string, params?: unknown[]) => queryWithClient(client, sql, params),
      }
      const result = await handler(tx)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
}

async function scopeRevisionCount(): Promise<number> {
  const result = await pool.query(
    `SELECT count(*)::integer AS count
       FROM elearning_scope_revisions r
      WHERE r.org_id = $1
        AND r.scope_id = (
          SELECT c.scope_id
            FROM elearning_courses c
           WHERE c.org_id = $1 AND c.id = $2
        )`,
    [ORG_A, SCOPE_COURSE_ID],
  )
  return Number(result.rows[0]?.count ?? 0)
}

async function activeCourseAclActions(granteeUserId: string): Promise<string[]> {
  const result = await pool.query(
    `SELECT action
       FROM elearning_object_acl
      WHERE org_id = $1
        AND course_id = $2
        AND grantee_user_id = $3
        AND revoked_at IS NULL
      ORDER BY action ASC`,
    [ORG_A, SCOPE_COURSE_ID, granteeUserId],
  )
  return result.rows.map((row) => String(row.action))
}

function signToken(claims: Record<string, unknown>): string {
  return jwt.sign(claims, JWT_SECRET, { expiresIn: '1h' })
}

function valuesFree(body: unknown): void {
  const serialized = JSON.stringify(body)
  expect(serialized).not.toMatch(/postgres(ql)?:\/\//i)
  expect(serialized).not.toContain(JWT_SECRET)
  expect(serialized).not.toMatch(/\b(?:password_hash|authorityCode|appKey)\b/)
}

describe('elearning V0.1 auth/tenant/RBAC gate (real DB, dedicated process)', () => {
  const readerId = randomUUID()
  const writerId = randomUUID()
  const adminId = randomUUID()
  const legacyId = randomUUID()
  const outsiderId = randomUUID()
  const forgedId = randomUUID()
  const createdUserIds = [readerId, writerId, adminId, legacyId, outsiderId, forgedId]
  const pinned = usePinnedServer()
  const learnerCalls: Array<{ orgId: string; userId: string }> = []
  const trainingPlanPublishCalls: PublishElearningTrainingPlanInput[] = []
  const trainingPlanGetCalls: GetElearningTrainingPlanInput[] = []
  const trainingPlanAssignmentCalls: AssignElearningTrainingPlanInput[] = []
  const trainingPlanRevocationCalls: RevokeElearningTrainingPlanAssignmentInput[] = []

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO permissions (code, name, description)
       VALUES
         ('elearning:read', 'E-learning Read', 'Read published learning content and own attempts'),
         ('elearning:write', 'E-learning Write', 'Create learning content'),
         ('elearning:admin', 'E-learning Admin', 'Administer learning content and scope')
       ON CONFLICT (code) DO NOTHING`,
    )
    await pool.query(
      `INSERT INTO roles (id, name)
       VALUES ($1, $2), ($3, $4), ($5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [ROLE_ID, ROLE_ID, WRITE_ROLE_ID, WRITE_ROLE_ID, ADMIN_ROLE_ID, ADMIN_ROLE_ID],
    )
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_code)
       VALUES
         ($1, 'elearning:read'),
         ($2, 'elearning:write'),
         ($3, 'elearning:admin')
       ON CONFLICT DO NOTHING`,
      [ROLE_ID, WRITE_ROLE_ID, ADMIN_ROLE_ID],
    )

    async function insertUser(id: string, tag: string): Promise<void> {
      await pool.query(
        `INSERT INTO users (
           id, email, name, password_hash, role, permissions,
           is_active, is_admin, activation_status, local_password_set,
           must_change_password, created_at, updated_at
         )
         VALUES (
           $1, $2, $3, 'x', 'user', '[]'::jsonb,
           TRUE, FALSE, 'activated', TRUE,
           FALSE, now(), now()
         )`,
        [id, `${id}@el-auth-gate.test`, `${NS}-${tag}`],
      )
    }

    await insertUser(readerId, 'reader')
    await insertUser(writerId, 'writer')
    await insertUser(adminId, 'admin')
    await insertUser(legacyId, 'legacy')
    await insertUser(outsiderId, 'outsider')
    await insertUser(forgedId, 'forged')

    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active)
       VALUES
         ($1, $2, TRUE),
         ($3, $2, TRUE),
         ($4, $2, TRUE),
         ($4, $5, TRUE),
         ($6, $2, TRUE),
         ($7, $2, TRUE)`,
      [readerId, ORG_A, writerId, adminId, ORG_B, legacyId, forgedId],
    )

    for (const userId of [readerId, legacyId, outsiderId]) {
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, ROLE_ID],
      )
      await pool.query(
        `INSERT INTO user_permissions (user_id, permission_code)
         VALUES ($1, 'elearning:read')
         ON CONFLICT DO NOTHING`,
        [userId],
      )
    }

    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [writerId, WRITE_ROLE_ID],
    )
    await pool.query(
      `INSERT INTO user_permissions (user_id, permission_code)
       VALUES ($1, 'elearning:write')
       ON CONFLICT DO NOTHING`,
      [writerId],
    )
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [adminId, ADMIN_ROLE_ID],
    )
    await pool.query(
      `INSERT INTO user_permissions (user_id, permission_code)
       VALUES ($1, 'elearning:admin')
       ON CONFLICT DO NOTHING`,
      [adminId],
    )

    await pool.query(
      `INSERT INTO elearning_courses (id, org_id, title, status, created_by)
       VALUES ($1, $2, 'Auth gate scope course', 'active', $3)`,
      [SCOPE_COURSE_ID, ORG_A, adminId],
    )

    // Namespace admission for every principal, including forgedId (roles/permissions
    // stay empty). A 403 then cannot be a later namespace denial.
    for (const userId of createdUserIds) {
      await pool.query(
        `INSERT INTO user_namespace_admissions (
           user_id, namespace, enabled, source, created_at, updated_at
         )
         VALUES ($1, 'elearning', TRUE, 'test', now(), now())
         ON CONFLICT (user_id, namespace) DO UPDATE SET enabled = TRUE`,
        [userId],
      )
    }

    const runtime = createElearningPilotRuntime({
      db: database as never,
      env: FLAG_EXAM_ON,
      listElearningLearnerCourses: async (_db, input) => {
        learnerCalls.push({ orgId: input.orgId, userId: input.userId })
        return LEARNER_COURSES
      },
      publishElearningTrainingPlan: async (_db, input) => {
        trainingPlanPublishCalls.push(input)
        return TRAINING_PLAN_RESULT
      },
      getElearningTrainingPlan: async (_db, input) => {
        trainingPlanGetCalls.push(input)
        if (input.orgId !== ORG_A || input.planId !== TRAINING_PLAN_ID) {
          throw new ElearningTrainingPlanError('not_found')
        }
        return TRAINING_PLAN_READ_RESULT
      },
      assignElearningTrainingPlan: async (_db, input) => {
        if (!input.isGlobalAdmin) throw new ElearningAdminAccessError('forbidden')
        trainingPlanAssignmentCalls.push(input)
        return TRAINING_PLAN_ASSIGNMENT_RESULT
      },
      revokeElearningTrainingPlanAssignment: async (_db, input) => {
        if (!input.isGlobalAdmin) throw new ElearningAdminAccessError('forbidden')
        trainingPlanRevocationCalls.push(input)
        return TRAINING_PLAN_REVOCATION_RESULT
      },
    })
    if (!runtime) {
      throw new Error('elearning pilot runtime must mount when exam flags are exact true')
    }
    const app = express()
    let capabilitiesMounted = false
    await elearningPlugin.activate({
      api: {
        database,
        http: {
          addRoute(method, path, handler) {
            if (method !== elearningPlugin.CANONICAL_METHOD || path !== elearningPlugin.CANONICAL_PATH) {
              throw new Error(`unexpected plugin route ${method} ${path}`)
            }
            app.get(path, authenticate, handler)
            capabilitiesMounted = true
          },
        },
      },
      services: {
        elearningReminderProducer: {
          produce: (input) => produceElearningAssignmentReminder(database, input),
        },
        elearningExamExpirySettlement: {
          settle: (input) => settleExpiredElearningExamAttempt(database, input),
        },
      },
    })
    if (!capabilitiesMounted) {
      throw new Error('plugin-elearning capabilities route must mount when master flag is exact true')
    }
    app.use(runtime.router)
    pinned.setApp(app)
  })

  afterAll(async () => {
    try {
      await pool.query(
        `ALTER TABLE elearning_object_acl
         DISABLE TRIGGER ${ELEARNING_OBJECT_ACL_STATE_TRIGGER}`,
      )
      try {
        await pool.query(
          `DELETE FROM elearning_object_acl
            WHERE org_id = $1 AND course_id = $2`,
          [ORG_A, SCOPE_COURSE_ID],
        )
      } finally {
        await pool.query(
          `ALTER TABLE elearning_object_acl
           ENABLE TRIGGER ${ELEARNING_OBJECT_ACL_STATE_TRIGGER}`,
        )
      }
      await pool.query(
        `DELETE FROM elearning_courses WHERE org_id = $1 AND id = $2`,
        [ORG_A, SCOPE_COURSE_ID],
      )
      await pool.query(
        `UPDATE elearning_scopes
            SET active_revision_id = NULL, latest_revision_id = NULL
          WHERE org_id = $1 AND created_by = $2`,
        [ORG_A, adminId],
      )
      await pool.query(
        `ALTER TABLE elearning_scope_revision_rules
         DISABLE TRIGGER ${SCOPE_RULES_DENY_MUTATION_TRIGGER}`,
      )
      await pool.query(
        `ALTER TABLE elearning_scope_revisions
         DISABLE TRIGGER ${SCOPE_REVISIONS_DENY_MUTATION_TRIGGER}`,
      )
      try {
        await pool.query(
          `DELETE FROM elearning_scope_revision_rules
            WHERE org_id = $1
              AND scope_revision_id IN (
                SELECT id FROM elearning_scope_revisions
                 WHERE org_id = $1 AND actor_id = $2
              )`,
          [ORG_A, adminId],
        )
        await pool.query(
          `DELETE FROM elearning_scope_revisions
            WHERE org_id = $1 AND actor_id = $2`,
          [ORG_A, adminId],
        )
      } finally {
        await pool.query(
          `ALTER TABLE elearning_scope_revisions
           ENABLE TRIGGER ${SCOPE_REVISIONS_DENY_MUTATION_TRIGGER}`,
        )
        await pool.query(
          `ALTER TABLE elearning_scope_revision_rules
           ENABLE TRIGGER ${SCOPE_RULES_DENY_MUTATION_TRIGGER}`,
        )
      }
      await pool.query(
        `DELETE FROM elearning_scopes WHERE org_id = $1 AND created_by = $2`,
        [ORG_A, adminId],
      )
      await pool.query(
        `DELETE FROM user_namespace_admissions WHERE user_id = ANY($1::text[])`,
        [createdUserIds],
      )
      await pool.query(
        `DELETE FROM user_permissions WHERE user_id = ANY($1::text[])`,
        [createdUserIds],
      )
      await pool.query(
        `DELETE FROM user_roles WHERE user_id = ANY($1::text[])`,
        [createdUserIds],
      )
      await pool.query(
        `DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`,
        [createdUserIds],
      )
      await pool.query(
        `DELETE FROM users WHERE id = ANY($1::text[])`,
        [createdUserIds],
      )
      await pool.query(
        `DELETE FROM role_permissions WHERE role_id = ANY($1::text[])`,
        [[ROLE_ID, WRITE_ROLE_ID, ADMIN_ROLE_ID]],
      )
      await pool.query(
        `DELETE FROM roles WHERE id = ANY($1::text[])`,
        [[ROLE_ID, WRITE_ROLE_ID, ADMIN_ROLE_ID]],
      )

      const residue = await pool.query(
        `SELECT 'elearning_object_acl' AS rel FROM elearning_object_acl
           WHERE org_id = $3 AND course_id = $4
         UNION ALL
         SELECT 'user_namespace_admissions' FROM user_namespace_admissions WHERE user_id = ANY($1::text[])
         UNION ALL
         SELECT 'user_permissions' FROM user_permissions WHERE user_id = ANY($1::text[])
         UNION ALL
         SELECT 'user_roles' FROM user_roles WHERE user_id = ANY($1::text[])
         UNION ALL
         SELECT 'user_orgs' FROM user_orgs WHERE user_id = ANY($1::text[])
         UNION ALL
         SELECT 'users' FROM users WHERE id = ANY($1::text[])
         UNION ALL
         SELECT 'role_permissions' FROM role_permissions WHERE role_id = ANY($2::text[])
         UNION ALL
         SELECT 'roles' FROM roles WHERE id = ANY($2::text[])`,
        [createdUserIds, [ROLE_ID, WRITE_ROLE_ID, ADMIN_ROLE_ID], ORG_A, SCOPE_COURSE_ID],
      )
      expect(residue.rows).toEqual([])
    } finally {
      await pool.end()
    }
  })

  it('dedicated setup pinned RBAC flags false before auth/RBAC/runtime import', () => {
    expect(process.env.ELEARNING_PILOT_AUTH_GATE_SETUP).toBe('1')
    expect(process.env.RBAC_BYPASS).toBe('false')
    expect(process.env.RBAC_TOKEN_TRUST).toBe('false')
    expect(process.env.PRODUCT_MODE).toBe('plm-workbench')
  })

  it('tenant-bound elearning:write-only reaches injected learner-list with exact org/user', async () => {
    learnerCalls.length = 0
    const token = signToken({
      userId: writerId,
      email: `${writerId}@el-auth-gate.test`,
      role: 'user',
      tenantId: ORG_A,
    })
    const res = await request(pinned.url())
      .get('/api/elearning/me/courses')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ courses: LEARNER_COURSES })
    expect(learnerCalls).toEqual([{ orgId: ORG_A, userId: writerId }])
    valuesFree(res.body)
  })

  it('signed token carrying forged elearning:write cannot bypass DB RBAC', async () => {
    learnerCalls.length = 0
    const token = signToken({
      userId: forgedId,
      email: `${forgedId}@el-auth-gate.test`,
      role: 'user',
      roles: ['elearning:write'],
      perms: ['elearning:write', 'elearning:read', 'elearning:admin'],
      permissions: ['elearning:write', 'elearning:read', 'elearning:admin'],
      tenantId: ORG_A,
    })
    const res = await request(pinned.url())
      .get('/api/elearning/me/courses')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'Insufficient permissions' })
    expect(learnerCalls).toHaveLength(0)
    valuesFree(res.body)
  })

  it('tenant-bound elearning:read reaches injected learner-list with exact org/user', async () => {
    learnerCalls.length = 0
    const token = signToken({
      userId: readerId,
      email: `${readerId}@el-auth-gate.test`,
      role: 'user',
      tenantId: ORG_A,
    })
    const res = await request(pinned.url())
      .get('/api/elearning/me/courses')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ courses: LEARNER_COURSES })
    expect(learnerCalls).toEqual([{ orgId: ORG_A, userId: readerId }])
    valuesFree(res.body)
  })

  it('tenant-less legacy token plus forged x-tenant-id is 403 ORG_CONTEXT_REQUIRED and never calls service', async () => {
    learnerCalls.length = 0
    const token = signToken({
      userId: legacyId,
      email: `${legacyId}@el-auth-gate.test`,
      role: 'user',
    })
    const res = await request(pinned.url())
      .get('/api/elearning/me/courses')
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', ORG_B)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    expect(learnerCalls).toHaveLength(0)
    valuesFree(res.body)
  })

  it('invalid tenant claim without membership fails closed and never calls service', async () => {
    learnerCalls.length = 0
    const token = signToken({
      userId: outsiderId,
      email: `${outsiderId}@el-auth-gate.test`,
      role: 'user',
      tenantId: FORGED_ORG,
    })
    const res = await request(pinned.url())
      .get('/api/elearning/me/courses')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    expect(learnerCalls).toHaveLength(0)
    valuesFree(res.body)
  })

  it('signed token carrying forged roles/perms cannot bypass DB RBAC', async () => {
    learnerCalls.length = 0
    const token = signToken({
      userId: forgedId,
      email: `${forgedId}@el-auth-gate.test`,
      role: 'admin',
      roles: ['admin'],
      perms: ['elearning:admin', 'elearning:read', '*:*'],
      permissions: ['elearning:admin', 'elearning:read', '*:*'],
      tenantId: ORG_A,
    })
    const res = await request(pinned.url())
      .get('/api/elearning/me/courses')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'Insufficient permissions' })
    expect(learnerCalls).toHaveLength(0)
    valuesFree(res.body)
  })

  it('hydrated admin may grant ACL while a write-only owner impostor stays non-global', async () => {
    const adminToken = signToken({
      userId: adminId,
      email: `${adminId}@el-auth-gate.test`,
      role: 'user',
      tenantId: ORG_A,
    })
    const granted = await request(pinned.url())
      .put(`/api/elearning/courses/${SCOPE_COURSE_ID}/collaborators/${readerId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'auth gate tracker', actions: ['track'] })
    expect(granted.status).toBe(200)
    expect(granted.body).toEqual({
      objectType: 'course',
      objectId: SCOPE_COURSE_ID,
      granteeUserId: readerId,
      actions: ['track'],
      duplicate: false,
    })
    expect(await activeCourseAclActions(readerId)).toEqual(['track'])
    valuesFree(granted.body)

    const forgedAdminToken = signToken({
      userId: writerId,
      email: `${writerId}@el-auth-gate.test`,
      role: 'admin',
      roles: ['admin'],
      perms: ['elearning:admin', '*:*'],
      permissions: ['elearning:admin', '*:*'],
      tenantId: ORG_A,
    })
    const denied = await request(pinned.url())
      .put(`/api/elearning/courses/${SCOPE_COURSE_ID}/collaborators/${readerId}`)
      .set('Authorization', `Bearer ${forgedAdminToken}`)
      .send({ reason: 'must not replace ACL', actions: ['assign'] })
    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: 'forbidden' })
    expect(await activeCourseAclActions(readerId)).toEqual(['track'])
    valuesFree(denied.body)
  })

  it('tenant-bound elearning:admin appends one real scope revision', async () => {
    const before = await scopeRevisionCount()
    const token = signToken({
      userId: adminId,
      email: `${adminId}@el-auth-gate.test`,
      role: 'user',
      tenantId: ORG_A,
    })
    const res = await request(pinned.url())
      .put(`/api/elearning/courses/${SCOPE_COURSE_ID}/scope`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'auth gate visibility', rules: [] })
    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual([
      'courseId',
      'revision',
      'revisionId',
      'ruleIds',
      'scopeId',
    ])
    expect(res.body.courseId).toBe(SCOPE_COURSE_ID)
    expect(res.body.revision).toBe(1)
    expect(res.body.ruleIds).toEqual([])
    expect(await scopeRevisionCount()).toBe(before + 1)
    valuesFree(res.body)
  })

  it('tenant-bound elearning:admin publishes and reads a plan with authoritative org/actor', async () => {
    trainingPlanPublishCalls.length = 0
    trainingPlanGetCalls.length = 0
    const token = signToken({
      userId: adminId,
      email: `${adminId}@el-auth-gate.test`,
      role: 'user',
      tenantId: ORG_A,
    })
    const publish = await request(pinned.url())
      .post(`/api/elearning/training-plans/publish?orgId=${encodeURIComponent(ORG_B)}&actorId=forged`)
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', ORG_B)
      .send(TRAINING_PLAN_BODY)
    expect(publish.status).toBe(201)
    expect(publish.body).toEqual(TRAINING_PLAN_RESULT)
    expect(trainingPlanPublishCalls).toEqual([{
      orgId: ORG_A,
      actorId: adminId,
      requestId: TRAINING_PLAN_BODY.requestId,
      title: TRAINING_PLAN_BODY.title,
      items: [{
        courseVersionId: TRAINING_PLAN_COURSE_VERSION_ID,
        required: true,
      }],
    }])
    valuesFree(publish.body)

    const read = await request(pinned.url())
      .get(`/api/elearning/training-plans/${TRAINING_PLAN_ID}?orgId=${encodeURIComponent(ORG_B)}`)
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', ORG_B)
    expect(read.status).toBe(200)
    expect(read.body).toEqual(TRAINING_PLAN_READ_RESULT)
    expect(trainingPlanGetCalls).toEqual([{
      orgId: ORG_A,
      planId: TRAINING_PLAN_ID,
    }])
    valuesFree(read.body)
  })

  it('elearning:write without admin cannot publish a training plan', async () => {
    trainingPlanPublishCalls.length = 0
    const token = signToken({
      userId: writerId,
      email: `${writerId}@el-auth-gate.test`,
      role: 'user',
      tenantId: ORG_A,
    })
    const res = await request(pinned.url())
      .post('/api/elearning/training-plans/publish')
      .set('Authorization', `Bearer ${token}`)
      .send(TRAINING_PLAN_BODY)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'Insufficient permissions' })
    expect(trainingPlanPublishCalls).toHaveLength(0)
    valuesFree(res.body)
  })

  it('only DB-authorized admin can assign a plan with JWT-bound org and actor', async () => {
    trainingPlanAssignmentCalls.length = 0
    const adminToken = signToken({
      userId: adminId,
      email: `${adminId}@el-auth-gate.test`,
      role: 'user',
      tenantId: ORG_A,
    })
    const assigned = await request(pinned.url())
      .post(`/api/elearning/training-plans/${TRAINING_PLAN_ID}/assign?orgId=${encodeURIComponent(ORG_B)}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', ORG_B)
      .send(TRAINING_PLAN_ASSIGNMENT_BODY)
    expect(assigned.status).toBe(201)
    expect(assigned.body).toEqual(TRAINING_PLAN_ASSIGNMENT_RESULT)
    expect(trainingPlanAssignmentCalls).toEqual([{
      orgId: ORG_A,
      actorId: adminId,
      planId: TRAINING_PLAN_ID,
      sourceKey: TRAINING_PLAN_ASSIGNMENT_BODY.sourceKey,
      deadline: TRAINING_PLAN_ASSIGNMENT_BODY.deadline,
      rules: TRAINING_PLAN_ASSIGNMENT_BODY.rules,
      isGlobalAdmin: true,
    }])
    valuesFree(assigned.body)

    trainingPlanAssignmentCalls.length = 0
    const writerToken = signToken({
      userId: writerId,
      email: `${writerId}@el-auth-gate.test`,
      role: 'user',
      tenantId: ORG_A,
    })
    const denied = await request(pinned.url())
      .post(`/api/elearning/training-plans/${TRAINING_PLAN_ID}/assign`)
      .set('Authorization', `Bearer ${writerToken}`)
      .send(TRAINING_PLAN_ASSIGNMENT_BODY)
    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: 'forbidden' })
    expect(trainingPlanAssignmentCalls).toEqual([])

    const legacyToken = signToken({
      userId: legacyId,
      email: `${legacyId}@el-auth-gate.test`,
      role: 'user',
    })
    const noOrg = await request(pinned.url())
      .post(`/api/elearning/training-plans/${TRAINING_PLAN_ID}/assign`)
      .set('Authorization', `Bearer ${legacyToken}`)
      .set('x-tenant-id', ORG_A)
      .send(TRAINING_PLAN_ASSIGNMENT_BODY)
    expect(noOrg.status).toBe(403)
    expect(noOrg.body).toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    expect(trainingPlanAssignmentCalls).toEqual([])
  })

  it('only DB-authorized admin can atomically revoke a plan assignment', async () => {
    trainingPlanRevocationCalls.length = 0
    const adminToken = signToken({
      userId: adminId,
      email: `${adminId}@el-auth-gate.test`,
      role: 'user',
      tenantId: ORG_A,
    })
    const revoked = await request(pinned.url())
      .put(
        `/api/elearning/training-plan-assignments/${TRAINING_PLAN_ASSIGNMENT_RESULT.planAssignmentId}/revocation?orgId=${encodeURIComponent(ORG_B)}`,
      )
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', ORG_B)
      .send(TRAINING_PLAN_REVOCATION_BODY)
    expect(revoked.status).toBe(200)
    expect(revoked.body).toEqual(TRAINING_PLAN_REVOCATION_RESULT)
    expect(trainingPlanRevocationCalls).toEqual([{
      orgId: ORG_A,
      actorId: adminId,
      planAssignmentId: TRAINING_PLAN_ASSIGNMENT_RESULT.planAssignmentId,
      reason: TRAINING_PLAN_REVOCATION_BODY.reason,
      isGlobalAdmin: true,
    }])
    valuesFree(revoked.body)

    trainingPlanRevocationCalls.length = 0
    const writerToken = signToken({
      userId: writerId,
      email: `${writerId}@el-auth-gate.test`,
      role: 'user',
      tenantId: ORG_A,
    })
    const denied = await request(pinned.url())
      .put(
        `/api/elearning/training-plan-assignments/${TRAINING_PLAN_ASSIGNMENT_RESULT.planAssignmentId}/revocation`,
      )
      .set('Authorization', `Bearer ${writerToken}`)
      .send(TRAINING_PLAN_REVOCATION_BODY)
    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: 'forbidden' })
    expect(trainingPlanRevocationCalls).toEqual([])

    const legacyToken = signToken({
      userId: legacyId,
      email: `${legacyId}@el-auth-gate.test`,
      role: 'user',
    })
    const noOrg = await request(pinned.url())
      .put(
        `/api/elearning/training-plan-assignments/${TRAINING_PLAN_ASSIGNMENT_RESULT.planAssignmentId}/revocation`,
      )
      .set('Authorization', `Bearer ${legacyToken}`)
      .set('x-tenant-id', ORG_A)
      .send(TRAINING_PLAN_REVOCATION_BODY)
    expect(noOrg.status).toBe(403)
    expect(noOrg.body).toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    expect(trainingPlanRevocationCalls).toEqual([])
  })

  it('the same admin receives not_found for a plan outside the JWT-bound org', async () => {
    trainingPlanGetCalls.length = 0
    const token = signToken({
      userId: adminId,
      email: `${adminId}@el-auth-gate.test`,
      role: 'user',
      tenantId: ORG_B,
    })
    const res = await request(pinned.url())
      .get(`/api/elearning/training-plans/${TRAINING_PLAN_ID}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
    expect(trainingPlanGetCalls).toEqual([{
      orgId: ORG_B,
      planId: TRAINING_PLAN_ID,
    }])
    valuesFree(res.body)
  })

  it('elearning:write without admin cannot append a scope revision', async () => {
    const before = await scopeRevisionCount()
    const token = signToken({
      userId: writerId,
      email: `${writerId}@el-auth-gate.test`,
      role: 'user',
      tenantId: ORG_A,
    })
    const res = await request(pinned.url())
      .put(`/api/elearning/courses/${SCOPE_COURSE_ID}/scope`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'must not write', rules: [] })
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'forbidden' })
    expect(await scopeRevisionCount()).toBe(before)
    valuesFree(res.body)
  })

  it('same admin in another org cannot append to the first org course', async () => {
    const before = await scopeRevisionCount()
    const token = signToken({
      userId: adminId,
      email: `${adminId}@el-auth-gate.test`,
      role: 'user',
      tenantId: ORG_B,
    })
    const res = await request(pinned.url())
      .put(`/api/elearning/courses/${SCOPE_COURSE_ID}/scope`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'cross-org must fail', rules: [] })
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
    expect(await scopeRevisionCount()).toBe(before)
    valuesFree(res.body)
  })

  it('tenant-less admin token plus forged x-tenant-id cannot append a scope revision', async () => {
    const before = await scopeRevisionCount()
    const token = signToken({
      userId: adminId,
      email: `${adminId}@el-auth-gate.test`,
      role: 'user',
    })
    const res = await request(pinned.url())
      .put(`/api/elearning/courses/${SCOPE_COURSE_ID}/scope`)
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', ORG_A)
      .send({ reason: 'forged tenant must fail', rules: [] })
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    expect(await scopeRevisionCount()).toBe(before)
    valuesFree(res.body)
  })

  it('tenant-bound elearning:read receives flag AND hydrated-RBAC capabilities', async () => {
    const token = signToken({
      userId: readerId,
      email: `${readerId}@el-auth-gate.test`,
      role: 'user',
      tenantId: ORG_A,
    })
    const res = await request(pinned.url())
      .get(elearningPlugin.CANONICAL_PATH)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual(READER_CAPABILITIES)
    valuesFree(res.body)
  })

  it('tenant-less legacy token plus forged x-tenant-id is capabilities 403 ORG_CONTEXT_REQUIRED', async () => {
    const token = signToken({
      userId: legacyId,
      email: `${legacyId}@el-auth-gate.test`,
      role: 'user',
    })
    const res = await request(pinned.url())
      .get(elearningPlugin.CANONICAL_PATH)
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', ORG_B)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    valuesFree(res.body)
  })

  it('invalid tenant claim without membership is capabilities 403 ORG_CONTEXT_REQUIRED', async () => {
    const token = signToken({
      userId: outsiderId,
      email: `${outsiderId}@el-auth-gate.test`,
      role: 'user',
      tenantId: FORGED_ORG,
    })
    const res = await request(pinned.url())
      .get(elearningPlugin.CANONICAL_PATH)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    valuesFree(res.body)
  })

  it('signed token carrying forged roles/perms cannot hydrate capabilities from claims', async () => {
    const token = signToken({
      userId: forgedId,
      email: `${forgedId}@el-auth-gate.test`,
      role: 'admin',
      roles: ['admin'],
      perms: ['elearning:admin', 'elearning:read', '*:*'],
      permissions: ['elearning:admin', 'elearning:read', '*:*'],
      tenantId: ORG_A,
    })
    const res = await request(pinned.url())
      .get(elearningPlugin.CANONICAL_PATH)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual(CLOSED_CAPABILITIES)
    valuesFree(res.body)
  })
})
