import { describe, expect, it } from 'vitest'
import {
  resolvePlmAuditTeamViewDuplicateName,
  shouldLockPlmAuditTeamViewManagementTarget,
} from '../src/views/plmAuditTeamViewControlTarget'

describe('plmAuditTeamViewControlTarget', () => {
  it('locks generic management actions when the local selector drifts away from the canonical route owner', () => {
    expect(shouldLockPlmAuditTeamViewManagementTarget({
      routeTeamViewId: 'audit-view-1',
      selectedTeamViewId: 'audit-view-2',
    })).toBe(true)

    expect(shouldLockPlmAuditTeamViewManagementTarget({
      routeTeamViewId: 'audit-view-1',
      selectedTeamViewId: 'audit-view-1',
    })).toBe(false)

    expect(shouldLockPlmAuditTeamViewManagementTarget({
      routeTeamViewId: '',
      selectedTeamViewId: 'audit-view-2',
    })).toBe(false)
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
