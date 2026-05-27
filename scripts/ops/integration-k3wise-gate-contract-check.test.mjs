import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { buildGateContractReport, isDirectCliRun } from './integration-k3wise-gate-contract-check.mjs'

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

function materialOnlyPacket() {
  return {
    webapiReadList: {
      answers: {
        'O1-MAT': '/K3API/Material/GetDetail',
        'O1-MAT-M': 'POST',
        O6: 'same token scope as Save',
      },
      samples: {
        materialDetail: 'sample-material-detail.redacted.json',
      },
    },
    materialOnlySafety: {
      answers: {
        'M0-SCOPE': 'Material only first',
        'M0-PREVIEW-FIELDS': 'First dry-run preview only includes FNumber and FName',
        'M0-BOM-DEFERRED': 'BOM deferred until Material passes',
        'M0-SAVE-ONLY-SEPARATE-APPROVAL': 'Save-only requires separate approval after dry-run',
        'M0-AUTOSUBMIT-FALSE': 'autoSubmit=false',
        'M0-AUTOAUDIT-FALSE': 'autoAudit=false',
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

async function writeMaterialOnlySamples(dir, overrides = {}) {
  const samples = {
    'sample-material-detail.redacted.json': {
      StatusCode: 200,
      Message: 'Successful',
      Data: [
        {
          Data: {
            FNumber: '<redacted:FNumber>',
            FName: '<redacted:FName>',
          },
        },
      ],
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

test('material-only scope passes without BOM, pagination, list, or relationship evidence', async () => {
  const dir = await makeDir()
  await writeMaterialOnlySamples(dir)
  const packetPath = path.join(dir, 'packet.json')
  const outDir = path.join(dir, 'out')
  await writeJson(packetPath, materialOnlyPacket())

  const result = runCli(['--scope', 'material-only', '--input', packetPath, '--out-dir', outDir])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /"decision": "PASS_MATERIAL_ONLY"/)

  const evidence = JSON.parse(await readFile(path.join(outDir, 'integration-k3wise-gate-contract-check.json'), 'utf8'))
  assert.equal(evidence.scope, 'material-only')
  assert.equal(evidence.decision, 'PASS_MATERIAL_ONLY')
  assert.equal(evidence.sections.webapiReadList.answered, 3)
  assert.equal(evidence.sections.webapiReadList.requiredAnswers, 3)
  assert.equal(evidence.sections.webapiReadList.samples.length, 1)
  assert.equal(evidence.sections.materialOnlySafety.answered, 6)
  assert.equal(evidence.sections.relationshipMapping.requiredAnswers, 0)
  assert.equal(evidence.issues.length, 0)

  const markdown = await readFile(path.join(outDir, 'integration-k3wise-gate-contract-check.md'), 'utf8')
  assert.match(markdown, /Scope: `material-only`/)
  assert.match(markdown, /not a full customer GATE pass/)
  assert.match(markdown, /does not approve K3 Save-only/)
})

test('material-only scope blocks missing material answers, safety answers, or material sample', async () => {
  const dir = await makeDir()
  const packet = materialOnlyPacket()
  packet.webapiReadList.answers.O6 = '<fill>'
  packet.webapiReadList.samples.materialDetail = 'missing-material.redacted.json'
  packet.materialOnlySafety.answers['M0-AUTOAUDIT-FALSE'] = '<fill>'
  packet.materialOnlySafety.answers['M0-PREVIEW-FIELDS'] = 'Material preview only'

  const report = await buildGateContractReport(packet, {
    inputPath: path.join(dir, 'packet.json'),
    generatedAt: '2026-05-27T00:00:00.000Z',
    scope: 'material-only',
  })

  assert.equal(report.decision, 'GATE_BLOCKED')
  assert.equal(report.exitCode, 2)
  assert(report.issues.some((issue) => issue.id === 'webapiReadList.O6'))
  assert(report.issues.some((issue) => issue.id === 'webapiReadList.sample.materialDetail'))
  assert(report.issues.some((issue) => issue.id === 'materialOnlySafety.M0-AUTOAUDIT-FALSE'))
  assert(report.issues.some((issue) => issue.id === 'materialOnlySafety.M0-PREVIEW-FIELDS'))
})

test('material-only scope still rejects unsafe endpoints and query secrets', async () => {
  const dir = await makeDir()
  await writeMaterialOnlySamples(dir)

  const absolutePacket = materialOnlyPacket()
  absolutePacket.webapiReadList.answers['O1-MAT'] = 'https://k3.example.test/K3API/Material/GetDetail'
  const absoluteReport = await buildGateContractReport(absolutePacket, {
    inputPath: path.join(dir, 'packet.json'),
    generatedAt: '2026-05-27T00:00:00.000Z',
    scope: 'material-only',
  })
  assert.equal(absoluteReport.decision, 'FAIL')
  assert(absoluteReport.issues.some((issue) => issue.id === 'webapiReadList.O1-MAT' && issue.status === 'fail'))

  const secretQueryPacket = materialOnlyPacket()
  secretQueryPacket.webapiReadList.answers['O1-MAT'] = '/K3API/Material/GetDetail?token=RAW-TOKEN'
  const secretQueryReport = await buildGateContractReport(secretQueryPacket, {
    inputPath: path.join(dir, 'packet.json'),
    generatedAt: '2026-05-27T00:00:00.000Z',
    scope: 'material-only',
  })
  assert.equal(secretQueryReport.decision, 'FAIL')
  assert(secretQueryReport.issues.some((issue) => issue.id === 'webapiReadList.O1-MAT' && issue.status === 'fail'))
})

test('material-only scope still scans material samples for secrets', async () => {
  const dir = await makeDir()
  await writeMaterialOnlySamples(dir, {
    'sample-material-detail.redacted.json': {
      StatusCode: 200,
      Data: [
        {
          Data: {
            FNumber: '<redacted:FNumber>',
            FName: '<redacted:FName>',
            callback: 'https://k3.example.test/K3API?access_token=RAW-TOKEN-SHOULD-NOT-LEAK',
          },
        },
      ],
    },
  })
  const packetPath = path.join(dir, 'packet.json')
  const outDir = path.join(dir, 'out')
  await writeJson(packetPath, materialOnlyPacket())

  const result = runCli(['--scope', 'material-only', '--input', packetPath, '--out-dir', outDir])
  assert.equal(result.status, 1)
  const evidenceText = await readFile(path.join(outDir, 'integration-k3wise-gate-contract-check.json'), 'utf8')
  assert.match(evidenceText, /URL query secret/)
  assert.equal(evidenceText.includes('RAW-TOKEN-SHOULD-NOT-LEAK'), false)
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

test('init-template writes a safe fillable packet that is blocked until customer answers are filled', async () => {
  const dir = await makeDir()

  const initResult = runCli(['--init-template', dir])
  assert.equal(initResult.status, 0, initResult.stderr)
  assert.match(initResult.stdout, /"decision": "TEMPLATE_CREATED"/)
  assert.match(initResult.stdout, /"sampleCount": 8/)
  assert.match(initResult.stdout, /README-CUSTOMER-HANDOFF\.zh\.md/)

  const packetPath = path.join(dir, 'k3wise-gate-contract-packet.template.json')
  const packet = JSON.parse(await readFile(packetPath, 'utf8'))
  assert.equal(packet.webapiReadList.answers['O1-MAT'], '<fill-outside-git>')
  assert.equal(packet.relationshipMapping.answers.R1, '<fill-outside-git>')

  const readmeText = await readFile(path.join(dir, 'README-CUSTOMER-HANDOFF.zh.md'), 'utf8')
  assert.match(readmeText, /K3 WISE GATE 信息填写说明/)
  assert.match(readmeText, /O1-MAT/)
  assert.match(readmeText, /O1-BOM/)
  assert.match(readmeText, /R1/)
  assert.match(readmeText, /R7/)
  assert.match(readmeText, /不执行 K3 Save、Submit、Audit/)
  assert.doesNotMatch(readmeText, /Bearer\s+[A-Za-z0-9._-]{16,}/i)
  assert.doesNotMatch(readmeText, /[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/)
  assert.doesNotMatch(readmeText, /\b(postgres|postgresql|mysql|mssql|sqlserver|jdbc):\/\/[^/\s:]+:[^@\s]+@/i)
  assert.doesNotMatch(readmeText, /[?&](access[_-]?token|api[_-]?key|auth|authorization|credential|jwt|password|secret|session[_-]?id|sign|signature|token)=([^&#\s]+)/i)

  for (const samplePath of [
    ...Object.values(packet.webapiReadList.samples),
    ...Object.values(packet.relationshipMapping.samples),
  ]) {
    const sampleText = await readFile(path.join(dir, samplePath), 'utf8')
    assert.doesNotMatch(sampleText, /Bearer\s+[A-Za-z0-9._-]{16,}/i)
    assert.doesNotMatch(sampleText, /[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/)
    assert.doesNotMatch(sampleText, /\b(postgres|postgresql|mysql|mssql|sqlserver|jdbc):\/\/[^/\s:]+:[^@\s]+@/i)
    assert.doesNotMatch(sampleText, /[?&](access[_-]?token|api[_-]?key|auth|authorization|credential|jwt|password|secret|session[_-]?id|sign|signature|token)=([^&#\s]+)/i)
  }

  const outDir = path.join(dir, 'out')
  const checkResult = runCli(['--input', packetPath, '--out-dir', outDir])
  assert.equal(checkResult.status, 2, checkResult.stderr)
  assert.match(checkResult.stdout, /"decision": "GATE_BLOCKED"/)

  const evidence = JSON.parse(await readFile(path.join(outDir, 'integration-k3wise-gate-contract-check.json'), 'utf8'))
  assert.equal(evidence.decision, 'GATE_BLOCKED')
  assert.equal(evidence.sections.webapiReadList.answered, 0)
  assert.equal(evidence.sections.relationshipMapping.answered, 0)
  assert.equal(evidence.sections.webapiReadList.samples.filter((sample) => sample.status === 'present').length, 4)
  assert.equal(evidence.sections.relationshipMapping.samples.filter((sample) => sample.status === 'present').length, 4)
})

test('direct-run guard accepts Windows script paths', () => {
  const modulePath = 'C:\\metasheet\\scripts\\ops\\integration-k3wise-gate-contract-check.mjs'

  assert.equal(isDirectCliRun(modulePath, modulePath, 'win32'), true)
  assert.equal(
    isDirectCliRun(modulePath, 'C:/metasheet/scripts/ops/integration-k3wise-gate-contract-check.mjs', 'win32'),
    true,
  )
  assert.equal(
    isDirectCliRun(modulePath, 'c:\\METASHEET\\scripts\\ops\\integration-k3wise-gate-contract-check.mjs', 'win32'),
    true,
  )
  assert.equal(isDirectCliRun(modulePath, 'C:\\metasheet\\scripts\\ops\\other-checker.mjs', 'win32'), false)
  assert.equal(
    isDirectCliRun(
      '/repo/scripts/ops/integration-k3wise-gate-contract-check.mjs',
      '/repo/scripts/ops/integration-k3wise-gate-contract-check.mjs',
      'linux',
    ),
    true,
  )
})

test('direct-run guard accepts equivalent real paths through symlinks', async () => {
  const dir = await makeDir()
  const realDir = path.join(dir, 'real')
  const linkDir = path.join(dir, 'link')
  await mkdir(realDir)
  await symlink(realDir, linkDir, 'dir')

  const realScript = path.join(realDir, 'integration-k3wise-gate-contract-check.mjs')
  const linkScript = path.join(linkDir, 'integration-k3wise-gate-contract-check.mjs')
  await writeFile(realScript, '')

  assert.equal(isDirectCliRun(realScript, linkScript), true)
})
