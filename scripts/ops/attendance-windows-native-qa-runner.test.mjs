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
    assert.deepEqual(
      report.cases.map((item) => item.id),
      [
        'PQA-01',
        'PQA-02',
        'PQA-03',
        'PQA-04',
        'PQA-05',
        'PQA-06',
        'PQA-07',
        'PQA-08',
        'PQA-09',
        'PQA-10',
      ],
    )
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
      () => runWindowsNativeQaMatrix({
        root,
        expectedSourceSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
      /override must match the QA pin/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runner fails closed on exact source SHA mismatch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'win-qa-runner-'))
  try {
    seedPackageRoot(root, {
      sourceSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
    assert.throws(
      () => runWindowsNativeQaMatrix({ root }),
      /Exact source SHA mismatch/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runner rejects stale package claims reused as current evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'win-qa-runner-'))
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-qa-evidence-'))
  try {
    seedPackageRoot(root)
    writeJson(path.join(evidenceDir, 'summary.json'), {
      sourceSha: STALE_SHA,
      residue: 0,
      cases: [
        {
          id: 'PQA-01',
          status: 'PASS',
          syntheticDataOnly: true,
          residue: 0,
          sourceSha: STALE_SHA,
        },
      ],
    })
    assert.throws(
      () => runWindowsNativeQaMatrix({ root, evidenceDir }),
      /stale/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(evidenceDir, { recursive: true, force: true })
  }
})

test('runner accepts PASS only when host evidence matches exact SHA and residue=0', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'win-qa-runner-'))
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-qa-evidence-'))
  try {
    seedPackageRoot(root)
    writeJson(path.join(evidenceDir, 'summary.json'), {
      sourceSha: PINNED_SHA,
      residue: 0,
      cases: [
        {
          id: 'PQA-01',
          status: 'PASS',
          syntheticDataOnly: true,
          residue: 0,
          sourceSha: PINNED_SHA,
          isolatedDatabase: true,
          databaseName: 'metasheet_windows_qa',
          hostPlatform: 'windows',
          windowsPowerShellVersion: '5.1.26100.1',
          customerOrExternalDestination: false,
          externalNotificationsSent: false,
          reason: 'synthetic multi-segment authoring verified on isolated QA DB',
        },
      ],
    })
    const report = runWindowsNativeQaMatrix({ root, evidenceDir })
    assert.equal(report.counts.PASS, 1)
    assert.equal(report.counts.BLOCKED, 9)
    assert.equal(report.residue, 0)
    assert.equal(report.cases[0].status, 'PASS')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(evidenceDir, { recursive: true, force: true })
  }
})

test('runner blocks PASS when host safety facts are omitted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'win-qa-runner-'))
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-qa-evidence-'))
  try {
    seedPackageRoot(root)
    writeJson(path.join(evidenceDir, 'summary.json'), {
      sourceSha: PINNED_SHA,
      residue: 0,
      cases: [
        {
          id: 'PQA-01',
          status: 'PASS',
          syntheticDataOnly: true,
          residue: 0,
          sourceSha: PINNED_SHA,
        },
      ],
    })
    const report = runWindowsNativeQaMatrix({ root, evidenceDir })
    assert.equal(report.counts.PASS, 0)
    assert.equal(report.counts.BLOCKED, 10)
    assert.match(report.cases[0].reason, /isolatedDatabase=true/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(evidenceDir, { recursive: true, force: true })
  }
})

test('runner rejects a pin that omits an explicit no-deployment boundary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'win-qa-runner-'))
  try {
    seedPackageRoot(root)
    const pinPath = path.join(root, 'scripts/ops/attendance-windows-native-qa-v2.pin.json')
    const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'))
    delete pin.deploymentAuthorized
    writeJson(pinPath, pin)
    assert.throws(
      () => runWindowsNativeQaMatrix({ root }),
      /explicitly keep deploymentAuthorized=false/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runner fails closed when residue is non-zero', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'win-qa-runner-'))
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-qa-evidence-'))
  try {
    seedPackageRoot(root)
    writeJson(path.join(evidenceDir, 'summary.json'), {
      sourceSha: PINNED_SHA,
      residue: 2,
      cases: [],
    })
    assert.throws(
      () => runWindowsNativeQaMatrix({ root, evidenceDir }),
      /Residue check failed/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(evidenceDir, { recursive: true, force: true })
  }
})
