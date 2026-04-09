import express from 'express'
import request from 'supertest'
import { Injector } from '@wendellhu/redi'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const rbacMocks = vi.hoisted(() => ({
  isAdmin: vi.fn(),
  userHasPermission: vi.fn(),
  listUserPermissions: vi.fn(),
  invalidateUserPerms: vi.fn(),
  getPermCacheStatus: vi.fn(),
}))

const auditMocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
}))

vi.mock('../../src/rbac/service', () => ({
  isAdmin: rbacMocks.isAdmin,
  userHasPermission: rbacMocks.userHasPermission,
  listUserPermissions: rbacMocks.listUserPermissions,
  invalidateUserPerms: rbacMocks.invalidateUserPerms,
  getPermCacheStatus: rbacMocks.getPermCacheStatus,
}))

vi.mock('../../src/audit/audit', () => ({
  auditLog: auditMocks.auditLog,
}))

import { federationRouter } from '../../src/routes/federation'
import { createContainer } from '../../src/di/container'
import { IAthenaAdapter, IConfigService, IPLMAdapter } from '../../src/di/identifiers'
import { plmContractFixtures, athenaContractFixtures } from '../fixtures/federation/contracts'

type RuntimeStatus = {
  implementation?: 'stub'
  configured?: boolean
  healthSupported?: boolean
  supportedOperations?: string[]
}

function createConfigServiceMock() {
  return {
    get: vi.fn(),
    set: vi.fn(),
    getAll: vi.fn(),
    reload: vi.fn(),
    validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
  }
}

function createPlmAdapterMock(runtimeStatus: RuntimeStatus = {}) {
  let connected = true

  return {
    isConnected: vi.fn(() => connected),
    connect: vi.fn(async () => { connected = true }),
    disconnect: vi.fn(async () => { connected = false }),
    healthCheck: vi.fn(async () => true),
    getRuntimeStatus: vi.fn(() => ({
      configured: runtimeStatus.configured ?? true,
      healthSupported: runtimeStatus.healthSupported ?? true,
      supportedOperations: runtimeStatus.supportedOperations ?? ['products', 'bom', 'approvals', 'approval_history', 'bom_compare', 'substitutes_add', 'details'],
      ...(runtimeStatus.implementation ? { implementation: runtimeStatus.implementation } : {}),
    })),
    getProducts: vi.fn(async () => ({
      data: plmContractFixtures.products,
      metadata: { totalCount: plmContractFixtures.products.length },
    })),
    getProductBOM: vi.fn(async () => ({
      data: plmContractFixtures.bom,
      metadata: { totalCount: plmContractFixtures.bom.length },
    })),
    getProductById: vi.fn(async () => plmContractFixtures.productDetail),
    getApprovalHistory: vi.fn(async () => ({
      data: plmContractFixtures.approvalHistory,
      metadata: { totalCount: plmContractFixtures.approvalHistory.length },
    })),
    getBomCompare: vi.fn(async () => ({
      data: [plmContractFixtures.bomCompare],
      metadata: { totalCount: 1 },
    })),
    addBomSubstitute: vi.fn(async () => ({
      data: [plmContractFixtures.substituteAdded],
      metadata: { totalCount: 1 },
    })),
    rejectApproval: vi.fn(async (approvalId: string, comment: string) => ({
      data: [{ id: approvalId, comment }],
      metadata: { totalCount: 1 },
    })),
  }
}

function createAthenaAdapterMock(runtimeStatus: RuntimeStatus = {}) {
  let connected = true

  return {
    isConnected: vi.fn(() => connected),
    connect: vi.fn(async () => { connected = true }),
    disconnect: vi.fn(async () => { connected = false }),
    healthCheck: vi.fn(async () => true),
    getRuntimeStatus: vi.fn(() => ({
      configured: runtimeStatus.configured ?? true,
      healthSupported: runtimeStatus.healthSupported ?? true,
      supportedOperations: runtimeStatus.supportedOperations ?? ['documents', 'search', 'versions'],
      ...(runtimeStatus.implementation ? { implementation: runtimeStatus.implementation } : {}),
    })),
    searchDocuments: vi.fn(async () => ({
      data: athenaContractFixtures.documents,
      metadata: { totalCount: athenaContractFixtures.documents.length },
    })),
    getDocument: vi.fn(async () => athenaContractFixtures.documentDetail),
    getVersionHistory: vi.fn(async () => ({
      data: [
        {
          version: 'A',
          created_at: '2026-03-01T00:00:00.000Z',
          created_by: 'user-1',
        },
      ],
      metadata: { totalCount: 1 },
    })),
  }
}

function createFederationApp(options: {
  plmAdapter?: any
  athenaAdapter?: any
} = {}) {
  const injector = new Injector()
  injector.add([IPLMAdapter, { useValue: options.plmAdapter ?? null }])
  injector.add([IAthenaAdapter, { useValue: options.athenaAdapter ?? null }])
  injector.add([IConfigService, { useValue: createConfigServiceMock() }])

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = {
      id: 'user-1',
      roles: ['admin'],
      perms: ['federation:read', 'federation:write'],
    }
    next()
  })
  app.use(federationRouter(injector))

  return app
}

describe('Federation contract routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    rbacMocks.isAdmin.mockResolvedValue(true)
    rbacMocks.userHasPermission.mockResolvedValue(true)
    rbacMocks.listUserPermissions.mockResolvedValue(['federation:read', 'federation:write'])
    auditMocks.auditLog.mockResolvedValue(undefined)
  })

  it('reports runtime adapter capability visibility via integration status', async () => {
    const app = createFederationApp({
      plmAdapter: createPlmAdapterMock(),
      athenaAdapter: createAthenaAdapterMock({
        implementation: 'stub',
        configured: false,
        supportedOperations: ['documents', 'search'],
      }),
    })

    const response = await request(app)
      .get('/api/federation/integration-status')
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.total).toBe(2)
    expect(response.body.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'plm',
          implementation: 'real',
          configured: true,
          connected: true,
        }),
        expect.objectContaining({
          id: 'athena',
          implementation: 'stub',
          configured: false,
          connected: true,
          supportedOperations: ['documents', 'search'],
        }),
      ]),
    )
  })

  it('exposes explicit stub runtime status for default container adapters', () => {
    const injector = createContainer()
    const athenaAdapter = injector.get(IAthenaAdapter) as {
      isConnected: () => boolean
      getRuntimeStatus: () => {
        implementation: string
        configured: boolean
        supportedOperations: string[]
      }
    }

    expect(athenaAdapter.isConnected()).toBe(false)
    expect(athenaAdapter.getRuntimeStatus()).toMatchObject({
      implementation: 'stub',
      configured: false,
      supportedOperations: ['documents', 'search', 'preview', 'versions', 'workflow', 'collaboration'],
    })
  })

  it('supports PLM query contracts for products, approval history, and BOM compare', async () => {
    const plmAdapter = createPlmAdapterMock()
    const app = createFederationApp({ plmAdapter })

    const productsResponse = await request(app)
      .post('/api/federation/plm/query')
      .send({
        operation: 'products',
        pagination: { limit: 25, offset: 10 },
        filters: { search: 'servo', status: 'released', itemType: 'Part' },
      })
      .expect(200)

    expect(plmAdapter.getProducts).toHaveBeenCalledWith({
      limit: 25,
      offset: 10,
      status: 'released',
      search: 'servo',
      itemType: 'Part',
    })
    expect(productsResponse.body.data).toEqual({
      items: [
        expect.objectContaining({
          id: 'prod-1001',
          partNumber: 'PN-1001',
          revision: 'B',
        }),
      ],
      total: 1,
      limit: 25,
      offset: 10,
    })

    const approvalHistoryResponse = await request(app)
      .post('/api/federation/plm/query')
      .send({
        operation: 'approval_history',
        filters: { ecoId: 'eco-1' },
      })
      .expect(200)

    expect(plmAdapter.getApprovalHistory).toHaveBeenCalledWith('eco-1')
    expect(approvalHistoryResponse.body.data).toEqual({
      approvalId: 'eco-1',
      items: plmContractFixtures.approvalHistory,
      total: 1,
    })

    const bomCompareResponse = await request(app)
      .post('/api/federation/plm/query')
      .send({
        operation: 'bom_compare',
        leftId: 'left-1',
        rightId: 'right-1',
        includeRelationshipProps: 'findNumber,referenceDesignator',
        filters: {
          compareMode: 'strict',
        },
      })
      .expect(200)

    expect(plmAdapter.getBomCompare).toHaveBeenCalledWith({
      leftId: 'left-1',
      rightId: 'right-1',
      leftType: 'item',
      rightType: 'item',
      lineKey: undefined,
      compareMode: 'strict',
      maxLevels: undefined,
      includeSubstitutes: undefined,
      includeEffectivity: undefined,
      includeRelationshipProps: ['findNumber', 'referenceDesignator'],
      effectiveAt: undefined,
    })
    expect(bomCompareResponse.body.data).toEqual(plmContractFixtures.bomCompare)
  })

  it('supports PLM mutation contracts for substitute add and approval reject', async () => {
    const plmAdapter = createPlmAdapterMock()
    const app = createFederationApp({ plmAdapter })

    const addResponse = await request(app)
      .post('/api/federation/plm/mutate')
      .send({
        operation: 'substitutes_add',
        bomLineId: 'line-1',
        substituteItemId: 'part-2',
        properties: { preference: 'alternate' },
      })
      .expect(200)

    expect(plmAdapter.addBomSubstitute).toHaveBeenCalledWith('line-1', 'part-2', { preference: 'alternate' })
    expect(addResponse.body.data).toEqual(plmContractFixtures.substituteAdded)

    const missingCommentResponse = await request(app)
      .post('/api/federation/plm/mutate')
      .send({
        operation: 'approval_reject',
        approvalId: 'eco-1',
      })
      .expect(400)

    expect(missingCommentResponse.body).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'comment is required for approval_reject',
      },
    })

    const rejectResponse = await request(app)
      .post('/api/federation/plm/mutate')
      .send({
        operation: 'approval_reject',
        approvalId: 'eco-1',
        comment: 'missing test evidence',
      })
      .expect(200)

    expect(plmAdapter.rejectApproval).toHaveBeenCalledWith('eco-1', 'missing test evidence')
    expect(rejectResponse.body.data).toEqual({
      id: 'eco-1',
      comment: 'missing test evidence',
    })
  })

  it('supports PLM detail contracts for product detail and BOM detail', async () => {
    const plmAdapter = createPlmAdapterMock()
    const app = createFederationApp({ plmAdapter })

    const detailResponse = await request(app)
      .get('/api/federation/plm/products/prod-1001')
      .query({ itemType: 'Part' })
      .expect(200)

    expect(plmAdapter.getProductById).toHaveBeenCalledWith('prod-1001', { itemType: 'Part' })
    expect(detailResponse.body.data).toEqual(
      expect.objectContaining({
        id: 'prod-1001',
        partNumber: 'PN-1001',
        revision: 'B',
      }),
    )

    const bomResponse = await request(app)
      .get('/api/federation/plm/products/prod-1001/bom')
      .query({ depth: 3, effective_at: '2026-03-06T00:00:00.000Z' })
      .expect(200)

    expect(plmAdapter.getProductBOM).toHaveBeenCalledWith('prod-1001', {
      depth: 3,
      effectiveAt: '2026-03-06T00:00:00.000Z',
    })
    expect(bomResponse.body.data).toEqual({
      productId: 'prod-1001',
      items: plmContractFixtures.bom,
      totalItems: 1,
    })
  })

  it('supports Athena query and detail contracts with mocked adapters', async () => {
    const athenaAdapter = createAthenaAdapterMock()
    const app = createFederationApp({ athenaAdapter })

    const queryResponse = await request(app)
      .post('/api/federation/athena/query')
      .send({
        operation: 'documents',
        query: 'servo',
        folderId: 'folder-1',
        pagination: { limit: 20, offset: 5 },
        filters: { status: 'approved' },
      })
      .expect(200)

    expect(athenaAdapter.searchDocuments).toHaveBeenCalledWith({
      query: 'servo',
      folder_id: 'folder-1',
      type: undefined,
      status: 'approved',
      created_by: undefined,
      created_after: undefined,
      created_before: undefined,
      limit: 20,
      offset: 5,
    })
    expect(queryResponse.body.data).toEqual({
      items: [
        expect.objectContaining({
          id: 'doc-1',
          mimeType: 'application/pdf',
          version: 'A',
        }),
      ],
      total: 1,
      limit: 20,
      offset: 5,
    })

    const detailResponse = await request(app)
      .get('/api/federation/athena/documents/doc-1')
      .expect(200)

    expect(athenaAdapter.getDocument).toHaveBeenCalledWith('doc-1')
    expect(detailResponse.body.data).toEqual({
      id: 'doc-1',
      name: 'Servo Spec.pdf',
      mimeType: 'application/pdf',
      size: 4096,
      version: 'A',
      createdAt: '2026-03-01T00:00:00.000Z',
      modifiedAt: '2026-03-02T00:00:00.000Z',
      locked: false,
    })
  })
})


// ---------------------------------------------------------------------------
// PLM documents partial-degradation (route-level regression)
// ---------------------------------------------------------------------------

describe('Federation PLM documents degradation visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    rbacMocks.isAdmin.mockResolvedValue(true)
    rbacMocks.userHasPermission.mockResolvedValue(true)
    rbacMocks.listUserPermissions.mockResolvedValue(['federation:read', 'federation:write'])
    auditMocks.auditLog.mockResolvedValue(undefined)
  })

  function createDocPlmAdapter(overrides: {
    getProductDocuments: (...args: any[]) => Promise<any>
  }) {
    const base = createPlmAdapterMock()
    return { ...base, getProductDocuments: vi.fn(overrides.getProductDocuments) }
  }

  it('returns sources metadata when attachments fail but AML succeeds', async () => {
    const plmAdapter = createDocPlmAdapter({
      getProductDocuments: async () => ({
        data: [{ id: 'doc-aml-1', name: 'AML Doc', document_type: 'document' }],
        metadata: {
          totalCount: 1,
          sources: [
            { name: 'attachments', ok: false, count: 0, error: 'file endpoint down' },
            { name: 'related_documents', ok: true, count: 1 },
          ],
        },
      }),
    })
    const app = createFederationApp({ plmAdapter })

    const res = await request(app)
      .post('/api/federation/plm/query')
      .send({ operation: 'documents', productId: 'prod-1' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.items).toHaveLength(1)
    expect(res.body.data.sources).toBeDefined()
    expect(res.body.data.sources[0]).toMatchObject({ name: 'attachments', ok: false })
    expect(res.body.data.sources[0].error).toBe('file endpoint down')
    expect(res.body.data.sources[1]).toMatchObject({ name: 'related_documents', ok: true, count: 1 })
  })

  it('returns sources metadata when AML fails but attachments succeed', async () => {
    const plmAdapter = createDocPlmAdapter({
      getProductDocuments: async () => ({
        data: [{ id: 'file-1', name: 'drawing.pdf', document_type: 'drawing' }],
        metadata: {
          totalCount: 1,
          sources: [
            { name: 'attachments', ok: true, count: 1 },
            { name: 'related_documents', ok: false, count: 0, error: 'aml query down' },
          ],
        },
      }),
    })
    const app = createFederationApp({ plmAdapter })

    const res = await request(app)
      .post('/api/federation/plm/query')
      .send({ operation: 'documents', productId: 'prod-1' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.items).toHaveLength(1)
    expect(res.body.data.sources[0]).toMatchObject({ name: 'attachments', ok: true })
    expect(res.body.data.sources[1]).toMatchObject({ name: 'related_documents', ok: false })
  })

  it('returns sources metadata even when both sides fail (no sendAdapterError short-circuit)', async () => {
    const plmAdapter = createDocPlmAdapter({
      getProductDocuments: async () => ({
        data: [],
        metadata: {
          totalCount: 0,
          sources: [
            { name: 'attachments', ok: false, count: 0, error: 'file side down' },
            { name: 'related_documents', ok: false, count: 0, error: 'aml side down' },
          ],
        },
        error: new Error('file side down'),
      }),
    })
    const app = createFederationApp({ plmAdapter })

    const res = await request(app)
      .post('/api/federation/plm/query')
      .send({ operation: 'documents', productId: 'prod-1' })

    // Key assertion: even with result.error set, the route should still
    // return ok:true + sources because sources metadata is present. The
    // sendAdapterError path is bypassed for documents when sources exist.
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.items).toHaveLength(0)
    expect(res.body.data.sources).toBeDefined()
    expect(res.body.data.sources[0]).toMatchObject({ name: 'attachments', ok: false })
    expect(res.body.data.sources[1]).toMatchObject({ name: 'related_documents', ok: false })
  })

  it('returns no sources field when both sides succeed (clean response)', async () => {
    const plmAdapter = createDocPlmAdapter({
      getProductDocuments: async () => ({
        data: [
          { id: 'f1', name: 'spec.pdf', document_type: 'drawing' },
          { id: 'd1', name: 'Related Doc', document_type: 'document' },
        ],
        metadata: {
          totalCount: 2,
          sources: [
            { name: 'attachments', ok: true, count: 1 },
            { name: 'related_documents', ok: true, count: 1 },
          ],
        },
      }),
    })
    const app = createFederationApp({ plmAdapter })

    const res = await request(app)
      .post('/api/federation/plm/query')
      .send({ operation: 'documents', productId: 'prod-1' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.items).toHaveLength(2)
    expect(res.body.data.sources).toBeDefined()
    expect(res.body.data.sources.every((s: any) => s.ok)).toBe(true)
  })
})
