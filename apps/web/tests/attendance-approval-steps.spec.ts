import { readFileSync } from 'node:fs'
import { useAttendanceAdminUsers } from '../src/views/attendance/useAttendanceAdminUsers'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_APPROVAL_REQUEST_TYPES,
  addApproverRoles,
  addApproverUser,
  addStep,
  collectAuthoringWarnings,
  makeEmptyStep,
  moveStep,
  normalizeStep,
  normalizeSteps,
  parseRoleInput,
  removeApproverRole,
  removeApproverUser,
  removeStep,
  setStepField,
  stepHasNoApprover,
  stepsPreviewJson,
  toPayloadSteps,
} from '../src/views/attendance/attendanceApprovalSteps'

describe('ATTENDANCE_APPROVAL_REQUEST_TYPES', () => {
  it('exposes all eight backend request types, including outdoor_punch and schedule_dispatch', () => {
    expect(ATTENDANCE_APPROVAL_REQUEST_TYPES).toEqual([
      'missed_check_in', 'missed_check_out', 'time_correction', 'leave',
      'overtime', 'outdoor_punch', 'shift_swap', 'schedule_dispatch',
    ])
  })

  it('stays in sync with the backend REQUEST_TYPES enum (the FE dropdown must not miss a type)', () => {
    // The original bug: backend accepted 8 types, the FE dropdown offered 6
    // (outdoor_punch/schedule_dispatch missing). Lock the two sets equal so a
    // future backend type can't silently become unauthorable.
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
})

describe('round-trip fidelity (fail-closed preservation)', () => {
  it('normalizeStep preserves keys the editor does not model', () => {
    const raw = { name: 'x', approverUserIds: ['u1'], mode: 'all', slaHours: 24 }
    const step = normalizeStep(raw)
    expect(step.mode).toBe('all')
    expect(step.slaHours).toBe(24)
    expect(step.approverUserIds).toEqual(['u1'])
    expect(step.approverRoleIds).toEqual([])
  })
  it('load → payload preserves unknown keys verbatim', () => {
    const loaded = normalizeSteps([{ name: 'x', approverRoleIds: ['manager'], threshold: 2 }])
    const payload = toPayloadSteps(loaded)
    expect(payload[0].threshold).toBe(2)
    expect(payload[0].approverRoleIds).toEqual(['manager'])
    expect(payload[0].name).toBe('x')
  })
  it('trims names and coerces arrays in payload', () => {
    const payload = toPayloadSteps([{ name: '  Manager  ', approverUserIds: [' u1 ', ''], approverRoleIds: undefined }])
    expect(payload[0].name).toBe('Manager')
    expect(payload[0].approverUserIds).toEqual(['u1'])
    expect(payload[0].approverRoleIds).toEqual([])
  })
})

describe('authoring warnings (empty-approver / no-steps)', () => {
  it('flags no steps', () => {
    expect(collectAuthoringWarnings([])).toEqual([{ code: 'no_steps' }])
  })
  it('flags a step with neither user nor role', () => {
    expect(stepHasNoApprover(makeEmptyStep())).toBe(true)
    const steps = [{ name: 'ok', approverUserIds: ['u1'] }, makeEmptyStep()]
    expect(collectAuthoringWarnings(steps)).toEqual([{ code: 'empty_approver', stepIndex: 1 }])
  })
  it('no warnings when every step has an approver', () => {
    expect(collectAuthoringWarnings([{ name: 'a', approverRoleIds: ['manager'] }])).toEqual([])
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
