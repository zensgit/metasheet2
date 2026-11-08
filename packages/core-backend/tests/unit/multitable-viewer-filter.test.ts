/**
 * Viewer filter (multitable/viewer-filter.ts) and the 备料 BOM relations /context block
 * (multitable/stock-preparation-bom-relations-context.ts) — the pure halves. The route halves (GET /view,
 * view-aggregate, /context over a real plugin-provisioned sheet) are pinned in
 * tests/integration/stock-preparation-bom-relations-realdb.cases.ts.
 */
import { describe, expect, test } from 'vitest'

import { getObjectFieldId } from '../../src/multitable/provisioning'
import {
  BOM_RELATIONS_LOGICAL_FIELD_IDS,
  bomRelationsContextBlockOf,
} from '../../src/multitable/stock-preparation-bom-relations-context'
import { STOCK_PREPARATION_PROJECT_SHEET_PLUGIN } from '../../src/multitable/stock-preparation-project-sheet-schema-clamp'
import {
  VIEWER_FILTER_MAX_CONDITIONS,
  VIEWER_FILTER_MAX_VALUE_LENGTH,
  composeViewerFilter,
  parseViewerFilterParam,
  viewerFilterFieldsPermitted,
} from '../../src/multitable/viewer-filter'

const raw = (conditions: unknown) => JSON.stringify({ conditions })

describe('parseViewerFilterParam', () => {
  test('absent / empty ⇒ absent (the route stays byte-identical)', () => {
    expect(parseViewerFilterParam(undefined).kind).toBe('absent')
    expect(parseViewerFilterParam('').kind).toBe('absent')
    expect(parseViewerFilterParam(null).kind).toBe('absent')
  })

  test('accepts 1..max `is` leaves with a non-blank string or a boolean', () => {
    const parsed = parseViewerFilterParam(raw([
      { fieldId: 'fld_a', operator: 'is', value: 'SRC-P07' },
      { fieldId: 'fld_b', operator: 'is', value: true },
    ]))
    expect(parsed).toEqual({ kind: 'present', conditions: [
      { fieldId: 'fld_a', operator: 'is', value: 'SRC-P07' },
      { fieldId: 'fld_b', operator: 'is', value: true },
    ] })
  })

  test.each([
    ['not JSON', '{nope'],
    ['an array root', JSON.stringify([{ fieldId: 'f', operator: 'is', value: 'x' }])],
    ['no conditions', JSON.stringify({})],
    ['empty conditions', raw([])],
    ['too many conditions', raw(Array.from({ length: VIEWER_FILTER_MAX_CONDITIONS + 1 }, (_, i) => ({ fieldId: `f${i}`, operator: 'is', value: 'x' })))],
    ['another operator', raw([{ fieldId: 'f', operator: 'contains', value: 'x' }])],
    ['a group node', raw([{ conjunction: 'or', conditions: [] }])],
    ['a blank string (would match every empty cell)', raw([{ fieldId: 'f', operator: 'is', value: '   ' }])],
    ['an empty string', raw([{ fieldId: 'f', operator: 'is', value: '' }])],
    ['a number value', raw([{ fieldId: 'f', operator: 'is', value: 7 }])],
    ['a missing value', raw([{ fieldId: 'f', operator: 'is' }])],
    ['an over-long value', raw([{ fieldId: 'f', operator: 'is', value: 'x'.repeat(VIEWER_FILTER_MAX_VALUE_LENGTH + 1) }])],
    ['a blank field id', raw([{ fieldId: ' ', operator: 'is', value: 'x' }])],
  ])('refuses %s', (_label, value) => {
    expect(parseViewerFilterParam(value).kind).toBe('invalid')
  })

  test('refuses a repeated key (Express array) and an object', () => {
    expect(parseViewerFilterParam([raw([{ fieldId: 'f', operator: 'is', value: 'x' }])]).kind).toBe('invalid')
    expect(parseViewerFilterParam({ conditions: [] }).kind).toBe('invalid')
  })
})

describe('viewerFilterFieldsPermitted', () => {
  const conditions = [{ fieldId: 'fld_a', operator: 'is' as const, value: 'x' }]
  test('a field in both the selectable set and the sheet passes', () => {
    expect(viewerFilterFieldsPermitted(conditions, new Set(['fld_a']), new Set(['fld_a']))).toBe(true)
  })
  test('a denied or unknown field fails', () => {
    expect(viewerFilterFieldsPermitted(conditions, new Set([]), new Set(['fld_a']))).toBe(false)
    expect(viewerFilterFieldsPermitted(conditions, new Set(['fld_a']), new Set([]))).toBe(false)
  })
})

describe('composeViewerFilter', () => {
  const leaf = { fieldId: 'fld_p', operator: 'is' as const, value: 'SRC-P07' }
  test('no stored filter ⇒ an AND of the viewer leaves', () => {
    expect(composeViewerFilter(null, [leaf])).toEqual({ conjunction: 'and', conditions: [leaf] })
  })
  test('a stored AND root gets the leaves appended (no extra depth) and is not mutated', () => {
    const stored = { conjunction: 'and' as const, conditions: [{ fieldId: 'fld_active', operator: 'is', value: true }] as unknown[] }
    const snapshot = JSON.stringify(stored)
    expect(composeViewerFilter(stored, [leaf])).toEqual({ conjunction: 'and', conditions: [stored.conditions[0], leaf] })
    expect(JSON.stringify(stored)).toBe(snapshot)
  })
  test('a stored OR root is wrapped, keeping its own semantics', () => {
    const stored = { conjunction: 'or' as const, conditions: [{ fieldId: 'a', operator: 'is', value: 'x' }, { fieldId: 'b', operator: 'is', value: 'y' }] as unknown[] }
    expect(composeViewerFilter(stored, [leaf])).toEqual({ conjunction: 'and', conditions: [stored, leaf] })
  })
  test('a lone stored leaf (a pruned single condition) is wrapped next to the viewer leaves', () => {
    const stored = { fieldId: 'fld_active', operator: 'is', value: true }
    expect(composeViewerFilter(stored, [leaf])).toEqual({ conjunction: 'and', conditions: [stored, leaf] })
  })
})

describe('bomRelationsContextBlockOf', () => {
  const projectId = 'tenant_syn:integration-core'
  const objectId = 'plm_stock_preparation_project_syn'
  const phys = (logical: string) => getObjectFieldId(projectId, objectId, logical)
  const stanza = (ownership: string) => ({ stockPreparation: { ownership, preserveOnRefresh: false, required: false, key: false } })
  const templateFields = () => Object.values(BOM_RELATIONS_LOGICAL_FIELD_IDS).map((logical) => ({ id: phys(logical), property: stanza('plm_system') }))
  const allReadable = () => new Set(templateFields().map((f) => f.id))
  const base = () => ({ pluginName: STOCK_PREPARATION_PROJECT_SHEET_PLUGIN, projectId, objectId, fields: templateFields(), readableFieldIds: allReadable() })

  test('a stock-prep main-template sheet: the five physical ids, exactly as provisioning derives them', () => {
    expect(bomRelationsContextBlockOf(base())).toEqual({
      componentSourceFieldId: phys('componentSourceId'),
      parentSourceFieldId: phys('parentSourceId'),
      activeFieldId: phys('active'),
      componentCodeFieldId: phys('componentCode'),
      componentNameFieldId: phys('componentName'),
    })
  })

  test('another plugin, a missing column, a column without the plm_system stanza, or an unreadable column ⇒ no block', () => {
    expect(bomRelationsContextBlockOf({ ...base(), pluginName: 'plugin-after-sales' })).toBeNull()
    expect(bomRelationsContextBlockOf({ ...base(), projectId: '' })).toBeNull()
    expect(bomRelationsContextBlockOf({ ...base(), fields: templateFields().filter((f) => f.id !== phys('parentSourceId')) })).toBeNull()
    expect(bomRelationsContextBlockOf({
      ...base(),
      fields: templateFields().map((f) => (f.id === phys('componentSourceId') ? { ...f, property: stanza('human_preserved') } : f)),
    })).toBeNull()
    expect(bomRelationsContextBlockOf({
      ...base(),
      fields: templateFields().map((f) => (f.id === phys('active') ? { ...f, property: {} } : f)),
    })).toBeNull()
    const readable = allReadable()
    readable.delete(phys('componentSourceId'))
    expect(bomRelationsContextBlockOf({ ...base(), readableFieldIds: readable })).toBeNull()
  })

  test('columns named like the template but with other ids (a hand-made look-alike) ⇒ no block', () => {
    const lookAlike = Object.values(BOM_RELATIONS_LOGICAL_FIELD_IDS).map((logical) => ({ id: `fld_${logical}`, name: logical, property: stanza('plm_system') }))
    expect(bomRelationsContextBlockOf({ ...base(), fields: lookAlike, readableFieldIds: new Set(lookAlike.map((f) => f.id)) })).toBeNull()
  })
})
