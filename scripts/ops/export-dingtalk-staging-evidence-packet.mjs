#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_OUTPUT_DIR = 'artifacts/dingtalk-staging-evidence-packet'
const DINGTALK_P4_REQUIRED_CHECK_IDS = [
  'create-table-form',
  'bind-two-dingtalk-groups',
  'set-form-dingtalk-granted',
  'send-group-message-form-link',
  'authorized-user-submit',
  'unauthorized-user-denied',
  'delivery-history-group-person',
  'no-email-user-create-bind',
]
const MOBILE_SIGNOFF_REQUIRED_CHECK_IDS = [
  'public-anonymous-submit',
  'dingtalk-unbound-rejected',
  'dingtalk-bound-submit',
  'selected-unbound-rejected',
  'selected-bound-submit',
  'selected-unlisted-bound-rejected',
  'granted-bound-without-grant-rejected',
  'granted-bound-with-grant-submit',
  'password-change-bypass-observed',
]

const requiredPacketFiles = [
  {
    path: 'docs/development/dingtalk-staging-canary-deploy-20260408.md',
    kind: 'runbook',
    description: 'staging topology, deploy, rollback, and drift recovery notes',
  },
  {
    path: 'docs/development/dingtalk-staging-execution-checklist-20260408.md',
    kind: 'checklist',
    description: 'tenant inputs, execution order, pass criteria, and stop conditions',
  },
  {
    path: 'docs/development/dingtalk-live-tenant-validation-checklist-20260408.md',
    kind: 'checklist',
    description: 'live tenant validation scope for login, directory, attendance, and robot send',
  },
  {
    path: 'docs/development/dingtalk-stack-merge-readiness-20260408.md',
    kind: 'readiness',
    description: 'DingTalk stack merge readiness context',
  },
  {
    path: 'docs/dingtalk-admin-operations-guide-20260420.md',
    kind: 'operations-guide',
    description: 'admin procedures for DingTalk app setup, directory users, group robots, and troubleshooting',
  },
  {
    path: 'docs/dingtalk-user-workflow-guide-20260422.md',
    kind: 'user-guide',
    description: 'table-owner workflow for DingTalk group/person notifications and protected form links',
  },
  {
    path: 'docs/dingtalk-synced-account-local-user-guide-20260420.md',
    kind: 'user-governance-guide',
    description: 'manual and auto-admission paths for DingTalk-synced accounts, including no-email users',
  },
  {
    path: 'docs/dingtalk-remote-smoke-checklist-20260422.md',
    kind: 'checklist',
    description: 'P4 remote smoke checklist for protected forms, multi-group sends, and DingTalk-bound users',
  },
  {
    path: 'docs/development/dingtalk-feature-plan-and-todo-20260422.md',
    kind: 'plan',
    description: 'current DingTalk feature plan, TODO status, and remaining remote smoke tasks',
  },
  {
    path: 'docker/app.staging.env.example',
    kind: 'config-template',
    description: 'canonical staging env template; copy to docker/app.staging.env and fill secrets',
  },
  {
    path: 'scripts/ops/validate-env-file.sh',
    kind: 'script',
    description: 'fails fast on corrupted one-line env files before docker compose runs',
  },
  {
    path: 'scripts/ops/repair-env-file.sh',
    kind: 'script',
    description: 'repairs env files that contain literal \\n sequences',
  },
  {
    path: 'scripts/ops/build-dingtalk-staging-images.sh',
    kind: 'script',
    description: 'builds local PR-stack images for staging when GHCR tags are unavailable',
  },
  {
    path: 'scripts/ops/deploy-dingtalk-staging.sh',
    kind: 'script',
    description: 'validates env, resolves image tag, runs docker compose, and checks backend health',
  },
  {
    path: 'scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs',
    kind: 'script',
    description: 'compiles redacted P4 remote-smoke evidence summaries from operator-provided results',
  },
  {
    path: 'scripts/ops/dingtalk-p4-remote-smoke.mjs',
    kind: 'script',
    description: 'runs the API-only part of P4 remote smoke and writes bootstrap evidence for manual completion',
  },
  {
    path: 'scripts/ops/dingtalk-p4-smoke-preflight.mjs',
    kind: 'script',
    description: 'validates P4 remote-smoke inputs and local tooling before calling staging or DingTalk',
  },
  {
    path: 'scripts/ops/dingtalk-p4-smoke-session.mjs',
    kind: 'script',
    description: 'orchestrates P4 preflight, API-only smoke workspace bootstrap, and non-strict evidence compile',
  },
  {
    path: 'scripts/ops/dingtalk-p4-evidence-record.mjs',
    kind: 'script',
    description: 'updates one P4 evidence check safely without hand-editing evidence.json',
  },
  {
    path: 'scripts/ops/dingtalk-p4-smoke-status.mjs',
    kind: 'script',
    description: 'summarizes a P4 smoke session, evidence gaps, finalization state, and handoff readiness',
  },
  {
    path: 'scripts/ops/dingtalk-p4-final-handoff.mjs',
    kind: 'script',
    description: 'exports a finalized P4 smoke session, validates the packet, and writes handoff summaries',
  },
  {
    path: 'scripts/ops/dingtalk-p4-final-docs.mjs',
    kind: 'script',
    description: 'generates final remote-smoke development and verification Markdown from release-ready summaries',
  },
  {
    path: 'scripts/ops/dingtalk-p4-final-closeout.mjs',
    kind: 'script',
    description: 'runs strict finalize, final handoff, release-ready status, and final docs in one closeout command',
  },
  {
    path: 'scripts/ops/dingtalk-public-form-mobile-signoff.mjs',
    kind: 'script',
    description: 'builds, records, TODO-tracks, and strict-compiles real DingTalk mobile public-form signoff evidence',
  },
  {
    path: 'scripts/ops/validate-dingtalk-staging-evidence-packet.mjs',
    kind: 'script',
    description: 'validates final gated evidence packets and scans for secret-like raw evidence before handoff',
  },
]

function printHelp() {
  console.log(`Usage: node scripts/ops/export-dingtalk-staging-evidence-packet.mjs [options]

Exports the DingTalk/shared-dev staging operations packet into one artifact directory.

Options:
  --output-dir <dir>              Output directory, default ${DEFAULT_OUTPUT_DIR}
  --include-output <dir>          Optional existing evidence directory to copy into evidence/
  --require-dingtalk-p4-pass      Require every included output to be a finalized passing P4 session
  --include-mobile-signoff <dir>  Optional strict mobile signoff output dir to copy into mobile-signoff/
  --require-mobile-signoff-pass   Require every included mobile signoff output to be strict passing
  --help                          Show this help

Examples:
  node scripts/ops/export-dingtalk-staging-evidence-packet.mjs
  node scripts/ops/export-dingtalk-staging-evidence-packet.mjs \\
    --include-output output/playwright/dingtalk-directory-staging-smoke/20260416-package-script
  node scripts/ops/export-dingtalk-staging-evidence-packet.mjs \\
    --include-output output/dingtalk-p4-remote-smoke-session/142-session \\
    --require-dingtalk-p4-pass
  node scripts/ops/export-dingtalk-staging-evidence-packet.mjs \\
    --include-output output/dingtalk-p4-remote-smoke-session/142-session \\
    --require-dingtalk-p4-pass \\
    --include-mobile-signoff output/dingtalk-public-form-mobile-signoff/142-compiled \\
    --require-mobile-signoff-pass
`)
}

function readRequiredValue(argv, index, flag) {
  const next = argv[index + 1]
  if (!next || next.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return next
}

function parseArgs(argv) {
  const opts = {
    outputDir: path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR),
    includeOutputDirs: [],
    requireDingTalkP4Pass: false,
    includeMobileSignoffDirs: [],
    requireMobileSignoffPass: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    switch (arg) {
      case '--output-dir':
        opts.outputDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--include-output':
        opts.includeOutputDirs.push(path.resolve(process.cwd(), readRequiredValue(argv, i, arg)))
        i += 1
        break
      case '--require-dingtalk-p4-pass':
        opts.requireDingTalkP4Pass = true
        break
      case '--include-mobile-signoff':
        opts.includeMobileSignoffDirs.push(path.resolve(process.cwd(), readRequiredValue(argv, i, arg)))
        i += 1
        break
      case '--require-mobile-signoff-pass':
        opts.requireMobileSignoffPass = true
        break
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return opts
}

function ensureSourceFile(file) {
  const source = path.resolve(process.cwd(), file)
  if (!existsSync(source) || !statSync(source).isFile()) {
    throw new Error(`missing required packet file: ${file}`)
  }
  return source
}

function copyFileIntoPacket(file, outputDir) {
  const source = ensureSourceFile(file)
  const destination = path.join(outputDir, file)
  mkdirSync(path.dirname(destination), { recursive: true })
  cpSync(source, destination)
  return destination
}

function sanitizeEvidenceName(sourceDir) {
  return path
    .basename(sourceDir)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '') || 'evidence'
}

function readJsonFile(file, label) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`${label} does not exist: ${file}`)
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function getArray(value, field, failures) {
  if (!Array.isArray(value)) {
    failures.push(`${field} is not an array`)
    return []
  }
  return value
}

function requireEmptyArray(value, field, failures) {
  const rows = getArray(value, field, failures)
  if (rows.length > 0) failures.push(`${field} is not empty`)
  return rows
}

function hasPassingCheck(requiredChecks, id) {
  return requiredChecks.some((check) => check?.id === id && check.status === 'pass')
}

function validateDingTalkP4FinalPass(sourceDir) {
  const sessionSummaryPath = path.join(sourceDir, 'session-summary.json')
  const compiledSummaryPath = path.join(sourceDir, 'compiled', 'summary.json')
  const sessionSummary = readJsonFile(sessionSummaryPath, 'session-summary.json')
  const compiledSummary = readJsonFile(compiledSummaryPath, 'compiled/summary.json')
  const failures = []

  if (sessionSummary.tool !== 'dingtalk-p4-smoke-session') failures.push('session-summary.json tool is not dingtalk-p4-smoke-session')
  if (sessionSummary.sessionPhase !== 'finalize') failures.push('session-summary.json sessionPhase is not finalize')
  if (sessionSummary.overallStatus !== 'pass') failures.push('session-summary.json overallStatus is not pass')
  if (sessionSummary.finalStrictStatus !== 'pass') failures.push('session-summary.json finalStrictStatus is not pass')
  const sessionSteps = getArray(sessionSummary.steps, 'session-summary.json steps', failures)
  const strictCompileStep = sessionSteps.find((step) => step?.id === 'strict-compile')
  if (!strictCompileStep) {
    failures.push('session-summary.json missing strict-compile step')
  } else if (strictCompileStep.status !== 'pass') {
    failures.push('session-summary.json strict-compile step is not pass')
  }
  requireEmptyArray(sessionSummary.pendingChecks, 'session-summary.json pendingChecks', failures)

  if (compiledSummary.tool !== 'compile-dingtalk-p4-smoke-evidence') failures.push('compiled/summary.json tool is not compile-dingtalk-p4-smoke-evidence')
  if (compiledSummary.overallStatus !== 'pass') failures.push('compiled/summary.json overallStatus is not pass')
  if (compiledSummary.apiBootstrapStatus !== 'pass') failures.push('compiled/summary.json apiBootstrapStatus is not pass')
  if (compiledSummary.remoteClientStatus !== 'pass') failures.push('compiled/summary.json remoteClientStatus is not pass')
  if (compiledSummary.totals?.pendingChecks !== 0) failures.push('compiled/summary.json totals.pendingChecks is not 0')
  if (compiledSummary.totals?.missingRequiredChecks !== 0) failures.push('compiled/summary.json totals.missingRequiredChecks is not 0')
  if (compiledSummary.totals?.failedChecks !== 0) failures.push('compiled/summary.json totals.failedChecks is not 0')

  const requiredChecks = getArray(compiledSummary.requiredChecks, 'compiled/summary.json requiredChecks', failures)
  for (const id of DINGTALK_P4_REQUIRED_CHECK_IDS) {
    if (!hasPassingCheck(requiredChecks, id)) {
      failures.push(`compiled/summary.json required check ${id} is not pass`)
    }
  }
  requireEmptyArray(compiledSummary.requiredChecksNotPassed, 'compiled/summary.json requiredChecksNotPassed', failures)
  requireEmptyArray(compiledSummary.manualEvidenceIssues, 'compiled/summary.json manualEvidenceIssues', failures)
  requireEmptyArray(compiledSummary.failedChecks, 'compiled/summary.json failedChecks', failures)
  requireEmptyArray(compiledSummary.missingRequiredChecks, 'compiled/summary.json missingRequiredChecks', failures)

  if (failures.length > 0) {
    throw new Error(`included DingTalk P4 session is not final pass: ${path.relative(process.cwd(), sourceDir).replaceAll('\\', '/')} (${failures.join('; ')})`)
  }

  return {
    status: 'pass',
    sessionSummary: path.relative(sourceDir, sessionSummaryPath).replaceAll('\\', '/'),
    compiledSummary: path.relative(sourceDir, compiledSummaryPath).replaceAll('\\', '/'),
    sessionPhase: sessionSummary.sessionPhase,
    finalStrictStatus: sessionSummary.finalStrictStatus,
    compiledOverallStatus: compiledSummary.overallStatus,
    apiBootstrapStatus: compiledSummary.apiBootstrapStatus,
    remoteClientStatus: compiledSummary.remoteClientStatus,
    remoteSmokePhase: compiledSummary.remoteSmokePhase ?? null,
    requiredChecks: DINGTALK_P4_REQUIRED_CHECK_IDS.length,
  }
}

function validateEvidenceDir(sourceDir, opts) {
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    throw new Error(`--include-output must point to an existing directory: ${sourceDir}`)
  }
  return opts.requireDingTalkP4Pass ? validateDingTalkP4FinalPass(sourceDir) : null
}

function validateMobileSignoffPass(sourceDir) {
  const summaryPath = path.join(sourceDir, 'summary.json')
  const redactedEvidencePath = path.join(sourceDir, 'mobile-signoff.redacted.json')
  const summary = readJsonFile(summaryPath, 'mobile signoff summary.json')
  const failures = []

  if (summary.tool !== 'dingtalk-public-form-mobile-signoff') failures.push('summary.json tool is not dingtalk-public-form-mobile-signoff')
  if (summary.strict !== true) failures.push('summary.json strict is not true')
  if (summary.status !== 'pass') failures.push('summary.json status is not pass')
  requireEmptyArray(summary.errors, 'summary.json errors', failures)
  if (!existsSync(redactedEvidencePath) || !statSync(redactedEvidencePath).isFile()) {
    failures.push('mobile-signoff.redacted.json does not exist')
  }
  if (existsSync(path.join(sourceDir, 'mobile-signoff.json'))) {
    failures.push('raw mobile-signoff.json must not be included; use the compiled output directory')
  }
  const requiredChecks = getArray(summary.requiredChecks, 'summary.json requiredChecks', failures)
  if (requiredChecks.length !== MOBILE_SIGNOFF_REQUIRED_CHECK_IDS.length) {
    failures.push(`summary.json requiredChecks length is not ${MOBILE_SIGNOFF_REQUIRED_CHECK_IDS.length}`)
  }
  for (const id of MOBILE_SIGNOFF_REQUIRED_CHECK_IDS) {
    if (!hasPassingCheck(requiredChecks, id)) {
      failures.push(`summary.json required check ${id} is not pass`)
    }
  }

  if (failures.length > 0) {
    throw new Error(`included mobile signoff output is not strict pass: ${path.relative(process.cwd(), sourceDir).replaceAll('\\', '/')} (${failures.join('; ')})`)
  }

  return {
    status: 'pass',
    summary: path.relative(sourceDir, summaryPath).replaceAll('\\', '/'),
    redactedEvidence: path.relative(sourceDir, redactedEvidencePath).replaceAll('\\', '/'),
    strict: summary.strict,
    overallStatus: summary.status,
    requiredChecks: MOBILE_SIGNOFF_REQUIRED_CHECK_IDS.length,
  }
}

function validateMobileSignoffDir(sourceDir, opts) {
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    throw new Error(`--include-mobile-signoff must point to an existing directory: ${sourceDir}`)
  }
  if (existsSync(path.join(sourceDir, 'mobile-signoff.json'))) {
    throw new Error(`--include-mobile-signoff must point to a compiled/redacted output directory, not a raw kit directory: ${sourceDir}`)
  }
  return opts.requireMobileSignoffPass ? validateMobileSignoffPass(sourceDir) : null
}

function inspectExistingPacketOutputDir(outputDir) {
  if (!existsSync(outputDir)) return { exists: false, isExistingPacket: false, entryCount: 0 }
  if (!statSync(outputDir).isDirectory()) {
    throw new Error(`--output-dir must be a directory: ${outputDir}`)
  }
  const manifestPath = path.join(outputDir, 'manifest.json')
  const readmePath = path.join(outputDir, 'README.md')
  let isExistingPacket = false
  if (existsSync(manifestPath) && statSync(manifestPath).isFile()) {
    try {
      isExistingPacket = readJsonFile(manifestPath, 'manifest.json')?.packet === 'dingtalk-staging-evidence-packet'
    } catch {
      isExistingPacket = false
    }
  }
  if (!isExistingPacket && existsSync(readmePath) && statSync(readmePath).isFile()) {
    isExistingPacket = readFileSync(readmePath, 'utf8').includes('# DingTalk Staging Evidence Packet')
  }
  return {
    exists: true,
    isExistingPacket,
    entryCount: readdirSync(outputDir).length,
  }
}

function clearGeneratedPacketMarkers(outputDir) {
  const inspected = inspectExistingPacketOutputDir(outputDir)
  if (inspected.exists && inspected.entryCount > 0 && !inspected.isExistingPacket) {
    throw new Error('--output-dir already exists and is not a DingTalk staging evidence packet; choose an empty/new packet directory')
  }
  const manifestPath = path.join(outputDir, 'manifest.json')
  const readmePath = path.join(outputDir, 'README.md')
  if (!inspected.exists || inspected.entryCount === 0) return
  if (inspected.isExistingPacket) {
    rmSync(path.join(outputDir, 'evidence'), { recursive: true, force: true })
  }
  for (const file of ['manifest.json', 'README.md']) {
    rmSync(path.join(outputDir, file), { force: true })
  }
}

function copyEvidenceDir(sourceDir, outputDir, index, dingtalkP4FinalStatus) {
  const destinationName = `${String(index + 1).padStart(2, '0')}-${sanitizeEvidenceName(sourceDir)}`
  const destination = path.join(outputDir, 'evidence', destinationName)
  mkdirSync(path.dirname(destination), { recursive: true })
  rmSync(destination, { recursive: true, force: true })
  cpSync(sourceDir, destination, { recursive: true })
  return {
    source: path.relative(process.cwd(), sourceDir).replaceAll('\\', '/'),
    destination: path.relative(outputDir, destination).replaceAll('\\', '/'),
    ...(dingtalkP4FinalStatus ? { dingtalkP4FinalStatus } : {}),
  }
}

function copyMobileSignoffDir(sourceDir, outputDir, index, mobileSignoffStatus) {
  const destinationName = `${String(index + 1).padStart(2, '0')}-${sanitizeEvidenceName(sourceDir)}`
  const destination = path.join(outputDir, 'mobile-signoff', destinationName)
  mkdirSync(path.dirname(destination), { recursive: true })
  rmSync(destination, { recursive: true, force: true })
  cpSync(sourceDir, destination, { recursive: true })
  return {
    source: path.relative(process.cwd(), sourceDir).replaceAll('\\', '/'),
    destination: path.relative(outputDir, destination).replaceAll('\\', '/'),
    ...(mobileSignoffStatus ? { mobileSignoffStatus } : {}),
  }
}

function renderReadme(manifest) {
  const docs = manifest.files.filter((file) => file.kind !== 'script')
  const scripts = manifest.files.filter((file) => file.kind === 'script')
  const evidence = manifest.includedEvidence
  const mobileSignoff = Array.isArray(manifest.includedMobileSignoff) ? manifest.includedMobileSignoff : []

  const fileLine = (file) => `- \`${file.path}\` — ${file.description}`
  const evidenceLines = evidence.length
    ? evidence.map((entry) => `- \`${entry.destination}\` copied from \`${entry.source}\``).join('\n')
    : '- No runtime evidence directory was included. Re-run with `--include-output <dir>` after staging smoke.'
  const mobileSignoffLines = mobileSignoff.length
    ? mobileSignoff.map((entry) => `- \`${entry.destination}\` copied from \`${entry.source}\``).join('\n')
    : '- No mobile public-form signoff directory was included. Re-run with `--include-mobile-signoff <dir>` after real DingTalk mobile signoff.'
  const gateLine = manifest.requireDingTalkP4Pass
    ? '- DingTalk P4 final-pass gate was enabled; every included output was validated before copy.'
    : '- DingTalk P4 final-pass gate was not enabled. Use `--require-dingtalk-p4-pass` for release evidence handoff.'
  const mobileGateLine = manifest.requireMobileSignoffPass
    ? '- DingTalk mobile public-form signoff gate was enabled; every included mobile signoff output was validated before copy.'
    : '- DingTalk mobile public-form signoff gate was not enabled. Use `--require-mobile-signoff-pass` for release evidence handoff.'

  return `# DingTalk Staging Evidence Packet

Generated at: ${manifest.generatedAt}

This packet is the operator handoff bundle for the shared-dev/142 DingTalk
staging stack. It is intentionally read-only: exporting it does not deploy,
call Docker, hit staging, or require credentials.

## Included Docs And Config

${docs.map(fileLine).join('\n')}

## Included Scripts

${scripts.map(fileLine).join('\n')}

## Included Runtime Evidence

${evidenceLines}

## Included Mobile Public-Form Signoff

${mobileSignoffLines}

## Evidence Gates

${gateLine}
${mobileGateLine}

## Recommended Order

1. Read \`docs/development/dingtalk-staging-canary-deploy-20260408.md\`.
2. Copy \`docker/app.staging.env.example\` to \`docker/app.staging.env\` and fill real secrets on the server only.
3. Validate the env with \`bash scripts/ops/validate-env-file.sh docker/app.staging.env\`.
4. Deploy a pinned tag with \`DEPLOY_IMAGE_TAG=<tag> bash scripts/ops/deploy-dingtalk-staging.sh\`.
5. Execute \`docs/development/dingtalk-staging-execution-checklist-20260408.md\`.
6. Execute \`docs/dingtalk-remote-smoke-checklist-20260422.md\` for P4 DingTalk form/group/person coverage.
7. Run the session orchestrator with \`node scripts/ops/dingtalk-p4-smoke-session.mjs --output-dir <session-dir>\`.
8. If needed, debug individual steps with \`dingtalk-p4-smoke-preflight.mjs\` and \`dingtalk-p4-remote-smoke.mjs\`.
9. Check remaining evidence gaps with \`node scripts/ops/dingtalk-p4-smoke-status.mjs --session-dir <session-dir>\`.
10. Record manual DingTalk-client/admin checks with \`node scripts/ops/dingtalk-p4-evidence-record.mjs --session-dir <session-dir> ...\`.
11. Prefer \`node scripts/ops/dingtalk-p4-final-closeout.mjs --session-dir <session-dir> --packet-output-dir <packet-dir>\` after all manual evidence is complete.
12. If debugging manually, finalize smoke evidence with \`node scripts/ops/dingtalk-p4-smoke-session.mjs --finalize <session-dir>\`.
13. Re-run \`dingtalk-p4-smoke-status.mjs\` to confirm the status moved to \`handoff_pending\`.
14. Run \`node scripts/ops/dingtalk-p4-final-handoff.mjs --session-dir <session-dir> --output-dir <packet-dir>\` after finalization passes.
15. Re-run \`node scripts/ops/dingtalk-p4-smoke-status.mjs --session-dir <session-dir> --handoff-summary <packet-dir>/handoff-summary.json --require-release-ready\`.
16. Generate final docs with \`node scripts/ops/dingtalk-p4-final-docs.mjs --session-dir <session-dir> --handoff-summary <packet-dir>/handoff-summary.json --require-release-ready\`.
17. For public-form mobile acceptance, create a kit with \`node scripts/ops/dingtalk-public-form-mobile-signoff.mjs --init-kit <mobile-kit-dir>\`.
18. Track remaining checks with \`node scripts/ops/dingtalk-public-form-mobile-signoff.mjs --todo <mobile-kit-dir>/mobile-signoff.json --output-dir <mobile-kit-dir>/todo\`.
19. Record each real DingTalk mobile result with the suggested \`--record ... --compile-when-ready\` command until strict output is written.
20. If debugging manually, re-export with \`--include-output <session-dir> --require-dingtalk-p4-pass --include-mobile-signoff <mobile-compiled-dir> --require-mobile-signoff-pass\`, then validate with \`validate-dingtalk-staging-evidence-packet.mjs\`.

## Non-Goals

- The exporter does not generate secrets; included evidence must be reviewed and redacted before release handoff.
- Does not mutate \`docker/app.staging.env\`.
- Does not run remote smoke tests.
- Does not decide whether a staging result is production-ready.
`
}

async function main() {
  try {
    const opts = parseArgs(process.argv.slice(2))
    clearGeneratedPacketMarkers(opts.outputDir)
    if (opts.requireDingTalkP4Pass && opts.includeOutputDirs.length === 0) {
      throw new Error('--require-dingtalk-p4-pass requires at least one --include-output session directory')
    }
    if (opts.requireMobileSignoffPass && opts.includeMobileSignoffDirs.length === 0) {
      throw new Error('--require-mobile-signoff-pass requires at least one --include-mobile-signoff directory')
    }
    const evidenceValidations = opts.includeOutputDirs.map((dir) => validateEvidenceDir(dir, opts))
    const mobileSignoffValidations = opts.includeMobileSignoffDirs.map((dir) => validateMobileSignoffDir(dir, opts))
    mkdirSync(opts.outputDir, { recursive: true })

    const copiedFiles = requiredPacketFiles.map((entry) => {
      const destination = copyFileIntoPacket(entry.path, opts.outputDir)
      console.log(`Copied ${entry.path}`)
      return {
        ...entry,
        destination: path.relative(opts.outputDir, destination).replaceAll('\\', '/'),
      }
    })

    const includedEvidence = opts.includeOutputDirs.map((dir, index) => {
      const copied = copyEvidenceDir(dir, opts.outputDir, index, evidenceValidations[index])
      console.log(`Copied evidence ${copied.source}`)
      return copied
    })

    const includedMobileSignoff = opts.includeMobileSignoffDirs.map((dir, index) => {
      const copied = copyMobileSignoffDir(dir, opts.outputDir, index, mobileSignoffValidations[index])
      console.log(`Copied mobile signoff ${copied.source}`)
      return copied
    })

    const manifest = {
      packet: 'dingtalk-staging-evidence-packet',
      generatedAt: new Date().toISOString(),
      repoRoot: process.cwd(),
      requireDingTalkP4Pass: opts.requireDingTalkP4Pass,
      requireMobileSignoffPass: opts.requireMobileSignoffPass,
      files: copiedFiles,
      includedEvidence,
      includedMobileSignoff,
    }

    const manifestPath = path.join(opts.outputDir, 'manifest.json')
    const readmePath = path.join(opts.outputDir, 'README.md')
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    writeFileSync(readmePath, `${renderReadme(manifest)}\n`, 'utf8')
    console.log(`Wrote ${path.relative(process.cwd(), manifestPath)}`)
    console.log(`Wrote ${path.relative(process.cwd(), readmePath)}`)
  } catch (error) {
    console.error(`[export-dingtalk-staging-evidence-packet] ERROR: ${error.message}`)
    process.exit(1)
  }
}

await main()
