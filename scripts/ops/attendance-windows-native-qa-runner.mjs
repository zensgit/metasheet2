#!/usr/bin/env node
/**
 * Attendance Windows-native exact-SHA QA v2 risk-matrix runner.
 *
 * Draft/HOLD only. Synthetic data. No deployment/staging authorization.
 * Never invents product PASS without host evidence for the pinned source SHA.
 * Never reuses stale W4C-2 package claims as current evidence.
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ALLOWED_STATUSES = new Set(['PASS', 'BLOCKED', 'FAIL'])

function parseArgs(argv) {
  const result = {
    root: process.cwd(),
    matrix: '',
    pin: '',
    evidenceDir: '',
    expectedSourceSha: process.env.ATTENDANCE_WINDOWS_NATIVE_EXPECTED_SOURCE_SHA || '',
    output: '',
    json: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    const next = argv[i + 1]
    if (token === '--root' && next) {
      result.root = next
      i += 1
    } else if (token === '--matrix' && next) {
      result.matrix = next
      i += 1
    } else if (token === '--pin' && next) {
      result.pin = next
      i += 1
    } else if (token === '--evidence-dir' && next) {
      result.evidenceDir = next
      i += 1
    } else if (token === '--expected-source-sha' && next) {
      result.expectedSourceSha = next
      i += 1
    } else if (token === '--output' && next) {
      result.output = next
      i += 1
    } else if (token === '--json') {
      result.json = true
    } else if (token === '--help' || token === '-h') {
      result.help = true
    } else {
      throw new Error(`Unexpected argument: ${token}`)
    }
  }
  return result
}

function isExactSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function resolveExisting(candidates, label) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return path.resolve(candidate)
  }
  throw new Error(`Missing ${label}; looked in: ${candidates.filter(Boolean).join(', ')}`)
}

function normalizeSha(value, label) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!isExactSha(normalized)) {
    throw new Error(`${label} must be a 40-char lowercase git SHA; got: ${value || 'empty'}`)
  }
  return normalized
}

function resolvePackageSourceSha(rootDir) {
  const sourceFile = path.join(rootDir, 'SOURCE_SHA')
  if (fs.existsSync(sourceFile)) {
    return normalizeSha(fs.readFileSync(sourceFile, 'utf8'), 'SOURCE_SHA')
  }

  const manifests = fs
    .readdirSync(rootDir)
    .filter((name) => /^metasheet-attendance-onprem-.*\.json$/.test(name))
    .sort()
    .reverse()
  for (const name of manifests) {
    const payload = readJson(path.join(rootDir, name))
    const candidate = payload.sourceSha || payload.source_sha
    if (candidate) return normalizeSha(candidate, `${name}.sourceSha`)
  }
  throw new Error('Package exact source SHA is missing (SOURCE_SHA or manifest sourceSha)')
}

function loadEvidence(evidenceDir) {
  if (!evidenceDir) return { cases: {}, residue: null, sourceSha: null, filePath: null }
  if (!fs.existsSync(evidenceDir)) {
    throw new Error(`Evidence directory does not exist: ${evidenceDir}`)
  }
  const summaryPath = path.join(evidenceDir, 'summary.json')
  if (!fs.existsSync(summaryPath)) {
    return { cases: {}, residue: null, sourceSha: null, filePath: summaryPath }
  }
  const summary = readJson(summaryPath)
  const cases = {}
  for (const entry of summary.cases || []) {
    if (!entry || !entry.id) continue
    cases[entry.id] = entry
  }
  return {
    cases,
    residue: summary.residue ?? null,
    sourceSha: summary.sourceSha || summary.source_sha || null,
    filePath: summaryPath,
    raw: summary,
  }
}

function evidenceValue(evidenceCase, evidence, key) {
  if (Object.prototype.hasOwnProperty.call(evidenceCase, key)) return evidenceCase[key]
  return evidence.raw?.[key]
}

function evaluateCase(matrixCase, evidence, packageSha, staleEvidenceShas, isolatedDatabaseName) {
  const evidenceCase = evidence.cases[matrixCase.id]
  if (!evidenceCase) {
    return {
      id: matrixCase.id,
      title: matrixCase.title,
      status: 'BLOCKED',
      reason: matrixCase.blockedReason || 'No host evidence provided for this case.',
      requiresHostEvidence: Boolean(matrixCase.requiresHostEvidence),
    }
  }

  const evidenceSha = normalizeSha(
    evidenceCase.sourceSha || evidence.sourceSha || '',
    `${matrixCase.id} evidence sourceSha`,
  )
  if (staleEvidenceShas.includes(evidenceSha)) {
    return {
      id: matrixCase.id,
      title: matrixCase.title,
      status: 'BLOCKED',
      reason: `Evidence source SHA ${evidenceSha} is a stale W4C-2/old package claim and must not be reused.`,
      requiresHostEvidence: Boolean(matrixCase.requiresHostEvidence),
    }
  }
  if (evidenceSha !== packageSha) {
    return {
      id: matrixCase.id,
      title: matrixCase.title,
      status: 'BLOCKED',
      reason: `Evidence source SHA ${evidenceSha} does not match package source SHA ${packageSha}.`,
      requiresHostEvidence: Boolean(matrixCase.requiresHostEvidence),
    }
  }

  const status = String(evidenceCase.status || '').toUpperCase()
  if (!ALLOWED_STATUSES.has(status)) {
    return {
      id: matrixCase.id,
      title: matrixCase.title,
      status: 'BLOCKED',
      reason: `Evidence status must be one of PASS|BLOCKED|FAIL; got: ${evidenceCase.status || 'empty'}`,
      requiresHostEvidence: Boolean(matrixCase.requiresHostEvidence),
    }
  }

  if (status === 'PASS') {
    if (evidenceCase.syntheticDataOnly !== true) {
      return {
        id: matrixCase.id,
        title: matrixCase.title,
        status: 'BLOCKED',
        reason: 'PASS requires syntheticDataOnly=true in host evidence.',
        requiresHostEvidence: Boolean(matrixCase.requiresHostEvidence),
      }
    }
    if (Number(evidenceCase.residue ?? evidence.residue ?? -1) !== 0) {
      return {
        id: matrixCase.id,
        title: matrixCase.title,
        status: 'BLOCKED',
        reason: 'PASS requires residue=0 in host evidence.',
        requiresHostEvidence: Boolean(matrixCase.requiresHostEvidence),
      }
    }
    if (evidenceValue(evidenceCase, evidence, 'isolatedDatabase') !== true) {
      return {
        id: matrixCase.id,
        title: matrixCase.title,
        status: 'BLOCKED',
        reason: 'PASS requires isolatedDatabase=true in host evidence.',
        requiresHostEvidence: Boolean(matrixCase.requiresHostEvidence),
      }
    }
    if (evidenceValue(evidenceCase, evidence, 'databaseName') !== isolatedDatabaseName) {
      return {
        id: matrixCase.id,
        title: matrixCase.title,
        status: 'BLOCKED',
        reason: `PASS requires databaseName=${isolatedDatabaseName} in host evidence.`,
        requiresHostEvidence: Boolean(matrixCase.requiresHostEvidence),
      }
    }
    if (String(evidenceValue(evidenceCase, evidence, 'hostPlatform') || '').toLowerCase() !== 'windows') {
      return {
        id: matrixCase.id,
        title: matrixCase.title,
        status: 'BLOCKED',
        reason: 'PASS requires hostPlatform=windows in host evidence.',
        requiresHostEvidence: Boolean(matrixCase.requiresHostEvidence),
      }
    }
    if (!/^5\.1(?:\.|$)/.test(String(evidenceValue(evidenceCase, evidence, 'windowsPowerShellVersion') || ''))) {
      return {
        id: matrixCase.id,
        title: matrixCase.title,
        status: 'BLOCKED',
        reason: 'PASS requires a Windows PowerShell 5.1 version in host evidence.',
        requiresHostEvidence: Boolean(matrixCase.requiresHostEvidence),
      }
    }
    if (evidenceValue(evidenceCase, evidence, 'customerOrExternalDestination') !== false) {
      return {
        id: matrixCase.id,
        title: matrixCase.title,
        status: evidenceValue(evidenceCase, evidence, 'customerOrExternalDestination') === true ? 'FAIL' : 'BLOCKED',
        reason: 'PASS requires customerOrExternalDestination=false in host evidence.',
        requiresHostEvidence: Boolean(matrixCase.requiresHostEvidence),
      }
    }
    if (evidenceValue(evidenceCase, evidence, 'externalNotificationsSent') !== false) {
      return {
        id: matrixCase.id,
        title: matrixCase.title,
        status: evidenceValue(evidenceCase, evidence, 'externalNotificationsSent') === true ? 'FAIL' : 'BLOCKED',
        reason: 'PASS requires externalNotificationsSent=false in host evidence.',
        requiresHostEvidence: Boolean(matrixCase.requiresHostEvidence),
      }
    }
  }

  return {
    id: matrixCase.id,
    title: matrixCase.title,
    status,
    reason: evidenceCase.reason || evidenceCase.notes || `Host evidence status=${status}`,
    requiresHostEvidence: Boolean(matrixCase.requiresHostEvidence),
  }
}

export function runWindowsNativeQaMatrix(options = {}) {
  const rootDir = path.resolve(options.root || process.cwd())
  const matrixPath = resolveExisting(
    [
      options.matrix,
      path.join(rootDir, 'scripts/ops/attendance-windows-native-qa-risk-matrix.json'),
      path.join(rootDir, 'attendance-windows-native-qa-risk-matrix.json'),
    ],
    'risk matrix',
  )
  const pinPath = resolveExisting(
    [
      options.pin,
      path.join(rootDir, 'scripts/ops/attendance-windows-native-qa-v2.pin.json'),
      path.join(rootDir, 'attendance-windows-native-qa-v2.pin.json'),
    ],
    'QA pin',
  )

  const matrix = readJson(matrixPath)
  const pin = readJson(pinPath)
  const packageSha = resolvePackageSourceSha(rootDir)
  const pinnedSourceSha = normalizeSha(
    pin.expectedSourceSha,
    'pin.expectedSourceSha',
  )
  const matrixSourceSha = normalizeSha(
    matrix.expectedSourceSha,
    'matrix.expectedSourceSha',
  )
  if (matrixSourceSha !== pinnedSourceSha) {
    throw new Error(
      `Risk matrix expectedSourceSha must match the QA pin: matrix=${matrixSourceSha} pin=${pinnedSourceSha}`,
    )
  }
  const expectedSourceOverride =
    options.expectedSourceSha ||
    process.env.ATTENDANCE_WINDOWS_NATIVE_EXPECTED_SOURCE_SHA ||
    ''
  if (expectedSourceOverride) {
    const normalizedOverride = normalizeSha(expectedSourceOverride, 'expectedSourceSha override')
    if (normalizedOverride !== pinnedSourceSha) {
      throw new Error(
        `Expected source SHA override must match the QA pin: override=${normalizedOverride} pin=${pinnedSourceSha}`,
      )
    }
  }
  const expectedSourceSha = pinnedSourceSha

  if (pin.deploymentAuthorized !== false || matrix.deploymentAuthorized !== false) {
    throw new Error('QA pin/matrix must explicitly keep deploymentAuthorized=false (Draft/HOLD)')
  }
  if (pin.syntheticDataOnly !== true || matrix.syntheticDataOnly !== true) {
    throw new Error('QA pin/matrix must explicitly keep syntheticDataOnly=true')
  }
  if (String(pin.status || '').toUpperCase() !== 'DRAFT_HOLD') {
    throw new Error('QA pin.status must be DRAFT_HOLD')
  }
  if (String(matrix.status || '').toUpperCase() !== 'DRAFT_HOLD') {
    throw new Error('Risk matrix status must be DRAFT_HOLD')
  }
  if (packageSha !== expectedSourceSha) {
    throw new Error(
      `Exact source SHA mismatch: package=${packageSha} expected=${expectedSourceSha}`,
    )
  }

  const evidence = loadEvidence(options.evidenceDir || '')
  if (evidence.sourceSha) {
    const evidenceSha = normalizeSha(evidence.sourceSha, 'evidence summary sourceSha')
    if ((matrix.staleEvidenceShas || []).includes(evidenceSha)) {
      throw new Error(
        `Evidence summary source SHA ${evidenceSha} is stale and must not be reused as current evidence`,
      )
    }
  }

  if (matrix.isolatedDatabaseName !== 'metasheet_windows_qa') {
    throw new Error('Risk matrix must pin isolatedDatabaseName=metasheet_windows_qa')
  }

  const cases = (matrix.cases || []).map((matrixCase) =>
    evaluateCase(
      matrixCase,
      evidence,
      packageSha,
      matrix.staleEvidenceShas || [],
      matrix.isolatedDatabaseName,
    ),
  )

  const counts = { PASS: 0, BLOCKED: 0, FAIL: 0 }
  for (const item of cases) counts[item.status] += 1

  let residue = null
  if (evidence.residue != null) {
    residue = Number(evidence.residue)
    if (!Number.isFinite(residue)) {
      throw new Error(`Evidence residue must be numeric; got: ${evidence.residue}`)
    }
  }
  if (residue !== null && residue !== 0) {
    throw new Error(`Residue check failed: residue=${residue} (required 0)`)
  }

  const report = {
    campaign: matrix.campaign || pin.campaign || 'attendance-windows-native-qa-v2-20260804',
    status: 'DRAFT_HOLD',
    deploymentAuthorized: false,
    syntheticDataOnly: true,
    sourceSha: packageSha,
    expectedSourceSha,
    residue,
    counts,
    cases,
    notes: [
      'Draft/HOLD preparation only. No deployment/staging authorization.',
      'Old package claims are not current evidence.',
      'Product PASS requires host evidence bound to the exact source SHA with residue=0.',
    ],
  }

  return report
}

function printReport(report, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }
  console.log('[attendance-windows-native-qa-runner] DRAFT/HOLD risk matrix report')
  console.log(`  campaign: ${report.campaign}`)
  console.log(`  sourceSha: ${report.sourceSha}`)
  console.log(`  residue: ${report.residue ?? 'not measured'}`)
  console.log(
    `  counts: PASS=${report.counts.PASS} BLOCKED=${report.counts.BLOCKED} FAIL=${report.counts.FAIL}`,
  )
  for (const item of report.cases) {
    console.log(`  - ${item.id} ${item.status}: ${item.reason}`)
  }
  console.log('  deploymentAuthorized: false')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(`Usage: node scripts/ops/attendance-windows-native-qa-runner.mjs [options]

Options:
  --root <dir>                 Package or repo root (default: cwd)
  --matrix <file>              Risk matrix JSON
  --pin <file>                 Exact-SHA pin JSON
  --evidence-dir <dir>         Optional host evidence directory containing summary.json
  --expected-source-sha <sha>  Override expected exact source SHA
  --output <file>              Write JSON report to file
  --json                       Print JSON report to stdout
`)
    return
  }

  const tempDirs = []
  try {
    const report = runWindowsNativeQaMatrix(args)
    if (args.output) {
      fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true })
      fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`)
    }
    printReport(report, args.json)
    if (report.counts.FAIL > 0) {
      process.exitCode = 2
    }
  } finally {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(`[attendance-windows-native-qa-runner] ERROR: ${error.message}`)
    process.exitCode = 1
  })
}
