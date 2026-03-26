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

  it('creates gallery views through the multitable createView contract', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: {
        view: {
          id: 'view_gallery',
          sheetId: 'sheet_ops',
          name: 'Gallery',
          type: 'gallery',
          config: {
            cardTemplate: { titleField: 'fld_title', contentFields: ['fld_desc'] },
            layout: { columns: 3, cardSize: 'medium', spacing: 'normal' },
            display: { showTitle: true, showContent: true, showImage: false, showTags: false, truncateContent: true },
          },
        },
      },
    }), { status: 201 }))
    vi.stubGlobal('fetch', fetchSpy)

    const { ViewManager } = await import('../src/services/ViewManager')
    const id = await ViewManager.getInstance().createGalleryView({
      name: 'Gallery',
      type: 'gallery',
      tableId: 'sheet_ops',
      createdBy: 'user_1',
      filters: [],
      sorting: [],
      visibleFields: [],
      cardTemplate: { titleField: 'fld_title', contentFields: ['fld_desc'] },
      layout: { columns: 3, cardSize: 'medium', spacing: 'normal' },
      display: { showTitle: true, showContent: true, showImage: false, showTags: false, truncateContent: true },
    } as any)

    expect(id).toBe('view_gallery')
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://unit.test/api/multitable/views',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"type":"gallery"'),
      }),
    )
  })

  it('creates form views through the multitable createView contract', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: {
        view: {
          id: 'view_form',
          sheetId: 'sheet_ops',
          name: 'Ops Form',
          type: 'form',
        },
      },
    }), { status: 201 }))
    vi.stubGlobal('fetch', fetchSpy)

    const { ViewManager } = await import('../src/services/ViewManager')
    const id = await ViewManager.getInstance().createFormView({
      name: 'Ops Form',
      type: 'form',
      tableId: 'sheet_ops',
      createdBy: 'user_1',
      filters: [],
      sorting: [],
      visibleFields: [],
      fields: [],
      settings: {
        title: 'Ops Form',
        submitButtonText: 'Submit',
        allowMultiple: true,
        requireAuth: true,
        enablePublicAccess: false,
        notifyOnSubmission: false,
      },
      validation: { enableValidation: true },
      styling: { theme: 'default', layout: 'single-column' },
    } as any)

    expect(id).toBe('view_form')
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://unit.test/api/multitable/views',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"type":"form"'),
      }),
    )
  })

  it('submits forms through the multitable runtime endpoint and maps runtime success to legacy success shape', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: {
        mode: 'create',
        record: { id: 'rec_1', version: 1, data: { fld_title: 'Alpha' } },
      },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    const { ViewManager } = await import('../src/services/ViewManager')
    const result = await ViewManager.getInstance().submitForm('view_form', { fld_title: 'Alpha' })

    expect(result).toEqual({
      success: true,
      data: {
        id: 'rec_1',
        message: 'Form submitted successfully',
      },
    })
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://unit.test/api/multitable/views/view_form/submit',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
