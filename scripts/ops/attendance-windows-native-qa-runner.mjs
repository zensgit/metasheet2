#!/usr/bin/env node
/**
 * Attendance Windows-native exact-SHA QA v2 risk-matrix runner.
 *
 * Draft/HOLD only. Synthetic data. No deployment/staging authorization.
 * Never invents product PASS without host evidence for the pinned source SHA.
 * Never reuses stale W4C-2 package claims as current evidence.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  isMachineEvidenceCase,
  validateMachineEvidence,
  validateOperatorEvidence,
} from './windows-qa/harness/machine-evidence-contract.mjs'

const ALLOWED_STATUSES = new Set(['PASS', 'BLOCKED', 'FAIL'])

// Owner FIX 2(c): raise the evidence floor above a trivial token (the owner forged a PASS with
// reason:"x", evidence:"x"). These are minimum trimmed lengths, applied ONLY to a PASS case's own
// reason + evidence. This raises the floor; it is NOT a proof of authenticity (the runner reads an
// operator-written JSON) — do not claim it makes the evidence unforgeable.
const MIN_REASON_LEN = 12
const MIN_EVIDENCE_LEN = 16

const SHA40 = /^[0-9a-f]{40}$/

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function meetsFloor(value, minLen) {
  return typeof value === 'string' && value.trim().length >= minLen
}

/**
 * Owner P2 hardening: when an evidence summary is present, its cases[] must be EXACTLY the closed set
 * of matrix ids — reject id-less entries, DUPLICATE ids (which the id->entry map would silently
 * overwrite), EXTRA ids, and MISSING ids. Validated on the RAW array, BEFORE any map collapse.
 */
function validateEvidenceCaseSet(rawCases, matrixIds) {
  if (!Array.isArray(rawCases)) {
    throw new Error('Evidence summary.cases must be an array of per-case entries.')
  }
  const seen = new Set()
  for (const entry of rawCases) {
    if (!entry || typeof entry.id !== 'string' || entry.id.trim() === '') {
      throw new Error('Evidence summary.cases contains an entry with no id.')
    }
    if (seen.has(entry.id)) {
      throw new Error(`Evidence summary.cases contains a DUPLICATE id: ${entry.id}`)
    }
    seen.add(entry.id)
  }
  const expected = new Set(matrixIds)
  const missing = matrixIds.filter((id) => !seen.has(id))
  const extra = [...seen].filter((id) => !expected.has(id))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Evidence summary.cases must be exactly the ${matrixIds.length} matrix ids. ` +
        `missing: ${missing.length ? missing.join(', ') : '(none)'}; ` +
        `extra: ${extra.length ? extra.join(', ') : '(none)'}`,
    )
  }
}

function parseArgs(argv) {
  const result = {
    root: process.cwd(),
    matrix: '',
    pin: '',
    evidenceDir: '',
    expectedSourceSha: process.env.ATTENDANCE_WINDOWS_NATIVE_EXPECTED_SOURCE_SHA || '',
    output: '',
    json: false,
    strict: false,
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
    } else if (token === '--strict') {
      result.strict = true
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

// Owner P2: the package build writes a QA_TOOLING_SHA (package-root file + manifest.qaToolingSha) but
// the runner only bound the product SOURCE_SHA — so evidence produced by a DIFFERENT tooling SHA still
// strict-PASSed. Resolve the package QA tooling SHA (file first, then newest manifest) so a PASS can be
// bound to it. Returns null when the package carries no QA_TOOLING_SHA at all (then PASS fails closed).
function resolvePackageToolingSha(rootDir) {
  const toolingFile = path.join(rootDir, 'QA_TOOLING_SHA')
  if (fs.existsSync(toolingFile)) {
    return normalizeSha(fs.readFileSync(toolingFile, 'utf8'), 'QA_TOOLING_SHA')
  }
  const manifests = fs
    .readdirSync(rootDir)
    .filter((name) => /^metasheet-attendance-onprem-.*\.json$/.test(name))
    .sort()
    .reverse()
  for (const name of manifests) {
    const payload = readJson(path.join(rootDir, name))
    const candidate = payload.qaToolingSha || payload.qa_tooling_sha
    if (candidate) return normalizeSha(candidate, `${name}.qaToolingSha`)
  }
  return null
}

function loadEvidence(evidenceDir) {
  if (!evidenceDir) return { cases: {}, residue: null, sourceSha: null, filePath: null }
  if (!fs.existsSync(evidenceDir)) {
    throw new Error(`Evidence directory does not exist: ${evidenceDir}`)
  }
  const summaryPath = path.join(evidenceDir, 'summary.json')
  if (!fs.existsSync(summaryPath)) {
    return { cases: {}, residue: null, sourceSha: null, runId: null, filePath: summaryPath }
  }
  const summary = readJson(summaryPath)
  const rawCases = summary.cases
  const cases = {}
  for (const entry of Array.isArray(rawCases) ? rawCases : []) {
    if (!entry || !entry.id) continue
    cases[entry.id] = entry
  }
  return {
    cases,
    rawCases,
    hasSummary: true,
    residue: summary.residue ?? null,
    sourceSha: summary.sourceSha || summary.source_sha || null,
    qaToolingSha: summary.qaToolingSha || summary.qa_tooling_sha || null,
    runId: summary.runId || summary.run_id || null,
    filePath: summaryPath,
    raw: summary,
  }
}

// Owner P2 hardening: the shared SAFETY fields are read PER-CASE ONLY — no top-level (`raw`)
// fallback. Otherwise one shared top-level affirmation would cover all ten cases (the exact
// "fill status + shared safety fields" forge the owner flagged). residue/sourceSha keep their
// legitimate top-level fallback (residue is a single global measurement; both handled elsewhere).
function evidenceValue(evidenceCase, _evidence, key) {
  if (Object.prototype.hasOwnProperty.call(evidenceCase, key)) return evidenceCase[key]
  return undefined
}

// Owner gate 1 — the artifactSha256 is RECOMPUTED by the runner over the real file in the evidence
// dir; a well-formed hex that points at no real (or a tampered) file must NOT PASS. Rejects: a missing
// evidence dir; a path escaping the evidence dir (traversal); a symlink (or a symlinked ancestor that
// escapes); a missing file; a non-file; and a digest that does not match the claimed sha256. The
// path/sha256 SHAPE is validated by the contract; this reads the bytes.
function verifyArtifactFile(evidenceDir, artifact) {
  if (!evidenceDir) {
    return { ok: false, error: 'operatorEvidence.artifact cannot be verified: no --evidence-dir was provided.' }
  }
  let baseReal
  try {
    baseReal = fs.realpathSync(evidenceDir)
  } catch {
    return { ok: false, error: `Evidence dir does not exist for artifact verification: ${evidenceDir}` }
  }
  const target = path.resolve(baseReal, artifact.path)
  const relToBase = path.relative(baseReal, target)
  if (relToBase === '' || relToBase.startsWith('..') || path.isAbsolute(relToBase)) {
    return { ok: false, error: `operatorEvidence.artifact.path resolves outside the evidence dir: ${artifact.path}` }
  }
  let lst
  try {
    lst = fs.lstatSync(target)
  } catch {
    return { ok: false, error: `operatorEvidence.artifact file does not exist: ${artifact.path}` }
  }
  if (lst.isSymbolicLink()) {
    return { ok: false, error: `operatorEvidence.artifact.path must not be a symlink: ${artifact.path}` }
  }
  // Resolve any symlinked ANCESTOR and re-check containment (a symlinked parent could escape the dir).
  let real
  try {
    real = fs.realpathSync(target)
  } catch {
    return { ok: false, error: `operatorEvidence.artifact file does not exist: ${artifact.path}` }
  }
  const relReal = path.relative(baseReal, real)
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
    return { ok: false, error: `operatorEvidence.artifact.path escapes the evidence dir via a symlink: ${artifact.path}` }
  }
  if (!fs.statSync(real).isFile()) {
    return { ok: false, error: `operatorEvidence.artifact is not a regular file: ${artifact.path}` }
  }
  const digest = crypto.createHash('sha256').update(fs.readFileSync(real)).digest('hex')
  if (digest !== artifact.sha256) {
    return {
      ok: false,
      error: `operatorEvidence.artifact.sha256 does not match the recomputed digest of ${artifact.path} (claimed ${artifact.sha256}, actual ${digest}).`,
    }
  }
  return { ok: true }
}

function evaluateCase(
  matrixCase,
  evidence,
  packageSha,
  staleEvidenceShas,
  isolatedDatabaseName,
  packageToolingSha,
  evidenceDir,
) {
  const blocked = (reason, status = 'BLOCKED') => ({
    id: matrixCase.id,
    title: matrixCase.title,
    status,
    reason,
    requiresHostEvidence: Boolean(matrixCase.requiresHostEvidence),
  })
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
    // Owner P2 hardening: PASS requires a non-empty per-case reason AND a non-empty per-case
    // evidence field (step output / SQL result / file reference) — no top-level fallback, no
    // whitespace-only. Status + safety fields alone can no longer forge a PASS.
    if (!meetsFloor(evidenceCase.reason, MIN_REASON_LEN)) {
      return {
        id: matrixCase.id,
        title: matrixCase.title,
        status: 'BLOCKED',
        reason: `PASS requires a non-empty per-case reason of at least ${MIN_REASON_LEN} chars (raises the floor above a trivial token; not a proof of authenticity).`,
        requiresHostEvidence: Boolean(matrixCase.requiresHostEvidence),
      }
    }
    const evidenceField =
      evidenceCase.evidence ?? evidenceCase.stepOutput ?? evidenceCase.sqlResult ?? evidenceCase.fileReference
    if (!meetsFloor(evidenceField, MIN_EVIDENCE_LEN)) {
      return {
        id: matrixCase.id,
        title: matrixCase.title,
        status: 'BLOCKED',
        reason: `PASS requires a non-empty per-case evidence field (step output / SQL result / file reference) of at least ${MIN_EVIDENCE_LEN} chars (raises the floor above a trivial token; not a proof of authenticity).`,
        requiresHostEvidence: Boolean(matrixCase.requiresHostEvidence),
      }
    }
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

    // Owner P2 — QA tooling SHA binding. Evidence produced by a DIFFERENT QA tooling SHA must not
    // PASS. Bind to the package QA_TOOLING_SHA; if the package carries none, a PASS cannot be verified.
    if (!packageToolingSha) {
      return blocked(
        'PASS requires a package QA_TOOLING_SHA to bind the evidence to, but none was found at the package root ' +
          '(QA_TOOLING_SHA file or manifest.qaToolingSha).',
      )
    }
    // A present-but-wrong per-case or top-level qaToolingSha must be REJECTED, never silently ignored
    // (that "unexpected field ignored" shape is exactly how stale-tooling evidence would slip through).
    for (const [scope, raw] of [
      ['per-case', evidenceCase.qaToolingSha],
      ['top-level', evidence.qaToolingSha],
    ]) {
      if (raw != null && String(raw).trim().toLowerCase() !== packageToolingSha) {
        return blocked(
          `PASS requires the ${scope} qaToolingSha to equal the package QA_TOOLING_SHA ${packageToolingSha}; got: ${raw}.`,
        )
      }
    }
    // Owner runId binding — a PASS requires the summary to carry a campaign runId, and every per-case
    // evidence record + its artifact manifest must carry that SAME runId (stops splicing a
    // same-product-SHA record from a DIFFERENT run into this report).
    const expectedRunId = evidence.runId
    if (!expectedRunId) {
      return blocked(
        'PASS requires a campaign runId in the evidence summary (summary.runId) that every per-case ' +
          'evidence record + artifact must be bound to; none was found.',
      )
    }

    // Owner direction a+ / gate 2 — STRICT evidence-kind partitioning, no fallback. Each surface has
    // exactly ONE accepted evidence kind; the WRONG kind (even if internally valid) is REJECTED:
    //   - PQA-09/10 (route-less harness cases): machineEvidence ONLY — whitelisted harnessModule FOR
    //     THAT CASE + that case's exact facts schema.
    //   - PQA-01..08 (operator-run HTTP/UI cases): operatorEvidence ONLY — tester + UTC timestamp +
    //     command/route + expected/observed + an artifact RECOMPUTED by the runner + bound SHAs, with a
    //     full-boundary attestation for PQA-05/06/08.
    // A machineEvidence on an operator case (the owner's forge) or an operatorEvidence on a machine case
    // is rejected here, not fallen back to.
    if (isMachineEvidenceCase(matrixCase.id)) {
      if (evidenceCase.operatorEvidence !== undefined) {
        return blocked(
          `${matrixCase.id} is a machine-evidence case (PQA-09/10) and accepts machineEvidence ONLY; an operatorEvidence is not accepted here.`,
        )
      }
      const machineCheck = validateMachineEvidence(evidenceCase.machineEvidence, {
        expectedQaToolingSha: packageToolingSha,
        expectedRunId,
        caseId: matrixCase.id,
      })
      if (!machineCheck.ok) {
        return blocked(machineCheck.error)
      }
    } else {
      if (evidenceCase.machineEvidence !== undefined) {
        return blocked(
          `${matrixCase.id} is an operator-evidence case (PQA-01..08) and accepts operatorEvidence ONLY; a machineEvidence is not accepted here.`,
        )
      }
      const operatorCheck = validateOperatorEvidence(evidenceCase.operatorEvidence, {
        expectedSourceSha: packageSha,
        expectedQaToolingSha: packageToolingSha,
        expectedRunId,
        caseId: matrixCase.id,
      })
      if (!operatorCheck.ok) {
        return blocked(operatorCheck.error)
      }
      // Owner gate 1 — recompute the artifact digest over the real file (missing/tampered/symlink/escape
      // all fail closed here, after the shape is validated above).
      const artifactCheck = verifyArtifactFile(evidenceDir, evidenceCase.operatorEvidence.artifact)
      if (!artifactCheck.ok) {
        return blocked(artifactCheck.error)
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
  const packageToolingSha = resolvePackageToolingSha(rootDir)
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
  // Owner P2 hardening: when a summary is present, its cases[] must be exactly the closed matrix set
  // (reject id-less, DUPLICATE, extra, or missing ids). No summary at all stays valid -> all BLOCKED.
  if (evidence.hasSummary) {
    validateEvidenceCaseSet(evidence.rawCases, (matrix.cases || []).map((c) => c.id))
  }
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

  const evidenceDirAbs = options.evidenceDir ? path.resolve(options.evidenceDir) : ''
  const cases = (matrix.cases || []).map((matrixCase) =>
    evaluateCase(
      matrixCase,
      evidence,
      packageSha,
      matrix.staleEvidenceShas || [],
      matrix.isolatedDatabaseName,
      packageToolingSha,
      evidenceDirAbs,
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
    qaToolingSha: packageToolingSha,
    runId: evidence.runId ?? null,
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

// Owner FIX 2(b): --strict. The non-strict runner only exits non-zero on FAIL>0, so an all-BLOCKED /
// 0-PASS run (residue never measured) exited 0 — a "green" that authorizes nothing. Under --strict the
// gate exits NON-ZERO unless EVERY case is PASS and residue is exactly 0. Returns null when the strict
// gate is satisfied, otherwise { exitCode, message }.
export function strictExitViolation(report) {
  const total = report.cases.length
  const allPass = report.counts.PASS === total && report.counts.FAIL === 0 && report.counts.BLOCKED === 0
  const residueZero = report.residue === 0
  if (allPass && residueZero) return null
  return {
    exitCode: 3,
    message:
      `--strict: NOT every one of the ${total} cases is PASS with residue=0 ` +
      `(PASS=${report.counts.PASS} BLOCKED=${report.counts.BLOCKED} FAIL=${report.counts.FAIL} ` +
      `residue=${report.residue ?? 'not measured'}).`,
  }
}

function printReport(report, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }
  console.log('[attendance-windows-native-qa-runner] DRAFT/HOLD risk matrix report')
  console.log(`  campaign: ${report.campaign}`)
  console.log(`  sourceSha: ${report.sourceSha}`)
  console.log(`  qaToolingSha: ${report.qaToolingSha ?? 'not bound'}`)
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
  --strict                     Exit NON-ZERO unless every case is PASS and residue=0
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
    if (args.strict) {
      const violation = strictExitViolation(report)
      if (violation) {
        if (!process.exitCode) process.exitCode = violation.exitCode
        console.error(`[attendance-windows-native-qa-runner] ${violation.message}`)
      } else {
        console.log(
          `[attendance-windows-native-qa-runner] --strict OK: all ${report.cases.length} cases PASS with residue=0.`,
        )
      }
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
