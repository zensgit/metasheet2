import { describe, expect, it } from 'vitest'
import {
  resolvePlmApprovalHistoryActorLabel,
  resolvePlmApprovalHistoryVersionLabel,
} from '../src/views/plm/plmApprovalHistoryDisplay'

describe('plmApprovalHistoryDisplay', () => {
  it('prefers hydrated actor names over legacy id fields', () => {
    expect(resolvePlmApprovalHistoryActorLabel({
      actor_name: 'Reviewer One',
      actor_id: 'user-1',
      user_id: 'legacy-user',
    })).toBe('Reviewer One')
  })

  it('falls back through hydrated and legacy actor identifiers', () => {
    expect(resolvePlmApprovalHistoryActorLabel({
      actor_name: '   ',
      approver_name: 'Reviewer Two',
      actor_id: 'user-2',
    })).toBe('Reviewer Two')

    expect(resolvePlmApprovalHistoryActorLabel({
      actor_id: 'user-3',
    })).toBe('user-3')

    expect(resolvePlmApprovalHistoryActorLabel({
      user_id: 'legacy-user-4',
    })).toBe('legacy-user-4')
  })

  it('builds approval history version labels from migrated version fields', () => {
    expect(resolvePlmApprovalHistoryVersionLabel({
      from_version: 1,
      to_version: 2,
    })).toBe('1 -> 2')

    expect(resolvePlmApprovalHistoryVersionLabel({
      fromVersion: '2',
      toVersion: '2',
    })).toBe('2')

    expect(resolvePlmApprovalHistoryVersionLabel({
      version: 4,
    })).toBe('4')

    expect(resolvePlmApprovalHistoryVersionLabel({})).toBe('-')
  })
})
