import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// PB4-4 CI two-point wiring contract. The reactivation suite is a real-DB concurrency test (2-way
// and 5-way callers converging on one id with exactly one reactivate audit) that is meaningless
// without a real DB: it needs BOTH (1) the vitest.config.ts exclude entry (so the no-DB job cannot
// skip-green it) AND (2) the plugin-tests.yml directory real-DB whole-file step (so a real-DB run
// actually names it). Removing either point makes the entire reactivation/concurrency suite silently
// never execute while exact-head CI stays green. This source-level guard (no DB) reddens if either
// point is dropped. It runs in the no-DB `test` job, so it gates every PR.
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const FILE = 'tests/integration/directory-local-integration-reactivation.db.test.ts'

// In plugin-tests.yml, directory real-DB suites share the single named step
// "Run approval real-DB integration (...)" with the approval suites. The guard anchors to that
// named step block — a path that appears only in a comment, the multitable step, or elsewhere
// must NOT pass (a suite moved out of the real-DB step never runs against a DB).
const DIRECTORY_REAL_DB_STEP = 'Run approval real-DB integration'

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


test('vitest.config.ts excludes the PB4-4 reactivation suite from the no-DB job', () => {
  const cfg = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
  assert.ok(cfg.includes(`'${FILE}'`), `vitest.config.ts must exclude ${FILE} (DATABASE_URL-gated whole file)`)
})

test('plugin-tests.yml runs the PB4-4 reactivation suite as a whole file in the directory real-DB step (Run approval real-DB integration)', () => {
  const wf = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  const step = namedStepBody(wf, DIRECTORY_REAL_DB_STEP)
  assert.match(
    step,
    wholeFileRunRe(FILE),
    `plugin-tests.yml directory real-DB step (${DIRECTORY_REAL_DB_STEP}) must run ${FILE} as a whole file`,
  )
  // Negative: must not be the sole (or any) placement under multitable real-DB.
  const multi = namedStepBody(wf, 'Run multitable real-DB integration')
  assert.doesNotMatch(
    multi,
    wholeFileRunRe(FILE),
    `${FILE} must not be wired into the multitable real-DB step`,
  )
})

test('the PB4-4 reactivation suite file exists on disk', () => {
  // Third point: both wiring texts can stay intact while the suite is renamed/deleted — vitest
  // exits 0 on an unmatched path argument, so CI stays green and the proof never runs.
  assert.ok(
    existsSync(join(repoRoot, 'packages/core-backend', FILE)),
    `wired suite packages/core-backend/${FILE} must exist on disk`,
  )
})
