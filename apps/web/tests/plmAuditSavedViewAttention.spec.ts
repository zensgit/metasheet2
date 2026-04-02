import { describe, expect, it } from 'vitest'
import {
  buildPlmAuditAppliedTeamViewAttentionState,
  applyPlmAuditSourceFocusState,
  buildPlmAuditClearedCollaborationFollowupAttentionState,
  buildPlmAuditDismissedCollaborationDraftAttentionState,
  buildPlmAuditManagedTeamViewAttentionState,
  buildPlmAuditPersistedTeamViewAttentionState,
  buildPlmAuditRoutePivotAttentionState,
  buildPlmAuditSavedViewStoreAttentionState,
  buildPlmAuditSourceLocalSaveAttentionState,
  buildPlmAuditSourceShareFollowupAttentionState,
  buildPlmAuditTeamViewHandoffAttentionState,
  clearPlmAuditSourceFocusState,
  resolvePlmAuditSavedViewAttentionRuntimeState,
  reducePlmAuditAttentionFocusState,
  reducePlmAuditSavedViewAttentionState,
} from '../src/views/plmAuditSavedViewAttention'

describe('plmAuditSavedViewAttention', () => {
  it('clears transient recommendation and saved-view source focus together', () => {
    expect(clearPlmAuditSourceFocusState()).toEqual({
      focusedRecommendedAuditTeamViewId: '',
      focusedSavedViewId: '',
    })
  })

  it('clears source, management, or all transient attention explicitly', () => {
    expect(reducePlmAuditAttentionFocusState({
      focusedAuditTeamViewId: 'team-view-1',
      focusedRecommendedAuditTeamViewId: 'recommended-1',
      focusedSavedViewId: 'saved-view-1',
    }, {
      kind: 'clear-source',
    })).toEqual({
      focusedAuditTeamViewId: 'team-view-1',
      focusedRecommendedAuditTeamViewId: '',
      focusedSavedViewId: '',
    })

    expect(reducePlmAuditAttentionFocusState({
      focusedAuditTeamViewId: 'team-view-2',
      focusedRecommendedAuditTeamViewId: 'recommended-2',
      focusedSavedViewId: 'saved-view-2',
    }, {
      kind: 'clear-management',
    })).toEqual({
      focusedAuditTeamViewId: '',
      focusedRecommendedAuditTeamViewId: 'recommended-2',
      focusedSavedViewId: 'saved-view-2',
    })

    expect(reducePlmAuditAttentionFocusState({
      focusedAuditTeamViewId: 'team-view-3',
      focusedRecommendedAuditTeamViewId: 'recommended-3',
      focusedSavedViewId: 'saved-view-3',
    }, {
      kind: 'clear-all',
    })).toEqual({
      focusedAuditTeamViewId: '',
      focusedRecommendedAuditTeamViewId: '',
      focusedSavedViewId: '',
    })
  })

  it('replaces prior source focus instead of merging it into a new follow-up target', () => {
    expect(applyPlmAuditSourceFocusState({
      focusedAuditTeamViewId: 'team-view-1',
      focusedRecommendedAuditTeamViewId: 'recommended-1',
      focusedSavedViewId: 'saved-view-1',
    }, {
      focusedRecommendedAuditTeamViewId: '',
      focusedSavedViewId: '',
    })).toEqual({
      focusedAuditTeamViewId: '',
      focusedRecommendedAuditTeamViewId: '',
      focusedSavedViewId: '',
    })

    expect(applyPlmAuditSourceFocusState({
      focusedAuditTeamViewId: 'team-view-2',
      focusedRecommendedAuditTeamViewId: 'recommended-2',
      focusedSavedViewId: 'saved-view-2',
    }, {
      focusedRecommendedAuditTeamViewId: 'recommended-9',
      focusedSavedViewId: '',
    })).toEqual({
      focusedAuditTeamViewId: '',
      focusedRecommendedAuditTeamViewId: 'recommended-9',
      focusedSavedViewId: '',
    })

    expect(applyPlmAuditSourceFocusState({
      focusedAuditTeamViewId: 'team-view-3',
      focusedRecommendedAuditTeamViewId: 'recommended-3',
      focusedSavedViewId: 'saved-view-3',
    }, {
      focusedRecommendedAuditTeamViewId: '',
      focusedSavedViewId: 'saved-view-9',
    })).toEqual({
      focusedAuditTeamViewId: '',
      focusedRecommendedAuditTeamViewId: '',
      focusedSavedViewId: 'saved-view-9',
    })
  })

  it('clears saved-view followup and focus when saved-view navigation, filter navigation, promotion, or shared-entry takeover takes over', () => {
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
      kind: 'filter-navigation',
    })).toEqual({
      shareFollowup: null,
      focusedSavedViewId: '',
    })

    expect(reducePlmAuditSavedViewAttentionState({
      shareFollowup: {
        savedViewId: 'saved-5',
        source: 'scene-context',
      },
      focusedSavedViewId: 'saved-6',
    }, {
      kind: 'promotion-handoff',
    })).toEqual({
      shareFollowup: null,
      focusedSavedViewId: '',
    })

    expect(reducePlmAuditSavedViewAttentionState({
      shareFollowup: {
        savedViewId: 'saved-7',
        source: 'shared-entry',
      },
      focusedSavedViewId: 'saved-7',
    }, {
      kind: 'reset-filters',
    })).toEqual({
      shareFollowup: null,
      focusedSavedViewId: '',
    })

    expect(reducePlmAuditSavedViewAttentionState({
      shareFollowup: {
        savedViewId: 'saved-8',
        source: 'scene-context',
      },
      focusedSavedViewId: 'saved-9',
    }, {
      kind: 'share-entry-takeover',
    })).toEqual({
      shareFollowup: null,
      focusedSavedViewId: '',
    })
  })

  it('replaces older saved-view focus when a new local followup is installed', () => {
    expect(reducePlmAuditSavedViewAttentionState({
      shareFollowup: {
        savedViewId: 'saved-1',
        source: 'shared-entry',
      },
      focusedSavedViewId: 'saved-2',
    }, {
      kind: 'install-followup',
      shareFollowup: {
        savedViewId: 'saved-3',
        source: 'scene-context',
      },
    })).toEqual({
      shareFollowup: {
        savedViewId: 'saved-3',
        source: 'scene-context',
      },
      focusedSavedViewId: '',
    })
  })

  it('clears source focus and local saved-view attention when a team-view handoff takes over', () => {
    expect(buildPlmAuditTeamViewHandoffAttentionState({
      focusedAuditTeamViewId: 'team-view-1',
      focusedRecommendedAuditTeamViewId: 'recommended-1',
      focusedSavedViewId: 'saved-view-1',
    }, {
      shareFollowup: {
        savedViewId: 'saved-view-2',
        source: 'scene-context',
      },
      focusedSavedViewId: 'saved-view-2',
    })).toEqual({
      attentionFocus: {
        focusedAuditTeamViewId: 'team-view-1',
        focusedRecommendedAuditTeamViewId: '',
        focusedSavedViewId: '',
      },
      savedViewAttention: {
        shareFollowup: null,
        focusedSavedViewId: '',
      },
    })
  })

  it('clears source focus and local saved-view followup when storing the current view', () => {
    expect(buildPlmAuditSavedViewStoreAttentionState({
      focusedAuditTeamViewId: 'team-view-9',
      focusedRecommendedAuditTeamViewId: 'recommended-9',
      focusedSavedViewId: 'saved-view-9',
    }, {
      shareFollowup: {
        savedViewId: 'saved-view-10',
        source: 'shared-entry',
      },
      focusedSavedViewId: 'saved-view-10',
    })).toEqual({
      attentionFocus: {
        focusedAuditTeamViewId: 'team-view-9',
        focusedRecommendedAuditTeamViewId: '',
        focusedSavedViewId: '',
      },
      savedViewAttention: {
        shareFollowup: null,
        focusedSavedViewId: '',
      },
    })
  })

  it('clears source focus and local saved-view followup when a managed team-view context takes over', () => {
    const attentionFocus = {
      focusedAuditTeamViewId: 'team-view-10',
      focusedRecommendedAuditTeamViewId: 'recommended-10',
      focusedSavedViewId: 'saved-view-10',
    }
    const savedViewAttention = {
      shareFollowup: {
        savedViewId: 'saved-view-11',
        source: 'shared-entry',
      },
      focusedSavedViewId: 'saved-view-11',
    }
    const expected = {
      attentionFocus: {
        focusedAuditTeamViewId: 'team-view-10',
        focusedRecommendedAuditTeamViewId: '',
        focusedSavedViewId: '',
      },
      savedViewAttention: {
        shareFollowup: null,
        focusedSavedViewId: '',
      },
    }

    expect(buildPlmAuditManagedTeamViewAttentionState(
      attentionFocus,
      savedViewAttention,
    )).toEqual(expected)

    expect(buildPlmAuditPersistedTeamViewAttentionState(
      attentionFocus,
      savedViewAttention,
    )).toEqual(expected)
  })

  it('clears management and source focus before installing a source-aware share followup', () => {
    expect(buildPlmAuditSourceShareFollowupAttentionState({
      focusedAuditTeamViewId: 'team-view-12',
      focusedRecommendedAuditTeamViewId: 'recommended-12',
      focusedSavedViewId: 'saved-view-12',
    }, {
      shareFollowup: {
        savedViewId: 'saved-view-13',
        source: 'scene-context',
      },
      focusedSavedViewId: 'saved-view-13',
    })).toEqual({
      attentionFocus: {
        focusedAuditTeamViewId: '',
        focusedRecommendedAuditTeamViewId: '',
        focusedSavedViewId: '',
      },
      savedViewAttention: {
        shareFollowup: null,
        focusedSavedViewId: '',
      },
    })
  })

  it('replaces stale focus with the newly applied team view when an apply action completes', () => {
    expect(buildPlmAuditAppliedTeamViewAttentionState({
      focusedAuditTeamViewId: 'team-view-old',
      focusedRecommendedAuditTeamViewId: 'recommended-11',
      focusedSavedViewId: 'saved-view-11',
    }, {
      shareFollowup: {
        savedViewId: 'saved-view-12',
        source: 'shared-entry',
      },
      focusedSavedViewId: 'saved-view-12',
    }, 'team-view-11')).toEqual({
      attentionFocus: {
        focusedAuditTeamViewId: 'team-view-11',
        focusedRecommendedAuditTeamViewId: '',
        focusedSavedViewId: '',
      },
      savedViewAttention: {
        shareFollowup: null,
        focusedSavedViewId: '',
      },
    })
  })

  it('clears management and source focus before installing a source-aware local-save followup', () => {
    expect(buildPlmAuditSourceLocalSaveAttentionState({
      focusedAuditTeamViewId: 'team-view-12',
      focusedRecommendedAuditTeamViewId: 'recommended-12',
      focusedSavedViewId: 'saved-view-12',
    }, {
      shareFollowup: {
        savedViewId: 'saved-view-13',
        source: 'scene-context',
      },
      focusedSavedViewId: 'saved-view-13',
    })).toEqual({
      attentionFocus: {
        focusedAuditTeamViewId: '',
        focusedRecommendedAuditTeamViewId: '',
        focusedSavedViewId: '',
      },
      savedViewAttention: {
        shareFollowup: null,
        focusedSavedViewId: '',
      },
    })
  })

  it('clears all transient attention when a collaboration followup is cleared', () => {
    expect(buildPlmAuditClearedCollaborationFollowupAttentionState({
      focusedAuditTeamViewId: 'team-view-14',
      focusedRecommendedAuditTeamViewId: 'recommended-14',
      focusedSavedViewId: 'saved-view-14',
    })).toEqual({
      attentionFocus: {
        focusedAuditTeamViewId: '',
        focusedRecommendedAuditTeamViewId: '',
        focusedSavedViewId: '',
      },
    })
  })

  it('clears only lifecycle management focus when a collaboration draft is dismissed', () => {
    expect(buildPlmAuditDismissedCollaborationDraftAttentionState({
      focusedAuditTeamViewId: 'team-view-15',
      focusedRecommendedAuditTeamViewId: 'recommended-15',
      focusedSavedViewId: 'saved-view-15',
    })).toEqual({
      attentionFocus: {
        focusedAuditTeamViewId: '',
        focusedRecommendedAuditTeamViewId: 'recommended-15',
        focusedSavedViewId: 'saved-view-15',
      },
    })
  })

  it('clears transient attention and saved-view followup on route pivots', () => {
    expect(buildPlmAuditRoutePivotAttentionState({
      focusedAuditTeamViewId: 'team-view-16',
      focusedRecommendedAuditTeamViewId: 'recommended-16',
      focusedSavedViewId: 'saved-view-16',
    }, {
      shareFollowup: {
        savedViewId: 'saved-view-17',
        source: 'shared-entry',
      },
      focusedSavedViewId: 'saved-view-17',
    })).toEqual({
      attentionFocus: {
        focusedAuditTeamViewId: '',
        focusedRecommendedAuditTeamViewId: '',
        focusedSavedViewId: '',
      },
      savedViewAttention: {
        shareFollowup: null,
        focusedSavedViewId: '',
      },
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

  it('clears stale saved-view focus when the backing saved view no longer exists at runtime', () => {
    expect(resolvePlmAuditSavedViewAttentionRuntimeState({
      shareFollowup: null,
      focusedSavedViewId: 'saved-2',
    }, [
      { id: 'saved-1' },
      { id: 'saved-3' },
    ])).toEqual({
      state: {
        shareFollowup: null,
        focusedSavedViewId: '',
      },
      changed: true,
    })

    expect(resolvePlmAuditSavedViewAttentionRuntimeState({
      shareFollowup: {
        savedViewId: 'saved-1',
        source: 'shared-entry',
      },
      focusedSavedViewId: 'saved-1',
    }, [
      { id: 'saved-1' },
      { id: 'saved-3' },
    ])).toEqual({
      state: {
        shareFollowup: {
          savedViewId: 'saved-1',
          source: 'shared-entry',
        },
        focusedSavedViewId: 'saved-1',
      },
      changed: false,
    })
  })
})
