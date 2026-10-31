export type Direction = 'check_in' | 'check_out'
export type Target = { kind: 'replacement'; segmentIndex: number; direction: Direction; evidenceRef: string } | { kind: 'insertion'; segmentIndex: number; direction: Direction }
export type Source = { recordId: string; calculationId: string; calculationVersion: number; semanticInputFingerprint: string }
export type Candidate = { target: Target; display: { timezone: string; expectedStartAt: string; expectedEndAt: string; originalOccurredAt: string | null; source: string } }
export type CorrectionTargets = { schemaVersion: 1; source: Source; checkIn: Target | null; checkOut: Target | null }
export type Result = { posture: 'legacy_projection_only' } | { posture: 'canonical'; source: Source; candidates: Candidate[] }

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}
function target(value: unknown, direction: Direction): Target | null {
  if (!value || typeof value !== 'object') return null
  const kind = (value as { kind?: unknown }).kind
  if (!exact(value, kind === 'replacement' ? ['kind', 'segmentIndex', 'direction', 'evidenceRef'] : ['kind', 'segmentIndex', 'direction'])
    || (kind !== 'replacement' && kind !== 'insertion') || value.direction !== direction
    || !Number.isSafeInteger(value.segmentIndex) || Number(value.segmentIndex) < 0 || Number(value.segmentIndex) > 2) return null
  if (kind === 'replacement') {
    if (typeof value.evidenceRef !== 'string' || !value.evidenceRef.length || value.evidenceRef.length > 512) return null
    return { kind, segmentIndex: Number(value.segmentIndex), direction, evidenceRef: value.evidenceRef }
  }
  return { kind, segmentIndex: Number(value.segmentIndex), direction }
}
function source(value: unknown): Source | null {
  if (!exact(value, ['recordId', 'calculationId', 'calculationVersion', 'semanticInputFingerprint'])) return null
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (typeof value.recordId !== 'string' || !uuid.test(value.recordId) || typeof value.calculationId !== 'string' || !uuid.test(value.calculationId)
    || !Number.isSafeInteger(value.calculationVersion) || Number(value.calculationVersion) < 1
    || typeof value.semanticInputFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(value.semanticInputFingerprint)) return null
  return { recordId: value.recordId, calculationId: value.calculationId, calculationVersion: Number(value.calculationVersion), semanticInputFingerprint: value.semanticInputFingerprint }
}
export function parseCorrectionTargets(body: unknown): Result | null {
  if (!exact(body, ['ok', 'data']) || body.ok !== true || !exact(body.data, ['schemaVersion', 'posture', 'source', 'candidates'])) return null
  const data = body.data
  if (data.schemaVersion !== 1 || !Array.isArray(data.candidates)) return null
  if (data.posture === 'legacy_projection_only') return data.source === null && data.candidates.length === 0 ? { posture: 'legacy_projection_only' } : null
  const parsedSource = source(data.source)
  if (data.posture !== 'canonical' || !parsedSource) return null
  const candidates: Candidate[] = []
  for (const row of data.candidates) {
    if (!exact(row, ['target', 'display']) || !exact(row.display, ['timezone', 'expectedStartAt', 'expectedEndAt', 'originalOccurredAt', 'source'])) return null
    const raw = row.target as { direction?: unknown } | null
    if (raw?.direction !== 'check_in' && raw?.direction !== 'check_out') return null
    const parsed = target(raw, raw.direction)
    const d = row.display
    if (!parsed || typeof d.timezone !== 'string' || !d.timezone || typeof d.expectedStartAt !== 'string' || !Number.isFinite(Date.parse(d.expectedStartAt))
      || typeof d.expectedEndAt !== 'string' || !Number.isFinite(Date.parse(d.expectedEndAt))
      || (d.originalOccurredAt !== null && (typeof d.originalOccurredAt !== 'string' || !Number.isFinite(Date.parse(d.originalOccurredAt))))
      || typeof d.source !== 'string' || !['attendance_event', 'outdoor_approval', 'import', 'correction', 'empty_boundary'].includes(d.source)
      || (parsed.kind === 'insertion' && (d.originalOccurredAt !== null || d.source !== 'empty_boundary'))
      || (parsed.kind === 'replacement' && (d.originalOccurredAt === null || d.source === 'empty_boundary'))) return null
    if (candidates.some(item => JSON.stringify(item.target) === JSON.stringify(parsed))) return null
    candidates.push({ target: parsed, display: { timezone: d.timezone, expectedStartAt: d.expectedStartAt, expectedEndAt: d.expectedEndAt, originalOccurredAt: d.originalOccurredAt as string | null, source: d.source } })
  }
  return { posture: 'canonical', source: parsedSource, candidates }
}
export function projectCorrectionTargets(result: Result, chosen: { checkIn: number | null; checkOut: number | null }, requested: { checkIn: boolean; checkOut: boolean }): CorrectionTargets | null {
  if (result.posture !== 'canonical') return null
  const canonical = result
  function side(direction: Direction, index: number | null, needed: boolean): Target | null | undefined {
    if (!needed) return null
    const candidates = canonical.candidates.filter(item => item.target.direction === direction)
    const selection = index === null && candidates.length === 1 ? candidates[0] : canonical.candidates[index ?? -1]
    return selection && selection.target.direction === direction ? selection.target : undefined
  }
  const checkIn = side('check_in', chosen.checkIn, requested.checkIn)
  const checkOut = side('check_out', chosen.checkOut, requested.checkOut)
  return checkIn === undefined || checkOut === undefined ? null : { schemaVersion: 1, source: result.source, checkIn, checkOut }
}
export function parseFrozenTargets(value: unknown): CorrectionTargets | null {
  if (!exact(value, ['schemaVersion', 'source', 'checkIn', 'checkOut']) || value.schemaVersion !== 1) return null
  const s = source(value.source)
  const checkIn = value.checkIn === null ? null : target(value.checkIn, 'check_in')
  const checkOut = value.checkOut === null ? null : target(value.checkOut, 'check_out')
  return s && (value.checkIn === null || checkIn) && (value.checkOut === null || checkOut) ? { schemaVersion: 1, source: s, checkIn, checkOut } : null
}
