# H-7 — verification (candidate, no DDL)

Companion to `integration-guard-registration-shape-design-20260922.md`. Branch
`test/integration-guard-registration-shape`, base `origin/main` @
`cd42eaf7455f03dd99021a02c47c42f1f3db6484` (fetched 2026-09-22). Method: one-time worktree at
`/private/tmp/claude-501/-Users-chouhua-Downloads-Github-metasheet2/6f6639a7-0412-43de-bd8b-0b416d18ae6b/scratchpad/h7-secondpoint`,
`node_modules` symlinked from the canonical checkout (root, `apps/web`, `packages/core-backend`) —
nothing installed. No database anywhere in this slice. Every mutation below: `cp` the real file to
`/tmp`, mutate in place, run, `cp` back, `cmp` to confirm byte-for-byte restoration. Zero
`git checkout -- <path>`, zero `reset --hard`, zero `stash`. Zero `git config user.*` (any scope) —
commits use `git -c user.name=zensgit -c user.email=77236085+zensgit@users.noreply.github.com`.

## 0. Diff summary

```
 packages/core-backend/tests/unit/required-web-lane-registration-shape.test.ts | 235 +++++++++++++++
 scripts/ops/integration-guard-run-web-specs.sh                                |  81 ++++-
 2 files changed, 315 insertions(+), 1 deletion(-)
```

Plus the two new `docs/development/*-20260922.md` files (this one and the design doc). No other
file touched. `git status --porcelain` at the end of this exercise: only those four paths.

## 1. Shape rewrite — token-set identity (real argv, not text)

Method: replicate `runWebSpecsScriptWithPnpmShim` (from
`scripts/ops/integration-guard-required-wiring-contract.test.mjs`) in a throwaway `/tmp` script —
a `pnpm` shim on `PATH` that records its own argv NUL-delimited, then `bash <script>` against it —
run once on the pre-rewrite file (backed up before editing) and once on the post-rewrite file.

```
$ /tmp/argv_probe.sh /tmp/h7-secondpoint-orig.sh > /tmp/argv-before.txt   # pre-rewrite, from disk backup
$ /tmp/argv_probe.sh scripts/ops/integration-guard-run-web-specs.sh > /tmp/argv-after.txt  # post-rewrite
$ wc -l /tmp/argv-before.txt /tmp/argv-after.txt
      60 /tmp/argv-before.txt
      60 /tmp/argv-after.txt
$ diff <(sort /tmp/argv-before.txt) <(sort /tmp/argv-after.txt) && echo "SET IDENTICAL (sorted)"
SET IDENTICAL (sorted)
$ diff /tmp/argv-before.txt /tmp/argv-after.txt | head -1
5a6,7
```
(An order diff at line 6 onward is expected and is the point — the tokens are now alphabetised;
the SET comparison above is what matters and is empty.) 60 = 5-word prefix
(`--filter @metasheet/web exec vitest run`) + 54 spec tokens + `--reporter=dot`, both before and
after. No committed token-set-diff script was added for this file — see design doc §5 for why; this
probe is a throwaway `/tmp` script, not part of the diff.

## 2. Shape sanity on the rewritten file

```
$ bash -n scripts/ops/integration-guard-run-web-specs.sh; echo "rc=$?"
rc=0
```

Structural walk (independent of the vitest guard, cross-check): header line found at its own
physical line, 55 body lines (54 token lines + terminator), terminator is exactly `  --reporter=dot`,
and the 54 tokens are already case-insensitively sorted (`tokens == sorted(tokens, key=(lower,
self))` → `True`).

## 3. Guard suite — clean baseline

```
$ CI=true npx vitest run tests/unit/required-web-lane-registration-shape.test.ts --reporter=dot
 ✓ tests/unit/required-web-lane-registration-shape.test.ts (27 tests) 33ms
 Test Files  1 passed (1)
      Tests  27 passed (27)
```
27 = 18 pre-existing (unchanged, byte-identical apart from the append) + 9 new (4 in the new
"second registration point … structural shape" `describe`, 5 in the new "… mutation self-proof"
`describe`).

```
$ node --test scripts/ops/integration-guard-required-wiring-contract.test.mjs
ℹ tests 62
ℹ pass 62
ℹ fail 0
```
Unaffected — this file was not edited; run to confirm the rewrite does not regress the
execution-based contract (§5 explains why this file matters here at all).

Neighbour health control (unrelated sibling files, same package, same run):
```
$ CI=true npx vitest run tests/unit/approval-ci-coverage-enumeration.test.ts tests/unit/approval-department-field-ci-wiring.test.ts --reporter=dot
 Test Files  2 passed (2)
      Tests  345 passed (345)
```

`tsc --noEmit` (package-scoped, `packages/core-backend`): exit 0, zero diagnostics printed.

## 4. Positive controls — four groups, each `cp`/mutate/run/`cp`-restore/`cmp`

All four applied to the REWRITTEN (multi-line) `scripts/ops/integration-guard-run-web-specs.sh` on
disk, each independently restored and `cmp`-verified before the next.

### PC1 — bare `#`-prefixed line inside the block

Inserted `  #note \` immediately after the `composition-vocab-mirror \` line.

| Check | Result |
|---|---|
| `bash -n` | rc=0 (still syntactically legal) |
| Shape guard (`required-web-lane-registration-shape.test.ts`) | **2 failed, 25 passed** — both the new direct check and its own in-memory mutation-self-proof (which independently re-derives the same mutation) |
| Failure message | `a `#`-prefixed physical line inside the exec continuation block silently truncates the argv bash actually passes to vitest — every token after it (including the trailing --reporter=dot flag) runs in no CI job at all: "  #note \\": expected true to be false` |
| Wiring-contract (`integration-guard-required-wiring-contract.test.mjs`) | **2 failed, 60 passed** — `must exit 0 when the runner succeeds: … line 118: fieldHints: command not found`, and the roster-coverage assertion |
| `bash -x` real trace (via the pnpm-shim probe) | see below |

```
+ pnpm --filter @metasheet/web exec vitest run bomSnapshotDiff bridgeAgentConfigCheck composition-vocab-mirror
+ fieldHints IntegrationBridgeAgentSection … StockPreparationWorkspace --reporter=dot
scripts/ops/integration-guard-run-web-specs.sh: line 118: fieldHints: command not found
```
Real captured argv reaching the `pnpm` shim: **3** entries after the 5-word prefix
(`bomSnapshotDiff`, `bridgeAgentConfigCheck`, `composition-vocab-mirror`) — none of the other 51
tokens or the `--reporter=dot` flag arrive. Mechanism, measured not assumed: the `#note` line is
reached while bash is still awaiting more words of the open `pnpm …` command (the previous line
ended in `\`); a `#` at a word boundary starts a comment there, which runs to the end of THAT
physical line and consumes its own trailing `\` as ordinary comment text — the open command
therefore ends, right there, on an ordinary (uncontinued) line. The NEXT physical line
(`  fieldHints \`) then starts a brand-new top-level command, which is itself still
backslash-continued and so swallows every remaining block line through `--reporter=dot` into one
attempted (here, invalid) command — hence the single `command not found` on `fieldHints`, not on
each dropped token individually.

Restored: `cmp` clean.

### PC2 — one existing token deleted

Two sub-cases, to discriminate the wiring-contract's actual coverage (see design doc §2):

| Deleted token | Shape guard | Wiring-contract |
|---|---|---|
| `bomSnapshotDiff` (backs a real `apps/web/tests/*.spec.ts` roster entry) | **27/27 green** (documented scope boundary — a shape guard does not compare against a remembered token set) | **1 failed, 61 passed** — roster-coverage assertion names the newly-uncovered roster entry |
| `IntegrationRunDetail` (this script's own header names it as deliberately NOT in the roster, "SC-04" note) | **27/27 green** | **62/62 green, silently** — the honest residual this slice does not close (design doc §2, §5) |

Both restored: `cmp` clean after each.

### PC3 — trailing blank line + whole-line comment AFTER the block (must NOT be flagged)

Appended `\n# a trailing rebase note\n` after `  --reporter=dot`.

```
Test Files  1 passed (1)
     Tests  27 passed (27)
```
Confirms the "no non-empty logical line after the block" check is not an always-red detector —
comment-only trailing content is legitimate and stays green. Restored: `cmp` clean.

### PC4 — two adjacent tokens swapped out of alphabetical order

Swapped the first two token lines (`bomSnapshotDiff` / `bridgeAgentConfigCheck`, alphabetically
adjacent in the sorted list).

```
Tests  3 failed | 24 passed (27)
```
Reds: the new direct "is sorted case-insensitively" check, and (because the on-disk file used by
the self-proof suite's own "baseline"/PC4 cases was the same mutated file) two of that describe
block's own tests, which independently re-derive sortedness against whatever is on disk — expected
cross-talk from testing a hand-mutation against a file the suite's OWN fixtures also read live, not
a design flaw; the clean in-memory PC4 case (mutating a COPY of the token array, not the file) was
also run and reds exactly the one intended assertion. Restored: `cmp` clean.

## 5. Correction to a prior review's coverage claim (design doc §2, repeated here with the exact runs)

```
# baseline, unmutated, single-line (pre-rewrite) file:
$ node --test scripts/ops/integration-guard-required-wiring-contract.test.mjs
ℹ tests 62 / pass 62 / fail 0

# mutate: ' fieldHints ' -> ' # rebase note ' (mid single physical line, the exact P3-2 shape)
$ node --test scripts/ops/integration-guard-required-wiring-contract.test.mjs
ℹ tests 62 / pass 60 / fail 2
  ✖ web-specs.sh: actually INVOKES the vitest runner, with the pinned invocation shape …
  ✖ web-specs.sh: every guarded apps/web spec in the roster is actually RUN by the web guard …
# restored, cmp clean
```

This is the SAME mutation a prior independent review round (P3-2,
`impl-gate-shape-guard-always-on-round2-20260922.md`) measured against only the STATIC shape guard
(`required-web-lane-registration-shape.test.ts`'s pre-existing "is still live" check, which stayed
green — reproduced, still true) and reported as "所有守卫全绿" (all guards green). It is not: the
execution-based wiring-contract already reds on it today, on `origin/main`, with zero changes from
this branch. See design doc §2 for the full, hedged claim (truncation always caught; single
roster-backed token loss caught; single non-roster token loss NOT caught — each measured
separately above and in §4's PC2).

## 6. `git cherry` / authorship / mechanics (post-commit)

Recorded after the commit described in the final report. `git cherry origin/main <branch>` and
patch-id intersection against recent `origin/main` history, plus author/committer identity, are
reported there rather than duplicated here to avoid a stale pre-commit number sitting next to a
post-commit one.

## 7. NOT RUN

- Real GitHub Actions `test (18.x)` / `test (20.x)` / `integration-guard` check runs on the pushed
  branch/PR — this document reflects local `vitest`/`node --test`/`bash`/`tsc` runs only. Per the
  harness's own network discipline, `gh` calls carry a 60s budget and a failure or a still-`pending`
  check is recorded as NOT RUN rather than waited out. Whatever the actual PR checks show at read
  time is reported in the final status message instead of guessed here.
- No database of any kind was started or touched; nothing in this slice needed one.
