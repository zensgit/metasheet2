import { describe, expect, it } from 'vitest'
import {
  resolvePlmHydratedRemovedTeamViewOwner,
  resolvePlmHydratedTeamViewOwnerTakeover,
} from '../src/views/plm/plmHydratedTeamViewOwnerTakeover'

describe('plmHydratedTeamViewOwnerTakeover', () => {
  it('clears stale local selector drafts when route hydration targets another owner', () => {
    expect(resolvePlmHydratedTeamViewOwnerTakeover({
      routeOwnerId: 'document-view-b',
      localSelectorId: 'document-view-a',
      localNameDraft: 'Rename A',
      localOwnerUserIdDraft: 'user-a',
    })).toEqual({
      shouldClearLocalSelector: true,
      nextSelectorId: '',
      nextNameDraft: '',
      nextOwnerUserIdDraft: '',
    })
  })

  it('keeps local selector drafts when hydration confirms the same owner', () => {
    expect(resolvePlmHydratedTeamViewOwnerTakeover({
      routeOwnerId: 'document-view-a',
      localSelectorId: 'document-view-a',
      localNameDraft: 'Rename A',
      localOwnerUserIdDraft: 'user-a',
    })).toEqual({
      shouldClearLocalSelector: false,
      nextSelectorId: 'document-view-a',
      nextNameDraft: 'Rename A',
      nextOwnerUserIdDraft: 'user-a',
    })
  })

  it('keeps local selector drafts when route hydration has no explicit owner', () => {
    expect(resolvePlmHydratedTeamViewOwnerTakeover({
      routeOwnerId: '',
      localSelectorId: 'document-view-a',
      localNameDraft: 'Rename A',
      localOwnerUserIdDraft: 'user-a',
    })).toEqual({
      shouldClearLocalSelector: false,
      nextSelectorId: 'document-view-a',
      nextNameDraft: 'Rename A',
      nextOwnerUserIdDraft: 'user-a',
    })
  })

  it('clears local selector drafts when a hydrated owner is removed from route state', () => {
    expect(resolvePlmHydratedRemovedTeamViewOwner({
      removedRouteOwnerId: 'document-view-a',
      localSelectorId: 'document-view-a',
      localNameDraft: 'Rename A',
      localOwnerUserIdDraft: 'user-a',
    })).toEqual({
      shouldClearLocalSelector: true,
      nextSelectorId: '',
      nextNameDraft: '',
      nextOwnerUserIdDraft: '',
    })
  })

  it('preserves pending local selector drafts when a different hydrated owner is removed', () => {
    expect(resolvePlmHydratedRemovedTeamViewOwner({
      removedRouteOwnerId: 'document-view-a',
      localSelectorId: 'document-view-b',
      localNameDraft: 'Rename B',
      localOwnerUserIdDraft: 'user-b',
    })).toEqual({
      shouldClearLocalSelector: false,
      nextSelectorId: 'document-view-b',
      nextNameDraft: 'Rename B',
      nextOwnerUserIdDraft: 'user-b',
    })
  })
})
