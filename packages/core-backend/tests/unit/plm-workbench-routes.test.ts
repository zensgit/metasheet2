import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const routeMocks = vi.hoisted(() => {
  const createBuilder = () => {
    const builder = {
      selectAll: vi.fn(),
      where: vi.fn(),
      orderBy: vi.fn(),
      set: vi.fn(),
      values: vi.fn(),
      returningAll: vi.fn(),
      onConflict: vi.fn(),
      execute: vi.fn(),
      executeTakeFirst: vi.fn(),
      executeTakeFirstOrThrow: vi.fn(),
    } as Record<string, ReturnType<typeof vi.fn>>

    builder.selectAll.mockImplementation(() => builder)
    builder.where.mockImplementation(() => builder)
    builder.orderBy.mockImplementation(() => builder)
    builder.set.mockImplementation(() => builder)
    builder.values.mockImplementation(() => builder)
    builder.returningAll.mockImplementation(() => builder)
    builder.onConflict.mockImplementation((callback: (arg: unknown) => void) => {
      callback({
        columns: () => ({
          doUpdateSet: () => builder,
        }),
      })
      return builder
    })

    return builder
  }

  const state = {
    authUser: {
      id: 'owner-1',
      tenantId: 'tenant-a',
    },
    builder: createBuilder(),
    trxBuilder: createBuilder(),
  }

  const db = {
    selectFrom: vi.fn(() => state.builder),
    updateTable: vi.fn(() => state.builder),
    insertInto: vi.fn(() => state.builder),
    deleteFrom: vi.fn(() => state.builder),
    transaction: vi.fn(() => ({
      execute: async (callback: (trx: unknown) => unknown) =>
        callback({
          updateTable: () => state.trxBuilder,
          insertInto: () => state.trxBuilder,
        }),
    })),
  }

  return {
    createBuilder,
    state,
    db,
  }
})

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(async () => ({ rows: [] })),
}))

vi.mock('../../src/db/db', () => ({
  db: routeMocks.db,
}))

vi.mock('../../src/db/pg', () => ({
  pool: {},
  query: pgMocks.query,
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = routeMocks.state.authUser as never
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

    return {
      body: () => makeChain(),
      param: () => makeChain(),
      query: () => makeChain(),
    }
  },
}))

import plmWorkbenchRouter from '../../src/routes/plm-workbench'

describe('plm-workbench routes', () => {
  const app = express()
  app.use(express.json())
  app.use(plmWorkbenchRouter)

  beforeEach(() => {
    routeMocks.state.authUser = {
      id: 'owner-1',
      tenantId: 'tenant-a',
    }
    routeMocks.state.builder = routeMocks.createBuilder()
    routeMocks.state.trxBuilder = routeMocks.createBuilder()
    vi.clearAllMocks()
    pgMocks.query.mockClear()
  })

  it('lists team views and returns defaultViewId metadata', async () => {
    routeMocks.state.builder.execute.mockResolvedValueOnce([
      {
        id: 'view-1',
        tenant_id: 'tenant-a',
        owner_user_id: 'owner-1',
        scope: 'team',
        kind: 'documents',
        name: '文档默认',
        name_key: '文档默认',
        is_default: true,
        state: JSON.stringify({ panel: 'documents' }),
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-09T00:10:00.000Z',
      },
      {
        id: 'view-2',
        tenant_id: 'tenant-a',
        owner_user_id: 'owner-2',
        scope: 'team',
        kind: 'documents',
        name: '文档备选',
        name_key: '文档备选',
        is_default: false,
        state: JSON.stringify({ panel: 'documents', columns: ['name'] }),
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-09T00:11:00.000Z',
      },
    ])
    pgMocks.query.mockResolvedValueOnce({
      rows: [
        {
          resource_id: 'view-1',
          last_default_set_at: '2026-03-09T00:30:00.000Z',
        },
      ],
    })

    const response = await request(app).get('/api/plm-workbench/views/team?kind=documents')

    expect(response.status).toBe(200)
    expect(response.body.data[0]).toMatchObject({
      id: 'view-1',
      lastDefaultSetAt: '2026-03-09T00:30:00.000Z',
    })
    expect(response.body.data[1].lastDefaultSetAt).toBeUndefined()
    expect(response.body.metadata).toMatchObject({
      total: 2,
      tenantId: 'tenant-a',
      kind: 'documents',
      defaultViewId: 'view-1',
    })
  })

  it('saves arbitrary json state for team views', async () => {
    routeMocks.state.builder.executeTakeFirstOrThrow.mockResolvedValueOnce({
      id: 'view-3',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'documents',
      name: '数组视图',
      name_key: '数组视图',
      is_default: false,
      state: JSON.stringify(['compact', { columns: ['name', 'revision'] }]),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:12:00.000Z',
    })

    const response = await request(app)
      .post('/api/plm-workbench/views/team')
      .send({
        kind: 'documents',
        name: '数组视图',
        state: ['compact', { columns: ['name', 'revision'] }],
      })

    expect(response.status).toBe(201)
    expect(response.body.data).toMatchObject({
      kind: 'documents',
      name: '数组视图',
      isDefault: false,
      state: ['compact', { columns: ['name', 'revision'] }],
    })
  })

  it('accepts workbench team views with query snapshots', async () => {
    routeMocks.state.builder.executeTakeFirstOrThrow.mockResolvedValueOnce({
      id: 'view-workbench',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'workbench',
      name: 'PLM 工作台',
      name_key: 'plm 工作台',
      is_default: false,
      state: JSON.stringify({
        query: {
          productId: 'prod-100',
          documentFilter: 'gear',
          approvalsFilter: 'eco',
          autoload: 'true',
        },
      }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:12:00.000Z',
    })

    const response = await request(app)
      .post('/api/plm-workbench/views/team')
      .send({
        kind: 'workbench',
        name: 'PLM 工作台',
        state: {
          query: {
            productId: 'prod-100',
            documentFilter: 'gear',
            approvalsFilter: 'eco',
            autoload: 'true',
          },
        },
      })

    expect(response.status).toBe(201)
    expect(response.body.data).toMatchObject({
      kind: 'workbench',
      name: 'PLM 工作台',
      state: {
        query: {
          productId: 'prod-100',
          documentFilter: 'gear',
          approvalsFilter: 'eco',
          autoload: 'true',
        },
      },
    })
  })

  it('accepts audit team views with query snapshots', async () => {
    routeMocks.state.builder.executeTakeFirstOrThrow.mockResolvedValueOnce({
      id: 'view-audit',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'audit',
      name: 'PLM 审计',
      name_key: 'plm 审计',
      is_default: false,
      state: JSON.stringify({
        page: 2,
        q: 'documents',
        actorId: 'dev-user',
        kind: 'documents',
        action: 'archive',
        resourceType: 'plm-team-view-batch',
        from: '2026-03-11T15:00:00.000Z',
        to: '2026-03-11T16:00:00.000Z',
        windowMinutes: 720,
      }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:12:00.000Z',
    })

    const response = await request(app)
      .post('/api/plm-workbench/views/team')
      .send({
        kind: 'audit',
        name: 'PLM 审计',
        state: {
          page: 2,
          q: 'documents',
          actorId: 'dev-user',
          kind: 'documents',
          action: 'archive',
          resourceType: 'plm-team-view-batch',
          from: '2026-03-11T15:00:00.000Z',
          to: '2026-03-11T16:00:00.000Z',
          windowMinutes: 720,
        },
      })

    expect(response.status).toBe(201)
    expect(response.body.data).toMatchObject({
      kind: 'audit',
      name: 'PLM 审计',
      state: {
        page: 2,
        q: 'documents',
        actorId: 'dev-user',
        kind: 'documents',
        action: 'archive',
        resourceType: 'plm-team-view-batch',
        from: '2026-03-11T15:00:00.000Z',
        to: '2026-03-11T16:00:00.000Z',
        windowMinutes: 720,
      },
    })
  })

  it('writes unified audit entries for preset batch actions', async () => {
    routeMocks.state.builder.execute.mockResolvedValueOnce([
      {
        id: '11111111-1111-4111-8111-111111111111',
        tenant_id: 'tenant-a',
        owner_user_id: 'owner-1',
        scope: 'team',
        kind: 'bom',
        name: '关键 BOM',
        name_key: '关键 bom',
        is_default: false,
        archived_at: null,
        state: JSON.stringify({ field: 'path', value: 'root/a', group: '机械' }),
        created_at: '2026-03-11T00:00:00.000Z',
        updated_at: '2026-03-11T00:10:00.000Z',
      },
    ])
    routeMocks.state.builder.execute.mockResolvedValueOnce([
      {
        id: '11111111-1111-4111-8111-111111111111',
        tenant_id: 'tenant-a',
        owner_user_id: 'owner-1',
        scope: 'team',
        kind: 'bom',
        name: '关键 BOM',
        name_key: '关键 bom',
        is_default: false,
        archived_at: '2026-03-11T01:00:00.000Z',
        state: JSON.stringify({ field: 'path', value: 'root/a', group: '机械' }),
        created_at: '2026-03-11T00:00:00.000Z',
        updated_at: '2026-03-11T01:00:00.000Z',
      },
    ])

    const response = await request(app)
      .post('/api/plm-workbench/filter-presets/team/batch')
      .send({
        action: 'archive',
        ids: ['11111111-1111-4111-8111-111111111111'],
      })

    expect(response.status).toBe(200)
    expect(pgMocks.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO operation_audit_logs'),
      expect.arrayContaining([
        'owner-1',
        'user',
        'archive',
        'plm-team-preset-batch',
        '11111111-1111-4111-8111-111111111111',
        expect.stringContaining('"processedKinds":["bom"]'),
      ]),
    )
  })

  it('writes unified audit entries for team view batch actions', async () => {
    routeMocks.state.builder.execute.mockResolvedValueOnce([
      {
        id: '22222222-2222-4222-8222-222222222222',
        tenant_id: 'tenant-a',
        owner_user_id: 'owner-1',
        scope: 'team',
        kind: 'documents',
        name: '共享文档',
        name_key: '共享文档',
        is_default: false,
        archived_at: null,
        state: JSON.stringify({ role: 'primary', filter: 'gear' }),
        created_at: '2026-03-11T00:00:00.000Z',
        updated_at: '2026-03-11T00:10:00.000Z',
      },
    ])
    routeMocks.state.builder.execute.mockResolvedValueOnce([
      {
        id: '22222222-2222-4222-8222-222222222222',
        tenant_id: 'tenant-a',
        owner_user_id: 'owner-1',
        scope: 'team',
        kind: 'documents',
        name: '共享文档',
        name_key: '共享文档',
        is_default: false,
        archived_at: '2026-03-11T01:00:00.000Z',
        state: JSON.stringify({ role: 'primary', filter: 'gear' }),
        created_at: '2026-03-11T00:00:00.000Z',
        updated_at: '2026-03-11T01:00:00.000Z',
      },
    ])

    const response = await request(app)
      .post('/api/plm-workbench/views/team/batch')
      .send({
        action: 'archive',
        ids: ['22222222-2222-4222-8222-222222222222'],
      })

    expect(response.status).toBe(200)
    expect(pgMocks.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO operation_audit_logs'),
      expect.arrayContaining([
        'owner-1',
        'user',
        'archive',
        'plm-team-view-batch',
        '22222222-2222-4222-8222-222222222222',
        expect.stringContaining('"processedKinds":["documents"]'),
      ]),
    )
  })

  it('renames a team view for the owner', async () => {
    routeMocks.state.builder.executeTakeFirst
      .mockResolvedValueOnce({
        id: 'view-rename',
        tenant_id: 'tenant-a',
        owner_user_id: 'owner-1',
        scope: 'team',
        kind: 'workbench',
        name: '旧工作台视图',
        name_key: '旧工作台视图',
        is_default: false,
        state: JSON.stringify({ query: { documentFilter: 'gear' } }),
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-09T00:12:00.000Z',
      })
      .mockResolvedValueOnce(undefined)

    routeMocks.state.builder.executeTakeFirstOrThrow.mockResolvedValueOnce({
      id: 'view-rename',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'workbench',
      name: '新工作台视图',
      name_key: '新工作台视图',
      is_default: false,
      state: JSON.stringify({ query: { documentFilter: 'gear' } }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:20:00.000Z',
    })

    const response = await request(app)
      .patch('/api/plm-workbench/views/team/view-rename')
      .send({ name: '新工作台视图' })

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      id: 'view-rename',
      kind: 'workbench',
      name: '新工作台视图',
    })
  })

  it('duplicates a team view into a new owner copy', async () => {
    routeMocks.state.authUser = {
      id: 'owner-2',
      tenantId: 'tenant-a',
    }

    routeMocks.state.builder.executeTakeFirst.mockResolvedValueOnce({
      id: 'view-source',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'workbench',
      name: '共享工作台视图',
      name_key: '共享工作台视图',
      is_default: true,
      state: JSON.stringify({ query: { approvalsFilter: 'eco' } }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:12:00.000Z',
    })
    routeMocks.state.builder.execute.mockResolvedValueOnce([
      {
        id: 'view-existing-copy',
        tenant_id: 'tenant-a',
        owner_user_id: 'owner-2',
        scope: 'team',
        kind: 'workbench',
        name: '共享工作台视图（副本）',
        name_key: '共享工作台视图（副本）',
        is_default: false,
        state: JSON.stringify({ query: { approvalsFilter: 'old' } }),
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-09T00:12:00.000Z',
      },
    ])
    routeMocks.state.builder.executeTakeFirstOrThrow.mockResolvedValueOnce({
      id: 'view-copy-2',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-2',
      scope: 'team',
      kind: 'workbench',
      name: '共享工作台视图（副本 2）',
      name_key: '共享工作台视图（副本 2）',
      is_default: false,
      state: JSON.stringify({ query: { approvalsFilter: 'eco' } }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:15:00.000Z',
    })

    const response = await request(app)
      .post('/api/plm-workbench/views/team/view-source/duplicate')
      .send({})

    expect(response.status).toBe(201)
    expect(response.body.data).toMatchObject({
      id: 'view-copy-2',
      ownerUserId: 'owner-2',
      kind: 'workbench',
      name: '共享工作台视图（副本 2）',
      isDefault: false,
      state: {
        query: {
          approvalsFilter: 'eco',
        },
      },
    })
  })

  it('transfers a team view to another active user', async () => {
    routeMocks.state.builder.executeTakeFirst
      .mockResolvedValueOnce({
        id: 'view-transfer',
        tenant_id: 'tenant-a',
        owner_user_id: 'owner-1',
        scope: 'team',
        kind: 'documents',
        name: '共享文档视角',
        name_key: '共享文档视角',
        is_default: false,
        state: JSON.stringify({
          role: 'primary',
          filter: 'gear',
          sortKey: 'updated',
          sortDir: 'desc',
          columns: { mime: true },
        }),
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-09T00:12:00.000Z',
      })
      .mockResolvedValueOnce({
        id: 'owner-2',
        email: 'owner-2@example.com',
        is_active: true,
      })
      .mockResolvedValueOnce(undefined)

    routeMocks.state.builder.executeTakeFirstOrThrow.mockResolvedValueOnce({
      id: 'view-transfer',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-2',
      scope: 'team',
      kind: 'documents',
      name: '共享文档视角',
      name_key: '共享文档视角',
      is_default: false,
      state: JSON.stringify({
        role: 'primary',
        filter: 'gear',
        sortKey: 'updated',
        sortDir: 'desc',
        columns: { mime: true },
      }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-10T09:00:00.000Z',
    })

    const response = await request(app)
      .post('/api/plm-workbench/views/team/view-transfer/transfer')
      .send({ ownerUserId: 'owner-2' })

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      id: 'view-transfer',
      kind: 'documents',
      ownerUserId: 'owner-2',
      canManage: false,
      state: {
        role: 'primary',
        filter: 'gear',
        sortKey: 'updated',
        sortDir: 'desc',
        columns: { mime: true },
      },
    })
  })

  it('rejects transfer when the target owner is missing', async () => {
    routeMocks.state.builder.executeTakeFirst
      .mockResolvedValueOnce({
        id: 'view-transfer',
        tenant_id: 'tenant-a',
        owner_user_id: 'owner-1',
        scope: 'team',
        kind: 'documents',
        name: '共享文档视角',
        name_key: '共享文档视角',
        is_default: false,
        state: JSON.stringify({
          role: 'primary',
          filter: 'gear',
          sortKey: 'updated',
          sortDir: 'desc',
          columns: { mime: true },
        }),
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-09T00:12:00.000Z',
      })
      .mockResolvedValueOnce(undefined)

    const response = await request(app)
      .post('/api/plm-workbench/views/team/view-transfer/transfer')
      .send({ ownerUserId: 'missing-user' })

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({
      success: false,
      error: 'Target owner user not found',
    })
  })

  it('archives a workbench team view for the owner', async () => {
    routeMocks.state.builder.executeTakeFirst.mockResolvedValueOnce({
      id: 'view-archive',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'workbench',
      name: '待归档工作台',
      name_key: '待归档工作台',
      is_default: true,
      archived_at: null,
      state: JSON.stringify({ query: { documentFilter: 'gear' } }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:12:00.000Z',
    })
    routeMocks.state.builder.executeTakeFirstOrThrow.mockResolvedValueOnce({
      id: 'view-archive',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'workbench',
      name: '待归档工作台',
      name_key: '待归档工作台',
      is_default: false,
      archived_at: '2026-03-10T08:00:00.000Z',
      state: JSON.stringify({ query: { documentFilter: 'gear' } }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-10T08:00:00.000Z',
    })

    const response = await request(app).post('/api/plm-workbench/views/team/view-archive/archive')

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      id: 'view-archive',
      kind: 'workbench',
      isDefault: false,
      isArchived: true,
      archivedAt: '2026-03-10T08:00:00.000Z',
    })
    expect(pgMocks.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO operation_audit_logs'),
      expect.arrayContaining([
        'owner-1',
        'archive',
        'plm-team-view-batch',
        'view-archive',
      ]),
    )
  })

  it('restores an archived workbench team view for the owner', async () => {
    routeMocks.state.builder.executeTakeFirst.mockResolvedValueOnce({
      id: 'view-restore',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'workbench',
      name: '待恢复工作台',
      name_key: '待恢复工作台',
      is_default: false,
      archived_at: '2026-03-10T08:00:00.000Z',
      state: JSON.stringify({ query: { documentFilter: 'gear' } }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-10T08:00:00.000Z',
    })
    routeMocks.state.builder.executeTakeFirstOrThrow.mockResolvedValueOnce({
      id: 'view-restore',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'workbench',
      name: '待恢复工作台',
      name_key: '待恢复工作台',
      is_default: false,
      archived_at: null,
      state: JSON.stringify({ query: { documentFilter: 'gear' } }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-10T08:05:00.000Z',
    })

    const response = await request(app).post('/api/plm-workbench/views/team/view-restore/restore')

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      id: 'view-restore',
      kind: 'workbench',
      isArchived: false,
    })
    expect(pgMocks.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO operation_audit_logs'),
      expect.arrayContaining([
        'owner-1',
        'restore',
        'plm-team-view-batch',
        'view-restore',
      ]),
    )
  })

  it('deletes a workbench team view for the owner and writes audit', async () => {
    routeMocks.state.builder.executeTakeFirst.mockResolvedValueOnce({
      id: 'view-delete',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'audit',
      name: '待删除审计视图',
      name_key: '待删除审计视图',
      is_default: false,
      archived_at: null,
      state: JSON.stringify({ page: 1, q: '', actorId: '', kind: '', action: '', resourceType: '', from: '', to: '', windowMinutes: 180 }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:12:00.000Z',
    })
    routeMocks.state.builder.execute.mockResolvedValueOnce(undefined)

    const response = await request(app).delete('/api/plm-workbench/views/team/view-delete')

    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({
      id: 'view-delete',
      message: 'PLM team view deleted successfully',
    })
    expect(pgMocks.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO operation_audit_logs'),
      expect.arrayContaining([
        'owner-1',
        'delete',
        'plm-team-view-batch',
        'view-delete',
      ]),
    )
  })

  it('batch archives manageable team views and reports skipped ids', async () => {
    routeMocks.state.builder.execute.mockResolvedValueOnce([
      {
        id: '11111111-1111-4111-8111-111111111111',
        tenant_id: 'tenant-a',
        owner_user_id: 'owner-1',
        scope: 'team',
        kind: 'documents',
        name: '文档批量 A',
        name_key: '文档批量 a',
        is_default: false,
        archived_at: null,
        state: JSON.stringify({ role: 'primary', filter: 'gear', sortKey: 'updated', sortDir: 'desc', columns: { mime: true } }),
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-09T00:12:00.000Z',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        tenant_id: 'tenant-a',
        owner_user_id: 'owner-2',
        scope: 'team',
        kind: 'documents',
        name: '文档批量 B',
        name_key: '文档批量 b',
        is_default: false,
        archived_at: null,
        state: JSON.stringify({ role: 'secondary', filter: 'motor', sortKey: 'updated', sortDir: 'desc', columns: { mime: true } }),
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-09T00:13:00.000Z',
      },
    ])
    routeMocks.state.builder.execute.mockResolvedValueOnce([
      {
        id: '11111111-1111-4111-8111-111111111111',
        tenant_id: 'tenant-a',
        owner_user_id: 'owner-1',
        scope: 'team',
        kind: 'documents',
        name: '文档批量 A',
        name_key: '文档批量 a',
        is_default: false,
        archived_at: '2026-03-11T10:00:00.000Z',
        state: JSON.stringify({ role: 'primary', filter: 'gear', sortKey: 'updated', sortDir: 'desc', columns: { mime: true } }),
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-11T10:00:00.000Z',
      },
    ])

    const response = await request(app)
      .post('/api/plm-workbench/views/team/batch')
      .send({
        action: 'archive',
        ids: [
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          'invalid-team-view-id',
        ],
      })

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      action: 'archive',
      processedIds: ['11111111-1111-4111-8111-111111111111'],
      skippedIds: ['22222222-2222-4222-8222-222222222222', 'invalid-team-view-id'],
    })
    expect(response.body.metadata).toMatchObject({
      requestedTotal: 3,
      processedTotal: 1,
      skippedTotal: 2,
    })
    expect(response.body.data.items[0]).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'documents',
      isArchived: true,
    })
  })

  it('batch deletes manageable team views', async () => {
    routeMocks.state.builder.execute.mockResolvedValueOnce([
      {
        id: '33333333-3333-4333-8333-333333333333',
        tenant_id: 'tenant-a',
        owner_user_id: 'owner-1',
        scope: 'team',
        kind: 'cad',
        name: 'CAD 批量 A',
        name_key: 'cad 批量 a',
        is_default: false,
        archived_at: null,
        state: JSON.stringify({ fileId: 'cad-a', otherFileId: '', reviewState: 'approved', reviewNote: 'ok' }),
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-09T00:12:00.000Z',
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        tenant_id: 'tenant-a',
        owner_user_id: 'owner-1',
        scope: 'team',
        kind: 'approvals',
        name: '审批批量 A',
        name_key: '审批批量 a',
        is_default: false,
        archived_at: null,
        state: JSON.stringify({ status: 'pending', filter: 'eco', comment: '', sortKey: 'created', sortDir: 'desc', columns: { id: true } }),
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-09T00:13:00.000Z',
      },
    ])
    routeMocks.state.builder.execute.mockResolvedValueOnce(undefined)

    const response = await request(app)
      .post('/api/plm-workbench/views/team/batch')
      .send({
        action: 'delete',
        ids: [
          '33333333-3333-4333-8333-333333333333',
          '44444444-4444-4444-8444-444444444444',
        ],
      })

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      action: 'delete',
      processedIds: [
        '33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444',
      ],
      skippedIds: [],
      items: [],
    })
    expect(response.body.metadata).toMatchObject({
      requestedTotal: 2,
      processedTotal: 2,
      skippedTotal: 0,
      processedKinds: ['cad', 'approvals'],
    })
  })

  it('renames a team preset for the owner', async () => {
    routeMocks.state.builder.executeTakeFirst
      .mockResolvedValueOnce({
        id: 'preset-rename',
        tenant_id: 'tenant-a',
        owner_user_id: 'owner-1',
        scope: 'team',
        kind: 'bom',
        name: '旧团队预设',
        name_key: '旧团队预设',
        is_default: false,
        state: JSON.stringify({ field: 'path', value: 'root/a', group: '机械' }),
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-09T00:12:00.000Z',
      })
      .mockResolvedValueOnce(undefined)

    routeMocks.state.builder.executeTakeFirstOrThrow.mockResolvedValueOnce({
      id: 'preset-rename',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'bom',
      name: '新团队预设',
      name_key: '新团队预设',
      is_default: false,
      state: JSON.stringify({ field: 'path', value: 'root/a', group: '机械' }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:20:00.000Z',
    })

    const response = await request(app)
      .patch('/api/plm-workbench/filter-presets/team/preset-rename')
      .send({ name: '新团队预设' })

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      id: 'preset-rename',
      kind: 'bom',
      name: '新团队预设',
    })
  })

  it('duplicates a team preset into a new owner copy', async () => {
    routeMocks.state.authUser = {
      id: 'owner-2',
      tenantId: 'tenant-a',
    }

    routeMocks.state.builder.executeTakeFirst.mockResolvedValueOnce({
      id: 'preset-source',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'where-used',
      name: '共享父件预设',
      name_key: '共享父件预设',
      is_default: true,
      state: JSON.stringify({ field: 'parent', value: 'assy-01', group: '装配' }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:12:00.000Z',
    })
    routeMocks.state.builder.execute.mockResolvedValueOnce([
      {
        id: 'preset-existing-copy',
        tenant_id: 'tenant-a',
        owner_user_id: 'owner-2',
        scope: 'team',
        kind: 'where-used',
        name: '共享父件预设（副本）',
        name_key: '共享父件预设（副本）',
        is_default: false,
        state: JSON.stringify({ field: 'parent', value: 'assy-legacy', group: '装配' }),
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-09T00:12:00.000Z',
      },
    ])
    routeMocks.state.builder.executeTakeFirstOrThrow.mockResolvedValueOnce({
      id: 'preset-copy-2',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-2',
      scope: 'team',
      kind: 'where-used',
      name: '共享父件预设（副本 2）',
      name_key: '共享父件预设（副本 2）',
      is_default: false,
      state: JSON.stringify({ field: 'parent', value: 'assy-01', group: '装配' }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:15:00.000Z',
    })

    const response = await request(app)
      .post('/api/plm-workbench/filter-presets/team/preset-source/duplicate')
      .send({})

    expect(response.status).toBe(201)
    expect(response.body.data).toMatchObject({
      id: 'preset-copy-2',
      ownerUserId: 'owner-2',
      kind: 'where-used',
      name: '共享父件预设（副本 2）',
      isDefault: false,
      state: {
        field: 'parent',
        value: 'assy-01',
        group: '装配',
      },
    })
  })

  it('transfers a team preset to another active user', async () => {
    routeMocks.state.builder.executeTakeFirst
      .mockResolvedValueOnce({
        id: 'preset-transfer',
        tenant_id: 'tenant-a',
        owner_user_id: 'owner-1',
        scope: 'team',
        kind: 'bom',
        name: '共享团队预设',
        name_key: '共享团队预设',
        is_default: false,
        archived_at: null,
        state: JSON.stringify({ field: 'path', value: 'root/shared', group: '机械' }),
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-10T08:00:00.000Z',
      })
      .mockResolvedValueOnce({
        id: 'target-user',
        tenant_id: 'tenant-a',
        email: 'target@example.com',
        is_active: true,
      })
      .mockResolvedValueOnce(undefined)
    routeMocks.state.builder.executeTakeFirstOrThrow.mockResolvedValueOnce({
      id: 'preset-transfer',
      tenant_id: 'tenant-a',
      owner_user_id: 'target-user',
      scope: 'team',
      kind: 'bom',
      name: '共享团队预设',
      name_key: '共享团队预设',
      is_default: false,
      archived_at: null,
      state: JSON.stringify({ field: 'path', value: 'root/shared', group: '机械' }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-10T08:10:00.000Z',
    })

    const response = await request(app)
      .post('/api/plm-workbench/filter-presets/team/preset-transfer/transfer')
      .send({ ownerUserId: 'target-user' })

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      id: 'preset-transfer',
      ownerUserId: 'target-user',
      canManage: false,
      kind: 'bom',
    })
  })

  it('rejects team preset transfer when target owner is missing', async () => {
    routeMocks.state.builder.executeTakeFirst
      .mockResolvedValueOnce({
        id: 'preset-transfer',
        tenant_id: 'tenant-a',
        owner_user_id: 'owner-1',
        scope: 'team',
        kind: 'where-used',
        name: '共享父件预设',
        name_key: '共享父件预设',
        is_default: false,
        archived_at: null,
        state: JSON.stringify({ field: 'parent', value: 'assy-01', group: '装配' }),
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-10T08:00:00.000Z',
      })
      .mockResolvedValueOnce(undefined)

    const response = await request(app)
      .post('/api/plm-workbench/filter-presets/team/preset-transfer/transfer')
      .send({ ownerUserId: 'missing-user' })

    expect(response.status).toBe(404)
    expect(response.body.error).toContain('Target owner user not found')
  })

  it('rejects transferring archived team presets', async () => {
    routeMocks.state.builder.executeTakeFirst.mockResolvedValueOnce({
      id: 'preset-archived-transfer',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'bom',
      name: '归档团队预设',
      name_key: '归档团队预设',
      is_default: false,
      archived_at: '2026-03-11T01:00:00.000Z',
      state: JSON.stringify({ field: 'path', value: 'root/archive', group: '机械' }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-11T01:00:00.000Z',
    })

    const response = await request(app)
      .post('/api/plm-workbench/filter-presets/team/preset-archived-transfer/transfer')
      .send({ ownerUserId: 'owner-2' })

    expect(response.status).toBe(409)
    expect(response.body.error).toContain('Archived PLM team presets cannot be transferred')
  })

  it('rejects clearing default for archived team presets', async () => {
    routeMocks.state.builder.executeTakeFirst.mockResolvedValueOnce({
      id: 'preset-archived-default',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'bom',
      name: '归档默认团队预设',
      name_key: '归档默认团队预设',
      is_default: true,
      archived_at: '2026-03-11T01:00:00.000Z',
      state: JSON.stringify({ field: 'path', value: 'root/archive', group: '机械' }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-11T01:00:00.000Z',
    })

    const response = await request(app)
      .delete('/api/plm-workbench/filter-presets/team/preset-archived-default/default')

    expect(response.status).toBe(409)
    expect(response.body.error).toContain('Archived PLM team presets cannot clear the default')
    expect(routeMocks.state.builder.where).toHaveBeenCalledWith('id', '=', 'preset-archived-default')
    expect(routeMocks.state.builder.where).toHaveBeenCalledWith('tenant_id', '=', 'tenant-a')
    expect(routeMocks.state.builder.where).toHaveBeenCalledWith('scope', '=', 'team')
    expect(routeMocks.state.builder.executeTakeFirstOrThrow).not.toHaveBeenCalled()
    expect(pgMocks.query).not.toHaveBeenCalled()
  })

  it('archives a team preset for the owner', async () => {
    routeMocks.state.builder.executeTakeFirst.mockResolvedValueOnce({
      id: 'preset-archive',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'bom',
      name: '待归档团队预设',
      name_key: '待归档团队预设',
      is_default: true,
      archived_at: null,
      state: JSON.stringify({ field: 'path', value: 'root/archive', group: '机械' }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:12:00.000Z',
    })
    routeMocks.state.builder.executeTakeFirstOrThrow.mockResolvedValueOnce({
      id: 'preset-archive',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'bom',
      name: '待归档团队预设',
      name_key: '待归档团队预设',
      is_default: false,
      archived_at: '2026-03-10T08:00:00.000Z',
      state: JSON.stringify({ field: 'path', value: 'root/archive', group: '机械' }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-10T08:00:00.000Z',
    })

    const response = await request(app).post('/api/plm-workbench/filter-presets/team/preset-archive/archive')

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      id: 'preset-archive',
      kind: 'bom',
      isDefault: false,
      isArchived: true,
      archivedAt: '2026-03-10T08:00:00.000Z',
    })
    expect(pgMocks.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO operation_audit_logs'),
      expect.arrayContaining([
        'owner-1',
        'archive',
        'plm-team-preset-batch',
        'preset-archive',
      ]),
    )
  })

  it('restores an archived team preset for the owner', async () => {
    routeMocks.state.builder.executeTakeFirst.mockResolvedValueOnce({
      id: 'preset-restore',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'where-used',
      name: '待恢复团队预设',
      name_key: '待恢复团队预设',
      is_default: false,
      archived_at: '2026-03-10T08:00:00.000Z',
      state: JSON.stringify({ field: 'parent', value: 'assy-01', group: '装配' }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-10T08:00:00.000Z',
    })
    routeMocks.state.builder.executeTakeFirstOrThrow.mockResolvedValueOnce({
      id: 'preset-restore',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'where-used',
      name: '待恢复团队预设',
      name_key: '待恢复团队预设',
      is_default: false,
      archived_at: null,
      state: JSON.stringify({ field: 'parent', value: 'assy-01', group: '装配' }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-10T08:05:00.000Z',
    })

    const response = await request(app).post('/api/plm-workbench/filter-presets/team/preset-restore/restore')

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      id: 'preset-restore',
      kind: 'where-used',
      isArchived: false,
    })
    expect(pgMocks.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO operation_audit_logs'),
      expect.arrayContaining([
        'owner-1',
        'restore',
        'plm-team-preset-batch',
        'preset-restore',
      ]),
    )
  })

  it('deletes a team preset for the owner and writes audit', async () => {
    routeMocks.state.builder.executeTakeFirst.mockResolvedValueOnce({
      id: 'preset-delete',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'where-used',
      name: '待删除团队预设',
      name_key: '待删除团队预设',
      is_default: false,
      archived_at: null,
      state: JSON.stringify({ field: 'parent', value: 'assy-del', group: '装配' }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:12:00.000Z',
    })
    routeMocks.state.builder.execute.mockResolvedValueOnce(undefined)

    const response = await request(app).delete('/api/plm-workbench/filter-presets/team/preset-delete')

    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({
      id: 'preset-delete',
      message: 'PLM team preset deleted successfully',
    })
    expect(routeMocks.state.builder.where).toHaveBeenCalledWith('id', '=', 'preset-delete')
    expect(routeMocks.state.builder.where).toHaveBeenCalledWith('tenant_id', '=', 'tenant-a')
    expect(routeMocks.state.builder.where).toHaveBeenCalledWith('scope', '=', 'team')
    expect(pgMocks.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO operation_audit_logs'),
      expect.arrayContaining([
        'owner-1',
        'delete',
        'plm-team-preset-batch',
        'preset-delete',
      ]),
    )
  })

  it('batch archives manageable team presets and reports skipped ids', async () => {
    routeMocks.state.builder.execute
      .mockResolvedValueOnce([
        {
          id: '11111111-1111-4111-8111-111111111111',
          tenant_id: 'tenant-a',
          owner_user_id: 'owner-1',
          scope: 'team',
          kind: 'bom',
          name: '可归档预设',
          name_key: '可归档预设',
          is_default: true,
          archived_at: null,
          state: JSON.stringify({ field: 'path', value: 'root/a', group: '机械' }),
          created_at: '2026-03-09T00:00:00.000Z',
          updated_at: '2026-03-10T08:00:00.000Z',
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          tenant_id: 'tenant-a',
          owner_user_id: 'owner-2',
          scope: 'team',
          kind: 'bom',
          name: '只读预设',
          name_key: '只读预设',
          is_default: false,
          archived_at: null,
          state: JSON.stringify({ field: 'path', value: 'root/b', group: '共享' }),
          created_at: '2026-03-09T00:00:00.000Z',
          updated_at: '2026-03-10T08:00:00.000Z',
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          tenant_id: 'tenant-a',
          owner_user_id: 'owner-1',
          scope: 'team',
          kind: 'bom',
          name: '已归档预设',
          name_key: '已归档预设',
          is_default: false,
          archived_at: '2026-03-10T08:00:00.000Z',
          state: JSON.stringify({ field: 'path', value: 'root/c', group: '归档' }),
          created_at: '2026-03-09T00:00:00.000Z',
          updated_at: '2026-03-10T08:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: '11111111-1111-4111-8111-111111111111',
          tenant_id: 'tenant-a',
          owner_user_id: 'owner-1',
          scope: 'team',
          kind: 'bom',
          name: '可归档预设',
          name_key: '可归档预设',
          is_default: false,
          archived_at: '2026-03-11T10:00:00.000Z',
          state: JSON.stringify({ field: 'path', value: 'root/a', group: '机械' }),
          created_at: '2026-03-09T00:00:00.000Z',
          updated_at: '2026-03-11T10:00:00.000Z',
        },
      ])

    const response = await request(app)
      .post('/api/plm-workbench/filter-presets/team/batch')
      .send({
        action: 'archive',
        ids: [
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          '33333333-3333-4333-8333-333333333333',
          'invalid-batch-id',
        ],
      })

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      action: 'archive',
      processedIds: ['11111111-1111-4111-8111-111111111111'],
      skippedIds: [
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
        'invalid-batch-id',
      ],
    })
    expect(response.body.data.items[0]).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      isArchived: true,
      isDefault: false,
    })
  })

  it('batch deletes manageable team presets', async () => {
    routeMocks.state.builder.execute
      .mockResolvedValueOnce([
        {
          id: '44444444-4444-4444-8444-444444444444',
          tenant_id: 'tenant-a',
          owner_user_id: 'owner-1',
          scope: 'team',
          kind: 'where-used',
          name: '删除 A',
          name_key: '删除 a',
          is_default: false,
          archived_at: null,
          state: JSON.stringify({ field: 'parent', value: 'assy-a', group: '装配' }),
          created_at: '2026-03-09T00:00:00.000Z',
          updated_at: '2026-03-10T08:00:00.000Z',
        },
        {
          id: '55555555-5555-4555-8555-555555555555',
          tenant_id: 'tenant-a',
          owner_user_id: 'owner-1',
          scope: 'team',
          kind: 'where-used',
          name: '删除 B',
          name_key: '删除 b',
          is_default: false,
          archived_at: null,
          state: JSON.stringify({ field: 'parent', value: 'assy-b', group: '装配' }),
          created_at: '2026-03-09T00:00:00.000Z',
          updated_at: '2026-03-10T08:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce(undefined)

    const response = await request(app)
      .post('/api/plm-workbench/filter-presets/team/batch')
      .send({
        action: 'delete',
        ids: [
          '44444444-4444-4444-8444-444444444444',
          '55555555-5555-4555-8555-555555555555',
        ],
      })

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      action: 'delete',
      processedIds: [
        '44444444-4444-4444-8444-444444444444',
        '55555555-5555-4555-8555-555555555555',
      ],
      skippedIds: [],
      items: [],
    })
  })

  it('sets default team preset for the owner only', async () => {
    routeMocks.state.builder.executeTakeFirst.mockResolvedValueOnce({
      id: 'preset-default',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'bom',
      name: 'BOM 默认预设',
      name_key: 'bom 默认预设',
      is_default: false,
      archived_at: null,
      state: JSON.stringify({ field: 'path', value: 'root/default', group: '机械' }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:10:00.000Z',
    })
    routeMocks.state.trxBuilder.execute.mockResolvedValueOnce(undefined)
    routeMocks.state.trxBuilder.executeTakeFirstOrThrow.mockResolvedValueOnce({
      id: 'preset-default',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'bom',
      name: 'BOM 默认预设',
      name_key: 'bom 默认预设',
      is_default: true,
      archived_at: null,
      state: JSON.stringify({ field: 'path', value: 'root/default', group: '机械' }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:20:00.000Z',
    })

    const response = await request(app).post('/api/plm-workbench/filter-presets/team/preset-default/default')

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      id: 'preset-default',
      kind: 'bom',
      isDefault: true,
      canManage: true,
    })
    expect(routeMocks.db.transaction).toHaveBeenCalledTimes(1)
    expect(routeMocks.state.builder.where).toHaveBeenCalledWith('id', '=', 'preset-default')
    expect(routeMocks.state.builder.where).toHaveBeenCalledWith('tenant_id', '=', 'tenant-a')
    expect(routeMocks.state.builder.where).toHaveBeenCalledWith('scope', '=', 'team')
  })

  it('sets default team view for the owner only', async () => {
    routeMocks.state.builder.executeTakeFirst.mockResolvedValueOnce({
      id: 'view-1',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'cad',
      name: 'CAD 默认',
      name_key: 'cad 默认',
      is_default: false,
      state: JSON.stringify({ panel: 'cad' }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:10:00.000Z',
    })
    routeMocks.state.trxBuilder.execute.mockResolvedValueOnce(undefined)
    routeMocks.state.trxBuilder.executeTakeFirstOrThrow.mockResolvedValueOnce({
      id: 'view-1',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'cad',
      name: 'CAD 默认',
      name_key: 'cad 默认',
      is_default: true,
      state: JSON.stringify({ panel: 'cad' }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:20:00.000Z',
    })
    pgMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            resource_id: 'view-1',
            last_default_set_at: '2026-03-09T00:20:00.000Z',
          },
        ],
      })

    const response = await request(app).post('/api/plm-workbench/views/team/view-1/default')

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      id: 'view-1',
      kind: 'cad',
      isDefault: true,
      canManage: true,
      lastDefaultSetAt: '2026-03-09T00:20:00.000Z',
    })
    expect(routeMocks.db.transaction).toHaveBeenCalledTimes(1)
    expect(pgMocks.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT INTO operation_audit_logs'),
      expect.arrayContaining([
        'owner-1',
        'set-default',
        'plm-team-view-default',
        'view-1',
      ]),
    )
    expect(pgMocks.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('SELECT resource_id, MAX(COALESCE(occurred_at, created_at)) AS last_default_set_at'),
      [['view-1']],
    )
  })

  it('rejects default changes from non-owners', async () => {
    routeMocks.state.builder.executeTakeFirst.mockResolvedValueOnce({
      id: 'view-2',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-2',
      scope: 'team',
      kind: 'approvals',
      name: '审批默认',
      name_key: '审批默认',
      is_default: true,
      state: JSON.stringify({ panel: 'approvals' }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:20:00.000Z',
    })

    const response = await request(app).post('/api/plm-workbench/views/team/view-2/default')

    expect(response.status).toBe(403)
    expect(response.body.error).toContain('Only the view owner')
  })

  it('clears default team view state', async () => {
    routeMocks.state.builder.executeTakeFirst.mockResolvedValueOnce({
      id: 'view-1',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'approvals',
      name: '审批默认',
      name_key: '审批默认',
      is_default: true,
      state: JSON.stringify({ panel: 'approvals', filters: { status: 'pending' } }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:20:00.000Z',
    })
    routeMocks.state.builder.executeTakeFirstOrThrow.mockResolvedValueOnce({
      id: 'view-1',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'approvals',
      name: '审批默认',
      name_key: '审批默认',
      is_default: false,
      state: JSON.stringify({ panel: 'approvals', filters: { status: 'pending' } }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:21:00.000Z',
    })
    pgMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            resource_id: 'view-1',
            last_default_set_at: '2026-03-09T00:20:00.000Z',
          },
        ],
      })

    const response = await request(app).delete('/api/plm-workbench/views/team/view-1/default')

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      id: 'view-1',
      kind: 'approvals',
      isDefault: false,
      lastDefaultSetAt: '2026-03-09T00:20:00.000Z',
    })
    expect(pgMocks.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT INTO operation_audit_logs'),
      expect.arrayContaining([
        'owner-1',
        'clear-default',
        'plm-team-view-default',
        'view-1',
      ]),
    )
    expect(pgMocks.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('SELECT resource_id, MAX(COALESCE(occurred_at, created_at)) AS last_default_set_at'),
      [['view-1']],
    )
  })

  it('rejects clearing default for archived team views', async () => {
    routeMocks.state.builder.executeTakeFirst.mockResolvedValueOnce({
      id: 'view-archived-default',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'documents',
      name: '归档文档默认',
      name_key: '归档文档默认',
      is_default: true,
      archived_at: '2026-03-11T01:00:00.000Z',
      state: JSON.stringify({ panel: 'documents' }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-11T01:00:00.000Z',
    })

    const response = await request(app).delete('/api/plm-workbench/views/team/view-archived-default/default')

    expect(response.status).toBe(409)
    expect(response.body.error).toContain('Archived PLM team views cannot clear the default')
    expect(pgMocks.query).not.toHaveBeenCalled()
  })

  it('writes default-scene audit when saving a team view as default', async () => {
    routeMocks.state.trxBuilder.execute.mockResolvedValueOnce(undefined)
    routeMocks.state.trxBuilder.executeTakeFirstOrThrow.mockResolvedValueOnce({
      id: 'view-save-default',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'workbench',
      name: '采购团队场景',
      name_key: '采购团队场景',
      is_default: true,
      state: JSON.stringify({ query: { productId: 'prod-100' } }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:22:00.000Z',
    })
    pgMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            resource_id: 'view-save-default',
            last_default_set_at: '2026-03-09T00:22:00.000Z',
          },
        ],
      })

    const response = await request(app)
      .post('/api/plm-workbench/views/team')
      .send({
        kind: 'workbench',
        name: '采购团队场景',
        isDefault: true,
        state: {
          query: { productId: 'prod-100' },
        },
      })

    expect(response.status).toBe(201)
    expect(response.body.data).toMatchObject({
      id: 'view-save-default',
      kind: 'workbench',
      isDefault: true,
      lastDefaultSetAt: '2026-03-09T00:22:00.000Z',
    })
    expect(pgMocks.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT INTO operation_audit_logs'),
      expect.arrayContaining([
        'owner-1',
        'set-default',
        'plm-team-view-default',
        'view-save-default',
      ]),
    )
    expect(pgMocks.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('SELECT resource_id, MAX(COALESCE(occurred_at, created_at)) AS last_default_set_at'),
      [['view-save-default']],
    )
  })

  it('rejects transferring archived team views', async () => {
    routeMocks.state.builder.executeTakeFirst.mockResolvedValueOnce({
      id: 'view-archived-transfer',
      tenant_id: 'tenant-a',
      owner_user_id: 'owner-1',
      scope: 'team',
      kind: 'documents',
      name: '归档文档视角',
      name_key: '归档文档视角',
      is_default: false,
      archived_at: '2026-03-11T01:00:00.000Z',
      state: JSON.stringify({ panel: 'documents' }),
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-11T01:00:00.000Z',
    })

    const response = await request(app)
      .post('/api/plm-workbench/views/team/view-archived-transfer/transfer')
      .send({ ownerUserId: 'owner-2' })

    expect(response.status).toBe(409)
    expect(response.body.error).toContain('Archived PLM team views cannot be transferred')
  })
})
