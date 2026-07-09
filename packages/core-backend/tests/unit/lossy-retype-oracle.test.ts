/**
 * 4c-1 loss oracle + envelope predicate — pure unit coverage (no DB). The real-DB golden matrix L1..L11 lives in
 * `tests/integration/multitable-lossy-retype-revert-realdb.test.ts`; this file pins the PURE contract the route
 * depends on: the fail-closed envelope (which is the whole safety story — see the module header for the §2.1
 * ambiguity), the double flag gate, and the three-bucket classification including its property-sensitivity.
 */
import { afterEach, describe, expect, test } from 'vitest'

import {
  classifyCellLoss,
  computeLossOutcomes,
  isLossyPropertyRetypeRevertShape,
  isLossyRetypeRevertEnabled,
  isLossyRetypeSupportedFieldType,
  summarizeLoss,
} from '../../src/multitable/lossy-retype-oracle'
import { isSupportedFieldRetypeRevert, type ConfigRevisionRow } from '../../src/multitable/config-restore'

const rev = (over: Partial<ConfigRevisionRow>): ConfigRevisionRow => ({
  id: 'r1', sheet_id: 's1', entity_type: 'field', entity_id: 'f1', action: 'update',
  before: null, after: null, changed_keys: [], ...over,
})

describe('4c-1 envelope predicate (fail-closed)', () => {
  test('admits a property-only field update revert', () => {
    expect(isLossyPropertyRetypeRevertShape(rev({ changed_keys: ['property'] }))).toBe(true)
    expect(isLossyPropertyRetypeRevertShape(rev({ changed_keys: ['name', 'property'] }))).toBe(true)
    expect(isLossyPropertyRetypeRevertShape(rev({ changed_keys: ['property', 'order'] }))).toBe(true)
  })

  test('REFUSES anything carrying a `type` change — that is the shipped schema-only tier, not this one', () => {
    expect(isLossyPropertyRetypeRevertShape(rev({ changed_keys: ['type'] }))).toBe(false)
    expect(isLossyPropertyRetypeRevertShape(rev({ changed_keys: ['type', 'property'] }))).toBe(false)
  })

  test('REFUSES non-field entities, non-update actions, unknown keys, and empty changed_keys', () => {
    expect(isLossyPropertyRetypeRevertShape(rev({ entity_type: 'view', changed_keys: ['property'] }))).toBe(false)
    expect(isLossyPropertyRetypeRevertShape(rev({ entity_type: 'sheet_config', changed_keys: ['property'] }))).toBe(false)
    expect(isLossyPropertyRetypeRevertShape(rev({ action: 'create', changed_keys: ['property'] }))).toBe(false)
    expect(isLossyPropertyRetypeRevertShape(rev({ action: 'delete', changed_keys: ['property'] }))).toBe(false)
    expect(isLossyPropertyRetypeRevertShape(rev({ changed_keys: ['property', 'somethingElse'] }))).toBe(false)
    expect(isLossyPropertyRetypeRevertShape(rev({ changed_keys: ['name'] }))).toBe(false) // no property → not ours
    expect(isLossyPropertyRetypeRevertShape(rev({ changed_keys: [] }))).toBe(false)
  })

  test('is DISJOINT from the shipped Tier-2 predicate — no revision can take both paths', () => {
    const candidates: string[][] = [['type'], ['property'], ['type', 'property'], ['name', 'property'], ['name', 'order'], ['name', 'order', 'type', 'property']]
    for (const changed_keys of candidates) {
      const r = rev({ changed_keys, before: { type: 'string', property: {} }, after: { type: 'number', property: {} } })
      expect(isLossyPropertyRetypeRevertShape(r) && isSupportedFieldRetypeRevert(r)).toBe(false)
    }
  })

  test('the TYPE half admits exactly the Batch-1 codec types (and no excluded/derived type)', () => {
    for (const t of ['currency', 'percent', 'rating', 'duration', 'url', 'email', 'phone', 'barcode', 'qrcode', 'location', 'dateTime']) {
      expect(isLossyRetypeSupportedFieldType(t)).toBe(true)
    }
    // excluded / derived / materialized types — a raw meta_fields UPDATE cannot safely leave these
    for (const t of ['formula', 'lookup', 'rollup', 'link', 'attachment', 'button', 'autoNumber', 'createdTime', 'modifiedTime', 'createdBy', 'modifiedBy']) {
      expect(isLossyRetypeSupportedFieldType(t)).toBe(false)
    }
    // plain scalars the oracle cannot reason about (coerceBatch1Value is the identity for them) stay out
    for (const t of ['string', 'number', 'boolean', 'date', 'select', 'multiSelect', 'longText', '']) {
      expect(isLossyRetypeSupportedFieldType(t)).toBe(false)
    }
  })
})

describe('4c-1 double flag gate', () => {
  const BASE = 'MULTITABLE_ENABLE_FIELD_RETYPE_REVERT'
  const LOSSY = 'MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY'
  afterEach(() => { delete process.env[BASE]; delete process.env[LOSSY] })

  test('needs BOTH flags; default off; only the exact string "true" counts', () => {
    expect(isLossyRetypeRevertEnabled({})).toBe(false)
    expect(isLossyRetypeRevertEnabled({ [BASE]: 'true' })).toBe(false)
    expect(isLossyRetypeRevertEnabled({ [LOSSY]: 'true' })).toBe(false)
    expect(isLossyRetypeRevertEnabled({ [BASE]: 'true', [LOSSY]: 'true' })).toBe(true)
    expect(isLossyRetypeRevertEnabled({ [BASE]: 'true', [LOSSY]: '1' })).toBe(false)
    expect(isLossyRetypeRevertEnabled({ [BASE]: 'true', [LOSSY]: 'TRUE' })).toBe(false)
    expect(isLossyRetypeRevertEnabled({ [BASE]: 'yes', [LOSSY]: 'true' })).toBe(false)
  })

  test('reads process.env by default and is off in a clean environment', () => {
    expect(isLossyRetypeRevertEnabled()).toBe(false)
  })
})

describe('4c-1 three-bucket cell oracle', () => {
  const bucket = (type: string, property: Record<string, unknown> | undefined, value: unknown) => classifyCellLoss(type, property, 'f1', value)

  test('unchanged: a value the restored config already represents', () => {
    expect(bucket('currency', {}, 9)).toEqual({ bucket: 'unchanged', next: 9 })
    expect(bucket('currency', {}, null)).toEqual({ bucket: 'unchanged', next: null })
    expect(bucket('rating', { max: 5 }, 3)).toEqual({ bucket: 'unchanged', next: 3 })
    expect(bucket('email', {}, 'a@b.com')).toEqual({ bucket: 'unchanged', next: 'a@b.com' })
  })

  test('coerced: representable but rewritten by the codec', () => {
    expect(bucket('currency', {}, '12.5')).toEqual({ bucket: 'coerced', next: 12.5 })
    expect(bucket('duration', {}, '3600')).toEqual({ bucket: 'coerced', next: 3600 })
    expect(bucket('url', {}, '  https://x.test  ')).toEqual({ bucket: 'coerced', next: 'https://x.test' })
  })

  test('dropped: the codec throws (not representable)', () => {
    expect(bucket('currency', {}, 'abc')).toEqual({ bucket: 'dropped', next: null })
    expect(bucket('rating', { max: 5 }, 8)).toEqual({ bucket: 'dropped', next: null })
    expect(bucket('duration', {}, -5)).toEqual({ bucket: 'dropped', next: null })
    expect(bucket('email', {}, 'not-an-email')).toEqual({ bucket: 'dropped', next: null })
  })

  test('dropped: the codec EMPTIES a non-empty value (a cell that ends up blank is a loss, not a coercion)', () => {
    expect(bucket('currency', {}, '')).toEqual({ bucket: 'dropped', next: null })
    expect(bucket('url', {}, '   ')).toEqual({ bucket: 'dropped', next: null })
  })

  test('the RESTORED property is load-bearing: the same value buckets differently under a different property', () => {
    expect(bucket('rating', { max: 10 }, 8).bucket).toBe('unchanged')
    expect(bucket('rating', { max: 5 }, 8).bucket).toBe('dropped')
  })

  test('object values compare canonically — a jsonb key-order difference is NOT a coercion', () => {
    const stored = { longitude: 2, latitude: 1, address: 'x' } // Postgres jsonb order
    expect(bucket('location', {}, stored).bucket).toBe('unchanged')
    // an extra key the codec drops IS a coercion
    expect(bucket('location', {}, { address: 'x', latitude: 1, longitude: 2, stray: 'y' }).bucket).toBe('coerced')
  })

  test('summarizeLoss counts every outcome exactly once', () => {
    const outcomes = computeLossOutcomes(
      [
        { recordId: 'a', value: 9 },
        { recordId: 'b', value: '12.5' },
        { recordId: 'c', value: 'abc' },
        { recordId: 'd', value: '' },
        { recordId: 'e', value: null },
      ],
      'currency', {}, 'f1',
    )
    expect(summarizeLoss(outcomes)).toEqual({ unchanged: 2, coerced: 1, dropped: 2 })
    expect(outcomes.find((o) => o.recordId === 'c')).toEqual({ recordId: 'c', bucket: 'dropped', before: 'abc', after: null })
    expect(outcomes.find((o) => o.recordId === 'b')).toEqual({ recordId: 'b', bucket: 'coerced', before: '12.5', after: 12.5 })
    expect(summarizeLoss([])).toEqual({ unchanged: 0, coerced: 0, dropped: 0 })
  })
})
