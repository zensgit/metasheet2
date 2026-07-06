/**
 * Slice 3c — column-reorder write path (personal vs shared). Goldens for the two load-bearing constraints:
 *  C1: personal mode ⇒ writes ONLY personal-config.fieldOrder, NEVER updateField (shared order untouched);
 *      shared mode ⇒ the unchanged updateField path, no personal-config call.
 *  C2: writing fieldOrder PRESERVES the actor's other personal facets (read-merge-write).
 *
 * Design: docs/development/multitable-personal-views-slice3-fe-toggle-design-lock-20260706.md
 */
import { describe, it, expect, vi } from 'vitest'

import { reorderViewFields, moveWithin, type ReorderClient } from '../src/multitable/utils/reorder-view-fields'
import type { MetaField } from '../src/multitable/types'

const field = (id: string): MetaField => ({ id, name: id, type: 'string' })

function mockClient(overrides: Partial<ReorderClient> = {}): ReorderClient {
  return {
    updateField: vi.fn(async () => ({})),
    getPersonalViewConfig: vi.fn(async () => ({ config: null })),
    putPersonalViewConfig: vi.fn(async () => ({})),
    ...overrides,
  }
}

describe('moveWithin', () => {
  it('moves fromId into toId\'s slot; returns null when either id is absent', () => {
    expect(moveWithin(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
    expect(moveWithin(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a'])
    expect(moveWithin(['a', 'b'], 'ghost', 'a')).toBeNull()
  })
})

describe('reorderViewFields — C1 write-target routing', () => {
  it('SHARED (isPersonal=false): reorders grid.fields + updateField per field; NO personal-config call', async () => {
    const client = mockClient()
    const onSharedOrder = vi.fn()
    const onPersonalOrder = vi.fn()
    await reorderViewFields({
      fromId: 'c', toId: 'a', isPersonal: false, viewId: 'v1',
      sharedFields: [field('a'), field('b'), field('c')],
      visibleFieldIds: ['a', 'b', 'c'],
      client, onSharedOrder, onPersonalOrder,
    })
    expect(onSharedOrder).toHaveBeenCalledWith([field('c'), field('a'), field('b')])
    expect(client.updateField).toHaveBeenCalledTimes(3)
    expect(client.updateField).toHaveBeenCalledWith('c', { order: 0 })
    expect(client.updateField).toHaveBeenCalledWith('a', { order: 1 })
    expect(client.updateField).toHaveBeenCalledWith('b', { order: 2 })
    // shared drag must NEVER touch the personal config, and never the personal apply
    expect(client.putPersonalViewConfig).not.toHaveBeenCalled()
    expect(client.getPersonalViewConfig).not.toHaveBeenCalled()
    expect(onPersonalOrder).not.toHaveBeenCalled()
  })

  it('PERSONAL (isPersonal=true): writes personal-config.fieldOrder over the VISIBLE order; NEVER updateField', async () => {
    const client = mockClient()
    const onSharedOrder = vi.fn()
    const onPersonalOrder = vi.fn()
    await reorderViewFields({
      fromId: 'c', toId: 'a', isPersonal: true, viewId: 'v1',
      sharedFields: [field('a'), field('b'), field('c'), field('hidden')],
      visibleFieldIds: ['a', 'b', 'c'], // personal reorders the VISIBLE order, not sharedFields
      client, onSharedOrder, onPersonalOrder,
    })
    expect(onPersonalOrder).toHaveBeenCalledWith(['c', 'a', 'b'])
    expect(client.putPersonalViewConfig).toHaveBeenCalledWith('v1', { fieldOrder: ['c', 'a', 'b'] })
    // C1: the SHARED field order is never written in personal mode
    expect(client.updateField).not.toHaveBeenCalled()
    expect(onSharedOrder).not.toHaveBeenCalled()
  })

  it('no-op when fromId/toId is not in the relevant list (personal uses visibleFieldIds)', async () => {
    const client = mockClient()
    await reorderViewFields({
      fromId: 'ghost', toId: 'a', isPersonal: true, viewId: 'v1',
      sharedFields: [field('a'), field('b')], visibleFieldIds: ['a', 'b'],
      client, onSharedOrder: vi.fn(), onPersonalOrder: vi.fn(),
    })
    expect(client.putPersonalViewConfig).not.toHaveBeenCalled()
    expect(client.getPersonalViewConfig).not.toHaveBeenCalled()
  })
})

describe('reorderViewFields — C2 preserve other personal facets (read-merge-write)', () => {
  it('an existing personal row with filter/sort/hidden ⇒ PUT keeps them, only fieldOrder changes', async () => {
    const existing = {
      filterInfo: { conjunction: 'and', conditions: [{ fieldId: 'a', operator: 'is', value: 'x' }] },
      sortInfo: { fieldId: 'b', direction: 'desc' },
      hiddenFieldIds: ['z'],
    }
    const client = mockClient({ getPersonalViewConfig: vi.fn(async () => ({ config: { ...existing } })) })
    await reorderViewFields({
      fromId: 'c', toId: 'a', isPersonal: true, viewId: 'v1',
      sharedFields: [field('a'), field('b'), field('c')], visibleFieldIds: ['a', 'b', 'c'],
      client, onSharedOrder: vi.fn(), onPersonalOrder: vi.fn(),
    })
    expect(client.getPersonalViewConfig).toHaveBeenCalledWith('v1')
    expect(client.putPersonalViewConfig).toHaveBeenCalledWith('v1', {
      ...existing,
      fieldOrder: ['c', 'a', 'b'],
    })
  })

  it('no existing row (config: null) ⇒ PUT creates it with just fieldOrder', async () => {
    const client = mockClient({ getPersonalViewConfig: vi.fn(async () => ({ config: null })) })
    await reorderViewFields({
      fromId: 'b', toId: 'a', isPersonal: true, viewId: 'v1',
      sharedFields: [field('a'), field('b')], visibleFieldIds: ['a', 'b'],
      client, onSharedOrder: vi.fn(), onPersonalOrder: vi.fn(),
    })
    expect(client.putPersonalViewConfig).toHaveBeenCalledWith('v1', { fieldOrder: ['b', 'a'] })
  })

  it('GET failure (404 no row / flag flip) ⇒ still writes fieldOrder, does not throw', async () => {
    const client = mockClient({
      getPersonalViewConfig: vi.fn(async () => { throw Object.assign(new Error('not found'), { status: 404 }) }),
    })
    await expect(reorderViewFields({
      fromId: 'b', toId: 'a', isPersonal: true, viewId: 'v1',
      sharedFields: [field('a'), field('b')], visibleFieldIds: ['a', 'b'],
      client, onSharedOrder: vi.fn(), onPersonalOrder: vi.fn(),
    })).resolves.toBeUndefined()
    expect(client.putPersonalViewConfig).toHaveBeenCalledWith('v1', { fieldOrder: ['b', 'a'] })
  })
})
