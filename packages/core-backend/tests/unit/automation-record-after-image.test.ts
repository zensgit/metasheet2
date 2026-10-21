import { describe, expect, it, vi } from 'vitest'
import {
  AUTOMATION_RECORD_AFTER_IMAGE_LIMITS as limits,
  AUTOMATION_RECORD_AFTER_IMAGE_RETURNING,
  encodeAutomationRecordAfterImage,
  encodeAutomationRecordAfterImageJson,
  persistAutomationRecordAfterImage,
  type AutomationRecordAfterImageInput,
} from '../../src/multitable/automation-record-after-image'
import type { EnqueuedOutboxEvent } from '../../src/multitable/automation-outbox-enqueue'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'

function captured(data: unknown): unknown {
  const result = encodeAutomationRecordAfterImage(data)
  expect(result.reason).toBeNull()
  expect(typeof result.json).toBe('string')
  return JSON.parse(result.json!) as unknown
}

describe('automation record after-image — bounded raw JSON encoding only', () => {
  it('preserves absent, explicit null and unset without filling schema or condition dependencies', () => {
    const original: Record<string, unknown> = { cleared: null, unset: 'old', unchanged: 2 }
    delete original.unset
    const output = captured(original) as Record<string, unknown>
    expect(output).toEqual({ cleared: null, unchanged: 2 })
    expect(Object.hasOwn(output, 'cleared')).toBe(true)
    expect(Object.hasOwn(output, 'unset')).toBe(false)
    expect(Object.hasOwn(output, 'neverPresent')).toBe(false)
    expect(captured({})).toEqual({})
    expect(original).toEqual({ cleared: null, unchanged: 2 })
  })

  it('preserves JSON scalar values, nested arrays, duplicate entries and their order', () => {
    const data = { a: ['z', null, 0, false, 'z', { nested: ['', true, -2.5] }], b: '  ', c: '中文😀' }
    expect(captured(data)).toEqual(data)
  })

  it('accepts null-prototype JSON maps without prototype pollution or special-key loss', () => {
    const data = Object.assign(Object.create(null) as Record<string, unknown>, { ordinary: 'value' })
    Object.defineProperty(data, '__proto__', { enumerable: true, value: { nested: 'preserved' } })
    Object.defineProperty(data, 'constructor', { enumerable: true, value: 'preserved' })
    const output = captured(data) as Record<string, unknown>
    expect(Object.hasOwn(output, '__proto__')).toBe(true)
    expect(output.__proto__).toEqual({ nested: 'preserved' })
    expect(output.constructor).toBe('preserved')
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype)
  })

  it('never executes an object getter, including a throwing getter', () => {
    const getter = vi.fn(() => { throw new Error('synthetic private value must not execute') })
    const data = Object.defineProperty({ valid: 'first' }, 'cell', { enumerable: true, get: getter })
    expect(encodeAutomationRecordAfterImage(data)).toEqual({ json: null, reason: 'invalid_data' })
    expect(getter).not.toHaveBeenCalled()
  })

  it('never invokes object or array toJSON, nor an accessor named toJSON', () => {
    const toJSON = vi.fn(() => ({ disguised: true }))
    for (const data of [
      { cell: { toJSON } }, { toJSON },
      { cell: Object.assign(['valid'], { toJSON }) },
      Object.defineProperty({}, 'toJSON', { enumerable: true, get: toJSON }),
    ]) {
      expect(encodeAutomationRecordAfterImage(data)).toEqual({ json: null, reason: 'invalid_data' })
    }
    expect(toJSON).not.toHaveBeenCalled()
  })

  it.each([NaN, Infinity, -Infinity, undefined, BigInt(1), () => 1, Symbol('cell'), new Date('2026-10-01T00:00:00Z')])('refuses a non-JSON nested value %# without silently nulling or dropping it', (cell) => {
    expect(encodeAutomationRecordAfterImage({ good: 'retained only on full success', cell })).toEqual({ json: null, reason: 'invalid_data' })
  })

  it.each([null, undefined, 1, 'text', true, [], new Date('2026-10-01T00:00:00Z')])('requires a raw object at the root %#', (data) => {
    expect(encodeAutomationRecordAfterImage(data)).toEqual({ json: null, reason: 'invalid_data' })
  })

  it('refuses custom prototypes, hidden or symbol properties, and sparse/decorated/accessor arrays', () => {
    const getter = vi.fn(() => 'not read')
    const accessor = ['value']
    Object.defineProperty(accessor, '0', { enumerable: true, get: getter })
    const candidates = [
      { cell: Object.create({ inherited: 'hidden state' }) },
      Object.defineProperty({ a: 1 }, 'hidden', { value: 2 }),
      { [Symbol('extra')]: 1 },
      { cell: new Array(1) },
      { cell: Object.assign(['a'], { extra: true }) },
      { cell: accessor },
      { cell: Object.setPrototypeOf(['a'], null) },
    ]
    for (const data of candidates) expect(encodeAutomationRecordAfterImage(data)).toEqual({ json: null, reason: 'invalid_data' })
    expect(getter).not.toHaveBeenCalled()
  })

  it('refuses cyclic graphs within a finite depth rather than executing hooks or producing partial JSON', () => {
    const data: Record<string, unknown> = { first: 'valid' }
    data.self = data
    expect(encodeAutomationRecordAfterImage(data)).toEqual({ json: null, reason: 'value_limits' })
  })

  it('allows repeated acyclic object references as repeated JSON values, not as a false cycle', () => {
    const same = { value: ['a', null] }
    expect(captured({ a: same, b: same })).toEqual({ a: same, b: same })
  })

  it('counts UTF-8 bytes instead of JS character count and preserves exactly-at-limit JSON', () => {
    const overhead = Buffer.byteLength(JSON.stringify({ x: '' }), 'utf8')
    const exact = { x: 'a'.repeat(limits.bytes - overhead) }
    const encoded = encodeAutomationRecordAfterImage(exact)
    expect(encoded.reason).toBeNull()
    expect(Buffer.byteLength(encoded.json!, 'utf8')).toBe(limits.bytes)
    expect(captured(exact)).toEqual(exact)
    expect(encodeAutomationRecordAfterImage({ x: `${exact.x}a` })).toEqual({ json: null, reason: 'value_limits' })
    const multibyte = '中'.repeat(Math.floor((limits.bytes - overhead) / 3) + 1)
    expect(multibyte.length).toBeLessThan(limits.bytes)
    expect(encodeAutomationRecordAfterImage({ x: multibyte })).toEqual({ json: null, reason: 'value_limits' })
  })

  it('counts JSON escaping and structural punctuation, not just unescaped string bytes', () => {
    const escaped = '\u0000'.repeat(Math.floor(limits.bytes / 6))
    expect(Buffer.byteLength(escaped, 'utf8')).toBeLessThan(limits.bytes)
    expect(encodeAutomationRecordAfterImage({ x: escaped })).toEqual({ json: null, reason: 'value_limits' })
    expect(captured({ x: '\n\t"\\\ud800' })).toEqual({ x: '\n\t"\\\ud800' })
  })

  it('bounds nesting depth, retaining the full accepted boundary and refusing one level further', () => {
    function nested(depth: number): unknown {
      let value: unknown = null
      for (let index = 0; index < depth; index++) value = { x: value }
      return value
    }
    expect(captured(nested(limits.depth))).toEqual(nested(limits.depth))
    expect(encodeAutomationRecordAfterImage(nested(limits.depth + 1))).toEqual({ json: null, reason: 'value_limits' })
  })

  it('bounds total visited nodes across sibling arrays, not just each branch', () => {
    const data = { a: Array(2048).fill(null), b: Array(2048).fill(null), c: Array(2048).fill(null), d: Array(2043).fill(null) }
    // 1 root + 4 arrays + 8187 scalar nodes = the actual 8192 node budget.
    expect(captured(data)).toEqual(data)
    data.d.push(null)
    expect(encodeAutomationRecordAfterImage(data)).toEqual({ json: null, reason: 'value_limits' })
  })

  it('bounds object keys and array items without truncating either collection', () => {
    const object = Object.fromEntries(Array.from({ length: limits.keys }, (_, i) => [`k${i}`, i]))
    expect(captured(object)).toEqual(object)
    expect(encodeAutomationRecordAfterImage({ ...object, excess: 1 })).toEqual({ json: null, reason: 'value_limits' })
    const array = Array.from({ length: limits.arrayItems }, (_, i) => i)
    expect(captured({ array })).toEqual({ array })
    expect(encodeAutomationRecordAfterImage({ first: 'good', array: [...array, 1] })).toEqual({ json: null, reason: 'value_limits' })
  })

  it('bounds aggregate string content across siblings and keys', () => {
    const half = 'x'.repeat(Math.floor(limits.bytes / 2))
    expect(encodeAutomationRecordAfterImage({ a: half, b: half })).toEqual({ json: null, reason: 'value_limits' })
    expect(encodeAutomationRecordAfterImage({ ['k'.repeat(limits.bytes)]: 1 })).toEqual({ json: null, reason: 'value_limits' })
  })

  it('has a fixed bounded SQL projection for DML results; this is SQL-shape evidence, not a PG execution', () => {
    expect(AUTOMATION_RECORD_AFTER_IMAGE_RETURNING).toContain(`octet_length(data::text)<=${limits.bytes}`)
    expect(AUTOMATION_RECORD_AFTER_IMAGE_RETURNING).toContain('THEN data::text ELSE NULL END AS automation_after_image_json')
    expect(AUTOMATION_RECORD_AFTER_IMAGE_RETURNING).toContain('automation_after_image_oversized')
    expect(AUTOMATION_RECORD_AFTER_IMAGE_RETURNING).toContain('automation_after_image_bytes')
  })
})

describe('automation record after-image — preserve original JSON text without a numeric round trip', () => {
  it('preserves a large integer and high-precision decimal exactly, not JSON.stringify(JSON.parse(raw))', () => {
    const rawJson = '{"integer":9007199254740993,"decimal":0.12345678901234567890123456789,"empty":null}'
    expect(JSON.stringify(JSON.parse(rawJson))).not.toBe(rawJson)
    expect(encodeAutomationRecordAfterImageJson(rawJson)).toEqual({ json: rawJson, reason: null })
  })

  it('preserves sparse keys, explicit null, ordering and array duplicates in the supplied text', () => {
    const rawJson = '{ "b": [3,1,3,null], "a": null, "__proto__": {"value":1} }'
    const result = encodeAutomationRecordAfterImageJson(rawJson)
    expect(result).toEqual({ json: rawJson, reason: null })
    const parsed = JSON.parse(result.json!) as Record<string, unknown>
    expect(Object.hasOwn(parsed, 'unset')).toBe(false)
    expect(Object.hasOwn(parsed, 'a')).toBe(true)
    expect(parsed.b).toEqual([3, 1, 3, null])
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true)
  })

  it.each([
    { rawJson: undefined }, { rawJson: null }, { rawJson: {} }, { rawJson: [] }, { rawJson: 1 },
    { rawJson: 'null' }, { rawJson: '[]' }, { rawJson: '1' }, { rawJson: '"text"' }, { rawJson: 'false' },
    { rawJson: '' }, { rawJson: 'not-json' }, { rawJson: '{"x":}' }, { rawJson: '{"x":NaN}' },
    { rawJson: '{"x":undefined}' },
  ])('refuses a nonstring, nonobject or malformed raw JSON input %#', ({ rawJson }) => {
    expect(encodeAutomationRecordAfterImageJson(rawJson)).toEqual({ json: null, reason: 'invalid_data' })
  })

  it('never stringifies/coerces a supplied object or invokes its toJSON/getters', () => {
    const callback = vi.fn(() => '{}')
    const rawJson = Object.defineProperty({ toJSON: callback, toString: callback }, 'value', { enumerable: true, get: callback })
    expect(encodeAutomationRecordAfterImageJson(rawJson)).toEqual({ json: null, reason: 'invalid_data' })
    expect(callback).not.toHaveBeenCalled()
  })

  it('checks original UTF-8 bytes, including insignificant whitespace, before accepting text', () => {
    const exact = `{"x":"${'a'.repeat(limits.bytes - 8)}"}`
    expect(Buffer.byteLength(exact, 'utf8')).toBe(limits.bytes)
    expect(encodeAutomationRecordAfterImageJson(exact)).toEqual({ json: exact, reason: null })
    expect(encodeAutomationRecordAfterImageJson(`${exact} `)).toEqual({ json: null, reason: 'value_limits' })
    const utf8 = `{"x":"${'中'.repeat(Math.floor((limits.bytes - 8) / 3) + 1)}"}`
    expect(utf8.length).toBeLessThan(limits.bytes)
    expect(encodeAutomationRecordAfterImageJson(utf8)).toEqual({ json: null, reason: 'value_limits' })
    expect(encodeAutomationRecordAfterImageJson(`${' '.repeat(limits.bytes)}{}`)).toEqual({ json: null, reason: 'value_limits' })
  })

  it('retains structure budgets in the raw-text path rather than treating valid JSON as sufficient', () => {
    let nested: unknown = null
    for (let i = 0; i < limits.depth + 1; i++) nested = { x: nested }
    const tooManyKeys = Object.fromEntries(Array.from({ length: limits.keys + 1 }, (_, i) => [`k${i}`, i]))
    const tooManyItems = { values: Array(limits.arrayItems + 1).fill(null) }
    const tooManyNodes = { a: Array(2048).fill(null), b: Array(2048).fill(null), c: Array(2048).fill(null), d: Array(2044).fill(null) }
    for (const value of [nested, tooManyKeys, tooManyItems, tooManyNodes]) {
      expect(encodeAutomationRecordAfterImageJson(JSON.stringify(value))).toEqual({ json: null, reason: 'value_limits' })
    }
  })
})

const receipt: EnqueuedOutboxEvent = {
  outboxId: 'obx_synthetic', eventType: 'multitable.record.updated', eventId: 'event_synthetic',
  manifestVersion: 1, consumerKeys: ['automation'],
}
const input: AutomationRecordAfterImageInput = {
  sheetId: 'sheet_synthetic', recordId: 'record_synthetic', recordVersion: 7, data: { privateCell: 'synthetic-value' },
}

// Honest query-shape fixture, NOT a PostgreSQL transaction/constraint/retention or provenance proof.
// Constant xid replies only let us reach and inspect the real persist function's emitted SQL/params.
function queryFixture(rows: Array<Record<string, unknown>> = [{ outbox_id: receipt.outboxId }]) {
  const statements: Array<{ sql: string; params?: unknown[] }> = []
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    statements.push({ sql, params })
    if (sql === 'SELECT pg_current_xact_id()::text AS xid') return { rows: [{ xid: 'synthetic-xid' }], rowCount: 1 }
    return { rows, rowCount: rows.length }
  })
  const trx: TransactionalQueryable = { isTransaction: true, query }
  return { trx, query, statements }
}

describe('automation record after-image — persist query contract only', () => {
  it('binds original rawJson directly as $7, preserving numeric precision instead of using data', async () => {
    const rawJson = '{"integer":9007199254740993,"decimal":0.12345678901234567890123456789}'
    const { trx, statements } = queryFixture()
    await persistAutomationRecordAfterImage(trx, receipt, { ...input, rawJson, data: JSON.parse(rawJson) })
    expect(statements[2].params?.slice(6, 8)).toEqual([rawJson, null])
    expect(statements[2].params?.[6]).not.toBe(JSON.stringify(JSON.parse(rawJson)))
  })

  it.each([
    { rawJson: undefined }, { rawJson: null }, { rawJson: [] }, { rawJson: '[]' },
    { rawJson: '{"broken":' }, { rawJson: 'null' },
  ])('does not fall back to good data when rawJson is explicitly supplied but unusable %#', async ({ rawJson }) => {
    const { trx, statements } = queryFixture()
    await persistAutomationRecordAfterImage(trx, receipt, { ...input, rawJson })
    expect(statements[2].params?.slice(6, 8)).toEqual([null, 'invalid_data'])
  })

  it('does not inspect a fallback data getter when an own rawJson property is present', async () => {
    const getter = vi.fn(() => { throw new Error('fallback is forbidden') })
    const supplied = Object.defineProperty({ ...input, rawJson: undefined }, 'data', { enumerable: true, get: getter })
    const { trx, statements } = queryFixture()
    await persistAutomationRecordAfterImage(trx, receipt, supplied)
    expect(statements[2].params?.slice(6, 8)).toEqual([null, 'invalid_data'])
    expect(getter).not.toHaveBeenCalled()
  })

  it('passes the exact identity and complete raw JSON as bound values after transaction probes', async () => {
    const { trx, statements } = queryFixture()
    await persistAutomationRecordAfterImage(trx, receipt, input)
    expect(statements).toHaveLength(3)
    expect(statements[0].sql).toBe('SELECT pg_current_xact_id()::text AS xid')
    expect(statements[1].sql).toBe(statements[0].sql)
    expect(statements[2].params).toEqual([
      receipt.outboxId, receipt.eventType, receipt.eventId, input.sheetId, input.recordId,
      input.recordVersion, JSON.stringify(input.data), null, null,
    ])
    expect(statements[2].sql).not.toContain('synthetic-value')
    expect(statements[2].sql).not.toContain(input.sheetId)
    expect(statements[2].sql).toContain('capture_xid=pg_catalog.pg_current_xact_id()')
    expect(statements[2].sql).toContain(`budget.records>=${limits.batchRecords}`)
    expect(statements[2].sql).toContain(`>${limits.batchBytes}`)
  })

  it.each([
    [{ data: { bad: undefined } }, 'invalid_data'],
    [{ data: { bad: 'x'.repeat(limits.bytes + 1) } }, 'value_limits'],
    [{ oversized: true }, 'value_limits'],
    [{ unavailableReason: 'batch_limits' }, 'batch_limits'],
  ] as [Partial<AutomationRecordAfterImageInput>, string][])('persists only a fixed unavailable reason with no partial body %#', async (extra, reason) => {
    const { trx, statements } = queryFixture()
    await persistAutomationRecordAfterImage(trx, receipt, { ...input, ...extra })
    expect(statements[2].params?.slice(6, 8)).toEqual([null, reason])
    expect(statements[2].sql).not.toContain('synthetic-value')
  })

  it('does not inspect refused oversized/batch-limited data or invoke its getters', async () => {
    const getter = vi.fn(() => { throw new Error('must not execute') })
    const data = Object.defineProperty({}, 'cell', { enumerable: true, get: getter })
    for (const extra of [{ oversized: true }, { unavailableReason: 'batch_limits' as const }]) {
      const { trx, statements } = queryFixture()
      await persistAutomationRecordAfterImage(trx, receipt, { ...input, data, ...extra })
      expect(statements[2].params?.[6]).toBeNull()
    }
    expect(getter).not.toHaveBeenCalled()
  })

  it.each([
    { sheetId: '' }, { sheetId: ' padded ' }, { recordId: 'invalid\nidentity' },
    { recordVersion: 0 }, { recordVersion: 1.5 }, { recordVersion: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid identity without querying or leaking the input %#', async (extra) => {
    const { trx, query } = queryFixture()
    await expect(persistAutomationRecordAfterImage(trx, receipt, { ...input, ...extra })).rejects.toThrow('AUTOMATION_RECORD_AFTER_IMAGE_IDENTITY_INVALID')
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects an unrelated event family before querying', async () => {
    const { trx, query } = queryFixture()
    await expect(persistAutomationRecordAfterImage(trx, { ...receipt, eventType: 'multitable.record.deleted' }, input)).rejects.toThrow('AUTOMATION_RECORD_AFTER_IMAGE_IDENTITY_INVALID')
    expect(query).not.toHaveBeenCalled()
  })

  it.each([
    { rows: [] },
    { rows: [{ outbox_id: 'different' }] },
    { rows: [{ outbox_id: receipt.outboxId }, { outbox_id: receipt.outboxId }] },
  ])('requires one exact persisted receipt row %#', async ({ rows }) => {
    const { trx } = queryFixture(rows)
    await expect(persistAutomationRecordAfterImage(trx, receipt, input)).rejects.toThrow('AUTOMATION_RECORD_AFTER_IMAGE_NOT_PERSISTED')
  })

  it('propagates query failure instead of returning a pretend unavailable success', async () => {
    const { trx, query } = queryFixture()
    const failure = new Error('synthetic database failure')
    query.mockRejectedValueOnce(failure)
    await expect(persistAutomationRecordAfterImage(trx, receipt, input)).rejects.toBe(failure)
    expect(query).toHaveBeenCalledTimes(1)
  })
})
