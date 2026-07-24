// W4-0 (Wave 4 onboarding design-lock 2026-07-21, RATIFIED §3/§7/§9): full seven-step discriminator
// matrix for `apps/web/src/views/attendance/attendanceSetupReadiness.ts` — zero DOM, zero fetch.
// Wired into .github/workflows/attendance-web-guard.yml (run-list + relevant-change classifier).
//
// Coverage goal ("判别矩阵全值域×七步"): every value the seven-value status domain can reach at
// each step, given today's implementation — this is not literally 7×7=49 combinations (most are
// structurally impossible per step, e.g. step① can never be 'unsupported'), it is every REACHABLE
// (step, status) pair:
//   forbidden/db_not_ready — whole-endpoint folds, all seven steps
//   ①②③⑤⑦ — ready / missing
//   ④ — ready / manual_review_required / unknown
//   ⑥ — unsupported (constant; the other two notify signals ride unreduced on notifySignals)
// That covers all seven domain values across the matrix.
import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_SETUP_READINESS_STATUS_VALUES,
  ATTENDANCE_SETUP_STEP_IDS,
  ATTENDANCE_SETUP_STEP_SCOPE,
  deriveAttendanceSetupReadinessPreviewReady,
  deriveAttendanceSetupReadinessSteps,
  deriveAttendanceSetupReadinessStep3Ready,
  type AttendanceSetupReadinessResponse,
} from '../src/views/attendance/attendanceSetupReadiness'

const EFFECTIVE_TIME = {
  source: 'test',
  posture: 'immediate' as const,
}

// §4.2-locked nested shape: perStep.effectiveTime: {source, posture, effectiveAt?} — each entry
// wraps under an `effectiveTime` key (not the effective-time record itself).
const PER_STEP = Object.fromEntries(
  ATTENDANCE_SETUP_STEP_IDS.map((id) => [id, { effectiveTime: EFFECTIVE_TIME }]),
) as Record<(typeof ATTENDANCE_SETUP_STEP_IDS)[number], { effectiveTime: typeof EFFECTIVE_TIME }>

function baseResponse(overrides: Partial<AttendanceSetupReadinessResponse> = {}): AttendanceSetupReadinessResponse {
  return {
    directoryLinked: false,
    orgActiveMemberCount: 1,
    groupCount: 1,
    groupsWithMembers: 1,
    shiftCount: 1,
    scheduledShiftGroupCount: 0,
    activeRotationRuleCount: 0,
    hasRotationRules: false,
    approvalFlowCount: 1,
    punchPolicyPosture: 'customized',
    notify: {
      deliveryRuntime: 'not_ready',
      orgRecipientBinding: { boundRecipientCount: 0, hasAnyBoundRecipient: false },
      recipientScopeConfig: 'unsupported',
    },
    previewReady: true,
    perStep: PER_STEP,
    ...overrides,
  }
}

function stepById(rows: ReturnType<typeof deriveAttendanceSetupReadinessSteps>, stepId: string) {
  const row = rows.find((r) => r.stepId === stepId)
  if (!row) throw new Error(`missing step ${stepId}`)
  return row
}

describe('value domain exhaustiveness', () => {
  it('is exactly the seven locked values', () => {
    expect(ATTENDANCE_SETUP_READINESS_STATUS_VALUES).toEqual([
      'ready',
      'missing',
      'forbidden',
      'unknown',
      'manual_review_required',
      'unsupported',
      'db_not_ready',
    ])
  })
})

describe('whole-endpoint folds', () => {
  it('forbidden folds all seven steps to forbidden', () => {
    const rows = deriveAttendanceSetupReadinessSteps({ kind: 'forbidden' })
    expect(rows).toHaveLength(7)
    expect(rows.map((r) => r.stepId)).toEqual([...ATTENDANCE_SETUP_STEP_IDS])
    for (const row of rows) {
      expect(row.status).toBe('forbidden')
      expect(row.reason).toBe('forbidden')
      expect(row.effectiveTime).toBeUndefined()
    }
  })

  it('db_not_ready folds all seven steps to db_not_ready', () => {
    const rows = deriveAttendanceSetupReadinessSteps({ kind: 'db_not_ready' })
    expect(rows).toHaveLength(7)
    for (const row of rows) {
      expect(row.status).toBe('db_not_ready')
      expect(row.reason).toBe('db_not_ready')
    }
  })
})

describe('step① attendance-admin-user-access — orgActiveMemberCount (OR semantics)', () => {
  it('ready when orgActiveMemberCount>0, regardless of directoryLinked', () => {
    const rows = deriveAttendanceSetupReadinessSteps({
      kind: 'ok',
      data: baseResponse({ orgActiveMemberCount: 5, directoryLinked: false }),
    })
    expect(stepById(rows, 'attendance-admin-user-access').status).toBe('ready')
  })

  it('ready via a directory-linked org too (directoryLinked is auxiliary, never the gate)', () => {
    const rows = deriveAttendanceSetupReadinessSteps({
      kind: 'ok',
      data: baseResponse({ orgActiveMemberCount: 5, directoryLinked: true }),
    })
    expect(stepById(rows, 'attendance-admin-user-access').status).toBe('ready')
  })

  it('missing when orgActiveMemberCount=0 even though directoryLinked=true (negative: not an AND gate)', () => {
    const rows = deriveAttendanceSetupReadinessSteps({
      kind: 'ok',
      data: baseResponse({ orgActiveMemberCount: 0, directoryLinked: true }),
    })
    const row = stepById(rows, 'attendance-admin-user-access')
    expect(row.status).toBe('missing')
    expect(row.reason).toBe('org_active_member_count_zero')
  })
})

describe('step② attendance-admin-groups — groupCount AND groupsWithMembers', () => {
  it('ready when both > 0', () => {
    const rows = deriveAttendanceSetupReadinessSteps({
      kind: 'ok',
      data: baseResponse({ groupCount: 3, groupsWithMembers: 1 }),
    })
    expect(stepById(rows, 'attendance-admin-groups').status).toBe('ready')
  })

  it('missing when groups exist but none have members', () => {
    const rows = deriveAttendanceSetupReadinessSteps({
      kind: 'ok',
      data: baseResponse({ groupCount: 3, groupsWithMembers: 0 }),
    })
    const row = stepById(rows, 'attendance-admin-groups')
    expect(row.status).toBe('missing')
    expect(row.reason).toBe('group_or_membership_missing')
  })

  it('missing when there are no groups at all', () => {
    const rows = deriveAttendanceSetupReadinessSteps({
      kind: 'ok',
      data: baseResponse({ groupCount: 0, groupsWithMembers: 0 }),
    })
    expect(stepById(rows, 'attendance-admin-groups').status).toBe('missing')
  })
})

describe('step③ attendance-admin-shifts — §3③ errata formula', () => {
  it('missing when shiftCount=0', () => {
    const rows = deriveAttendanceSetupReadinessSteps({
      kind: 'ok',
      data: baseResponse({ shiftCount: 0, scheduledShiftGroupCount: 0, activeRotationRuleCount: 0 }),
    })
    const row = stepById(rows, 'attendance-admin-shifts')
    expect(row.status).toBe('missing')
    expect(row.reason).toBe('shift_count_zero')
  })

  it('ready when shiftCount>0 and no scheduled-shift group exists (org-level existence test)', () => {
    const rows = deriveAttendanceSetupReadinessSteps({
      kind: 'ok',
      data: baseResponse({ shiftCount: 2, scheduledShiftGroupCount: 0, activeRotationRuleCount: 0 }),
    })
    expect(stepById(rows, 'attendance-admin-shifts').status).toBe('ready')
  })

  it('missing when a scheduled-shift group exists but no active rotation rule does', () => {
    const rows = deriveAttendanceSetupReadinessSteps({
      kind: 'ok',
      data: baseResponse({ shiftCount: 2, scheduledShiftGroupCount: 1, activeRotationRuleCount: 0 }),
    })
    const row = stepById(rows, 'attendance-admin-shifts')
    expect(row.status).toBe('missing')
    expect(row.reason).toBe('scheduled_shift_group_without_rotation_rules')
  })

  it('ready when a scheduled-shift group exists AND an active rotation rule does', () => {
    const rows = deriveAttendanceSetupReadinessSteps({
      kind: 'ok',
      data: baseResponse({ shiftCount: 2, scheduledShiftGroupCount: 1, activeRotationRuleCount: 1 }),
    })
    expect(stepById(rows, 'attendance-admin-shifts').status).toBe('ready')
  })

  it('deriveAttendanceSetupReadinessStep3Ready matches the step③ status exactly (single source of truth)', () => {
    for (const [shiftCount, scheduledShiftGroupCount, activeRotationRuleCount] of [
      [0, 0, 0],
      [2, 0, 0],
      [2, 1, 0],
      [2, 1, 1],
    ] as const) {
      const formula = deriveAttendanceSetupReadinessStep3Ready(shiftCount, scheduledShiftGroupCount, activeRotationRuleCount)
      const rows = deriveAttendanceSetupReadinessSteps({
        kind: 'ok',
        data: baseResponse({ shiftCount, scheduledShiftGroupCount, activeRotationRuleCount }),
      })
      expect(stepById(rows, 'attendance-admin-shifts').status).toBe(formula ? 'ready' : 'missing')
    }
  })
})

describe('step④ attendance-admin-settings — punchPolicyPosture mapping (errata, NEVER default→ready)', () => {
  it('customized -> ready', () => {
    const rows = deriveAttendanceSetupReadinessSteps({
      kind: 'ok',
      data: baseResponse({ punchPolicyPosture: 'customized' }),
    })
    const row = stepById(rows, 'attendance-admin-settings')
    expect(row.status).toBe('ready')
    expect(row.reason).toBe('punch_policy_customized')
  })

  it('default -> manual_review_required (errata; the frozen predecessor mapped this to ready — must not regress)', () => {
    const rows = deriveAttendanceSetupReadinessSteps({
      kind: 'ok',
      data: baseResponse({ punchPolicyPosture: 'default' }),
    })
    const row = stepById(rows, 'attendance-admin-settings')
    expect(row.status).toBe('manual_review_required')
    expect(row.reason).toBe('punch_policy_default')
  })

  it('unknown -> unknown (fail-closed)', () => {
    const rows = deriveAttendanceSetupReadinessSteps({
      kind: 'ok',
      data: baseResponse({ punchPolicyPosture: 'unknown' }),
    })
    const row = stepById(rows, 'attendance-admin-settings')
    expect(row.status).toBe('unknown')
    expect(row.reason).toBe('punch_policy_unknown')
  })
})

describe('step⑤ attendance-admin-approval-flows — approvalFlowCount', () => {
  it('ready when approvalFlowCount>0', () => {
    const rows = deriveAttendanceSetupReadinessSteps({ kind: 'ok', data: baseResponse({ approvalFlowCount: 2 }) })
    expect(stepById(rows, 'attendance-admin-approval-flows').status).toBe('ready')
  })
  it('missing when approvalFlowCount=0', () => {
    const rows = deriveAttendanceSetupReadinessSteps({ kind: 'ok', data: baseResponse({ approvalFlowCount: 0 }) })
    const row = stepById(rows, 'attendance-admin-approval-flows')
    expect(row.status).toBe('missing')
    expect(row.reason).toBe('approval_flow_count_zero')
  })
})

describe('step⑥ attendance-admin-notification-deliveries — three signals, never merged (§3⑥ P2-2)', () => {
  it('status is always unsupported (recipientScopeConfig, the step-naming capability) regardless of the other two signals', () => {
    for (const deliveryRuntime of ['ready', 'not_ready', 'unknown'] as const) {
      for (const hasAnyBoundRecipient of [true, false]) {
        const rows = deriveAttendanceSetupReadinessSteps({
          kind: 'ok',
          data: baseResponse({
            notify: {
              deliveryRuntime,
              orgRecipientBinding: { boundRecipientCount: hasAnyBoundRecipient ? 3 : 0, hasAnyBoundRecipient },
              recipientScopeConfig: 'unsupported',
            },
          }),
        })
        const row = stepById(rows, 'attendance-admin-notification-deliveries')
        expect(row.status).toBe('unsupported')
        expect(row.reason).toBe('recipient_scope_unsupported')
      }
    }
  })

  it('carries the other two signals unreduced on notifySignals — never folded into status', () => {
    const rows = deriveAttendanceSetupReadinessSteps({
      kind: 'ok',
      data: baseResponse({
        notify: {
          deliveryRuntime: 'unknown',
          orgRecipientBinding: { boundRecipientCount: 4, hasAnyBoundRecipient: true },
          recipientScopeConfig: 'unsupported',
        },
      }),
    })
    const row = stepById(rows, 'attendance-admin-notification-deliveries')
    expect(row.notifySignals).toEqual({
      deliveryRuntime: 'unknown',
      orgRecipientBinding: { boundRecipientCount: 4, hasAnyBoundRecipient: true },
    })
  })

  it('no other step carries notifySignals', () => {
    const rows = deriveAttendanceSetupReadinessSteps({ kind: 'ok', data: baseResponse() })
    for (const row of rows) {
      if (row.stepId !== 'attendance-admin-notification-deliveries') {
        expect(row.notifySignals).toBeUndefined()
      }
    }
  })
})

describe('step⑦ preview — previewReady = ①②③⑤ only; ④/⑥ never gate (§3.2 / §9 W4-0-G4)', () => {
  const readyBase = baseResponse()

  it('ready when ①②③⑤ all ready, regardless of ④=default/unknown', () => {
    for (const punchPolicyPosture of ['default', 'customized', 'unknown'] as const) {
      const rows = deriveAttendanceSetupReadinessSteps({
        kind: 'ok',
        data: baseResponse({ punchPolicyPosture }),
      })
      const row = stepById(rows, 'preview')
      expect(row.status).toBe('ready')
      expect(row.reason).toBe('preview_ready')
    }
  })

  it('ready regardless of every ⑥ notify combination', () => {
    for (const deliveryRuntime of ['ready', 'not_ready', 'unknown'] as const) {
      const rows = deriveAttendanceSetupReadinessSteps({
        kind: 'ok',
        data: baseResponse({
          notify: {
            deliveryRuntime,
            orgRecipientBinding: { boundRecipientCount: 0, hasAnyBoundRecipient: false },
            recipientScopeConfig: 'unsupported',
          },
        }),
      })
      expect(stepById(rows, 'preview').status).toBe('ready')
    }
  })

  it.each([
    ['orgActiveMemberCount', 0],
    ['groupCount', 0],
    ['groupsWithMembers', 0],
    ['shiftCount', 0],
    ['approvalFlowCount', 0],
  ] as const)('missing when %s drops to %d, even with ④=customized and ⑥ fully bound', (field, value) => {
    const rows = deriveAttendanceSetupReadinessSteps({
      kind: 'ok',
      data: baseResponse({
        [field]: value,
        punchPolicyPosture: 'customized',
        notify: {
          deliveryRuntime: 'unknown',
          orgRecipientBinding: { boundRecipientCount: 9, hasAnyBoundRecipient: true },
          recipientScopeConfig: 'unsupported',
        },
      } as Partial<AttendanceSetupReadinessResponse>),
    })
    const row = stepById(rows, 'preview')
    expect(row.status).toBe('missing')
    expect(row.reason).toBe('preview_blocked_by_prior_step')
  })

  it('deriveAttendanceSetupReadinessPreviewReady matches the step⑦ status exactly', () => {
    expect(deriveAttendanceSetupReadinessPreviewReady(readyBase)).toBe(true)
    const rows = deriveAttendanceSetupReadinessSteps({ kind: 'ok', data: readyBase })
    expect(stepById(rows, 'preview').status).toBe('ready')
  })
})

describe('effectiveTime pass-through', () => {
  it('carries each step perStep entry through unchanged', () => {
    const custom = { source: 'user_orgs.is_active', posture: 'immediate' as const }
    const rows = deriveAttendanceSetupReadinessSteps({
      kind: 'ok',
      data: baseResponse({ perStep: { ...PER_STEP, 'attendance-admin-user-access': { effectiveTime: custom } } }),
    })
    expect(stepById(rows, 'attendance-admin-user-access').effectiveTime).toEqual(custom)
  })

  it('an "undeterminable"/effectiveAt-bearing entry round-trips exactly', () => {
    const scheduled = { source: 'holiday_sync_window', posture: 'scheduled' as const, effectiveAt: '2026-08-01T00:00:00.000Z' }
    const rows = deriveAttendanceSetupReadinessSteps({
      kind: 'ok',
      data: baseResponse({ perStep: { ...PER_STEP, 'attendance-admin-groups': { effectiveTime: scheduled } } }),
    })
    expect(stepById(rows, 'attendance-admin-groups').effectiveTime).toEqual(scheduled)
  })
})

describe('scope tag (§3.2 "每信号携带 scope: org | deployment") on every matrix row', () => {
  it('org-scoped for ①②③⑤⑦, deployment-scoped for ④⑥, on an "ok" response', () => {
    const rows = deriveAttendanceSetupReadinessSteps({ kind: 'ok', data: baseResponse() })
    expect(stepById(rows, 'attendance-admin-user-access').scope).toBe('org')
    expect(stepById(rows, 'attendance-admin-groups').scope).toBe('org')
    expect(stepById(rows, 'attendance-admin-shifts').scope).toBe('org')
    expect(stepById(rows, 'attendance-admin-settings').scope).toBe('deployment')
    expect(stepById(rows, 'attendance-admin-approval-flows').scope).toBe('org')
    expect(stepById(rows, 'attendance-admin-notification-deliveries').scope).toBe('deployment')
    expect(stepById(rows, 'preview').scope).toBe('org')
  })

  it('every row scope matches the exported ATTENDANCE_SETUP_STEP_SCOPE registry exactly', () => {
    const rows = deriveAttendanceSetupReadinessSteps({ kind: 'ok', data: baseResponse() })
    for (const row of rows) {
      expect(row.scope).toBe(ATTENDANCE_SETUP_STEP_SCOPE[row.stepId])
    }
  })

  it('scope is present even on the whole-endpoint forbidden/db_not_ready folds (a scope tag is a property of the STEP, not of the current judgement)', () => {
    for (const input of [{ kind: 'forbidden' as const }, { kind: 'db_not_ready' as const }]) {
      const rows = deriveAttendanceSetupReadinessSteps(input)
      for (const row of rows) {
        expect(row.scope).toBe(ATTENDANCE_SETUP_STEP_SCOPE[row.stepId])
      }
    }
  })
})

describe('full-matrix status-value coverage (every domain value reachable in the current implementation)', () => {
  it('touches all seven values across the folds + a representative "ok" response', () => {
    const touched = new Set<string>()
    for (const row of deriveAttendanceSetupReadinessSteps({ kind: 'forbidden' })) touched.add(row.status)
    for (const row of deriveAttendanceSetupReadinessSteps({ kind: 'db_not_ready' })) touched.add(row.status)
    for (const row of deriveAttendanceSetupReadinessSteps({
      kind: 'ok',
      data: baseResponse({ orgActiveMemberCount: 0, punchPolicyPosture: 'unknown' }),
    })) {
      touched.add(row.status)
    }
    for (const row of deriveAttendanceSetupReadinessSteps({
      kind: 'ok',
      data: baseResponse({ punchPolicyPosture: 'default' }),
    })) {
      touched.add(row.status)
    }
    expect([...touched].sort()).toEqual([...ATTENDANCE_SETUP_READINESS_STATUS_VALUES].sort())
  })
})
