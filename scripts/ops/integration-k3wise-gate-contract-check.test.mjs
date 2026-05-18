import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { buildGateContractReport } from './integration-k3wise-gate-contract-check.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..')
const scriptPath = path.join(__dirname, 'integration-k3wise-gate-contract-check.mjs')

async function makeDir() {
  return mkdtemp(path.join(os.tmpdir(), 'k3wise-gate-contract-'))
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function completePacket() {
  return {
    webapiReadList: {
      answers: {
        'O1-MAT': '/K3API/Material/List',
        'O1-MAT-M': 'POST',
        'O1-BOM': '/K3API/BOM/List',
        'O1-BOM-M': 'POST',
        'O2-P': 'PageIndex/PageSize',
        'O2-T': 'Total',
        'O2-C': '100',
        'O3-F': 'number and modifiedSince',
        'O3-M': 'ModifiedSince',
        'O4-MAT': 'FNumber,FName,FModel,FBaseUnitID',
        'O4-BOM': 'FParentItemNumber,FChildItemNumber,FQty,FUnitID,FEntryID',
        O6: 'same token scope as Save',
      },
      samples: {
        materialList: 'sample-material-list.redacted.json',
        materialDetail: 'sample-material-detail.redacted.json',
        bomList: 'sample-bom-list.redacted.json',
        bomDetail: 'sample-bom-detail.redacted.json',
      },
    },
    relationshipMapping: {
      answers: {
        R1: 'flat lines',
        R2: 'yes, parentCode and childCode are K3 FNumber values',
        R3: 'parentCode + childCode + sequence',
        R4: 'header body with FChildItems[]',
        R5: 'dead-letter-row',
        R6: 'unit and sequence are mandatory',
        R7: 'yes',
      },
      samples: {
        flatBomLines: 'relationship-flat-bom-lines.redacted.json',
        treeBom: 'relationship-tree-bom.redacted.json',
        unresolvedChild: 'relationship-unresolved-child.redacted.json',
        k3BomSaveShape: 'relationship-k3-bom-save-shape.redacted.json',
      },
    },
  }
}

async function writeCompleteSamples(dir, overrides = {}) {
  const samples = {
    'sample-material-list.redacted.json': {
      ResponseStatus: { IsSuccess: true },
      Data: [{ FNumber: 'MAT-001', FName: 'Sample material', FModel: 'Spec', FBaseUnitID: 'PCS' }],
    },
    'sample-material-detail.redacted.json': {
      ResponseStatus: { IsSuccess: true },
      Data: { FNumber: 'MAT-001', FName: 'Sample material' },
    },
    'sample-bom-list.redacted.json': {
      ResponseStatus: { IsSuccess: true },
      Data: [{ FParentItemNumber: 'FG-001', FChildItemNumber: 'MAT-001', FQty: 2, FUnitID: 'PCS' }],
    },
    'sample-bom-detail.redacted.json': {
      ResponseStatus: { IsSuccess: true },
      Data: { FParentItemNumber: 'FG-001', FChildItems: [{ FItemNumber: 'MAT-001', FQty: 2 }] },
    },
    'relationship-flat-bom-lines.redacted.json': {
      case: 'flat-bom-lines',
      records: [{ parentCode: 'FG-001', childCode: 'MAT-001', quantity: 2 }],
    },
    'relationship-tree-bom.redacted.json': {
      case: 'tree-bom',
      root: { code: 'FG-001', children: [{ code: 'MAT-001', quantity: 2 }] },
    },
    'relationship-unresolved-child.redacted.json': {
      case: 'unresolved-child-material',
      record: { parentCode: 'FG-001', childCode: 'MAT-MISSING' },
      expectedCustomerPolicy: 'dead-letter-row',
    },
    'relationship-k3-bom-save-shape.redacted.json': {
      Data: {
        FParentItemNumber: 'FG-001',
        FChildItems: [{ FItemNumber: 'MAT-001', FQty: 2, FUnitID: 'PCS', FEntryID: 1 }],
      },
    },
    ...overrides,
  }
  await Promise.all(Object.entries(samples).map(([fileName, value]) => writeJson(path.join(dir, fileName), value)))
}

function runCli(args, cwd = repoRoot) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
  })
}

test('complete GATE contract packet passes and writes JSON/Markdown evidence', async () => {
  const dir = await makeDir()
  await writeCompleteSamples(dir)
  const packetPath = path.join(dir, 'packet.json')
  const outDir = path.join(dir, 'out')
  await writeJson(packetPath, completePacket())

  const result = runCli(['--input', packetPath, '--out-dir', outDir])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /"decision": "PASS"/)

  const evidence = JSON.parse(await readFile(path.join(outDir, 'integration-k3wise-gate-contract-check.json'), 'utf8'))
  assert.equal(evidence.decision, 'PASS')
  assert.equal(evidence.sections.webapiReadList.answered, 12)
  assert.equal(evidence.sections.relationshipMapping.answered, 7)
  assert.equal(evidence.issues.length, 0)

  const markdown = await readFile(path.join(outDir, 'integration-k3wise-gate-contract-check.md'), 'utf8')
  assert.match(markdown, /Decision: `PASS`/)
  assert.match(markdown, /Stage 1 Lock: `held`/)
})

test('missing answers or sample files block runtime work with exit 2', async () => {
  const dir = await makeDir()
  await writeCompleteSamples(dir)
  const packet = completePacket()
  packet.webapiReadList.answers['O1-BOM'] = '<fill>'
  packet.relationshipMapping.samples.treeBom = 'missing-tree.redacted.json'
  const report = await buildGateContractReport(packet, {
    inputPath: path.join(dir, 'packet.json'),
    generatedAt: '2026-05-18T00:00:00.000Z',
  })

  assert.equal(report.decision, 'GATE_BLOCKED')
  assert.equal(report.exitCode, 2)
  assert(report.issues.some((issue) => issue.id === 'webapiReadList.O1-BOM'))
  assert(report.issues.some((issue) => issue.id === 'relationshipMapping.sample.treeBom'))
})

test('absolute read endpoints are rejected before runtime work', async () => {
  const dir = await makeDir()
  await writeCompleteSamples(dir)
  const packet = completePacket()
  packet.webapiReadList.answers['O1-MAT'] = 'https://k3.example.test/K3API/Material/List'

  const report = await buildGateContractReport(packet, {
    inputPath: path.join(dir, 'packet.json'),
    generatedAt: '2026-05-18T00:00:00.000Z',
  })

  assert.equal(report.decision, 'FAIL')
  assert(report.issues.some((issue) => issue.id === 'webapiReadList.O1-MAT' && issue.status === 'fail'))
})

test('secret-looking sample values fail and evidence does not echo raw secret', async () => {
  const dir = await makeDir()
  await writeCompleteSamples(dir, {
    'sample-material-detail.redacted.json': {
      ResponseStatus: { IsSuccess: true },
      Data: {
        FNumber: 'MAT-001',
        FName: 'Sample material',
        password: 'RAW-PASSWORD-SHOULD-NOT-LEAK',
        callback: 'https://k3.example.test/K3API/?access_token=RAW-TOKEN-SHOULD-NOT-LEAK',
      },
    },
  })
  const packetPath = path.join(dir, 'packet.json')
  const outDir = path.join(dir, 'out')
  await writeJson(packetPath, completePacket())

  const result = runCli(['--input', packetPath, '--out-dir', outDir])
  assert.equal(result.status, 1)
  const evidenceText = await readFile(path.join(outDir, 'integration-k3wise-gate-contract-check.json'), 'utf8')
  assert.match(evidenceText, /secret-looking key/)
  assert.equal(evidenceText.includes('RAW-PASSWORD-SHOULD-NOT-LEAK'), false)
  assert.equal(evidenceText.includes('RAW-TOKEN-SHOULD-NOT-LEAK'), false)
})
