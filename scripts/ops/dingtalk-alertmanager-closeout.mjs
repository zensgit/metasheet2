#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { evaluateReadiness } from './github-actions-runtime-readiness.mjs'

const DEFAULT_WORKFLOW = 'dingtalk-oauth-stability-recording-lite.yml'

export function parseArgs(argv) {
  const config = {
    repo: process.env.GITHUB_REPOSITORY || 'zensgit/metasheet2',
    ref: 'main',
    workflow: DEFAULT_WORKFLOW,
    output: null,
    outputDir: '',
    format: 'text',
    secretsJson: null,
    variablesJson: null,
    runId: '',
    trigger: false,
    wait: false,
    timeoutSeconds: 900,
    pollSeconds: 5,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--repo') {
      config.repo = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--ref') {
      config.ref = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--workflow') {
      config.workflow = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--output') {
      config.output = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--output-dir') {
      config.outputDir = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--format') {
      config.format = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--secrets-json') {
      config.secretsJson = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--variables-json') {
      config.variablesJson = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--run-id') {
      config.runId = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--trigger') {
      config.trigger = true
    } else if (arg === '--wait') {
      config.wait = true
    } else if (arg === '--timeout-seconds') {
      config.timeoutSeconds = Number(requireValue(argv, index, arg))
      index += 1
    } else if (arg === '--poll-seconds') {
      config.pollSeconds = Number(requireValue(argv, index, arg))
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
  if (!Number.isFinite(config.timeoutSeconds) || config.timeoutSeconds <= 0) {
    throw new Error('--timeout-seconds must be a positive number')
  }
  if (!Number.isFinite(config.pollSeconds) || config.pollSeconds <= 0) {
    throw new Error('--poll-seconds must be a positive number')
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

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function runGhJson(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return JSON.parse(result.stdout || '[]')
}

function runGh(args, options = {}) {
  const result = spawnSync('gh', args, { encoding: 'utf8', ...options })
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`gh ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result
}

function loadReadinessInputs(config) {
  const secrets = config.secretsJson
    ? readJsonFile(config.secretsJson)
    : runGhJson(['secret', 'list', '--repo', config.repo, '--json', 'name,updatedAt'])
  const variables = config.variablesJson
    ? readJsonFile(config.variablesJson)
    : runGhJson(['variable', 'list', '--repo', config.repo, '--json', 'name,value,updatedAt'])
  return { secrets, variables }
}

export function makeInitialSummary(config, readiness) {
  const status = readiness.ok ? 'READY' : 'BLOCKED'
  const nextActions = readiness.ok
    ? ['Trigger DingTalk OAuth Stability Recording and inspect the uploaded summary artifact.']
    : readiness.nextActions
  return {
    status,
    repo: config.repo,
    ref: config.ref,
    workflow: config.workflow,
    runId: config.runId || '',
    triggered: false,
    watched: false,
    artifactsDownloaded: false,
    outputDir: config.outputDir || '',
    readiness,
    workflowRun: null,
    artifactSummary: null,
    nextActions,
  }
}

function triggerWorkflow(config) {
  runGh(['workflow', 'run', config.workflow, '--repo', config.repo, '--ref', config.ref])
}

export function chooseLatestWorkflowDispatchRun(runs, startedAtIso) {
  const startedAt = Date.parse(startedAtIso)
  const candidates = runs
    .filter((run) => run.event === 'workflow_dispatch')
    .filter((run) => !Number.isFinite(startedAt) || Date.parse(run.createdAt || '') >= startedAt - 30_000)
    .sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''))
  return candidates[0] || null
}

function findTriggeredRun(config, startedAtIso) {
  const deadline = Date.now() + Math.min(config.timeoutSeconds, 60) * 1000
  while (Date.now() <= deadline) {
    const runs = runGhJson([
      'run',
      'list',
      '--repo',
      config.repo,
      '--workflow',
      config.workflow,
      '--limit',
      '10',
      '--json',
      'databaseId,status,conclusion,createdAt,headSha,event,url',
    ])
    const run = chooseLatestWorkflowDispatchRun(runs, startedAtIso)
    if (run) return run
    sleep(config.pollSeconds)
  }
  throw new Error(`Timed out waiting for ${config.workflow} workflow_dispatch run to appear`)
}

function sleep(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.ceil(seconds * 1000))
}

function watchRun(config, runId) {
  runGh(['run', 'watch', String(runId), '--repo', config.repo], { allowFailure: true })
}

function viewRun(config, runId) {
  return runGhJson([
    'run',
    'view',
    String(runId),
    '--repo',
    config.repo,
    '--json',
    'databaseId,status,conclusion,createdAt,updatedAt,headSha,event,url',
  ])
}

function downloadRunArtifacts(config, runId, outputDir) {
  mkdirSync(outputDir, { recursive: true })
  runGh(['run', 'download', String(runId), '--repo', config.repo, '--dir', outputDir])
}

function findFiles(root, basename) {
  const matches = []
  for (const entry of readdirSync(root)) {
    const entryPath = path.join(root, entry)
    const stat = statSync(entryPath)
    if (stat.isDirectory()) {
      matches.push(...findFiles(entryPath, basename))
    } else if (entry === basename) {
      matches.push(entryPath)
    }
  }
  return matches
}

export function loadArtifactSummary(outputDir) {
  const summaryJson = findFiles(outputDir, 'summary.json')[0]
  const summaryMarkdown = findFiles(outputDir, 'summary.md')[0]
  if (!summaryJson && !summaryMarkdown) {
    return null
  }
  const payload = summaryJson ? readJsonFile(summaryJson) : null
  return {
    status: payload?.status || '',
    healthy: Boolean(payload?.healthy),
    failureReasons: payload?.failureReasons || [],
    nextActions: payload?.nextActions || [],
    selfHeal: payload?.selfHeal || {},
    snapshot: payload?.snapshot
      ? {
          checkedAt: payload.snapshot.checkedAt,
          host: payload.snapshot.host,
          health: payload.snapshot.health,
          webhookConfig: payload.snapshot.webhookConfig,
          alertmanager: payload.snapshot.alertmanager,
          storage: payload.snapshot.storage,
        }
      : null,
    paths: {
      summaryJson: summaryJson || '',
      summaryMarkdown: summaryMarkdown || '',
    },
  }
}

function defaultOutputDir(runId) {
  return path.join('output', 'github', 'dingtalk-alertmanager-closeout', String(runId || 'latest'))
}

function renderText(summary) {
  const lines = [
    `DingTalk Alertmanager closeout: ${summary.status}`,
    `Repo: ${summary.repo}`,
    `Ref: ${summary.ref}`,
    `Workflow: ${summary.workflow}`,
  ]
  if (summary.runId) lines.push(`Run: ${summary.runId}`)
  lines.push('', `Readiness: ${summary.readiness.status}`)
  for (const [name, check] of Object.entries(summary.readiness.checks || {})) {
    lines.push(`- ${name}: ${check.ok ? 'PASS' : 'FAIL'}`)
  }
  if (summary.workflowRun) {
    lines.push('', `Workflow conclusion: ${summary.workflowRun.conclusion || summary.workflowRun.status}`)
    lines.push(`Workflow URL: ${summary.workflowRun.url}`)
  }
  if (summary.artifactSummary) {
    lines.push('', `Artifact status: ${summary.artifactSummary.status || 'unknown'}`)
    lines.push(`Artifact healthy: ${summary.artifactSummary.healthy}`)
    for (const reason of summary.artifactSummary.failureReasons || []) {
      lines.push(`- Failure reason: ${reason}`)
    }
  }
  lines.push('', 'Next actions:')
  for (const action of summary.nextActions || []) {
    lines.push(`- ${action}`)
  }
  return `${lines.join('\n')}\n`
}

function renderMarkdown(summary) {
  const lines = [
    '# DingTalk Alertmanager Closeout',
    '',
    `- Overall: **${summary.status}**`,
    `- Repo: \`${summary.repo}\``,
    `- Ref: \`${summary.ref}\``,
    `- Workflow: \`${summary.workflow}\``,
  ]
  if (summary.runId) lines.push(`- Run: \`${summary.runId}\``)
  lines.push('', '## Readiness', '')
  lines.push(`- Overall: **${summary.readiness.status}**`)
  lines.push(`- Checked at: \`${summary.readiness.checkedAt}\``)
  lines.push('', '### Checks', '')
  for (const [name, check] of Object.entries(summary.readiness.checks || {})) {
    lines.push(`- \`${name}\`: **${check.ok ? 'PASS' : 'FAIL'}**`)
    if (check.missing?.length) lines.push(`  - Missing: \`${check.missing.join('`, `')}\``)
    if (check.missingVariables?.length) lines.push(`  - Missing variables: \`${check.missingVariables.join('`, `')}\``)
    if (name === 'dingtalkWebhookSelfHeal') {
      lines.push(`  - Present supported webhook secrets: \`${check.present.length ? check.present.join('`, `') : 'none'}\``)
    }
    if (name === 'k3DeployAuthGate') {
      lines.push(`  - Require auth enabled: \`${check.requireAuthEnabled}\``)
      lines.push(`  - Tenant configured: \`${check.tenantConfigured}\``)
    }
  }
  if (summary.workflowRun) {
    lines.push('', '## Workflow Run', '')
    lines.push(`- Conclusion: \`${summary.workflowRun.conclusion || summary.workflowRun.status}\``)
    lines.push(`- URL: \`${summary.workflowRun.url}\``)
  }
  if (summary.artifactSummary) {
    lines.push('', '## Artifact Summary', '')
    lines.push(`- Status: \`${summary.artifactSummary.status || 'unknown'}\``)
    lines.push(`- Healthy: \`${summary.artifactSummary.healthy}\``)
    for (const reason of summary.artifactSummary.failureReasons || []) {
      lines.push(`- Failure reason: ${reason}`)
    }
  }
  lines.push('', '## Next Actions', '')
  for (const action of summary.nextActions || []) lines.push(`- ${action}`)
  return `${lines.join('\n')}\n`
}

function render(summary, format) {
  if (format === 'json') return `${JSON.stringify(summary, null, 2)}\n`
  if (format === 'markdown') return renderMarkdown(summary)
  return renderText(summary)
}

function writeOrPrint(rendered, output) {
  if (output) {
    writeFileSync(output, rendered)
  } else {
    process.stdout.write(rendered)
  }
}

function printHelp() {
  console.log(`usage: dingtalk-alertmanager-closeout.mjs [options]

Options:
  --repo <owner/name>          GitHub repository (default: GITHUB_REPOSITORY or zensgit/metasheet2)
  --ref <git-ref>              Workflow ref to dispatch (default: main)
  --workflow <file/name>       Workflow file/name (default: ${DEFAULT_WORKFLOW})
  --format <text|markdown|json>
  --output <path>              Write rendered closeout summary to a file
  --output-dir <path>          Artifact download directory
  --secrets-json <path>        Use fixture JSON instead of gh secret list
  --variables-json <path>      Use fixture JSON instead of gh variable list
  --run-id <id>                Summarize an existing run instead of discovering one
  --trigger                   Trigger the workflow after readiness passes
  --wait                      Wait for the run and download artifacts
  --timeout-seconds <number>   Max wait time for run discovery/watch paths
  --poll-seconds <number>      Poll interval for run discovery

Examples:
  node scripts/ops/dingtalk-alertmanager-closeout.mjs --repo zensgit/metasheet2
  node scripts/ops/dingtalk-alertmanager-closeout.mjs --repo zensgit/metasheet2 --trigger --wait --format markdown
`)
}

export function main(argv = process.argv.slice(2)) {
  const config = parseArgs(argv)
  if (config.help) {
    printHelp()
    return 0
  }

  const { secrets, variables } = loadReadinessInputs(config)
  const readiness = evaluateReadiness({ secrets, variables, repo: config.repo })
  const summary = makeInitialSummary(config, readiness)
  if (!readiness.ok) {
    writeOrPrint(render(summary, config.format), config.output)
    return 2
  }

  if (config.trigger) {
    const startedAtIso = new Date().toISOString()
    triggerWorkflow(config)
    const triggeredRun = findTriggeredRun(config, startedAtIso)
    summary.triggered = true
    summary.runId = String(triggeredRun.databaseId)
    summary.workflowRun = triggeredRun
  } else if (config.runId) {
    summary.runId = String(config.runId)
    summary.workflowRun = viewRun(config, config.runId)
  }

  if (summary.runId && config.wait) {
    watchRun(config, summary.runId)
    summary.watched = true
    summary.workflowRun = viewRun(config, summary.runId)
  }

  if (summary.runId) {
    const outputDir = config.outputDir || defaultOutputDir(summary.runId)
    downloadRunArtifacts(config, summary.runId, outputDir)
    summary.outputDir = outputDir
    summary.artifactsDownloaded = true
    summary.artifactSummary = loadArtifactSummary(outputDir)
    if (summary.artifactSummary?.nextActions?.length) {
      summary.nextActions = summary.artifactSummary.nextActions
    } else if (summary.workflowRun?.conclusion === 'success') {
      summary.status = 'PASS'
      summary.nextActions = ['Continue observing scheduled DingTalk OAuth stability runs.']
    }
  }

  if (summary.workflowRun?.conclusion === 'failure' || summary.artifactSummary?.status === 'FAIL') {
    summary.status = 'FAIL'
  } else if (summary.workflowRun?.conclusion === 'success' || summary.artifactSummary?.status === 'PASS') {
    summary.status = 'PASS'
  }

  writeOrPrint(render(summary, config.format), config.output)
  if (summary.status === 'BLOCKED') return 2
  return summary.status === 'FAIL' ? 1 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
