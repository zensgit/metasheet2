import type { EnqueuedOutboxEvent } from './automation-outbox-enqueue'
import { assertInTransaction, type TransactionalQueryable } from './pg-transaction-guard'
import { resolveAutomationRecordSchemaRevision, type AutomationRecordSchemaToken } from './automation-record-schema'

/** Host-private raw stored data, NOT a condition authorization or a hydrated record. */
export const AUTOMATION_RECORD_AFTER_IMAGE_LIMITS = Object.freeze({
  bytes: 262144,
  depth: 16,
  nodes: 8192,
  keys: 2048,
  arrayItems: 2048,
  batchRecords: 256,
  batchBytes: 4194304,
})

// DML RETURNING avoids newly transferring an unbounded stored value merely for capture. The existing
// no-op PATCH uses the same text projection in its existing locked read. Preserve PostgreSQL's JSON
// text: decoding jsonb through JS and stringifying it would silently round existing numeric values.
export const AUTOMATION_RECORD_AFTER_IMAGE_RETURNING = `version,
  CASE WHEN octet_length(data::text)<=${AUTOMATION_RECORD_AFTER_IMAGE_LIMITS.bytes} THEN data::text ELSE NULL END AS automation_after_image_json,
  (octet_length(data::text)>${AUTOMATION_RECORD_AFTER_IMAGE_LIMITS.bytes}) AS automation_after_image_oversized,
  octet_length(data::text) AS automation_after_image_bytes`

export interface AutomationRecordAfterImageInput {
  readonly sheetId: string
  readonly recordId: string
  readonly recordVersion: number
  readonly data: unknown
  /** Actual bounded PostgreSQL data::text; when present, failure MUST NOT fall back to data. */
  readonly rawJson?: unknown
  /** Private token captured before the source DML on this very transaction handle. */
  readonly schema?: AutomationRecordSchemaToken
  readonly oversized?: boolean
  /** A bulk producer may discard excess material BEFORE retaining its per-record evidence map. */
  readonly unavailableReason?: 'batch_limits'
}

type UnavailableReason = 'invalid_data' | 'value_limits' | 'batch_limits'
type EncodedImage = { json: string; reason: null } | { json: null; reason: UnavailableReason }
class CaptureRefusal extends Error {
  constructor(readonly reason: UnavailableReason) { super(reason) }
}
const refuse = (reason: UnavailableReason): never => { throw new CaptureRefusal(reason) }

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Total bounded JSON snapshot; never runs toJSON/getters or truncates an oversized record. */
export function encodeAutomationRecordAfterImage(data: unknown): EncodedImage {
  let nodes = 0, bytes = 0
  const limits = AUTOMATION_RECORD_AFTER_IMAGE_LIMITS
  const string = (value: string): string => {
    if (value.length > limits.bytes) refuse('value_limits')
    bytes += Buffer.byteLength(value, 'utf8')
    if (bytes > limits.bytes) refuse('value_limits')
    return value
  }
  const own = (value: object, key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return refuse('invalid_data')
    return descriptor.value
  }
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > limits.nodes || depth > limits.depth) return refuse('value_limits')
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'string') return string(value)
    if (typeof value === 'number') return Number.isFinite(value) ? value : refuse('invalid_data')
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return refuse('invalid_data')
      if (value.length > limits.arrayItems) return refuse('value_limits')
      if (Reflect.ownKeys(value).length !== value.length + 1) return refuse('invalid_data')
      return Array.from({ length: value.length }, (_, index) => visit(own(value, String(index)), depth + 1))
    }
    if (!plain(value)) return refuse('invalid_data')
    const keys = Reflect.ownKeys(value)
    if (keys.length > limits.keys) return refuse('value_limits')
    const result = Object.create(null) as Record<string, unknown>
    for (const key of keys) {
      if (typeof key !== 'string') return refuse('invalid_data')
      result[string(key)] = visit(own(value, key), depth + 1)
    }
    return result
  }
  try {
    if (!plain(data)) return { json: null, reason: 'invalid_data' }
    const json = JSON.stringify(visit(data, 0))
    if (Buffer.byteLength(json, 'utf8') > limits.bytes) return { json: null, reason: 'value_limits' }
    return { json, reason: null }
  } catch (error) {
    return { json: null, reason: error instanceof CaptureRefusal ? error.reason : 'invalid_data' }
  }
}

/** Check shape/limits without serializing the decoded JS numbers back into the stored evidence. */
export function encodeAutomationRecordAfterImageJson(rawJson: unknown): EncodedImage {
  if (typeof rawJson !== 'string') return { json: null, reason: 'invalid_data' }
  if (rawJson.length > AUTOMATION_RECORD_AFTER_IMAGE_LIMITS.bytes
    || Buffer.byteLength(rawJson, 'utf8') > AUTOMATION_RECORD_AFTER_IMAGE_LIMITS.bytes) {
    return { json: null, reason: 'value_limits' }
  }
  try {
    const checked = encodeAutomationRecordAfterImage(JSON.parse(rawJson))
    return checked.reason === null ? { json: rawJson, reason: null } : checked
  } catch {
    return { json: null, reason: 'invalid_data' }
  }
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value === value.trim()
    && Array.from(value).every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
}

/** Called only by the record producer immediately after its real same-transaction outbox receipt.
 * The producer, not this serializer, attests the actual DML origin. No payload or latest-row fallback.
 * Deterministic size/shape refusal stores a small unavailable row; DB errors still roll back the source.
 * A private raw capture alone does NOT prove field-at-write schema, permissions, lease or consent.
 */
export async function persistAutomationRecordAfterImage(
  trx: TransactionalQueryable, receipt: EnqueuedOutboxEvent, input: AutomationRecordAfterImageInput,
): Promise<void> {
  if ((receipt.eventType !== 'multitable.record.created' && receipt.eventType !== 'multitable.record.updated')
    || !identity(input.sheetId) || !identity(input.recordId)
    || !Number.isSafeInteger(input.recordVersion) || input.recordVersion < 1) {
    throw new Error('AUTOMATION_RECORD_AFTER_IMAGE_IDENTITY_INVALID')
  }
  await assertInTransaction(trx, 'persistAutomationRecordAfterImage')
  const schemaRevision = await resolveAutomationRecordSchemaRevision(trx, input.sheetId, input.schema)
  const encoded: EncodedImage = input.oversized === true ? { json: null, reason: 'value_limits' }
    : input.unavailableReason === 'batch_limits' ? { json: null, reason: 'batch_limits' }
      : Object.hasOwn(input, 'rawJson') ? encodeAutomationRecordAfterImageJson(input.rawJson)
        : encodeAutomationRecordAfterImage(input.data)
  // Canonical jsonb text length is checked by PostgreSQL too (JSON whitespace/escaping differs from JS).
  // Every call in a transaction shares the DB-issued xid and persisted count/byte budget, not a caller's
  // resettable JS counter. This is a capture budget, not a transaction's general record-write limit.
  const result = await trx.query(`WITH image AS (
      SELECT $7::jsonb AS data, $8::text AS reason
    ), budget AS (
      SELECT count(*) AS records,coalesce(sum(captured_bytes),0) AS bytes
        FROM meta_automation_record_after_images WHERE capture_xid=pg_catalog.pg_current_xact_id()
    ), bounded AS (
      SELECT image.data,CASE WHEN image.reason IS NOT NULL THEN image.reason
        WHEN octet_length(image.data::text)>${AUTOMATION_RECORD_AFTER_IMAGE_LIMITS.bytes} THEN 'value_limits'
        WHEN budget.records>=${AUTOMATION_RECORD_AFTER_IMAGE_LIMITS.batchRecords}
          OR budget.bytes+octet_length(image.data::text)>${AUTOMATION_RECORD_AFTER_IMAGE_LIMITS.batchBytes} THEN 'batch_limits'
        ELSE NULL END AS reason FROM image CROSS JOIN budget
    ) INSERT INTO meta_automation_record_after_images
      (outbox_id,event_type,event_id,sheet_id,record_id,record_version,status,reason,after_image,captured_bytes,schema_revision)
    SELECT $1,$2,$3,$4,$5,$6,
      CASE WHEN reason IS NULL THEN 'captured' ELSE 'unavailable' END,reason,
      CASE WHEN reason IS NULL THEN data ELSE NULL END,
      CASE WHEN reason IS NULL THEN octet_length(data::text) ELSE 0 END,$9::uuid FROM bounded
    RETURNING outbox_id`,
  [receipt.outboxId, receipt.eventType, receipt.eventId, input.sheetId, input.recordId,
    input.recordVersion, encoded.json, encoded.reason, schemaRevision])
  if (result.rows.length !== 1 || result.rows[0].outbox_id !== receipt.outboxId) {
    throw new Error('AUTOMATION_RECORD_AFTER_IMAGE_NOT_PERSISTED')
  }
}
