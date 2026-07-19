import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

// S7-1 (RATIFIED attendance-approval-s7 resolver design-lock, §7 S7-1 + §4.1): pure-helper unit
// coverage for the DISCRIMINATED-UNION step contract and the RUNTIME fail-closed gate. Every rejection
// carries a DISTINCT HttpError code, so these tests double as mutation canaries — removing any single
// guard changes (or removes) the specific code its leg asserts, reddening exactly that leg rather than
// being masked by a later 422. The port is faked (core-backend is the PROVIDER in prod). S7-1 cases
// below default `implementedKinds: []` so well-formed dynamic steps hit UNAVAILABLE; S7-2 unit cases
// override with `direct_manager` where they assert the implemented path.

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceApprovalCenterForTests as {
  normalizeApprovalSteps: (value: unknown) => Array<Record<string, unknown>>
  assertApprovalStepsContract: (steps: unknown, context: unknown) => void
  assertDynamicFlowStepsRuntimeAvailable: (
    steps: unknown,
    context: unknown,
    options?: { onlyStepIndex?: number },
  ) => void
  buildAttendanceApprovalAssignments: (steps: unknown, index?: number) => unknown
  getApprovalStepKind: (step: unknown) => string | null
  ATTENDANCE_DYNAMIC_ASSIGNEE_FLAG_ENV: string
  ATTENDANCE_DYNAMIC_ASSIGNEE_KINDS: string[]
}

const {
  normalizeApprovalSteps,
  assertApprovalStepsContract,
  assertDynamicFlowStepsRuntimeAvailable,
  buildAttendanceApprovalAssignments,
  ATTENDANCE_DYNAMIC_ASSIGNEE_FLAG_ENV,
} = helpers

const MAX = 10 // host-resolved default (APPROVAL_MANAGER_CHAIN_MAX_LEVELS unset ⇒ 10)

function makeContext(
  opts: { implementedKinds?: string[]; maxManagerChainLevels?: number; port?: boolean } = {},
): unknown {
  if (opts.port === false) return { services: {} }
  return {
    services: {
      approvalAssigneeResolver: {
        maxManagerChainLevels: opts.maxManagerChainLevels ?? MAX,
        implementedKinds: opts.implementedKinds ?? [],
        resolve: async () => ({ status: 'unimplemented' as const }),
      },
    },
  }
}

function setFlag(enabled: boolean): void {
  process.env[ATTENDANCE_DYNAMIC_ASSIGNEE_FLAG_ENV] = enabled ? 'true' : 'false'
}

function httpCode(fn: () => void): { status: number; code: string } | null {
  try {
    fn()
    return null
  } catch (err) {
    const e = err as { status?: number; code?: string }
    return { status: e.status ?? -1, code: e.code ?? '<none>' }
  }
}

afterEach(() => {
  delete process.env[ATTENDANCE_DYNAMIC_ASSIGNEE_FLAG_ENV]
})

describe('S7-1 normalizeApprovalSteps — discriminated union survives to persistence', () => {
  it('preserves a static step byte-for-byte (legacy, unchanged — normalizer does not dedup)', () => {
    expect(
      normalizeApprovalSteps([{ name: 'LM', approverUserIds: ['u1', 'u2'], approverRoleIds: ['r1'] }]),
    ).toEqual([{ name: 'LM', approverUserIds: ['u1', 'u2'], approverRoleIds: ['r1'] }])
  })

  it('preserves a dynamic kind (direct_manager) and drops static approver arrays', () => {
    expect(normalizeApprovalSteps([{ name: 'Mgr', kind: 'direct_manager' }])).toEqual([
      { name: 'Mgr', kind: 'direct_manager' },
    ])
  })

  it('preserves manager_at_level with its integer level', () => {
    expect(normalizeApprovalSteps([{ kind: 'manager_at_level', level: 3 }])).toEqual([
      { name: undefined, kind: 'manager_at_level', level: 3 },
    ])
  })

  it('a mixed step normalizes to dynamic (kind wins) so it cannot route to the admin fallback', () => {
    expect(normalizeApprovalSteps([{ kind: 'direct_manager', approverUserIds: ['u1'] }])).toEqual([
      { name: undefined, kind: 'direct_manager' },
    ])
  })
})

describe('S7-1 assertApprovalStepsContract — discriminated-union authoring matrix (distinct codes)', () => {
  // Shape checks run with flag ON + ALL kinds "implemented" so a shape rejection is NOT masked by the
  // availability arm — proving shape precedence and that each shape code is the load-bearing reason.
  const allImplemented = () =>
    makeContext({ implementedKinds: ['direct_manager', 'dept_head', 'manager_at_level'] })

  it('static/dynamic MIXED → APPROVAL_STEP_STATIC_DYNAMIC_MIXED', () => {
    setFlag(true)
    expect(httpCode(() => assertApprovalStepsContract([{ kind: 'direct_manager', approverUserIds: ['u1'] }], allImplemented())))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_STATIC_DYNAMIC_MIXED' })
  })

  it('MIXED still 422/MIXED even with flag OFF + no implemented kinds (shape precedes availability)', () => {
    setFlag(false)
    expect(httpCode(() => assertApprovalStepsContract([{ kind: 'direct_manager', approverRoleIds: ['r1'] }], makeContext())))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_STATIC_DYNAMIC_MIXED' })
  })

  // Owner P2 (#4415 round 2): the lock's union is a KEY-shape constraint — an EMPTY array still carries
  // the static key, so it must 422 MIXED, never be silently key-dropped by the normalizer.
  it('dynamic + approverUserIds: [] (empty array carries the key) → MIXED', () => {
    setFlag(true)
    expect(httpCode(() => assertApprovalStepsContract([{ kind: 'direct_manager', approverUserIds: [] }], allImplemented())))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_STATIC_DYNAMIC_MIXED' })
  })

  it('dynamic + approverRoleIds: [] (empty array carries the key) → MIXED', () => {
    setFlag(true)
    expect(httpCode(() => assertApprovalStepsContract([{ kind: 'direct_manager', approverRoleIds: [] }], allImplemented())))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_STATIC_DYNAMIC_MIXED' })
  })

  it('dynamic + approverUserIds: null (JSON null carries the key) → MIXED', () => {
    setFlag(true)
    expect(httpCode(() => assertApprovalStepsContract([{ kind: 'direct_manager', approverUserIds: null }], allImplemented())))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_STATIC_DYNAMIC_MIXED' })
  })

  it('undefined-valued approver keys are NOT mixing (normalizeApprovalStepPayload materializes both keys as undefined on every step)', () => {
    setFlag(true)
    expect(httpCode(() => assertApprovalStepsContract(
      [{ kind: 'manager_at_level', level: 2, approverUserIds: undefined, approverRoleIds: undefined }],
      allImplemented(),
    ))).toBeNull()
  })

  // Owner P2 (#4415 round 2): closed per-kind param union — {name, kind} ∪ ({level} iff manager_at_level).
  it('direct_manager + level (no-param kind) → APPROVAL_STEP_PARAMS_INVALID', () => {
    setFlag(true)
    expect(httpCode(() => assertApprovalStepsContract([{ kind: 'direct_manager', level: 2 }], allImplemented())))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_PARAMS_INVALID' })
  })

  it('dept_head + level (no-param kind) → APPROVAL_STEP_PARAMS_INVALID', () => {
    setFlag(true)
    expect(httpCode(() => assertApprovalStepsContract([{ kind: 'dept_head', level: 1 }], allImplemented())))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_PARAMS_INVALID' })
  })

  it('unmodeled dynamic param (dept_head + target) → APPROVAL_STEP_PARAMS_INVALID', () => {
    setFlag(true)
    expect(httpCode(() => assertApprovalStepsContract([{ kind: 'dept_head', target: 'x' }], allImplemented())))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_PARAMS_INVALID' })
  })

  it('PARAMS_INVALID still surfaces with flag OFF + no implemented kinds (shape precedes availability)', () => {
    setFlag(false)
    expect(httpCode(() => assertApprovalStepsContract([{ kind: 'direct_manager', level: 2 }], makeContext())))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_PARAMS_INVALID' })
  })

  it('name + level on manager_at_level are inside the closed union (no throw)', () => {
    setFlag(true)
    expect(httpCode(() => assertApprovalStepsContract([{ name: '主管', kind: 'manager_at_level', level: 2 }], allImplemented())))
      .toBeNull()
  })

  it('unknown kind → APPROVAL_STEP_KIND_INVALID', () => {
    setFlag(true)
    expect(httpCode(() => assertApprovalStepsContract([{ kind: 'bogus_kind' }], allImplemented())))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_KIND_INVALID' })
  })

  it('continuous_managers is OUT-of-v1 → APPROVAL_STEP_KIND_INVALID', () => {
    setFlag(true)
    expect(httpCode(() => assertApprovalStepsContract([{ kind: 'continuous_managers', levels: 2 }], allImplemented())))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_KIND_INVALID' })
  })

  it('kind present but empty string → APPROVAL_STEP_KIND_INVALID', () => {
    setFlag(true)
    expect(httpCode(() => assertApprovalStepsContract([{ kind: '' }], allImplemented())))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_KIND_INVALID' })
  })

  it('manager_at_level missing level → APPROVAL_STEP_LEVEL_INVALID', () => {
    setFlag(true)
    expect(httpCode(() => assertApprovalStepsContract([{ kind: 'manager_at_level' }], allImplemented())))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_LEVEL_INVALID' })
  })

  it('manager_at_level non-integer level (1.5) → APPROVAL_STEP_LEVEL_INVALID', () => {
    setFlag(true)
    expect(httpCode(() => assertApprovalStepsContract([{ kind: 'manager_at_level', level: 1.5 }], allImplemented())))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_LEVEL_INVALID' })
  })

  it('manager_at_level level 0 (below range) → APPROVAL_STEP_LEVEL_INVALID', () => {
    setFlag(true)
    expect(httpCode(() => assertApprovalStepsContract([{ kind: 'manager_at_level', level: 0 }], allImplemented())))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_LEVEL_INVALID' })
  })

  it('manager_at_level level MAX+1 (11) → APPROVAL_STEP_LEVEL_INVALID (host-resolved bound)', () => {
    setFlag(true)
    expect(httpCode(() => assertApprovalStepsContract([{ kind: 'manager_at_level', level: MAX + 1 }], allImplemented())))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_LEVEL_INVALID' })
  })

  it('level MAX+1 is a LEVEL error even with flag OFF (bound precedes availability — bound is load-bearing)', () => {
    setFlag(false)
    expect(httpCode(() => assertApprovalStepsContract([{ kind: 'manager_at_level', level: MAX + 1 }], makeContext())))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_LEVEL_INVALID' })
  })

  it('a well-formed static step is accepted (no throw)', () => {
    setFlag(false)
    expect(httpCode(() => assertApprovalStepsContract([{ name: 'x', approverUserIds: ['u1'] }, {}], makeContext())))
      .toBeNull()
  })
})

describe('S7-1 assertApprovalStepsContract — availability gate (S7-1 fail-closed posture)', () => {
  it('flag ON + no implemented kinds → well-formed direct_manager is APPROVAL_STEP_KIND_UNAVAILABLE', () => {
    setFlag(true)
    expect(httpCode(() => assertApprovalStepsContract([{ kind: 'direct_manager' }], makeContext({ implementedKinds: [] }))))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_KIND_UNAVAILABLE' })
  })

  it('flag ON + no implemented kinds → well-formed manager_at_level (valid level) is UNAVAILABLE', () => {
    setFlag(true)
    expect(httpCode(() => assertApprovalStepsContract([{ kind: 'manager_at_level', level: 3 }], makeContext({ implementedKinds: [] }))))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_KIND_UNAVAILABLE' })
  })

  it('flag OFF (even if a kind were implemented) → UNAVAILABLE', () => {
    setFlag(false)
    expect(httpCode(() => assertApprovalStepsContract([{ kind: 'direct_manager' }], makeContext({ implementedKinds: ['direct_manager'] }))))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_KIND_UNAVAILABLE' })
  })

  it('port absent + flag ON → UNAVAILABLE', () => {
    setFlag(true)
    expect(httpCode(() => assertApprovalStepsContract([{ kind: 'direct_manager' }], makeContext({ port: false }))))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_KIND_UNAVAILABLE' })
  })

  it('NOT vacuous: flag ON + kind implemented → the well-formed dynamic step is accepted (forward-compat for S7-2+)', () => {
    setFlag(true)
    expect(httpCode(() => assertApprovalStepsContract(
      [{ kind: 'direct_manager' }, { kind: 'manager_at_level', level: MAX }],
      makeContext({ implementedKinds: ['direct_manager', 'manager_at_level'] }),
    ))).toBeNull()
  })
})

describe('S7-1 assertDynamicFlowStepsRuntimeAvailable — §4.1 runtime fail-closed', () => {
  const flow = () => normalizeApprovalSteps([{}, { kind: 'direct_manager' }])

  it('whole-flow scan: a later dynamic step + flag OFF → throws (cannot start and strand)', () => {
    setFlag(false)
    expect(httpCode(() => assertDynamicFlowStepsRuntimeAvailable(flow(), makeContext())))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_KIND_UNAVAILABLE' })
  })

  it('whole-flow scan: all-static flow → no throw (byte-identical legacy)', () => {
    setFlag(false)
    expect(httpCode(() => assertDynamicFlowStepsRuntimeAvailable(
      normalizeApprovalSteps([{ approverUserIds: ['u1'] }, {}]),
      makeContext(),
    ))).toBeNull()
  })

  it('onlyStepIndex targets the step about to become active (advance): index 1 dynamic → throws', () => {
    setFlag(false)
    expect(httpCode(() => assertDynamicFlowStepsRuntimeAvailable(flow(), makeContext(), { onlyStepIndex: 1 })))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_KIND_UNAVAILABLE' })
  })

  it('onlyStepIndex 0 (static step 0) → no throw', () => {
    setFlag(false)
    expect(httpCode(() => assertDynamicFlowStepsRuntimeAvailable(flow(), makeContext(), { onlyStepIndex: 0 })))
      .toBeNull()
  })

  it('port absent + dynamic step → throws (trigger set includes port-absent)', () => {
    setFlag(true)
    expect(httpCode(() => assertDynamicFlowStepsRuntimeAvailable(flow(), makeContext({ port: false }))))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_KIND_UNAVAILABLE' })
  })

  it('NOT vacuous: flag ON + kind implemented → dynamic step passes the runtime gate', () => {
    setFlag(true)
    expect(httpCode(() => assertDynamicFlowStepsRuntimeAvailable(
      flow(),
      makeContext({ implementedKinds: ['direct_manager'] }),
    ))).toBeNull()
  })
})

describe('S7-1/S7-2/S7-3 buildAttendanceApprovalAssignments — dynamic step never reaches the admin fallback', () => {
  // S7-2/S7-3: direct_manager + dept_head are implemented — missing/empty/self snapshot →
  // APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED (block-with-error, §4). manager_at_level still hits UNGATED.
  it('direct_manager without frozen managerId throws APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED (never admin fallback)', () => {
    expect(httpCode(() => buildAttendanceApprovalAssignments([{ kind: 'direct_manager' }], 0)))
      .toEqual({ status: 422, code: 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED' })
  })

  it('dept_head without frozen deptHeadId throws APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED (never admin fallback)', () => {
    expect(httpCode(() => buildAttendanceApprovalAssignments([{ kind: 'dept_head' }], 0)))
      .toEqual({ status: 422, code: 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED' })
  })

  it('an unimplemented dynamic kind (manager_at_level) still throws APPROVAL_STEP_DYNAMIC_UNGATED', () => {
    expect(httpCode(() => buildAttendanceApprovalAssignments([{ kind: 'manager_at_level', level: 1 }], 0)))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_DYNAMIC_UNGATED' })
  })

  it('legacy static + empty-approver fallback behavior is preserved', () => {
    expect(buildAttendanceApprovalAssignments([], 0)).toEqual([
      { assignmentType: 'role', assigneeId: 'admin', sourceStep: 0, nodeKey: 'attendance_request_step_0', metadata: { source: 'attendance', queue: 'attendance-approval' } },
      { assignmentType: 'source_queue', assigneeId: 'attendance:approve', sourceStep: 0, nodeKey: 'attendance_request_step_0', metadata: { source: 'attendance', queue: 'attendance-approval' } },
      { assignmentType: 'source_queue', assigneeId: 'attendance:admin', sourceStep: 0, nodeKey: 'attendance_request_step_0', metadata: { source: 'attendance', queue: 'attendance-approval' } },
    ])
  })
})

describe('S7-1 F4 NIT — non-string kind reaches DISTINCT 422 (not a silent static step)', () => {
  it('kind: 123 (number) → APPROVAL_STEP_KIND_INVALID', () => {
    setFlag(true)
    expect(httpCode(() => assertApprovalStepsContract([{ kind: 123 }], allImplementedContext())))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_KIND_INVALID' })
  })

  it('kind: null → APPROVAL_STEP_KIND_INVALID', () => {
    setFlag(true)
    expect(httpCode(() => assertApprovalStepsContract([{ kind: null }], allImplementedContext())))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_KIND_INVALID' })
  })

  it('kind: true (boolean) → APPROVAL_STEP_KIND_INVALID', () => {
    setFlag(true)
    expect(httpCode(() => assertApprovalStepsContract([{ kind: true }], allImplementedContext())))
      .toEqual({ status: 422, code: 'APPROVAL_STEP_KIND_INVALID' })
  })
})

function allImplementedContext() {
  return makeContext({ implementedKinds: ['direct_manager', 'dept_head', 'manager_at_level'] })
}
