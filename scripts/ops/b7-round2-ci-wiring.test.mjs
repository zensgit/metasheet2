import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// B7 owner-round CI two-point wiring contract: the binding admin-routes suite and the Q6 post-sync
// hook suite are real-DB proofs (the hook one drives the REAL sync). Each needs BOTH the
// vitest.config.ts exclude (no skip-green) AND its plugin-tests.yml real-DB whole-file step.
//
// Placement (within the shared "Run approval real-DB integration" step block that hosts both
// directory and approval real-DB suites):
//   - admin-routes  → directory real-DB placement (next to reconciliation / org-directory-*)
//   - sync-hook     → approval real-DB placement (next to approval-routing / direct-manager)
// The guard parses the named step block so a path that only appears in a comment or in another
// step (e.g. multitable) does not pass.
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const ADMIN_FILE = 'tests/integration/directory-binding-admin-routes.db.test.ts'
const SYNC_HOOK_FILE = 'tests/integration/directory-binding-sync-hook.db.test.ts'

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

function wholeFileRunRe(file) {
  return new RegExp(`\\n\\s*${file.replace(/[.]/g, '\\.')} \\\\`)
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
  // Clustering pin: admin routes sit AFTER reconciliation in the directory suite region
  // (not only "somewhere" in the shared step).
  assert.match(
    step,
    /directory-binding-reconciliation\.db\.test\.ts \\[\s\S]*directory-binding-admin-routes\.db\.test\.ts \\/,
    `${ADMIN_FILE} must be clustered after the directory reconciliation suite in the real-DB step`,
  )
  // Must not be parked only in the approval cluster (before reconciliation).
  assert.doesNotMatch(
    step,
    /directory-binding-admin-routes\.db\.test\.ts \\[\s\S]*directory-binding-reconciliation\.db\.test\.ts \\/,
    `${ADMIN_FILE} must not precede reconciliation (wrong cluster)`,
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
  // Clustering pin: Q6 sync-hook sits in the approval region — AFTER equivalence and BEFORE
  // the directory reconciliation suite. Moving it into the directory cluster reds this order.
  assert.match(
    step,
    /approval-routing-policy-equivalence\.db\.test\.ts \\[\s\S]*directory-binding-sync-hook\.db\.test\.ts \\[\s\S]*directory-binding-reconciliation\.db\.test\.ts \\/,
    `${SYNC_HOOK_FILE} must sit between approval equivalence and directory reconciliation in the real-DB step`,
  )
  const multi = namedStepBody(wf, 'Run multitable real-DB integration')
  assert.doesNotMatch(multi, wholeFileRunRe(SYNC_HOOK_FILE), `${SYNC_HOOK_FILE} must not be in multitable real-DB`)
})
