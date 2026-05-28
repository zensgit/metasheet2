'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const yaml = require('js-yaml')
const {
  PROVENANCE_EVENT_TYPES,
  ProvenanceContractValidationError,
  normalizeProvenanceEvent,
  normalizeProvenanceEvents,
} = require(path.join(__dirname, '..', 'lib', 'provenance-contracts.cjs'))
// DF-N2-2c: the route projection's field list is the single source of truth for the
// ProvenanceTimelineEntry shape; parity below asserts the OpenAPI required set equals it.
const { __internals: pipelinesInternals } = require(path.join(__dirname, '..', 'lib', 'pipelines.cjs'))

const ROOT_DIR = path.join(__dirname, '..', '..', '..')

function createEvent(overrides = {}) {
  return {
    runId: 'run_20260526_001',
    rowId: 'row_material_001',
    eventType: 'source_read',
    at: '2026-05-26T15:00:00.000Z',
    attrs: {
      sourceSystemId: 'plm_main',
      hasRawSnapshot: true,
    },
    ...overrides,
  }
}

function assertValidationError(fn, message) {
  let caught = null
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof ProvenanceContractValidationError, message)
  return caught
}

function assertOpenApiParity() {
  const basePath = path.join(ROOT_DIR, 'packages', 'openapi', 'src', 'base.yml')
  const doc = yaml.load(fs.readFileSync(basePath, 'utf8'))
  const schemas = doc.components && doc.components.schemas
  const eventTypeSchema = schemas && schemas.ProvenanceEventType
  const eventSchema = schemas && schemas.ProvenanceEvent

  assert.ok(eventTypeSchema, 'OpenAPI ProvenanceEventType schema exists')
  assert.deepEqual(eventTypeSchema.enum, PROVENANCE_EVENT_TYPES, 'OpenAPI event enum matches plugin contract')
  assert.equal(eventTypeSchema.enum.includes('row_skipped'), false, 'row_skipped remains reserved/deferred')
  assert.ok(eventSchema, 'OpenAPI ProvenanceEvent schema exists')
  assert.deepEqual(eventSchema.required, ['runId', 'rowId', 'eventType', 'at', 'attrs'])
  assert.equal(eventSchema.properties.eventType.$ref, '#/components/schemas/ProvenanceEventType')
  assert.equal(eventSchema.additionalProperties, false)

  // DF-N2-2c: ProvenanceTimelineEntry (read-route response item) — strict + LOAD-BEARING.
  // required set MUST equal the pipelines.cjs projection field list (so a drift between the
  // route projection and the spec fails here), eventType reuses the enum-locked type, and
  // additionalProperties:false forbids leaking extra view columns.
  const timelineSchema = schemas && schemas.ProvenanceTimelineEntry
  assert.ok(timelineSchema, 'OpenAPI ProvenanceTimelineEntry schema exists')
  assert.equal(timelineSchema.additionalProperties, false, 'ProvenanceTimelineEntry forbids extra properties')
  assert.equal(timelineSchema.properties.eventType.$ref, '#/components/schemas/ProvenanceEventType', 'eventType reuses the enum-locked type')
  assert.deepEqual(
    [...timelineSchema.required].sort(),
    [...pipelinesInternals.PROVENANCE_TIMELINE_ENTRY_FIELDS].sort(),
    'OpenAPI ProvenanceTimelineEntry.required === pipelines.cjs projection field list',
  )
}

function main() {
  const normalized = normalizeProvenanceEvent(createEvent())
  assert.equal(normalized.runId, 'run_20260526_001')
  assert.equal(normalized.rowId, 'row_material_001')
  assert.equal(normalized.eventType, 'source_read')
  assert.equal(normalized.at, '2026-05-26T15:00:00.000Z')
  assert.equal(normalized.attrs.sourceSystemId, 'plm_main')
  assert.equal(normalized.attrs.hasRawSnapshot, true)
  assert.deepEqual(Object.keys(normalized), ['runId', 'rowId', 'eventType', 'at', 'attrs'])

  for (const eventType of PROVENANCE_EVENT_TYPES) {
    const event = normalizeProvenanceEvent(createEvent({ eventType }))
    assert.equal(event.eventType, eventType, `${eventType} accepted`)
  }

  const invalid = assertValidationError(
    () => normalizeProvenanceEvent(createEvent({ eventType: 'row_skipped' })),
    'unknown eventType is rejected',
  )
  assert.equal(invalid.details.field, 'eventType')

  // --- negative cases: bad at / empty-missing runId,rowId / attrs non-object ---
  assert.equal(
    assertValidationError(() => normalizeProvenanceEvent(createEvent({ at: 'not-a-date' })), 'bad at string rejected').details.field,
    'at',
  )
  assertValidationError(() => normalizeProvenanceEvent(createEvent({ at: '' })), 'empty at rejected')
  assertValidationError(() => normalizeProvenanceEvent(createEvent({ at: undefined })), 'missing at rejected')
  assert.equal(
    assertValidationError(() => normalizeProvenanceEvent(createEvent({ runId: '' })), 'empty runId rejected').details.field,
    'runId',
  )
  assertValidationError(() => normalizeProvenanceEvent(createEvent({ runId: undefined })), 'missing runId rejected')
  assert.equal(
    assertValidationError(() => normalizeProvenanceEvent(createEvent({ rowId: '   ' })), 'whitespace rowId rejected').details.field,
    'rowId',
  )
  assert.equal(
    assertValidationError(() => normalizeProvenanceEvent(createEvent({ attrs: [] })), 'array attrs rejected').details.field,
    'attrs',
  )
  assertValidationError(() => normalizeProvenanceEvent(createEvent({ attrs: 'nope' })), 'string attrs rejected')
  assertValidationError(() => normalizeProvenanceEvent(createEvent({ attrs: null })), 'null attrs rejected')

  const redacted = normalizeProvenanceEvent(createEvent({
    attrs: {
      token: 'secret-token',
      password: 'secret-password',
      headers: {
        Authorization: 'Bearer secret',
      },
      connectionString: 'postgres://user:pass@example.invalid/db',
      databaseUrl: 'postgres://user:pass@example.invalid/db',
      safeId: 'MAT-001',
    },
  }))
  assert.equal(redacted.attrs.token, '[redacted]')
  assert.equal(redacted.attrs.password, '[redacted]')
  assert.equal(redacted.attrs.headers.Authorization, '[redacted]')
  assert.equal(redacted.attrs.connectionString, '[redacted]')
  assert.equal(redacted.attrs.databaseUrl, '[redacted]')
  assert.equal(redacted.attrs.safeId, 'MAT-001')

  const maliciousAttrs = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":{"polluted":true},"safe":"ok"}')
  const malicious = normalizeProvenanceEvent(createEvent({ attrs: maliciousAttrs }))
  assert.equal(Object.getPrototypeOf(malicious.attrs), null, 'attrs preserve sanitizer null-prototype output')
  assert.equal(Object.hasOwn(malicious.attrs, '__proto__'), false, 'unsafe __proto__ key is dropped')
  assert.equal(Object.hasOwn(malicious.attrs, 'constructor'), false, 'unsafe constructor key is dropped')
  assert.equal(Object.hasOwn(malicious.attrs, 'prototype'), false, 'unsafe prototype key is dropped')
  assert.equal(malicious.attrs.safe, 'ok')
  assert.equal({}.polluted, undefined, 'Object.prototype is not polluted')

  assertValidationError(() => normalizeProvenanceEvents(createEvent()), 'non-array batch input is rejected')
  const batch = normalizeProvenanceEvents([
    createEvent({ eventType: 'row_imported', rowId: 'row_1' }),
    createEvent({ eventType: 'row_exported', rowId: 'row_2' }),
  ])
  assert.equal(batch.length, 2)
  assert.equal(batch[0].eventType, 'row_imported')
  assert.equal(batch[1].eventType, 'row_exported')

  assertValidationError(
    () => normalizeProvenanceEvents([createEvent(), createEvent({ attrs: null })]),
    'invalid array item is rejected',
  )

  assertOpenApiParity()

  console.log('✓ provenance-contracts: normalizer + OpenAPI parity tests passed')
}

try {
  main()
} catch (err) {
  console.error('✗ provenance-contracts FAILED')
  console.error(err)
  process.exit(1)
}
