# Automation `send_webhook` SSRF gate — verification (G05 / #5615 刀 0)

**Date**: 2026-09-10 · **Branch**: `fix/automation-webhook-ssrf-guard` (base `origin/main` @ `11dddc18b`)
· Design: `automation-webhook-ssrf-guard-design-20260910.md`

## 1. Commands and exit codes

All run from the worktree root, `pnpm 9.15.9` / `vitest 1.6.1` / Node 20.

| # | Command | Result |
|---|---|---|
| 0 | `pnpm install --frozen-lockfile --offline` | exit **0** (1m 10s) |
| 1 | `pnpm --filter @metasheet/core-backend run type-check` | exit **0** (`tsc --noEmit`), re-run after the review round |
| 2 | `… exec vitest run tests/unit/automation-send-webhook-ssrf.test.ts` | exit **0** — **62 passed / 62** (37 → 57 after the first review round → 62 after the second, §3.2) |
| 3 | `… exec vitest run` over the 8 affected specs (below) | exit **0** — **417 passed / 417**, 8 files (392 → 412 → 417) |
| 4 | `npx eslint src/multitable/automation-executor.ts src/multitable/webhook-refusal-class.ts` | exit **0**, no findings (run from the package root; the repo's `.eslintrc.json` needs `parserOptions.project` resolved there, and it ignores `**/*.test.ts`) |
| 5 | Full `… exec vitest run` (core-backend) | see §5 — pre-existing local noise, CI is the judge |

Command 3's file set: `automation-send-webhook-ssrf`, `send-webhook-action-hardening`,
`automation-classb-outbound`, `automation-v1`, `webhook-ssrf-guard`, `multitable-button-routes`,
`multitable-automation-log-redact`, `webhook-pinned-fetch`.

**Pre-change baseline** for comparison: the same set minus the new spec (6 files) was **348 passed**,
exit 0, before any edit — so nothing that was green went red.

**Not run here** (stated so no one reads a number that does not exist): the 5 real-DB integration files.
They need `DATABASE_URL`; three of them are in the vitest `exclude` list and run as whole files in the
`plugin-tests.yml` real-DB lanes. Their first real execution is that lane on this PR. The pre-merge
inventory in the design note (§7) also needs a real database and was **not** run from here.

### Runtime fact this round depends on, measured rather than quoted

```
node v25.9.0
new Request('https://e.com/').redirect                       === 'follow'
new Request('https://e.com/', {redirect:'manual'}).redirect  === 'manual'
[default] POST → 307 → status 200, redirected true, second server hit 1 time
[manual]  POST → 307 → status 307, ok false, type 'basic', second server hit 0 times
```

Two loopback `http.Server`s in a scratch script (no external network, nothing written into the repo).
The `manual` row is what the fix relies on: the platform surfaces the 3xx itself and issues no second
request. Note the shape is the Node/undici one — the browser profile returns an opaque-redirect response
(`type 'opaqueredirect'`, `status 0`) instead, so `isRefusedRedirectStatus`
(`webhook-refusal-class.ts:86`) accepts both rather than assuming one.

## 2. Coverage map of the new spec

`packages/core-backend/tests/unit/automation-send-webhook-ssrf.test.ts` — 62 tests. Every *pre-dispatch*
refusal test asserts `expect(fetch).toHaveBeenCalledTimes(0)` via the shared `expectRefused` helper,
alongside the step status, the coded error and the values-free class. The redirect cases assert
`toHaveBeenCalledTimes(1)` instead — the first hop is allowed, and nothing follows it.

| Group | Cases | Class asserted |
|---|---|---|
| Loopback | `127.0.0.1`, `127.9.9.9` (whole `/8`), `localhost` (no DNS call), `[::1]` | `loopback` |
| Private / link-local | `10.1.2.3`, `172.16.0.9`, `192.168.1.10`, `169.254.169.254`, `0.0.0.0` | `private` / `link-local` / `unspecified` |
| IPv6 + mapped | `[fd00::1]`, `[fe80::1]`, `[::ffff:127.0.0.1]`, `[::ffff:10.0.0.5]` | `unique-local` / `link-local` / `loopback` / `private`, family `ipv4-mapped-ipv6` |
| DNS-decided | resolves to `10.0.0.5`; multi-record with one `169.254.169.254`; resolves to `::ffff:127.0.0.1`; resolver throws; empty record set | `dns-resolved-internal` / `dns-unresolved` |
| Malformed / scheme | `'not a url'`, non-string `12345`, `http://…`, `http://127.0.0.1`, `file:///etc/passwd`, `*.internal` | `invalid-url` / `scheme-not-allowed` / `loopback` / `internal-name` |
| **Positive controls** | public IP literal (headers + body verbatim, 1 fetch); public NAME with all-public records (1 fetch, 1 lookup) | — |
| Credentials | fetch never called; values-free log; values-free step result; values-free gate-owned surfaces | — |
| **Two-phase (#4196)** | positive control (intent claimed + 1 fetch); private target; DNS-internal target; credentialed loopback — each asserting **0 intent inserts** and 0 fetches | — |
| Terminal | a 500 on a public target *does* retry (>1 fetch); a refused target is never attempted | — |
| Contract | pins the guard's `reason` strings; classifier returns only closed-set tokens | — |
| **Redirects** (new) | legacy 307 → internal `Location`; `redirect:'manual'` asserted on the dispatch init (both paths); 301/302/303/307/308 table; two-phase 302 (intent claimed + outcome recorded); values-free; 2xx positive control | `redirect-not-allowed` |
| **Post-dispatch logs** | credentialed **public** URL that fails with a **mocked HTTP 500**: the legacy "failed after N attempts" line and the two-phase `outcome_unknown` line carry no userinfo / `token=` / path. **Insufficient on its own** — see the row below and §3.2 | — |
| **Native request-construction exception** (new, §3.2) | the same credentialed **public** URL dispatched through the **real** `fetch` (no mock): runtime precondition (throws at request construction, message carries the password, `redactString` does **not** catch it); legacy log; legacy step classification; two-phase log + step classification + intent bookkeeping; the classifier's closed set + its "never reads `message`" invariant | `invalid-request` |
| **Host-form matrix** (new) | `0177.0.0.1`, `2130706433`, `0x7f.1`, `127.1`, `%31%32%37.0.0.1`, `127。0。0。1` (IDNA), `localhost.`, `LOCALHOST`, `http://public@127.0.0.1`; a lying resolver seam; plus two ALLOW counter-controls (`…#@127.0.0.1`, `127.0.0.1@example.com`) | `loopback` / `private` / — |

Four assertions carry the security weight and are named explicitly for review:

- `refuses the IPv4 loopback literal 127.0.0.1 and never calls fetch`
- `refuses an internal target BEFORE Tx A: no intent row claimed, no fetch`
- `legacy path: a 307 to an internal Location produces NO second fetch and a failed step`
- *legacy path: asks the platform not to follow (redirect: "manual" on the dispatch init)* — the one
  that actually binds production, because an in-process mock cannot follow a redirect even when the
  option is missing (see probe **M1**).

The host-form matrix is a **tripwire, not a fix**: every row is refused on the baseline too. It exists
because all of those rows are refused only thanks to WHATWG `new URL()` normalisation (IPv4
octal/decimal/hex/short forms, IDNA mapping, percent-decoding) happening before
`webhook-ssrf-guard.ts:98` reads `parsed.hostname` — an implicit precondition that nothing else in the
suite states. Probe **M7** shows what that is worth.

## 3. Mutation probes

Method: `packages/core-backend/src/multitable/automation-executor.ts` was copied **outside the repo**
(session scratchpad), mutated, run, then restored and hash-verified. Nothing was committed and no probe
artifact remains.

- pre-probe / post-restore sha256: `5c23eb5723e9b02d76cf6e8ea5478e063f3edbfb1157d69651bd0953ef9b847d`
  (identical), and the spec is 37/37 green again after restore.

| Probe | Mutation | Result | Reads as |
|---|---|---|---|
| **P1** | Delete the entire gate block (2 931 chars) | **32 failed / 5 passed** | The gate is what refuses. Survivors are exactly the 2 positive controls, the 2 pure classifier/guard-contract tests, and the gate-owned values-free test (a run with no refusal has nothing to leak) — i.e. the controls are *not* gate-dependent, as a control must not be. |
| **P2** | Refusal downgraded to log-only, execution falls through and sends ("monitor mode") | **30 failed / 7 passed** | A log-only regression cannot pass. |
| **P2b** | Dispatch the request anyway but still **report** the refusal (status/error/class all unchanged) | **29 failed / 8 passed**; the loopback case fails with `expected "spy" to be called +0 times, but got 1 times` | Isolates the call-count assertion: with every status/error/class assertion still green, only the fetch counter catches the leak. This is the probe that proves "refused" means "nothing left the process". |
| **P3** | Add `url` to the refusal log meta | **exactly 1 failed** — `VALUES-FREE: the refusal log carries only the code + host shape, never the URL or a header value` (`expected '["[automation.send_webhook.refused]",…' not to contain '127.0.0.1'`) | The values-free assertion is load-bearing and precisely targeted. |
| **P4** | Move the gate to **after** the two-phase dispatch (legacy path only) | **exactly 3 failed** — the three two-phase refusal tests | The *placement* before Tx A is load-bearing, and the two-phase coverage is not redundant with the legacy coverage. |

### 3.1 Review-round probes (the redirect fix and the two log lines)

Same method: the file was copied to the session scratchpad, mutated in place, run, restored from the
copy, and the sha256 re-checked. `automation-executor.ts` before and after:
`5fd8076a85f765c15d06fcd099d1c5c35d70f76b9f85ba81c8c927c3256e6554` (identical);
`webhook-ssrf-guard.ts` (touched only by M7) before and after:
`a964abd8d4b4a483cb314e1609369753fe92eff615c0932b7b8a5636715b9a75` (identical). `git status` after the
restore lists neither file as modified beyond the intended change set. All counts are out of **57**.

| Probe | Mutation | Result | Reads as |
|---|---|---|---|
| **M1** | Delete `redirect: 'manual'` from **both** dispatch inits | **2 failed / 55 passed** — exactly the two "asks the platform not to follow" cases | Honest negative worth stating: the *behavioural* 307 cases survive this mutation, because a mocked `fetchFn` cannot follow a redirect regardless of the option. Only a direct assertion on the dispatch init can catch the deletion, which is why both paths have one. Without those two cases the production-relevant half of this fix would be unpinned. |
| **M2** | Legacy path: make the 3xx branch unreachable (fall through to the ordinary non-2xx → retry path) | **3 failed / 54 passed** — the 307 case, the 301/302/303/307/308 table, and the values-free redirect case | A 3xx that is merely "a failed attempt" is not the same thing: the count goes to 3 fetches and the coded error disappears. |
| **M3** | Two-phase path: make the redirect branch unreachable | **1 failed / 56 passed** — the two-phase 302 case | The two-phase coverage is not redundant with the legacy coverage (same conclusion P4 reached for the gate itself). |
| **M4** | Restore the old legacy failure log (`send_webhook to ${redactString(url)} failed after …`) | **1 failed / 56 passed** — "the 'failed after N attempts' line carries shape + identifiers, never the URL" | The shared redactor does not save that line: the case feeds `https://<user>:<pw>@203.0.113.10/hook?token=…`, a **public** target the gate allows. **Incomplete, as the next review round proved**: this probe only removed the *URL* interpolation, while the replacement line still carried `failure: redactString(lastError)`, and the case's mocked HTTP 500 makes `lastError` the harmless string `HTTP 500`. See §3.2. |
| **M5** | Restore the old two-phase `outcome_unknown` log | **1 failed / 56 passed** — the two-phase half of the same pair | Same, on the other dispatch path. |
| **M6** | Drop `ruleId` / `executionId` from the refusal log meta | **1 failed / 56 passed** — the values-free refusal case (its positive half) | The identifiers are pinned, so a later "tidy up the log meta" cannot silently take them away again; and the FORBIDDEN list in the same case still guards the other direction. |
| **M7** | Replace `parsed.hostname` in `webhook-ssrf-guard.ts` with hand-rolled string parsing of the raw URL (a plausible "let's normalise the host ourselves" refactor) | **6 failed / 51 passed** — exactly the six numeric/IDNA rows (`0177.0.0.1`, `2130706433`, `0x7f.1`, `127.1`, `%31%32%37.0.0.1`, `127。0。0。1`) | This is the case for the matrix: under that mutation all six become **allowed egress to loopback**, and every one of the original 37 cases stays green. The trailing-dot and uppercase rows also survive the mutation (that mutant still lowercases and the name classifier strips the trailing dot), which is why the matrix lists them separately rather than claiming one uniform reason. |

### 3.2 Second review round — the P2 counterexample (log redaction was not finished)

**The counterexample, as given**: the new log still recorded `redactString(lastError)`; with a synthetic
URL, the real guard, the real redactor and **native `fetch`**, the request-construction exception carries
the full URL and the password still reaches the log. The earlier test used a mocked HTTP 500 and missed it.

**Reproduced first, on the branch as it stood.** A throwaway spec (real `globalThis.fetch` captured at
module load, real guard with a TEST-NET-3 resolver stub, real redactor, no mock, `AUTOMATION_WEBHOOK_MAX_RETRIES=0`)
printed the log line the executor actually emitted:

```
[automation.send_webhook.failed] {"hostFamily":"ipv4","attempts":1,
 "failure":"Request cannot be constructed from a URL that includes credentials: https://svc:S3cr3t@203.0.113.10/x?token=SUPERSECRETQUERY",
 "sheetId":"sheet_1","ruleId":"rule_ssrf","executionId":"axe_63be9ece-…"}
```

→ `AssertionError: expected '[["[automation.send_webhook.failed]",…' not to contain 'S3cr3t'`
(**1 failed / 2 passed**). The same probe's two-phase case was **green** before the fix — that path logs
`reason: "network_error"` from `outboundReasonClass`, which is computed from a status/system code and
never from a message. So the leak was the legacy line only, and the probe says so rather than claiming
both. The probe file was deleted after capture; the permanent version of all five cases lives in the spec
(`automation-send-webhook-ssrf.test.ts:737`).

**No network**: the rejection happens while *constructing* the `Request` (undici refuses a URL with
userinfo), before DNS or any socket, and the host is an RFC 5737 documentation literal. The spec pins that
precondition explicitly, so the suite cannot quietly become one that dials out.

**The fix**: `failure: redactString(lastError ?? 'unknown')` → `failureClass: WebhookFailureClass`, a
closed union produced by `classifyWebhookFailure` (`webhook-refusal-class.ts:192`) which reads only
`name` / `code` / `cause.name` / `cause.code` and **never** `error.message`. Closed set (10 members):
`http-4xx`, `http-5xx`, `http-other`, `timeout`, `invalid-request`, `dns-failure`, `conn-refused`,
`tls-failure`, `transport-error`, `unknown`. The same class is echoed into the step's `output`
(`automation-executor.ts:4332`). The credentialed case now logs
`{"attempts":1,"failureClass":"invalid-request","hostFamily":"ipv4","sheetId":…,"ruleId":…,"executionId":…}`.

**Probes** (same method: file copied to the session scratchpad, mutated, run, restored from the copy;
nothing committed, no artifact left). All counts out of **62**; the suite is 62/62 again after each restore.

| Probe | Mutation | Result | Reads as |
|---|---|---|---|
| **R1** | Exactly the reviewer's revert: log `failure: redactString(lastError ?? 'unknown')` instead of `failureClass` | **1 failed / 61 passed** — `legacy path: the failure log carries a CLOSED failure class, never the client message` | The counterexample is pinned by precisely one case, and it is the case that names it. |
| **R2** | Keep `failureClass` **and** re-add `failure: redactString(lastError)` (the plausible "but it is useful" regression) | **1 failed / 61 passed** — same case | The assertion is on the **absence of free text**, not merely on the presence of the class; adding the class back does not buy a leak. |
| **R3** | Step `output.failureClass` carries `lastError` instead of the class | **1 failed / 61 passed** — `legacy path: the step CLASSIFICATION is closed-set — the client message is not in it` | The step classification is covered separately from the log, so neither surface can regress under cover of the other. |
| **R4** | `classifyWebhookFailure` builds its label from `error.message` | **3 failed / 59 passed** — the legacy log case, the legacy step-classification case, and `the failure classifier is closed-set and never reads 'message'` | The "never reads `message`" invariant is enforced by a poisoned error whose `message` getter throws, so a classifier that starts reading free text dies at the source as well as at both call sites. |

**Scope correction carried into the design note (§4).** "The log carries no credential" is a claim about
these log lines and nothing else. `lastError` still reaches the step's operator-facing `error`
(`Webhook failed after N attempts: …`, pre-existing and asserted by two other specs), and that string is
persisted through `redactValue`, which has the documented userinfo blind spot — as does `rule_snapshot`,
which stores `config.url` verbatim on every run. The credentialed URL is therefore still recoverable from
`meta_automation_executions`; that persistence face is pre-existing, is **not** closed by this PR, and
closing it means changing the shared redactor (four channels + a web mirror).

**Also observed, not changed** (reported rather than fixed, because the fix would *loosen* a safety
property): on the two-phase path a request-construction `TypeError` is classified `outcome_unknown`
("the send may have happened") by `classifyOutboundResult`, although nothing was built, let alone sent.
That is conservative in the safe direction — it blocks an automatic resend — so it is left alone.

## 4. Existing tests that had to change, and why

Wiring a DNS-resolving gate into `send_webhook` made previously offline specs depend on live DNS. Two
different remedies, both chosen to keep unit tests deterministic **without** weakening the gate:

1. **Unit specs with a central deps factory** got `ssrfLookupFn` returning `203.0.113.10` (TEST-NET-3,
   RFC 5737 — documentation-only, not routable):
   `automation-v1.test.ts:108`, `automation-classb-outbound.test.ts:82`,
   `send-webhook-action-hardening.test.ts:30`.
   The seam supplies **addresses only**; `checkWebhookTargetUrl` still judges them, so a seam that
   returned an internal address would still be refused. It cannot disable the gate.
   Evidence this was necessary: before the stubs, `automation-classb-outbound` went **8 failed** with
   each case stalling ~11 s on a real resolver timeout for `example.test` (RFC 6761 guaranteed NXDOMAIN).
2. **Integration specs** construct `AutomationService` and have no deps seam, so their webhook targets
   moved from `https://example.test/…` to `https://203.0.113.10/…` — a public **IP literal**, which the
   guard accepts with **no DNS lookup at all**. 33 URLs across 5 files (`multitable-automation-jobs`,
   `multitable-automation-start-approval`, `-start-approval-http`, `multitable-automation-branch-local-wait`,
   `multitable-d1c-approval-revision-realdb`), including the assertions that compare captured URLs. Each
   file carries a header note explaining the choice.

**`fetchFn` stubbing, stated exactly** (the earlier "stubbed in all of them" was wrong, and wrong in a
security-evidence artifact, so here is the enumeration):

| File | Constructions | Status |
|---|---|---|
| `multitable-automation-jobs.test.ts` | 6 | 3 stubbed (`:126`, `:195`, `:240`); 3 bare (`:90`, `:385`, `:532`) — checked one by one: none of those three rules contains a `send_webhook` action, so no dispatch can occur |
| `multitable-automation-start-approval.test.ts` | 1 factory, 24 call sites | 4 were **bare** (`makeAutomationService()`) on rules that do carry a tail `send_webhook`. Fixed this round: the factory parameter now defaults to an OK stub (`:72-74`), so no call site can fall back to `globalThis.fetch` |
| `-start-approval-http.test.ts` | 1 factory, 2 call sites | both pass a stub (0 bare) |
| `branch-local-wait.test.ts` | 1 factory, 9 call sites | all pass `okFetch` / `failFetch` (0 bare) |
| `d1c-approval-revision-realdb.test.ts` | 1 factory | stub hard-coded inside it |

Why the 4 bare ones mattered even though the tail was unreachable: with the pre-change `example.test`
host a stray real `fetch` failed in milliseconds (RFC 6761 NXDOMAIN); with `203.0.113.10` it is a
black-hole address, so the same stray call becomes a per-attempt 5 s timeout (≈15 s with the default 2
retries) inside a real-DB lane, which reads like a slow database rather than an outbound call. The
default stub removes the possibility instead of relying on the tail staying unreachable.

**Changed this round**: `multitable-automation-jobs.test.ts:143` used to target
`http://127.0.0.1:1/blocked`. Under the gate that case went green for a **different reason** than the one
it documents — its subject is "a throwing `fetchFn` makes the action fail fast, and `onStart`/`onSettled`
still bracket it", and the gate refuses the URL before `fetchFn` is ever called, leaving the catch branch
in the executor's retry loop (`automation-executor.ts:4274-4276`) with no coverage anywhere in the suite.
(The earlier claim here that this was "strictly more deterministic" told only half of it.) It is now
`https://203.0.113.10/blocked`, so the throwing stub is the failure source again, and the gate's own
real-DB coverage lives in a **separate** case (`:193`) that asserts `WEBHOOK_TARGET_REJECTED:` **and**
that the throwing `fetchFn` was never entered (`fetchCalls === 0`).

**Not runnable locally**: the 5 integration files need real PostgreSQL; three of them
(`-start-approval-http`, `branch-local-wait`, `d1c-approval-revision-realdb`) are in the vitest
`exclude` list and are wired as whole files into `plugin-tests.yml` real-DB lanes. Their URL rewrite is
verified by inspection + type-check here, and by those CI lanes on the PR.

## 5. Full-suite number

`pnpm --filter @metasheet/core-backend exec vitest run` → exit **1**:
**29 files failed / 847 passed / 175 skipped (1051)**; tests **60 failed / 12797 passed / 1572 skipped
(14429)**, 195.7 s.

Re-run unchanged after the review round: the same **29** files, and the failing set contains none of the
files this PR touches. Grepping the whole run output for `automation-send-webhook-ssrf`,
`webhook-refusal-class` and `automation-executor.ts` returns hits only inside the passing
`automation-send-webhook-ssrf` / `automation-v1` output, never inside a `FAIL` block.

Known local-only noise on this Windows box; CI is the judge. That claim was **checked, not assumed** —
the four failures that could plausibly have been caused by this change were re-run and read:

| Spec | Actual failure | Mine? |
|---|---|---|
| `workflow-approval-automation-convergence.guard` | offending list is `routes\workflow-designer.ts`, `routes\workflow.ts`, 4 × `workflow\__tests__\BPMNWorkflowEngine.*` — **backslash** paths vs a forward-slash allowlist | No |
| `multitable-cross-base-link-wall-guard` | seams in `routes/univer-meta.ts`, `multitable/provisioning.ts` | No |
| `multitable-oapi-allowlist-guard-tripwire` | `expected 0 to be greater than 50` — the source scan found nothing at all | No |
| `runtime-dependency-classification` | eager-import-site scan + a stale `@opentelemetry/api` exemption at `src/core/logger.ts` | No |

A grep of those specs' failure output for `webhook-refusal-class` / `automation-send-webhook-ssrf` /
`automation-executor` returns **0** matches. The remaining 25 failures are census / enum-mirror /
attendance-plugin-dist / e-learning / spike specs that scan the repo or need plugin build output. The 8
affected specs are green in isolation (§1, command 3), and the pre-change baseline of that set was
likewise green.

## 6. Pin check

No re-pin needed. Nothing under `plugins/` was touched, `plugin-tests.yml` was not modified, and a
repo-wide search shows no `.json` / `.yml` / `.txt` manifest referencing `automation-executor.ts` or
`webhook-ssrf-guard.ts`. The three integration specs named in `plugin-tests.yml` are wired **by path**;
the pin is on that workflow file's own bytes, which are unchanged.

## 7. Residual risk, stated plainly

- **DNS rebinding is not closed on this path.** The gate resolves once, **outside** the legacy retry
  loop, and each attempt then resolves again — up to `retries + 1` = 3 times on the legacy path, once on
  the two-phase path — with none of those connections pinned to the addresses the gate judged
  (`ssrf.addresses` is computed and dropped). "A narrow window" understated the legacy path; this is the
  precise shape. The button route avoids it with `pinnedHttpsFetch`; adopting that here changes the
  response contract and the retry/two-phase structure and is deliberately out of scope (design §6, F-1).
  No rebinding claim is made.
- **Redirects are now refused, not followed** (design §2.1) — that is the one item of this list the
  review round moved from "undeclared" to "closed". What is closed is *following*: the first hop is still
  dispatched, so a rule aimed at an attacker-controlled public host still reaches that host with the
  configured headers. That was always true of any allowed target and is not what the gate is for.
- **`ruleSnapshot` still carries the raw rule config.** `redactValue` **is** applied at persist time
  (`automation-log-service.ts:102`, `:274`) and it masks `headers.authorization` / `secret` / other
  `STRUCTURED_FIELDS` **keys** — but `url` is not such a key, and the string rules behind it have no
  generic userinfo rule and no generic `token=` rule, so a URL of the form
  `https://<user>:<pw>@host/x?token=…` is persisted essentially as written (`access_token=` and the
  DingTalk robot form are the exceptions). Measured against the real function; the full table is in
  design §4. Pre-existing, populated on every run, unchanged by this PR, and deliberately **not** fixed
  here (F-2 — the redactor is shared by four channels, mirrored in `apps/web`, and a generic URL rule
  would overturn `tests/unit/multitable-automation-log-redact.test.ts:130`). The earlier wording here
  ("redacted by `redactValue` at persist time") implied a coverage that does not exist and is corrected
  rather than defended.
- **A second, still-ungated egress out of the same EventBus**: `webhook-service.ts:394` (subscription
  delivery) neither runs the guard nor sets `redirect`. Different config surface, different retry model
  — a sibling slice, listed as F-3, not silently in scope here.
- **https-only is a live behaviour change** for any existing rule using an `http://` webhook: it now
  fails with `WEBHOOK_TARGET_REJECTED:scheme-not-allowed`. Same for a receiver that answers 3xx
  (`:redirect-not-allowed`). Both go in the release note, and the owner runs the read-only inventory in
  design §7 **before** merge — that query needs a real database and was not run from this worktree.
- **No author-side check and no i18n label yet** (F-7): both changes surface only at run time, as a coded
  step error. `apps/web/src/services/integration/errorCodeLabels.ts` was deliberately left alone because
  two other open PRs are editing it.
