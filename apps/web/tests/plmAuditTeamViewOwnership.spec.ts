import { describe, expect, it } from 'vitest'
import {
  prunePlmAuditTransientOwnershipForRemovedViews,
  resolvePlmAuditRemovedTeamViewIds,
  trimPlmAuditExistingTeamViewUiState,
} from '../src/views/plmAuditTeamViewOwnership'

describe('plmAuditTeamViewOwnership', () => {
  it('detects team views removed by refreshes', () => {
    expect(resolvePlmAuditRemovedTeamViewIds([
      { id: 'audit-view-1' },
      { id: 'audit-view-2' },
      { id: 'audit-view-3' },
    ], [
      { id: 'audit-view-2' },
      { id: 'audit-view-4' },
    ])).toEqual([
      'audit-view-1',
      'audit-view-3',
    ])

    expect(resolvePlmAuditRemovedTeamViewIds([
      { id: 'audit-view-1' },
    ], [
      { id: 'audit-view-1' },
      { id: 'audit-view-2' },
    ])).toEqual([])
  })

  it('prunes invisible collaboration and shared-entry owners for removed team views', () => {
    expect(prunePlmAuditTransientOwnershipForRemovedViews({
      collaborationDraft: {
        teamViewId: 'audit-view-1',
        teamViewName: 'View A',
        teamViewOwnerUserId: 'owner-a',
        focusTargetId: 'focus-a',
        statusMessage: 'Draft',
        source: 'recommendation',
        sourceSavedViewId: null,
      },
      collaborationFollowup: {
        teamViewId: 'audit-view-2',
        source: 'scene-context',
        action: 'share',
        logsAnchorId: 'logs',
        sourceAnchorId: 'scene',
        sourceSavedViewId: null,
      },
      shareEntry: {
        teamViewId: 'audit-view-3',
      },
    }, [
      'audit-view-1',
      'audit-view-3',
    ])).toEqual({
      collaborationDraft: null,
      collaborationFollowup: {
        teamViewId: 'audit-view-2',
        source: 'scene-context',
        action: 'share',
        logsAnchorId: 'logs',
        sourceAnchorId: 'scene',
        sourceSavedViewId: null,
      },
      shareEntry: null,
    })
  })

  it('clears stale local selectors and focus when refresh removes their backing team views', () => {
    expect(trimPlmAuditExistingTeamViewUiState({
      selectedTeamViewId: 'audit-view-3',
      selectedIds: ['audit-view-1', 'audit-view-3'],
      focusedTeamViewId: 'audit-view-3',
      focusedRecommendedTeamViewId: 'audit-view-2',
      draftTeamViewName: '即将删除团队视图',
      draftOwnerUserId: 'owner-b',
    }, [
      { id: 'audit-view-1' },
      { id: 'audit-view-2' },
    ])).toEqual({
      selectedTeamViewId: '',
      selectedIds: ['audit-view-1'],
      focusedTeamViewId: '',
      focusedRecommendedTeamViewId: 'audit-view-2',
      draftTeamViewName: '',
      draftOwnerUserId: '',
    })
  })

  it('keeps create-form drafts when no selected team view is being removed', () => {
    expect(trimPlmAuditExistingTeamViewUiState({
      selectedTeamViewId: '',
      selectedIds: [],
      focusedTeamViewId: '',
      focusedRecommendedTeamViewId: '',
      draftTeamViewName: '新的团队视图',
      draftOwnerUserId: 'owner-c',
    }, [
      { id: 'audit-view-1' },
    ])).toEqual({
      selectedTeamViewId: '',
      selectedIds: [],
      focusedTeamViewId: '',
      focusedRecommendedTeamViewId: '',
      draftTeamViewName: '新的团队视图',
      draftOwnerUserId: 'owner-c',
    })
  })
})
