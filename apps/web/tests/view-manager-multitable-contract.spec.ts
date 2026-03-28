import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    buildAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
  }),
}))

vi.mock('../src/utils/api', () => ({
  getApiBase: () => 'http://unit.test',
  apiFetch: vi.fn(),
}))

describe('ViewManager multitable CRUD contract', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('loads gallery config through multitable context and restores legacy config shape', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: {
        base: null,
        sheet: { id: 'sheet_ops', name: 'Ops', baseId: 'base_ops' },
        sheets: [{ id: 'sheet_ops', name: 'Ops', baseId: 'base_ops' }],
        views: [
          {
            id: 'view_gallery',
            sheetId: 'sheet_ops',
            name: 'Gallery',
            type: 'gallery',
            filterInfo: { mode: 'all' },
            sortInfo: { order: 'manual' },
            groupInfo: {},
            hiddenFieldIds: ['fld_hidden'],
            config: {
              description: 'Ops gallery',
              cardTemplate: { titleField: 'fld_title', contentFields: ['fld_desc'], imageField: 'fld_image', tagFields: ['fld_tags'] },
              layout: { columns: 4, cardSize: 'large', spacing: 'comfortable' },
              display: { showTitle: true, showContent: true, showImage: true, showTags: true, truncateContent: false },
            },
          },
        ],
        capabilities: { canRead: true },
      },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    const { ViewManager } = await import('../src/services/ViewManager')
    const result = await ViewManager.getInstance().loadViewConfig<any>('view_gallery')

    expect(result).toEqual(expect.objectContaining({
      id: 'view_gallery',
      tableId: 'sheet_ops',
      name: 'Gallery',
      type: 'gallery',
      description: 'Ops gallery',
      cardTemplate: expect.objectContaining({ titleField: 'fld_title' }),
      layout: expect.objectContaining({ columns: 4 }),
      display: expect.objectContaining({ truncateContent: false }),
      filterInfo: { mode: 'all' },
      hiddenFieldIds: ['fld_hidden'],
    }))
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://unit.test/api/multitable/context?viewId=view_gallery',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }),
    )
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

  it('saves calendar config through PATCH /api/multitable/views/:id and nests legacy fields into runtime config', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: {
        view: {
          id: 'view_calendar',
          sheetId: 'sheet_ops',
          name: 'Calendar',
          type: 'calendar',
          filterInfo: { mode: 'upcoming' },
          sortInfo: {},
          groupInfo: {},
          hiddenFieldIds: [],
          config: {
            description: 'Ops calendar',
            defaultView: 'week',
            weekStartsOn: 1,
            timeFormat: 24,
            fields: {
              title: 'title',
              start: 'startDate',
              startDate: 'startDate',
              end: 'endDate',
              endDate: 'endDate',
              category: 'category',
              location: 'location',
            },
            colorRules: [{ field: 'category', value: 'meeting', color: '#00f' }],
          },
        },
      },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    const { ViewManager } = await import('../src/services/ViewManager')
    const ok = await ViewManager.getInstance().saveViewConfig({
      id: 'view_calendar',
      name: 'Calendar',
      type: 'calendar',
      description: 'Ops calendar',
      createdAt: new Date('2026-03-26T00:00:00Z'),
      updatedAt: new Date('2026-03-26T00:00:00Z'),
      createdBy: 'user_1',
      tableId: 'sheet_ops',
      defaultView: 'week',
      weekStartsOn: 1,
      timeFormat: 24,
      fields: {
        title: 'title',
        start: 'startDate',
        startDate: 'startDate',
        end: 'endDate',
        endDate: 'endDate',
        category: 'category',
        location: 'location',
      },
      colorRules: [{ field: 'category', value: 'meeting', color: '#00f' }],
      config: {},
      filterInfo: { mode: 'upcoming' },
    } as any)

    expect(ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://unit.test/api/multitable/views/view_calendar',
      expect.objectContaining({
        method: 'PATCH',
        body: expect.stringContaining('"defaultView":"week"'),
      }),
    )
    const [, init] = fetchSpy.mock.calls[0]!
    expect(JSON.parse(String(init?.body))).toMatchObject({
      name: 'Calendar',
      type: 'calendar',
      filterInfo: { mode: 'upcoming' },
      config: expect.objectContaining({
        description: 'Ops calendar',
        defaultView: 'week',
        weekStartsOn: 1,
        timeFormat: 24,
        colorRules: [{ field: 'category', value: 'meeting', color: '#00f' }],
      }),
    })
  })
})
