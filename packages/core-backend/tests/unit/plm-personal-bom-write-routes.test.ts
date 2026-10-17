import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '../../src/core/logger'
import { PlmPersonalBomWriteBindingService } from '../../src/services/PlmPersonalBomWriteBindingService'
import { bindPlmPersonalBomWriteService } from '../../src/services/plm-personal-bom-write-http'
import { PlmPersonalBomWriteError } from '../../src/services/plm-personal-bom-write-wire'
import { usePinnedServer } from '../utils/pinned-server'

const LOGIN = `Bearer ${jwt.sign({ userId: 'owner-1', email: 'o@x', role: 'user' }, 'synthetic-route-key')}`
const GRANT = `yuw_${'ab'.repeat(16)}_${'c'.repeat(43)}`
const BINDING_ID = '11111111-1111-4111-8111-111111111111'
const WRITE_URL = '/api/plm-workbench/data-sources/ds-1/bom-multitable/P1/lines/R1'
const INTENT_URL = '/api/plm-workbench/data-sources/ds-1/bom-multitable/P1/eco-intent'
const LINE_NATIVE = { ok: true, bom_line_id: 'R1' }
const ECO_NATIVE = { eco_id: 'ECO-1', state: 'progress', attached: false, source_version_id: 'v1', target_version_id: 'v2' }
const METADATA = {
  id: BINDING_ID,
  ownerId: 'owner-1',
  dataSourceId: 'ds-1',
  connectionId: 'conn-1',
  subjectId: 'subject-1',
  metaTenantId: 'tenant-a',
  targetOrigin: 'https://plm.example',
  yuantusTenantId: 'yt',
  yuantusOrgId: 'yo',
  workspaceId: null,
  scopeKind: 'private',
  grantId: 'ab'.repeat(16),
  generation: 2,
  expiresAt: '2026-12-01T00:00:00.000Z',
  bound: false,
  remoteRevokeState: 'pending',
  previousGrantRevokeState: 'unknown',
}

const dsMocks = vi.hoisted(() => ({ getDataSource: vi.fn(), assertAccess: vi.fn() }))
const pgMocks = vi.hoisted(() => ({ query: vi.fn() }))
const authRef = vi.hoisted(() => ({
  user: undefined as Record<string, unknown> | undefined,
  claim: undefined as { kind: string; value?: string } | undefined,
  tenant: undefined as string | undefined,
  apiTokenId: undefined as string | undefined,
  authorization: undefined as string | undefined,
}))
const holder = vi.hoisted(() => ({
  service: undefined as {
    list: (...args: unknown[]) => Promise<unknown>
    bind: (...args: unknown[]) => Promise<unknown>
    unbind: (...args: unknown[]) => Promise<unknown>
    managementUrl: (...args: unknown[]) => Promise<unknown>
    retryRetiredRevocations: (...args: unknown[]) => Promise<unknown>
  } | undefined,
}))

vi.mock('../../src/db/db', () => ({ db: {} }))
vi.mock('../../src/db/pg', () => ({ pool: {}, query: pgMocks.query }))
vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = authRef.user as never
    if (authRef.claim) req.verifiedTenantClaim = authRef.claim as never
    if (authRef.tenant) req.authenticatedTenantId = authRef.tenant
    if (authRef.apiTokenId) req.apiTokenId = authRef.apiTokenId
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
  getDataSourceManager: () => ({ getDataSource: dsMocks.getDataSource, assertAccess: dsMocks.assertAccess }),
}))

import plmWorkbenchRouter, {
  PLM_BOM_WRITEBACK_FAILED_MESSAGE,
  PLM_ECO_INTENT_FAILED_MESSAGE,
} from '../../src/routes/plm-workbench'
import { createPlmPersonalBomWriteBindingsRouter } from '../../src/routes/plm-personal-bom-write-bindings'

const ENTITLED = { supported: true, api_version: 'v1', entitled: true }
const pinned = usePinnedServer()

function writeSource() {
  const updateBomMultitableLine = vi.fn()
  const requestBomEcoRevisionIntent = vi.fn()
  dsMocks.getDataSource.mockReturnValue({
    getIntegrationCapabilities: vi.fn().mockResolvedValue({
      available: true,
      manifest: {
        schema_version: 'v1',
        provider: 'yuantus-plm',
        advisory: true,
        features: {
          bom_multitable: ENTITLED,
          bom_multitable_writeback: ENTITLED,
          bom_eco_revision: { ...ENTITLED, actions: ['eco_revision_intent'], action_status: 'governed' },
        },
      },
    }),
    getBomMultitableContext: vi.fn(),
    updateBomMultitableLine,
    requestBomEcoRevisionIntent,
  })
  return { updateBomMultitableLine, requestBomEcoRevisionIntent }
}

function scriptedPool(options: { orgs: boolean; binding: boolean }) {
  const sql: string[] = []
  const connect = vi.fn(async () => ({
    release: vi.fn(),
    query: vi.fn(async (text: string) => {
      sql.push(text)
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 }
      if (text.includes('FROM users')) return { rows: [{ id: 'owner-1' }], rowCount: 1 }
      if (text.includes('FROM user_orgs')) {
        return options.orgs ? { rows: [{ user_id: 'owner-1' }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (text.includes('FROM data_sources')) {
        return {
          rows: [{
            id: 'ds-1',
            owner_id: 'owner-1',
            workspace_id: null,
            tenant_id: 'tenant-a',
            scope_kind: 'private',
            type: 'plm',
            config: {},
            is_active: true,
            deleted_at: null,
          }],
          rowCount: 1,
        }
      }
      if (text.includes('plm_personal_bom_write_bindings')) return { rows: [], rowCount: options.binding ? 1 : 0 }
      throw new Error(`unexpected sql ${text}`)
    }),
  }))
  return { connect, sql }
}

function installReal(pool: { connect: ReturnType<typeof vi.fn> }, provider = vi.fn()) {
  const service = new PlmPersonalBomWriteBindingService(pool as never, provider as never)
  holder.service = service
  bindPlmPersonalBomWriteService(service)
  return { service, provider }
}

describe('personal BOM write routes and owner binding management', () => {
  const dispatchOperation = vi.fn()
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    if (authRef.apiTokenId) req.apiTokenId = authRef.apiTokenId
    if (authRef.authorization === '') delete req.headers.authorization
    else if (!req.headers.authorization) req.headers.authorization = LOGIN
    next()
  })
  app.use(plmWorkbenchRouter)
  app.use('/api/me/plm-bom-write-bindings', createPlmPersonalBomWriteBindingsRouter({
    list: (...args) => holder.service!.list(...args),
    bind: (...args) => holder.service!.bind(...args),
    unbind: (...args) => holder.service!.unbind(...args),
    managementUrl: (...args) => holder.service!.managementUrl(...args),
    retryRetiredRevocations: (...args) => holder.service!.retryRetiredRevocations(...args),
  } as never))

  let priorFlag: string | undefined
  let errorLog: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    priorFlag = process.env.PLM_PERSONAL_BOM_WRITE_ENABLED
    delete process.env.PLM_PERSONAL_BOM_WRITE_ENABLED
    authRef.user = { id: 'owner-1', tenantId: 'header-tenant-not-authority', role: 'admin' }
    authRef.claim = { kind: 'present', value: 'tenant-a' }
    authRef.tenant = 'tenant-a'
    authRef.apiTokenId = undefined
    authRef.authorization = undefined
    dsMocks.getDataSource.mockReset()
    dsMocks.assertAccess.mockReset()
    pgMocks.query.mockReset()
    pgMocks.query.mockResolvedValue({ rows: [], rowCount: 1 })
    dispatchOperation.mockReset()
    dispatchOperation.mockResolvedValue({ native: LINE_NATIVE })
    bindPlmPersonalBomWriteService({ dispatchOperation } as never)
    holder.service = {
      list: vi.fn(async () => [METADATA]),
      bind: vi.fn(async () => METADATA),
      unbind: vi.fn(async () => METADATA),
      managementUrl: vi.fn(async () => 'https://plm.example/personal-approval-grants#bom-write'),
      retryRetiredRevocations: vi.fn(async () => undefined),
    }
    errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    pinned.setApp(app)
  })

  afterEach(() => {
    if (priorFlag === undefined) delete process.env.PLM_PERSONAL_BOM_WRITE_ENABLED
    else process.env.PLM_PERSONAL_BOM_WRITE_ENABLED = priorFlag
    bindPlmPersonalBomWriteService(undefined)
    errorLog.mockRestore()
  })

  it('dispatches both writes for the owner and ignores the header tenant and admin role', async () => {
    const adapter = writeSource()
    const line = await request(pinned.url()).patch(WRITE_URL).set('Idempotency-Key', 'submit-1').set('x-tenant-id', 'forged-header').send({ quantity: 5 })
    dispatchOperation.mockResolvedValueOnce({ native: ECO_NATIVE })
    const eco = await request(pinned.url()).post(INTENT_URL).set('Idempotency-Key', 'eco-1').set('If-Match', '"etag"').send({ bomLineId: 'nope', patch: { quantity: 9 } })
    expect(line.status).toBe(200)
    expect(line.body).toEqual(LINE_NATIVE)
    expect(eco.status).toBe(200)
    expect(eco.body).toEqual(ECO_NATIVE)
    expect(dispatchOperation).toHaveBeenNthCalledWith(
      1,
      { userId: 'owner-1', metaTenantId: 'tenant-a' },
      'ds-1',
      { operationKind: 'line', partId: 'P1', bomLineId: 'R1', clientKey: 'submit-1', patch: { quantity: 5 } },
    )
    expect(dispatchOperation).toHaveBeenNthCalledWith(
      2,
      { userId: 'owner-1', metaTenantId: 'tenant-a' },
      'ds-1',
      { operationKind: 'eco-intent', partId: 'P1', clientKey: 'eco-1' },
    )
    expect(adapter.updateBomMultitableLine).not.toHaveBeenCalled()
    expect(adapter.requestBomEcoRevisionIntent).not.toHaveBeenCalled()
  })

  it.each([
    ['line', 403, 'patch' as const, WRITE_URL, 'PLM_BOM_WRITEBACK_FAILED', PLM_BOM_WRITEBACK_FAILED_MESSAGE],
    ['eco-intent', 403, 'post' as const, INTENT_URL, 'PLM_ECO_INTENT_FAILED', PLM_ECO_INTENT_FAILED_MESSAGE],
    ['line', 401, 'patch' as const, WRITE_URL, 'PLM_BOM_WRITEBACK_FAILED', PLM_BOM_WRITEBACK_FAILED_MESSAGE],
    ['eco-intent', 401, 'post' as const, INTENT_URL, 'PLM_ECO_INTENT_FAILED', PLM_ECO_INTENT_FAILED_MESSAGE],
  ])('native refusal on %s (%s) keeps provider-rejected and marks the operation as possibly applied', async (_kind, status, method, url, code, message) => {
    const adapter = writeSource()
    dispatchOperation.mockRejectedValueOnce(
      new PlmPersonalBomWriteError(status, status === 401 ? 'PLM_BOM_WRITE_UNAUTHORIZED' : 'PLM_BOM_WRITE_FORBIDDEN', { message: 'native applied already' }, true),
    )
    const native = method === 'patch'
      ? await request(pinned.url()).patch(url).set('Idempotency-Key', 'submit-1').send({ quantity: 5 })
      : await request(pinned.url()).post(url).set('Idempotency-Key', 'eco-1')
    expect(native.status).toBe(status)
    expect(native.body).toEqual({
      error: message,
      code,
      data_source_id: 'ds-1',
      reason: 'provider-rejected',
      attempt_outcome: 'refused',
      operation_may_have_applied: true,
      retry_policy: 'same-operation',
    })
    expect(JSON.stringify(native.body)).not.toContain('native applied')
    expect(native.body).not.toHaveProperty('native')
    expect(adapter.updateBomMultitableLine).not.toHaveBeenCalled()
    expect(adapter.requestBomEcoRevisionIntent).not.toHaveBeenCalled()

    dispatchOperation.mockRejectedValueOnce(new PlmPersonalBomWriteError(403, 'PLM_BOM_WRITE_FORBIDDEN'))
    const local = method === 'patch'
      ? await request(pinned.url()).patch(url).set('Idempotency-Key', 'submit-2').send({ quantity: 5 })
      : await request(pinned.url()).post(url).set('Idempotency-Key', 'eco-2')
    expect(local.status).toBe(403)
    expect(local.body.reason).toBe('PLM_BOM_WRITE_FORBIDDEN')
    expect(local.body.attempt_outcome).toBeUndefined()
    expect(local.body.operation_may_have_applied).toBeUndefined()
    expect(local.body.retry_policy).toBeUndefined()
  })

  it.each([undefined, '', 'false', 'TRUE', '1', 'yes'])('flag %s refuses both writes before any wire', async (flag) => {
    if (flag === undefined) delete process.env.PLM_PERSONAL_BOM_WRITE_ENABLED
    else process.env.PLM_PERSONAL_BOM_WRITE_ENABLED = flag
    const connect = vi.fn(async () => { throw new Error('connect must not run') })
    const provider = vi.fn(() => { throw new Error('provider must not run') })
    installReal({ connect }, provider)
    const adapter = writeSource()
    const line = await request(pinned.url()).patch(WRITE_URL).set('Idempotency-Key', 'submit-1').send({ quantity: 5 })
    const eco = await request(pinned.url()).post(INTENT_URL).set('Idempotency-Key', 'eco-1')
    for (const res of [line, eco]) {
      expect(res.status).toBe(404)
      expect(res.body.code).toBe('PLM_BOM_WRITE_DISABLED')
      expect(res.body.reason).toBe('PLM_BOM_WRITE_DISABLED')
    }
    expect(connect).not.toHaveBeenCalled()
    expect(provider).not.toHaveBeenCalled()
    expect(adapter.updateBomMultitableLine).not.toHaveBeenCalled()
    expect(adapter.requestBomEcoRevisionIntent).not.toHaveBeenCalled()
    expect(pgMocks.query).toHaveBeenCalled()
  })

  it('literal true reaches dispatch and still does not call the shared adapter', async () => {
    process.env.PLM_PERSONAL_BOM_WRITE_ENABLED = 'true'
    const adapter = writeSource()
    const res = await request(pinned.url()).patch(WRITE_URL).set('Idempotency-Key', 'submit-1').send({ quantity: 5 })
    expect(res.status).toBe(200)
    expect(dispatchOperation).toHaveBeenCalledTimes(1)
    expect(adapter.updateBomMultitableLine).not.toHaveBeenCalled()
  })

  it('missing binding and lost membership do not call the provider', async () => {
    process.env.PLM_PERSONAL_BOM_WRITE_ENABLED = 'true'
    const adapter = writeSource()
    const missing = scriptedPool({ orgs: true, binding: false })
    const provider = vi.fn(() => { throw new Error('provider must not run') })
    installReal(missing, provider)
    const noBinding = await request(pinned.url()).patch(WRITE_URL).set('Idempotency-Key', 'submit-1').send({ quantity: 5 })
    expect(noBinding.status).toBe(404)
    expect(noBinding.body.code).toBe('PLM_BOM_WRITE_NOT_FOUND')
    expect(missing.sql.some((sql) => sql.includes('plm_personal_bom_write_bindings'))).toBe(true)
    expect(provider).not.toHaveBeenCalled()
    expect(adapter.updateBomMultitableLine).not.toHaveBeenCalled()

    const denied = scriptedPool({ orgs: false, binding: false })
    installReal(denied, provider)
    const membership = await request(pinned.url()).post(INTENT_URL).set('Idempotency-Key', 'eco-1')
    expect(membership.status).toBe(403)
    expect(membership.body.code).toBe('PLM_BOM_WRITE_FORBIDDEN')
    expect(denied.sql.some((sql) => sql.includes('FROM user_orgs'))).toBe(true)
    expect(denied.sql.some((sql) => sql.includes('FROM data_sources'))).toBe(false)
    expect(provider).not.toHaveBeenCalled()
    expect(adapter.requestBomEcoRevisionIntent).not.toHaveBeenCalled()
  })

  it('attempt audit failure dispatches zero times', async () => {
    pgMocks.query.mockRejectedValue(new Error('audit down'))
    writeSource()
    const res = await request(pinned.url()).patch(WRITE_URL).set('Idempotency-Key', 'submit-1').send({ quantity: 5 })
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('PLM_WRITEBACK_AUDIT_UNAVAILABLE')
    expect(dispatchOperation).not.toHaveBeenCalled()
  })

  it('outcome audit failure keeps the committed native success', async () => {
    pgMocks.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }).mockRejectedValueOnce(new Error('audit lost'))
    writeSource()
    const res = await request(pinned.url()).patch(WRITE_URL).set('Idempotency-Key', 'submit-1').send({ quantity: 5 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual(LINE_NATIVE)
    expect(dispatchOperation).toHaveBeenCalledTimes(1)
  })

  it('distinguishes a local frozen 409 from native 409 and 412', async () => {
    writeSource()
    dispatchOperation.mockRejectedValueOnce(
      new PlmPersonalBomWriteError(409, 'PLM_BOM_WRITE_CONFLICT', { code: 'lifecycle_locked' }, false),
    )
    const local = await request(pinned.url()).patch(WRITE_URL).set('Idempotency-Key', 'submit-1').send({ quantity: 5 })
    expect(local.status).toBe(409)
    expect(local.body.reason).toBe('frozen-context')
    expect(local.body.code).toBe('PLM_BOM_WRITE_CONFLICT')
    expect(JSON.stringify(local.body)).not.toContain('lifecycle_locked')

    dispatchOperation.mockRejectedValueOnce(
      new PlmPersonalBomWriteError(409, 'PLM_BOM_WRITE_PROVIDER', { code: 'lifecycle_locked', message: 'locked text' }, true),
    )
    const native = await request(pinned.url()).patch(WRITE_URL).set('Idempotency-Key', 'submit-2').send({ quantity: 5 })
    expect(native.status).toBe(409)
    expect(native.body.reason).toBe('lifecycle_locked')
    expect(native.body.code).toBe('PLM_BOM_WRITEBACK_FAILED')
    expect(JSON.stringify(native.body)).not.toContain('locked text')

    dispatchOperation.mockRejectedValueOnce(new PlmPersonalBomWriteError(412, 'PLM_BOM_WRITE_PROVIDER', undefined, true))
    const precondition = await request(pinned.url()).patch(WRITE_URL).set('Idempotency-Key', 'submit-3').set('If-Match', '"etag"').send({ quantity: 5 })
    expect(precondition.status).toBe(412)
    expect(precondition.body.reason).toBe('precondition-failed')
    expect(precondition.body.code).toBe('PLM_BOM_WRITEBACK_FAILED')

    dispatchOperation.mockRejectedValueOnce(
      new PlmPersonalBomWriteError(409, 'PLM_BOM_WRITE_PROVIDER', { code: 'not_locked' }, true),
    )
    const eco = await request(pinned.url()).post(INTENT_URL).set('Idempotency-Key', 'eco-1')
    expect(eco.status).toBe(409)
    expect(eco.body.reason).toBe('not_locked')
    expect(eco.body.code).toBe('PLM_ECO_INTENT_FAILED')

    dispatchOperation.mockRejectedValueOnce(
      new PlmPersonalBomWriteError(412, 'PLM_BOM_WRITE_PROVIDER', { message: 'stale body' }, true),
    )
    const ecoPrecondition = await request(pinned.url()).post(INTENT_URL).set('Idempotency-Key', 'eco-2')
    expect(ecoPrecondition.status).toBe(412)
    expect(ecoPrecondition.body.reason).toBe('precondition-failed')
    expect(JSON.stringify(ecoPrecondition.body)).not.toContain('stale body')
  })

  it('uses explicit null only for an absent verified claim', async () => {
    writeSource()
    authRef.claim = { kind: 'absent' }
    authRef.tenant = undefined
    authRef.user = { id: 'owner-1', tenantId: 'forged-header', role: 'admin' }
    const res = await request(pinned.url()).patch(WRITE_URL).set('Idempotency-Key', 'submit-1').set('x-tenant-id', 'forged-header').send({ quantity: 5 })
    expect(res.status).toBe(200)
    expect(dispatchOperation).toHaveBeenCalledWith(
      { userId: 'owner-1', metaTenantId: null },
      'ds-1',
      expect.objectContaining({ operationKind: 'line', clientKey: 'submit-1' }),
    )
  })

  it.each(['rejected', 'blank', 'malformed'] as const)('a %s claim does not write or list legacy rows', async (kind) => {
    writeSource()
    authRef.claim = { kind }
    const write = await request(pinned.url()).patch(WRITE_URL).set('Idempotency-Key', 'submit-1').send({ quantity: 5 })
    expect(write.status).toBe(403)
    expect(write.body.code).toBe('PLM_BOM_WRITE_FORBIDDEN')
    expect(dispatchOperation).not.toHaveBeenCalled()
    expect(pgMocks.query).not.toHaveBeenCalled()
    const listed = await request(pinned.url()).get('/api/me/plm-bom-write-bindings')
    expect(listed.status).toBe(403)
    expect(holder.service!.list).not.toHaveBeenCalled()
  })

  it('keeps unbind and retired retry available after flag disable and membership loss', async () => {
    delete process.env.PLM_PERSONAL_BOM_WRITE_ENABLED
    authRef.claim = { kind: 'rejected' }
    const removed = await request(pinned.url()).delete(`/api/me/plm-bom-write-bindings/${BINDING_ID}`)
    const retried = await request(pinned.url()).post('/api/me/plm-bom-write-bindings/retired-revocations/retry').send({})
    expect(removed.status).toBe(200)
    expect(removed.body.data.remoteRevokeState).toBe('pending')
    expect(removed.body.data.previousGrantRevokeState).toBe('unknown')
    expect(JSON.stringify(removed.body)).not.toContain('revoked')
    expect(holder.service!.unbind).toHaveBeenCalledWith('owner-1', BINDING_ID)
    expect(retried.status).toBe(200)
    expect(holder.service!.retryRetiredRevocations).toHaveBeenCalledWith('owner-1')
    expect(removed.headers['cache-control']).toBe('no-store')
  })

  it('does not accept caller owner, origin, or grant echoes', async () => {
    const bound = await request(pinned.url()).post('/api/me/plm-bom-write-bindings').send({
      dataSourceId: 'ds-1',
      connectionId: 'conn-1',
      grant: GRANT,
      ownerId: 'intruder',
      origin: 'https://evil.example',
    })
    expect(bound.status).toBe(422)
    expect(bound.body).toEqual({ ok: false, error: { code: 'PLM_BOM_WRITE_INVALID' } })
    expect(JSON.stringify(bound.body)).not.toContain(GRANT)
    expect(holder.service!.bind).not.toHaveBeenCalled()

    const url = await request(pinned.url()).get('/api/me/plm-bom-write-bindings/management-url').query({
      dataSourceId: 'ds-1',
      origin: 'https://evil.example',
      ownerId: 'intruder',
    })
    expect(url.status).toBe(200)
    expect(holder.service!.managementUrl).toHaveBeenCalledWith(
      { userId: 'owner-1', metaTenantId: 'tenant-a' },
      'ds-1',
    )

    const retry = await request(pinned.url()).post('/api/me/plm-bom-write-bindings/retired-revocations/retry').send({ grant: GRANT })
    expect(retry.status).toBe(422)
    expect(JSON.stringify(retry.body)).not.toContain(GRANT)
    expect(holder.service!.retryRetiredRevocations).not.toHaveBeenCalled()
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(GRANT)
    expect(JSON.stringify(pgMocks.query.mock.calls)).not.toContain(GRANT)
  })

  it('returns safe bind metadata and lets an admin through without a data_sources permission', async () => {
    const created = await request(pinned.url()).post('/api/me/plm-bom-write-bindings').send({
      dataSourceId: 'ds-1',
      connectionId: 'conn-1',
      grant: GRANT,
    })
    expect(created.status).toBe(201)
    expect(created.body.data).toEqual(METADATA)
    expect(JSON.stringify(created.body)).not.toContain(GRANT)
    expect(JSON.stringify(created.body)).not.toContain('encrypted_grant')
    authRef.user = { id: 'admin-1', role: 'admin', tenantId: 'header-tenant-not-authority' }
    const listed = await request(pinned.url()).get('/api/me/plm-bom-write-bindings')
    expect(listed.status).toBe(200)
    expect(holder.service!.list).toHaveBeenCalledWith({ userId: 'admin-1', metaTenantId: 'tenant-a' })
  })

  it('rejects API and purpose credentials before personal management or write', async () => {
    writeSource()
    authRef.authorization = ''
    const missing = await request(pinned.url()).patch(WRITE_URL).set('Idempotency-Key', 'submit-1').send({ quantity: 5 })
    expect(missing.status).toBe(401)
    expect(dispatchOperation).not.toHaveBeenCalled()

    authRef.authorization = undefined
    authRef.apiTokenId = 'tok-1'
    const token = await request(pinned.url()).get('/api/me/plm-bom-write-bindings').set('Authorization', LOGIN)
    expect(token.status).toBe(401)
    expect(token.headers['cache-control']).toBe('no-store')
    expect(holder.service!.list).not.toHaveBeenCalled()

    authRef.apiTokenId = undefined
    const purpose = `Bearer ${jwt.sign({ userId: 'owner-1', email: 'o@x', role: 'user', aud: 'api' }, 'synthetic-route-key')}`
    const purposeRes = await request(pinned.url()).post(INTENT_URL).set('Authorization', purpose).set('Idempotency-Key', 'eco-1')
    expect(purposeRes.status).toBe(401)
    expect(dispatchOperation).not.toHaveBeenCalled()
  })

  it('flag-off management URL and bind do not connect, and current membership is still required', async () => {
    const connect = vi.fn(async () => { throw new Error('connect must not run') })
    const provider = vi.fn(() => { throw new Error('provider must not run') })
    installReal({ connect }, provider)
    const url = await request(pinned.url()).get('/api/me/plm-bom-write-bindings/management-url').query({ dataSourceId: 'ds-1' })
    const bound = await request(pinned.url()).post('/api/me/plm-bom-write-bindings').send({
      dataSourceId: 'ds-1',
      connectionId: 'conn-1',
      grant: GRANT,
    })
    expect(url.status).toBe(404)
    expect(url.body.error.code).toBe('PLM_BOM_WRITE_DISABLED')
    expect(bound.status).toBe(404)
    expect(JSON.stringify(bound.body)).not.toContain(GRANT)
    expect(connect).not.toHaveBeenCalled()
    expect(provider).not.toHaveBeenCalled()

    process.env.PLM_PERSONAL_BOM_WRITE_ENABLED = 'true'
    const denied = scriptedPool({ orgs: false, binding: false })
    installReal(denied, provider)
    const membership = await request(pinned.url()).get('/api/me/plm-bom-write-bindings/management-url').query({ dataSourceId: 'ds-1' })
    expect(membership.status).toBe(403)
    expect(membership.body.error.code).toBe('PLM_BOM_WRITE_FORBIDDEN')
    expect(denied.sql.some((sql) => sql.includes('FROM user_orgs'))).toBe(true)
    expect(provider).not.toHaveBeenCalled()
  })
})
