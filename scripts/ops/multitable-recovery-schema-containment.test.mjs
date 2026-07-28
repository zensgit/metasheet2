#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  assessSchemaSnapshot,
  expectedSchemaSnapshot,
  renderAssessment,
  runSchemaContainment,
} from './multitable-recovery-schema-containment.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')

function expectedCopy() {
  return structuredClone(expectedSchemaSnapshot())
}

test('expected schema posture is exact: 9 disabled triggers, 6 functions, and one NO ACTION FK', () => {
  const expected = expectedCopy()
  assert.equal(expected.authorityTriggers.length, 9)
  assert.equal(expected.authorityFunctions.length, 6)
  assert.equal(expected.metaLinksForeignKey.length, 1)
  assert.ok(
    expected.authorityTriggers.every((trigger) => trigger.enabled === 'D'),
  )
  assert.equal(expected.metaLinksForeignKey[0].deleteAction, 'a')
  assert.equal(expected.metaLinksForeignKey[0].deferrable, true)
  assert.equal(expected.metaLinksForeignKey[0].validated, false)

  const assessment = assessSchemaSnapshot(expected)
  assert.equal(assessment.ok, true)
  assert.match(renderAssessment(assessment), /^VERDICT: PASS -/m)
})

test('missing or unexpectedly enabled authority triggers fail closed', () => {
  const missing = expectedCopy()
  missing.authorityTriggers.pop()
  assert.equal(assessSchemaSnapshot(missing).ok, false)

  const enabled = expectedCopy()
  enabled.authorityTriggers[0].enabled = 'O'
  const enabledAssessment = assessSchemaSnapshot(enabled)
  assert.equal(enabledAssessment.ok, false)
  assert.match(
    renderAssessment(enabledAssessment),
    /recovery-authority-triggers: FAIL/,
  )
})

test('authority function-body drift changes the fingerprint and fails closed', () => {
  const drifted = expectedCopy()
  drifted.authorityFunctions[0].body = 'BEGIN RETURN; END;'
  const assessment = assessSchemaSnapshot(drifted)
  assert.equal(assessment.ok, false)
  assert.match(
    renderAssessment(assessment),
    /recovery-authority-functions: FAIL/,
  )
})

test('same-name meta_links FK with the wrong column or delete action fails closed', () => {
  const wrongColumn = expectedCopy()
  wrongColumn.metaLinksForeignKey[0].sourceColumns = ['record_id']
  assert.equal(assessSchemaSnapshot(wrongColumn).ok, false)

  const wrongDeleteAction = expectedCopy()
  wrongDeleteAction.metaLinksForeignKey[0].deleteAction = 'c'
  const assessment = assessSchemaSnapshot(wrongDeleteAction)
  assert.equal(assessment.ok, false)
  assert.match(renderAssessment(assessment), /meta-links-live-target-fk: FAIL/)
})

test('missing DATABASE_URL is non-PASS without exposing unrelated environment values', async () => {
  const result = await runSchemaContainment({
    env: {
      SECRET_TOKEN: 'do-not-print',
    },
  })
  assert.notEqual(result.exitCode, 0)
  assert.match(result.output, /^VERDICT: FAIL -/)
  assert.doesNotMatch(result.output, /do-not-print|SECRET_TOKEN/)
  assert.doesNotMatch(result.output, /VERDICT: PASS/)
})

test('database or catalog-permission failure is generic and never echoes URL/error data', async () => {
  const databaseUrl =
    'postgresql://sensitive-user:sensitive-pass@example.invalid/private-db'
  const result = await runSchemaContainment({
    env: { DATABASE_URL: databaseUrl },
    querySnapshot: async () => {
      throw new Error(`permission denied for secret_row via ${databaseUrl}`)
    },
  })
  assert.notEqual(result.exitCode, 0)
  assert.match(result.output, /^VERDICT: FAIL -/)
  assert.doesNotMatch(
    result.output,
    /sensitive-user|sensitive-pass|example\.invalid|private-db|secret_row|postgresql:\/\//,
  )
  assert.doesNotMatch(result.output, /VERDICT: PASS/)
})

test('workflow requires the schema helper for every expected backend container and rejects missing PASS', () => {
  const workflow = readFileSync(
    join(
      repoRoot,
      '.github/workflows/multitable-recovery-flag-containment-check.yml',
    ),
    'utf8',
  )
  const loopStart = workflow.indexOf('for name in $EXPECTED_CONTAINERS; do')
  const loopEnd = workflow.indexOf('echo "== summary =="', loopStart)
  assert.ok(
    loopStart >= 0 && loopEnd > loopStart,
    'expected-container loop must exist',
  )
  const loop = workflow.slice(loopStart, loopEnd)

  assert.match(
    loop,
    /docker exec "\$name" node scripts\/ops\/multitable-recovery-schema-containment\.mjs/,
  )
  const helperSource = readFileSync(
    join(repoRoot, 'scripts/ops/multitable-recovery-schema-containment.mjs'),
  )
  const helperHash = createHash('sha256').update(helperSource).digest('hex')
  assert.match(
    workflow,
    new RegExp(`SCHEMA_HELPER_SHA256="${helperHash}"`),
    'workflow must pin the reviewed helper instead of trusting arbitrary code in the target image',
  )
  assert.match(loop, /helper_sha.*sha256sum/)
  assert.match(loop, /helper_sha.*SCHEMA_HELPER_SHA256/)
  assert.match(loop, /SCHEMA_PASS_LINE/)
  assert.match(loop, /schema containment helper failed/)
  assert.match(
    loop,
    /schema containment helper did not emit its exact PASS sentinel/,
  )
  const executableLoop = loop
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
  assert.doesNotMatch(executableLoop, /DATABASE_URL/)
})
