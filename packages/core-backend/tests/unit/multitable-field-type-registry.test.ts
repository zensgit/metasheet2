import { describe, it, expect, beforeEach } from 'vitest'

import { FieldTypeRegistry } from '../../src/multitable/field-type-registry'
import type { FieldTypeDefinition } from '../../src/multitable/field-type-registry'

function makeDef(overrides: Partial<FieldTypeDefinition> = {}): FieldTypeDefinition {
  return {
    name: overrides.name ?? 'test-type',
    validate: overrides.validate ?? ((v) => v),
    sanitizeProperty: overrides.sanitizeProperty ?? ((p) => (typeof p === 'object' && p !== null ? p as Record<string, unknown> : {})),
    ...(overrides.serialize ? { serialize: overrides.serialize } : {}),
    ...(overrides.deserialize ? { deserialize: overrides.deserialize } : {}),
  }
}

describe('FieldTypeRegistry', () => {
  let registry: FieldTypeRegistry

  beforeEach(() => {
    registry = new FieldTypeRegistry()
  })

  it('register and get returns the definition', () => {
    const def = makeDef({ name: 'currency' })
    registry.register('currency', def)
    expect(registry.get('currency')).toBe(def)
  })

  it('has returns true for registered types', () => {
    registry.register('currency', makeDef({ name: 'currency' }))
    expect(registry.has('currency')).toBe(true)
  })

  it('has returns false for unregistered types', () => {
    expect(registry.has('nonexistent')).toBe(false)
  })

  it('get returns undefined for unregistered types', () => {
    expect(registry.get('nonexistent')).toBeUndefined()
  })

  it('unregister removes the definition', () => {
    registry.register('currency', makeDef({ name: 'currency' }))
    registry.unregister('currency')
    expect(registry.has('currency')).toBe(false)
    expect(registry.get('currency')).toBeUndefined()
  })

  it('unregister on nonexistent type does not throw', () => {
    expect(() => registry.unregister('nonexistent')).not.toThrow()
  })

  it('getRegisteredTypes lists all registered types', () => {
    registry.register('currency', makeDef({ name: 'currency' }))
    registry.register('rating', makeDef({ name: 'rating' }))
    expect(registry.getRegisteredTypes().sort()).toEqual(['currency', 'rating'])
  })

  it('getRegisteredTypes returns empty array when nothing registered', () => {
    expect(registry.getRegisteredTypes()).toEqual([])
  })

  it('register overwrites existing definition', () => {
    const def1 = makeDef({ name: 'v1' })
    const def2 = makeDef({ name: 'v2' })
    registry.register('currency', def1)
    registry.register('currency', def2)
    expect(registry.get('currency')).toBe(def2)
  })

  it('register throws on empty name', () => {
    expect(() => registry.register('', makeDef())).toThrow()
  })

  it('validate delegates correctly', () => {
    const def = makeDef({
      name: 'currency',
      validate: (value, fieldId) => {
        if (typeof value !== 'number') {
          throw new Error(`Currency must be a number: ${fieldId}`)
        }
        return Math.round(value * 100) / 100
      },
    })
    registry.register('currency', def)
    const registered = registry.get('currency')!
    expect(registered.validate(12.345, 'fld1')).toBe(12.35)
    expect(() => registered.validate('abc', 'fld1')).toThrow('Currency must be a number: fld1')
  })

  it('sanitizeProperty delegates correctly', () => {
    const def = makeDef({
      name: 'currency',
      sanitizeProperty: (property) => {
        const obj = typeof property === 'object' && property !== null
          ? property as Record<string, unknown>
          : {}
        return {
          currencyCode: typeof obj.currencyCode === 'string' ? obj.currencyCode : 'USD',
          precision: typeof obj.precision === 'number' ? obj.precision : 2,
        }
      },
    })
    registry.register('currency', def)
    const registered = registry.get('currency')!
    expect(registered.sanitizeProperty({ currencyCode: 'EUR' })).toEqual({
      currencyCode: 'EUR',
      precision: 2,
    })
    expect(registered.sanitizeProperty(null)).toEqual({
      currencyCode: 'USD',
      precision: 2,
    })
  })

  it('serialize and deserialize are optional', () => {
    const def = makeDef({ name: 'simple' })
    registry.register('simple', def)
    const registered = registry.get('simple')!
    expect(registered.serialize).toBeUndefined()
    expect(registered.deserialize).toBeUndefined()
  })

  it('serialize and deserialize delegate correctly when provided', () => {
    const def = makeDef({
      name: 'json-list',
      serialize: (value) => JSON.stringify(value),
      deserialize: (value) => typeof value === 'string' ? JSON.parse(value) : value,
    })
    registry.register('json-list', def)
    const registered = registry.get('json-list')!
    expect(registered.serialize!([1, 2, 3])).toBe('[1,2,3]')
    expect(registered.deserialize!('[1,2,3]')).toEqual([1, 2, 3])
  })
})
