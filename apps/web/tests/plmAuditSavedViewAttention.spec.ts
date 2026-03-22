import { describe, expect, it } from 'vitest'
import {
  applyPlmAuditSourceFocusState,
  buildPlmAuditTeamViewHandoffAttentionState,
  clearPlmAuditSourceFocusState,
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
