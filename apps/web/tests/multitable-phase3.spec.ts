import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { useMultitableGrid } from '../src/multitable/composables/useMultitableGrid'
import { useMultitableWorkbench } from '../src/multitable/composables/useMultitableWorkbench'
import { MultitableApiClient } from '../src/multitable/api/client'

function mockClient(data: any = {}) {
  return new MultitableApiClient({
    fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data }), { status: 200 })),
  })
}

function mockClientWithFn(fetchFn: ReturnType<typeof vi.fn>) {
  return new MultitableApiClient({ fetchFn })
}

// --- Column width persistence ---
describe('column width persistence', () => {
  const store: Record<string, string> = {}
  const mockLocalStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = val },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { Object.keys(store).forEach((k) => delete store[k]) },
    get length() { return Object.keys(store).length },
    key: (i: number) => Object.keys(store)[i] ?? null,
  }

  beforeEach(() => {
    mockLocalStorage.clear()
    Object.defineProperty(globalThis, 'localStorage', { value: mockLocalStorage, writable: true, configurable: true })
  })

  it('persists column widths to localStorage', () => {
    const client = mockClient()
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })
    grid.setColumnWidth('f1', 200)
    const key = 'mt_col_widths_s1_v1'
    const stored = JSON.parse(store[key] ?? '{}')
    expect(stored.f1).toBe(200)
  })

  it('loads column widths from localStorage', () => {
    const key = 'mt_col_widths_s2_v2'
    store[key] = JSON.stringify({ f1: 150, f2: 300 })
    const client = mockClient()
    const grid = useMultitableGrid({ sheetId: ref('s2'), viewId: ref('v2'), client })
    expect(grid.columnWidths.value.f1).toBe(150)
    expect(grid.columnWidths.value.f2).toBe(300)
  })

  it('handles corrupted localStorage gracefully', () => {
    const key = 'mt_col_widths_s3_v3'
    store[key] = 'NOT_JSON'
    const client = mockClient()
    const grid = useMultitableGrid({ sheetId: ref('s3'), viewId: ref('v3'), client })
    expect(grid.columnWidths.value).toEqual({})
  })
})

// --- Workbench: field management ---
describe('workbench field management', () => {
  it('createField calls API and returns field', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { field: { id: 'f_new', name: 'Age', type: 'number' } } }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    const result = await client.createField({ sheetId: 's1', name: 'Age', type: 'number' })
    expect(result.field.id).toBe('f_new')
    expect(result.field.name).toBe('Age')
    expect(fetchFn).toHaveBeenCalledWith('/api/multitable/fields', expect.objectContaining({ method: 'POST' }))
  })

  it('updateField calls PATCH endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { field: { id: 'f1', name: 'Renamed' } } }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    const result = await client.updateField('f1', { name: 'Renamed' })
    expect(result.field.name).toBe('Renamed')
    expect(fetchFn).toHaveBeenCalledWith('/api/multitable/fields/f1', expect.objectContaining({ method: 'PATCH' }))
  })

  it('deleteField calls DELETE endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { deleted: 'f1' } }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    const result = await client.deleteField('f1')
    expect(result.deleted).toBe('f1')
    expect(fetchFn).toHaveBeenCalledWith('/api/multitable/fields/f1', expect.objectContaining({ method: 'DELETE' }))
  })
})

// --- Workbench: view management ---
describe('workbench view management', () => {
  it('createView calls POST and returns view', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { view: { id: 'v_new', sheetId: 's1', name: 'Kanban', type: 'kanban' } } }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    const result = await client.createView({ sheetId: 's1', name: 'Kanban', type: 'kanban' })
    expect(result.view.type).toBe('kanban')
    expect(fetchFn).toHaveBeenCalledWith('/api/multitable/views', expect.objectContaining({ method: 'POST' }))
  })

  it('deleteView calls DELETE endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { deleted: 'v1' } }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    const result = await client.deleteView('v1')
    expect(result.deleted).toBe('v1')
  })
})

// --- Base management ---
describe('base management API', () => {
  it('listBases calls correct endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { bases: [{ id: 'b1', name: 'Base 1' }] } }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    const result = await client.listBases()
    expect(result.bases).toHaveLength(1)
    expect(fetchFn).toHaveBeenCalledWith('/api/multitable/bases')
  })

  it('createBase calls POST', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { base: { id: 'b_new', name: 'New Base' } } }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    const result = await client.createBase({ name: 'New Base' })
    expect(result.base.name).toBe('New Base')
  })

  it('listTemplates calls the template catalog endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: { templates: [{ id: 'project-tracker', name: 'Project Tracker', description: '', category: 'Project management', icon: 'kanban', color: '#2563eb', sheets: [] }] },
      }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    const result = await client.listTemplates()
    expect(result.templates[0].id).toBe('project-tracker')
    expect(fetchFn).toHaveBeenCalledWith('/api/multitable/templates')
  })

  it('installTemplate calls the template install endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: {
          template: { id: 'project-tracker', name: 'Project Tracker', description: '', category: 'Project management', icon: 'kanban', color: '#2563eb', sheets: [] },
          base: { id: 'base_new', name: 'Project Tracker' },
          sheets: [],
          fields: [],
          views: [],
        },
      }), { status: 201 }),
    )
    const client = mockClientWithFn(fetchFn)
    const result = await client.installTemplate('project-tracker', { baseName: 'Launch Base' })
    expect(result.base.id).toBe('base_new')
    expect(fetchFn).toHaveBeenCalledWith('/api/multitable/templates/project-tracker/install', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).baseName).toBe('Launch Base')
  })

  it('loadContext calls correct endpoint with params', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: { base: { id: 'b1', name: 'Base' }, sheets: [], views: [], capabilities: {} },
      }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    const result = await client.loadContext({ baseId: 'b1' })
    expect(result.sheets).toEqual([])
    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/multitable/context'))
    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('baseId=b1'))
  })
})

// --- Form submit ---
describe('form submit API', () => {
  it('submitForm calls correct endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: { mode: 'create', record: { id: 'r1', version: 1, data: {} }, commentsScope: {} },
      }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    const result = await client.submitForm('v1', { data: { name: 'Alice' } })
    expect(result.mode).toBe('create')
    expect(fetchFn).toHaveBeenCalledWith('/api/multitable/views/v1/submit', expect.objectContaining({ method: 'POST' }))
  })

  it('submitForm sends recordId for updates', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: { mode: 'update', record: { id: 'r1', version: 2, data: {} }, commentsScope: {} },
      }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    await client.submitForm('v1', { recordId: 'r1', expectedVersion: 1, data: { name: 'Bob' } })
    const body = JSON.parse(fetchFn.mock.calls[0][1].body)
    expect(body.recordId).toBe('r1')
    expect(body.expectedVersion).toBe(1)
  })
})

// --- Backend capabilities ---
describe('backend capabilities in useMultitableCapabilities', () => {
  it('accepts MetaCapabilities object', async () => {
    const { useMultitableCapabilities } = await import('../src/multitable/composables/useMultitableCapabilities')
    const caps = useMultitableCapabilities(ref({
      canRead: true,
      canCreateRecord: false,
      canEditRecord: true,
      canDeleteRecord: false,
      canManageFields: true,
      canManageSheetAccess: false,
      canManageViews: false,
      canComment: true,
      canManageAutomation: false, canExport: true,
    }))
    expect(caps.canRead.value).toBe(true)
    expect(caps.canCreateRecord.value).toBe(false)
    expect(caps.canManageFields.value).toBe(true)
    expect(caps.canManageSheetAccess.value).toBe(false)
    expect(caps.canManageViews.value).toBe(false)
  })

  it('falls back to viewer when source is null', async () => {
    const { useMultitableCapabilities } = await import('../src/multitable/composables/useMultitableCapabilities')
    const caps = useMultitableCapabilities(ref(null))
    expect(caps.canRead.value).toBe(true)
    expect(caps.canCreateRecord.value).toBe(false)
    expect(caps.canManageFields.value).toBe(false)
    expect(caps.canManageSheetAccess.value).toBe(false)
  })
})
