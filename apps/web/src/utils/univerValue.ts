type CellValue = {
  v?: string | number | boolean | null
  f?: string | null
  s?: Record<string, unknown>
  [key: string]: unknown
}

export function buildSelectCell(value: string, color?: string): CellValue {
  const cell: CellValue = { v: value }
  if (color) {
    cell.s = { ...(cell.s || {}), bg: color }
  }
  return cell
}

export function buildLinkCell(displayText: string): CellValue {
  return { v: displayText }
}

export function applyReadonlyStyle(cell: any, reason: string): any {
  return {
    ...cell,
    s: { ...(cell?.s || {}), bg: '#f5f5f5' },
    __readonlyReason: reason,
  }
}

export function extractValueFromCell(cell: unknown): unknown {
  if (!cell || typeof cell !== 'object') return cell
  const anyCell = cell as { v?: unknown; f?: unknown; __linkIds?: unknown }
  if (Array.isArray(anyCell.__linkIds)) return anyCell.__linkIds
  if (typeof anyCell.f === 'string') return anyCell.f
  return anyCell.v
}

export function isFormulaValue(value: unknown): boolean {
  return typeof value === 'string' && value.trim().startsWith('=')
}

export function resolveFallbackSelectColor(value: string): string | undefined {
  if (!value) return undefined
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i)
    hash |= 0
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 70%, 65%)`
}
