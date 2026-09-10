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
// so the same guard covers both surfaces.
//
// CSV/FORMULA INJECTION GUARD IS OPT-IN (`{ guardFormulas: true }`), default OFF. B3, an adversarial
// review of the move above: `plmCsv.ts`'s `downloadCsvFile` already backs EIGHT existing PLM export
// flows (`usePlmExportActions.ts`, via `PlmProductView.vue`'s `downloadCsv`), and those export plain
// numeric fields — a BOM line quantity of `-1` is a real, unremarkable value there. Turning formula
// guarding on unconditionally would have silently rewritten every negative quantity in those exports
// into the TEXT `'-1`, a behavior change no one asked for on a surface this PR does not otherwise
// touch. The guard is real and still lives here — the 缺件清单 panel opts into it explicitly on every
// call, because ITS cells are a customer's own external part numbers reaching a spreadsheet for the
// first time — but every pre-existing caller (via `plmCsv.ts`'s re-export, using no options) keeps
// its exact prior byte-for-byte output.
//
// A cell whose text starts with a character a spreadsheet reads as a formula prefix (`=`, `+`, `-`,
// `@`, a raw tab, or a carriage return) is prefixed with a leading apostrophe when guarding is on,
// which every mainstream spreadsheet renders as literal text instead of evaluating.
export interface CsvCellOptions {
  /** Opt-in CSV/formula-injection guard. Default false — see the module comment above (B3). */
  guardFormulas?: boolean
}

const CSV_INJECTION_PREFIX_RE = /^[=+\-@\t\r]/

function guardFormulaInjection(text: string): string {
  return CSV_INJECTION_PREFIX_RE.test(text) ? `'${text}` : text
}

export function escapeCsvCell(value: unknown, options: CsvCellOptions = {}): string {
  const raw = value === undefined || value === null ? '' : String(value)
  const text = options.guardFormulas ? guardFormulaInjection(raw) : raw
  // `\r` is included alongside `"`/`,`/`\n` (2026-09 fix, #5): a guarded value that itself STARTS
  // with a carriage return (`guardFormulaInjection` prefixes it with `'` rather than removing it)
  // must still be quote-wrapped, or the raw CR ships unescaped into a single-line CSV field and
  // corrupts the row for any reader that treats bare CR as a line break.
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

/**
 * Same injection guard as `escapeCsvCell` (also opt-in, also default off), sized for tab-separated
 * clipboard text rather than a quoted .csv field: a stray tab or newline inside a value would
 * otherwise misalign the pasted columns, so both are flattened to a single space instead of being
 * quote-escaped.
 */
export function escapeTsvCell(value: unknown, options: CsvCellOptions = {}): string {
  const raw = value === undefined || value === null ? '' : String(value)
  const text = options.guardFormulas ? guardFormulaInjection(raw) : raw
  return text.replace(/[\t\r\n]/g, ' ')
}

export function downloadCsvFile(
  filename: string,
  headers: string[],
  rows: Array<Array<unknown>>,
  options: CsvCellOptions = {},
): void {
  const lines = [
    headers.map((header) => escapeCsvCell(header, options)).join(','),
    ...rows.map((row) => row.map((cell) => escapeCsvCell(cell, options)).join(',')),
  ]
  const blob = new Blob([`\ufeff${lines.join('\n')}`], { type: 'text/csv;charset=utf-8;' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename
  link.click()
  URL.revokeObjectURL(link.href)
}
