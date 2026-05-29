'use strict'

// DF-T1A connector action metadata contract tests. Mirrors provenance-contracts.test.cjs:
// OpenAPI parity (load-bearing) + contract invariants. Plain node test (throws on failure).

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const yaml = require('js-yaml')

const {
  CONNECTOR_ACTION_OPERATIONS,
  WRITE_OPERATIONS,
  ConnectorActionContractValidationError,
  normalizeConnectorAction,
  K3_WISE_MATERIAL_ACTIONS,
} = require(path.join(__dirname, '..', 'lib', 'connector-action-contracts.cjs'))

const ROOT_DIR = path.join(__dirname, '..', '..', '..')

function baseAction(overrides = {}) {
  return {
    actionId: 'k3wise.material.get-detail',
    connectorKind: 'erp:k3-wise-webapi',
    operation: 'read',
    label: 'Material GetDetail',
    request: {
      method: 'POST',
      path: '/K3API/Material/GetDetail',
      inputs: { body: [{ name: 'Number', source: 'record.FNumber', required: true }] },
    },
    output: { recordPath: 'Data[0].Data', successPath: 'StatusCode', successValue: 200, errorPath: 'Message' },
    safety: { readOnly: true, allowBatch: false, maxRowsPreview: 1, requiresApproval: false },
    ...overrides,
  }
}

// OpenAPI parity is load-bearing: the contract enum/shape and base.yml must not drift.
function assertOpenApiParity() {
  const basePath = path.join(ROOT_DIR, 'packages', 'openapi', 'src', 'base.yml')
  const doc = yaml.load(fs.readFileSync(basePath, 'utf8'))
  const schemas = (doc.components && doc.components.schemas) || {}
  const opSchema = schemas.ConnectorActionOperation
  const actionSchema = schemas.ConnectorAction
  const inputSchema = schemas.ConnectorActionInput
  assert.ok(opSchema, 'OpenAPI ConnectorActionOperation schema exists')
  assert.deepEqual(opSchema.enum, [...CONNECTOR_ACTION_OPERATIONS], 'operation enum matches the contract (load-bearing)')
  assert.ok(actionSchema, 'OpenAPI ConnectorAction schema exists')
  assert.ok(inputSchema, 'OpenAPI ConnectorActionInput schema exists')
  assert.equal(actionSchema.additionalProperties, false, 'ConnectorAction is additionalProperties:false')
  assert.equal(
    actionSchema.properties.operation.$ref,
    '#/components/schemas/ConnectorActionOperation',
    'operation reuses the enum-locked ConnectorActionOperation type',
  )
  for (const field of ['actionId', 'connectorKind', 'operation', 'request', 'output', 'safety', 'gated']) {
    assert.ok(actionSchema.required.includes(field), `ConnectorAction.required includes ${field}`)
  }
}

function main() {
  assertOpenApiParity()

  // The shipped sample catalog describes the EXISTING K3 adapter ops as metadata.
  assert.equal(K3_WISE_MATERIAL_ACTIONS.length, 2, 'K3 sample has get-detail + save')
  const byId = Object.fromEntries(K3_WISE_MATERIAL_ACTIONS.map((a) => [a.actionId, a]))
  const getDetail = byId['k3wise.material.get-detail']
  const save = byId['k3wise.material.save']

  // read action is runnable (not gated); save (write) is gated/disabled, never enabled.
  assert.equal(getDetail.operation, 'read')
  assert.equal(getDetail.gated, false, 'read action is not gated')
  assert.equal(getDetail.request.path, '/K3API/Material/GetDetail')
  assert.equal(getDetail.request.inputs.body[0].source, 'record.FNumber')
  assert.equal(save.operation, 'upsert')
  assert.equal(save.gated, true, 'upsert (write) is always gated')
  assert.equal(save.safety.requiresApproval, true)
  // No inline values rode into the sample metadata (no embedded secrets).
  assert.ok(!('value' in save.request.inputs.body[0]), 'sample inputs carry no inline value')

  // enum-strict
  assert.throws(
    () => normalizeConnectorAction(baseAction({ operation: 'delete' })),
    ConnectorActionContractValidationError,
    'unknown operation rejected',
  )

  // relative-path only — no generic HTTP client / SSRF via metadata; and no query/
  // fragment in the path (query/header/body go through inputs, not the endpoint path).
  for (const bad of [
    'http://evil.example/x',
    '//evil.example/x',
    'K3API/Material/GetDetail',
    '\\\\host\\share',
    '/K3API/Material/GetDetail?token=abc',
    '/K3API/Material/GetDetail#frag',
  ]) {
    assert.throws(
      () => normalizeConnectorAction(baseAction({ request: { method: 'POST', path: bad, inputs: {} } })),
      ConnectorActionContractValidationError,
      `path rejected: ${bad}`,
    )
  }

  // no inline secret value on inputs (must use source/secretsRef)
  assert.throws(
    () => normalizeConnectorAction(baseAction({
      request: { method: 'POST', path: '/x', inputs: { header: [{ name: 'Authorization', value: 'Bearer abc' }] } },
    })),
    ConnectorActionContractValidationError,
    'inline input value rejected',
  )

  // write-gating: an upsert without requiresApproval cannot be silently enabled
  assert.throws(
    () => normalizeConnectorAction(baseAction({
      operation: 'upsert',
      output: { recordPath: 'R', successPath: 'S', errorPath: 'E' },
      safety: { readOnly: false, allowBatch: false, maxRowsPreview: 1, requiresApproval: false },
    })),
    ConnectorActionContractValidationError,
    'write op without requiresApproval rejected',
  )
  // ...and a write op cannot claim readOnly.
  assert.throws(
    () => normalizeConnectorAction(baseAction({
      operation: 'upsert',
      output: { recordPath: 'R', successPath: 'S', errorPath: 'E' },
      safety: { readOnly: true, allowBatch: false, maxRowsPreview: 1, requiresApproval: true },
    })),
    ConnectorActionContractValidationError,
    'write op cannot be readOnly',
  )

  // write-SET gating must NOT over-gate the no-write preview/export (advisor-caught)
  assert.equal(normalizeConnectorAction(baseAction({ operation: 'preview' })).gated, false, 'preview not gated')
  assert.equal(normalizeConnectorAction(baseAction({ operation: 'export' })).gated, false, 'export not gated')
  assert.deepEqual([...WRITE_OPERATIONS], ['upsert'], 'write set is upsert only (Submit/Audit/BOM not modeled here)')

  // non-write ops (read/preview/export) must declare readOnly:true — must not pose as mutating.
  for (const op of ['read', 'preview', 'export']) {
    assert.throws(
      () => normalizeConnectorAction(baseAction({
        operation: op,
        safety: { readOnly: false, allowBatch: false, maxRowsPreview: 1, requiresApproval: false },
      })),
      ConnectorActionContractValidationError,
      `non-write ${op} with readOnly:false rejected`,
    )
  }

  // redaction self-check: a secret-shaped value in help is scrubbed, never stored raw
  const withSecret = normalizeConnectorAction(baseAction({
    help: { currentStep: 'connect via postgres://erp:S3cretPass@db/x', note: 'ok' },
  }))
  assert.ok(!JSON.stringify(withSecret.help).includes('S3cretPass'), 'secret-shaped value in help scrubbed')

  console.log('connector-action-contracts.test.cjs OK')
}

main()
