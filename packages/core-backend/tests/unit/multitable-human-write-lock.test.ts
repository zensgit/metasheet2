/**
 * 备料 option B (awaiting the owner's A/B/C ruling) — the HUMAN WRITE LOCK (multitable/human-write-lock.ts).
 *
 * `property.humanWriteLock = 'plm_system'` makes a column read-only for PEOPLE while the plugin records SDK (the
 * PLM apply) keeps writing it. Both halves are pinned here, plus the wiring that makes the person half real:
 *
 *   L1  the predicate is a closed vocabulary (exact `'plm_system'` only).
 *   L2  the PLUGIN half: `isFieldAlwaysReadOnly` — the plugin records SDK's guard — does NOT see the lock; the
 *       person floor `isFieldReadOnlyForPeople` does. (records.ts behaviour is pinned in multitable-records.test.ts
 *       "B tripwire" cases and end to end in the real-DB suite.)
 *   L3  `deriveFieldPermissions` marks the column read-only for every capability level, and a per-subject scope
 *       cannot lift it (no administrator override).
 *   L4  both sanitizers keep a valid lock for every type (including the closed-allowlist person / button branches),
 *       drop junk values, and never mutate the caller's property object.
 *   L5  the person field-write helpers: a person can neither set (strip) nor clear / change (carry) the lock.
 *   L6  a sheet copy drops the lock (the copy has no system writer).
 *   L7  the bulk / collab write spine (`RecordWriteService.validateChanges`) refuses with the CLOSED code.
 *   L8  wiring (source scan): every person guard builder uses the person floor, and the plugin records path never
 *       imports the lock module.
 *   L10 `hasHumanWriteLockedRequiredField` (R68): a locked column that its own validation marks required means no
 *       person can create a record on the sheet; `GET /context` reports it as `recordCreateBlockedByLock`.
 */
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  FIELD_HUMAN_WRITE_LOCK_PROPERTY_KEY,
  FIELD_READONLY_PLM_SYSTEM_CODE,
  carryHumanWriteLock,
  hasHumanWriteLockedRequiredField,
  humanWriteLockRefusalBody,
  isFieldHumanWriteLocked,
  listHumanWriteLockedFieldIds,
  stripHumanWriteLockKey,
  withHumanWriteLockKey,
} from '../../src/multitable/human-write-lock'
import {
  deriveFieldPermissions,
  isFieldAlwaysReadOnly,
  isFieldReadOnlyForPeople,
  isFieldWriteForbidden,
} from '../../src/multitable/permission-derivation'
import { sanitizeFieldProperty, serializeFieldRow } from '../../src/multitable/field-codecs'
import { remapFieldProperty, type FieldRemapContext } from '../../src/multitable/copy-sheet-remap'
import { RecordFieldForbiddenError, RecordWriteService } from '../../src/multitable/record-write-service'
import { applyConfigRevert, computeRevertPreview, fieldRevertPropertyKeepingLock } from '../../src/multitable/config-restore'

const LOCK = { humanWriteLock: 'plm_system' }
const SRC = path.join(__dirname, '..', '..', 'src')
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8')

describe('L1 closed vocabulary', () => {
  it('only the exact plm_system value locks', () => {
    expect(FIELD_HUMAN_WRITE_LOCK_PROPERTY_KEY).toBe('humanWriteLock')
    expect(isFieldHumanWriteLocked({ property: { ...LOCK } })).toBe(true)
    expect(isFieldHumanWriteLocked({ property: JSON.stringify(LOCK) })).toBe(true)
    for (const value of [true, 'PLM_SYSTEM', 'plm', '', null, 0, ['plm_system'], { kind: 'plm_system' }]) {
      expect(isFieldHumanWriteLocked({ property: { humanWriteLock: value } }), JSON.stringify(value)).toBe(false)
    }
    expect(isFieldHumanWriteLocked({ property: {} })).toBe(false)
    expect(isFieldHumanWriteLocked({})).toBe(false)
    expect(isFieldHumanWriteLocked(null)).toBe(false)
  })

  it('the refusal body is the closed code + values-free message + the caller ids', () => {
    expect(humanWriteLockRefusalBody(['fld_a'])).toEqual({
      ok: false,
      error: { code: 'FIELD_READONLY_PLM_SYSTEM', message: expect.any(String), fieldIds: ['fld_a'] },
    })
    expect(FIELD_READONLY_PLM_SYSTEM_CODE).toBe('FIELD_READONLY_PLM_SYSTEM')
  })

  it('listHumanWriteLockedFieldIds: submitted order, de-duplicated, invisible fields fall through', () => {
    const fields = [{ id: 'a', property: { ...LOCK } }, { id: 'b', property: {} }, { id: 'c', property: { ...LOCK } }]
    expect(listHumanWriteLockedFieldIds(fields, ['c', 'b', 'a', 'c'])).toEqual(['c', 'a'])
    expect(listHumanWriteLockedFieldIds(fields, ['c', 'a'], (id) => id !== 'c')).toEqual(['a'])
    expect(listHumanWriteLockedFieldIds(fields, ['b', 'zzz'])).toEqual([])
  })
})

describe('L2 the plugin half: the plugin SDK guard does not see the lock; the person floor does', () => {
  for (const type of ['string', 'number', 'boolean', 'date', 'select']) {
    it(`${type}: isFieldAlwaysReadOnly=false, isFieldReadOnlyForPeople=true`, () => {
      const field = { type, property: { ...LOCK } }
      expect(isFieldAlwaysReadOnly(field)).toBe(false)
      expect(isFieldReadOnlyForPeople(field)).toBe(true)
    })
  }
  it('an unlocked column is unaffected by the person floor', () => {
    expect(isFieldReadOnlyForPeople({ type: 'string', property: {} })).toBe(false)
  })
})

describe('L3 deriveFieldPermissions: read-only for every person, no override', () => {
  const fields = [
    { id: 'plm', type: 'string', property: { ...LOCK } },
    { id: 'human', type: 'string', property: {} },
  ]
  it('full edit capability (the admin tier) still gets readOnly on the locked column only', () => {
    const perms = deriveFieldPermissions(fields, { canEditRecord: true, canCreateRecord: true })
    expect(perms.plm).toEqual({ visible: true, readOnly: true })
    expect(perms.human).toEqual({ visible: true, readOnly: false })
    expect(isFieldWriteForbidden(perms.plm)).toBe(true)
    expect(isFieldWriteForbidden(perms.human)).toBe(false)
  })
  it('a per-subject scope saying readOnly:false cannot lift it; the column stays VISIBLE (reading is unaffected)', () => {
    const fieldScopeMap = new Map([['plm', { visible: true, readOnly: false }]])
    const perms = deriveFieldPermissions(fields, { canEditRecord: true, canCreateRecord: true }, { fieldScopeMap })
    expect(perms.plm).toEqual({ visible: true, readOnly: true })
  })
})

describe('L4 sanitizers keep a valid lock, drop junk, never mutate the source', () => {
  for (const type of ['string', 'number', 'boolean', 'date', 'select', 'person', 'button', 'longText']) {
    it(`${type}: a valid lock survives sanitizeFieldProperty`, () => {
      expect(sanitizeFieldProperty(type, { ...LOCK }).humanWriteLock).toBe('plm_system')
    })
  }
  it('a junk value is dropped, on a copy', () => {
    const source = { humanWriteLock: 'yes', other: 1 }
    const out = sanitizeFieldProperty('string', source)
    expect('humanWriteLock' in out).toBe(false)
    expect(out.other).toBe(1)
    expect(source).toEqual({ humanWriteLock: 'yes', other: 1 })
  })
  it('the read serializer (serializeFieldRow) carries the lock to clients', () => {
    const row = serializeFieldRow({ id: 'fld', name: 'n', type: 'string', property: { ...LOCK }, order: 0 })
    expect((row.property as Record<string, unknown>).humanWriteLock).toBe('plm_system')
  })
  it('withHumanWriteLockKey on an object without the key is identity', () => {
    const obj = { a: 1 }
    expect(withHumanWriteLockKey(obj, {})).toBe(obj)
  })
})

describe('L5 the person field-write helpers', () => {
  it('strip: a person body can never SET the lock', () => {
    expect(stripHumanWriteLockKey({ humanWriteLock: 'plm_system', a: 1 })).toEqual({ a: 1 })
    const untouched = { a: 1 }
    expect(stripHumanWriteLockKey(untouched)).toBe(untouched)
  })
  it('carry: the STORED lock wins over a body that clears, changes or omits it', () => {
    expect(carryHumanWriteLock({ ...LOCK }, { a: 1 })).toEqual({ a: 1, humanWriteLock: 'plm_system' })
    expect(carryHumanWriteLock({ ...LOCK }, { a: 1, humanWriteLock: 'other' })).toEqual({ a: 1, humanWriteLock: 'plm_system' })
    expect(carryHumanWriteLock(JSON.stringify(LOCK), {})).toEqual({ humanWriteLock: 'plm_system' })
  })
  it('carry: an unlocked stored field never GAINS a lock from the body', () => {
    expect(carryHumanWriteLock({}, { humanWriteLock: 'plm_system', a: 1 })).toEqual({ a: 1 })
    expect(carryHumanWriteLock(null, { humanWriteLock: 'plm_system' })).toEqual({})
  })
})

describe('L6 a sheet copy drops the lock', () => {
  it('remapFieldProperty does not carry humanWriteLock', () => {
    const ctx: FieldRemapContext = {
      sourceSheetId: 'sheet_src',
      newSheetId: 'sheet_new',
      fieldIdMap: new Map([['fld_a', 'fld_b']]),
      fieldTypeById: new Map([['fld_a', 'string']]),
      fieldPropertyById: new Map([['fld_a', { ...LOCK, note: 'kept' }]]),
      unbuiltFieldIds: new Set(),
      blankedFieldIds: new Set(),
    }
    const out = remapFieldProperty(ctx, { id: 'fld_a', type: 'string', property: { ...LOCK, note: 'kept' } } as never)
    expect(out).toEqual({ note: 'kept' })
  })
})

describe('L7 RecordWriteService.validateChanges refuses a locked column with the closed code', () => {
  const service = new RecordWriteService({} as never, {} as never, {} as never)
  const guard = (property: Record<string, unknown>) => ({ type: 'string' as const, readOnly: isFieldReadOnlyForPeople({ type: 'string', property }), hidden: false, property })
  it('locked → RecordFieldForbiddenError(FIELD_READONLY_PLM_SYSTEM)', async () => {
    const error = await service.validateChanges({
      sheetId: 'sheet_x',
      changesByRecord: new Map([['rec_1', [{ fieldId: 'plm', value: 'HACK' }]]]),
      fieldById: new Map([['plm', guard({ ...LOCK })]]),
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RecordFieldForbiddenError)
    expect(error).toMatchObject({ code: 'FIELD_READONLY_PLM_SYSTEM', fieldId: 'plm' })
  })
  it('a guard that lost its property still refuses (generic FIELD_READONLY via the folded readOnly)', async () => {
    const error = await service.validateChanges({
      sheetId: 'sheet_x',
      changesByRecord: new Map([['rec_1', [{ fieldId: 'plm', value: 'HACK' }]]]),
      fieldById: new Map([['plm', { type: 'string' as const, readOnly: true, hidden: false }]]),
    }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'FIELD_READONLY' })
  })
  it('an unlocked human column passes', async () => {
    await expect(service.validateChanges({
      sheetId: 'sheet_x',
      changesByRecord: new Map([['rec_1', [{ fieldId: 'human', value: 'ok' }]]]),
      fieldById: new Map([['human', guard({})]]),
    })).resolves.toBeUndefined()
  })
})

describe('L9 a field-property config revert keeps the STORED lock (preview target and write)', () => {
  const rev = (before: Record<string, unknown>, after: Record<string, unknown>) => ({
    id: 'rev_1', sheet_id: 'sheet_x', entity_type: 'field' as const, entity_id: 'fld_plm', action: 'update' as const,
    before, after, changed_keys: ['type', 'property'],
  })
  it('helper: stored lock wins; an unlocked field on both sides is returned untouched (same reference)', () => {
    expect(fieldRevertPropertyKeepingLock({ ...LOCK }, { decimals: 2 })).toEqual({ decimals: 2, humanWriteLock: 'plm_system' })
    expect(fieldRevertPropertyKeepingLock({ ...LOCK }, null)).toEqual({ humanWriteLock: 'plm_system' })
    expect(fieldRevertPropertyKeepingLock({}, { humanWriteLock: 'plm_system', a: 1 })).toEqual({ a: 1 })
    const plain = { a: 1 }
    expect(fieldRevertPropertyKeepingLock({ b: 2 }, plain)).toBe(plain)
  })
  it('computeRevertPreview discloses the carried lock in target.property', () => {
    const preview = computeRevertPreview(rev({ type: 'number', property: {} }, { type: 'string', property: { ...LOCK } }), { type: 'string', property: { ...LOCK } })
    expect(preview.target.property).toEqual({ humanWriteLock: 'plm_system' })
    expect(preview.driftConflict).toBe(false)
  })
  it('applyConfigRevert writes the carried lock (reads the stored property first)', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const query = async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      if (sql.startsWith('SELECT property FROM meta_fields')) return { rows: [{ property: { ...LOCK } }] }
      return { rows: [] }
    }
    await applyConfigRevert(query, rev({ type: 'number', property: {} }, { type: 'string', property: { ...LOCK } }))
    const update = calls.find((c) => c.sql.startsWith('UPDATE meta_fields'))!
    expect(update.sql).toContain('property = $2::jsonb')
    expect(JSON.parse(String(update.params[1]))).toEqual({ humanWriteLock: 'plm_system' })
  })
  it('applyConfigRevert on a revert that does not touch property does not read or carry anything', async () => {
    const calls: string[] = []
    await applyConfigRevert(async (sql: string) => { calls.push(sql); return { rows: [] } }, { ...rev({ name: 'a' }, { name: 'b' }), changed_keys: ['name'] })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatch(/^UPDATE meta_fields SET name = \$1 WHERE id = \$2$/)
  })
})

describe('L8 wiring (source scan)', () => {
  it('every person guard builder uses the person floor, not the plugin guard alone', () => {
    const univerMeta = read('routes/univer-meta.ts')
    const guardBuilder = univerMeta.slice(univerMeta.indexOf('function buildFieldMutationGuardMap('), univerMeta.indexOf('function filterVisiblePropertyFields('))
    expect(guardBuilder).toContain('readOnly: isFieldReadOnlyForPeople(field)')
    const recordService = read('multitable/record-service.ts')
    const rsBuilder = recordService.slice(recordService.indexOf('function buildFieldMutationGuardMap('))
    expect(rsBuilder.slice(0, 600)).toContain('readOnly: isFieldReadOnlyForPeople(field)')
    expect(read('index.ts')).toContain('const isReadOnly = isFieldReadOnlyForPeople(f)')
  })
  it('the person routes answer the closed code before the generic refusal (single + bulk patch)', () => {
    const univerMeta = read('routes/univer-meta.ts')
    expect(univerMeta.match(/res\.status\(403\)\.json\(humanWriteLockRefusalBody\(humanLockedFieldIds\)\)/g)?.length).toBe(2)
  })
  it('the plugin records SDK path never consults the lock (that is the whole bypass)', () => {
    const records = read('multitable/records.ts')
    expect(records).not.toMatch(/human-write-lock|isFieldReadOnlyForPeople|isFieldHumanWriteLocked|humanWriteLock/)
    const derivation = read('multitable/permission-derivation.ts').replace(/\r\n/g, '\n')
    const start = derivation.indexOf('export function isFieldAlwaysReadOnly(')
    const alwaysReadOnly = derivation.slice(start, derivation.indexOf('\n}\n', start))
    expect(alwaysReadOnly.length).toBeGreaterThan(100)
    expect(alwaysReadOnly).not.toMatch(/HumanWriteLock|humanWriteLock/)
  })
})

describe('L10 hasHumanWriteLockedRequiredField: a locked + required column blocks every person create', () => {
  const REQUIRED = { validation: [{ type: 'required' }] }
  it('locked AND required → true (raw object, JSON-string property, mixed with other rules / fields)', () => {
    expect(hasHumanWriteLockedRequiredField([{ property: { ...LOCK, ...REQUIRED } }])).toBe(true)
    expect(hasHumanWriteLockedRequiredField([{ property: JSON.stringify({ ...LOCK, ...REQUIRED }) }])).toBe(true)
    expect(hasHumanWriteLockedRequiredField([
      { property: {} },
      { property: { ...LOCK, validation: [{ type: 'maxLength', params: { value: 10 } }, { type: 'required' }] } },
    ])).toBe(true)
  })
  it('locked but not required, required but not locked, or split across two columns → false', () => {
    expect(hasHumanWriteLockedRequiredField([{ property: { ...LOCK } }])).toBe(false)
    expect(hasHumanWriteLockedRequiredField([{ property: { ...REQUIRED } }])).toBe(false)
    expect(hasHumanWriteLockedRequiredField([{ property: { ...LOCK } }, { property: { ...REQUIRED } }])).toBe(false)
    expect(hasHumanWriteLockedRequiredField([{ property: { ...LOCK, validation: [{ type: 'maxLength', params: { value: 5 } }] } }])).toBe(false)
    expect(hasHumanWriteLockedRequiredField([{ property: { ...LOCK, validation: { type: 'required' } } }])).toBe(false)
    expect(hasHumanWriteLockedRequiredField([{ property: { ...LOCK, validation: [null, 'required'] } }])).toBe(false)
    expect(hasHumanWriteLockedRequiredField([{ property: { humanWriteLock: 'PLM_SYSTEM', ...REQUIRED } }])).toBe(false)
    expect(hasHumanWriteLockedRequiredField([])).toBe(false)
  })
  it('sees through the read serializer GET /context loads with, for the project-sheet column types', () => {
    for (const type of ['string', 'number', 'boolean']) {
      const row = serializeFieldRow({ id: 'fld', name: 'n', type, property: { ...LOCK, ...REQUIRED }, order: 0 })
      expect(hasHumanWriteLockedRequiredField([row]), type).toBe(true)
    }
  })
})
