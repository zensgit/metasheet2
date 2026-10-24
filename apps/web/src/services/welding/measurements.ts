import { isHash, isObject, type PlanPayload } from './planRecovery'

type Weld = PlanPayload['welds'][number]
export type GeometryRow = { weld_id: string; status: string; length_mm: number | null; reason: string | null }
export type LengthMetric = { known_count: number; missing_count: number; value_mm: number | null; complete: boolean }

// Geometry is supplied by the pinned VemCAD helper or a saved server projection.
// This module only aggregates business quantities; it does not measure CAD entities.
export function measurementRows(value: unknown, ids: string[], saved = false): GeometryRow[] | null {
  if (!isObject(value) || value.schema !== (saved ? 'yuantus.welding_geometry_measurement/1' : 'vemcad-weld-measurement/1')
    || value.algorithm !== 'vemcad-weld-length/1' || ![null, 'mm', 'in'].includes(value.source_unit as null | string)
    || saved && (!isHash(value.bundle_sha256) || !isHash(value.geometry_basis_sha256))
    || !Array.isArray(value.rows) || value.rows.length !== ids.length) return null
  const remaining = new Set(ids)
  if (remaining.size !== ids.length) return null
  for (const row of value.rows) {
    if (!isObject(row) || typeof row.weld_id !== 'string' || !remaining.delete(row.weld_id)) return null
    const measured = row.status === 'measured' && typeof row.length_mm === 'number' && Number.isFinite(row.length_mm) && row.length_mm >= 0 && row.reason === null
    const unknown = row.length_mm === null && (row.status === 'unmeasurable' && row.reason === 'length_overflow' || saved && row.status === 'unbound' && row.reason === null)
    if (!measured && !unknown) return null
  }
  return value.rows as GeometryRow[]
}

function quantity(value: unknown): number | null {
  if (!isObject(value) || typeof value.value !== 'number' || !Number.isFinite(value.value) || value.value < 0 || !['mm', 'in'].includes(String(value.unit))) return null
  return value.value * (value.unit === 'in' ? 25.4 : 1)
}

function metric(values: Array<number | null>): LengthMetric {
  const known = values.filter((value): value is number => value !== null)
  const sum = known.reduce((total, value) => total + value, 0)
  return { known_count: known.length, missing_count: values.length - known.length, value_mm: Number.isFinite(sum) ? sum : null, complete: known.length === values.length && Number.isFinite(sum) }
}

export function summarizeWelds(payload: PlanPayload, geometry: GeometryRow[] | null) {
  const lengths = new Map(geometry?.map(row => [row.weld_id, row.length_mm]))
  const summarize = (welds: Weld[]) => {
    const included = welds.filter(weld => weld.included !== false)
    return { weld_count: welds.length, included_count: included.length,
      geometry: metric(included.map(weld => lengths.get(weld.weld_id) ?? null)),
      manufacturing: metric(included.map(weld => quantity(weld.manufacturing_length))),
      manual: metric(included.map(weld => quantity(weld.measured_length))) }
  }
  const groups = new Map<string, Weld[]>()
  for (const weld of payload.welds) {
    const name = typeof weld.group_name === 'string' ? weld.group_name : ''
    const rows = groups.get(name) ?? []; rows.push(weld); groups.set(name, rows)
  }
  const codepointOrder = (a: string, b: string) => {
    const left = Array.from(a, c => c.codePointAt(0)!), right = Array.from(b, c => c.codePointAt(0)!)
    for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i]
    return left.length - right.length
  }
  return { totals: summarize(payload.welds), groups: [...groups].sort(([a], [b]) => codepointOrder(a, b)).map(([group_name, welds]) => ({ group_name, ...summarize(welds) })) }
}
