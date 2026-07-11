// S5 report xlsx export (attendance benchmark remaining-plan): the attendance
// report download offered only CSV, which Excel mis-guesses as ANSI/GBK
// (Chinese → 乱码 without the BOM the CSV path prepends). This produces a real
// .xlsx from the SAME server-rendered CSV — zero backend change, every report
// field/fingerprint stays identical. SheetJS loads via dynamic import so it
// never enters the main bundle (same discipline as importXlsxConvert.ts).

export const REPORT_XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** Convert server report CSV text into .xlsx bytes. Reuses SheetJS's CSV
 *  parser (quote-aware) so the sheet mirrors the CSV exactly. */
export async function csvTextToXlsxArrayBuffer(csvText: string): Promise<ArrayBuffer> {
  const XLSX = await import('xlsx')
  // read the CSV as a workbook (first/only sheet), then write it as xlsx.
  const workbook = XLSX.read(csvText ?? '', { type: 'string', raw: true })
  const out = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
  return out
}

/** Swap a .csv download filename for its .xlsx sibling (keeps any prefix). */
export function xlsxFilenameFromCsv(csvFilename: string): string {
  const base = String(csvFilename || 'attendance-export.csv').trim()
  if (/\.xlsx$/i.test(base)) return base
  if (/\.csv$/i.test(base)) return base.replace(/\.csv$/i, '.xlsx')
  return `${base}.xlsx`
}
