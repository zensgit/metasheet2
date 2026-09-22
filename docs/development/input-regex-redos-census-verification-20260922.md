# Input-regex ReDoS census — verification (slice H-3)

**Status: PROPOSED.** Date: 2026-09-22. Base: `origin/main` @ `cd42eaf7455f03dd99021a02c47c42f1f3db6484`.
Branch: `fix/input-regex-redos-candidates`. Local PostgreSQL 15.17 (Homebrew, aarch64).
One-shot DB: `metasheet2_h3_20260922` (owner `ms2testbed`, non-superuser); `current_database()` verified before every DB touch. Never pointed at `metasheet_test` / `metasheet_v2` / `metasheet_testbed_*`.

All timings are `process.hrtime`/`performance.now()` wall-clock on this machine; absolute
ms are machine-relative — the **ratios** and the **victim-vs-attacker** contrast are the
evidence, not the constants.

**Round 2.** §1–§4 are the round-1 census and finding measurements; an independent gate
reconciled the §1/§2 denominator 47/47 and reproduced §4.4's numbers, and they are
unchanged here. §5 has been **rewritten**: round 1's "the fixes work" claim was withdrawn
after the gate measured the shipped detector refusing six common linear patterns while
still admitting a 22-second `^(a|a)*$`. §5 now reports what was measured, in both
directions, plus the mutation table and the differential fuzz. §6 NOT RUN is extended.

## 1. Denominator hygiene (extraction)

`extract.cjs` over the three roots:

| metric | value |
|---|---|
| files attempted | 2006 |
| files parsed | 2006 |
| **parse failures** | **0** (none — no silently dropped file) |
| `.vue` files with no `<script>` block | 0 |
| regex sites extracted | 1694 (core-backend 1160, apps-web 440, plugins 94) |
| by kind | literal 1647, `new RegExp` 47 |

The 47 `new RegExp` count independently matches `git grep -c "new RegExp"`
(36 core-backend + 10 apps-web + 1 plugins). Every `.vue` was parsed by pulling
each `<script>` block out with its byte offset preserved so reported lines match
the SFC. **Parse-failure count is asserted 0**, not assumed.

## 2. Static filter + fuzz denominator

| metric | value |
|---|---|
| sites total | 1694 |
| unresolvable pattern (`new RegExp(expr)` — pattern not a literal/const) | 47 |
| no unbounded quantifier (statically cannot be super-linear in \|input\|) | 921 |
| distinct `(pattern, flags, method)` fuzz jobs | 415 |
| **flagged super-linear** | **14** |
| fuzz errors | 0 |

The 47 unresolvable were **hand-read** (class-two hunt). Per-site provenance
(not a sweeping claim — the first draft asserted "all but the formula engine are
safe", which was **wrong**; a second class-two site, `field-validation-engine.ts:103`,
was found and is finding L2):

**CONFIRMED live class-two (MITIGATED on branch — see design MD §3C/§3D for what that word
does and does not cover):**
- `formula/engine.ts:183,326,329,332` — SUBSTITUTE + REGEX*; pattern = user
  formula arg. Finding L1.
- `multitable/field-validation-engine.ts:103` — `rule.params.regex` from the
  uncapped `property.validation` blob; runs on record write / public form submit.
  Finding L2. (Measured § 4.4.)

**UNVERIFIED — pattern is config/query/author-derived, NOT swept as safe (owner-review):**
- `data-adapters/RedisAdapter.ts:532` — `value.$regex` + `value.$options` flags
  (Mongo-style query operator; potentially query-derived).
- `services/ApprovalGraphExecutor.ts:729` — `new RegExp(pattern).test(...)`
  (approval-graph condition; author-supplied).
- `core/plugin-config-manager.ts:150`, `plugin/PluginConfigManager.ts:633` —
  `validation.pattern` / `item.pattern` from plugin config.
- `gateway/APIGateway.ts:640,939` — `rules.pattern` / `pattern` from gateway route
  config.
- `sandbox/SafeFunctions.ts:361` — `pattern` (sandbox).
- `plugins/plugin-attendance/index.cjs:12490` — `new RegExp(pattern, 'i')`.
- ~~`apps/web/src/views/FormView.vue:650`~~ — RESOLVED in round 2: the FE mirror now routes
  through `apps/web/src/utils/userRegexGuard.ts` (post-image `FormView.vue:658`), so it
  agrees with the backend about which values are refused. Design MD §3F.

**MISSED BY THE ROUND-1 SCOPE GLOB (`plugins/*/index.cjs` excludes `plugins/*/lib/**`):**
- `plugins/plugin-integration-core/lib/validator.cjs` — finding **L3**. Measured 20164ms
  in-process at a 33-character value; reachability argued, not proven. Design MD §3E.
  A full re-run over `plugins/**/*.cjs` is NOT done (§6).

**Verified safe (escaping present in source) / low-risk template:**
- Escaped: `services/ApprovalProductService.ts:3166`,
  `integration/messaging/message-bus.ts:331,334`,
  `apps/web/.../approvalFormCommands.ts:405,414`, `.../conditionEdit.ts:324-342`,
  `.../MetaCommentComposer.vue:349,378,422` (all use `escapeRegExp`/`escapeRegex`
  or `.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')`).
- Template over a fixed/enumerated token (function/api/element name):
  `routes/univer-meta.ts:1588`, `sandbox/SecurityPolicy.ts:185,308`,
  `messaging/pattern-trie.ts:267`, `workflow/bpmnCompilePreview.ts:289,290,315`.
- Internal glob/placeholder, not a user-facing pattern: `core/EventBusService.ts:765`,
  `services/CacheService.ts:210`, `sandbox/SandboxManager.ts:319`.
- Test-only files (not production): `attendance/__tests__/w4c2-*`,
  `w4c3a-rollout-control-inventory.test.ts`, `w4c3c-active-current.test.ts`,
  `tests/audit-system.test.ts`.

## 3. Instrument controls — 6/6 pass (what makes "flagged vs not" a conclusion, not a guess)

`run-controls.cjs`:

| control | expect | got | evidence |
|---|---|---|---|
| POS-1 real `NAME_EDGE_TRIM_PATTERN` (`^[cls]+\|[cls]+$`, `gu`, `.replace`) — the precedent, measured elsewhere at 49s/15.01s | super-linear | **super-linear** | ratio 93.4, 4233ms @1e5; discriminating shape = non-member-head+member-run+non-member-tail, ladder `[0.46, 45.3, 4233]ms` |
| POS-2 classic `^(a+)+$` (`.test`) | super-linear | **super-linear** | UNFINISHED, killed after 20000ms |
| POS-3 whitespace trim idiom `^\s+\|\s+$` (`g`, `.replace`) | super-linear | **super-linear** | ratio 93.2, 4247ms @1e5 |
| NEG-1 unanchored `\s+` (`g`) — no failing tail | linear | **linear** | ratio 1, 0.07ms |
| NEG-2 `^[a-z0-9-]+$` | linear | **linear** | ratio 1, 0.09ms |
| NEG-3 `^[0-9]{4}-[0-9]{2}$` (no unbounded quant) | linear-no-quant | **linear-no-quant** | filtered pre-fuzz |

**Control correction (recorded, per doctrine).** NEG-1 was first specified as
`^\s+|\s+$/g` on the assumption the plain trim idiom is safe. The instrument
flagged it super-linear; an **independent hand-check with no fuzzer in the loop**
confirmed it: on `"Z"+" ".repeat(N)+"Z"`, doubling N quadruples the time
(N=5000→13ms, 10000→46ms, 20000→174ms, 40000→692ms) — O(n²) — while native
`.trim()` is flat (N=1e6→0.1ms). The expectation was wrong, not the instrument.
NEG-1 was reclassified POS-3; a new NEG-1 (`\s+/g`, no failing tail) was added.
The POS-1 pass on the **exact real precedent pattern** is the proof the classifier
has discriminating power: without it, a zero-findings census would be
indistinguishable from a broken extractor.

## 4. The live findings — reproduced on the real origin/main code

L1 (formula engine) in § 4.1–4.3; L2 (field-validation pattern rule) in § 4.4.

### 4.1 (L1) In-process, via the route's own method `MultitableFormulaEngine.dryRun`
(`probe-dryrun.ts`; the no-DB engine constructed exactly as `univer-meta.ts:452`).
Each row also replays the route's three caps against the attack expression:

| attack expression | length | caps verdict | time |
|---|---|---|---|
| benign `REGEXMATCH(a×5000, "^[a-z]+$")` | 5026 | len-cap REJECT (control) | 1.2ms |
| `REGEXMATCH(a×20 +"!", "^(a+)+$")` | 46 | **ALL CAPS PASS** | 26.9ms |
| `REGEXMATCH(a×28 +"!", "^(a+)+$")` | 54 | **ALL CAPS PASS** | 1278ms |
| `REGEXMATCH(a×30 +"!", "^(a+)+$")` | 56 | **ALL CAPS PASS** | 5101ms |
| `REGEXMATCH(a×32 +"!", "^(a+)+$")` | 58 | **ALL CAPS PASS** (len 58/4000, depth 2/32, refs 0/64) | **20368ms** |

A 58-character request passes every structural cap and blocks for 20s. The +2-in-n
≈ 4× growth is the exponential signature.

### 4.2 Stored path (any-user trigger) via `evaluateField`
(`probe-stored.ts`; the method `recalculateRecordFromData` calls at
`multitable/formula-engine.ts:339`):

| stored formula | record value | time |
|---|---|---|
| `UPPER({fld})` (negative control) | 100k chars | 10.2ms |
| `REGEXMATCH(a×32+"!", "^(a+)+$")` | — | 20655ms |
| `REGEXREPLACE({fld}, "^\s+\|\s+$", "")` | `"Z"+" "×100000+"Z"` | 4272ms |

Field-write validation is `property: z.record(z.unknown())`
(`univer-meta.ts:13471`, `:13842`) — no cap on the stored expression.

### 4.3 Out-of-band cross-tenant blocking (the P1 criterion) — real Express + one-shot DB
`oob-server.ts` (real Express on the real single-threaded event loop; attacker
route calls the real `dryRun`; victim `GET /victim/ping` does a real `SELECT 1`
against `metasheet2_h3_20260922`) + `oob-client.mjs`. Server startup line:
`LISTENING <port> db=metasheet2_h3_20260922 user=ms2testbed`.

| phase | victim GET latency | attacker |
|---|---|---|
| baseline (no attack) | max 49ms (first-conn warmup), then 1–2ms | — |
| **NEG control: benign-pattern attacker in flight** | **max 18ms (flat)** | 57-char benign req, server 1ms |
| **POSITIVE: `^(a+)+$` attacker in flight** | **max 54967ms** | 57-char req, server 55058ms |
| RECOVERY (after attack) | max 3ms | — |

**A 57-character request from tenant A froze tenant B's unrelated, DB-backed GET
for ~55 seconds.** Two negatives in place (benign attacker leaves the victim flat;
victim recovers to 3ms after the attack), one positive (catastrophic attacker
blocks). This mirrors the precedent's evidence shape (victim GET blocked 15.01s)
and is well past the finding's >1s threshold.

### 4.4 (L2) Field-validation pattern rule via the real `validateRecord`
(`probe-validate.ts`; `validateRecord` called exactly as `univer-meta.ts:17526`,
with rules shaped as `{type:'pattern', params:{regex}}` parsed from
`property.validation`):

| stored pattern rule | record value | time | result |
|---|---|---|---|
| `^[a-z]+$` (negative control) | 100k chars | 0.1ms | valid:true |
| `^(a+)+$` | `a×24 + "!"` | 431ms | valid:false |
| `^(a+)+$` | `a×28 + "!"` | 1274ms | valid:false |
| `^(a+)+$` | `a×30 + "!"` | 5196ms | valid:false |
| `^(a+)+$` | `a×32 + "!"` | **20545ms** | valid:false |

The benign pattern on a 100k value is 0.1ms; the nested-quantifier pattern on a
33-char value blocks 20.5s — the input source is the field's own uncapped
`property.validation` (`univer-meta.ts:17519-17525`), the trigger is any record
write / public form submit. NOTE (recorded): the first probe run used
`params.pattern` and got 0ms/valid:true — the real dispatch reads `params.regex`
(`field-validation-engine.ts:168-171`); corrected, the site fired. This is why the
"all 47 safe" first-draft claim was false and why this finding was initially missed.

## 5. What the round-2 guard was measured to do — in both directions

Round 1's heading here read *"The fixes work — old implementation vs new"*. **That claim is
withdrawn.** It was true only of the one shape the detector happened to catch; an
independent gate measured the same build refusing six common LINEAR patterns and still
admitting `^(a|a)*$` at 22437ms. The replacement is a **mitigation**, and the two tables
below are deliberately separate because they are separate claims.

### 5.1 Suites

```
CI=true npx vitest run src/formula/__tests__/regex-safety.test.ts \
  tests/unit/user-regex-guard-three-copy-parity.test.ts \
  tests/unit/user-regex-guard-read-parity-fuzz.test.ts \
  tests/unit/formula-engine.test.ts tests/unit/field-validation.test.ts \
  tests/unit/field-validation-wiring.test.ts --config vitest.config.ts
```
→ round 3b, re-counted at this head: `regex-safety` **60**, three-copy parity **33**,
read-parity fuzz **4**, formula-engine **87**, field-validation **72**,
field-validation-wiring **5** = **261 passed / 6 files**. (Round 2 read 45 / 32 for the
first two; the cases added since are listed in §5.8.2 and §5.8.9(e).)

Full default lane (the config CI's backend job uses), **no DATABASE_URL — the lane's own
`exclude` list drops every DB-backed integration spec, and this slice's mechanism is
DB-independent**:
```
CI=true pnpm --filter @metasheet/core-backend test     # the required job's own step, §5.8.10
→ Test Files  982 passed | 175 skipped (1157)
        Tests  15988 passed | 1615 skipped (17603)      exit 0
```
`plugins/plugin-integration-core`: `node scripts/test-chain.cjs` → **229 suites passed**.
`packages/core-backend`: `npx tsc --noEmit -p tsconfig.json` → exit 0, no output.
`apps/web`: `npx vue-tsc --noEmit -p tsconfig.app.json` → exit 0, no output. (`vue-tsc -b`
additionally type-checks `vite.config.ts` and fails there with a vite 5-vs-7 `PluginOption`
mismatch in the shared `node_modules`; that file is not in this diff and the failure
reproduces without it — environmental, recorded rather than hidden.)

### 5.2 FALSE POSITIVES — the six patterns round 1 refused (200 runs each)

Adversarial subject at the ceiling: long member run + failing tail, 10000 characters.

| pattern | refused | worst guarded call | worst SINGLE ladder rung |
|---|---|---|---|
| `^\d+(\.\d+)*$` version number | **0 / 200** | 0.49ms | 0.041ms |
| `^[a-z0-9]+(-[a-z0-9]+)*$` slug | **0 / 200** | 0.55ms | 0.069ms |
| `^(\w+\.)*\w+$` dotted identifier | **0 / 200** | 0.60ms | 0.044ms |
| `^[a-z]+(,[a-z]+)*$` comma list | **0 / 200** | 0.54ms | 0.030ms |
| `^[^@]+@[^@]+(\.[^@]+)+$` e-mail | **0 / 200** | 0.25ms | 0.012ms |
| `^(/[a-z0-9_-]+)+$` path segments | **0 / 200** | 0.59ms | 0.038ms |

**0 / 1200.** The "worst single rung" column is the load-bearing one: the deciding branch
is only reachable once a rung crosses `USER_REGEX_PROBE_FLOOR_MS = 2`, and the worst rung
over the whole ladder for this corpus is 0.069ms — ~29x under it.

**That 29x is headroom, not a bound, and the next paragraph is why.** 0.069ms is the cost of
the regex work in a rung. What the floor actually compares against is the WALL time of that
rung, which also absorbs whatever the runtime does inside it — a GC pause lands in exactly
that window. Re-measured over 50 full-ladder passes per pattern, the median pass's worst
rung is 0.014–0.048ms (consistent with 0.069ms) while the worst pass reaches tens of
milliseconds; that tail is dominated by allocation pressure and, in the run that produced
it, by the measuring harness's own retained probe strings rather than by the guard. So the
two numbers below are not in conflict: **29x of headroom on regex cost, and a measured
1-in-100000 rate of the floor being crossed anyway once real allocation load is present.**
The headroom is what makes the rate small; it is not what makes it zero, and nothing here
bounds the rate on a loaded host.

**Round 3 widened this and found the limit of the claim.** Re-run at 3000x6 = **18000
calls**, with a counter patched into the deciding branch itself rather than inferred from
rung timings: **deciding branch entered 0 times, 0 refusals.** But the same counter over
the 100000-pair fuzz corpus (§5.4) enters the deciding branch **once**, and the slope test
calls that one pair super-linear — the confirmation re-measurement is what declines to
refuse it. So the corpus-scoped statement stands and the general one does not:

| corpus | calls | deciding branch entered | slope said super-linear | refused |
|---|---|---|---|---|
| the six linear patterns, adversarial subject at the ceiling | 18000 | **0** | 0 | **0** |
| differential fuzz, random linear pairs (§5.4) | 100000 | **1** | **1** | **0** |

The earlier wording ("for a linear pattern the verdict is not timing-dependent at all; the
timing branch is never entered") was a generalisation from the first row to all linear
input, and the second row is a counter-example to it. Corrected claim: **on the six-pattern
corpus the verdict is not timing-dependent; across random linear input it is
timing-dependent at roughly 1e-5 of calls, and at that rate the confirmation
re-measurement — not the floor — is what prevents a refusal.** That is why the
re-measurement is now pinned (mutation M5, §5.5).

### 5.3 TRUE POSITIVES — the three catastrophic shapes (200 runs each)

Subject `a`×32 + `!` (n=33). **Unguarded, this exact input was measured at 20545ms** (§4.4).

| pattern | refused | worst guarded call | fitted slope | extrapolated cost | decided at rung |
|---|---|---|---|---|---|
| `^(a+)+$` | **200 / 200** | 11.2ms | 12.5 | 1291ms | len 20 |
| `^(a\|a)*$` — the shape round 1 ADMITTED at 22437ms | **200 / 200** | 13.9ms | 12.5 | 1516ms | len 20 |
| `^([a-z]\|[a-z])*$` | **200 / 200** | 14.4ms | 12.7 | 1849ms | len 20 |

**600 / 600**, worst 14.4ms, i.e. ~1400x under the unguarded 20545ms on the same input and
well under the 100ms the task set. Refusal reaches the caller as a distinct message
(`"…validation pattern is too slow on this value to be evaluated safely"`), never as the
format-mismatch wording.

**For these three shapes, time-to-refusal does not grow with the subject** (round 3; the
table above is n=33 only, and a reader could reasonably assume a ceiling-length subject costs
proportionally more). The ladder decides at a rung around len 20 for each of them, so the
real subject length never enters the cost. **This is a statement about the three named
shapes, not a property of the guard** — design MD §3D.1 burns 495760ms inside the ladder on a
different shape, and §3D.2 measures 644.7ms in a single rung at n=1200. Both are
counterexamples to the general reading:

| pattern | n=33 | n=10000 (the ceiling) | unguarded at n=33 |
|---|---|---|---|
| `^(a+)+$` | 14.5ms | 12.4ms | **21794ms** |
| `^(a\|a)*$` | 13.1ms | 13.9ms | **57468ms** |
| `^([a-z]\|[a-z])*$` | 13.9ms | 13.3ms | **102183ms** |

The unguarded column is a fresh round-3 measurement of the same three shapes at n=33 on
this machine. `^([a-z]|[a-z])*$` at **102 seconds** is the worst number this slice has
produced anywhere, and round 1's detector admitted two of these three.

**Two numbers that must not be read as one.** "Three named malicious shapes refuse in
≤14.5ms" (these tables) and "the worst ACCEPTED shape at the ceiling costs 90ms" (design MD
§3.3.1) are different claims about different populations. The second is a polynomial shape
the slope test deliberately accepts; it is not inside the malicious-shape budget and is not
meant to be.

### 5.4 READ PARITY — differential fuzz, 100000 pairs

`tests/unit/user-regex-guard-read-parity-fuzz.test.ts`. Seeded (`mulberry32`, seed
`0x5eed1234`); `H3_FUZZ_ITERATIONS` / `H3_FUZZ_SEED` override. The reference implementation
is `origin/main`'s `validatePattern` body, inlined because the point is to run the OLD code
and the old code is no longer in the tree.

| metric | value |
|---|---|
| random (pattern, flags, value) pairs compared | **100000** |
| divergences (verdict differs) | **0** |
| refusals inside the corpus | **0** |
| wall clock | 1632ms |
| second pass through the real `validateRecord`, error text included | 5000 pairs, 0 divergences |

Corpus hygiene is asserted, not assumed: >1000 distinct patterns and >1000 distinct
subjects per 2000 draws, both `true` and `false` verdicts present in quantity, and the
corpus is asserted to CONTAIN the `(...)+`-over-a-class shape round 1 refused — otherwise
"all equal" would be a statement about an empty intersection.

**POSITIVE CONTROL** (without it, "100000 equal" is indistinguishable from comparing
nothing): an over-ceiling subject is asserted to make the two implementations DISAGREE
(`true` vs `refused`), and `^(a+)+$` at n=33 is asserted to be refused.

**Which population these 100000 pairs actually cover** (round 3 — stated because "0
divergences" reads stronger than it is). The guarded and unguarded implementations can
only differ on a pair the guard REFUSES, and refusal needs the deciding branch. Instrumented
with a counter inside that branch, the corpus enters it **1 time in 100000** and the slope
test calls that single pair super-linear; the confirmation re-measurement declines, so the
refusal count is 0 and parity is 100000/100000. In other words this fuzz is overwhelmingly
a proof about the population where **the ladder never fires** — which is the right
population for a read-parity claim, and is not the same as proving the guard's refusal rule
correct. The fires-population is covered by the unit cases instead: 6 must-ACCEPT linear
patterns on adversarial ceiling-length subjects, 3 must-REFUSE catastrophic shapes × 200
repeats, 4 `selectFitAnchor` cases, and the confirmation-re-measurement case (§5.5 M5).

Recorded as a negative result: with `bestOf` collapsed to one sample (mutation M5), the
same corpus still ran 3× with 0 divergences. The one pair that crosses the floor is not
reliably refused by the mutant either, which is exactly why a corpus-level assertion cannot
pin that guard and a constructed case is needed.

### 5.5 MUTATION TABLE

Every mutation applied in the throwaway worktree by `cp` backup → edit → run → `cp`
restore → re-run green. **No `git checkout --`, no `reset --hard`, no `stash`.** Suite =
the three guard files (81 cases). Baseline restored green after every row.

| # | mutation | result | what went red |
|---|---|---|---|
| **M1** | delete the subject-length ceiling in `regex-safety.ts` | **3 failed** | over-ceiling refusal (backend + parity table), FE/backend ceiling agreement |
| **M2** | delete the pattern-length ceiling | **2 failed** | `pattern-length ceiling > refuses an over-length pattern before compiling it` |
| **M3** | neuter the ladder (iterate an empty rung list) | **12 failed** | every catastrophic-shape refusal, in all three copies |
| **M4** | drop the final-approach rungs from `userRegexProbeLadder` | **2 failed** | ladder ends at n−1; rung count 60≠63; three-copy ladder equality |
| **M5** | `REGEXMATCH` bypasses the guard (bare `new RegExp`) | **3 failed** | `#ERROR!` expected, got the 20-second real answer |
| **M6** | `evaluatePatternRule` bypasses the guard | **4 failed** | refusal message must differ from the format-mismatch message |
| **M7** | `validator.cjs` bypasses the guard | **2 failed** | plugin refusal 20164.9ms ≥ 2000ms; `PATTERN_NOT_EVALUATED` missing |
| **M8** | FE copy's ceiling changed to 20000 | **2 failed** | three-copy constant equality; FE verdict diverges |
| **M9** | `FormView.vue` reverted to `new RegExp(validation.pattern)` | **1 failed** | FE call-site text pin |
| **M10** | re-introduce round-1-style shape rejection (refuse any `)+` / `)*`) | **29 failed** | the whole false-positive battery + the fuzz corpus |
| **M11** | fit the ADJACENT rung instead of the dynamic-range anchor | **4 failed** | `selectFitAnchor` unit cases + three-copy anchor equality |

**Round 3 re-ran the whole battery against the final tree** (11 mutations, `--retry=0` so a
retry cannot absorb a red, suite = the six files, 245 cases). Ten of eleven red; the
counts above are reproduced within ±1. **One came back GREEN and is a finding, not a row:**

| # | mutation | round-3 result | disposition |
|---|---|---|---|
| **M12** | `bestOf` collapsed to a single sample — the confirmation re-measurement on the refusal path | **245 / 245 GREEN** | **untested guard**; now pinned, see below |
| M13 | the ladder's final-approach list widened to 14 deltas (cost blow-up; rung count still under the old `< 80` pin) | **GREEN under the old pins** | now pinned by the total-work assertion |

M12 is the guard that decides whether a one-off scheduling spike becomes a write-path
refusal, and §5.4 shows the fuzz corpus reaching that branch once in 100000. Deleting it
left every case green because a quiet process never inflates a sample — the textbook shape
of a guard nothing tests. It is now pinned by a constructed case that drives the inflation
through the `execute` seam the guard already takes (one rung expensive for its first two
measurements, free after) and asserts both the behaviour (`status === 'ok'`) and the
mechanism (the deciding rung was sampled ≥3 times — a call COUNT, so no duration is
asserted and it cannot flake). Verified: the mutation now fails 1/47.

M13 is the same class one level up. The old pin was `ladder(ceiling).length < 80`, which
bounds the rung COUNT and not the WORK — eight more final-approach rungs move the count by
8 and the characters scanned by 8n. Now pinned as total probe characters ≤ 16n with a
non-degeneracy floor. Verified: the mutation fails 1/47.

**M11 is recorded with its history, because it is the one that nearly got away.** Against
the BEHAVIOURAL suite alone the same mutation passed **5 / 5** runs — the failure it
reintroduces is intermittent (measured: `^(a+)+$` at n=33 accepted, then 22248ms), and an
intermittent defect cannot be pinned by a behavioural assertion. The anchor rule was
therefore extracted into an exported pure function `selectFitAnchor` specifically so it
could be pinned deterministically. The repeat-loop test (20 runs × 3 patterns) is kept as a
flake-catcher and is labelled in the source as having high but not certain power.

### 5.6 Guard overhead (it is not free)

Per guarded call, measured against the unguarded `new RegExp(p).test(v)`:

| case | subject | unguarded | guarded | rungs |
|---|---|---|---|---|
| slug, typical value | 13 | 0.0001ms | 0.0029ms | 11 |
| e-mail, typical value | 19 | 0.0001ms | 0.0030ms | 17 |
| anchored class | 2000 | 0.0006ms | 0.0154ms | 56 |
| anchored class | 10000 | 0.0027ms | 0.0472ms | 63 |
| slug, adversarial | 10000 | 0.0308ms | 0.4436ms | 63 |

14x–49x relative, 3µs–444µs absolute.

**The mechanism sentence this section used to carry was wrong, and the correction matters
more than the numbers.** It read: *"its cost is bounded by a few multiples of
`USER_REGEX_PROBE_FLOOR_MS` plus one real call, because it stops at the first rung that
crosses the floor."* On a linear pattern **no rung ever crosses the floor** (§5.2), so the
loop never breaks early and the guard pays **every** rung — and the benign path is the
common path: every record write on every field carrying a pattern rule. The bound is
structural, not an early exit:

| n | rungs | total probe characters | = multiples of the real subject |
|---|---|---|---|
| 20 | 18 | 189 | 9.4x |
| 200 | 40 | 1815 | 9.1x |
| 1000 | 53 | 13102 | 13.1x |
| 10000 | 63 | 124494 | **12.4x** |

So the honest statement is "the guard scans the subject about twelve times over, plus one
real call", and that ratio is now an assertion rather than a paragraph (§5.5 M13).

**Round 3 — the benign path measured against the true pre-image**, i.e. `validateRecord`
from `origin/main` (`git show cd42eaf74:…/field-validation-engine.ts`) imported alongside
the guarded one, not a re-implementation:

| case | guarded | pre-image | multiplier |
|---|---|---|---|
| 1 field, 20-char value | 0.0040ms | 0.0003ms | 12.4x |
| 1 field, 200-char value | 0.0082ms | 0.0003ms | 23.5x |
| 1 field, 1000-char value | 0.0188ms | 0.0008ms | 23.9x |
| 1 field, ceiling-length value | 0.1038ms | 0.0070ms | 14.8x |
| 20 fields, 20-char values | 0.0589ms | 0.0026ms | 22.4x |
| 20 fields, 200-char values | 0.1403ms | 0.0042ms | 33.7x |
| 20 fields, ceiling-length values | 1.9518ms | 0.1305ms | 15.0x |
| **1000 records × 1 field, 20-char values** | **3.0ms** | 0.16ms | 19.1x |
| **1000 records × 1 field, 200-char values** | **6.9ms** | 0.29ms | 24.0x |

**Relative cost is 12x–34x; absolute cost is what decides whether that matters, and it is
bounded by the request body limit.** `express.json({ limit: '10mb' })`
(`packages/core-backend/src/index.ts`) caps one request at ~10MB, so the most
pattern-checked characters a single request can carry is ~10⁷ — about 1000 ceiling-length
values. The per-value cost is NOT one number: the per-call table above runs from 0.0472ms
(anchored class at the ceiling) to **0.4436ms** (slug on an adversarial value at the
ceiling), and the aggregate table below reads 0.1038ms for one ceiling-length field. The
bound is therefore **~100ms to ~440ms of added event-loop occupancy for the largest request
the server will accept**, against ~7ms unguarded. Round 2 quoted the cheap row alone, which
understated its own upper corner by 4.4x; a bound is taken from the expensive row.

At realistic value lengths a 1000-record import pays **3–7ms**. Stated as the upper corner rather than the typical case, and it is
an owner item (design MD §3.4.9) rather than something this round absorbs: the honest
reading is "bounded and small in absolute terms, but a 12–34x multiplier on a hot path is
a real cost that a linear-time engine would not have".

**Per-call is the wrong unit for a finding about event-loop occupancy**, so the aggregate
shape was measured too: one `validateRecord` over a record carrying 20 pattern-ruled
fields (the loop that actually runs on a record write).

| record | value length | guarded | unguarded |
|---|---|---|---|
| 20 slug fields, typical value | 13 | **0.069ms** | 0.002ms |
| 20 e-mail fields, typical value | 19 | **0.080ms** | 0.002ms |
| 20 slug fields, 1000-char value | 1000 | 1.013ms | 0.057ms |
| 20 slug fields, ceiling-length value | 10000 | 7.895ms | 0.572ms |

At realistic value lengths a 20-field record costs tens of microseconds of guard overhead.
The ceiling-length row is the honest upper corner: 7.9ms per record, ~14x the unguarded
0.57ms, and it is the row a bulk path would multiply. Round 3 measured that multiplication
in-process (1000 records: 3.0ms / 6.9ms) and derived the per-request bound from the 10MB
body limit — see the round-3 block above. **STILL NOT RUN:** no real HTTP import /
batch-create measurement, and no concurrency measurement of the guard's own cost. §6.

### 5.8 ROUND 3 — what changed, and what it was measured to do

Round 3 answers the four P2 findings of the round-2 gate. Everything below was measured on
this machine in one session; the suite numbers are version-independent, the millisecond
numbers are not (§6).

**5.8.1 A rung that re-measures below the floor now decides nothing (P2-1).**
The only gate into the deciding branch is the floor test, and round 2 fed the re-measured
value back into the SLOPE alone — so the guard could prove its entry sample was noise and
refuse on it anyway, contradicting the contract `USER_REGEX_PROBE_FLOOR_MS` states in its
own doc comment. Reproduced here independently of the gate, in one process with 180000 live
ballast objects so the heap has a realistic shape, one benign pair (a quadratic pattern
against a ceiling-length subject, unguarded answer `false`), 2000 runs of each build:

| build | refusals | the refusal's own evidence |
|---|---|---|
| round 2 (`bab083dc4`) | **1 / 2000 refused** | `slope=4.17 pred=4596880ms atLen=60 measuredMs=0.00` |
| round 3 | **0 / 2000 refused** | — |

`measuredMs=0.00` against a 2ms floor: the re-measurement had already shown the rung cost
nothing, and the refusal went out regardless.

**5.8.1b The first cut of that fix was WORSE than the defect it fixed, and that is the more
useful record.** Withdrawing the refusal while leaving the loop's `break` in place stops the
ladder and hands the real call a pattern whose cost curve was never established. Measured on
that cut: `^(a|a)*$` at n=33 entered the branch at rung 19 — ladder sample 2.41ms,
confirmations 1.46ms and 1.48ms — the refusal was withdrawn, the ladder stopped, and the
real call ran for **21884ms**. **1 in 1000 calls, where round 2 refused 1000/1000.**

The mechanism is not a pause. `bestOf` takes a MINIMUM, and the minimum is biased DOWNWARD
by warm-up: the FIRST sample at a given probe length is systematically the slowest, so a
rung whose steady-state cost sits just under the floor can cross it once and never again.
Measured standalone, the deciding rung for the three named shapes costs 2.18ms–3.14ms
(p5–p95) against a 2ms floor — a margin of well under 2x, which is why this is reachable at
all.

The shipped rule is the whole invariant, not half of it: a rung that re-measures below the
floor is recorded as an ordinary sub-floor sample and **the ladder keeps climbing**. The
next rung up is above the floor on every sample and refuses there. Re-measured after the
correction: **0 acceptances in 1000 runs** for each of the three named shapes, against
1/1000 for `^(a\|a)*$` on the first cut.

**5.8.2 Five ACCEPT-side guards are now pinned (P2-2).**
The gate mutated four guards that decide NOT to refuse and all 247 cases stayed green. A
fifth — the `predictedMs > USER_REGEX_PROBE_BUDGET_MS` conjunct, the gate's `Mh` — the gate
reported as pinned (1 red); re-run at the round-3 head it came back **GREEN**, so whatever
reddened it in round 2 was not a deterministic case. Rather than carry that claim forward
unverified it gets a case too.

The root cause is structural, not an oversight: the false-positive corpus never enters the
deciding branch (0 entries in 18000 calls, §5.2) and the true-positive corpus is refused
under any single conjunct alone, so the branch's accept side has no natural input at all.
Five constructed cost curves now cover it, each asserting an outcome AND a sample count at a
NAMED rung length. The round-2 case asserted `Math.max` over every rung, which is satisfied
by ANY rung being sampled three times; it now names the deciding rung and the anchor rung
separately, and that alone catches two mutations it used to miss.

**5.8.3 The confirmation is bounded (P2-4).**
`USER_REGEX_REMEASURE_BUDGET_MS = 200`, spent against the total time the call has spent
measuring. Before/after in the same process, best of three runs each, against the unguarded
`new RegExp(...).test(...)`:

| pair | unguarded | round 2 | round 3 | verdict |
|---|---|---|---|---|
| the §3D.2 runway shape (26-char pattern / 1200-char value) | 0.001 | 1943.8 | 650.9 | refused -> refused |
| slug, adversarial at the ceiling | 0.032 | 0.5 | 0.4 | ok -> ok |
| slug, matching (13 chars) | 0.000 | 0.0 | 0.0 | ok -> ok |
| anchored class at the ceiling | 0.003 | 0.1 | 0.1 | ok -> ok |
| version number, adversarial at the ceiling | 0.016 | 0.2 | 0.2 | ok -> ok |
| e-mail, adversarial at the ceiling | 0.003 | 0.2 | 0.2 | ok -> ok |
| path segments, adversarial at the ceiling | 0.037 | 0.5 | 0.5 | ok -> ok |
| quadratic trim idiom at the ceiling (/g) | 45.261 | 51.0 | 50.3 | ok -> ok |
| nested quantifier, n=33 (a true positive) | not run (~20s, see §5.3) | 10.6 | 10.2 | refused -> refused |
| alternation overlap, n=33 (a true positive) | not run (~20s, see §5.3) | 11.7 | 11.4 | refused -> refused |

The runway pair is the finding: **1943.8ms → 650.9ms**, same verdict, because the
deciding rung is measured once instead of three times. Its cost breakdown: 45 sub-floor
rungs cost 0.072ms in total and the single deciding rung at length 1184 costs 644.7ms, so
the residual is one probe and nothing here bounds it. Every benign row is unchanged; the
largest benign delta is under 1ms.

It is deliberately NOT applied to the ladder loop. Stopping the sweep early could skip the
rung that would have crossed the floor and turn a refusal into an acceptance — the same
class of mistake as 5.8.1b, one level up.

**5.8.4 What the guard ACCEPTS costs more than the budget suggests (P3-4).**
`USER_REGEX_PROBE_BUDGET_MS = 100` bounds an EXTRAPOLATION, not the real cost of a shape the
ladder accepts. Walking n up to the first refusal, per shape:

| pattern | first refused at | worst ACCEPTED single call |
|---|---|---|
| `^(a+)+$` | n=27 (11.0ms) | 165.2ms @ n=26 |
| `^(a\|a)*$` | n=28 (10.5ms) | 390.3ms @ n=27 |
| `^([a-z]\|[a-z])*$` | n=27 (12.6ms) | 186.5ms @ n=26 |
| `^(a{1,2})*$` | n=38 (41.9ms) | 162.3ms @ n=37 |

So the mitigation buys a reduction from ~20000ms to a worst accepted call of **165ms–390ms**
on this machine — roughly 50x–100x, not "everything is under 100ms" — and an attacker can
still call it repeatedly. That number belongs beside the 600/600 refusal count, not instead
of it.

**5.8.5 Aggregate cost, re-measured (P3-3).**
Through the real `validateRecord`, ceiling-length values, the slug pattern:

| pattern fields in one record | guarded |
|---|---|
| 1 | 0.2 |
| 20 | 3.4 |
| 200 | 33.7 |

**5.8.6 READ PARITY — round 2 vs round 3, field by field.**
An independent generator (wider than the in-repo suite: lookarounds, top-level alternation,
ten flag combinations, subjects to 96 characters), its own seed, the full outcome shape
compared — and every accepted pair also compared against the unguarded answer:

```
pairs=100000 distinctPatterns=64793
r2 refusals=969  r3 refusals=969
divergences (r2 vs r3, and new vs unguarded) = 0
```

Identical refusal counts and zero divergences: the round-3 changes move no verdict on this
corpus. Positive control (an over-ceiling subject must diverge) passes.

Re-run in round 3b with a different seed, since that round touches `regex-safety.ts` (comments
only) and adds cases:

```
pairs=100000 distinctPatterns=64697
r2 refusals=1083  r3 refusals=1083
divergences (r2 vs r3, and new vs unguarded) = 0
```

Positive control passes there too. `r2` is a copy of `bab083dc4` verified byte-identical to
that commit before the run (`git show <sha>:<path> | cmp -`), so "r2" is the reviewed head
and not a reconstruction of it.

**5.8.7 Round-3 mutation battery — the new guards.**
Same protocol as §5.5 (`cp` backup → edit → `cmp` to prove the edit took → run → `cp`
restore → `cmp` to prove the restore took). Suite = the six files, `--retry=0`.

| # | mutation | result | case(s) that went red |
|---|---|---|---|
| **X1** | the sub-floor withdrawal is never taken (a rung that re-measures below the floor still refuses) | **RED** (2 cases) | `a rung that re-measures BELOW the floor withdraws the refusal, not just the slope` + `a withdrawn refusal keeps climbing the ladder — a later rung can still refuse` |
| **X9** | the withdrawal stops the ladder instead of continuing it | **RED** (1 case) | `a withdrawn refusal keeps climbing the ladder — a later rung can still refuse` |
| **X10** | the withdrawn rung is not recorded as a sample | **RED** (1 case) | `a withdrawn refusal keeps climbing the ladder — a later rung can still refuse` |
| **X2** | drop the re-measurement budget break | **RED** (1 case) | `stops re-measuring once the call has already spent the measurement budget` |
| **X3** | a flat curve falls back to the ADJACENT rung instead of breaking | **RED** (1 case) | `a FLAT curve is not evidence: no anchor DYNAMIC_RANGE times cheaper => accept` |
| **X4** | drop the slope conjunct (budget alone decides) | **RED** (1 case) | `LINEAR growth whose extrapolation exceeds the budget is still accepted (slope is a conjunct, not a tie-break)` |
| **Mh** | drop the budget conjunct (slope alone decides) | **RED** (1 case) | `super-linear growth whose extrapolation stays INSIDE the budget is accepted (the budget is a conjunct too)` |
| **X5** | the first rung confirms once instead of three times | **RED** (1 case) | `the FIRST rung re-measures three times before refusing a 2-character subject` |
| **X6** | the anchor is confirmed with ONE sample instead of two | **RED** (3 cases) | `a withdrawn refusal keeps climbing the ladder — a later rung can still refuse` + `re-measures a one-off spike instead of turning it into a refusal` + `the ANCHOR is re-measured too, and the re-measured anchor is what the verdict uses` |
| **X7** | the anchor confirmation is deleted (the ladder sample stands) | **RED** (3 cases) |
| **X11** | insert the prescribed "statically provable linear" fast path at the top of `runUserRegex` | **RED** (16 cases) | the 4 `STAR-HEIGHT-1 POLYNOMIALS` cases + 9 `execute`-seam cases (4 `confirmation re-measurement`, 5 `deciding branch, ACCEPT side` — their synthetic patterns carry no quantified group either, so the fast path skips the seam) + 3 INVALID-PATTERN cases, because the prescribed fast path compiles `new RegExp` OUTSIDE the existing try/catch and throws where the guard used to return `invalid-pattern` |

X1, X9 and X10 are the three ways to get §5.8.1 wrong — never withdraw, withdraw and stop,
withdraw and forget the sample — and every one of the ten reds the case written for it. The
extra reds are not noise: X1 also reds the keeps-climbing case (never withdrawing means
never reaching the rung above), and X6/X7 also red the round-2 spike case and the
keeps-climbing case, because a mis-measured anchor changes which verdict the withdrawal
path is asked about. The round-2 spike case only catches them at all because its `Math.max`
assertion was replaced by two named-length ones.

**5.8.8 Round-3 re-run of the round-2 battery.**

| # | mutation | result |
|---|---|---|
| **Ma** | pattern-length ceiling deleted | **RED** (2 cases) |
| **Mb** | subject-length ceiling deleted | **RED** (4 cases) |
| **Md** | ladder neutered (empty rung list) | **suite did not finish (240s cap)** |
| **Me** | floor raised so no rung ever decides | **suite did not finish (240s cap)** |
| **Mf** | anchor = the adjacent rung | **RED** (7 cases) |
| **Mh** | drop the budget conjunct (slope alone decides) | **RED** (1 case) |
| **Mi2** | `USER_REGEX_PROBE_BUDGET_MS` x1000 | **RED** (15 cases) |
| **Mi3** | `USER_REGEX_SUPERLINEAR_SLOPE` x10 | **RED** (14 cases) |
| **Mj** | `MIN_MEASURABLE_MS` -> 0 | **GREEN** |
| **Mk** | probe becomes a pure prefix (drops the failing tail) | **RED** (13 cases) |
| **Mn** | deciding rung confirmed with a single sample | **RED** (3 cases) |
| **Mp** | final-approach rungs deleted | **RED** (3 cases) |
| **Mr** | FE subject ceiling drifts to 20000 | **RED** (2 cases) |
| **Mr2** | FE anchor rule drifts | **RED** (2 cases) |
| **Mr3** | FE probe becomes a pure prefix | **RED** (3 cases) |
| **Ms** | `validator.cjs` bypasses the guard | **RED** (2 cases) |
| **Mt** | `FormView.vue` reverts to a bare `new RegExp` | **RED** (1 case) |
| **Mu** | L2 field-validation bypasses the guard | **suite did not finish (240s cap)** |
| **Mv** | `SUBSTITUTE` reverts to a regex replacement | **RED** (1 case) |
| **Mw** | `REGEXMATCH` reverts to a bare `new RegExp` | **RED** (3 cases) |

"suite did not finish" means the run passed a 240s cap: those mutations take the guard off a
catastrophic shape, so the suite runs the unguarded regex and blocks. A run that cannot
finish is a red lane, not a green one; it is recorded as its own status rather than folded
into RED so the distinction stays visible. `Mj` is GREEN and is recorded as a known unpinned
constant (§6), not as a covered guard.

**5.8.9 The two remedies proposed for P2-4 were traced through the guard and declined — the
reasons are measurements, not arguments.**
Alongside the spend budget above, two further remedies were put for the runway regression:
skip the timing ladder for any pattern a STATIC rule can call linear, or CACHE the ladder's
conclusion per `(pattern, subject-length bucket)`. Both were implemented far enough to be
measured against the shipped guard. Neither is adopted, and each failed for a different
reason.

*(a) Coverage — the fast path would skip the ladder for none of the patterns it was for.*
The predicate implemented literally as worded ("no quantified group whose body carries a
quantifier, and none whose body carries an alternation"):

| population | takes the fast path |
|---|---|
| the six common linear patterns (§5.2) | **0 / 6** |
| the three named catastrophic shapes (§5.3) | 0 / 3 |
| the two star-height-1 polynomials below | **2 / 2** |

Every one of the six carries a quantified group — `(\.\d+)*`, `(-[a-z0-9]+)*`, `(\w+\.)*`,
`(,[a-z]+)*`, `(\.[^@]+)+`, `(/[a-z0-9_-]+)+` — which is exactly the property round 1's
detector keyed on when it refused all six (design MD §3C.1). A predicate sound enough to be
safe in the ACCEPT direction has to exclude them for the same reason round 1's could not
separate them in the REFUSE direction.

*(b) Soundness — it would remove refusals the guard makes today.* Two shapes with no
quantified group anywhere in the source, so the predicate calls both linear. Unguarded on
this machine:

| pattern | n=250 | n=500 | n=1000 | n=2000 | n=4000 | growth per doubling |
|---|---|---|---|---|---|---|
| `^a*a*a*a*b$` | 851ms | 2963ms | **38679ms** | — | — | x3.5 then x13.1 |
| `^.*.*.*b$` | 11.1ms | 24.4ms | 169ms | 1270ms | **10118ms** | x2.2 … x8.0 |

and what the SHIPPED ladder does with the same pairs:

| pattern | n=1000 | n=4000 | n=10000 (the ceiling) |
|---|---|---|---|
| `^a*a*a*a*b$` | refused, 22.5ms, slope 3.78 @len 80 | refused, 21.7ms | refused, 21.9ms |
| `^.*.*.*b$` | refused, 9.8ms, slope 2.59 @len 197 | refused, 20.8ms | refused, 11.9ms |

The subject ceiling is 10000, i.e. ten times the length at which the first shape already
costs 38.7 seconds. So the fast path does not merely fail to help — it hands the real call a
shape the guard refuses today, in 22ms, on measured evidence. That is a bypass, and it is
the same mistake as round 1's in the opposite direction: a shape is not evidence either way.

*(c) The cache — the verdict is not a function of `(pattern, subject length)`.*

| pattern | subject | guard | cost |
|---|---|---|---|
| `^(a+)+$` | 33 `a`s, matches immediately | **ok** | 0.492ms |
| `^(a+)+$` | 32 `a`s + a failing tail, **same length** | **refused** | 10.1ms |

Same pattern, same length bucket, opposite verdicts — because a backtracking blow-up is a
property of the (pattern, VALUE) pair, not of the pair's shape or size. Any cache keyed that
way serves the first row's `ok` to the second row's value and disables the guard for it. The
same value six characters shorter already costs 318ms unguarded.

*(d) What the benign rows cost without either remedy.* Independent re-measurement, best of
three in one process, `r2` = the reviewed head `bab083dc4` (a copy verified byte-identical
to that commit) and `r3` = this head:

| pair | unguarded | r2 | r3 | **r3 − unguarded** | verdict |
|---|---|---|---|---|---|
| the runway shape (26-char pattern / 1200-char value) | 0.001 | 1911 | **635** | 635 | refused -> refused |
| slug, adversarial at the ceiling | 0.032 | 0.453 | 0.466 | **0.434** | ok -> ok |
| slug, matching (13 chars) | 0.000 | 0.005 | 0.005 | **0.005** | ok -> ok |
| anchored class at the ceiling | 0.003 | 0.058 | 0.059 | **0.056** | ok -> ok |
| version number, adversarial at the ceiling | 0.019 | 0.259 | 0.233 | **0.214** | ok -> ok |
| e-mail, adversarial at the ceiling | 0.003 | 0.163 | 0.156 | **0.154** | ok -> ok |
| path segments, adversarial at the ceiling | 0.042 | 0.517 | 0.522 | **0.480** | ok -> ok |
| quadratic trim idiom at the ceiling (/g) | 45.2 | 48.7 | 51.9 | **6.8** | ok -> ok |
| nested quantifier, n=33 (a true positive) | not run | 9.4 | 9.3 | n/a | refused -> refused |
| alternation overlap, n=33 (a true positive) | not run | 13.2 | 10.6 | n/a | refused -> refused |

Every benign row pays **under half a millisecond** over the unguarded call. The single row
above a millisecond is the quadratic trim idiom — +6.8ms on a 45.2ms unguarded baseline,
+15% — and that is a POLYNOMIAL shape the slope test deliberately accepts, not one of the
linear patterns the remedy was aimed at. So the "a benign pair pays under a millisecond"
property already holds on this corpus, and neither remedy would have bought it for the six.

*(e) Both polynomial shapes are now pinned, so the fast path cannot be added quietly.*
`regex-safety.test.ts` gains five cases: a POSITIVE CONTROL asserting that the three named
catastrophic shapes AND all six linear patterns do carry a quantified group (without which
the predicate assertion would be vacuous), two cases through `runUserRegex` and two through
the real `validateRecord`. Their discriminating assertion is the VERDICT, not a time bound:
at the n chosen — 250 and 2000, picked so a regression that ACCEPTED the shape still
finishes in about a second rather than hanging a required lane — the unguarded call is fast
enough that no loose millisecond bound would separate the two implementations. That is
stated in the file rather than papered over. Mutation **X11** (insert the prescribed fast
path at the top of `runUserRegex`) turns the six-file suite **16 red**, four of them these
new behavioural cases; the red lines carry the leaked unguarded cost as their duration. The
positive control stays green under X11, as it must.

The four BEHAVIOURAL cases are timing-derived — the ladder has to cross the floor at a rung
and fit a slope above 2 — so their result was also read off the FULL-package run, where 982
files compete for forks, rather than only from a quiet process: **all five cases in the
block (the four plus the positive control) are green there** (same run as §5.8.10). That matters because the lane sets `retry: 2`, which would hide a single
flake rather than remove it. Quiet-process stability before that: 100/100 refused at each
chosen n. The same shape at n=1000 was 23/25, which is why `^.*.*.*b$` is pinned at n=2000
and not lower.

**5.8.10 CI collection (P2-3) — the round-2 gate's finding is REFUTED, and here is the
collection line.**
The gate reported that no workflow executes the three test files, having grepped the
workflows for the file names, for `vitest run` with no file arguments, and for `pnpm test` /
`npm test` / `pnpm -r test`. All four greps miss the step that actually runs them:

```
.github/workflows/plugin-tests.yml
  job `test:`                        (line 174, matrix node-version: [18.x, 20.x])
  step "Run core-backend tests"      (lines 842-844)
    run: pnpm --filter @metasheet/core-backend test
```

`test (20.x)` is a required context on `main` (`gh api repos/zensgit/metasheet2/branches/
main/protection` → the contexts list includes it). The package script is `"test": "vitest"`
— no file arguments and no `run` — so it is a WHOLE-CONFIG collection over
`vitest.config.ts`, and GitHub Actions sets `CI=true`, which is what makes vitest execute
once instead of watching. The step carries no `if:`, so it runs on both matrix legs. And the
workflow's `on.pull_request` carries only `branches: [main, develop]` — **no `paths` filter**
(the `paths` list in that file sits under `on.push`, not under `on.pull_request`), so the job
is not path-gated away on a PR that happens to touch only these files.

Run here, at this head, as the exact command the workflow runs:

```
CI=true pnpm --filter @metasheet/core-backend test
> @metasheet/core-backend@2.5.0 test .../h3-r3/packages/core-backend
> vitest
  Test Files  982 passed | 175 skipped (1157)
       Tests  15988 passed | 1615 skipped (17603)
```

Cases reported by that run, per file — the collection evidence, counted from the run's own
output rather than inferred from the glob:

| file | cases collected |
|---|---|
| `src/formula/__tests__/regex-safety.test.ts` | **60** |
| `tests/unit/user-regex-guard-three-copy-parity.test.ts` | **33** |
| `tests/unit/user-regex-guard-read-parity-fuzz.test.ts` | **4** |

So this slice's cases are gated by a required check as they stand. **No workflow file is
edited by this branch, therefore the `plugin-tests.yml` s6a provenance pin is untouched and
is not recomputed** — the two-point wiring registration (a `vitest.config.ts` exclude plus a
named step) applies to DB-backed specs that must be kept out of the no-DB lane, and none of
these three needs a database.

The limit of this claim, stated: what is verified is that the command the required job runs
collects and executes these files, reproduced locally at this head. The branch has no PR, so
no GitHub checks list has been observed executing it. "被触发≠被验证" cuts both ways, and the
remaining step is to read the check output on the PR.

### 5.9 SUBSTITUTE

`substituteLiteral("xa+y","a+","Z") → "xZy"` (arg-2 treated literally; the old regex impl
treated it as a quantifier). In-repo dependents (`grep -rn "SUBSTITUTE("`): one existing
test + one docs example, both literal args, both still pass. A stored
`SUBSTITUTE(x, "[0-9]", "")` in a customer database silently becomes a no-op — owner item,
design MD §3.4(1).

## 6. NOT RUN / limitations (explicit)

**Round-3 additions to this list, first:**
- **Node version.** Every millisecond figure in §5.8 was measured on **node v25.9.0**; the
  required lanes run **18.x / 20.x**. The timing tables are machine- AND version-relative.
  The eleven new cases are NOT: they drive a manufactured cost curve through the `execute`
  seam and assert outcomes and call counts, with no duration assertion anywhere.
- **The host was not quiet.** Two unrelated processes held two cores at 100% for the whole
  session. Every absolute number in §5.8 is therefore an upper-ish estimate rather than a
  best case, and the ratios are the evidence.
- **The 2000-run load measurement in §5.8.1 is not in any lane.** It needs a loaded heap and
  tolerance for a ~1e-3 event; a required lane cannot carry that. The lane carries the
  deterministic seam-driven cases instead.
- **The 2.18ms floor margin in §5.8.1b is a property of THIS machine.** On a host where the
  deciding rung for those shapes lands under 2ms, the ladder simply decides one rung later;
  on a host where the sub-floor rungs land above it, it decides one rung earlier. What the
  round-3 rule removes is the case where a withdrawal ENDS the measurement, not the
  machine-relativity of the floor itself (§3D.3).
- **The re-measurement budget is not proven unreachable by a benign pattern, only measured
  to be.** The worst benign ladder spend in §5.6 is single-digit milliseconds against a 200ms
  budget, and the sub-floor sweep is bounded below it structurally (rung count pinned < 80 x
  a 2ms floor). A host slow enough to make a benign rung cost 200ms would change the guard's
  behaviour anyway.
- **No metric, no log, no counter on the refusal path** — unchanged from round 2, and §5.8.1
  sharpens it: a refusal caused by measurement noise leaves nothing behind in production.
  Owner item (design MD §3.4.8).
- **The FE refusal string is English inside a zh-CN form.** `FormView.vue` renders
  `${field.label}: ${describeUserRegexRefusal(...)}`, so a Chinese form shows a Chinese label
  followed by an English sentence; the backend has the same shape. Cosmetic, disclosed, not
  fixed here — fixing it means adding an i18n surface to a payload-free operator string.
- **`MIN_MEASURABLE_MS` has no behavioural pin.** Setting it to 0 leaves the suite green and
  neither this round nor the round-2 gate could construct a verdict flip: at a zero anchor
  the extrapolation is dominated by the log ratio and stays far over budget either way. It
  changes only the `slope`/`predictedMs` REPORTED inside a refusal. Recorded as a known
  unpinned constant rather than presented as covered.
- **The L3 pattern-length ceiling is enforced after compilation, not before it.**
  `validator.cjs`'s `compilePattern` calls `new RegExp` before the guard sees the pattern, so
  the backend case "refuses an over-length pattern BEFORE compiling it" is L1/L2-scoped.
  Measured cost of the gap: 1.1ms to pre-compile a 133331-character alternation. Not
  restructured, because moving the check would change the error CODE this site reports
  (`PATTERN_NOT_EVALUATED` -> `INVALID_RULE`), a pipeline-visible contract change.
- **The re-measurement budget has no BEHAVIOURAL three-copy pin.** The constant's equality
  across the three copies is pinned, and the backend case pins the behaviour, but the shared
  case table has no rung expensive enough to reach the budget — same coverage shape as every
  other constant in that table.


- **The mitigation was NOT re-verified at victim latency (OOB).** The finding was proven at
  victim latency (55s cross-tenant, § 4.3); the mitigation is measured only in-process
  (§5.3). The inference — a call that returns in 14ms burns 14ms of CPU and therefore
  blocks the loop for 14ms — holds **for the inputs in §5.3 and for nothing else**. It does
  NOT extend to the shapes in design MD §3D: the runway family was measured spending
  495760ms inside the guard's own ladder, and no victim-latency figure exists for it. Round
  1 wrote "the inference is sound" without that qualifier; the qualifier is the point.
- **L2 cross-tenant HTTP proof** — NOT RUN. L2 was proven in-process only (§ 4.4,
  20.5s). It shares L1's shared-event-loop mechanism, so the cross-tenant
  consequence follows by the same argument as § 4.3, but the concurrent victim
  measurement was not repeated for L2.
- **Full application boot** against `metasheet2_h3_20260922` was NOT performed.
  The OOB proof used a focused real-Express harness that mounts the **real**
  `dryRun`/engine code and a real DB-backed victim route. The full auth/routing
  stack adds request latency but is **not part of the blocking mechanism** (a
  synchronous regex on the single-threaded event loop blocks regardless of what
  else is mounted). The one-shot DB is exercised by the victim's `SELECT 1`.
- **Per-site cross-tenant HTTP proof for the 14 flagged literal-shape sites** — NOT RUN. They
  were microbenchmarked only; reachability is traced or marked UNVERIFIED in the
  design table. No speculative fixes were shipped for UNVERIFIED-reachability
  sites (doctrine: dead-code defect ≠ live vulnerability).
- **Guard completeness** — the static detector is GONE (design MD §3C). The replacement is
  not exhaustive either and the boundary is enumerated in design MD §3D: cost that is
  discontinuous in subject length (`^.{64}(a+)+$`, measured 495760ms inside the ladder),
  probe truncation as a cost proxy rather than a semantic one, machine-relative constants,
  and a subject ceiling that bounds the subject rather than the cost. **The class is not
  closed.** The complete fix (RE2 / killable worker / step budget) is deferred to owner.
- **Census re-run over `plugins/**/*.cjs`** — NOT DONE. L3 was found by following the gate's
  pointer to one file, not by re-running the extractor over the widened glob. Other
  `plugins/*/lib/**` sites may exist. Design MD §3.4(7).
- **L3 end-to-end** — NOT RUN. `plugins/plugin-integration-core/lib/validator.cjs` was
  measured by direct `require` of the real module. No HTTP request was driven through
  `POST /api/integration/templates/preview`, and no confirmation was obtained that this
  plugin is active in the production deployment. Reachability is an argument over the
  static call graph plus the route table and `requireAccess(req, 'write')`; design MD §3E
  states exactly how far it goes.
- **The FE call site is pinned by source text only.** `apps/web`'s spec lane is not a
  required check and a backend lane cannot execute a Vue SFC, so
  `FormView.vue` is held by "imports the guard AND does not contain
  `new RegExp(validation.pattern)`" (mutation M9). The FE guard MODULE is pinned
  behaviourally (M8). Design MD §3F.
- **No victim-latency or concurrency measurement of the guard's own cost.** §5.6 is
  single-process timing. A 444µs guard on a hot write path was not load-tested.
- **Bulk write paths measured in-process only (round 3).** 1000 records × 1 pattern-ruled
  field costs 3.0ms guarded / 0.16ms pre-image at 20-char values and 6.9ms / 0.29ms at
  200-char values; the per-request upper corner derived from `express.json({limit:'10mb'})`
  is ~100ms guarded against ~7ms unguarded (§5.6). **What is still missing** is the same
  shape through a real HTTP import / batch-create endpoint, and any concurrency
  measurement — the numbers above are a single process doing nothing else, which is the
  friendliest possible condition for a guard whose cost is CPU on the shared loop.
- **Refusals are unobservable.** No metric, no log line, no counter. If a tenant's
  legitimate pattern were refused in production, nothing would surface it. Design MD
  §3.4(8).
- **CI collection verified locally, NOT yet on a PR check.** The three files are collected
  and executed by `pnpm --filter @metasheet/core-backend test`, which is the required
  `test (20.x)` job's own step (§5.8.10) — reproduced here at this head with the per-file
  case counts taken from the run's output. What is still missing is the same evidence read
  off a GitHub checks list, which needs a PR. "被触发≠被验证".
- **Stored-path HTTP chain** (field-create → record-write over HTTP) — the engine
  behaviour was proven by direct calls into the real `evaluateField`/`dryRun`; the
  full HTTP write chain was NOT driven end-to-end.
- **PG16 axis** — tests ran on local PG 15.17 only (the regex work is
  DB-independent; the DB is used only by the OOB victim route).
- **plugin-attendance / apps-web copies** of flagged shapes were extracted and
  graded but not individually OOB-probed (FE = single-session, out of the
  cross-tenant severity class).

## 7. Reproduction artifacts (scratch, not committed)

Round 1: `extract.cjs`, `fuzz-one.cjs`, `runner.cjs`, `controls.cjs`, `run-controls.cjs`,
`probe-formula.ts`, `probe-dryrun.ts`, `probe-stored.ts`, `probe-validate.ts`, `oob-server.ts`,
`oob-client.mjs`, plus `h3-sites.json` / `h3-fuzz.json` / `controls-result*.txt`.

Round 2: `soak.cjs` (§5.2/§5.3 tables), `overhead.cjs` + `zzz-h3-measure2.test.ts` (§5.6), `residual.cjs` +
`residual-one.cjs` (design MD §3D.1), `ladder-trace.cjs` (the §3C.2 diagnosis),
`mutate.py` + `run-mutations.sh` (§5.5). Everything committed lives in the three test files
listed in design MD §4; the numbers above are reproducible from them plus the constants.
