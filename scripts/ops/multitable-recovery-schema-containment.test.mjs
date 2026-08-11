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

test('expected schema posture is exact: 9 disabled triggers, 6 functions, zero foreign_record_id FKs', () => {
  const expected = expectedCopy()
  assert.equal(expected.authorityTriggers.length, 9)
  assert.equal(expected.authorityFunctions.length, 6)
  assert.equal(expected.metaLinksForeignRecordFks.length, 0)
  assert.ok(
    expected.authorityTriggers.every((trigger) => trigger.enabled === 'D'),
  )

  const assessment = assessSchemaSnapshot(expected)
  assert.equal(assessment.ok, true)
  assert.match(renderAssessment(assessment), /^VERDICT: PASS -/m)
})

test('any FK covering meta_links.foreign_record_id fails closed — NO ACTION and CASCADE both red', async () => {
  // Mutation shape mirrors what queryRecoverySchemaSnapshot returns for
  //   ALTER TABLE meta_links ADD CONSTRAINT <name>
  //     FOREIGN KEY (foreign_record_id) REFERENCES meta_records(id)
  //     ON DELETE NO ACTION NOT VALID          -> confdeltype 'a'
  // and the same with ON DELETE CASCADE       -> confdeltype 'c'.
  // The invariant is column-scoped and absolute: BOTH actions must turn the check red.
  const seededFks = [
    { constraint_name: 'meta_links_frid_noaction_fkey', on_delete_action: 'a' },
    { constraint_name: 'meta_links_frid_cascade_fkey', on_delete_action: 'c' },
  ]
  for (const seededFk of seededFks) {
    const snapshot = expectedCopy()
    snapshot.metaLinksForeignRecordFks = [seededFk]

    const assessment = assessSchemaSnapshot(snapshot)
    assert.equal(assessment.ok, false)
    const rendered = renderAssessment(assessment)
    assert.match(rendered, /meta-links-foreign-record-id-fk-absence: FAIL/)
    assert.ok(
      rendered.includes(`constraint="${seededFk.constraint_name}"`),
      'failure diagnostics must name the offending constraint',
    )
    assert.ok(
      rendered.includes(`on_delete_action='${seededFk.on_delete_action}'`),
      'failure diagnostics must show the ON DELETE action letter',
    )
    assert.match(rendered, /^VERDICT: FAIL -/m)
    assert.doesNotMatch(rendered, /VERDICT: PASS/)

    const result = await runSchemaContainment({
      env: { DATABASE_URL: 'postgresql://placeholder.invalid/scratch' },
      querySnapshot: async () => snapshot,
    })
    assert.equal(result.exitCode, 1)
    assert.doesNotMatch(result.output, /VERDICT: PASS/)
  }
})

test('with the FK removed the helper returns PASS with the exact workflow sentinel line', async () => {
  const snapshot = expectedCopy()
  snapshot.metaLinksForeignRecordFks = []
  const result = await runSchemaContainment({
    env: { DATABASE_URL: 'postgresql://placeholder.invalid/scratch' },
    querySnapshot: async () => snapshot,
  })
  assert.equal(result.exitCode, 0)
  assert.match(result.output, /meta-links-foreign-record-id-fk-absence: PASS count=0\/0/)

  // The workflow greps its SCHEMA_PASS_LINE with `grep -qxF` (exact full line). Keep the helper's
  // PASS sentinel and the workflow constant in lockstep, or leg 2 fails at runtime despite exit 0.
  const workflow = readFileSync(
    join(
      repoRoot,
      '.github/workflows/multitable-recovery-flag-containment-check.yml',
    ),
    'utf8',
  )
  const sentinel = workflow.match(/^\s*SCHEMA_PASS_LINE="(.+)"$/m)
  assert.ok(sentinel, 'workflow must define SCHEMA_PASS_LINE')
  assert.ok(
    result.output.split('\n').includes(sentinel[1]),
    'helper PASS output must contain the exact SCHEMA_PASS_LINE the workflow greps for',
  )
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
