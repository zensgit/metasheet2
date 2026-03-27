import { describe, expect, it } from 'vitest'
import { resolvePlmHydratedLocalFilterPresetTakeover } from '../src/views/plm/plmHydratedLocalFilterPresetTakeover'

describe('plmHydratedLocalFilterPresetTakeover', () => {
  it('clears the local selector and drafts when route ownership moves to another local preset', () => {
    expect(resolvePlmHydratedLocalFilterPresetTakeover({
      routePresetKey: 'bom:route-b',
      localSelectorKey: 'bom:route-a',
      localNameDraft: 'A 预设草稿',
      localGroupDraft: 'A 分组草稿',
      localSelectionKeys: ['bom:route-a', 'bom:other'],
      localBatchGroupDraft: '批量分组',
    })).toEqual({
      shouldClearLocalSelector: true,
      nextSelectorKey: '',
      nextNameDraft: '',
      nextGroupDraft: '',
      nextSelectionKeys: [],
      nextBatchGroupDraft: '',
    })
  })

  it('preserves the local selector when the hydrated route owner matches the current selector', () => {
    expect(resolvePlmHydratedLocalFilterPresetTakeover({
      routePresetKey: 'bom:route-a',
      localSelectorKey: 'bom:route-a',
      localNameDraft: 'A 预设草稿',
      localGroupDraft: 'A 分组草稿',
      localSelectionKeys: ['bom:route-a'],
      localBatchGroupDraft: '批量分组',
    })).toEqual({
      shouldClearLocalSelector: false,
      nextSelectorKey: 'bom:route-a',
      nextNameDraft: 'A 预设草稿',
      nextGroupDraft: 'A 分组草稿',
      nextSelectionKeys: ['bom:route-a'],
      nextBatchGroupDraft: '批量分组',
    })
  })

  it('preserves batch management state when hydration has no explicit route owner', () => {
    expect(resolvePlmHydratedLocalFilterPresetTakeover({
      routePresetKey: '',
      localSelectorKey: 'bom:route-a',
      localNameDraft: 'A 预设草稿',
      localGroupDraft: 'A 分组草稿',
      localSelectionKeys: ['bom:route-a'],
      localBatchGroupDraft: '批量分组',
    })).toEqual({
      shouldClearLocalSelector: false,
      nextSelectorKey: 'bom:route-a',
      nextNameDraft: 'A 预设草稿',
      nextGroupDraft: 'A 分组草稿',
      nextSelectionKeys: ['bom:route-a'],
      nextBatchGroupDraft: '批量分组',
    })
  })
})
