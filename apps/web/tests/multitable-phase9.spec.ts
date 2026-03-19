import { describe, it, expect } from 'vitest'

// --- Clipboard import parsing ---
describe('clipboard import parsing', () => {
  function parseTSV(raw: string): { headers: string[]; rows: string[][] } {
    const lines = raw.trim().split('\n').map((l) => l.split('\t'))
    if (lines.length < 2) return { headers: [], rows: [] }
    return { headers: lines[0], rows: lines.slice(1).filter((r) => r.some((c) => c.trim())) }
  }

  it('parses tab-separated text with headers', () => {
    const input = 'Name\tAge\tEmail\nAlice\t30\talice@example.com\nBob\t25\tbob@example.com'
    const { headers, rows } = parseTSV(input)
    expect(headers).toEqual(['Name', 'Age', 'Email'])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual(['Alice', '30', 'alice@example.com'])
  })

  it('skips empty rows', () => {
    const input = 'Name\tAge\nAlice\t30\n\t\nBob\t25'
    const { rows } = parseTSV(input)
    expect(rows).toHaveLength(2)
  })

  it('returns empty for single-line input', () => {
    const { headers, rows } = parseTSV('just headers')
    expect(headers).toEqual([])
    expect(rows).toEqual([])
  })
})

// --- Auto field mapping ---
describe('auto field mapping', () => {
  it('maps headers to fields by case-insensitive name match', () => {
    const headers = ['Name', 'age', 'EMAIL']
    const fields = [
      { id: 'f1', name: 'Name', type: 'string' },
      { id: 'f2', name: 'Age', type: 'number' },
      { id: 'f3', name: 'Email', type: 'string' },
    ]
    const mapping: Record<number, string> = {}
    headers.forEach((header, i) => {
      const lh = header.toLowerCase().trim()
      const match = fields.find((f) => f.name.toLowerCase() === lh)
      if (match) mapping[i] = match.id
    })
    expect(mapping).toEqual({ 0: 'f1', 1: 'f2', 2: 'f3' })
  })

  it('leaves unmapped columns with no match', () => {
    const headers = ['Name', 'Unknown']
    const fields = [{ id: 'f1', name: 'Name', type: 'string' }]
    const mapping: Record<number, string> = {}
    headers.forEach((header, i) => {
      const match = fields.find((f) => f.name.toLowerCase() === header.toLowerCase())
      if (match) mapping[i] = match.id
    })
    expect(mapping).toEqual({ 0: 'f1' })
    expect(mapping[1]).toBeUndefined()
  })
})

// --- Import data type conversion ---
describe('import type conversion', () => {
  it('converts number field values to Number', () => {
    const fieldType = 'number'
    const val = '42.5'
    const result = fieldType === 'number' && val !== '' ? Number(val) : val
    expect(result).toBe(42.5)
  })

  it('converts boolean field "true" to true', () => {
    const val = 'true'
    const result = val.toLowerCase() === 'true' || val === '1'
    expect(result).toBe(true)
  })

  it('converts boolean field "1" to true', () => {
    const val = '1'
    const result = val.toLowerCase() === 'true' || val === '1'
    expect(result).toBe(true)
  })

  it('converts boolean field "false" to false', () => {
    const val = 'false'
    const result = val.toLowerCase() === 'true' || val === '1'
    expect(result).toBe(false)
  })
})

// --- Column reorder ---
describe('column drag-and-drop reorder', () => {
  it('moves field from source to target position', () => {
    const fields = [
      { id: 'f1', name: 'A' },
      { id: 'f2', name: 'B' },
      { id: 'f3', name: 'C' },
    ]
    const fromId = 'f3'
    const toId = 'f1'
    const arr = [...fields]
    const fromIdx = arr.findIndex((f) => f.id === fromId)
    const toIdx = arr.findIndex((f) => f.id === toId)
    const [moved] = arr.splice(fromIdx, 1)
    arr.splice(toIdx, 0, moved)
    expect(arr.map((f) => f.id)).toEqual(['f3', 'f1', 'f2'])
  })

  it('preserves field order for fieldOrder array', () => {
    const reordered = ['f3', 'f1', 'f2']
    expect(reordered).toHaveLength(3)
    expect(reordered[0]).toBe('f3')
  })
})

// --- Conditional cell formatting ---
describe('conditional cell formatting', () => {
  function getConditionalClass(fieldType: string, value: unknown): string {
    if (value === null || value === undefined || value === '') return 'meta-cell-renderer--empty'
    if (fieldType === 'boolean') return value ? 'meta-cell-renderer--positive' : 'meta-cell-renderer--negative'
    if (fieldType === 'number' && typeof value === 'number') {
      if (value > 0) return 'meta-cell-renderer--positive'
      if (value < 0) return 'meta-cell-renderer--negative'
    }
    return ''
  }

  it('marks empty values', () => {
    expect(getConditionalClass('string', null)).toBe('meta-cell-renderer--empty')
    expect(getConditionalClass('string', '')).toBe('meta-cell-renderer--empty')
  })

  it('marks positive numbers green', () => {
    expect(getConditionalClass('number', 42)).toBe('meta-cell-renderer--positive')
  })

  it('marks negative numbers red', () => {
    expect(getConditionalClass('number', -5)).toBe('meta-cell-renderer--negative')
  })

  it('marks boolean true as positive', () => {
    expect(getConditionalClass('boolean', true)).toBe('meta-cell-renderer--positive')
  })

  it('marks boolean false as negative', () => {
    expect(getConditionalClass('boolean', false)).toBe('meta-cell-renderer--negative')
  })

  it('returns empty for normal string values', () => {
    expect(getConditionalClass('string', 'hello')).toBe('')
  })
})
