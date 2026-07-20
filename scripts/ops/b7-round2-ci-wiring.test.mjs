import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// B7 owner-round CI two-point wiring contract: the binding admin-routes suite and the Q6 post-sync
// hook suite are real-DB proofs (the hook one drives the REAL sync). Each needs BOTH the
// vitest.config.ts exclude (no skip-green) AND its plugin-tests.yml real-DB whole-file step.
//
// Placement (within the shared "Run approval real-DB integration" step block that hosts both
// directory and approval real-DB suites):
//   - admin-routes  → immediately after directory-binding-reconciliation (directory cluster)
//   - sync-hook     → immediately after approval-routing-policy-equivalence (approval cluster)
// Guards parse the named step's whole-file vitest argument list and assert EXACT adjacency by
// index — not merely "somewhere later" via [\s\S]* ordering. A path only in a comment, in the
// multitable step, or non-adjacent within the same named step does not pass.
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const ADMIN_FILE = 'tests/integration/directory-binding-admin-routes.db.test.ts'
const SYNC_HOOK_FILE = 'tests/integration/directory-binding-sync-hook.db.test.ts'
const EQUIVALENCE_FILE = 'tests/integration/approval-routing-policy-equivalence.db.test.ts'
const RECONCILIATION_FILE = 'tests/integration/directory-binding-reconciliation.db.test.ts'

// Same named step hosts both families; anchors still fail if a suite is moved out of it.
const REAL_DB_STEP = 'Run approval real-DB integration'

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

/**
 * Ordered list of whole-file vitest arguments in a step body.
 * Matches lines like: `            tests/integration/foo.db.test.ts \`
 * (path + trailing backslash continuation; last file may omit the backslash).
 */
function wholeFileVitestArgs(stepBody) {
  const files = []
  for (const line of stepBody.split('\n')) {
    const m = line.match(/^\s+(tests\/integration\/\S+\.(?:test|spec)\.[tj]sx?)\s*(?:\\)?\s*$/)
    if (m) files.push(m[1])
  }
  return files
}

function wholeFileRunRe(file) {
  return new RegExp(`\\n\\s*${file.replace(/[.]/g, '\\.')} \\\\`)
}

function assertImmediatelyFollows(files, predecessor, successor, label) {
  const iPred = files.indexOf(predecessor)
  const iSucc = files.indexOf(successor)
  assert.ok(iPred >= 0, `${label}: predecessor ${predecessor} missing from step vitest arg list`)
  assert.ok(iSucc >= 0, `${label}: successor ${successor} missing from step vitest arg list`)
  assert.equal(
    iSucc,
    iPred + 1,
    `${label}: ${successor} must immediately follow ${predecessor} ` +
      `(indices pred=${iPred} succ=${iSucc}; found[${iPred}..${iPred + 1}]=` +
      `${JSON.stringify(files.slice(iPred, iPred + 2))})`,
  )
}

test('vitest.config.ts excludes both B7 round-2 suites from the no-DB job', () => {
  const cfg = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
  for (const f of [ADMIN_FILE, SYNC_HOOK_FILE]) {
    assert.ok(cfg.includes(`'${f}'`), `vitest.config.ts must exclude ${f}`)
  }
})

test('plugin-tests.yml runs the B7 admin-routes suite as a whole file in the directory real-DB step', () => {
  const wf = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  const step = namedStepBody(wf, REAL_DB_STEP)
  assert.match(
    step,
    wholeFileRunRe(ADMIN_FILE),
    `plugin-tests.yml directory real-DB step (${REAL_DB_STEP}) must run ${ADMIN_FILE} as a whole file`,
  )
  const files = wholeFileVitestArgs(step)
  assertImmediatelyFollows(
    files,
    RECONCILIATION_FILE,
    ADMIN_FILE,
    'directory cluster adjacency',
  )
  const multi = namedStepBody(wf, 'Run multitable real-DB integration')
  assert.doesNotMatch(multi, wholeFileRunRe(ADMIN_FILE), `${ADMIN_FILE} must not be in multitable real-DB`)
})

test('plugin-tests.yml runs the B7 sync-hook suite as a whole file in the approval real-DB step', () => {
  const wf = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  const step = namedStepBody(wf, REAL_DB_STEP)
  assert.match(
    step,
    wholeFileRunRe(SYNC_HOOK_FILE),
    `plugin-tests.yml approval real-DB step (${REAL_DB_STEP}) must run ${SYNC_HOOK_FILE} as a whole file`,
  )
  const files = wholeFileVitestArgs(step)
  assertImmediatelyFollows(
    files,
    EQUIVALENCE_FILE,
    SYNC_HOOK_FILE,
    'approval cluster adjacency',
  )
  const multi = namedStepBody(wf, 'Run multitable real-DB integration')
  assert.doesNotMatch(multi, wholeFileRunRe(SYNC_HOOK_FILE), `${SYNC_HOOK_FILE} must not be in multitable real-DB`)
})

test('both B7 round-2 suite files exist on disk', () => {
  // Third point: both wiring texts can stay intact while a suite is renamed/deleted — vitest
  // exits 0 on an unmatched path argument, so CI stays green and the proof never runs.
  for (const f of [ADMIN_FILE, SYNC_HOOK_FILE]) {
    assert.ok(
      existsSync(join(repoRoot, 'packages/core-backend', f)),
      `wired suite packages/core-backend/${f} must exist on disk`,
    )
  }
})
