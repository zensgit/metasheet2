import { parseAttendanceInstantMsV1 } from './w4c1-strict-time'
import type { AttendanceEvidenceV1 } from './w4c0-write-boundary-types'

export type AttendanceCorrectionDirection = 'check_in' | 'check_out'
export type AttendanceCorrectionTargetV1 = Readonly<{
  kind: 'replacement'
  segmentIndex: number
  direction: AttendanceCorrectionDirection
  evidenceRef: string
}> | Readonly<{
  kind: 'insertion'
  segmentIndex: number
  direction: AttendanceCorrectionDirection
}>
export type AttendanceCorrectionSourceV1 = Readonly<{
  recordId: string
  calculationId: string
  calculationVersion: number
  semanticInputFingerprint: string
}>
export type AttendanceCorrectionTargetsV1 = Readonly<{
  schemaVersion: 1
  source: AttendanceCorrectionSourceV1
  checkIn: AttendanceCorrectionTargetV1 | null
  checkOut: AttendanceCorrectionTargetV1 | null
}>

export class AttendanceCorrectionTargetError extends Error {
  readonly code: string
  readonly httpStatus: number
  constructor(code: string, httpStatus = 422) {
    super(code)
    this.name = 'AttendanceCorrectionTargetError'
    this.code = code
    this.httpStatus = httpStatus
  }
}
export function correctionTargetFail(code: string, status = 422): never {
  throw new AttendanceCorrectionTargetError(code, status)
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length !== 0
    || Object.getOwnPropertyNames(value).length !== keys.length
    || keys.some(key => !Object.getOwnPropertyDescriptor(value, key)
      || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) {
    correctionTargetFail('ATTENDANCE_CORRECTION_TARGET_INVALID', 400)
  }
  return value as Record<string, unknown>
}
function uuid(value: unknown): string {
  if (typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    correctionTargetFail('ATTENDANCE_CORRECTION_TARGET_INVALID', 400)
  }
  return value.toLowerCase()
}
export function normalizeAttendanceCorrectionTargetV1(value: unknown, direction: AttendanceCorrectionDirection): AttendanceCorrectionTargetV1 | null {
  if (value === null) return null
  const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'kind') : undefined
  const kind = descriptor && 'value' in descriptor ? descriptor.value : null
  const keys = kind === 'replacement'
    ? ['kind', 'segmentIndex', 'direction', 'evidenceRef']
    : ['kind', 'segmentIndex', 'direction']
  const row = exact(value, keys)
  if ((row.kind !== 'replacement' && row.kind !== 'insertion') || row.direction !== direction
    || !Number.isSafeInteger(row.segmentIndex) || Number(row.segmentIndex) < 0 || Number(row.segmentIndex) > 2) {
    correctionTargetFail('ATTENDANCE_CORRECTION_TARGET_INVALID', 400)
  }
  if (row.kind === 'replacement') {
    if (typeof row.evidenceRef !== 'string' || row.evidenceRef.length === 0 || row.evidenceRef.length > 512) {
      correctionTargetFail('ATTENDANCE_CORRECTION_TARGET_INVALID', 400)
    }
    return Object.freeze({ kind: 'replacement', segmentIndex: Number(row.segmentIndex), direction, evidenceRef: row.evidenceRef })
  }
  return Object.freeze({ kind: 'insertion', segmentIndex: Number(row.segmentIndex), direction })
}
export function normalizeAttendanceCorrectionTargetsV1(value: unknown): AttendanceCorrectionTargetsV1 {
  const row = exact(value, ['schemaVersion', 'source', 'checkIn', 'checkOut'])
  const source = exact(row.source, ['recordId', 'calculationId', 'calculationVersion', 'semanticInputFingerprint'])
  if (row.schemaVersion !== 1 || !Number.isSafeInteger(source.calculationVersion)
    || Number(source.calculationVersion) < 1 || typeof source.semanticInputFingerprint !== 'string'
    || !/^[0-9a-f]{64}$/.test(source.semanticInputFingerprint)) {
    correctionTargetFail('ATTENDANCE_CORRECTION_TARGET_INVALID', 400)
  }
  return Object.freeze({
    schemaVersion: 1,
    source: Object.freeze({ recordId: uuid(source.recordId), calculationId: uuid(source.calculationId),
      calculationVersion: Number(source.calculationVersion), semanticInputFingerprint: source.semanticInputFingerprint }),
    checkIn: normalizeAttendanceCorrectionTargetV1(row.checkIn, 'check_in'),
    checkOut: normalizeAttendanceCorrectionTargetV1(row.checkOut, 'check_out'),
  })
}

export type AttendanceCorrectionCellV1 = Readonly<{
  segmentIndex: number
  direction: AttendanceCorrectionDirection
  evidenceRefs: readonly string[]
  startMs: number
  endMs: number
  finalCell: boolean
}>
export function correctionCandidatesForCellsV1(cells: readonly AttendanceCorrectionCellV1[]): AttendanceCorrectionTargetV1[] {
  return cells.flatMap<AttendanceCorrectionTargetV1>(cell => cell.evidenceRefs.length === 0
    ? [{ kind: 'insertion' as const, segmentIndex: cell.segmentIndex, direction: cell.direction }]
    : cell.evidenceRefs.map(evidenceRef => ({ kind: 'replacement' as const, segmentIndex: cell.segmentIndex,
      direction: cell.direction, evidenceRef })))
}
export function verifyCorrectionTargetV1(
  selected: AttendanceCorrectionTargetV1,
  cells: readonly AttendanceCorrectionCellV1[],
  occurredAt: string,
  evidence: readonly AttendanceEvidenceV1[],
): void {
  const cell = cells.find(item => item.segmentIndex === selected.segmentIndex && item.direction === selected.direction)
  let ms: number
  try { ms = parseAttendanceInstantMsV1(occurredAt) }
  catch { correctionTargetFail('ATTENDANCE_CORRECTION_TARGET_MISMATCH') }
  if (!cell || !Number.isFinite(ms) || ms < cell.startMs
    || (cell.finalCell ? ms > cell.endMs : ms >= cell.endMs)) {
    correctionTargetFail('ATTENDANCE_CORRECTION_TARGET_MISMATCH')
  }
  if (selected.kind === 'insertion') {
    if (cell.evidenceRefs.length !== 0) correctionTargetFail('ATTENDANCE_CORRECTION_TARGET_NOT_EMPTY', 409)
  } else {
    const matches = evidence.filter(item => item.ref === selected.evidenceRef
      && item.kind !== 'scheduled_absence' && item.direction === selected.direction)
    if (matches.length !== 1 || !cell.evidenceRefs.includes(selected.evidenceRef)) {
      correctionTargetFail('ATTENDANCE_CORRECTION_TARGET_STALE', 409)
    }
  }
}
