import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// P4 Option C needs both points: exclusion from the no-DB default job, and a whole-file invocation
// in the required real-DB job. Losing either point would turn the repair proof into a silent skip.
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const FILE = 'tests/integration/stock-preparation-p4-repair-once-realdb.test.ts'

// In plugin-tests.yml this suite runs inside the single named step
// "Run multitable real-DB integration (...)" — the only step that hands it a live Postgres. The
// guard anchors to that named step block, so a path that appears only in a comment, in the
// approval real-DB step, or anywhere else must NOT pass (a suite moved out of its real-DB step
// never runs against a DB).
const MULTITABLE_REAL_DB_STEP = 'Run multitable real-DB integration'

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

test('vitest.config.ts excludes the P4 repair suite from the no-DB job', () => {
  const config = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
  assert.ok(config.includes(`'${FILE}'`), `vitest.config.ts must exclude ${FILE}`)
})

test('plugin-tests.yml runs the P4 repair suite as a whole file in the multitable real-DB step (Run multitable real-DB integration)', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  const step = namedStepBody(workflow, MULTITABLE_REAL_DB_STEP)
  assert.match(
    step,
    wholeFileRunRe(FILE),
    `plugin-tests.yml multitable real-DB step (${MULTITABLE_REAL_DB_STEP}) must run ${FILE} as a whole file`,
  )
  // Negative: must not be the sole (or any) placement under the approval real-DB step.
  const approval = namedStepBody(workflow, 'Run approval real-DB integration')
  assert.doesNotMatch(
    approval,
    wholeFileRunRe(FILE),
    `${FILE} must not be wired into the approval real-DB step`,
  )
})

test('the P4 repair suite file exists on disk', () => {
  // Third point: both wiring texts can stay intact while the suite is renamed/deleted — vitest
  // exits 0 on an unmatched path argument, so CI stays green and the proof never runs.
  assert.ok(
    existsSync(join(repoRoot, 'packages/core-backend', FILE)),
    `wired suite packages/core-backend/${FILE} must exist on disk`,
  )
})
