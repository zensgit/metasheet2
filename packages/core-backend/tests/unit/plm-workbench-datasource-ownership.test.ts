/**
 * PLM workbench data-source ownership enforcement.
 *
 * The gap this pins: the four PLM workbench routes that take a CLIENT-SUPPLIED data source `:id`
 * resolved it with a bare `DataSourceManager.getDataSource(...)` behind `authenticate` only — no
 * per-user ownership assertion — while every other consumer of the manager
 * (`routes/data-sources.ts`, `data-source-plugin-facade.ts`) calls `assertAccess` on every
 * `:id` entry. Any authenticated user who learned or guessed an id could therefore drive PLM
 * workbench reads and writes against ANOTHER user's registered connection.
 *
 * These tests run against the REAL `DataSourceManager` — real `scopes`, real `assertAccess`, real
 * uniform not-found wording — deliberately NOT a hand-written stub that merely agrees with the
 * production semantics. A faithful-looking stub would keep passing if the real assertion drifted;
 * only the real manager witnesses the actual boundary.
 *
 * Companion-branch note: owner-only is the deliberate posture here. A shared/org-wide visibility
 * model belongs to the data-source visibility work, not to this file.
 */
import { EventEmitter } from 'node:events'
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

// The manager the mocked `getDataSourceManager()` hands to the routes. Swapped per test so a
// single probe id can be tested in a world where it exists and a world where it never did.
const managerRef = vi.hoisted(() => ({ current: null as unknown }))
// The authenticated caller, swapped per test (owner / non-owner / anonymous).
const authRef = vi.hoisted(() => ({ user: undefined as unknown }))

vi.mock('../../src/db/db', () => ({ db: {} }))
vi.mock('../../src/db/pg', () => ({ pool: {}, query: vi.fn() }))
vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = authRef.user as never
    next()
  },
}))
vi.mock('../../src/middleware/validation', () => ({
  validate: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))
vi.mock('../../src/types/validator', () => ({
  loadValidators: () => {
    const makeChain = () => {
      const chain = ((
        _req: express.Request,
        _res: express.Response,
        next: express.NextFunction,
      ) => next()) as express.RequestHandler & Record<string, () => express.RequestHandler>
      chain.optional = () => chain
      chain.isString = () => chain
      chain.notEmpty = () => chain
      chain.exists = () => chain
      chain.isObject = () => chain
      return chain
    }
    return { body: () => makeChain(), param: () => makeChain(), query: () => makeChain() }
  },
}))
// Only the accessor is mocked — it returns the REAL DataSourceManager built per test.
vi.mock('../../src/routes/data-sources', () => ({
  getDataSourceManager: () => managerRef.current,
}))

import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'
import plmWorkbenchRouter from '../../src/routes/plm-workbench'

const OWNER = 'alice'
const INTRUDER = 'bob'
/** One id reused across both worlds, so the two 404s are comparable byte for byte. */
const PROBE_ID = 'ds-probe'

const FEATURE = { supported: true, api_version: 'v1', entitled: true }

/**
 * A PLM-shaped adapter satisfying all four routes' duck-typed guards, so every route reaches its
 * real success path for the owner. Registered as a manager adapter type, i.e. it is produced by
 * the real `addDataSource` pipeline rather than injected past it.
 */
class FakePlmAdapter extends EventEmitter {
  async getIntegrationCapabilities() {
    return {
      available: true,
      manifest: {
        schema_version: 'v1',
        provider: 'yuantus-plm',
        advisory: true,
        features: {
          bom_multitable: FEATURE,
          bom_multitable_writeback: FEATURE,
          bom_eco_revision: { ...FEATURE, actions: ['eco_revision_intent'], action_status: 'governed' },
        },
      },
    }
  }

  async getBomMultitableContext(partId: string) {
    return { entitled: true, context: { part_id: partId, lines: [] } }
  }

  async updateBomMultitableLine(_partId: string, bomLineId: string) {
    return { data: [{ ok: true, bom_line_id: bomLineId }] }
  }

  async requestBomEcoRevisionIntent(_partId: string) {
    return { data: [{ eco_id: 'ECO-1', state: 'progress', attached: false }] }
  }
}

function plmConfig(id: string): DataSourceConfig {
  return {
    id,
    name: id,
    type: 'fake-plm',
    connection: { host: 'localhost' },
    options: { autoConnect: false },
  } as unknown as DataSourceConfig
}

/** Build a real manager holding exactly the given sources, each with a real ownership scope. */
async function buildManager(sources: Array<{ id: string; owner: string }>) {
  const manager = new DataSourceManager()
  manager.registerAdapterType('fake-plm', FakePlmAdapter as never)
  for (const s of sources) {
    await manager.addDataSource(plmConfig(s.id), { ownerId: s.owner })
  }
  return manager
}

const pinned = usePinnedServer()

/**
 * Every route that takes a client-supplied data source `:id`. Each entry sends a request for the
 * given id and names the marker proving the OWNER reached the real handler (not a degraded 200).
 */
const ROUTES = [
  {
    name: 'GET capabilities',
    send: (id: string) =>
      request(pinned.url()).get(`/api/plm-workbench/data-sources/${id}/capabilities`),
    expectOwner: (body: Record<string, unknown>) => {
      expect(body.available).toBe(true)
      expect((body.manifest as Record<string, unknown>).provider).toBe('yuantus-plm')
    },
  },
  {
    name: 'GET bom-multitable context',
    send: (id: string) =>
      request(pinned.url()).get(`/api/plm-workbench/data-sources/${id}/bom-multitable/P1/context`),
    expectOwner: (body: Record<string, unknown>) => {
      expect(body.entitled).toBe(true)
      expect((body.context as Record<string, unknown>).part_id).toBe('P1')
    },
  },
  {
    name: 'PATCH bom-multitable line (write-back)',
    send: (id: string) =>
      request(pinned.url())
        .patch(`/api/plm-workbench/data-sources/${id}/bom-multitable/P1/lines/R1`)
        .set('Idempotency-Key', 'k-1')
        .send({ quantity: 5 }),
    expectOwner: (body: Record<string, unknown>) => {
      expect(body.ok).toBe(true)
      expect(body.bom_line_id).toBe('R1')
    },
  },
  {
    name: 'POST bom eco-intent',
    send: (id: string) =>
      request(pinned.url()).post(`/api/plm-workbench/data-sources/${id}/bom-multitable/P1/eco-intent`).send({}),
    expectOwner: (body: Record<string, unknown>) => {
      expect(body.eco_id).toBe('ECO-1')
    },
  },
]

describe('plm-workbench data-source routes enforce per-user ownership', () => {
  const app = express()
  app.use(express.json())
  app.use(plmWorkbenchRouter)

  beforeEach(async () => {
    pinned.setApp(app)
    authRef.user = { id: OWNER, tenantId: 'tenant-a' }
    managerRef.current = await buildManager([{ id: PROBE_ID, owner: OWNER }])
  })

  for (const route of ROUTES) {
    describe(route.name, () => {
      it('lets the OWNER through to the real handler', async () => {
        authRef.user = { id: OWNER, tenantId: 'tenant-a' }
        const res = await route.send(PROBE_ID)
        expect(res.status).toBe(200)
        route.expectOwner(res.body)
      })

      it('refuses a NON-OWNER with 404', async () => {
        authRef.user = { id: INTRUDER, tenantId: 'tenant-a' }
        const res = await route.send(PROBE_ID)
        expect(res.status).toBe(404)
      })

      it('refuses an ANONYMOUS caller with 404 (no principal is never an owner)', async () => {
        authRef.user = undefined
        const res = await route.send(PROBE_ID)
        expect(res.status).toBe(404)
      })

      it('gives a non-owner a response BYTE-IDENTICAL to a never-existing id (no existence oracle)', async () => {
        authRef.user = { id: INTRUDER, tenantId: 'tenant-a' }

        // World A: PROBE_ID exists, owned by someone else.
        managerRef.current = await buildManager([{ id: PROBE_ID, owner: OWNER }])
        const denied = await route.send(PROBE_ID)

        // World B: PROBE_ID never existed at all. Same requester, same URL, same id echoed back —
        // so any difference in the two responses would BE the oracle.
        managerRef.current = await buildManager([{ id: 'unrelated', owner: OWNER }])
        const missing = await route.send(PROBE_ID)

        expect(denied.status).toBe(404)
        expect(missing.status).toBe(404)
        expect(denied.text).toBe(missing.text)
        expect(denied.headers['content-type']).toBe(missing.headers['content-type'])
      })
    })
  }

  // The principal must be resolved the same way `routes/data-sources.ts` resolves it when it
  // persists `owner_id` (id -> userId -> sub). A resolver that read only `id` would lock the real
  // owner out of their own source whenever the auth middleware used one of the other claim shapes.
  it.each([
    ['userId', { userId: OWNER, tenantId: 'tenant-a' }],
    ['sub', { sub: OWNER, tenantId: 'tenant-a' }],
  ])('accepts the owner authenticated via the %s claim', async (_claim, user) => {
    authRef.user = user
    const res = await request(pinned.url()).get(`/api/plm-workbench/data-sources/${PROBE_ID}/capabilities`)
    expect(res.status).toBe(200)
    expect(res.body.available).toBe(true)
  })

  it('still 404s a non-owner whose id merely PREFIXES the owner id (strict equality, not prefix)', async () => {
    authRef.user = { id: 'ali', tenantId: 'tenant-a' }
    const res = await request(pinned.url()).get(`/api/plm-workbench/data-sources/${PROBE_ID}/capabilities`)
    expect(res.status).toBe(404)
  })

  it('does not leak the other user’s source through the write path either (no side effect)', async () => {
    const manager = await buildManager([{ id: PROBE_ID, owner: OWNER }])
    managerRef.current = manager
    const adapter = manager.getDataSource(PROBE_ID) as unknown as FakePlmAdapter
    const spy = vi.spyOn(adapter, 'updateBomMultitableLine')

    authRef.user = { id: INTRUDER, tenantId: 'tenant-a' }
    const res = await request(pinned.url())
      .patch(`/api/plm-workbench/data-sources/${PROBE_ID}/bom-multitable/P1/lines/R1`)
      .set('Idempotency-Key', 'k-1')
      .send({ quantity: 5 })

    expect(res.status).toBe(404)
    // The refusal happens BEFORE the adapter is touched — the intruder's patch never reaches PLM.
    expect(spy).not.toHaveBeenCalled()
  })
})
