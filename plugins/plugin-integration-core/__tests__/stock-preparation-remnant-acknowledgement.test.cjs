'use strict'

// 备料 batch-refresh step 6d-1b (S6-5; register row R-91) — the PURE half of the census routes and the remnant
// acknowledgement (lib/stock-preparation-remnant-acknowledgement.cjs).
//
//   RA-01  the census query: cursor = a non-negative integer ordinal, limit 1..10 (default 10); anything else 400 by field
//   RA-02  the acknowledgement body: a 24-hex handle, the ONE basis, a values-free runbook handle and EXACTLY
//          acknowledge: { customerAnswered: true }; the revoke body: the path id and a runbook handle
//   RA-03  the exemption rule: only ACTIVE remnant_acknowledged rows naming the handle exempt it — revoked rows, the
//          dropped_head_included kind (until S6-7) and another component's handle never do
//   RA-04  the re-proof: a handle that is not a D2 remnant of the fresh read is 409 NOT_PRESENT
//   RA-05  the human columns: the template band, plus pack columns declared human / pinned / unclassified under BOTH ids;
//          a plm_system extension column is not human
//   RA-06  the tenant-wide row: complete => publicCensusOf counts + the acknowledgement counts; incomplete => a closed
//          reason and NO counts; the page cursor; the governed token
//   RA-07  the project answer: the components by handle with their active acknowledgement; an acknowledgement whose
//          component is no longer a remnant is listed apart; rulings unreadable => null counts, never zero
//   RA-08  the audit entries and details pass the audit store's own values-free gate and carry no handle / project / id
// Every value is synthetic.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const lib = require(path.join(LIB, 'stock-preparation-remnant-acknowledgement.cjs'))
const census = require(path.join(LIB, 'stock-preparation-sheet-census.cjs'))
const { HUMAN_PRESERVED_FIELD_IDS } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const { __internals: auditInternals } = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TENANT = 'tenant-ra-a'
const PROJECT = 'PRJ-RA-01'
const handleOf = (component, project = PROJECT) => census.__internals.componentHandle(TENANT, project, component)
const row = (component, { parent = null, active = true, ...cells } = {}) => ({ projectNo: PROJECT, componentSourceId: component, parentSourceId: parent, active, idempotencyKey: JSON.stringify([component, parent]), ...cells })
// D2 on S1 (old root inactive, S1 active under P1), D1 on S2 (both active), a clean P1.
const ROWS = [row('P1'), row('S1', { active: false, [HUMAN_PRESERVED_FIELD_IDS[0]]: 'filled' }), row('S1', { parent: 'P1' }), row('S2'), row('S2', { parent: 'P1' })]
const ack = (component, extra = {}) => ({ id: `cr_${component}`, componentDigest: handleOf(component), kind: 'remnant_acknowledged', basis: 'head_not_ordered', status: 'active', runbookRef: 'R-91.ack', recordedAt: '2026-11-10T00:00:00.000Z', recordedBy: 'u_admin', ...extra })

function refusal(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected a refusal')
}

test('RA-01 the census query: cursor and limit', () => {
  assert.deepEqual({ ...lib.normalizeCensusQuery({}) }, { cursor: 0, limit: 10 })
  assert.deepEqual({ ...lib.normalizeCensusQuery({ cursor: '20', limit: '5' }) }, { cursor: 20, limit: 5 })
  assert.deepEqual({ ...lib.normalizeCensusQuery({ cursor: '', limit: '' }) }, { cursor: 0, limit: 10 })
  for (const [query, field] of [[{ cursor: '-1' }, 'cursor'], [{ cursor: '01' }, 'cursor'], [{ cursor: 'abc' }, 'cursor'], [{ cursor: '1.5' }, 'cursor'], [{ limit: '0' }, 'limit'], [{ limit: '11' }, 'limit'], [{ limit: '1e1' }, 'limit']]) {
    const error = refusal(() => lib.normalizeCensusQuery(query))
    assert.equal(error.status, 400, JSON.stringify(query))
    assert.equal(error.code, lib.REMNANT_ACKNOWLEDGEMENT_ERROR_CODES.REQUEST_INVALID)
    assert.equal(error.details.field, field)
  }
})

test('RA-02 the acknowledgement and revoke bodies are closed and exact', () => {
  const good = { confirmProjectNo: PROJECT, componentHandle: handleOf('S1'), basis: 'head_not_ordered', runbookRef: 'R-91.ack-01', acknowledge: { customerAnswered: true } }
  assert.deepEqual({ ...lib.normalizeAcknowledgementBody(good) }, { componentHandle: handleOf('S1'), basis: 'head_not_ordered', runbookRef: 'R-91.ack-01' })
  for (const [patch, field] of [
    [{ componentHandle: 'S1' }, 'componentHandle'],
    [{ componentHandle: handleOf('S1').toUpperCase() }, 'componentHandle'],
    [{ basis: 'customer_said_so' }, 'basis'],
    [{ basis: undefined }, 'basis'],
    [{ runbookRef: 'the customer told the owner on the phone' }, 'runbookRef'],
    [{ runbookRef: undefined }, 'runbookRef'],
    [{ acknowledge: undefined }, 'acknowledge'],
    [{ acknowledge: { customerAnswered: 'yes' } }, 'acknowledge'],
    [{ acknowledge: { customerAnswered: true, note: 'x' } }, 'acknowledge'],
  ]) {
    const error = refusal(() => lib.normalizeAcknowledgementBody({ ...good, ...patch }))
    assert.equal(error.status, 400, JSON.stringify(patch))
    assert.equal(error.details.field, field, JSON.stringify(patch))
  }
  assert.deepEqual({ ...lib.normalizeRevokeBody({ confirmProjectNo: PROJECT, runbookRef: 'R-91.rev' }, 'cr_syn_1') }, { acknowledgementId: 'cr_syn_1', runbookRef: 'R-91.rev' })
  assert.equal(refusal(() => lib.normalizeRevokeBody({ runbookRef: 'R-91' }, 'id with space')).details.field, 'acknowledgementId')
  assert.equal(refusal(() => lib.normalizeRevokeBody({ runbookRef: 'free text!' }, 'cr_1')).details.field, 'runbookRef')
})

test('RA-03 the exemption rule: only ACTIVE remnant_acknowledged rows naming the handle', () => {
  const handles = [handleOf('S1'), handleOf('S3')]
  assert.deepEqual(lib.unacknowledgedRemnantHandles(handles, []), handles)
  assert.deepEqual(lib.unacknowledgedRemnantHandles(handles, [ack('S1')]), [handleOf('S3')])
  assert.deepEqual(lib.unacknowledgedRemnantHandles(handles, [ack('S1'), ack('S3')]), [])
  assert.deepEqual(lib.unacknowledgedRemnantHandles(handles, [ack('S1', { status: 'revoked' })]), handles, 'a revoked row exempts nothing')
  assert.deepEqual(lib.unacknowledgedRemnantHandles(handles, [ack('S1', { kind: 'dropped_head_included', basis: null })]), handles, 'dropped_head_included exempts nothing before S6-7')
  assert.deepEqual(lib.unacknowledgedRemnantHandles(handles, [ack('S1', { componentDigest: handleOf('S1', 'PRJ-OTHER') })]), handles, 'another project\'s handle exempts nothing')
  assert.deepEqual(lib.unacknowledgedRemnantHandles(handles, null), handles)
})

test('RA-04 the re-proof: the handle must be a D2 remnant of THIS read', () => {
  const fresh = lib.projectCensusOf(ROWS, { tenantId: TENANT, projectNo: PROJECT })
  assert.deepEqual(fresh.private.inactiveRootRemnantComponentHandles, [handleOf('S1')])
  lib.assertRemnantPresent(fresh, handleOf('S1'))
  for (const handle of [handleOf('S2'), handleOf('P1'), handleOf('S1', 'PRJ-OTHER')]) {
    const error = refusal(() => lib.assertRemnantPresent(fresh, handle))
    assert.equal(error.status, 409)
    assert.equal(error.code, lib.REMNANT_ACKNOWLEDGEMENT_ERROR_CODES.NOT_PRESENT)
    assert.equal(error.details.reason, 'not_a_remnant')
    assert.ok(!JSON.stringify(error.details).includes(handle), 'the refusal never echoes the handle')
  }
  assert.throws(() => lib.projectCensusOf(ROWS, { tenantId: TENANT }), /required/)
})

test('RA-05 the human columns: the template band plus pack human / pinned / unclassified columns under both ids', () => {
  assert.deepEqual(lib.censusHumanFieldIdsOf([]), [...HUMAN_PRESERVED_FIELD_IDS].sort())
  const ids = lib.censusHumanFieldIdsOf([
    { fieldId: 'ext_syn_human', physicalId: 'fld_syn_human', property: { stockPreparation: { ownership: 'human_preserved' } } },
    { fieldId: 'ext_syn_pinned', physicalId: 'fld_syn_pinned', property: { stockPreparation: { ownership: 'plm_system', extension: true, preserveOnRefresh: true } } },
    { fieldId: 'ext_syn_unclassified', physicalId: 'fld_syn_unclassified', property: {} },
    { fieldId: 'ext_syn_plm', physicalId: 'fld_syn_plm', property: { stockPreparation: { ownership: 'plm_system', extension: true } } },
  ])
  for (const id of ['ext_syn_human', 'fld_syn_human', 'ext_syn_pinned', 'fld_syn_pinned', 'ext_syn_unclassified', 'fld_syn_unclassified']) assert.ok(ids.includes(id), id)
  assert.ok(!ids.includes('ext_syn_plm') && !ids.includes('fld_syn_plm'), 'a plm_system extension column is not a human column')
  for (const id of HUMAN_PRESERVED_FIELD_IDS) assert.ok(ids.includes(id))
  // A pack human cell keyed by its PHYSICAL id on an inactive row is counted.
  const counted = lib.projectCensusOf([row('S9', { active: false, fld_syn_human: 'kept' })], { tenantId: TENANT, projectNo: PROJECT, humanFieldIds: ids })
  assert.equal(counted.inactiveRowsWithHumanCells, 1)
  const template = lib.projectCensusOf([row('S9', { active: false, fld_syn_human: 'kept' })], { tenantId: TENANT, projectNo: PROJECT })
  assert.equal(template.inactiveRowsWithHumanCells, 0, 'witness: the template band alone misses it')
})

test('RA-06 the tenant-wide row and page', () => {
  const registryRow = { objectId: 'plm_obj_ra', status: 'active' }
  const fresh = lib.projectCensusOf(ROWS, { tenantId: TENANT, projectNo: PROJECT })
  const complete = lib.censusRowAnswer({ ordinal: 3, registryRow, census: fresh, governed: 'pilot', rulings: [ack('S1'), ack('S9', { kind: 'dropped_head_included', basis: null }), ack('S7', { status: 'revoked' })] })
  assert.equal(complete.status, 'complete')
  assert.equal(complete.ordinal, 3)
  assert.equal(complete.objectId, 'plm_obj_ra')
  assert.equal(complete.registryStatus, 'active')
  assert.equal(complete.governed, 'pilot')
  for (const key of census.SHEET_CENSUS_COUNT_KEYS) assert.equal(complete[key], fresh[key], key)
  assert.equal(complete.inactiveRootRemnantComponents, 1)
  assert.equal(complete.twoCopyComponents, 1)
  assert.equal(complete.acknowledgedComponents, 1)
  assert.equal(complete.rulingComponents, 1)
  assert.equal(complete.unacknowledgedRemnantComponents, 0)
  assert.ok(!('private' in complete) && !JSON.stringify(complete).includes(handleOf('S1')), 'no handle on the tenant-wide row')
  const unreadableRulings = lib.censusRowAnswer({ ordinal: 1, registryRow, census: fresh, governed: 'none', rulings: null })
  assert.equal(unreadableRulings.acknowledgedComponents, null)
  assert.equal(unreadableRulings.unacknowledgedRemnantComponents, null, 'unknown, never zero')
  const incomplete = lib.censusRowAnswer({ ordinal: 2, registryRow: { objectId: 'plm_obj_rb', status: 'archived' }, incompleteReason: 'rows_too_large', governed: 'weird', rulings: [] })
  assert.deepEqual({ ...incomplete }, { ordinal: 2, objectId: 'plm_obj_rb', registryStatus: 'archived', governed: 'unreadable', status: 'incomplete', reason: 'rows_too_large' })
  assert.equal(lib.censusRowAnswer({ ordinal: 2, registryRow, incompleteReason: 'made_up', governed: 'none' }).reason, 'rows_unreadable', 'a reason outside the closed list never travels')
  const page = lib.censusPageAnswer({ items: [complete], total: 5, cursor: 2, limit: 1 })
  assert.equal(page.nextCursor, '3')
  assert.equal(lib.censusPageAnswer({ items: [complete], total: 3, cursor: 2, limit: 1 }).nextCursor, null)
  assert.equal(lib.censusPageAnswer({ items: [], total: 3, cursor: 3, limit: 10 }).nextCursor, null)
  assert.equal(page.scheme, census.SHEET_CENSUS_SCHEME)
  for (const [state, token] of [[{ readable: true, governed: 'pilot' }, 'pilot'], [{ readable: true, governed: 'protected' }, 'protected'], [{ readable: true, governed: 'none' }, 'none'], [{ readable: false, governed: 'unknown' }, 'unreadable'], [{ readable: true, governed: 'unknown' }, 'unreadable'], [null, 'unreadable']]) {
    assert.equal(lib.governedTokenOf(state), token, JSON.stringify(state))
  }
})

test('RA-07 the project answer: components by handle with their active acknowledgement; stale acknowledgements apart; unreadable rulings are null', () => {
  const fresh = lib.projectCensusOf([...ROWS, row('S3', { active: false }), row('S3', { parent: 'P1' })], { tenantId: TENANT, projectNo: PROJECT })
  const answer = lib.projectCensusAnswer({ projectNo: PROJECT, registryStatus: 'active', census: fresh, governed: 'none', rulings: [ack('S1'), ack('S4'), ack('S3', { status: 'revoked' })] })
  assert.equal(answer.projectNo, PROJECT)
  assert.deepEqual(answer.components.map((entry) => [entry.componentHandle, entry.acknowledgement && entry.acknowledgement.acknowledgementId]), [[handleOf('S1'), 'cr_S1'], [handleOf('S3'), null]].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
  assert.deepEqual(answer.acknowledgementsNotCurrentlyRemnant.map((entry) => entry.acknowledgementId), ['cr_S4'])
  assert.equal(answer.unacknowledgedRemnantComponents, 1)
  assert.equal(answer.acknowledgedComponents, 2)
  assert.equal(answer.rulingsReadable, true)
  assert.ok(!JSON.stringify(answer).includes('u_admin'), 'no principal id in the answer')
  const unreadable = lib.projectCensusAnswer({ projectNo: PROJECT, registryStatus: 'archived', census: fresh, governed: 'unreadable', rulings: null })
  assert.equal(unreadable.rulingsReadable, false)
  assert.equal(unreadable.acknowledgedComponents, null)
  assert.equal(unreadable.unacknowledgedRemnantComponents, null)
  assert.ok(unreadable.components.every((entry) => entry.acknowledgement === null))
  const created = lib.acknowledgementAnswer({ ...ack('S1'), revokedAt: null, revokedRunbookRef: null }, { created: true })
  assert.deepEqual(Object.keys(created).sort(), ['acknowledgementId', 'basis', 'componentHandle', 'kind', 'nextStep', 'recordedAt', 'runbookRef', 'status'])
  assert.equal(created.nextStep, 'readiness_again')
})

test('RA-08 the audit entries and details pass the audit store\'s values-free gate and carry no handle / project / principal', () => {
  const fresh = lib.projectCensusOf(ROWS, { tenantId: TENANT, projectNo: PROJECT })
  const page = lib.censusPageAnswer({
    items: [
      lib.censusRowAnswer({ ordinal: 1, registryRow: { objectId: 'plm_obj_ra', status: 'active' }, census: fresh, governed: 'none', rulings: [] }),
      lib.censusRowAnswer({ ordinal: 2, registryRow: { objectId: 'plm_obj_rb', status: 'active' }, census: fresh, governed: 'none', rulings: null }),
      lib.censusRowAnswer({ ordinal: 3, registryRow: { objectId: 'plm_obj_rc', status: 'active' }, incompleteReason: 'tenant_wall', governed: 'none' }),
    ],
    total: 3,
    cursor: 0,
    limit: 10,
  })
  const list = lib.censusListAuditDetail(page)
  assert.deepEqual(list, { operation: 'sheet_census_list', total: 3, itemCount: 3, completeCount: 2, incompleteCount: 1, remnantComponents: 2, unacknowledgedRemnantComponents: 1, rulingsUnreadableCount: 1 })
  const project = lib.projectCensusAuditDetail(lib.projectCensusAnswer({ projectNo: PROJECT, registryStatus: 'active', census: fresh, governed: 'none', rulings: [ack('S1')] }))
  assert.equal(project.operation, 'sheet_census_project')
  assert.equal(project.acknowledgedComponents, 1)
  const entry = lib.acknowledgementAuditEntryOf({ operation: 'remnant_acknowledged', rulingId: 'cr_syn_1', kind: 'remnant_acknowledged', basis: 'head_not_ordered', runbookRef: 'R-91.ack' })
  assert.deepEqual(entry, { action: 'exception_resolve', subjectId: 'cr_syn_1', mode: 'remnant_acknowledged', detail: { operation: 'remnant_acknowledged', kind: 'remnant_acknowledged', basis: 'head_not_ordered', runbookRef: 'R-91.ack' } })
  assert.equal(lib.acknowledgementAuditEntryOf({ operation: 'remnant_acknowledgement_revoked', rulingId: 'cr_syn_1', kind: 'remnant_acknowledged', basis: 'head_not_ordered', runbookRef: 'R-91.rev' }).mode, 'remnant_acknowledgement_revoked')
  assert.throws(() => lib.acknowledgementAuditEntryOf({ operation: 'something_else' }), (error) => error.status === 500)
  for (const detail of [list, project, entry.detail]) {
    auditInternals.assertValuesFreeDetail(detail)
    const text = JSON.stringify(detail)
    assert.ok(!text.includes(handleOf('S1')) && !text.includes(PROJECT) && !text.includes('plm_obj'), 'values-free')
  }
  assert.deepEqual({ ...lib.SHEET_CENSUS_AUDIT.modes }, { censusRead: 'sheet_census_read', acknowledged: 'remnant_acknowledged', revoked: 'remnant_acknowledgement_revoked' })
})

test('RA-09 an acknowledgement never reaches a lane: only the route layer, the plugin wiring, readiness (through this lib) and this lib name the ruling ledger', () => {
  const fs = require('node:fs')
  const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const files = ['index.cjs', ...fs.readdirSync(LIB).filter((name) => name.endsWith('.cjs')).map((name) => `lib/${name}`)]
  const naming = (pattern) => files.filter((file) => pattern.test(strip(fs.readFileSync(path.join(__dirname, '..', file), 'utf8')))).sort()
  // The store module and the table name: the store itself, the route layer and the plugin wiring.
  assert.deepEqual(naming(/stock-preparation-component-ruling-store\.cjs|integration_stock_prep_component_ruling/), [
    'index.cjs', 'lib/http-routes.cjs', 'lib/stock-preparation-component-ruling-store.cjs', 'lib/stock-preparation-remnant-acknowledgement.cjs',
  ])
  // The ledger's read and the one exemption rule: the route layer, readiness and this lib — no lane, no planner, no writer.
  assert.deepEqual(naming(/componentRulingStore|unacknowledgedRemnantHandles|listActiveRulings/), [
    'lib/http-routes.cjs', 'lib/stock-preparation-component-ruling-store.cjs', 'lib/stock-preparation-pilot-readiness.cjs', 'lib/stock-preparation-remnant-acknowledgement.cjs',
  ])
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-remnant-acknowledgement.test.cjs', tests)
