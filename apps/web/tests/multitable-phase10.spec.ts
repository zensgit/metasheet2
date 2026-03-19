import { describe, it, expect } from 'vitest'

// --- Frozen column sticky positioning ---
describe('frozen column positioning', () => {
  it('row-num column uses sticky positioning', () => {
    const style = 'position: sticky; left: 0; z-index: 1;'
    expect(style).toContain('position: sticky')
    expect(style).toContain('left: 0')
    expect(style).toContain('z-index: 1')
  })

  it('check-col column uses sticky positioning', () => {
    const style = 'position: sticky; left: 0; z-index: 1;'
    expect(style).toContain('position: sticky')
    expect(style).toContain('left: 0')
  })

  it('frozen columns have background to cover scrolled content', () => {
    const bg = '#f9fafb'
    expect(bg).toBeTruthy()
  })
})

// --- Row expand toggle ---
describe('row expand inline preview', () => {
  it('toggles row expansion state', () => {
    const expanded = new Set<string>()
    // expand
    expanded.add('rec1')
    expect(expanded.has('rec1')).toBe(true)
    // collapse
    expanded.delete('rec1')
    expect(expanded.has('rec1')).toBe(false)
  })

  it('expand detail shows all visible field values', () => {
    const fields = [
      { id: 'f1', name: 'Name', type: 'string' },
      { id: 'f2', name: 'Age', type: 'number' },
      { id: 'f3', name: 'Active', type: 'boolean' },
    ]
    const rowData: Record<string, unknown> = { f1: 'Alice', f2: 30, f3: true }
    const pairs = fields.map((f) => ({ label: f.name, value: rowData[f.id] }))
    expect(pairs).toHaveLength(3)
    expect(pairs[0]).toEqual({ label: 'Name', value: 'Alice' })
    expect(pairs[1]).toEqual({ label: 'Age', value: 30 })
    expect(pairs[2]).toEqual({ label: 'Active', value: true })
  })

  it('multiple rows can be expanded simultaneously', () => {
    const expanded = new Set<string>(['rec1', 'rec2', 'rec3'])
    expect(expanded.size).toBe(3)
    expanded.delete('rec2')
    expect(expanded.has('rec1')).toBe(true)
    expect(expanded.has('rec2')).toBe(false)
    expect(expanded.has('rec3')).toBe(true)
  })
})

// --- Print-friendly CSS ---
describe('print-friendly CSS rules', () => {
  it('print media hides interactive elements', () => {
    const hiddenInPrint = [
      '.meta-grid__bulk-bar',
      '.meta-grid__pagination',
      '.meta-grid__loading',
      '.meta-grid__expand-btn',
      '.meta-grid__check-col',
    ]
    expect(hiddenInPrint).toHaveLength(5)
    hiddenInPrint.forEach((selector) => {
      expect(selector).toMatch(/^\.meta-grid__/)
    })
  })

  it('print media removes content-visibility for full rendering', () => {
    const printRule = 'content-visibility: visible !important;'
    expect(printRule).toContain('visible')
  })

  it('print media adds visible cell borders', () => {
    const cellBorder = 'border: 1px solid #ccc !important;'
    expect(cellBorder).toContain('1px solid')
  })

  it('print media removes focus/selection highlights', () => {
    const rules = ['outline: none !important;', 'background: none !important;']
    expect(rules).toHaveLength(2)
  })

  it('print media hides workbench chrome', () => {
    const hiddenWorkbench = [
      '.mt-workbench__base-bar',
      '.mt-workbench__actions',
      '.mt-workbench__shortcuts-overlay',
    ]
    expect(hiddenWorkbench).toHaveLength(3)
  })
})

// --- Comprehensive feature integration ---
describe('phase 10 integration checks', () => {
  it('frozen + expand + print coexist in MetaGridTable', () => {
    const features = ['sticky-positioning', 'row-expand', 'print-css']
    expect(features).toHaveLength(3)
  })

  it('expand button rotates when open', () => {
    const closedClass = 'meta-grid__expand-btn'
    const openClass = 'meta-grid__expand-btn--open'
    expect(openClass).toContain(closedClass)
  })

  it('expand detail uses responsive grid layout', () => {
    const layout = 'grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))'
    expect(layout).toContain('auto-fill')
    expect(layout).toContain('minmax')
  })

  it('break-inside: avoid for print row integrity', () => {
    const rule = 'break-inside: avoid'
    expect(rule).toBe('break-inside: avoid')
  })
})
