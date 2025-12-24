type UniverCellLike = {
  v?: unknown
  f?: unknown
  __linkIds?: string[]
}

export function extractValueFromCell(cell: unknown): unknown {
  if (!cell || typeof cell !== 'object') return cell
  const maybe = cell as UniverCellLike
  if (Array.isArray(maybe.__linkIds)) return cell
  if (typeof maybe.f === 'string') return maybe.f.startsWith('=') ? maybe.f : `=${maybe.f}`
  if ('v' in maybe) return maybe.v
  return cell
}

export function isFormulaValue(value: unknown): value is string {
  return typeof value === 'string' && (value === '' || value.startsWith('='))
}

export function resolveFallbackSelectColor(value: string): string | undefined {
  const fallback: Record<string, string> = {
    P0: '#ff4d4f',
    P1: '#faad14',
    P2: '#1677ff',
    Done: '#52c41a',
  }
  return fallback[value]
}

export function buildSelectCell(value: string, color: string) {
  return {
    v: value,
    s: {
      bg: { rgb: color },
      cl: { rgb: '#ffffff' },
      ht: 2,
      vt: 2,
    },
  }
}

export function buildLinkCell(value: string) {
  return {
    v: value,
    s: {
      cl: { rgb: '#1677ff' },
      ul: { s: 1 },
    },
  }
}

export function applyReadonlyStyle<T extends Record<string, any>>(cell: T, reason?: string) {
  const style = cell.s && typeof cell.s === 'object' ? cell.s : {}
  return {
    ...cell,
    s: {
      ...style,
      bg: { rgb: '#f5f5f5' },
      cl: { rgb: '#8c8c8c' },
    },
    __readonly: true,
    ...(reason ? { __readonlyReason: reason } : {}),
  }
}
