# H-2: arm `EXPECT_DB` on the `plugin-tests.yml` approval real-DB step

Status: **CANDIDATE — no DDL, awaiting owner ratification.** Prepared 2026-09-21 on branch
`ci/plugin-tests-approval-expect-db-arming` (worktree from `origin/main`). This document and its
companion verification report describe a CI-wiring-only change: one workflow env key, a
mechanical s6a pin recompute, and one new unit guard. No schema, no runtime flag, no production
code path touched.

## 0. Correction to the originating brief

The brief that produced this slice asserted "8 cancel-round real-DB test files" carry the
anti-skip-green sentinel and are wired into the affected step. A repo-wide census (below) found
**3 files**, none named or scoped to "cancel round" — they are Lock-10 (S2) `approval_comments`,
Lock-10 (S1) `approval-instance-readability-s1`, and Lock-9 attachment processing. This document
reports the census as found, not the brief's count.

## 1. Census

Command: `grep -rl "itIfExpectDb = process.env.EXPECT_DB" packages/core-backend/tests` finds
**46 files** repo-wide carrying the sentinel (45 real-DB suites + one meta/unit test that asserts
the detector pattern itself, `approval-ci-coverage-enumeration.test.ts`).

Cross-referencing that list against every occurrence of each basename anywhere in
`.github/workflows/plugin-tests.yml` finds exactly **3 files** that this workflow runs, and all
three land in the **same single step**:

| File | Sentinel at | Step in `plugin-tests.yml` |
|---|---|---|
| `tests/integration/approval-instance-readability-s1.db.test.ts` | line 50 | `id: approval-real-db-integration` (line ~1573) |
| `tests/integration/approval-comments.db.test.ts` | line 56 | same step |
| `tests/integration/approval-lock9-process-attachments-realdb.db.test.ts` | line 35 | same step |

That step — `"Run approval real-DB integration (…)"`, stable `id: approval-real-db-integration`,
gated `if: matrix.node-version == '20.x'` inside the `test` job (a required check) — runs **77**
`tests/integration/*.test.ts` files whole-file. Only the 3 above reference `EXPECT_DB` anywhere in
their source; the other 74 do not.

`grep -n EXPECT_DB .github/workflows/plugin-tests.yml` returns **zero hits** before this change —
no step in this workflow has ever exported it, on any lane.

### Sentinel semantics (from `approval-comments.db.test.ts:29-32`, identical shape in all 46)

```ts
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})
```

- Defined at **module top level**, outside any `describeIfDatabase` gate — so unlike the rest of
  the file's tests, this one test's `it`-vs-`it.skip` choice does not depend on `DATABASE_URL`.
- The value is read with **strict string equality** (`=== '1'`) — not a truthy check. `'0'`,
  `'true'`, or a bare unquoted `1` (YAML would parse that as a number) do **not** arm it.
- When armed (`EXPECT_DB === '1'`) and `DATABASE_URL` is falsy, the test body's own assertion
  fails — the file goes **RED**, not skip-green.
- When unarmed (today's state for this step), the test is `it.skip`, unconditionally, regardless
  of `DATABASE_URL`. It contributes nothing either way — it is inert, not merely weak.

**Why 74 of 77 files are unaffected by adding the key**: none of them contain the text
`process.env.EXPECT_DB` anywhere (verified by grep over each file), so an unread environment
variable is a no-op for them by construction.

## 2. The fix

One line added to the step's `env:` block (plus an explanatory comment), `EXPECT_DB: '1'`,
scoped to `id: approval-real-db-integration` only. No other step touched.

```diff
         if: matrix.node-version == '20.x'
         env:
           DATABASE_URL: postgresql://postgres@localhost:5432/metasheet_test
+          # Arms this step's embedded anti-skip-green sentinels (…)
+          EXPECT_DB: '1'
         run: |
           : "${DATABASE_URL:?DATABASE_URL is required for approval real-DB integration}"
```

Verified against the shared step-shape contract (`scripts/ops/ci-realdb-step-contract.mjs`,
`requireExecutableRealDbStep`) — it asserts `id`, the `20.x` gate, a literal `DATABASE_URL`, and a
real `vitest --config vitest.integration.config.ts` invocation, but never an exact env key SET —
adding a key does not perturb it. Re-ran it and its dependents (`t2gate-collision-mechanism-ci-
wiring.test.mjs`'s 40 synthetic cases, `pb4-2/3/4`, `b4-department-bindings`,
`b7-round2`) after the edit: all green.

## 3. What this fix does and does not close

**Does close**: the specific gap where this step's shell has `DATABASE_URL` set (the common,
intended case) but the value silently fails to reach the vitest worker process, or is truthy-but-
wrong — the embedded sentinel now actually runs in that lane and would catch it, instead of being
permanently `it.skip`ped.

**Does NOT close, and was never claimed to**: a `DATABASE_URL` that is unset or empty **in the
step's own shell** never reaches vitest at all — the step's pre-existing guard

```sh
: "${DATABASE_URL:?DATABASE_URL is required for approval real-DB integration}"
```

aborts the shell (`bash -e`) before the `pnpm … vitest …` line runs, independent of `EXPECT_DB`
and independent of this fix (reproduced against the pre-fix file too — §5.2 below). Practically,
`pool: 'forks'` in `vitest.integration.config.ts` carries no custom `env:` override, so a forked
worker inherits the parent shell's environment verbatim; §5.1 confirms the shell-set var does
reach the worker today. The sentinel is deliberately a **second, independent door** at the vitest-
worker layer, consistent with the same pattern already shipped in the 45 sibling suites and their
dedicated `approval-realdb-*.yml` lanes (see `feedback_failclosed_doors_cover_for_each_other`) —
this PR arms that second door for the one place it had never been wired, it does not claim the
first door was broken.

## 4. Evidence: 2×2 matrix (DB present/absent × `EXPECT_DB` set/absent)

Run at the **vitest-invocation layer** (`npx vitest --config vitest.integration.config.ts run
<the 3 files>`), because the step-level `:?` guard makes cells with `DATABASE_URL` absent
untestable at the full-step level (see §3 and §5.2) — this is the layer the sentinel itself
actually evaluates at, per `feedback_realdb_test_two_point_wiring.md`'s prescribed probe. DB:
one-time `ms2testbed`-owned Postgres 15.17 database `metasheet2_h2_20260922`, migrated with the
same `MIGRATION_EXCLUDE` list `approval-realdb-comments.yml` uses (CI's dedicated lane runs
`postgres:16`; this is a local PG15 vs. CI PG16 delta, noted not hidden).

| | `EXPECT_DB` unset (pre-fix behavior for this step) | `EXPECT_DB=1` (post-fix) |
|---|---|---|
| **`DATABASE_URL` present** | (iv) exit 0. `3 passed \| 0 skipped` files, `121 passed \| 3 skipped` tests — only the 3 sentinel tests themselves skip; all substantive coverage runs identically either way. | (i) exit 0. `3 passed` files, **`124 passed`** tests — sentinel included, no skip. |
| **`DATABASE_URL` absent** | (iii) **exit 0** — skip-green. `1 passed \| 2 skipped` files, `22 passed \| 102 skipped` tests. This is the baseline hole: two of three files report nothing but the process still exits 0. | (ii) **exit 1** — red. `3 failed` files, `3 failed \| 22 passed \| 99 skipped` tests. Failure: `AssertionError: expected undefined to be truthy` at each sentinel assertion. |

Reading the grid: fixing the arming turns column-2 red exactly where column-1 was silently green
(row "absent"), and is a no-op on the row where DB is present (121 vs. 124 — the delta is only the
3 sentinel tests, nothing else moves). That is the mutation proof requested by the task brief:
(iii)→(ii) is the same env-line delete/restore this document's §5.3 performs on the real file.

## 5. Full-step-level reproduction (production shell flags)

Per `feedback_ci_step_shell_flags_must_be_reproduced.md`: GitHub runs `run:` blocks with
`bash --noprofile --norc -eo pipefail`, not a hand-copied `bash script.sh`. The `run:` text below
was extracted from the **parsed** YAML (`python3`+`PyYAML` via `yaml.safe_load(...)['jobs']['test']
['steps']`, filtered to `id == 'approval-real-db-integration'`), never hand-transcribed.

### 5.1 DB present, real command, both env keys — sanity that the shell path matches §4 row 1

Not separately re-run at full-step granularity beyond §4's vitest-layer cell (i)/(iv); §4 already
demonstrates shell-set env reaching the vitest fork-pool worker (pool inherits `process.env`, no
override in `vitest.integration.config.ts`).

### 5.2 `DATABASE_URL` unset, extracted `run:` text, production flags

```
$ env -u DATABASE_URL bash --noprofile --norc -eo pipefail /tmp/extracted-run.sh
exit=1
extracted-run.sh: line 1: DATABASE_URL: DATABASE_URL is required for approval real-DB integration
```

This aborts on line 1 — before `pnpm … vitest …` is reached — **identically whether or not
`EXPECT_DB` is armed**, because it is the pre-existing `:?` guard, not the sentinel, firing. This
is the honest answer to "what does removing `DATABASE_URL` do to this step": it was already fail-
loud, for an unrelated reason, before and after this PR. The mutation that this PR's fix actually
guards against is not "shell-level `DATABASE_URL` unset" (already covered by `:?`) but "value
present in the shell yet absent/wrong by the time `describeIfDatabase`/`itIfExpectDb` evaluate it
inside the vitest worker" — see §3.

### 5.3 Mutation: env line deleted from the real file, restored, byte-compared

```
$ cp .github/workflows/plugin-tests.yml /tmp/plugin-tests.yml.fixed
$ cp /tmp/plugin-tests.yml.orig .github/workflows/plugin-tests.yml   # pre-fix version
$ npx vitest run tests/unit/plugin-tests-workflow-approval-realdb-expect-db-arming.test.ts
  … 2 failed | 4 passed (6)   # the GUARD test and one MUTATION sanity assertion both correctly red
$ cp /tmp/plugin-tests.yml.fixed .github/workflows/plugin-tests.yml
$ cmp /tmp/plugin-tests.yml.fixed .github/workflows/plugin-tests.yml
  (no output — byte-identical)
$ npx vitest run tests/unit/plugin-tests-workflow-approval-realdb-expect-db-arming.test.ts
  … 6 passed (6)
```

This is the working-tree-level version of the §4 (iii)→(ii) flip: deleting the arming line
reproduces the pre-fix, skip-green-vulnerable state, and the new unit guard (§6) detects it.

## 6. New guard

`packages/core-backend/tests/unit/plugin-tests-workflow-approval-realdb-expect-db-arming.test.ts`
(new file, auto-collected by the default `pnpm --filter @metasheet/core-backend test` / CI's
"Run core-backend tests" step — confirmed present in a full `CI=true` run of that command, 6/6
passing among 980 passed / 175 skipped files, 15897/17512 tests).

Design choices:
- **Real YAML parsing (`js-yaml`), not regex/text matching**, for the pass/fail decision: the step
  is located via the parsed `jobs.test.steps[].id`, and the arming check reads the parsed
  `step.env.EXPECT_DB`. Per `feedback_source_text_assertions_are_not_behaviour`, a regex over the
  raw workflow bytes would prove a string appeared somewhere, not that it landed on the right key.
  The one place this guard reads raw text is deriving *which* `tests/integration/*.test.ts` tokens
  the step's `run:` script names — that only builds the population to check, not the verdict.
- **Derived population, not a hardcoded 3-file list**: the guard scans every file the step
  actually runs for the `itIfExpectDb` source pattern, rather than hardcoding today's three
  filenames. Per `finding_o2_census_token_list_enumeration_trap` /
  `finding_guard_closed_over_the_wrong_world`, a hardcoded list stops protecting the day a 4th
  sentinel-bearing file joins this step without anyone touching the guard; the derived form keeps
  covering that case for free. A separate assertion still documents today's known 3-member set
  (via `arrayContaining`, which can only grow, never shrink the population it accepts).
- **Strict `'1'` equality asserted, with two discriminating mutations**: one test proves the guard
  goes red when the `EXPECT_DB` key is deleted; a second proves it goes red when weakened to the
  string `'0'` — `'0'` is JS-truthy, so a careless `if (envVal)` check would wrongly accept it. Per
  `feedback_count_guard_and_fake_switch_test`, a check must be shown to discriminate the exact
  wrong variant it claims to catch, not just some variant.
- **Guard reversal proven red against the real file**, not only via in-memory mutation of the
  parsed object: §5.3 above swaps in the literal pre-fix `plugin-tests.yml` and shows the guard
  failing, then restores and byte-compares.

## 7. s6a pin impact

`plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json`'s
`evidenceFiles.pluginTestsWorkflow` field pins a raw SHA-256 of `.github/workflows/plugin-tests.yml`
(`sealed-export-package-provenance.test.cjs`'s `frozenManifestIsIndependentOfWorkingTreeMutation`
check). Editing that workflow file **necessarily** changes this hash — per
`feedback_s6a_pin_is_a_merge_bottleneck`, this is a case where the change legitimately must touch
the pinned surface (unlike that note's #5016 precedent, where the fix was to move an unrelated
test off `plugin-tests.yml` instead); recompute is the correct response, not an escape hatch.

Recomputed the **official** way — `computePackageProvenancePinSet(repoRoot)` (exported by
`sealed-export-package-provenance.cjs`) — and wrote only the one field it produced
(`evidenceFiles.pluginTestsWorkflow`) back into the existing JSON, leaving every other field
byte-identical. Verified: `diff` between the pre- and post-recompute JSON shows **exactly one
line changed** (old vs. new hash), and `node
plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs` is green
after the recompute (and was confirmed red — `SEALED_EXPORT_INTERNAL_ERROR` — immediately after
the workflow edit and before the recompute, per that note's documented failure signature).

No hash in this PR was hand-written.

## 8. Out of scope

- The other 42 sentinel-bearing files not run by `plugin-tests.yml`: each already has (per the
  `approval-realdb-comments.yml` pattern inspected for this design) its own dedicated
  `approval-realdb-*.yml` lane with `EXPECT_DB: '1'` at job level — that arming was not part of
  this gap and is untouched.
- `approval-ci-coverage-enumeration.test.ts`'s W6/W7 classification logic: inspected to confirm it
  does not assert plugin-tests.yml's env key set for this step (it only tracks whole-file
  membership and each suite's own sentinel text, both unaffected) — not modified.
- Any change to `vitest.integration.config.ts` env handling, or to the shell-level `:?` guard —
  both already do their job independently of this fix (§3, §5.2).
- Any DDL, runtime flag, or production code path. None touched.
- Whether the s6a pin recompute in this PR needs a merge-window coordination call (owner
  decision — see PR body).
