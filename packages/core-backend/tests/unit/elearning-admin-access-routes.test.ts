import express, { type Request } from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import {
  createElearningAdminAccessRouter,
  isElearningGlobalAdminRequest,
} from '../../src/routes/elearning-admin-access'
import {
  ElearningAdminAccessError,
  type ReplaceElearningAdminScopesInput,
  type ReplaceElearningObjectAclInput,
} from '../../src/services/elearning-admin-access'

const ORG = 'org-admin-route'
const ACTOR = 'actor-admin-route'
const USER = 'user-admin-route'
const COURSE = '11111111-1111-4111-8111-111111111111'
const PLAN = '22222222-2222-4222-8222-222222222222'
const DEPARTMENT = '33333333-3333-4333-8333-333333333333'
const FLAGS = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_ASSIGNMENT_ENABLED: 'true',
} as unknown as NodeJS.ProcessEnv

function makeApp(options: {
  env?: NodeJS.ProcessEnv
  actor?: string | null
  org?: string | null
  allowAdmin?: boolean
  allowWrite?: boolean
  globalAdmin?: boolean
  serviceError?: unknown
} = {}) {
  const scopeCalls: ReplaceElearningAdminScopesInput[] = []
  const aclCalls: ReplaceElearningObjectAclInput[] = []
  const order: string[] = []
  const db = {
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async <T>(handler: (tx: { query: typeof db.query }) => Promise<T>) =>
      handler({ query: db.query }),
  }
  const router = createElearningAdminAccessRouter({
    db,
    env: options.env ?? FLAGS,
    viewerId: () => {
      order.push('identity')
      return options.actor === undefined ? ACTOR : options.actor
    },
    orgId: () => {
      order.push('org')
      return options.org === undefined ? ORG : options.org
    },
    adminGuard: (_req, res, next) => {
      order.push('admin-rbac')
      if (options.allowAdmin === false) {
        res.status(403).json({ error: 'Insufficient permissions' })
        return
      }
      next()
    },
    writeGuard: (_req, res, next) => {
      order.push('write-rbac')
      if (options.allowWrite === false) {
        res.status(403).json({ error: 'Insufficient permissions' })
        return
      }
      next()
    },
    isGlobalAdmin: () => options.globalAdmin === true,
    replaceElearningAdminScopes: async (_db, input) => {
      order.push('scope-service')
      scopeCalls.push(input)
      if (options.serviceError) throw options.serviceError
      return { targetUserId: input.targetUserId, scopeCount: 1, duplicate: false }
    },
    replaceElearningObjectAcl: async (_db, input) => {
      order.push('acl-service')
      aclCalls.push(input)
      if (options.serviceError) throw options.serviceError
      return {
        objectType: 'course',
        objectId: COURSE,
        granteeUserId: input.granteeUserId,
        actions: ['track'],
        duplicate: false,
      }
    },
  })
  const app = express()
  if (router) app.use(router)
  return { app, router, scopeCalls, aclCalls, order }
}

describe('e-learning admin-access routes', () => {
  it('mounts only with exact assignment capability flags', () => {
    expect(makeApp().router).not.toBeNull()
    for (const env of [
      {},
      { ...FLAGS, ELEARNING_ENABLED: 'TRUE' },
      { ...FLAGS, ELEARNING_CONTENT_ENABLED: undefined },
      { ...FLAGS, ELEARNING_ASSIGNMENT_ENABLED: '1' },
    ]) {
      expect(makeApp({ env: env as NodeJS.ProcessEnv }).router).toBeNull()
    }
  })

  it('injects authoritative org/actor into admin-scope replacement after RBAC', async () => {
    const fixture = makeApp()
    const response = await request(fixture.app)
      .put(`/api/elearning/admin-scopes/${USER}?orgId=evil`)
      .set('x-tenant-id', 'evil')
      .send({
        reason: 'delegated department',
        scopes: [{ departmentId: DEPARTMENT, includeChildren: true }],
      })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      targetUserId: USER,
      scopeCount: 1,
      duplicate: false,
    })
    expect(fixture.scopeCalls).toEqual([{
      orgId: ORG,
      actorId: ACTOR,
      targetUserId: USER,
      reason: 'delegated department',
      scopes: [{ departmentId: DEPARTMENT, includeChildren: true }],
    }])
    expect(fixture.order.slice(0, 5)).toEqual([
      'identity',
      'org',
      'admin-rbac',
      'identity',
      'org',
    ])
    expect(fixture.order.at(-1)).toBe('scope-service')
  })

  it('uses write RBAC for collaborators and passes only hydrated global-admin state', async () => {
    const fixture = makeApp({ globalAdmin: true })
    const response = await request(fixture.app)
      .put(`/api/elearning/courses/${COURSE}/collaborators/${USER}`)
      .send({ reason: 'course tracker', actions: ['track'] })
    expect(response.status).toBe(200)
    expect(fixture.order).toContain('write-rbac')
    expect(fixture.order).not.toContain('admin-rbac')
    expect(fixture.aclCalls).toEqual([{
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: true,
      object: { courseId: COURSE },
      granteeUserId: USER,
      reason: 'course tracker',
      actions: ['track'],
    }])

    const plan = makeApp()
    const planResponse = await request(plan.app)
      .put(`/api/elearning/training-plans/${PLAN}/collaborators/${USER}`)
      .send({ reason: 'plan assigner', actions: ['assign'] })
    expect(planResponse.status).toBe(200)
    expect(plan.aclCalls[0]?.object).toEqual({ trainingPlanId: PLAN })
  })

  it('checks identity, org, and RBAC before parsing or service execution', async () => {
    const unauthenticated = makeApp({ actor: null })
    expect((await request(unauthenticated.app)
      .put(`/api/elearning/admin-scopes/${USER}`)
      .send('{bad')).status).toBe(401)
    expect(unauthenticated.scopeCalls).toEqual([])

    const noOrg = makeApp({ org: null })
    expect((await request(noOrg.app)
      .put(`/api/elearning/admin-scopes/${USER}`)
      .send({ reason: 'x', scopes: [] })).body).toEqual({
      error: 'ORG_CONTEXT_REQUIRED',
    })

    const denied = makeApp({ allowWrite: false })
    const deniedResponse = await request(denied.app)
      .put(`/api/elearning/courses/${COURSE}/collaborators/${USER}`)
      .send({ reason: 'x', actions: ['track'] })
    expect(deniedResponse.status).toBe(403)
    expect(denied.aclCalls).toEqual([])
  })

  it('rejects unknown/missing keys and malformed path identifiers', async () => {
    for (const requestCase of [
      request(makeApp().app)
        .put(`/api/elearning/admin-scopes/${USER}`)
        .send({ reason: 'x', scopes: [], extra: true }),
      request(makeApp().app)
        .put(`/api/elearning/courses/not-a-uuid/collaborators/${USER}`)
        .send({ reason: 'x', actions: [] }),
      request(makeApp().app)
        .put(`/api/elearning/training-plans/${PLAN}/collaborators/${USER}`)
        .send({ reason: 'x' }),
    ]) {
      const response = await requestCase
      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: 'invalid_input' })
    }
  })

  it('rechecks flags at request time and maps closed service errors', async () => {
    const env = { ...FLAGS } as NodeJS.ProcessEnv
    const fixture = makeApp({ env })
    env.ELEARNING_ASSIGNMENT_ENABLED = 'false'
    const disabled = await request(fixture.app)
      .put(`/api/elearning/admin-scopes/${USER}`)
      .send({ reason: 'x', scopes: [] })
    expect(disabled.status).toBe(404)
    expect(fixture.scopeCalls).toEqual([])

    const statuses = {
      invalid_input: 400,
      not_found: 404,
      forbidden: 403,
      scope_required: 403,
      target_out_of_scope: 403,
      unavailable: 503,
    } as const
    for (const [code, status] of Object.entries(statuses)) {
      const errorFixture = makeApp({
        serviceError: new ElearningAdminAccessError(
          code as keyof typeof statuses,
        ),
      })
      const response = await request(errorFixture.app)
        .put(`/api/elearning/admin-scopes/${USER}`)
        .send({ reason: 'x', scopes: [] })
      expect(response.status).toBe(status)
      expect(response.body).toEqual({ error: code })
    }
  })
})

describe('e-learning global-admin resolver', () => {
  function req(user: Record<string, unknown>): Request {
    return { user } as unknown as Request
  }

  it('accepts hydrated role/permissions and ignores raw token claims', () => {
    expect(isElearningGlobalAdminRequest(req({ role: 'admin' }))).toBe(true)
    expect(isElearningGlobalAdminRequest(req({ roles: ['admin'] }))).toBe(true)
    expect(isElearningGlobalAdminRequest(req({ permissions: ['elearning:admin'] })))
      .toBe(true)
    expect(isElearningGlobalAdminRequest(req({ permissions: ['elearning:*'] })))
      .toBe(true)
    expect(isElearningGlobalAdminRequest(req({ permissions: ['*:*'] }))).toBe(true)
    expect(isElearningGlobalAdminRequest(req({
      role: 'user',
      permissions: ['elearning:write'],
      perms: ['elearning:admin', '*:*'],
    }))).toBe(false)
  })
})
