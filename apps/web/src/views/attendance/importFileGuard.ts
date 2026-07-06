// Client-side guard for the attendance CSV importer: reject Excel (.xlsx/.xls)
// files before they are read as text / uploaded, so a foreseeable format
// mismatch (DingTalk exports .xlsx by default) surfaces an actionable message
// instead of a cryptic downstream VALIDATION_ERROR. Pure, dependency-free.
//
// See docs/development/attendance-import-xlsx-guard-design-lock-20260706.md.
// Shared by BOTH the live `AttendanceView.vue` inline import handlers and the
// `useAttendanceAdminImportWorkflow` composable so the guard logic cannot drift
// between the two call sites.

export type BlockedSpreadsheetKind = 'xlsx' | 'xls'

const XLSX_NAME = /\.(xlsx|xlsm|xlsb)$/i
const XLS_NAME = /\.xls$/i

/** Extension-based detection (cheap, synchronous). */
export function detectSpreadsheetByName(name: string | null | undefined): BlockedSpreadsheetKind | null {
  const lower = String(name ?? '').trim().toLowerCase()
  if (!lower) return null
  if (XLSX_NAME.test(lower)) return 'xlsx'
  if (XLS_NAME.test(lower)) return 'xls'
  return null
}

/**
 * Magic-byte detection over the first bytes of a file — catches Excel files
 * that were renamed to `.csv`.
 *  - ZIP / OOXML (.xlsx): 50 4B (PK) followed by 03 04 | 05 06 | 07 08
 *  - OLE2 compound (.xls, legacy): D0 CF 11 E0 A1 B1 1A E1
 */
export function detectSpreadsheetByMagic(head: Uint8Array): BlockedSpreadsheetKind | null {
  if (
    head.length >= 4 &&
    head[0] === 0x50 && head[1] === 0x4b &&
    (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07) &&
    (head[3] === 0x04 || head[3] === 0x06 || head[3] === 0x08)
  ) {
    return 'xlsx'
  }
  if (
    head.length >= 8 &&
    head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0 &&
    head[4] === 0xa1 && head[5] === 0xb1 && head[6] === 0x1a && head[7] === 0xe1
  ) {
    return 'xls'
  }
  return null
}

/** Actionable, localizable message. Callers pick en/zh via their own tr(). */
export function blockedSpreadsheetMessage(kind: BlockedSpreadsheetKind): { en: string; zh: string } {
  const label = kind === 'xls' ? '.xls' : '.xlsx'
  return {
    en: `This looks like an Excel file (${label}). The importer only accepts CSV — open it in Excel/WPS, use Save As → CSV, then upload the .csv. You can also click "Download CSV template" for the exact format.`,
    zh: `检测到 Excel 文件（${label}），本导入仅支持 CSV。请在 Excel/WPS 中「另存为 → CSV（逗号分隔，建议 UTF-8）」后再上传该 .csv；也可点「下载 CSV 模板」参照格式。`,
  }
}

async function readBlobHeadBytes(blob: Blob): Promise<ArrayBuffer | null> {
  if (typeof blob.arrayBuffer === 'function') {
    return await blob.arrayBuffer()
  }
  // Fallback mirroring defaultReadFileText: environments without
  // Blob.arrayBuffer (jsdom, legacy WebViews) still expose FileReader.
  if (typeof FileReader === 'undefined') return null
  return await new Promise<ArrayBuffer | null>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result instanceof ArrayBuffer ? reader.result : null)
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsArrayBuffer(blob)
  })
}

/**
 * Inspect a selected file: name first (sync-cheap), then sniff the first 8
 * bytes for magic. Byte-read failure falls back to the (allowed) name result.
 */
export async function inspectImportFile(
  file: { name?: string; slice?: (start?: number, end?: number) => Blob },
): Promise<{ ok: true } | { ok: false; kind: BlockedSpreadsheetKind }> {
  const byName = detectSpreadsheetByName(file?.name)
  if (byName) return { ok: false, kind: byName }
  try {
    const head = typeof file?.slice === 'function' ? file.slice(0, 8) : null
    const buffer = head ? await readBlobHeadBytes(head) : null
    if (buffer) {
      const byMagic = detectSpreadsheetByMagic(new Uint8Array(buffer).subarray(0, 8))
      if (byMagic) return { ok: false, kind: byMagic }
    }
  } catch {
    // ignore — name check already passed; allow through
  }
  return { ok: true }
}
