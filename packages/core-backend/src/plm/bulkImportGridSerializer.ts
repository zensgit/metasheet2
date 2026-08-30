/**
 * MetaSheet bulk item-property maintenance grid — serializer + report model.
 *
 * Provider taskbook (authoritative, merged on Yuantus main):
 *   docs/development/DEVELOPMENT_TASK_METASHEET_BULK_GRID_CONSUMER_20260829.md
 *
 * ## N1 — the clause that, if dropped, ships a grid that destroys data
 *
 * `POST /api/v1/bulk-import/commit` does NOT merge on update. It REPLACES:
 *
 *     item.properties = {k: v for k, v in row.items() if k in declared_property_names}
 *     (yuantus src/yuantus/meta_engine/services/bulk_import_commit_service.py, whose own
 *      comment says "overwrite ... wholesale")
 *
 * Therefore: **any declared property column this serializer fails to emit is silently
 * deleted from every matched row.** No error, no warning, no row_error — the report says
 * `ready: true` and the commit looks like a success.
 *
 * The single invariant that prevents that, and the reason this module exists:
 *
 *   > The header and every record's key set are derived from the **declared property list
 *   > fetched from PLM** — NEVER from the rendered column set, NEVER from `Object.keys(row)`.
 *
 * `Object.keys(row)` is the specific footgun: a row that simply has no value for a column
 * would omit it, which is exactly N1's silent-delete. Records are therefore built by
 * projecting each row ONTO the declared list, filling absent values with an empty cell
 * (N1-c), never by reading back what the row happens to contain.
 *
 * Hidden, collapsed, off-viewport, virtualized and newly-added-in-PLM columns are all
 * serialized identically to visible ones, because the visible set is never consulted here.
 *
 * N1-b (fetch the declared list fresh per submission) is the caller's obligation and is
 * enforced at the route/adapter layer, not here.
 *
 * N1-d (mutation obligation) is discharged by `tests/unit/plm-bulk-grid-serializer.test.ts`:
 * `assertSerializedGridRoundTripsAllDeclaredColumns` below is the SHARED oracle used by both
 * the production-path assertion and the mutant assertion, so one mutation fires the sibling
 * assert rather than leaving it false-green.
 */

/** A declared property of the target ItemType, as returned by `GET /api/v1/aml/metadata/{itemType}`. */
export interface PlmBulkGridDeclaredProperty {
  name: string
  label?: string
  type?: string
  required?: boolean
  length?: number | null
}

/** One grid row as the operator edited it. Keys are property names; missing keys are normal. */
export type PlmBulkGridRow = Record<string, unknown>

/** A `row_errors` entry (taskbook §3.1 — every entry carries these four fields). */
export interface PlmBulkImportRowError {
  row_number: number
  property_name?: string
  error_code: string
  message: string
}

/** The dry-run / commit report envelope. */
export interface PlmBulkImportReport {
  ready: boolean
  row_errors: PlmBulkImportRowError[]
  /** File-level counts. There is NO per-row new-vs-updated verdict — see §3.1. */
  would_create?: number
  would_update?: number
  /** File-level, non-fatal: unknown columns are stripped before write, never orphaned. */
  unknown_columns?: string[]
  created_ids?: string[]
  updated_ids?: string[]
}

/**
 * The declared column order for a submission. This is the ONLY place a header is derived.
 * Order follows PLM's declared order so the report's `row_number` maps to grid rows directly.
 */
export function declaredColumnNames(declared: readonly PlmBulkGridDeclaredProperty[]): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const property of declared) {
    const name = typeof property?.name === 'string' ? property.name.trim() : ''
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

/**
 * Coerce one cell to its serialized text form.
 *
 * N1-c: absent/null/undefined becomes an EMPTY CELL, never an omitted column. An empty
 * optional cell is skipped by the provider validator; an absent REQUIRED column raises
 * MISSING_REQUIRED_VALUE, which is loud and therefore safe.
 */
export function serializeCellValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString()
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/**
 * N1-a + N1-c: project every row onto the DECLARED column list.
 *
 * Every returned record has exactly one key per declared column, in declared order, with an
 * empty string where the row carries no value. The row's own key set is never used to decide
 * which columns exist — it is only ever read *through* the declared list.
 */
export function buildBulkGridRecords(
  declared: readonly PlmBulkGridDeclaredProperty[],
  rows: readonly PlmBulkGridRow[],
): Array<Record<string, string>> {
  const columns = declaredColumnNames(declared)
  return rows.map((row) => {
    const record: Record<string, string> = {}
    for (const column of columns) {
      // Deliberately indexed BY DECLARED COLUMN, never iterated from the row.
      record[column] = serializeCellValue(row ? row[column] : undefined)
    }
    return record
  })
}

/** RFC4180 field escaping. */
function escapeCsvField(value: string): string {
  if (value === '') return ''
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

/**
 * Serialize the grid to CSV. The header is `declaredColumnNames(declared)` — the full
 * declared set — and each record is emitted in that same order.
 *
 * Both CSV and .xlsx are accepted by the provider (detected by filename suffix or
 * content-type, xlsx winning ties) and converge on the identical validation core, so the
 * report is byte-identical either way. CSV is chosen as the default wire form because it is
 * dependency-free and diffable; `serializeBulkGridToXlsx` is available for parity.
 */
export function serializeBulkGridToCsv(
  declared: readonly PlmBulkGridDeclaredProperty[],
  rows: readonly PlmBulkGridRow[],
): string {
  const columns = declaredColumnNames(declared)
  const records = buildBulkGridRecords(declared, rows)
  const lines: string[] = [columns.map(escapeCsvField).join(',')]
  for (const record of records) {
    lines.push(columns.map((column) => escapeCsvField(record[column] ?? '')).join(','))
  }
  return lines.join('\r\n')
}

/**
 * Parse a CSV produced by `serializeBulkGridToCsv` back into its header + records. Used by
 * the N1 oracle so the assertion inspects the ACTUAL serialized bytes rather than the
 * in-memory records — a serializer that builds correct records but drops a column while
 * writing them out must still be caught.
 */
export function parseCsvForVerification(csv: string): { header: string[]; records: Array<Record<string, string>> } {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i]
    if (inQuotes) {
      if (char === '"') {
        if (csv[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\r') {
      // consume the \n of a \r\n pair below
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  row.push(field)
  rows.push(row)

  const header = rows.shift() ?? []
  const records = rows
    .filter((entry) => !(entry.length === 1 && entry[0] === ''))
    .map((entry) => {
      const record: Record<string, string> = {}
      header.forEach((column, index) => {
        record[column] = entry[index] ?? ''
      })
      return record
    })
  return { header, records }
}

/**
 * N1 ORACLE — the shared, load-bearing check.
 *
 * Both the production-path test and the mutation test call THIS function, so a serializer
 * that drops a declared column fails the same assertion in both directions. Returns the list
 * of violations; empty means the round trip is whole.
 *
 * Checks, against the serialized CSV text (not the intermediate records):
 *   1. the header contains EVERY declared column (the silent-delete condition);
 *   2. the header contains no column that is not declared;
 *   3. every data row carries a cell for every declared column (empty is fine, absent is not).
 */
export function assertSerializedGridRoundTripsAllDeclaredColumns(
  declared: readonly PlmBulkGridDeclaredProperty[],
  rowCount: number,
  csv: string,
): string[] {
  const expected = declaredColumnNames(declared)
  const { header, records } = parseCsvForVerification(csv)
  const violations: string[] = []

  for (const column of expected) {
    if (!header.includes(column)) {
      violations.push(
        `declared column "${column}" is MISSING from the serialized header — commit would wholesale-delete it from every matched row (N1)`,
      )
    }
  }
  for (const column of header) {
    if (!expected.includes(column)) {
      violations.push(`serialized header carries undeclared column "${column}"`)
    }
  }
  if (records.length !== rowCount) {
    violations.push(`serialized ${records.length} data rows, expected ${rowCount}`)
  }
  records.forEach((record, index) => {
    for (const column of expected) {
      if (!(column in record)) {
        violations.push(`row ${index + 1} has no cell for declared column "${column}" (N1-c: empty, never omitted)`)
      }
    }
  })
  return violations
}

/**
 * Normalize a provider report. `ready` is the ONLY success discriminator (§3): a total
 * rejection is HTTP **200** with `ready: false` and writes nothing, so any caller that
 * branches on the status code mistakes a total rejection for a success. Absent/non-boolean
 * `ready` is treated as NOT ready — fail closed.
 */
export function normalizeBulkImportReport(payload: unknown): PlmBulkImportReport {
  const source = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const rawErrors = Array.isArray(source.row_errors) ? source.row_errors : []
  const row_errors: PlmBulkImportRowError[] = rawErrors
    .map((entry) => {
      const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
      const rowNumber = typeof record.row_number === 'number' ? record.row_number : Number(record.row_number)
      if (!Number.isFinite(rowNumber)) return null
      return {
        row_number: rowNumber,
        ...(typeof record.property_name === 'string' ? { property_name: record.property_name } : {}),
        error_code: typeof record.error_code === 'string' ? record.error_code : 'UNKNOWN',
        message: typeof record.message === 'string' ? record.message : '',
      }
    })
    .filter((entry): entry is PlmBulkImportRowError => entry !== null)

  const numberOrUndefined = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const stringArrayOrUndefined = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined

  const wouldCreate = numberOrUndefined(source.would_create)
  const wouldUpdate = numberOrUndefined(source.would_update)
  const unknownColumns = stringArrayOrUndefined(source.unknown_columns)
  const createdIds = stringArrayOrUndefined(source.created_ids)
  const updatedIds = stringArrayOrUndefined(source.updated_ids)

  return {
    ready: source.ready === true,
    row_errors,
    ...(wouldCreate !== undefined ? { would_create: wouldCreate } : {}),
    ...(wouldUpdate !== undefined ? { would_update: wouldUpdate } : {}),
    ...(unknownColumns !== undefined ? { unknown_columns: unknownColumns } : {}),
    ...(createdIds !== undefined ? { created_ids: createdIds } : {}),
    ...(updatedIds !== undefined ? { updated_ids: updatedIds } : {}),
  }
}

/**
 * PARKED — no live caller. Kept for the owner's N3 disposition (§12.2), not used today.
 *
 * This scans the grid's OWN loaded rows for duplicate match values. That is a real check, but
 * it is **not** the check N3-A asks for: §6 requires uniqueness "for that `ItemType` in that
 * tenant", and a grid holding a single `P-100` row says nothing about a tenant that holds two
 * items numbered `P-100`. Wiring this in as though it discharged N3-A is precisely the mistake
 * to avoid — it would look like a uniqueness guarantee while checking a population of one.
 *
 * The consumer therefore ships **create-only** and refuses `match_property` outright; see
 * `n3RefuseUpdateMode` in `src/routes/plm-bulk-import.ts` for why none of the three routes to
 * establishing uniqueness is open from here. When the owner rules on N3 this becomes one half
 * of the eventual precondition (the intra-grid half); the tenant-population half has to come
 * from the provider, since §7 forbids the consumer synthesizing it by probing.
 */
export function findDuplicateMatchValues(
  rows: readonly PlmBulkGridRow[],
  matchProperty: string,
): string[] {
  if (!matchProperty) return []
  const counts = new Map<string, number>()
  for (const row of rows) {
    const value = serializeCellValue(row ? row[matchProperty] : undefined).trim()
    if (!value) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value)
}

/**
 * Idempotency-Key shape guard (§11): non-blank after strip, at most 64 characters, or the
 * provider returns 400. Minting is the caller's job — a NEW key whenever any cell changes.
 */
export function isValidIdempotencyKey(key: string | null | undefined): boolean {
  if (typeof key !== 'string') return false
  const trimmed = key.trim()
  return trimmed.length > 0 && trimmed.length <= 64
}
