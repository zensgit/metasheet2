import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    buildAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
  }),
}))

vi.mock('../src/utils/api', () => ({
  getApiBase: () => 'http://unit.test',
}))

describe('ViewManager multitable CRUD contract', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('creates views through the multitable runtime endpoint', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: {
        view: {
          id: 'view_new',
          sheetId: 'sheet_ops',
          name: 'Kanban',
          type: 'kanban',
        },
      },
    }), { status: 201 }))
    vi.stubGlobal('fetch', fetchSpy)

    const { ViewManager } = await import('../src/services/ViewManager')
    const result = await ViewManager.getInstance().createView({
      id: 'view_new',
      sheetId: 'sheet_ops',
      name: 'Kanban',
      type: 'kanban',
    } as any)

    expect(result).toEqual(expect.objectContaining({
      id: 'view_new',
      sheetId: 'sheet_ops',
      name: 'Kanban',
      type: 'kanban',
    }))
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://unit.test/api/multitable/views',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('lists sheet views through /api/multitable/views?sheetId=', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: {
        views: [
          { id: 'view_grid', sheetId: 'sheet_ops', name: 'Grid', type: 'grid' },
          { id: 'view_form', sheetId: 'sheet_ops', name: 'Form', type: 'form' },
        ],
      },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    const { ViewManager } = await import('../src/services/ViewManager')
    const views = await ViewManager.getInstance().getTableViews('sheet_ops')

    expect(views).toHaveLength(2)
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://unit.test/api/multitable/views?sheetId=sheet_ops',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }),
    )
  })

  it('updates views through PATCH /api/multitable/views/:id', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: {
        view: {
          id: 'view_grid',
          sheetId: 'sheet_ops',
          name: 'Ops Grid',
          type: 'grid',
        },
      },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    const { ViewManager } = await import('../src/services/ViewManager')
    const ok = await ViewManager.getInstance().updateView({
      id: 'view_grid',
      sheetId: 'sheet_ops',
      name: 'Ops Grid',
      type: 'grid',
    } as any)

    expect(ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://unit.test/api/multitable/views/view_grid',
      expect.objectContaining({ method: 'PATCH' }),
    )
  })

  it('deletes views through DELETE /api/multitable/views/:id', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: { deleted: 'view_grid' },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    const { ViewManager } = await import('../src/services/ViewManager')
    const ok = await ViewManager.getInstance().deleteView('view_grid')

    expect(ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://unit.test/api/multitable/views/view_grid',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})
