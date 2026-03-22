import { describe, expect, it } from 'vitest'
import {
  buildPlmAuditTeamViewCollaborationActionOutcome,
  buildPlmAuditTeamViewCollaborationFollowup,
  buildPlmAuditSavedViewPromotionCollaborationDraft,
  buildPlmAuditTeamViewCollaborationActionStatus,
  buildPlmAuditTeamViewCollaborationDraft,
  buildPlmAuditTeamViewCollaborationFollowupNotice,
  buildPlmAuditTeamViewCollaborationNotice,
  findPlmAuditTeamViewCollaborationFollowupView,
  resolvePlmAuditTeamViewCollaborationSourceAnchorId,
} from '../src/views/plmAuditTeamViewCollaboration'

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
      statusMessage:
        'Prepared collaboration controls for this audit team view.|已为该审计团队视图准备好协作操作。',
    })
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
    )).toEqual({
      statusMessage:
        'Share link copied for the recommended audit team view.|已复制推荐审计团队视图的分享链接。',
      followup: {
        teamViewId: 'audit-view-4',
        source: 'recommendation',
        action: 'share',
        logsAnchorId: 'plm-audit-log-results',
        sourceAnchorId: 'plm-audit-recommended-team-views',
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

  it('builds share and default follow-up state from the shared provenance contract', () => {
    expect(buildPlmAuditTeamViewCollaborationFollowup(
      'audit-view-4',
      'recommendation',
      'share',
    )).toEqual({
      teamViewId: 'audit-view-4',
      source: 'recommendation',
      action: 'share',
      logsAnchorId: 'plm-audit-log-results',
      sourceAnchorId: 'plm-audit-recommended-team-views',
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
})
