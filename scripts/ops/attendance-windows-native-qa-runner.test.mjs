import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runWindowsNativeQaMatrix, strictExitViolation } from './attendance-windows-native-qa-runner.mjs'
import {
  MACHINE_EVIDENCE_PRODUCER,
  MACHINE_EVIDENCE_SCHEMA,
} from './windows-qa/harness/machine-evidence-contract.mjs'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const runnerPath = path.join(testDir, 'attendance-windows-native-qa-runner.mjs')
const repoRoot = path.resolve(testDir, '../..')
const PINNED_SHA = '0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b'
const STALE_SHA = '66a980357078f9d243fd4b025b080ac9aca9fa21'
// A tooling SHA deliberately DIFFERENT from the product SOURCE_SHA (PINNED_SHA), used to prove the
// runner reads the package QA_TOOLING_SHA rather than a constant that happens to equal SOURCE_SHA.
const TOOLING_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const MATRIX_IDS = [
  'PQA-01', 'PQA-02', 'PQA-03', 'PQA-04', 'PQA-05',
  'PQA-06', 'PQA-07', 'PQA-08', 'PQA-09', 'PQA-10',
]

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function seedPackageRoot(root, { sourceSha = PINNED_SHA, qaToolingSha = PINNED_SHA } = {}) {
  fs.mkdirSync(path.join(root, 'scripts/ops'), { recursive: true })
  fs.writeFileSync(path.join(root, 'SOURCE_SHA'), `${sourceSha}\n`)
  // Owner P2: the package build writes a QA_TOOLING_SHA the runner binds evidence to. `null` omits it
  // (to exercise the runner's fail-closed "no package tooling SHA" branch).
  if (qaToolingSha !== null) {
    fs.writeFileSync(path.join(root, 'QA_TOOLING_SHA'), `${qaToolingSha}\n`)
  }
  fs.copyFileSync(
    path.join(repoRoot, 'scripts/ops/attendance-windows-native-qa-v2.pin.json'),
    path.join(root, 'scripts/ops/attendance-windows-native-qa-v2.pin.json'),
  )
  fs.copyFileSync(
    path.join(repoRoot, 'scripts/ops/attendance-windows-native-qa-risk-matrix.json'),
    path.join(root, 'scripts/ops/attendance-windows-native-qa-risk-matrix.json'),
  )
  writeJson(path.join(root, `metasheet-attendance-onprem-v2.5.0-test.json`), {
    name: 'metasheet-attendance-onprem-v2.5.0-test',
    sourceSha,
    windowsNativeQa: {
      campaign: 'attendance-windows-native-qa-v2-20260804',
      status: 'DRAFT_HOLD',
      deploymentAuthorized: false,
      syntheticDataOnly: true,
    },
  })
}

// A STRUCTURED harness-produced machine-evidence envelope (owner P1), the shape a PASS now requires.
function machineEvidence(overrides = {}) {
  return {
    schema: MACHINE_EVIDENCE_SCHEMA,
    producedBy: MACHINE_EVIDENCE_PRODUCER,
    harnessModule: 'pqa-test-harness.mjs',
    determination: 'PASS',
    qaToolingSha: PINNED_SHA,
    facts: { rows: 1, uuid: '00000000-0000-4000-8000-0000000000a2' },
    producedAt: '2026-08-06T00:00:00Z',
    ...overrides,
  }
}

// A fully-affirmed PASS case (non-empty per-case reason + evidence + all per-case safety fields +
// a structured harness-produced machineEvidence envelope bound to the QA tooling SHA).
function passCase(id, overrides = {}) {
  return {
    id,
    title: id,
    status: 'PASS',
    syntheticDataOnly: true,
    sourceSha: PINNED_SHA,
    residue: 0,
    isolatedDatabase: true,
    databaseName: 'metasheet_windows_qa',
    hostPlatform: 'windows',
    windowsPowerShellVersion: '5.1.26100.1',
    customerOrExternalDestination: false,
    externalNotificationsSent: false,
    reason: 'synthetic verified on isolated QA DB',
    evidence: 'observed==expected; residue=0',
    machineEvidence: machineEvidence(),
    ...overrides,
  }
}

// A PASS-status case with a long free-text reason/evidence AND all per-case safety fields, but NO
// structured machineEvidence — the exact "ten long meaningless strings" forge (owner P1).
function freeTextForge(id, overrides = {}) {
  const c = passCase(id, overrides)
  delete c.machineEvidence
  c.reason = 'this is a long plausible-looking free-text reason typed by an operator who never ran it'
  c.evidence = 'observed matched expected across all steps; residue measured 0; totally legitimate text'
  return c
}

function blockedCase(id) {
  return { id, title: id, status: 'BLOCKED', syntheticDataOnly: false, reason: '', evidence: '' }
}

// Build the closed 10-case set, overriding specific ids from `map`.
function full10(map = {}) {
  return MATRIX_IDS.map((id) => map[id] || blockedCase(id))
}

function writeSummary(evidenceDir, { sourceSha = PINNED_SHA, residue = 0, cases }) {
  writeJson(path.join(evidenceDir, 'summary.json'), { sourceSha, residue, cases })
}

function withRoots(fn, seedOpts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'win-qa-runner-'))
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-qa-evidence-'))
  try {
    seedPackageRoot(root, seedOpts)
    return fn(root, evidenceDir)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(evidenceDir, { recursive: true, force: true })
  }
}

test('runner reports honest BLOCKED for PQA-01..10 without inventing residue evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'win-qa-runner-'))
  try {
    seedPackageRoot(root)
    const report = runWindowsNativeQaMatrix({ root })
    assert.equal(report.sourceSha, PINNED_SHA)
    assert.equal(report.residue, null)
    assert.equal(report.deploymentAuthorized, false)
    assert.equal(report.status, 'DRAFT_HOLD')
    assert.equal(report.counts.PASS, 0)
    assert.equal(report.counts.FAIL, 0)
    assert.equal(report.counts.BLOCKED, 10)
    assert.deepEqual(report.cases.map((item) => item.id), MATRIX_IDS)
    const pqa10 = report.cases.find((item) => item.id === 'PQA-10')
    assert.equal(pqa10.status, 'BLOCKED')
    assert.match(pqa10.reason, /Do not invent PASS|Windows-host synthetic evidence/i)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runner rejects an expected source SHA override that differs from the QA pin', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'win-qa-runner-'))
  try {
    seedPackageRoot(root)
    assert.throws(
      () => runWindowsNativeQaMatrix({ root, expectedSourceSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
      /override must match the QA pin/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runner fails closed on exact source SHA mismatch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'win-qa-runner-'))
  try {
    seedPackageRoot(root, { sourceSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
    assert.throws(() => runWindowsNativeQaMatrix({ root }), /Exact source SHA mismatch/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runner rejects stale package claims reused as current evidence', () => {
  withRoots((root, evidenceDir) => {
    writeSummary(evidenceDir, {
      sourceSha: STALE_SHA,
      residue: 0,
      cases: full10({ 'PQA-01': passCase('PQA-01', { sourceSha: STALE_SHA }) }),
    })
    assert.throws(() => runWindowsNativeQaMatrix({ root, evidenceDir }), /stale/)
  })
})

test('runner accepts PASS only when host evidence matches exact SHA and residue=0', () => {
  withRoots((root, evidenceDir) => {
    writeSummary(evidenceDir, { cases: full10({ 'PQA-01': passCase('PQA-01') }) })
    const report = runWindowsNativeQaMatrix({ root, evidenceDir })
    assert.equal(report.counts.PASS, 1)
    assert.equal(report.counts.BLOCKED, 9)
    assert.equal(report.residue, 0)
    assert.equal(report.cases[0].status, 'PASS')
  })
})

test('runner blocks PASS when host safety facts are omitted', () => {
  withRoots((root, evidenceDir) => {
    // A PASS-status case with floor-satisfying reason+evidence but NO per-case safety fields.
    // (reason/evidence clear the FIX 2(c) floor so evaluation reaches the safety-field gate.)
    writeSummary(evidenceDir, {
      cases: full10({
        'PQA-01': {
          id: 'PQA-01', title: 'PQA-01', status: 'PASS',
          syntheticDataOnly: true, residue: 0, sourceSha: PINNED_SHA,
          reason: 'synthetic verified on isolated QA DB', evidence: 'observed==expected; residue=0',
        },
      }),
    })
    const report = runWindowsNativeQaMatrix({ root, evidenceDir })
    assert.equal(report.counts.PASS, 0)
    assert.equal(report.counts.BLOCKED, 10)
    assert.match(report.cases[0].reason, /isolatedDatabase=true/)
  })
})

test('runner rejects a pin that omits an explicit no-deployment boundary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'win-qa-runner-'))
  try {
    seedPackageRoot(root)
    const pinPath = path.join(root, 'scripts/ops/attendance-windows-native-qa-v2.pin.json')
    const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'))
    delete pin.deploymentAuthorized
    writeJson(pinPath, pin)
    assert.throws(() => runWindowsNativeQaMatrix({ root }), /explicitly keep deploymentAuthorized=false/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runner fails closed when residue is non-zero', () => {
  withRoots((root, evidenceDir) => {
    writeSummary(evidenceDir, { residue: 2, cases: full10() })
    assert.throws(() => runWindowsNativeQaMatrix({ root, evidenceDir }), /Residue check failed/)
  })
})

// --------------------------------------------------------------------------
// Owner P2 hardening — three mutation groups (forged PASS must never PASS).
// --------------------------------------------------------------------------

test('P2 group (a): missing/empty/whitespace evidence field never PASSes', () => {
  withRoots((root, evidenceDir) => {
    // evidence field entirely absent
    writeSummary(evidenceDir, {
      cases: full10({ 'PQA-01': (() => { const c = passCase('PQA-01'); delete c.evidence; return c })() }),
    })
    let report = runWindowsNativeQaMatrix({ root, evidenceDir })
    assert.equal(report.counts.PASS, 0)
    assert.match(report.cases[0].reason, /non-empty per-case evidence/)

    // whitespace-only evidence
    writeSummary(evidenceDir, { cases: full10({ 'PQA-01': passCase('PQA-01', { evidence: '   ' }) }) })
    report = runWindowsNativeQaMatrix({ root, evidenceDir })
    assert.equal(report.counts.PASS, 0)
    assert.match(report.cases[0].reason, /non-empty per-case evidence/)
  })
})

test('P2 group (b): duplicate case id is rejected (never silently overwritten)', () => {
  withRoots((root, evidenceDir) => {
    const cases = full10({ 'PQA-01': passCase('PQA-01') })
    cases.push(passCase('PQA-01', { evidence: 'second forged copy' })) // 11 entries, dup PQA-01
    writeSummary(evidenceDir, { cases })
    assert.throws(() => runWindowsNativeQaMatrix({ root, evidenceDir }), /DUPLICATE id: PQA-01/)
  })
})

test('P2 group (b2): extra/unknown or missing ids are rejected (closed set)', () => {
  withRoots((root, evidenceDir) => {
    const extra = full10({ 'PQA-01': passCase('PQA-01') })
    extra.push(passCase('PQA-99'))
    writeSummary(evidenceDir, { cases: extra })
    assert.throws(() => runWindowsNativeQaMatrix({ root, evidenceDir }), /extra: PQA-99/)

    // missing: only 9 cases present
    writeSummary(evidenceDir, { cases: full10().slice(0, 9) })
    assert.throws(() => runWindowsNativeQaMatrix({ root, evidenceDir }), /missing: PQA-10/)
  })
})

test('P2 group (c): forged PASS (status + safety only, empty reason) never PASSes', () => {
  withRoots((root, evidenceDir) => {
    // All safety fields affirmed, status PASS, but reason empty and evidence empty.
    writeSummary(evidenceDir, {
      cases: full10({ 'PQA-01': passCase('PQA-01', { reason: '   ', evidence: '' }) }),
    })
    const report = runWindowsNativeQaMatrix({ root, evidenceDir })
    assert.equal(report.counts.PASS, 0)
    assert.match(report.cases[0].reason, /non-empty per-case reason/)
  })
})

test('P2: a single shared top-level safety affirmation cannot cover any case (no raw fallback)', () => {
  withRoots((root, evidenceDir) => {
    // Per-case has status PASS + reason + evidence, but the safety fields are only TOP-LEVEL.
    writeJson(path.join(evidenceDir, 'summary.json'), {
      sourceSha: PINNED_SHA,
      residue: 0,
      isolatedDatabase: true,
      databaseName: 'metasheet_windows_qa',
      hostPlatform: 'windows',
      windowsPowerShellVersion: '5.1.26100.1',
      customerOrExternalDestination: false,
      externalNotificationsSent: false,
      cases: full10({
        'PQA-01': {
          id: 'PQA-01', title: 'PQA-01', status: 'PASS',
          syntheticDataOnly: true, residue: 0, sourceSha: PINNED_SHA,
          reason: 'synthetic verified on isolated QA DB', evidence: 'observed==expected; residue=0',
        },
      }),
    })
    const report = runWindowsNativeQaMatrix({ root, evidenceDir })
    assert.equal(report.counts.PASS, 0)
    assert.match(report.cases[0].reason, /isolatedDatabase=true/)
  })
})

// --------------------------------------------------------------------------
// Owner FIX 2(c) — evidence FLOOR: a trivial token can no longer PASS.
// --------------------------------------------------------------------------

test("FIX 2(c): the owner's reason:'x' evidence:'x' forgery no longer PASSes", () => {
  withRoots((root, evidenceDir) => {
    writeSummary(evidenceDir, {
      cases: full10({ 'PQA-01': passCase('PQA-01', { reason: 'x', evidence: 'x' }) }),
    })
    const report = runWindowsNativeQaMatrix({ root, evidenceDir })
    assert.equal(report.counts.PASS, 0)
    assert.match(report.cases[0].reason, /per-case reason of at least 12 chars/)
  })
})

test('FIX 2(c): a per-case evidence field below the length floor never PASSes', () => {
  withRoots((root, evidenceDir) => {
    // reason is fine; evidence "short" (5 chars) is below the 16-char floor.
    writeSummary(evidenceDir, {
      cases: full10({ 'PQA-01': passCase('PQA-01', { evidence: 'short' }) }),
    })
    const report = runWindowsNativeQaMatrix({ root, evidenceDir })
    assert.equal(report.counts.PASS, 0)
    assert.match(report.cases[0].reason, /per-case evidence field.*at least 16 chars/)
  })
})

// --------------------------------------------------------------------------
// Owner 3rd review P1 — a PASS requires a STRUCTURED machine-evidence record, not a long string.
// (The reproduction: ten long free-text reason/evidence strings + residue=0 forged 10/10 PASS.)
// --------------------------------------------------------------------------

test('P1: a PASS-status case with long free-text but NO machineEvidence is BLOCKED', () => {
  withRoots((root, evidenceDir) => {
    writeSummary(evidenceDir, { cases: full10({ 'PQA-01': freeTextForge('PQA-01') }) })
    const report = runWindowsNativeQaMatrix({ root, evidenceDir })
    assert.equal(report.counts.PASS, 0)
    assert.match(report.cases[0].reason, /structured machineEvidence object produced by a harness/)
  })
})

test('P1 positive control: the SAME case WITH a structured machineEvidence PASSes', () => {
  // Same shape as the forge above, but now carrying the harness-produced machineEvidence envelope.
  withRoots((root, evidenceDir) => {
    writeSummary(evidenceDir, { cases: full10({ 'PQA-01': passCase('PQA-01') }) })
    const report = runWindowsNativeQaMatrix({ root, evidenceDir })
    assert.equal(report.counts.PASS, 1)
    assert.equal(report.cases[0].status, 'PASS')
  })
})

test('P1 reproduction: ten long free-text cases (no machineEvidence) do NOT strict-PASS', () => {
  withRoots((root, evidenceDir) => {
    writeSummary(evidenceDir, { residue: 0, cases: MATRIX_IDS.map((id) => freeTextForge(id)) })
    const report = runWindowsNativeQaMatrix({ root, evidenceDir })
    assert.equal(report.counts.PASS, 0)
    assert.equal(report.counts.BLOCKED, 10)
    assert.equal(strictExitViolation(report).exitCode, 3)
  })
})

test('P1: machineEvidence with determination!=PASS is rejected (cannot borrow a BLOCKED record)', () => {
  withRoots((root, evidenceDir) => {
    writeSummary(evidenceDir, {
      cases: full10({ 'PQA-01': passCase('PQA-01', { machineEvidence: machineEvidence({ determination: 'BLOCKED' }) }) }),
    })
    const report = runWindowsNativeQaMatrix({ root, evidenceDir })
    assert.equal(report.counts.PASS, 0)
    assert.match(report.cases[0].reason, /determination must be "PASS"/)
  })
})

test('P1: machineEvidence with empty facts is rejected', () => {
  withRoots((root, evidenceDir) => {
    writeSummary(evidenceDir, {
      cases: full10({ 'PQA-01': passCase('PQA-01', { machineEvidence: machineEvidence({ facts: {} }) }) }),
    })
    const report = runWindowsNativeQaMatrix({ root, evidenceDir })
    assert.equal(report.counts.PASS, 0)
    assert.match(report.cases[0].reason, /facts must be a non-empty object/)
  })
})

// --------------------------------------------------------------------------
// Owner 3rd review P2 — the QA tooling SHA must be bound to the package QA_TOOLING_SHA.
// --------------------------------------------------------------------------

test('P2: machineEvidence.qaToolingSha not matching the package QA_TOOLING_SHA is BLOCKED', () => {
  withRoots((root, evidenceDir) => {
    // Package QA_TOOLING_SHA is PINNED_SHA (seed default); evidence claims a different tooling SHA.
    writeSummary(evidenceDir, {
      cases: full10({ 'PQA-01': passCase('PQA-01', { machineEvidence: machineEvidence({ qaToolingSha: TOOLING_SHA }) }) }),
    })
    const report = runWindowsNativeQaMatrix({ root, evidenceDir })
    assert.equal(report.counts.PASS, 0)
    assert.match(report.cases[0].reason, /qaToolingSha .* does not match the package QA_TOOLING_SHA/)
  })
})

test('P2: a present-but-wrong per-case qaToolingSha is rejected, not ignored', () => {
  // machineEvidence is valid (matches package), but a stray per-case qaToolingSha disagrees.
  withRoots((root, evidenceDir) => {
    writeSummary(evidenceDir, {
      cases: full10({ 'PQA-01': passCase('PQA-01', { qaToolingSha: TOOLING_SHA }) }),
    })
    const report = runWindowsNativeQaMatrix({ root, evidenceDir })
    assert.equal(report.counts.PASS, 0)
    assert.match(report.cases[0].reason, /per-case qaToolingSha to equal the package QA_TOOLING_SHA/)
  })
})

test('P2: a present-but-wrong top-level qaToolingSha is rejected, not ignored', () => {
  withRoots((root, evidenceDir) => {
    writeJson(path.join(evidenceDir, 'summary.json'), {
      sourceSha: PINNED_SHA,
      qaToolingSha: TOOLING_SHA, // top-level, disagrees with the package QA_TOOLING_SHA
      residue: 0,
      cases: full10({ 'PQA-01': passCase('PQA-01') }),
    })
    const report = runWindowsNativeQaMatrix({ root, evidenceDir })
    assert.equal(report.counts.PASS, 0)
    assert.match(report.cases[0].reason, /top-level qaToolingSha to equal the package QA_TOOLING_SHA/)
  })
})

test('P2 positive control: a DISTINCT package QA_TOOLING_SHA matched by the evidence PASSes', () => {
  // Proves the runner reads the package QA_TOOLING_SHA file, not a constant equal to SOURCE_SHA:
  // package tooling SHA = TOOLING_SHA (!= PINNED_SHA product SHA); evidence stamps the same value.
  withRoots(
    (root, evidenceDir) => {
      assert.equal(runWindowsNativeQaMatrix({ root }).qaToolingSha, TOOLING_SHA)
      writeSummary(evidenceDir, {
        cases: full10({ 'PQA-01': passCase('PQA-01', { machineEvidence: machineEvidence({ qaToolingSha: TOOLING_SHA }) }) }),
      })
      const report = runWindowsNativeQaMatrix({ root, evidenceDir })
      assert.equal(report.counts.PASS, 1)
      assert.equal(report.cases[0].status, 'PASS')
    },
    { qaToolingSha: TOOLING_SHA },
  )
})

test('P2: a package with NO QA_TOOLING_SHA cannot PASS (fail closed)', () => {
  withRoots(
    (root, evidenceDir) => {
      assert.equal(runWindowsNativeQaMatrix({ root }).qaToolingSha, null)
      writeSummary(evidenceDir, { cases: full10({ 'PQA-01': passCase('PQA-01') }) })
      const report = runWindowsNativeQaMatrix({ root, evidenceDir })
      assert.equal(report.counts.PASS, 0)
      assert.match(report.cases[0].reason, /requires a package QA_TOOLING_SHA/)
    },
    { qaToolingSha: null },
  )
})

// --------------------------------------------------------------------------
// Owner FIX 2(b) — --strict exit code. Three paths, proven via the real CLI.
// --------------------------------------------------------------------------

function runCli(args) {
  return spawnSync(process.execPath, [runnerPath, ...args], { encoding: 'utf8' })
}

test('--strict exits NON-ZERO when not every case PASSes (all BLOCKED / residue not measured)', () => {
  withRoots((root) => {
    const res = runCli(['--root', root, '--strict'])
    assert.notEqual(res.status, 0)
    assert.match(res.stderr, /--strict: NOT every one of the 10 cases is PASS/)
  })
})

test('--strict exits ZERO only when every case PASSes and residue=0', () => {
  withRoots((root, evidenceDir) => {
    writeSummary(evidenceDir, { residue: 0, cases: MATRIX_IDS.map((id) => passCase(id)) })
    const res = runCli(['--root', root, '--evidence-dir', evidenceDir, '--strict'])
    assert.equal(res.status, 0)
    assert.match(res.stdout, /--strict OK: all 10 cases PASS with residue=0/)
  })
})

test('without --strict an all-BLOCKED run still exits ZERO (unchanged behaviour)', () => {
  withRoots((root) => {
    const res = runCli(['--root', root])
    assert.equal(res.status, 0)
  })
})

test('strictExitViolation: null only when all PASS with residue exactly 0', () => {
  const mk = (counts, residue, total = 10) => ({ counts, residue, cases: new Array(total).fill(null) })
  assert.equal(strictExitViolation(mk({ PASS: 10, BLOCKED: 0, FAIL: 0 }, 0)), null)
  assert.equal(strictExitViolation(mk({ PASS: 0, BLOCKED: 10, FAIL: 0 }, null)).exitCode, 3)
  assert.equal(strictExitViolation(mk({ PASS: 10, BLOCKED: 0, FAIL: 0 }, 2)).exitCode, 3)
  assert.equal(strictExitViolation(mk({ PASS: 9, BLOCKED: 0, FAIL: 1 }, 0)).exitCode, 3)
})

// --------------------------------------------------------------------------
// Positive control: the SHIPPED template must still report all BLOCKED.
// --------------------------------------------------------------------------

test('shipped summary.template.json reports all BLOCKED under the hardened rules', () => {
  withRoots((root, evidenceDir) => {
    fs.copyFileSync(
      path.join(repoRoot, 'scripts/ops/windows-qa/summary.template.json'),
      path.join(evidenceDir, 'summary.json'),
    )
    const report = runWindowsNativeQaMatrix({ root, evidenceDir })
    assert.equal(report.counts.PASS, 0)
    assert.equal(report.counts.FAIL, 0)
    assert.equal(report.counts.BLOCKED, 10)
    assert.deepEqual(report.cases.map((c) => c.id), MATRIX_IDS)
  })
})
