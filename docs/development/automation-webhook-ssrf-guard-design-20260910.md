# Automation `send_webhook` SSRF gate — design (G05 / #5615 刀 0)

**Date**: 2026-09-10 · **Branch**: `fix/automation-webhook-ssrf-guard` · **Scope**: `@metasheet/core-backend`

## 1. Why now

The repository already owns a complete egress guard —
`packages/core-backend/src/multitable/webhook-ssrf-guard.ts` (`checkWebhookTargetUrl:89`, with
`isInternalIpv4:26` / `isInternalIpv6:43` / `isInternalAddress:73` and resolve-then-pin). Before this
change it had **exactly one** non-test caller: `packages/core-backend/src/routes/multitable-button.ts:358`,
the button-field egress route.

The automation **rule** path did not use it. `AutomationExecutor.executeSendWebhook` read `config.url`
out of the rule's stored JSON, attached `config.headers` verbatim, and called `fetch` — on both of its
dispatch paths (the legacy in-call retry loop, and the #4196 class-B two-phase path).

Stated precisely, because the honest framing matters:

- The write fence was **not** bypassed. The run route's C6 multi-table write lifecycle gate is still in
  force; this is not a "rules can write anything" hole.
- The real exposure is **credential exposure + unattributable trigger**. A long-lived
  `Authorization: Bearer …` sits in cleartext inside `automation_rules`' JSON, so anyone who can edit a
  rule can borrow it; run records only say `by api`. An ungated `fetch` turns that into a
  request-forgery primitive aimed at whatever the server can reach: loopback admin ports, RFC1918
  services, `169.254.169.254`.
- "The benchmark is stricter" is **not** the argument. Feishu aPaaS itself permits permanent bearer
  tokens and does not restrict target IPs. The argument is our own internal reachable surface.

The trigger-port design (#5615) names this "刀 0": a hard prerequisite that must land before any inbound
trigger port is opened. This PR is only 刀 0.

## 2. What changed

| # | File | What |
|---|---|---|
| 1 | `src/multitable/webhook-refusal-class.ts` (new) | Values-free classification of a refusal. Decides nothing. |
| 2 | `src/multitable/automation-executor.ts:4134-4192` | The gate, inside `executeSendWebhook`. |
| 3 | `src/multitable/automation-executor.ts:4243-4262` (legacy loop) and `:4393-4423` (two-phase) | `redirect: 'manual'` on both dispatch sites; a 3xx is a terminal refusal (§2.1). |
| 4 | `src/multitable/automation-executor.ts:4294-4301`, `:4446-4451` | The two post-dispatch log lines, made values-free (§4). |
| 5 | `src/multitable/automation-executor.ts:1537-1543` | `AutomationDeps.ssrfLookupFn` — a DNS **resolver** seam. |

The gate sits immediately after the "URL is required" check and **before** everything else. That
placement is load-bearing three ways:

1. **Before header/HMAC assembly** — a refused target never gets a signature computed over the body, and
   the caller-supplied `Authorization` / `Cookie` headers are never even materialised.
2. **Before `classBOutboundIdentity` / `executeSendWebhookTwoPhase`** — so one call gates *both* dispatch
   paths, and a refusal consumes **no** outbound-intent claim (Tx A never runs). Burning an at-most-once
   claim on a refusal would make a later, legitimately re-pointed rule run short-circuit as "already
   attempted". This mirrors the button route, which refuses before its dedup transaction
   (`multitable-button.ts:357`).
3. **Before any `fetchFn` call** — refusal means the request is never made. This is the whole
   "strip Authorization aimed at localhost" property: we do not scrub the header, we never dispatch the
   request that would carry it. Placement alone is not sufficient, though: it decides only what the FIRST
   request is, so it is paired with §2.1 (the dispatch must stop at the URL that was judged).

On refusal the step result is `status:'failed'`,
`error: "WEBHOOK_TARGET_REJECTED:<class>"`, and
`output: { code, refusalClass, hostFamily, dispatched:false }`. Refusal is terminal for that attempt: no
retry-loop re-attempt, no fallback.

### 2.1 Redirects are not followed (the gate judges one URL, so the dispatch must stop at it)

The gate validates `config.url`. It is only a boundary if the request stops there — and `fetch`'s default
is `redirect: 'follow'` (measured on this repo's runtime: Node v25.9.0,
`new Request('https://e.com/').redirect === 'follow'`; a loopback repro confirmed the second hop is
reached, and that `redirect: 'manual'` resolves with the 3xx itself — `status 307, ok false,
type 'basic'` — and issues no second request).

Under the default, a rule pointed at an attacker-controlled **public** host is admitted by the gate, and a
single `307` then replays the same method, the same body, the caller-supplied headers and the
`X-Webhook-Signature` / `X-Webhook-Timestamp` headers this code computes at a `Location` the gate never
saw. Cross-origin the platform strips `Authorization` / `Cookie` / `Proxy-Authorization`, but not headers
the rule author chose the name of. A `Location: http://…` would be followed as well (the fetch standard
has no scheme-downgrade guard), which would take https-only with it — that sub-claim is read off the
standard and was **not** measured here; the loopback repro below was http→http, and nothing in the fix
depends on it. What is measured is enough on its own: this is not a narrow race, it is deterministic and
repeatable by anyone who can edit a rule — the adversary this gate exists for.

So both dispatch sites pass **`redirect: 'manual'`**, and a 3xx is a **terminal** refusal:

- step result `status:'failed'`, `error: "WEBHOOK_TARGET_REJECTED:redirect-not-allowed"`,
  `output: { code, refusalClass:'redirect-not-allowed', hostFamily, dispatched:true }`.
  `dispatched:true` is the honest difference from a pre-dispatch refusal: the **first** hop did go out —
  the gate allowed that URL. What is refused is the hop the `Location` asks for.
- No retry. Re-sending the same body to the same first hop only earns the same 3xx.
- The `Location` is never read, logged, followed or echoed. It is a value chosen by whoever answered,
  and it is the one input the gate never judged.
- On the two-phase path the refusal happens **after** Tx B, so the intent row is never left `pending`
  and nothing is auto-resent (`classifyOutboundResult` already treats a non-2xx as the ambiguous
  outcome — the first hop did receive the body). Only the step label changes.
- No new switch: `redirect-not-allowed` is a new member of the existing closed
  `WebhookRefusalClass` union (`webhook-refusal-class.ts:64`), and it is the ONLY member decided from a
  response rather than from a URL — `classifyWebhookRefusal` never returns it; the dispatch sites set it
  via `isRefusedRedirectStatus` (`:86`).

This is the posture the other two egress paths in this repo already have, and which this PR's first
revision did not: the button route dispatches through `webhook-pinned-fetch.ts:51-63` (`https.request`,
which does not follow), and `guards/egress-dispatcher.ts:201` follows **manually**, re-validating and
re-pinning every hop and returning `REDIRECT_LIMIT_EXCEEDED`. Manual following is strictly more work than
this path needs today, so it refuses instead.

**Behaviour change**: a rule whose receiver answers 3xx (e.g. an endpoint that moved and relies on a
redirect) now fails with `redirect-not-allowed` instead of silently delivering to the redirect target.
The fix is to point the rule at the final URL. Called out in the release note alongside https-only (§7).

### Error code choice

The code is **`WEBHOOK_TARGET_REJECTED`**, not a new `…_REFUSED` synonym. The button route already
returns exactly that literal for exactly this decision (`multitable-button.ts:363`), so one alert query
now covers both egress paths. Inventing a second name for the same event would split the signal.

## 3. Refusal classification table

The guard's own rejection `reason` strings are **not** values-free by construction (the scheme variant
embeds `parsed.protocol`), so the executor never logs them. It logs the closed-set label instead.

| `refusalClass` | Trigger | `hostFamily` |
|---|---|---|
| `loopback` | `127.0.0.0/8`, `::1`, `localhost` / `*.localhost` | `ipv4` / `ipv6` / `name` |
| `private` | RFC1918 `10/8`, `172.16/12`, `192.168/16` | `ipv4` |
| `link-local` | `169.254/16` (incl. cloud metadata), IPv6 `fe80::/10` | `ipv4` / `ipv6` |
| `unique-local` | IPv6 `fc00::/7` | `ipv6` |
| `unspecified` | `0.0.0.0/8` "this host", IPv6 `::` | `ipv4` / `ipv6` |
| `internal-name` | `*.internal`, `*.local` | `name` |
| `dns-resolved-internal` | public-looking name, DNS returned ≥1 internal address | `name` |
| `dns-unresolved` | name did not resolve / empty record set (fail-closed) | `name` |
| `scheme-not-allowed` | parsed, but not `https:` | any |
| `invalid-url` | missing / non-string / unparseable | `none` |
| `internal-other` | refused for a reason the classifier cannot label | any |
| `redirect-not-allowed` | the first hop answered 3xx under `redirect:'manual'` (§2.1) — the only **post-dispatch** member, and the only one not produced by `classifyWebhookRefusal` | shape of the **original** URL |

An IPv4-mapped IPv6 literal (`::ffff:127.0.0.1`, which Node normalises to `::ffff:7f00:1`) is unwrapped
to the embedded v4 shape, and `hostFamily` records `ipv4-mapped-ipv6` so the smuggling attempt is visible.

Precedence: an internal **host shape** beats the reason, so `http://127.0.0.1` reports `loopback` (the
operator-actionable fact) rather than `scheme-not-allowed`, even though the guard refuses it at the
scheme check.

## 4. Values-free constraint

A webhook URL is both attacker-influenced and credential-bearing
(`https://user:pw@host:8443/path?token=…`), and `config.headers` carries the bearer token. So:

- `WebhookRefusal` has **no free-text field by construction** — every member of every field is a closed
  union, so a caller cannot smuggle a value through it.
- The refusal log line `[automation.send_webhook.refused]` carries `code`, `refusalClass`, `hostFamily`,
  `sheetId`, `ruleId` and `executionId`. The last three are **identifiers**, not values — the same class
  of field the sibling button route logs (`routes/multitable-button.ts:311-314` logs
  `executionId`+`sheetId`+`recordId`+`fieldId`+`actorId`). `sheetId` alone only narrows an alert to a
  sheet, which can carry many rules, so it did not make good on this section's own promise that "the
  offending rule is findable"; `ruleId`/`executionId` were already on the `ExecutionContext`
  (`automation-executor.ts:1412-1416`).
- The two **post-dispatch** lines on the ALLOWED path are values-free too, as of this round:
  `[automation.send_webhook.failed]` (`:4294`) and `[automation.send_webhook.outcome_unknown]` (`:4446`)
  carry `hostFamily` + attempt count / bounded reason class + identifiers. They previously read
  `send_webhook to ${redactString(url)} …`, which is **not** the same thing — see the redactor's real
  coverage below. These lines fire on every failed delivery, i.e. exactly where the gate has already
  said yes, so they were the largest remaining URL-bearing surface owned by this function.
- Never logged / never persisted by this path: the URL, the host, the port, the path, the query, any
  header value, the HMAC secret, the `Location` of a refused redirect, and the guard's raw `reason`.

**Scoped honestly** — the execution object also carries `ruleSnapshot`, i.e. the rule exactly as
supplied, so the raw `config.url` / `config.headers` are in *there*. That carrier is pre-existing and is
populated on **every** run whether refused or not. `redactValue` **is** applied to it at persist time
(`automation-log-service.ts:102`, `:274` → `rule_snapshot`), but its coverage is narrower than the name
suggests, and the earlier wording here ("is scrubbed by `redactValue`") over-promised for exactly the URL
shape this section uses as its own example. Measured by running the real function on that shape:

| Input | `redactValue` output |
|---|---|
| `config.headers.Authorization`, `config.secret` | `<redacted>` (key match, `automation-log-redact.ts:121-143` + `:146-148`) |
| a header whose NAME is not in that set (e.g. a vendor-specific token header) | **unchanged** |
| `config.url = https://<user>:<pw>@host/x?token=…` | **unchanged** — `url` is not a `STRUCTURED_FIELDS` member (`webhookurl` is; `send_webhook` uses `url`), so it falls to `redactString` (`:164`), and `STRING_PATTERNS` (`:30-61`) has no generic userinfo rule (userinfo stripping is scoped to `postgres`/`mysql` URLs, `:28`, `:63-77`) and no generic `token=` / `api_key=` / `sig=` rule |
| `config.url = …?access_token=…` | `access_token=<redacted>` (`:36`) |
| a DingTalk robot webhook URL | fully masked (`:33`) |

So: credential-bearing URLs in `rule_snapshot` are a real, **pre-existing** persistence surface that this
PR neither introduces, widens, nor closes. Fixing it means a generic URL rule in the shared redactor —
which four channels and a web-app mirror depend on, and which would overturn the standing assertion at
`tests/unit/multitable-automation-log-redact.test.ts:130` (it requires the URL to survive with only the
token masked). That is a change with its own design, not a rider on this one; see §6.

## 5. Allowlist / escape hatch: deliberately none

**Finding, with evidence**: the button-field egress path has **no** env allowlist, no bypass flag, and no
internal-target escape hatch. `multitable-button.ts:358` calls `checkWebhookTargetUrl(url)` with no
override argument and returns a hard `400` on rejection. A repo-wide search for
`ALLOW_INTERNAL|WEBHOOK_ALLOW|SSRF_ALLOW|ALLOWLIST|allowInternal` finds only
`INTEGRATION_CORE_OUTBOUND_SQL_WRITE_TARGETS` (`.env.example:311-343`), which gates **plugin SQL writes**
to named targets — a different subsystem, a different threat, and not a webhook egress control.

Per the brief: since the existing path has no such switch, this PR **does not invent one**. On both
egress paths an internal target is refused with no override and no allowlist, and neither path will
follow a redirect to one (§2.1). What is still NOT claimed on the rule path is address pinning — see §6
and the residual-risk section of the verification note.

**A deployment that genuinely must reach an internal receiver** therefore does not get a product flag.
The existing route is: publish the receiver on an https endpoint the server resolves to a public address
(reverse proxy / ingress), and point the rule at that. This keeps the decision at the network boundary
where it is auditable, instead of inside a rule row any rule editor can change. If a first-party
internal-target capability is ever wanted, it is a design-lock of its own (who may create such a rule,
where the allowlist lives, how it is reviewed) — not a flag added in a hardening PR.

## 6. What this PR deliberately does NOT do

- **No `run_integration_pipeline` action, no `triggeredBy` attribution work, no run-route changes.**
  Those are 刀 1–刀 5 of #5615.
- **No resolve-then-pin on this path.** The button route connects to the pinned address via
  `pinnedHttpsFetch`; the executor still calls `fetchFn(url, …)`, which re-resolves, and the guard's
  `ssrf.addresses` (the addresses it actually judged) are computed and then dropped. Stated precisely
  rather than as "a narrow window": the gate resolves once, **outside** the retry loop, and then **each
  attempt resolves again** — up to `retries + 1` = 3 times on the legacy path (`DEFAULT_MAX_WEBHOOK_RETRIES`
  = 2, `automation-executor.ts:143`, overridable per-deployment by `AUTOMATION_WEBHOOK_MAX_RETRIES`, `:164-169`, backoff 100/200 ms), once on the two-phase path (at-most-once). None
  of those connections is pinned to what the gate judged. Closing it means replacing the injectable
  `fetchFn` with the pinned-`https.request` helper, which changes the response contract and the
  retry/two-phase structure — a separate change (F-1). **This PR does not claim rebinding protection on
  the rule path.**
- **No change to the dry-run/simulate plan** (`simulatedGenericClassBPlan`, executor `:929`). It performs
  no egress, so it is not an SSRF surface; it still reports a plan for a target that will be refused at
  run time.
- **No `ruleSnapshot` redaction change** (see §4). Pre-existing, out of scope, reported separately.
- **No `plugins/` and no `apps/web` changes.** No new env var, so `.env.example` is untouched. In
  particular `apps/web/src/services/integration/errorCodeLabels.ts` is deliberately NOT touched (two
  other open PRs own that file); `WEBHOOK_TARGET_REJECTED:*` therefore surfaces untranslated in the run
  log for now — follow-up below.
- **No manual redirect FOLLOWING.** §2.1 refuses a 3xx rather than re-validating each hop the way
  `guards/egress-dispatcher.ts:184-230` does. Refusing is the conservative side of that choice and needs
  no hop budget; adopting the dispatcher is a separate change.
- **Nothing about `webhook-service.ts`.** Its subscription delivery (`webhook-service.ts:394`,
  `this.fetchFn(wh.url, …)`) is a **second** egress out of the same EventBus and is still ungated and
  still redirect-following. It has a different config surface (a `webhooks` table, not rule JSON) and a
  different retry/backoff model, so it is a sibling slice, not a rider.

### Follow-ups this round deliberately leaves open (each already has evidence in the review record)

| # | Item | Why not here |
|---|---|---|
| F-1 | resolve-then-pin on this path (`pinnedHttpsFetch` / `runPinnedEgress`) | Changes the response contract, kills the legacy retry loop, and punches through the `deps.fetchFn` seam nine test files use. See the bullet above. |
| F-2 | Generic URL rule in `redactValue` + the `apps/web` mirror + spec update | Shared by four channels; overturns a standing assertion (§4). |
| F-3 | Gate `webhook-service.ts:394` (subscription delivery) and give it the same redirect posture | Different config surface and retry model. |
| F-4 | DNS-resolution timeout / `AbortController` around the gate's lookup | The gate adds a resolve to the dispatch path; a hung resolver is a latency bug, not a containment bug. |
| F-5 | Separate the "resolver flapped" signal from the real SSRF refusal (today both surface as `dns-unresolved`) | Needs an alerting decision, not a code decision. |
| F-6 | Two-phase ordering: the gate runs before the `skip_sent` short-circuit, so a re-play of an already-sent intent is re-judged | Flag is default OFF; affects replay noise only. |
| F-7 | Author-side rejection + i18n label for `WEBHOOK_TARGET_REJECTED:*` (rule editor should refuse an internal/`http://` URL at save time) | Needs `apps/web` changes, which this PR has none of. |

## 7. Behaviour changes to flag for review

**(a) https-only.** A rule configured with an `http://` webhook that used to be delivered is now refused
with `scheme-not-allowed`. This matches the button path (`routes/multitable-button.ts:358`) and is the
correct posture — cleartext to an internal host is the exact vector, and this path deliberately does not
pin, so allowing http-to-public would re-open the branch that is easiest to rebind. It is kept, and it is
a live-behaviour change, not a pure tightening of an unreachable case.

**(b) 3xx no longer delivers** (§2.1). A rule whose receiver answers a redirect now fails with
`redirect-not-allowed` instead of following it.

Both belong in the release note. Neither has an author-side check yet (F-7), so today they surface only
at run time, as a coded step error.

### Pre-merge step for the owner (needs a real database — not runnable from this worktree)

Inventory the existing rules that change behaviour, read-only, and put the counts in the release note.
Run against the target database as a read-only role:

```sql
-- rules whose action JSON carries an http:// webhook target (these start failing: scheme-not-allowed)
SELECT count(*) AS http_rules
  FROM automation_rules
 WHERE actions::text ILIKE '%"url":"http://%';

-- same, broken out per sheet so the owner can warn the right teams (identifiers only, no URLs)
SELECT sheet_id, count(*) AS http_rules
  FROM automation_rules
 WHERE actions::text ILIKE '%"url":"http://%'
 GROUP BY sheet_id
 ORDER BY http_rules DESC;

-- rules aimed at an obviously internal literal (these were already being attempted before this PR)
SELECT count(*) AS internal_rules
  FROM automation_rules
 WHERE actions::text ~* '"url":"https?://(127\.|10\.|192\.168\.|169\.254\.|localhost)';
```

Deliberately no `SELECT actions` — the URLs carry credentials (§4). Counts and sheet ids are enough to
decide, and they are identifiers, not values. There is no equivalent inventory for (b): whether a
receiver answers 3xx is not visible from the stored config.
