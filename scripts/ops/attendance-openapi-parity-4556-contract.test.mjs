#!/usr/bin/env node
/**
 * OpenAPI parity contract for attendance low-risk slice (#4556).
 *
 * Parses source YAML structurally (not string grep) and fails if required fields
 * or enums disappear or drift from the runtime-aligned contract:
 * - AttendanceGroup: attendanceType enum + memberCount integer
 * - Group POST/PUT request: optional attendanceType with the same enum
 * - Shift PUT request: isOvernight boolean
 * - AttendanceShiftAssignment + assignment POST/PUT: slotIndex (0..2) and
 *   legacy slot_index where runtime accepts/returns it (response legacy deprecated)
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const basePath = path.join(rootDir, 'packages/openapi/src/base.yml')
const attendancePath = path.join(rootDir, 'packages/openapi/src/paths/attendance.yml')

const ATTENDANCE_GROUP_TYPES = ['fixed_shift', 'scheduled_shift', 'free_time']

function resolveYamlModule() {
  const candidates = [
    'js-yaml',
    path.join(rootDir, 'node_modules/js-yaml'),
    path.join(rootDir, 'packages/openapi/node_modules/js-yaml'),
    // Partial installs may leave the package under pnpm's .ignored tree.
    path.join(rootDir, 'packages/openapi/node_modules/.ignored/js-yaml'),
  ]
  const errors = []
  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch (error) {
      errors.push(`${candidate}: ${error?.message || error}`)
    }
  }
  throw new Error(`Unable to resolve js-yaml for YAML structural parse.\n${errors.join('\n')}`)
}

const yaml = resolveYamlModule()

function loadYaml(filePath) {
  assert.ok(fs.existsSync(filePath), `missing YAML file: ${filePath}`)
  return yaml.load(fs.readFileSync(filePath, 'utf8'))
}

function requireSchema(doc, name) {
  const schema = doc?.components?.schemas?.[name]
  assert.ok(schema && typeof schema === 'object', `missing components.schemas.${name}`)
  return schema
}

function requireProperty(schema, name, context) {
  const prop = schema?.properties?.[name]
  assert.ok(prop && typeof prop === 'object', `${context} missing property: ${name}`)
  return prop
}

function assertEnumExact(prop, expected, context) {
  assert.equal(prop.type, 'string', `${context} must be type string`)
  assert.ok(Array.isArray(prop.enum), `${context} must declare enum`)
  assert.deepEqual(prop.enum, expected, `${context} enum drifted`)
}

function assertSlotIndex(prop, context) {
  assert.equal(prop.type, 'integer', `${context} must be type integer`)
  assert.equal(prop.minimum, 0, `${context} must have minimum: 0`)
  assert.equal(prop.maximum, 2, `${context} must have maximum: 2`)
}

function requestBodySchema(pathsDoc, apiPath, method) {
  const op = pathsDoc?.paths?.[apiPath]?.[method]
  assert.ok(op && typeof op === 'object', `missing path ${method.toUpperCase()} ${apiPath}`)
  const schema = op?.requestBody?.content?.['application/json']?.schema
  assert.ok(schema && typeof schema === 'object', `${method.toUpperCase()} ${apiPath} missing JSON request schema`)
  return schema
}

test('AttendanceGroup response schema includes attendanceType enum and memberCount', () => {
  const base = loadYaml(basePath)
  const group = requireSchema(base, 'AttendanceGroup')

  const attendanceType = requireProperty(group, 'attendanceType', 'AttendanceGroup')
  assertEnumExact(attendanceType, ATTENDANCE_GROUP_TYPES, 'AttendanceGroup.attendanceType')

  const memberCount = requireProperty(group, 'memberCount', 'AttendanceGroup')
  assert.equal(memberCount.type, 'integer', 'AttendanceGroup.memberCount must be integer')

  const legacyAttendanceType = requireProperty(group, 'attendance_type', 'AttendanceGroup')
  assertEnumExact(legacyAttendanceType, ATTENDANCE_GROUP_TYPES, 'AttendanceGroup.attendance_type')
  assert.equal(legacyAttendanceType.deprecated, true, 'AttendanceGroup.attendance_type must be deprecated')

  const legacyMemberCount = requireProperty(group, 'member_count', 'AttendanceGroup')
  assert.equal(legacyMemberCount.type, 'integer', 'AttendanceGroup.member_count must be integer')
  assert.equal(legacyMemberCount.deprecated, true, 'AttendanceGroup.member_count must be deprecated')
})

test('group POST/PUT request schemas include optional attendanceType enum (not invented required)', () => {
  const attendance = loadYaml(attendancePath)

  for (const [apiPath, method] of [
    ['/api/attendance/groups', 'post'],
    ['/api/attendance/groups/{id}', 'put'],
  ]) {
    const schema = requestBodySchema(attendance, apiPath, method)
    const attendanceType = requireProperty(schema, 'attendanceType', `${method.toUpperCase()} ${apiPath}`)
    assertEnumExact(attendanceType, ATTENDANCE_GROUP_TYPES, `${method.toUpperCase()} ${apiPath} attendanceType`)

    const required = Array.isArray(schema.required) ? schema.required : []
    assert.ok(
      !required.includes('attendanceType'),
      `${method.toUpperCase()} ${apiPath} must not invent required attendanceType`,
    )
  }

  // Preserve existing create required fields; do not invent new ones.
  const createSchema = requestBodySchema(attendance, '/api/attendance/groups', 'post')
  assert.deepEqual(
    createSchema.required,
    ['name', 'timezone'],
    'POST /api/attendance/groups required list drifted',
  )
})

test('shift PUT request schema includes isOvernight', () => {
  const attendance = loadYaml(attendancePath)
  const schema = requestBodySchema(attendance, '/api/attendance/shifts/{id}', 'put')
  const isOvernight = requireProperty(schema, 'isOvernight', 'PUT /api/attendance/shifts/{id}')
  assert.equal(isOvernight.type, 'boolean', 'PUT shift isOvernight must be boolean')
})

test('AttendanceShiftAssignment schema includes slotIndex min 0 and deprecated slot_index', () => {
  const base = loadYaml(basePath)
  const assignment = requireSchema(base, 'AttendanceShiftAssignment')

  const slotIndex = requireProperty(assignment, 'slotIndex', 'AttendanceShiftAssignment')
  assertSlotIndex(slotIndex, 'AttendanceShiftAssignment.slotIndex')

  const legacy = requireProperty(assignment, 'slot_index', 'AttendanceShiftAssignment')
  assertSlotIndex(legacy, 'AttendanceShiftAssignment.slot_index')
  assert.equal(legacy.deprecated, true, 'AttendanceShiftAssignment.slot_index must be deprecated')
})

test('assignment POST/PUT request schemas include slotIndex min 0 and legacy slot_index', () => {
  const attendance = loadYaml(attendancePath)

  for (const [apiPath, method] of [
    ['/api/attendance/assignments', 'post'],
    ['/api/attendance/assignments/{id}', 'put'],
  ]) {
    const schema = requestBodySchema(attendance, apiPath, method)
    const slotIndex = requireProperty(schema, 'slotIndex', `${method.toUpperCase()} ${apiPath}`)
    assertSlotIndex(slotIndex, `${method.toUpperCase()} ${apiPath} slotIndex`)

    const legacy = requireProperty(schema, 'slot_index', `${method.toUpperCase()} ${apiPath}`)
    assertSlotIndex(legacy, `${method.toUpperCase()} ${apiPath} slot_index`)
  }

  // Create still requires the original identity fields only.
  const createSchema = requestBodySchema(attendance, '/api/attendance/assignments', 'post')
  assert.deepEqual(
    createSchema.required,
    ['userId', 'shiftId', 'startDate'],
    'POST /api/attendance/assignments required list drifted',
  )
  assert.ok(
    !(createSchema.required || []).includes('slotIndex'),
    'POST assignment must not invent required slotIndex',
  )
})

test('W1 calculation-group membership schema exposes effective dates and durable audit context', () => {
  const base = loadYaml(basePath)
  const membership = requireSchema(base, 'AttendanceCalculationGroupMembership')
  const required = membership.required || []
  assert.deepEqual(
    required,
    [
      'id',
      'orgId',
      'userId',
      'groupId',
      'effectiveFrom',
      'effectiveTo',
      'assignedBy',
      'assignedReason',
      'assignedCorrelationId',
      'closedBy',
      'closedReason',
      'closedCorrelationId',
      'createdAt',
      'updatedAt',
    ],
    'AttendanceCalculationGroupMembership required fields drifted',
  )
  assert.equal(
    requireProperty(membership, 'effectiveFrom', 'AttendanceCalculationGroupMembership').format,
    'date',
  )
  assert.equal(
    requireProperty(membership, 'effectiveTo', 'AttendanceCalculationGroupMembership').nullable,
    true,
  )
})

test('W1 admin API exposes only timeline GET and atomic transition POST', () => {
  const attendance = loadYaml(attendancePath)
  const list = attendance.paths?.['/api/attendance-admin/calculation-group-memberships']
  const transition =
    attendance.paths?.['/api/attendance-admin/calculation-group-memberships/transition']
  assert.deepEqual(Object.keys(list || {}), ['get'], 'W1 timeline path method surface drifted')
  assert.deepEqual(
    Object.keys(transition || {}),
    ['post'],
    'W1 transition path method surface drifted',
  )

  const listParameters = list.get.parameters || []
  assert.deepEqual(
    listParameters.map((parameter) => [parameter.name, parameter.required]),
    [
      ['orgId', true],
      ['userId', true],
    ],
  )

  const transitionSchema = requestBodySchema(
    attendance,
    '/api/attendance-admin/calculation-group-memberships/transition',
    'post',
  )
  assert.deepEqual(
    transitionSchema.required,
    ['orgId', 'userId', 'targetGroupId', 'effectiveOn', 'reason'],
  )
  assert.equal(transitionSchema.properties.targetGroupId.format, 'uuid')
  assert.equal(transitionSchema.properties.effectiveOn.format, 'date')
  assert.equal(transitionSchema.properties.reason.minLength, 1)
  assert.equal(transitionSchema.properties.correlationId.maxLength, 128)
  assert.equal(
    Object.prototype.hasOwnProperty.call(transitionSchema.properties, 'actorId'),
    false,
    'actor identity must come from authentication, not the request body',
  )

  assert.deepEqual(
    Object.keys(list.get.responses).sort(),
    ['200', '400', '401', '403', '500', '503'],
    'timeline responses must cover every reachable route status',
  )
  assert.deepEqual(
    Object.keys(transition.post.responses).sort(),
    ['200', '400', '401', '403', '404', '409', '422', '500', '503'],
    'transition responses must cover every reachable route status',
  )
})

test('W3 AttendanceShift exposes segments, calculationMode, plannedMinutes, and capabilities', () => {
  const base = loadYaml(basePath)
  const shift = requireSchema(base, 'AttendanceShift')

  const segments = requireProperty(shift, 'segments', 'AttendanceShift')
  assert.equal(segments.type, 'array', 'AttendanceShift.segments must be an array')
  assert.equal(
    segments.items?.$ref,
    '#/components/schemas/AttendanceShiftSegment',
    'AttendanceShift.segments must reference AttendanceShiftSegment',
  )

  assertEnumExact(
    requireProperty(shift, 'calculationMode', 'AttendanceShift'),
    ['envelope', 'segments'],
    'AttendanceShift.calculationMode',
  )

  const plannedMinutes = requireProperty(shift, 'plannedMinutes', 'AttendanceShift')
  assert.equal(plannedMinutes.type, 'integer', 'AttendanceShift.plannedMinutes must be integer')

  const capabilities = requireProperty(shift, 'capabilities', 'AttendanceShift')
  assert.equal(
    capabilities.$ref,
    '#/components/schemas/AttendanceShiftCapabilities',
    'AttendanceShift.capabilities must reference AttendanceShiftCapabilities',
  )
})

test('W3 AttendanceShiftSegment schema carries day offsets with deprecated snake twins', () => {
  const base = loadYaml(basePath)
  const segment = requireSchema(base, 'AttendanceShiftSegment')

  const segmentIndex = requireProperty(segment, 'segmentIndex', 'AttendanceShiftSegment')
  assert.equal(segmentIndex.type, 'integer')
  assert.equal(segmentIndex.minimum, 0)
  assert.equal(segmentIndex.maximum, 2)
  assert.equal(requireProperty(segment, 'segment_index', 'AttendanceShiftSegment').deprecated, true)

  const startDayOffset = requireProperty(segment, 'startDayOffset', 'AttendanceShiftSegment')
  assert.deepEqual(startDayOffset.enum, [0], 'startDayOffset is fixed to 0 in v1')
  assert.equal(requireProperty(segment, 'start_day_offset', 'AttendanceShiftSegment').deprecated, true)

  const endDayOffset = requireProperty(segment, 'endDayOffset', 'AttendanceShiftSegment')
  assert.equal(endDayOffset.type, 'integer')
  assert.equal(endDayOffset.minimum, 0)
  assert.equal(endDayOffset.maximum, 1)
  assert.equal(requireProperty(segment, 'end_day_offset', 'AttendanceShiftSegment').deprecated, true)

  for (const twin of ['start_time', 'end_time']) {
    assert.equal(
      requireProperty(segment, twin, 'AttendanceShiftSegment').deprecated,
      true,
      `AttendanceShiftSegment.${twin} must be deprecated`,
    )
  }
})

test('W3 AttendanceShiftSegmentInput is strict and requires startTime/endTime', () => {
  const base = loadYaml(basePath)
  const input = requireSchema(base, 'AttendanceShiftSegmentInput')
  const strictTimePattern = '^(?:[01]\\d|2[0-3]):[0-5]\\d$'
  assert.equal(input.additionalProperties, false, 'unknown segment properties must be rejected')
  assert.deepEqual(input.required, ['startTime', 'endTime'])
  assert.equal(
    requireProperty(input, 'startTime', 'AttendanceShiftSegmentInput').pattern,
    strictTimePattern,
    'input startTime must describe the same strict HH:MM contract as runtime',
  )
  assert.equal(
    requireProperty(input, 'endTime', 'AttendanceShiftSegmentInput').pattern,
    strictTimePattern,
    'input endTime must describe the same strict HH:MM contract as runtime',
  )
  assert.deepEqual(
    requireProperty(input, 'startDayOffset', 'AttendanceShiftSegmentInput').enum,
    [0],
    'input startDayOffset is fixed to 0 in v1',
  )
  const endDayOffset = requireProperty(input, 'endDayOffset', 'AttendanceShiftSegmentInput')
  assert.equal(endDayOffset.minimum, 0)
  assert.equal(endDayOffset.maximum, 1)
})

test('W3 capabilities are values-safe and show authoritative segment calculation disabled by default', () => {
  const base = loadYaml(basePath)
  const capabilities = requireSchema(base, 'AttendanceShiftCapabilities')
  const segmentCalculation = requireProperty(capabilities, 'segmentCalculation', 'AttendanceShiftCapabilities')

  const defaultEnabled = requireProperty(segmentCalculation, 'defaultEnabled', 'segmentCalculation')
  assert.deepEqual(defaultEnabled.enum, [false], 'defaultEnabled must be pinned to false')

  const enabled = requireProperty(segmentCalculation, 'enabled', 'segmentCalculation')
  assert.equal(enabled.type, 'boolean')
  const authoritativeResults = requireProperty(segmentCalculation, 'authoritativeResults', 'segmentCalculation')
  assert.equal(authoritativeResults.type, 'boolean')

  assertEnumExact(
    requireProperty(segmentCalculation, 'multiSegmentAuthoring', 'segmentCalculation'),
    ['preview_only', 'enabled'],
    'segmentCalculation.multiSegmentAuthoring',
  )
  assertEnumExact(
    requireProperty(segmentCalculation, 'flag', 'segmentCalculation'),
    ['ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'],
    'segmentCalculation.flag',
  )

  // Values-safe: no org/member/user values leak through the capability block.
  for (const forbidden of ['orgId', 'org_id', 'userId', 'user_id', 'members', 'memberCount']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(segmentCalculation.properties ?? {}, forbidden),
      false,
      `segmentCalculation must not expose ${forbidden}`,
    )
  }
})

test('W3 cancelled-dispatch evidence contract permits a redacted deleted shift reference', () => {
  const base = loadYaml(basePath)
  const dispatch = requireSchema(base, 'AttendanceScheduleDispatchRequest')
  const targetShiftId = requireProperty(dispatch, 'targetShiftId', 'AttendanceScheduleDispatchRequest')
  assert.equal(targetShiftId.type, 'string')
  assert.equal(targetShiftId.nullable, true, 'historical cancelled dispatch targetShiftId must allow null')
  assert.equal(
    requireProperty(dispatch, 'targetShiftLabel', 'AttendanceScheduleDispatchRequest').type,
    'string',
  )
  assertEnumExact(
    requireProperty(dispatch, 'targetShiftStatus', 'AttendanceScheduleDispatchRequest'),
    ['available', 'deleted'],
    'AttendanceScheduleDispatchRequest.targetShiftStatus',
  )
})

test('W3 rejected/cancelled shift-swap evidence permits redacted deleted shift references', () => {
  const base = loadYaml(basePath)
  const swap = requireSchema(base, 'AttendanceShiftSwapRequest')

  for (const prefix of ['requester', 'counterparty']) {
    for (const idField of [`${prefix}ShiftId`, `${prefix}_shift_id`]) {
      const id = requireProperty(swap, idField, 'AttendanceShiftSwapRequest')
      assert.equal(id.type, 'string')
      assert.equal(id.nullable, true, `${idField} must allow null after evidence-preserving shift deletion`)
    }
    assert.equal(
      requireProperty(swap, `${prefix}ShiftLabel`, 'AttendanceShiftSwapRequest').type,
      'string',
    )
    assertEnumExact(
      requireProperty(swap, `${prefix}ShiftStatus`, 'AttendanceShiftSwapRequest'),
      ['available', 'deleted'],
      `AttendanceShiftSwapRequest.${prefix}ShiftStatus`,
    )
  }
})

test('W3 shift POST/PUT request bodies accept strict 1..3 segments and declare typed rejections', () => {
  const attendance = loadYaml(attendancePath)

  for (const [apiPath, method] of [
    ['/api/attendance/shifts', 'post'],
    ['/api/attendance/shifts/{id}', 'put'],
  ]) {
    const schema = requestBodySchema(attendance, apiPath, method)
    assert.equal(schema.additionalProperties, false, `${method.toUpperCase()} ${apiPath} must stay strict`)
    const segments = requireProperty(schema, 'segments', `${method.toUpperCase()} ${apiPath}`)
    assert.equal(segments.type, 'array')
    assert.equal(segments.minItems, 1)
    assert.equal(segments.maxItems, 3)
    assert.equal(
      segments.items?.$ref,
      '#/components/schemas/AttendanceShiftSegmentInput',
      `${method.toUpperCase()} ${apiPath} segments must reference AttendanceShiftSegmentInput`,
    )
    const required = Array.isArray(schema.required) ? schema.required : []
    assert.ok(!required.includes('segments'), `${method.toUpperCase()} ${apiPath} must not require segments`)
  }

  const post = loadYaml(attendancePath).paths['/api/attendance/shifts']
  assert.deepEqual(
    requestBodySchema(attendance, '/api/attendance/shifts', 'post').required,
    ['name'],
    'POST /api/attendance/shifts required list drifted',
  )
  assert.ok(post.post.responses['422'], 'POST shift must declare the typed 422 segment rejection')

  const byId = loadYaml(attendancePath).paths['/api/attendance/shifts/{id}']
  assert.ok(byId.put.responses['422'], 'PUT shift must declare the typed 422 segment rejection')
  assert.ok(byId.put.responses['409'], 'PUT shift must declare the typed 409 conversion block')
  assert.ok(byId.delete.responses['409'], 'DELETE shift must declare the typed 409 delete blocker')
})
