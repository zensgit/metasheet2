# Input-regex length gate and shape warning — verification (slice H-3, route (ii))

**Status: PROPOSED.** Date: 2026-09-25 (round 2 appended the same day, §7). Base: `origin/main` @ `e046a21c0a0110fbe22ca765852f1e053d90c0cb`.
Branch: `fix/input-regex-redos-route-ii`. Design: `input-regex-redos-route-ii-design-20260925.md`.

The counts in §1 and the mutation tables in §3 are the round-2 numbers (the round-1 numbers they
replace are in the git history of this file); every other section states which round it describes.

All timings are `process.hrtime` / `performance.now()` wall-clock on one machine (Node
v25.9.0, aarch64) and are machine-relative. The evidence is the **contrast** between the two
columns of each table, not the constants; every threshold in a test is set so that the contrast,
not the absolute number, decides it (§2.3).

## 0. Environment

- One-shot worktree on the base, node_modules shared read-only from the canonical checkout.
- No database (`createdb` 0, `DATABASE_URL` unset — the mechanism under test is in-process).
- Only the files named in §1 were run; no whole-package or workspace-wide test run.

## 1. Suites

```
cd packages/core-backend && CI=true npx vitest run \
  src/formula/__tests__/regex-safety.test.ts \
  tests/unit/user-regex-limits-three-copy-parity.test.ts \
  tests/unit/field-validation.test.ts tests/unit/formula-engine.test.ts \
  tests/unit/field-validation-wiring.test.ts tests/unit/formula-1a-text-date-expansion.test.ts \
  --config vitest.config.ts --retry=0
```

| file | tests | note |
|---|---|---|
| `src/formula/__tests__/regex-safety.test.ts` | 115 | new: gate, "before compile", shape scanner, log-not-gate, L1/L2 equivalence + refusals, timing (own `describe`); round 2 added the nested `SUBSTITUTE` / `REGEX*` pins (invalid and over-limit, `LEN` and `IFERROR`) and split the `SUBSTITUTE` refusal cases out as throws |
| `tests/unit/user-regex-limits-three-copy-parity.test.ts` | 28 | new: constants + one table through backend / web / plugin copies; plugin end-to-end; round 2 added the `/`-bearing at-limit pattern through all three copies, the `RegExp`-instance fallback, and the form's own caller (`validateFormField`) |
| `tests/unit/field-validation.test.ts` | 72 | existing neighbour, unchanged |
| `tests/unit/formula-engine.test.ts` | 87 | existing neighbour, unchanged |
| `tests/unit/field-validation-wiring.test.ts` | 5 | existing neighbour, unchanged |
| `tests/unit/formula-1a-text-date-expansion.test.ts` | 17 | existing neighbour (mentions `SUBSTITUTE` / `REGEXREPLACE`), unchanged; added to the set in round 2 |
| **total** | **324 passed (324)** | |

Web lane (not part of the set above; its own root):
`cd apps/web && CI=true npx vitest run tests/formViewValidation.spec.ts --retry=0` → **17 passed (17)**
(`validateFormField`: the gate in front of the pattern, and the form's other rules unchanged by the extraction).

Plugin chain file (already in `plugins/plugin-integration-core/test-chain.txt`, not edited in round 2):
`node plugins/plugin-integration-core/__tests__/transform-validator.test.cjs` → `[pass]`
(extended in round 1 with section 6: at-limit accepted, over-limit `PATTERN_NOT_EVALUATED` with reason,
over-limit pattern, `INVALID_RULE` precedence, prompt return on an over-limit quadratic subject).

Type checks (round 2 tree): `packages/core-backend` `npx tsc --noEmit -p tsconfig.json` → exit 0, no output;
`apps/web` `npx vue-tsc --noEmit -p tsconfig.app.json` → exit 0, no output.

Whole-package run (round 2 tree, no database, `DATABASE_URL` unset):
`CI=true pnpm --filter @metasheet/core-backend test -- --run --pool=forks --poolOptions.forks.maxForks=3`
→ **Test Files 983 passed | 175 skipped (1158); Tests 16130 passed | 1615 skipped (17745)**, exit 0, 64 s.
The skipped files are the `describeIfDatabase` suites; both new files (143 tests) are in the passed set.

## 2. Timing

### 2.1 Inputs

- Quadratic trim idiom `^\s+|\s+$` (and its tail half `\s+$` where a global pattern is not
  wanted) on the subject `'Z' + ' '.repeat(N) + 'Z'`. This idiom's cost is quadratic in the
  run of spaces; it is the shape the census's instrument controls used. It is benign in the
  sense that it terminates; it is the right probe for a **length** gate because its cost is a
  function of length alone.
- Linear control `^[a-z]+$` on `'a'.repeat(N)`.

### 2.2 Readings

Pre-image = the base's own sinks (`e046a21c0`), measured with a probe that calls the registered
functions and `validateRecord` directly. Post-image = this branch.

| sink | N | pre-image | post-image | post-image result |
|---|---|---|---|---|
| `REGEXMATCH` | 100000 | 4190.8 ms | 0.0 ms | `#ERROR!` (refused: subject over limit) |
| `REGEXREPLACE` | 100000 | 4145.9 ms | 0.0 ms | `#ERROR!` |
| `REGEXEXTRACT` | 100000 | 4128.5 ms | 0.0 ms | `#ERROR!` |
| `SUBSTITUTE` | 100000 | 4111.9 ms | 0.0 ms | thrown → whole formula `#ERROR!` (round 2; round 1 returned the sentinel) |
| field-validation `pattern` | 100000 | 4153.1 ms | 0.1 ms | `valid:false`, refusal message |
| linear control | 100000 | 0.2 ms | 0.0 ms | `#ERROR!` (over limit) |
| the five sinks above | 10001 (one over) | — | 0.0–0.1 ms | refused |
| the five sinks above | 10002 (subject `Z`+10000 spaces+`Z`) | 44.8–45.9 ms | refused | — |
| linear control | 10000 (at limit) | 0.1 ms | 0.1 ms | `true` (real answer) |
| the five sinks above, trim idiom | 9998 spaces (subject exactly at limit) | 41.3–43.8 ms | 41.3–43.8 ms | real answer (`false` / replaced text / `valid:false` with the format message) |

The last row is what the limit still admits: the quadratic idiom at exactly the limit runs to
completion in tens of milliseconds on this machine. That cost is a property of the limit, not
of the gate, and it is pinned only loosely (< 2000 ms) to document it.

### 2.3 Thresholds and host differences

The timing `describe` asserts each over-limit case returns in **< 500 ms**. On this machine the
guarded path is a length comparison (0.0–0.1 ms) and the unguarded path is 4.1–8.4 s, so the
threshold sits > 1000× above the former and > 8× below the latter. A slower host moves the
unguarded number up and leaves the guarded one where it is; the gap only widens. A host on
which a length comparison takes 500 ms would fail the case, and would be failing much else.

## 3. Mutations

Every mutation: `cp` backup → scripted edit with an asserted match count → run the two new files
+ the plugin chain file → `cp` restore → `cmp` byte-equal (any mismatch aborts the campaign).
After the campaign the full §1 set was re-run: **293 passed (293)**, plugin `[pass]`.

| # | mutation | red | where |
|---|---|---|---|
| M1 | `REGEXMATCH` back on a bare `new RegExp(...).test` | 3 | subject-over, pattern-over, **timing 4164 ms** |
| M2 | `SUBSTITUTE` back on a bare `new RegExp(..., 'g')` | 3 | subject-over, pattern-over, **timing 8380 ms** |
| M3 | field-validation rule back on a bare `new RegExp(...).test` | 4 | three refusal-message cases, **timing 4108 ms** |
| M4 | backend: subject-length check removed | 14 | parity (backend row), gate, `runUserRegex`, 4× L1 subject-over, 2× L2, **5 timing cases 4136–8361 ms** |
| M5 | backend: pattern-length check removed | 11 | parity (3 backend rows), gate ×2, "before compile", 4× L1 pattern-over, L2 pattern-over |
| M6 | shape warning turned into a refusal | 2 | "evaluates a flagged pattern unchanged", "still evaluates when the sink throws" |
| M7 | gate moved after `new RegExp` | 1 | "refuses an over-length pattern BEFORE compiling it" |
| M8 | web copy: subject limit changed | 2 | parity: web constants, web "subject one over" |
| M9 | plugin copy: subject-length check removed | 2 + chain | parity: plugin "subject one over", plugin end-to-end; plugin chain file `[fail]` |
| M10 | L2: refusal message dropped (custom/format message used) | 4 | three refusal-message cases, L2 timing case (asserts the message names the limit) |
| M11 | warning de-duplication removed | 2 | "does not log a second time", "memory bounded" |
| M12 | scanner treats optional atoms as mandatory | 1 | the leading-optional-atom row of the flagged table |
| M13 | scanner never reports quantified alternation | 5 | the five alternation rows |

Each mutation was confirmed to have changed at least one file before the run (a no-op edit is
counted as VOID and does not appear above; none occurred).

The table above is round 1. In round 2 the `SUBSTITUTE` cases changed shape (a refusal is now a
throw), so M2's red set is now the one shown as MR5 below; the other rows were not re-run.

### 3.1 Round 2

Same procedure. The run is the two new backend files (115 + 28 = 143 tests); MR2 / MR5 add the
plugin chain file, MR3 adds the web spec (17 tests).

| # | mutation (restores the round-1 / pre-fix behaviour) | red | where |
|---|---|---|---|
| MR1 | `SUBSTITUTE` returns `'#ERROR!'` instead of throwing (round-1 behaviour; P2-1) | 7 / 143 | `LEN(SUBSTITUTE(invalid))` → `7`, `IFERROR(SUBSTITUTE(invalid))` → `"fb"`, the direct-call "throws" case, the three nested over-limit rows, timing `SUBSTITUTE` (returned instead of threw) |
| MR2 | plugin gate back on `regexp.source.length` (P3-2) | 2 / 143; chain still `[pass]` | parity "AT the limit, all three copies evaluate" (plugin refuses with length 7996), "one over … report the STRING length" (plugin reports 7998). The chain file has no `/`-bearing fixture, so it does not see this — the pin lives in the parity file |
| MR3 | `findUserRegexLengthRefusal(...)` replaced by `null` in `formViewValidation.ts` (P3-1) | 3 / 143 + **3 / 17** (web) | parity: the form's two rows + the `/`-bearing one-over row (the form answers "格式不正确" instead of refusing); web spec: subject one over, pattern one over, both over |
| MR4 | (prose, P3-3) — no test can turn red; checked instead by a phrase scan over both MDs, the three gate sources, the three test files and the web spec: after the edit the only hit is a substring false positive of the scan itself | n/a | §7 |
| MR5 | `SUBSTITUTE` back on a bare `new RegExp(..., 'g')` (round-1 M2 replayed on the round-2 tests) | 5 / 143; chain `[pass]` | the direct-call "throws" case, the three nested over-limit rows, timing `SUBSTITUTE` **3827 ms** (returned a real answer). The nested invalid-pattern rows stay green — the bare sink threw on an invalid pattern too, which is the point of option (i) |

All five restored by `cp` and `cmp` byte-equal; `git status --porcelain` unchanged before / after.

## 4. Equivalence evidence

- Tables through the public entry points: 11 formula-text cases (`engine.calculate`), 6 rule
  cases + custom-message + flags (`validateFieldValue`).
- Fuzz, seeded (mulberry32), 2000 pairs per site family, comparing the registered
  `REGEXMATCH` / `REGEXEXTRACT` / `REGEXREPLACE` / `SUBSTITUTE` functions and the rule with a
  verbatim copy of the pre-image implementation. The corpus has no quantified group (linear by
  construction); the test asserts > 500 distinct patterns and > 50 of each verdict, so a
  degenerate corpus fails.
- Boundary: at-limit inputs get the real answer at every sink; one-over inputs are refused.

## 5. CI collection (not re-verified on CI — no PR)

- The two new backend test files fall under `packages/core-backend`'s default vitest glob, which is
  what the required `test (20.x)` job runs (`pnpm --filter @metasheet/core-backend test`); the
  census gate established this collection path with a positive control on the earlier branch.
  Not re-run on CI here.
- The plugin file is already listed in `test-chain.txt`; no chain edit, no workflow edit, no
  provenance pin change (`validator.cjs` is not a pinned runtime file).
- `apps/web`: the util **and** (round 2) the form's `validateFormField` are exercised from the
  backend parity test, which the required `test (20.x)` job collects. The web spec
  `apps/web/tests/formViewValidation.spec.ts` is **not collected by CI**: every `apps/web` vitest
  step in `.github/workflows/` runs an explicit name list (`multitable-web-guard`,
  `approval-web-guard`, `attendance-web-guard`, …) and no workflow runs the package's bare `test`
  script. This round does not edit workflows; whether to add the spec to a run-list is for the
  owner. `FormView.vue` itself is still only type-checked (`vue-tsc`), not mounted.

## 6. NOT RUN

- No database, no HTTP, no cross-request victim latency measurement; all readings are
  in-process.
- The `apps/web` spec lane as CI runs it (only the one new spec was run locally); the public form
  was not driven in a browser and `FormView.vue` was not mounted.
- Whole-package or workspace test runs; only the files in §1.
- Lint: `packages/core-backend` has no `lint` script and `apps/web`'s lint script enumerates a
  fixed file list that does not include the changed files.
- The stored populations of §6.2 in the design MD (fields with an explicit `pattern` rule and no
  `maxLength`; patterns over 4000 characters) — not countable from the code.
- PG / OS axes — irrelevant to the mechanism.

## 7. Round 2 (2026-09-25)

- What changed: see design §8 (P2-1 / P3-1 / P3-2 / P3-3). Nothing route-level: none of the
  design §5 options (or the V8 flag the gate review added) is implemented, no limit value changed,
  L2 message precedence unchanged, no notification added, no workflow edited.
- **Commit message correction.** The body of `d55a31be9` says "Every place that compiles a
  caller-supplied string into a RegExp now goes through one length gate". That sentence is
  overstated: the gate covers the sites in design §1 (the two confirmed sites and the two sibling
  copies) and no other `new RegExp` sink. Commit messages are not rewritten on this branch; this
  note is authoritative over that sentence.
- `IFERROR` nesting, measured rather than assumed: with a refused `SUBSTITUTE` as its first
  argument, `=IFERROR(SUBSTITUTE("abc","[","x"),"fb")` is `#ERROR!` on the base and on this tree
  (the engine evaluates all arguments before calling the function, so the throw never reaches
  `IFERROR`); `=IFERROR(REGEXREPLACE("abc","[","x"),"fb")` is `"fb"` on both. Both pinned.
- Phrase scan (P3-3): `grep -n -i -E` for "every (caller|place|entry)", "all (entry points|call
  sites|sites)", "is not refused here", "nothing … accepts", "cannot be (bypassed|reached)",
  "fully (covered|protected)", "guarantee", "impossible", "no way to", "complete(ly)
  (protect|cover)" over both MDs, `regex-safety.ts`, `userRegexLimits.ts`, `validator.cjs`,
  `formViewValidation.ts`, the two backend test files and the web spec. Before: 2 real hits
  (design §0 "every", `regex-safety.ts` "not refused here"). After: 0 real hits; the scan's one
  remaining line is design §5 row (d) "the call sites' synchronous contract", matched through the
  substring "all sites" and not an over-claim.
- Timing readings on this tree, same idiom and subjects as §2: every guarded over-limit case
  0.0–0.1 ms; the bare `SUBSTITUTE` under MR5 3827 ms (the threshold is 500 ms).
