#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REQUIRED_PASS_CHECKS = [
  'auth-me',
  'integration-route-contract',
  'integration-list-external-systems',
  'integration-list-pipelines',
  'integration-list-runs',
  'integration-list-dead-letters',
  'staging-descriptor-contract',
]

class K3WiseSignoffGateError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'K3WiseSignoffGateError'
    this.details = details
  }
}

function printHelp() {
  console.log(`Usage: node scripts/ops/integration-k3wise-signoff-gate.mjs --input <path>

Machine-checks K3 WISE postdeploy smoke evidence for internal-trial signoff.
Public-only smoke and presentation summaries are not accepted as signoff.

Required evidence:
  ok === true
  authenticated === true
  signoff.internalTrial === "pass"
  summary.fail === 0
  required checks pass: ${REQUIRED_PASS_CHECKS.join(', ')}

Options:
  --input <path>  K3 WISE postdeploy smoke evidence JSON path
  --help          Show this help
`)
}

function readRequiredValue(argv, index, flag) {
  const next = argv[index + 1]
  if (!next || next.startsWith('--')) {
    throw new K3WiseSignoffGateError(`${flag} requires a value`, { flag })
  }
  return next
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    input: '',
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--input':
        opts.input = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--help':
      case '-h':
        opts.help = true
        break
      default:
        throw new K3WiseSignoffGateError(`unknown option: ${arg}`, { arg })
    }
  }

  if (!opts.help && !opts.input) {
    throw new K3WiseSignoffGateError('--input is required')
  }

  return opts
}

function asNonNegativeInteger(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : null
}

function getCheckMap(evidence) {
  const checks = Array.isArray(evidence?.checks) ? evidence.checks : []
  return new Map(
    checks
      .filter((check) => check && typeof check === 'object' && typeof check.id === 'string')
      .map((check) => [check.id, check]),
  )
}

function evaluateSignoffEvidence(evidence) {
  const failures = []
  const checkMap = getCheckMap(evidence)
  const summaryFail = asNonNegativeInteger(evidence?.summary?.fail)

  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    failures.push('evidence JSON must be an object')
  }
  if (evidence?.ok !== true) {
    failures.push('top-level ok must be true')
  }
  if (evidence?.authenticated !== true) {
    failures.push('authenticated checks must have run')
  }
  if (evidence?.signoff?.internalTrial !== 'pass') {
    failures.push('signoff.internalTrial must be pass')
  }
  if (summaryFail !== 0) {
    failures.push('summary.fail must be 0')
  }

  const missingChecks = []
  const failedChecks = []
  for (const checkId of REQUIRED_PASS_CHECKS) {
    const check = checkMap.get(checkId)
    if (!check) {
      missingChecks.push(checkId)
    } else if (check.status !== 'pass') {
      failedChecks.push(`${checkId}:${check.status || 'unknown'}`)
    }
  }

  if (missingChecks.length > 0) {
    failures.push(`missing required checks: ${missingChecks.join(', ')}`)
  }
  if (failedChecks.length > 0) {
    failures.push(`required checks not passing: ${failedChecks.join(', ')}`)
  }

  return {
    ok: failures.length === 0,
    status: failures.length === 0 ? 'PASS' : 'BLOCKED',
    reason: failures.length === 0 ? 'authenticated postdeploy smoke satisfies internal-trial gate' : failures.join('; '),
    requiredChecks: REQUIRED_PASS_CHECKS,
    summary: {
      pass: asNonNegativeInteger(evidence?.summary?.pass),
      skipped: asNonNegativeInteger(evidence?.summary?.skipped),
      fail: summaryFail,
    },
    authenticated: evidence?.authenticated === true,
    signoff: evidence?.signoff?.internalTrial || null,
  }
}

async function readEvidence(inputPath) {
  const raw = await readFile(inputPath, 'utf8')
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new K3WiseSignoffGateError(`invalid evidence JSON: ${inputPath}`, {
      cause: error && error.message ? error.message : String(error),
    })
  }
}

async function runCli(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv)
  if (opts.help) {
    printHelp()
    return 0
  }

  const inputPath = path.resolve(opts.input)
  const evidence = await readEvidence(inputPath)
  const result = evaluateSignoffEvidence(evidence)
  console.log(JSON.stringify(result, null, 2))
  return result.ok ? 0 : 1
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (entryPath && import.meta.url === entryPath) {
  runCli().then((code) => {
    process.exit(code)
  }).catch((error) => {
    const body = error instanceof K3WiseSignoffGateError
      ? { ok: false, code: error.name, message: error.message, details: error.details }
      : { ok: false, code: error && error.name ? error.name : 'Error', message: error && error.message ? error.message : String(error) }
    console.error(JSON.stringify(body, null, 2))
    process.exit(1)
  })
}

export {
  K3WiseSignoffGateError,
  REQUIRED_PASS_CHECKS,
  evaluateSignoffEvidence,
  parseArgs,
  runCli,
}
