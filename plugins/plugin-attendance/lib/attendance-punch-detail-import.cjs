const BUSINESS_KEYS = ['inputKind', 'userId', 'workDate', 'timezone', 'punches']
const TRANSPORT_KEYS = ['orgId', 'idempotencyKey', 'commitToken', 'previewLimit', 'returnItems', 'itemsLimit', 'mode']
const ALLOWED_KEYS = new Set([...BUSINESS_KEYS, ...TRANSPORT_KEYS])
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

/** Only absence selects the unchanged daily-row path; named input is never normalized as daily rows. */
function readAttendancePunchDetailRequestV1(raw, { HttpError, parseInput }) {
  const invalid = () => { throw new HttpError(400, 'ATTENDANCE_PUNCH_DETAIL_INPUT_INVALID', 'ATTENDANCE_PUNCH_DETAIL_INPUT_INVALID') }
  if (raw === null || typeof raw !== 'object') return null
  if (own(raw, '__punchDetailInput')) invalid()
  if (!('inputKind' in raw)) return null
  if (!own(raw, 'inputKind') || Array.isArray(raw)) invalid()
  const prototype = Object.getPrototypeOf(raw)
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(raw)
  if (Reflect.ownKeys(raw).some((key) => typeof key !== 'string' || !ALLOWED_KEYS.has(key) || !('value' in descriptors[key]))) invalid()
  if (raw.inputKind !== 'punch_events_v1') invalid()
  if (typeof parseInput !== 'function') {
    throw new HttpError(503, 'ATTENDANCE_PUNCH_DETAIL_HOST_MISSING', 'ATTENDANCE_PUNCH_DETAIL_HOST_MISSING')
  }
  let input
  try {
    input = parseInput(Object.fromEntries(BUSINESS_KEYS.map((key) => [key, raw[key]])))
  } catch (error) {
    if (error?.code === 'ATTENDANCE_PUNCH_DETAIL_INPUT_INVALID') invalid()
    throw error
  }
  if (raw.orgId !== undefined && typeof raw.orgId !== 'string') invalid()
  if (raw.commitToken !== undefined && typeof raw.commitToken !== 'string') invalid()
  if (raw.idempotencyKey !== undefined && (typeof raw.idempotencyKey !== 'string'
    || raw.idempotencyKey.trim().length < 1 || raw.idempotencyKey.trim().length > 128)) invalid()
  for (const key of ['previewLimit', 'itemsLimit']) {
    if (raw[key] !== undefined && (!Number.isInteger(raw[key]) || raw[key] < 1 || raw[key] > 1000)) invalid()
  }
  if (raw.returnItems !== undefined && typeof raw.returnItems !== 'boolean') invalid()
  if (raw.mode !== undefined && raw.mode !== 'override') invalid()
  return Object.freeze({
    input,
    // This selector is checked against authenticated access by the route; never identity authority.
    orgId: raw.orgId ?? null,
    idempotencyKey: raw.idempotencyKey?.trim() ?? null,
    commitToken: raw.commitToken ?? null,
    previewLimit: raw.previewLimit ?? null,
    returnItems: raw.returnItems !== false,
    itemsLimit: raw.itemsLimit ?? null,
  })
}

module.exports = { readAttendancePunchDetailRequestV1 }
