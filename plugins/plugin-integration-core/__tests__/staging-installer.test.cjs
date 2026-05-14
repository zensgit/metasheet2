'use strict'

// ---------------------------------------------------------------------------
// staging-installer.cjs — unit tests (Node assert, no framework dependency)
//
// Verifies:
//   1. STAGING_DESCRIPTORS shape is valid (5 sheets, required fields present)
//   2. installStaging() rejects when provisioning API is unavailable
//   3. installStaging() rejects without projectId
//   4. installStaging() calls ensureObject once per descriptor
//   5. Repeat install (idempotency) — ensureObject is called the same count,
//      same input shapes, returning the same sheet ids. No duplicate state.
//   6. Partial failure — one descriptor throws, others still provisioned,
//      warnings collected.
//
// Run:
//   node plugins/plugin-integration-core/__tests__/staging-installer.test.cjs
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  installStaging,
  listStagingDescriptors,
  STAGING_DESCRIPTORS,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'staging-installer.cjs'))

const EXPECTED_IDS = [
  'plm_raw_items',
  'standard_materials',
  'bom_cleanse',
  'integration_exceptions',
  'integration_run_log',
]

function createMockContext({ failOn = new Set() } = {}) {
  const calls = []
  const viewCalls = []
  const sheetIdsByDescriptor = new Map()
  const viewIdsByDescriptor = new Map()
  return {
    context: {
      api: {
        multitable: {
          provisioning: {
            async ensureObject({ projectId, baseId, descriptor }) {
              calls.push({ projectId, baseId, descriptorId: descriptor.id, fields: descriptor.fields.map((f) => f.id) })
              if (failOn.has(descriptor.id)) {
                throw new Error(`mock: refused to provision ${descriptor.id}`)
              }
              // Idempotent mock: same descriptorId → same sheet id
              if (!sheetIdsByDescriptor.has(descriptor.id)) {
                sheetIdsByDescriptor.set(descriptor.id, `sheet_${descriptor.id}`)
              }
              return {
                baseId: baseId || 'base_default',
                sheet: { id: sheetIdsByDescriptor.get(descriptor.id), baseId, name: descriptor.name, description: null },
                fields: descriptor.fields.map((f, i) => ({
                  id: `fld_${descriptor.id}_${f.id}`,
                  sheetId: sheetIdsByDescriptor.get(descriptor.id),
                  name: f.name,
                  type: f.type,
                  property: {},
                  order: i,
                })),
              }
            },
            async ensureView({ projectId, sheetId, descriptor }) {
              viewCalls.push({ projectId, sheetId, descriptor })
              if (!viewIdsByDescriptor.has(descriptor.objectId)) {
                viewIdsByDescriptor.set(descriptor.objectId, `view_${descriptor.objectId}`)
              }
              return {
                id: viewIdsByDescriptor.get(descriptor.objectId),
                sheetId,
                name: descriptor.name,
                type: descriptor.type,
                filterInfo: {},
                sortInfo: {},
                groupInfo: {},
                hiddenFieldIds: [],
                config: descriptor.config || {},
              }
            },
          },
        },
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
    inspect: { calls, viewCalls, sheetIdsByDescriptor, viewIdsByDescriptor },
  }
}

async function main() {
  // --- 1. Descriptor shape sanity --------------------------------------
  assert.equal(STAGING_DESCRIPTORS.length, 5, 'five staging sheets')
  const descriptorIds = STAGING_DESCRIPTORS.map((d) => d.id)
  assert.deepEqual(descriptorIds, EXPECTED_IDS, 'descriptor ids match plan')
  for (const d of STAGING_DESCRIPTORS) {
    assert.ok(Array.isArray(d.fields) && d.fields.length > 0, `${d.id} has fields`)
    assert.ok(d.backing === 'multitable', `${d.id} backing=multitable`)
    assert.ok(d.provisioning && d.provisioning.multitable === true, `${d.id} provisioning.multitable=true`)
    for (const f of d.fields) {
      assert.ok(typeof f.id === 'string' && f.id.length > 0, `${d.id}.field.id`)
      assert.ok(['string', 'number', 'date', 'select'].includes(f.type), `${d.id}.${f.id} type`)
      if (f.type === 'select') assert.ok(Array.isArray(f.options) && f.options.length > 0, `${d.id}.${f.id} select options`)
      // Provisioning contract (multitable/contracts.ts:13) has no `required`
      // at the top level; the materialization step must have removed it.
      assert.equal(f.required, undefined, `${d.id}.${f.id} top-level required must be stripped`)
    }
  }
  const summary = listStagingDescriptors()
  assert.equal(summary.length, 5)
  assert.equal(typeof summary[0].fields[0], 'string')
  assert.equal(summary[0].fieldDetails[0].id, 'sourceSystemId')
  assert.equal(summary[0].fieldDetails[0].name, 'Source System')
  assert.equal(summary[0].fieldDetails[0].type, 'string')
  assert.deepEqual(summary[0].fieldDetails[0].property.validation, [{ type: 'required' }])
  const standardMaterialsSummary = summary.find((d) => d.id === 'standard_materials')
  const codeFieldSummary = standardMaterialsSummary.fieldDetails.find((f) => f.id === 'code')
  const statusFieldSummary = standardMaterialsSummary.fieldDetails.find((f) => f.id === 'status')
  assert.deepEqual(codeFieldSummary.property.validation, [{ type: 'required' }])
  assert.deepEqual(statusFieldSummary.options, ['draft', 'active', 'obsolete'])
  assert.deepEqual(statusFieldSummary.property.validation, [{ type: 'required' }])
  assert.equal(statusFieldSummary.required, undefined, 'field details do not re-expose authoring-only required')

  statusFieldSummary.property.validation.push({ type: 'mutated-by-caller' })
  const summaryAfterMutation = listStagingDescriptors()
  const statusFieldAfterMutation = summaryAfterMutation
    .find((d) => d.id === 'standard_materials')
    .fieldDetails.find((f) => f.id === 'status')
  assert.deepEqual(
    statusFieldAfterMutation.property.validation,
    [{ type: 'required' }],
    'field detail property is copied defensively',
  )

  // --- 1b. Required fields materialize into property.validation --------
  // Raw authored fields use `required: true`; the materialized descriptor
  // must move that into property.validation to match multitable's
  // field-validation contract (field-validation.ts:5 / contracts.ts:13).
  const raw = __internals.RAW_DESCRIPTORS
  const requiredRawByDescriptor = {}
  for (const rd of raw) {
    requiredRawByDescriptor[rd.id] = new Set(rd.fields.filter((f) => f.required === true).map((f) => f.id))
  }
  for (const d of STAGING_DESCRIPTORS) {
    for (const f of d.fields) {
      const wasRequired = requiredRawByDescriptor[d.id].has(f.id)
      if (wasRequired) {
        assert.ok(f.property && Array.isArray(f.property.validation), `${d.id}.${f.id} has property.validation array`)
        const hasRequiredRule = f.property.validation.some((r) => r && r.type === 'required')
        assert.ok(hasRequiredRule, `${d.id}.${f.id} property.validation contains required rule`)
      }
    }
  }
  // Spot-check the transform via the exposed helper too.
  const mat = __internals.materializeField({ id: 'code', name: 'Code', type: 'string', required: true }, 0)
  assert.deepEqual(mat.property.validation, [{ type: 'required' }], 'materializeField moves required into property.validation')
  assert.equal(mat.required, undefined, 'materialized field strips top-level required')
  const matNoReq = __internals.materializeField({ id: 'note', name: 'Note', type: 'string' }, 1)
  assert.equal(matNoReq.property, undefined, 'no required → no property added')

  // --- 2. Rejects when provisioning API unavailable --------------------
  let err = null
  try {
    await installStaging({ context: { api: {} }, projectId: 'proj1' })
  } catch (e) {
    err = e
  }
  assert.ok(err && /provisioning/.test(err.message), 'rejects when provisioning missing')

  // --- 3. Rejects without projectId ------------------------------------
  const { context: okCtx } = createMockContext()
  let err2 = null
  try {
    await installStaging({ context: okCtx })
  } catch (e) {
    err2 = e
  }
  assert.ok(err2 && /projectId/.test(err2.message), 'rejects without projectId')

  // --- 4. Happy path: one call per descriptor --------------------------
  const { context: ctx1, inspect: inspect1 } = createMockContext()
  const res1 = await installStaging({ context: ctx1, projectId: 'proj1' })
  assert.equal(inspect1.calls.length, 5, 'called once per descriptor')
  assert.equal(inspect1.viewCalls.length, 5, 'ensured one default view per descriptor')
  assert.deepEqual(inspect1.calls.map((c) => c.descriptorId), EXPECTED_IDS)
  assert.deepEqual(inspect1.viewCalls.map((c) => c.descriptor.objectId), EXPECTED_IDS)
  assert.deepEqual(inspect1.viewCalls.map((c) => c.descriptor.id), Array(5).fill('default_grid'))
  assert.equal(Object.keys(res1.sheetIds).length, 5, 'all 5 sheet ids returned')
  assert.equal(Object.keys(res1.viewIds).length, 5, 'all 5 view ids returned')
  assert.equal(Object.keys(res1.openLinks).length, 5, 'all 5 open links returned')
  assert.equal(res1.targets.length, 5, 'all 5 open targets returned')
  assert.equal(res1.warnings.length, 0, 'no warnings on happy path')
  for (const id of EXPECTED_IDS) {
    assert.equal(res1.sheetIds[id], `sheet_${id}`, `sheetId mapped for ${id}`)
    assert.equal(res1.viewIds[id], `view_${id}`, `viewId mapped for ${id}`)
    assert.equal(
      res1.openLinks[id],
      `/multitable/sheet_${id}/view_${id}?baseId=base_default`,
      `openLink mapped for ${id}`,
    )
  }
  assert.deepEqual(res1.targets[0], {
    id: 'plm_raw_items',
    name: 'PLM Raw Items',
    sheetId: 'sheet_plm_raw_items',
    viewId: 'view_plm_raw_items',
    baseId: 'base_default',
    openLink: '/multitable/sheet_plm_raw_items/view_plm_raw_items?baseId=base_default',
  })

  // --- 5. Idempotency: second install returns same sheet ids -----------
  const res2 = await installStaging({ context: ctx1, projectId: 'proj1' })
  assert.equal(inspect1.calls.length, 10, '5 more calls on second install (ensureObject is idempotent upstream)')
  assert.equal(inspect1.viewCalls.length, 10, '5 more view calls on second install (ensureView is idempotent upstream)')
  assert.deepEqual(res1.sheetIds, res2.sheetIds, 'same sheet ids on re-install')
  assert.deepEqual(res1.viewIds, res2.viewIds, 'same view ids on re-install')
  assert.deepEqual(res1.openLinks, res2.openLinks, 'same open links on re-install')

  // --- 6. Partial failure: one descriptor fails, others continue ------
  const { context: ctx2, inspect: inspect2 } = createMockContext({ failOn: new Set(['bom_cleanse']) })
  const res3 = await installStaging({ context: ctx2, projectId: 'proj2' })
  assert.equal(inspect2.calls.length, 5, 'still attempted all 5 descriptors')
  assert.equal(inspect2.viewCalls.length, 4, 'ensured views only for successfully provisioned sheets')
  assert.equal(Object.keys(res3.sheetIds).length, 4, '4 sheets provisioned')
  assert.equal(Object.keys(res3.viewIds).length, 4, '4 views provisioned')
  assert.equal(res3.warnings.length, 1, 'one warning collected')
  assert.match(res3.warnings[0], /bom_cleanse/, 'warning names the failing descriptor')
  assert.ok(!('bom_cleanse' in res3.sheetIds), 'failing descriptor absent from sheetIds')
  assert.ok(!('bom_cleanse' in res3.viewIds), 'failing descriptor absent from viewIds')

  // --- 7. View provisioning is optional for legacy plugin host tests ----
  const legacyCtx = createMockContext().context
  delete legacyCtx.api.multitable.provisioning.ensureView
  const legacyRes = await installStaging({ context: legacyCtx, projectId: 'proj-legacy' })
  assert.equal(Object.keys(legacyRes.sheetIds).length, 5, 'legacy context still provisions sheets')
  assert.equal(Object.keys(legacyRes.viewIds).length, 0, 'legacy context has no views')
  assert.equal(Object.keys(legacyRes.openLinks).length, 0, 'legacy context has no open links')
  assert.match(legacyRes.warnings[0], /ensureView not available/, 'legacy context reports missing open links')

  // --- 8. Internal helper ----------------------------------------------
  assert.equal(__internals.isProvisioningAvailable({ api: {} }), false)
  assert.equal(__internals.isProvisioningAvailable(ctx1), true)
  assert.equal(__internals.isViewProvisioningAvailable({ api: {} }), false)
  assert.equal(__internals.isViewProvisioningAvailable(ctx1), true)
  assert.deepEqual(__internals.buildDefaultViewDescriptor({ id: 'standard_materials' }), {
    id: 'default_grid',
    objectId: 'standard_materials',
    name: 'All records',
    type: 'grid',
    config: {
      integrationStaging: true,
      stagingObjectId: 'standard_materials',
    },
  })
  assert.equal(
    __internals.buildMultitableOpenLink({ sheetId: 'sheet A', viewId: 'view/B', baseId: 'base C' }),
    '/multitable/sheet%20A/view%2FB?baseId=base%20C',
    'open links encode route segments and baseId',
  )

  console.log('✓ staging-installer: all 8 assertions passed')
}

main().catch((err) => {
  console.error('✗ staging-installer FAILED')
  console.error(err)
  process.exit(1)
})
