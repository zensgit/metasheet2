#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const DEFAULT_PACKET_ROOT = 'artifacts/dingtalk-staging-evidence-packet'

function printHelp() {
  console.log(`Usage: node scripts/ops/dingtalk-p4-final-handoff.mjs [options]

Exports and validates a finalized DingTalk P4 smoke session in one local handoff command.

Options:
  --session-dir <dir>          Finalized DingTalk P4 smoke session directory (required)
  --output-dir <dir>           Packet directory, default ${DEFAULT_PACKET_ROOT}/<session-name>-final
  --include-mobile-signoff <dir>
                               Optional strict mobile public-form signoff output dir
  --require-mobile-signoff-pass
                               Require every included mobile signoff output to be strict passing
  --publish-check-json <file>  Validator JSON output, default <output-dir>/publish-check.json
  --summary-json <file>        Handoff JSON summary, default <output-dir>/handoff-summary.json
  --summary-md <file>          Handoff Markdown summary, default <output-dir>/handoff-summary.md
  --help                       Show this help
`)
}

function readRequiredValue(argv, index, flag) {
  const next = argv[index + 1]
  if (!next || next.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return next
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
    outputDir: '',
    includeMobileSignoffDirs: [],
    requireMobileSignoffPass: false,
    publishCheckJson: '',
    summaryJson: '',
    summaryMd: '',
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--session-dir':
        opts.sessionDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--output-dir':
        opts.outputDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--include-mobile-signoff':
        opts.includeMobileSignoffDirs.push(path.resolve(process.cwd(), readRequiredValue(argv, i, arg)))
        i += 1
        break
      case '--require-mobile-signoff-pass':
        opts.requireMobileSignoffPass = true
        break
      case '--publish-check-json':
        opts.publishCheckJson = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
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
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!opts.sessionDir) throw new Error('--session-dir is required')
  if (!opts.outputDir) {
    opts.outputDir = path.resolve(process.cwd(), DEFAULT_PACKET_ROOT, `${sanitizeName(opts.sessionDir)}-final`)
  }
  opts.publishCheckJson ||= path.join(opts.outputDir, 'publish-check.json')
  opts.summaryJson ||= path.join(opts.outputDir, 'handoff-summary.json')
  opts.summaryMd ||= path.join(opts.outputDir, 'handoff-summary.md')
  return opts
}

function relativePath(file) {
  return path.relative(process.cwd(), file).replaceAll('\\', '/')
}

function redactString(value) {
  return String(value)
    .replace(/(access_token=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/(publicToken=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/([?&](?:sign|timestamp)=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/((?:client_secret|DINGTALK_CLIENT_SECRET|DINGTALK_STATE_SECRET)=)[^\s&]+/gi, '$1<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\bSEC[A-Za-z0-9+/=_-]{8,}\b/g, 'SEC<redacted>')
    .replace(/\beyJ[A-Za-z0-9._-]{20,}\b/g, '<jwt:redacted>')
}

function readJsonIfExists(file) {
  if (!existsSync(file) || !statSync(file).isFile()) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}

function compactText(value) {
  const text = redactString(value ?? '').trim()
  if (!text) return ''
  return text.length > 4000 ? `${text.slice(0, 3997)}...` : text
}

function runNodeStep(id, label, args) {
  const startedAt = new Date().toISOString()
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  const finishedAt = new Date().toISOString()
  return {
    id,
    label,
    command: `node ${args.join(' ')}`,
    status: result.status === 0 ? 'pass' : 'fail',
    exitCode: result.status ?? 1,
    startedAt,
    finishedAt,
    stdout: compactText(result.stdout),
    stderr: compactText(result.stderr),
  }
}

function validateSessionDir(sessionDir) {
  if (!existsSync(sessionDir) || !statSync(sessionDir).isDirectory()) {
    throw new Error(`--session-dir must point to an existing directory: ${relativePath(sessionDir)}`)
  }
}

function pathsOverlap(left, right) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`)
}

function validateOutputDir(opts) {
  if (pathsOverlap(opts.outputDir, opts.sessionDir)) {
    throw new Error('--output-dir must not be the session directory or overlap with it')
  }
}

function validateMobileSignoffArgs(opts) {
  if (opts.requireMobileSignoffPass && opts.includeMobileSignoffDirs.length === 0) {
    throw new Error('--require-mobile-signoff-pass requires at least one --include-mobile-signoff directory')
  }
}

function clearGeneratedHandoffMarkers(opts) {
  for (const file of [opts.publishCheckJson, opts.summaryJson, opts.summaryMd]) {
    rmSync(file, { force: true })
  }
}

function mobileSignoffExportArgs(opts) {
  const args = []
  for (const dir of opts.includeMobileSignoffDirs) {
    args.push('--include-mobile-signoff', relativePath(dir))
  }
  if (opts.requireMobileSignoffPass) args.push('--require-mobile-signoff-pass')
  return args
}

function canWriteFailureSummary(opts) {
  return !pathsOverlap(opts.outputDir, opts.sessionDir)
}

function sanitizePublishCheck(value) {
  if (!value || typeof value !== 'object') return value
  return {
    ...value,
    secretFindings: Array.isArray(value.secretFindings)
      ? value.secretFindings.map((finding) => ({
          ...finding,
          preview: finding?.preview ? '<redacted>' : finding?.preview,
        }))
      : value.secretFindings,
  }
}

function renderMarkdown(summary) {
  const stepRows = summary.steps.map((step) => {
    const notes = step.stderr || step.stdout.split(/\r?\n/).filter(Boolean).at(-1) || ''
    return `| \`${step.id}\` | ${step.status} | ${step.exitCode} | ${notes.replaceAll('|', '\\|')} |`
  })
  const failures = summary.failures.length
    ? summary.failures.map((failure) => `- ${failure}`).join('\n')
    : '- None'
  const publishStatus = summary.publishCheck?.status ?? 'not_available'

  return `# DingTalk P4 Final Handoff Summary

Generated at: ${summary.generatedAt}

Overall status: **${summary.status}**

Session directory: \`${summary.sessionDir}\`

Packet directory: \`${summary.outputDir}\`

Publish check status: **${publishStatus}**

Mobile signoff gate: **${summary.mobileSignoff.required ? 'required' : 'not_required'}**

Included mobile signoff count: **${summary.mobileSignoff.includedCount}**

## Steps

| Step | Status | Exit | Notes |
| --- | --- | --- | --- |
${stepRows.join('\n')}

## Outputs

- Packet manifest: \`${summary.outputs.manifest}\`
- Packet README: \`${summary.outputs.readme}\`
- Publish check JSON: \`${summary.outputs.publishCheckJson}\`
- Handoff summary JSON: \`${summary.outputs.summaryJson}\`
- Handoff summary Markdown: \`${summary.outputs.summaryMd}\`

## Failures

${failures}

## Next Action

${summary.status === 'pass'
  ? '- Packet is ready for human release handoff review. Review raw artifacts once more before sharing externally.'
  : '- Fix the failed step above, rerun this command, and do not publish the packet until this summary is pass.'}
`
}

function writeSummary(summary, opts) {
  mkdirSync(path.dirname(opts.summaryJson), { recursive: true })
  mkdirSync(path.dirname(opts.summaryMd), { recursive: true })
  writeFileSync(opts.summaryJson, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  writeFileSync(opts.summaryMd, `${renderMarkdown(summary)}\n`, 'utf8')
}

function buildSummary(opts, steps) {
  const publishCheck = sanitizePublishCheck(readJsonIfExists(opts.publishCheckJson))
  const sessionSummary = readJsonIfExists(path.join(opts.sessionDir, 'session-summary.json'))
  const failures = []
  for (const step of steps) {
    if (step.status !== 'pass') failures.push(`${step.id} failed with exit code ${step.exitCode}`)
  }
  if (publishCheck && publishCheck.status !== 'pass') {
    failures.push(...(Array.isArray(publishCheck.failures) ? publishCheck.failures : ['publish check failed']))
  }

  return {
    tool: 'dingtalk-p4-final-handoff',
    generatedAt: new Date().toISOString(),
    status: steps.every((step) => step.status === 'pass') && publishCheck?.status === 'pass' ? 'pass' : 'fail',
    sessionDir: relativePath(opts.sessionDir),
    sessionRunId: typeof sessionSummary?.runId === 'string' ? sessionSummary.runId : '',
    outputDir: relativePath(opts.outputDir),
    steps,
    publishCheck,
    mobileSignoff: {
      required: opts.requireMobileSignoffPass,
      includedCount: publishCheck?.includedMobileSignoffCount ?? 0,
      sources: opts.includeMobileSignoffDirs.map((dir) => relativePath(dir)),
    },
    failures,
    outputs: {
      manifest: relativePath(path.join(opts.outputDir, 'manifest.json')),
      readme: relativePath(path.join(opts.outputDir, 'README.md')),
      publishCheckJson: relativePath(opts.publishCheckJson),
      summaryJson: relativePath(opts.summaryJson),
      summaryMd: relativePath(opts.summaryMd),
    },
  }
}

async function main() {
  let opts
  let steps = []
  try {
    opts = parseArgs(process.argv.slice(2))
    validateSessionDir(opts.sessionDir)
    validateOutputDir(opts)
    validateMobileSignoffArgs(opts)
    clearGeneratedHandoffMarkers(opts)

    const exportStep = runNodeStep('export-packet', 'Export final gated packet', [
      'scripts/ops/export-dingtalk-staging-evidence-packet.mjs',
      '--include-output',
      relativePath(opts.sessionDir),
      '--require-dingtalk-p4-pass',
      ...mobileSignoffExportArgs(opts),
      '--output-dir',
      relativePath(opts.outputDir),
    ])
    steps.push(exportStep)

    if (exportStep.status === 'pass') {
      const validateStep = runNodeStep('validate-packet', 'Validate packet publish readiness', [
        'scripts/ops/validate-dingtalk-staging-evidence-packet.mjs',
        '--packet-dir',
        relativePath(opts.outputDir),
        '--output-json',
        relativePath(opts.publishCheckJson),
      ])
      steps.push(validateStep)
    }

    const summary = buildSummary(opts, steps)
    writeSummary(summary, opts)
    console.log(`Wrote ${relativePath(opts.summaryJson)}`)
    console.log(`Wrote ${relativePath(opts.summaryMd)}`)
    if (summary.status !== 'pass') process.exit(1)
  } catch (error) {
    if (opts && canWriteFailureSummary(opts)) {
      const summary = buildSummary(opts, steps)
      summary.status = 'fail'
      summary.failures.push(error instanceof Error ? error.message : String(error))
      writeSummary(summary, opts)
      console.log(`Wrote ${relativePath(opts.summaryJson)}`)
      console.log(`Wrote ${relativePath(opts.summaryMd)}`)
    }
    console.error(`[dingtalk-p4-final-handoff] ERROR: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

await main()
