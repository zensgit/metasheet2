/**
 * C1/S2 first slice — the HTTP boundary of the synthetic integration preview (routes/automation.ts):
 *   POST /api/multitable/sheets/:sheetId/automations/:ruleId/integration-preview
 *   GET  /api/multitable/sheets/:sheetId/automations/integration-preview/catalog
 * Pinned: Cache-Control no-store on every answer; canManageAutomation on the PATH sheet first (403, nothing
 * else runs); liveness; the switch (fixed 404 before any catalog or service call); the verified tenant claim
 * only (x-tenant-id and the body cannot set it; a tenantless token is refused); the body is handed to the
 * runtime's strict DTO unchanged; refusals are fixed codes; the four authority flags are host constants.
 */
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAutomationRoutes } from '../../src/routes/automation'
import { SyntheticPreviewError } from '../../src/integration/automation-synthetic-preview'
import { usePinnedServer } from '../utils/pinned-server'

const resolveSheetCapabilities = vi.hoisted(() => vi.fn())
vi.mock('../../src/multitable/permission-service', () => ({ resolveSheetCapabilities }))
vi.mock('../../src/integration/db/connection-pool', () => {
  const client = { query: vi.fn(), getInternalPool: () => null }
  return { poolManager: { get: () => client } }
})
vi.mock('../../src/guards/audit-integration', () => ({
  requireAdminRole: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}))

const PATH = '/api/multitable/sheets/sheet_a/automations/rule_a/integration-preview'
const CATALOG = '/api/multitable/sheets/sheet_a/automations/integration-preview/catalog'
const BODY = { planId: 'plm-material-to-yida-preview.v1', fixtureId: 'synthetic-materials.two-page.v1', mappingPresetId: 'yida-material-v3.original.v1' }
const AUTHORIZED = { capabilities: { canManageAutomation: true }, sheetLiveness: 'live' }

let enabled = true
const previewIntegrationPlan = vi.fn()
const service = {
  syntheticIntegrationPreviewEnabled: () => enabled,
  previewIntegrationPlan,
}

function buildApp(user: Record<string, unknown> | null, tenant?: string) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    if (user) (req as unknown as { user: unknown }).user = user
    if (tenant !== undefined) (req as unknown as { authenticatedTenantId: string }).authenticatedTenantId = tenant
    next()
  })
  app.use('/api/multitable', createAutomationRoutes(service as never))
  return app
}

const pinned = usePinnedServer()

describe('integration preview route', () => {
  beforeEach(() => {
    enabled = true
    resolveSheetCapabilities.mockReset()
    resolveSheetCapabilities.mockResolvedValue(AUTHORIZED)
    previewIntegrationPlan.mockReset()
    previewIntegrationPlan.mockResolvedValue({
      ok: true, synthetic: true, summary: { outcome: 'OK' }, preview: { rowCount: 1, rows: [] },
      canSend: true, canApply: true, tokenIssued: true, externalWriteAttempted: true, extra: 'forged',
    })
    pinned.setApp(buildApp({ id: 'actor_1' }, 'tenant_1'))
  })

  it('403s a caller without canManageAutomation on the path sheet, with no-store, before the switch or the service', async () => {
    resolveSheetCapabilities.mockResolvedValue({ capabilities: { canManageAutomation: false }, sheetLiveness: 'live' })
    enabled = false
    const res = await request(pinned.url()).post(PATH).send(BODY)
    expect(res.status).toBe(403)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(previewIntegrationPlan).not.toHaveBeenCalled()
  })

  it('404s a sheet that is not live', async () => {
    resolveSheetCapabilities.mockResolvedValue({ capabilities: { canManageAutomation: true }, sheetLiveness: 'deleted' })
    const res = await request(pinned.url()).post(PATH).send(BODY)
    expect(res.status).toBe(404)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(previewIntegrationPlan).not.toHaveBeenCalled()
  })

  it('a permission-resolution failure is a fixed 503, never a fall-through', async () => {
    resolveSheetCapabilities.mockRejectedValue(new Error('connect ECONNREFUSED SYN-HOST:1 SYN-SECRET'))
    const res = await request(pinned.url()).post(PATH).send(BODY)
    expect(res.status).toBe(503)
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|SYN-HOST|SYN-SECRET/)
    expect(previewIntegrationPlan).not.toHaveBeenCalled()
  })

  it('G01: switch OFF is a fixed 404 for both the preview and the catalog, before the service', async () => {
    enabled = false
    const post = await request(pinned.url()).post(PATH).send(BODY)
    expect(post.status).toBe(404)
    expect(post.body.error.code).toBe('INTEGRATION_PREVIEW_DISABLED')
    expect(post.headers['cache-control']).toBe('no-store')
    const get = await request(pinned.url()).get(CATALOG)
    expect(get.status).toBe(404)
    expect(get.body).not.toHaveProperty('catalog')
    expect(previewIntegrationPlan).not.toHaveBeenCalled()
  })

  it('switch ON: the catalog lists fixed ids only', async () => {
    const res = await request(pinned.url()).get(CATALOG)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body.catalog.fixtureIds).toEqual(['synthetic-materials.two-page.v1', 'synthetic-materials.single-page.v1'])
    expect(JSON.stringify(res.body)).not.toMatch(/SYN-DRW|rows/)
  })

  it('C03: the tenant comes only from the verified claim; x-tenant-id and body fields cannot set it', async () => {
    const res = await request(pinned.url()).post(PATH).set('x-tenant-id', 'forged_tenant').send(BODY)
    expect(res.status).toBe(200)
    expect(previewIntegrationPlan).toHaveBeenCalledTimes(1)
    const [scope, body, options] = previewIntegrationPlan.mock.calls[0]
    expect(scope).toEqual({ actorId: 'actor_1', tenantId: 'tenant_1', sheetId: 'sheet_a', ruleId: 'rule_a' })
    expect(body).toEqual(BODY)
    expect(options.signal).toBeInstanceOf(AbortSignal)
  })

  it('C03: a tenantless or anonymous request is refused before the service', async () => {
    pinned.setApp(buildApp({ id: 'actor_1' }))
    expect((await request(pinned.url()).post(PATH).set('x-tenant-id', 'tenant_1').send(BODY)).status).toBe(403)
    pinned.setApp(buildApp(null, 'tenant_1'))
    expect((await request(pinned.url()).post(PATH).send(BODY)).status).toBe(403)
    expect(previewIntegrationPlan).not.toHaveBeenCalled()
  })

  it('success: no-store, and the four authority flags are host constants even if the runtime object said otherwise', async () => {
    const res = await request(pinned.url()).post(PATH).send(BODY)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toEqual({
      ok: true, synthetic: true, summary: { outcome: 'OK' }, preview: { rowCount: 1, rows: [] },
      canSend: false, canApply: false, tokenIssued: false, externalWriteAttempted: false,
    })
  })

  it.each([
    ['INPUT', 400], ['DISABLED', 404], ['DENIED', 403], ['NOT_FOUND', 404], ['LIMIT', 422], ['REJECTED', 422],
    ['CANCELLED', 409], ['TIMEOUT', 504], ['INACTIVE', 503], ['UNAVAILABLE', 503],
  ] as const)('runtime %s -> %i with a fixed body and no-store', async (code, status) => {
    previewIntegrationPlan.mockRejectedValue(new SyntheticPreviewError(code))
    const res = await request(pinned.url()).post(PATH).send(BODY)
    expect(res.status).toBe(status)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body.error.code).toBe(`INTEGRATION_PREVIEW_${code}`)
  })

  it('a foreign error (even one that looks like a preview error) is a fixed 503 without its text', async () => {
    const forged = Object.assign(new Error('AUTOMATION_INTEGRATION_PREVIEW_DENIED SYN-SENTINEL'), { code: 'AUTOMATION_INTEGRATION_PREVIEW_DENIED' })
    previewIntegrationPlan.mockRejectedValue(forged)
    const res = await request(pinned.url()).post(PATH).send(BODY)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('INTEGRATION_PREVIEW_UNAVAILABLE')
    expect(JSON.stringify(res.body)).not.toContain('SYN-SENTINEL')
  })
})
