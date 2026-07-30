'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const yaml = require('js-yaml')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const workflowPath = path.join(
  repoRoot,
  '.github',
  'workflows',
  'sealed-export-s5-sqlserver.yml',
)
const workflowText = fs.readFileSync(workflowPath, 'utf8')
const workflow = yaml.load(workflowText)

assert.ok(workflow && typeof workflow === 'object')
assert.ok(workflow.jobs && typeof workflow.jobs === 'object')
const pullRequest = workflow.on?.pull_request || workflow.true?.pull_request
assert.ok(pullRequest && Array.isArray(pullRequest.paths))
for (const requiredPath of [
  'plugins/plugin-integration-core/lib/gip-profile-certification-contracts.cjs',
  'plugins/plugin-integration-core/__tests__/support/sealed-export-signer-authority-memory-db.cjs',
  'packages/core-backend/migrations/057_create_integration_core_tables.sql',
  'packages/core-backend/migrations/072_harden_integration_sealed_export_terminal_signer_history.sql',
]) {
  assert.ok(
    pullRequest.paths.includes(requiredPath),
    `the S5 evidence workflow must run when ${requiredPath} changes`,
  )
}

const product = workflow.jobs['sqlserver-product-action']
assert.ok(product && typeof product === 'object')
assert.deepEqual(
  product.strategy?.matrix?.mssql,
  ['2019', '2022'],
  'the product action must run both certified SQL Server versions',
)

const gate = workflow.jobs['gate-check']
assert.ok(gate && typeof gate === 'object')
assert.deepEqual(gate.needs, ['sqlserver-product-action'])
assert.equal(gate.if, 'always()')
assert.ok(Array.isArray(gate.steps))

const resultStep = gate.steps.find(
  (step) => step.name === 'Require all SQL Server product-action matrix legs',
)
assert.ok(resultStep, 'the gate must consume the aggregate matrix result')
assert.equal(
  resultStep.env?.PRODUCT_ACTION_RESULT,
  '${{ needs.sqlserver-product-action.result }}',
)
assert.match(
  resultStep.run,
  /\[\s*"\$PRODUCT_ACTION_RESULT"\s*!=\s*"success"\s*\]/,
)
assert.match(resultStep.run, /\bexit 1\b/)

const downloadStep = gate.steps.find(
  (step) =>
    typeof step.uses === 'string' &&
    step.uses.startsWith('actions/download-artifact@'),
)
assert.ok(downloadStep, 'the exact evidence verifier requires downloaded artifacts')
assert.notEqual(
  downloadStep['continue-on-error'],
  true,
  'artifact download failure must not be ignored',
)

console.log('sealed-export-s5-ci-wiring.test.cjs OK')
