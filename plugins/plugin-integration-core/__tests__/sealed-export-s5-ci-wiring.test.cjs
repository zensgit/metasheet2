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
  'plugins/plugin-integration-core/lib/gip-canonical-json.cjs',
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

assert.ok(Array.isArray(product.steps))
const productEvidenceStep = product.steps.find(
  (step) => step.name === 'Run sealed-export S5 real-engine product evidence',
)
assert.ok(productEvidenceStep, 'each SQL Server leg must run product evidence')
assert.equal(
  productEvidenceStep.env?.S5_MSSQL_DECLARED_MAJOR_VERSION,
  '${{ matrix.mssql }}',
)
assert.equal(
  productEvidenceStep.env?.S5_EVIDENCE_DIR,
  '${{ github.workspace }}/sealed-export-s5-evidence-${{ matrix.mssql }}',
)
assert.equal(
  productEvidenceStep.run,
  'pnpm --filter plugin-integration-core evidence:sealed-export-s5-sqlserver',
)

const uploadStep = product.steps.find(
  (step) => step.name === 'Upload values-free sealed-export S5 evidence',
)
assert.ok(uploadStep, 'each SQL Server leg must upload its evidence')
assert.equal(uploadStep.uses, 'actions/upload-artifact@v4')
assert.equal(uploadStep.if, 'always()')
assert.equal(
  uploadStep.with?.name,
  'sealed-export-s5-product-evidence-${{ matrix.mssql }}',
)
assert.equal(
  uploadStep.with?.path,
  'sealed-export-s5-evidence-${{ matrix.mssql }}/',
)
assert.equal(uploadStep.with?.['if-no-files-found'], 'error')

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

const realPostgresStep = gate.steps.find(
  (step) => step.name === 'Run real-Postgres signer lifecycle migration gate',
)
assert.ok(realPostgresStep, 'the gate must execute the real Postgres lifecycle test')
assert.match(realPostgresStep.run, /vitest\.integration\.config\.ts/)
assert.match(
  realPostgresStep.run,
  /sealed-export-signer-authority-lifecycle-migration\.db\.test\.ts/,
)

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
assert.equal(downloadStep.with?.pattern, 'sealed-export-s5-product-evidence-*')
assert.equal(downloadStep.with?.path, 'sealed-export-s5-evidence-combined')
assert.equal(downloadStep.with?.['merge-multiple'], true)

const verifierStep = gate.steps.find(
  (step) => step.name === 'Verify exact values-free S5 evidence set',
)
assert.ok(verifierStep, 'the gate must run the exact combined evidence verifier')
assert.equal(
  verifierStep.env?.S5_EVIDENCE_DIR,
  '${{ github.workspace }}/sealed-export-s5-evidence-combined',
)
assert.equal(
  verifierStep.run,
  'pnpm --filter plugin-integration-core verify:sealed-export-s5-sqlserver-evidence',
)

console.log('sealed-export-s5-ci-wiring.test.cjs OK')
