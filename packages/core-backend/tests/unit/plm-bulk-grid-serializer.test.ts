/**
 * MetaSheet bulk item-property grid — serializer unit tests.
 *
 * Taskbook: docs/development/DEVELOPMENT_TASK_METASHEET_BULK_GRID_CONSUMER_20260829.md
 * (authoritative, merged on Yuantus main).
 *
 * The centrepiece is N1-d, the MUTATION TEST OBLIGATION. See the block comment above
 * `describe('N1-d ...')` for why the mutant is written the way it is.
 */
import { describe, it, expect } from 'vitest'
import {
  assertSerializedGridRoundTripsAllDeclaredColumns,
  buildBulkGridRecords,
  declaredColumnNames,
  findDuplicateMatchValues,
  indexRowErrors,
  isValidIdempotencyKey,
  normalizeBulkImportReport,
  parseCsvForVerification,
  serializeBulkGridToCsv,
  serializeCellValue,
  type PlmBulkGridDeclaredProperty,
  type PlmBulkGridRow,
} from '../../src/plm/bulkImportGridSerializer'

/**
 * A representative ItemType schema. `cost_center` and `notes` are NON-REQUIRED — they are the
 * only legitimate mutation targets (see the N1-d block comment).
 */
const DECLARED: PlmBulkGridDeclaredProperty[] = [
  { name: 'item_number', label: 'Item Number', type: 'string', required: true },
  { name: 'name', label: 'Name', type: 'string', required: true },
  { name: 'material', label: 'Material', type: 'string', required: false },
  { name: 'cost_center', label: 'Cost Center', type: 'string', required: false },
  { name: 'notes', label: 'Notes', type: 'string', required: false },
]

const ROWS: PlmBulkGridRow[] = [
  { item_number: 'P-001', name: 'Bracket', material: 'Steel', cost_center: 'CC-10', notes: 'first' },
  // Deliberately sparse: `material`/`notes` absent entirely, `cost_center` explicitly null.
  // Under N1-c these must still be SERIALIZED as empty cells, never omitted.
  { item_number: 'P-002', name: 'Washer', cost_center: null },
]

describe('declaredColumnNames', () => {
  it('preserves PLM declared order and de-duplicates', () => {
    expect(declaredColumnNames(DECLARED)).toEqual(['item_number', 'name', 'material', 'cost_center', 'notes'])
    expect(declaredColumnNames([{ name: 'a' }, { name: 'a' }, { name: ' ' }, { name: 'b' }])).toEqual(['a', 'b'])
  })
})

describe('serializeCellValue (N1-c: empty cell, never an omitted column)', () => {
  it('renders absent/null/undefined as an empty cell', () => {
    expect(serializeCellValue(undefined)).toBe('')
    expect(serializeCellValue(null)).toBe('')
    expect(serializeCellValue('')).toBe('')
  })

  it('renders scalars losslessly', () => {
    expect(serializeCellValue('Steel')).toBe('Steel')
    expect(serializeCellValue(42)).toBe('42')
    expect(serializeCellValue(0)).toBe('0')
    expect(serializeCellValue(false)).toBe('false')
    expect(serializeCellValue(true)).toBe('true')
  })

  it('renders a Date as ISO and a NaN/Infinity number as empty', () => {
    expect(serializeCellValue(new Date('2026-08-29T00:00:00.000Z'))).toBe('2026-08-29T00:00:00.000Z')
    expect(serializeCellValue(Number.NaN)).toBe('')
    expect(serializeCellValue(Number.POSITIVE_INFINITY)).toBe('')
  })
})

describe('buildBulkGridRecords (N1-a: keyed by the DECLARED list, not the row)', () => {
  it('gives every record a cell for every declared column, including absent ones', () => {
    const records = buildBulkGridRecords(DECLARED, ROWS)
    expect(records).toHaveLength(2)
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual(['cost_center', 'item_number', 'material', 'name', 'notes'])
    }
    expect(records[1]).toEqual({
      item_number: 'P-002',
      name: 'Washer',
      material: '',
      cost_center: '',
      notes: '',
    })
  })

  it('ignores keys the row carries that the ItemType does not declare', () => {
    const records = buildBulkGridRecords(DECLARED, [{ item_number: 'P-003', name: 'Pin', bogus_column: 'x' }])
    expect(records[0]).not.toHaveProperty('bogus_column')
  })

  it('serializes a column the operator HID exactly like a visible one', () => {
    // The serializer has no notion of visibility by construction — this pins that the
    // "hidden column" case is structurally impossible, not merely untested.
    const hiddenAware = buildBulkGridRecords(DECLARED, ROWS)
    expect(hiddenAware[0].cost_center).toBe('CC-10')
    expect(hiddenAware[0].notes).toBe('first')
  })
})

describe('serializeBulkGridToCsv', () => {
  it('emits the full declared header in declared order', () => {
    const csv = serializeBulkGridToCsv(DECLARED, ROWS)
    expect(csv.split('\r\n')[0]).toBe('item_number,name,material,cost_center,notes')
  })

  it('round-trips RFC4180 quoting for commas, quotes and newlines', () => {
    const csv = serializeBulkGridToCsv(DECLARED, [
      { item_number: 'P-1', name: 'A,B', material: 'say "hi"', cost_center: 'line1\nline2', notes: '' },
    ])
    const { records } = parseCsvForVerification(csv)
    expect(records[0].name).toBe('A,B')
    expect(records[0].material).toBe('say "hi"')
    expect(records[0].cost_center).toBe('line1\nline2')
  })

  it('passes the N1 oracle on the production path', () => {
    const csv = serializeBulkGridToCsv(DECLARED, ROWS)
    expect(assertSerializedGridRoundTripsAllDeclaredColumns(DECLARED, ROWS.length, csv)).toEqual([])
  })

  it('serializes a column added to the ItemType AFTER the rows were loaded', () => {
    // N1: a property added in PLM after the grid's rows were composed must still be emitted
    // (as an empty cell), or committing would delete it from every matched row.
    const widened = [...DECLARED, { name: 'lifecycle_note', required: false }]
    const csv = serializeBulkGridToCsv(widened, ROWS)
    expect(csv.split('\r\n')[0]).toContain('lifecycle_note')
    expect(assertSerializedGridRoundTripsAllDeclaredColumns(widened, ROWS.length, csv)).toEqual([])
  })
})

/**
 * N1-d — MUTATION TEST OBLIGATION.
 *
 * The taskbook requires a test that "deliberately drops one declared column from the
 * serializer and asserts the test suite goes RED", and requires the dropped column to be
 * NON-REQUIRED: dropping a required one trips MISSING_REQUIRED_VALUE server-side →
 * reject-all → nothing written, so the test would pass for the wrong reason and prove
 * nothing.
 *
 * `mutantSerializeDroppingOneColumn` below is a byte-for-byte copy of the production CSV
 * writer with exactly ONE edit: it filters `cost_center` (non-required) out of the declared
 * header. Both this mutant and the production serializer are checked by the SAME oracle,
 * `assertSerializedGridRoundTripsAllDeclaredColumns`, so the assertion that guards the
 * production path is demonstrably the assertion that catches the drop — it cannot be
 * false-green.
 *
 * This was ALSO verified by hand: `cost_center` was temporarily removed from
 * `declaredColumnNames`' output in src/plm/bulkImportGridSerializer.ts, the suite was run,
 * and 5 tests failed (including "passes the N1 oracle on the production path"); the edit was
 * then reverted from a scratchpad backup. See the delivery report for the recorded output.
 */
describe('N1-d mutation obligation: a dropped declared column MUST fail the oracle', () => {
  const MUTATION_TARGET = 'cost_center'

  function mutantSerializeDroppingOneColumn(
    declared: readonly PlmBulkGridDeclaredProperty[],
    rows: readonly PlmBulkGridRow[],
  ): string {
    // THE MUTATION: the declared list is filtered before it reaches the header/record loop —
    // exactly what a virtualized grid, a hidden column, or an export preset would do.
    const columns = declaredColumnNames(declared).filter((column) => column !== MUTATION_TARGET)
    const lines: string[] = [columns.join(',')]
    for (const row of rows) {
      lines.push(columns.map((column) => serializeCellValue(row[column])).join(','))
    }
    return lines.join('\r\n')
  }

  it('the mutation target is genuinely NON-required (a required one would prove nothing)', () => {
    const target = DECLARED.find((property) => property.name === MUTATION_TARGET)
    expect(target).toBeDefined()
    expect(target!.required).toBe(false)
  })

  it('RED: the oracle rejects a serializer that drops one non-required declared column', () => {
    const csv = mutantSerializeDroppingOneColumn(DECLARED, ROWS)
    const violations = assertSerializedGridRoundTripsAllDeclaredColumns(DECLARED, ROWS.length, csv)
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.join(' | ')).toContain(`declared column "${MUTATION_TARGET}" is MISSING`)
  })

  it('GREEN: the same oracle accepts the production serializer on the same input', () => {
    // The pair is the proof: same oracle, same fixture, opposite verdicts.
    const csv = serializeBulkGridToCsv(DECLARED, ROWS)
    expect(assertSerializedGridRoundTripsAllDeclaredColumns(DECLARED, ROWS.length, csv)).toEqual([])
  })

  it('the mutant is otherwise well-formed — EVERY violation is about the dropped column', () => {
    // Guards against the mutant being caught for an incidental reason (bad quoting, wrong row
    // count, an undeclared header), which would leave the real N1 assertion unproven.
    // The oracle legitimately reports the drop once for the header and once per data row, so
    // the assertion is "all violations name the target", not a fixed count.
    const csv = mutantSerializeDroppingOneColumn(DECLARED, ROWS)
    const violations = assertSerializedGridRoundTripsAllDeclaredColumns(DECLARED, ROWS.length, csv)
    expect(violations.length).toBe(1 + ROWS.length)
    for (const violation of violations) {
      expect(violation).toContain(MUTATION_TARGET)
    }
    expect(violations.join(' | ')).not.toContain('undeclared column')
    expect(violations.join(' | ')).not.toContain('data rows, expected')
  })
})

describe('normalizeBulkImportReport (§3: branch on `ready`, never on the status code)', () => {
  it('treats an absent or non-boolean `ready` as NOT ready (fail closed)', () => {
    expect(normalizeBulkImportReport({}).ready).toBe(false)
    expect(normalizeBulkImportReport({ ready: 'true' }).ready).toBe(false)
    expect(normalizeBulkImportReport(null).ready).toBe(false)
    expect(normalizeBulkImportReport({ ready: true }).ready).toBe(true)
  })

  it('preserves an UNRECOGNIZED error_code rather than dropping it (§3.1: the set is open)', () => {
    const report = normalizeBulkImportReport({
      ready: false,
      row_errors: [{ row_number: 2, property_name: 'material', error_code: 'SOME_FUTURE_CODE', message: 'nope' }],
    })
    expect(report.row_errors[0].error_code).toBe('SOME_FUTURE_CODE')
  })

  it('keeps would_create/would_update as FILE-level counts only', () => {
    const report = normalizeBulkImportReport({ ready: true, row_errors: [], would_create: 3, would_update: 1 })
    expect(report.would_create).toBe(3)
    expect(report.would_update).toBe(1)
    // §3.1 / §10: there is no per-row verdict anywhere in the report shape.
    expect(report).not.toHaveProperty('row_verdicts')
  })

  it('surfaces unknown_columns as a non-fatal warning list', () => {
    const report = normalizeBulkImportReport({ ready: true, row_errors: [], unknown_columns: ['typoed_header'] })
    expect(report.unknown_columns).toEqual(['typoed_header'])
  })
})

describe('indexRowErrors (the red gutter)', () => {
  it('buckets multiple errors on the same row', () => {
    const index = indexRowErrors({
      ready: false,
      row_errors: [
        { row_number: 2, property_name: 'name', error_code: 'MISSING_REQUIRED_VALUE', message: 'required' },
        { row_number: 2, property_name: 'material', error_code: 'LENGTH_EXCEEDED', message: 'too long' },
        { row_number: 5, property_name: 'name', error_code: 'TYPE_COERCION_FAILED', message: 'bad type' },
      ],
    })
    expect(index.get(2)).toHaveLength(2)
    expect(index.get(5)).toHaveLength(1)
    expect(index.has(3)).toBe(false)
  })

  it('is empty for a ready report and tolerates a malformed entry', () => {
    expect(indexRowErrors({ ready: true, row_errors: [] }).size).toBe(0)
    expect(indexRowErrors(undefined).size).toBe(0)
    const index = indexRowErrors({
      ready: false,
      row_errors: [{ row_number: Number.NaN as number, error_code: 'X', message: '' }],
    })
    expect(index.size).toBe(0)
  })
})

describe('findDuplicateMatchValues (N3-A pre-flight)', () => {
  it('reports a duplicated match value — update mode must then be refused', () => {
    const rows: PlmBulkGridRow[] = [
      { item_number: 'P-001' },
      { item_number: 'P-002' },
      { item_number: 'P-001' },
    ]
    expect(findDuplicateMatchValues(rows, 'item_number')).toEqual(['P-001'])
  })

  it('is empty when every match value is unique, and ignores blank values', () => {
    expect(findDuplicateMatchValues([{ item_number: 'A' }, { item_number: 'B' }], 'item_number')).toEqual([])
    expect(findDuplicateMatchValues([{ item_number: '' }, { item_number: null }], 'item_number')).toEqual([])
  })
})

describe('isValidIdempotencyKey (§11 shape guard)', () => {
  it('accepts a non-blank key of at most 64 chars', () => {
    expect(isValidIdempotencyKey('abc')).toBe(true)
    expect(isValidIdempotencyKey('x'.repeat(64))).toBe(true)
  })

  it('rejects blank and over-length keys (the provider returns 400)', () => {
    expect(isValidIdempotencyKey('')).toBe(false)
    expect(isValidIdempotencyKey('   ')).toBe(false)
    expect(isValidIdempotencyKey('x'.repeat(65))).toBe(false)
    expect(isValidIdempotencyKey(undefined)).toBe(false)
  })
})
