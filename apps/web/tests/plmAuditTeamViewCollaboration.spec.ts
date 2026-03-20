import { describe, expect, it } from 'vitest'
import {
  buildPlmAuditTeamViewCollaborationDraft,
  buildPlmAuditTeamViewCollaborationNotice,
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
})
