# CI flake: an untracked scratch file written into the live source tree races a sibling directory-walking gate

Date: 2026-09-19
Branch: `test/ci-flake-scratch-file-in-source-tree`
Base: `origin/main` @ `bb77ca5f2`

## 1. Symptom

Two independent Opus gate-review reports each hit this once: `core-backend` full-suite
`vitest` (the required `test (20.x)` check, "Run core-backend tests" step of
`.github/workflows/plugin-tests.yml` job `test`, i.e. `pnpm --filter @metasheet/core-backend
test`) occasionally reds with

```
ENOENT: no such file or directory, open
'.../packages/core-backend/src/attendance/zz-nit3-untracked-scratch.ts'
```

in `tests/unit/role-assignment-boundary.test.ts`'s `user_roles has exactly one writer >
every writer of the table is the boundary module and nothing else`. Both implicated files
are unchanged on `origin/main`; each passes 100% alone (40/40 and 16/16 respectively); the
failure only appears when the full suite runs under `pool: 'forks'`.

## 2. Root cause

`packages/core-backend/src/attendance/__tests__/w4c3a-rollout-control-inventory.test.ts`'s
`NIT-3` test wrote a real, untracked scratch file **inside the live repository source
tree** — `packages/core-backend/src/attendance/zz-nit3-untracked-scratch.ts` — to prove
`listGitTrackedFiles()` (the exact-boundary DML inventory gate) walks `git ls-files
--cached` and therefore ignores an untracked file, not the raw filesystem. It wrote the
file, ran the real gate, asserted the file was excluded, then deleted it in a `finally`.

Concurrently, `packages/core-backend/tests/unit/role-assignment-boundary.test.ts`'s
`user_roles has exactly one writer` suite walks the same directory
(`collectSweptFiles()` recursively lists `packages/core-backend/src` and `plugins`) and,
in a later `it()`, reads every listed file with `fs.readFileSync`.

Under `pool: 'forks'`, these two test files run in separate, concurrent OS processes. If
`collectSweptFiles()`'s directory listing happens to run while the scratch file transiently
exists, the scratch path is captured in `role-assignment-boundary.test.ts`'s own `swept`
array. If the inventory test's `finally` block deletes the file before
`role-assignment-boundary.test.ts` gets around to actually reading it (it reads ~800+ files
in the same loop, so there is always some delay), the read throws `ENOENT` — a classic
list-then-stale-read TOCTOU race over a shared filesystem path neither test owns
exclusively. Locally, and in an isolated two-file run with both forks starting near-
simultaneously, `role-assignment-boundary.test.ts` reliably finishes its listing well
before the inventory test even reaches `NIT-3` (which runs after a slower, whole-repo-grep
first test), so the collision needs the additional scheduling jitter of a fully loaded CI
runner running ~1120 test files concurrently to manifest — consistent with "single run
40/40 green, full run 1 red 1 green."

Neither test file has a bug in its own logic; the defect is purely the shared mutable
filesystem path.

## 3. Reproduction — deterministic cross-process handshake

Random full-suite timing is not a practical repro loop, and an isolated two-file run
(both forks starting together) does not race at all, because `role-assignment-
boundary.test.ts`'s listing finishes long before the inventory test reaches `NIT-3`.
Instead of guessing at the exact scheduling jitter that surfaces under full-suite load,
the race was constructed directly, matching repo doctrine ("TOCTOU 必须构造并发"): temporary
instrumentation (gated behind `process.env.CI_FLAKE_REPRO_DIR`, added only for this
investigation, never committed) added a file-marker handshake between the two real test
files:

- Inventory test's `NIT-3`, after writing the scratch file: write a `written` marker, then
  busy-wait (`Atomics.wait` on a throwaway `SharedArrayBuffer`) for a `go` marker before
  proceeding to `listGitTrackedFiles` and the `finally`/delete; after deleting, write a
  `deleted` marker.
- `role-assignment-boundary.test.ts`'s `describe` body, before calling
  `collectSweptFiles()`: busy-wait for the `written` marker, call `collectSweptFiles()`
  (now guaranteed to observe the scratch file), write the `go` marker, then busy-wait for
  `deleted` before continuing to the `it()` blocks that read the files.

This forces exactly the interleaving the bug depends on — listing while the file exists,
reading after it is gone — with certainty, not luck.

Command:
```
CI_FLAKE_REPRO_DIR=/tmp/ci-flake-handoff npx vitest run --pool=forks \
  --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=4 --reporter=dot \
  src/attendance/__tests__/w4c3a-rollout-control-inventory.test.ts \
  tests/unit/role-assignment-boundary.test.ts
```

Result: **3/3 runs reproduced** the exact reported failure —
`role-assignment-boundary.test.ts > user_roles has exactly one writer > every writer of
the table is the boundary module and nothing else` → `ENOENT: no such file or directory,
open '.../packages/core-backend/src/attendance/zz-nit3-untracked-scratch.ts'` at
`role-assignment-boundary.test.ts:893` (`fs.readFileSync(path.join(REPO_ROOT, file),
'utf8')`), byte-identical to the two Opus reports. (Line 893 is in the temporarily
instrumented copy of the file used for this repro run — the handshake code shifts line
numbers; the shipped, uninstrumented `role-assignment-boundary.test.ts` has the same
`readFileSync` call at line 872.) The instrumentation was reverted via `cp` backup/restore
(`cmp` confirmed byte-identical to the pre-instrumentation original) before any real
change was made — nothing from this step is in the diff.

## 4. Fix (option (a) — isolate the fixture, never touch the live tree)

`listGitTrackedFiles(rootDir: string)` already takes an arbitrary `rootDir` — it is not
hardcoded to the repo root — so no production code change was needed. `NIT-3` was
rewritten to create a throwaway, single-use `git init` repository under
`fs.mkdtempSync(os.tmpdir())`, write the untracked scratch file there, and call
`listGitTrackedFiles(isolatedRepo)` against that isolated repo instead of the live one.
The scratch file is never written into `packages/core-backend/src` (or anywhere in the
live tree), so it is structurally impossible for it to be observed by
`role-assignment-boundary.test.ts`'s sweep, or by any other directory-walking gate over
the real source tree — not merely less likely, incapable of colliding, because the two
operations no longer share a filesystem path.

This preserves the test's exact regression-catching semantics: a hypothetical reversion of
`listGitTrackedFiles` back to a raw filesystem walk would still see the untracked file
inside the isolated repo and red the test (verified directly — see §5). Only the test file
was changed; `listGitTrackedFiles`, `walk`, and every other function in the file are
untouched.

Diff (`packages/core-backend/src/attendance/__tests__/w4c3a-rollout-control-inventory.test.ts`,
`NIT-3` body only): 34 insertions / 10 deletions, all inside the one `it()` block.

## 5. Mutation testing

**Mutation A — prove the isolated fixture still discriminates (not vacuous).** With the
fix applied, temporarily replaced `listGitTrackedFiles(isolatedRepo)` with the file's own
raw-filesystem `walk(isolatedRepo, files)` helper (simulating the exact regression NIT-3
exists to catch). Result: **reds**, `expected [] to deeply equal [Array(1)]` — the scratch
file appears under a raw walk, confirming the isolated-repo fixture is load-bearing after
the fix, not just passing by construction. Reverted via `cp` backup/restore; `cmp`
confirmed byte-identical to the fixed version.

**Mutation B — prove the FIX itself is what eliminated the race (task-mandated).**
Temporarily reverted the fix in a copy of the fixed file (scratch file written back to
`packages/core-backend/src/attendance/` inside the live tree, exactly as before), re-added
the §3 handshake instrumentation to both files, and re-ran the same deterministic repro
command. Result: **reds again**, the identical `ENOENT` at the same read site (line 891 in
that run's instrumented copy — the instrumentation added to `role-assignment-boundary.test.ts`
for this probe shifts its line numbers by two versus the shipped file's line 872, same
caveat as §3). This confirms the isolation in §4 — not something else — is what removes
the race. Reverted via `cp` backup/restore; `cmp` confirmed both files byte-identical to
their intended final state (fixed inventory test with no instrumentation; untouched
original `role-assignment-boundary.test.ts`).

## 6. Post-fix confirmation

- `NIT-3` alone, and the full `w4c3a-rollout-control-inventory.test.ts` file (16/16),
  pass unchanged.
- `role-assignment-boundary.test.ts` is untouched — `cmp` against `origin/main`'s copy is
  byte-identical (zero diff on that file in the final PR).
- The two implicated files run together, `--pool=forks`, **20/20 consecutive clean runs,
  zero `ENOENT`** — but this by itself is **not discriminating evidence for the fix**: an
  isolated two-file run of the ORIGINAL (buggy) pair was already shown in §2/§3 to be
  green too (both forks start together and `role-assignment-boundary.test.ts` finishes its
  listing before the inventory test even reaches `NIT-3`), so the same 20 plain runs would
  have passed before the fix as well. Recorded here only as a cheap smoke check, not as
  proof.
- The actual proof that the race is gone, not just harder to hit, is structural plus
  Mutation B: §3's deterministic handshake method has no precondition left to exploit
  post-fix, because its precondition — a transient write to a path
  `role-assignment-boundary.test.ts` sweeps — no longer exists (the scratch file lives in
  an isolated `os.tmpdir()` git repo that shares no path with `packages/core-backend/src`
  or `plugins`). §5 Mutation B is the discriminating test: re-introducing the live-tree
  write and re-running the identical deterministic method reproduces the exact `ENOENT`
  again, which is what shows the fix — not incidental timing — is what closes the race.

## 7. Sweep for other live-tree writers (is this the only instance?)

`collectSweptFiles()` walks all of `packages/core-backend/src` and `plugins`, not just
the `attendance/` subtree, and `role-assignment-boundary.test.ts`'s own header already
names this exact hazard as established doctrine ("never a write into the real tree,
which would race sibling suites under `pool: 'forks'`"). Fixing the one instance the
brief named is not the same claim as "the flake is closed" unless nothing else in the
tree does the same thing, so this was checked directly rather than assumed.

**Static sweep** — every `writeFileSync` / `appendFileSync` / `renameSync` /
`symlinkSync` / `copyFileSync` call in every `*.test.*`/`*.spec.*` file under
`packages/core-backend` and `plugins` (90 call sites) was enumerated and each
destination traced. Findings:

- The `plugin-integration-core` provenance-clone helpers (`copyFileSync` into `dest`)
  write into their own `fs.mkdtempSync(os.tmpdir())` clone, never into the live tree —
  read-only against `REPO_ROOT`, safe.
- Two OTHER test files in `packages/core-backend` already carry this exact hazard as
  **known, previously-fixed** history, both with their own explicit code comments
  naming it:
  - `tests/unit/attendance-w6-fser-single-source-caller-inventory.test.ts` — its decoy
    scratch file "previously lived at `src/attendance/zz-w6r4-decoy-scratch.ts`" (inside
    a pinned `w7-w6r5` guard root) and was moved to
    `packages/core-backend/tests/unit/zz-w6r4-decoy-scratch.ts` specifically because that
    prior location raced `attendance-w7-w6r5-preservation-guard.test.ts` under
    `pool: 'forks'` — the comment describes catching this as a "latent nondeterministic
    red" independently. `tests/unit/` is outside both that guard's pinned roots and
    `role-assignment-boundary.test.ts`'s `SWEEP_ROOTS` (`packages/core-backend/src`,
    `plugins`), so this is already safe with respect to the bug fixed here.
  - `tests/unit/attendance-w6-import-graph-no-calculation-consumer.test.ts` — its
    untracked-scope decoy is written to `path.dirname(fileURLToPath(import.meta.url))`
    (its own test-file directory, `tests/unit/`), with a comment stating plainly that the
    positive-control decoys in the same file "intentionally never touch the real
    `packages/core-backend/src/` tree (another suite walks it recursively and races a
    transient file there)". Also outside `SWEEP_ROOTS` — already safe.
- No other call site in the 90 writes into a path resolved against `ROOT` / `REPO_ROOT`
  / `__dirname` / `process.cwd()` under `packages/core-backend/src` or `plugins`; every
  other write target is either an isolated `mkdtemp` directory, the test file's own
  `tests/unit`/`__tests__` directory (outside both `SWEEP_ROOTS`), or a fixture path
  that never resolves under either swept root.

**Empirical corroboration** — polled `git status --porcelain packages/core-backend/src
plugins` every 150ms for the full duration of a second complete
`CI=true pnpm --filter @metasheet/core-backend test` run (945/1120 files passed, 0
failed, same as §9): **zero transient entries observed**. This is a sampling check (a
write-then-delete narrower than the poll interval could be missed), so it corroborates
rather than substitutes for the static sweep above, which is exhaustive by construction.

**Conclusion**: the fixed `NIT-3` was the only live, unguarded writer into
`role-assignment-boundary.test.ts`'s swept roots. The claim in §9 ("full-suite green")
is not resting on the absence of other writers being merely assumed.

## 8. Attendance four-census-pin check

Per `feedback_attendance_new_file_census_trio`, the four pins (s6a workflow-hash pin,
W7-R10 `classification.ts`, the `attendance-w4c2-ci-wiring` CI-suite corpus, and the
`attendance-w4c0-dml-inventory-collector` DML table-classification) are tripped by
**adding** a new attendance lib/test file, a new DB-backed table, or editing
`plugin-tests.yml`. This change does none of those — it edits the body of one existing
test (`w4c3a-rollout-control-inventory.test.ts`, already an entry in every relevant
population) in place; no file was added or removed, no table was touched, and
`plugin-tests.yml` was not edited. All four checks were run against the diff regardless,
as a mechanical sanity pass, and all four are green with no re-pin required:

| Pin | Command | Result |
|---|---|---|
| s6a package-provenance hash | `node plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs` | OK |
| W7-R10 classification | `vitest run tests/unit/attendance-w7-w6r5-preservation-guard.test.ts` | 13/13 pass |
| CI corpus | `node --test scripts/ops/attendance-w4c2-ci-wiring.test.mjs` | 262/262 pass |
| DML table-classification | `node --test scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs` | 60/60 pass |

No pin file was modified.

## 9. Full-suite confirmation

`CI=true pnpm --filter @metasheet/core-backend test` (the exact required `test (20.x)`
step, `vitest` default discovery, `pool: 'forks'`), one run, full corpus:

```
Test Files  945 passed | 175 skipped (1120)
     Tests  14991 passed | 1609 skipped (16600)
```

Zero failures, zero `ENOENT`.

## 10. Scope

Only test files were touched:
`packages/core-backend/src/attendance/__tests__/w4c3a-rollout-control-inventory.test.ts`
(`NIT-3` body rewritten to an isolated throwaway git repo under `os.tmpdir()`). No
production code, no migration, no workflow file, and no other test file (including
`role-assignment-boundary.test.ts`) was changed.
