import { describe, expect, it } from 'vitest'
import { resolvePlmHydratedTeamPresetOwnerTakeover } from '../src/views/plm/plmHydratedTeamPresetOwnerTakeover'

describe('plmHydratedTeamPresetOwnerTakeover', () => {
  it('clears stale local selector drafts when route hydration targets another preset owner', () => {
    expect(resolvePlmHydratedTeamPresetOwnerTakeover({
      routeOwnerId: 'team-preset-b',
      localSelectorId: 'team-preset-a',
      localNameDraft: 'Rename A',
      localGroupDraft: 'A组',
      localOwnerUserIdDraft: 'owner-a',
    })).toEqual({
      shouldClearLocalSelector: true,
      nextSelectorId: '',
      nextNameDraft: '',
      nextGroupDraft: '',
      nextOwnerUserIdDraft: '',
    })
  })

  it('keeps local selector drafts when hydration confirms the same preset owner', () => {
    expect(resolvePlmHydratedTeamPresetOwnerTakeover({
      routeOwnerId: 'team-preset-a',
      localSelectorId: 'team-preset-a',
      localNameDraft: 'Rename A',
      localGroupDraft: 'A组',
      localOwnerUserIdDraft: 'owner-a',
    })).toEqual({
      shouldClearLocalSelector: false,
      nextSelectorId: 'team-preset-a',
      nextNameDraft: 'Rename A',
      nextGroupDraft: 'A组',
      nextOwnerUserIdDraft: 'owner-a',
    })
  })

  it('keeps local selector drafts when route hydration has no explicit preset owner', () => {
    expect(resolvePlmHydratedTeamPresetOwnerTakeover({
      routeOwnerId: '',
      localSelectorId: 'team-preset-a',
      localNameDraft: 'Rename A',
      localGroupDraft: 'A组',
      localOwnerUserIdDraft: 'owner-a',
    })).toEqual({
      shouldClearLocalSelector: false,
      nextSelectorId: 'team-preset-a',
      nextNameDraft: 'Rename A',
      nextGroupDraft: 'A组',
      nextOwnerUserIdDraft: 'owner-a',
    })
  })
})
