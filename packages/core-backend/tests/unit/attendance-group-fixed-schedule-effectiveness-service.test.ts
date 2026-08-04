import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  deriveAttendanceGroupFixedScheduleEffectiveness,
} = require('../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs') as {
  deriveAttendanceGroupFixedScheduleEffectiveness: (input: Record<string, unknown>) => Record<string, unknown>
}

const desired = { shiftId: 'shift-current', startDate: '2026-08-01', endDate: '2026-08-31', revision: 2 }
const producerKey = 'attendance_group_fixed_schedule:group-1:shift-current:2026-08-01:2026-08-31'
const oldProducerKey = 'attendance_group_fixed_schedule:group-1:shift-old:2026-07-01:2026-07-31'

function assignment(overrides: Record<string, unknown> = {}) {
  return {
    user_id: 'member-a',
    shift_id: desired.shiftId,
    start_date: desired.startDate,
    end_date: desired.endDate,
    publish_status: 'published',
    producer_key: producerKey,
    ...overrides,
  }
}

function derive(overrides: Record<string, unknown> = {}) {
  return deriveAttendanceGroupFixedScheduleEffectiveness({
    desired,
    targetMemberIds: ['member-a'],
    managedRows: [],
    producerKey,
    evaluatedAt: '2026-08-04T00:00:00.000Z',
    ...overrides,
  })
}

describe('attendance group fixed-schedule effectiveness derivation', () => {
  // Mutation proofs: removing configuration-changed precedence, treating duplicate
  // matching rows as effective, or changing the reason-order filter each reds a case.
  it.each([
    ['no config', { desired: null }, 'not_configured', ['NO_DESIRED_CONFIG']],
    ['no config with historical rows', { desired: null, managedRows: [assignment({ producer_key: oldProducerKey })] }, 'not_configured', ['NO_DESIRED_CONFIG']],
    ['new desired config', {}, 'pending_apply', ['TARGET_MEMBER_MISSING']],
    ['configured group without members', { targetMemberIds: [] }, 'pending_apply', ['NO_TARGET_MEMBERS']],
    ['complete exact coverage', { managedRows: [assignment()] }, 'effective', ['EFFECTIVE']],
    ['different managed key', { managedRows: [assignment({ producer_key: oldProducerKey })] }, 'configuration_changed', ['DIFFERENT_MANAGED_KEY_ACTIVE', 'TARGET_MEMBER_MISSING']],
    ['different key takes precedence over duplicate and missing coverage', { managedRows: [assignment({ producer_key: oldProducerKey }), assignment(), assignment()] }, 'configuration_changed', ['DIFFERENT_MANAGED_KEY_ACTIVE', 'DUPLICATE_MATCHING_ASSIGNMENT']],
    ['missing target member', { targetMemberIds: ['member-a', 'member-b'], managedRows: [assignment()] }, 'pending_apply', ['TARGET_MEMBER_MISSING']],
    ['non-member target', { managedRows: [assignment(), assignment({ user_id: 'former-member' })] }, 'pending_apply', ['NON_MEMBER_TARGET_ACTIVE']],
    ['duplicate matching assignment', { managedRows: [assignment(), assignment()] }, 'pending_apply', ['DUPLICATE_MATCHING_ASSIGNMENT']],
    ['matching key with mismatched values', { managedRows: [assignment({ shift_id: 'shift-corrupt' })] }, 'pending_apply', ['TARGET_MEMBER_MISSING', 'ASSIGNMENT_VALUE_MISMATCH']],
    ['unpublished desired row', { managedRows: [assignment({ publish_status: 'pending' })] }, 'pending_apply', ['TARGET_MEMBER_MISSING', 'UNPUBLISHED_MANAGED_ROW']],
    ['unpublished historical row without config', { desired: null, managedRows: [assignment({ producer_key: oldProducerKey, publish_status: 'reopened' })] }, 'not_configured', ['NO_DESIRED_CONFIG']],
    ['unpublished row does not override eligible old key precedence', { managedRows: [assignment({ producer_key: oldProducerKey }), assignment({ publish_status: 'pending' })] }, 'configuration_changed', ['DIFFERENT_MANAGED_KEY_ACTIVE', 'TARGET_MEMBER_MISSING', 'UNPUBLISHED_MANAGED_ROW']],
    ['inactive historical row is absent from the evaluator input', { managedRows: [assignment()] }, 'effective', ['EFFECTIVE']],
    ['reason ordering is stable', { targetMemberIds: [], managedRows: [assignment({ producer_key: oldProducerKey, publish_status: 'pending' })] }, 'pending_apply', ['NO_TARGET_MEMBERS', 'UNPUBLISHED_MANAGED_ROW']],
  ])('%s', (_name, input, state, reasonCodes) => {
    const result = derive(input as Record<string, unknown>)
    expect(result.state).toBe(state)
    expect(result.reasonCodes).toEqual(reasonCodes)
  })

  it('never includes member identifiers in its projection', () => {
    const result = JSON.stringify(derive({ managedRows: [assignment()] }))
    expect(result).not.toContain('member-a')
  })
})
