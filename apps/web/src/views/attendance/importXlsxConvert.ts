// X1 xlsx direct import (attendance-import-xlsx-direct design-lock, RATIFIED
// D1=A): convert a selected .xlsx in the browser — first non-empty sheet →
// CSV text — and feed the EXISTING csvText pipeline, so the backend stays
// byte-identical and every downstream gate (recognition, preview, commit)
// applies unchanged. SheetJS loads via dynamic import so it never enters the
// main bundle; the dependency was upgraded to 0.20.3 first (#3737, D3-a).

/** D4: refuse to convert workbooks larger than this before reading. */
export const IMPORT_XLSX_MAX_BYTES = 10 * 1024 * 1024

export type AttendanceXlsxConvertFailure =
  | 'too-large'
  | 'encrypted'
  | 'empty'
  | 'unreadable'

export type AttendanceXlsxConvertResult =
  | { ok: true; csvText: string; sheetName: string; sheetCount: number }
  | { ok: false; reason: AttendanceXlsxConvertFailure }

export function xlsxConvertFailureMessage(reason: AttendanceXlsxConvertFailure): { en: string; zh: string } {
  switch (reason) {
    case 'too-large':
      return {
        en: `The Excel file exceeds ${IMPORT_XLSX_MAX_BYTES / (1024 * 1024)}MB — save it as CSV and upload that instead.`,
        zh: `Excel 文件超过 ${IMPORT_XLSX_MAX_BYTES / (1024 * 1024)}MB——请另存为 CSV 后上传。`,
      }
    case 'encrypted':
      return {
        en: 'This workbook is password-protected — remove the password or save it as CSV, then retry.',
        zh: '该工作簿有密码保护——请去除密码或另存为 CSV 后重试。',
      }
    case 'empty':
      return {
        en: 'No non-empty worksheet was found in this workbook — check the file, or save the intended sheet as CSV.',
        zh: '工作簿中未找到非空工作表——请检查文件，或将目标工作表另存为 CSV。',
      }
    default:
      return {
        en: 'Could not read this Excel file — it may be corrupt; save it as CSV and retry.',
        zh: '无法读取该 Excel 文件——文件可能已损坏；请另存为 CSV 后重试。',
      }
  }
}

async function readFileArrayBuffer(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') {
    return await file.arrayBuffer()
  }
  if (typeof FileReader === 'undefined') throw new Error('FileReader unavailable')
  return await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result)
      else reject(new Error('Unexpected read result'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsArrayBuffer(file)
  })
}

/**
 * Convert the first non-empty worksheet of an .xlsx File to CSV text.
 * Formatted cell text (raw:false) matches the textual shape of a DingTalk
 * export; formulas contribute their cached values (SheetJS default).
 */
export async function convertXlsxFileToCsvText(file: File): Promise<AttendanceXlsxConvertResult> {
  if (typeof file?.size === 'number' && file.size > IMPORT_XLSX_MAX_BYTES) {
    return { ok: false, reason: 'too-large' }
  }
  let buffer: ArrayBuffer
  try {
    buffer = await readFileArrayBuffer(file)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  try {
    const XLSX = await import('xlsx')
    const workbook = XLSX.read(buffer, { type: 'array' })
    const sheetNames = workbook.SheetNames ?? []
    for (const sheetName of sheetNames) {
      const sheet = workbook.Sheets[sheetName]
      if (!sheet) continue
      const csvText = XLSX.utils.sheet_to_csv(sheet, { blankrows: false })
      if (csvText.trim().length > 0) {
        return { ok: true, csvText, sheetName, sheetCount: sheetNames.length }
      }
    }
    return { ok: false, reason: 'empty' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/password|encrypted|ECMA-376|agile/i.test(message)) {
      return { ok: false, reason: 'encrypted' }
    }
    return { ok: false, reason: 'unreadable' }
  }
}

/** v1 scope (lock D2): only a plain `.xlsx` extension converts. */
export function isDirectConvertibleXlsxName(name: string | null | undefined): boolean {
  return /\.xlsx$/i.test(String(name ?? '').trim())
}
