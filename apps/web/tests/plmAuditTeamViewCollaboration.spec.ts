import { describe, expect, it } from 'vitest'
import { buildPlmAuditTeamViewCollaborationDraft } from '../src/views/plmAuditTeamViewCollaboration'

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
      statusMessage:
        'Saved view promoted and collaboration controls are ready.|保存视图已提升为团队视图，并已准备好协作操作。',
    })
  })
})
