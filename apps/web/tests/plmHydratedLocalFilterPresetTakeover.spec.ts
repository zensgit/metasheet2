import { describe, expect, it } from 'vitest'
import { resolvePlmHydratedLocalFilterPresetTakeover } from '../src/views/plm/plmHydratedLocalFilterPresetTakeover'

describe('plmHydratedLocalFilterPresetTakeover', () => {
  it('clears the local selector and drafts when route ownership moves to another local preset', () => {
    expect(resolvePlmHydratedLocalFilterPresetTakeover({
      routePresetKey: 'bom:route-b',
      localSelectorKey: 'bom:route-a',
      localNameDraft: 'A 预设草稿',
      localGroupDraft: 'A 分组草稿',
    })).toEqual({
      shouldClearLocalSelector: true,
      nextSelectorKey: '',
      nextNameDraft: '',
      nextGroupDraft: '',
    })
  })

  it('preserves the local selector when the hydrated route owner matches the current selector', () => {
    expect(resolvePlmHydratedLocalFilterPresetTakeover({
      routePresetKey: 'bom:route-a',
      localSelectorKey: 'bom:route-a',
      localNameDraft: 'A 预设草稿',
      localGroupDraft: 'A 分组草稿',
    })).toEqual({
      shouldClearLocalSelector: false,
      nextSelectorKey: 'bom:route-a',
      nextNameDraft: 'A 预设草稿',
      nextGroupDraft: 'A 分组草稿',
    })
  })
})
