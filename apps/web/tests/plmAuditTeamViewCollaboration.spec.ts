import { describe, expect, it } from 'vitest'
import {
  buildPlmAuditTeamViewCollaborationActionOutcome,
  buildPlmAuditTeamViewCollaborationHandoff,
  buildPlmAuditTeamViewCollaborationFollowup,
  buildPlmAuditSavedViewPromotionCollaborationDraft,
  buildPlmAuditTeamViewCollaborationActionStatus,
  buildPlmAuditTeamViewCollaborationDraft,
  buildPlmAuditTeamViewCollaborationFollowupNotice,
  buildPlmAuditTeamViewCollaborationNotice,
  buildPlmAuditTeamViewCollaborationSourceFocusIntent,
  findPlmAuditTeamViewCollaborationDraftView,
  findPlmAuditTeamViewCollaborationFollowupView,
  prunePlmAuditTeamViewCollaborationDraftForRemovedViews,
  prunePlmAuditTeamViewCollaborationDraftSavedViewSource,
  prunePlmAuditTeamViewCollaborationFollowupForRemovedViews,
  prunePlmAuditTeamViewCollaborationFollowupSavedViewSource,
  resolvePlmAuditClearedTeamViewDraftSelection,
  resolvePlmAuditCompletedTeamViewBatchCollaborationDraft,
  resolvePlmAuditCompletedTeamViewCollaborationDraft,
  resolvePlmAuditSavedViewTakeoverCollaborationState,
  resolvePlmAuditTeamViewCollaborationActionFeedback,
  resolvePlmAuditTeamViewCollaborationFollowupActionFeedback,
  resolvePlmAuditTeamViewCollaborationSourceSavedViewId,
  resolvePlmAuditTeamViewCollaborationSourceRecommendationFilter,
  resolvePlmAuditTeamViewCollaborationRuntimeFollowup,
  resolvePlmAuditTeamViewCollaborationRuntimeState,
  resolvePlmAuditTeamViewFollowupSelection,
  resolvePlmAuditTeamViewCollaborationAttentionMode,
  resolvePlmAuditTeamViewCollaborationActionTarget,
  resolvePlmAuditTeamViewCollaborationSourceAnchorId,
  syncPlmAuditTeamViewCollaborationDraftSavedViewSource,
  syncPlmAuditTeamViewCollaborationFollowupSavedViewSource,
  shouldClearPlmAuditTeamViewCollaborationDraft,
  shouldClearPlmAuditTeamViewCollaborationFollowupForViewEntry,
  shouldKeepPlmAuditTeamViewCollaborationDraft,
  shouldKeepPlmAuditTeamViewCollaborationFollowup,
  shouldReplacePlmAuditTeamViewCollaborationDraftWithFollowup,
  shouldReplacePlmAuditTeamViewCollaborationOwnershipWithSharedEntry,
  syncPlmAuditTeamViewCollaborationFollowupSourceAnchor,
} from '../src/views/plmAuditTeamViewCollaboration'
import { buildPlmAuditTeamViewLogState } from '../src/views/plmAuditTeamViewAudit'

function tr(en: string, zh: string) {
  return `${en}|${zh}`
}

describe('plmAuditTeamViewCollaboration', () => {
  it('builds a recommendation-driven collaboration draft for an audit team view', () => {
    expect(buildPlmAuditTeamViewCollaborationDraft({
      id: 'audit-view-1',
      name: '默认审计视图',
    }, tr, 'recommendation')).toEqual({
      teamViewId: 'audit-view-1',
      teamViewName: '默认审计视图',
      teamViewOwnerUserId: '',
      focusTargetId: 'plm-audit-team-view-controls',
      source: 'recommendation',
      sourceSavedViewId: null,
      sourceRecommendationFilter: '',
      statusMessage:
        'Prepared collaboration controls for this audit team view.|已为该审计团队视图准备好协作操作。',
    })
  })

  it('finds the draft target view independently from the local selector state', () => {
    expect(findPlmAuditTeamViewCollaborationDraftView([
      { id: 'audit-view-1', name: 'A' },
      { id: 'audit-view-2', name: 'B' },
    ], {
      teamViewId: 'audit-view-1',
    })).toEqual({
      id: 'audit-view-1',
      name: 'A',
    })

    expect(findPlmAuditTeamViewCollaborationDraftView([
      { id: 'audit-view-1', name: 'A' },
    ], {
      teamViewId: 'audit-view-2',
    })).toBeNull()
  })

  it('keeps collaboration notice actions pinned to the draft target', () => {
    expect(resolvePlmAuditTeamViewCollaborationActionTarget(
      { id: 'audit-view-1', name: 'A' },
      { id: 'audit-view-2', name: 'B' },
    )).toEqual({
      id: 'audit-view-1',
      name: 'A',
    })

    expect(resolvePlmAuditTeamViewCollaborationActionTarget(
      null,
      { id: 'audit-view-2', name: 'B' },
    )).toBeNull()
  })

  it('builds a saved-view-promotion collaboration draft', () => {
    expect(buildPlmAuditTeamViewCollaborationDraft({
      id: 'audit-view-2',
      name: '新提升视图',
    }, tr, 'saved-view-promotion')).toEqual({
      teamViewId: 'audit-view-2',
      teamViewName: '新提升视图',
      teamViewOwnerUserId: '',
      focusTargetId: 'plm-audit-team-view-controls',
      source: 'saved-view-promotion',
      sourceSavedViewId: null,
      statusMessage:
        'Saved view promoted and collaboration controls are ready.|保存视图已提升为团队视图，并已准备好协作操作。',
    })
  })

  it('preserves scene-context provenance when a scene save follow-up promotes into a team view', () => {
    expect(buildPlmAuditSavedViewPromotionCollaborationDraft({
      id: 'audit-view-2',
      name: '新提升视图',
    }, 'scene-context', tr)).toEqual({
      teamViewId: 'audit-view-2',
      teamViewName: '新提升视图',
      teamViewOwnerUserId: '',
      focusTargetId: 'plm-audit-team-view-controls',
      source: 'scene-context',
      sourceSavedViewId: null,
      statusMessage:
        'Scene audit saved to team views and collaboration controls are ready.|场景审计已保存到团队视图，并已准备好协作操作。',
    })
  })

  it('builds a scene-context collaboration draft', () => {
    expect(buildPlmAuditTeamViewCollaborationDraft({
      id: 'audit-view-7',
      name: '场景团队视图',
    }, tr, 'scene-context')).toEqual({
      teamViewId: 'audit-view-7',
      teamViewName: '场景团队视图',
      teamViewOwnerUserId: '',
      focusTargetId: 'plm-audit-team-view-controls',
      source: 'scene-context',
      sourceSavedViewId: null,
      statusMessage:
        'Scene audit saved to team views and collaboration controls are ready.|场景审计已保存到团队视图，并已准备好协作操作。',
    })
  })

  it('builds collaboration notice actions for a promoted active team view', () => {
    const draft = buildPlmAuditTeamViewCollaborationDraft({
      id: 'audit-view-2',
      name: '新提升视图',
    }, tr, 'saved-view-promotion')

    expect(buildPlmAuditTeamViewCollaborationNotice({
      id: 'audit-view-2',
      name: '新提升视图',
      isDefault: false,
      isArchived: false,
    }, draft, {
      canShare: true,
      canSetDefault: true,
    }, tr)).toEqual({
      sourceLabel: 'Saved view promotion|保存视图提升',
      title: 'The promoted team view is ready for collaboration.|已提升的团队视图已可继续协作。',
      description:
        'Typical next steps are sharing this team view or promoting it to the default team audit entry.|常见下一步是分享这个团队视图，或继续提升为团队默认审计入口。',
      actions: [
        {
          kind: 'share',
          label: 'Copy share link|复制分享链接',
          emphasis: 'secondary',
        },
        {
          kind: 'set-default',
          label: 'Set as default|设为默认',
          emphasis: 'primary',
        },
        {
          kind: 'dismiss',
          label: 'Done|完成',
          emphasis: 'secondary',
        },
      ],
    })
  })

  it('returns explicit feedback when a collaboration draft disappears or loses its target', () => {
    expect(resolvePlmAuditTeamViewCollaborationActionFeedback({
      actionKind: 'share',
      draft: null,
      target: null,
      tr,
    })).toEqual({
      kind: 'error',
      message: 'Current audit team-view collaboration action is unavailable.|当前审计团队视图协作动作不可用。',
    })

    expect(resolvePlmAuditTeamViewCollaborationActionFeedback({
      actionKind: 'set-default',
      draft: {
        teamViewId: 'audit-view-2',
        teamViewName: 'Promoted view',
        teamViewOwnerUserId: '',
        focusTargetId: 'plm-audit-team-view-controls',
        statusMessage: 'ready',
        source: 'saved-view-promotion',
        sourceSavedViewId: 'saved-view-2',
      },
      target: null,
      tr,
    })).toEqual({
      kind: 'error',
      message:
        'Audit team view is no longer available. Recreate the collaboration flow before continuing.|审计团队视图已不存在。请先重新建立协作流程，再继续执行。',
    })
  })

  it('omits unavailable actions and only keeps dismiss for archived/default mismatches', () => {
    const draft = buildPlmAuditTeamViewCollaborationDraft({
      id: 'audit-view-3',
      name: '默认归档视图',
    }, tr, 'recommendation')

    expect(buildPlmAuditTeamViewCollaborationNotice({
      id: 'audit-view-3',
      name: '默认归档视图',
      isDefault: true,
      isArchived: true,
    }, draft, {
      canShare: false,
      canSetDefault: false,
    }, tr)?.actions).toEqual([
      {
        kind: 'dismiss',
        label: 'Done|完成',
        emphasis: 'secondary',
      },
    ])
  })

  it('builds source-aware status messages for follow-up actions', () => {
    expect(buildPlmAuditTeamViewCollaborationActionStatus('recommendation', 'share', tr)).toBe(
      'Share link copied for the recommended audit team view.|已复制推荐审计团队视图的分享链接。',
    )
    expect(buildPlmAuditTeamViewCollaborationActionStatus('saved-view-promotion', 'set-default', tr)).toBe(
      'Promoted audit team view set as default. Showing matching audit logs.|已将提升后的审计团队视图设为默认，并切换到对应审计日志。',
    )
    expect(buildPlmAuditTeamViewCollaborationActionStatus('scene-context', 'share', tr)).toBe(
      'Share link copied for the scene-driven audit team view.|已复制场景驱动审计团队视图的分享链接。',
    )
  })

  it('builds a source-aware collaboration outcome for share and default actions', () => {
    expect(buildPlmAuditTeamViewCollaborationActionOutcome(
      'audit-view-4',
      'recommendation',
      'share',
      tr,
      {
        sourceRecommendationFilter: 'recent-default',
      },
    )).toEqual({
      statusMessage:
        'Share link copied for the recommended audit team view.|已复制推荐审计团队视图的分享链接。',
      followup: {
        teamViewId: 'audit-view-4',
        source: 'recommendation',
        action: 'share',
        logsAnchorId: 'plm-audit-log-results',
        sourceAnchorId: 'plm-audit-recommended-team-views',
        sourceSavedViewId: null,
        sourceRecommendationFilter: 'recent-default',
      },
      scrollTargetId: null,
    })

    expect(buildPlmAuditTeamViewCollaborationActionOutcome(
      'audit-view-8',
      'scene-context',
      'set-default',
      tr,
      {
        sceneContextAvailable: false,
      },
    )).toEqual({
      statusMessage:
        'Scene-driven audit team view set as default. Showing matching audit logs.|场景驱动审计团队视图已设为默认，并切换到对应审计日志。',
      followup: {
        teamViewId: 'audit-view-8',
        source: 'scene-context',
        action: 'set-default',
        logsAnchorId: 'plm-audit-log-results',
        sourceAnchorId: 'plm-audit-team-view-controls',
        sourceSavedViewId: null,
      },
      scrollTargetId: 'plm-audit-log-results',
    })
  })

  it('falls back to generic collaboration outcomes when no provenance is available', () => {
    expect(buildPlmAuditTeamViewCollaborationActionOutcome(
      'audit-view-6',
      null,
      'share',
      tr,
    )).toEqual({
      statusMessage: 'Audit team view link copied.|审计团队视图链接已复制。',
      followup: null,
      scrollTargetId: null,
    })

    expect(buildPlmAuditTeamViewCollaborationActionOutcome(
      'audit-view-6',
      null,
      'set-default',
      tr,
    )).toEqual({
      statusMessage:
        'Audit team view set as default. Showing matching audit logs.|审计团队视图已设为默认，已切换到对应审计日志。',
      followup: null,
      scrollTargetId: null,
    })
  })

  it('routes generic and default collaboration outcomes through management attention cleanup', () => {
    expect(resolvePlmAuditTeamViewCollaborationAttentionMode('recommendation', 'share')).toBe(
      'source-share-followup',
    )
    expect(resolvePlmAuditTeamViewCollaborationAttentionMode(null, 'share')).toBe(
      'managed-team-view',
    )
    expect(resolvePlmAuditTeamViewCollaborationAttentionMode('saved-view-promotion', 'set-default')).toBe(
      'managed-team-view',
    )
    expect(resolvePlmAuditTeamViewCollaborationAttentionMode(null, 'set-default')).toBe(
      'managed-team-view',
    )
  })

  it('clears draft-owned single selection when share followup replaces a collaboration draft', () => {
    expect(resolvePlmAuditTeamViewFollowupSelection({
      selectedIds: ['audit-view-9'],
      previousDraft: {
        teamViewId: 'audit-view-9',
      },
      nextFollowup: {
        teamViewId: 'audit-view-9',
        action: 'share',
      },
    })).toEqual([])

    expect(resolvePlmAuditTeamViewFollowupSelection({
      selectedIds: ['audit-view-9', 'audit-view-10'],
      previousDraft: {
        teamViewId: 'audit-view-9',
      },
      nextFollowup: {
        teamViewId: 'audit-view-9',
        action: 'share',
      },
    })).toEqual(['audit-view-9', 'audit-view-10'])

    expect(resolvePlmAuditTeamViewFollowupSelection({
      selectedIds: ['audit-view-9'],
      previousDraft: {
        teamViewId: 'audit-view-9',
      },
      nextFollowup: {
        teamViewId: 'audit-view-9',
        action: 'set-default',
      },
    })).toEqual(['audit-view-9'])
  })

  it('clears draft-owned single selection whenever collaboration draft ownership is cleared', () => {
    expect(resolvePlmAuditClearedTeamViewDraftSelection({
      selectedIds: ['audit-view-9'],
      clearedDraft: {
        teamViewId: 'audit-view-9',
      },
    })).toEqual([])

    expect(resolvePlmAuditClearedTeamViewDraftSelection({
      selectedIds: ['audit-view-9', 'audit-view-10'],
      clearedDraft: {
        teamViewId: 'audit-view-9',
      },
    })).toEqual(['audit-view-9', 'audit-view-10'])

    expect(resolvePlmAuditClearedTeamViewDraftSelection({
      selectedIds: ['audit-view-10'],
      clearedDraft: {
        teamViewId: 'audit-view-9',
      },
    })).toEqual(['audit-view-10'])
  })

  it('clears the matching collaboration draft when a generic managed action completes', () => {
    expect(resolvePlmAuditCompletedTeamViewCollaborationDraft({
      selectedIds: ['audit-view-9'],
      draft: {
        teamViewId: 'audit-view-9',
      },
      nextFollowup: null,
      source: null,
      targetTeamViewId: 'audit-view-9',
    })).toEqual({
      selectedIds: [],
      clearDraft: true,
    })

    expect(resolvePlmAuditCompletedTeamViewCollaborationDraft({
      selectedIds: ['audit-view-9', 'audit-view-10'],
      draft: {
        teamViewId: 'audit-view-9',
      },
      nextFollowup: null,
      source: null,
      targetTeamViewId: 'audit-view-9',
    })).toEqual({
      selectedIds: ['audit-view-9', 'audit-view-10'],
      clearDraft: true,
    })
  })

  it('keeps generic managed actions from clearing unrelated or source-owned drafts', () => {
    expect(resolvePlmAuditCompletedTeamViewCollaborationDraft({
      selectedIds: ['audit-view-9'],
      draft: {
        teamViewId: 'audit-view-7',
      },
      nextFollowup: null,
      source: null,
      targetTeamViewId: 'audit-view-9',
    })).toEqual({
      selectedIds: ['audit-view-9'],
      clearDraft: false,
    })

    expect(resolvePlmAuditCompletedTeamViewCollaborationDraft({
      selectedIds: ['audit-view-9'],
      draft: {
        teamViewId: 'audit-view-9',
      },
      nextFollowup: {
        teamViewId: 'audit-view-9',
        action: 'share',
      },
      source: 'recommendation',
      targetTeamViewId: 'audit-view-9',
    })).toEqual({
      selectedIds: [],
      clearDraft: true,
    })
  })

  it('still clears a matching draft for clear-default log actions after teamViewId is cleared', () => {
    expect(buildPlmAuditTeamViewLogState({
      id: 'audit-view-9',
      kind: 'audit',
    }, 'clear-default', {
      windowMinutes: 180,
      returnToPlmPath: '/plm?sceneFocus=scene-9',
    }).teamViewId).toBe('')

    expect(resolvePlmAuditCompletedTeamViewCollaborationDraft({
      selectedIds: ['audit-view-9'],
      draft: {
        teamViewId: 'audit-view-9',
      },
      nextFollowup: null,
      source: null,
      targetTeamViewId: 'audit-view-9',
    })).toEqual({
      selectedIds: [],
      clearDraft: true,
    })
  })

  it('clears matching drafts for batch lifecycle actions without consuming user multi-select', () => {
    expect(resolvePlmAuditCompletedTeamViewBatchCollaborationDraft({
      selectedIds: ['audit-view-9'],
      draft: {
        teamViewId: 'audit-view-9',
      },
      processedTeamViewIds: ['audit-view-9'],
    })).toEqual({
      selectedIds: [],
      clearDraft: true,
    })

    expect(resolvePlmAuditCompletedTeamViewBatchCollaborationDraft({
      selectedIds: ['audit-view-9', 'audit-view-10'],
      draft: {
        teamViewId: 'audit-view-9',
      },
      processedTeamViewIds: ['audit-view-9', 'audit-view-11'],
    })).toEqual({
      selectedIds: ['audit-view-9', 'audit-view-10'],
      clearDraft: true,
    })

    expect(resolvePlmAuditCompletedTeamViewBatchCollaborationDraft({
      selectedIds: ['audit-view-9'],
      draft: {
        teamViewId: 'audit-view-8',
      },
      processedTeamViewIds: ['audit-view-9'],
    })).toEqual({
      selectedIds: ['audit-view-9'],
      clearDraft: false,
    })
  })

  it('clears collaboration owners before a saved-view takeover installs its own state', () => {
    expect(resolvePlmAuditSavedViewTakeoverCollaborationState({
      selectedIds: ['audit-view-9'],
      draft: {
        teamViewId: 'audit-view-9',
      },
      followup: {
        teamViewId: 'audit-view-10',
      },
    })).toEqual({
      selectedIds: [],
      draft: null,
      followup: null,
    })

    expect(resolvePlmAuditSavedViewTakeoverCollaborationState({
      selectedIds: ['audit-view-9', 'audit-view-10'],
      draft: {
        teamViewId: 'audit-view-9',
      },
      followup: {
        teamViewId: 'audit-view-11',
      },
    })).toEqual({
      selectedIds: ['audit-view-9', 'audit-view-10'],
      draft: null,
      followup: null,
    })

    expect(resolvePlmAuditSavedViewTakeoverCollaborationState({
      selectedIds: ['audit-view-12'],
      draft: {
        teamViewId: 'audit-view-12',
      },
      followup: null,
    })).toEqual({
      selectedIds: [],
      draft: null,
      followup: null,
    })
  })

  it('clears draft-owned single selection for route takeovers that reuse the saved-view takeover contract', () => {
    expect(resolvePlmAuditSavedViewTakeoverCollaborationState({
      selectedIds: ['audit-view-scene'],
      draft: {
        teamViewId: 'audit-view-scene',
      },
      followup: {
        teamViewId: 'audit-view-logs',
      },
    })).toEqual({
      selectedIds: [],
      draft: null,
      followup: null,
    })
  })

  it('clears draft-owned single selection when a generic local save takes over collaboration state', () => {
    expect(resolvePlmAuditSavedViewTakeoverCollaborationState({
      selectedIds: ['audit-view-local'],
      draft: {
        teamViewId: 'audit-view-local',
      },
      followup: null,
    })).toEqual({
      selectedIds: [],
      draft: null,
      followup: null,
    })
  })

  it('keeps collaboration drafts pinned to the canonical team-view route only', () => {
    expect(shouldKeepPlmAuditTeamViewCollaborationDraft({
      teamViewId: 'audit-view-9',
    }, 'audit-view-9')).toBe(true)

    expect(shouldKeepPlmAuditTeamViewCollaborationDraft({
      teamViewId: 'audit-view-9',
    }, 'audit-view-10')).toBe(false)

    expect(shouldKeepPlmAuditTeamViewCollaborationDraft(null, 'audit-view-9')).toBe(false)
  })

  it('clears collaboration ownership when the owning team view entry is removed', () => {
    expect(prunePlmAuditTeamViewCollaborationDraftForRemovedViews({
      teamViewId: 'audit-view-9',
      teamViewName: 'A',
      teamViewOwnerUserId: '',
      focusTargetId: 'plm-audit-team-view-controls',
      source: 'recommendation',
      sourceSavedViewId: null,
      statusMessage: 'prepared',
    }, ['audit-view-9'])).toBeNull()

    expect(prunePlmAuditTeamViewCollaborationFollowupForRemovedViews({
      teamViewId: 'audit-view-9',
      source: 'recommendation',
      action: 'share',
      logsAnchorId: 'plm-audit-log-results',
      sourceAnchorId: 'plm-audit-recommended-team-views',
      sourceSavedViewId: null,
    }, ['audit-view-9'])).toBeNull()

    expect(prunePlmAuditTeamViewCollaborationFollowupForRemovedViews({
      teamViewId: 'audit-view-9',
      source: 'recommendation',
      action: 'share',
      logsAnchorId: 'plm-audit-log-results',
      sourceAnchorId: 'plm-audit-recommended-team-views',
      sourceSavedViewId: null,
    }, ['audit-view-10'])).toEqual({
      teamViewId: 'audit-view-9',
      source: 'recommendation',
      action: 'share',
      logsAnchorId: 'plm-audit-log-results',
      sourceAnchorId: 'plm-audit-recommended-team-views',
      sourceSavedViewId: null,
    })
  })

  it('builds a draft handoff for recommendation and promotion flows', () => {
    expect(buildPlmAuditTeamViewCollaborationHandoff(
      {
        id: 'audit-view-10',
        name: '推荐团队视图',
      },
      {
        source: 'recommendation',
        mode: 'draft',
        selectable: true,
      },
      tr,
    )).toEqual({
      selectedTeamViewId: 'audit-view-10',
      teamViewName: '推荐团队视图',
      teamViewOwnerUserId: '',
      selectedIds: ['audit-view-10'],
      focusedTeamViewId: 'audit-view-10',
      draft: {
        teamViewId: 'audit-view-10',
        teamViewName: '推荐团队视图',
        teamViewOwnerUserId: '',
        focusTargetId: 'plm-audit-team-view-controls',
        source: 'recommendation',
        sourceSavedViewId: null,
        sourceRecommendationFilter: '',
        statusMessage:
          'Prepared collaboration controls for this audit team view.|已为该审计团队视图准备好协作操作。',
      },
      followup: null,
      scrollTargetId: 'plm-audit-team-view-controls',
      statusMessage:
        'Prepared collaboration controls for this audit team view.|已为该审计团队视图准备好协作操作。',
    })

    expect(buildPlmAuditTeamViewCollaborationHandoff(
      {
        id: 'audit-view-10',
        name: '推荐团队视图',
      },
      {
        source: 'recommendation',
        mode: 'draft',
        selectable: true,
        sourceRecommendationFilter: '',
      },
      tr,
    ).draft).toMatchObject({
      teamViewId: 'audit-view-10',
      source: 'recommendation',
      sourceRecommendationFilter: '',
    })
  })

  it('preserves the active recommendation filter through handoff draft for focus-source round-trip', () => {
    const handoff = buildPlmAuditTeamViewCollaborationHandoff(
      { id: 'audit-view-12', name: '近期默认视图' },
      {
        source: 'recommendation',
        mode: 'draft',
        selectable: true,
        sourceRecommendationFilter: 'recent-default',
      },
      tr,
    )
    expect(handoff.draft?.sourceRecommendationFilter).toBe('recent-default')

    // Simulate share → followup → focus-source round-trip
    const followup = buildPlmAuditTeamViewCollaborationFollowup(
      'audit-view-12',
      'recommendation',
      'share',
      { sourceRecommendationFilter: 'recent-default' },
    )
    const focusIntent = buildPlmAuditTeamViewCollaborationSourceFocusIntent(
      followup,
      { id: 'audit-view-12', isDefault: false, lastDefaultSetAt: '2026-03-19T10:00:00.000Z' },
    )
    expect(focusIntent.recommendationFilter).toBe('recent-default')
  })

  it('defaults to empty recommendation filter when sourceRecommendationFilter is omitted from handoff', () => {
    const handoff = buildPlmAuditTeamViewCollaborationHandoff(
      { id: 'audit-view-13', name: '无过滤视图' },
      { source: 'recommendation', mode: 'draft', selectable: true },
      tr,
    )
    // When omitted, resolves to '' (all recommendations)
    expect(handoff.draft?.sourceRecommendationFilter).toBe('')

    expect(buildPlmAuditTeamViewCollaborationHandoff(
      {
        id: 'audit-view-11',
        name: '提升团队视图',
      },
      {
        source: 'saved-view-promotion',
        mode: 'draft',
        selectable: false,
        statusSuffix: 'Local-only context note.',
      },
      tr,
    )).toEqual({
      selectedTeamViewId: 'audit-view-11',
      teamViewName: '提升团队视图',
      teamViewOwnerUserId: '',
      selectedIds: [],
      focusedTeamViewId: 'audit-view-11',
      draft: {
        teamViewId: 'audit-view-11',
        teamViewName: '提升团队视图',
        teamViewOwnerUserId: '',
        focusTargetId: 'plm-audit-team-view-controls',
        source: 'saved-view-promotion',
        sourceSavedViewId: null,
        statusMessage:
          'Saved view promoted and collaboration controls are ready.|保存视图已提升为团队视图，并已准备好协作操作。',
      },
      followup: null,
      scrollTargetId: 'plm-audit-team-view-controls',
      statusMessage:
        'Saved view promoted and collaboration controls are ready.|保存视图已提升为团队视图，并已准备好协作操作。 Local-only context note.',
    })
  })

  it('builds a default-followup handoff without exposing draft state', () => {
    expect(buildPlmAuditTeamViewCollaborationHandoff(
      {
        id: 'audit-view-12',
        name: '默认团队视图',
      },
      {
        source: 'scene-context',
        mode: 'set-default-followup',
        selectable: true,
        sceneContextAvailable: false,
        statusSuffix: 'Local-only context note.',
      },
      tr,
    )).toEqual({
      selectedTeamViewId: null,
      teamViewName: null,
      teamViewOwnerUserId: null,
      selectedIds: [],
      focusedTeamViewId: 'audit-view-12',
      draft: null,
      followup: {
        teamViewId: 'audit-view-12',
        source: 'scene-context',
        action: 'set-default',
        logsAnchorId: 'plm-audit-log-results',
        sourceAnchorId: 'plm-audit-team-view-controls',
        sourceSavedViewId: null,
      },
      scrollTargetId: 'plm-audit-log-results',
      statusMessage:
        'Scene-driven audit team view set as default. Showing matching audit logs.|场景驱动审计团队视图已设为默认，并切换到对应审计日志。 Local-only context note.',
    })
  })

  it('builds share follow-up actions after collaboration copy', () => {
    expect(buildPlmAuditTeamViewCollaborationFollowupNotice({
      id: 'audit-view-4',
      isDefault: false,
      isArchived: false,
    }, {
      teamViewId: 'audit-view-4',
      source: 'recommendation',
      action: 'share',
      logsAnchorId: 'plm-audit-log-results',
      sourceAnchorId: 'plm-audit-recommended-team-views',
    }, {
      canSetDefault: true,
    }, tr)).toEqual({
      sourceLabel: 'Recommended team view|推荐团队视图',
      title: 'Share link copied.|分享链接已复制。',
      description:
        'This share link came from a recommended team view card. You can jump back to recommendations or continue by promoting it to the default audit entry.|这条分享链接来自推荐团队视图卡片。你可以返回推荐区域，或继续将其提升为默认审计入口。',
      actions: [
        {
          kind: 'set-default',
          label: 'Set as default|设为默认',
          emphasis: 'primary',
        },
        {
          kind: 'focus-source',
          label: 'Back to recommendations|回到推荐卡片',
          emphasis: 'secondary',
        },
        {
          kind: 'dismiss',
          label: 'Done|完成',
          emphasis: 'secondary',
        },
      ],
    })
  })

  it('maps collaboration sources to the expected source anchors', () => {
    expect(resolvePlmAuditTeamViewCollaborationSourceAnchorId('recommendation')).toBe(
      'plm-audit-recommended-team-views',
    )
    expect(resolvePlmAuditTeamViewCollaborationSourceAnchorId('saved-view-promotion')).toBe(
      'plm-audit-saved-views',
    )
    expect(resolvePlmAuditTeamViewCollaborationSourceAnchorId('scene-context')).toBe(
      'plm-audit-scene-context',
    )
    expect(resolvePlmAuditTeamViewCollaborationSourceAnchorId('scene-context', {
      sceneContextAvailable: false,
    })).toBe('plm-audit-team-view-controls')
  })

  it('normalizes recommendation provenance filters for direct source actions', () => {
    expect(resolvePlmAuditTeamViewCollaborationSourceRecommendationFilter(
      'recommendation',
      'recent-default',
    )).toBe('recent-default')
    expect(resolvePlmAuditTeamViewCollaborationSourceRecommendationFilter(
      'recommendation',
    )).toBe('')
    expect(resolvePlmAuditTeamViewCollaborationSourceRecommendationFilter(
      'saved-view-promotion',
      'recent-default',
    )).toBeUndefined()
  })

  it('reuses the recommendation provenance normalizer for draft and followup builders', () => {
    expect(buildPlmAuditTeamViewCollaborationDraft({
      id: 'audit-view-14',
      name: '推荐团队视图',
    }, tr, 'recommendation', {
      sourceRecommendationFilter: 'recent-default',
    }).sourceRecommendationFilter).toBe('recent-default')

    expect(buildPlmAuditTeamViewCollaborationFollowup(
      'audit-view-14',
      'recommendation',
      'share',
    ).sourceRecommendationFilter).toBe('')

    expect(buildPlmAuditTeamViewCollaborationDraft({
      id: 'audit-view-15',
      name: '场景团队视图',
    }, tr, 'scene-context', {
      sourceRecommendationFilter: 'recent-default',
    }).sourceRecommendationFilter).toBeUndefined()
  })

  it('reuses the saved-view provenance normalizer for draft and followup builders', () => {
    expect(resolvePlmAuditTeamViewCollaborationSourceSavedViewId(
      'saved-view-promotion',
      'saved-view-14',
    )).toBe('saved-view-14')
    expect(resolvePlmAuditTeamViewCollaborationSourceSavedViewId(
      'saved-view-promotion',
    )).toBeNull()
    expect(resolvePlmAuditTeamViewCollaborationSourceSavedViewId(
      'scene-context',
      'saved-view-14',
    )).toBeNull()

    expect(buildPlmAuditTeamViewCollaborationDraft({
      id: 'audit-view-16',
      name: '提升团队视图',
    }, tr, 'saved-view-promotion', {
      sourceSavedViewId: 'saved-view-14',
    }).sourceSavedViewId).toBe('saved-view-14')

    expect(buildPlmAuditTeamViewCollaborationFollowup(
      'audit-view-16',
      'scene-context',
      'share',
      {
        sourceSavedViewId: 'saved-view-14',
      },
    ).sourceSavedViewId).toBeNull()
  })

  it('builds recommendation source focus intent that restores the card filter and focus', () => {
    expect(buildPlmAuditTeamViewCollaborationSourceFocusIntent({
      source: 'recommendation',
      sourceAnchorId: 'plm-audit-recommended-team-views',
      sourceRecommendationFilter: 'recent-default',
    }, {
      id: 'audit-view-4',
      isDefault: false,
      lastDefaultSetAt: '2026-03-19T15:00:00.000Z',
    })).toEqual({
      anchorId: 'plm-audit-recommended-team-views',
      focusedRecommendationTeamViewId: 'audit-view-4',
      focusedSavedViewId: null,
      recommendationFilter: 'recent-default',
    })
  })

  it('preserves the original recommendation filter for focus-source instead of recomputing from the live card', () => {
    expect(buildPlmAuditTeamViewCollaborationSourceFocusIntent({
      source: 'recommendation',
      sourceAnchorId: 'plm-audit-recommended-team-views',
      sourceRecommendationFilter: '',
    }, {
      id: 'audit-view-4',
      isDefault: false,
      lastDefaultSetAt: '2026-03-19T15:00:00.000Z',
    })).toEqual({
      anchorId: 'plm-audit-recommended-team-views',
      focusedRecommendationTeamViewId: 'audit-view-4',
      focusedSavedViewId: null,
      recommendationFilter: '',
    })
  })

  it('falls back to anchor-only source focus when the follow-up did not come from recommendations', () => {
    expect(buildPlmAuditTeamViewCollaborationSourceFocusIntent({
      source: 'saved-view-promotion',
      sourceAnchorId: 'plm-audit-saved-views',
      sourceSavedViewId: null,
    }, {
      id: 'audit-view-6',
      isDefault: false,
      lastDefaultSetAt: '',
    })).toEqual({
      anchorId: 'plm-audit-saved-views',
      focusedRecommendationTeamViewId: null,
      focusedSavedViewId: null,
      recommendationFilter: '',
    })
  })

  it('restores the originating saved view card when a promotion follow-up goes back to source', () => {
    expect(buildPlmAuditTeamViewCollaborationSourceFocusIntent({
      source: 'saved-view-promotion',
      sourceAnchorId: 'plm-audit-saved-views',
      sourceSavedViewId: 'saved-view-7',
    })).toEqual({
      anchorId: 'plm-audit-saved-views',
      focusedRecommendationTeamViewId: null,
      focusedSavedViewId: 'saved-view-7',
      recommendationFilter: '',
    })
  })

  it('keeps scene-context source focus anchor-only so stale saved/recommendation focus can be cleared', () => {
    expect(buildPlmAuditTeamViewCollaborationSourceFocusIntent({
      source: 'scene-context',
      sourceAnchorId: 'plm-audit-scene-context',
      sourceSavedViewId: null,
    })).toEqual({
      anchorId: 'plm-audit-scene-context',
      focusedRecommendationTeamViewId: null,
      focusedSavedViewId: null,
      recommendationFilter: '',
    })
  })

  it('builds share and default follow-up state from the shared provenance contract', () => {
    expect(buildPlmAuditTeamViewCollaborationFollowup(
      'audit-view-4',
      'recommendation',
      'share',
      {
        sourceRecommendationFilter: '',
      },
    )).toEqual({
      teamViewId: 'audit-view-4',
      source: 'recommendation',
      action: 'share',
      logsAnchorId: 'plm-audit-log-results',
      sourceAnchorId: 'plm-audit-recommended-team-views',
      sourceSavedViewId: null,
      sourceRecommendationFilter: '',
    })

    expect(buildPlmAuditTeamViewCollaborationFollowup(
      'audit-view-8',
      'scene-context',
      'set-default',
    )).toEqual({
      teamViewId: 'audit-view-8',
      source: 'scene-context',
      action: 'set-default',
      logsAnchorId: 'plm-audit-log-results',
      sourceAnchorId: 'plm-audit-scene-context',
      sourceSavedViewId: null,
    })

    expect(buildPlmAuditTeamViewCollaborationFollowup(
      'audit-view-9',
      'scene-context',
      'share',
      {
        sceneContextAvailable: false,
      },
    )).toEqual({
      teamViewId: 'audit-view-9',
      source: 'scene-context',
      action: 'share',
      logsAnchorId: 'plm-audit-log-results',
      sourceAnchorId: 'plm-audit-team-view-controls',
      sourceSavedViewId: null,
    })
  })

  it('builds default-change log review follow-up after default promotion', () => {
    expect(buildPlmAuditTeamViewCollaborationFollowupNotice({
      id: 'audit-view-5',
      isDefault: true,
      isArchived: false,
    }, {
      teamViewId: 'audit-view-5',
      source: 'saved-view-promotion',
      action: 'set-default',
      logsAnchorId: 'plm-audit-log-results',
      sourceAnchorId: 'plm-audit-saved-views',
    }, {
      canSetDefault: false,
    }, tr)).toEqual({
      sourceLabel: 'Saved view promotion|保存视图提升',
      title: 'Default audit entry updated.|默认审计入口已更新。',
      description:
        'Matching default-change audit logs are ready below. Review them now or dismiss this follow-up.|对应的默认变更审计日志已在下方就绪。你可以立即查看，或关闭这条后续提示。',
      actions: [
        {
          kind: 'view-logs',
          label: 'Review audit logs|查看审计日志',
          emphasis: 'primary',
        },
        {
          kind: 'dismiss',
          label: 'Done|完成',
          emphasis: 'secondary',
        },
      ],
    })
  })

  it('builds saved-view share follow-up with a return-to-source action', () => {
    expect(buildPlmAuditTeamViewCollaborationFollowupNotice({
      id: 'audit-view-6',
      isDefault: false,
      isArchived: false,
    }, {
      teamViewId: 'audit-view-6',
      source: 'saved-view-promotion',
      action: 'share',
      logsAnchorId: 'plm-audit-log-results',
      sourceAnchorId: 'plm-audit-saved-views',
    }, {
      canSetDefault: false,
    }, tr)).toEqual({
      sourceLabel: 'Saved view promotion|保存视图提升',
      title: 'Share link copied.|分享链接已复制。',
      description:
        'This share link came from the saved-view promotion flow. You can return to the saved-view list or continue by promoting this team view to the default audit entry.|这条分享链接来自保存视图提升流程。你可以返回保存视图列表，或继续将该团队视图提升为默认审计入口。',
      actions: [
        {
          kind: 'focus-source',
          label: 'Back to saved views|回到保存视图',
          emphasis: 'secondary',
        },
        {
          kind: 'dismiss',
          label: 'Done|完成',
          emphasis: 'secondary',
        },
      ],
    })
  })

  it('builds scene-context share follow-up with a return-to-context action', () => {
    expect(buildPlmAuditTeamViewCollaborationFollowupNotice({
      id: 'audit-view-8',
      isDefault: false,
      isArchived: false,
    }, {
      teamViewId: 'audit-view-8',
      source: 'scene-context',
      action: 'share',
      logsAnchorId: 'plm-audit-log-results',
      sourceAnchorId: 'plm-audit-scene-context',
    }, {
      canSetDefault: true,
    }, tr)).toEqual({
      sourceLabel: 'Scene save shortcut|场景快捷保存',
      title: 'Share link copied.|分享链接已复制。',
      description:
        'This share link came from the scene quick-save flow. You can jump back to the scene context or continue by promoting this team view to the default audit entry.|这条分享链接来自场景快捷保存流程。你可以返回场景上下文，或继续将该团队视图提升为默认审计入口。',
      actions: [
        {
          kind: 'set-default',
          label: 'Set as default|设为默认',
          emphasis: 'primary',
        },
        {
          kind: 'focus-source',
          label: 'Back to scene context|回到场景上下文',
          emphasis: 'secondary',
        },
        {
          kind: 'dismiss',
          label: 'Done|完成',
          emphasis: 'secondary',
        },
      ],
    })
  })

  it('falls back to team-view controls when scene-context provenance survives but the scene banner is gone', () => {
    expect(buildPlmAuditTeamViewCollaborationFollowupNotice({
      id: 'audit-view-9',
      isDefault: false,
      isArchived: false,
    }, {
      teamViewId: 'audit-view-9',
      source: 'scene-context',
      action: 'share',
      logsAnchorId: 'plm-audit-log-results',
      sourceAnchorId: 'plm-audit-team-view-controls',
    }, {
      canSetDefault: true,
    }, tr)).toEqual({
      sourceLabel: 'Scene save shortcut|场景快捷保存',
      title: 'Share link copied.|分享链接已复制。',
      description:
        'This share link came from the scene quick-save flow. You can jump back to the team-view controls or continue by promoting this team view to the default audit entry.|这条分享链接来自场景快捷保存流程。你可以返回团队视图控制区，或继续将该团队视图提升为默认审计入口。',
      actions: [
        {
          kind: 'set-default',
          label: 'Set as default|设为默认',
          emphasis: 'primary',
        },
        {
          kind: 'focus-source',
          label: 'Back to team view controls|回到团队视图控制区',
          emphasis: 'secondary',
        },
        {
          kind: 'dismiss',
          label: 'Done|完成',
          emphasis: 'secondary',
        },
      ],
    })
  })

  it('retargets scene-context followups when the scene banner disappears', () => {
    expect(syncPlmAuditTeamViewCollaborationFollowupSourceAnchor({
      teamViewId: 'audit-view-9',
      source: 'scene-context',
      action: 'share',
      logsAnchorId: 'plm-audit-log-results',
      sourceAnchorId: 'plm-audit-scene-context',
      sourceSavedViewId: null,
    }, {
      sceneContextAvailable: false,
    })).toEqual({
      teamViewId: 'audit-view-9',
      source: 'scene-context',
      action: 'share',
      logsAnchorId: 'plm-audit-log-results',
      sourceAnchorId: 'plm-audit-team-view-controls',
      sourceSavedViewId: null,
    })

    expect(syncPlmAuditTeamViewCollaborationFollowupSourceAnchor({
      teamViewId: 'audit-view-10',
      source: 'saved-view-promotion',
      action: 'share',
      logsAnchorId: 'plm-audit-log-results',
      sourceAnchorId: 'plm-audit-saved-views',
      sourceSavedViewId: 'saved-view-10',
    }, {
      sceneContextAvailable: false,
    })).toEqual({
      teamViewId: 'audit-view-10',
      source: 'saved-view-promotion',
      action: 'share',
      logsAnchorId: 'plm-audit-log-results',
      sourceAnchorId: 'plm-audit-saved-views',
      sourceSavedViewId: 'saved-view-10',
    })
  })

  it('marks runtime followups as changed when a scene-context anchor must be persisted to controls', () => {
    expect(resolvePlmAuditTeamViewCollaborationRuntimeFollowup({
      teamViewId: 'audit-view-9',
      source: 'scene-context',
      action: 'share',
      logsAnchorId: 'plm-audit-log-results',
      sourceAnchorId: 'plm-audit-scene-context',
      sourceSavedViewId: null,
    }, {
      sceneContextAvailable: false,
    })).toEqual({
      followup: {
        teamViewId: 'audit-view-9',
        source: 'scene-context',
        action: 'share',
        logsAnchorId: 'plm-audit-log-results',
        sourceAnchorId: 'plm-audit-team-view-controls',
        sourceSavedViewId: null,
      },
      changed: true,
    })

    expect(resolvePlmAuditTeamViewCollaborationRuntimeFollowup({
      teamViewId: 'audit-view-9',
      source: 'scene-context',
      action: 'share',
      logsAnchorId: 'plm-audit-log-results',
      sourceAnchorId: 'plm-audit-team-view-controls',
      sourceSavedViewId: null,
    }, {
      sceneContextAvailable: false,
    })).toEqual({
      followup: {
        teamViewId: 'audit-view-9',
        source: 'scene-context',
        action: 'share',
        logsAnchorId: 'plm-audit-log-results',
        sourceAnchorId: 'plm-audit-team-view-controls',
        sourceSavedViewId: null,
      },
      changed: false,
    })
  })

  it('drops missing saved-view provenance from promotion drafts and followups at runtime', () => {
    expect(syncPlmAuditTeamViewCollaborationDraftSavedViewSource({
      teamViewId: 'audit-view-11',
      teamViewName: '提升后的审计视图',
      teamViewOwnerUserId: '',
      focusTargetId: 'plm-audit-team-view-controls',
      source: 'saved-view-promotion',
      sourceSavedViewId: 'saved-view-11',
      statusMessage: 'ready',
    }, [
      { id: 'saved-view-2' },
    ])).toEqual({
      teamViewId: 'audit-view-11',
      teamViewName: '提升后的审计视图',
      teamViewOwnerUserId: '',
      focusTargetId: 'plm-audit-team-view-controls',
      source: 'saved-view-promotion',
      sourceSavedViewId: null,
      statusMessage: 'ready',
    })

    expect(syncPlmAuditTeamViewCollaborationFollowupSavedViewSource({
      teamViewId: 'audit-view-12',
      source: 'saved-view-promotion',
      action: 'share',
      logsAnchorId: 'plm-audit-log-results',
      sourceAnchorId: 'plm-audit-saved-views',
      sourceSavedViewId: 'saved-view-12',
    }, [
      { id: 'saved-view-2' },
    ])).toEqual({
      teamViewId: 'audit-view-12',
      source: 'saved-view-promotion',
      action: 'share',
      logsAnchorId: 'plm-audit-log-results',
      sourceAnchorId: 'plm-audit-saved-views',
      sourceSavedViewId: null,
    })
  })

  it('persists collaboration runtime cleanup when saved-view promotion provenance disappears externally', () => {
    expect(resolvePlmAuditTeamViewCollaborationRuntimeState({
      draft: {
        teamViewId: 'audit-view-13',
        teamViewName: '提升后的审计视图',
        teamViewOwnerUserId: '',
        focusTargetId: 'plm-audit-team-view-controls',
        source: 'saved-view-promotion',
        sourceSavedViewId: 'saved-view-13',
        statusMessage: 'ready',
      },
      followup: {
        teamViewId: 'audit-view-13',
        source: 'saved-view-promotion',
        action: 'share',
        logsAnchorId: 'plm-audit-log-results',
        sourceAnchorId: 'plm-audit-saved-views',
        sourceSavedViewId: 'saved-view-13',
      },
    }, {
      savedViews: [
        { id: 'saved-view-2' },
      ],
      sceneContextAvailable: true,
    })).toEqual({
      state: {
        draft: {
          teamViewId: 'audit-view-13',
          teamViewName: '提升后的审计视图',
          teamViewOwnerUserId: '',
          focusTargetId: 'plm-audit-team-view-controls',
          source: 'saved-view-promotion',
          sourceSavedViewId: null,
          statusMessage: 'ready',
        },
        followup: {
          teamViewId: 'audit-view-13',
          source: 'saved-view-promotion',
          action: 'share',
          logsAnchorId: 'plm-audit-log-results',
          sourceAnchorId: 'plm-audit-saved-views',
          sourceSavedViewId: null,
        },
      },
      changed: true,
    })
  })

  it('finds the follow-up target by id even after route selection is cleared', () => {
    expect(findPlmAuditTeamViewCollaborationFollowupView([
      { id: 'audit-view-1', isDefault: false },
      { id: 'audit-view-2', isDefault: true },
    ], {
      teamViewId: 'audit-view-2',
    })).toEqual({
      id: 'audit-view-2',
      isDefault: true,
    })
  })

  it('returns explicit feedback when a collaboration follow-up disappears or loses its target', () => {
    expect(resolvePlmAuditTeamViewCollaborationFollowupActionFeedback({
      actionKind: 'set-default',
      followup: null,
      target: null,
      tr,
    })).toEqual({
      kind: 'error',
      message: 'Current audit team-view follow-up is unavailable.|当前审计团队视图后续动作不可用。',
    })

    expect(resolvePlmAuditTeamViewCollaborationFollowupActionFeedback({
      actionKind: 'focus-source',
      followup: {
        teamViewId: 'audit-view-2',
        source: 'saved-view-promotion',
        action: 'share',
        logsAnchorId: 'plm-audit-log-results',
        sourceAnchorId: 'plm-audit-saved-views',
        sourceSavedViewId: 'saved-view-2',
      },
      target: null,
      tr,
    })).toBeNull()

    expect(resolvePlmAuditTeamViewCollaborationFollowupActionFeedback({
      actionKind: 'focus-source',
      followup: {
        teamViewId: 'audit-view-3',
        source: 'scene-context',
        action: 'share',
        logsAnchorId: 'plm-audit-log-results',
        sourceAnchorId: 'plm-audit-scene-context',
        sourceSavedViewId: null,
      },
      target: null,
      tr,
    })).toBeNull()
  })

  it('keeps default-log follow-ups actionable without a live team-view record', () => {
    expect(resolvePlmAuditTeamViewCollaborationFollowupActionFeedback({
      actionKind: 'view-logs',
      followup: {
        teamViewId: 'audit-view-2',
        source: 'recommendation',
        action: 'set-default',
        logsAnchorId: 'plm-audit-log-results',
        sourceAnchorId: 'plm-audit-team-view-recommendations',
        sourceSavedViewId: null,
      },
      target: null,
      tr,
    })).toBeNull()

    expect(buildPlmAuditTeamViewCollaborationFollowupNotice(
      null,
      {
        teamViewId: 'audit-view-2',
        source: 'recommendation',
        action: 'set-default',
        logsAnchorId: 'plm-audit-log-results',
        sourceAnchorId: 'plm-audit-team-view-recommendations',
        sourceSavedViewId: null,
      },
      {
        canSetDefault: false,
      },
      tr,
    )).toEqual({
      sourceLabel: 'Recommended team view|推荐团队视图',
      title: 'Default audit entry updated.|默认审计入口已更新。',
      description:
        'Matching default-change audit logs are ready below. Review them now or dismiss this follow-up.|对应的默认变更审计日志已在下方就绪。你可以立即查看，或关闭这条后续提示。',
      actions: [
        {
          kind: 'view-logs',
          label: 'Review audit logs|查看审计日志',
          emphasis: 'primary',
        },
        {
          kind: 'dismiss',
          label: 'Done|完成',
          emphasis: 'secondary',
        },
      ],
    })
  })

  it('keeps follow-ups only while the route still matches their audit context', () => {
    expect(shouldKeepPlmAuditTeamViewCollaborationFollowup({
      teamViewId: 'audit-view-6',
      action: 'share',
    }, {
      page: 1,
      teamViewId: 'audit-view-6',
      q: '',
      actorId: '',
      kind: '',
      action: '',
      resourceType: '',
      from: '',
      to: '',
      windowMinutes: 180,
    })).toBe(true)

    expect(shouldKeepPlmAuditTeamViewCollaborationFollowup({
      teamViewId: 'audit-view-6',
      action: 'share',
    }, {
      page: 1,
      teamViewId: '',
      q: '',
      actorId: '',
      kind: '',
      action: '',
      resourceType: '',
      from: '',
      to: '',
      windowMinutes: 180,
    })).toBe(false)

    expect(shouldKeepPlmAuditTeamViewCollaborationFollowup({
      teamViewId: 'audit-view-9',
      action: 'set-default',
    }, {
      page: 1,
      teamViewId: '',
      q: 'audit-view-9',
      actorId: '',
      kind: 'audit',
      action: 'set-default',
      resourceType: 'plm-team-view-default',
      from: '',
      to: '',
      windowMinutes: 180,
    })).toBe(true)

    expect(shouldKeepPlmAuditTeamViewCollaborationFollowup({
      teamViewId: 'audit-view-9',
      action: 'set-default',
    }, {
      page: 1,
      teamViewId: '',
      q: '',
      actorId: '',
      kind: '',
      action: '',
      resourceType: '',
      from: '',
      to: '',
      windowMinutes: 180,
    })).toBe(false)

    expect(shouldKeepPlmAuditTeamViewCollaborationFollowup({
      teamViewId: 'audit-view-9',
      action: 'set-default',
    }, {
      page: 1,
      teamViewId: '',
      q: 'other-view',
      actorId: '',
      kind: 'audit',
      action: 'set-default',
      resourceType: 'plm-team-view-default',
      from: '',
      to: '',
      windowMinutes: 180,
    })).toBe(false)

    expect(shouldKeepPlmAuditTeamViewCollaborationFollowup({
      teamViewId: 'audit-view-9',
      action: 'set-default',
    }, {
      page: 2,
      teamViewId: '',
      q: 'audit-view-9',
      actorId: '',
      kind: 'audit',
      action: 'set-default',
      resourceType: 'plm-team-view-default',
      from: '',
      to: '',
      windowMinutes: 180,
    })).toBe(false)

    expect(shouldKeepPlmAuditTeamViewCollaborationFollowup({
      teamViewId: 'audit-view-9',
      action: 'set-default',
    }, {
      page: 1,
      teamViewId: '',
      q: 'audit-view-9',
      actorId: 'owner-a',
      kind: 'audit',
      action: 'set-default',
      resourceType: 'plm-team-view-default',
      from: '',
      to: '',
      windowMinutes: 180,
    })).toBe(false)

    expect(shouldKeepPlmAuditTeamViewCollaborationFollowup({
      teamViewId: 'audit-view-9',
      action: 'set-default',
    }, {
      page: 1,
      teamViewId: '',
      q: 'audit-view-9',
      actorId: '',
      kind: 'audit',
      action: 'set-default',
      resourceType: 'plm-team-view-default',
      from: '2026-03-22',
      to: '',
      windowMinutes: 180,
    })).toBe(false)

    expect(shouldKeepPlmAuditTeamViewCollaborationFollowup({
      teamViewId: 'audit-view-9',
      action: 'set-default',
    }, {
      page: 1,
      teamViewId: '',
      q: 'audit-view-9',
      actorId: '',
      kind: 'audit',
      action: 'set-default',
      resourceType: 'plm-team-view-default',
      from: '',
      to: '',
      windowMinutes: 720,
    })).toBe(false)

    expect(shouldKeepPlmAuditTeamViewCollaborationFollowup({
      teamViewId: 'audit-view-9',
      action: 'set-default',
    }, {
      page: 1,
      teamViewId: '',
      q: 'audit-view-9',
      actorId: '',
      kind: 'documents',
      action: 'set-default',
      resourceType: 'plm-team-view-default',
      from: '',
      to: '',
      windowMinutes: 180,
    })).toBe(false)
  })

  it('drops deleted saved-view provenance from promotion drafts and follow-ups', () => {
    expect(prunePlmAuditTeamViewCollaborationDraftSavedViewSource({
      teamViewId: 'audit-view-2',
      teamViewName: '新提升视图',
      teamViewOwnerUserId: '',
      focusTargetId: 'plm-audit-team-view-controls',
      source: 'saved-view-promotion',
      sourceSavedViewId: 'saved-view-7',
      statusMessage: 'ready',
    }, 'saved-view-7')).toEqual({
      teamViewId: 'audit-view-2',
      teamViewName: '新提升视图',
      teamViewOwnerUserId: '',
      focusTargetId: 'plm-audit-team-view-controls',
      source: 'saved-view-promotion',
      sourceSavedViewId: null,
      statusMessage: 'ready',
    })

    expect(prunePlmAuditTeamViewCollaborationFollowupSavedViewSource({
      teamViewId: 'audit-view-3',
      source: 'saved-view-promotion',
      action: 'share',
      logsAnchorId: 'plm-audit-log-results',
      sourceAnchorId: 'plm-audit-saved-views',
      sourceSavedViewId: 'saved-view-8',
    }, 'saved-view-8')).toEqual({
      teamViewId: 'audit-view-3',
      source: 'saved-view-promotion',
      action: 'share',
      logsAnchorId: 'plm-audit-log-results',
      sourceAnchorId: 'plm-audit-saved-views',
      sourceSavedViewId: null,
    })
  })

  it('keeps set-default follow-ups on the ownerless default-log route after the backing view leaves the list', () => {
    expect(prunePlmAuditTeamViewCollaborationFollowupForRemovedViews({
      teamViewId: 'audit-view-9',
      source: 'recommendation',
      action: 'set-default',
      logsAnchorId: 'plm-audit-log-results',
      sourceAnchorId: 'plm-audit-team-view-recommendations',
      sourceSavedViewId: null,
    }, [
      'audit-view-9',
    ])).toEqual({
      teamViewId: 'audit-view-9',
      source: 'recommendation',
      action: 'set-default',
      logsAnchorId: 'plm-audit-log-results',
      sourceAnchorId: 'plm-audit-team-view-recommendations',
      sourceSavedViewId: null,
    })
  })

  it('clears the matching collaboration draft after share handoff takes over', () => {
    expect(shouldClearPlmAuditTeamViewCollaborationDraft(
      {
        teamViewId: 'audit-view-2',
      },
      'audit-view-2',
    )).toBe(true)

    expect(shouldClearPlmAuditTeamViewCollaborationDraft(
      {
        teamViewId: 'audit-view-2',
      },
      'audit-view-7',
    )).toBe(false)
  })

  it('replaces an existing collaboration draft once any collaboration follow-up takes over', () => {
    expect(shouldReplacePlmAuditTeamViewCollaborationDraftWithFollowup(
      {
        teamViewId: 'audit-view-2',
      },
      {
        teamViewId: 'audit-view-2',
      },
    )).toBe(true)

    expect(shouldReplacePlmAuditTeamViewCollaborationDraftWithFollowup(
      {
        teamViewId: 'audit-view-2',
      },
      {
        teamViewId: 'audit-view-9',
      },
    )).toBe(true)

    expect(shouldReplacePlmAuditTeamViewCollaborationDraftWithFollowup(
      {
        teamViewId: 'audit-view-2',
      },
      {
        teamViewId: 'audit-view-7',
      },
    )).toBe(true)

    expect(shouldReplacePlmAuditTeamViewCollaborationDraftWithFollowup(
      {
        teamViewId: 'audit-view-2',
      },
      null,
    )).toBe(false)

    expect(shouldReplacePlmAuditTeamViewCollaborationDraftWithFollowup(
      null,
      {
        teamViewId: 'audit-view-7',
      },
    )).toBe(false)
  })

  it('replaces any collaboration owner once shared-entry takes over', () => {
    expect(shouldReplacePlmAuditTeamViewCollaborationOwnershipWithSharedEntry(
      {
        teamViewId: 'audit-view-2',
      },
      null,
    )).toBe(true)

    expect(shouldReplacePlmAuditTeamViewCollaborationOwnershipWithSharedEntry(
      null,
      {
        teamViewId: 'audit-view-8',
      },
    )).toBe(true)

    expect(shouldReplacePlmAuditTeamViewCollaborationOwnershipWithSharedEntry(
      {
        teamViewId: 'audit-view-2',
      },
      {
        teamViewId: 'audit-view-8',
      },
    )).toBe(true)

    expect(shouldReplacePlmAuditTeamViewCollaborationOwnershipWithSharedEntry(
      null,
      null,
    )).toBe(false)
  })

  it('clears the matching collaboration follow-up when shared-link entry takes over the same view', () => {
    expect(shouldClearPlmAuditTeamViewCollaborationFollowupForViewEntry(
      {
        teamViewId: 'audit-view-3',
      },
      'audit-view-3',
    )).toBe(true)

    expect(shouldClearPlmAuditTeamViewCollaborationFollowupForViewEntry(
      {
        teamViewId: 'audit-view-3',
      },
      'audit-view-8',
    )).toBe(false)
  })
})
