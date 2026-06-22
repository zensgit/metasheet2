'use strict'

// FOS-2: generic field-option-sync kernel. Proves the loop / skip / patch / error-if-none semantics
// in isolation — the single runtime both the stock-prep wrapper and the generic route route through.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { syncFieldOptions } = require(path.join(__dirname, '..', 'lib', 'field-option-sync-runtime.cjs'))

// ZERO-DRIFT STRUCTURAL LOCK: the stock-prep option-sync module MUST route through this kernel and
// MUST NOT carry its own patch loop / patch call (else it would be a parallel copy that could drift
// from the generic route). The behavioral revert-test (break the kernel → stock-prep test fails)
// confirms the runtime path; this lock keeps the wrapper from regrowing a private write path.
function assertStockPrepRoutesThroughKernel() {
  const wrapperSource = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'stock-preparation-option-sync.cjs'),
    'utf8',
  )
  assert.ok(
    wrapperSource.includes("require('./field-option-sync-runtime.cjs')"),
    'stock-prep wrapper must require the shared kernel',
  )
  assert.ok(
    /\bsyncFieldOptions\s*\(/.test(wrapperSource),
    'stock-prep wrapper must call syncFieldOptions',
  )
  // The only allowed mentions of patchObjectFieldProperty in the wrapper are the API-availability
  // check (a `typeof ... !== 'function'` guard + its required-methods evidence). An actual call
  // `provisioning.patchObjectFieldProperty(` or `await ...patchObjectFieldProperty(` would mean a
  // parallel write path.
  assert.ok(
    !/\.patchObjectFieldProperty\s*\(/.test(wrapperSource),
    'stock-prep wrapper must NOT call patchObjectFieldProperty (kernel owns the write)',
  )
  assert.ok(
    !/for\s*\(\s*const\s+field\s+of\s+templateOptionFields/.test(wrapperSource),
    'stock-prep wrapper must NOT keep its own option-field loop',
  )
}

function createProvisioning({ failOn = null } = {}) {
  const calls = []
  return {
    calls,
    async patchObjectFieldProperty(input) {
      calls.push(JSON.parse(JSON.stringify(input)))
      if (failOn && input.fieldId === failOn) {
        const error = new Error('field deleted while syncing')
        error.code = 'FIELD_GONE'
        throw error
      }
      return { id: `fld_${input.fieldId}` }
    },
  }
}

const OPTION_FIELDS = [
  { id: 'materialType', optionSource: { key: 'material_type', type: 'config_info' } },
  { id: 'blankType', optionSource: { key: 'blank_type', type: 'config_info' } },
  { id: 'decision', optionSource: { key: 'decision_v1', type: 'contract' } },
]

function buildPropertyPatch(field, set) {
  return {
    options: set.options.map((option) => ({ value: option.value })),
    meta: { sourceKey: field.optionSource.key, optionCount: set.options.length },
  }
}

function resolveSkipReason(field) {
  return field.optionSource.type === 'config_info' ? 'config_info_not_supplied' : 'contract_not_available'
}

function makeErrorFactory(tag = {}) {
  return {
    patchFailed: (ctx) => {
      tag.patchFailed = ctx
      const error = new Error('PATCH_FAILED_FACTORY')
      error.code = 'PATCH_FAILED_FACTORY'
      error.ctx = ctx
      return error
    },
    noFieldsSynced: (ctx) => {
      tag.noFieldsSynced = ctx
      const error = new Error('NO_FIELDS_FACTORY')
      error.code = 'NO_FIELDS_FACTORY'
      error.ctx = ctx
      return error
    },
  }
}

async function rejectsWithCode(fn, code) {
  let err = null
  try {
    await fn()
  } catch (error) {
    err = error
  }
  assert.ok(err, `expected rejection ${code}`)
  assert.equal(err.code, code)
  return err
}

async function main() {
  assertStockPrepRoutesThroughKernel()

  // ---- happy path: per-field patch for supplied sets, skip for absent, returns synced/skipped ----
  {
    const provisioning = createProvisioning()
    const { synced, skipped } = await syncFieldOptions({
      provisioning,
      projectId: 'tenant_1:integration-core',
      targetObjectId: 'obj_demo',
      optionFields: OPTION_FIELDS,
      optionSets: {
        material_type: { options: [{ value: 'plate' }, { value: 'bar' }] },
        decision_v1: { options: [{ value: 'add' }] },
      },
      buildPropertyPatch,
      resolveSkipReason,
      errorFactory: makeErrorFactory(),
    })

    assert.equal(provisioning.calls.length, 2, 'patches only supplied fields')
    assert.deepEqual(provisioning.calls.map((c) => c.fieldId), ['materialType', 'decision'])
    // The kernel writes EXACTLY what buildPropertyPatch returns, against projectId + targetObjectId.
    assert.equal(provisioning.calls[0].projectId, 'tenant_1:integration-core')
    assert.equal(provisioning.calls[0].objectId, 'obj_demo')
    assert.deepEqual(provisioning.calls[0].propertyPatch, {
      options: [{ value: 'plate' }, { value: 'bar' }],
      meta: { sourceKey: 'material_type', optionCount: 2 },
    })

    assert.equal(synced.length, 2)
    assert.deepEqual(synced.map((e) => e.field), ['materialType', 'decision'])
    // synced entries carry the set so callers can summarize their own evidence.
    assert.equal(synced[0].set.options.length, 2)
    assert.deepEqual(synced[0].optionSource, { key: 'material_type', type: 'config_info' })

    assert.equal(skipped.length, 1, 'blank_type absent → skipped')
    assert.equal(skipped[0].field, 'blankType')
    assert.equal(skipped[0].reason, 'config_info_not_supplied', 'skip reason comes from the resolver')
    assert.deepEqual(skipped[0].optionSource, { key: 'blank_type', type: 'config_info' })
  }

  // ---- optionSource clone: mutating a returned optionSource must not affect the input field ----
  {
    const provisioning = createProvisioning()
    const inputFields = [{ id: 'materialType', optionSource: { key: 'material_type', type: 'config_info' } }]
    const { synced } = await syncFieldOptions({
      provisioning,
      projectId: 'p',
      targetObjectId: 'o',
      optionFields: inputFields,
      optionSets: { material_type: { options: [{ value: 'x' }] } },
      buildPropertyPatch,
      resolveSkipReason,
      errorFactory: makeErrorFactory(),
    })
    synced[0].optionSource.key = 'mutated'
    assert.equal(inputFields[0].optionSource.key, 'material_type', 'kernel returns a cloned optionSource')
  }

  // ---- error-if-none: zero synced → errorFactory.noFieldsSynced with targetObjectId + skipped ----
  {
    const provisioning = createProvisioning()
    const tag = {}
    const err = await rejectsWithCode(
      () => syncFieldOptions({
        provisioning,
        projectId: 'p',
        targetObjectId: 'obj_none',
        optionFields: OPTION_FIELDS,
        optionSets: {}, // nothing supplied → all skipped
        buildPropertyPatch,
        resolveSkipReason,
        errorFactory: makeErrorFactory(tag),
      }),
      'NO_FIELDS_FACTORY',
    )
    assert.equal(provisioning.calls.length, 0, 'no patch when nothing is supplied')
    assert.equal(err.ctx.targetObjectId, 'obj_none')
    assert.equal(err.ctx.skipped.length, 3, 'all three fields skipped')
    assert.equal(tag.noFieldsSynced.skipped[0].reason, 'config_info_not_supplied')
    assert.equal(tag.noFieldsSynced.skipped[2].reason, 'contract_not_available')
  }

  // ---- patch failure: errorFactory.patchFailed receives field/sourceKey/error ----
  {
    const provisioning = createProvisioning({ failOn: 'materialType' })
    const tag = {}
    const err = await rejectsWithCode(
      () => syncFieldOptions({
        provisioning,
        projectId: 'p',
        targetObjectId: 'o',
        optionFields: OPTION_FIELDS,
        optionSets: { material_type: { options: [{ value: 'plate' }] } },
        buildPropertyPatch,
        resolveSkipReason,
        errorFactory: makeErrorFactory(tag),
      }),
      'PATCH_FAILED_FACTORY',
    )
    assert.equal(err.ctx.field, 'materialType')
    assert.equal(err.ctx.sourceKey, 'material_type')
    assert.equal(err.ctx.error.code, 'FIELD_GONE', 'patchFailed receives the underlying error')
    assert.equal(tag.patchFailed.field, 'materialType')
  }

  // ---- buildPropertyPatch throwing is routed through patchFailed (not leaked raw) ----
  {
    const provisioning = createProvisioning()
    const err = await rejectsWithCode(
      () => syncFieldOptions({
        provisioning,
        projectId: 'p',
        targetObjectId: 'o',
        optionFields: [{ id: 'materialType', optionSource: { key: 'material_type', type: 'config_info' } }],
        optionSets: { material_type: { options: [{ value: 'plate' }] } },
        buildPropertyPatch: () => { throw new Error('builder boom') },
        resolveSkipReason,
        errorFactory: makeErrorFactory(),
      }),
      'PATCH_FAILED_FACTORY',
    )
    assert.equal(provisioning.calls.length, 0, 'builder threw before any patch call')
    assert.equal(err.ctx.error.message, 'builder boom')
  }

  // ---- guards: required collaborators ----
  await assert.rejects(
    () => syncFieldOptions({ provisioning: {}, buildPropertyPatch, resolveSkipReason, errorFactory: makeErrorFactory() }),
    /provisioning\.patchObjectFieldProperty/,
    'missing provisioning method throws',
  )
  await assert.rejects(
    () => syncFieldOptions({ provisioning: createProvisioning(), resolveSkipReason, errorFactory: makeErrorFactory() }),
    /buildPropertyPatch/,
    'missing buildPropertyPatch throws',
  )
  await assert.rejects(
    () => syncFieldOptions({ provisioning: createProvisioning(), buildPropertyPatch, errorFactory: makeErrorFactory() }),
    /resolveSkipReason/,
    'missing resolveSkipReason throws',
  )
  await assert.rejects(
    () => syncFieldOptions({ provisioning: createProvisioning(), buildPropertyPatch, resolveSkipReason, errorFactory: { patchFailed() {} } }),
    /errorFactory\.patchFailed and errorFactory\.noFieldsSynced/,
    'incomplete errorFactory throws',
  )

  console.log('field-option-sync-runtime: kernel loop/skip/patch/error-if-none + guards tests passed')
}

main().catch((error) => {
  console.error('field-option-sync-runtime FAILED')
  console.error(error)
  process.exit(1)
})
