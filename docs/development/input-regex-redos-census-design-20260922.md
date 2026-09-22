# Input-regex ReDoS census — design (slice H-3)

**Status: PROPOSED.** Date: 2026-09-22. Base: `origin/main` @ `cd42eaf7455f03dd99021a02c47c42f1f3db6484`.
Branch: `fix/input-regex-redos-candidates`. Candidate only — not merged, not undrafted, no DDL.

**Round 2.** An independent gate reviewed round 1 at head `71f869e644f2646e46c8075bd79b0aa09bcd73d4`
and returned CHANGES-REQUESTED: the candidate's static shape detector was measured
**net-negative** (it refused six extremely common LINEAR patterns, turning each into a
write-path 422 and a persisted `#ERROR!`, while still admitting a 22-second `^(a|a)*$`).
Round 2 **deletes the shape detector** and replaces it with two guards that refuse only on
evidence: a hard subject-length ceiling and a bounded timing ladder. §3C records why the
shape route was abandoned; §3D records what the replacement still cannot see. Every
"FIXED" claim from round 1 has been downgraded to a measured statement (§2, §3C, and
verification MD §5).

## 0. Scope

Mechanical census of every regular expression evaluated in
`packages/core-backend/src`, `apps/web/src`, and `plugins/*/index.cjs`, with a
concurrent-timing probe for the shapes a static grader flags as super-linear, and
a candidate fix for the one site with **measured cross-tenant event-loop
blocking**.

Motivation (private): a custom edge-trim regex candidate (`NAME_EDGE_TRIM_PATTERN`,
approval template groups name-rule) was measured freezing an unrelated tenant's
request for 15.01s. That candidate is not on `origin/main`; this census asks
whether any regex **already on `origin/main`** has the same property against
user-controlled input.

**Scope correction (round 2).** The round-1 glob `plugins/*/index.cjs` excluded
`plugins/*/lib/**` and therefore missed a third class-two site,
`plugins/plugin-integration-core/lib/validator.cjs` (finding **L3**, §3E). The census
denominator below is the round-1 one and is unchanged for the roots it did cover
(independently reconciled 47/47 by the gate); L3 is an ADDITION to it, not a correction of
it. A full re-run over `plugins/**/*.cjs` is NOT done — see §5 NOT RUN.

### In scope
- Regex **literals** and `new RegExp(...)` on user input, classified by shape.
- Two distinct bug classes: (1) user input as the **subject** of a constant
  regex (the precedent's shape); (2) user input as the **pattern** itself.
- Backend cross-tenant severity (shared single-threaded event loop) vs frontend
  single-session self-DoS (one browser tab).

### Not in scope / deferred to owner
- Any merge / undraft / migration.
- The definitive fix for user-supplied regex (linear-time engine such as RE2, or
  a step-budgeted / interruptible matcher). The candidate here is a **partial**
  guard; the complete fix is a dependency/contract decision.
- Per-site cross-tenant HTTP proof for the 13 literal candidates (only
  microbenchmarked; reachability marked UNVERIFIED where not traced).

## 1. Method (four stages, cheap→expensive, each gating the next)

1. **AST extraction** (`ts` compiler API) — every regex site, no judgment.
2. **Static grade** — drop sites with no unbounded quantifier; dedupe the rest
   into distinct `(pattern, flags, call-method)` jobs.
3. **Pump-fuzz** each job in an isolated, killable child process at N =
   1e3/1e4/1e5 with three subject shapes per quantified atom (member-run;
   member-run + non-member tail; non-member head + member-run + tail). Super-linear
   growth (≥25× per 10× N, or a child that cannot finish in 20s) escalates.
4. **Out-of-band concurrent probe** (real Express, real event loop, one-shot DB
   `metasheet2_h3_20260922`) — only for a site with confirmed reachable
   user-controlled input, to measure **victim-request** latency (the criterion
   that makes it a P1, not a slow endpoint).

Instrument validity is asserted by a control battery (§ verification MD): the
real `NAME_EDGE_TRIM_PATTERN` must grade super-linear or every "linear" verdict is
vacuous.

## 2. Census table — the 14 super-linear-flagged shapes + the class-two finding

`file:line` / input source / shape / measured (microbench) / disposition.
Full site lists for the two multi-site shapes are in § 2.1.

| # | file:line | input source | shape | measured | disposition |
|---|---|---|---|---|---|
| **L1** | pre-image SINKS `formula/engine.ts:326/329/332` (REGEXMATCH/EXTRACT/REPLACE) + `:183` (SUBSTITUTE); post-image REGISTRATIONS `:340/:344/:350` + `:187`, sinks moved into `regex-safety.ts:311/324/432` | **user supplies the PATTERN** via a formula expression | class-two; nested-quantifier `new RegExp(userStr)` | **20.4s in-process @58-char expr; 55.0s cross-tenant victim GET (OOB)** | **LIVE, CONFIRMED cross-tenant. MITIGATED on branch (PROPOSED), not fixed:** the three named catastrophic shapes are refused in ≤14.4ms (600/600 runs) and SUBSTITUTE no longer reaches a regex engine at all; a pattern whose cost is discontinuous in subject length is still not caught (§3D). |
| **L2** | pre-image SINK `multitable/field-validation-engine.ts:103` (inside `validatePattern:100`); post-image `:112` (`evaluatePatternRule`), `:129` (guarded call), `:192` (the `pattern` case) | **user supplies the PATTERN** via a stored `property.validation` rule (uncapped `z.record(z.unknown())`); runs on **every record write and public form submission** (`univer-meta.ts:17526`, `record-service.ts:725`) | class-two; nested-quantifier `new RegExp(rule.params.regex)` `.test` | **20.5s in-process @33-char record value** (benign control 0.1ms) | **LIVE, CONFIRMED. MITIGATED on branch (PROPOSED), not fixed:** same ladder as L1, plus the subject ceiling this site had no equivalent of (§3B.2). Cross-tenant HTTP proof NOT RUN (in-process only); same shared-event-loop mechanism as L1. |
| **L3** | pre-image SINK `plugins/plugin-integration-core/lib/validator.cjs:97` (inside `compilePattern`); post-image `:155` (guarded call), `:160` (`PATTERN_NOT_EVALUATED`) | **user supplies the PATTERN** via a pipeline `fieldMapping.validation` rule (`params.regex \| params.pattern \| params.value`) | class-two; `new RegExp(pattern, flags)` `.test` on a record value | **20164ms in-process @33-char value**, measured on the real module through the real `validateValue` (this round, mutation M7) | **LIVE on the code shape; runtime reachability argued but NOT end-to-end proven (§3E). MITIGATED on branch (PROPOSED)** — missed entirely by the round-1 scope glob. |
| 1 | `attendance/w7-shadow-expected-differences.ts:287` | `ratifiedBy` from W7 expected-shadow roster config | `/[\w-]+\.md\b/` `.test` | ratio 101, 5.1s @1e5 | internal domain config, not HTTP body → UNVERIFIED reachable; no fix |
| 2 | `data-adapters/DataSourceManager.ts:1252` (+11 copies, § 2.1) | DataSourceManager: data-source config `value`; the other 11 are internal (migrations, integration clients, storage-key builders) | `/\/+$/` `.replace` | ratio 92, 3.1s @1e5 | quadratic; needs ~1e5 `/` chars; **bound not verified at any of the 12 sites → UNVERIFIED**; no fix |
| 3 | `data-adapters/PLMAdapter.ts:15`, `services/ai-provider-client.ts:55` | adapter error/log text (URL userinfo redaction) | `/([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/gi` `.replace` | ratio 97, 5.1s @1e5 | quadratic; input = error text, not direct body; UNVERIFIED; no fix |
| 4 | `routes/univer-meta.ts:5247` **only** (the verified site) | `sheetName` (export filename) | `/^_+|_+$/g` `.replace` | ratio 92, 3.1s @1e5 | **BOUNDED — not a finding**: `name: z.string().max(255)` (`:8056/:13469/:14397`) before regex |
| 4b | `/^_+|_+$/g` — other 8 copies (§ 2.1) | directory-sync / attendance name normalization / IntegrationWorkbench / plugin-attendance | same shape | same | **UNVERIFIED** (not individually bound-checked); no fix. Only `:5247` was verified — the max(255) bound is NOT generalized to these |
| 5 | `multitable/approval-form-value-mapping.ts:75` | decimal number lexeme from approval form | `/0+$/` `.replace` | ratio 102, 3.2s @1e5 | needs ~1e5 trailing zeros; bounded by numeric field precision in practice; UNVERIFIED; no fix |
| 6 | `multitable/automation-log-redact.ts:108` (backend) + `apps/web/.../automation-log-redact.ts:108` | automation-log content (host parsed from DB-URL-in-log) | `/\d+\.\d+\.\d+\.\d+/` `.test` | **UNFINISHED >20s** | backend copy = cross-tenant weight; ReDoS-shaped; reachability UNVERIFIED → **owner-review candidate**, no speculative fix. FE copy = single-session |
| 7 | `sandbox/SecurityPolicy.ts:250` | sandbox script (user automation code) | `/\w+\s*\(/g` `.match` | ratio 94, 3.9s @1e5 | quadratic; sandbox analysis path; gating UNVERIFIED; no fix |
| 8 | `services/AttendanceNotificationDeliveryWorker.ts:1126/1220` | DingTalk error text | `/(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}…/gi` `.replace` | **UNFINISHED >20s** | **precedent antipattern**: truncates to 240 *after* the regex (`normalizeErrorText`); background worker; attacker-control UNVERIFIED → **owner-review candidate** |
| 9 | `workflow/BPMNWorkflowEngine.ts:1266` | BPMN condition expression `cond` | `/^(.+?)\s*(===|…)\s*(.+)$/` `.match` | **UNFINISHED >20s** | author-supplied workflow definition; ReDoS-shaped → **owner-review candidate** |
| 10 | `workflow/bpmnCompilePreview.ts:865` | automation condition `raw` | `/\s*\}$/` `.replace` | ratio 98, 5.1s @1e5 | author-supplied; quadratic; UNVERIFIED; no fix |
| 11 | `apps/web/src/multitable/import/delimited.ts:94` | CSV cell content (import) | `/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig` `.match` | **UNFINISHED >20s** | **FE → single-session self-DoS** (importer's own tab); not cross-tenant |
| 12 | `apps/web/src/multitable/import/xlsx-mapping.ts:135` | sheet name | `/^'+|'+$/g` `.replace` | ratio 92, 3.2s @1e5 | **BOUNDED — not a finding**: `.slice(0,31)` before regex; FE anyway |
| 13 | `apps/web/.../automation-log-support-packet.ts:134` (FE), `plugins/plugin-attendance/index.cjs:5858/:22616` | filename seed from `profile.id/source` | `/^-+|-+$/g` `.replace` | ratio 93, 3.2s @1e5 | **UNVERIFIED** (no length bound verified at any of the 3 sites); FE + plugin; no fix |
| 14 | `apps/web/src/views/plm/plmFilterPresetUtils.ts:186` | filter-preset base64 tail | `/=+$/g` `.replace` | ratio 96, 3.2s @1e5 | **FE → single-session self-DoS**; bounded by preset content |

**Result: 3 live class-two findings (user supplies the pattern), all three MITIGATED —
not fixed — on branch as PROPOSED candidates.** L1 formula engine (cross-tenant
HTTP-proven, 55s), L2 field-validation pattern rule (in-process 20.5s; cross-tenant HTTP
NOT RUN but the same shared-event-loop mechanism), L3 plugin pipeline validator
(in-process 20.2s; runtime reachability argued, not proven). "Mitigated" is the precise
word and §3C/§3D say exactly what it buys and what it does not. 1 site
verified bounded-before-regex (`univer-meta.ts:5247`, max 255) + 1 FE site bounded
(`xlsx-mapping.ts:135`, slice 31) — not findings. Several FE sites are
single-session self-DoS (lower severity, not cross-tenant). The remaining backend
rows are ReDoS-shaped with reachability UNVERIFIED — owner-review candidates, no
speculative fix per "先探可达性再写紧迫性" (dead-code defect ≠ live vulnerability).
Note: the two live findings are class-two (`new RegExp(userStr)`), so they sit in
the 47 `new RegExp` bucket, not the 14 literal-shape rows — see § 3 and the
verification MD § 2 per-site breakdown of the 47.**

### 2.1 Full site lists for multi-site shapes
- `/\/+$/` `.replace` (12): DataSourceManager.ts:1252; db/migrations/zzzz20260710140000_add_files_storage_key.ts:77; integrations/dingtalk/client.ts:176,773; integrations/wecom/client.ts:84; services/ApprovalBreachNotifier.ts:287; services/AttendanceNotificationDeliveryWorker.ts:138; services/ai-provider-client.ts:257; services/dingtalk-todo-mirror-worker.ts:106; services/filesStorageKey.ts:37,64; apps/web/src/views/attendance/useAttendanceSetupReadiness.ts:45.
- `/^_+|_+$/g` `.replace` (9): directory/directory-sync.ts:756; middleware/attendance-production.ts:126; rbac/plugin-role-template.ts:26; routes/univer-meta.ts:5247; workflow/bpmnCompilePreview.ts:1039; apps/web/src/views/IntegrationWorkbenchView.vue:2534,2539; apps/web/src/views/attendance/attendanceCode.ts:17; plugins/plugin-attendance/index.cjs:1044.

## 3. The live findings — user-supplied regex (class two)

Both live findings share one mechanism: a **caller-authored string is compiled
into `new RegExp`** and a nested-quantifier pattern (e.g. `^(a+)+$`, 7 chars)
blocks the single-threaded event loop for every concurrent request. § 3A is the
formula engine (L1); § 3B is the field-validation pattern rule (L2).

## 3A. Live finding L1 — user-supplied regex in the formula engine

### 3.1 Mechanism
`REGEXMATCH(text, pattern)`, `REGEXEXTRACT`, `REGEXREPLACE` compile the
caller-authored `pattern` string into `new RegExp(String(pattern))`
(pre-image sinks `formula/engine.ts:326/329/332`; post-image registrations
`:340/:344/:350`, with the `new RegExp` itself now inside
`formula/regex-safety.ts:311/324/432`). `SUBSTITUTE(text, old, new)` compiled `old` into
`new RegExp(String(old), 'g')` (pre-image sink `:183`); post-image `:187` calls
`substituteLiteral` and reaches no regex engine at all. A nested-quantifier pattern such as
`^(a+)+$` (7 characters) is exponential in the subject length; because JS regex
runs synchronously on the main thread, it blocks the event loop for **every**
concurrent request, across all tenants.

### 3.2 Two reachable paths (both CONFIRMED via the real code, not a re-implementation)
- **Dry-run (admin-triggered, one-shot):** `POST /sheets/:sheetId/formula/dry-run`
  (`routes/univer-meta.ts:16398`) takes `expression` straight off `req.body` and
  calls `dryRunFormulaEngine.dryRun(...)` (`:452`, `:16523`). The three structural
  caps — `DRY_RUN_MAX_EXPRESSION_LEN=4000` (`:454`), `MAX_PAREN_DEPTH=32` (`:456`),
  `MAX_REFERENCED_FIELDS=64` (`:455`) — **all pass** for a 58-char attack
  expression (measured, § verification). Gated by `canManageFields`.
- **Stored (any-user trigger, persistent):** a formula field's
  `property.expression` is validated only as `z.record(z.unknown())` on field
  create/update (`routes/univer-meta.ts:13471`, `:13842`) — **no length, depth,
  or content cap, and the dry-run caps do not apply here.** Once stored, every
  record write recomputes it via `recalculateFormulaFields` → `recalculateRecord­FromData` → `evaluateField` (`multitable/formula-engine.ts:339`), so an ordinary
  user with no field-management rights pays the cost on each write. This is the
  more severe variant: unbounded stored pattern, lower-privileged trigger.

### 3.3 Candidate mitigation (PROPOSED, round 2)
- **`SUBSTITUTE` → literal replacement** (`substituteLiteral`, `formula/regex-safety.ts:49`,
  split/join, O(n)). This both fixes a spec bug (Excel/Sheets SUBSTITUTE is literal,
  not regex) and removes the vector — arg-2 never reaches a regex engine. This IS a
  complete fix for this function; it is also a behaviour change, see §3.4(1).

  **No subject ceiling on SUBSTITUTE, and that is a decision, not an oversight.** The
  ceiling exists to bound backtracking, and after this change arg-2 never reaches a
  backtracking engine at all: `split/join` is Θ(n) in the text with no super-linear shape
  available to an attacker. The remaining cost is allocation, and it is measured to be
  the same order as what `origin/main` already did:

  | text | old-text | new (`split/join`) | `origin/main` (`.replace(/…/g)`) |
  |---|---|---|---|
  | 10000 | 1 char | 0.06ms | 0.06ms |
  | 100000 | 1 char | 0.66ms | 0.50ms |
  | 1000000 | 1 char | 6.92ms | 5.67ms |

  ~1.2x of the pre-image at 1e6 characters, both linear. Adding a ceiling here would be a
  NEW refusal of inputs that work on `origin/main` today, bought against a cost curve that
  is not the one this slice exists to bound — so it is declined on the record rather than
  added. If the owner wants formula text arguments bounded, that is a separate contract
  decision about the formula core, not a ReDoS mitigation.
- **`REGEX*` → `runUserRegex`** (`formula/regex-safety.ts:297`), which refuses on two
  measured criteria and on nothing else:
  1. **the subject ceiling first** — `USER_REGEX_MAX_SUBJECT_LEN = 10000` (`:85`) and
     `USER_REGEX_MAX_PATTERN_LEN = 1000` (`:88`), applied before compilation and
     independent of any caller-side rule list. Derivation in §3.3.1.
  2. **a bounded timing ladder** — sample the cost of the REAL (pattern, subject) pair at
     an ascending schedule of truncated subjects (`userRegexProbeLadder`, `:186`), and
     refuse only when the measured log-log growth exponent exceeds
     `USER_REGEX_SUPERLINEAR_SLOPE = 2` **and** the extrapolated cost at the real length
     exceeds `USER_REGEX_PROBE_BUDGET_MS = 100` — both re-measured before the
     refusal is returned. A rung below `USER_REGEX_PROBE_FLOOR_MS = 2` decides nothing,
     and the fit is anchored against a rung at least
     `USER_REGEX_DECISION_DYNAMIC_RANGE = 8` times cheaper (`selectFitAnchor`, `:232`)
     rather than the adjacent rung — see §3C.2 for the measurement that forced that.

     **The re-measurement withdraws the ENTRY condition, not only the slope (round 3).**
     The only gate into the deciding branch is the floor test, so a rung that re-measures
     BELOW the floor is a rung whose first sample was inflated — exactly what the
     re-measurement exists to detect. Round 2 fed the re-measured value back into the
     slope alone and refused anyway; measured under heap load that produced **1 refusal in
     2000 runs of one benign pair**, the refusal's own evidence reading `measuredMs=0.00`
     against a 2ms floor (verification MD §5.8.1).

     **And "decides nothing" means the ladder keeps climbing.** The rung is recorded as an
     ordinary sub-floor sample and sampling continues; it is NOT a reason to stop. A first
     cut of this fix withdrew the refusal and fell out of the loop into the real call, which
     hands an unmeasured pattern the whole subject — measured, one of the three named
     catastrophic shapes then ran for over twenty seconds once in 1000 calls, where round 2
     refused 1000/1000 (verification MD §5.8.1b). The minimum
     `bestOf` takes is biased downward by WARM-UP, not only by pauses: the first sample at a
     probe length is systematically the slowest, and the deciding rung for the named shapes
     sits only ~1.1x–1.6x above the floor. Continuing reaches the next rung, which is above
     the floor on every sample.

     **The re-measurement is bounded by `USER_REGEX_REMEASURE_BUDGET_MS = 200` (round 3).**
     Confirmation costs up to three runs of the deciding rung, and that rung's cost is not
     bounded by anything here. Measured, a shape whose cost is discontinuous in subject
     length crosses the floor on a SINGLE rung costing hundreds of milliseconds, and the
     guard paid about three times that rung for a pattern the unguarded code answers in
     microseconds (§3D.2; exact values in verification MD §5.8.3 — they are machine- and
     version-relative and are quoted in one place only). Once a call has already spent
     the budget on measurement, a scheduling pause is no longer a candidate explanation for
     the number, so the first measurement stands. This bounds the guard's own MULTIPLIER;
     it does not, and cannot, bound the cost of one probe. It is deliberately NOT applied
     to the ladder loop: stopping the sweep early could skip the rung that would have
     crossed the floor and turn a refusal into an acceptance.
  When not refused, `runUserRegex` returns the result of the real regex against the real
  subject, byte-for-byte what the unguarded code returned (differential fuzz: 100000
  pairs, 0 divergences — verification MD §5.4).

#### 3.3.1 Why the ceiling is 10000, derived

Two independent constraints meet at the same number.

**(a) Parity, so the ceiling is not a new narrowing for a default-ruled field.**
`getDefaultValidationRules` (`multitable/field-validation-engine.ts:273`) caps `string` /
`longText` at `maxLength: 10000`. A field that declares no explicit validation therefore
already rejects a >10000-character value, so for that population the ceiling changes
nothing.

**(b) The budget for the shapes the ladder deliberately accepts.** The ladder refuses only
super-QUADRATIC growth, so a genuinely quadratic pattern is accepted and runs to
completion; the ceiling is the only thing bounding it. Measured at the ceiling:

| accepted shape | subject | guarded | unguarded |
|---|---|---|---|
| `^\s+\|\s+$` `/g` `.replace` | `Z` + 9998 spaces + `Z` | 54ms | 45ms |
| the zero-width edge-trim precedent `/gu` | `Z` + 9998 U+200B + `Z` | **90ms** | 90ms |

90ms is the worst ACCEPTED shape measured. Cost is quadratic in the ceiling, so 20000
would be ~360ms. **Stated plainly: 90ms is NOT covered by `USER_REGEX_PROBE_BUDGET_MS`** —
that constant governs the slope test's extrapolation, not the cost of a polynomial shape
the slope test deliberately accepts. And no ceiling bounds an exponential pattern; that is
what the ladder is for, and the two guards are independent on purpose.

**What the ceiling does NOT cover:** a field whose EXPLICIT rule list contains a pattern
rule but no `maxLength`. Both call sites merge as `explicitRules ?? defaultRules`
(`routes/univer-meta.ts:17518`, `multitable/record-service.ts:489`) — a REPLACEMENT, not a
merge — so those fields have no length bound today and a >10000-character value that
writes successfully on `origin/main` will now be refused. That is a real write-path
narrowing; it is an owner item (§3.4.6), and the population cannot be censused from here.

**SUBSTITUTE dependents (in-repo):** `grep -rn "SUBSTITUTE("` finds one existing
test (`tests/unit/formula-engine.test.ts:135`, `SUBSTITUTE("hello world","world",
"there")→"hello there"` — passes under literal semantics) and one docs example
(`formula-docs.ts:366`, literal `"-"`). **No in-repo caller depends on the old
regex behaviour.** Stored formulas in customer DBs are out of reach of this grep;
a `SUBSTITUTE(x, "[0-9]", "")` stored formula silently changes from a regex strip
to a no-op — owner should weigh this before landing.

## 3B. Live finding L2 — user-supplied regex in the field-validation pattern rule

### 3B.1 Mechanism + reachability (CONFIRMED via the real code)
`validatePattern` (`multitable/field-validation-engine.ts:103`) compiles
`rule.params.regex` into `new RegExp(regex, flags)` and `.test()`s the record
value. The `pattern` rule is stored in a field's `property.validation` array,
parsed at `univer-meta.ts:17519-17525` from `f.property` — the same uncapped
`z.record(z.unknown())` blob as L1's `property.expression`. `validateRecord` runs
on **every record write** (`univer-meta.ts:17526`) and, per the module header,
**public form submission** (`record-service.ts:725`). A field manager stores a
`{type:'pattern', params:{regex:'^(a+)+$'}}` rule once; thereafter any user's
record write / any public form submit against that field runs the exponential
regex on the shared event loop. Measured: **20.5s in-process at a 33-char record
value**; benign pattern on a 100k value 0.1ms (§ verification MD § 4.4).

### 3B.2 Candidate mitigation (PROPOSED, round 2)
`evaluatePatternRule` (`multitable/field-validation-engine.ts:112`) routes the stored
regex through the same `runUserRegex`, so this site gets the subject ceiling it never had.
That matters here specifically: `explicitRules ?? defaultRules` means a field that
declares a pattern rule has thrown away the built-in `maxLength: 10000`, so before this
change the record value reaching a stored regex was bounded only by
`express.json({ limit: '10mb' })`.

**A refusal is NOT reported as a format mismatch.** Round 1 made a refused pattern return
`false`, which surfaced as the ordinary `"<field> does not match the required format"` —
byte-identical to a genuine mismatch, so neither the submitting user nor the field
administrator could tell "this value really is malformed" from "the guard declined to run
this check". Round 2 pushes a distinct message per refusal kind
(`describeUserRegexRefusal`, `formula/regex-safety.ts:259`) and deliberately ignores the
rule's own `message` override for refusals, because that string describes a format
mismatch and this is not one. The **invalid-regex** branch is unchanged on purpose: it
predates this slice and keeps returning a plain validation failure.

**Round 1's justification here is withdrawn.** It read: *"a field with a catastrophic
validation pattern now always fails validation (that pattern was misconfiguration)"*. The
gate measured six patterns the detector called catastrophic — version numbers, slugs,
dotted identifiers, comma lists, e-mail, path segments — each of which runs in ≤0.069ms on
a 10000-character adversarial subject. They were not misconfiguration; the detector was
wrong. §3C.

**Residual behaviour change (owner item, §3.4.6):** a value over the ceiling now fails the
write with its own message. See §3.3.1.

## 3C. Why the static shape detector was dropped

Round 1 shipped `hasNestedUnboundedQuantifier` — "a quantified GROUP whose body itself
carries an unbounded quantifier", i.e. `(a+)+`, `(.*)*`, `(\d+){2,}`. It is deleted. Three
reasons, in order of weight; all three are measurements, none is an argument from taste.

### 3C.1 It was net-negative: six common linear patterns refused, the named bypass admitted

The predicate does not require AMBIGUITY, so any `(X+)*` / `(X+)+` shape matched it
regardless of whether the outer iteration is anchored by a separator. Measured on
10000-character adversarial subjects (long member run + failing tail — the shape that makes
a genuinely catastrophic pattern explode), through the real `validateRecord`:

| pattern | round 1 | round 2 | worst single ladder rung | guarded call |
|---|---|---|---|---|
| `^\d+(\.\d+)*$` version number | **REFUSED** | ACCEPTED | 0.041ms | 0.49ms |
| `^[a-z0-9]+(-[a-z0-9]+)*$` slug | **REFUSED** | ACCEPTED | 0.069ms | 0.55ms |
| `^(\w+\.)*\w+$` dotted identifier | **REFUSED** | ACCEPTED | 0.044ms | 0.60ms |
| `^[a-z]+(,[a-z]+)*$` comma list | **REFUSED** | ACCEPTED | 0.030ms | 0.54ms |
| `^[^@]+@[^@]+(\.[^@]+)+$` e-mail | **REFUSED** | ACCEPTED | 0.012ms | 0.25ms |
| `^(/[a-z0-9_-]+)+$` path segments | **REFUSED** | ACCEPTED | 0.038ms | 0.59ms |

Every one of them is LINEAR: the worst single rung over the whole ladder is 0.069ms of
regex work, ~29x under the 2ms floor. That is headroom on the regex cost, not a bound on
the rung's wall time (a GC pause lands inside the same window) — verification MD §5.2. On
this corpus the headroom is enough: the deciding branch is never entered at all **for this
corpus** —
0 entries and 0 refusals over 18000 calls, counted inside the branch rather than inferred
(verification MD §5.2). The corpus qualifier is load-bearing and was added in round 3: over
the 100000-pair random linear corpus the branch IS entered once, so "a linear pattern never
reaches the timing decision" is false in general. See §3D.6.

What the refusals cost, on `origin/main` behaviour that worked: on the field-validation
side every record write and every public form submission against such a field returns 422;
on the formula side `REGEXMATCH("my-valid-slug", "^[a-z0-9]+(-[a-z0-9]+)*$")` returns
`#ERROR!` and `recalculateRecordFromData` → `applyFencedDerivedDataMerge`
(`multitable/formula-engine.ts:337` / `:372`) writes that literal string over a previously
correct derived value in `meta_records.data`.

And what it bought: the gate measured `^(a|a)*$` — two characters longer — still blocking
**22437ms** on the guarded code. Attacker cost unchanged, victim cost unchanged.

### 3C.2 A shape is not evidence — and the replacement's own first design proved the point

The replacement refuses only on a measured cost curve. That is not automatically safe
either: the first version of the ladder fitted the growth exponent against the **adjacent**
rung. Two adjacent rungs at the floor are ~1.3ms and ~2.7ms, and the entire verdict is
their RATIO, so ordinary scheduling noise on a 1.3ms sample halves the fitted exponent.
MEASURED: `^(a+)+$` at n=33 was then **intermittently ACCEPTED and ran for 22248ms** — the
round-1 defect, reintroduced by a different mechanism. The shipped design anchors the fit
against a rung at least `USER_REGEX_DECISION_DYNAMIC_RANGE = 8` times cheaper
(`selectFitAnchor`), which makes the fit rest on a ratio jitter cannot manufacture: after
the change, 600/600 refusals across the three named shapes, worst 14.4ms.

That failure is recorded here rather than quietly fixed because it is the strongest
available argument for the section's thesis: the difference between the two designs is not
"static vs dynamic", it is **how much evidence the refusal is required to rest on**.

### 3C.3 The detector was also untestable in the direction that mattered

Round 1's suite asserted only that catastrophic shapes were refused. Nothing asserted that
a legitimate pattern was NOT refused, so the six-pattern regression could not turn any test
red — 173/173 green carried no information about it. Round 2's false-positive battery is
the load-bearing half of the suite, and the fuzz (§5.4 of the verification MD) is its
generalisation.

## 3D. Residual: what this guard still cannot see

**The class is not closed.** This section is the honest boundary; nothing above should be
read as closing it.

1. **Cost that is DISCONTINUOUS in subject length.** The ladder samples truncated subjects,
   so a pattern that hides its blow-up behind a fixed-length runway — `^.{64}(a+)+$` — is
   flat on every rung shorter than the runway. Measured, `^.{64}(a+)+$` against
   `x`×64 + `a`×40 + `!` (105 characters, well inside the ceiling): the guard **does**
   refuse it, but only after **495760ms** burned inside the ladder itself, because the
   geometric rung step at length 80 → 100 adds 20 characters to the quantified run, i.e.
   ~2^20 more work in a single rung. Shorter runs of the same family behave: `runway=512`
   and `runway=4000` at the same k refuse in 239ms / 243ms.

   **A strictly stronger instance of the same residual (round 3, independent gate).** The
   example above still CONVERGES — it refuses, just expensively — and a reader could take
   that to mean the ladder always gets there eventually. It does not. Replace the
   fixed-length runway with a MINIMUM-LENGTH assertion whose threshold is set to the real
   subject's own length: every rung is shorter than the threshold, so the assertion fails
   on every rung, so every rung is flat, so the ladder never refuses at all. Measured
   (16-character pattern of that shape, warm-vs-warm against the unguarded code):
   guard overhead **≤0.3%** at three subject lengths, i.e. a confirmed **no-op**, with the
   cost doubling per added character and an out-of-band victim request measured at 20829ms.
   The shape family is disclosed here and in `regex-safety.ts:31`; the payload is not
   written down in this repository.

   Note also that the "final approach" rungs in `userRegexProbeLadder` bound the last step
   in SUBJECT LENGTH, not in WORK. Against a threshold-style predicate — one that flips at
   an exact length rather than growing with it — that bound buys nothing, because the
   discontinuity is not a matter of how many characters the last step adds.
2. **A probe is a COST proxy, not a semantic one.** `userRegexProbeSubject` keeps the head
   and the real last 8 characters. A pattern with a literal suffix longer than 8 characters
   (`^(a+)+TERMINATOR1234$`) would see its probes fail where the real subject matches, so
   the probe could be catastrophic for a subject the unguarded code handles instantly. The
   100000-pair differential fuzz found no such case and none of the named patterns has that
   shape, but it is NOT excluded by construction.

   **Round 3 — this was measured, and round 2's "could be" was a real regression.** With a
   26-character pattern of that family and a 1200-character value (well inside the
   ceiling), `origin/main` answers in well under a millisecond and round 2's guard took
   **1943.8ms**: the deciding rung at length 1184 costs 644.7ms on its own, and the
   confirmation ran it twice more. The attacker's MAXIMUM capability is not raised by this — on either tree he would
   pick a stronger attack — but it is a real per-input regression this slice introduced.
   `USER_REGEX_REMEASURE_BUDGET_MS` (§3.3) removes the 3x multiplier: the same pair now
   costs **650.9ms**, one rung, same verdict. The residual 650.9ms is one probe, and nothing
   short of an interruptible engine bounds that.

   **Two remedies were considered and declined, and round 3 MEASURED both rather than
   arguing them** (verification MD §5.8.9).
   *A static "provably linear, skip the ladder" fast path* fails in both directions at once.
   Coverage: **0 of the 6** common linear patterns take it, because every one of them
   contains a quantified group whose body carries a quantifier — precisely the predicate
   round 1 proved cannot separate them from a catastrophic shape (§3C.1). Soundness: it
   ADMITS shapes the guard refuses today. `^a*a*a*a*b$` has no quantified group at all, so
   the predicate calls it linear; measured unguarded it costs **851ms at n=250 and 38679ms
   at n=1000**, against a subject ceiling of 10000, while the shipped ladder refuses it in
   ~22ms on a measured slope of 3.78. Skipping the ladder for it is a bypass. Both shapes
   are now pinned behaviourally so the fast path cannot be reintroduced quietly (mutation
   X11: 14 red).
   *Caching the ladder's conclusion per (pattern, subject-length bucket)* is unsound because
   the verdict is a property of the (pattern, VALUE) pair, not of its size. Measured, same
   pattern and same length: `^(a+)+$` against 33 matching characters is **ok in 0.492ms**,
   and against 32 characters plus a failing tail is **refused in 10.1ms**. They share a
   bucket, so one cached "ok" disables the guard for the other. Neither is adopted.
3. **A timing criterion is machine-relative.** The constants are budgets measured on one
   machine. A much slower host shifts which rung crosses the floor. The floor, the
   dynamic-range anchor and the confirm-before-refusing re-measurement are what keep that
   from turning into refusals of linear patterns (0/1200 measured), but the ladder is not
   scale-free.
4. **The subject ceiling bounds the SUBJECT, not the cost.** See §3.3.1(b).
5. **Round 1's unclosed items stay unclosed.** The formula side still materialises
   `#ERROR!` through `applyFencedDerivedDataMerge` when a subject is over the ceiling —
   round 2 removes the FALSE-POSITIVE overwrite (the six patterns), not the over-length
   one. That is still owner decision §3.4.3.
6. **The verdict is timing-dependent at about 1e-5 of calls, and the floor is not what
   stops it there.** Counted inside the deciding branch (round 3): 0 entries in 18000 calls
   over the six-pattern corpus, but **1 entry in 100000** over the random linear fuzz
   corpus, where the slope test called that pair super-linear. The confirmation
   re-measurement declined and no refusal occurred. So the guard's freedom from false
   positives rests on TWO mechanisms, not one, and the second was untested until round 3
   (verification MD §5.5 M12). A host under heavy load shifts this rate in the wrong
   direction and nothing here bounds by how much.
7. **The benign path pays the whole ladder.** A linear pattern crosses no rung, so the loop
   never exits early: every pattern-ruled field on every record write scans its value about
   twelve times over. Measured 12x–34x the pre-image, absolute 4µs–104µs per field, and
   **~100ms to ~440ms** for the largest request `express.json({limit:'10mb'})` accepts —
   a RANGE, because the per-value cost depends on the pattern's shape and the round-2 text
   quoted the cheapest row of its own table (verification MD §5.6).
   Bounded and small, but it is a real hot-path cost that a linear-time engine would not
   have — owner item §3.4.9.

**The complete fix remains a linear-time engine (RE2) or a killable worker.** Everything
here is a cost reduction on the reachable blast radius, bought at a measured 0 false
positives.

## 3E. Live finding L3 — the plugin pipeline validator (missed by the round-1 scope)

`plugins/plugin-integration-core/lib/validator.cjs` compiles a fieldMapping's
`params.regex | params.pattern | params.value` into `new RegExp(pattern, flags)` and
`.test()`s a record value. Measured on the real module through the real `validateValue`:
**20164ms** at a 33-character value with `^(a+)+$` (this round, as mutation M7's control).

**Reachability — argued, and here is exactly how far the argument goes.**
- Static call graph: `lib/pipeline-runner.cjs:805` (persisted `context.pipeline.fieldMappings`)
  and `lib/http-routes.cjs:3389` / `:3407`, both inside `buildTemplatePreview`.
- `buildTemplatePreview` is reached from the route table entry
  `['POST', '/api/integration/templates/preview', 'templatesPreview']`
  (`lib/http-routes.cjs:269`), whose handler (`:9758`) calls `requireAccess(req, 'write')`
  (`:934`) — authenticated principal holding the integration `write` tier; 401/403 otherwise.
- On that route **both halves come from the same request body**: `fieldMappings[].validation`
  (the pattern) and `sourceRecord` (the value). One authenticated integration-write
  principal therefore needs no stored state at all.
- The plugin ships in the image (`Dockerfile.backend` copies `plugins/` in both stages) and
  PluginLoader scans that directory at runtime.

**NOT proven:** no end-to-end HTTP run, no confirmation that this plugin is active in the
production deployment, and no out-of-band victim-latency measurement for this site. Under
the repo's "dead-code defect ≠ live vulnerability" rule this stays an argued-reachable
finding, which is why it is mitigated but not escalated above L1/L2.

**Mitigation (PROPOSED):** `lib/user-regex-guard.cjs` — the same guard, same constants,
held to the TS original by a three-way behavioural pin in the backend's required lane
(`packages/core-backend/tests/unit/user-regex-guard-three-copy-parity.test.ts`). A refusal
is reported under its own code `PATTERN_NOT_EVALUATED` (`lib/validator.cjs:160`), never as
`PATTERN`, for the same reason as §3B.2.

## 3F. The browser mirror

`apps/web/src/views/FormView.vue` ran `new RegExp(validation.pattern).test(value)` with no
guard (pre-image sink `:650`; post-image guarded call `:658`). Round 1 left it untouched,
which would have produced a user-visible contradiction: the public form says a slug is fine, the write returns 422 saying the format
is wrong. Round 2 routes it through `apps/web/src/utils/userRegexGuard.ts`.

**Why a copy and not an import:** `apps/web` has no build or runtime dependency on
`@metasheet/core-backend` (its vite alias set is `@` → `apps/web/src`; the backend is a
server bundle). This is the same constraint that forced
`apps/web/src/utils/permission-match.ts` to mirror
`packages/core-backend/src/auth/permission-match.ts`. The copy is dependency-free (no Vue,
no alias, `performance.now()` only) precisely so the backend's required lane can import it
directly and replay one shared case table through all three copies. `apps/web`'s own spec
lane is not a required check, so a pin living there would hold nothing.

**Coverage limit, stated:** the backend lane pins the FE **module** behaviourally and the
FE **call site** only by source text (`FormView.vue` must import the guard and must not
contain `new RegExp(validation.pattern)`). A required lane cannot execute that SFC.

### 3.4 Owner decisions

1. Whether to land the SUBSTITUTE literal-semantics change (behaviour change, but toward
   spec-correctness; no in-repo dependents — see above; a stored
   `SUBSTITUTE(x, "[0-9]", "")` in a customer DB silently becomes a no-op).
2. **Which strategy at all.** This round's answer is "measured refusal + ceilings", and
   §3D says what it leaves open. The alternatives remain RE2, a killable worker, a step
   budget, or refusing every non-trivial user pattern outright. Landing this does not close
   the class; it reduces the blast radius at 0 measured false positives.
3. Whether `#ERROR!` may be materialised by `applyFencedDerivedDataMerge` at all. Round 2
   removes the false-positive path into it, not the over-length one (§3D.5).
4. Disposition of the owner-review candidates (rows 6, 8, 9) — confirm/deny reachability,
   then treat under the same pattern if reachable.
5. Disposition of the other UNVERIFIED class-two `new RegExp` sites the census did NOT
   sweep as safe (verification MD § 2): `RedisAdapter.ts:532` (`value.$regex`),
   `ApprovalGraphExecutor.ts:729`, `plugin-config-manager.ts:150` /
   `PluginConfigManager.ts:633`, `APIGateway.ts:640/939`, `SafeFunctions.ts:361`,
   `plugin-attendance/index.cjs:12490`. (`FormView.vue` is no longer on this list — §3F.)
6. **Two write-path narrowings this round introduces, both disclosed rather than absorbed:**
   (a) a value over `USER_REGEX_MAX_SUBJECT_LEN` on a field whose explicit rule list has a
   pattern rule but no `maxLength` now fails the write (§3.3.1); (b) the plugin pipeline
   validator now emits `PATTERN_NOT_EVALUATED`, a code no consumer has seen before.
   Neither population can be censused from here.
7. Whether to re-run the census over `plugins/**/*.cjs` (the round-1 glob's blind spot,
   §3E) before or after landing.
8. Whether a refusal should be observable — today it is a validation error message and
   nothing else; there is no metric, no log line, and therefore no way to notice a tenant
   hitting it.
9. **Whether a 12x–34x cost multiplier on the benign write path is an acceptable price**
   (§3D.7). Absolute cost is small and bounded by the request body limit (~100ms for the
   largest accepted request, 3–7ms for a 1000-record import at realistic value lengths), so
   this round does not trade correctness for it. But it is the clearest argument for the
   RE2 / worker option in item 2: a linear-time engine needs no ladder and therefore no
   multiplier. Deciding item 2 decides this one.

## 4. Seams (file:line — POST-image unless marked, regenerated mechanically at the end of round 3)

Convention, because round 1 got this wrong (gate P3-1): a "SINK" number points at the
`new RegExp` line itself; a "registration"/function number points at the declaration. Both
are given where they differ.

Guard:
- `packages/core-backend/src/formula/regex-safety.ts` — `substituteLiteral:49`,
  `USER_REGEX_MAX_SUBJECT_LEN:85`, `USER_REGEX_MAX_PATTERN_LEN:88`,
  `USER_REGEX_PROBE_FLOOR_MS:106`, `USER_REGEX_PROBE_BUDGET_MS:109`,
  `USER_REGEX_SUPERLINEAR_SLOPE:112`, `USER_REGEX_DECISION_DYNAMIC_RANGE:122`,
  `USER_REGEX_REMEASURE_BUDGET_MS:156` (round 3),
  `userRegexProbeLadder:186`, `userRegexProbeSubject:212`,
  `selectFitAnchor:232`, `describeUserRegexRefusal:259`,
  `runUserRegex:297`. Decision points inside `runUserRegex`:
  re-measurement budget `:346`, flat-curve break `:384`,
  sub-floor withdrawal, which records the rung and keeps climbing
  `:389` (round 3).
- `apps/web/src/utils/userRegexGuard.ts` — mirror; `USER_REGEX_MAX_SUBJECT_LEN:24`
  and the five siblings that follow it, `USER_REGEX_REMEASURE_BUDGET_MS:47`,
  `userRegexProbeLadder:55`, `userRegexProbeSubject:72`,
  `selectFitAnchor:92`, `describeUserRegexRefusal:116`,
  `runUserRegex:149`.
- `plugins/plugin-integration-core/lib/user-regex-guard.cjs` — mirror; constants from
  `:24`, `USER_REGEX_REMEASURE_BUDGET_MS:35`,
  `selectFitAnchor:69`, `runUserRegex:103`.

**These numbers are generated, not typed.** Round 2's version of this section claimed the
same and nine of its guard anchors were stale by exactly 8 lines — a doc comment grew
between rounds and the list was not regenerated. Regenerate by locating each symbol's
declaration, never by adding a delta.

Call sites:
- `packages/core-backend/src/formula/engine.ts:187` (SUBSTITUTE), `:340` (REGEXMATCH),
  `:344` (REGEXEXTRACT), `:350` (REGEXREPLACE) — these are the REGISTRATION lines; the
  pre-image SINK lines were `:183/:326/:329/:332` and the post-image sinks are
  `regex-safety.ts:311` (validity compile), `:324` (per-rung),
  `:432` (the real call).
- `packages/core-backend/src/multitable/field-validation-engine.ts:112`
  (`evaluatePatternRule`), `:129` (the guarded call), `:192` (the `pattern` case),
  `:273` (`getDefaultValidationRules`, the parity anchor for the ceiling)
  — pre-image sink `:103`, inside `validatePattern:100`.
- `apps/web/src/views/FormView.vue:668` (guarded call), `:671` (the refusal
  message the submitter reads) — pre-image sink `:650`.
- `plugins/plugin-integration-core/lib/validator.cjs:166` (guarded call), `:171`
  (`PATTERN_NOT_EVALUATED`), `compilePattern:85` with its own compile sink
  `:100` — which runs BEFORE the guard, so the pattern-length ceiling is enforced
  here after compilation (verification MD §6); callers `lib/pipeline-runner.cjs:805`,
  `lib/http-routes.cjs:3389,3407`, route table `:269`, handler `:9758`,
  `requireAccess:934`.

Unchanged context (pre-image = post-image, this slice does not touch them):
- `packages/core-backend/src/routes/univer-meta.ts:452,454-456,13471,13842,16398,16523,17518-17526` — reachability + caps + the `explicitRules ?? defaultRules` replacement.
- `packages/core-backend/src/multitable/record-service.ts:489,725`.
- `packages/core-backend/src/multitable/formula-engine.ts:96,155,337,339,372` — evaluateField / dryRun / recalc / fenced derived merge.

Tests:
- `packages/core-backend/src/formula/__tests__/regex-safety.test.ts` — 54 cases.
- `packages/core-backend/tests/unit/user-regex-guard-three-copy-parity.test.ts` — 33 cases.
- `packages/core-backend/tests/unit/user-regex-guard-read-parity-fuzz.test.ts` — 4 cases,
  100000 differential pairs.
