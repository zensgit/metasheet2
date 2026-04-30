#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const DEFAULT_PACKET_ROOT = 'artifacts/dingtalk-staging-evidence-packet'
const DEFAULT_DOCS_DIR = 'docs/development'
const FINALIZE_SCRIPT_ENV = 'DINGTALK_P4_FINAL_CLOSEOUT_FINALIZE_SCRIPT'
const HANDOFF_SCRIPT_ENV = 'DINGTALK_P4_FINAL_CLOSEOUT_HANDOFF_SCRIPT'
const STATUS_SCRIPT_ENV = 'DINGTALK_P4_FINAL_CLOSEOUT_STATUS_SCRIPT'
const DOCS_SCRIPT_ENV = 'DINGTALK_P4_FINAL_CLOSEOUT_DOCS_SCRIPT'

function printHelp() {
  console.log(`Usage: node scripts/ops/dingtalk-p4-final-closeout.mjs [options]

Runs the local final DingTalk P4 closeout chain after all manual evidence has
been recorded:
  1. strict finalize the smoke session
  2. export and validate the final handoff packet
  3. run the release-ready smoke status gate
  4. generate final development and verification Markdown

It does not call DingTalk or staging. It only consumes the local finalized
session workspace and handoff packet.

Options:
  --session-dir <dir>                 DingTalk P4 smoke session directory (required)
  --packet-output-dir <dir>           Packet directory, default ${DEFAULT_PACKET_ROOT}/<session-name>-final
  --docs-output-dir <dir>             Final docs directory, default ${DEFAULT_DOCS_DIR}
  --date <yyyymmdd>                   Final docs date suffix, default current UTC date
  --summary-json <file>               Closeout JSON summary, default <packet-output-dir>/closeout-summary.json
  --summary-md <file>                 Closeout Markdown summary, default <packet-output-dir>/closeout-summary.md
  --allow-external-artifact-refs      Forward to dingtalk-p4-smoke-session.mjs --finalize
  --skip-docs                         Stop after release-ready status gate
  --help                              Show this help
`)
}

function readRequiredValue(argv, index, flag) {
  const next = argv[index + 1]
  if (!next || next.startsWith('--')) throw new Error(`${flag} requires a value`)
  return next
}

function defaultDate() {
  return new Date().toISOString().slice(0, 10).replaceAll('-', '')
}

function sanitizeName(value) {
  return path
    .basename(value)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '') || 'session'
}

function parseArgs(argv) {
  const opts = {
    sessionDir: '',
    packetOutputDir: '',
    docsOutputDir: path.resolve(process.cwd(), DEFAULT_DOCS_DIR),
    date: defaultDate(),
    summaryJson: '',
    summaryMd: '',
    allowExternalArtifactRefs: false,
    skipDocs: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--session-dir':
        opts.sessionDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--packet-output-dir':
        opts.packetOutputDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--docs-output-dir':
        opts.docsOutputDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--date':
        opts.date = readRequiredValue(argv, i, arg).trim()
        i += 1
        break
      case '--summary-json':
        opts.summaryJson = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--summary-md':
        opts.summaryMd = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--allow-external-artifact-refs':
        opts.allowExternalArtifactRefs = true
        break
      case '--skip-docs':
        opts.skipDocs = true
        break
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!opts.sessionDir) throw new Error('--session-dir is required')
  if (!/^\d{8}$/.test(opts.date)) throw new Error('--date must be formatted as yyyymmdd')
  if (!opts.packetOutputDir) {
    opts.packetOutputDir = path.resolve(process.cwd(), DEFAULT_PACKET_ROOT, `${sanitizeName(opts.sessionDir)}-final`)
  }
  opts.summaryJson ||= path.join(opts.packetOutputDir, 'closeout-summary.json')
  opts.summaryMd ||= path.join(opts.packetOutputDir, 'closeout-summary.md')
  return opts
}

function relativePath(file) {
  return path.relative(process.cwd(), file).replaceAll('\\', '/')
}

function redactString(value) {
  return String(value ?? '')
    .replace(/(access_token=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/(publicToken=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/([?&](?:sign|timestamp)=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/\b((?:client_secret|DINGTALK_CLIENT_SECRET|DINGTALK_STATE_SECRET)\s*=\s*)[^&\s)"'`<>]+/gi, '$1<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\bSEC[A-Za-z0-9+/=_-]{8,}\b/g, 'SEC<redacted>')
    .replace(/\beyJ[A-Za-z0-9._-]{20,}\b/g, '<jwt:redacted>')
}

function compactText(value) {
  const text = redactString(value ?? '').trim()
  if (!text) return ''
  return text.length > 4000 ? `${text.slice(0, 3997)}...` : text
}

function readJsonIfExists(file) {
  if (!existsSync(file) || !statSync(file).isFile()) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}

function assertDirectory(file, label) {
  if (!existsSync(file) || !statSync(file).isDirectory()) {
    throw new Error(`${label} must point to an existing directory: ${relativePath(file)}`)
  }
}

function pathsOverlap(left, right) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`)
}

function validatePaths(opts) {
  assertDirectory(opts.sessionDir, '--session-dir')
  if (pathsOverlap(opts.packetOutputDir, opts.sessionDir)) {
    throw new Error('--packet-output-dir must not be the session directory or overlap with it')
  }
}

function scriptPath(envName, fallback) {
  return process.env[envName] || fallback
}

function runNodeStep(id, label, script, args) {
  const startedAt = new Date().toISOString()
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env: process.env,
  })
  const finishedAt = new Date().toISOString()
  return {
    id,
    label,
    command: `node ${[script, ...args].join(' ')}`,
    status: result.status === 0 ? 'pass' : 'fail',
    exitCode: result.status ?? 1,
    startedAt,
    finishedAt,
    stdout: compactText(result.stdout),
    stderr: compactText(result.stderr || result.error?.message || ''),
  }
}

function sessionSummary(opts) {
  return readJsonIfExists(path.join(opts.sessionDir, 'session-summary.json'))
}

function handoffSummary(opts) {
  return readJsonIfExists(path.join(opts.packetOutputDir, 'handoff-summary.json'))
}

function smokeStatusSummary(opts) {
  return readJsonIfExists(path.join(opts.sessionDir, 'smoke-status.json'))
}

function docsOutputs(opts) {
  return {
    developmentMd: path.join(opts.docsOutputDir, `dingtalk-final-remote-smoke-development-${opts.date}.md`),
    verificationMd: path.join(opts.docsOutputDir, `dingtalk-final-remote-smoke-verification-${opts.date}.md`),
  }
}

function clearStaleCloseoutOutputs(opts) {
  rmSync(opts.summaryJson, { force: true })
  rmSync(opts.summaryMd, { force: true })
}

function clearSkippedDocsOutputs(opts) {
  if (!opts.skipDocs) return
  const docs = docsOutputs(opts)
  rmSync(docs.developmentMd, { force: true })
  rmSync(docs.verificationMd, { force: true })
}

function buildSummary(opts, steps) {
  const docs = opts.skipDocs ? null : docsOutputs(opts)
  const session = sessionSummary(opts)
  const handoff = handoffSummary(opts)
  const status = smokeStatusSummary(opts)
  const failures = []
  for (const step of steps) {
    if (step.status !== 'pass') failures.push(`${step.id} failed with exit code ${step.exitCode}`)
  }
  if (steps.every((step) => step.status === 'pass') && status?.overallStatus !== 'release_ready') {
    failures.push(`smoke status is ${status?.overallStatus ?? 'not_available'}, expected release_ready`)
  }
  if (steps.every((step) => step.status === 'pass') && handoff?.status !== 'pass') {
    failures.push(`handoff status is ${handoff?.status ?? 'not_available'}, expected pass`)
  }

  return {
    tool: 'dingtalk-p4-final-closeout',
    generatedAt: new Date().toISOString(),
    status: failures.length === 0 ? 'pass' : 'fail',
    sessionDir: relativePath(opts.sessionDir),
    packetOutputDir: relativePath(opts.packetOutputDir),
    docsOutputDir: relativePath(opts.docsOutputDir),
    date: opts.date,
    steps,
    outputs: {
      closeoutSummaryJson: relativePath(opts.summaryJson),
      closeoutSummaryMd: relativePath(opts.summaryMd),
      sessionSummaryJson: relativePath(path.join(opts.sessionDir, 'session-summary.json')),
      smokeStatusJson: relativePath(path.join(opts.sessionDir, 'smoke-status.json')),
      handoffSummaryJson: relativePath(path.join(opts.packetOutputDir, 'handoff-summary.json')),
      publishCheckJson: relativePath(path.join(opts.packetOutputDir, 'publish-check.json')),
      developmentMd: docs ? relativePath(docs.developmentMd) : '',
      verificationMd: docs ? relativePath(docs.verificationMd) : '',
    },
    final: {
      sessionPhase: session?.sessionPhase ?? 'not_available',
      sessionStatus: session?.overallStatus ?? 'not_available',
      finalStrictStatus: session?.finalStrictStatus ?? 'not_available',
      smokeStatus: status?.overallStatus ?? 'not_available',
      handoffStatus: handoff?.status ?? 'not_available',
      publishStatus: handoff?.publishCheck?.status ?? status?.handoff?.publishStatus ?? 'not_available',
      secretFindingCount: Array.isArray(handoff?.publishCheck?.secretFindings)
        ? handoff.publishCheck.secretFindings.length
        : status?.handoff?.secretFindingCount ?? 0,
    },
    failures: failures.map((failure) => redactString(failure)),
  }
}

function renderMarkdown(summary) {
  const stepRows = summary.steps.map((step) => {
    const notes = step.stderr || step.stdout.split(/\r?\n/).filter(Boolean).at(-1) || ''
    return `| \`${step.id}\` | ${step.status} | ${step.exitCode} | ${redactString(notes).replaceAll('|', '\\|')} |`
  })
  const failures = summary.failures.length
    ? summary.failures.map((failure) => `- ${failure}`).join('\n')
    : '- None'
  const developmentMd = summary.outputs.developmentMd || 'not_generated (--skip-docs)'
  const verificationMd = summary.outputs.verificationMd || 'not_generated (--skip-docs)'

  return `# DingTalk P4 Final Closeout Summary

Generated at: ${summary.generatedAt}

Overall status: **${summary.status}**

Session directory: \`${summary.sessionDir}\`

Packet directory: \`${summary.packetOutputDir}\`

Docs directory: \`${summary.docsOutputDir}\`

## Steps

| Step | Status | Exit | Notes |
| --- | --- | ---: | --- |
${stepRows.join('\n')}

## Outputs

- Session summary: \`${summary.outputs.sessionSummaryJson}\`
- Smoke status: \`${summary.outputs.smokeStatusJson}\`
- Handoff summary: \`${summary.outputs.handoffSummaryJson}\`
- Publish check: \`${summary.outputs.publishCheckJson}\`
- Development MD: \`${developmentMd}\`
- Verification MD: \`${verificationMd}\`

## Final Status

- Session phase: **${summary.final.sessionPhase}**
- Session status: **${summary.final.sessionStatus}**
- Final strict status: **${summary.final.finalStrictStatus}**
- Smoke status: **${summary.final.smokeStatus}**
- Handoff status: **${summary.final.handoffStatus}**
- Publish status: **${summary.final.publishStatus}**
- Secret findings: **${summary.final.secretFindingCount}**

## Failures

${failures}

## Secret Handling

- This closeout summary redacts bearer tokens, DingTalk webhook tokens, SEC secrets, JWTs, public form tokens, timestamps, and signatures.
- It references artifact locations only; raw screenshots and local evidence files still require human release-owner review.
`
}

function writeSummary(summary, opts) {
  mkdirSync(path.dirname(opts.summaryJson), { recursive: true })
  mkdirSync(path.dirname(opts.summaryMd), { recursive: true })
  writeFileSync(opts.summaryJson, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  writeFileSync(opts.summaryMd, renderMarkdown(summary), 'utf8')
  console.log(`Wrote ${relativePath(opts.summaryJson)}`)
  console.log(`Wrote ${relativePath(opts.summaryMd)}`)
}

function runCloseout(opts) {
  clearStaleCloseoutOutputs(opts)
  validatePaths(opts)
  clearSkippedDocsOutputs(opts)
  const steps = []

  const finalizeStep = runNodeStep(
    'finalize-session',
    'Run strict smoke-session finalize',
    scriptPath(FINALIZE_SCRIPT_ENV, 'scripts/ops/dingtalk-p4-smoke-session.mjs'),
    [
      '--finalize',
      opts.sessionDir,
      ...(opts.allowExternalArtifactRefs ? ['--allow-external-artifact-refs'] : []),
    ],
  )
  steps.push(finalizeStep)

  if (finalizeStep.status === 'pass') {
    steps.push(runNodeStep(
      'final-handoff',
      'Export and validate final handoff packet',
      scriptPath(HANDOFF_SCRIPT_ENV, 'scripts/ops/dingtalk-p4-final-handoff.mjs'),
      [
        '--session-dir',
        opts.sessionDir,
        '--output-dir',
        opts.packetOutputDir,
      ],
    ))
  }

  if (steps.at(-1)?.status === 'pass') {
    steps.push(runNodeStep(
      'release-ready-status',
      'Run release-ready smoke status gate',
      scriptPath(STATUS_SCRIPT_ENV, 'scripts/ops/dingtalk-p4-smoke-status.mjs'),
      [
        '--session-dir',
        opts.sessionDir,
        '--handoff-summary',
        path.join(opts.packetOutputDir, 'handoff-summary.json'),
        '--require-release-ready',
      ],
    ))
  }

  if (!opts.skipDocs && steps.at(-1)?.status === 'pass') {
    steps.push(runNodeStep(
      'final-docs',
      'Generate final remote smoke development and verification docs',
      scriptPath(DOCS_SCRIPT_ENV, 'scripts/ops/dingtalk-p4-final-docs.mjs'),
      [
        '--session-dir',
        opts.sessionDir,
        '--handoff-summary',
        path.join(opts.packetOutputDir, 'handoff-summary.json'),
        '--status-summary',
        path.join(opts.sessionDir, 'smoke-status.json'),
        '--output-dir',
        opts.docsOutputDir,
        '--date',
        opts.date,
        '--require-release-ready',
      ],
    ))
  }

  const summary = buildSummary(opts, steps)
  writeSummary(summary, opts)
  return summary.status === 'pass' ? 0 : 1
}

try {
  const opts = parseArgs(process.argv.slice(2))
  process.exit(runCloseout(opts))
} catch (error) {
  console.error(`[dingtalk-p4-final-closeout] ERROR: ${redactString(error instanceof Error ? error.message : String(error))}`)
  process.exit(1)
}
