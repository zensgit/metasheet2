import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runWindowsNativeQaMatrix } from './attendance-windows-native-qa-runner.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PINNED_SHA = '0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b'
const STALE_SHA = '66a980357078f9d243fd4b025b080ac9aca9fa21'
const MATRIX_IDS = [
  'PQA-01', 'PQA-02', 'PQA-03', 'PQA-04', 'PQA-05',
  'PQA-06', 'PQA-07', 'PQA-08', 'PQA-09', 'PQA-10',
]

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function seedPackageRoot(root, { sourceSha = PINNED_SHA } = {}) {
  fs.mkdirSync(path.join(root, 'scripts/ops'), { recursive: true })
  fs.writeFileSync(path.join(root, 'SOURCE_SHA'), `${sourceSha}\n`)
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

// A fully-affirmed PASS case (non-empty per-case reason + evidence + all per-case safety fields).
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
    ...overrides,
  }
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

function withRoots(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'win-qa-runner-'))
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-qa-evidence-'))
  try {
    seedPackageRoot(root)
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
    // A PASS-status case with reason+evidence but NO per-case safety fields.
    writeSummary(evidenceDir, {
      cases: full10({
        'PQA-01': {
          id: 'PQA-01', title: 'PQA-01', status: 'PASS',
          syntheticDataOnly: true, residue: 0, sourceSha: PINNED_SHA,
          reason: 'r', evidence: 'e',
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
          syntheticDataOnly: true, residue: 0, sourceSha: PINNED_SHA, reason: 'r', evidence: 'e',
        },
      }),
    })
    const report = runWindowsNativeQaMatrix({ root, evidenceDir })
    assert.equal(report.counts.PASS, 0)
    assert.match(report.cases[0].reason, /isolatedDatabase=true/)
  })
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
