// Wire-only declarations. Evidence remains operator-supplied, never a permit.
export type YidaReconciliationInput = Readonly<{
  commandKey: string; expectedHeadSequence: number; conclusion: 'observed_match' | 'observed_mismatch' | 'inconclusive';
  reason: string; evidenceKind: 'operator_receipt' | 'operator_comparison' | null; evidenceSha256: string | null;
  evidenceRef: string | null; claimedObservedAt: string | null; supersedesObservationId: string | null;
}>
export type YidaReconciliationRecord = YidaReconciliationInput & Readonly<{ id: string; sequence: number; authorId: string;
  recordedAt: string; evidenceOrigin: 'operator-supplied'; evidenceVerified: false; canSend: false; canRetry: false }>
const keys = ['commandKey','expectedHeadSequence','conclusion','reason','evidenceKind','evidenceSha256','evidenceRef','claimedObservedAt','supersedesObservationId']
const uuid = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(v)
function fail(): never { throw new Error('YIDA_RECONCILIATION_INVALID') }
function exact(value: unknown, wanted: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== wanted.length || Object.keys(row).some(key => !wanted.includes(key))) fail()
  return row
}
export function parseYidaReconciliationInput(value: unknown): YidaReconciliationInput {
  const row = exact(value, keys)
  const reasons: Record<string, string[]> = { observed_match: ['OPERATOR_RECORDED_MATCH','CORRECTION'],
    observed_mismatch: ['FIELD_MISMATCH','FIELD_MISSING','INSTANCE_MISMATCH','CORRECTION'],
    inconclusive: ['INSTANCE_UNRESOLVED','NO_OBSERVATION','CORRECTION'] }
  if (!uuid(row.commandKey) || typeof row.expectedHeadSequence !== 'number' || !Number.isSafeInteger(row.expectedHeadSequence)
    || row.expectedHeadSequence < 0 || row.expectedHeadSequence >= 2147483647
    || typeof row.conclusion !== 'string' || !Object.prototype.hasOwnProperty.call(reasons, row.conclusion)
    || typeof row.reason !== 'string' || !reasons[row.conclusion].includes(row.reason)) fail()
  if (row.evidenceKind === null) {
    if (row.evidenceRef !== null || row.evidenceSha256 !== null || row.conclusion !== 'inconclusive') fail()
  } else if (typeof row.evidenceKind !== 'string' || !['operator_receipt','operator_comparison'].includes(row.evidenceKind)
    || typeof row.evidenceSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.evidenceSha256)
    || typeof row.evidenceRef !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(row.evidenceRef)) fail()
  if (row.claimedObservedAt !== null && (typeof row.claimedObservedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(row.claimedObservedAt)
    || !Number.isFinite(Date.parse(row.claimedObservedAt)) || new Date(row.claimedObservedAt).toISOString() !== row.claimedObservedAt)) fail()
  if (row.supersedesObservationId !== null && !uuid(row.supersedesObservationId)
    || (row.reason === 'CORRECTION') !== (row.supersedesObservationId !== null)
    || new TextEncoder().encode(JSON.stringify(row)).byteLength > 4096) fail()
  return Object.freeze({ ...row }) as YidaReconciliationInput
}
export function parseYidaReconciliationRecord(value: unknown): YidaReconciliationRecord {
  const row = exact(value, [...keys,'id','sequence','authorId','recordedAt','evidenceOrigin','evidenceVerified','canSend','canRetry'])
  const input = parseYidaReconciliationInput(Object.fromEntries(keys.map(key => [key,row[key]])))
  if (!uuid(row.id) || row.sequence !== input.expectedHeadSequence + 1 || typeof row.authorId !== 'string'
    || !row.authorId || row.authorId.length > 128 || typeof row.recordedAt !== 'string' || !Number.isFinite(Date.parse(row.recordedAt))
    || row.evidenceOrigin !== 'operator-supplied' || row.evidenceVerified !== false || row.canSend !== false || row.canRetry !== false) fail()
  return Object.freeze({ ...row }) as YidaReconciliationRecord
}
export function parseYidaReconciliationPage(value: unknown) {
  const row = exact(value, ['records','headSequence','nextAfterId','canSend','canRetry'])
  if (!Array.isArray(row.records) || row.records.length > 50 || Object.keys(row.records).length !== row.records.length
    || typeof row.headSequence !== 'number' || !Number.isSafeInteger(row.headSequence) || row.headSequence < 0
    || row.canSend !== false || row.canRetry !== false) fail()
  const records = row.records.map(parseYidaReconciliationRecord)
  if (records.some((record,index) => record.sequence > (row.headSequence as number)
    || index > 0 && record.sequence !== records[index-1].sequence + 1)
    || row.nextAfterId !== null && (row.nextAfterId !== records.at(-1)?.id || records.length !== 50)) fail()
  return Object.freeze({ records: Object.freeze(records), headSequence: row.headSequence,
    nextAfterId: row.nextAfterId as string | null, canSend: false, canRetry: false })
}
