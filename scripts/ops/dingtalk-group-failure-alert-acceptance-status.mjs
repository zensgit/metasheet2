#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_OUTPUT_DIR = 'output/dingtalk-group-failure-alert-acceptance-status'
const DEFAULT_PROBE_OUTPUT_DIR = 'output/dingtalk-group-failure-alert-probe/142-acceptance'
const DEFAULT_ALERT_SUBJECT = 'MetaSheet DingTalk group delivery failed'
const SCHEMA_VERSION = 1

function printHelp() {
  console.log(`Usage: node scripts/ops/dingtalk-group-failure-alert-acceptance-status.mjs [options]

Checks whether the private inputs for the DingTalk group failure-alert live
acceptance probe are ready. It does not call 142, does not call DingTalk, and
does not print token values.

Options:
  --env-file <file>              Optional env file with probe inputs
  --write-env-template <file>    Write a fill-in env template and exit
  --force                        Overwrite an existing env template
  --api-base <url>               Overrides DINGTALK_GROUP_FAILURE_ALERT_API_BASE
  --auth-token <token>           Token presence check only; never written
  --auth-token-file <file>       Overrides DINGTALK_GROUP_FAILURE_ALERT_AUTH_TOKEN_FILE
  --sheet-id <id>                Overrides DINGTALK_GROUP_FAILURE_ALERT_SHEET_ID
  --rule-id <id>                 Overrides DINGTALK_GROUP_FAILURE_ALERT_RULE_ID
  --record-id <id>               Overrides DINGTALK_GROUP_FAILURE_ALERT_RECORD_ID
  --expect-person-status <s>     success, skipped, failed, none, or any; default success
  --alert-subject <text>         Creator alert subject matcher
  --probe-output-dir <dir>       Output dir to use in the generated probe command
  --output-json <file>           Output JSON path, default ${DEFAULT_OUTPUT_DIR}/summary.json
  --output-md <file>             Output Markdown path, default ${DEFAULT_OUTPUT_DIR}/summary.md
  --allow-blocked                Exit 0 even when required inputs are missing
  --help                         Show this help
`)
}

function readRequiredValue(argv, index, flag) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function parseArgs(argv) {
  const opts = {
    envFile: '',
    writeEnvTemplate: '',
    outputJson: path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR, 'summary.json'),
    outputMd: path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR, 'summary.md'),
    cli: {},
    allowBlocked: false,
    force: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--env-file':
        opts.envFile = path.resolve(process.cwd(), readRequiredValue(argv, index, arg))
        index += 1
        break
      case '--write-env-template':
        opts.writeEnvTemplate = path.resolve(process.cwd(), readRequiredValue(argv, index, arg))
        index += 1
        break
      case '--force':
        opts.force = true
        break
      case '--api-base':
        opts.cli.apiBase = readRequiredValue(argv, index, arg)
        index += 1
        break
      case '--auth-token':
        opts.cli.authToken = readRequiredValue(argv, index, arg)
        index += 1
        break
      case '--auth-token-file':
        opts.cli.authTokenFile = path.resolve(process.cwd(), readRequiredValue(argv, index, arg))
        index += 1
        break
      case '--sheet-id':
        opts.cli.sheetId = readRequiredValue(argv, index, arg)
        index += 1
        break
      case '--rule-id':
        opts.cli.ruleId = readRequiredValue(argv, index, arg)
        index += 1
        break
      case '--record-id':
        opts.cli.recordId = readRequiredValue(argv, index, arg)
        index += 1
        break
      case '--expect-person-status':
        opts.cli.expectPersonStatus = readRequiredValue(argv, index, arg)
        index += 1
        break
      case '--alert-subject':
        opts.cli.alertSubject = readRequiredValue(argv, index, arg)
        index += 1
        break
      case '--probe-output-dir':
        opts.cli.probeOutputDir = readRequiredValue(argv, index, arg)
        index += 1
        break
      case '--output-json':
        opts.outputJson = path.resolve(process.cwd(), readRequiredValue(argv, index, arg))
        index += 1
        break
      case '--output-md':
        opts.outputMd = path.resolve(process.cwd(), readRequiredValue(argv, index, arg))
        index += 1
        break
      case '--allow-blocked':
        opts.allowBlocked = true
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

function unquoteEnvValue(value) {
  const trimmed = String(value ?? '').trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\')
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function readEnvFile(file) {
  const values = new Map()
  if (!file) return values
  if (!existsSync(file)) throw new Error(`env file not found: ${file}`)
  const text = readFileSync(file, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    values.set(trimmed.slice(0, index).trim(), unquoteEnvValue(trimmed.slice(index + 1)))
  }
  return values
}

function renderEnvTemplate() {
  return `# DingTalk group failure-alert live acceptance inputs.
# This file is consumed by:
# node scripts/ops/dingtalk-group-failure-alert-acceptance-status.mjs --env-file <this-file>
#
# Do not commit a filled copy. Keep real admin tokens outside the repo.

# 142 or target backend API base.
DINGTALK_GROUP_FAILURE_ALERT_API_BASE="http://142.171.239.56:8081"

# Prefer a token file. Leave AUTH_TOKEN blank unless a file is not available.
DINGTALK_GROUP_FAILURE_ALERT_AUTH_TOKEN_FILE="/tmp/metasheet-142-main-admin-72h.jwt"
DINGTALK_GROUP_FAILURE_ALERT_AUTH_TOKEN=""

# Fill these after selecting the multitable sheet and DingTalk group automation rule.
DINGTALK_GROUP_FAILURE_ALERT_SHEET_ID=""
DINGTALK_GROUP_FAILURE_ALERT_RULE_ID=""

# Fill this with the record id from a fresh controlled failed group robot test.
DINGTALK_GROUP_FAILURE_ALERT_RECORD_ID=""

# Usually "success" for a linked rule creator. Use skipped/failed/none/any for other scenarios.
DINGTALK_GROUP_FAILURE_ALERT_EXPECT_PERSON_STATUS="success"

# Leave default unless the creator work-notification subject was customized.
DINGTALK_GROUP_FAILURE_ALERT_SUBJECT="${DEFAULT_ALERT_SUBJECT}"

# Where the probe should write its redaction-safe PASS/BLOCKED evidence.
DINGTALK_GROUP_FAILURE_ALERT_PROBE_OUTPUT_DIR="${DEFAULT_PROBE_OUTPUT_DIR}"
`
}

function writeEnvTemplate(file, force = false) {
  if (existsSync(file) && !force) {
    throw new Error(`env template already exists: ${file}; pass --force to overwrite`)
  }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, renderEnvTemplate(), 'utf8')
}

function firstValue(cliValue, envValues, ...keys) {
  if (typeof cliValue === 'string' && cliValue.trim()) return cliValue.trim()
  for (const key of keys) {
    const fromFile = envValues.get(key)
    if (typeof fromFile === 'string' && fromFile.trim()) return fromFile.trim()
    const fromEnv = process.env[key]
    if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  }
  return ''
}

function relativePath(file) {
  return path.relative(process.cwd(), file).replaceAll('\\', '/')
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function redactString(value) {
  return String(value ?? '')
    .replace(/(access_token=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/([?&](?:sign|timestamp)=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\bSEC[A-Za-z0-9+/=_-]{8,}\b/g, 'SEC<redacted>')
    .replace(/\beyJ[A-Za-z0-9._-]{20,}\.[A-Za-z0-9._-]{20,}\.[A-Za-z0-9._-]{10,}\b/g, '<jwt:redacted>')
}

function redactPath(file) {
  return file ? relativePath(file) : ''
}

function normalizeValues(opts, envValues) {
  const authTokenFile = firstValue(
    opts.cli.authTokenFile,
    envValues,
    'DINGTALK_GROUP_FAILURE_ALERT_AUTH_TOKEN_FILE',
    'ADMIN_TOKEN_FILE',
    'AUTH_TOKEN_FILE',
  )

  return {
    apiBase: firstValue(opts.cli.apiBase, envValues, 'DINGTALK_GROUP_FAILURE_ALERT_API_BASE', 'API_BASE'),
    authToken: firstValue(opts.cli.authToken, envValues, 'DINGTALK_GROUP_FAILURE_ALERT_AUTH_TOKEN', 'ADMIN_TOKEN', 'AUTH_TOKEN'),
    authTokenFile: authTokenFile ? path.resolve(process.cwd(), authTokenFile) : '',
    sheetId: firstValue(opts.cli.sheetId, envValues, 'DINGTALK_GROUP_FAILURE_ALERT_SHEET_ID', 'SHEET_ID'),
    ruleId: firstValue(opts.cli.ruleId, envValues, 'DINGTALK_GROUP_FAILURE_ALERT_RULE_ID', 'RULE_ID'),
    recordId: firstValue(opts.cli.recordId, envValues, 'DINGTALK_GROUP_FAILURE_ALERT_RECORD_ID', 'RECORD_ID'),
    expectPersonStatus: firstValue(opts.cli.expectPersonStatus, envValues, 'DINGTALK_GROUP_FAILURE_ALERT_EXPECT_PERSON_STATUS') || 'success',
    alertSubject: firstValue(opts.cli.alertSubject, envValues, 'DINGTALK_GROUP_FAILURE_ALERT_SUBJECT', 'ALERT_SUBJECT') || DEFAULT_ALERT_SUBJECT,
    probeOutputDir: firstValue(opts.cli.probeOutputDir, envValues, 'DINGTALK_GROUP_FAILURE_ALERT_PROBE_OUTPUT_DIR') || DEFAULT_PROBE_OUTPUT_DIR,
  }
}

function isValidUrl(value) {
  if (!value) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function addCheck(summary, id, label, passed, details = {}, remediation = '') {
  summary.checks.push({
    id,
    label,
    status: passed ? 'pass' : 'fail',
    details,
    remediation,
  })
}

function buildProbeCommand(values) {
  const authArgs = values.authTokenFile
    ? ['--auth-token-file', shellQuote(values.authTokenFile)]
    : ['--auth-token', '"$DINGTALK_GROUP_FAILURE_ALERT_AUTH_TOKEN"']
  return [
    'node scripts/ops/dingtalk-group-failure-alert-probe.mjs',
    '--api-base',
    shellQuote(values.apiBase),
    ...authArgs,
    '--sheet-id',
    shellQuote(values.sheetId),
    '--rule-id',
    shellQuote(values.ruleId),
    '--record-id',
    shellQuote(values.recordId),
    '--acceptance',
    '--expect-person-status',
    shellQuote(values.expectPersonStatus),
    '--alert-subject',
    shellQuote(values.alertSubject),
    '--output-dir',
    shellQuote(values.probeOutputDir),
  ].join(' ')
}

function buildOptOutCommand(values) {
  const authArgs = values.authTokenFile
    ? ['--auth-token-file', shellQuote(values.authTokenFile)]
    : ['--auth-token', '"$DINGTALK_GROUP_FAILURE_ALERT_AUTH_TOKEN"']
  return [
    'node scripts/ops/dingtalk-group-failure-alert-probe.mjs',
    '--api-base',
    shellQuote(values.apiBase),
    ...authArgs,
    '--sheet-id',
    shellQuote(values.sheetId),
    '--rule-id',
    shellQuote(values.ruleId),
    '--record-id',
    shellQuote(values.recordId),
    '--expect-alert disabled',
    '--expect-person-status none',
    '--require-group-failure',
    '--output-dir',
    shellQuote(values.probeOutputDir.replace(/142-acceptance$/, '142-opt-out')),
  ].join(' ')
}

function buildSummary(opts, values) {
  const summary = {
    tool: 'dingtalk-group-failure-alert-acceptance-status',
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    envFile: opts.envFile ? relativePath(opts.envFile) : '',
    overallStatus: 'blocked',
    inputs: {
      apiBase: redactString(values.apiBase),
      authTokenPresent: Boolean(values.authToken),
      authTokenFile: redactPath(values.authTokenFile),
      authTokenFilePresent: Boolean(values.authTokenFile && existsSync(values.authTokenFile)),
      sheetIdPresent: Boolean(values.sheetId),
      ruleIdPresent: Boolean(values.ruleId),
      recordIdPresent: Boolean(values.recordId),
      expectPersonStatus: values.expectPersonStatus,
      alertSubject: values.alertSubject,
      probeOutputDir: values.probeOutputDir,
    },
    checks: [],
    missingInputs: [],
    nextCommands: [],
    notes: [
      'This status helper does not call 142, DingTalk, or trigger automations.',
      'Use the generated probe command only after producing a fresh failed group robot delivery for the selected record.',
    ],
  }

  addCheck(summary, 'api-base-present', 'API base is present', Boolean(values.apiBase), {}, 'Set DINGTALK_GROUP_FAILURE_ALERT_API_BASE or pass --api-base.')
  addCheck(summary, 'api-base-url', 'API base is an http(s) URL', isValidUrl(values.apiBase), { apiBase: redactString(values.apiBase) }, 'Use a valid API base such as http://142.171.239.56:8081.')
  addCheck(summary, 'auth-present', 'Admin token or token file is present', Boolean(values.authToken || values.authTokenFile), {
    authTokenPresent: Boolean(values.authToken),
    authTokenFile: redactPath(values.authTokenFile),
  }, 'Set DINGTALK_GROUP_FAILURE_ALERT_AUTH_TOKEN_FILE or DINGTALK_GROUP_FAILURE_ALERT_AUTH_TOKEN.')
  addCheck(summary, 'auth-token-file-readable', 'Token file is readable when provided', !values.authTokenFile || existsSync(values.authTokenFile), {
    authTokenFile: redactPath(values.authTokenFile),
  }, 'Refresh or correct the admin token file path.')
  addCheck(summary, 'sheet-id-present', 'Sheet id is present', Boolean(values.sheetId), {}, 'Set DINGTALK_GROUP_FAILURE_ALERT_SHEET_ID or pass --sheet-id.')
  addCheck(summary, 'rule-id-present', 'Automation rule id is present', Boolean(values.ruleId), {}, 'Set DINGTALK_GROUP_FAILURE_ALERT_RULE_ID or pass --rule-id.')
  addCheck(summary, 'record-id-present', 'Fresh failed test record id is present', Boolean(values.recordId), {}, 'Trigger one controlled failed group delivery and set DINGTALK_GROUP_FAILURE_ALERT_RECORD_ID.')
  addCheck(summary, 'expect-person-status-valid', 'Expected creator alert status is valid', ['success', 'skipped', 'failed', 'none', 'any'].includes(values.expectPersonStatus), {
    expectPersonStatus: values.expectPersonStatus,
  }, 'Use success, skipped, failed, none, or any.')
  addCheck(summary, 'alert-subject-present', 'Creator alert subject matcher is present', Boolean(values.alertSubject), {}, 'Set DINGTALK_GROUP_FAILURE_ALERT_SUBJECT or use the default subject.')

  summary.missingInputs = summary.checks
    .filter((check) => check.status === 'fail')
    .map((check) => ({
      id: check.id,
      label: check.label,
      remediation: check.remediation,
    }))
  summary.overallStatus = summary.missingInputs.length === 0 ? 'ready' : 'blocked'
  summary.nextCommands = summary.overallStatus === 'ready'
    ? [buildProbeCommand(values), buildOptOutCommand(values)]
    : ['Fill the missing inputs above, rerun this status helper, then run the generated probe command.']
  return summary
}

function renderMarkdown(summary) {
  const lines = [
    '# DingTalk Group Failure Alert Acceptance Status',
    '',
    `- Generated At: ${summary.generatedAt}`,
    `- Env File: \`${summary.envFile || '<none>'}\``,
    `- Overall Status: \`${summary.overallStatus}\``,
    '',
    '## Redacted Inputs',
    '',
    `- API Base: \`${summary.inputs.apiBase || '<missing>'}\``,
    `- Auth Token Present: \`${summary.inputs.authTokenPresent}\``,
    `- Auth Token File: \`${summary.inputs.authTokenFile || '<missing>'}\``,
    `- Auth Token File Present: \`${summary.inputs.authTokenFilePresent}\``,
    `- Sheet ID Present: \`${summary.inputs.sheetIdPresent}\``,
    `- Rule ID Present: \`${summary.inputs.ruleIdPresent}\``,
    `- Record ID Present: \`${summary.inputs.recordIdPresent}\``,
    `- Expected Person Status: \`${summary.inputs.expectPersonStatus}\``,
    `- Alert Subject: \`${summary.inputs.alertSubject}\``,
    `- Probe Output Dir: \`${summary.inputs.probeOutputDir}\``,
    '',
    '## Checks',
    '',
    '| Check | Label | Status | Remediation |',
    '| --- | --- | --- | --- |',
  ]
  for (const check of summary.checks) {
    lines.push(`| \`${check.id}\` | ${check.label} | \`${check.status}\` | ${check.status === 'pass' ? '' : check.remediation} |`)
  }

  lines.push('', '## Next Commands', '')
  for (const command of summary.nextCommands) {
    lines.push('```bash', command, '```', '')
  }

  if (summary.missingInputs.length > 0) {
    lines.push('## Missing Inputs', '')
    for (const item of summary.missingInputs) {
      lines.push(`- \`${item.id}\`: ${item.remediation}`)
    }
    lines.push('')
  }

  lines.push('## Notes', '')
  for (const note of summary.notes) {
    lines.push(`- ${note}`)
  }
  lines.push('')
  return lines.join('\n')
}

function writeOutputs(opts, summary) {
  mkdirSync(path.dirname(opts.outputJson), { recursive: true })
  mkdirSync(path.dirname(opts.outputMd), { recursive: true })
  writeFileSync(opts.outputJson, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  writeFileSync(opts.outputMd, renderMarkdown(summary), 'utf8')
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.writeEnvTemplate) {
    writeEnvTemplate(opts.writeEnvTemplate, opts.force)
    console.log(`[dingtalk-group-failure-alert-acceptance-status] wrote env template: ${relativePath(opts.writeEnvTemplate)}`)
    return
  }
  const envValues = readEnvFile(opts.envFile)
  const values = normalizeValues(opts, envValues)
  const summary = buildSummary(opts, values)
  writeOutputs(opts, summary)
  console.log(`[dingtalk-group-failure-alert-acceptance-status] ${summary.overallStatus}: ${opts.outputJson}`)
  if (summary.overallStatus !== 'ready' && !opts.allowBlocked) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(redactString(error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
})

export {
  buildSummary,
  normalizeValues,
  parseArgs,
  readEnvFile,
  redactString,
  renderEnvTemplate,
}
