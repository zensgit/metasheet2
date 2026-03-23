import { describe, expect, it } from 'vitest'
import {
  prunePlmAuditTransientOwnershipForRemovedViews,
  resolvePlmAuditCanonicalTeamViewFormDraftState,
  resolvePlmAuditRemovedTeamViewIds,
  resolvePlmAuditTakeoverTeamViewFormDraftState,
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
      managedTeamViewId: 'audit-view-3',
      selectedIds: ['audit-view-1', 'audit-view-3'],
      focusedTeamViewId: 'audit-view-3',
      focusedRecommendedTeamViewId: 'audit-view-2',
      draftTeamViewName: '即将删除团队视图',
      draftTeamViewNameOwnerId: 'audit-view-3',
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
      draftTeamViewNameOwnerId: '',
      draftOwnerUserId: '',
    })
  })

  it('keeps create-form drafts when no selected team view is being removed', () => {
    expect(trimPlmAuditExistingTeamViewUiState({
      selectedTeamViewId: '',
      managedTeamViewId: '',
      selectedIds: [],
      focusedTeamViewId: '',
      focusedRecommendedTeamViewId: '',
      draftTeamViewName: '新的团队视图',
      draftTeamViewNameOwnerId: '',
      draftOwnerUserId: 'owner-c',
    }, [
      { id: 'audit-view-1' },
    ])).toEqual({
      selectedTeamViewId: '',
      selectedIds: [],
      focusedTeamViewId: '',
      focusedRecommendedTeamViewId: '',
      draftTeamViewName: '新的团队视图',
      draftTeamViewNameOwnerId: '',
      draftOwnerUserId: 'owner-c',
    })
  })

  it('clears stale drafts when the canonical management owner disappears after refresh', () => {
    expect(trimPlmAuditExistingTeamViewUiState({
      selectedTeamViewId: '',
      managedTeamViewId: 'audit-view-3',
      selectedIds: [],
      focusedTeamViewId: 'audit-view-3',
      focusedRecommendedTeamViewId: '',
      draftTeamViewName: '待设默认团队视图',
      draftTeamViewNameOwnerId: 'audit-view-3',
      draftOwnerUserId: 'owner-d',
    }, [
      { id: 'audit-view-1' },
      { id: 'audit-view-2' },
    ])).toEqual({
      selectedTeamViewId: '',
      selectedIds: [],
      focusedTeamViewId: '',
      focusedRecommendedTeamViewId: '',
      draftTeamViewName: '',
      draftTeamViewNameOwnerId: '',
      draftOwnerUserId: '',
    })
  })

  it('keeps local selector drafts when only a different canonical owner disappears', () => {
    expect(trimPlmAuditExistingTeamViewUiState({
      selectedTeamViewId: 'audit-view-2',
      managedTeamViewId: 'audit-view-3',
      selectedIds: ['audit-view-2'],
      focusedTeamViewId: 'audit-view-2',
      focusedRecommendedTeamViewId: '',
      draftTeamViewName: '本地选择的团队视图',
      draftTeamViewNameOwnerId: 'audit-view-2',
      draftOwnerUserId: 'owner-e',
    }, [
      { id: 'audit-view-1' },
      { id: 'audit-view-2' },
    ])).toEqual({
      selectedTeamViewId: 'audit-view-2',
      selectedIds: ['audit-view-2'],
      focusedTeamViewId: 'audit-view-2',
      focusedRecommendedTeamViewId: '',
      draftTeamViewName: '本地选择的团队视图',
      draftTeamViewNameOwnerId: 'audit-view-2',
      draftOwnerUserId: 'owner-e',
    })
  })

  it('preserves team-view name drafts while clearing owner drafts when the canonical management target changes', () => {
    expect(resolvePlmAuditCanonicalTeamViewFormDraftState({
      previousCanonicalTeamViewId: 'audit-view-1',
      nextCanonicalTeamViewId: 'audit-view-2',
      draftTeamViewName: '重命名中的团队视图',
      draftTeamViewNameOwnerId: 'audit-view-1',
      draftOwnerUserId: 'owner-f',
    })).toEqual({
      draftTeamViewName: '重命名中的团队视图',
      draftTeamViewNameOwnerId: 'audit-view-1',
      draftOwnerUserId: '',
    })

    expect(resolvePlmAuditCanonicalTeamViewFormDraftState({
      previousCanonicalTeamViewId: 'audit-view-1',
      nextCanonicalTeamViewId: '',
      draftTeamViewName: '转移中的团队视图',
      draftTeamViewNameOwnerId: 'audit-view-1',
      draftOwnerUserId: 'owner-g',
    })).toEqual({
      draftTeamViewName: '转移中的团队视图',
      draftTeamViewNameOwnerId: 'audit-view-1',
      draftOwnerUserId: '',
    })
  })

  it('keeps form drafts when the canonical target stays the same or stays empty', () => {
    expect(resolvePlmAuditCanonicalTeamViewFormDraftState({
      previousCanonicalTeamViewId: 'audit-view-1',
      nextCanonicalTeamViewId: 'audit-view-1',
      draftTeamViewName: '同一团队视图',
      draftTeamViewNameOwnerId: 'audit-view-1',
      draftOwnerUserId: 'owner-h',
    })).toEqual({
      draftTeamViewName: '同一团队视图',
      draftTeamViewNameOwnerId: 'audit-view-1',
      draftOwnerUserId: 'owner-h',
    })

    expect(resolvePlmAuditCanonicalTeamViewFormDraftState({
      previousCanonicalTeamViewId: '',
      nextCanonicalTeamViewId: '',
      draftTeamViewName: '新建团队视图',
      draftTeamViewNameOwnerId: '',
      draftOwnerUserId: 'owner-i',
    })).toEqual({
      draftTeamViewName: '新建团队视图',
      draftTeamViewNameOwnerId: '',
      draftOwnerUserId: 'owner-i',
    })
  })

  it('clears management-owned drafts for non-management takeovers while preserving create-mode drafts', () => {
    expect(resolvePlmAuditTakeoverTeamViewFormDraftState({
      draftTeamViewName: '重命名中的团队视图',
      draftTeamViewNameOwnerId: 'audit-view-1',
      draftOwnerUserId: 'owner-j',
    })).toEqual({
      draftTeamViewName: '',
      draftTeamViewNameOwnerId: '',
      draftOwnerUserId: '',
    })

    expect(resolvePlmAuditTakeoverTeamViewFormDraftState({
      draftTeamViewName: '新建团队视图',
      draftTeamViewNameOwnerId: '',
      draftOwnerUserId: 'owner-k',
    })).toEqual({
      draftTeamViewName: '新建团队视图',
      draftTeamViewNameOwnerId: '',
      draftOwnerUserId: 'owner-k',
    })
  })
})
