export type CellVersionMap = Record<string, number>

export interface SpreadsheetServerCell {
  row_index: number
  column_index: number
  version?: number | null
}

export interface SpreadsheetCellPatch {
  row: number
  col: number
  value?: string | null
  formula?: string
  dataType?: string
  expectedVersion?: number
}

export interface CellVersionConflictPayload {
  code?: string
  message?: string
  row?: number
  col?: number
  serverVersion?: number
  expectedVersion?: number
}

export function cellVersionKey(row: number, col: number): string {
  return `${row}:${col}`
}

export function formatCellReference(row: number, col: number): string {
  let label = ''
  let index = col
  while (index >= 0) {
    label = String.fromCharCode(65 + (index % 26)) + label
    index = Math.floor(index / 26) - 1
  }
  return `${label}${row + 1}`
}

export function buildCellVersionMap(cells: readonly SpreadsheetServerCell[]): CellVersionMap {
  return mergeCellVersionMap({}, cells)
}

export function mergeCellVersionMap(
  current: CellVersionMap,
  cells: readonly SpreadsheetServerCell[],
): CellVersionMap {
  const next: CellVersionMap = { ...current }
  for (const cell of cells) {
    if (typeof cell.version !== 'number') continue
    if (!Number.isInteger(cell.row_index) || !Number.isInteger(cell.column_index)) continue
    next[cellVersionKey(cell.row_index, cell.column_index)] = cell.version
  }
  return next
}

export function withExpectedCellVersions<T extends { row: number; col: number }>(
  cells: readonly T[],
  versions: CellVersionMap,
): Array<T & { expectedVersion?: number }> {
  return cells.map((cell) => {
    const expectedVersion = versions[cellVersionKey(cell.row, cell.col)]
    if (typeof expectedVersion !== 'number') {
      return { ...cell }
    }
    return { ...cell, expectedVersion }
  })
}

export function isCellVersionConflict(error: unknown): error is CellVersionConflictPayload {
  return Boolean(error && typeof error === 'object' && (error as CellVersionConflictPayload).code === 'VERSION_CONFLICT')
}

export function formatCellVersionConflict(
  error: CellVersionConflictPayload,
  options: { locale?: 'en' | 'zh-CN' } = {},
): string {
  const row = typeof error.row === 'number' ? error.row : undefined
  const col = typeof error.col === 'number' ? error.col : undefined
  const cell = row !== undefined && col !== undefined ? formatCellReference(row, col) : undefined
  const serverVersion = typeof error.serverVersion === 'number' ? error.serverVersion : undefined
  const expectedVersion = typeof error.expectedVersion === 'number' ? error.expectedVersion : undefined
  const versionHint = serverVersion !== undefined && expectedVersion !== undefined
    ? options.locale === 'zh-CN'
      ? `服务器版本：${serverVersion}，本地版本：${expectedVersion}`
      : `server version: ${serverVersion}, expected: ${expectedVersion}`
    : undefined

  if (options.locale === 'zh-CN') {
    const target = cell ? `单元格 ${cell}` : '单元格'
    return `${target} 已被其他会话更新，请刷新后重试。${versionHint ? `（${versionHint}）` : ''}`
  }

  const target = cell ? `Cell ${cell}` : 'The cell'
  return `${target} was changed by another session. Refresh before retrying.${versionHint ? ` (${versionHint})` : ''}`
}
