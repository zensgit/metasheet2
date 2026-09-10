import { describe, expect, it } from 'vitest'
import {
  CREATE_FIELD_SENTINEL,
  MAX_FIELD_NAME_LENGTH,
  MAX_SHEET_FIELDS,
  createFieldPlaceholderId,
  isCreateFieldPlaceholderId,
  planCreateFieldNames,
} from '../src/multitable/import/create-fields'

describe('planCreateFieldNames', () => {
  it('keeps the header verbatim when nothing collides', () => {
    const plan = planCreateFieldNames({
      requests: [{ header: 'Warehouse', columnIndex: 1 }, { header: 'Batch', columnIndex: 2 }],
      existingNames: ['Name'],
    })
    expect(plan).toEqual({ ok: true, names: ['Warehouse', 'Batch'] })
  })

  it('suffixes case-insensitive collisions with existing field names', () => {
    const plan = planCreateFieldNames({
      requests: [{ header: 'score', columnIndex: 0 }],
      existingNames: ['Name', 'Score'],
    })
    expect(plan).toEqual({ ok: true, names: ['score (2)'] })
  })

  it('suffixes duplicates inside the same batch', () => {
    const plan = planCreateFieldNames({
      requests: [
        { header: '库位', columnIndex: 0 },
        { header: '库位', columnIndex: 3 },
        { header: ' 库位 ', columnIndex: 5 },
      ],
      existingNames: [],
    })
    expect(plan).toEqual({ ok: true, names: ['库位', '库位 (2)', '库位 (3)'] })
  })

  it('refuses an empty header instead of creating an unnamed field', () => {
    expect(planCreateFieldNames({ requests: [{ header: '   ', columnIndex: 0 }], existingNames: [] }))
      .toEqual({ ok: false, reason: 'invalid-name', header: '   ' })
  })

  it('refuses (never truncates) a name past the backend length cap', () => {
    const header = 'x'.repeat(MAX_FIELD_NAME_LENGTH + 1)
    expect(planCreateFieldNames({ requests: [{ header, columnIndex: 0 }], existingNames: [] }))
      .toEqual({ ok: false, reason: 'name-too-long', header })
  })

  it('refuses a batch that would push the sheet past the readable field limit', () => {
    const plan = planCreateFieldNames({
      requests: [{ header: 'Extra', columnIndex: 0 }],
      existingNames: [],
      existingFieldCount: MAX_SHEET_FIELDS,
    })
    expect(plan).toEqual({ ok: false, reason: 'field-limit' })
  })

  it('allows a batch that lands exactly on the limit', () => {
    const plan = planCreateFieldNames({
      requests: [{ header: 'Extra', columnIndex: 0 }],
      existingNames: [],
      existingFieldCount: MAX_SHEET_FIELDS - 1,
    })
    expect(plan).toEqual({ ok: true, names: ['Extra'] })
  })
})

describe('create-field placeholder ids', () => {
  it('cannot be confused with the mapping sentinel or a real field id', () => {
    expect(createFieldPlaceholderId(3)).toBe('__create__:3')
    expect(isCreateFieldPlaceholderId(createFieldPlaceholderId(3))).toBe(true)
    expect(isCreateFieldPlaceholderId(CREATE_FIELD_SENTINEL)).toBe(false)
    expect(isCreateFieldPlaceholderId('fld_warehouse')).toBe(false)
    expect(isCreateFieldPlaceholderId(undefined)).toBe(false)
  })
})
