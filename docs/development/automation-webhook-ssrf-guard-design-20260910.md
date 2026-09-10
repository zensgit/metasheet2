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
| 2 | `src/multitable/automation-executor.ts:4128-4173` | The gate, inside `executeSendWebhook`. |
| 3 | `src/multitable/automation-executor.ts:1530-1537` | `AutomationDeps.ssrfLookupFn` — a DNS **resolver** seam. |

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
   request that would carry it.

On refusal the step result is `status:'failed'`,
`error: "WEBHOOK_TARGET_REJECTED:<class>"`, and
`output: { code, refusalClass, hostFamily, dispatched:false }`. Refusal is terminal for that attempt: no
retry-loop re-attempt, no fallback.

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
- The refusal log line `[automation.send_webhook.refused]` carries `code`, `refusalClass`, `hostFamily`
  and `sheetId`. `sheetId` is an identifier (so the offending rule is findable), not a value; it is the
  same class of field the sibling button route already logs.
- Never logged / never persisted by this path: the URL, the host, the port, the path, the query, any
  header value, the HMAC secret, and the guard's raw `reason`.

**Scoped honestly** — the execution object also carries `ruleSnapshot`, i.e. the rule exactly as
supplied, so the raw `config.url` / `config.headers` are in *there*. That carrier is pre-existing, is
populated on **every** run whether refused or not, and is scrubbed by `redactValue` at persist time
(`automation-log-service.ts` → `rule_snapshot`). This change neither introduces nor fixes it; see §6.

## 5. Allowlist / escape hatch: deliberately none

**Finding, with evidence**: the button-field egress path has **no** env allowlist, no bypass flag, and no
internal-target escape hatch. `multitable-button.ts:358` calls `checkWebhookTargetUrl(url)` with no
override argument and returns a hard `400` on rejection. A repo-wide search for
`ALLOW_INTERNAL|WEBHOOK_ALLOW|SSRF_ALLOW|ALLOWLIST|allowInternal` finds only
`INTEGRATION_CORE_OUTBOUND_SQL_WRITE_TARGETS` (`.env.example:311-343`), which gates **plugin SQL writes**
to named targets — a different subsystem, a different threat, and not a webhook egress control.

Per the brief: since the existing path has no such switch, this PR **does not invent one**. Both egress
paths now refuse internal targets unconditionally.

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
  `pinnedHttpsFetch`; the executor still calls `fetchFn(url, …)`, which re-resolves. So a DNS-rebinding
  attacker retains a narrow check-to-use window here. Closing it means replacing the injectable
  `fetchFn` with the pinned-`https.request` helper, which changes the response contract and the
  retry/two-phase structure — a separate change. **This PR does not claim rebinding protection on the
  rule path.**
- **No change to the dry-run/simulate plan** (`simulatedGenericClassBPlan`, executor `:929`). It performs
  no egress, so it is not an SSRF surface; it still reports a plan for a target that will be refused at
  run time.
- **No `ruleSnapshot` redaction change** (see §4). Pre-existing, out of scope, reported separately.
- **No `plugins/` and no `apps/web` changes.** No new env var, so `.env.example` is untouched.

## 7. Behaviour change to flag for review

The guard is **https-only**. A rule configured with an `http://` webhook that used to be delivered will
now be refused with `scheme-not-allowed`. This matches the button path and is the correct posture (plain
http to an internal host is the exact vector), but it is a live-behaviour change, not a pure tightening
of an unreachable case. It should be called out in the release note.
