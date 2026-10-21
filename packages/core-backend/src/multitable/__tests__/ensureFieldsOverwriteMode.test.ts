import { describe, expect, test } from 'vitest'

import {
  ENSURE_FIELDS_OVERWRITE_MODE_ENV,
  resolveEnsureFieldsOverwriteMode,
  classifyFieldOverwrite,
  diffFieldOverwriteKinds,
  MultitableEnsureFieldsRefusedError,
} from '../ensureFieldsOverwriteMode'

describe('ensureFields overwrite-mode resolution (P0-S S3)', () => {
  test('env key name is the documented flag', () => {
    expect(ENSURE_FIELDS_OVERWRITE_MODE_ENV).toBe('MULTITABLE_ENSURE_FIELDS_OVERWRITE_MODE')
  })

  test('unset defaults to REFUSE (fail-closed — an existing object is never silently reconciled)', () => {
    expect(resolveEnsureFieldsOverwriteMode({})).toBe('refuse')
  })

  test.each(['', 'OVERWRITE', 'Observe', 'PRESERVE', 'x', 'true', 'overwrit', ' overwrite'])(
    'unrecognized value %j falls back to refuse, never to overwrite',
    (value) => {
      expect(resolveEnsureFieldsOverwriteMode({ [ENSURE_FIELDS_OVERWRITE_MODE_ENV]: value })).toBe(
        'refuse',
      )
    },
  )

  test('the exact literal overwrite is the only env value that restores the old behavior', () => {
    expect(
      resolveEnsureFieldsOverwriteMode({ [ENSURE_FIELDS_OVERWRITE_MODE_ENV]: 'overwrite' }),
    ).toBe('overwrite')
  })

  test('exact observe / preserve are honored', () => {
    expect(resolveEnsureFieldsOverwriteMode({ [ENSURE_FIELDS_OVERWRITE_MODE_ENV]: 'observe' })).toBe(
      'observe',
    )
    expect(
      resolveEnsureFieldsOverwriteMode({ [ENSURE_FIELDS_OVERWRITE_MODE_ENV]: 'preserve' }),
    ).toBe('preserve')
  })
})

describe('diffFieldOverwriteKinds (P0-S S3, Codex round 2)', () => {
  const base = { name: 'A', type: 'text', property: { x: 1 }, order: 0 }

  test('a create (no existing row) reports no diff — it is not a destructive overwrite', () => {
    expect(diffFieldOverwriteKinds(null, base)).toEqual([])
    expect(diffFieldOverwriteKinds(undefined, base)).toEqual([])
  })

  test('identical rows report no diff, property key order insensitive', () => {
    expect(diffFieldOverwriteKinds({ ...base }, base)).toEqual([])
    expect(
      diffFieldOverwriteKinds(
        { name: 'A', type: 'text', property: { b: 2, a: 1 }, order: 0 },
        { name: 'A', type: 'text', property: { a: 1, b: 2 }, order: 0 },
      ),
    ).toEqual([])
  })

  test.each([
    ['name', { ...base, name: 'B' }, ['name']],
    ['type', { ...base, type: 'number' }, ['type']],
    ['property', { ...base, property: { x: 2 } }, ['property']],
    ['order', { ...base, order: 3 }, ['order']],
  ])('a %s change is named exactly', (_label, existing, expected) => {
    expect(diffFieldOverwriteKinds(existing as never, base)).toEqual(expected)
  })

  test('multiple diffs come back in a stable, deterministic order', () => {
    const existing = { name: 'B', type: 'number', property: { x: 9 }, order: 7 }
    expect(diffFieldOverwriteKinds(existing, base)).toEqual(['name', 'type', 'property', 'order'])
    // stability: the declaration order does not depend on which field differs first
    expect(diffFieldOverwriteKinds({ ...base, order: 7, name: 'B' }, base)).toEqual(['name', 'order'])
  })
})

describe('MultitableEnsureFieldsRefusedError (P0-S S3, Codex round 2)', () => {
  const err = new MultitableEnsureFieldsRefusedError({
    fieldId: 'fld_abc123',
    sheetId: 'sheet_def456',
    diffKinds: ['name', 'type'],
  })

  test('is a real Error subclass with a stable typed code', () => {
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(MultitableEnsureFieldsRefusedError)
    expect(err.code).toBe('MULTITABLE_ENSURE_FIELDS_REFUSED')
    expect(err.name).toBe('MultitableEnsureFieldsRefusedError')
  })

  test('carries the structured diff for callers that want to branch on it', () => {
    expect(err.fieldId).toBe('fld_abc123')
    expect(err.sheetId).toBe('sheet_def456')
    expect(err.diffKinds).toEqual(['name', 'type'])
  })

  test('the message names the diff KINDS and the escape hatch, and stays values-free', () => {
    expect(err.message).toContain('name, type')
    expect(err.message).toContain('fld_abc123')
    expect(err.message).toContain(ENSURE_FIELDS_OVERWRITE_MODE_ENV)
    expect(err.message).toContain('ensureMissingObjectFields')
  })

  test('no stored or incoming VALUE can leak through the message', () => {
    const leaky = new MultitableEnsureFieldsRefusedError({
      fieldId: 'fld_1',
      sheetId: 'sheet_1',
      diffKinds: ['property'],
    })
    // the constructor takes no value payload at all — the only inputs are ids + kinds
    expect(leaky.message).not.toContain('张三')
    expect(leaky.message).not.toContain('13800000000')
    expect(Object.keys(leaky)).not.toContain('property')
  })
})

describe('classifyFieldOverwrite (P0-S S3)', () => {
  const base = { name: 'A', type: 'text', property: { x: 1 }, order: 0 }

  test('no existing row => create', () => {
    expect(classifyFieldOverwrite(null, base)).toBe('create')
    expect(classifyFieldOverwrite(undefined, base)).toBe('create')
  })

  test('identical => unchanged (order-insensitive property compare)', () => {
    expect(classifyFieldOverwrite({ name: 'A', type: 'text', property: { x: 1 }, order: 0 }, base)).toBe(
      'unchanged',
    )
    // property key order must not matter
    expect(
      classifyFieldOverwrite(
        { name: 'A', type: 'text', property: { b: 2, a: 1 }, order: 0 },
        { name: 'A', type: 'text', property: { a: 1, b: 2 }, order: 0 },
      ),
    ).toBe('unchanged')
  })

  test.each([
    ['name', { ...base, name: 'B' }],
    ['type', { ...base, type: 'number' }],
    ['order', { ...base, order: 3 }],
    ['property', { ...base, property: { x: 2 } }],
  ])('differing %s => would_overwrite', (_field, existing) => {
    expect(classifyFieldOverwrite(existing as any, base)).toBe('would_overwrite')
  })
})
