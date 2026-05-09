#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_OUTPUT_DIR = 'output/dingtalk-work-notification-env-status'
const SCHEMA_VERSION = 1

const REQUIREMENTS = [
  {
    id: 'app-key',
    label: 'DingTalk app key is configured',
    keys: ['DINGTALK_APP_KEY', 'DINGTALK_CLIENT_ID'],
    remediation: 'Set DINGTALK_APP_KEY, or the legacy alias DINGTALK_CLIENT_ID.',
  },
  {
    id: 'app-secret',
    label: 'DingTalk app secret is configured',
    keys: ['DINGTALK_APP_SECRET', 'DINGTALK_CLIENT_SECRET'],
    remediation: 'Set DINGTALK_APP_SECRET, or the legacy alias DINGTALK_CLIENT_SECRET.',
  },
  {
    id: 'agent-id',
    label: 'DingTalk work-notification agent id is configured',
    keys: ['DINGTALK_AGENT_ID', 'DINGTALK_NOTIFY_AGENT_ID'],
    remediation: 'Set DINGTALK_AGENT_ID, or the legacy alias DINGTALK_NOTIFY_AGENT_ID.',
  },
]

function printHelp() {
  console.log(`Usage: node scripts/ops/dingtalk-work-notification-env-status.mjs [options]

Checks DingTalk work-notification environment readiness without calling
DingTalk and without printing credential values. This is the release gate for
creator failure alerts changing from audited failed attempts to real successful
work notifications.

Options:
  --env-file <file>              Env file to read; repeatable
  --write-env-template <file>    Write a fill-in env template and exit
  --force                        Overwrite an existing env template
  --output-json <file>           Output JSON path, default ${DEFAULT_OUTPUT_DIR}/summary.json
  --output-md <file>             Output Markdown path, default ${DEFAULT_OUTPUT_DIR}/summary.md
  --allow-blocked                Exit 0 even when required envs are missing
  --help                         Show this help

Environment fallbacks:
  DINGTALK_APP_KEY or DINGTALK_CLIENT_ID
  DINGTALK_APP_SECRET or DINGTALK_CLIENT_SECRET
  DINGTALK_AGENT_ID or DINGTALK_NOTIFY_AGENT_ID
`)
}

function readRequiredValue(argv, index, flag) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function parseArgs(argv) {
  const opts = {
    envFiles: [],
    writeEnvTemplate: '',
    outputJson: path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR, 'summary.json'),
    outputMd: path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR, 'summary.md'),
    allowBlocked: false,
    force: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--env-file':
        opts.envFiles.push(path.resolve(process.cwd(), readRequiredValue(argv, index, arg)))
        index += 1
        break
      case '--write-env-template':
        opts.writeEnvTemplate = path.resolve(process.cwd(), readRequiredValue(argv, index, arg))
        index += 1
        break
      case '--force':
        opts.force = true
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
  if (!existsSync(file)) throw new Error(`env file not found: ${file}`)
  const values = new Map()
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

function mergeEnvFiles(files) {
  const values = new Map()
  const sources = new Map()
  for (const file of files) {
    const fileValues = readEnvFile(file)
    for (const [key, value] of fileValues.entries()) {
      values.set(key, value)
      sources.set(key, file)
    }
  }
  for (const requirement of REQUIREMENTS) {
    for (const key of requirement.keys) {
      const value = process.env[key]
      if (typeof value === 'string' && value.trim()) {
        values.set(key, value.trim())
        sources.set(key, '<process.env>')
      }
    }
  }
  return { values, sources }
}

function relativePath(file) {
  if (!file) return ''
  if (file === '<process.env>') return file
  return path.relative(process.cwd(), file).replaceAll('\\', '/')
}

function renderEnvTemplate() {
  return `# DingTalk work-notification envs for creator failure alerts.
# Keep filled copies outside Git and do not paste secrets into chat.
#
# Required by readDingTalkMessageConfig():

DINGTALK_APP_KEY=""
DINGTALK_APP_SECRET=""
DINGTALK_AGENT_ID=""

# Legacy aliases are also accepted by the backend:
# DINGTALK_CLIENT_ID=""
# DINGTALK_CLIENT_SECRET=""
# DINGTALK_NOTIFY_AGENT_ID=""
`
}

function writeEnvTemplate(file, force = false) {
  if (existsSync(file) && !force) {
    throw new Error(`env template already exists: ${file}; pass --force to overwrite`)
  }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, renderEnvTemplate(), 'utf8')
}

function pickRequirement(values, sources, requirement) {
  const candidates = requirement.keys.map((key) => {
    const value = typeof values.get(key) === 'string' ? values.get(key).trim() : ''
    return {
      key,
      present: Boolean(value),
      length: value.length,
      source: value ? relativePath(sources.get(key) ?? '') : '',
    }
  })
  const selected = candidates.find((candidate) => candidate.present) ?? null
  const presentCandidates = candidates.filter((candidate) => candidate.present)
  return {
    id: requirement.id,
    label: requirement.label,
    keys: requirement.keys,
    present: Boolean(selected),
    selectedKey: selected?.key ?? '',
    source: selected?.source ?? '',
    length: selected?.length ?? 0,
    aliasCount: presentCandidates.length,
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

function buildSummary(opts, merged) {
  const requirementStates = REQUIREMENTS.map((requirement) =>
    pickRequirement(merged.values, merged.sources, requirement),
  )
  const requirementById = new Map(requirementStates.map((state) => [state.id, state]))

  const summary = {
    tool: 'dingtalk-work-notification-env-status',
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    envFiles: opts.envFiles.map(relativePath),
    overallStatus: 'blocked',
    requirements: Object.fromEntries(requirementStates.map((state) => [state.id, {
      keys: state.keys,
      present: state.present,
      selectedKey: state.selectedKey,
      source: state.source,
      length: state.length,
      aliasCount: state.aliasCount,
    }])),
    checks: [],
    missingInputs: [],
    nextCommands: [],
    notes: [
      'This helper does not call DingTalk and never writes credential values.',
      'It only checks whether the envs required by readDingTalkMessageConfig() are present.',
    ],
  }

  for (const requirement of REQUIREMENTS) {
    const state = requirementById.get(requirement.id)
    addCheck(summary, `${requirement.id}-present`, requirement.label, state?.present === true, {
      acceptedKeys: requirement.keys,
      selectedKey: state?.selectedKey ?? '',
      source: state?.source ?? '',
      length: state?.length ?? 0,
    }, requirement.remediation)
  }

  summary.missingInputs = summary.checks
    .filter((check) => check.status === 'fail')
    .map((check) => ({
      id: check.id,
      label: check.label,
      remediation: check.remediation,
    }))
  summary.overallStatus = summary.missingInputs.length === 0 ? 'ready' : 'blocked'
  summary.nextCommands = summary.overallStatus === 'ready'
    ? [
        'Restart metasheet-backend so the DingTalk work-notification envs are loaded.',
        'Rerun scripts/ops/dingtalk-group-failure-alert-probe.mjs with --expect-person-status success against a fresh controlled failed group delivery.',
      ]
    : ['Set the missing envs, restart metasheet-backend, then rerun this helper.']
  return summary
}

function renderMarkdown(summary) {
  const lines = [
    '# DingTalk Work Notification Env Status',
    '',
    `- Generated At: ${summary.generatedAt}`,
    `- Overall Status: \`${summary.overallStatus}\``,
    `- Env Files: ${summary.envFiles.length ? summary.envFiles.map((file) => `\`${file}\``).join(', ') : '`<none>`'}`,
    '',
    '## Requirements',
    '',
    '| Requirement | Accepted Keys | Present | Selected Key | Source | Length |',
    '| --- | --- | --- | --- | --- | --- |',
  ]

  for (const [id, state] of Object.entries(summary.requirements)) {
    lines.push(`| \`${id}\` | \`${state.keys.join('`, `')}\` | \`${state.present}\` | \`${state.selectedKey || '<missing>'}\` | \`${state.source || '<missing>'}\` | \`${state.length}\` |`)
  }

  lines.push('', '## Checks', '')
  lines.push('| Check | Label | Status | Remediation |')
  lines.push('| --- | --- | --- | --- |')
  for (const check of summary.checks) {
    lines.push(`| \`${check.id}\` | ${check.label} | \`${check.status}\` | ${check.status === 'pass' ? '' : check.remediation} |`)
  }

  lines.push('', '## Next Commands', '')
  for (const command of summary.nextCommands) {
    lines.push(`- ${command}`)
  }

  if (summary.missingInputs.length > 0) {
    lines.push('', '## Missing Inputs', '')
    for (const item of summary.missingInputs) {
      lines.push(`- \`${item.id}\`: ${item.remediation}`)
    }
  }

  lines.push('', '## Notes', '')
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
    console.log(`[dingtalk-work-notification-env-status] wrote env template: ${relativePath(opts.writeEnvTemplate)}`)
    return
  }

  const merged = mergeEnvFiles(opts.envFiles)
  const summary = buildSummary(opts, merged)
  writeOutputs(opts, summary)
  console.log(`[dingtalk-work-notification-env-status] ${summary.overallStatus}: ${relativePath(opts.outputJson)}`)
  if (summary.overallStatus !== 'ready' && !opts.allowBlocked) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

export {
  buildSummary,
  mergeEnvFiles,
  parseArgs,
  readEnvFile,
  renderEnvTemplate,
  renderMarkdown,
}
