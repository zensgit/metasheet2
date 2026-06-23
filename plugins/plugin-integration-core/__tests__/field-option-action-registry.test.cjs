'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  FieldOptionActionError,
  FOS_PREDEFINED_ACTIONS,
  normalizeFieldOptionActionBinding,
  isRegisteredActionId,
  assertActionRegistryValuesFree,
  listRegisteredActionIds,
} = require(path.join(__dirname, '..', 'lib', 'field-option-action-registry.cjs'))

const STOCK_ACTION = 'plm.stock-preparation.pull-bom.v1'

async function main() {
  // --- registry self-check: values-free + structurally sound (gating present) ---
  assert.equal(assertActionRegistryValuesFree(), true)
  assert.ok(listRegisteredActionIds().includes(STOCK_ACTION), 'registry seeds the stock-prep predefined action')
  assert.ok(isRegisteredActionId(STOCK_ACTION) && !isRegisteredActionId('nope.v1'))

  // --- happy path: actionId ∈ registry ∩ permitted → normalized with REGISTRY-OWNED gating ---
  const ok = normalizeFieldOptionActionBinding(
    { actionId: STOCK_ACTION, parameterBindings: { projectNo: 'projectNo' } },
    { permittedActionIds: [STOCK_ACTION] },
  )
  assert.equal(ok.actionId, STOCK_ACTION)
  assert.equal(ok.requiresDryRun, true, 'gating copied from registry, not request')
  assert.equal(ok.requiredPermission, 'write')
  assert.deepEqual(ok.parameterBindings, { projectNo: 'projectNo' })
  // predefinedActionId alias works
  assert.equal(normalizeFieldOptionActionBinding({ predefinedActionId: STOCK_ACTION }, { permittedActionIds: [STOCK_ACTION] }).actionId, STOCK_ACTION)

  // --- NEGATIVE CONTROLS (the security-relevant rejections) ---
  const rej = (input, opts, label) => assert.throws(
    () => normalizeFieldOptionActionBinding(input, opts),
    (e) => e instanceof FieldOptionActionError,
    label,
  )
  // unregistered actionId → reject
  rej({ actionId: 'evil.exec.v1' }, { permittedActionIds: ['evil.exec.v1'] }, 'unregistered actionId rejected')
  // registered but NOT in preset's permitted subset → reject
  rej({ actionId: STOCK_ACTION }, { permittedActionIds: [] }, 'not-permitted-by-preset rejected')
  rej({ actionId: STOCK_ACTION }, { permittedActionIds: ['other.v1'] }, 'permitted subset enforced')
  // parameter binding not in the registry's allowlist → reject
  rej({ actionId: STOCK_ACTION, parameterBindings: { secretKey: 'x' } }, { permittedActionIds: [STOCK_ACTION] }, 'param outside allowlist rejected')
  // request tries to DEFINE behavior / carry an action body → reject (browser references, never defines)
  for (const k of ['handler', 'functionBody', 'sql', 'js', 'url', 'script', 'body']) {
    rej({ actionId: STOCK_ACTION, [k]: 'anything', parameterBindings: {} }, { permittedActionIds: [STOCK_ACTION] }, `forbidden key ${k} rejected`)
  }
  // request tries to OVERRIDE registry-owned gating → reject
  for (const k of ['requiresDryRun', 'requiredPermission', 'allowedParameterBindings']) {
    rej({ actionId: STOCK_ACTION, [k]: 'x', parameterBindings: {} }, { permittedActionIds: [STOCK_ACTION] }, `gating override ${k} rejected`)
  }
  // secret-shaped param value → reject
  rej({ actionId: STOCK_ACTION, parameterBindings: { projectNo: 'Server=db;User Id=sa;Password=Hunter2;' } }, { permittedActionIds: [STOCK_ACTION] }, 'secret-shaped param value rejected')
  // missing/empty actionId → reject
  rej({ parameterBindings: {} }, { permittedActionIds: [STOCK_ACTION] }, 'missing actionId rejected')

  // --- registry is frozen (cannot be mutated at runtime) ---
  assert.throws(() => { FOS_PREDEFINED_ACTIONS['x.v1'] = {} }, 'registry is frozen')

  console.log('✓ field-option-action-registry: registry values-free + normalizer happy-path + negative controls (unregistered/not-permitted/param/forbidden-key/gating-override/secret/frozen) passed')
}

main().catch((e) => { console.error('✗ field-option-action-registry FAILED'); console.error(e); process.exit(1) })
