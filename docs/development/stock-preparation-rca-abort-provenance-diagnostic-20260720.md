# Stock-Preparation RC-A Abort-Provenance Diagnostic Client — Development & Verification (2026-07-20)

Issue: #4437 (RC-A on-prem acceptance, diagnostic chain). Scope: one new tested, read-only,
values-free diagnostic client plus its contract tests and CI wiring. No service-side change, no
RC-A package republish, no flag or PM2 interaction.

## 1. Why

The #4437 diagnostic chain reached a contradiction. With the numeric literal `timeoutMs: 15000`
attested at the call site, the probe still reported `authReadResult=ABORT_ERROR` with
`elapsedClass=LT_1S`. At the exact package SHA, the smoke helper `requestJson` has exactly one
abort source — `setTimeout(() => controller.abort(), timeoutMs)`, cleared in `finally` — so a
sub-second AbortError cannot originate from that timer in a standard Node runtime. The remaining
hypotheses are: the abort came from outside the helper's controller, the supplied timeout value
did not actually reach the helper, or the machine's JS runtime has nonstandard timer/abort
semantics (the preserved capture's `clientNodeMajor=OTHER` remains unresolved).

Owner verdict (2026-07-20): the diagnosis direction stands, but hand-written operator wrappers
have exhausted their evidentiary credit (consecutive import-method and timeout contradictions).
The next probe must be a tested script whose output block is produced by the script itself.

What this diagnostic can and cannot conclude, per the same verdict:

- The exact-SHA helper is NOT "structurally cleared" wholesale. Only one path is excluded: its
  own correctly-scheduled 15s timer producing a sub-second abort. Independent tool gaps (for
  example, the smokes' `--timeout-ms` argument is `Number()`-coerced without a strict
  positive-integer guard) remain open and are out of scope here (see §6).
- `abortProvenance=OUTSIDE_HELPER_SIGNAL` only states the helper's controller did not fire. It
  does not by itself attribute the abort to the operator context, the fetch implementation, or
  the runtime.
- `abortErrorNameClass=TIMEOUT_ERROR` is a strong hint that some `AbortSignal.timeout()` exists
  in the failure path (the helper's mechanism produces plain `AbortError`), reported as an
  observation, not as sole attribution.

## 2. Deliverable

`scripts/ops/stock-preparation-rca-abort-provenance.mjs` — single-file client, Node builtins
only, shipped separately from the RC-A package. It imports the exact-SHA helper module from the
existing on-machine checkout via `pathToFileURL` (basename allowlist: the two RC-A smoke
harnesses) and produces one fixed values-free result block.

Three observation phases:

1. **Runtime identity (no network).** `runtimeIdentity=NODE|BUN|DENO|OTHER` — Bun/Deno
   compat markers are checked before Node, since both emulate `process.versions.node` —
   plus `nodeMajorClass=18|20|22|24|OTHER|UNAVAILABLE`.
2. **Local timer/abort semantics (no network).** Schedules the same abort-timer shape the helper
   uses (15s `setTimeout` -> `controller.abort()`), sleeps ~1.2s, and classifies against
   `process.hrtime.bigint()`: `NORMAL | ABORT_EARLY | CLOCK_ANOMALY`. The abort timer is cleared
   in `finally` on every path so it can never outlive the probe and pollute the real request.
3. **One request through the helper's own `fetchImpl` seam.** Exactly one internal read-only GET
   with the smoke AUTH shape (tenant scope via query + header when supplied), fixed
   `timeoutMs: 15000` (no CLI override exists; unknown flags — including `--timeout-ms` — fail
   closed with a usage error). The provenance shim only observes: it counts dispatches, latches
   whether every target stayed under the base URL, subscribes to the helper-provided
   `AbortSignal`, and delegates to global fetch unmodified. Elapsed time is monotonic-clock
   bucketed (`LT_1S | 1_TO_14S | 15_TO_20S | GT_20S`).

Result block (closed vocabulary, fixed order, every value validated before rendering; the
rendered block is additionally scanned for the auth token and scrubbed fail-closed):

```text
STOCK_PREPARATION_RCA_ABORT_PROVENANCE
executionState=DIAGNOSTIC_COMPLETE|DIAGNOSTIC_BLOCKED
diagnosticAction=RUNTIME_ABORT_PROVENANCE
blockedReasonClass=NONE|USAGE|HELPER_MISMATCH|IMPORT|NO_REQUEST|REQUEST_ANOMALY|INTERNAL
runtimeIdentity=NODE|BUN|DENO|OTHER|UNAVAILABLE
nodeMajorClass=18|20|22|24|OTHER|UNAVAILABLE
timerProbeResult=NORMAL|ABORT_EARLY|CLOCK_ANOMALY|UNAVAILABLE
helperContentVerified=PASS|FAIL|UNAVAILABLE
fileUrlImport=PASS|FAIL|UNAVAILABLE
timeoutArgumentMs=15000
networkRequestCount=0|1|OTHER
networkTarget=INTERNAL_API_ONLY|OTHER|UNAVAILABLE
authReadResult=HTTP_2XX|HTTP_4XX|HTTP_5XX|TYPE_ERROR|ABORT_ERROR|OTHER|UNAVAILABLE
elapsedClass=LT_1S|1_TO_14S|15_TO_20S|GT_20S|UNAVAILABLE
typeErrorBoundary=INVALID_URL|REQUEST_HEADERS|CONNECT|DNS|TLS|FETCH_API|RESPONSE_READ|OTHER|NONE|UNAVAILABLE
abortErrorNameClass=ABORT_ERROR|TIMEOUT_ERROR|OTHER|NONE
abortProvenance=HELPER_SIGNAL|OUTSIDE_HELPER_SIGNAL|NONE|UNAVAILABLE
externalWrite=false|true
tokenScrubbed=PASS|FAIL|NOT_USED
flagTouched=false
```

Fail-closed accounting: `externalWrite=true` for anything beyond exactly one internal request
(over-reporting direction); `networkTarget` latches `OTHER` permanently once any non-internal
target is observed; a failed helper import blocks the request phase entirely
(`DIAGNOSTIC_BLOCKED` / `IMPORT`, zero dispatches). `flagTouched=false` is a constant: the client
has no code path that touches service-side flags.

TypeError boundary classification collects error codes from a closed set of locations (error,
cause, AggregateError members, one nested cause level — Node >= 20 wraps connection failures in
AggregateError) and maps them into coarse families; no code at any location -> `FETCH_API`,
unrecognized codes -> `OTHER`. Values are never printed.

## 3. Owner-verdict absorption map

| Verdict item | Where absorbed |
|---|---|
| "Structurally cleared" was too strong | §1 scope statement; script header comment states the narrow exclusion only |
| Local timer probe must clean up | `runTimerProbe` clears the abort timer in `finally`; leaked-timer test + mutation M1 |
| Elapsed must use `process.hrtime.bigint()` | `defaultNowNs`; timer probe measures the sleep against it (`CLOCK_ANOMALY`), request elapsed bucketed from it |
| `helperSignalFired=FALSE` must not indict the operator wrapper | Neutral enum `abortProvenance=OUTSIDE_HELPER_SIGNAL`; comment forbids further attribution |
| TimeoutError is a hint, not sole attribution | Separate observation field `abortErrorNameClass`; no causal wording |
| No more self-reported wrapper fields | Every field is computed and rendered by the script; closed-vocabulary validation throws on any out-of-registry value; token scrub is a final fail-closed pass over the rendered block |
| Fixed 15000, no CLI override | `TIMEOUT_MS` constant; `--timeout-ms` (and any unknown flag) raises a usage error; end-to-end test pins `timeoutMs === 15000` at the real helper call site |
| Acceptance on CI-parity Node 20 | Contract tests wired into the existing prep-line workflow's contract job (`node-version: 20`) |

## 4. Verification

Suites (local, Node 25; CI runs the same files on Node 20):

- `node --test scripts/ops/stock-preparation-rca-abort-provenance.test.mjs` — 30/30 pass.
  Owner-required scenarios covered: HTTP 2xx (real helper through the seam), helper-signal abort
  (real helper, its own timer firing, `HELPER_SIGNAL`), outside-signal abort (AbortError with the
  helper signal never firing, `OUTSIDE_HELPER_SIGNAL`), anomalous runtime (Bun/Deno markers,
  non-enumerated majors), leaked timer (counting hooks assert the abort-timer handle is cleared
  on normal and anomaly paths). Plus: vocabulary/order pinning, blocked blocks, arg parsing
  fail-closed, elapsed bucket boundaries, rejection classification (AbortError / TimeoutError /
  TypeError families incl. AggregateError members), network accounting fail-closed, tenant-scoped
  AUTH pathname shape, token-scrub PASS/FAIL/NOT_USED including an adversarial token colliding
  with rendered vocabulary text.
- Regression: `stock-preparation-prep-line-extended-smoke.test.mjs` 19/19,
  `stock-preparation-mvp-postdeploy-smoke.test.mjs` 30/30 (same contract job).

CLI end-to-end (real fetch, no server):

- Refused high port -> `authReadResult=TYPE_ERROR`, `typeErrorBoundary=CONNECT`,
  `networkRequestCount=1`, exit 0. (Initial check against a fetch-spec blocked port surfaced the
  AggregateError/plain-cause classification gap; fixed and covered by test.)
- `--timeout-ms` present -> `DIAGNOSTIC_BLOCKED` / `blockedReasonClass=USAGE`, static usage text,
  exit 2.

Mutation battery (commit `04f6f5401`; apply -> expect RED -> restore -> clean rerun 30/30):

| Mutation | Result |
|---|---|
| M1 drop abort-timer `clearTimeout` in `finally` | RED (2) — leaked-timer test first |
| M2 `timeoutMs: TIMEOUT_MS` -> `1500` at call site | RED (1) — fixed-15000 call-site pin |
| M3 unknown flags silently ignored | RED (2) — `--timeout-ms` rejection test |
| M4 swap HELPER/OUTSIDE provenance branches | RED (3) — helper-signal test first |
| M5 remove helper-signal listener subscription | RED (4) — seam contract test first |
| M6 elapsed boundary `<` -> `<=` at 1s | RED (1) — bucket boundary test |
| M7 remove closed-vocabulary validation throw | RED (1) — out-of-registry refusal test |
| M8 skip token-scrub scan (always return tentative) | RED (1) — collision-scrub test |

## 4b. Round-2 review absorption (2026-07-20)

Owner round-2 identified two false protections in the first cut; both are closed:

1. **Basename allowlist was not an exact-SHA binding.** Any file renamed to an allowlisted
   basename would have been dynamically imported and executed. Now `HELPER_CONTENT_SHA256` pins
   the SHA-256 of both smoke harnesses as of the RC-A exact package SHA
   `d87e086fd1218b4cfb150177d43f2c52904b1d6d`, and `verifyHelperContent` byte-checks the target
   file AND its statically-imported sibling (the extended smoke imports its sanitizing layer from
   the W6 smoke) BEFORE any dynamic import. Any mismatch, unreadable file, or missing sibling ->
   `DIAGNOSTIC_BLOCKED` / `HELPER_MISMATCH` with zero imports and zero requests (exit 2). A
   repo-parity tripwire test fails loudly if the frozen smokes ever drift from the pinned digests
   without a new diagnostic release.
2. **Zero-request runs could read as COMPLETE.** A runtime without `fetch` (or any skipped
   request phase) previously fell through to `DIAGNOSTIC_COMPLETE` with `UNAVAILABLE` request
   fields. `DIAGNOSTIC_COMPLETE` is now a contract: content verified + import passed + exactly
   the intended request dispatched and classified; otherwise `DIAGNOSTIC_BLOCKED` /
   `NO_REQUEST`. Precedence: `HELPER_MISMATCH` > `IMPORT` > `NO_REQUEST`.

Added verification: suite grew to 35/35 (constants shape + sibling map closure, repo-parity
tripwire, fixture-based verify PASS/FAIL/missing-sibling/tamper cases, mismatch end-to-end with
zero import/fetch spies, fetch-less NO_REQUEST closure); CLI end-to-end for the verified path and
a tampered-copy path (BLOCKED, exit 2). Mutations M9-M12 (import-despite-mismatch,
zero-request-complete, digest-drift, sibling-dropped) each RED with the intended discriminating
test first; clean rerun 35/35.

## 4c. Round-3 review absorption (2026-07-20)

Owner round-3 reproduced two more false-PASSes; both closed:

1. **Symlink bypassed the exact-SHA binding.** Verification derived the sibling directory from
   `path.dirname(path.resolve(helperPath))`, which normalises `..` but does NOT follow symlinks,
   while the Node loader imports a symlinked module by its real path and resolves that module's
   static sibling import relative to the real directory. An attacker holding a byte-correct sibling
   copy beside a symlink could make an UNVERIFIED real sibling execute. Fix: `resolveRealHelperFiles`
   `realpath`s the target and each sibling, requires each real basename to equal its logical name
   and each sibling to reside in the target's real directory, and both verification and import
   operate on those real paths. Reproduced end-to-end: a tampered real sibling behind a clean
   link-dir copy now yields `HELPER_MISMATCH` / exit 2. (Import via the caller path vs the resolved
   real target is behaviourally equivalent — Node realpaths either to the same module — so that
   mutation is an intentional equivalent; the residence and content guards are the load-bearing ones.)
2. **Multiple / non-internal requests could read as COMPLETE.** The closure only blocked zero
   requests. `DIAGNOSTIC_COMPLETE` now requires exactly one dispatch to the internal origin with
   `externalWrite=false`; anything else (two dispatches, non-internal target, external-write guard
   tripped) is `DIAGNOSTIC_BLOCKED` / `REQUEST_ANOMALY` / exit 2.

Also fixed the P3: internal-target classification moved from `startsWith(baseUrl)` (which called
`http://internal.example.evil` internal) to a same-origin `URL` comparison with an optional base
path-prefix check; unparseable targets fail closed to non-internal.

Verification grew to 42/42: `isInternalTarget` origin cases incl. the evil-suffix host, symlink
repro (resolve into the real dir, tampered real sibling caught, differently-named target refused,
sibling escaping the pinned dir refused), and two `REQUEST_ANOMALY` end-to-end cases (two internal
dispatches, one external dispatch). Mutations M13/M15/M16/M17 (drop realpath, startsWith
regression, drop anomaly guard, count-only anomaly check) each RED with the intended test first;
M14 (drop sibling residence guard) RED via the escape test; clean rerun 42/42.

## 5. Operating notes (entity machine, owner-authorized runs only)

```
node scripts/ops/stock-preparation-rca-abort-provenance.mjs \
  --helper <exact-sha-checkout>/scripts/ops/stock-preparation-prep-line-extended-smoke.mjs \
  --base-url <internal-base-url> [--tenant-id <tenant>]
```

Token via `METASHEET_AUTH_TOKEN` (never printed; scrub is checked over the final render). The
client performs at most one internal GET, keeps the service flag posture untouched, and exits 0
only on `DIAGNOSTIC_COMPLETE`. Routing of the result block stays owner-court; this document
deliberately encodes no fast-track condition.

## 6. Acknowledged independent gap (not addressed here)

The existing smoke harnesses parse `--timeout-ms` with `Number(next())` (accepts `''`->0-like
coercions, exponent/hex forms, non-integers) and schedule `setTimeout` from it unvalidated. A
strict positive-safe-integer guard is a separate acceptance-tool hardening slice; it is left
untouched in this PR so the exact-SHA package surface stays byte-stable for #4437.
