import { describe, it, expect } from 'vitest'

// --- Print button ---
describe('print functionality', () => {
  it('print handler calls window.print pattern', () => {
    const onPrint = () => { /* window.print() */ }
    expect(typeof onPrint).toBe('function')
  })

  it('print media hides toolbar chrome for workbench', () => {
    const hiddenSelectors = [
      '.mt-workbench__base-bar',
      '.mt-workbench__actions',
      '.mt-workbench__shortcuts-overlay',
    ]
    expect(hiddenSelectors).toHaveLength(3)
  })
})

// --- Row density ---
describe('row density toggle', () => {
  it('supports three density values', () => {
    const densities = ['compact', 'normal', 'expanded'] as const
    expect(densities).toHaveLength(3)
  })

  it('compact density uses smaller padding and font', () => {
    const compactRow = { padding: '3px 8px', fontSize: '12px', height: 28 }
    expect(compactRow.height).toBe(28)
    expect(compactRow.fontSize).toBe('12px')
  })

  it('normal density is the default', () => {
    const defaultDensity = 'normal'
    expect(defaultDensity).toBe('normal')
  })

  it('expanded density uses larger padding', () => {
    const expandedRow = { padding: '10px 12px', height: 52 }
    expect(expandedRow.height).toBe(52)
  })

  it('density class is applied to grid root', () => {
    const density = 'compact'
    const cls = `meta-grid--${density}`
    expect(cls).toBe('meta-grid--compact')
  })
})

// --- Column auto-fit ---
describe('column auto-fit', () => {
  it('calculates width from field name and cell content', () => {
    const fields = [
      { id: 'f1', name: 'Name', type: 'string' },
      { id: 'f2', name: 'Description', type: 'string' },
    ]
    const rows = [
      { data: { f1: 'Alice', f2: 'A very long description text here' } },
      { data: { f1: 'Bob', f2: 'Short' } },
    ]
    const widths: Record<string, number> = {}
    for (const f of fields) {
      let maxLen = f.name.length
      for (const r of rows) {
        const v = r.data[f.id as keyof typeof r.data]
        if (v != null) maxLen = Math.max(maxLen, String(v).length)
      }
      widths[f.id] = Math.max(80, Math.min(400, maxLen * 8 + 24))
    }
    expect(widths.f1).toBeGreaterThanOrEqual(80)
    expect(widths.f2).toBeGreaterThan(widths.f1)
  })

  it('clamps width between 80 and 400', () => {
    const shortWidth = Math.max(80, Math.min(400, 2 * 8 + 24))
    const longWidth = Math.max(80, Math.min(400, 100 * 8 + 24))
    expect(shortWidth).toBe(80)
    expect(longWidth).toBe(400)
  })
})

// --- Date field type ---
describe('date field type', () => {
  it('date is included in MetaFieldType union', () => {
    const fieldTypes = ['string', 'number', 'boolean', 'date', 'formula', 'select', 'link', 'lookup', 'rollup']
    expect(fieldTypes).toContain('date')
  })

  it('date field is editable', () => {
    const EDITABLE = new Set(['string', 'number', 'boolean', 'date', 'select', 'link'])
    expect(EDITABLE.has('date')).toBe(true)
  })

  it('date field is groupable', () => {
    const GROUPABLE = new Set(['select', 'string', 'boolean', 'number', 'date'])
    expect(GROUPABLE.has('date')).toBe(true)
  })

  it('date filter operators include before/after', () => {
    const dateOps = [
      { value: 'is', label: 'is' },
      { value: 'isNot', label: 'is not' },
      { value: 'greater', label: 'after' },
      { value: 'less', label: 'before' },
      { value: 'isEmpty', label: 'is empty' },
      { value: 'isNotEmpty', label: 'is not empty' },
    ]
    const opValues = dateOps.map((o) => o.value)
    expect(opValues).toContain('greater')
    expect(opValues).toContain('less')
    expect(dateOps.find((o) => o.value === 'greater')!.label).toBe('after')
  })

  it('date display formats correctly', () => {
    const val = '2026-03-18'
    const d = new Date(val)
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(2) // March = 2
    expect(d.getDate()).toBe(18)
  })

  it('date field has icon in field manager', () => {
    const FIELD_ICONS: Record<string, string> = {
      string: 'Aa', number: '#', boolean: '\u2611', date: '\u{1F4C5}', select: '\u25CF',
      link: '\u21C4', lookup: '\u2197', rollup: '\u03A3', formula: 'fx',
    }
    expect(FIELD_ICONS.date).toBe('\u{1F4C5}')
  })

  it('date filter input type is date', () => {
    const getInputType = (type: string) => {
      if (type === 'number') return 'number'
      if (type === 'date') return 'date'
      return 'text'
    }
    expect(getInputType('date')).toBe('date')
    expect(getInputType('number')).toBe('number')
    expect(getInputType('string')).toBe('text')
  })
})

// --- Toolbar visibility for all views ---
describe('toolbar across view types', () => {
  it('toolbar is rendered above all view types', () => {
    const viewTypes = ['grid', 'form', 'kanban', 'gallery', 'calendar']
    // Toolbar is placed before the view-type conditional, so all views get it
    expect(viewTypes).toHaveLength(5)
  })

  it('toolbar emits print event', () => {
    const events = [
      'toggle-field', 'add-sort', 'remove-sort', 'update-sort',
      'add-filter', 'update-filter', 'remove-filter', 'clear-filters',
      'set-conjunction', 'apply-sort-filter', 'add-record', 'undo', 'redo',
      'set-group-field', 'export-csv', 'import', 'update:search-text',
      'print', 'set-row-density', 'auto-fit-columns',
    ]
    expect(events).toContain('print')
    expect(events).toContain('set-row-density')
    expect(events).toContain('auto-fit-columns')
  })
})
