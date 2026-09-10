# Automation `send_webhook` SSRF gate — verification (G05 / #5615 刀 0)

**Date**: 2026-09-10 · **Branch**: `fix/automation-webhook-ssrf-guard` (base `origin/main` @ `11dddc18b`)
· Design: `automation-webhook-ssrf-guard-design-20260910.md`

## 1. Commands and exit codes

All run from the worktree root, `pnpm 9.15.9` / `vitest 1.6.1` / Node 20.

| # | Command | Result |
|---|---|---|
| 0 | `pnpm install --frozen-lockfile --offline` | exit **0** (1m 10s) |
| 1 | `pnpm --filter @metasheet/core-backend run type-check` | exit **0** (`tsc --noEmit`) |
| 2 | `… exec vitest run tests/unit/automation-send-webhook-ssrf.test.ts` | exit **0** — **37 passed / 37** |
| 3 | `… exec vitest run` over the 8 affected specs (below) | exit **0** — **392 passed / 392**, 8 files |
| 4 | Full `… exec vitest run` (core-backend) | see §5 — pre-existing local noise, CI is the judge |

Command 3's file set: `automation-send-webhook-ssrf`, `send-webhook-action-hardening`,
`automation-classb-outbound`, `automation-v1`, `webhook-ssrf-guard`, `multitable-button-routes`,
`multitable-automation-log-redact`, `webhook-pinned-fetch`.

**Pre-change baseline** for comparison: the same set minus the new spec (6 files) was **348 passed**,
exit 0, before any edit — so nothing that was green went red.

## 2. Coverage map of the new spec

`packages/core-backend/tests/unit/automation-send-webhook-ssrf.test.ts` — 37 tests. Every refusal test
asserts `expect(fetch).toHaveBeenCalledTimes(0)` via the shared `expectRefused` helper, alongside the
step status, the coded error and the values-free class.

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

Two assertions carry the security weight and are named explicitly for review:

- `refuses the IPv4 loopback literal 127.0.0.1 and never calls fetch`
- `refuses an internal target BEFORE Tx A: no intent row claimed, no fetch`

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
   file carries a header note explaining the choice. `fetchFn` is stubbed in all of them, so no packet is
   ever sent.

Not changed: `multitable-automation-jobs.test.ts:130` deliberately targets `http://127.0.0.1:1/blocked`
and asserts the step **fails**. It still fails — now at the gate (`loopback`) instead of at connect —
so the assertion holds and the case became strictly more deterministic.

**Not runnable locally**: the 5 integration files need real PostgreSQL; three of them
(`-start-approval-http`, `branch-local-wait`, `d1c-approval-revision-realdb`) are in the vitest
`exclude` list and are wired as whole files into `plugin-tests.yml` real-DB lanes. Their URL rewrite is
verified by inspection + type-check here, and by those CI lanes on the PR.

## 5. Full-suite number

`pnpm --filter @metasheet/core-backend exec vitest run` → exit **1**:
**29 files failed / 847 passed / 175 skipped (1051)**.

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

- **DNS rebinding is not closed on this path.** The gate validates, then `fetchFn(url, …)` re-resolves.
  The button route avoids this with `pinnedHttpsFetch`; adopting it here changes the response contract
  and the retry/two-phase structure and is deliberately out of scope. No rebinding claim is made.
- **`ruleSnapshot` still carries the raw rule config** in the in-memory execution object (redacted by
  `redactValue` at persist time). Pre-existing, populated on every run, unchanged here — and the spec's
  values-free test is scoped accordingly rather than making a blanket "nothing leaks" claim.
- **https-only is a live behaviour change** for any existing rule using an `http://` webhook: it now
  fails with `WEBHOOK_TARGET_REJECTED:scheme-not-allowed`. Flag in the release note.
