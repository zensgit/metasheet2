import { describe, expect, it } from 'vitest'
import { DEFAULT_PLM_AUDIT_ROUTE_STATE, type PlmAuditTeamViewState } from '../src/views/plmAuditQueryState'
import {
  buildPlmAuditPersistedTeamViewRouteState,
  buildPlmAuditSelectedTeamViewRouteState,
  resolvePlmAuditRequestedTeamViewRouteState,
} from '../src/views/plmAuditTeamViewRouteState'

type AuditTeamViewRouteCandidate = {
  id: string
  kind: 'audit'
  isArchived: boolean
  state: PlmAuditTeamViewState
}

function createView(id: string, overrides?: Partial<PlmAuditTeamViewState>): AuditTeamViewRouteCandidate {
  return {
    id,
    kind: 'audit',
    isArchived: false,
    state: {
      page: 2,
      q: 'documents',
      actorId: '',
      kind: 'documents',
      action: 'archive',
      resourceType: 'plm-team-view-batch',
      from: '2026-03-11T15:00:00.000Z',
      to: '2026-03-11T16:00:00.000Z',
      windowMinutes: 720,
      ...overrides,
    },
  }
}

describe('plmAuditTeamViewRouteState', () => {
  it('builds a selected team-view route state, drops local scene metadata, and keeps the return path', () => {
    expect(buildPlmAuditSelectedTeamViewRouteState(
      createView('audit-view-1'),
      {
        returnToPlmPath: '/plm?sceneFocus=scene-1',
      },
    )).toEqual({
      page: 2,
      q: 'documents',
      actorId: '',
      kind: 'documents',
      action: 'archive',
      resourceType: 'plm-team-view-batch',
      from: '2026-03-11T15:00:00.000Z',
      to: '2026-03-11T16:00:00.000Z',
      windowMinutes: 720,
      teamViewId: 'audit-view-1',
      sceneId: '',
      sceneName: '',
      sceneOwnerUserId: '',
      sceneRecommendationReason: '',
      sceneRecommendationSourceLabel: '',
      returnToPlmPath: '/plm?sceneFocus=scene-1',
    })
  })

  it('keeps ordinary team-view saves on the selected team-view route', () => {
    expect(buildPlmAuditPersistedTeamViewRouteState(
      createView('audit-view-keep'),
      {
        windowMinutes: 60,
        returnToPlmPath: '/plm?sceneFocus=scene-keep',
      },
    )).toEqual(buildPlmAuditSelectedTeamViewRouteState(
      createView('audit-view-keep'),
      {
        returnToPlmPath: '/plm?sceneFocus=scene-keep',
      },
    ))
  })

  it('pivots default team-view saves into matching audit-log filters', () => {
    expect(buildPlmAuditPersistedTeamViewRouteState(
      createView('audit-view-default', {
        kind: 'workbench',
        action: '',
        resourceType: '',
        q: 'scene-1',
        windowMinutes: 180,
      }),
      {
        windowMinutes: 720,
        returnToPlmPath: '/plm?sceneFocus=scene-default',
      },
      {
        isDefault: true,
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
      returnToPlmPath: '/plm?sceneFocus=scene-default',
    })
  })

  it('resolves an explicit requested team view into the team-view route state', () => {
    const requestedState = {
      ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
      teamViewId: 'audit-view-2',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
      sceneRecommendationReason: 'recent-update',
      sceneRecommendationSourceLabel: '近期更新的团队场景',
      returnToPlmPath: '/plm?sceneFocus=scene-1',
    }

    expect(resolvePlmAuditRequestedTeamViewRouteState(
      requestedState,
      [createView('audit-view-2')],
      null,
    )).toEqual({
      kind: 'apply-view',
      viewId: 'audit-view-2',
      nextState: buildPlmAuditSelectedTeamViewRouteState(createView('audit-view-2'), requestedState),
    })
  })

  it('clears the requested selection when the team view no longer exists', () => {
    expect(resolvePlmAuditRequestedTeamViewRouteState(
      {
        ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
        teamViewId: 'missing-view',
        q: 'workbench',
      },
      [createView('audit-view-1')],
      null,
    )).toEqual({
      kind: 'clear-selection',
      nextState: {
        ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
        teamViewId: '',
        q: 'workbench',
      },
    })
  })

  it('falls back to the default team view when there are no explicit filters', () => {
    expect(resolvePlmAuditRequestedTeamViewRouteState(
      DEFAULT_PLM_AUDIT_ROUTE_STATE,
      [createView('audit-view-1')],
      createView('audit-default', {
        kind: 'workbench',
        action: 'set-default',
        resourceType: 'plm-team-view-default',
      }),
    )).toEqual({
      kind: 'apply-view',
      viewId: 'audit-default',
      nextState: buildPlmAuditSelectedTeamViewRouteState(createView('audit-default', {
        kind: 'workbench',
        action: 'set-default',
        resourceType: 'plm-team-view-default',
      }), DEFAULT_PLM_AUDIT_ROUTE_STATE),
    })
  })

  it('does not auto-apply the default team view while scene context is still present', () => {
    expect(resolvePlmAuditRequestedTeamViewRouteState(
      {
        ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
        sceneId: 'scene-1',
        sceneName: '采购团队场景',
        sceneOwnerUserId: 'owner-a',
        sceneRecommendationReason: 'recent-update',
        sceneRecommendationSourceLabel: '近期更新的团队场景',
        returnToPlmPath: '/plm?sceneFocus=scene-1',
      },
      [createView('audit-view-1')],
      createView('audit-default', {
        kind: 'workbench',
        action: 'set-default',
        resourceType: 'plm-team-view-default',
      }),
    )).toEqual({
      kind: 'noop',
    })
  })

  it('keeps the current state when explicit filters are already active', () => {
    expect(resolvePlmAuditRequestedTeamViewRouteState(
      {
        ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
        q: 'documents',
      },
      [createView('audit-view-1')],
      createView('audit-default'),
    )).toEqual({
      kind: 'noop',
    })
  })
})
