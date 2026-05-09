#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const REQUIRED_MAIN_WORKFLOWS = [
  {
    id: 'docker-images',
    workflowName: 'Build and Push Docker Images',
    purpose: 'backend and frontend Docker images build and push for the selected main commit',
  },
  {
    id: 'plugin-system-tests',
    workflowName: 'Plugin System Tests',
    purpose: 'plugin, K3 offline PoC, Node 18/20, and coverage checks pass on the selected main commit',
  },
  {
    id: 'production-flags',
    workflowName: 'Phase 5 Production Flags Guard',
    purpose: 'production flag guard passes before deployment',
  },
  {
    id: 'deploy-workflow',
    workflowName: 'Deploy to Production',
    purpose: 'repository deploy workflow accepts the selected main commit',
  },
]

export const REQUIRED_SOURCE_MARKERS = [
  {
    id: 'k3-setup-deploy-checklist-service',
    file: 'apps/web/src/services/integration/k3WiseSetup.ts',
    marker: 'buildK3WiseDeployGateChecklist',
    purpose: 'K3 WISE setup helper exposes deploy checklist evaluation',
  },
  {
    id: 'k3-setup-deploy-checklist-view',
    file: 'apps/web/src/views/IntegrationK3WiseSetupView.vue',
    marker: 'deployGateChecklist',
    purpose: 'K3 WISE setup page renders the deploy checklist',
  },
  {
    id: 'k3-offline-poc-chain',
    file: 'scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs',
    marker: 'mock chain verified end-to-end',
    purpose: 'offline mock PLM/K3 WISE PoC chain is present',
  },
  {
    id: 'k3-postdeploy-smoke',
    file: 'scripts/ops/integration-k3wise-postdeploy-smoke.mjs',
    marker: 'staging-descriptor-contract',
    purpose: 'postdeploy smoke can validate integration routes and staging descriptors',
  },
]

export const REQUIRED_CUSTOMER_GATE_FIELDS = [
  'tenantId',
  'workspaceId',
  'k3Wise',
  'plm',
  'rollback',
]

export function parseArgs(argv) {
  const config = {
    repo: process.env.GITHUB_REPOSITORY || 'zensgit/metasheet2',
    branch: 'main',
    headSha: '',
    repoRoot: process.cwd(),
    runsJson: '',
    customerGateJson: '',
    format: 'text',
    output: '',
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      continue
    } else if (arg === '--repo') {
      config.repo = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--branch') {
      config.branch = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--head-sha') {
      config.headSha = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--repo-root') {
      config.repoRoot = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--runs-json') {
      config.runsJson = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--customer-gate-json') {
      config.customerGateJson = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--format') {
      config.format = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--output') {
      config.output = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--help' || arg === '-h') {
      config.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!['json', 'markdown', 'text'].includes(config.format)) {
    throw new Error('--format must be one of: text, markdown, json')
  }

  return config
}

function requireValue(argv, index, arg) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${arg} requires a value`)
  }
  return value
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function normalizeRuns(value) {
  if (Array.isArray(value)) return value
  if (value && Array.isArray(value.runs)) return value.runs
  if (value && Array.isArray(value.workflowRuns)) return value.workflowRuns
  throw new Error('Runs JSON must be an array or an object with runs/workflowRuns')
}

function readRunsFromGh(config) {
  const output = runCommand('gh', [
    'run',
    'list',
    '--repo',
    config.repo,
    '--branch',
    config.branch,
    '--limit',
    '40',
    '--json',
    'databaseId,workflowName,headSha,status,conclusion,url,createdAt,updatedAt',
  ])
  return normalizeRuns(JSON.parse(output || '[]'))
}

function resolveHeadSha(config) {
  if (config.headSha) return config.headSha
  try {
    return runCommand('git', ['rev-parse', `origin/${config.branch}`], { cwd: config.repoRoot })
  } catch {
    return runCommand('git', ['rev-parse', 'HEAD'], { cwd: config.repoRoot })
  }
}

function newestFirst(a, b) {
  return String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
}

function findWorkflowRun(runs, workflowName, headSha) {
  return runs
    .filter((run) => run.workflowName === workflowName)
    .filter((run) => !headSha || run.headSha === headSha)
    .sort(newestFirst)[0] || null
}

function evaluateWorkflowRun(spec, run) {
  if (!run) {
    return {
      ...spec,
      ok: false,
      status: 'missing',
      conclusion: '',
      url: '',
      reason: 'workflow run not found for selected head SHA',
    }
  }
  if (run.status !== 'completed') {
    return {
      ...spec,
      ok: false,
      status: run.status || 'unknown',
      conclusion: run.conclusion || '',
      url: run.url || '',
      reason: `workflow is ${run.status || 'unknown'}`,
    }
  }
  if (run.conclusion !== 'success') {
    return {
      ...spec,
      ok: false,
      status: run.status,
      conclusion: run.conclusion || '',
      url: run.url || '',
      reason: `workflow conclusion is ${run.conclusion || 'empty'}, expected success`,
    }
  }
  return {
    ...spec,
    ok: true,
    status: run.status,
    conclusion: run.conclusion,
    url: run.url || '',
    reason: '',
  }
}

export function evaluateWorkflowReadiness(runs, options = {}) {
  const headSha = options.headSha || ''
  const results = REQUIRED_MAIN_WORKFLOWS.map((spec) => evaluateWorkflowRun(spec, findWorkflowRun(runs, spec.workflowName, headSha)))
  return {
    ok: results.every((result) => result.ok),
    headSha,
    results,
  }
}

export function evaluateSourceMarkers(repoRoot) {
  const results = REQUIRED_SOURCE_MARKERS.map((spec) => {
    const filePath = path.join(repoRoot, spec.file)
    if (!existsSync(filePath)) {
      return {
        ...spec,
        ok: false,
        reason: 'file missing',
      }
    }
    const text = readFileSync(filePath, 'utf8')
    if (!text.includes(spec.marker)) {
      return {
        ...spec,
        ok: false,
        reason: `marker not found: ${spec.marker}`,
      }
    }
    return {
      ...spec,
      ok: true,
      reason: '',
    }
  })
  return {
    ok: results.every((result) => result.ok),
    results,
  }
}

export function evaluateCustomerGate(filePath = '') {
  if (!filePath) {
    return {
      status: 'blocked',
      ok: false,
      provided: false,
      missing: REQUIRED_CUSTOMER_GATE_FIELDS,
      message: 'customer GATE JSON not provided; internal deployment can proceed, customer live PoC remains blocked',
    }
  }
  const packet = readJsonFile(filePath)
  const missing = REQUIRED_CUSTOMER_GATE_FIELDS.filter((field) => packet[field] === undefined || packet[field] === null || packet[field] === '')
  return {
    status: missing.length === 0 ? 'packet-present' : 'incomplete',
    ok: missing.length === 0,
    provided: true,
    missing,
    message: missing.length === 0
      ? 'customer GATE JSON has required top-level sections; run live preflight next'
      : `customer GATE JSON is missing: ${missing.join(', ')}`,
  }
}

export function evaluateDeployReadiness({ runs, repoRoot, headSha, customerGateJson = '', checkedAt = new Date().toISOString() }) {
  const workflows = evaluateWorkflowReadiness(runs, { headSha })
  const source = evaluateSourceMarkers(repoRoot)
  const customerGate = evaluateCustomerGate(customerGateJson)
  const internalReady = workflows.ok && source.ok
  return {
    ok: internalReady,
    checkedAt,
    headSha,
    workflows,
    source,
    customerGate,
    deployMode: {
      internalDeployment: internalReady ? 'ready-for-physical-machine-test' : 'blocked',
      customerLive: customerGate.ok && internalReady ? 'gate-packet-present-run-preflight-next' : 'blocked-until-customer-gate-and-test-account',
    },
    localCommands: [
      'pnpm run verify:integration-k3wise:poc',
      'pnpm -F plugin-integration-core test',
      'pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts --watch=false',
      'pnpm --filter @metasheet/web build',
    ],
    postdeployCommands: [
      'node scripts/ops/integration-k3wise-postdeploy-smoke.mjs --base-url "$METASHEET_BASE_URL" --token-file "$METASHEET_AUTH_TOKEN_FILE" --tenant-id "$METASHEET_TENANT_ID" --require-auth --out-dir artifacts/integration-k3wise-postdeploy',
      'node scripts/ops/integration-k3wise-postdeploy-summary.mjs --input artifacts/integration-k3wise-postdeploy/integration-k3wise-postdeploy-smoke.json --require-auth-signoff',
    ],
  }
}

function renderStatus(ok) {
  return ok ? 'PASS' : 'FAIL'
}

export function renderText(summary) {
  const lines = [
    `ERP/PLM deploy readiness: ${renderStatus(summary.ok)}`,
    `Head SHA: ${summary.headSha}`,
    `Internal deployment: ${summary.deployMode.internalDeployment}`,
    `Customer live: ${summary.deployMode.customerLive}`,
    '',
    'Main workflow gates:',
  ]
  for (const item of summary.workflows.results) {
    lines.push(`- ${item.workflowName}: ${renderStatus(item.ok)}${item.reason ? ` (${item.reason})` : ''}`)
  }
  lines.push('', 'Source gates:')
  for (const item of summary.source.results) {
    lines.push(`- ${item.id}: ${renderStatus(item.ok)}${item.reason ? ` (${item.reason})` : ''}`)
  }
  lines.push('', `Customer GATE: ${summary.customerGate.status}`)
  if (summary.customerGate.missing.length > 0) lines.push(`Missing: ${summary.customerGate.missing.join(', ')}`)
  lines.push('', 'Local commands before physical-machine smoke:')
  for (const command of summary.localCommands) lines.push(`- ${command}`)
  lines.push('', 'Postdeploy commands:')
  for (const command of summary.postdeployCommands) lines.push(`- ${command}`)
  return `${lines.join('\n')}\n`
}

export function renderMarkdown(summary) {
  const lines = [
    '# ERP/PLM Deploy Readiness',
    '',
    `Overall: **${renderStatus(summary.ok)}**`,
    '',
    `Head SHA: \`${summary.headSha}\``,
    '',
    `Internal deployment: \`${summary.deployMode.internalDeployment}\``,
    '',
    `Customer live: \`${summary.deployMode.customerLive}\``,
    '',
    '## Main Workflow Gates',
    '',
    '| Workflow | Status | Reason | URL |',
    '| --- | --- | --- | --- |',
  ]
  for (const item of summary.workflows.results) {
    lines.push([
      `\`${item.workflowName}\``,
      renderStatus(item.ok),
      item.reason || '-',
      item.url ? `[run](${item.url})` : '-',
    ].join(' | '))
  }
  lines.push('', '## Source Gates', '', '| Gate | Status | File | Reason |', '| --- | --- | --- | --- |')
  for (const item of summary.source.results) {
    lines.push([
      `\`${item.id}\``,
      renderStatus(item.ok),
      `\`${item.file}\``,
      item.reason || '-',
    ].join(' | '))
  }
  lines.push('', '## Customer Gate', '')
  lines.push(`- Status: \`${summary.customerGate.status}\``)
  lines.push(`- Message: ${summary.customerGate.message}`)
  if (summary.customerGate.missing.length > 0) lines.push(`- Missing: \`${summary.customerGate.missing.join('`, `')}\``)
  lines.push('', '## Local Commands', '')
  for (const command of summary.localCommands) lines.push(`- \`${command}\``)
  lines.push('', '## Postdeploy Commands', '')
  for (const command of summary.postdeployCommands) lines.push(`- \`${command}\``)
  return `${lines.join('\n')}\n`
}

export function renderSummary(summary, format) {
  if (format === 'json') return `${JSON.stringify(summary, null, 2)}\n`
  if (format === 'markdown') return renderMarkdown(summary)
  return renderText(summary)
}

function printHelp() {
  console.log(`Usage:
  node scripts/ops/integration-erp-plm-deploy-readiness.mjs [options]

Options:
  --repo <owner/name>              GitHub repo. Default: GITHUB_REPOSITORY or zensgit/metasheet2
  --branch <branch>                GitHub branch for workflow lookup. Default: main
  --head-sha <sha>                 Commit SHA to check. Default: origin/<branch>, then HEAD
  --repo-root <path>               Repo root for source marker checks. Default: cwd
  --runs-json <path>               Offline GitHub runs JSON fixture
  --customer-gate-json <path>      Optional customer GATE JSON packet
  --format <text|markdown|json>    Output format. Default: text
  --output <path>                  Write report to file
`)
}

export function main(argv = process.argv.slice(2)) {
  const config = parseArgs(argv)
  if (config.help) {
    printHelp()
    return 0
  }
  const headSha = resolveHeadSha(config)
  const runs = config.runsJson ? normalizeRuns(readJsonFile(config.runsJson)) : readRunsFromGh(config)
  const summary = evaluateDeployReadiness({
    runs,
    repoRoot: config.repoRoot,
    headSha,
    customerGateJson: config.customerGateJson,
  })
  const rendered = renderSummary(summary, config.format)
  if (config.output) {
    mkdirSync(path.dirname(config.output), { recursive: true })
    writeFileSync(config.output, rendered, 'utf8')
  } else {
    process.stdout.write(rendered)
  }
  return summary.ok ? 0 : 1
}

const entryPath = process.argv[1]
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
