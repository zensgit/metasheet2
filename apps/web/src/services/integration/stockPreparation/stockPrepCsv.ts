// CSV/TSV helpers for the stock-prep surface.
//
// `escapeCsvCell`/`downloadCsvFile` were MOVED here from `apps/web/src/views/plm/plmCsv.ts` (kept
// there as a thin re-export — nothing that already imports from the old path has to change) so the
// 缺件清单 (missing-components) panel does not have to reach into `views/plm` for a generic utility
// that has nothing to do with the PLM product view.
//
// `escapeTsvCell` is NEW. The missing-components panel's "复制" button puts a tab-separated block on
// the clipboard so it pastes straight into a spreadsheet row-for-row; a part number pasted that way
// is exactly as capable of tripping spreadsheet formula evaluation as one written into a .csv file,
// so the same guard has to cover both surfaces, not just the file.
//
// CSV/FORMULA INJECTION. A cell whose text starts with a character a spreadsheet reads as a formula
// prefix (`=`, `+`, `-`, `@`, a raw tab, or a carriage return) is prefixed with a leading apostrophe,
// which every mainstream spreadsheet renders as literal text instead of evaluating. The values this
// panel puts in a cell — a PLM component number, a parent BOM id — are the customer's own external
// data read back verbatim from a system this app does not control, which is exactly the kind of
// string this guard exists for.
const CSV_INJECTION_PREFIX_RE = /^[=+\-@\t\r]/

function guardFormulaInjection(text: string): string {
  return CSV_INJECTION_PREFIX_RE.test(text) ? `'${text}` : text
}

export function escapeCsvCell(value: unknown): string {
  const raw = value === undefined || value === null ? '' : String(value)
  const guarded = guardFormulaInjection(raw)
  if (/[",\n]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`
  }
  return guarded
}

/**
 * Same injection guard as `escapeCsvCell`, sized for tab-separated clipboard text rather than a
 * quoted .csv field: a stray tab or newline inside a value would otherwise misalign the pasted
 * columns, so both are flattened to a single space instead of being quote-escaped.
 */
export function escapeTsvCell(value: unknown): string {
  const raw = value === undefined || value === null ? '' : String(value)
  const guarded = guardFormulaInjection(raw)
  return guarded.replace(/[\t\r\n]/g, ' ')
}

export function downloadCsvFile(filename: string, headers: string[], rows: Array<Array<unknown>>): void {
  const lines = [
    headers.map((header) => escapeCsvCell(header)).join(','),
    ...rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(',')),
  ]
  const blob = new Blob([`\ufeff${lines.join('\n')}`], { type: 'text/csv;charset=utf-8;' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename
  link.click()
  URL.revokeObjectURL(link.href)
}
