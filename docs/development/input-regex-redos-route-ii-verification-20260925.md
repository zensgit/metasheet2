# Input-regex length gate and shape warning — verification (slice H-3, route (ii))

**Status: PROPOSED.** Date: 2026-09-25. Base: `origin/main` @ `e046a21c0a0110fbe22ca765852f1e053d90c0cb`.
Branch: `fix/input-regex-redos-route-ii`. Design: `input-regex-redos-route-ii-design-20260925.md`.

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
  tests/unit/field-validation-wiring.test.ts --config vitest.config.ts --retry=0
```

| file | tests | note |
|---|---|---|
| `src/formula/__tests__/regex-safety.test.ts` | 107 | new: gate, "before compile", shape scanner, log-not-gate, L1/L2 equivalence + refusals, timing (own `describe`) |
| `tests/unit/user-regex-limits-three-copy-parity.test.ts` | 22 | new: constants + one table through backend / web / plugin copies; plugin end-to-end |
| `tests/unit/field-validation.test.ts` | 72 | existing neighbour, unchanged |
| `tests/unit/formula-engine.test.ts` | 87 | existing neighbour, unchanged |
| `tests/unit/field-validation-wiring.test.ts` | 5 | existing neighbour, unchanged |
| **total** | **293 passed (293)** | |

Plugin chain file (already in `plugins/plugin-integration-core/test-chain.txt`):
`node plugins/plugin-integration-core/__tests__/transform-validator.test.cjs` → `[pass]`
(extended with section 6: at-limit accepted, over-limit `PATTERN_NOT_EVALUATED` with reason,
over-limit pattern, `INVALID_RULE` precedence, prompt return on an over-limit quadratic subject).

Type checks: `packages/core-backend` `npx tsc --noEmit -p tsconfig.json` → exit 0, no output;
`apps/web` `npx vue-tsc --noEmit -p tsconfig.app.json` → exit 0.

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
| `SUBSTITUTE` | 100000 | 4111.9 ms | 0.0 ms | `#ERROR!` |
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
- `apps/web`: the util is exercised from the backend parity test; `FormView.vue` is only
  type-checked (`vue-tsc`), not run.

## 6. NOT RUN

- No database, no HTTP, no cross-request victim latency measurement; all readings are
  in-process.
- `apps/web` spec lane; the public form was not driven in a browser.
- Whole-package or workspace test runs; only the files in §1.
- Lint: `packages/core-backend` has no `lint` script and `apps/web`'s lint script enumerates a
  fixed file list that does not include the changed files.
- The stored populations of §6.2 in the design MD (fields with an explicit `pattern` rule and no
  `maxLength`; patterns over 4000 characters) — not countable from the code.
- PG / OS axes — irrelevant to the mechanism.
