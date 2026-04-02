import { describe, expect, it } from 'vitest'
import { buildPlmAuditTeamViewRouteTakeoverState } from '../src/views/plmAuditTeamViewRouteTakeover'

describe('plmAuditTeamViewRouteTakeover', () => {
  it('clears transient attention, shared-entry owner, and collaboration ownership for resolved team-view routes', () => {
    expect(buildPlmAuditTeamViewRouteTakeoverState({
      attentionFocus: {
        focusedAuditTeamViewId: 'team-view-1',
        focusedRecommendedAuditTeamViewId: 'recommended-1',
        focusedSavedViewId: 'saved-view-focus',
      },
      savedViewAttention: {
        shareFollowup: {
          savedViewId: 'saved-view-1',
          source: 'shared-entry',
        },
        focusedSavedViewId: 'saved-view-focus',
      },
      formDraft: {
        draftTeamViewName: 'Rename legacy view',
        draftTeamViewNameOwnerId: 'team-view-legacy',
        draftOwnerUserId: 'owner-a',
      },
      collaboration: {
        selectedIds: ['team-view-1'],
        draft: {
          teamViewId: 'team-view-1',
          teamViewName: 'Draft',
          teamViewOwnerUserId: '',
          focusTargetId: 'plm-audit-team-view-controls',
          statusMessage: 'Prepared',
          source: 'recommendation',
          sourceSavedViewId: null,
        },
        followup: {
          teamViewId: 'team-view-2',
          source: 'scene-context',
          action: 'share',
          logsAnchorId: 'plm-audit-log-results',
          sourceAnchorId: 'plm-audit-scene-context',
          sourceSavedViewId: null,
        },
      },
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
      shareEntry: null,
      formDraft: {
        draftTeamViewName: '',
        draftTeamViewNameOwnerId: '',
        draftOwnerUserId: '',
      },
      collaboration: {
        selectedIds: [],
        draft: null,
        followup: null,
      },
    })
  })

  it('preserves user multi-select while clearing resolved-route collaboration owners', () => {
    expect(buildPlmAuditTeamViewRouteTakeoverState({
      attentionFocus: {
        focusedAuditTeamViewId: '',
        focusedRecommendedAuditTeamViewId: '',
        focusedSavedViewId: '',
      },
      savedViewAttention: {
        shareFollowup: null,
        focusedSavedViewId: '',
      },
      formDraft: {
        draftTeamViewName: 'Create new view',
        draftTeamViewNameOwnerId: '',
        draftOwnerUserId: 'owner-b',
      },
      collaboration: {
        selectedIds: ['team-view-1', 'team-view-2'],
        draft: {
          teamViewId: 'team-view-1',
          teamViewName: 'Draft',
          teamViewOwnerUserId: '',
          focusTargetId: 'plm-audit-team-view-controls',
          statusMessage: 'Prepared',
          source: 'recommendation',
          sourceSavedViewId: null,
        },
        followup: null,
      },
    }).collaboration).toEqual({
      selectedIds: ['team-view-1', 'team-view-2'],
      draft: null,
      followup: null,
    })
  })

  it('also clears stale shared-entry and saved-view attention for clear-selection refresh takeovers', () => {
    expect(buildPlmAuditTeamViewRouteTakeoverState({
      attentionFocus: {
        focusedAuditTeamViewId: 'archived-view',
        focusedRecommendedAuditTeamViewId: '',
        focusedSavedViewId: 'saved-view-archived',
      },
      savedViewAttention: {
        shareFollowup: {
          savedViewId: 'saved-view-archived',
          source: 'shared-entry',
        },
        focusedSavedViewId: 'saved-view-archived',
      },
      formDraft: {
        draftTeamViewName: 'Archived legacy draft',
        draftTeamViewNameOwnerId: 'archived-view',
        draftOwnerUserId: 'owner-c',
      },
      collaboration: {
        selectedIds: ['archived-view'],
        draft: null,
        followup: null,
      },
    })).toMatchObject({
      attentionFocus: {
        focusedAuditTeamViewId: '',
        focusedRecommendedAuditTeamViewId: '',
        focusedSavedViewId: '',
      },
      savedViewAttention: {
        shareFollowup: null,
        focusedSavedViewId: '',
      },
      shareEntry: null,
      formDraft: {
        draftTeamViewName: '',
        draftTeamViewNameOwnerId: '',
        draftOwnerUserId: '',
      },
      collaboration: {
        selectedIds: ['archived-view'],
        draft: null,
        followup: null,
      },
    })
  })
})
