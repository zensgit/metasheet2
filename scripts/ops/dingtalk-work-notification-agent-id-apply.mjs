#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const SCHEMA_VERSION = 1
const DEFAULT_OUTPUT_DIR = 'output/dingtalk-work-notification-agent-id-apply'
const AGENT_ID_KEYS = ['DINGTALK_AGENT_ID', 'DINGTALK_NOTIFY_AGENT_ID']

function printHelp() {
  console.log(`Usage: node scripts/ops/dingtalk-work-notification-agent-id-apply.mjs [options]

Safely applies the DingTalk work-notification agent id to an env file without
printing the value. Intended for the final 142 blocker after app key/secret are
already configured.

Options:
  --env-file <file>              Env file to update, required
  --agent-id-file <file>         File containing only the numeric DingTalk agent id, required
  --key <env-key>                Target key, default DINGTALK_AGENT_ID unless an accepted alias already exists
  --backup-dir <dir>             Backup directory, default env-file directory
  --output-json <file>           Output JSON path, default ${DEFAULT_OUTPUT_DIR}/summary.json
  --output-md <file>             Output Markdown path, default ${DEFAULT_OUTPUT_DIR}/summary.md
  --dry-run                      Validate and write evidence without changing the env file
  --force                        Allow replacing an existing different agent id
  --restart-backend              Recreate backend after updating the env file
  --compose-file <file>          Compose file for --restart-backend, default docker-compose.app.yml
  --service <name>               Compose service for --restart-backend, default backend
  --help                         Show this help

Security:
  The agent id value is read from a file, never from a CLI argument, to avoid
  shell history leaks. Summary files include only key names, length, and status.
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
    agentIdFile: '',
    key: 'DINGTALK_AGENT_ID',
    keyExplicit: false,
    backupDir: '',
    outputJson: path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR, 'summary.json'),
    outputMd: path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR, 'summary.md'),
    dryRun: false,
    force: false,
    restartBackend: false,
    composeFile: path.resolve(process.cwd(), 'docker-compose.app.yml'),
    service: 'backend',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--env-file':
        opts.envFile = path.resolve(process.cwd(), readRequiredValue(argv, index, arg))
        index += 1
        break
      case '--agent-id-file':
        opts.agentIdFile = path.resolve(process.cwd(), readRequiredValue(argv, index, arg))
        index += 1
        break
      case '--key':
        opts.key = readRequiredValue(argv, index, arg)
        opts.keyExplicit = true
        index += 1
        break
      case '--backup-dir':
        opts.backupDir = path.resolve(process.cwd(), readRequiredValue(argv, index, arg))
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
      case '--dry-run':
        opts.dryRun = true
        break
      case '--force':
        opts.force = true
        break
      case '--restart-backend':
        opts.restartBackend = true
        break
      case '--compose-file':
        opts.composeFile = path.resolve(process.cwd(), readRequiredValue(argv, index, arg))
        index += 1
        break
      case '--service':
        opts.service = readRequiredValue(argv, index, arg)
        index += 1
        break
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!opts.envFile) throw new Error('--env-file is required')
  if (!opts.agentIdFile) throw new Error('--agent-id-file is required')
  if (!AGENT_ID_KEYS.includes(opts.key)) {
    throw new Error(`--key must be one of: ${AGENT_ID_KEYS.join(', ')}`)
  }
  if (!opts.backupDir) opts.backupDir = path.dirname(opts.envFile)

  return opts
}

function relativePath(file) {
  if (!file) return ''
  return path.relative(process.cwd(), file).replaceAll('\\', '/')
}

function parseEnvLine(line) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  const index = trimmed.indexOf('=')
  if (index <= 0) return null
  return {
    key: trimmed.slice(0, index).trim(),
    value: trimmed.slice(index + 1).trim(),
  }
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

function readAgentId(file) {
  if (!existsSync(file)) throw new Error(`agent id file not found: ${file}`)
  const raw = readFileSync(file, 'utf8')
  const value = raw.trim()
  if (!value) throw new Error('agent id file is empty')
  if (!/^\d{1,32}$/.test(value)) {
    throw new Error('agent id must be numeric and at most 32 digits')
  }
  return value
}

function findExistingAgentEntries(lines) {
  const entries = []
  lines.forEach((line, index) => {
    const parsed = parseEnvLine(line)
    if (!parsed || !AGENT_ID_KEYS.includes(parsed.key)) return
    const value = unquoteEnvValue(parsed.value)
    if (!value) return
    entries.push({
      key: parsed.key,
      index,
      length: value.length,
      same: null,
      value,
    })
  })
  return entries
}

function makeBackupPath(opts) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const base = path.basename(opts.envFile)
  return path.join(opts.backupDir, `${base}.backup-before-dingtalk-agent-id-${stamp}`)
}

function renderEnvLine(key, value) {
  return `${key}=${value}`
}

function applyEnvUpdate(opts, agentId) {
  if (!existsSync(opts.envFile)) throw new Error(`env file not found: ${opts.envFile}`)
  const original = readFileSync(opts.envFile, 'utf8')
  const hadTrailingNewline = original.endsWith('\n')
  const lines = original.split(/\r?\n/)
  if (hadTrailingNewline) lines.pop()

  const existing = findExistingAgentEntries(lines).map((entry) => ({
    ...entry,
    same: entry.value === agentId,
    value: undefined,
  }))
  const existingTarget = opts.keyExplicit
    ? existing.find((entry) => entry.key === opts.key)
    : existing[0]
  const targetKey = existingTarget?.key ?? opts.key
  const conflicting = existing.filter((entry) => entry.same === false)

  if (conflicting.length > 0 && !opts.force) {
    return {
      action: 'blocked',
      targetKey,
      existingKeys: existing.map((entry) => ({ key: entry.key, length: entry.length, same: entry.same })),
      checks: [
        { id: 'agent-id-valid', status: 'pass', details: { length: agentId.length } },
        {
          id: 'existing-agent-id-conflict',
          status: 'fail',
          details: { keys: conflicting.map((entry) => entry.key) },
          remediation: 'Pass --force only after confirming the existing agent id should be replaced.',
        },
      ],
      backupFile: '',
      restart: { requested: opts.restartBackend, attempted: false },
    }
  }

  const targetIndex = lines.findIndex((line) => parseEnvLine(line)?.key === targetKey)
  const nextLines = [...lines]
  if (targetIndex >= 0) {
    nextLines[targetIndex] = renderEnvLine(targetKey, agentId)
  } else {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1].trim()) nextLines.push('')
    nextLines.push('# DingTalk work-notification agent id for direct messages and rule-creator failure alerts.')
    nextLines.push(renderEnvLine(targetKey, agentId))
  }

  const action = existing.length > 0 && existing.every((entry) => entry.same) && targetIndex >= 0
    ? 'unchanged'
    : opts.dryRun
      ? 'would_update'
      : 'updated'

  let backupFile = ''
  if (!opts.dryRun && action !== 'unchanged') {
    mkdirSync(opts.backupDir, { recursive: true })
    backupFile = makeBackupPath(opts)
    copyFileSync(opts.envFile, backupFile)
    writeFileSync(opts.envFile, `${nextLines.join('\n')}\n`, 'utf8')
  }

  return {
    action,
    targetKey,
    existingKeys: existing.map((entry) => ({ key: entry.key, length: entry.length, same: entry.same })),
    checks: [
      { id: 'agent-id-valid', status: 'pass', details: { length: agentId.length } },
      {
        id: 'env-file-updated',
        status: opts.dryRun || action === 'unchanged' || backupFile ? 'pass' : 'fail',
        details: { action, targetKey },
      },
    ],
    backupFile,
    restart: { requested: opts.restartBackend, attempted: false },
  }
}

function restartBackend(opts) {
  const args = ['compose', '-f', opts.composeFile, 'up', '-d', '--no-deps', '--force-recreate', opts.service]
  const result = spawnSync('docker', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  return {
    requested: true,
    attempted: true,
    command: ['docker', 'compose', '-f', relativePath(opts.composeFile), 'up', '-d', '--no-deps', '--force-recreate', opts.service].join(' '),
    exitCode: typeof result.status === 'number' ? result.status : 1,
    signal: result.signal ?? '',
    stdoutLength: result.stdout?.length ?? 0,
    stderrLength: result.stderr?.length ?? 0,
  }
}

function buildSummary(opts, applyResult, agentIdLength) {
  return {
    tool: 'dingtalk-work-notification-agent-id-apply',
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    status: applyResult.action === 'blocked' ? 'blocked' : 'pass',
    action: applyResult.action,
    dryRun: opts.dryRun,
    envFile: relativePath(opts.envFile),
    agentIdFile: relativePath(opts.agentIdFile),
    agentId: { length: agentIdLength, valuePrinted: false },
    targetKey: applyResult.targetKey,
    existingKeys: applyResult.existingKeys,
    backupFile: relativePath(applyResult.backupFile),
    restart: applyResult.restart,
    checks: applyResult.checks,
    nextCommands: applyResult.action === 'blocked'
      ? ['Confirm the existing agent id, then rerun with --force if replacement is intended.']
      : [
          'Restart metasheet-backend if --restart-backend was not used.',
          'Rerun scripts/ops/dingtalk-work-notification-env-status.mjs to confirm Overall Status: ready.',
        ],
    notes: [
      'The agent id value is never printed to stdout or summary files.',
      'A backup is created before modifying the env file unless --dry-run is used.',
    ],
  }
}

function renderMarkdown(summary) {
  const lines = [
    '# DingTalk Work Notification Agent ID Apply',
    '',
    `- Generated At: ${summary.generatedAt}`,
    `- Status: \`${summary.status}\``,
    `- Action: \`${summary.action}\``,
    `- Dry Run: \`${summary.dryRun}\``,
    `- Env File: \`${summary.envFile}\``,
    `- Agent ID File: \`${summary.agentIdFile}\``,
    `- Agent ID Length: \`${summary.agentId.length}\``,
    `- Target Key: \`${summary.targetKey}\``,
    `- Backup File: \`${summary.backupFile || '<none>'}\``,
    '',
    '## Checks',
    '',
    '| Check | Status | Details |',
    '| --- | --- | --- |',
  ]

  for (const check of summary.checks) {
    lines.push(`| \`${check.id}\` | \`${check.status}\` | \`${JSON.stringify(check.details ?? {})}\` |`)
  }

  lines.push('', '## Restart', '')
  lines.push(`- Requested: \`${summary.restart.requested}\``)
  lines.push(`- Attempted: \`${summary.restart.attempted}\``)
  if (summary.restart.attempted) {
    lines.push(`- Exit Code: \`${summary.restart.exitCode}\``)
    lines.push(`- Command: \`${summary.restart.command}\``)
  }

  lines.push('', '## Next Commands', '')
  for (const command of summary.nextCommands) lines.push(`- ${command}`)

  lines.push('', '## Notes', '')
  for (const note of summary.notes) lines.push(`- ${note}`)

  return `${lines.join('\n')}\n`
}

function writeSummary(opts, summary) {
  mkdirSync(path.dirname(opts.outputJson), { recursive: true })
  mkdirSync(path.dirname(opts.outputMd), { recursive: true })
  writeFileSync(opts.outputJson, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  writeFileSync(opts.outputMd, renderMarkdown(summary), 'utf8')
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const agentId = readAgentId(opts.agentIdFile)
  const applyResult = applyEnvUpdate(opts, agentId)
  if (opts.restartBackend && !opts.dryRun && applyResult.action !== 'blocked' && applyResult.action !== 'unchanged') {
    applyResult.restart = restartBackend(opts)
    applyResult.checks.push({
      id: 'backend-restart',
      status: applyResult.restart.exitCode === 0 ? 'pass' : 'fail',
      details: {
        attempted: applyResult.restart.attempted,
        exitCode: applyResult.restart.exitCode,
        stdoutLength: applyResult.restart.stdoutLength,
        stderrLength: applyResult.restart.stderrLength,
      },
    })
  }

  const summary = buildSummary(opts, applyResult, agentId.length)
  writeSummary(opts, summary)
  console.log(`DingTalk work-notification agent id apply: ${summary.action}; target=${summary.targetKey}; length=${summary.agentId.length}; summary=${relativePath(opts.outputMd)}`)

  if (summary.status === 'blocked') process.exit(1)
  if (summary.restart.attempted && summary.restart.exitCode !== 0) process.exit(summary.restart.exitCode || 1)
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
