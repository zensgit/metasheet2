import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * Integration Guard required-wiring contract (governance slice, 2026-07-25 — standalone from
 * #4603/#4604/#4610 by owner instruction).
 *
 * THE PROBLEM THIS PINS. .github/workflows/integration-guard.yml used to trigger `pull_request` with
 * a `paths:` filter and had no `merge_group` trigger. A required status check is matched by
 * check/job NAME: if the workflow never runs for a given PR (paths didn't match) or event
 * (merge_group never listened), the `integration-guard` context is never produced, and that
 * PR/merge-queue entry waits FOREVER on a required check that will never report. This slice makes
 * the context UNIVERSAL — it does not promote it to required (that is the owner's separate, later
 * branch-protection step) — by (1) dropping the trigger-level `paths:` filter on `pull_request` and
 * adding `merge_group:`, (2) moving the guarded-path scope check INSIDE the job so an out-of-scope
 * change still produces a real, green, EXPLICIT no-op step (exit 0) instead of the job never
 * existing at all.
 *
 * BE HONEST ABOUT WHAT THIS CAN AND CANNOT PROVE. This is a YAML-SHAPE assertion, not a behavioural
 * one — whether GitHub actually fires `merge_group`, whether it actually treats this workflow's
 * absence as "pending forever" vs. "not required", and whether a `skipped` step conclusion differs
 * from an executed `exit 0` in required-check evaluation are all GitHub platform behaviour this test
 * cannot exercise from a repo checkout (see this repo's own doctrine: source-text assertions are not
 * behaviour assertions). It earns its keep only if it actually REDS under the specific mutations that
 * would silently regress the wiring — see the four owner-mandated mutations plus three additional
 * ones closing vacuous-pass gaps, recorded in the PR body for this slice, each pasted with real
 * `node --test` output before landing.
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
// Pin 4a: the in-job scope classifier (id: changes) actually writes its verdict to $GITHUB_OUTPUT.
// Without this, steps.changes.outputs.relevant is the empty string at runtime for EVERY event, so
// neither the =='true' nor the =='false' gated steps below ever run, and the job reports green
// having executed nothing at all — a vacuous pass that "some step has if: ...=='false'" alone would
// not catch.
// ---------------------------------------------------------------------------

test('the scope-detection step (id: changes) writes its verdict to $GITHUB_OUTPUT', () => {
  const job = requireJob()
  const classifier = stepsOf(job).find((s) => isPlainObject(s) && s.id === CLASSIFIER_STEP_ID)
  assert.ok(
    classifier,
    `job.${JOB_ID} must have a step with id: ${CLASSIFIER_STEP_ID} (the in-job guarded-path scope ` +
      `classifier) — located by exact id, never by title, so a name-prefix decoy cannot stand in`,
  )
  const run = typeof classifier.run === 'string' ? classifier.run : ''
  assert.ok(
    run.includes('relevant=$relevant" >> "$GITHUB_OUTPUT"'),
    `the ${CLASSIFIER_STEP_ID} step must write its relevant=true/false verdict to $GITHUB_OUTPUT — ` +
      `without this line every gated step below (both the =='true' and =='false' branches) is ` +
      `skipped, and the job reports green having run nothing at all`,
  )
})

// ---------------------------------------------------------------------------
// Pin 4b: changes in the guarded paths run the full existing suite, unchanged — both real steps
// (the plugin-integration-core CJS chain and the integration web guard specs) are located by their
// ACTUAL command content (never by `- name:` title, per this repo's decoy-title doctrine — see
// scripts/ops/ci-realdb-step-contract.mjs's header) and must be gated on relevant=='true'.
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
  assert.equal(
    typeof vitestGuardStep.if === 'string' ? vitestGuardStep.if.trim() : null,
    RELEVANT_TRUE_IF,
    `the integration web guard specs step must be gated \`if: ${RELEVANT_TRUE_IF}\``,
  )
})

// ---------------------------------------------------------------------------
// Pin 4c: changes outside the guarded paths hit an explicit no-op SUCCESS (exit 0) — a real,
// executed, green step, not a GitHub-`skipped` step/job (the owner's distinction: a `skipped`
// conclusion does not satisfy a required context the same way).
// ---------------------------------------------------------------------------

test('an irrelevant change hits an explicit no-op SUCCESS (exit 0), not a skipped job', () => {
  const job = requireJob()
  const noop = stepsOf(job).find(
    (s) => isPlainObject(s) && typeof s.if === 'string' && s.if.trim() === RELEVANT_FALSE_IF,
  )
  assert.ok(
    noop,
    `a step gated \`if: ${RELEVANT_FALSE_IF}\` (the no-op branch) must exist — deleting it removes ` +
      `the only path that keeps the job green (and the context real) on an out-of-scope change`,
  )
  const run = typeof noop.run === 'string' ? noop.run : ''
  assert.match(
    run,
    /(^|\s)exit 0(\s|$)/,
    'the no-op step must explicitly `exit 0` — relying on the default zero exit of the last `echo` ' +
      'is not the "explicit no-op SUCCESS" the owner asked for, and is fragile to an added command',
  )
})
