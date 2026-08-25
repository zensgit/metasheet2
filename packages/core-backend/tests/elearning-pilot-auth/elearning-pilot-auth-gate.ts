/**
 * E-learning V0.1 ratified gate 1: real PostgreSQL authentication / tenant /
 * RBAC on the production pilot runtime.
 *
 * Import order is owned by tests/elearning-pilot-auth/setup.ts plus this
 * dedicated vitest config. Do not run this file under
 * vitest.integration.config.ts (that setup caches RBAC_TOKEN_TRUST true).
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import { Pool } from 'pg'
import request from 'supertest'

import { createElearningPilotRuntime } from '../../src/services/elearning-pilot-runtime'
import type { ElearningLearnerCourse } from '../../src/services/elearning-learner-courses'
import { ELEARNING_MEDIA_PLAYBACK_SECRET_ENV } from '../../src/services/elearning-media-playback'
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
const ORG_A = `${NS}-org-a`
const ORG_B = `${NS}-org-b`
const FORGED_ORG = `${NS}-forged-org`

const LEARNER_COURSES: ElearningLearnerCourse[] = [{
  courseId: '11111111-1111-4111-8111-111111111111',
  courseVersionId: '22222222-2222-4222-8222-222222222222',
  title: 'Pilot course',
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

const dummyDb = {
  query: async () => ({ rows: [], rowCount: 0 }),
  transaction: async (handler: (tx: { query: typeof dummyDb.query }) => Promise<unknown>) =>
    handler({ query: dummyDb.query }),
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
  const legacyId = randomUUID()
  const outsiderId = randomUUID()
  const forgedId = randomUUID()
  const createdUserIds = [readerId, legacyId, outsiderId, forgedId]
  const pinned = usePinnedServer()
  const learnerCalls: Array<{ orgId: string; userId: string }> = []

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO permissions (code, name, description)
       VALUES ('elearning:read', 'E-learning Read', 'Read published learning content and own attempts')
       ON CONFLICT (code) DO NOTHING`,
    )
    await pool.query(
      `INSERT INTO roles (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [ROLE_ID, ROLE_ID],
    )
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_code)
       VALUES ($1, 'elearning:read')
       ON CONFLICT DO NOTHING`,
      [ROLE_ID],
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
    await insertUser(legacyId, 'legacy')
    await insertUser(outsiderId, 'outsider')
    await insertUser(forgedId, 'forged')

    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active)
       VALUES ($1, $2, TRUE), ($3, $2, TRUE), ($3, $4, TRUE), ($5, $2, TRUE)`,
      [readerId, ORG_A, legacyId, ORG_B, forgedId],
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
      db: dummyDb as never,
      env: FLAG_EXAM_ON,
      listElearningLearnerCourses: async (_db, input) => {
        learnerCalls.push({ orgId: input.orgId, userId: input.userId })
        return LEARNER_COURSES
      },
    })
    if (!runtime) {
      throw new Error('elearning pilot runtime must mount when exam flags are exact true')
    }
    const app = express()
    app.use(runtime.router)
    pinned.setApp(app)
  })

  afterAll(async () => {
    await pool.query(
      `DELETE FROM user_namespace_admissions WHERE user_id = ANY($1::text[])`,
      [createdUserIds],
    ).catch(() => undefined)
    await pool.query(
      `DELETE FROM user_permissions WHERE user_id = ANY($1::text[])`,
      [createdUserIds],
    ).catch(() => undefined)
    await pool.query(
      `DELETE FROM user_roles WHERE user_id = ANY($1::text[])`,
      [createdUserIds],
    ).catch(() => undefined)
    await pool.query(
      `DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`,
      [createdUserIds],
    ).catch(() => undefined)
    await pool.query(
      `DELETE FROM users WHERE id = ANY($1::text[])`,
      [createdUserIds],
    ).catch(() => undefined)
    await pool.query(
      `DELETE FROM role_permissions WHERE role_id = $1`,
      [ROLE_ID],
    ).catch(() => undefined)
    await pool.query(`DELETE FROM roles WHERE id = $1`, [ROLE_ID]).catch(() => undefined)
    await pool.end()
  })

  it('dedicated setup pinned RBAC flags false before auth/RBAC/runtime import', () => {
    expect(process.env.ELEARNING_PILOT_AUTH_GATE_SETUP).toBe('1')
    expect(process.env.RBAC_BYPASS).toBe('false')
    expect(process.env.RBAC_TOKEN_TRUST).toBe('false')
    expect(process.env.PRODUCT_MODE).toBe('plm-workbench')
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
})
