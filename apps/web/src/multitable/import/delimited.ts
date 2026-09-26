import type { MetaField } from '../types'
import { importCancelled, importDateTimeInvalid, importResolverMissing, importValueResolveFailed } from '../utils/meta-import-labels'
import { isLinkField, isNativePersonField, isPersonField } from '../utils/link-fields'
import { parseDateTimeTextToUtcMs, resolveDateTimeTimezone } from '../utils/business-timezone'

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

/**
 * #5809 — per-build context handed to a resolver. `signal` aborts when the user cancels the import
 * while the records are still being built, so a resolver can drop lookups it has only queued.
 */
export type ImportResolveContext = { signal?: AbortSignal }

export type ImportValueResolver = ((rawValue: string, field: MetaField, context?: ImportResolveContext) => Promise<unknown | null> | unknown) & {
  /**
   * #5809 — optional look-ahead. Called once per build, BEFORE the row loop, with every non-empty raw
   * value of the field's column (row order, overridden cells left out), so a resolver can queue its
   * bounded per-token lookups for the whole import instead of one row at a time. Fire-and-forget: it
   * decides nothing — every cell is still resolved (and fails) through the resolver call itself — and
   * anything it throws is ignored.
   */
  prime?: (rawValues: string[], field: MetaField, context?: ImportResolveContext) => void
}

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

/** #5809 — the rejection a cancelled build ends with (same shape bulk-import uses: name `AbortError`). */
export function createImportAbortError(isZh = false): Error {
  const error = new Error(importCancelled(isZh))
  error.name = 'AbortError'
  return error
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
  isZh?: boolean
  /**
   * #5809 — aborting it stops the build: no further row is resolved, resolvers receive it (so queued
   * lookups can be dropped), and the promise rejects with an `AbortError` instead of returning records.
   */
  signal?: AbortSignal
}): Promise<ImportBuildResult> {
  const { parsedRows, fieldMapping, fields, fieldResolvers = {}, fieldOverrides = {}, isZh = false, signal } = params
  const records: Array<Record<string, unknown>> = []
  const rowIndexes: number[] = []
  const failures: ImportBuildFailure[] = []
  const throwIfAborted = () => {
    if (signal?.aborted) throw createImportAbortError(isZh)
  }
  const resolveContext: ImportResolveContext | undefined = signal ? { signal } : undefined

  throwIfAborted()
  primeFieldResolvers({ parsedRows, fieldMapping, fields, fieldResolvers, fieldOverrides, context: resolveContext })

  for (const [rowIndex, row] of parsedRows.entries()) {
    throwIfAborted()
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
      } else if (field?.type === 'dateTime') {
        // 客户反馈 2026-09-24 #4c (B1): a dateTime cell is the SAME `YYYY-MM-DD HH:mm` business wall clock the
        // export writes (zone rule: explicit non-UTC field zone, else the business zone); an absolute ISO
        // string keeps its instant. Parsed HERE (not left to the server) so the row failure names the field
        // in the import preview instead of a generic 400, and so a zone-less string is never read in the
        // browser's zone. Unparseable non-empty text fails the ROW (values-free message) — never dropped,
        // never stored as raw text.
        const rawValue = val.trim()
        if (!rawValue) {
          data[fieldId] = null
          continue
        }
        const ms = parseDateTimeTextToUtcMs(rawValue, resolveDateTimeTimezone(field.property))
        if (ms === null) {
          rowFailure = importDateTimeInvalid(field.name, isZh)
          failingField = field
          break
        }
        data[fieldId] = new Date(ms).toISOString()
      } else if (field && (isLinkField(field) || isNativePersonField(field))) {
        // Link, legacy link-backed person (isLinkField), OR native person (isNativePersonField).
        // All three resolve a delimited token to an id[] via the injected resolver; the resolver
        // itself is kind-aware (native person → userIds, legacy person → People recordIds, link →
        // linked recordIds).
        const rawValue = val.trim()
        if (!rawValue) {
          data[fieldId] = []
          continue
        }
        const resolver = fieldResolvers[fieldId]
        if (!resolver) {
          rowFailure = importResolverMissing(field.name, isPersonField(field) ? 'person' : 'link', isZh)
          failingField = field
          break
        }
        let resolved: unknown | null
        try {
          resolved = await (resolveContext ? resolver(rawValue, field, resolveContext) : resolver(rawValue, field))
        } catch (error: any) {
          rowFailure = error?.message ?? importValueResolveFailed(field.name, rawValue, isPersonField(field) ? 'person' : 'link', isZh)
          failingField = field
          break
        }
        if (resolved === null || resolved === undefined) {
          rowFailure = importValueResolveFailed(field.name, rawValue, isPersonField(field) ? 'person' : 'link', isZh)
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

  // A cancel during the last row (even one whose resolver ignored the signal) still rejects.
  throwIfAborted()
  return { records, rowIndexes, failures }
}

function primeFieldResolvers(params: {
  parsedRows: string[][]
  fieldMapping: Record<number, string>
  fields: MetaField[]
  fieldResolvers: Record<string, ImportValueResolver>
  fieldOverrides: ImportFieldOverrides
  context?: ImportResolveContext
}) {
  const { parsedRows, fieldMapping, fields, fieldResolvers, fieldOverrides, context } = params
  for (const [colIdx, fieldId] of Object.entries(fieldMapping)) {
    if (!fieldId) continue
    const prime = fieldResolvers[fieldId]?.prime
    const field = fields.find((candidate) => candidate.id === fieldId)
    if (!prime || !field || !(isLinkField(field) || isNativePersonField(field))) continue
    const rawValues: string[] = []
    for (const [rowIndex, row] of parsedRows.entries()) {
      if (fieldOverrides[rowIndex]?.[fieldId] !== undefined) continue
      const rawValue = (row[Number(colIdx)] ?? '').trim()
      if (rawValue) rawValues.push(rawValue)
    }
    if (!rawValues.length) continue
    try {
      prime(rawValues, field, context)
    } catch {
      // Look-ahead only: the row loop resolves every cell itself.
    }
  }
}
