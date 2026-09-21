# Input-regex ReDoS census — verification (slice H-3)

**Status: PROPOSED.** Date: 2026-09-22. Base: `origin/main` @ `cd42eaf7455f03dd99021a02c47c42f1f3db6484`.
Branch: `fix/input-regex-redos-candidates`. Local PostgreSQL 15.17 (Homebrew, aarch64).
One-shot DB: `metasheet2_h3_20260922` (owner `ms2testbed`, non-superuser); `current_database()` verified before every DB touch. Never pointed at `metasheet_test` / `metasheet_v2` / `metasheet_testbed_*`.

All timings are `process.hrtime`/wall-clock on this machine; absolute ms are
machine-relative — the **ratios** and the **victim-vs-attacker** contrast are the
evidence, not the constants.

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

The 47 unresolvable were **hand-read** (class-two hunt): all but the formula
engine resolve their pattern from a module constant, an escaped
(`escapeRegExp`-guarded) template, or a fixed literal-with-interpolation used in
tests. The formula engine is the only production site where the **pattern itself**
is user-authored and unescaped.

## 3. Instrument controls — 6/6 pass (this is what makes "1 live / 13 not" a conclusion)

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

## 4. The live finding — reproduced three ways on the real origin/main code

### 4.1 In-process, via the route's own method `MultitableFormulaEngine.dryRun`
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

## 5. The fix works — old implementation vs new, load-bearing assertions

`src/formula/__tests__/regex-safety.test.ts` — **7 tests pass in 4ms**
(`vitest run … --config vitest.config.ts`, `CI=true`).

- The POSITIVE tests assert the previously-catastrophic cases now return `#ERROR!`
  in <200ms. **The old implementation measured 20368ms (dry-run) / 20655ms
  (stored) on the identical n=32 case (§4.1/§4.2)** — so the `<200ms` bound is the
  mutation proof: the pre-fix code fails it by 100×.
- LINEAR CONTROLS assert legitimate patterns still work: `REGEXMATCH("hello-world",
  "^[a-z-]+$")→true`, `REGEXREPLACE("a1b2c3","[0-9]","")→"abc"`,
  `REGEXEXTRACT("id=42","id=([0-9]+)")→"42"`, `SUBSTITUTE("2026-09-22","-","/")→
  "2026/09/22"`.
- SUBSTITUTE correctness: `substituteLiteral("xa+y","a+","Z")→"xZy"` (arg-2 `a+`
  treated literally; the old regex impl treated it as a quantifier).
- Detector unit cases: `hasNestedUnboundedQuantifier` true for `^(a+)+$`,
  `(?:x+)*`, `(\d+){2,}`; false for `^[a-z0-9-]+$`, `^\d{4}-\d{2}$`, and
  `[(+*)]+` (char-class contents not mistaken for a quantified group).

`tsc --noEmit -p tsconfig.json` clean at both commit states (SUBSTITUTE-only and
full).

## 6. NOT RUN / limitations (explicit)

- **Full application boot** against `metasheet2_h3_20260922` was NOT performed.
  The OOB proof used a focused real-Express harness that mounts the **real**
  `dryRun`/engine code and a real DB-backed victim route. The full auth/routing
  stack adds request latency but is **not part of the blocking mechanism** (a
  synchronous regex on the single-threaded event loop blocks regardless of what
  else is mounted). The one-shot DB is exercised by the victim's `SELECT 1`.
- **Per-site cross-tenant HTTP proof for the 13 literal sites** — NOT RUN. They
  were microbenchmarked only; reachability is traced or marked UNVERIFIED in the
  design table. No speculative fixes were shipped for UNVERIFIED-reachability
  sites (doctrine: dead-code defect ≠ live vulnerability).
- **REGEX* guard completeness** — the static detector is PARTIAL by construction
  (misses alternation-overlap ReDoS such as `(a|a)*`); NOT exhaustively fuzzed
  against all ReDoS families. The complete fix (RE2 / step budget) is deferred to
  owner.
- **Stored-path HTTP chain** (field-create → record-write over HTTP) — the engine
  behaviour was proven by direct calls into the real `evaluateField`/`dryRun`; the
  full HTTP write chain was NOT driven end-to-end.
- **PG16 axis** — tests ran on local PG 15.17 only (the regex work is
  DB-independent; the DB is used only by the OOB victim route).
- **plugin-attendance / apps-web copies** of flagged shapes were extracted and
  graded but not individually OOB-probed (FE = single-session, out of the
  cross-tenant severity class).

## 7. Reproduction artifacts (scratch, not committed)
`extract.cjs`, `fuzz-one.cjs`, `runner.cjs`, `controls.cjs`, `run-controls.cjs`,
`probe-formula.ts`, `probe-dryrun.ts`, `probe-stored.ts`, `oob-server.ts`,
`oob-client.mjs`, plus `h3-sites.json` / `h3-fuzz.json` / `controls-result*.txt`.
