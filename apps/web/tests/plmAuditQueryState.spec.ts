import { describe, expect, it } from 'vitest'
import { normalizePlmAuditDateTimeTransport } from '../src/views/plmAuditDateTimeTransport'
import {
  buildPlmAuditRouteStateFromTeamView,
  buildPlmAuditTeamViewState,
  buildPlmAuditRouteQuery,
  DEFAULT_PLM_AUDIT_ROUTE_STATE,
  hasPlmAuditSceneContext,
  hasExplicitPlmAuditFilters,
  isPlmAuditRouteStateEqual,
  parsePlmAuditRouteState,
  resetPlmAuditRouteFilters,
} from '../src/views/plmAuditQueryState'

describe('plmAuditQueryState', () => {
  it('parses audit filters, page, and window from route query', () => {
    const expectedFrom = normalizePlmAuditDateTimeTransport('2026-03-11T15:00')
    const expectedTo = normalizePlmAuditDateTimeTransport('2026-03-11T16:00')

    expect(parsePlmAuditRouteState({
      auditPage: '3',
      auditQ: 'documents',
      auditActor: 'dev-user',
      auditKind: 'documents',
      auditAction: 'archive',
      auditType: 'plm-team-view-batch',
      auditFrom: '2026-03-11T15:00',
      auditTo: '2026-03-11T16:00',
      auditWindow: '720',
      auditSceneId: 'scene-1',
      auditSceneName: '采购团队场景',
      auditSceneOwner: 'owner-a',
      auditSceneReason: 'recent-update',
      auditSceneSource: '近期更新的团队场景',
      auditReturnTo: '/plm?scene=recent-update',
    })).toEqual({
      page: 3,
      q: 'documents',
      actorId: 'dev-user',
      kind: 'documents',
      action: 'archive',
      resourceType: 'plm-team-view-batch',
      from: expectedFrom,
      to: expectedTo,
      windowMinutes: 720,
      teamViewId: '',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
      sceneRecommendationReason: 'recent-update',
      sceneRecommendationSourceLabel: '近期更新的团队场景',
      returnToPlmPath: '/plm?scene=recent-update',
    })
  })

  it('normalizes repeated audit datetime query params using the first value', () => {
    const expectedFrom = normalizePlmAuditDateTimeTransport('2026-03-11T15:00')
    const expectedTo = normalizePlmAuditDateTimeTransport('2026-03-11T16:00')

    expect(parsePlmAuditRouteState({
      auditFrom: ['2026-03-11T15:00', '2026-03-11T18:00'],
      auditTo: ['2026-03-11T16:00', '2026-03-11T19:00'],
    })).toMatchObject({
      from: expectedFrom,
      to: expectedTo,
    })
  })

  it('accepts default-scene audit action and resource filters', () => {
    expect(parsePlmAuditRouteState({
      auditAction: 'set-default',
      auditType: 'plm-team-view-default',
      auditKind: 'workbench',
    })).toMatchObject({
      action: 'set-default',
      resourceType: 'plm-team-view-default',
      kind: 'workbench',
    })
  })

  it('accepts team preset default audit resource filters', () => {
    expect(parsePlmAuditRouteState({
      auditAction: 'clear-default',
      auditType: 'plm-team-preset-default',
      auditKind: 'bom',
    })).toMatchObject({
      action: 'clear-default',
      resourceType: 'plm-team-preset-default',
      kind: 'bom',
    })
  })

  it('drops defaults when building a shareable route query', () => {
    const expectedFrom = normalizePlmAuditDateTimeTransport('2026-03-11T15:00')
    const expectedTo = normalizePlmAuditDateTimeTransport('2026-03-11T16:00')

    expect(buildPlmAuditRouteQuery(DEFAULT_PLM_AUDIT_ROUTE_STATE)).toEqual({})

    expect(buildPlmAuditRouteQuery({
      ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
      page: 2,
      q: 'bom',
      action: 'delete',
      from: '2026-03-11T15:00',
      to: '2026-03-11T16:00',
      windowMinutes: 60,
      teamViewId: 'audit-view-1',
      sceneId: 'scene-2',
      sceneName: 'BOM 巡检场景',
      sceneOwnerUserId: 'owner-b',
      sceneRecommendationReason: 'recent-default',
      sceneRecommendationSourceLabel: '近期被设为团队默认场景',
      returnToPlmPath: '/plm?scene=recent-default',
    })).toEqual({
      auditPage: '2',
      auditQ: 'bom',
      auditAction: 'delete',
      auditFrom: expectedFrom,
      auditTo: expectedTo,
      auditWindow: '60',
      auditTeamView: 'audit-view-1',
      auditSceneId: 'scene-2',
      auditSceneName: 'BOM 巡检场景',
      auditSceneOwner: 'owner-b',
      auditSceneReason: 'recent-default',
      auditSceneSource: '近期被设为团队默认场景',
      auditReturnTo: '/plm?scene=recent-default',
    })
  })

  it('builds audit route state from team-view snapshots', () => {
    const expectedFrom = normalizePlmAuditDateTimeTransport('2026-03-11T15:00')
    const expectedTo = normalizePlmAuditDateTimeTransport('2026-03-11T16:00')

    const state = buildPlmAuditRouteStateFromTeamView('audit-view-1', {
      page: 2,
      q: 'archive',
      actorId: 'dev-user',
      kind: 'documents',
      action: 'archive',
      resourceType: 'plm-team-view-batch',
      from: expectedFrom,
      to: expectedTo,
      windowMinutes: 720,
    })

    expect(state).toEqual({
      page: 2,
      q: 'archive',
      actorId: 'dev-user',
      kind: 'documents',
      action: 'archive',
      resourceType: 'plm-team-view-batch',
      from: expectedFrom,
      to: expectedTo,
      windowMinutes: 720,
      teamViewId: 'audit-view-1',
      sceneId: '',
      sceneName: '',
      sceneOwnerUserId: '',
      sceneRecommendationReason: '',
      sceneRecommendationSourceLabel: '',
      returnToPlmPath: '',
    })
    expect(buildPlmAuditTeamViewState(state)).toEqual({
      page: 2,
      q: 'archive',
      actorId: 'dev-user',
      kind: 'documents',
      action: 'archive',
      resourceType: 'plm-team-view-batch',
      from: expectedFrom,
      to: expectedTo,
      windowMinutes: 720,
    })
  })

  it('detects explicit audit filters without treating team-view identity as a filter', () => {
    expect(hasExplicitPlmAuditFilters(DEFAULT_PLM_AUDIT_ROUTE_STATE)).toBe(false)
    expect(hasExplicitPlmAuditFilters({
      ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
      teamViewId: 'audit-view-1',
    })).toBe(false)
    expect(hasExplicitPlmAuditFilters({
      ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
    })).toBe(false)
    expect(hasExplicitPlmAuditFilters({
      ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
      q: 'documents',
    })).toBe(true)
  })

  it('tracks scene recovery metadata separately from explicit audit filters', () => {
    expect(hasPlmAuditSceneContext(DEFAULT_PLM_AUDIT_ROUTE_STATE)).toBe(false)
    expect(hasPlmAuditSceneContext({
      ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
      sceneRecommendationReason: 'recent-update',
      sceneRecommendationSourceLabel: '近期更新的团队场景',
    })).toBe(true)
    expect(hasPlmAuditSceneContext({
      ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
      returnToPlmPath: '/plm?sceneFocus=scene-1',
    })).toBe(true)
  })

  it('resets explicit audit filters while preserving team-view and scene recovery context', () => {
    expect(resetPlmAuditRouteFilters({
      ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
      page: 3,
      q: 'documents',
      actorId: 'dev-user',
      kind: 'documents',
      action: 'archive',
      resourceType: 'plm-team-view-batch',
      from: '2026-03-11T15:00',
      to: '2026-03-11T16:00',
      windowMinutes: 720,
      teamViewId: 'audit-view-1',
      sceneId: 'scene-2',
      sceneName: 'BOM 巡检场景',
      sceneOwnerUserId: 'owner-b',
      sceneRecommendationReason: 'recent-default',
      sceneRecommendationSourceLabel: '近期被设为团队默认场景',
      returnToPlmPath: '/plm?sceneFocus=scene-2',
    })).toEqual({
      ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
      teamViewId: 'audit-view-1',
      sceneId: 'scene-2',
      sceneName: 'BOM 巡检场景',
      sceneOwnerUserId: 'owner-b',
      sceneRecommendationReason: 'recent-default',
      sceneRecommendationSourceLabel: '近期被设为团队默认场景',
      returnToPlmPath: '/plm?sceneFocus=scene-2',
    })
  })

  it('compares route state for browser history replay', () => {
    expect(isPlmAuditRouteStateEqual(
      DEFAULT_PLM_AUDIT_ROUTE_STATE,
      { ...DEFAULT_PLM_AUDIT_ROUTE_STATE },
    )).toBe(true)

    expect(isPlmAuditRouteStateEqual(
      DEFAULT_PLM_AUDIT_ROUTE_STATE,
      { ...DEFAULT_PLM_AUDIT_ROUTE_STATE, resourceType: 'plm-team-view-batch' },
    )).toBe(false)
  })
})
