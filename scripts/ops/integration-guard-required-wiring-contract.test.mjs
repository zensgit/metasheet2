import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { GUARDED_PATH_ENTRIES, isPrefixEntry, prefixOf } from './integration-guard-guarded-paths.mjs'
import { classify, matchesGuardedPath, parseNulDelimited, findMissingRosterEntries } from './integration-guard-classify.mjs'
import { assertBranch } from './integration-guard-assert-branch.mjs'

/**
 * Integration Guard required-wiring contract (governance slice, 2026-07-25 — standalone from
 * #4603/#4604/#4610 by owner instruction; HARDENED 2026-07-25 after a P1x2/P2 owner review of the
 * original wiring-only slice — see .github/workflows/integration-guard.yml's own header for the full
 * corrected narrative, including the RETRACTION of an earlier false claim about GitHub's skipped-job
 * semantics).
 *
 * THE PROBLEM THIS PINS, LAYERED.
 *
 * Layer 1 (the original wiring-only slice, still true): a required status check is matched by
 * check/job NAME. If the WORKFLOW never runs for a given PR (a trigger-level `paths:` filter didn't
 * match) or event (no `merge_group` trigger), the `integration-guard` context is never produced, and
 * that PR/merge-queue entry waits FOREVER on a required check that will never report. Fixed by
 * dropping `pull_request`'s trigger-level `paths:` filter and adding `merge_group:`.
 *
 * Layer 2 (P1, first review): even with Layer 1 fixed, a JOB that GitHub skips via a job-level `if:`
 * condition reports SUCCESS — a skipped job DOES satisfy a required context, same as a real green one.
 * `needs:` has the identical effect whenever it points at a job that is itself skipped (the skip
 * propagates transitively, still reporting SUCCESS) — distinct from `needs:` naming a job that does
 * not exist, which is a workflow VALIDATION ERROR rather than a skip; forbidding the key closes both.
 * So `jobs.integration-guard.if: false`, a `needs:` on a since-skipped job, or `continue-on-error:
 * true` on a real test step all leave the job green having run nothing (or ignored a real failure).
 * Fixed by contract-pinning the ABSENCE of `if`/`needs`/`continue-on-error` at the job level and the
 * ABSENCE of `continue-on-error` on every load-bearing step (classifier, both real branches, the noop,
 * and the terminal assertion).
 *
 * Layer 3 (P1, second review): the in-job scope classifier was not itself load-bearing. Renaming a
 * guarded-path roster entry to a path that no longer exists silently makes a real in-scope change
 * classify as out-of-scope (the no-op branch runs, green, having tested nothing relevant). Defaulting
 * the classification to an ambiguous `unknown` value makes BOTH the `=='true'` and `=='false'` gated
 * branches skip — the job is green having run NEITHER the real suite NOR the no-op. Fixed by:
 *   - extracting classification into scripts/ops/integration-guard-classify.mjs, an executable script
 *     (not inline bash) whose `classify()` only ever returns a JS `boolean` — there is no shell-string
 *     default that could drift to `'unknown'`;
 *   - a single-sourced roster (scripts/ops/integration-guard-guarded-paths.mjs) pinned here against
 *     both the workflow's `on.push.paths` AND the real filesystem (case-exact, see below);
 *   - a terminal `if: always()` step, backed by scripts/ops/integration-guard-assert-branch.mjs, that
 *     FAILS the job unless `relevant` came out strictly `'true'`/`'false'` AND exactly the
 *     corresponding branch's steps ran to completion.
 *
 * TWO INDEPENDENT DOORS AGAINST THE "AMBIGUOUS relevant" FAILURE MODE — proven separately, not
 * layered so one covers for the other's absence (per this repo's "多道fail-closed门互相掩护" doctrine):
 *   - Door A protects the classify.mjs SOURCE: its own behavioural tests below (`classify()` driven
 *     with a neither-diff) assert with `assert.strictEqual(..., false)` — a strict primitive-boolean
 *     comparison, not a truthiness check — so if classify.mjs's own fallback were ever changed to
 *     return anything other than the boolean `false` (including the string `'unknown'`), THIS test
 *     REDs, independent of whether the terminal step exists or is wired correctly at all.
 *   - Door B protects the RUNTIME WIRING, independent of classify.mjs's own correctness: the
 *     assertBranch() behavioural tests below feed `relevant: 'unknown'` (and `''`, and contradictory
 *     outcome combinations) DIRECTLY — they never call classify() or read the workflow YAML — so even
 *     a regression that has NOTHING to do with classify.mjs (e.g. the classifier step's shell wrapper
 *     reverted to inline bash with a bad default, bypassing the script entirely) is still caught at
 *     runtime by the terminal step, PROVIDED the terminal step itself stays wired — which is why the
 *     terminal step's existence, its `id`, its exact `if: always()`, and the absence of
 *     `continue-on-error` on it are ALSO separately YAML-shape-pinned below, not merely assumed.
 * The mutation ledger in the PR body demonstrates this: mutating scripts/ops/integration-guard-
 * guarded-paths.mjs (Door A's territory) REDs the roster/classify tests specifically, and mutating
 * scripts/ops/integration-guard-assert-branch.mjs's own validation (Door B's territory) REDs the
 * assertBranch tests specifically — neither mutation REDs the other door's tests, which is the
 * evidence the two doors are not one door wearing two hats.
 *
 * P2 (correction, kept mechanism): an earlier revision of the workflow's header justified the
 * explicit no-op step by claiming "a skipped job does not satisfy a required context the same way" a
 * real green step does. THAT CLAIM IS FALSE and has been RETRACTED (not reworded) in the workflow's
 * header — see Layer 2 above for GitHub's actual behaviour, which is the opposite: a job-level `if:`
 * skip DOES satisfy a required context, which is exactly why it is now a forbidden key on the job. The
 * no-op step itself is still kept, but on the correct rationale: it yields an AUDITABLE, IN-BAND log
 * line instead of an ambiguous skipped conclusion a reviewer would have to look up out-of-band.
 * Separately, `merge_group:` is required because GitHub's own documentation requires a workflow gating
 * a required check to add that event for the merge queue to ever trigger it — cited as the reason,
 * not inferred from the "pending forever" argument.
 *
 * BE HONEST ABOUT WHAT EACH LAYER CAN AND CANNOT PROVE.
 *   - The YAML-shape assertions (onBlock/requireJob/stepsOf-based) are source-text assertions: they
 *     cannot exercise whether GitHub actually fires `merge_group`, whether a job-level `if: false`
 *     really does report SUCCESS on the real platform, or whether `outcome` context values really are
 *     `success`/`skipped` at runtime as this file assumes — that is GitHub platform behaviour no repo
 *     checkout can exercise (see this repo's own doctrine: source-text assertions are not behaviour
 *     assertions).
 *   - The classify()/assertBranch() behavioural tests below DO exercise real code paths with real
 *     inputs and real `assert.strictEqual` assertions — that part of the contract is genuinely
 *     behavioural, not YAML-shape — but they still cannot exercise the GitHub Actions runtime itself
 *     (step `outcome` propagation, `if: always()` semantics, required-check evaluation). Both layers
 *     together are the strongest proof obtainable from a repo checkout; neither alone is a full proof.
 *   - It earns its keep only if it actually REDS under the mutations that would silently regress the
 *     wiring — see the PR body for this slice, each mutation pasted with real `node --test` output
 *     before landing.
 *
 * WHY THIS LIVES HERE, NOT A COPY OF THE INTEGRATION SUITE. The owner was explicit: do NOT copy the
 * integration suite into `test (20.x)` (two copies would drift apart) — only the wiring contract
 * belongs here. `test (20.x)` is the already-required job (plugin-tests.yml `test:`, matrix
 * node-version: [18.x, 20.x]) that this step runs inside, on BOTH matrix legs, before `pnpm install`
 * — the same house pattern as its ~15 `*-ci-wiring.test.mjs` siblings.
 *
 * WHY THE YAML BRIDGE IS DUPLICATED, NOT IMPORTED FROM scripts/ops/ci-realdb-step-contract.mjs.
 * That shared module is scoped to the plugin-tests.yml real-DB step contract used by its own sibling
 * guards; this is a standalone governance slice (explicitly kept isolated from the in-flight
 * #4603/#4604/#4610 fix PRs by owner instruction) and must not touch shared infra those guards
 * depend on. The reasoning for using python3 + PyYAML (not js-yaml) is identical to that module's:
 * this step runs in the required no-DB `test` job BEFORE `pnpm install`, so no npm package is
 * importable yet; the GitHub `ubuntu-latest` runner's system python3 ships PyYAML. The bridge is
 * fail-closed regardless: a missing interpreter, missing PyYAML, or a YAML parse error all throw —
 * a workflow PyYAML cannot parse is also a workflow GitHub will not run, so a parse failure is never
 * a green path.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const WORKFLOW_PATH = join(repoRoot, '.github/workflows/integration-guard.yml')

const JOB_ID = 'integration-guard'
const CLASSIFIER_STEP_ID = 'changes'
const NOOP_STEP_ID = 'noop'
const PLUGIN_STEP_ID = 'plugin-core-tests'
const WEB_STEP_ID = 'web-guard-specs'
const TERMINAL_STEP_ID = 'assert-branch'
const RELEVANT_TRUE_IF = "steps.changes.outputs.relevant == 'true'"
const RELEVANT_FALSE_IF = "steps.changes.outputs.relevant == 'false'"

// ---------------------------------------------------------------------------
// YAML parse bridge (python3 + PyYAML -> JSON), fail-closed. See header for why this is duplicated
// rather than imported.
// ---------------------------------------------------------------------------

const PY_YAML_TO_JSON = [
  'import json, sys',
  'try:',
  '    import yaml',
  'except Exception as exc:',
  "    sys.stderr.write('PYYAML_MISSING: %r' % (exc,))",
  '    sys.exit(3)',
  'try:',
  '    doc = yaml.safe_load(sys.stdin.read())',
  'except Exception as exc:',
  "    sys.stderr.write('YAML_PARSE_ERROR: %r' % (exc,))",
  '    sys.exit(4)',
  'def jsonable(node):',
  '    if isinstance(node, dict):',
  '        return {str(key): jsonable(value) for key, value in node.items()}',
  '    if isinstance(node, list):',
  '        return [jsonable(value) for value in node]',
  '    return node',
  'json.dump(jsonable(doc), sys.stdout, default=str)',
].join('\n')

/**
 * @param {string} wf
 * @returns {unknown}
 */
function parseYamlDocument(wf) {
  const res = spawnSync('python3', ['-c', PY_YAML_TO_JSON], {
    input: wf,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  })
  if (res.error) {
    throw new Error(
      `integration-guard required-wiring contract: failing CLOSED — python3 could not be spawned ` +
        `for the YAML parse (${res.error.message}).`,
    )
  }
  if (res.status !== 0) {
    throw new Error(
      `integration-guard required-wiring contract: failing CLOSED — the PyYAML bridge exited ` +
        `${res.status}: ${(res.stderr || '').trim() || '(no stderr)'}`,
    )
  }
  try {
    return JSON.parse(res.stdout)
  } catch (err) {
    throw new Error(
      `integration-guard required-wiring contract: failing CLOSED — the PyYAML bridge emitted ` +
        `unparseable JSON: ${err.message}`,
    )
  }
}

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const workflowText = readFileSync(WORKFLOW_PATH, 'utf8')
const doc = parseYamlDocument(workflowText)

/**
 * `on:` is a YAML 1.1 boolean keyword — PyYAML's SafeLoader resolves an unquoted `on` to the Python
 * bool `True`, and the jsonable() bridge above stringifies every key, so the parsed JSON carries the
 * trigger block under the STRING key "True", not "on". Verified empirically against this exact file:
 *   python3 -c "import yaml; print(list(yaml.safe_load(open('.github/workflows/integration-guard.yml')).keys()))"
 *   -> ['name', True, 'jobs']
 * Fail CLOSED (throw) if none of the three possible spellings is present on the parsed document —
 * defaulting to `{}` would make "the whole trigger block vanished" read as a vacuously passing empty
 * mapping, which is the same class of bug this repo's "读空≠不存在" doctrine names.
 *
 * @returns {Record<string, unknown>}
 */
function onBlock() {
  for (const key of ['True', 'on', 'true']) {
    if (isPlainObject(doc) && Object.prototype.hasOwnProperty.call(doc, key)) {
      const value = doc[key]
      if (isPlainObject(value)) return value
      throw new Error(
        `integration-guard.yml: the on: trigger block (found under parsed key "${key}") is not a ` +
          `mapping — refusing to treat it as an empty trigger set`,
      )
    }
  }
  throw new Error(
    'integration-guard.yml: could not locate the on: trigger block under any of its parsed ' +
      'spellings (True/on/true) — refusing to treat a missing trigger block as vacuously empty',
  )
}

/**
 * @returns {Record<string, unknown>}
 */
function requireJob() {
  assert.ok(isPlainObject(doc.jobs), 'integration-guard.yml: jobs: mapping must exist')
  assert.ok(
    Object.prototype.hasOwnProperty.call(doc.jobs, JOB_ID),
    `integration-guard.yml: jobs.${JOB_ID} must exist — the required context is matched by this ` +
      `exact job key (renaming/removing it silently orphans any future required-check promotion)`,
  )
  return doc.jobs[JOB_ID]
}

/** @param {Record<string, unknown>} job */
function stepsOf(job) {
  return Array.isArray(job.steps) ? job.steps : []
}

/**
 * Locates a step by its exact `id:` — never by `- name:` title, per this repo's decoy-title doctrine
 * (a renamed/duplicated title must not stand in for the step actually wired to run/be referenced).
 * @param {Record<string, unknown>} job
 * @param {string} id
 * @returns {Record<string, unknown> | undefined}
 */
function stepById(job, id) {
  return stepsOf(job).find((s) => isPlainObject(s) && s.id === id)
}

// ---------------------------------------------------------------------------
// Pin 1: on.pull_request carries no paths/paths-ignore filter — the property that makes the
// produced context universal across every pull_request event, not just ones touching guarded paths.
// ---------------------------------------------------------------------------

test('on.pull_request exists and carries no paths/paths-ignore filter', () => {
  const on = onBlock()
  assert.ok(
    Object.prototype.hasOwnProperty.call(on, 'pull_request'),
    'on.pull_request trigger must exist — deleting the trigger entirely must not read as "no paths ' +
      'filter" (that would be the worst possible state: the context never appears on any PR at all)',
  )
  const pr = on.pull_request
  assert.ok(
    pr === null || isPlainObject(pr),
    'on.pull_request must be a bare/empty trigger (matches every PR) or a mapping',
  )
  if (isPlainObject(pr)) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(pr, 'paths'),
      false,
      'on.pull_request must not carry a paths: filter — a required context must be produced on ' +
        'every pull_request event, not only ones touching the guarded paths',
    )
    assert.equal(
      Object.prototype.hasOwnProperty.call(pr, 'paths-ignore'),
      false,
      'on.pull_request must not carry a paths-ignore: filter either — same universality requirement',
    )
  }
})

// ---------------------------------------------------------------------------
// Pin 2: on.merge_group exists — otherwise a merge-queue entry never produces the context either.
// ---------------------------------------------------------------------------

test('on.merge_group trigger exists', () => {
  const on = onBlock()
  assert.ok(
    Object.prototype.hasOwnProperty.call(on, 'merge_group'),
    'on.merge_group must exist — without it a merge-queue entry never triggers this workflow and ' +
      'the integration-guard context is never produced for it, so it would wait forever once required',
  )
})

// ---------------------------------------------------------------------------
// Pin 3: the job producing the required context is present under the exact expected name, with no
// strategy.matrix silently suffixing the produced check name.
// ---------------------------------------------------------------------------

test('the job producing the required context is present under the exact expected name, with no matrix suffix', () => {
  const job = requireJob()
  const effectiveName = typeof job.name === 'string' && job.name.length > 0 ? job.name : JOB_ID
  assert.equal(
    effectiveName,
    JOB_ID,
    `the job's effective GitHub check name must be exactly "${JOB_ID}" — a required context is ` +
      `matched by this literal string`,
  )
  const hasMatrix = isPlainObject(job.strategy) && isPlainObject(job.strategy.matrix)
  assert.equal(
    hasMatrix,
    false,
    'the job must not carry a strategy.matrix — GitHub would suffix the produced context with ' +
      '"(<value>)" per matrix leg (e.g. "integration-guard (20.x)"), silently breaking ' +
      'required-context matching even though the job was not "renamed"',
  )
})

// ---------------------------------------------------------------------------
// Pin 4 (P1, layer 2): the job itself must forbid `if`, `needs`, and `continue-on-error` at the JOB
// level. A job-level `if: false` makes GitHub report the job SKIPPED, which — unlike a workflow that
// never runs — DOES satisfy a required context, exactly like a real green run, having executed
// nothing. A `needs:` entry has the identical effect whenever the job(s) it points at are themselves
// skipped (transitively propagating the skip, still reporting SUCCESS) — note this is distinct from
// `needs:` naming a job that does not exist at all, which is a workflow VALIDATION ERROR, not a
// skip; forbidding the key closes both failure modes without having to distinguish them.
// `continue-on-error: true` at the job level would similarly let a hard failure inside the job still
// report the job overall as successful.
// ---------------------------------------------------------------------------

test('jobs.integration-guard forbids job-level if/needs/continue-on-error', () => {
  const job = requireJob()
  for (const forbiddenKey of ['if', 'needs', 'continue-on-error']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(job, forbiddenKey),
      false,
      `jobs.${JOB_ID} must not carry a job-level "${forbiddenKey}" key — GitHub reports a job ` +
        `skipped by "if" (or transitively via "needs" on a job that is itself skipped) as SUCCESS, ` +
        `and "continue-on-error" swallows a real failure, either of which produces a false-green ` +
        `required context having run nothing`,
    )
  }
})

// ---------------------------------------------------------------------------
// Pin 5 (P1, layer 2): none of the classifier, no-op, real-branch, or terminal-assertion steps may
// carry `continue-on-error` — it would let any of them silently fail without failing the job.
// ---------------------------------------------------------------------------

test('the classifier, no-op, real-branch, and terminal steps forbid continue-on-error', () => {
  const job = requireJob()
  const guardedSteps = [
    ['classifier (id: changes)', stepById(job, CLASSIFIER_STEP_ID)],
    ['no-op (id: noop)', stepById(job, NOOP_STEP_ID)],
    ['plugin-core-tests (id: plugin-core-tests)', stepById(job, PLUGIN_STEP_ID)],
    ['web-guard-specs (id: web-guard-specs)', stepById(job, WEB_STEP_ID)],
    ['terminal assertion (id: assert-branch)', stepById(job, TERMINAL_STEP_ID)],
  ]
  for (const [label, step] of guardedSteps) {
    assert.ok(step, `the ${label} step must exist (located by exact id)`)
    assert.equal(
      Object.prototype.hasOwnProperty.call(step, 'continue-on-error'),
      false,
      `the ${label} step must not carry continue-on-error — it is one of the steps this contract ` +
        `relies on actually failing the job when it fails`,
    )
  }
})

// ---------------------------------------------------------------------------
// Pin 6 (P1, layer 3): the in-job scope classifier invokes the EXTRACTED, unit-testable script — not
// a reimplemented inline case-statement (which would silently drop out of sync with the behavioural
// tests below, since those test the script file directly, not whatever inline bash sits in the YAML).
// ---------------------------------------------------------------------------

test('the scope-detection step (id: changes) invokes the extracted classifier script with NUL-delimited git diff', () => {
  const job = requireJob()
  const classifier = stepById(job, CLASSIFIER_STEP_ID)
  assert.ok(classifier, `job.${JOB_ID} must have a step with id: ${CLASSIFIER_STEP_ID}`)
  const run = typeof classifier.run === 'string' ? classifier.run : ''
  assert.ok(
    run.includes('node scripts/ops/integration-guard-classify.mjs'),
    `the ${CLASSIFIER_STEP_ID} step must invoke \`node scripts/ops/integration-guard-classify.mjs\` ` +
      `— reverting to an inline reimplementation would silently desync from the behavioural tests ` +
      `below, which exercise the SCRIPT FILE directly`,
  )
  assert.ok(
    run.includes('git diff --name-only -z') || run.includes('git diff-tree --root --no-commit-id --name-only -z -r'),
    `the ${CLASSIFIER_STEP_ID} step must feed the classifier NUL-delimited paths (\`-z\`) — a plain ` +
      `newline-delimited diff can misparse a path containing a literal newline`,
  )
})

// ---------------------------------------------------------------------------
// Pin 7 (unchanged property, relocated): a relevant change runs the full existing suite (both real
// steps gated on relevant=='true', located by their ACTUAL command content, never by `- name:` title).
// ---------------------------------------------------------------------------

test('a relevant change runs the full existing suite (both real steps gated on relevant==true)', () => {
  const job = requireJob()

  const pluginCoreStep = stepsOf(job).find(
    (s) => isPlainObject(s) && typeof s.run === 'string' && s.run.includes('pnpm --filter plugin-integration-core test'),
  )
  assert.ok(
    pluginCoreStep,
    'a step invoking `pnpm --filter plugin-integration-core test` (the plugin CJS test chain) must exist',
  )
  assert.equal(pluginCoreStep.id, PLUGIN_STEP_ID, `the plugin-integration-core test step must carry id: ${PLUGIN_STEP_ID}`)
  assert.equal(
    typeof pluginCoreStep.if === 'string' ? pluginCoreStep.if.trim() : null,
    RELEVANT_TRUE_IF,
    `the plugin-integration-core test step must be gated \`if: ${RELEVANT_TRUE_IF}\` — flipping ` +
      `this to =='false' (or removing it) would leave the no-op branch green while the real suite ` +
      `silently never runs on relevant changes`,
  )

  const vitestGuardStep = stepsOf(job).find(
    (s) => isPlainObject(s) && typeof s.run === 'string'
      && s.run.includes('--filter @metasheet/web exec vitest run')
      && s.run.includes('composition-vocab-mirror'),
  )
  assert.ok(
    vitestGuardStep,
    'a step invoking the integration web guard specs (vitest run ... composition-vocab-mirror ...) must exist',
  )
  assert.equal(vitestGuardStep.id, WEB_STEP_ID, `the integration web guard specs step must carry id: ${WEB_STEP_ID}`)
  assert.equal(
    typeof vitestGuardStep.if === 'string' ? vitestGuardStep.if.trim() : null,
    RELEVANT_TRUE_IF,
    `the integration web guard specs step must be gated \`if: ${RELEVANT_TRUE_IF}\``,
  )
})

// ---------------------------------------------------------------------------
// Pin 8: changes outside the guarded paths hit an explicit no-op SUCCESS (exit 0) — a real, executed,
// green step (kept for auditability — see the P2 correction in the header for why, and why NOT
// because a skipped step/job "wouldn't satisfy" the required context, which is false).
// ---------------------------------------------------------------------------

test('an irrelevant change hits an explicit no-op SUCCESS (exit 0), id: noop', () => {
  const job = requireJob()
  const noop = stepById(job, NOOP_STEP_ID)
  assert.ok(noop, `job.${JOB_ID} must have a step with id: ${NOOP_STEP_ID}`)
  assert.equal(
    typeof noop.if === 'string' ? noop.if.trim() : null,
    RELEVANT_FALSE_IF,
    `the ${NOOP_STEP_ID} step must be gated \`if: ${RELEVANT_FALSE_IF}\``,
  )
  const run = typeof noop.run === 'string' ? noop.run : ''
  assert.match(
    run,
    /(^|\s)exit 0(\s|$)/,
    'the no-op step must explicitly `exit 0` — relying on the default zero exit of the last `echo` ' +
      'is not the "explicit no-op SUCCESS" the owner asked for, and is fragile to an added command',
  )
})

// ---------------------------------------------------------------------------
// Pin 9 (P1, layer 3): the terminal safety-net step exists, id: assert-branch, gated EXACTLY
// `if: always()`, invokes the extracted assert-branch script, and is wired to the three branch
// steps' outcomes plus the classifier's verdict via env.
// ---------------------------------------------------------------------------

test('the terminal branch-assertion step exists, is gated if: always(), and is wired to all three branch outcomes', () => {
  const job = requireJob()
  const terminal = stepById(job, TERMINAL_STEP_ID)
  assert.ok(
    terminal,
    `job.${JOB_ID} must have a step with id: ${TERMINAL_STEP_ID} — deleting it removes the only ` +
      `runtime door against an ambiguous (non-true/false) classification result`,
  )
  assert.equal(
    typeof terminal.if === 'string' ? terminal.if.trim() : null,
    'always()',
    `the ${TERMINAL_STEP_ID} step must be gated EXACTLY \`if: always()\` — any other condition ` +
      `(including the default, which behaves like success()) can skip this step precisely when an ` +
      `earlier step's outcome makes it most needed`,
  )
  const run = typeof terminal.run === 'string' ? terminal.run : ''
  assert.ok(
    run.includes('node scripts/ops/integration-guard-assert-branch.mjs'),
    `the ${TERMINAL_STEP_ID} step must invoke \`node scripts/ops/integration-guard-assert-branch.mjs\``,
  )
  const env = isPlainObject(terminal.env) ? terminal.env : {}
  const relevantExpr = String(env.RELEVANT ?? '')
  const noopExpr = String(env.NOOP_OUTCOME ?? '')
  const pluginExpr = String(env.PLUGIN_OUTCOME ?? '')
  const webExpr = String(env.WEB_OUTCOME ?? '')
  assert.ok(
    relevantExpr.includes(`steps.${CLASSIFIER_STEP_ID}.outputs.relevant`),
    'env.RELEVANT must read steps.changes.outputs.relevant',
  )
  assert.ok(noopExpr.includes(`steps.${NOOP_STEP_ID}.outcome`), 'env.NOOP_OUTCOME must read the noop step outcome')
  assert.ok(pluginExpr.includes(`steps.${PLUGIN_STEP_ID}.outcome`), 'env.PLUGIN_OUTCOME must read the plugin-core-tests step outcome')
  assert.ok(webExpr.includes(`steps.${WEB_STEP_ID}.outcome`), 'env.WEB_OUTCOME must read the web-guard-specs step outcome')
})

// ---------------------------------------------------------------------------
// Pin 10 (P1, layer 3, roster single-sourcing): on.push.paths must be exactly the same SET as
// scripts/ops/integration-guard-guarded-paths.mjs's GUARDED_PATH_ENTRIES — no drift in either
// direction, and no duplicates (the pre-existing bug this slice also fixes: JsonAssist.vue and
// utils/jsonAssist.ts were each listed twice in the old on.push.paths).
// ---------------------------------------------------------------------------

test('on.push.paths is exactly the guarded-path roster, with no duplicates on either side', () => {
  const on = onBlock()
  assert.ok(isPlainObject(on.push), 'on.push must exist')
  assert.ok(Array.isArray(on.push.paths), 'on.push.paths must be an array')
  const pushPaths = on.push.paths.map(String)

  const pushSet = new Set(pushPaths)
  assert.equal(pushSet.size, pushPaths.length, 'on.push.paths must not contain duplicate entries')

  const rosterSet = new Set(GUARDED_PATH_ENTRIES)
  assert.equal(rosterSet.size, GUARDED_PATH_ENTRIES.length, 'GUARDED_PATH_ENTRIES must not contain duplicate entries')

  const onlyInPush = pushPaths.filter((p) => !rosterSet.has(p))
  const onlyInRoster = GUARDED_PATH_ENTRIES.filter((p) => !pushSet.has(p))
  assert.deepEqual(onlyInPush, [], `on.push.paths has entries not in the roster: ${JSON.stringify(onlyInPush)}`)
  assert.deepEqual(onlyInRoster, [], `the roster has entries not in on.push.paths: ${JSON.stringify(onlyInRoster)}`)
})

// ---------------------------------------------------------------------------
// Pin 11 (P1, layer 3, roster-level defense against "renamed to a nonexistent path" — closes the
// mutation CLASS, not just the one path the owner's mutation happened to pick). CASE-EXACT: plain
// fs.existsSync is case-insensitive on the default macOS/Windows filesystem, which would let a
// case-only roster mutation pass locally while silently never matching on the case-sensitive ubuntu
// CI runner (same as git's own path matching).
// ---------------------------------------------------------------------------

test('every guarded-path roster entry resolves to a real file/directory, case-exactly', () => {
  const missing = findMissingRosterEntries(GUARDED_PATH_ENTRIES, repoRoot)
  assert.deepEqual(
    missing,
    [],
    `roster entries that do not resolve on disk (case-exact): ${JSON.stringify(missing, null, 2)}`,
  )
})

// ---------------------------------------------------------------------------
// Behavioural tests of scripts/ops/integration-guard-classify.mjs — Door A. These call classify()
// directly with synthetic file lists; they do not depend on GitHub Actions, the terminal step, or
// assert-branch.mjs at all.
// ---------------------------------------------------------------------------

test('classify(): a deeply-nested plugin-only change is relevant (glob-semantics regression guard)', () => {
  assert.strictEqual(
    classify(['plugins/plugin-integration-core/src/read/foo/bar.ts']),
    true,
    'a nested path under the plugins/plugin-integration-core/** prefix must classify as relevant — ' +
      'a matcher that only checks top-level files under the prefix would silently miss this',
  )
})

test('classify(): a web-only exact-file change is relevant', () => {
  assert.strictEqual(classify(['apps/web/src/services/integration/readSourceConfigs.ts']), true)
})

test('classify(): a web-only nested stock-preparation change (prefix entry) is relevant', () => {
  assert.strictEqual(
    classify(['apps/web/src/components/integration/stockPreparation/deep/nested/Widget.vue']),
    true,
  )
})

test('classify(): a change touching both a plugin file and a web file is relevant', () => {
  assert.strictEqual(
    classify([
      'plugins/plugin-integration-core/src/write/target.ts',
      'apps/web/src/services/integration/fieldHints.ts',
    ]),
    true,
  )
})

test('classify(): a change touching none of the guarded paths is NOT relevant — strictly false, never "unknown"', () => {
  assert.strictEqual(
    classify(['README.md', 'packages/core-backend/src/unrelated/module.ts']),
    false,
    'classify() must return the primitive boolean false, never a truthy-but-wrong string like "unknown"',
  )
})

test('classify(): an empty changed-file list is NOT relevant', () => {
  assert.strictEqual(classify([]), false)
})

test('classify(): matchesGuardedPath() exact-matches non-prefix entries and does not over-match siblings', () => {
  assert.equal(matchesGuardedPath('apps/web/src/services/integration/workbench.ts', GUARDED_PATH_ENTRIES), true)
  assert.equal(matchesGuardedPath('apps/web/src/services/integration/workbench2.ts', GUARDED_PATH_ENTRIES), false)
})

test('parseNulDelimited(): splits on NUL, not whitespace, and drops empty trailing entries', () => {
  const NUL = String.fromCharCode(0)
  const raw = Buffer.from(['a/b file with spaces.ts', 'c/d.ts', ''].join(NUL))
  assert.deepEqual(parseNulDelimited(raw), ['a/b file with spaces.ts', 'c/d.ts'])
})

test('classify() CLI: piping a real NUL-delimited diff through the script emits exactly one relevant=true|false line', () => {
  const NUL = String.fromCharCode(0)
  const scriptPath = join(repoRoot, 'scripts/ops/integration-guard-classify.mjs')

  const relevantRes = spawnSync('node', [scriptPath], {
    input: Buffer.from(['plugins/plugin-integration-core/src/x.ts'].join(NUL) + NUL),
    encoding: 'utf8',
  })
  assert.equal(relevantRes.status, 0, `classify CLI must exit 0 (relevant case): stderr=${relevantRes.stderr}`)
  assert.equal(relevantRes.stdout.trim(), 'relevant=true')

  const irrelevantRes = spawnSync('node', [scriptPath], {
    input: Buffer.from(['README.md'].join(NUL) + NUL),
    encoding: 'utf8',
  })
  assert.equal(irrelevantRes.status, 0, `classify CLI must exit 0 (irrelevant case): stderr=${irrelevantRes.stderr}`)
  assert.equal(irrelevantRes.stdout.trim(), 'relevant=false')

  const emptyRes = spawnSync('node', [scriptPath], { input: Buffer.from(''), encoding: 'utf8' })
  assert.equal(emptyRes.status, 0, `classify CLI must exit 0 (empty-diff case): stderr=${emptyRes.stderr}`)
  assert.equal(
    emptyRes.stdout.trim(),
    'relevant=false',
    'an empty diff (e.g. the BASE_SHA-missing fallback with no actual file changes) must emit ' +
      'relevant=false explicitly — never an empty string and never "unknown"',
  )
})

// ---------------------------------------------------------------------------
// Behavioural tests of scripts/ops/integration-guard-assert-branch.mjs — Door B. These call
// assertBranch() directly with synthetic state; they do not call classify() or read the workflow
// YAML at all, so they independently prove the runtime safety net is load-bearing on its own.
// ---------------------------------------------------------------------------

test('assertBranch(): relevant=true with both real steps succeeded and noop skipped is OK', () => {
  const result = assertBranch({ relevant: 'true', noopOutcome: 'skipped', pluginOutcome: 'success', webOutcome: 'success' })
  assert.equal(result.ok, true)
})

test('assertBranch(): relevant=false with noop succeeded and both real steps skipped is OK', () => {
  const result = assertBranch({ relevant: 'false', noopOutcome: 'success', pluginOutcome: 'skipped', webOutcome: 'skipped' })
  assert.equal(result.ok, true)
})

test('assertBranch(): relevant="unknown" is REJECTED regardless of outcomes (the owner-mandated mutation, at the runtime layer)', () => {
  const result = assertBranch({ relevant: 'unknown', noopOutcome: 'skipped', pluginOutcome: 'skipped', webOutcome: 'skipped' })
  assert.equal(result.ok, false)
  assert.match(result.message, /must be strictly 'true' or 'false'/)
})

test('assertBranch(): relevant="" (empty/unset) is REJECTED', () => {
  const result = assertBranch({ relevant: '', noopOutcome: undefined, pluginOutcome: undefined, webOutcome: undefined })
  assert.equal(result.ok, false)
})

test('assertBranch(): relevant=true but noop ALSO succeeded (contradiction — both branches ran) is REJECTED', () => {
  const result = assertBranch({ relevant: 'true', noopOutcome: 'success', pluginOutcome: 'success', webOutcome: 'success' })
  assert.equal(result.ok, false)
})

test('assertBranch(): relevant=false but a real step ALSO succeeded (contradiction) is REJECTED', () => {
  const result = assertBranch({ relevant: 'false', noopOutcome: 'success', pluginOutcome: 'success', webOutcome: 'skipped' })
  assert.equal(result.ok, false)
})

test('assertBranch(): relevant=true but a real step was skipped (real branch did not actually run) is REJECTED', () => {
  const result = assertBranch({ relevant: 'true', noopOutcome: 'skipped', pluginOutcome: 'skipped', webOutcome: 'success' })
  assert.equal(result.ok, false)
})
