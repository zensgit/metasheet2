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
    /env:\s*\n\s*PACT_BROKER_BASE_URL: \$\{\{ secrets\.PACT_BROKER_BASE_URL \}\}\s*\n\s*PACT_BROKER_TOKEN: \$\{\{ secrets\.PACT_BROKER_TOKEN \}\}/,
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
