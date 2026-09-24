# Input-regex length gate and shape warning — design (slice H-3, route (ii))

**Status: PROPOSED.** Date: 2026-09-25. Base: `origin/main` @ `e046a21c0a0110fbe22ca765852f1e053d90c0cb`.
Branch: `fix/input-regex-redos-route-ii`. Candidate only — not merged, no PR, no DDL, no new dependency.

## 0. Scope and relation to the earlier branch

The H-3 census (`fix/input-regex-redos-candidates` @ `968ef747f2e6e9b0e1f8b4efba4f50e74d80c47f`,
design and verification MDs `input-regex-redos-census-*-20260922.md` on that branch) identified
the places where a **caller-supplied string is compiled into `new RegExp`** and run on the
shared event loop. That branch also carried a measurement-based guard (a timing ladder) whose
benign-input cost and boundary refusals were judged a design cost rather than a defect. The
decision for this slice is **route (ii)**:

1. a **pure length gate** at every caller-supplied-regex entry point, with limits taken from
   constraints the product already enforces;
2. a **compile-time shape warning** that only logs — never refuses, never throws;
3. the two confirmed sites (formula engine, field-validation pattern rule) treated
   individually, each with its own refusal semantics, timing regression and equivalence pins.

This branch is built fresh on the window baseline. It reuses the census's *conclusions*
(which sites, which populations) and its testing ideas; it does not carry over the timing
ladder or any of its constants. The measurement-based route is not pursued further.

## 1. Sites (post-image `file:line` on this branch; pre-image on the base)

| # | site | pre-image sink | post-image | how the gate is reached |
|---|---|---|---|---|
| L1 | formula engine `SUBSTITUTE` | `packages/core-backend/src/formula/engine.ts:183` | `:187-191` | `runUserRegex(old, 'g', text, replace)` |
| L1 | formula engine `REGEXMATCH` | `engine.ts:326` | `:337-342` | `runUserRegex(pattern, undefined, text, test)` |
| L1 | formula engine `REGEXEXTRACT` | `engine.ts:329` | `:343-350` | `runUserRegex(pattern, undefined, text, match)` |
| L1 | formula engine `REGEXREPLACE` | `engine.ts:332` | `:351-357` | `runUserRegex(pattern, 'g', text, replace)` |
| L2 | field-validation `pattern` rule | `packages/core-backend/src/multitable/field-validation-engine.ts:103` | `evaluatePatternRule :114-129`, `case 'pattern' :187-197`, message `:217` | `runUserRegex(regex, flags, value, test)` |
| L3 | integration pipeline validator | `plugins/plugin-integration-core/lib/validator.cjs:97` | constants `:26-38`, gate `:177-185` | inline copy of the gate, after `compilePattern` |
| FE | public form field pattern | `apps/web/src/views/FormView.vue:650` | `:651-658` + `apps/web/src/utils/userRegexLimits.ts` | inline copy of the gate, before `new RegExp` |

The shared module is `packages/core-backend/src/formula/regex-safety.ts`. L1 and L2 import it.
L3 and FE cannot (no import edge between the roots), so they carry a copy of the two constants
and of `findUserRegexLengthRefusal`; the three copies are pinned behaviourally by
`packages/core-backend/tests/unit/user-regex-limits-three-copy-parity.test.ts`.

## 2. The length gate

### 2.1 Constants and their sources

| constant | value | source (on the base) |
|---|---|---|
| `USER_REGEX_MAX_SUBJECT_LEN` | 10000 | `getDefaultValidationRules` — `string` / `longText` default `maxLength: 10000` (`field-validation-engine.ts:241`) |
| `USER_REGEX_MAX_PATTERN_LEN` | 4000 | `DRY_RUN_MAX_EXPRESSION_LEN = 4000` — the longest formula expression the dry-run route accepts (`routes/univer-meta.ts:454`) |

Why these two: a field with no explicit validation list already refuses a value longer than
10000 on write, so the subject limit adds no refusal for that population. A pattern literal is
a substring of the expression it sits in, so nothing the dry-run route accepts is refused by
the pattern limit. Both limits are pinned as literal numbers in the tests so a change is a
visible edit, not drift.

### 2.2 Order of checks (`runUserRegex`)

1. pattern length > limit → `pattern-too-long` — **before** `new RegExp` (pinned: an
   over-length pattern that is also syntactically invalid is reported as too long, which is
   only possible if the gate precedes compilation);
2. subject length > limit → `subject-too-long` — before the pattern runs on it;
3. `new RegExp(pattern, flags)`; a syntax error → `invalid-pattern` (each site keeps the
   behaviour it had for an invalid pattern, see §2.3);
4. shape warning (§3), log only;
5. `execute(re, subject)` — the caller's own call on the compiled RegExp with the caller's own
   flags; an exception from `execute` propagates unchanged.

A length equal to the limit is inside the limit.

### 2.3 What each site does with a refusal

| site | over-limit (pattern or subject) | invalid pattern (unchanged) |
|---|---|---|
| L1 `REGEXMATCH` / `REGEXEXTRACT` / `REGEXREPLACE` | `#ERROR!` | `#ERROR!` (as before) |
| L1 `SUBSTITUTE` | `#ERROR!` | `#ERROR!` — before, the throw was caught one level up by `calculate` and produced the same sentinel |
| L2 `pattern` rule | `valid:false`, rule `pattern`, **message names the limit** (`describeUserRegexRefusal`), and this message takes precedence over a custom `rule.message` because a custom message describes a mismatch, not a refusal | `valid:false` with the format message (as before) |
| L3 pipeline validator | error code `PATTERN_NOT_EVALUATED` with `details.reason` / `length` / `limit`; `INVALID_RULE` keeps precedence (the gate runs after `compilePattern`, so at this one site the pattern limit bounds the match, not the compilation) | `INVALID_RULE` (as before) |
| FE form | a field error: over-length value → "不能超过 N 个字符"; over-length pattern → "格式规则过长，无法校验" | `new RegExp` throws (as before) |

The L2 message rule is the one semantic choice in this table that is not forced by the gate
itself; it follows the reviewed predecessor branch and is a one-line change if the owner
prefers the custom message to win.

## 3. The shape warning

### 3.1 Definition

`describeUserRegexShape(pattern)` scans the pattern's syntax and reports:

- `nested-quantifier` — a group under an **unbounded** quantifier (`*`, `+`, `{n,}`, lazy or
  not) whose **first mandatory atom** (skipping leading optional atoms) is itself under an
  unbounded quantifier, directly or through an inner group that starts that way;
- `quantified-alternation` — a group under an unbounded quantifier whose body has a top-level
  `|`.

Escapes, character classes, non-capturing / named groups and lookarounds are parsed; a
bounded quantifier (`?`, `{n}`, `{n,m}`) is treated as bounded whatever its size.

### 3.2 Heuristic, and stated as one

- **False positives**: a group that starts with an unbounded atom but whose iterations are
  separated by a delimiter later in the body is flagged although it is linear. One such idiom
  (`^(\w+\.)*\w+$`) is pinned in the tests as *flagged*, so the code and this sentence cannot
  drift apart silently. The common delimiter-first idioms (version numbers, slugs, comma
  lists, e-mail, path segments) are pinned as *not flagged*.
- **False negatives**: overlap between alternatives, or between an atom and what follows it,
  is not modelled; a large bounded quantifier is treated as bounded.
- **Never refuses, never throws**: malformed input yields `[]`; the warning path is wrapped so
  a failure in it (including a throwing log sink) cannot affect evaluation. Both are pinned.

This is why it is a log and not a gate.

### 3.3 Where and how it logs

- Backend only (`Logger('UserRegexGuard').warn`), through a replaceable `userRegexGuardHooks.warn`
  so tests observe it without a logger spy. L3 and FE carry no scanner: the log is read by an
  operator of the backend process, and it is not a gate.
- Once per distinct `(flags, pattern)` per process, in a bounded table
  (`USER_REGEX_SHAPE_WARNING_MEMORY = 256`, oldest entry evicted). A stored rule that is
  evaluated on every record write therefore produces one line, not one per write.
- Log line: message `caller-supplied regex has a shape that can backtrack super-linearly;
  evaluated unchanged`, fields `site` (`formula:REGEXMATCH`, `field-validation:pattern`, …),
  `kinds`, `patternLength`, `patternPreview` (first 80 characters), `flags`.

## 4. What is unchanged (the equivalence claim)

Inside the limits every site makes the same call it made before — the same RegExp source, the
same flags, the same `.test` / `.match` / `.replace` — so the answer is the same. This is pinned
two ways per site: a table of ordinary inputs through the public entry points
(`engine.calculate`, `validateRecord` / `validateFieldValue`), and a seeded 2000-pair fuzz that
calls the registered functions and the rule directly and compares them with a verbatim copy of
the previous implementation. The fuzz corpus is linear by construction (no quantified groups)
because the claim under test is "same answer", not "bounded cost"; its non-degeneracy (many
distinct patterns, both verdicts) is asserted.

Also unchanged: the formula engine's string-literal parser, `SUBSTITUTE`'s treatment of its
second argument as a pattern, the default and custom messages for a format mismatch, the
`INVALID_RULE` code at L3, and the order in which an explicit `maxLength` rule reports before a
`pattern` rule.

## 5. The two confirmed sites — what "site-specific" could and could not mean here

The route (ii) decision asks for the two confirmed sites to be treated individually. Both are
sites where the **caller supplies the pattern**, so "rewrite the site's regex into a linear
one" has no object: there is no fixed regex at either site to rewrite. What this branch does
for each site individually is the refusal semantics in §2.3, a timing regression pinned per
sink, and the equivalence pins in §4.

Going further than that — making the *evaluation* linear-time at these sites — cannot be done
without changing the set of inputs the site accepts or the answers it gives, which is not
covered by the decision. The options, for the owner:

| option | what changes | acceptance-set / answer change |
|---|---|---|
| (a) stop here | length gate + shape warning (this branch) | only the new refusals of §6.2 |
| (b) `SUBSTITUTE` as a literal replacement | the one L1 sub-site whose spreadsheet contract is literal; its second argument would no longer be a pattern | a stored formula whose second argument uses pattern metacharacters gives a different result (predecessor branch commit `3d7066f92`, reviewed there) |
| (c) a linear-time engine for caller patterns | new dependency; L1/L2 evaluate on it | patterns using backreferences or lookaround stop compiling |
| (d) an interruptible evaluation (worker + deadline) | L1/L2 become asynchronous at the sink | a slow evaluation is reported as a refusal after the deadline; the call sites' synchronous contract changes |

None of (b)–(d) is implemented. The branch stops at (a) and records the question.

## 6. Residuals

### 6.1 Not bounded

A pattern that is super-linear **inside** the limits is evaluated as before. The length gate
bounds the subject, not the work; the shape warning describes, it does not stop. This is the
known limit of route (ii) and the reason §5 exists.

### 6.2 New refusals (the population the gate changes)

- A field whose explicit rule list carries a `pattern` rule but no `maxLength` rule refuses a
  value longer than 10000 on write (before: no length bound at all on that path, because
  `explicitRules ?? defaultRules` replaces the defaults — `routes/univer-meta.ts:17518`,
  `multitable/record-service.ts:489`). The public form gives the same answer for its own
  `validation.pattern` surface. The size of this population in stored data cannot be counted
  from here.
- A stored pattern (formula argument, validation rule, pipeline mapping) longer than 4000
  characters is refused.
- The formula sinks report `#ERROR!` for an over-limit input, the same sentinel they already
  report for an invalid pattern, and it reaches the same downstream paths (including derived
  value materialisation). The sentinel is not new; the inputs that produce it are.

### 6.3 Observability

Refusals are visible to the caller (validation error message, `#ERROR!`, `PATTERN_NOT_EVALUATED`)
but are not counted or logged server-side. Shapes are logged (§3.3) but not counted. Neither is
a metric.

## 7. For the owner

1. §5: whether any of (b)–(d) should follow, and which.
2. §2.3: at L2, refusal message vs custom message precedence (currently: refusal message wins).
3. §6.2: whether the two limits should be announced to field/pipeline administrators before
   this lands, given the explicit-rule population cannot be counted from the code.
4. §6.3: whether a refusal counter is wanted (not in this slice).
