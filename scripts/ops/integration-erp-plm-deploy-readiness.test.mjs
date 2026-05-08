import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  evaluateDeployReadiness,
  evaluateWorkflowReadiness,
  main,
  parseArgs,
  renderMarkdown,
} from './integration-erp-plm-deploy-readiness.mjs'

const HEAD = 'abc123'

function run(workflowName, overrides = {}) {
  return {
    databaseId: Math.floor(Math.random() * 100000),
    workflowName,
    headSha: HEAD,
    status: 'completed',
    conclusion: 'success',
    url: `https://github.example/runs/${workflowName}`,
    createdAt: '2026-05-08T00:00:00Z',
    ...overrides,
  }
}

function successRuns() {
  return [
    run('Build and Push Docker Images'),
    run('Plugin System Tests'),
    run('Phase 5 Production Flags Guard'),
    run('Deploy to Production'),
  ]
}

function makeRepoRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'erp-plm-readiness-root-'))
  const files = {
    'apps/web/src/services/integration/k3WiseSetup.ts': 'export function buildK3WiseDeployGateChecklist() {}',
    'apps/web/src/views/IntegrationK3WiseSetupView.vue': 'const deployGateChecklist = []',
    'scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs': 'console.log("mock chain verified end-to-end")',
    'scripts/ops/integration-k3wise-postdeploy-smoke.mjs': 'const id = "staging-descriptor-contract"',
  }
  for (const [file, content] of Object.entries(files)) {
    const filePath = path.join(root, file)
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(filePath, content, 'utf8')
  }
  return root
}

test('parseArgs accepts deploy readiness options', () => {
  assert.deepEqual(parseArgs([
    '--',
    '--repo',
    'zensgit/metasheet2',
    '--branch',
    'main',
    '--head-sha',
    HEAD,
    '--repo-root',
    '/tmp/repo',
    '--runs-json',
    'runs.json',
    '--customer-gate-json',
    'gate.json',
    '--format',
    'markdown',
    '--output',
    'out.md',
  ]), {
    repo: 'zensgit/metasheet2',
    branch: 'main',
    headSha: HEAD,
    repoRoot: '/tmp/repo',
    runsJson: 'runs.json',
    customerGateJson: 'gate.json',
    format: 'markdown',
    output: 'out.md',
    help: false,
  })
})

test('evaluateWorkflowReadiness passes required workflows for the selected head', () => {
  const summary = evaluateWorkflowReadiness([
    run('Build and Push Docker Images', { headSha: 'old', conclusion: 'failure', createdAt: '2026-05-07T00:00:00Z' }),
    ...successRuns(),
  ], { headSha: HEAD })

  assert.equal(summary.ok, true)
  assert.equal(summary.results.length, 4)
})

test('evaluateWorkflowReadiness fails missing, pending, and failed workflow gates', () => {
  const summary = evaluateWorkflowReadiness([
    run('Build and Push Docker Images', { conclusion: 'failure' }),
    run('Plugin System Tests', { status: 'in_progress', conclusion: '' }),
    run('Phase 5 Production Flags Guard'),
  ], { headSha: HEAD })

  assert.equal(summary.ok, false)
  assert.match(summary.results.find((item) => item.id === 'docker-images').reason, /failure/)
  assert.match(summary.results.find((item) => item.id === 'plugin-system-tests').reason, /in_progress/)
  assert.match(summary.results.find((item) => item.id === 'deploy-workflow').reason, /not found/)
})

test('evaluateDeployReadiness passes internal deployment and keeps customer live blocked without GATE JSON', () => {
  const repoRoot = makeRepoRoot()
  try {
    const summary = evaluateDeployReadiness({
      runs: successRuns(),
      repoRoot,
      headSha: HEAD,
      checkedAt: '2026-05-08T00:00:00Z',
    })

    assert.equal(summary.ok, true)
    assert.equal(summary.deployMode.internalDeployment, 'ready-for-physical-machine-test')
    assert.equal(summary.deployMode.customerLive, 'blocked-until-customer-gate-and-test-account')
    assert.equal(summary.customerGate.provided, false)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('evaluateDeployReadiness fails when source markers are missing', () => {
  const repoRoot = makeRepoRoot()
  try {
    writeFileSync(path.join(repoRoot, 'apps/web/src/views/IntegrationK3WiseSetupView.vue'), 'no marker', 'utf8')
    const summary = evaluateDeployReadiness({ runs: successRuns(), repoRoot, headSha: HEAD })

    assert.equal(summary.ok, false)
    assert.match(summary.source.results.find((item) => item.id === 'k3-setup-deploy-checklist-view').reason, /marker/)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('customer GATE JSON moves live status to preflight-next only when required sections exist', () => {
  const repoRoot = makeRepoRoot()
  const tmp = mkdtempSync(path.join(tmpdir(), 'erp-plm-gate-'))
  const gateJson = path.join(tmp, 'gate.json')
  try {
    writeFileSync(gateJson, JSON.stringify({
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      k3Wise: {},
      plm: {},
      rollback: {},
    }), 'utf8')
    const summary = evaluateDeployReadiness({
      runs: successRuns(),
      repoRoot,
      headSha: HEAD,
      customerGateJson: gateJson,
    })

    assert.equal(summary.ok, true)
    assert.equal(summary.customerGate.ok, true)
    assert.equal(summary.deployMode.customerLive, 'gate-packet-present-run-preflight-next')
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('renderMarkdown includes workflow, source, and postdeploy command sections', () => {
  const repoRoot = makeRepoRoot()
  try {
    const markdown = renderMarkdown(evaluateDeployReadiness({ runs: successRuns(), repoRoot, headSha: HEAD }))
    assert.match(markdown, /## Main Workflow Gates/)
    assert.match(markdown, /## Source Gates/)
    assert.match(markdown, /integration-k3wise-postdeploy-smoke/)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('main renders markdown from offline runs JSON', () => {
  const repoRoot = makeRepoRoot()
  const tmp = mkdtempSync(path.join(tmpdir(), 'erp-plm-readiness-'))
  const runsJson = path.join(tmp, 'runs.json')
  const output = path.join(tmp, 'readiness.md')
  try {
    writeFileSync(runsJson, JSON.stringify(successRuns(), null, 2), 'utf8')
    const exitCode = main([
      '--head-sha',
      HEAD,
      '--repo-root',
      repoRoot,
      '--runs-json',
      runsJson,
      '--format',
      'markdown',
      '--output',
      output,
    ])

    assert.equal(exitCode, 0)
    assert.match(readFileSync(output, 'utf8'), /Overall: \*\*PASS\*\*/)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
    rmSync(tmp, { recursive: true, force: true })
  }
})
