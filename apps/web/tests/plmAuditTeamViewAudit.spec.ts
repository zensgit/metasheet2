import { describe, expect, it } from 'vitest'
import {
  buildPlmAuditTeamViewBatchLogState,
  buildPlmAuditTeamViewLogState,
} from '../src/views/plmAuditTeamViewAudit'
import type { PlmWorkbenchTeamView } from '../src/views/plm/plmPanelModels'

function createAuditTeamView(
  overrides: Partial<PlmWorkbenchTeamView<'audit'>> = {},
): PlmWorkbenchTeamView<'audit'> {
  return {
    id: 'audit-view-1',
    kind: 'audit',
    scope: 'team',
    name: '默认审计视图',
    ownerUserId: 'owner-a',
    canManage: true,
    permissions: {
      canManage: true,
      canApply: true,
      canDuplicate: true,
      canShare: true,
      canDelete: true,
      canArchive: true,
      canRestore: false,
      canRename: true,
      canTransfer: true,
      canSetDefault: true,
      canClearDefault: false,
    },
    isDefault: false,
    isArchived: false,
    state: {
      page: 1,
      q: '',
      actorId: '',
      kind: '',
      action: '',
      resourceType: '',
      from: '',
      to: '',
      windowMinutes: 180,
    },
    createdAt: '2026-03-19T09:00:00.000Z',
    updatedAt: '2026-03-19T10:00:00.000Z',
    ...overrides,
  }
}

describe('plmAuditTeamViewAudit', () => {
  it('builds explicit audit filters for default actions', () => {
    expect(buildPlmAuditTeamViewLogState(
      createAuditTeamView({ id: 'audit-view-default' }),
      'set-default',
      {
        windowMinutes: 720,
        returnToPlmPath: '/plm?sceneFocus=scene-1',
      },
    )).toEqual({
      page: 1,
      q: 'audit-view-default',
      actorId: '',
      kind: 'audit',
      action: 'set-default',
      resourceType: 'plm-team-view-default',
      from: '',
      to: '',
      windowMinutes: 720,
      teamViewId: '',
      sceneId: '',
      sceneName: '',
      sceneOwnerUserId: '',
      sceneRecommendationReason: '',
      sceneRecommendationSourceLabel: '',
      returnToPlmPath: '/plm?sceneFocus=scene-1',
    })
  })

  it('builds explicit audit filters for lifecycle actions', () => {
    expect(buildPlmAuditTeamViewLogState(
      createAuditTeamView({ id: 'audit-view-archive' }),
      'archive',
      {
        windowMinutes: 60,
        returnToPlmPath: '/plm?sceneFocus=scene-2',
      },
    )).toEqual({
      page: 1,
      q: 'audit-view-archive',
      actorId: '',
      kind: 'audit',
      action: 'archive',
      resourceType: 'plm-team-view-batch',
      from: '',
      to: '',
      windowMinutes: 60,
      teamViewId: '',
      sceneId: '',
      sceneName: '',
      sceneOwnerUserId: '',
      sceneRecommendationReason: '',
      sceneRecommendationSourceLabel: '',
      returnToPlmPath: '/plm?sceneFocus=scene-2',
    })
  })

  it('uses the first processed view to anchor batch audit filters', () => {
    expect(buildPlmAuditTeamViewBatchLogState([
      createAuditTeamView({ id: 'batch-view-a' }),
      createAuditTeamView({ id: 'batch-view-b' }),
    ], 'delete', {
      windowMinutes: 180,
      returnToPlmPath: '/plm?sceneFocus=batch-view-a',
    })).toEqual({
      page: 1,
      q: 'batch-view-a',
      actorId: '',
      kind: 'audit',
      action: 'delete',
      resourceType: 'plm-team-view-batch',
      from: '',
      to: '',
      windowMinutes: 180,
      teamViewId: '',
      sceneId: '',
      sceneName: '',
      sceneOwnerUserId: '',
      sceneRecommendationReason: '',
      sceneRecommendationSourceLabel: '',
      returnToPlmPath: '/plm?sceneFocus=batch-view-a',
    })
  })
})
