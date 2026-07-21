// W4-0 (Wave 4 onboarding design-lock 2026-07-21, RATIFIED) — pure-module spec for
// attendanceSetupReadiness.ts. Zero DOM/zero fetch/zero Vue: this file only proves the seven-step
// discriminator matrix (§3/§4/§7). The wizard shell (AttendanceSetupReadiness.vue) that consumes this
// module is W4-1 scope, not tested here.
//
// Design lock: docs/development/attendance-vnext-wave4-onboarding-design-lock-20260721.md §3/§4/§7.
import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_SETUP_STEP_IDS,
  deriveAttendanceSetupReadinessSteps,
  type AttendanceSetupReadinessInput,
  type AttendanceSetupReadinessResponse,
  type AttendanceSetupReadinessStatus,
  type AttendanceSetupStepId,
} from '../src/views/attendance/attendanceSetupReadiness'

const STATUS_DOMAIN: AttendanceSetupReadinessStatus[] = ['ready', 'missing', 'forbidden', 'unknown', 'db_not_ready']

/** A fully-"everything ready" response — individual fields are overridden per test. */
function readyResponse(overrides: Partial<AttendanceSetupReadinessResponse> = {}): AttendanceSetupReadinessResponse {
  return {
    directoryLinked: true,
    orgActiveMemberCount: 3,
    groupCount: 2,
    groupsWithMembers: 2,
    shiftCount: 2,
    rotationRuleCount: 0,
    hasRotationRules: false,
    approvalFlowCount: 1,
    punchPolicyPosture: 'default',
    notify: {
      workerEnabled: true,
      defaultChannelAvailable: true,
      availableChannelCount: 1,
      orgRecipientBindingReady: true,
    },
    perStep: [
      { step: 'attendance-admin-user-access', scope: 'org', effectiveTime: { source: 'user_orgs.is_active', posture: 'immediate' } },
      { step: 'attendance-admin-groups', scope: 'org', effectiveTime: { source: 'attendance_group_members', posture: 'immediate' } },
      { step: 'attendance-admin-shifts', scope: 'org', effectiveTime: { source: 'attendance_shifts+attendance_rotation_rules', posture: 'immediate' } },
      { step: 'attendance-admin-settings', scope: 'deployment', effectiveTime: { source: 'system_configs.attendance_settings', posture: 'immediate' } },
      { step: 'attendance-admin-approval-flows', scope: 'org', effectiveTime: { source: 'attendance_approval_flows.is_active', posture: 'immediate' } },
      { step: 'attendance-admin-notification-deliveries', scope: 'deployment', effectiveTime: { source: 'none', posture: 'undeterminable' } },
      { step: 'preview', scope: 'org', effectiveTime: { source: 'none', posture: 'manual_activation' } },
    ],
    deploymentScopedSignals: ['punchPolicyPosture', 'notify.workerEnabled', 'notify.defaultChannelAvailable', 'notify.availableChannelCount'],
    ...overrides,
  }
}

function ok(overrides: Partial<AttendanceSetupReadinessResponse> = {}): AttendanceSetupReadinessInput {
  return { kind: 'ok', data: readyResponse(overrides) }
}

function stepResult(steps: ReturnType<typeof deriveAttendanceSetupReadinessSteps>, stepId: AttendanceSetupStepId) {
  const found = steps.find((s) => s.stepId === stepId)
  if (!found) throw new Error(`step ${stepId} missing from derived matrix`)
  return found
}

describe('ATTENDANCE_SETUP_STEP_IDS', () => {
  it('is the seven canonical step ids, in wizard order', () => {
    expect(ATTENDANCE_SETUP_STEP_IDS).toEqual([
      'attendance-admin-user-access',
      'attendance-admin-groups',
      'attendance-admin-shifts',
      'attendance-admin-settings',
      'attendance-admin-approval-flows',
      'attendance-admin-notification-deliveries',
      'preview',
    ])
  })
})

describe('deriveAttendanceSetupReadinessSteps — whole-endpoint 403/503 folding', () => {
  it('forbidden: all seven steps fold to forbidden (§4.3 per-surface 403, not the global adminForbidden flag)', () => {
    const steps = deriveAttendanceSetupReadinessSteps({ kind: 'forbidden' })
    expect(steps).toHaveLength(7)
    expect(steps.map((s) => s.stepId)).toEqual([...ATTENDANCE_SETUP_STEP_IDS])
    for (const s of steps) {
      expect(s.status).toBe('forbidden')
      expect(s.reason).toBe('forbidden')
    }
  })

  it('db_not_ready: all seven steps fold to db_not_ready (503 DB_NOT_READY)', () => {
    const steps = deriveAttendanceSetupReadinessSteps({ kind: 'db_not_ready' })
    expect(steps).toHaveLength(7)
    for (const s of steps) {
      expect(s.status).toBe('db_not_ready')
      expect(s.reason).toBe('db_not_ready')
    }
  })

  it('every derived status is a member of the five-value locked domain — never a sixth value', () => {
    const inputs: AttendanceSetupReadinessInput[] = [
      { kind: 'forbidden' },
      { kind: 'db_not_ready' },
      ok(),
      ok({ orgActiveMemberCount: 0 }),
      ok({ punchPolicyPosture: 'unknown' }),
    ]
    for (const input of inputs) {
      for (const s of deriveAttendanceSetupReadinessSteps(input)) {
        expect(STATUS_DOMAIN).toContain(s.status)
      }
    }
  })
})

describe('① attendance-admin-user-access — orgActiveMemberCount only (round-3 P2-1: OR not AND)', () => {
  it('ready when orgActiveMemberCount > 0, regardless of directoryLinked', () => {
    const steps = deriveAttendanceSetupReadinessSteps(ok({ orgActiveMemberCount: 5, directoryLinked: false }))
    const s = stepResult(steps, 'attendance-admin-user-access')
    expect(s.status).toBe('ready')
    expect(s.reason).toBe('ready')
  })

  it('missing when orgActiveMemberCount === 0, even when directoryLinked is true (directoryLinked is auxiliary-only, never gating)', () => {
    const steps = deriveAttendanceSetupReadinessSteps(ok({ orgActiveMemberCount: 0, directoryLinked: true }))
    const s = stepResult(steps, 'attendance-admin-user-access')
    expect(s.status).toBe('missing')
    expect(s.reason).toBe('org_active_member_count_zero')
  })

  it('carries the registered effectiveTime for this step', () => {
    const steps = deriveAttendanceSetupReadinessSteps(ok())
    const s = stepResult(steps, 'attendance-admin-user-access')
    expect(s.effectiveTime).toEqual({ source: 'user_orgs.is_active', posture: 'immediate' })
  })
})

describe('② attendance-admin-groups — groupCount>0 AND groupsWithMembers>0 (OD-W4-6)', () => {
  it('ready when both counts are positive', () => {
    const s = stepResult(deriveAttendanceSetupReadinessSteps(ok({ groupCount: 3, groupsWithMembers: 1 })), 'attendance-admin-groups')
    expect(s.status).toBe('ready')
    expect(s.reason).toBe('ready')
  })

  it('missing when groups exist but none has members', () => {
    const s = stepResult(deriveAttendanceSetupReadinessSteps(ok({ groupCount: 2, groupsWithMembers: 0 })), 'attendance-admin-groups')
    expect(s.status).toBe('missing')
    expect(s.reason).toBe('group_or_membership_missing')
  })

  it('missing when there are zero groups at all', () => {
    const s = stepResult(deriveAttendanceSetupReadinessSteps(ok({ groupCount: 0, groupsWithMembers: 0 })), 'attendance-admin-groups')
    expect(s.status).toBe('missing')
    expect(s.reason).toBe('group_or_membership_missing')
  })
})

describe('③ attendance-admin-shifts — shiftCount>0; rotation-rule fields are informational only (KNOWN SCOPE GAP, see module header)', () => {
  it('ready when shiftCount > 0, even with hasRotationRules=false', () => {
    const s = stepResult(deriveAttendanceSetupReadinessSteps(ok({ shiftCount: 1, hasRotationRules: false, rotationRuleCount: 0 })), 'attendance-admin-shifts')
    expect(s.status).toBe('ready')
    expect(s.reason).toBe('ready')
  })

  it('missing when shiftCount === 0, even with hasRotationRules=true (rotation fields never gate step③ in W4-0)', () => {
    const s = stepResult(deriveAttendanceSetupReadinessSteps(ok({ shiftCount: 0, hasRotationRules: true, rotationRuleCount: 4 })), 'attendance-admin-shifts')
    expect(s.status).toBe('missing')
    expect(s.reason).toBe('shift_count_zero')
  })
})

describe('④ attendance-admin-settings — punchPolicyPosture (OD-W4-4=(c), round-3 (b) default→ready)', () => {
  it('default posture is ready with reason punch_policy_default (displayed as 「使用平台默认策略」 by the W4-1 tr() layer — this pure module locks the reason KEY, not the Chinese literal)', () => {
    const s = stepResult(deriveAttendanceSetupReadinessSteps(ok({ punchPolicyPosture: 'default' })), 'attendance-admin-settings')
    expect(s.status).toBe('ready')
    expect(s.reason).toBe('punch_policy_default')
  })

  it('customized posture is ready with reason punch_policy_customized (displayed as 「已自定义」 by W4-1)', () => {
    const s = stepResult(deriveAttendanceSetupReadinessSteps(ok({ punchPolicyPosture: 'customized' })), 'attendance-admin-settings')
    expect(s.status).toBe('ready')
    expect(s.reason).toBe('punch_policy_customized')
  })

  it('unknown posture fails closed to unknown — never displayed as complete (§3 未知态红线)', () => {
    const s = stepResult(deriveAttendanceSetupReadinessSteps(ok({ punchPolicyPosture: 'unknown' })), 'attendance-admin-settings')
    expect(s.status).toBe('unknown')
    expect(s.reason).toBe('punch_policy_unknown')
  })
})

describe('⑤ attendance-admin-approval-flows — approvalFlowCount>0', () => {
  it('ready when approvalFlowCount > 0', () => {
    const s = stepResult(deriveAttendanceSetupReadinessSteps(ok({ approvalFlowCount: 2 })), 'attendance-admin-approval-flows')
    expect(s.status).toBe('ready')
    expect(s.reason).toBe('ready')
  })

  it('missing when approvalFlowCount === 0', () => {
    const s = stepResult(deriveAttendanceSetupReadinessSteps(ok({ approvalFlowCount: 0 })), 'attendance-admin-approval-flows')
    expect(s.status).toBe('missing')
    expect(s.reason).toBe('approval_flow_count_zero')
  })
})

describe('⑥ attendance-admin-notification-deliveries — §4.5 port fail-closed to unknown on ANY unknown signal', () => {
  it('ready when all three gating signals are true', () => {
    const s = stepResult(
      deriveAttendanceSetupReadinessSteps(ok({ notify: { workerEnabled: true, defaultChannelAvailable: true, availableChannelCount: 1, orgRecipientBindingReady: true } })),
      'attendance-admin-notification-deliveries',
    )
    expect(s.status).toBe('ready')
    expect(s.reason).toBe('ready')
  })

  it('missing when every signal resolved but at least one is false (not unknown)', () => {
    const s = stepResult(
      deriveAttendanceSetupReadinessSteps(ok({ notify: { workerEnabled: false, defaultChannelAvailable: false, availableChannelCount: 0, orgRecipientBindingReady: false } })),
      'attendance-admin-notification-deliveries',
    )
    expect(s.status).toBe('missing')
    expect(s.reason).toBe('notify_not_ready')
  })

  it('unknown when workerEnabled is unknown (port missing), even though the other two look ready', () => {
    const s = stepResult(
      deriveAttendanceSetupReadinessSteps(ok({ notify: { workerEnabled: 'unknown', defaultChannelAvailable: true, availableChannelCount: 1, orgRecipientBindingReady: true } })),
      'attendance-admin-notification-deliveries',
    )
    expect(s.status).toBe('unknown')
    expect(s.reason).toBe('notify_signal_unknown')
  })

  it('unknown when only orgRecipientBindingReady is unknown (the narrowed DB-probe-failure case, §4.5)', () => {
    const s = stepResult(
      deriveAttendanceSetupReadinessSteps(ok({ notify: { workerEnabled: true, defaultChannelAvailable: true, availableChannelCount: 1, orgRecipientBindingReady: 'unknown' } })),
      'attendance-admin-notification-deliveries',
    )
    expect(s.status).toBe('unknown')
  })
})

describe('⑦ preview — previewReady iff all six prior steps ready; any prior unknown propagates as unknown', () => {
  it('ready ("preview-ready") when all six prior steps are ready', () => {
    const s = stepResult(deriveAttendanceSetupReadinessSteps(ok()), 'preview')
    expect(s.status).toBe('ready')
    expect(s.reason).toBe('preview_ready')
  })

  it('missing ("blocked by prior step") when at least one prior step is missing but none is unknown', () => {
    const s = stepResult(deriveAttendanceSetupReadinessSteps(ok({ shiftCount: 0 })), 'preview')
    expect(s.status).toBe('missing')
    expect(s.reason).toBe('preview_blocked_by_prior_step')
  })

  it('unknown when a prior step is unknown (transitive fail-closed — §3 未知态红线 applies through the preview gate too)', () => {
    const s = stepResult(deriveAttendanceSetupReadinessSteps(ok({ punchPolicyPosture: 'unknown' })), 'preview')
    expect(s.status).toBe('unknown')
  })

  it('never claims ready when both a missing AND an unknown prior step are present (unknown wins over missing)', () => {
    const s = stepResult(
      deriveAttendanceSetupReadinessSteps(ok({ shiftCount: 0, punchPolicyPosture: 'unknown' })),
      'preview',
    )
    expect(s.status).toBe('unknown')
  })

  it('carries the manual_activation effectiveTime posture — preview never implies an app-triggered enable event', () => {
    const s = stepResult(deriveAttendanceSetupReadinessSteps(ok()), 'preview')
    expect(s.effectiveTime).toEqual({ source: 'none', posture: 'manual_activation' })
  })
})

describe('full seven-row matrix on a maximally-mixed input (every status value represented at least once elsewhere in this file)', () => {
  it('produces exactly seven rows, each with a stepId from the locked step-id list and a status from the locked domain', () => {
    const steps = deriveAttendanceSetupReadinessSteps(
      ok({
        orgActiveMemberCount: 4,
        groupCount: 1,
        groupsWithMembers: 0, // ② missing
        shiftCount: 2, // ③ ready
        punchPolicyPosture: 'customized', // ④ ready
        approvalFlowCount: 0, // ⑤ missing
        notify: { workerEnabled: true, defaultChannelAvailable: true, availableChannelCount: 1, orgRecipientBindingReady: 'unknown' }, // ⑥ unknown
      }),
    )
    expect(steps).toHaveLength(7)
    expect(steps.map((s) => s.stepId)).toEqual([...ATTENDANCE_SETUP_STEP_IDS])
    expect(steps.map((s) => s.status)).toEqual([
      'ready', // ①
      'missing', // ②
      'ready', // ③
      'ready', // ④
      'missing', // ⑤
      'unknown', // ⑥
      'unknown', // ⑦ transitive from ⑥
    ])
    for (const s of steps) expect(STATUS_DOMAIN).toContain(s.status)
  })
})
