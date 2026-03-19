import type { MetaField } from '../types'

export type DelimitedParseResult = {
  delimiter: ',' | '\t'
  rows: string[][]
}

function countDelimiter(text: string, delimiter: ',' | '\t'): number {
  let count = 0
  let inQuotes = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (!inQuotes && ch === delimiter) count += 1
    if (!inQuotes && (ch === '\n' || ch === '\r')) break
  }
  return count
}

function detectDelimiter(text: string): ',' | '\t' {
  const tabs = countDelimiter(text, '\t')
  const commas = countDelimiter(text, ',')
  return tabs >= commas && tabs > 0 ? '\t' : ','
}

export function parseDelimitedText(input: string): DelimitedParseResult {
  const text = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  if (!text) return { delimiter: '\t', rows: [] }

  const delimiter = detectDelimiter(text)
  const rows: string[][] = []
  let cell = ''
  let row: string[] = []
  let inQuotes = false

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cell += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (!inQuotes && ch === delimiter) {
      row.push(cell)
      cell = ''
      continue
    }
    if (!inQuotes && ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      continue
    }
    cell += ch
  }

  row.push(cell)
  rows.push(row)
  return { delimiter, rows }
}

export function buildImportedRecords(params: {
  parsedRows: string[][]
  fieldMapping: Record<number, string>
  fields: MetaField[]
}): Array<Record<string, unknown>> {
  const { parsedRows, fieldMapping, fields } = params
  const records: Array<Record<string, unknown>> = []

  for (const row of parsedRows) {
    const data: Record<string, unknown> = {}
    for (const [colIdx, fieldId] of Object.entries(fieldMapping)) {
      if (!fieldId) continue
      const val = row[Number(colIdx)] ?? ''
      const field = fields.find((f) => f.id === fieldId)
      if (field?.type === 'number' && val !== '') data[fieldId] = Number(val)
      else if (field?.type === 'boolean') data[fieldId] = val.toLowerCase() === 'true' || val === '1'
      else if (field?.type === 'date' && val !== '') {
        const d = new Date(val)
        data[fieldId] = !Number.isNaN(d.getTime()) ? d.toISOString().split('T')[0] : val
      } else data[fieldId] = val
    }
    if (Object.keys(data).length) records.push(data)
  }

  return records
}
