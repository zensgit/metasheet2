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
