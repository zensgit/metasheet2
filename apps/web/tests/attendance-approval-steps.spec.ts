import { readFileSync } from 'node:fs'
import { useAttendanceAdminUsers } from '../src/views/attendance/useAttendanceAdminUsers'
import {
  resolveAttendanceReadinessOrgId,
  useAttendanceApprovalDirectoryReadiness,
} from '../src/views/attendance/useAttendanceApprovalDirectoryReadiness'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_APPROVAL_REQUEST_TYPES,
  ATTENDANCE_DEFAULT_ORG_ID,
  ATTENDANCE_DYNAMIC_STEP_KINDS,
  addApproverRoles,
  addApproverUser,
  addStep,
  collectAuthoringWarnings,
  getStepKindSelection,
  isUnsupportedDynamicStep,
  makeEmptyStep,
  moveStep,
  normalizeStep,
  normalizeSteps,
  parseRoleInput,
  removeApproverRole,
  removeApproverUser,
  removeStep,
  setManagerLevel,
  setStepField,
  setStepKind,
  stepHasNoApprover,
  stepsPreviewJson,
  toPayloadSteps,
  type AttendanceApprovalStep,
} from '../src/views/attendance/attendanceApprovalSteps'

describe('ATTENDANCE_APPROVAL_REQUEST_TYPES', () => {
  it('exposes all eight backend request types, including outdoor_punch and schedule_dispatch', () => {
    expect(ATTENDANCE_APPROVAL_REQUEST_TYPES).toEqual([
      'missed_check_in', 'missed_check_out', 'time_correction', 'leave',
      'overtime', 'outdoor_punch', 'shift_swap', 'schedule_dispatch',
    ])
  })

  it('stays in sync with the backend REQUEST_TYPES enum (the FE dropdown must not miss a type)', () => {
    const backend = readFileSync(
      resolve(__dirname, '../../../plugins/plugin-attendance/index.cjs'),
      'utf8',
    )
    const block = backend.match(/const REQUEST_TYPES = \[([\s\S]*?)\]/)
    expect(block, 'REQUEST_TYPES array not found in backend').toBeTruthy()
    const backendTypes = Array.from(block![1].matchAll(/'([a-z_]+)'/g)).map(m => m[1])
    expect([...ATTENDANCE_APPROVAL_REQUEST_TYPES].sort()).toEqual([...backendTypes].sort())
  })
})

describe('S7-5 fixture-sync: dynamic kinds + default org', () => {
  it('selector kinds match backend ATTENDANCE_DYNAMIC_ASSIGNEE_KINDS and never include continuous_managers', () => {
    const backend = readFileSync(
      resolve(__dirname, '../../../plugins/plugin-attendance/index.cjs'),
      'utf8',
    )
    const block = backend.match(/const ATTENDANCE_DYNAMIC_ASSIGNEE_KINDS = \[([\s\S]*?)\]/)
    expect(block, 'ATTENDANCE_DYNAMIC_ASSIGNEE_KINDS not found').toBeTruthy()
    const backendKinds = Array.from(block![1].matchAll(/'([a-z_]+)'/g)).map(m => m[1])
    expect([...ATTENDANCE_DYNAMIC_STEP_KINDS].sort()).toEqual([...backendKinds].sort())
    expect(ATTENDANCE_DYNAMIC_STEP_KINDS).not.toContain('continuous_managers')
  })

  it('ATTENDANCE_DEFAULT_ORG_ID matches plugin DEFAULT_ORG_ID literal (blank-org readiness path)', () => {
    const backend = readFileSync(
      resolve(__dirname, '../../../plugins/plugin-attendance/index.cjs'),
      'utf8',
    )
    const match = backend.match(/const DEFAULT_ORG_ID = '([^']+)'/)
    expect(match, 'DEFAULT_ORG_ID not found in plugin-attendance').toBeTruthy()
    expect(ATTENDANCE_DEFAULT_ORG_ID).toBe(match![1])
    expect(ATTENDANCE_DEFAULT_ORG_ID).toBe('default')
  })
})

describe('step add/remove/reorder', () => {
  it('adds an empty step and removes by index', () => {
    let steps = addStep([])
    expect(steps).toHaveLength(1)
    steps = addStep(steps)
    expect(steps).toHaveLength(2)
    steps = removeStep(steps, 0)
    expect(steps).toHaveLength(1)
  })
  it('moves a step up/down and no-ops at the ends', () => {
    const steps = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]
    expect(moveStep(steps, 2, -1).map(s => s.name)).toEqual(['a', 'c', 'b'])
    expect(moveStep(steps, 0, -1).map(s => s.name)).toEqual(['a', 'b', 'c'])
    expect(moveStep(steps, 2, 1).map(s => s.name)).toEqual(['a', 'b', 'c'])
  })
  it('setStepField patches immutably', () => {
    const steps = [makeEmptyStep()]
    const next = setStepField(steps, 0, { name: 'Manager' })
    expect(next[0].name).toBe('Manager')
    expect(steps[0].name).toBe('')
  })
})

describe('approver users & roles', () => {
  it('adds/removes approver users, deduped', () => {
    let steps = [makeEmptyStep()]
    steps = addApproverUser(steps, 0, 'u1')
    steps = addApproverUser(steps, 0, 'u1')
    steps = addApproverUser(steps, 0, 'u2')
    expect(steps[0].approverUserIds).toEqual(['u1', 'u2'])
    steps = removeApproverUser(steps, 0, 'u1')
    expect(steps[0].approverUserIds).toEqual(['u2'])
  })
  it('parses and adds roles from mixed separators', () => {
    expect(parseRoleInput('manager, hr\nlead  manager')).toEqual(['manager', 'hr', 'lead'])
    let steps = [makeEmptyStep()]
    steps = addApproverRoles(steps, 0, 'manager，hr')
    expect(steps[0].approverRoleIds).toEqual(['manager', 'hr'])
    steps = removeApproverRole(steps, 0, 'manager')
    expect(steps[0].approverRoleIds).toEqual(['hr'])
  })
  it('refuses to mutate static approver arrays on a clean dynamic step', () => {
    let steps = setStepKind([makeEmptyStep()], 0, 'direct_manager')
    steps = addApproverUser(steps, 0, 'u1')
    steps = addApproverRoles(steps, 0, 'manager')
    expect(steps[0].approverUserIds).toBeUndefined()
    expect(steps[0].approverRoleIds).toBeUndefined()
    expect(steps[0].kind).toBe('direct_manager')
  })
})

describe('S7-5 step kind selector / intentional switch', () => {
  it('setStepKind static→dynamic drops static approver KEYS and sets kind', () => {
    let steps = [{ name: 'L1', approverUserIds: ['u1'], approverRoleIds: ['manager'] }]
    steps = setStepKind(steps, 0, 'direct_manager')
    expect(steps[0]).toEqual({ name: 'L1', kind: 'direct_manager' })
  })

  it('setStepKind dynamic→static drops kind/level and materializes empty approver arrays', () => {
    let steps = setStepKind([makeEmptyStep()], 0, 'manager_at_level', { maxManagerChainLevels: 10 })
    expect(steps[0]).toEqual({ name: '', kind: 'manager_at_level', level: 1 })
    steps = setStepKind(steps, 0, 'static')
    expect(steps[0]).toEqual({ name: '', approverUserIds: [], approverRoleIds: [] })
  })

  it('intentional switch to manager_at_level initializes level=1 only when host max is known', () => {
    const withMax = setStepKind([makeEmptyStep()], 0, 'manager_at_level', { maxManagerChainLevels: 5 })
    expect(withMax[0]).toEqual({ name: '', kind: 'manager_at_level', level: 1 })

    // Unknown max → no-op (fail-closed; no invented level)
    const original = makeEmptyStep()
    const withoutMax = setStepKind([original], 0, 'manager_at_level', { maxManagerChainLevels: null })
    expect(withoutMax[0]).toEqual(original)
    expect(withoutMax[0].kind).toBeUndefined()
  })

  it('setManagerLevel stores raw value without trunc/clamp when max is known', () => {
    let steps = setStepKind([makeEmptyStep()], 0, 'manager_at_level', { maxManagerChainLevels: 5 })
    steps = setManagerLevel(steps, 0, 1.5, 5)
    expect(steps[0].level).toBe(1.5)
    steps = setManagerLevel(steps, 0, 0, 5)
    expect(steps[0].level).toBe(0)
    steps = setManagerLevel(steps, 0, 6, 5) // MAX+1
    expect(steps[0].level).toBe(6)
  })

  it('setManagerLevel is a no-op while host max is unknown', () => {
    const steps = [{ name: 'L', kind: 'manager_at_level', level: 3 }]
    const next = setManagerLevel(steps, 0, 99, null)
    expect(next[0].level).toBe(3)
  })

  it('toPayloadSteps emits clean static vs dynamic shapes', () => {
    const staticPayload = toPayloadSteps([{ name: '  Manager  ', approverUserIds: [' u1 '], approverRoleIds: ['hr'] }])
    expect(staticPayload[0]).toEqual({ name: 'Manager', approverUserIds: ['u1'], approverRoleIds: ['hr'] })

    const dm = toPayloadSteps([{ name: 'DM', kind: 'direct_manager' }])
    expect(dm[0]).toEqual({ name: 'DM', kind: 'direct_manager' })

    const mal = toPayloadSteps([{ name: 'L2', kind: 'manager_at_level', level: 3 }])
    expect(mal[0]).toEqual({ name: 'L2', kind: 'manager_at_level', level: 3 })
  })
})

describe('P2-1 fail-closed: malformed shapes are NOT repaired', () => {
  it('normalizeStep preserves mixed kind + static approver arrays', () => {
    const raw = { name: 'mixed', kind: 'direct_manager', approverUserIds: ['u1'], approverRoleIds: ['hr'] }
    const step = normalizeStep(raw)
    expect(step.kind).toBe('direct_manager')
    expect(step.approverUserIds).toEqual(['u1'])
    expect(step.approverRoleIds).toEqual(['hr'])
  })

  it('toPayloadSteps does not strip mixed kind + static arrays', () => {
    const payload = toPayloadSteps([
      { name: 'mixed', kind: 'direct_manager', approverUserIds: ['u1'], approverRoleIds: ['hr'] },
    ])
    expect(payload[0].kind).toBe('direct_manager')
    expect(payload[0].approverUserIds).toEqual(['u1'])
    expect(payload[0].approverRoleIds).toEqual(['hr'])
  })

  it('non-string kind is preserved and never displayed/coerced as static', () => {
    const step = normalizeStep({ name: 'x', kind: 42 as unknown as string })
    expect(hasOwnKind(step)).toBe(true)
    expect(getStepKindSelection(step)).toBeNull()
    expect(isUnsupportedDynamicStep(step)).toBe(true)
    const payload = toPayloadSteps([step])
    expect(payload[0].kind).toBe(42)
    // Must NOT delete kind (would make it look static to the backend)
    expect(Object.prototype.hasOwnProperty.call(payload[0], 'kind')).toBe(true)
  })

  it('blank string kind is preserved (not deleted into a static step)', () => {
    const step = normalizeStep({ name: 'x', kind: '  ' })
    expect(getStepKindSelection(step)).toBeNull()
    const payload = toPayloadSteps([step])
    expect(Object.prototype.hasOwnProperty.call(payload[0], 'kind')).toBe(true)
    expect(payload[0].kind).toBe('  ')
  })

  it('manager_at_level missing level is NOT defaulted to 1', () => {
    const step = normalizeStep({ name: 'L', kind: 'manager_at_level' })
    expect(step.level).toBeUndefined()
    const payload = toPayloadSteps([step])
    expect(payload[0].kind).toBe('manager_at_level')
    expect(Object.prototype.hasOwnProperty.call(payload[0], 'level') ? payload[0].level : undefined).toBeUndefined()
    expect(payload[0]).not.toEqual(expect.objectContaining({ level: 1 }))
  })

  it('fractional level is preserved (not Math.trunc\'d)', () => {
    const step = normalizeStep({ name: 'L', kind: 'manager_at_level', level: 2.7 })
    expect(step.level).toBe(2.7)
    const payload = toPayloadSteps([step])
    expect(payload[0].level).toBe(2.7)
  })

  it('level 0 and MAX+1 are preserved (not clamped into range)', () => {
    const zero = toPayloadSteps([{ name: 'L', kind: 'manager_at_level', level: 0 }])
    expect(zero[0].level).toBe(0)
    const over = toPayloadSteps([{ name: 'L', kind: 'manager_at_level', level: 11 }])
    expect(over[0].level).toBe(11)
  })

  it('param-less kind with futureParam is preserved (not stripped to clean {name,kind})', () => {
    // Backend assertApprovalStepsContract → APPROVAL_STEP_PARAMS_INVALID.
    // Mutation evidence: a clean-branch strip would drop futureParam and green-pass this.
    const payload = toPayloadSteps([
      { name: 'x', kind: 'direct_manager', futureParam: true } as AttendanceApprovalStep,
    ])
    expect(payload[0].kind).toBe('direct_manager')
    expect(payload[0].futureParam).toBe(true)
    expect(Object.keys(payload[0]).sort()).toEqual(['futureParam', 'kind', 'name'])
  })

  it('dept_head carrying level is preserved (level is not a param-less-kind field)', () => {
    const payload = toPayloadSteps([
      { name: 'dh', kind: 'dept_head', level: 2 } as AttendanceApprovalStep,
    ])
    expect(payload[0].kind).toBe('dept_head')
    expect(payload[0].level).toBe(2)
    expect(Object.keys(payload[0]).sort()).toEqual(['kind', 'level', 'name'])
  })

  it('manager_at_level with an extra key is preserved (not closed-union stripped)', () => {
    const payload = toPayloadSteps([
      { name: 'L', kind: 'manager_at_level', level: 2, extraFlag: 'x' } as AttendanceApprovalStep,
    ])
    expect(payload[0].kind).toBe('manager_at_level')
    expect(payload[0].level).toBe(2)
    expect(payload[0].extraFlag).toBe('x')
    expect(Object.keys(payload[0]).sort()).toEqual(['extraFlag', 'kind', 'level', 'name'])
  })

  it('explicit setStepKind still produces a clean closed shape (extra keys dropped only on intentional switch)', () => {
    // User switches away from a polluted step → closed union for the NEW kind.
    const polluted = [{ name: 'x', kind: 'direct_manager', futureParam: true } as AttendanceApprovalStep]
    const switched = setStepKind(polluted, 0, 'dept_head')
    expect(toPayloadSteps(switched)[0]).toEqual({ name: 'x', kind: 'dept_head' })
    expect(Object.prototype.hasOwnProperty.call(toPayloadSteps(switched)[0], 'futureParam')).toBe(false)
  })

  it('unsupported continuous_managers round-trips without rewrite', () => {
    const raw = { name: 'chain', kind: 'continuous_managers', levels: 3, mode: 'all' }
    const step = normalizeStep(raw)
    expect(isUnsupportedDynamicStep(step)).toBe(true)
    expect(getStepKindSelection(step)).toBeNull()
    const payload = toPayloadSteps([step])
    expect(payload[0].kind).toBe('continuous_managers')
    expect(payload[0].levels).toBe(3)
    expect(payload[0].mode).toBe('all')
  })
})

function hasOwnKind(step: object): boolean {
  return Object.prototype.hasOwnProperty.call(step, 'kind')
}

describe('round-trip fidelity (static unknown keys)', () => {
  it('normalizeStep preserves keys the editor does not model on static steps', () => {
    const raw = { name: 'x', approverUserIds: ['u1'], mode: 'all', slaHours: 24 }
    const step = normalizeStep(raw)
    expect(step.mode).toBe('all')
    expect(step.slaHours).toBe(24)
    expect(step.approverUserIds).toEqual(['u1'])
    expect(step.approverRoleIds).toEqual([])
  })
  it('load → payload preserves unknown keys on static steps verbatim', () => {
    const loaded = normalizeSteps([{ name: 'x', approverRoleIds: ['manager'], threshold: 2 }])
    const payload = toPayloadSteps(loaded)
    expect(payload[0].threshold).toBe(2)
    expect(payload[0].approverRoleIds).toEqual(['manager'])
    expect(payload[0].name).toBe('x')
  })
  it('trims names and coerces arrays in static payload', () => {
    const payload = toPayloadSteps([{ name: '  Manager  ', approverUserIds: [' u1 ', ''], approverRoleIds: undefined }])
    expect(payload[0].name).toBe('Manager')
    expect(payload[0].approverUserIds).toEqual(['u1'])
    expect(payload[0].approverRoleIds).toEqual([])
  })
})

describe('authoring warnings (empty-approver / no-steps / directory_not_ready)', () => {
  it('flags no steps', () => {
    expect(collectAuthoringWarnings([])).toEqual([{ code: 'no_steps' }])
  })
  it('flags a static step with neither user nor role', () => {
    expect(stepHasNoApprover(makeEmptyStep())).toBe(true)
    const steps = [{ name: 'ok', approverUserIds: ['u1'] }, makeEmptyStep()]
    expect(collectAuthoringWarnings(steps)).toEqual([{ code: 'empty_approver', stepIndex: 1 }])
  })
  it('no empty_approver warning for a dynamic step without static approvers', () => {
    const steps = [{ name: 'DM', kind: 'direct_manager' }]
    expect(stepHasNoApprover(steps[0])).toBe(false)
    expect(collectAuthoringWarnings(steps)).toEqual([])
  })
  it('flags directory_not_ready when a dynamic step is present and org has no linked directory', () => {
    const steps = [{ name: 'DM', kind: 'direct_manager' }]
    expect(collectAuthoringWarnings(steps, { hasLinkedDirectoryAccounts: false })).toEqual([
      { code: 'directory_not_ready' },
    ])
  })
  it('does not invent directory_not_ready when readiness is unknown (null)', () => {
    const steps = [{ name: 'DM', kind: 'direct_manager' }]
    expect(collectAuthoringWarnings(steps, { hasLinkedDirectoryAccounts: null })).toEqual([])
  })
  it('no warnings when every static step has an approver and directory is ready', () => {
    expect(collectAuthoringWarnings(
      [{ name: 'a', approverRoleIds: ['manager'] }],
      { hasLinkedDirectoryAccounts: true },
    )).toEqual([])
  })
})

describe('stepsPreviewJson', () => {
  it('renders the payload as pretty JSON', () => {
    const json = stepsPreviewJson([{ name: 'Manager', approverRoleIds: ['manager'] }])
    expect(JSON.parse(json)).toEqual([{ name: 'Manager', approverUserIds: [], approverRoleIds: ['manager'] }])
  })
})

describe('useAttendanceAdminUsers endpoint (review P2)', () => {
  it('defaults to the platform /api/admin/users route', async () => {
    const calls: string[] = []
    const apiFetch = async (path: string) => {
      calls.push(path)
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { items: [] } }) } as unknown as Response
    }
    const { loadUsers } = useAttendanceAdminUsers({ apiFetch })
    await loadUsers('alice')
    expect(calls[0]).toBe('/api/admin/users?q=alice')
  })
  it('uses the attendance-scoped search when endpoint is provided', async () => {
    const calls: string[] = []
    const apiFetch = async (path: string) => {
      calls.push(path)
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { items: [] } }) } as unknown as Response
    }
    const { loadUsers } = useAttendanceAdminUsers({ apiFetch, endpoint: '/api/attendance-admin/users/search' })
    await loadUsers('bob')
    expect(calls[0]).toBe('/api/attendance-admin/users/search?q=bob')
    expect(calls.some(p => p.startsWith('/api/admin/users'))).toBe(false)
  })
})

describe('useAttendanceApprovalDirectoryReadiness (OD-S7-6 / P2-2 / P2-3)', () => {
  it('maps blank org to ATTENDANCE_DEFAULT_ORG_ID and calls attendance-admin readiness', async () => {
    expect(resolveAttendanceReadinessOrgId('')).toBe(ATTENDANCE_DEFAULT_ORG_ID)
    expect(resolveAttendanceReadinessOrgId('  ')).toBe(ATTENDANCE_DEFAULT_ORG_ID)
    expect(resolveAttendanceReadinessOrgId(null)).toBe(ATTENDANCE_DEFAULT_ORG_ID)
    expect(resolveAttendanceReadinessOrgId('org-a')).toBe('org-a')

    const calls: string[] = []
    const apiFetch = async (path: string) => {
      calls.push(path)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data: { hasLinkedDirectoryAccounts: false, maxManagerChainLevels: 10 },
        }),
      } as unknown as Response
    }
    const { loadReadiness, hasLinkedDirectoryAccounts, maxManagerChainLevels } =
      useAttendanceApprovalDirectoryReadiness({ apiFetch })
    // Blank org must still load readiness for the plugin default org.
    const result = await loadReadiness('')
    expect(calls).toEqual([`/api/attendance-admin/directory-readiness?orgId=${ATTENDANCE_DEFAULT_ORG_ID}`])
    expect(calls.some(p => p.includes('/api/admin/'))).toBe(false)
    expect(result).toEqual({ hasLinkedDirectoryAccounts: false, maxManagerChainLevels: 10 })
    expect(hasLinkedDirectoryAccounts.value).toBe(false)
    expect(maxManagerChainLevels.value).toBe(10)
  })

  it('starts with unknown max (null) — no local fallback constant', () => {
    const { maxManagerChainLevels, hasLinkedDirectoryAccounts } = useAttendanceApprovalDirectoryReadiness({
      apiFetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
    })
    expect(maxManagerChainLevels.value).toBeNull()
    expect(hasLinkedDirectoryAccounts.value).toBeNull()
  })

  it('resets max/readiness to unknown on HTTP failure', async () => {
    const apiFetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({ ok: false }),
    }) as unknown as Response
    const { loadReadiness, maxManagerChainLevels, hasLinkedDirectoryAccounts } =
      useAttendanceApprovalDirectoryReadiness({ apiFetch })
    await loadReadiness('org-a')
    expect(maxManagerChainLevels.value).toBeNull()
    expect(hasLinkedDirectoryAccounts.value).toBeNull()
  })

  it('stale-response guard: an older org response cannot overwrite the current org', async () => {
    type Deferred = { resolve: (r: Response) => void }
    const queue: Deferred[] = []
    const apiFetch = async (_path: string) =>
      await new Promise<Response>((resolve) => {
        queue.push({ resolve })
      })

    const makeResponse = (hasLinked: boolean, max: number) =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data: { hasLinkedDirectoryAccounts: hasLinked, maxManagerChainLevels: max },
        }),
      }) as unknown as Response

    const { loadReadiness, maxManagerChainLevels, hasLinkedDirectoryAccounts, lastOrgId } =
      useAttendanceApprovalDirectoryReadiness({ apiFetch })

    const pA = loadReadiness('org-a')
    for (let i = 0; i < 20 && queue.length < 1; i += 1) await Promise.resolve()
    expect(queue.length).toBe(1)

    const pB = loadReadiness('org-b')
    for (let i = 0; i < 20 && queue.length < 2; i += 1) await Promise.resolve()
    expect(queue.length).toBe(2)

    // B completes first
    queue[1].resolve(makeResponse(false, 3))
    await pB
    expect(lastOrgId.value).toBe('org-b')
    expect(maxManagerChainLevels.value).toBe(3)
    expect(hasLinkedDirectoryAccounts.value).toBe(false)

    // Stale A completes — must NOT overwrite B
    queue[0].resolve(makeResponse(true, 7))
    await pA
    expect(lastOrgId.value).toBe('org-b')
    expect(maxManagerChainLevels.value).toBe(3)
    expect(hasLinkedDirectoryAccounts.value).toBe(false)
  })

  it('malformed max in response leaves max unknown (no invented fallback)', async () => {
    const apiFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        data: { hasLinkedDirectoryAccounts: true, maxManagerChainLevels: 'nope' },
      }),
    }) as unknown as Response
    const { loadReadiness, maxManagerChainLevels, hasLinkedDirectoryAccounts } =
      useAttendanceApprovalDirectoryReadiness({ apiFetch })
    const result = await loadReadiness('org-a')
    expect(result).toBeNull()
    expect(maxManagerChainLevels.value).toBeNull()
    expect(hasLinkedDirectoryAccounts.value).toBeNull()
  })
})
