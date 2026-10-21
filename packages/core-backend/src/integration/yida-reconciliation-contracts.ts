import { createHash } from 'node:crypto'
import { types } from 'node:util'

type Code = 'INPUT' | 'DENIED' | 'CONFLICT' | 'UNAVAILABLE'
const errors = new WeakMap<object, Code>()
export function reconciliationFail(code: Code): never {
  const error = new Error('YIDA_RECONCILIATION_' + code)
  errors.set(error, code); throw error
}
export function reconciliationErrorCode(error: unknown): Code | undefined { return errors.get(error as object) }
export function reconciliationObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) reconciliationFail('INPUT')
  const prototype = Object.getPrototypeOf(value), descriptors = Object.getOwnPropertyDescriptors(value)
  if (prototype !== Object.prototype && prototype !== null || Reflect.ownKeys(descriptors).length !== keys.length) reconciliationFail('INPUT')
  return Object.fromEntries(keys.map(key => {
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) reconciliationFail('INPUT')
    return [key, descriptor.value]
  }))
}
export function reconciliationUuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)) reconciliationFail('INPUT')
  return value
}
export type ReconciliationInput = Readonly<{
  commandKey: string; expectedHeadSequence: number; conclusion: 'observed_match' | 'observed_mismatch' | 'inconclusive';
  reason: string; evidenceKind: 'operator_receipt' | 'operator_comparison' | null;
  evidenceSha256: string | null; evidenceRef: string | null; claimedObservedAt: string | null;
  supersedesObservationId: string | null;
}>
export const reconciliationInputKeys = ['commandKey', 'expectedHeadSequence', 'conclusion', 'reason', 'evidenceKind',
  'evidenceSha256', 'evidenceRef', 'claimedObservedAt', 'supersedesObservationId'] as const
export function checkedReconciliationInput(value: unknown): ReconciliationInput {
  const row = reconciliationObject(value, reconciliationInputKeys)
  reconciliationUuid(row.commandKey)
  if (typeof row.expectedHeadSequence !== 'number' || !Number.isSafeInteger(row.expectedHeadSequence)
    || row.expectedHeadSequence < 0 || row.expectedHeadSequence >= 2147483647) reconciliationFail('INPUT')
  const reasons: Record<string, readonly string[]> = {
    observed_match: ['OPERATOR_RECORDED_MATCH', 'CORRECTION'],
    observed_mismatch: ['FIELD_MISMATCH', 'FIELD_MISSING', 'INSTANCE_MISMATCH', 'CORRECTION'],
    inconclusive: ['INSTANCE_UNRESOLVED', 'NO_OBSERVATION', 'CORRECTION'],
  }
  if (typeof row.conclusion !== 'string' || !Object.hasOwn(reasons, row.conclusion)
    || typeof row.reason !== 'string' || !reasons[row.conclusion].includes(row.reason)) reconciliationFail('INPUT')
  if (row.evidenceKind === null) {
    if (row.evidenceSha256 !== null || row.evidenceRef !== null || row.conclusion !== 'inconclusive') reconciliationFail('INPUT')
  } else if (typeof row.evidenceKind !== 'string' || !['operator_receipt', 'operator_comparison'].includes(row.evidenceKind)
    || typeof row.evidenceSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.evidenceSha256)
    || typeof row.evidenceRef !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(row.evidenceRef)) reconciliationFail('INPUT')
  if (row.claimedObservedAt !== null && (typeof row.claimedObservedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(row.claimedObservedAt)
    || !Number.isFinite(Date.parse(row.claimedObservedAt)) || new Date(row.claimedObservedAt).toISOString() !== row.claimedObservedAt)) reconciliationFail('INPUT')
  if (row.supersedesObservationId !== null) reconciliationUuid(row.supersedesObservationId)
  if ((row.reason === 'CORRECTION') !== (row.supersedesObservationId !== null)) reconciliationFail('INPUT')
  if (Buffer.byteLength(JSON.stringify(row), 'utf8') > 4096) reconciliationFail('INPUT')
  return Object.freeze(row) as ReconciliationInput
}
export function reconciliationContentHash(requestId: string, input: ReconciliationInput): string {
  return createHash('sha256').update(JSON.stringify([requestId, input])).digest('hex')
}
export const reconciliationRecordKeys = ['id', 'sequence', 'authorId', 'recordedAt', ...reconciliationInputKeys,
  'evidenceOrigin', 'evidenceVerified', 'canSend', 'canRetry'] as const
export function checkedReconciliationRecord(value: unknown) {
  const row = reconciliationObject(value, reconciliationRecordKeys)
  const input = checkedReconciliationInput(Object.fromEntries(reconciliationInputKeys.map(key => [key, row[key]])))
  reconciliationUuid(row.id)
  if (typeof row.sequence !== 'number' || !Number.isSafeInteger(row.sequence) || row.sequence < 1
    || row.sequence !== input.expectedHeadSequence + 1 || typeof row.authorId !== 'string' || !row.authorId || row.authorId.length > 128
    || typeof row.recordedAt !== 'string' || !Number.isFinite(Date.parse(row.recordedAt))
    || row.evidenceOrigin !== 'operator-supplied' || row.evidenceVerified !== false || row.canSend !== false || row.canRetry !== false) reconciliationFail('UNAVAILABLE')
  return Object.freeze(row)
}
export function checkedReconciliationPage(value: unknown) {
  const row = reconciliationObject(value, ['records', 'headSequence', 'nextAfterId', 'canSend', 'canRetry'])
  if (!Array.isArray(row.records) || types.isProxy(row.records) || Object.getPrototypeOf(row.records) !== Array.prototype || row.records.length > 50
    || Reflect.ownKeys(row.records).length !== row.records.length + 1 || row.canSend !== false || row.canRetry !== false
    || typeof row.headSequence !== 'number' || !Number.isSafeInteger(row.headSequence) || row.headSequence < 0) reconciliationFail('UNAVAILABLE')
  const records = Array.from({ length: row.records.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(row.records, String(index))
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) reconciliationFail('UNAVAILABLE')
    return checkedReconciliationRecord(descriptor.value)
  })
  if (records.some((record, index) => (record.sequence as number) > (row.headSequence as number)
    || index > 0 && (record.sequence as number) !== (records[index - 1].sequence as number) + 1)) reconciliationFail('UNAVAILABLE')
  if (row.nextAfterId !== null && (row.nextAfterId !== records.at(-1)?.id || records.length !== 50)) reconciliationFail('UNAVAILABLE')
  return Object.freeze({ ...row, records: Object.freeze(records) })
}
