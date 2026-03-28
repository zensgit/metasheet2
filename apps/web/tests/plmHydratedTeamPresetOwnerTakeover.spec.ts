import { describe, expect, it } from 'vitest'
import {
  resolvePlmHydratedRemovedTeamPresetOwner,
  resolvePlmHydratedTeamPresetOwnerTakeover,
} from '../src/views/plm/plmHydratedTeamPresetOwnerTakeover'

describe('plmHydratedTeamPresetOwnerTakeover', () => {
  it('clears stale local selector drafts when route hydration targets another preset owner', () => {
    expect(resolvePlmHydratedTeamPresetOwnerTakeover({
      routeOwnerId: 'team-preset-b',
      localSelectorId: 'team-preset-a',
      localNameDraft: 'Rename A',
      localGroupDraft: 'A组',
      localOwnerUserIdDraft: 'owner-a',
      localSelectionIds: ['team-preset-a', 'team-preset-b'],
    })).toEqual({
      shouldClearLocalSelector: true,
      nextSelectorId: '',
      nextNameDraft: '',
      nextGroupDraft: '',
      nextOwnerUserIdDraft: '',
      nextSelectionIds: [],
    })
  })

  it('keeps local selector drafts when hydration confirms the same preset owner', () => {
    expect(resolvePlmHydratedTeamPresetOwnerTakeover({
      routeOwnerId: 'team-preset-a',
      localSelectorId: 'team-preset-a',
      localNameDraft: 'Rename A',
      localGroupDraft: 'A组',
      localOwnerUserIdDraft: 'owner-a',
      localSelectionIds: ['team-preset-a', 'team-preset-b'],
    })).toEqual({
      shouldClearLocalSelector: true,
      nextSelectorId: 'team-preset-a',
      nextNameDraft: 'Rename A',
      nextGroupDraft: 'A组',
      nextOwnerUserIdDraft: 'owner-a',
      nextSelectionIds: ['team-preset-a'],
    })
  })

  it('keeps local selector drafts when route hydration has no explicit preset owner', () => {
    expect(resolvePlmHydratedTeamPresetOwnerTakeover({
      routeOwnerId: '',
      localSelectorId: 'team-preset-a',
      localNameDraft: 'Rename A',
      localGroupDraft: 'A组',
      localOwnerUserIdDraft: 'owner-a',
      localSelectionIds: ['team-preset-a'],
    })).toEqual({
      shouldClearLocalSelector: false,
      nextSelectorId: 'team-preset-a',
      nextNameDraft: 'Rename A',
      nextGroupDraft: 'A组',
      nextOwnerUserIdDraft: 'owner-a',
      nextSelectionIds: ['team-preset-a'],
    })
  })

  it('clears local selector drafts when a hydrated preset owner is removed from route state', () => {
    expect(resolvePlmHydratedRemovedTeamPresetOwner({
      removedRouteOwnerId: 'team-preset-a',
      localSelectorId: 'team-preset-a',
      localNameDraft: 'Rename A',
      localGroupDraft: 'A组',
      localOwnerUserIdDraft: 'owner-a',
      localSelectionIds: ['team-preset-a', 'team-preset-b'],
    })).toEqual({
      shouldClearLocalSelector: true,
      nextSelectorId: '',
      nextNameDraft: '',
      nextGroupDraft: '',
      nextOwnerUserIdDraft: '',
      nextSelectionIds: ['team-preset-b'],
    })
  })

  it('preserves pending local selector drafts when a different hydrated owner is removed', () => {
    expect(resolvePlmHydratedRemovedTeamPresetOwner({
      removedRouteOwnerId: 'team-preset-a',
      localSelectorId: 'team-preset-b',
      localNameDraft: 'Rename B',
      localGroupDraft: 'B组',
      localOwnerUserIdDraft: 'owner-b',
      localSelectionIds: ['team-preset-a', 'team-preset-b'],
    })).toEqual({
      shouldClearLocalSelector: true,
      nextSelectorId: 'team-preset-b',
      nextNameDraft: 'Rename B',
      nextGroupDraft: 'B组',
      nextOwnerUserIdDraft: 'owner-b',
      nextSelectionIds: ['team-preset-b'],
    })
  })

  it('preserves the hydrated owner in batch selection when selector already targets it', () => {
    expect(resolvePlmHydratedTeamPresetOwnerTakeover({
      routeOwnerId: 'team-preset-b',
      localSelectorId: 'team-preset-b',
      localNameDraft: 'Rename B',
      localGroupDraft: 'B组',
      localOwnerUserIdDraft: 'owner-b',
      localSelectionIds: ['team-preset-a', 'team-preset-b'],
    })).toEqual({
      shouldClearLocalSelector: true,
      nextSelectorId: 'team-preset-b',
      nextNameDraft: 'Rename B',
      nextGroupDraft: 'B组',
      nextOwnerUserIdDraft: 'owner-b',
      nextSelectionIds: ['team-preset-b'],
    })
  })

  it('preserves pending local selection when a different hydrated owner is removed', () => {
    expect(resolvePlmHydratedRemovedTeamPresetOwner({
      removedRouteOwnerId: 'team-preset-a',
      localSelectorId: 'team-preset-b',
      localNameDraft: 'Rename B',
      localGroupDraft: 'B组',
      localOwnerUserIdDraft: 'owner-b',
      localSelectionIds: ['team-preset-a', 'team-preset-b'],
    })).toEqual({
      shouldClearLocalSelector: true,
      nextSelectorId: 'team-preset-b',
      nextNameDraft: 'Rename B',
      nextGroupDraft: 'B组',
      nextOwnerUserIdDraft: 'owner-b',
      nextSelectionIds: ['team-preset-b'],
    })
  })
})
