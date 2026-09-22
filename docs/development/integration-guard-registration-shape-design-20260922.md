# H-7 — the second registration point's registration shape (design, candidate)

STATUS: PROPOSED / candidate for owner review. No DDL. No merge, no undraft performed by this
slice. Branch: `test/integration-guard-registration-shape`, base `origin/main` @
`cd42eaf7455f03dd99021a02c47c42f1f3db6484` (fetched 2026-09-22).

## 0. What this is and is not

This closes ONE narrow gap: `scripts/ops/integration-guard-run-web-specs.sh`'s vitest invocation
was a single 1623-byte physical line (the "second registration point" the two-point discipline in
`packages/core-backend/tests/unit/required-web-lane-registration-shape.test.ts` already names), and
the always-on structural shape guard that file carries for the FIRST registration point
(`apps/web/scripts/run-required-web-tests.sh`) had no counterpart for the second. This slice:

1. reshapes the second registration point into the same one-token-per-line, backslash-continued,
   alphabetised block the first point already uses (contention reduction — the reason the first
   point was reshaped in the first place), with the token SET verified unchanged;
2. extends the always-on guard to check that shape directly, including a check the existing guard
   for the FIRST point does not have: a bare `#`-prefixed physical line inside the continuation
   block is flagged directly, rather than left to the guard's own comment-stripping fold (see §3);
3. corrects, with a measurement, a claim from a prior independent review round about what is
   already covered without this change (§2).

This is NOT a rewrite of `apps/web/scripts/run-required-web-tests.sh`, not a fix to that file's own
guard (tracked separately in the still-open, still-draft PR #5898), not a change to
`.gitattributes`, and not a new committed token-set-diff tool. Each of those is an explicit,
recorded decision in §5, not a silent omission.

## 1. The two registration points, compared

| | First point — `apps/web/scripts/run-required-web-tests.sh` | Second point — `scripts/ops/integration-guard-run-web-specs.sh` |
|---|---|---|
| Invocation before this change | Already one-token-per-line (Q8/C4, 2026-09-21) | ONE physical line, 1623 bytes, 54 spec tokens + `--reporter=dot` (55 argv words after `run`) |
| Command shape | `exec npx vitest run \` … `--reporter=dot` (shell `exec` replaces the process — the script's last act) | `pnpm --filter @metasheet/web exec vitest run …` (no shell `exec`; `set -euo pipefail` + natural fall-through propagates the exit code — the wiring-contract test below exists specifically because that path is easy to defeat with `|| true`) |
| Which required check collects it | `web-tests` (path-filtered: fires whenever `apps/web/**`, `apps/web/scripts/**`, etc. change) | `integration-guard` (path-filtered via `scripts/ops/integration-guard-guarded-paths.mjs`'s roster, which lists this very file, so any edit to it is guaranteed `relevant=true`) |
| Static shape guard | `required-web-lane-registration-shape.test.ts`'s first `describe` block (bash -n, exactly-one-exec-logical-line, one-token-per-line, no-duplicate, sorted, ends-on-`--reporter=dot`, `.gitattributes` pin) | Before this change: only the "is still live and readable" check at the end of that file (invocation count, token count > 30, no duplicates, no `-t`/`--testNamePattern`, non-empty overlap with the first point) — no shape check, because there was no multi-line shape to check |
| Execution-based guard | None dedicated (covered indirectly by the required lane actually running) | `scripts/ops/integration-guard-required-wiring-contract.test.mjs`'s four `web-specs.sh: …` tests — runs the REAL script against a PATH-injected `pnpm` shim that records real argv, asserts the argv prefix/suffix shape, that a failing runner's exit code propagates, that every `WEB_SPEC_ROSTER_ENTRIES` roster entry is covered by some token (deep-equal against a named exception set), and that every token resolves to a real spec file. Runs BEFORE `pnpm install`, needs no node_modules. |
| bash lexical risk (pre-existing, either point) | A `#`-prefixed physical line INSIDE a backslash-continued block is not a harmless comment: backslash-newline joining happens before bash goes looking for a `#`, so such a line ends whatever command it interrupts right there (its own trailing `\` is consumed as comment text, not honoured as a continuation) — everything after it, up to and including a later `--reporter=dot`, is either dropped from the real invocation or re-parsed as an unrelated (here, invalid) command on the next physical line. This is symmetric across both points once both are multi-line; it was previously only reachable on the SINGLE physical line of the second point, where inserting `#` anywhere had the same truncating effect. | (same clause) |

Read together with the guard file's own `PARSING CONTRACT` section: every guard that reads either
script must strip whole-line `#` comments and JOIN backslash continuations before looking for the
invocation — a physical-line `.startsWith(...)` parse sees only the continuation backslash as its
"argument".

## 2. Correction: what a prior review round's "all guards green" claim covers, measured

A prior independent review round (`impl-gate-shape-guard-always-on-round2-20260922.md`, finding
P3-2, folded into `finding_required_web_script_duplicate_exec_lines_dead_lane_specs.md`'s
2026-09-22 addendum) measured a `#`-in-the-middle mutation against the second registration point
and reported the always-on STATIC shape guard (`required-web-lane-registration-shape.test.ts`)
stayed green — true, and reproduced here (see §4, "before" column). Read on its own, "the guard for
this file stayed green" can be misread as "nothing in CI would have caught this." Measured directly
in this slice, against `origin/main`, with ZERO changes from this branch:

- **Truncation (any mid-block `#`) is already caught, today, on `origin/main`.**
  `scripts/ops/integration-guard-required-wiring-contract.test.mjs` executes the real script via a
  PATH-injected `pnpm` shim. Replacing ` fieldHints ` with ` # rebase note ` in the (then still
  single-line) file and re-running that contract: **62 → 60 pass, 2 fail** — the
  `--reporter=dot` tail-flag assertion fails (the flag never reaches the shim) and the
  roster-coverage assertion fails (the 46 roster-backed specs after the injection point are no
  longer covered). That file is wired into `plugin-tests.yml`'s required `test` job (both
  node-version legs, no `if:`), so this is a today-live safety net, not a hypothetical one.
- **A single existing token silently dropped is caught only when that token backs a
  `WEB_SPEC_ROSTER_ENTRIES` roster entry.** Measured with two single-token deletions:
  - deleting `bomSnapshotDiff` (roster-backed) → wiring-contract **61 pass, 1 fail** (roster
    coverage reds);
  - deleting `IntegrationRunDetail` — one of the ~7 tokens this very script's own header
    documents as deliberately outside the roster (its "SC-04" note) → wiring-contract stays
    **62 pass, 0 fail**, silently.

So the accurate scope is narrower than either "closed" or "wide open": truncation is already
fail-closed via execution; single-token loss is fail-closed only for roster-backed tokens. The
static shape guard extended in this slice closes the FIRST class a second, independent way (so a
truncating `#` reds two unrelated mechanisms instead of depending solely on the runtime contract,
and reds it as a shape violation rather than an opaque `command not found`), and makes no claim
about the second — a shape guard checks structure, not token-set membership, matching the
pre-existing `tokens.length > 30` loose bound the same file already uses for the first point (see
§5 for why an exact pin was rejected).

## 3. Target shape and the two-clause `#` coverage

Target shape for the second point, matching the first point's existing convention:

```
pnpm --filter @metasheet/web exec vitest run \
  <token> \
  <token> \
  …
  --reporter=dot
```

- one token per physical line, two-space indented, each continued with a trailing ` \`;
- case-insensitive alphabetical order (tie-broken by plain string comparison — the same
  `caseInsensitive` comparator the file already exports/uses for the first point);
- a single logical line (via backslash continuation) from the bare header through the terminator;
- nothing but the bare `--reporter=dot` flag as the terminator (no other flag — a narrowing
  `-t`/`--testNamePattern` is already checked by the pre-existing "is still live" test's regex, and
  continues to be, since it reads the SAME folded logical line);
- no non-empty logical line anywhere after the block;
- no `#`-prefixed physical line anywhere inside the block.

The last item needs its own direct check rather than reuse of the file's `logicalLines()` fold,
and the reason is itself worth stating precisely (a prior review round flagged "parses the way bash
does" as an overclaim when a fold only strips a LEADING `#`): `logicalLines()` strips every
`#`-prefixed physical line from the WHOLE file, unconditionally, before it ever starts joining
continuations. A `#`-prefixed line inserted between two token lines is therefore invisible to it —
the fold silently reconnects the token before and the token after with no gap, and every
`logicalLines()`-derived assertion (token count, no-duplicate, no-`-t`, overlap) stays green. That
parser remains the right tool for "does this still fold to one clean invocation" (what the
pre-existing "is still live" test uses it for); it does not, on its own, double as a truncation
detector. The two-clause coverage this slice adds, each with its own counterexample:

- a **bare** `#`-prefixed line (one word, e.g. `  #note \`) → the new direct check (walks RAW
  physical lines, not the comment-stripped `logicalLines()` view) flags it: `line.trim().startsWith('#')`.
- a **trailing inline comment sharing a line with a real token** (`  token #note \`, two or more
  words) → already caught by the pre-existing "exactly one argument per physical line" check,
  because bash's comment start is a word boundary and a naive whitespace split counts the comment
  text as extra words.
- `token#note` (no space before `#`) is not a bash comment at all — `#` only starts one at the
  start of a word — and is out of scope for the identical reason it already is for the first point.

That pair (bare-line direct check + pre-existing per-line-token-count check) covers the two
bash-comment word shapes enumerated above; nothing in this slice or its comments claims "folds the
way bash does" beyond that.

## 4. Guard placement and CI collection evidence

**Placement**: appended to the SAME file,
`packages/core-backend/tests/unit/required-web-lane-registration-shape.test.ts`, as two new
top-level `describe` blocks at end-of-file — not a new file, and not an edit to the existing
`describe` blocks. Reasons, in order:

1. **Reuse, not a fourth parser copy.** The file already exports `logicalLines()` and `tokensOf()`
   and defines `caseInsensitive()`/`BASH` at module scope; a new file would need its own copy of at
   least the first two, and this exact repo already carries a documented NIT about three duplicate
   `logicalLines`-shaped implementations drifting. Appending reuses the existing exports.
2. **Conflict minimisation against #5898.** PR #5898 (`test/web-required-script-shape-guard`,
   still OPEN/draft/unowned as of this branch's base) rewrites this same file's fold algorithm and
   header comment. This slice touches neither — it only appends new `describe` blocks at EOF and
   leaves every existing line alone, which is the smallest surface for a future rebase of either
   branch onto the other to collide on.
3. **Same job, same evidence requirement.** The new blocks are collected by the identical
   mechanism that already collects the file's existing 18 tests (see below) — no new wiring is
   needed, so there is nothing new to prove is "always-on" beyond what the pre-existing tests in
   the same file already establish.

**Collection evidence (read from `origin/main`, not assumed)**:

- `.github/workflows/plugin-tests.yml`'s `pull_request:` trigger (`:19`) carries no `paths:`
  filter (only the `push:` trigger does, `:6-14`) — a PR is not filtered out by touched paths.
- The `test:` job (`:174`) matrix is `node-version: [18.x, 20.x]`, `fail-fast: false`, no job-level
  `if:`.
- The `Run core-backend tests` step (`:842-844`) carries no step-level `if:` (the two steps
  immediately above it, `Run linting` and `Run type checking`, are the ones gated to
  `matrix.node-version == '20.x'` — the core-backend test step itself is not) and runs
  `pnpm --filter @metasheet/core-backend test`.
- `packages/core-backend/package.json`'s `"test"` script is bare `vitest` (no args) → CI (non-TTY)
  runs in `run` mode over the default include glob.
- `packages/core-backend/vitest.config.ts` has no `include:` key (default glob applies) and its
  `exclude:` array (grep-verified, zero hits for `required-web-lane` or `registration-shape`) never
  mentions this file or its directory — only specific real-DB `tests/integration/*.test.ts` files
  are excluded.

So: any PR triggers `pull_request`, both node-version legs run `Run core-backend tests`
unconditionally, and vitest's default collection picks up
`tests/unit/required-web-lane-registration-shape.test.ts` whole, new `describe` blocks included.
Locally reproduced in this slice (worktree, no DB): `CI=true npx vitest run
tests/unit/required-web-lane-registration-shape.test.ts --reporter=dot` → **27 passed (27)** (18
pre-existing + 9 new: 4 in the new structural-shape block, 5 in the new mutation-self-proof block).
Whether the real `test (20.x)`/`test (18.x)` required contexts on the actual PR head are green is a
separate, CI-network fact — recorded as NOT RUN / pending in the verification doc, not asserted
here from the local run.

## 5. Recorded decisions (not silent omissions)

- **No exact token-count pin.** The pre-existing "is still live" test already uses a loose
  `tokens.length > 30` bound for the second point (mirroring `> 300` for the first). An exact pin
  would need bumping on every legitimate new integration spec — this file's own header already
  carries seven multi-paragraph notes documenting exactly that kind of addition over 2026-07 to
  2026-09 — and would read as noise rather than signal. Content-set integrity is instead the
  execution-based wiring-contract's job for roster-backed tokens (§2); this shape guard's job is
  structure.
- **No new committed token-set-diff script.** `scripts/ops/required-web-lane-token-set-diff.mjs`
  exists but is hard-coded to the FIRST point's path and `exec\s+npx\s+vitest\s+run` header regex;
  parameterising it for a second, differently-shaped header was judged more surface than the
  one-time migration needs. Instead, the token-set-identity claim for THIS rewrite is proven the
  same way the pre-existing execution-based contract itself proves invocation shape: a throwaway
  script replicates `runWebSpecsScriptWithPnpmShim`'s PATH-injected `pnpm` shim, captures
  NUL-delimited real argv before and after the rewrite, and diffs the two as SORTED sets (order is
  expected to change — alphabetisation is the point). See the verification doc for the exact
  command and output. This is the same mechanism CI itself exercises
  (`integration-guard-required-wiring-contract.test.mjs`), not a parallel text-based claim.
- **No `.gitattributes` change.** The first point's `merge=union` pin was not extended to the
  second point. Out of the scope this task named, and the churn precedent that motivated it for the
  first point (76 commits in 20 days) has not been observed here.
- **No touch to `apps/web/scripts/run-required-web-tests.sh` or its own guard.** That file's
  analogous `#`-inside-block gap (P2-2/P3-2 in the cited review rounds) is tracked in the still-open
  PR #5898, not reproduced or fixed here.

## 6. Relationship to open PRs

- **#5898** (`test/web-required-script-shape-guard`) rewrites this SAME guard file's fold algorithm
  and the FIRST point's own `attendance-web-guard-workflow.spec.ts` assertions; still draft/OPEN as
  of this branch's base commit. This slice appends new, independent `describe` blocks at EOF and
  does not touch any line #5898 touches — the two should be mergeable in either order, but whichever
  lands second should re-diff the other's `describe` block boundaries before merging to confirm the
  textual append point is still clean.
- **#5974** (`ci/required-web-lane-token-manifest-guard`, OPEN/draft/MERGEABLE as of this branch's
  base) is a sibling candidate addressing token-SET (not shape) coverage for the FIRST registration
  point only — it commits `apps/web/scripts/run-required-web-tests.tokens`, a sorted manifest of
  all 499 tokens across that script's 19 `vitest run` lines, plus a new guard file
  `packages/core-backend/tests/unit/required-web-lane-token-manifest-guard.test.ts` asserting the
  manifest equals the live union. Its own body states explicitly it makes "No edit to
  `required-web-lane-registration-shape.test.ts`" — confirmed no file overlap with this slice. It
  does not touch the second registration point at all (its scope is the 19 lines in
  `run-required-web-tests.sh`). The two are independent and can land in either order; a natural
  follow-up an owner may want to weigh, NOT done here, is whether a manifest of the same shape
  should eventually cover the second point's 54 tokens too — out of scope for this narrowly-scoped
  shape-only slice (§0, §5).

No lock document is touched by this slice. No DDL. No flag changes.

## 7. Round-1 gate review disposition (2026-09-22, record-level)

The round-1 gate (`impl-gate-H7-integration-guard-registration-shape-round1-20260922.md`, APPROVE,
0 P1/0 P2/4 P3/2 NIT) found §3's "complete cover of the block" an unscoped absolute given the
section itself already hedges to two named word shapes — narrowed above. **P3-1 (the ~7 non-roster
tokens, §2), P3-2 (`.gitattributes` `eol=lf` half not extended alongside `merge=union`, §5) and
P3-3 (no `merge=union` pin, so alphabetically-adjacent lanes can still conflict, §5) are existing,
unresolved** — the gate's own disposition recommends they land in a separate follow-up PR, not in
this one; no `.gitattributes` or coverage change is made in this pass.

P3-4 (PR body item 3 expanding the `#`-truncation mechanism and disclosing an unfixed detection
gap) was handled in this pass by trimming that body item; the mechanism detail stays in this MD
and the private review notes. NIT-2 (the mutation self-proof block re-implements
`secondRegistrationBlock()` and `SECOND_HEADER_LINE` is declared twice in the same file) needs
executable-code changes and is outside this record-level pass — existing, unresolved.

## 8. S-8 gate disposition (2026-09-23, record-level)

The S-8 independent adversarial gate (`impl-gate-S8-first-point-sort-guard-20260923.md`,
APPROVE-with-hardening, 0 P1/1 P2 PRE-EXISTING/2 P3/5 NIT) found the second registration point's
one-token and two-space-indent checks (in the it titled "opens with the bare pnpm/vitest header, is
written one token per physical line continued with a trailing backslash, and rejects a bare
`#`-prefixed physical line inside the block") each duplicated inline in the first registration
point's own per-line loop (the it titled "is written one token per physical line, continued with a
trailing backslash") — the first point has no bare-`#` check of its own — and the second point's
bare-`#` check reimplemented a second time, as its own separate copy, inside its own PC1 self-proof
(it titled "PC1 — a bare `#`-prefixed line inside the block reds the direct detector (kills a
mid-rebase-note truncation)") rather than exercising the real assertion.

Commit `89edec9e4d28e862ab1320f8193af1c98bf2576c` on this branch moved the three predicates
(`isBareCommentLine`, `isOneTokenLine`, `hasTwoSpaceIndent`) to live once each at module scope, made
both registration points' real assertions and PC1 call them instead of a local copy, and added
three new self-proofs (PC5, PC6, M6) that feed each predicate's **function body** a controlled bad
input and assert it is caught. Measured, that layer is a real improvement: SIB-1/2/3/4 each red on
this branch's head under the mutation; SIB-1 and SIB-4 are measured green on base `72da9f76b` under
the same mutation intent (the site differs: base has no module-scope predicate to neuter), while
SIB-2 and SIB-3 have no corresponding self-proof on base at all — they would be trivially green
there since there is nothing for the mutation to land on, but base never actually measured this, so
their absence of a red is not evidence the predicate was covered (S-9 independent gate,
`impl-gate-S9-sibling-predicates-20260923.md` §三.1). What this commit does not close is the real
assertions' **call sites**: replacing `isBareCommentLine(line)`, `isOneTokenLine(payload)` or
`hasTwoSpaceIndent(line)` with a constant at the call site itself — not inside the function body —
leaves the suite green (S-9 gate CALL-1/2a/2b/3a/3b, green each), because a fail-open check run on
an already-conformant script reads the same as a correct one — the same limit `firstSortBreak`'s own
doc comment already names for that detector. A same-file mutation self-proof does not by itself rule
this out: it can only feed a predicate the input IT supplies and check the verdict, not show what a
constant-replaced call site would have done to some other input a future regression might carry.

Base `72da9f76b`'s bare-`#` predicate (SIB-1) genuinely was covered by a sibling copy before this
branch: PC1 carried its own separate `#` check while the real assertion's own inline copy had no
self-proof of its own, so neutering the real assertion's copy alone left PC1's copy silently
standing in for it. That sibling-masking mechanism is scoped to SIB-1. The one-token predicate
(SIB-2) and the indent predicate (SIB-3/4) were not sibling-masked: on base, neutering BOTH the
indent predicate's inline copies together (the first and second registration points' own per-line
loops — the same two `it` blocks named above) at once is still green (S-9 gate §三, base-comparison run) —
because SIB-2 and indent carried no self-proof at all before this branch, so there was no sibling to
do the masking. On this branch's head, SIB-2's self-proof is PC5 (it titled "PC5 — a registration
line carrying two tokens reds the one-token-per-line detector"). The mechanism there is the same
fail-open-indistinguishable-from-correct limit named above, not a masking sibling.

The gate's separate NIT-1/NIT-2/NIT-4 wording corrections and the `firstSortBreak` return-shape
change it prescribed (returning `{ at, found, expected }` so neither "is sorted" call site re-sorts
the token list itself) are in the same commit.

**S-9 gate follow-up (2026-09-23, record-level, optional narrowing).** Commit `3f5a4ae4b` on this
branch hoists the shared `payload` derivation (`line.replace(/\s+$/, '').replace(/\\$/,
'').trim()`) — previously duplicated three times, at the first point's real assertion (it titled "is
written one token per physical line, continued with a trailing backslash"), the second point's real
assertion (it titled "opens with the bare pnpm/vitest header, is written one token per physical line
continued with a trailing backslash, and rejects a bare `#`-prefixed physical line inside the
block"), and PC5's own self-proof (it titled "PC5 — a registration line carrying two tokens reds the
one-token-per-line detector") — into one module-scope `payloadOf(line)`, with all three sites now
calling it. This is a narrowing, not a closure: the S-9 gate's PAY-PC positive control (replacing
the call site with `line`, unmodified) reds the second point's real assertion, showing the site is
reachable and load-bearing; but replacing the call site itself (`const payload = payloadOf(line)` →
a literal) at either real assertion still leaves the suite green each time, which is the identical
call-site limit two paragraphs above, applied to this predicate too. After the hoist, the positive
control that replaces the body of `payloadOf` with `line` reds both real assertions and PC5 (before
the hoist only one site). A regression inside `payloadOf` that only drops the trailing-whitespace
normalisation stays green (S-10 gate PAY-WS). The S-11 gate re-ran that mutation with a trailing
space appended to the PC5 fixture and it still stayed green, so the blind spot is not a property of
the fixture; under that mutation no assertion in this file reds. The cause is not isolated in this
document. The single definition removes the drift surface; it does not make every derivation
regression visible.
