import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildPacket,
  sampleGate,
} from './integration-k3wise-live-poc-preflight.mjs'
import {
  LivePocEvidenceError,
  buildEvidenceReport,
  renderMarkdown,
  runCli,
  sampleEvidence,
} from './integration-k3wise-live-poc-evidence.mjs'

function packet(overrides = {}) {
  return buildPacket({
    ...sampleGate(),
    ...overrides,
  }, { generatedAt: '2026-04-25T00:00:00.000Z' })
}

test('buildEvidenceReport returns PASS for complete Save-only evidence', () => {
  const report = buildEvidenceReport(packet(), sampleEvidence(), { generatedAt: '2026-04-25T11:00:00.000Z' })
  assert.equal(report.decision, 'PASS')
  assert.equal(report.issues.length, 0)
  assert.equal(report.scope.bomRequired, true)
  assert.equal(report.phases.find((phase) => phase.id === 'bomPoC').status, 'pass')
  assert.match(renderMarkdown(report), /Decision: PASS/)
})

test('buildEvidenceReport returns PARTIAL when a required phase is missing', () => {
  const evidence = sampleEvidence()
  delete evidence.customerConfirmation
  const report = buildEvidenceReport(packet(), evidence)
  assert.equal(report.decision, 'PARTIAL')
  assert.equal(report.phases.find((phase) => phase.id === 'customerConfirmation').status, 'todo')
})

test('buildEvidenceReport returns FAIL when Save-only row count exceeds PoC limit', () => {
  const evidence = sampleEvidence()
  evidence.materialSaveOnly.rowsWritten = 4
  const report = buildEvidenceReport(packet(), evidence)
  assert.equal(report.decision, 'FAIL')
  assert.equal(report.issues.some((issue) => issue.code === 'SAVE_ONLY_ROW_COUNT'), true)
})

test('buildEvidenceReport returns FAIL when autoAudit appears in Save-only evidence', () => {
  const evidence = sampleEvidence()
  evidence.materialSaveOnly.autoAudit = true
  const report = buildEvidenceReport(packet(), evidence)
  assert.equal(report.decision, 'FAIL')
  assert.equal(report.issues.some((issue) => issue.code === 'SAVE_ONLY_VIOLATED'), true)
})

test('buildEvidenceReport rejects unredacted secret-like evidence fields', () => {
  const evidence = sampleEvidence()
  evidence.connections.k3Wise.sessionToken = 'live-session-token'
  assert.throws(
    () => buildEvidenceReport(packet(), evidence),
    (error) => error instanceof LivePocEvidenceError && error.details.secretLeaks.includes('evidence.connections.k3Wise.sessionToken'),
  )
})

// ----- migration of bool-coercion sweep from preflight (#1168 / #1169) -----

test('buildEvidenceReport returns FAIL when materialSaveOnly autoSubmit is the string "true"', () => {
  const evidence = sampleEvidence()
  evidence.materialSaveOnly.autoSubmit = 'true'
  const report = buildEvidenceReport(packet(), evidence)
  assert.equal(report.decision, 'FAIL')
  assert.equal(report.issues.some((issue) => issue.code === 'SAVE_ONLY_VIOLATED'), true)
})

test('buildEvidenceReport returns FAIL when materialSaveOnly autoAudit is "yes" / "是" / "on" / "Y"', () => {
  for (const variant of ['yes', '是', 'on', 'Y']) {
    const evidence = sampleEvidence()
    evidence.materialSaveOnly.autoAudit = variant
    const report = buildEvidenceReport(packet(), evidence)
    assert.equal(report.decision, 'FAIL', `variant ${JSON.stringify(variant)} should fail`)
    assert.equal(
      report.issues.some((issue) => issue.code === 'SAVE_ONLY_VIOLATED'),
      true,
      `variant ${JSON.stringify(variant)} should raise SAVE_ONLY_VIOLATED`,
    )
  }
})

test('buildEvidenceReport returns FAIL when bom.legacyPipelineOptionsSourceProductId is the string "true"', () => {
  const evidence = sampleEvidence()
  evidence.bomPoC.legacyPipelineOptionsSourceProductId = 'true'
  const report = buildEvidenceReport(packet(), evidence)
  assert.equal(report.decision, 'FAIL')
  assert.equal(report.issues.some((issue) => issue.code === 'LEGACY_BOM_PRODUCT_ID_USED'), true)
})

test('buildEvidenceReport returns FAIL when materialSaveOnly autoSubmit is the number 1 (spreadsheet boolean)', () => {
  const evidence = sampleEvidence()
  evidence.materialSaveOnly.autoSubmit = 1
  const report = buildEvidenceReport(packet(), evidence)
  assert.equal(report.decision, 'FAIL')
  assert.equal(report.issues.some((issue) => issue.code === 'SAVE_ONLY_VIOLATED'), true)
})

test('buildEvidenceReport accepts the number 0 / string "no" / "否" / "false" as legitimate Save-only confirmation', () => {
  for (const falseLike of [0, 'no', '否', 'false', 'off']) {
    const evidence = sampleEvidence()
    evidence.materialSaveOnly.autoSubmit = falseLike
    evidence.materialSaveOnly.autoAudit = falseLike
    const report = buildEvidenceReport(packet(), evidence)
    assert.equal(
      report.issues.some((issue) => issue.code === 'SAVE_ONLY_VIOLATED'),
      false,
      `false-like ${JSON.stringify(falseLike)} should NOT raise SAVE_ONLY_VIOLATED`,
    )
  }
})

test('buildEvidenceReport throws clear errors for non-coercible boolean values', () => {
  const evidence = sampleEvidence()
  evidence.materialSaveOnly.autoSubmit = 'maybe'
  assert.throws(
    () => buildEvidenceReport(packet(), evidence),
    (error) => error instanceof LivePocEvidenceError && error.details.field === 'materialSaveOnly.autoSubmit',
    'unknown string boolean should throw with field name',
  )

  const evidence2 = sampleEvidence()
  evidence2.materialSaveOnly.autoAudit = 2
  assert.throws(
    () => buildEvidenceReport(packet(), evidence2),
    (error) => error instanceof LivePocEvidenceError && /0 or 1/.test(error.message),
    'non-0/1 number should throw with "0 or 1" message',
  )

  const evidence3 = sampleEvidence()
  evidence3.materialSaveOnly.autoSubmit = NaN
  assert.throws(
    () => buildEvidenceReport(packet(), evidence3),
    (error) => error instanceof LivePocEvidenceError && /finite/.test(error.message),
    'NaN should throw with "finite" message',
  )
})

// ----- numeric ID coercion (deferred from #1175 design doc, picked up here) -----

test('buildEvidenceReport accepts numeric runId / productId from spreadsheet exports', () => {
  const evidence = sampleEvidence()
  evidence.materialSaveOnly.runId = 1234567890
  evidence.bomPoC.productId = 99887766
  const report = buildEvidenceReport(packet(), evidence)
  assert.equal(report.decision, 'PASS')
  assert.equal(
    report.issues.some((issue) => issue.code === 'SAVE_ONLY_RUN_ID_REQUIRED'),
    false,
    'numeric runId should not raise SAVE_ONLY_RUN_ID_REQUIRED',
  )
  assert.equal(
    report.issues.some((issue) => issue.code === 'BOM_PRODUCT_SCOPE_REQUIRED'),
    false,
    'numeric productId should not raise BOM_PRODUCT_SCOPE_REQUIRED',
  )
})

test('buildEvidenceReport accepts bigint productId for very large external IDs', () => {
  const evidence = sampleEvidence()
  evidence.bomPoC.productId = 9007199254740993n
  const report = buildEvidenceReport(packet(), evidence)
  assert.equal(
    report.issues.some((issue) => issue.code === 'BOM_PRODUCT_SCOPE_REQUIRED'),
    false,
    'bigint productId should not raise BOM_PRODUCT_SCOPE_REQUIRED',
  )
})

test('buildEvidenceReport still rejects NaN / Infinity / object / array / null as missing IDs', () => {
  for (const bogus of [NaN, Infinity, -Infinity, {}, [], null, undefined, true, false]) {
    const evidence = sampleEvidence()
    evidence.bomPoC.productId = bogus
    const report = buildEvidenceReport(packet(), evidence)
    assert.equal(
      report.issues.some((issue) => issue.code === 'BOM_PRODUCT_SCOPE_REQUIRED'),
      true,
      `bogus productId ${JSON.stringify(bogus) ?? String(bogus)} should still raise BOM_PRODUCT_SCOPE_REQUIRED`,
    )
  }
})

test('buildEvidenceReport accepts numeric runId for materialSaveOnly evidence', () => {
  const evidence = sampleEvidence()
  evidence.materialSaveOnly.runId = 0
  const report = buildEvidenceReport(packet(), evidence)
  assert.equal(
    report.issues.some((issue) => issue.code === 'SAVE_ONLY_RUN_ID_REQUIRED'),
    false,
    'runId of 0 (legitimate edge case) should not raise SAVE_ONLY_RUN_ID_REQUIRED',
  )
})

// ----- normalizeStatus synonym map (deferred from #1175 / #1176, picked up here) -----

test('normalizeStatus accepts English pass-synonyms ("passed", "complete", "done", "ok", "success", "succeeded")', () => {
  for (const variant of ['passed', 'complete', 'completed', 'done', 'ok', 'success', 'successful', 'succeeded']) {
    const evidence = sampleEvidence()
    evidence.materialDryRun.status = variant
    const report = buildEvidenceReport(packet(), evidence)
    const phase = report.phases.find((p) => p.id === 'materialDryRun')
    assert.equal(phase.status, 'pass', `variant ${JSON.stringify(variant)} should normalize to 'pass'`)
  }
})

test('normalizeStatus accepts Chinese pass-synonyms ("通过", "成功", "完成", "已完成", "已通过", "完毕")', () => {
  for (const variant of ['通过', '成功', '完成', '已完成', '已通过', '完毕']) {
    const evidence = sampleEvidence()
    evidence.materialDryRun.status = variant
    const report = buildEvidenceReport(packet(), evidence)
    const phase = report.phases.find((p) => p.id === 'materialDryRun')
    assert.equal(phase.status, 'pass', `variant ${JSON.stringify(variant)} should normalize to 'pass'`)
  }
})

test('normalizeStatus accepts fail synonyms (English + Chinese)', () => {
  for (const variant of ['failed', 'error', 'errored', 'failure', '失败', '错误', '出错']) {
    const evidence = sampleEvidence()
    evidence.materialDryRun.status = variant
    const report = buildEvidenceReport(packet(), evidence)
    const phase = report.phases.find((p) => p.id === 'materialDryRun')
    assert.equal(phase.status, 'fail', `variant ${JSON.stringify(variant)} should normalize to 'fail'`)
  }
})

test('normalizeStatus accepts partial / blocked / skipped / todo synonyms', () => {
  const cases = [
    { variant: 'partially', expected: 'partial' },
    { variant: 'in-progress', expected: 'partial' },
    { variant: '进行中', expected: 'partial' },
    { variant: '部分', expected: 'partial' },
    { variant: 'on-hold', expected: 'blocked' },
    { variant: 'waiting', expected: 'blocked' },
    { variant: '阻塞', expected: 'blocked' },
    { variant: 'skip', expected: 'skipped' },
    { variant: 'n/a', expected: 'skipped' },
    { variant: '跳过', expected: 'skipped' },
    { variant: 'pending', expected: 'todo' },
    { variant: '待办', expected: 'todo' },
  ]
  for (const { variant, expected } of cases) {
    const evidence = sampleEvidence()
    evidence.materialDryRun.status = variant
    const report = buildEvidenceReport(packet(), evidence)
    const phase = report.phases.find((p) => p.id === 'materialDryRun')
    assert.equal(phase.status, expected, `variant ${JSON.stringify(variant)} should normalize to '${expected}'`)
  }
})

test('normalizeStatus is case-insensitive ("PASSED" / "Failed" / "DONE")', () => {
  const cases = [
    { variant: 'PASSED', expected: 'pass' },
    { variant: 'Failed', expected: 'fail' },
    { variant: 'DONE', expected: 'pass' },
    { variant: 'Pending', expected: 'todo' },
  ]
  for (const { variant, expected } of cases) {
    const evidence = sampleEvidence()
    evidence.materialDryRun.status = variant
    const report = buildEvidenceReport(packet(), evidence)
    const phase = report.phases.find((p) => p.id === 'materialDryRun')
    assert.equal(phase.status, expected, `variant ${JSON.stringify(variant)} should normalize to '${expected}'`)
  }
})

test('normalizeStatus still defaults unknown strings to "todo" (no over-acceptance)', () => {
  for (const unknown of ['maybe', 'wat', 'xxxxx', 'random-junk', '不确定', 'unknown']) {
    const evidence = sampleEvidence()
    evidence.materialDryRun.status = unknown
    const report = buildEvidenceReport(packet(), evidence)
    const phase = report.phases.find((p) => p.id === 'materialDryRun')
    assert.equal(phase.status, 'todo', `unknown variant ${JSON.stringify(unknown)} should default to 'todo'`)
  }
})

test('normalizeStatus synonym for fail in materialSaveOnly correctly skips Save-only safety checks', () => {
  // When status is "失败" (a fail synonym), evaluateMaterialSaveOnly must
  // recognize this as a fail and SKIP the autoSubmit/autoAudit safety
  // checks (since they only matter for runs that actually wrote data).
  const evidence = sampleEvidence()
  evidence.materialSaveOnly.status = '失败'
  evidence.materialSaveOnly.autoSubmit = true  // would normally raise SAVE_ONLY_VIOLATED
  const report = buildEvidenceReport(packet(), evidence)
  // Phase status reflects the synonym mapping; the run failed, so save-only
  // checks are bypassed (matching existing logic that returns early on non-pass).
  const phase = report.phases.find((p) => p.id === 'materialSaveOnly')
  assert.equal(phase.status, 'fail')
  assert.equal(
    report.issues.some((issue) => issue.code === 'SAVE_ONLY_VIOLATED'),
    false,
    'SAVE_ONLY_VIOLATED should not be raised when the save-only run itself failed',
  )
})

test('CLI writes redacted JSON and Markdown reports', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'integration-live-evidence-'))
  try {
    const packetPath = path.join(dir, 'packet.json')
    const evidencePath = path.join(dir, 'evidence.json')
    await writeFile(packetPath, `${JSON.stringify(packet(), null, 2)}\n`)
    await writeFile(evidencePath, `${JSON.stringify(sampleEvidence(), null, 2)}\n`)
    await runCli(['--packet', packetPath, '--evidence', evidencePath, '--out-dir', dir])
    const json = await readFile(path.join(dir, 'integration-k3wise-live-poc-evidence-report.json'), 'utf8')
    const md = await readFile(path.join(dir, 'integration-k3wise-live-poc-evidence-report.md'), 'utf8')
    assert.match(json, /"decision": "PASS"/)
    assert.match(md, /Decision: PASS/)
    assert.equal(json.includes('password'), false)
    assert.equal(md.includes('sessionToken'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
