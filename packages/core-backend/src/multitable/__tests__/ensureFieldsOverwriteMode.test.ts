import { describe, expect, test } from 'vitest'

import {
  ENSURE_FIELDS_OVERWRITE_MODE_ENV,
  resolveEnsureFieldsOverwriteMode,
  classifyFieldOverwrite,
} from '../ensureFieldsOverwriteMode'

describe('ensureFields overwrite-mode resolution (P0-S S3)', () => {
  test('env key name is the documented flag', () => {
    expect(ENSURE_FIELDS_OVERWRITE_MODE_ENV).toBe('MULTITABLE_ENSURE_FIELDS_OVERWRITE_MODE')
  })

  test('unset defaults to overwrite (today behavior, non-breaking)', () => {
    expect(resolveEnsureFieldsOverwriteMode({})).toBe('overwrite')
  })

  test.each(['', 'OVERWRITE', 'Observe', 'PRESERVE', 'x', 'true'])(
    'unrecognized value %j falls back to overwrite',
    (value) => {
      expect(resolveEnsureFieldsOverwriteMode({ [ENSURE_FIELDS_OVERWRITE_MODE_ENV]: value })).toBe(
        'overwrite',
      )
    },
  )

  test('exact observe / preserve are honored', () => {
    expect(resolveEnsureFieldsOverwriteMode({ [ENSURE_FIELDS_OVERWRITE_MODE_ENV]: 'observe' })).toBe(
      'observe',
    )
    expect(
      resolveEnsureFieldsOverwriteMode({ [ENSURE_FIELDS_OVERWRITE_MODE_ENV]: 'preserve' }),
    ).toBe('preserve')
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
