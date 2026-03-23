import { describe, expect, it } from 'vitest'
import {
  resolvePlmAuditCanonicalTeamViewManagementTargetId,
  resolvePlmAuditCanonicalTeamViewRouteState,
  resolvePlmAuditTeamViewDuplicateName,
  shouldLockPlmAuditTeamViewManagementTarget,
} from '../src/views/plmAuditTeamViewControlTarget'
import { DEFAULT_PLM_AUDIT_ROUTE_STATE } from '../src/views/plmAuditQueryState'

describe('plmAuditTeamViewControlTarget', () => {
  it('resolves generic management actions against the canonical owner before the local selector', () => {
    expect(resolvePlmAuditCanonicalTeamViewManagementTargetId({
      routeTeamViewId: 'audit-view-1',
      followupTeamViewId: 'audit-view-2',
    })).toBe('audit-view-1')

    expect(resolvePlmAuditCanonicalTeamViewManagementTargetId({
      routeTeamViewId: '',
      followupTeamViewId: 'audit-view-2',
    })).toBe('audit-view-2')
  })

  it('locks generic management actions when the local selector drifts away from the canonical route owner', () => {
    expect(shouldLockPlmAuditTeamViewManagementTarget({
      canonicalTeamViewId: 'audit-view-1',
      selectedTeamViewId: 'audit-view-2',
    })).toBe(true)

    expect(shouldLockPlmAuditTeamViewManagementTarget({
      canonicalTeamViewId: 'audit-view-1',
      selectedTeamViewId: 'audit-view-1',
    })).toBe(false)

    expect(shouldLockPlmAuditTeamViewManagementTarget({
      canonicalTeamViewId: '',
      selectedTeamViewId: 'audit-view-2',
    })).toBe(false)
  })

  it('keeps filter navigation on the canonical team-view route owner instead of the local selector', () => {
    expect(resolvePlmAuditCanonicalTeamViewRouteState({
      currentState: {
        ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
        q: 'documents',
        teamViewId: 'audit-view-2',
      },
      routeTeamViewId: 'audit-view-1',
    })).toEqual({
      ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
      q: 'documents',
      teamViewId: 'audit-view-1',
    })

    expect(resolvePlmAuditCanonicalTeamViewRouteState({
      currentState: {
        ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
        q: 'documents',
        teamViewId: 'audit-view-2',
      },
      routeTeamViewId: '',
    })).toEqual({
      ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
      q: 'documents',
      teamViewId: '',
    })
  })

  it('ignores local draft names for canonical shared-entry duplicate actions', () => {
    expect(resolvePlmAuditTeamViewDuplicateName({
      draftName: 'Shared entry duplicate',
      allowDraftName: false,
    })).toBeUndefined()

    expect(resolvePlmAuditTeamViewDuplicateName({
      draftName: 'Shared entry duplicate',
      allowDraftName: true,
    })).toBe('Shared entry duplicate')

    expect(resolvePlmAuditTeamViewDuplicateName({
      draftName: '   ',
      allowDraftName: true,
    })).toBeUndefined()
  })
})
