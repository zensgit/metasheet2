import { describe, expect, it } from 'vitest'
import { buildPlmAuditSceneContextTakeoverState } from '../src/views/plmAuditSceneContextTakeover'

describe('plmAuditSceneContextTakeover', () => {
  it('clears route-pivot attention and collaboration owners together', () => {
    expect(buildPlmAuditSceneContextTakeoverState({
      attentionFocus: {
        focusedAuditTeamViewId: 'team-view-1',
        focusedRecommendedAuditTeamViewId: 'recommended-1',
        focusedSavedViewId: 'saved-view-focus',
      },
      savedViewAttention: {
        shareFollowup: {
          savedViewId: 'saved-view-1',
          source: 'scene-context',
        },
        focusedSavedViewId: 'saved-view-focus',
      },
      shareEntry: {
        teamViewId: 'team-view-shared',
      },
      formDraft: {
        draftTeamViewName: 'Rename scene-owned view',
        draftTeamViewNameOwnerId: 'team-view-1',
        draftOwnerUserId: 'owner-a',
      },
      collaboration: {
        selectedIds: ['team-view-1'],
        draft: {
          teamViewId: 'team-view-1',
          teamViewName: 'Scene draft',
          teamViewOwnerUserId: '',
          focusTargetId: 'plm-audit-team-view-controls',
          statusMessage: 'Prepared',
          source: 'scene-context',
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
      consumeSharedEntry: true,
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

  it('preserves user multi-select while clearing scene-taken-over collaboration owners', () => {
    expect(buildPlmAuditSceneContextTakeoverState({
      attentionFocus: {
        focusedAuditTeamViewId: 'team-view-9',
        focusedRecommendedAuditTeamViewId: '',
        focusedSavedViewId: '',
      },
      savedViewAttention: {
        shareFollowup: null,
        focusedSavedViewId: '',
      },
      shareEntry: null,
      formDraft: {
        draftTeamViewName: 'Create new scene-owned view',
        draftTeamViewNameOwnerId: '',
        draftOwnerUserId: 'owner-draft',
      },
      collaboration: {
        selectedIds: ['team-view-9', 'team-view-10'],
        draft: {
          teamViewId: 'team-view-9',
          teamViewName: 'Scene draft',
          teamViewOwnerUserId: '',
          focusTargetId: 'plm-audit-team-view-controls',
          statusMessage: 'Prepared',
          source: 'scene-context',
          sourceSavedViewId: null,
        },
        followup: null,
      },
    })).toMatchObject({
      consumeSharedEntry: false,
      formDraft: {
        draftTeamViewName: 'Create new scene-owned view',
        draftTeamViewNameOwnerId: '',
        draftOwnerUserId: 'owner-draft',
      },
      collaboration: {
        selectedIds: ['team-view-9', 'team-view-10'],
        draft: null,
        followup: null,
      },
    })
  })

  it('clears shared-entry ownership when scene context takes over the route', () => {
    expect(buildPlmAuditSceneContextTakeoverState({
      attentionFocus: {
        focusedAuditTeamViewId: '',
        focusedRecommendedAuditTeamViewId: '',
        focusedSavedViewId: '',
      },
      savedViewAttention: {
        shareFollowup: null,
        focusedSavedViewId: '',
      },
      shareEntry: {
        teamViewId: 'team-view-shared',
      },
      formDraft: {
        draftTeamViewName: 'Rename scene target',
        draftTeamViewNameOwnerId: 'team-view-shared',
        draftOwnerUserId: 'owner-b',
      },
      collaboration: {
        selectedIds: [],
        draft: null,
        followup: null,
      },
    })).toMatchObject({
      shareEntry: null,
      consumeSharedEntry: true,
      formDraft: {
        draftTeamViewName: '',
        draftTeamViewNameOwnerId: '',
        draftOwnerUserId: '',
      },
    })
  })
})
