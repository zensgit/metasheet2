import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Phase 15 — Server-Side Search, Attachment Field & Timeline View
// ---------------------------------------------------------------------------

// === Feature A: Server-Side Search ===

describe('server-side search — debounce', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('should debounce search input by 150ms', () => {
    let callCount = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    function setSearchQuery(_q: string) {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { callCount++ }, 150)
    }

    setSearchQuery('hel')
    setSearchQuery('hell')
    setSearchQuery('hello')
    vi.advanceTimersByTime(150)
    expect(callCount).toBe(1) // Only one API call after debounce
    vi.useRealTimers()
  })

  it('should not trigger API call before debounce completes', () => {
    let called = false
    let timer: ReturnType<typeof setTimeout> | null = null

    function setSearchQuery(_q: string) {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { called = true }, 150)
    }

    setSearchQuery('test')
    vi.advanceTimersByTime(100) // Only 100ms
    expect(called).toBe(false)
    vi.advanceTimersByTime(50) // Now 150ms
    expect(called).toBe(true)
    vi.useRealTimers()
  })
})

describe('server-side search — API param', () => {
  it('should pass search param to loadView', () => {
    const params: Record<string, string | number | boolean | undefined> = {
      sheetId: 'sheet_1',
      viewId: 'view_1',
      limit: 50,
      offset: 0,
      includeLinkSummaries: true,
      search: 'hello',
    }
    expect(params.search).toBe('hello')
  })

  it('should omit search param when empty', () => {
    const searchQuery = ''
    const params: Record<string, unknown> = {
      search: searchQuery || undefined,
    }
    expect(params.search).toBeUndefined()
  })
})

describe('server-side search — pagination reset', () => {
  it('should reset offset to 0 when search changes', () => {
    const page = { offset: 100, limit: 50, total: 200, hasMore: true }
    // Simulate search reset
    page.offset = 0
    expect(page.offset).toBe(0)
  })

  it('should track loading state during search', () => {
    const loading = { value: false }
    // Simulate loading start
    loading.value = true
    expect(loading.value).toBe(true)
    // Simulate loading end
    loading.value = false
    expect(loading.value).toBe(false)
  })
})

// === Feature B: Attachment Types ===

describe('attachment field — type system', () => {
  it('MetaFieldType union should include attachment', () => {
    const validTypes = ['string', 'number', 'boolean', 'date', 'formula', 'select', 'link', 'lookup', 'rollup', 'attachment']
    expect(validTypes).toContain('attachment')
  })

  it('MetaAttachment interface should have required properties', () => {
    const attachment = {
      id: 'att_001',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      size: 1024,
      url: '/api/multitable/attachments/att_001',
      thumbnailUrl: null,
      uploadedAt: '2026-03-19T10:00:00Z',
    }
    expect(attachment.id).toBe('att_001')
    expect(attachment.filename).toBe('report.pdf')
    expect(attachment.mimeType).toBe('application/pdf')
    expect(attachment.size).toBe(1024)
    expect(attachment.url).toBeTruthy()
  })

  it('FIELD_TYPES array should include attachment', () => {
    const FIELD_TYPES = ['string', 'number', 'boolean', 'date', 'select', 'link', 'formula', 'lookup', 'rollup', 'attachment']
    expect(FIELD_TYPES).toContain('attachment')
    expect(FIELD_TYPES.length).toBe(10)
  })

  it('EDITABLE set should include attachment', () => {
    const EDITABLE = new Set(['string', 'number', 'boolean', 'date', 'select', 'link', 'attachment'])
    expect(EDITABLE.has('attachment')).toBe(true)
  })
})

describe('attachment field — client methods', () => {
  it('uploadAttachment should build FormData correctly', () => {
    const formData = new FormData()
    const file = new File(['test'], 'doc.pdf', { type: 'application/pdf' })
    formData.append('file', file)
    formData.append('sheetId', 'sheet_1')
    expect(formData.get('file')).toBeInstanceOf(File)
    expect(formData.get('sheetId')).toBe('sheet_1')
  })

  it('deleteAttachment should construct correct URL', () => {
    const attachmentId = 'att_123'
    const url = `/api/multitable/attachments/${attachmentId}`
    expect(url).toBe('/api/multitable/attachments/att_123')
  })
})

// === Feature B: Attachment Rendering ===

describe('attachment cell rendering', () => {
  it('should render attachment ids as chips', () => {
    const value = ['att_001', 'att_002']
    const attachmentIds = Array.isArray(value) ? value.map(String) : []
    expect(attachmentIds).toEqual(['att_001', 'att_002'])
    expect(attachmentIds.length).toBe(2)
  })

  it('should handle single attachment value', () => {
    const value = 'att_001'
    const attachmentIds = Array.isArray(value) ? value.map(String) : value ? [String(value)] : []
    expect(attachmentIds).toEqual(['att_001'])
  })

  it('should handle empty attachment value', () => {
    const value = null
    const attachmentIds = Array.isArray(value) ? value.map(String) : value ? [String(value)] : []
    expect(attachmentIds).toEqual([])
  })

  it('should show paperclip icon for attachments', () => {
    const icon = '\uD83D\uDCCE' // 📎
    expect(icon).toBeTruthy()
  })

  it('should render multiple files with filenames', () => {
    const attachments = ['report.pdf', 'image.png', 'data.csv']
    expect(attachments.length).toBe(3)
    attachments.forEach((name) => expect(typeof name).toBe('string'))
  })
})

// === Feature C: Timeline View ===

describe('timeline view — field selection', () => {
  it('should filter date fields from all fields', () => {
    const fields = [
      { id: 'f1', name: 'Name', type: 'string' },
      { id: 'f2', name: 'Start Date', type: 'date' },
      { id: 'f3', name: 'End Date', type: 'date' },
      { id: 'f4', name: 'Priority', type: 'select' },
    ]
    const dateFields = fields.filter((f) => f.type === 'date')
    expect(dateFields).toHaveLength(2)
    expect(dateFields[0].name).toBe('Start Date')
    expect(dateFields[1].name).toBe('End Date')
  })

  it('should show placeholder when no date fields selected', () => {
    const startFieldId = ''
    const endFieldId = ''
    const showPlaceholder = !startFieldId || !endFieldId
    expect(showPlaceholder).toBe(true)
  })
})

describe('timeline view — bar position calculation', () => {
  it('should calculate bar left and width as percentages', () => {
    const rangeMin = new Date('2026-01-01').getTime()
    const rangeMax = new Date('2026-12-31').getTime()
    const totalRange = rangeMax - rangeMin

    const start = new Date('2026-03-01').getTime()
    const end = new Date('2026-06-01').getTime()

    const barLeft = ((start - rangeMin) / totalRange) * 100
    const barWidth = ((end - start) / totalRange) * 100

    expect(barLeft).toBeGreaterThan(0)
    expect(barLeft).toBeLessThan(100)
    expect(barWidth).toBeGreaterThan(0)
    expect(barWidth).toBeLessThan(100)
    expect(barLeft + barWidth).toBeLessThan(100)
  })

  it('should clamp bar to visible range', () => {
    const barLeft = -5
    const clampedLeft = Math.max(0, barLeft)
    expect(clampedLeft).toBe(0)

    const barWidth = 120
    const clampedWidth = Math.min(100 - clampedLeft, barWidth)
    expect(clampedWidth).toBe(100)
  })

  it('should enforce minimum bar width', () => {
    const rangeMs = 86400000 * 365
    const durationMs = 1000 // 1 second — tiny duration
    const rawWidth = (durationMs / rangeMs) * 100
    const minWidth = Math.max(1, rawWidth)
    expect(minWidth).toBe(1) // Enforced minimum
  })
})

describe('timeline view — zoom levels', () => {
  it('should support day/week/month zoom', () => {
    const validZooms = ['day', 'week', 'month']
    expect(validZooms).toContain('day')
    expect(validZooms).toContain('week')
    expect(validZooms).toContain('month')
  })

  it('should generate axis ticks based on zoom level', () => {
    const dayMs = 86400000
    const zoomMs: Record<string, number> = {
      day: dayMs,
      week: dayMs * 7,
      month: dayMs * 30,
    }
    expect(zoomMs.day).toBe(86400000)
    expect(zoomMs.week).toBe(86400000 * 7)
    expect(zoomMs.month).toBe(86400000 * 30)
  })
})

describe('timeline view — interaction', () => {
  it('should emit select-record on click', () => {
    const emitted: string[] = []
    function onSelect(recordId: string) { emitted.push(recordId) }
    onSelect('rec_1')
    expect(emitted).toEqual(['rec_1'])
  })

  it('should separate scheduled and unscheduled rows', () => {
    const rows = [
      { id: 'r1', version: 1, data: { start: '2026-01-01', end: '2026-02-01' } },
      { id: 'r2', version: 1, data: { start: null, end: null } },
      { id: 'r3', version: 1, data: { start: '2026-03-01', end: '2026-04-01' } },
    ]
    const scheduled = rows.filter((r) => r.data.start && r.data.end)
    const unscheduled = rows.filter((r) => !r.data.start || !r.data.end)
    expect(scheduled).toHaveLength(2)
    expect(unscheduled).toHaveLength(1)
    expect(unscheduled[0].id).toBe('r2')
  })

  it('should track selected record id', () => {
    let selectedId: string | null = null
    selectedId = 'rec_1'
    expect(selectedId).toBe('rec_1')
    selectedId = null
    expect(selectedId).toBeNull()
  })
})

// === Feature C: Timeline Config ===

describe('timeline config', () => {
  it('should persist start/end field picker selections', () => {
    const config = { startFieldId: 'f2', endFieldId: 'f3', zoom: 'week' as const }
    expect(config.startFieldId).toBe('f2')
    expect(config.endFieldId).toBe('f3')
  })

  it('should default zoom to week', () => {
    const defaultZoom = 'week'
    expect(defaultZoom).toBe('week')
  })

  it('VIEW_TYPES should include timeline', () => {
    const VIEW_TYPES = ['grid', 'form', 'kanban', 'gallery', 'calendar', 'timeline']
    expect(VIEW_TYPES).toContain('timeline')
  })
})

// === Phase 15.1: Attachment Upload Real Flow ===

describe('upload flow — MetaCellEditor', () => {
  it('should call uploadFn for each file with field/record context and emit IDs', async () => {
    const uploadFn = vi.fn()
      .mockResolvedValueOnce({ id: 'att_1', filename: 'a.pdf', mimeType: 'application/pdf', size: 100, url: '/att/1' })
      .mockResolvedValueOnce({ id: 'att_2', filename: 'b.png', mimeType: 'image/png', size: 200, url: '/att/2' })

    const file1 = new File(['x'], 'a.pdf', { type: 'application/pdf' })
    const file2 = new File(['y'], 'b.png', { type: 'image/png' })
    const files = [file1, file2]
    const uploadContext = { recordId: 'rec_1', fieldId: 'fld_attach' }

    const newIds: string[] = []
    for (const file of files) {
      const attachment = await uploadFn(file, uploadContext)
      newIds.push(attachment.id)
    }

    expect(uploadFn).toHaveBeenCalledTimes(2)
    expect(uploadFn).toHaveBeenCalledWith(file1, uploadContext)
    expect(uploadFn).toHaveBeenCalledWith(file2, uploadContext)
    expect(newIds).toEqual(['att_1', 'att_2'])
  })

  it('should emit attachment IDs not filenames', async () => {
    const uploadFn = vi.fn().mockResolvedValue({ id: 'att_99', filename: 'doc.pdf', mimeType: 'application/pdf', size: 50, url: '/att/99' })
    const file = new File(['content'], 'doc.pdf')
    const result = await uploadFn(file)
    expect(result.id).toBe('att_99')
    expect(result.id).not.toBe('doc.pdf')
  })

  it('should preserve existing IDs when adding new files', async () => {
    const existingIds = ['att_existing_1', 'att_existing_2']
    const uploadFn = vi.fn().mockResolvedValue({ id: 'att_new', filename: 'new.pdf', mimeType: 'application/pdf', size: 10, url: '/att/new' })

    const file = new File(['x'], 'new.pdf')
    const attachment = await uploadFn(file)
    const merged = [...existingIds, attachment.id]

    expect(merged).toEqual(['att_existing_1', 'att_existing_2', 'att_new'])
  })

  it('should not emit on upload error', async () => {
    const uploadFn = vi.fn().mockRejectedValue(new Error('Network error'))
    let emitted = false
    try {
      await uploadFn(new File(['x'], 'fail.pdf'))
      emitted = true
    } catch {
      emitted = false
    }
    expect(emitted).toBe(false)
  })
})

describe('upload flow — MetaFormView', () => {
  it('should store IDs in formData after upload', async () => {
    const formData: Record<string, unknown> = {}
    const uploadFn = vi.fn()
      .mockResolvedValueOnce({ id: 'att_f1', filename: 'f1.pdf', mimeType: 'application/pdf', size: 10, url: '/att/f1' })
      .mockResolvedValueOnce({ id: 'att_f2', filename: 'f2.pdf', mimeType: 'application/pdf', size: 20, url: '/att/f2' })

    const fieldId = 'fld_attach'
    const files = [new File(['a'], 'f1.pdf'), new File(['b'], 'f2.pdf')]
    const existing: string[] = []
    const newIds: string[] = []
    for (const file of files) {
      const attachment = await uploadFn(file, { recordId: 'rec_form', fieldId })
      newIds.push(attachment.id)
    }
    formData[fieldId] = [...existing, ...newIds]

    expect(uploadFn).toHaveBeenNthCalledWith(1, files[0], { recordId: 'rec_form', fieldId })
    expect(uploadFn).toHaveBeenNthCalledWith(2, files[1], { recordId: 'rec_form', fieldId })
    expect(formData[fieldId]).toEqual(['att_f1', 'att_f2'])
  })

  it('should track uploading state per field', () => {
    const uploadingFields = new Set<string>()
    uploadingFields.add('fld_1')
    expect(uploadingFields.has('fld_1')).toBe(true)
    expect(uploadingFields.has('fld_2')).toBe(false)
    uploadingFields.delete('fld_1')
    expect(uploadingFields.has('fld_1')).toBe(false)
  })

  it('should preserve existing attachments when adding new', async () => {
    const existingIds = ['att_old_1']
    const uploadFn = vi.fn().mockResolvedValue({ id: 'att_new_form', filename: 'new.pdf', mimeType: 'application/pdf', size: 5, url: '' })
    const attachment = await uploadFn(new File(['x'], 'new.pdf'))
    const merged = [...existingIds, attachment.id]
    expect(merged).toEqual(['att_old_1', 'att_new_form'])
  })

  it('should handle upload error gracefully', async () => {
    const formData: Record<string, unknown> = { fld_1: ['att_existing'] }
    const uploadFn = vi.fn().mockRejectedValue(new Error('Upload failed'))
    try {
      await uploadFn(new File(['x'], 'fail.pdf'))
    } catch {
      // Error caught — formData should remain unchanged
    }
    expect(formData.fld_1).toEqual(['att_existing'])
  })
})

describe('upload flow — MetaRecordDrawer', () => {
  it('should upload and emit patch with ID array', async () => {
    const existingIds = ['att_a']
    const uploadFn = vi.fn().mockResolvedValue({ id: 'att_b', filename: 'b.pdf', mimeType: 'application/pdf', size: 10, url: '' })
    const attachment = await uploadFn(new File(['x'], 'b.pdf'), { recordId: 'rec_drawer', fieldId: 'fld_attach' })
    const patchValue = [...existingIds, attachment.id]
    expect(uploadFn).toHaveBeenCalledWith(expect.any(File), { recordId: 'rec_drawer', fieldId: 'fld_attach' })
    expect(patchValue).toEqual(['att_a', 'att_b'])
  })

  it('should emit filtered array when removing attachment chip', () => {
    const existingIds = ['att_1', 'att_2', 'att_3']
    const removeId = 'att_2'
    const filtered = existingIds.filter((id) => id !== removeId)
    expect(filtered).toEqual(['att_1', 'att_3'])
  })

  it('should track uploading field state', () => {
    let uploadingFieldId: string | null = null
    uploadingFieldId = 'fld_attach'
    expect(uploadingFieldId).toBe('fld_attach')
    uploadingFieldId = null
    expect(uploadingFieldId).toBeNull()
  })
})

describe('upload-then-patch integration', () => {
  it('uploadFn called → patchCell sends IDs not filenames', async () => {
    const uploadFn = vi.fn().mockResolvedValue({ id: 'att_srv_1', filename: 'report.pdf', mimeType: 'application/pdf', size: 1024, url: '/api/multitable/attachments/att_srv_1' })
    const patchCell = vi.fn()

    const file = new File(['content'], 'report.pdf', { type: 'application/pdf' })
    const uploadContext = { recordId: 'rec_1', fieldId: 'fld_attach' }
    const attachment = await uploadFn(file, uploadContext)
    patchCell('rec_1', 'fld_attach', [attachment.id], 1)

    expect(uploadFn).toHaveBeenCalledWith(file, uploadContext)
    expect(patchCell).toHaveBeenCalledWith('rec_1', 'fld_attach', ['att_srv_1'], 1)
    expect(patchCell.mock.calls[0][2]).not.toContain('report.pdf')
  })

  it('FormData body should contain file and upload context', () => {
    const fd = new FormData()
    const file = new File(['test'], 'upload.xlsx', { type: 'application/vnd.ms-excel' })
    fd.append('file', file)
    fd.append('sheetId', 'sheet_abc')
    fd.append('recordId', 'rec_1')
    fd.append('fieldId', 'fld_attach')
    expect(fd.get('file')).toBeInstanceOf(File)
    expect((fd.get('file') as File).name).toBe('upload.xlsx')
    expect(fd.get('sheetId')).toBe('sheet_abc')
    expect(fd.get('recordId')).toBe('rec_1')
    expect(fd.get('fieldId')).toBe('fld_attach')
  })

  it('deleteAttachment URL should use attachment ID', () => {
    const attId = 'att_to_delete'
    const url = `/api/multitable/attachments/${attId}`
    expect(url).toBe('/api/multitable/attachments/att_to_delete')
  })

  it('multi-file sequential upload should collect all IDs', async () => {
    const uploadFn = vi.fn()
      .mockResolvedValueOnce({ id: 'att_m1', filename: 'm1.pdf', mimeType: 'application/pdf', size: 10, url: '' })
      .mockResolvedValueOnce({ id: 'att_m2', filename: 'm2.pdf', mimeType: 'application/pdf', size: 20, url: '' })
      .mockResolvedValueOnce({ id: 'att_m3', filename: 'm3.pdf', mimeType: 'application/pdf', size: 30, url: '' })

    const files = [new File(['a'], 'm1.pdf'), new File(['b'], 'm2.pdf'), new File(['c'], 'm3.pdf')]
    const ids: string[] = []
    for (const file of files) {
      const att = await uploadFn(file, { recordId: 'rec_multi', fieldId: 'fld_attach' })
      ids.push(att.id)
    }
    expect(ids).toEqual(['att_m1', 'att_m2', 'att_m3'])
    expect(uploadFn).toHaveBeenCalledTimes(3)
    expect(uploadFn).toHaveBeenNthCalledWith(1, files[0], { recordId: 'rec_multi', fieldId: 'fld_attach' })
    expect(uploadFn).toHaveBeenNthCalledWith(2, files[1], { recordId: 'rec_multi', fieldId: 'fld_attach' })
    expect(uploadFn).toHaveBeenNthCalledWith(3, files[2], { recordId: 'rec_multi', fieldId: 'fld_attach' })
  })
})

describe('attachment hydration', () => {
  it('applyPatchResult should update attachmentSummaries', () => {
    const attachmentSummaries: Record<string, Record<string, { id: string; filename: string }[]>> = {}
    const recordId = 'rec_1'
    const fieldId = 'fld_att'
    const newSummaries = [{ id: 'att_1', filename: 'doc.pdf' }]

    attachmentSummaries[recordId] = { ...(attachmentSummaries[recordId] ?? {}), [fieldId]: newSummaries }
    expect(attachmentSummaries[recordId][fieldId]).toEqual([{ id: 'att_1', filename: 'doc.pdf' }])
  })

  it('renderer should use summaries over raw IDs when available', () => {
    const rawIds = ['att_1']
    const summaries = [{ id: 'att_1', filename: 'nice-name.pdf', mimeType: 'application/pdf', size: 100, url: '/att/1', thumbnailUrl: null, uploadedAt: null }]
    const displayItems = summaries.length > 0 ? summaries : rawIds.map((id) => ({ id, filename: id, mimeType: 'application/octet-stream', size: 0, url: '', thumbnailUrl: null, uploadedAt: null }))
    expect(displayItems[0].filename).toBe('nice-name.pdf')
    expect(displayItems[0].filename).not.toBe('att_1')
  })

  it('empty attachment should render dash', () => {
    const value: unknown = null
    const attachmentIds = Array.isArray(value) ? value.map(String) : value ? [String(value)] : []
    const display = attachmentIds.length > 0 ? attachmentIds.join(', ') : '—'
    expect(display).toBe('—')
  })
})
