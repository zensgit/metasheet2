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
 * goes to `logger.error()` only (server side). Personal dispatch maps Failure.detail/received.
 * An unknown outcome is 503 reason `unknown` and is not claimed as refused.
 *
 * Values-free fixture: an RFC 5737 TEST-NET-3 documentation address and a literal placeholder
 * role/password -- recognizable as "leaky", never a real deployment value.
 *
 * Transport: usePinnedServer() + request(pinned.url()), never request(app) -- see #4154.
 *
 * #6105 follow-up: the redaction above was never pinned against dropping the server-side
 * `logger.error(...)` call that both branches make right before building the redacted body --
 * deleting either call left all suites below green. Spy on `Logger.prototype.error` (the seam
 * used by admin-read-error-echo-redaction.test.ts and admin-tree-5xx-values-free.test.ts for the
 * same shape of assertion) and assert each write route calls it exactly once, with the original
 * (unredacted) error reaching the second argument.
 */
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'
import { Logger } from '../../src/core/logger'
import { PlmPersonalBomWriteError } from '../../src/services/plm-personal-bom-write-wire'

const LOGIN = `Bearer ${jwt.sign({ userId: 'owner-1', email: 'o@x', role: 'user' }, 'synthetic-route-key')}`
const dsMocks = vi.hoisted(() => ({
  getDataSource: vi.fn(),
  assertAccess: vi.fn(),
}))
const dispatchMocks = vi.hoisted(() => ({ dispatchOperation: vi.fn() }))
const pgMocks = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('../../src/db/db', () => ({ db: {} }))
vi.mock('../../src/db/pg', () => ({ pool: {}, query: pgMocks.query }))
vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { id: 'owner-1', tenantId: 'header-tenant-not-authority', role: 'admin' } as never
    req.authenticatedTenantId = 'tenant-a'
    req.verifiedTenantClaim = { kind: 'present', value: 'tenant-a' }
    next()
  },
}))
vi.mock('../../src/services/plm-personal-bom-write-http', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/plm-personal-bom-write-http')>(
    '../../src/services/plm-personal-bom-write-http',
  )
  return {
    ...actual,
    plmPersonalBomWriteService: () => ({ dispatchOperation: dispatchMocks.dispatchOperation }),
  }
})
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

import {
  beginDurableUnboundClassification,
  finishDurableUnboundClassification,
  type DurableUnboundCall,
} from '../utils/plm-managed-unbound-classification'
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

/**
 * The other half of the contract: redacting the wire body must not also silence the operator.
 * The route's own `logger.error(...)` call is the only place the original provider error is
 * still allowed to appear, so pin that it fires exactly once and carries the real error.
 */
function expectLoggedOriginalError(errorLog: ReturnType<typeof vi.spyOn>): void {
  expect(errorLog).toHaveBeenCalledTimes(1)
  const [, loggedError] = errorLog.mock.calls[0] as [string, Error | undefined]
  expect(loggedError).toBeInstanceOf(Error)
  expect(loggedError?.message).toBe(LEAKY)
}

const pinned = usePinnedServer()
const classificationCalls: DurableUnboundCall[] = []

describe('plm-workbench write routes redact the provider error text (values-free)', () => {
  const app = express()
  app.use((req, _res, next) => {
    if (!req.headers.authorization) req.headers.authorization = LOGIN
    next()
  })
  app.use(express.json())
  app.use(plmWorkbenchRouter)

  let errorLog: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dsMocks.getDataSource.mockReset()
    dsMocks.assertAccess.mockReset()
    dispatchMocks.dispatchOperation.mockReset()
    pinned.setApp(app)
    // Record (and silence) server-side error logs: the original error must still land HERE.
    errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    beginDurableUnboundClassification(pgMocks.query, classificationCalls)
  })

  afterEach(() => {
    finishDurableUnboundClassification(classificationCalls, 'ds-1')
    vi.restoreAllMocks()
  })

  it('BOM write-back PATCH: the response never echoes the provider error message', async () => {
    dispatchMocks.dispatchOperation.mockRejectedValue(leakyError())
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest(
          { supported: true, api_version: 'v1', entitled: true },
          { bom_multitable_writeback: { supported: true, api_version: 'v1', entitled: true } },
        ),
      }),
      getBomMultitableContext: vi.fn(),
      updateBomMultitableLine: vi.fn(),
    })
    const res = await request(pinned.url())
      .patch(WRITE_URL)
      .set('Idempotency-Key', 'submit-1')
      .send({ quantity: 5 })
    expect(res.status).toBe(503)
    expect(res.body.reason).toBe('unknown')
    expectRedacted(res.body as Record<string, unknown>, PLM_BOM_WRITEBACK_FAILED_CODE, PLM_BOM_WRITEBACK_FAILED_MESSAGE)
    expectLoggedOriginalError(errorLog)
  })

  it('BOM write-back PATCH: a native lifecycle_locked 409 redacts detail.message', async () => {
    const conflict = new PlmPersonalBomWriteError(409, 'PLM_BOM_WRITE_PROVIDER', { code: 'lifecycle_locked', message: LEAKY }, true)
    dispatchMocks.dispatchOperation.mockRejectedValue(conflict)
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest(
          { supported: true, api_version: 'v1', entitled: true },
          { bom_multitable_writeback: { supported: true, api_version: 'v1', entitled: true } },
        ),
      }),
      getBomMultitableContext: vi.fn(),
      updateBomMultitableLine: vi.fn(),
    })
    const res = await request(pinned.url())
      .patch(WRITE_URL)
      .set('Idempotency-Key', 'submit-1')
      .send({ quantity: 5 })
    expect(res.status).toBe(409)
    expect(res.body.reason).toBe('lifecycle_locked')
    expectRedacted(res.body as Record<string, unknown>, PLM_BOM_WRITEBACK_FAILED_CODE, PLM_BOM_WRITEBACK_FAILED_MESSAGE)
    expect(errorLog).toHaveBeenCalledTimes(1)
    const logged = errorLog.mock.calls[0]?.[1] as PlmPersonalBomWriteError
    expect(logged.detail?.message).toBe(LEAKY)
    expect(logged.message).not.toBe(LEAKY)
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
      requestBomEcoRevisionIntent: vi.fn(),
    })
    dispatchMocks.dispatchOperation.mockRejectedValue(leakyError())
    const res = await request(pinned.url()).post(INTENT_URL).set('Idempotency-Key', 'eco-1')
    expect(res.status).toBe(503)
    expect(res.body.reason).toBe('unknown')
    expectRedacted(res.body as Record<string, unknown>, PLM_ECO_INTENT_FAILED_CODE, PLM_ECO_INTENT_FAILED_MESSAGE)
    expectLoggedOriginalError(errorLog)
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
