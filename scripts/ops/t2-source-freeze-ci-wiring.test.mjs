import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// T2 CI two-point wiring contract. The source-freeze suite proves an ACTIVE org transfer freezes
// its source integration's sync (typed 409 before the lease claim, zero run rows, the destructive
// absence sweep provably blocked — with the freeze_source_sync=false override as the positive
// control) against the REAL syncDirectoryIntegration + real Postgres — meaningless without a DB.
// It needs BOTH (1) the vitest.config.ts exclude entry (so the no-DB job cannot skip-green it)
// AND (2) the plugin-tests.yml approval real-DB whole-file step. Removing either point silently
// disables the §12.2 freeze proof while CI stays green. Runs in the gating no-DB test job.
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const FILE = 'tests/integration/directory-org-transfer-source-freeze.db.test.ts'

// In plugin-tests.yml, the real-DB suites share the single named step
// "Run approval real-DB integration (...)". The guard anchors to that named step block — a path that appears only in
// a comment, the multitable step, or elsewhere must NOT pass (a suite moved out of the real-DB
// step never runs against a DB).
const APPROVAL_REAL_DB_STEP = 'Run approval real-DB integration'

/**
 * Body of the first workflow step whose name contains `nameNeedle`, from the line after
 * `- name:` through (not including) the next same-indent `- name:`.
 */
function namedStepBody(wf, nameNeedle) {
  const lines = wf.split('\n')
  let start = -1
  let indent = ''
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)- name:\s*(.*)$/)
    if (m && m[2].includes(nameNeedle)) {
      start = i
      indent = m[1]
      break
    }
  }
  assert.ok(start >= 0, `workflow step whose name includes ${JSON.stringify(nameNeedle)} not found`)
  const body = []
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)- name:\s*/)
    if (m && m[1] === indent) break
    body.push(lines[i])
  }
  return body.join('\n')
}

/** Whole-file vitest arg line: newline + indent + path + trailing ` \`. */
function wholeFileRunRe(file) {
  return new RegExp(`\\n\\s*${file.replace(/[.]/g, '\\.')} \\\\`)
}

test('vitest.config.ts excludes the T2 source-freeze suite from the no-DB job', () => {
  const cfg = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
  assert.ok(cfg.includes(`'${FILE}'`), `vitest.config.ts must exclude ${FILE} (DATABASE_URL-gated whole file)`)
})

test('plugin-tests.yml runs the T2 source-freeze suite as a whole file in a real-DB step', () => {
  const wf = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  const step = namedStepBody(wf, APPROVAL_REAL_DB_STEP)
  assert.match(
    step,
    wholeFileRunRe(FILE),
    `plugin-tests.yml real-DB step (${APPROVAL_REAL_DB_STEP}) must run ${FILE} as a whole file`,
  )
  // Negative: must not be the sole (or any) placement under multitable real-DB.
  const multi = namedStepBody(wf, 'Run multitable real-DB integration')
  assert.doesNotMatch(
    multi,
    wholeFileRunRe(FILE),
    `${FILE} must not be wired into the multitable real-DB step`,
  )
})

test('the T2 source-freeze suite file exists on disk', () => {
  // Third point: both wiring texts can stay intact while the suite is renamed/deleted — vitest
  // exits 0 on an unmatched path argument, so CI stays green and the proof never runs.
  assert.ok(
    existsSync(join(repoRoot, 'packages/core-backend', FILE)),
    `wired suite packages/core-backend/${FILE} must exist on disk`,
  )
})
