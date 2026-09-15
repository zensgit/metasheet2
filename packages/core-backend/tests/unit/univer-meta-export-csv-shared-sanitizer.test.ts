/**
 * CSV shared-sanitizer migration (owner-scoped hygiene slice, chore/csv-shared-sanitizer).
 *
 * `buildExportCsv` (multitable/univer-meta CSV export) used to hand-roll its own RFC-4180-only
 * escape function. This asserts its output against the shared `csv-cell.ts` helper
 * (`sanitizeCsvRow`/`sanitizeCsvCell`) it now delegates to, on TWO axes:
 *
 *   1. Byte-for-byte parity for plain/RFC-4180-special values (comma/quote/CR+LF) — column
 *      order, header text, and the CRLF row terminator are unchanged from the pre-migration
 *      hand-rolled escaper.
 *   2. A formula-injection positive control — the one INTENTIONAL addition the shared helper
 *      brings to this endpoint: a cell whose stringified value starts with a formula-injection
 *      lead character now gets a defensive leading apostrophe.
 */
import { describe, expect, it } from 'vitest'
import { buildExportCsv } from '../../src/routes/univer-meta'

describe('univer-meta buildExportCsv — shared csv-cell.ts sanitizer migration', () => {
  it('produces byte-identical output for plain and RFC-4180-special cells', () => {
    const headers = ['Name', 'Notes']
    const rows: Array<Array<string | number | boolean | null | undefined>> = [
      ['Alice', 'Hello, "World"'],
      ['Bob', 'Line1\r\nLine2'],
      ['Carol', null],
      ['Dave', undefined],
      ['Eve', true],
      ['Frank', 42],
    ]

    const csv = buildExportCsv(headers, rows)

    expect(csv).toBe(
      [
        'Name,Notes',
        'Alice,"Hello, ""World"""',
        'Bob,"Line1\r\nLine2"',
        'Carol,',
        'Dave,',
        'Eve,true',
        'Frank,42',
      ].join('\r\n'),
    )
  })

  it('positive control: neutralizes a formula-injection lead character (new behavior)', () => {
    const headers = ['Field']
    const rows: Array<Array<string | number | boolean | null | undefined>> = [
      ['=SUM(A1:A2)'],
      ['+1+1'],
      ['-1'],
      ['@cmd'],
      ['\ttab-led'],
      ['normal'],
    ]

    const csv = buildExportCsv(headers, rows)

    expect(csv).toBe(
      [
        'Field',
        "'=SUM(A1:A2)",
        "'+1+1",
        "'-1",
        "'@cmd",
        "'\ttab-led",
        'normal',
      ].join('\r\n'),
    )
  })

  // P1-3 (csv-helper gate, DISCLOSURE — behavior intentionally unchanged, contract-sanctioned):
  // `-` is one of the seven ratified `CSV_FORMULA_INJECTION_LEAD_CHARS`, so a numeric cell whose
  // value is negative gets the same defensive leading apostrophe as a string starting with `-`.
  // This is the one export of the four migrated in this slice whose payload is user DATA rather
  // than an audit trail (`rows` here comes from `serializeXlsxCell` on real record field values —
  // see `univer-meta.ts:15035-15045` / `xlsx-service.ts:344`), so a negative-number column (e.g.
  // Amount/Delta/Balance) round-trips into Excel/Sheets as apostrophe-prefixed TEXT, not a number
  // — SUM/sort/chart over that column break. A field NAME starting with `-` or `=` gets the same
  // treatment in the header row, which also affects the CSV-import round-trip
  // (`apps/web/src/multitable/components/MetaImportModal.vue`). This test pins the CURRENT
  // behavior with a hand-typed expected value; whether the lead-char set should be narrowed for
  // numeric cells is an owner call, not something this slice decides.
  it('DISCLOSURE (pinned, not a defect): a negative-number cell and a formula-leading header both get the apostrophe prefix', () => {
    const headers = ['Amount', '-Delta', '=Total']
    const rows: Array<Array<string | number | boolean | null | undefined>> = [
      [-123, -0.5, 7],
      [1, 2, 3],
    ]

    const csv = buildExportCsv(headers, rows)

    expect(csv).toBe(
      ["Amount,'-Delta,'=Total", "'-123,'-0.5,7", '1,2,3'].join('\r\n'),
    )
  })
})
