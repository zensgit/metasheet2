import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const configServiceLib = require('../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-config-service.cjs') as {
  ATTENDANCE_FIXED_SCHEDULE_CONFIG_CHANGED: string
  createAttendanceGroupFixedScheduleConfigService: (input: Record<string, unknown>) => {
    upsertConfig: (trx: unknown, input: Record<string, unknown>) => Promise<{ revision: number }>
    resolveConfigForApplyRebuild: (trx: unknown, input: Record<string, unknown>) => Promise<{ config: any; created: boolean }>
  }
}
// These unit seams exercise scheduling/RBAC, not timezone source resolution.
// Supply the trusted guard collaborator; native runtime tests prove its SQL/locks.
const runtimeModule = require('../../../../plugins/plugin-attendance/lib/attendance-timezone-runtime.cjs')
const originalRuntimeFactory = runtimeModule.createAttendanceTimezoneRuntime
const verifyTimezoneSource = vi.fn(async () => {})
const prepareTimezoneSource = vi.fn(async (_trx: unknown, input: { orgId: string }) => {
  expect(input.orgId).toBeTruthy()
  return verifyTimezoneSource
})
runtimeModule.createAttendanceTimezoneRuntime = (deps: unknown) => ({
  ...originalRuntimeFactory(deps),
  prepareSourceChange: prepareTimezoneSource,
})
delete require.cache[require.resolve('../../../../plugins/plugin-attendance/index.cjs')]
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs') as {
  activate: (context: unknown) => Promise<void>
  deactivate: () => Promise<void>
  resetAttendanceSettingsCacheForTests?: () => void
  __attendanceGroupFixedScheduleForTests: {
    applyAttendanceGroupFixedSchedule: (db: unknown, input: Record<string, unknown>) => Promise<any>
    rebuildAttendanceGroupFixedSchedule: (db: unknown, input: Record<string, unknown>) => Promise<any>
    buildAttendanceGroupFixedScheduleProducerKey: (input: { groupId: string; shiftId: string; startDate: string; endDate: string | null }) => string
    runAttendanceGroupFixedScheduleTransaction: (db: unknown, operation: (trx: unknown) => Promise<any>) => Promise<any>
  }
}

runtimeModule.createAttendanceTimezoneRuntime = originalRuntimeFactory

beforeAll(async () => {
  await attendancePlugin.activate({
    api: {
      database: { query: async () => [] },
      http: { addRoute: vi.fn() }, events: { emit: vi.fn() },
    },
    services: { attendanceW4SegmentCalculation: {} },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  })
})
afterAll(async () => {
  try { await attendancePlugin.deactivate() }
  finally {
    const key = require.resolve('../../../../plugins/plugin-attendance/index.cjs')
    if (require.cache[key]?.exports === attendancePlugin) delete require.cache[key]
  }
})


class FakeHttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

const service = configServiceLib.createAttendanceGroupFixedScheduleConfigService({ HttpError: FakeHttpError })
const seam = attendancePlugin.__attendanceGroupFixedScheduleForTests
const attendancePluginSource = readFileSync(
  new URL('../../../../plugins/plugin-attendance/index.cjs', import.meta.url),
  'utf8',
)

const orgId = 'org-a'
const groupId = randomUUID()
const shiftId = randomUUID()
const candidate = {
  orgId,
  groupId,
  shiftId,
  startDate: '2026-08-01',
  endDate: '2026-08-31',
  updatedBy: 'admin-1',
}

function configRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    org_id: orgId,
    group_id: groupId,
    shift_id: shiftId,
    start_date: '2026-08-01',
    end_date: '2026-08-31',
    revision: 2,
    updated_by: 'admin-1',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

type FakeTrx = {
  query: ReturnType<typeof vi.fn>
  statements: string[]
}

// Script-driven fake trx: each entry matches a statement substring and returns rows.
function makeTrx(script: Array<{ match: string; rows: unknown[] }>): FakeTrx {
  const statements: string[] = []
  const queue = [...script]
  const query = vi.fn(async (text: string) => {
    statements.push(text)
    const index = queue.findIndex(entry => text.includes(entry.match))
    if (index === -1) throw new Error(`unexpected statement: ${text}`)
    const [entry] = queue.splice(index, 1)
    return entry.rows
  })
  return { query, statements }
}

function validationScript() {
  return [
    { match: 'SELECT id FROM attendance_groups', rows: [{ id: groupId }] },
    { match: 'SELECT id FROM attendance_shifts', rows: [{ id: shiftId }] },
    { match: 'FROM attendance_group_members', rows: [{ present: 1 }] },
  ]
}

describe('attendance group fixed-schedule config consumption (unit)', () => {
  it('creates the desired config atomically when none exists and reloads the winner FOR UPDATE', async () => {
    const winner = configRow({ revision: 1 })
    const trx = makeTrx([
      ...validationScript(),
      { match: 'FROM attendance_group_fixed_schedule_configs', rows: [] },
      { match: 'INSERT INTO attendance_group_fixed_schedule_configs', rows: [{ id: winner.id }] },
      { match: 'FROM attendance_group_fixed_schedule_configs', rows: [winner] },
    ])

    const result = await service.resolveConfigForApplyRebuild(trx, candidate)

    expect(result.created).toBe(true)
    expect(result.config).toMatchObject({ shiftId, startDate: '2026-08-01', endDate: '2026-08-31', revision: 1 })
    const insertIndex = trx.statements.findIndex(statement => statement.includes('INSERT INTO attendance_group_fixed_schedule_configs'))
    const membersIndex = trx.statements.findIndex(statement => statement.includes('FROM attendance_group_members'))
    const winnerSelect = trx.statements[trx.statements.length - 1]
    // Mutation proof: validating after the config insert, or reloading without FOR
    // UPDATE, reds this case.
    expect(membersIndex).toBeGreaterThanOrEqual(0)
    expect(insertIndex).toBeGreaterThan(membersIndex)
    expect(winnerSelect).toContain('FOR UPDATE')
    expect(trx.statements.filter(statement => statement.includes('ON CONFLICT (org_id, group_id) DO NOTHING'))).toHaveLength(1)
  })

  it('lets an identical concurrent first-create candidate continue without its own insert', async () => {
    const winner = configRow({ revision: 1 })
    const trx = makeTrx([
      ...validationScript(),
      { match: 'FROM attendance_group_fixed_schedule_configs', rows: [] },
      // ON CONFLICT DO NOTHING lost the race: no row returned.
      { match: 'INSERT INTO attendance_group_fixed_schedule_configs', rows: [] },
      { match: 'FROM attendance_group_fixed_schedule_configs', rows: [winner] },
    ])

    const result = await service.resolveConfigForApplyRebuild(trx, candidate)

    expect(result.created).toBe(false)
    expect(result.config.revision).toBe(1)
  })

  it('returns the typed 409 when the concurrent winner holds a different candidate', async () => {
    const winner = configRow({ revision: 1, shift_id: randomUUID() })
    const trx = makeTrx([
      ...validationScript(),
      { match: 'FROM attendance_group_fixed_schedule_configs', rows: [] },
      { match: 'INSERT INTO attendance_group_fixed_schedule_configs', rows: [] },
      { match: 'FROM attendance_group_fixed_schedule_configs', rows: [winner] },
    ])

    await expect(service.resolveConfigForApplyRebuild(trx, candidate))
      .rejects.toMatchObject({ status: 409, code: configServiceLib.ATTENDANCE_FIXED_SCHEDULE_CONFIG_CHANGED })
    expect(trx.statements.some(statement => statement.includes('attendance_shift_assignments'))).toBe(false)
  })

  it('accepts a matching expectedConfigRevision against an existing config without any write', async () => {
    const trx = makeTrx([
      ...validationScript(),
      { match: 'FROM attendance_group_fixed_schedule_configs', rows: [configRow()] },
    ])

    const result = await service.resolveConfigForApplyRebuild(trx, { ...candidate, expectedConfigRevision: 2 })

    expect(result).toMatchObject({ created: false, config: { revision: 2 } })
    const configSelect = trx.statements.find(statement => statement.includes('FROM attendance_group_fixed_schedule_configs'))
    expect(configSelect).toContain('FOR UPDATE')
    expect(trx.statements.some(statement => /^\s*(INSERT|UPDATE|DELETE)/i.test(statement))).toBe(false)
  })

  it('rejects a stale expectedConfigRevision with the typed 409 and zero writes', async () => {
    const trx = makeTrx([
      ...validationScript(),
      { match: 'FROM attendance_group_fixed_schedule_configs', rows: [configRow()] },
    ])

    await expect(service.resolveConfigForApplyRebuild(trx, { ...candidate, expectedConfigRevision: 1 }))
      .rejects.toMatchObject({ status: 409, code: configServiceLib.ATTENDANCE_FIXED_SCHEDULE_CONFIG_CHANGED })
    expect(trx.statements.some(statement => /^\s*(INSERT|UPDATE|DELETE)/i.test(statement))).toBe(false)
  })

  it('accepts a legacy candidate whose three values equal the locked config row', async () => {
    const trx = makeTrx([
      ...validationScript(),
      { match: 'FROM attendance_group_fixed_schedule_configs', rows: [configRow()] },
    ])

    const result = await service.resolveConfigForApplyRebuild(trx, candidate)

    expect(result.created).toBe(false)
    expect(trx.statements.some(statement => /^\s*(INSERT|UPDATE|DELETE)/i.test(statement))).toBe(false)
  })

  it.each(['shiftId', 'startDate', 'endDate'])('rejects a legacy candidate with a mismatched %s', async (field) => {
    const mismatched = {
      ...candidate,
      [field]: field === 'shiftId'
        ? randomUUID()
        : field === 'startDate'
          ? '2026-07-31'
          : '2026-09-01',
    }
    const trx = makeTrx([
      ...validationScript(),
      { match: 'FROM attendance_group_fixed_schedule_configs', rows: [configRow()] },
    ])

    await expect(service.resolveConfigForApplyRebuild(trx, mismatched))
      .rejects.toMatchObject({ status: 409, code: configServiceLib.ATTENDANCE_FIXED_SCHEDULE_CONFIG_CHANGED })
    expect(trx.statements.some(statement => /^\s*(INSERT|UPDATE|DELETE)/i.test(statement))).toBe(false)
  })

  it('rejects an inverted date window before any config statement', async () => {
    const trx = makeTrx([])

    await expect(service.resolveConfigForApplyRebuild(trx, { ...candidate, startDate: '2026-09-01' }))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' })
    expect(trx.statements).toHaveLength(0)
  })

  it('rejects a missing group before any config statement', async () => {
    const trx = makeTrx([{ match: 'SELECT id FROM attendance_groups', rows: [] }])

    await expect(service.resolveConfigForApplyRebuild(trx, candidate))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(trx.statements).toHaveLength(1)
  })

  it('rejects a missing shift before any config statement', async () => {
    const trx = makeTrx([
      { match: 'SELECT id FROM attendance_groups', rows: [{ id: groupId }] },
      { match: 'FROM attendance_group_fixed_schedule_configs', rows: [] },
      { match: 'SELECT id FROM attendance_shifts', rows: [] },
    ])

    await expect(service.resolveConfigForApplyRebuild(trx, candidate))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(trx.statements.some(statement => statement.includes('INSERT INTO attendance_group_fixed_schedule_configs'))).toBe(false)
  })

  it('rejects an empty target set before the config insert', async () => {
    const trx = makeTrx([
      { match: 'SELECT id FROM attendance_groups', rows: [{ id: groupId }] },
      { match: 'FROM attendance_group_fixed_schedule_configs', rows: [] },
      { match: 'SELECT id FROM attendance_shifts', rows: [{ id: shiftId }] },
      { match: 'FROM attendance_group_members', rows: [] },
    ])

    await expect(service.resolveConfigForApplyRebuild(trx, candidate))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' })
    expect(trx.statements.some(statement => statement.includes('INSERT INTO attendance_group_fixed_schedule_configs'))).toBe(false)
  })
})

// Full apply/rebuild write paths through the plugin seam with a statement-matching
// fake db. Proves FSER-3 orchestration: the config row is locked before any per-user
// advisory target lock, materialization uses the canonical producer-key builder, and
// the successful response keeps its pre-FSER-3 shape.
describe('attendance group fixed-schedule apply/rebuild config consumption (unit seam)', () => {
  const APPLY_RESPONSE_KEYS = [
    'applied',
    'blockingConflicts',
    'created',
    'group',
    'shift',
    'skipped',
    'skippedManaged',
    'skippedExternalManaged',
    'skippedUnmanaged',
    'target',
    'window',
    'wouldCreate',
  ]

  function makeApplyDb({ lockedConfig, concurrentWinner }: { lockedConfig: Record<string, unknown> | null; concurrentWinner?: Record<string, unknown> | null }) {
    const statements: string[] = []
    const insertedAssignments: unknown[][] = []
    let configSelects = 0
    const db = {
      statements,
      insertedAssignments,
      async query(text: string, params?: unknown[]) {
        statements.push(text)
        if (text.includes('INSERT INTO attendance_group_fixed_schedule_configs')) {
          return concurrentWinner === undefined ? [{ id: randomUUID() }] : []
        }
        if (text.includes('FROM attendance_group_fixed_schedule_configs')) {
          configSelects += 1
          if (lockedConfig) return [lockedConfig]
          if (configSelects === 1) return []
          return [concurrentWinner ?? configRow({ revision: 1 })]
        }
        if (text.includes('SELECT id FROM attendance_groups')) return [{ id: groupId }]
        if (text.includes('SELECT * FROM attendance_groups')) {
          return [{ id: groupId, org_id: orgId, name: 'Group' }]
        }
        if (text.includes('FROM attendance_shifts') && text.includes('FOR SHARE')) return [{ id: shiftId }]
        if (text.includes('FROM attendance_shift_segments')) return [{ total: 0 }]
        if (text.includes('SELECT 1 AS present FROM attendance_group_members')) return [{ present: 1 }]
        if (text.includes('SELECT DISTINCT user_id')) return [{ user_id: 'member-a' }]
        if (text.includes('SELECT * FROM attendance_shifts')) {
          return [{ id: shiftId, org_id: orgId, name: 'Shift', work_start_time: '09:00', work_end_time: '17:00', is_overnight: false }]
        }
        if (text.includes('pg_advisory_xact_lock')) return []
        if (text.includes('FROM system_configs')) return []
        if (text.includes('INSERT INTO attendance_shift_assignments')) {
          insertedAssignments.push(params ?? [])
          return [{
            id: randomUUID(),
            org_id: orgId,
            user_id: 'member-a',
            shift_id: shiftId,
            slot_index: 0,
            start_date: candidate.startDate,
            end_date: candidate.endDate,
            is_active: true,
            publish_status: 'published',
            producer_type: 'attendance_group_fixed_schedule',
            producer_ref_id: groupId,
            producer_key: params?.[8],
            producer_run_id: params?.[9],
          }]
        }
        if (text.includes('FROM attendance_shift_assignments')) return []
        if (text.includes('UPDATE attendance_shift_assignments')) return []
        if (text.includes('FROM attendance_rotation_assignments')) return []
        throw new Error(`unexpected statement: ${text}`)
      },
    }
    return db
  }

  function configLockIndex(statements: string[]) {
    return statements.findIndex(statement => statement.includes('FROM attendance_group_fixed_schedule_configs') && statement.includes('FOR UPDATE'))
  }

  function firstTargetLockIndex(statements: string[]) {
    return statements.findIndex(statement => statement.includes('pg_advisory_xact_lock'))
  }

  beforeEach(() => {
    attendancePlugin.resetAttendanceSettingsCacheForTests?.()
  })

  it('rolls back staged writes when an apply/rebuild operation returns a business error', async () => {
    const committed: string[] = []
    const db = {
      async transaction(operation: (trx: { write: (value: string) => void }) => Promise<unknown>) {
        const staged: string[] = []
        const result = await operation({ write: value => staged.push(value) })
        committed.push(...staged)
        return result
      },
    }

    await expect(seam.runAttendanceGroupFixedScheduleTransaction(db, async (trx: any) => {
      trx.write('config')
      return {
        ok: false,
        status: 409,
        code: 'ATTENDANCE_GROUP_FIXED_SCHEDULE_BLOCKING_CONFLICT',
        message: 'Fixed schedule apply has blocking conflicts',
      }
    })).rejects.toMatchObject({
      result: {
        status: 409,
        code: 'ATTENDANCE_GROUP_FIXED_SCHEDULE_BLOCKING_CONFLICT',
      },
    })
    expect(committed).toEqual([])
  })

  it('keeps producer metadata wired to the canonical producer-key builder', () => {
    const start = attendancePluginSource.indexOf('function buildAttendanceGroupFixedScheduleProducerMetadata')
    const end = attendancePluginSource.indexOf('\n}', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(attendancePluginSource.slice(start, end)).toContain(
      'producerKey: buildAttendanceGroupFixedScheduleProducerKey(input)',
    )
  })

  it('apply with a matching configured candidate keeps the response shape, canonical key, and lock order', async () => {
    const db = makeApplyDb({ lockedConfig: configRow() })

    const result = await seam.applyAttendanceGroupFixedSchedule(db, { ...candidate, expectedConfigRevision: 2 })

    expect(result.ok).toBe(true)
    // Byte-compatible response shape: exactly the pre-FSER-3 key set.
    expect(Object.keys(result.data).sort()).toEqual([...APPLY_RESPONSE_KEYS].sort())
    expect(result.data.applied).toBe(true)
    expect(result.data.window).toEqual({ startDate: candidate.startDate, endDate: candidate.endDate })
    expect(result.data.shift.id).toBe(shiftId)
    expect(result.data.created).toHaveLength(1)
    // Canonical producer-key parity: the inserted row key is the canonical builder output.
    const canonicalKey = seam.buildAttendanceGroupFixedScheduleProducerKey({
      groupId,
      shiftId,
      startDate: candidate.startDate,
      endDate: candidate.endDate,
    })
    expect(db.insertedAssignments).toHaveLength(1)
    expect(db.insertedAssignments[0]?.[8]).toBe(canonicalKey)
    // Lock order: config FOR UPDATE strictly before the first per-user target lock.
    // Mutation proof: resolving the config after buildPlan(lockTargets) reds this.
    expect(configLockIndex(db.statements)).toBeGreaterThanOrEqual(0)
    expect(firstTargetLockIndex(db.statements)).toBeGreaterThan(configLockIndex(db.statements))
    // Existing config: no first-create insert was issued.
    expect(db.statements.some(statement => statement.includes('INSERT INTO attendance_group_fixed_schedule_configs'))).toBe(false)
  })

  it('apply with a stale revision returns the typed 409 before any target lock or write', async () => {
    const db = makeApplyDb({ lockedConfig: configRow() })

    await expect(seam.applyAttendanceGroupFixedSchedule(db, { ...candidate, expectedConfigRevision: 1 }))
      .rejects.toMatchObject({ status: 409, code: configServiceLib.ATTENDANCE_FIXED_SCHEDULE_CONFIG_CHANGED })
    expect(firstTargetLockIndex(db.statements)).toBe(-1)
    expect(db.insertedAssignments).toHaveLength(0)
    expect(db.statements.some(statement => /^\s*(INSERT|UPDATE|DELETE)/i.test(statement))).toBe(false)
  })

  it('apply with a legacy candidate value mismatch returns the typed 409 with zero writes', async () => {
    const db = makeApplyDb({ lockedConfig: configRow() })

    await expect(seam.applyAttendanceGroupFixedSchedule(db, { ...candidate, endDate: '2026-09-30' }))
      .rejects.toMatchObject({ status: 409, code: configServiceLib.ATTENDANCE_FIXED_SCHEDULE_CONFIG_CHANGED })
    expect(firstTargetLockIndex(db.statements)).toBe(-1)
    expect(db.insertedAssignments).toHaveLength(0)
    expect(db.statements.some(statement => /^\s*(INSERT|UPDATE|DELETE)/i.test(statement))).toBe(false)
  })

  it('apply with no existing config first-creates it inside the same path and then applies', async () => {
    const db = makeApplyDb({ lockedConfig: null })

    const result = await seam.applyAttendanceGroupFixedSchedule(db, candidate)

    expect(result.ok).toBe(true)
    expect(result.data.created).toHaveLength(1)
    const insertIndex = db.statements.findIndex(statement => statement.includes('INSERT INTO attendance_group_fixed_schedule_configs'))
    expect(insertIndex).toBeGreaterThanOrEqual(0)
    expect(insertIndex).toBeLessThan(firstTargetLockIndex(db.statements))
  })

  it('rebuild with a matching configured candidate keeps canonical key semantics and lock order', async () => {
    const db = makeApplyDb({ lockedConfig: configRow() })

    const result = await seam.rebuildAttendanceGroupFixedSchedule(db, { ...candidate, expectedConfigRevision: 2 })

    expect(result.ok).toBe(true)
    expect(result.data.rebuilt).toBe(true)
    const canonicalKey = seam.buildAttendanceGroupFixedScheduleProducerKey({
      groupId,
      shiftId,
      startDate: candidate.startDate,
      endDate: candidate.endDate,
    })
    expect(db.insertedAssignments[0]?.[8]).toBe(canonicalKey)
    expect(configLockIndex(db.statements)).toBeGreaterThanOrEqual(0)
    expect(firstTargetLockIndex(db.statements)).toBeGreaterThan(configLockIndex(db.statements))
    expect(db.statements.some(statement => statement.includes('INSERT INTO attendance_group_fixed_schedule_configs'))).toBe(false)
  })

  it('rebuild with a stale revision returns the typed 409 with zero assignment or config mutation', async () => {
    const db = makeApplyDb({ lockedConfig: configRow() })

    await expect(seam.rebuildAttendanceGroupFixedSchedule(db, { ...candidate, expectedConfigRevision: 99 }))
      .rejects.toMatchObject({ status: 409, code: configServiceLib.ATTENDANCE_FIXED_SCHEDULE_CONFIG_CHANGED })
    expect(firstTargetLockIndex(db.statements)).toBe(-1)
    expect(db.statements.some(statement => /^\s*(INSERT|UPDATE|DELETE)/i.test(statement))).toBe(false)
  })
})


describe('fixed-schedule desired config save compare-and-swap', () => {
  function saveTrx(existing: Record<string, unknown> | null, inserted = true) {
    return makeTrx([
      { match: 'SELECT id FROM attendance_groups', rows: [{ id: groupId }] },
      { match: 'FROM attendance_group_fixed_schedule_configs', rows: existing ? [existing] : [] },
      { match: 'SELECT id FROM attendance_shifts', rows: [{ id: shiftId }] },
      { match: 'INSERT INTO attendance_group_fixed_schedule_configs', rows: inserted ? [configRow({ revision: existing ? 3 : 1 })] : [] },
    ])
  }

  it.each([
    { existing: configRow(), expectedConfigRevision: 0 },
    { existing: configRow(), expectedConfigRevision: 1 },
    { existing: null, expectedConfigRevision: 2 },
  ])('rejects stale save expectations before any DML: $expectedConfigRevision', async ({ existing, expectedConfigRevision }) => {
    const trx = saveTrx(existing)
    await expect(service.upsertConfig(trx, { ...candidate, expectedConfigRevision }))
      .rejects.toMatchObject({ status: 409, code: configServiceLib.ATTENDANCE_FIXED_SCHEDULE_CONFIG_CHANGED })
    expect(trx.statements.some(statement => /^\s*(INSERT|UPDATE|DELETE)/i.test(statement))).toBe(false)
  })

  it('first-saves only while absent and never overwrites a concurrent winner', async () => {
    const trx = saveTrx(null, false)
    await expect(service.upsertConfig(trx, { ...candidate, expectedConfigRevision: 0 }))
      .rejects.toMatchObject({ status: 409, code: configServiceLib.ATTENDANCE_FIXED_SCHEDULE_CONFIG_CHANGED })
    expect(trx.statements.at(-1)).toContain('ON CONFLICT (org_id, group_id) DO NOTHING')
  })

  it('locks the matching config before the shift and preserves the legacy upsert semantics', async () => {
    const trx = saveTrx(configRow())
    const result = await service.upsertConfig(trx, { ...candidate, expectedConfigRevision: 2 })
    expect(result.revision).toBe(3)
    expect(trx.statements[1]).toContain('FOR UPDATE')
    expect(trx.statements[2]).toContain('FOR SHARE')
    expect(trx.statements[3]).toContain('DO UPDATE')
  })

  it.each([-1, 0.5, null, '2', Number.MAX_SAFE_INTEGER + 1])('rejects invalid expected revision %s before config SQL', async (expectedConfigRevision) => {
    const trx = saveTrx(null)
    await expect(service.upsertConfig(trx, { ...candidate, expectedConfigRevision }))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' })
    expect(trx.statements).toHaveLength(1)
  })
})

describe('fixed-schedule editor projection', () => {
  const editorLib = require('../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-editor-service.cjs')
  const desired = { shiftId, startDate: candidate.startDate, endDate: candidate.endDate, revision: 2 }
  const managedSets = [{ shiftId, startDate: candidate.startDate, endDate: candidate.endDate, producerKey: 'old', rowCount: 1 }]

  function editorHarness(segmentCount: unknown, referenceSegments: unknown, storedDesired: unknown = desired) {
    const getEffectiveness = vi.fn(async () => ({
      groupId, state: 'configuration_changed', reasonCodes: ['DIFFERENT_MANAGED_KEY_ACTIVE'], desired: storedDesired,
      coverage: { targetMembers: 1 }, drift: { managedSets, unpublishedManagedRows: 0 }, evaluatedAt: 'now',
    }))
    const resolveReferenceSegments = vi.fn(async () => referenceSegments)
    const trx = { query: vi.fn(async (sql: string, _params?: unknown[]) => sql.includes('COUNT(*)') ? [{ total: segmentCount }] : [{ id: shiftId }]) }
    const editor = editorLib.createAttendanceGroupFixedScheduleEditorService({ HttpError: FakeHttpError, getEffectiveness, resolveReferenceSegments })
    return { editor, trx, getEffectiveness, resolveReferenceSegments }
  }

  it.each([
    { count: 0, posture: false, allowed: true },
    { count: 1, posture: false, allowed: true },
    { count: 2, posture: false, allowed: false },
    { count: 2, posture: true, allowed: true },
    { count: 2, posture: 'true', allowed: false },
  ])('projects strict persisted segment eligibility $count / $posture', async ({ count, posture, allowed }) => {
    const { editor, trx, resolveReferenceSegments } = editorHarness(count, posture)
    const result = await editor.getEditor(trx, { orgId, groupId })
    expect(result).toEqual({
      groupId, state: 'configuration_changed', reasonCodes: ['DIFFERENT_MANAGED_KEY_ACTIVE'], desired,
      drift: { managedSets }, referenceEligibility: { shiftId, allowed, reasonCode: allowed ? null : 'ATTENDANCE_SHIFT_MULTI_SEGMENT_CALCULATION_DISABLED' },
    })
    expect(resolveReferenceSegments).toHaveBeenCalledWith(trx, orgId)
    expect(trx.query.mock.calls[0][0]).toContain('FOR SHARE')
    expect(resolveReferenceSegments.mock.invocationCallOrder[0]).toBeLessThan(trx.query.mock.invocationCallOrder[0])
  })

  it('uses the selected candidate without replacing saved desired or old managed sets', async () => {
    const selected = randomUUID()
    const { editor, trx } = editorHarness(2, false)
    const result = await editor.getEditor(trx, { orgId, groupId, shiftId: selected })
    expect(result.desired).toEqual(desired)
    expect(result.drift).toEqual({ managedSets })
    expect(result.referenceEligibility.shiftId).toBe(selected)
    expect(trx.query.mock.calls[0][1]).toEqual([selected, orgId])
  })

  it('returns null eligibility for an unconfigured group without a candidate', async () => {
    const { editor, trx, resolveReferenceSegments } = editorHarness(0, false, null)
    const result = await editor.getEditor(trx, { orgId, groupId })
    expect(result.referenceEligibility).toBeNull()
    expect(trx.query).not.toHaveBeenCalled()
    expect(resolveReferenceSegments).not.toHaveBeenCalled()
  })

  it.each([null, -1, 1.5, 'unreadable'])('fails unreadable persisted count %s closed', async (count) => {
    const { editor, trx } = editorHarness(count, true)
    await expect(editor.getEditor(trx, { orgId, groupId })).rejects.toMatchObject({ status: 503, code: 'ATTENDANCE_FIXED_SCHEDULE_EDITOR_UNAVAILABLE' })
  })

  it.each(['segments', 'posture'])('returns 503 for unreadable %s', async (failure) => {
    const { editor, trx, resolveReferenceSegments } = editorHarness(2, true)
    if (failure === 'segments') trx.query.mockImplementation(async (sql: string) => { if (sql.includes('COUNT(*)')) throw new Error('schema unavailable'); return [{ id: shiftId }] })
    else resolveReferenceSegments.mockRejectedValue(new Error('policy unavailable'))
    await expect(editor.getEditor(trx, { orgId, groupId })).rejects.toMatchObject({ status: 503 })
  })
})
