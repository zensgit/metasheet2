import { describe, expect, it } from 'vitest'
import {
  clearPlmAuditSourceFocusState,
  reducePlmAuditSavedViewAttentionState,
} from '../src/views/plmAuditSavedViewAttention'

describe('plmAuditSavedViewAttention', () => {
  it('clears transient recommendation and saved-view source focus together', () => {
    expect(clearPlmAuditSourceFocusState()).toEqual({
      focusedRecommendedAuditTeamViewId: '',
      focusedSavedViewId: '',
    })
  })

  it('clears saved-view followup and focus when saved-view navigation takes over', () => {
    expect(reducePlmAuditSavedViewAttentionState({
      shareFollowup: {
        savedViewId: 'saved-1',
        source: 'shared-entry',
      },
      focusedSavedViewId: 'saved-2',
    }, {
      kind: 'apply',
    })).toEqual({
      shareFollowup: null,
      focusedSavedViewId: '',
    })

    expect(reducePlmAuditSavedViewAttentionState({
      shareFollowup: {
        savedViewId: 'saved-3',
        source: 'scene-context',
      },
      focusedSavedViewId: 'saved-3',
    }, {
      kind: 'context-action',
    })).toEqual({
      shareFollowup: null,
      focusedSavedViewId: '',
    })

    expect(reducePlmAuditSavedViewAttentionState({
      shareFollowup: {
        savedViewId: 'saved-4',
        source: 'shared-entry',
      },
      focusedSavedViewId: 'saved-4',
    }, {
      kind: 'reset-filters',
    })).toEqual({
      shareFollowup: null,
      focusedSavedViewId: '',
    })
  })

  it('only clears the deleted saved-view attention target', () => {
    expect(reducePlmAuditSavedViewAttentionState({
      shareFollowup: {
        savedViewId: 'saved-1',
        source: 'shared-entry',
      },
      focusedSavedViewId: 'saved-2',
    }, {
      kind: 'delete',
      savedViewId: 'saved-1',
    })).toEqual({
      shareFollowup: null,
      focusedSavedViewId: 'saved-2',
    })

    expect(reducePlmAuditSavedViewAttentionState({
      shareFollowup: {
        savedViewId: 'saved-1',
        source: 'shared-entry',
      },
      focusedSavedViewId: 'saved-2',
    }, {
      kind: 'delete',
      savedViewId: 'saved-2',
    })).toEqual({
      shareFollowup: {
        savedViewId: 'saved-1',
        source: 'shared-entry',
      },
      focusedSavedViewId: '',
    })
  })
})
