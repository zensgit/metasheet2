import { describe, expect, it } from 'vitest'
import {
  resolvePlmAuditTeamViewApplyTarget,
  resolvePlmAuditCanonicalTeamViewManagementTarget,
  resolvePlmAuditCanonicalTeamViewManagementTargetId,
  resolvePlmAuditCanonicalTeamViewRouteState,
  resolvePlmAuditTakeoverTeamViewSelectorId,
  resolvePlmAuditTeamViewDuplicateName,
  shouldEnablePlmAuditTeamViewRenameAction,
  shouldDisablePlmAuditTeamViewTransferOwnerInput,
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

  it('can recover the canonical management entry from a follow-up owner even when the selector is cleared', () => {
    expect(resolvePlmAuditCanonicalTeamViewManagementTarget([
      { id: 'audit-view-1', name: 'A' },
      { id: 'audit-view-2', name: 'B' },
    ], {
      routeTeamViewId: '',
      followupTeamViewId: 'audit-view-2',
    })).toEqual({
      id: 'audit-view-2',
      name: 'B',
    })

    expect(resolvePlmAuditCanonicalTeamViewManagementTarget([
      { id: 'audit-view-1', name: 'A' },
    ], {
      routeTeamViewId: '',
      followupTeamViewId: 'audit-view-2',
    })).toBeNull()
  })

  it('resolves apply actions against the local selector before the canonical owner', () => {
    expect(resolvePlmAuditTeamViewApplyTarget([
      { id: 'audit-view-1', name: 'A' },
      { id: 'audit-view-2', name: 'B' },
    ], {
      selectedTeamViewId: 'audit-view-2',
      routeTeamViewId: 'audit-view-1',
      followupTeamViewId: '',
    })).toEqual({
      id: 'audit-view-2',
      name: 'B',
    })

    expect(resolvePlmAuditTeamViewApplyTarget([
      { id: 'audit-view-1', name: 'A' },
      { id: 'audit-view-2', name: 'B' },
    ], {
      selectedTeamViewId: '',
      routeTeamViewId: 'audit-view-1',
      followupTeamViewId: '',
    })).toEqual({
      id: 'audit-view-1',
      name: 'A',
    })

    expect(resolvePlmAuditTeamViewApplyTarget([
      { id: 'audit-view-1', name: 'A' },
    ], {
      selectedTeamViewId: 'audit-view-2',
      routeTeamViewId: 'audit-view-1',
      followupTeamViewId: '',
    })).toEqual({
      id: 'audit-view-1',
      name: 'A',
    })
  })

  it('aligns non-apply takeovers to the target route owner instead of keeping a stale local selector', () => {
    expect(resolvePlmAuditTakeoverTeamViewSelectorId({
      targetTeamViewId: 'audit-view-1',
    })).toBe('audit-view-1')

    expect(resolvePlmAuditTakeoverTeamViewSelectorId({
      targetTeamViewId: '',
    })).toBe('')
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

  it('disables transfer-owner drafts whenever the canonical target is not actionable', () => {
    expect(shouldDisablePlmAuditTeamViewTransferOwnerInput({
      managementTargetLocked: true,
      canTransferTarget: true,
      loading: false,
    })).toBe(true)

    expect(shouldDisablePlmAuditTeamViewTransferOwnerInput({
      managementTargetLocked: false,
      canTransferTarget: false,
      loading: false,
    })).toBe(true)

    expect(shouldDisablePlmAuditTeamViewTransferOwnerInput({
      managementTargetLocked: false,
      canTransferTarget: true,
      loading: true,
    })).toBe(true)

    expect(shouldDisablePlmAuditTeamViewTransferOwnerInput({
      managementTargetLocked: false,
      canTransferTarget: true,
      loading: false,
    })).toBe(false)
  })

  it('only allows rename submission when the name draft still belongs to the current canonical owner', () => {
    expect(shouldEnablePlmAuditTeamViewRenameAction({
      canRename: true,
      canonicalTeamViewId: 'audit-view-1',
      draftOwnerTeamViewId: 'audit-view-1',
    })).toBe(true)

    expect(shouldEnablePlmAuditTeamViewRenameAction({
      canRename: true,
      canonicalTeamViewId: 'audit-view-2',
      draftOwnerTeamViewId: 'audit-view-1',
    })).toBe(false)

    expect(shouldEnablePlmAuditTeamViewRenameAction({
      canRename: true,
      canonicalTeamViewId: 'audit-view-2',
      draftOwnerTeamViewId: '',
    })).toBe(false)

    expect(shouldEnablePlmAuditTeamViewRenameAction({
      canRename: false,
      canonicalTeamViewId: 'audit-view-2',
      draftOwnerTeamViewId: 'audit-view-2',
    })).toBe(false)
  })
})
