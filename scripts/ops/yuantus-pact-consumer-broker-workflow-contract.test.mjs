import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const workflowPath = '.github/workflows/yuantus-pact-consumer.yml'
const contractTestPath = 'scripts/ops/yuantus-pact-consumer-broker-workflow-contract.test.mjs'

function readWorkflow() {
  return readFileSync(path.join(repoRoot, workflowPath), 'utf8')
}

test('yuantus pact consumer broker publish stays advisory and secret-guarded', () => {
  const raw = readWorkflow()
  const checkStep = raw.indexOf('Run Yuantus pact consumer checks')
  const publishStep = raw.indexOf('Publish consumer pact to broker (advisory, Phase A)')

  assert.match(raw, /workflow_dispatch: \{\}/)
  assert.match(raw, /workflow_dispatch-enabled workflow exists on/)
  assert.match(raw, /post-merge push:main run is what publishes the mainBranch pact/)
  assert.ok(checkStep >= 0, 'local consumer checks step must exist')
  assert.ok(publishStep > checkStep, 'broker publish must run only after local consumer checks')
  assert.match(raw, new RegExp(contractTestPath.replaceAll('/', '\\/'), 'g'))
  assert.match(
    raw,
    /Run pact broker workflow contract test[\s\S]*node --test scripts\/ops\/yuantus-pact-consumer-broker-workflow-contract\.test\.mjs/,
  )
  assert.match(raw, /pnpm --filter @metasheet\/core-backend test:contract/)
  assert.match(raw, /Publish consumer pact to broker \(advisory, Phase A\)[\s\S]*continue-on-error: true/)
  assert.match(
    raw,
    /env:\s*\n\s*PACT_BROKER_BASE_URL: \$\{\{ secrets\.PACT_BROKER_BASE_URL \}\}\s*\n\s*PACT_BROKER_TOKEN: \$\{\{ secrets\.PACT_BROKER_TOKEN \}\}\s*\n\s*PACT_BROKER_ERROR_ON_UNKNOWN_OPTION: "true"/,
  )
  assert.doesNotMatch(raw, /if:\s*\$\{\{\s*secrets\.PACT_BROKER_/)
  assert.match(
    raw,
    /if \[ -z "\$\{PACT_BROKER_BASE_URL:-\}" \]; then[\s\S]*PACT_BROKER_BASE_URL not set[\s\S]*exit 0/,
  )
  assert.match(
    raw,
    /if \[ -z "\$\{PACT_BROKER_TOKEN:-\}" \]; then[\s\S]*Pact broker token missing[\s\S]*exit 1/,
  )
})

test('yuantus pact consumer broker publish uses git SHA and broker branch semantics', () => {
  const raw = readWorkflow()

  assert.match(
    raw,
    /pact-broker publish packages\/core-backend\/tests\/contract\/pacts\/metasheet2-yuantus-plm\.json/,
  )
  assert.match(raw, /--consumer-app-version "\$\{GITHUB_SHA\}"/)
  assert.match(raw, /--branch "\$\{GITHUB_REF_NAME\}"/)
  assert.match(raw, /--broker-base-url "\$PACT_BROKER_BASE_URL"/)
  assert.match(raw, /--broker-token "\$PACT_BROKER_TOKEN"/)
  assert.doesNotMatch(raw, /--tag\b/)
})

test('yuantus pact consumer broker publish is gated to push:main (off-main hygiene)', () => {
  const raw = readWorkflow()

  // Off-main hygiene: the publish step must be gated to push:main via a reliable step-level `if`
  // (github.event_name / github.ref ARE available to steps.if, unlike `secrets`), so PR runs never
  // publish off-main pact versions to the broker (a stray off-main "latest" once false-no'd Yuantus
  // can-i-deploy; pinned out by Yuantus #869 --main-branch, removed at the source here).
  const publishIdx = raw.indexOf('Publish consumer pact to broker (advisory, Phase A)')
  assert.ok(publishIdx >= 0, 'publish step must exist')
  const continueIdx = raw.indexOf('continue-on-error: true', publishIdx)
  const publishHead = raw.slice(publishIdx, continueIdx)
  assert.match(
    publishHead,
    /if: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' \}\}/,
    'publish step must be gated to push:main',
  )
})
