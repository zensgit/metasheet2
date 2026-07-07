/**
 * Slice 3d — additive personal-config writes. A single-facet personal edit must NOT wipe the actor's other
 * personal facets (the backend PUT replaces the whole row). Design:
 * docs/development/multitable-personal-views-slice3d-additive-writes-20260706.md.
 *
 * Named `multitable-grid-*` so the multitable-web-guard `multitable-grid` filter runs it.
 */
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'

import { writePersonalConfigMerged, type PersonalConfigWriteClient } from '../src/multitable/utils/personal-config-write'
import { useMultitableGrid } from '../src/multitable/composables/useMultitableGrid'
import { MultitableApiClient } from '../src/multitable/api/client'

// ---- unit goldens for the merge helper ----

function mockClient(config: unknown): PersonalConfigWriteClient {
  return {
    getPersonalViewConfig: vi.fn(async () => ({ config: config as never })),
    putPersonalViewConfig: vi.fn(async () => ({})),
  }
}
const putArg = (c: PersonalConfigWriteClient) => (c.putPersonalViewConfig as ReturnType<typeof vi.fn>).mock.calls[0]

describe('writePersonalConfigMerged — additive personal writes', () => {
  it('GOLDEN: existing {filter, sort, hidden} + single-facet {hiddenFieldIds} edit ⇒ filter & sort preserved', async () => {
    const existing = {
      filterInfo: { conjunction: 'and', conditions: [{ fieldId: 'a', operator: 'is', value: 'x' }] },
      sortInfo: { fieldId: 'b', direction: 'desc' },
      hiddenFieldIds: ['old'],
    }
    const client = mockClient({ ...existing })
    await writePersonalConfigMerged(client, 'v1', { hiddenFieldIds: ['new'] })
    expect(client.getPersonalViewConfig).toHaveBeenCalledWith('v1')
    expect(putArg(client)).toEqual(['v1', { filterInfo: existing.filterInfo, sortInfo: existing.sortInfo, hiddenFieldIds: ['new'] }])
  })

  it('a {sortInfo} edit preserves an existing personal fieldOrder + filter', async () => {
    const client = mockClient({ filterInfo: { conjunction: 'or', conditions: [] }, fieldOrder: ['c', 'a', 'b'] })
    await writePersonalConfigMerged(client, 'v1', { sortInfo: { fieldId: 'a', direction: 'asc' } })
    expect(putArg(client)[1]).toEqual({ filterInfo: { conjunction: 'or', conditions: [] }, fieldOrder: ['c', 'a', 'b'], sortInfo: { fieldId: 'a', direction: 'asc' } })
  })

  it('no existing row (config: null) ⇒ writes just the patch', async () => {
    const client = mockClient(null)
    await writePersonalConfigMerged(client, 'v1', { groupInfo: { fieldIds: ['g'] } })
    expect(putArg(client)[1]).toEqual({ groupInfo: { fieldIds: ['g'] } })
  })

  it('GET failure (404 / flag flip) ⇒ still writes the patch, does not throw', async () => {
    const client: PersonalConfigWriteClient = {
      getPersonalViewConfig: vi.fn(async () => { throw Object.assign(new Error('not found'), { status: 404 }) }),
      putPersonalViewConfig: vi.fn(async () => ({})),
    }
    await expect(writePersonalConfigMerged(client, 'v1', { sortInfo: { fieldId: 'a', direction: 'asc' } })).resolves.toBeUndefined()
    expect(client.putPersonalViewConfig).toHaveBeenCalledWith('v1', { sortInfo: { fieldId: 'a', direction: 'asc' } })
  })

  it('FAIL-CLOSED: a non-404 GET failure (500 / network) ⇒ REJECTS and does NOT PUT (never overwrites other facets)', async () => {
    const client: PersonalConfigWriteClient = {
      getPersonalViewConfig: vi.fn(async () => { throw Object.assign(new Error('server error'), { status: 500 }) }),
      putPersonalViewConfig: vi.fn(async () => ({})),
    }
    await expect(writePersonalConfigMerged(client, 'v1', { sortInfo: { fieldId: 'a', direction: 'asc' } })).rejects.toThrow('server error')
    expect(client.putPersonalViewConfig).not.toHaveBeenCalled()
  })

  it('clearing a facet: patch {filterInfo: undefined} drops filter (JSON omits undefined) while others persist', async () => {
    const client = mockClient({ filterInfo: { conjunction: 'and', conditions: [] }, sortInfo: { fieldId: 'b', direction: 'asc' }, hiddenFieldIds: ['z'] })
    await writePersonalConfigMerged(client, 'v1', { filterInfo: undefined })
    const sent = JSON.parse(JSON.stringify(putArg(client)[1]))
    expect(sent).toEqual({ sortInfo: { fieldId: 'b', direction: 'asc' }, hiddenFieldIds: ['z'] })
  })
})

// ---- grid wiring: personal in-place edit routes through the additive write; shared path unchanged ----

function gridClient(personalConfig: unknown) {
  const client = new MultitableApiClient({ fetchFn: vi.fn(async () => new Response('{}', { status: 200 })) })
  vi.spyOn(client, 'getPersonalViewConfig').mockResolvedValue({ viewId: 'v1', config: personalConfig as never, updatedAt: null })
  vi.spyOn(client, 'putPersonalViewConfig').mockResolvedValue({ viewId: 'v1', config: personalConfig as never, updatedAt: null })
  vi.spyOn(client, 'updateView').mockResolvedValue({} as never)
  return client
}

describe('useMultitableGrid — personal in-place edit is additive (Slice 3d wiring)', () => {
  it('personal ON: toggling a hidden field merges over the existing personal config (sort preserved), not updateView', async () => {
    const client = gridClient({ sortInfo: { fieldId: 'b', direction: 'desc' } })
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client, isPersonalMode: () => true })
    grid.toggleFieldVisibility('f1')
    await vi.waitFor(() => expect(client.putPersonalViewConfig).toHaveBeenCalled())
    expect(client.putPersonalViewConfig).toHaveBeenCalledWith('v1', { sortInfo: { fieldId: 'b', direction: 'desc' }, hiddenFieldIds: ['f1'] })
    expect(client.updateView).not.toHaveBeenCalled()
  })

  it('personal OFF: toggling a hidden field uses the shared updateView path, no personal-config calls', async () => {
    const client = gridClient(null)
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client, isPersonalMode: () => false })
    grid.toggleFieldVisibility('f1')
    await vi.waitFor(() => expect(client.updateView).toHaveBeenCalled())
    expect(client.updateView).toHaveBeenCalledWith('v1', { hiddenFieldIds: ['f1'] })
    expect(client.putPersonalViewConfig).not.toHaveBeenCalled()
    expect(client.getPersonalViewConfig).not.toHaveBeenCalled()
  })
})
