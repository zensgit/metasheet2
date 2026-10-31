import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { parseAttendancePunchDetailInputV1, type AttendancePunchDetailInputV1 } from '../w4c3a-punch-detail-input'
import { punchDetailPreparationFixture } from './helpers/punch-detail-plan-fixture'

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
const require = createRequire(import.meta.url)
const { readAttendancePunchDetailRequestV1: read } = require('../../../../../plugins/plugin-attendance/lib/attendance-punch-detail-import.cjs') as {
  readAttendancePunchDetailRequestV1(raw: unknown, deps: { HttpError: typeof HttpError; parseInput?: typeof parseAttendancePunchDetailInputV1 }): null | {
    input: AttendancePunchDetailInputV1; orgId: string | null; idempotencyKey: string | null; commitToken: string | null
    previewLimit: number | null; returnItems: boolean; itemsLimit: number | null
  }
}
const deps = { HttpError, parseInput: parseAttendancePunchDetailInputV1 }
const business = () => punchDetailPreparationFixture().envelope.__punchDetailInput
const invalid = (raw: unknown) => {
  try { read(raw, deps) } catch (error) {
    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ status: 400, code: 'ATTENDANCE_PUNCH_DETAIL_INPUT_INVALID', message: 'ATTENDANCE_PUNCH_DETAIL_INPUT_INVALID' })
    return
  }
  throw new Error('EXPECTED_NAMED_INPUT_REFUSAL')
}

describe('public punch-detail discriminator before daily normalization', () => {
  it('leaves absent legacy input untouched without requiring the new core port', () => {
    const raw = { rows: [{ userId: 'legacy-user', workDate: '2026-01-01' }], source: 'manual' }
    expect(read(raw, { HttpError })).toBeNull()
    expect(raw).toEqual({ rows: [{ userId: 'legacy-user', workDate: '2026-01-01' }], source: 'manual' })
  })
  it('separates the exact business object from existing transport options', () => {
    const input = business()
    expect(read({ ...input, orgId: 'selected-org', idempotencyKey: '  request-key  ', commitToken: 'token-fixture',
      previewLimit: 10, returnItems: false, itemsLimit: 1, mode: 'override' }, deps)).toEqual({
      input, orgId: 'selected-org', idempotencyKey: 'request-key', commitToken: 'token-fixture',
      previewLimit: 10, returnItems: false, itemsLimit: 1,
    })
  })
  it('keeps all four instants and uses closed transport defaults', () => {
    const input = business()
    const result = read(input, deps)
    expect(result).toEqual({ input, orgId: null, idempotencyKey: null, commitToken: null, previewLimit: null, returnItems: true, itemsLimit: null })
    expect(result?.input.punches).toHaveLength(4)
    expect(Object.isFrozen(result?.input.punches)).toBe(true)
    expect(Object.isFrozen(result)).toBe(true)
  })
  it.each([null, '', 'daily_rows', 1])('refuses explicit invalid discriminator %j instead of daily fallback', (inputKind) => {
    invalid({ ...business(), inputKind })
  })
  it.each(['rows', 'entries', 'csvFileId', 'engine', 'ruleSetId', 'groupSync', 'batchMeta', '__punchDetailInput', 'actorId'])(
    'refuses unsupported or internal named-format field %s', (key) => { invalid({ ...business(), [key]: 'forbidden-fixture' }) },
  )
  it('rejects an internal command marker even without a public discriminator', () => {
    invalid({ rows: [], __punchDetailInput: business() })
  })
  it.each([
    { idempotencyKey: ' ' }, { idempotencyKey: 'x'.repeat(129) }, { commitToken: 1 },
    { previewLimit: 0 }, { previewLimit: 1001 }, { itemsLimit: 1.5 }, { returnItems: 'false' },
    { mode: 'merge' }, { orgId: 1 },
  ])('retains strict transport validation %j', (transport) => { invalid({ ...business(), ...transport }) })
  it('rejects getters without invoking them', () => {
    let invoked = false
    const raw = { ...business() }
    Object.defineProperty(raw, 'commitToken', { enumerable: true, get() { invoked = true; return 'hidden' } })
    invalid(raw)
    expect(invoked).toBe(false)
  })
  it('refuses an inherited discriminator', () => { invalid(Object.assign(Object.create({ inputKind: 'punch_events_v1' }), { rows: [] })) })
  it('does not substitute daily behavior when the core port is unavailable', () => {
    expect(() => read(business(), { HttpError })).toThrow('ATTENDANCE_PUNCH_DETAIL_HOST_MISSING')
  })
  it('rejects changed physical evidence through the real core parser', () => {
    const raw = business()
    invalid({ ...raw, punches: [...raw.punches].reverse() })
  })
})
