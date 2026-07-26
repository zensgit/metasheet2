import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
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
 *   - The Pin 6/7/8/9 EXACT-EQUALITY `run:`/`env:` assertions (added in the P1 correction above) are
 *     STILL source-text assertions, upgraded from substring-containment to byte-identity — an upgrade
 *     in precision, not a change in KIND. They prove the YAML text a reviewer reads is the YAML text
 *     that will execute; they do not prove GitHub evaluates `${{ steps.changes.outputs.relevant }}`
 *     correctly at runtime, nor that `node scripts/ops/integration-guard-classify.mjs`'s own internals
 *     are correct. Do not restate this as "the classifier is now load-bearing, full stop" — it is
 *     load-bearing against the specific mutation class (workflow-side bypass) this exact-shape pinning
 *     closes. The GITHUB_OUTPUT-content behavioural tests below are what closes the SCRIPT-side class
 *     (the write being neutered); nothing in this file exercises the real GitHub Actions runner.
 *   - It earns its keep only if it actually REDS under the mutations that would silently regress the
 *     wiring — see the PR body for this slice, each mutation pasted with real `node --test` output
 *     before landing.
 *
 * CORRECTION (P1, second review round, 2026-07-26): the "TWO INDEPENDENT DOORS" section above, and the
 * matching claim in integration-guard.yml's own header ("the classifier is now load-bearing"), were
 * OVERSTATED and are RETRACTED here, not merely reworded. Pins 6/7/8/9 as they stood asserted only
 * SUBSTRING PRESENCE (`run.includes(...)`, `env.X.includes(...)`) inside the step's `run:`/`env:` text,
 * never the text's exact shape. Two concrete mutations proved this was not load-bearing while staying
 * 27/27 GREEN:
 *   - M4d: left `id: changes`'s classifier invocation line byte-for-byte untouched, but (a) suppressed
 *     `integration-guard-classify.mjs`'s own `appendFileSync` to `$GITHUB_OUTPUT` and (b) added one
 *     extra line to the SAME step's `run:` block that unconditionally writes `relevant=false` to
 *     `$GITHUB_OUTPUT` afterward. `run.includes('node scripts/ops/integration-guard-classify.mjs')`
 *     still matched (the line is still there), so Pin 6 (as it stood) never noticed the classifier's
 *     real verdict had been discarded.
 *   - M8b: replaced `env.RELEVANT: ${{ steps.changes.outputs.relevant }}` with an expression that still
 *     contains the substring `steps.changes.outputs.relevant` somewhere inside it but is written so the
 *     expression never actually evaluates to that value (e.g. `${{ false && steps.changes.outputs.
 *     relevant || 'true' }}`, which always yields the literal `'true'`). `env.RELEVANT.includes(...)`
 *     still matched, so Pin 9 (as it stood) never noticed the terminal safety net was reading a
 *     constant instead of the classifier's actual output.
 *   - The same substring-containment weakness applied to Pin 7 (the two real-branch steps, located by
 *     `run.includes('pnpm --filter plugin-integration-core test')` / `run.includes('--filter
 *     @metasheet/web exec vitest run ...')`) and Pin 8 (the no-op step's `exit 0` regex) — commenting
 *     out the real command with a leading `#` still leaves the substring present in the `run:` text.
 * FIX, applied below: Pins 6/7/8 now assert EXACT EQUALITY of each pinned step's `run:` text against a
 * literal captured from the current file (not a hand-typed approximation — see the `EXACT` constants
 * below, generated by dumping `JSON.stringify(step.run)` and pasting it verbatim, per this repo's
 * "token pinning must be exact-equal" doctrine). Pin 9's four `env:` values are now asserted by EXACT
 * EQUALITY, not `.includes(...)`. Additionally, two new Door-A behavioural tests (see below, "writes
 * GITHUB_OUTPUT exactly once, with exact content") spawn the real `integration-guard-classify.mjs` CLI
 * with a real temp file as `$GITHUB_OUTPUT` and assert its EXACT final byte content — this is the one
 * property exact-shape YAML pinning alone cannot prove, because M4d's `appendFileSync` suppression is a
 * change to the SCRIPT, not the workflow YAML, and no amount of pinning `run:` text detects it. Between
 * the two: exact-shape pinning closes "the workflow bypasses the script's verdict", and the new
 * GITHUB_OUTPUT-content tests close "the script's own write is neutered" — together, not layered so one
 * covers for the other's absence (same "两道fail-closed门互相掩护" doctrine Layer 3 above already names).
 * Still true, and worth restating precisely rather than re-overclaiming one layer up: exact-shape `run:`
 * pinning is STILL a source-text assertion (it proves the YAML text is byte-identical to a known-good
 * capture, not that GitHub Actions evaluates it as expected at runtime) — see "BE HONEST ABOUT WHAT EACH
 * LAYER CAN AND CANNOT PROVE" below, which this correction does not supersede, only sharpens.
 *
 * THIRD REVIEW ROUND (2026-07-26) — three more findings, all closed here:
 *   - [P1] The exact-equality treatment above was applied to the terminal step's `env:` (Pin 9) and to
 *     every load-bearing step's `run:` (Pins 6/7/8), but NOT to the classifier step's (`id: changes`)
 *     own `env:` block (EVENT_NAME/BASE_SHA/HEAD_SHA) — that was left entirely unpinned, not even by
 *     substring. This is a UNIVERSAL false negative, not a narrow one: on a real `pull_request` event
 *     `github.sha` (HEAD_SHA) is a MERGE COMMIT, and the `run:` block's own empty-diff fallback
 *     (`git diff-tree --root -r "$HEAD_SHA"`, taken whenever BASE_SHA is empty or the all-zeros
 *     sentinel) emits ZERO paths for any merge commit — verified against this PR's own real
 *     GitHub-generated merge commit in the PR body's evidence for this round. A mutation hardcoding
 *     `env.BASE_SHA` to the all-zeros sentinel (the `run:` text, which IS pinned, stays byte-for-byte
 *     untouched) therefore forces every run down that empty-diff path regardless of what actually
 *     changed. Closed by extending Pin 6 to exact-pin EVENT_NAME/BASE_SHA/HEAD_SHA the same way Pin 9
 *     already pins the terminal step's four env values.
 *   - [P3] Pin 2 (`on.merge_group` exists) was asymmetric with Pin 1's "reject ANY narrowing key"
 *     treatment of `on.pull_request` — it only checked `hasOwnProperty`, never the value's shape, so
 *     both `merge_group: { types: [] }` (filters out the only type merge_group supports — the trigger
 *     never actually fires) and `merge_group: { types: [checks_requested], branches: [not-main] }` (the
 *     exact permanent-Pending mode this whole contract exists to prevent, on the merge_group half)
 *     stayed green. Made symmetric: the key set is pinned to exactly `['types']` and `types` itself to
 *     exactly `['checks_requested']` — merge_group legitimately needs that one key (unlike
 *     pull_request), so this cannot mirror Pin 1's "zero keys" shape verbatim, only its "reject any
 *     narrowing beyond what's structurally required" intent.
 *   - [P3] Added a NUL-byte-absence pin (Pin 12) over the workflow file and all three extracted scripts.
 *     Not hypothetical: the exact defect it guards against (a literal raw NUL byte where a `'\0'` escape
 *     belonged, making the whole file render as BINARY in review — no patch, additions=0/deletions=0)
 *     occurred once already on this branch (fixed in `b1aae0244`) and has recurred in this line before;
 *     nothing previously REDs if it recurs a third time.
 * Real `node --test` RED output for all three, plus the corrected M9/M10 mutation-ledger counts this
 * round's two new baseline tests shifted (M9 now REDs 5, not 4; M10 now REDs 4, not 3 — M11 unchanged at
 * 1), live in PR #4614's body, not here — same house rule as the second round above.
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
// EXACT-SHAPE pins (P1 correction, 2026-07-26): each literal below was captured by dumping
// `JSON.stringify(step.run)` / `JSON.stringify(step.env.X)` straight out of a parsed copy of the
// current integration-guard.yml and pasting the output verbatim — never hand-typed — specifically to
// avoid a transcription error (e.g. a dropped trailing newline a YAML `run: |` block scalar preserves)
// producing a pin that never matches the real file and so is permanently RED, or worse, a pin quietly
// loosened to make it pass. `git diff` on this file makes the provenance of each literal reviewable.
// A step whose `run:`/`env:` text differs from these by even one byte (a trailing space, a re-ordered
// clause, an injected extra line) fails the corresponding pin below — this is what closes M4d/M8b/M17
// (see the CORRECTION note in the file header above).
// ---------------------------------------------------------------------------

const CLASSIFIER_RUN_EXACT =
  "set -euo pipefail\n\necho \"Integration Guard: classifying for $EVENT_NAME (base=${BASE_SHA:-<none>}, head=$HEAD_SHA).\"\n\nif [[ -z \"${BASE_SHA:-}\" || \"$BASE_SHA\" == \"0000000000000000000000000000000000000000\" ]]; then\n  git diff-tree --root --no-commit-id --name-only -z -r \"$HEAD_SHA\" | node scripts/ops/integration-guard-classify.mjs\nelse\n  git diff --name-only -z \"$BASE_SHA\" \"$HEAD_SHA\" | node scripts/ops/integration-guard-classify.mjs\nfi\n"

const NOOP_RUN_EXACT =
  "echo \"Integration Guard: no changes in guarded paths for this ${{ github.event_name }} event.\"\necho \"This is a DELIBERATE NO-OP SUCCESS (exit 0) -- an auditable, in-band result in this\"\necho \"job's own log, not an out-of-band skipped conclusion a reviewer would have to look up.\"\nexit 0\n"

const PLUGIN_CORE_RUN_EXACT = "pnpm --filter plugin-integration-core test"

const WEB_GUARD_RUN_EXACT =
  "pnpm --filter @metasheet/web exec vitest run composition-vocab-mirror multitable-resolver-vocab-mirror integrationErrorCodeLabels fieldHints IntegrationReadSourceConfigPanel IntegrationReadSourceCompositionPanel IntegrationReadSourceCompositionAuthoringPanel readSourceCompositions.service IntegrationWorkbenchView IntegrationWorkbenchRail IntegrationMonitoringSection IntegrationCleaningDatasetSection IntegrationMappingRulesSection IntegrationObjectTemplateSection IntegrationPayloadPreviewSection IntegrationConnectionSection IntegrationBridgeAgentSection IntegrationK3WiseSetupView IntegrationHelpView IntegrationPipelineRunSection IntegrationStockPrepPanel IntegrationExternalWritePanel IntegrationTableActionsPanel IntegrationFieldOptionSyncPanel readSourceModePresets IntegrationReadSourceWizard JsonAssist IntegrationCompositionWizard bridgeAgentConfigCheck IntegrationOptionSetsStructuredEditor optionSetsStructured integrationWorkbench MetaIntegrationFieldRuleAuthoring readSourceTemplateCatalog IntegrationTemplateCatalogPicker StockPreparationWorkspace StockPreparationProjectWorkspaceView bomSnapshotDiff StockPreparationSnapshotDiffView StockPreparationMappingConfirmView StockPreparationUnitConfirmView StockPreparationPrepLineView StockPreparationExceptionQueueView StockPreparationDashboardView StockPreparationStageOverview StockPreparationStageStepper --reporter=dot"

const TERMINAL_RUN_EXACT = "node scripts/ops/integration-guard-assert-branch.mjs"

const RELEVANT_ENV_EXACT = '${{ steps.changes.outputs.relevant }}'
const NOOP_OUTCOME_ENV_EXACT = '${{ steps.noop.outcome }}'
const PLUGIN_OUTCOME_ENV_EXACT = '${{ steps.plugin-core-tests.outcome }}'
const WEB_OUTCOME_ENV_EXACT = '${{ steps.web-guard-specs.outcome }}'

// Captured the same way (JSON.stringify(step.env.X) dumped from a parsed copy of the current file,
// pasted verbatim) for the CLASSIFIER step's own env — see Pin 6 (P1, third review round, 2026-07-26)
// for why these three were previously unpinned and what that gap allowed.
const EVENT_NAME_ENV_EXACT = '${{ github.event_name }}'
const BASE_SHA_ENV_EXACT =
  '${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || github.event.before }}'
const HEAD_SHA_ENV_EXACT = '${{ github.sha }}'

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
// Pin 1 (P2 correction, 2026-07-26): on.pull_request must carry NO event-narrowing key at all — not
// just paths/paths-ignore. The original version of this pin checked only those two keys; it did not
// notice that `types: [labeled]` (which REPLACES GitHub's default `[opened, synchronize, reopened]`
// set, so the context stops appearing on an ordinary new commit to a PR branch) or `branches:` /
// `branches-ignore:` (scoping the trigger to specific base/head branches) produce the exact same
// permanent-Pending failure this contract exists to prevent, through a different key. Pinning the
// absence of the FULL key set (rather than enumerating known narrowing keys one at a time, which would
// need updating every time GitHub adds a new one) closes the mutation CLASS, not just the two keys the
// original review happened to name.
// ---------------------------------------------------------------------------

test('on.pull_request exists and is a bare trigger with no event-narrowing key at all', () => {
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
    const keys = Object.keys(pr)
    assert.deepEqual(
      keys,
      [],
      `on.pull_request must carry ZERO event-narrowing keys (found: ${JSON.stringify(keys)}) — ` +
        '`paths`/`paths-ignore` are not the only keys that scope which pull_request events produce ' +
        'this context; `types` (replaces the default event-type set) and `branches`/`branches-ignore` ' +
        '(scopes by base/head branch) are the same class of gap through a different key, and this ' +
        'assertion is written to reject ANY key here, not an enumerated list of the ones named so far',
    )
  }
})

// ---------------------------------------------------------------------------
// Pin 2 (P3 correction, third review round, 2026-07-26): on.merge_group exists — otherwise a
// merge-queue entry never produces the context either. Made SYMMETRIC with Pin 1's "reject any
// narrowing key" treatment: the original version of this pin only checked `hasOwnProperty(on,
// 'merge_group')` and never looked inside the value, so both of the following stayed GREEN:
//   - `merge_group: { types: [] }` — an empty `types:` filters out the only event type GitHub's
//     `merge_group` trigger supports (`checks_requested`), so the trigger never actually fires for a
//     real merge-queue event — the "workflow never runs, context pending forever" failure mode this
//     whole contract exists to prevent, just reached through `types:` instead of a missing trigger.
//   - `merge_group: { types: [checks_requested], branches: [not-main] }` — `branches:` scopes which
//     merge-queue base branches produce the context, the exact same permanent-Pending mode Pin 1
//     forbids on `pull_request` via `branches`/`branches-ignore`, just unpinned on the merge_group half.
// Unlike `pull_request` (which needs zero keys — GitHub's default event-type set is already correct),
// `merge_group` legitimately needs `types: [checks_requested]` (the only type it supports) for the
// production workflow as it stands, so this pin cannot simply mirror Pin 1's "reject ANY key". Instead:
// the key set is pinned to EXACTLY `['types']` (rejecting `branches`/`branches-ignore`/anything else),
// and `types` itself is pinned to EXACTLY `['checks_requested']` (rejecting both the empty-array and
// any-other-value variants).
// ---------------------------------------------------------------------------

test('on.merge_group trigger exists and carries no key beyond the required types: [checks_requested]', () => {
  const on = onBlock()
  assert.ok(
    Object.prototype.hasOwnProperty.call(on, 'merge_group'),
    'on.merge_group must exist — without it a merge-queue entry never triggers this workflow and ' +
      'the integration-guard context is never produced for it, so it would wait forever once required',
  )
  const mg = on.merge_group
  assert.ok(mg === null || isPlainObject(mg), 'on.merge_group must be a bare/empty trigger or a mapping')
  if (isPlainObject(mg)) {
    const keys = Object.keys(mg)
    assert.deepEqual(
      keys,
      ['types'],
      `on.merge_group must carry EXACTLY the "types" key and no other (found: ${JSON.stringify(keys)}) ` +
        '— `branches`/`branches-ignore` (or any other key) scopes which merge-queue entries produce ' +
        'this context, the same permanent-Pending class Pin 1 forbids on pull_request, just through a ' +
        'different key on the merge_group half',
    )
    assert.deepEqual(
      mg.types,
      ['checks_requested'],
      `on.merge_group.types must be EXACTLY ["checks_requested"] (found: ${JSON.stringify(mg.types)}) ` +
        '— an empty array filters out the only event type GitHub\'s merge_group trigger supports, so ' +
        'the workflow would never actually fire for a real merge-queue event despite the trigger key ' +
        'being present',
    )
  }
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
// Pin 6 (P1, layer 3; EXACT-SHAPE correction 2026-07-26): the in-job scope classifier invokes the
// EXTRACTED, unit-testable script — not a reimplemented inline case-statement (which would silently
// drop out of sync with the behavioural tests below, since those test the script file directly, not
// whatever inline bash sits in the YAML) — AND the step's `run:` text is asserted BYTE-IDENTICAL to a
// pinned literal, not merely "contains this substring". Substring containment (`run.includes(...)`) is
// satisfied by a `run:` block that keeps the exact invocation line present but ALSO appends an extra
// line after it (e.g. an unconditional `echo "relevant=false" >> "$GITHUB_OUTPUT"`) that overwrites
// `steps.changes.outputs.relevant` regardless of what the script actually classified — this is mutation
// M4d's second half, proven RED-before-fix in PR #4614's review ledger. Exact equality catches ANY
// added/removed/reordered line, not just that specific bypass.
//
// EXTENDED (P1, third review round, 2026-07-26): the `run:` pin above proves the SCRIPT is still
// invoked byte-identically, but the classifier step's `env:` block (EVENT_NAME/BASE_SHA/HEAD_SHA — the
// script's only inputs) was entirely unpinned until now. That gap is a UNIVERSAL false negative, not a
// narrow one: on a real `pull_request` event, `github.sha` (HEAD_SHA) is a MERGE COMMIT, and
// `git diff-tree --root --no-commit-id -r <merge-sha>` (the `run:` block's own fallback branch, taken
// whenever `BASE_SHA` is empty or the all-zeros sentinel) emits ZERO paths for a merge commit — verified
// empirically against a real merge commit in this repo's own history, not asserted:
//   $ git diff-tree --root --no-commit-id --name-only -z -r 48a425044 | tr '\0' '\n' | wc -l
//   0
// So a mutation that hardcodes `env.BASE_SHA` to the all-zeros sentinel (leaving the `run:` text, which
// IS pinned, completely untouched) forces every `pull_request`/`merge_group` run down the empty-diff
// path regardless of what the PR actually changed — `classify()` receives an empty file list, returns
// `false`, and the no-op branch runs green. This is caught by NEITHER Door A (classify.mjs's own tests
// never see a merge-commit HEAD_SHA) NOR Door B (assertBranch() accepts `relevant=false` with the no-op
// branch having run to completion — that is exactly the state this mutation produces). Closed here by
// extending the same byte-identical-equality treatment already applied to `run:` to the three `env:`
// values, symmetric with Pin 9's treatment of the terminal step's `env:`.
// ---------------------------------------------------------------------------

test('the scope-detection step (id: changes) run: text and its EVENT_NAME/BASE_SHA/HEAD_SHA env values are byte-identical to the pinned literals', () => {
  const job = requireJob()
  const classifier = stepById(job, CLASSIFIER_STEP_ID)
  assert.ok(classifier, `job.${JOB_ID} must have a step with id: ${CLASSIFIER_STEP_ID}`)
  assert.equal(
    classifier.run,
    CLASSIFIER_RUN_EXACT,
    `the ${CLASSIFIER_STEP_ID} step's run: text must be byte-identical to the pinned literal — any ` +
      `deviation (an inline reimplementation, an appended line that bypasses the script's own ` +
      `$GITHUB_OUTPUT write, a dropped -z flag) fails this pin even if the required substrings are ` +
      `still present somewhere in the text`,
  )
  const env = isPlainObject(classifier.env) ? classifier.env : {}
  assert.equal(
    String(env.EVENT_NAME ?? ''),
    EVENT_NAME_ENV_EXACT,
    'env.EVENT_NAME must be EXACTLY `${{ github.event_name }}`',
  )
  assert.equal(
    String(env.BASE_SHA ?? ''),
    BASE_SHA_ENV_EXACT,
    'env.BASE_SHA must be EXACTLY the pinned `pull_request.base.sha || merge_group.base_sha || before` ' +
      'expression — a mutation that hardcodes this to the all-zeros sentinel (or any other constant) ' +
      'forces the classifier down its empty-diff fallback on every run regardless of what actually ' +
      'changed, and since HEAD_SHA is a merge commit on pull_request events, that fallback yields zero ' +
      'paths (see the mechanism documented above the test) — a universal false negative',
  )
  assert.equal(
    String(env.HEAD_SHA ?? ''),
    HEAD_SHA_ENV_EXACT,
    'env.HEAD_SHA must be EXACTLY `${{ github.sha }}`',
  )
})

// ---------------------------------------------------------------------------
// Pin 7 (EXACT-SHAPE correction 2026-07-26): a relevant change runs the full existing suite (both real
// steps gated on relevant=='true', located by their ACTUAL command content). The step-location match
// AND the full run: text are both now exact-equality, not substring containment. Substring containment
// was the mutation M17 exploited: prefixing the real command with `#` (commenting it out) still leaves
// `run.includes('pnpm --filter plugin-integration-core test')` true, because the substring is still
// textually present in the comment — the step "exists" by this pin's old standard while running
// nothing. Locating the step by exact `run ===` equality means a commented-out command simply does not
// match any step at all, and the "must exist" assertion fails instead of silently passing.
// ---------------------------------------------------------------------------

test('a relevant change runs the full existing suite (both real steps gated on relevant==true, run: text byte-identical)', () => {
  const job = requireJob()

  const pluginCoreStep = stepsOf(job).find((s) => isPlainObject(s) && s.run === PLUGIN_CORE_RUN_EXACT)
  assert.ok(
    pluginCoreStep,
    'a step whose run: text is byte-identical to the pinned `pnpm --filter plugin-integration-core ' +
      'test` literal must exist — a commented-out (`#`-prefixed) or otherwise altered copy does not ' +
      'match this exact-equality lookup, unlike the substring-containment check this replaces',
  )
  assert.equal(pluginCoreStep.id, PLUGIN_STEP_ID, `the plugin-integration-core test step must carry id: ${PLUGIN_STEP_ID}`)
  assert.equal(
    typeof pluginCoreStep.if === 'string' ? pluginCoreStep.if.trim() : null,
    RELEVANT_TRUE_IF,
    `the plugin-integration-core test step must be gated \`if: ${RELEVANT_TRUE_IF}\` — flipping ` +
      `this to =='false' (or removing it) would leave the no-op branch green while the real suite ` +
      `silently never runs on relevant changes`,
  )

  const vitestGuardStep = stepsOf(job).find((s) => isPlainObject(s) && s.run === WEB_GUARD_RUN_EXACT)
  assert.ok(
    vitestGuardStep,
    'a step whose run: text is byte-identical to the pinned integration web guard specs vitest ' +
      'literal must exist',
  )
  assert.equal(vitestGuardStep.id, WEB_STEP_ID, `the integration web guard specs step must carry id: ${WEB_STEP_ID}`)
  assert.equal(
    typeof vitestGuardStep.if === 'string' ? vitestGuardStep.if.trim() : null,
    RELEVANT_TRUE_IF,
    `the integration web guard specs step must be gated \`if: ${RELEVANT_TRUE_IF}\``,
  )
})

// ---------------------------------------------------------------------------
// Pin 8 (EXACT-SHAPE correction 2026-07-26): changes outside the guarded paths hit an explicit no-op
// SUCCESS (exit 0) — a real, executed, green step (kept for auditability — see the P2 correction in the
// header for why, and why NOT because a skipped step/job "wouldn't satisfy" the required context, which
// is false). The old regex `/(^|\s)exit 0(\s|$)/` also matches a commented-out `# ... exit 0` line
// (the `#` is whitespace-adjacent, not excluded by the pattern) — same M17-class gap as Pin 7. Exact
// equality on the full run: text closes it.
// ---------------------------------------------------------------------------

test('an irrelevant change hits an explicit no-op SUCCESS (exit 0), id: noop, run: text byte-identical', () => {
  const job = requireJob()
  const noop = stepById(job, NOOP_STEP_ID)
  assert.ok(noop, `job.${JOB_ID} must have a step with id: ${NOOP_STEP_ID}`)
  assert.equal(
    typeof noop.if === 'string' ? noop.if.trim() : null,
    RELEVANT_FALSE_IF,
    `the ${NOOP_STEP_ID} step must be gated \`if: ${RELEVANT_FALSE_IF}\``,
  )
  assert.equal(
    noop.run,
    NOOP_RUN_EXACT,
    'the no-op step run: text must be byte-identical to the pinned literal, which ends in an ' +
      'unconditional, uncommented `exit 0` — a `#`-commented-out `exit 0` or a reworded log line no ' +
      'longer matches',
  )
})

// ---------------------------------------------------------------------------
// Pin 9 (P1, layer 3; EXACT-EQUALITY correction 2026-07-26): the terminal safety-net step exists,
// id: assert-branch, gated EXACTLY `if: always()`, invokes the extracted assert-branch script
// byte-identically, and is wired to the three branch steps' outcomes plus the classifier's verdict via
// env — each env value now pinned by EXACT EQUALITY to its expected `${{ ... }}` expression, not
// `.includes(...)`. Substring containment let mutation M8b replace e.g.
// `env.RELEVANT: ${{ steps.changes.outputs.relevant }}` with an expression that still CONTAINS the
// substring `steps.changes.outputs.relevant` somewhere inside it but is constructed so it never
// actually YIELDS that value (`${{ false && steps.changes.outputs.relevant || 'true' }}` always
// evaluates to the literal `'true'`) — `env.RELEVANT.includes(...)` stayed green while assert-branch.mjs
// received a constant instead of the real classifier verdict. Exact equality on the whole expression
// closes this: any wrapper, fallback, or reordering changes the string and fails the pin. This is
// exactly the "token pinning must be exact-equal" doctrine this repo already applies elsewhere, now
// applied here too.
// ---------------------------------------------------------------------------

test('the terminal branch-assertion step exists, is gated if: always(), run: text and all four env values are byte-identical', () => {
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
  assert.equal(
    terminal.run,
    TERMINAL_RUN_EXACT,
    `the ${TERMINAL_STEP_ID} step's run: text must be byte-identical to the pinned literal`,
  )
  const env = isPlainObject(terminal.env) ? terminal.env : {}
  assert.equal(
    String(env.RELEVANT ?? ''),
    RELEVANT_ENV_EXACT,
    'env.RELEVANT must be EXACTLY `${{ steps.changes.outputs.relevant }}` — an expression that merely ' +
      'contains that substring while wrapping it in a fallback/short-circuit that never yields the ' +
      'real value must fail this pin (mutation M8b)',
  )
  assert.equal(String(env.NOOP_OUTCOME ?? ''), NOOP_OUTCOME_ENV_EXACT, 'env.NOOP_OUTCOME must be EXACTLY `${{ steps.noop.outcome }}`')
  assert.equal(
    String(env.PLUGIN_OUTCOME ?? ''),
    PLUGIN_OUTCOME_ENV_EXACT,
    'env.PLUGIN_OUTCOME must be EXACTLY `${{ steps.plugin-core-tests.outcome }}`',
  )
  assert.equal(String(env.WEB_OUTCOME ?? ''), WEB_OUTCOME_ENV_EXACT, 'env.WEB_OUTCOME must be EXACTLY `${{ steps.web-guard-specs.outcome }}`')
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
// Pin 12 (P3, third review round, 2026-07-26): none of the files this contract depends on may contain
// a raw NUL (0x00) byte. This is not a hypothetical: at `fd48ecf91` (before this same PR's own
// `b1aae0244` fix), `integration-guard-classify.mjs` line 63 had a literal raw NUL byte where the
// two-character `\0` escape belonged, which made git/GitHub classify the whole file as BINARY — no
// patch rendered in review, `additions=0 deletions=0` from the API, even though every sibling file in
// the PR had a real diff. That defect recurred once already in this exact line and was fixed by hand
// each time, with nothing to stop it recurring a third time. One-line-per-file pin, closes the class.
// ---------------------------------------------------------------------------

test('none of the files this contract reads/imports contain a raw NUL (0x00) byte', () => {
  const filesToCheck = [
    ['integration-guard.yml', WORKFLOW_PATH],
    ['integration-guard-guarded-paths.mjs', join(repoRoot, 'scripts/ops/integration-guard-guarded-paths.mjs')],
    ['integration-guard-classify.mjs', join(repoRoot, 'scripts/ops/integration-guard-classify.mjs')],
    ['integration-guard-assert-branch.mjs', join(repoRoot, 'scripts/ops/integration-guard-assert-branch.mjs')],
  ]
  for (const [label, path] of filesToCheck) {
    const bytes = readFileSync(path)
    assert.equal(
      bytes.includes(0),
      false,
      `${label} contains a raw NUL (0x00) byte — this is the exact defect class that made ` +
        `integration-guard-classify.mjs render as a BINARY file (no patch, additions=0/deletions=0) in ` +
        `PR review before this fix; a raw NUL anywhere in a source string (e.g. a mistyped '\\0' ` +
        `escape) silently makes the WHOLE FILE invisible to diff/review tooling, not just the one line`,
    )
  }
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
// NEW (Door A, P1 correction 2026-07-26): the CLI test above only asserts STDOUT — it never sets
// $GITHUB_OUTPUT, so it does NOT exercise the `appendFileSync(outputFile, ...)` branch in
// integration-guard-classify.mjs's CLI entrypoint at all. That branch is exactly what mutation M4d
// neutered while leaving everything the tests above check untouched (stdout still prints
// `relevant=true`, exit code still 0): with the append call removed, `$GITHUB_OUTPUT` stays EMPTY,
// which — combined with a bypass line elsewhere in the workflow step forcing `relevant=false` — let
// the classifier's real verdict be silently discarded while every prior assertion stayed green. These
// two tests spawn the real CLI with $GITHUB_OUTPUT pointed at a real temp file and assert its EXACT
// final byte content (not `.includes(...)` — a bypass that appends a SECOND, contradicting line after
// the script's own line would still satisfy a containment check). This is what proves the script
// writes to $GITHUB_OUTPUT "exactly once, via the script only" — the property the review asked this
// pin to establish, independent of anything in the workflow YAML.
// ---------------------------------------------------------------------------

test('classify() CLI: a relevant diff writes $GITHUB_OUTPUT with EXACTLY "relevant=true\\n" and nothing else', () => {
  const NUL = String.fromCharCode(0)
  const scriptPath = join(repoRoot, 'scripts/ops/integration-guard-classify.mjs')
  const tmpDir = mkdtempSync(join(tmpdir(), 'integration-guard-output-'))
  const outputFile = join(tmpDir, 'github_output')
  writeFileSync(outputFile, '')
  try {
    const res = spawnSync('node', [scriptPath], {
      input: Buffer.from(['plugins/plugin-integration-core/src/x.ts'].join(NUL) + NUL),
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outputFile },
    })
    assert.equal(res.status, 0, `classify CLI must exit 0: stderr=${res.stderr}`)
    assert.equal(res.stdout.trim(), 'relevant=true')
    const written = readFileSync(outputFile, 'utf8')
    assert.equal(
      written,
      'relevant=true\n',
      'GITHUB_OUTPUT must contain EXACTLY "relevant=true\\n" and nothing else — an empty file here ' +
        '(with stdout/exit-code still green) is the M4d "suppressed write" false-green; a SECOND line ' +
        'appended after a correct first line is the M4d "then write relevant=false" bypass, and this ' +
        'exact-content check (not a substring check) rejects either',
    )
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('classify() CLI: an irrelevant diff writes $GITHUB_OUTPUT with EXACTLY "relevant=false\\n" and nothing else', () => {
  const NUL = String.fromCharCode(0)
  const scriptPath = join(repoRoot, 'scripts/ops/integration-guard-classify.mjs')
  const tmpDir = mkdtempSync(join(tmpdir(), 'integration-guard-output-'))
  const outputFile = join(tmpDir, 'github_output')
  writeFileSync(outputFile, '')
  try {
    const res = spawnSync('node', [scriptPath], {
      input: Buffer.from(['README.md'].join(NUL) + NUL),
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outputFile },
    })
    assert.equal(res.status, 0, `classify CLI must exit 0: stderr=${res.stderr}`)
    assert.equal(res.stdout.trim(), 'relevant=false')
    const written = readFileSync(outputFile, 'utf8')
    assert.equal(written, 'relevant=false\n', 'GITHUB_OUTPUT must contain EXACTLY "relevant=false\\n" and nothing else')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
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
