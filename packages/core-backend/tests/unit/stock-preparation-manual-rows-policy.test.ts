/**
 * 人工补充行 B2 — THE SWITCH (ADR adr-stock-prep-manual-rows-20261030 §4; §8 「B2 主机」 5):
 * `property.stockPreparationManualRows` on the key column. Absent or exactly `'allowed'` = allowed; ANY other present
 * value = disabled, and both sanitizer chokepoints NORMALIZE such a value to `'disabled'` — never drop it (a dropped value
 * reads as absent = allowed = fail open, which is why this is not `withHumanWriteLockKey`'s rule).
 *
 *   P-01 the value rule, over every shape a stored property can hold (raw object, JSON-string jsonb);
 *   P-02 the cross-cutting rule: normalized on a COPY, a valid value returned as is, the source never mutated;
 *   P-03 the field-codecs chokepoint for every field type (closed-allowlist branches included) and the read serializer;
 *   P-04 the write chokepoint: provisioning.patchObjectFieldProperty (the plugin's switch route writes through it);
 *   P-05 the person field-write helpers: POST /fields strips it, PATCH /fields carries the STORED value;
 *   P-06 the config revert keeps the STORED value (preview target and write), untouched when neither side has a key;
 *   P-07 wiring (source scan): the route-local sibling sanitizer, the strip and the carry are in place;
 *   P-08 the gate reads the switch from the RAW stored property with the same rule.
 */
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  MANUAL_ROWS_POLICY_PROPERTY_KEY,
  carryManualRowPolicy,
  manualRowsPolicyOfProperty,
  manualRowsPolicyValueOf,
  stripManualRowPolicyKey,
  withManualRowPolicyKey,
} from '../../src/multitable/stock-preparation-manual-rows'
import { evaluateManualRowsGate, deriveManualRowsFieldIds } from '../../src/multitable/stock-preparation-manual-rows-gate'
import { sanitizeFieldProperty, serializeFieldRow } from '../../src/multitable/field-codecs'
import { patchObjectFieldProperty, getObjectFieldId } from '../../src/multitable/provisioning'
import { applyConfigRevert, computeRevertPreview, fieldRevertPropertyKeepingLock } from '../../src/multitable/config-restore'

const KEY = MANUAL_ROWS_POLICY_PROPERTY_KEY
const SRC = path.resolve(__dirname, '../../src')
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')

const JUNK: Array<[string, unknown]> = [
  ["'disabled'", 'disabled'],
  ["'ALLOWED' (case)", 'ALLOWED'],
  ["' allowed' (space)", ' allowed'],
  ["'allowed ' (space)", 'allowed '],
  ["'nope'", 'nope'],
  ["''", ''],
  ['null', null],
  ['true', true],
  ['false', false],
  ['0', 0],
  ['1', 1],
  ['{}', {}],
  ['[]', []],
  ["['allowed']", ['allowed']],
]

describe('P-01 the value rule', () => {
  it('absent (no key, or an undefined value JSON cannot store) → no value, the effect is allowed', () => {
    for (const property of [{}, { other: 1 }, { [KEY]: undefined }, null, undefined, '', 'not json', '[]', 42]) {
      expect(manualRowsPolicyValueOf(property), JSON.stringify(property)).toBeNull()
      expect(manualRowsPolicyOfProperty(property)).toBe('allowed')
    }
  })
  it("exactly 'allowed' → allowed (raw object and JSON-string property)", () => {
    expect(manualRowsPolicyValueOf({ [KEY]: 'allowed' })).toBe('allowed')
    expect(manualRowsPolicyValueOf(JSON.stringify({ [KEY]: 'allowed' }))).toBe('allowed')
    expect(manualRowsPolicyOfProperty({ [KEY]: 'allowed' })).toBe('allowed')
  })
  it.each(JUNK)('any other present value (%s) → disabled', (_label, value) => {
    expect(manualRowsPolicyValueOf({ [KEY]: value })).toBe('disabled')
    expect(manualRowsPolicyOfProperty({ [KEY]: value })).toBe('disabled')
    expect(manualRowsPolicyOfProperty(JSON.stringify({ [KEY]: value }))).toBe('disabled')
  })
})

describe('P-02 the cross-cutting rule', () => {
  it('a junk value is normalized to disabled on a COPY; the source is not mutated', () => {
    const source = { [KEY]: 'nope', other: 1 }
    const out = withManualRowPolicyKey(source, source)
    expect(out).not.toBe(source)
    expect(out).toEqual({ [KEY]: 'disabled', other: 1 })
    expect(source).toEqual({ [KEY]: 'nope', other: 1 })
  })
  it("a valid value ('allowed' / 'disabled') is returned as is — same object", () => {
    for (const value of ['allowed', 'disabled']) {
      const obj = { [KEY]: value, other: 1 }
      expect(withManualRowPolicyKey(obj, obj)).toBe(obj)
    }
  })
  it('absent in the source → absent in the output (a stray key on the sanitized side is dropped on a copy)', () => {
    const plain = { a: 1 }
    expect(withManualRowPolicyKey(plain, {})).toBe(plain)
    const stray = { a: 1, [KEY]: 'allowed' }
    const out = withManualRowPolicyKey(stray, { a: 1 })
    expect(KEY in out).toBe(false)
    expect(stray[KEY]).toBe('allowed')
  })
})

describe('P-03 the field-codecs chokepoint (provisioning write + read serializer)', () => {
  for (const type of ['string', 'number', 'boolean', 'date', 'select', 'multiSelect', 'person', 'button', 'longText', 'link', 'attachment']) {
    it(`${type}: junk → disabled, 'allowed' kept, absent stays absent`, () => {
      expect(sanitizeFieldProperty(type, { [KEY]: 'nope' })[KEY]).toBe('disabled')
      expect(sanitizeFieldProperty(type, { [KEY]: null })[KEY]).toBe('disabled')
      expect(sanitizeFieldProperty(type, { [KEY]: 'allowed' })[KEY]).toBe('allowed')
      expect(KEY in sanitizeFieldProperty(type, {})).toBe(false)
    })
  }
  it('the read serializer (serializeFieldRow) carries the normalized value to clients, from a JSON-string property too', () => {
    expect((serializeFieldRow({ id: 'f', name: 'n', type: 'string', property: { [KEY]: 'off' }, order: 0 }).property as Record<string, unknown>)[KEY]).toBe('disabled')
    expect((serializeFieldRow({ id: 'f', name: 'n', type: 'string', property: JSON.stringify({ [KEY]: 'allowed' }), order: 0 }).property as Record<string, unknown>)[KEY]).toBe('allowed')
  })
  it('the lock and the switch coexist on the key column through the chain', () => {
    const out = sanitizeFieldProperty('string', { humanWriteLock: 'plm_system', stockPreparation: { key: true }, [KEY]: 'x' })
    expect(out).toMatchObject({ humanWriteLock: 'plm_system', stockPreparation: { key: true }, [KEY]: 'disabled' })
  })
})

describe('P-04 the write chokepoint: provisioning.patchObjectFieldProperty', () => {
  function provisioningQuery(stored: Record<string, unknown>) {
    const written: unknown[] = []
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      const q = sql.replace(/\s+/g, ' ').trim()
      if (q.startsWith('SELECT id, sheet_id, name, type, property, "order" FROM meta_fields')) {
        return { rows: [{ id: params[1], sheet_id: params[0], name: 'Key', type: 'string', property: stored, order: 1 }] }
      }
      if (q.startsWith('UPDATE meta_fields SET property = $3::jsonb')) {
        written.push(JSON.parse(String(params[2])))
        return { rows: [{ id: params[1], sheet_id: params[0], name: 'Key', type: 'string', property: JSON.parse(String(params[2])), order: 1 }] }
      }
      return { rows: [] }
    })
    return { query, written }
  }
  it.each([
    ['allowed', 'allowed'],
    ['disabled', 'disabled'],
    ['junk', 'disabled'],
    [null, 'disabled'],
  ])('a patch of %j is stored as %j (merged onto the stored property, the lock kept)', async (value, expected) => {
    const { query, written } = provisioningQuery({ humanWriteLock: 'plm_system', stockPreparation: { key: true } })
    await patchObjectFieldProperty({ query, projectId: 'tenant_p:integration-core', objectId: 'plm_stock_preparation_sandbox_p_000000000000000000000001', fieldId: 'idempotencyKey', propertyPatch: { [KEY]: value } })
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ humanWriteLock: 'plm_system', stockPreparation: { key: true }, [KEY]: expected })
  })
})

describe('P-05 the person field-write helpers (POST /fields strips, PATCH /fields carries the STORED value)', () => {
  it('strip: a person body can never SET the switch', () => {
    expect(stripManualRowPolicyKey({ a: 1, [KEY]: 'disabled' })).toEqual({ a: 1 })
    const plain = { a: 1 }
    expect(stripManualRowPolicyKey(plain)).toBe(plain)
  })
  it('carry: the stored value wins over a body that sets, clears, changes or omits it', () => {
    expect(carryManualRowPolicy({ [KEY]: 'disabled' }, { a: 1 })).toEqual({ a: 1, [KEY]: 'disabled' })
    expect(carryManualRowPolicy({ [KEY]: 'disabled' }, { a: 1, [KEY]: 'allowed' })).toEqual({ a: 1, [KEY]: 'disabled' })
    expect(carryManualRowPolicy({ [KEY]: 'allowed' }, { [KEY]: 'disabled' })).toEqual({ [KEY]: 'allowed' })
    expect(carryManualRowPolicy({}, { a: 1, [KEY]: 'disabled' })).toEqual({ a: 1 })
    // A junk stored value carries as what it means (disabled), never as allowed.
    expect(carryManualRowPolicy({ [KEY]: 'off' }, {})).toEqual({ [KEY]: 'disabled' })
  })
})

describe('P-06 the config revert keeps the STORED switch (preview target and write)', () => {
  const rev = (before: Record<string, unknown>, after: Record<string, unknown>) => ({
    id: 'rev_mrb2', sheet_id: 'sheet_x', entity_type: 'field' as const, entity_id: 'fld_key', action: 'update' as const,
    before, after, changed_keys: ['property'],
  })
  it('helper: the stored value wins in both directions; neither side with a key → the revert property untouched (same reference)', () => {
    expect(fieldRevertPropertyKeepingLock({ [KEY]: 'disabled' }, { a: 1 })).toEqual({ a: 1, [KEY]: 'disabled' })
    expect(fieldRevertPropertyKeepingLock({}, { a: 1, [KEY]: 'disabled' })).toEqual({ a: 1 })
    expect(fieldRevertPropertyKeepingLock({ [KEY]: 'allowed', humanWriteLock: 'plm_system' }, { [KEY]: 'disabled' })).toEqual({ [KEY]: 'allowed', humanWriteLock: 'plm_system' })
    const plain = { a: 1 }
    expect(fieldRevertPropertyKeepingLock({ b: 2 }, plain)).toBe(plain)
  })
  it('computeRevertPreview discloses the carried value in target.property', () => {
    const preview = computeRevertPreview(rev({ property: { [KEY]: 'allowed' } }, { property: { [KEY]: 'disabled' } }), { property: { [KEY]: 'disabled' } })
    expect((preview.target.property as Record<string, unknown>)[KEY]).toBe('disabled')
  })
  it('applyConfigRevert writes the carried value (reads the stored property first)', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const query = async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      if (sql.startsWith('SELECT property FROM meta_fields')) return { rows: [{ property: { [KEY]: 'disabled' } }] }
      return { rows: [] }
    }
    await applyConfigRevert(query, rev({ property: { [KEY]: 'allowed' } }, { property: { [KEY]: 'disabled' } }))
    const update = calls.find((c) => c.sql.startsWith('UPDATE meta_fields'))!
    expect(update.sql).toContain('property = $')
    const written = update.params.find((p) => typeof p === 'string' && p.trim().startsWith('{'))
    expect(JSON.parse(String(written))).toEqual({ [KEY]: 'disabled' })
  })
})

describe('P-07 wiring (source scan): both chokepoints, the strip and the carry', () => {
  it('field-codecs sanitizeFieldProperty wraps the chain in withManualRowPolicyKey', () => {
    const codecs = read('multitable/field-codecs.ts')
    const fn = codecs.slice(codecs.indexOf('export function sanitizeFieldProperty('), codecs.indexOf('export function withLayer2VisibilityKeys('))
    expect(fn).toContain('return withManualRowPolicyKey(')
    expect(fn).toContain('withHumanWriteLockKey(')
  })
  it('the route-local sibling sanitizer in univer-meta.ts applies the same function', () => {
    const meta = read('routes/univer-meta.ts')
    const fn = meta.slice(meta.indexOf('function sanitizeFieldProperty(type: UniverMetaField'), meta.indexOf('function sanitizeFieldPropertyByType(type: UniverMetaField'))
    expect(fn).toContain('return withManualRowPolicyKey(')
  })
  it('POST /fields strips it (normalizeFieldWriteInput); PATCH /fields carries the stored value', () => {
    const meta = read('routes/univer-meta.ts')
    expect(meta).toContain('property: stripManualRowPolicyKey(stripHumanWriteLockKey(sanitizeFieldProperty(requestedType as UniverMetaField[\'type\'], rawProperty))),')
    expect(meta).toContain('const nextProperty = carryManualRowPolicy(row.property, carryHumanWriteLock(row.property, normalizedNextProperty))')
  })
  it('the provisioning write runs through the field-codecs chokepoint (sanitizeFieldProperty)', () => {
    const provisioning = read('multitable/provisioning.ts')
    const fn = provisioning.slice(provisioning.indexOf('export async function patchObjectFieldProperty('), provisioning.indexOf('export type GetObjectFieldInput'))
    expect(fn).toContain('const property = sanitizeFieldProperty(fieldType, mergedProperty)')
  })
})

describe('P-08 the gate reads the switch from the RAW stored property, with the same rule', () => {
  const projectId = 'tenant_p8:integration-core'
  const objectId = 'plm_stock_preparation_sandbox_p_000000000000000000000008'
  const derived = deriveManualRowsFieldIds(projectId, objectId)
  const fieldRows = (policy: unknown, withPolicy: boolean) => [
    { id: derived.key, property: { stockPreparation: { key: true }, humanWriteLock: 'plm_system', ...(withPolicy ? { [KEY]: policy } : {}) } },
    { id: derived.projectNo, property: { stockPreparation: { key: false }, humanWriteLock: 'plm_system' } },
    { id: derived.active, property: { stockPreparation: { key: false }, humanWriteLock: 'plm_system' } },
    { id: derived.byLogical.componentName, property: { stockPreparation: { key: false }, humanWriteLock: 'plm_system' } },
    { id: derived.byLogical.totalQuantity, property: { stockPreparation: { key: false }, humanWriteLock: 'plm_system' } },
  ]
  const verdict = (policy: unknown, withPolicy = true) => evaluateManualRowsGate({
    sheetId: 'sheet_p8',
    fields: fieldRows(policy, withPolicy),
    host: { kind: 'present', row: { projectId, objectId, pluginName: 'plugin-integration-core' } },
    target: { kind: 'present', row: { sheetId: 'sheet_p8', projectNo: 'SYN-P8', status: 'active', objectId, tenantId: 'tenant_p8' } },
    mode: 'create',
    flagOn: true,
  }).kind
  it('absent / allowed → allowed; every junk value → disabled', () => {
    expect(verdict(undefined, false)).toBe('allowed')
    expect(verdict('allowed')).toBe('allowed')
    for (const [, value] of JUNK) expect(verdict(value), JSON.stringify(value)).toBe('disabled')
  })
  it('a JSON-string key property is read the same way', () => {
    const rows = fieldRows('nope', true).map((row, i) => (i === 0 ? { ...row, property: JSON.stringify(row.property) } : row))
    expect(evaluateManualRowsGate({
      sheetId: 'sheet_p8', fields: rows,
      host: { kind: 'present', row: { projectId, objectId, pluginName: 'plugin-integration-core' } },
      target: { kind: 'present', row: { sheetId: 'sheet_p8', projectNo: 'SYN-P8', status: 'active', objectId, tenantId: 'tenant_p8' } },
      mode: 'create', flagOn: true,
    }).kind).toBe('disabled')
    expect(getObjectFieldId(projectId, objectId, 'idempotencyKey')).toBe(derived.key)
  })
})
