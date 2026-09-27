/**
 * PLM workbench BOM write-back PATCH and ECO revision-intent POST no longer echo the provider/
 * axios error's raw `.message` into the response body.
 *
 * docs/development/plm-adapter-token-persistence-design-20260912.md (~:180, R6 residual): both
 * `error: result.error.message || 'BOM write-back failed'` (plm-workbench.ts, BOM write-back PATCH)
 * and `error: result.error.message || 'ECO revision intent failed'` (same file, ECO revision-intent
 * POST) put the caught provider/axios error's message straight on the wire. That error can be a
 * connection failure or an axios error whose `.message` embeds the request host/port and, for some
 * drivers, credential-shaped detail. relayProviderWritebackError / relayProviderEcoIntentError only
 * classify `status` + `reason`; neither one touches `.message`.
 *
 * Fix: both branches now answer a fixed, values-free string plus a stable `code`; the real error
 * goes to `logger.error()` only (server side). Shape mirrors #6066's admin-failure-envelope.
 *
 * Values-free fixture: an RFC 5737 TEST-NET-3 documentation address and a literal placeholder
 * role/password -- recognizable as "leaky", never a real deployment value.
 *
 * Transport: usePinnedServer() + request(pinned.url()), never request(app) -- see #4154.
 */
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const dsMocks = vi.hoisted(() => ({
  getDataSource: vi.fn(),
  assertAccess: vi.fn(),
}))

vi.mock('../../src/db/db', () => ({ db: {} }))
vi.mock('../../src/db/pg', () => ({ pool: {}, query: vi.fn() }))
vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { id: 'owner-1', tenantId: 'tenant-a' } as never
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
vi.mock('../../src/routes/data-sources', () => ({
  getDataSourceManager: () => ({
    getDataSource: dsMocks.getDataSource,
    assertAccess: dsMocks.assertAccess,
  }),
}))

import plmWorkbenchRouter, {
  PLM_BOM_WRITEBACK_FAILED_CODE,
  PLM_BOM_WRITEBACK_FAILED_MESSAGE,
  PLM_ECO_INTENT_FAILED_CODE,
  PLM_ECO_INTENT_FAILED_MESSAGE,
} from '../../src/routes/plm-workbench'

/** The kind of text a real driver/axios failure carries: host:port plus an auth failure. */
const LEAKY = 'connect ECONNREFUSED 203.0.113.9:5432 - password authentication failed for user "fixture-role"'
const LEAKY_FRAGMENTS = ['203.0.113.9', '5432', 'fixture-role', 'ECONNREFUSED', 'password']

function leakyError(): Error {
  return new Error(LEAKY)
}

const WRITE_URL = '/api/plm-workbench/data-sources/ds-1/bom-multitable/P1/lines/R1'
const INTENT_URL = '/api/plm-workbench/data-sources/ds-1/bom-multitable/P1/eco-intent'

const manifest = (
  bom: Record<string, unknown>,
  extraFeatures: Record<string, Record<string, unknown>> = {},
) => ({
  schema_version: 'v1',
  provider: 'yuantus-plm',
  advisory: true,
  features: {
    bom_multitable: bom,
    ...extraFeatures,
  },
})

/** The whole contract of this change, in one assertion helper. */
function expectRedacted(body: Record<string, unknown>, code: string, message: string): void {
  expect(body.code).toBe(code)
  expect(body.error).toBe(message)
  const serialized = JSON.stringify(body)
  expect(serialized).not.toContain(LEAKY)
  for (const fragment of LEAKY_FRAGMENTS) {
    expect(serialized).not.toContain(fragment)
  }
  // No stack ever travels either.
  expect(serialized).not.toContain('.ts:')
  expect(serialized).not.toContain('at Object')
}

const pinned = usePinnedServer()

describe('plm-workbench write routes redact the provider error text (values-free)', () => {
  const app = express()
  app.use(express.json())
  app.use(plmWorkbenchRouter)

  beforeEach(() => {
    dsMocks.getDataSource.mockReset()
    dsMocks.assertAccess.mockReset()
    pinned.setApp(app)
  })

  it('BOM write-back PATCH: the response never echoes the provider error message', async () => {
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest(
          { supported: true, api_version: 'v1', entitled: true },
          { bom_multitable_writeback: { supported: true, api_version: 'v1', entitled: true } },
        ),
      }),
      getBomMultitableContext: vi.fn(),
      updateBomMultitableLine: vi.fn().mockResolvedValue({ data: [], error: leakyError() }),
    })
    const res = await request(pinned.url())
      .patch(WRITE_URL)
      .set('Idempotency-Key', 'submit-1')
      .send({ quantity: 5 })
    expect(res.status).toBe(502)
    expect(res.body.reason).toBe('provider-unavailable')
    expectRedacted(res.body as Record<string, unknown>, PLM_BOM_WRITEBACK_FAILED_CODE, PLM_BOM_WRITEBACK_FAILED_MESSAGE)
  })

  it('BOM write-back PATCH: a discriminated 409 still redacts the message (status/reason unaffected)', async () => {
    const conflict = Object.assign(leakyError(), { response: { status: 409 } })
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest(
          { supported: true, api_version: 'v1', entitled: true },
          { bom_multitable_writeback: { supported: true, api_version: 'v1', entitled: true } },
        ),
      }),
      getBomMultitableContext: vi.fn(),
      updateBomMultitableLine: vi.fn().mockResolvedValue({ data: [], error: conflict }),
    })
    const res = await request(pinned.url())
      .patch(WRITE_URL)
      .set('Idempotency-Key', 'submit-1')
      .send({ quantity: 5 })
    expect(res.status).toBe(409)
    expect(res.body.reason).toBe('provider-rejected')
    expectRedacted(res.body as Record<string, unknown>, PLM_BOM_WRITEBACK_FAILED_CODE, PLM_BOM_WRITEBACK_FAILED_MESSAGE)
  })

  it('ECO revision-intent POST: the response never echoes the provider error message', async () => {
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest(
          { supported: true, api_version: 'v1', entitled: true },
          {
            bom_eco_revision: {
              supported: true,
              api_version: 'v1',
              entitled: true,
              actions: ['eco_revision_intent'],
              action_status: 'governed',
            },
          },
        ),
      }),
      getBomMultitableContext: vi.fn(),
      requestBomEcoRevisionIntent: vi.fn().mockResolvedValue({ data: [], error: leakyError() }),
    })
    const res = await request(pinned.url()).post(INTENT_URL)
    expect(res.status).toBe(502)
    expect(res.body.reason).toBe('provider-unavailable')
    expectRedacted(res.body as Record<string, unknown>, PLM_ECO_INTENT_FAILED_CODE, PLM_ECO_INTENT_FAILED_MESSAGE)
  })

  it('the fixed messages and codes are themselves values-free', () => {
    for (const fragment of [...LEAKY_FRAGMENTS, 'postgres', 'redis', '/', '\\']) {
      expect(PLM_BOM_WRITEBACK_FAILED_MESSAGE).not.toContain(fragment)
      expect(PLM_ECO_INTENT_FAILED_MESSAGE).not.toContain(fragment)
    }
    expect(PLM_BOM_WRITEBACK_FAILED_CODE).toBe('PLM_BOM_WRITEBACK_FAILED')
    expect(PLM_ECO_INTENT_FAILED_CODE).toBe('PLM_ECO_INTENT_FAILED')
  })
})
