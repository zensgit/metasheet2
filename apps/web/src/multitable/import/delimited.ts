import type { MetaField } from '../types'
import { isLinkField, isPersonField } from '../utils/link-fields'

export type DelimitedParseResult = {
  delimiter: ',' | '\t'
  rows: string[][]
}

export type ImportBuildFailure = {
  rowIndex: number
  message: string
  retryable?: boolean
  fieldId?: string
  fieldName?: string
}

export type ImportValueResolver = (rawValue: string, field: MetaField) => Promise<unknown | null> | unknown

export type ImportBuildResult = {
  records: Array<Record<string, unknown>>
  rowIndexes: number[]
  failures: ImportBuildFailure[]
}

export type ImportFieldOverrides = Record<number, Record<string, unknown>>

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

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase()
}

export function extractImportTokens(rawValue: string): string[] {
  const value = rawValue.trim()
  if (!value) return []

  const tokens = new Set<string>()
  const addToken = (token: string) => {
    const normalized = normalizeLookupKey(token)
    if (normalized) tokens.add(normalized)
  }

  addToken(value)

  const angleMatch = value.match(/<([^>]+)>/)
  if (angleMatch?.[1]) addToken(angleMatch[1])

  const emailMatches = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) ?? []
  for (const match of emailMatches) addToken(match)

  if (/[,\n;，；、]/.test(value)) {
    for (const segment of value.split(/[,\n;，；、]/)) addToken(segment)
  }

  return [...tokens]
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

export async function buildImportedRecords(params: {
  parsedRows: string[][]
  fieldMapping: Record<number, string>
  fields: MetaField[]
  fieldResolvers?: Record<string, ImportValueResolver>
  fieldOverrides?: ImportFieldOverrides
}): Promise<ImportBuildResult> {
  const { parsedRows, fieldMapping, fields, fieldResolvers = {}, fieldOverrides = {} } = params
  const records: Array<Record<string, unknown>> = []
  const rowIndexes: number[] = []
  const failures: ImportBuildFailure[] = []

  for (const [rowIndex, row] of parsedRows.entries()) {
    const data: Record<string, unknown> = {}
    let rowFailure: string | null = null
    let failingField: MetaField | null = null
    for (const [colIdx, fieldId] of Object.entries(fieldMapping)) {
      if (!fieldId) continue
      const override = fieldOverrides[rowIndex]?.[fieldId]
      if (override !== undefined) {
        data[fieldId] = override
        continue
      }
      const val = row[Number(colIdx)] ?? ''
      const field = fields.find((f) => f.id === fieldId)
      if (field?.type === 'number' && val !== '') data[fieldId] = Number(val)
      else if (field?.type === 'boolean') data[fieldId] = val.toLowerCase() === 'true' || val === '1'
      else if (field?.type === 'date' && val !== '') {
        const d = new Date(val)
        data[fieldId] = !Number.isNaN(d.getTime()) ? d.toISOString().split('T')[0] : val
      } else if (field && isLinkField(field)) {
        const rawValue = val.trim()
        if (!rawValue) {
          data[fieldId] = []
          continue
        }
        const resolver = fieldResolvers[fieldId]
        if (!resolver) {
          rowFailure = isPersonField(field)
            ? `No import resolver is configured for people field ${field.name}`
            : `No import resolver is configured for linked field ${field.name}`
          failingField = field
          break
        }
        let resolved: unknown | null
        try {
          resolved = await resolver(rawValue, field)
        } catch (error: any) {
          rowFailure = error?.message ?? (isPersonField(field)
            ? `Unable to resolve people value for ${field.name}: ${rawValue}`
            : `Unable to resolve linked value for ${field.name}: ${rawValue}`)
          failingField = field
          break
        }
        if (resolved === null || resolved === undefined) {
          rowFailure = isPersonField(field)
            ? `Unable to resolve people value for ${field.name}: ${rawValue}`
            : `Unable to resolve linked value for ${field.name}: ${rawValue}`
          failingField = field
          break
        }
        data[fieldId] = resolved
      } else data[fieldId] = val
    }
    if (rowFailure) {
      failures.push({
        rowIndex,
        message: rowFailure,
        retryable: false,
        ...(failingField ? { fieldId: failingField.id, fieldName: failingField.name } : {}),
      })
      continue
    }
    if (Object.keys(data).length) {
      records.push(data)
      rowIndexes.push(rowIndex)
    }
  }

  return { records, rowIndexes, failures }
}
