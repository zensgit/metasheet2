/**
 * The per-source door of `GET /api/todo/items` and `GET /api/todo/count`, through the real router and
 * the real query parser, with `requestHasPermission` answered by a table. The decision itself is
 * covered by `rbac-request-has-permission.test.ts`.
 */
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { actorId as taskRouteActorId } from '../../src/routes/tasks-http'
import { pendingSourceRegistry, type PendingSource, type PendingViewer } from '../../src/services/pending-source-registry'
import { requestHasPermission } from '../../src/rbac/rbac'
import { todoRouter } from '../../src/routes/todo'
import { usePinnedServer } from '../utils/pinned-server'

const state = vi.hoisted(() => ({
  user: undefined as Record<string, unknown> | undefined,
  sessionOrg: undefined as string | undefined,
  granted: new Set<string>(),
  failure: null as Error | null,
  taskRouteActorIds: [] as string[],
}))

vi.mock('../../src/middleware/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/auth')>()),
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = state.user as express.Request['user']
    if (state.sessionOrg !== undefined) req.authenticatedTenantId = state.sessionOrg
    next()
  },
}))

vi.mock('../../src/rbac/rbac', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/rbac/rbac')>()),
  requestHasPermission: vi.fn(async (_req: unknown, code: string) => {
    if (state.failure) throw state.failure
    return state.granted.has(code)
  }),
}))

vi.mock('../../src/services/approval-actor-roles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/approval-actor-roles')>()),
  resolveApprovalActorRoles: vi.fn(async () => ['member']),
}))

type StubSource = PendingSource & {
  listPendingForUser: ReturnType<typeof vi.fn>
  countPendingForUser: ReturnType<typeof vi.fn>
}

function stub(name: string, permission: string): StubSource {
  return {
    name,
    permission,
    listPendingForUser: vi.fn(async () => [{ source: name, id: `${name}-1`, title: name, href: `/${name}/1`, updatedAt: '2031-01-01T00:00:00.000Z' }]),
    countPendingForUser: vi.fn(async () => 1),
  }
}

function app(): express.Express {
  const server = express()
  server.use((req, res, next) => {
    // The id the task routes would resolve from the same user shape.
    res.on('finish', () => {
      if (req.user) state.taskRouteActorIds.push(taskRouteActorId(req))
    })
    next()
  })
  server.use(todoRouter())
  return server
}

const ITEMS = '/api/todo/items'
const COUNT = '/api/todo/count'

describe('todo center per-source door', () => {
  const pinned = usePinnedServer()
  let approval: StubSource
  let task: StubSource

  beforeEach(() => {
    state.user = { id: 'u1' }
    pinned.setApp(app())
    state.sessionOrg = 'org-1'
    state.granted = new Set()
    state.failure = null
    state.taskRouteActorIds = []
    vi.mocked(requestHasPermission).mockClear()
    pendingSourceRegistry.clear()
    approval = stub('approval', 'approvals:read')
    task = stub('task', 'tasks:read')
    pendingSourceRegistry.register(approval)
    pendingSourceRegistry.register(task)
  })

  afterEach(() => {
    pendingSourceRegistry.clear()
  })

  it('a viewer with approval access alone gets the approval source and no task key', async () => {
    state.granted = new Set(['approvals:read'])
    const items = await request(pinned.url()).get(ITEMS)
    expect(items.status).toBe(200)
    expect(items.body.sources).toEqual({ approval: 'ok' })
    expect(items.body.items.map((item: { source: string }) => item.source)).toEqual(['approval'])
    const count = await request(pinned.url()).get(COUNT)
    expect(count.body).toEqual({ count: 1, sources: { approval: 'ok' } })
    expect(task.listPendingForUser).not.toHaveBeenCalled()
    expect(task.countPendingForUser).not.toHaveBeenCalled()
  })

  it('a viewer with task access alone gets the task source and no approval key', async () => {
    state.granted = new Set(['tasks:read'])
    const items = await request(pinned.url()).get(ITEMS)
    expect(items.status).toBe(200)
    expect(items.body.sources).toEqual({ task: 'ok' })
    expect(approval.listPendingForUser).not.toHaveBeenCalled()
  })

  it('a viewer with both gets both, in registration order', async () => {
    state.granted = new Set(['approvals:read', 'tasks:read'])
    const items = await request(pinned.url()).get(ITEMS)
    expect(Object.keys(items.body.sources)).toEqual(['approval', 'task'])
    expect(items.body.items.map((item: { source: string }) => item.source)).toEqual(['approval', 'task'])
    const count = await request(pinned.url()).get(COUNT)
    expect(count.body).toEqual({ count: 2, sources: { approval: 'ok', task: 'ok' } })
  })

  it('a viewer with neither gets the same 403 body as rbacGuard', async () => {
    for (const path of [ITEMS, COUNT]) {
      const response = await request(pinned.url()).get(path)
      expect(response.status).toBe(403)
      expect(response.body).toEqual({ error: 'Insufficient permissions' })
    }
  })

  it('a failed check answers the same 500 body as rbacGuard', async () => {
    state.failure = new Error('lookup failed')
    for (const path of [ITEMS, COUNT]) {
      const response = await request(pinned.url()).get(path)
      expect(response.status).toBe(500)
      expect(response.body).toEqual({ error: 'Permission check failed' })
    }
  })

  it('no user id answers the same 401 body as rbacGuard, before any check', async () => {
    state.user = undefined
    for (const path of [ITEMS, COUNT]) {
      const response = await request(pinned.url()).get(path)
      expect(response.status).toBe(401)
      expect(response.body).toEqual({ error: 'Authentication required' })
    }
    expect(requestHasPermission).not.toHaveBeenCalled()
  })

  it('the door follows the registry: a third source appears only when its own code is held', async () => {
    const third = stub('third', 'third:read')
    pendingSourceRegistry.register(third)
    state.granted = new Set(['approvals:read'])
    let items = await request(pinned.url()).get(ITEMS)
    expect(items.body.sources).toEqual({ approval: 'ok' })

    state.granted = new Set(['approvals:read', 'third:read'])
    items = await request(pinned.url()).get(ITEMS)
    expect(items.body.sources).toEqual({ approval: 'ok', third: 'ok' })
  })

  it('each distinct code is evaluated once per request', async () => {
    pendingSourceRegistry.register(stub('third', 'approvals:read'))
    state.granted = new Set(['approvals:read'])
    const items = await request(pinned.url()).get(ITEMS)
    expect(items.body.sources).toEqual({ approval: 'ok', third: 'ok' })
    const codes = vi.mocked(requestHasPermission).mock.calls.map((call) => call[1]).sort()
    expect(codes).toEqual(['approvals:read', 'tasks:read'])
  })

  describe('?sources= can only narrow', () => {
    beforeEach(() => {
      state.granted = new Set(['approvals:read', 'tasks:read'])
    })

    it('a source the viewer may not read stays out of the answer', async () => {
      state.granted = new Set(['approvals:read'])
      const items = await request(pinned.url()).get(`${ITEMS}?sources=task`)
      expect(items.status).toBe(200)
      expect(items.body).toEqual({ items: [], sources: {} })
      const count = await request(pinned.url()).get(`${COUNT}?sources=task`)
      expect(count.status).toBe(200)
      expect(count.body).toEqual({ count: 0, sources: {} })
      expect(task.listPendingForUser).not.toHaveBeenCalled()
      expect(task.countPendingForUser).not.toHaveBeenCalled()
    })

    it('a readable named source settles the answer without evaluating the other codes', async () => {
      state.granted = new Set(['approvals:read'])
      const count = await request(pinned.url()).get(`${COUNT}?sources=approval`)
      expect(count.status).toBe(200)
      expect(count.body).toEqual({ count: 1, sources: { approval: 'ok' } })
      expect(vi.mocked(requestHasPermission).mock.calls.map((call) => call[1])).toEqual(['approvals:read'])
    })

    it('a named source the viewer may not read evaluates the others to tell an empty answer from a refusal', async () => {
      state.granted = new Set(['approvals:read'])
      await request(pinned.url()).get(`${COUNT}?sources=task`)
      const codes = vi.mocked(requestHasPermission).mock.calls.map((call) => call[1]).sort()
      expect(codes).toEqual(['approvals:read', 'tasks:read'])
    })

    it('naming a source still answers 403 for a viewer with none', async () => {
      state.granted = new Set()
      for (const path of [ITEMS, COUNT]) {
        for (const name of ['approval', 'task']) {
          const response = await request(pinned.url()).get(`${path}?sources=${name}`)
          expect(response.status).toBe(403)
          expect(response.body).toEqual({ error: 'Insufficient permissions' })
        }
      }
    })

    it('a failed check on a named source answers the same 500 body as rbacGuard', async () => {
      state.failure = new Error('lookup failed')
      for (const path of [ITEMS, COUNT]) {
        const response = await request(pinned.url()).get(`${path}?sources=approval`)
        expect(response.status).toBe(500)
        expect(response.body).toEqual({ error: 'Permission check failed' })
      }
    })

    it('an unknown name is dropped', async () => {
      const count = await request(pinned.url()).get(`${COUNT}?sources=approval,bogus`)
      expect(count.body).toEqual({ count: 1, sources: { approval: 'ok' } })
    })

    it('registration order is kept whatever the request order', async () => {
      const items = await request(pinned.url()).get(`${ITEMS}?sources=task,approval`)
      expect(Object.keys(items.body.sources)).toEqual(['approval', 'task'])
    })

    it('the repeated-key form is read as a list', async () => {
      const count = await request(pinned.url()).get(`${COUNT}?sources=approval&sources=task`)
      expect(count.status).toBe(200)
      expect(count.body.sources).toEqual({ approval: 'ok', task: 'ok' })
    })

    it('the bracket form is read as a list', async () => {
      const count = await request(pinned.url()).get(`${COUNT}?sources[]=task`)
      expect(count.status).toBe(200)
      expect(count.body.sources).toEqual({ task: 'ok' })
    })

    it('the object form counts as not named', async () => {
      const count = await request(pinned.url()).get(`${COUNT}?sources[x]=y`)
      expect(count.status).toBe(200)
      expect(count.body.sources).toEqual({ approval: 'ok', task: 'ok' })
    })

    it('the empty value names an empty set', async () => {
      const items = await request(pinned.url()).get(`${ITEMS}?sources=`)
      expect(items.status).toBe(200)
      expect(items.body).toEqual({ items: [], sources: {} })
      const count = await request(pinned.url()).get(`${COUNT}?sources=`)
      expect(count.body).toEqual({ count: 0, sources: {} })
    })

    it('spaces and empty members are ignored', async () => {
      const count = await request(pinned.url()).get(`${COUNT}?sources=${encodeURIComponent(' approval , ,task ')}`)
      expect(count.body.sources).toEqual({ approval: 'ok', task: 'ok' })
    })

    it('naming no sources still answers 403 for a viewer with none', async () => {
      state.granted = new Set()
      const count = await request(pinned.url()).get(`${COUNT}?sources=`)
      expect(count.status).toBe(403)
      expect(count.body).toEqual({ error: 'Insufficient permissions' })
    })
  })

  describe('viewer passed to sources', () => {
    function viewerSeen(): PendingViewer {
      return approval.listPendingForUser.mock.calls[0][0] as PendingViewer
    }

    beforeEach(() => {
      state.granted = new Set(['approvals:read'])
    })

    it('organization comes from the session, not from request metadata', async () => {
      state.user = { id: 'u1', tenantId: 'org-a' }
      state.sessionOrg = undefined
      await request(pinned.url()).get(ITEMS).set('x-tenant-id', 'org-a')
      expect(viewerSeen().orgId).toBeNull()
    })

    it('the session organization is passed on', async () => {
      state.user = { id: 'u1', tenantId: 'org-b' }
      state.sessionOrg = 'org-b'
      await request(pinned.url()).get(ITEMS)
      expect(viewerSeen().orgId).toBe('org-b')
    })

    it('the session organization decides when other fields differ', async () => {
      state.user = { id: 'u1', tenantId: 'org-a' }
      state.sessionOrg = 'org-b'
      await request(pinned.url()).get(ITEMS).set('x-tenant-id', 'org-a')
      expect(viewerSeen().orgId).toBe('org-b')
    })

    it('an empty session organization becomes null', async () => {
      state.sessionOrg = ''
      await request(pinned.url()).get(ITEMS)
      expect(viewerSeen().orgId).toBeNull()
    })

    it('a valid time zone header is passed on; a missing or invalid one becomes null', async () => {
      await request(pinned.url()).get(ITEMS).set('x-viewer-time-zone', 'Asia/Shanghai')
      expect(viewerSeen().timeZone).toBe('Asia/Shanghai')

      approval.listPendingForUser.mockClear()
      await request(pinned.url()).get(ITEMS).set('x-viewer-time-zone', 'not/a-zone')
      expect(viewerSeen().timeZone).toBeNull()

      approval.listPendingForUser.mockClear()
      await request(pinned.url()).get(ITEMS)
      expect(viewerSeen().timeZone).toBeNull()
    })

    it('the three existing fields keep their values', async () => {
      state.user = { id: 'u1', permissions: ['approvals:read'] }
      await request(pinned.url()).get(ITEMS)
      expect(viewerSeen()).toMatchObject({ actorId: 'u1', roles: ['member'], permissions: ['approvals:read'] })
    })

    it('the actor id equals the one the task routes resolve', async () => {
      state.user = { id: 'u1' }
      await request(pinned.url()).get(ITEMS)
      await vi.waitFor(() => expect(state.taskRouteActorIds).toHaveLength(1))
      expect(viewerSeen().actorId).toBe(state.taskRouteActorIds[0])
    })
  })
})
