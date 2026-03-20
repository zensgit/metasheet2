import { describe, expect, it } from 'vitest'
import {
  buildPlmAuditRouteStateFromTeamView,
  buildPlmAuditTeamViewState,
  buildPlmAuditRouteQuery,
  DEFAULT_PLM_AUDIT_ROUTE_STATE,
  hasExplicitPlmAuditFilters,
  isPlmAuditRouteStateEqual,
  parsePlmAuditRouteState,
} from '../src/views/plmAuditQueryState'

describe('plmAuditQueryState', () => {
  it('parses audit filters, page, and window from route query', () => {
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
    })).toEqual({
      page: 3,
      q: 'documents',
      actorId: 'dev-user',
      kind: 'documents',
      action: 'archive',
      resourceType: 'plm-team-view-batch',
      from: '2026-03-11T15:00',
      to: '2026-03-11T16:00',
      windowMinutes: 720,
      teamViewId: '',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
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

  it('drops defaults when building a shareable route query', () => {
    expect(buildPlmAuditRouteQuery(DEFAULT_PLM_AUDIT_ROUTE_STATE)).toEqual({})

    expect(buildPlmAuditRouteQuery({
      ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
      page: 2,
      q: 'bom',
      action: 'delete',
      windowMinutes: 60,
      teamViewId: 'audit-view-1',
      sceneId: 'scene-2',
      sceneName: 'BOM 巡检场景',
      sceneOwnerUserId: 'owner-b',
    })).toEqual({
      auditPage: '2',
      auditQ: 'bom',
      auditAction: 'delete',
      auditWindow: '60',
      auditTeamView: 'audit-view-1',
      auditSceneId: 'scene-2',
      auditSceneName: 'BOM 巡检场景',
      auditSceneOwner: 'owner-b',
    })
  })

  it('builds audit route state from team-view snapshots', () => {
    const state = buildPlmAuditRouteStateFromTeamView('audit-view-1', {
      page: 2,
      q: 'archive',
      actorId: 'dev-user',
      kind: 'documents',
      action: 'archive',
      resourceType: 'plm-team-view-batch',
      from: '2026-03-11T15:00',
      to: '2026-03-11T16:00',
      windowMinutes: 720,
    })

    expect(state).toEqual({
      page: 2,
      q: 'archive',
      actorId: 'dev-user',
      kind: 'documents',
      action: 'archive',
      resourceType: 'plm-team-view-batch',
      from: '2026-03-11T15:00',
      to: '2026-03-11T16:00',
      windowMinutes: 720,
      teamViewId: 'audit-view-1',
      sceneId: '',
      sceneName: '',
      sceneOwnerUserId: '',
    })
    expect(buildPlmAuditTeamViewState(state)).toEqual({
      page: 2,
      q: 'archive',
      actorId: 'dev-user',
      kind: 'documents',
      action: 'archive',
      resourceType: 'plm-team-view-batch',
      from: '2026-03-11T15:00',
      to: '2026-03-11T16:00',
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
