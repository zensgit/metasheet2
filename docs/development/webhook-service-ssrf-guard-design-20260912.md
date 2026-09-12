# Webhook SUBSCRIPTION delivery — SSRF gate + redirect posture (F-3 of the #5619 security review)

Branch: `fix/webhook-service-ssrf-guard` (stacked on `fix/automation-webhook-ssrf-guard` @ `d096f4039`).
Written 2026-09-11 18:58 +0800; the filename carries this wave's `20260912` stamp, as the two #5619
documents do for theirs.

Scope: `packages/core-backend/src/multitable/webhook-service.ts` only. No route, schema, migration,
redactor (`automation-log-redact.ts`), i18n (`errorCodeLabels.ts`) or pinned file is touched.

---

## 1. Why now — the third egress out of the same EventBus, with the widest write surface

#5619 gated the rule-driven `send_webhook` action and registered what it could not reach in the same
pass:

> **F-3** | Gate `webhook-service.ts:394` (subscription delivery) and give it the same redirect posture
> | Different config surface and retry model.
> (`docs/development/automation-webhook-ssrf-guard-design-20260910.md:276`)

That line was the only un-gated `fetch` left on this bus. Three egress paths now exist; before this
change the third one was bare:

| egress | target comes from | who can write it | gate before this PR |
|---|---|---|---|
| button field (`routes/multitable-button.ts:358`) | field config | sheet editor | `checkWebhookTargetUrl` + `pinnedHttpsFetch` (B1-S2 / #2897) |
| automation rule (`automation-executor.ts:4166`) | `automation_rules.actions[].config.url` | rule editor | `checkWebhookTargetUrl` (#5619) |
| **subscription (`webhook-service.ts`)** | `multitable_webhooks.url` | **any authenticated user** | **none** |

The write surface is the point. `POST /api/multitable/webhooks` is behind `authenticate` and nothing
else — no permission code, no RBAC guard, no api-token scope check on those three paths
(`routes/api-tokens.ts:228-230`; POST handler `:320`, `createWebhook` call `:328`, PATCH `:348`). `createWebhook` only rejects a non-https URL
**when `NODE_ENV === 'production'`** (`webhook-service.ts:192-200`), and `updateWebhook` has **no scheme
check at all** — it accepts anything `new URL()` parses (`:286-293`). So a plain session holder could
register `https://169.254.169.254/latest/meta-data/...` (or PATCH an existing row to it) and have the
server POST every matching `record.created` / `record.updated` / `record.deleted` / `comment.created`
payload there — HMAC-signed with the subscriber's own secret, retried on a schedule by
`WebhookRetryScheduler`, and auto-resumed after a crash by the stray-recovery leg. Request forgery with
a delivery guarantee attached.

## 2. Outbound inventory — every point in this file that can emit a request

Read, not assumed. `webhook-service.ts` has exactly **one** outbound call site:

```
packages/core-backend/src/multitable/webhook-service.ts:512   await this.fetchFn(wh.url, { method: 'POST', ... })
```

(`grep -n "fetchFn"` over the file returns the field declaration :164, the constructor :174/:176, the
placement comment :423 and that one call. `:172` is the `ssrfLookupFn` field and is NOT one of those
hits — an earlier draft of this line listed it by mistake.) There is no separate "test delivery"
endpoint and no second retry client: both entry points funnel into the same method.

| entry point | caller | reaches |
|---|---|---|
| `deliverEvent()` fan-out | `webhook-event-bridge.ts:86` (EventBus bridge) and `automation-durable-consumer-handlers.ts:108` (durable outbox consumer) | `executeDelivery()` fire-and-forget per matching subscription (`:383`) |
| `retryFailedDeliveries()` tick | `services/WebhookRetryScheduler.ts:151` (60s interval, optional Redis leader lock) | `executeDelivery()` for every claimed `pending` row (`:731`) |

Both therefore pass through ONE gate. A row queued before this change is re-judged on its next attempt,
because the gate runs per attempt, inside `executeDelivery`, not at enqueue time.

Retry/dead-letter semantics as they already existed (unchanged by this PR): failure →
`handleDeliveryFailure` → exponential backoff (`computeBackoffMs`, per-webhook policy columns) while
`attempt_count < max_retries`, else `status='failed'`; `failure_count` on the webhook row increments and
at `WEBHOOK_MAX_CONSECUTIVE_FAILURES` (default 10) the subscription is set `active=false`. There is no
dead-letter table; a terminal row simply sits `failed` and is readable through
`GET /api/multitable/webhooks/:id/deliveries`.

## 3. What changed

### 3.1 The gate (`webhook-service.ts:408-487`)

`checkWebhookTargetUrl(wh.url, this.ssrfLookupFn)` runs inside `executeDelivery`, **after** the webhook
row is loaded and **before** anything else. Placement is load-bearing three ways, the same argument the
rule-driven path makes at `automation-executor.ts:4128`:

1. **Before the header/HMAC assembly** (`:492-504`): a refused target never has
   `WebhookService.signPayload` called over the body, so the subscriber's secret is not exercised
   against a target we refuse to speak to. The spec pins this with a `signPayload` spy, not just a
   `fetch` counter — a gate that sat *after* the header block would still pass a fetch-count assertion.
2. **Inside the single dispatch funnel**, so the fan-out and the retry tick are gated by one call.
3. **Before the only `fetchFn` call**, so refusal means the request is never made. Nothing is scrubbed;
   nothing is dispatched.

The resolver seam is the third constructor argument (`:166-178`), identical in shape and in wording to
`AutomationDeps.ssrfLookupFn`. Every production construction omits it (`routes/api-tokens.ts:26`,
`webhook-event-bridge.ts:79`, `services/WebhookRetryScheduler.ts:81`, `index.ts:3890`) and therefore
uses the real resolver. It is a RESOLVER seam only: `checkWebhookTargetUrl` still judges every address
returned, so a seam that answers with `169.254.169.254` is refused like any other (pinned by the "lying
resolver" test).

### 3.2 A refusal does NOT change the delivery lifecycle — only whether we send

A refused target is handed to the **existing** `handleDeliveryFailure`, with `attemptCount` incremented
so termination is guaranteed. Consequences, stated exactly:

- retries and backoff behave as they already did for an unreachable receiver; every retry re-enters the
  gate and still sends nothing, so re-attempting costs nothing in containment terms;
- a refusal counts toward `failure_count`, so a permanently refused subscription auto-disables after 10
  consecutive **attempts** — the same operator signal an unreachable endpoint produces today. Attempts,
  not events: `handleDeliveryFailure` does `wh.failureCount + 1` once per `executeDelivery` call
  (`:816`), and one event burns up to `max_retries` attempts, so at the default `max_retries = 3`
  (`webhooks.ts:28`) the tenth attempt — and the `active=false` write — lands on the 4th event: each of
  the first three events spends 3 attempts (a delivery terminates at `attemptCount >= maxRetries`), and
  the 4th event's FIRST attempt is the tenth. That assumes `failure_count` started at 0 and nothing
  succeeded in between; the event count is a function of the per-subscription retry policy, not a
  constant;
- a **transient** resolver failure (`dns-unresolved`) keeps today's retry behaviour instead of dropping
  the event. Before this change the same failure arrived as an `ENOTFOUND` transport error and was
  retried; making the refusal terminal would have silently converted a DNS blip into lost events.

**That bookkeeping is wrapped in its own `try`/`catch` (`:474-485`) — the availability consequence the
new branch had to pay for.** `handleDeliveryFailure` issues two UPDATEs, and this branch
runs BEFORE the dispatch `try`, so an exception would have left `executeDelivery` — which the retry tick
awaits per row with no guard of its own (`:731`) — and aborted the whole pass in `retryFailedDeliveries`.
Every row that pass already claimed has had `next_retry_at` leased forward (`:696`), so the batch would
sit undelivered until `RETRY_CLAIM_LEASE_MS` expires, and `services/WebhookRetryScheduler.ts:157` would
log the driver's raw `err.message`. Before this PR that shape existed only for `getWebhookById` (`:397`)
and the not-found UPDATE (`:399-404`); this branch would have made it routine, because a refused target
hits it on every attempt. The `catch` takes NO binding, so the error object is unreachable from that
scope and the line it emits is closed-set labels plus identifiers. Swallowing is safe here and only
here: the gate already refused, so neither the failed write nor the recovery dispatches anything; the
cost is the row keeping its previous state, to be re-judged by this same gate on the next tick. Making
`:731` itself per-row-guarded is the general fix and stays out of scope (existing code, separate change).

This is deliberately NOT a class-driven branch: `webhook-refusal-class.ts` states that a label must
never be able to change a delivery decision, and nothing here reads the label to decide anything. The
one policy difference below is read off the RESPONSE, not off a label.

### 3.3 Redirects are not followed (`:512-536`, `:623-654`)

The gate judges exactly one URL, so the dispatch has to stop at it. `redirect: 'manual'` is now passed
in the fetch init, and a 3xx is a **terminal** refusal
(`WEBHOOK_TARGET_REJECTED:redirect-not-allowed`, reusing #5619's literal), written by
`handleRefusedRedirect`: `status='failed'`, `next_retry_at=NULL`, no backoff row — **unless the terminal
write itself fails**. `handleRefusedRedirect` is called from inside the `try` at `:508`, so a DB blip on
that UPDATE is caught by the generic catch at `:568`, labelled `transport-error` like any other throw,
and handed to `handleDeliveryFailure`, which writes `status='pending'` + a backoff instead; the row is
then re-claimed and the same body re-sent to the same first hop, bounded by `max_retries`. Containment
is unaffected (the re-attempt re-enters the gate at `:432`, and the first hop is the URL the gate
already judged); what is wrong in that window is the LABEL and one extra egress per retry. Moving the
redirect decision out of the `try` is registered as FS-8.

Why terminal here when a target refusal is not: a retry of a refused **target** dispatches nothing,
while a retry after a 3xx re-sends the same body to the same first hop, which will answer 3xx again —
real repeated egress with no chance of success. The check runs **before** the response body is read, so
nothing from the redirect response — `Location` above all — is read, logged or persisted. The spec pins
that with `expect(headers.get).not.toHaveBeenCalled()`.

`failure_count` is deliberately not touched on this path: auto-disable is the flap counter for a
receiver that cannot be reached, and this receiver answered. The cost is stated in §6.

### 3.4 The failure log is a closed set (`:568-602`)

The old line was

```ts
logger.error(`Webhook delivery error for ${wh.id}: ${err instanceof Error ? err.message : String(err)}`)
```

— raw transport text, with no redactor on it at all. On this runtime the transport's own text **can be**
the credential: a subscription URL carrying userinfo makes the native client throw, while CONSTRUCTING
the Request (before any socket),

```
TypeError: Request cannot be constructed from a URL that includes credentials: https://svc:<pw>@host/x?token=…
```

and `createWebhook` accepts exactly such a URL, so this was reachable from the public route. It is now

```ts
logger.warn('[webhook.delivery.failed]', { failureClass, hostFamily, webhookId, deliveryId, attempts })
```

with `classifyWebhookFailure({ kind: 'error', error: err })` — #5619's classifier, which reads only
`name` / `code` / `cause.*` and never `message`. The level drops from `error` to `warn` because
`Logger.error(msg, err)` has no structured-meta parameter (`core/logger.ts:112`) and folds `err.message`
into the record — the very thing being removed. Nothing else about the failure path changes.

### 3.5 The persistence face — what an operator can still read

This table has **no `last_error` column** (`db/types.ts:1561-1576`) and this PR does not add one, so
there is no "keep `lastError` for the operator" option here in the shape #5619 had. Before the change a
transport failure persisted *nothing* about itself (and left `response_body` / `http_status` holding a
STALE value from an earlier attempt). After it:

| case | `http_status` | `response_body` |
|---|---|---|
| target refused | `NULL` | `WEBHOOK_TARGET_REJECTED:<refusalClass>` |
| 3xx refused | the real 3xx | `WEBHOOK_TARGET_REJECTED:redirect-not-allowed` |
| transport failure | `NULL` (stale value cleared) | `WEBHOOK_DELIVERY_FAILED:<failureClass>` |
| HTTP failure response | the real status | the RECEIVER's body, exactly as before |

Both markers are closed-set by construction: the suffix is a union member from
`webhook-refusal-class.ts`, never free text and never the URL. So the operator gains a reason without
the row gaining a value. `DELIVERY_FAILURE_MARKER` is defined locally (`:58-65`) rather than exported from
the shared module, because it is a storage marker for this table, not a refusal vocabulary.

## 4. Values-free contract, and its exact edges

Logged: `code`, `refusalClass` / `failureClass`, `hostFamily`, `webhookId`, `deliveryId`, `event` (a
fixed enum), `attempts`, and for a redirect the numeric status. All closed-set tokens or identifiers.

Not logged, anywhere on these paths: the URL, its host, its userinfo, its query, the subscription
secret, any header value, any response body, and the guard's own `reason` string (which is not
values-free by construction — the scheme variant embeds `parsed.protocol`).

Edges this PR does NOT close, so the claim is not wider than the code:

- `multitable_webhooks.url` and `.secret` are stored verbatim, as they always were, and
  `GET /api/multitable/webhooks` returns them to their creator. That is the subscription record itself,
  not a log, and changing it is a product decision, not a redaction fix.
- `deliverEvent`'s fire-and-forget catch (`:383-387`) still logs `err.message` for errors thrown by
  `executeDelivery` itself. After this change `executeDelivery` catches its own transport errors, so
  what can reach that line is a DB error — from `getWebhookById` (`:397`), from the not-found UPDATE
  (`:399-404`), or from the success / non-2xx bookkeeping inside the `try`. NOT from the refusal
  branch: that branch is new and runs BEFORE the `try`, so its bookkeeping is caught locally (§3.1).
  The free-text line itself is out of scope and left alone.
- `tests/integration/rc-regression.test.ts` contains a spec-local `InMemoryWebhookService`
  reimplementation (`:338`) that does NOT go through this gate. It is a test double, not product code,
  and it is deliberately left as-is so it keeps testing what it was written to test.

## 5. Allowlist / escape hatch: deliberately none

Neither sibling egress path has an env switch or an internal-target exemption, and this one does not
invent the first. A deployment that must reach an internal receiver exposes it through a reverse proxy
as an https public endpoint — the same answer as #5619 §5.

## 6. Behaviour changes to flag in the release note

**(a) https-only.** A subscription with an `http://` URL that used to be delivered now fails, and —
because refusals go through the existing ledger — auto-disables after 10 consecutive **attempts**
(`active=false`); at the default `max_retries = 3` that is about the 4th event, NOT the 10th (§3.2 —
`failure_count` advances once per attempt, and one event burns up to `max_retries` attempts). Same
posture as the other two egress paths.

Which label such a row gets depends on the HOST, not only on the scheme: `classifyWebhookRefusal`
decides host shape first (`webhook-refusal-class.ts:311-313` states the precedence, :327-340 returns
before the reason mapping at :346-349). So `http://hooks.example.com` is labelled `scheme-not-allowed`,
while `http://localhost:3000` is `loopback`, `http://10.0.0.5` is `private`, `http://169.254.169.254` is
`link-local` and `http://receiver.internal` is `internal-name`. An operator grepping the refusal log for
`scheme-not-allowed` alone will therefore MISS the `http://`-to-internal-host rows; all of the labels
above are in the same closed set and all of them mean "not dispatched". Two of these pairs are pinned
by the spec's refusal table (`webhook-service-ssrf.test.ts:239` `http://sink.example.com` →
`scheme-not-allowed`, :241 `http://127.0.0.1` → `loopback`).

Note the population this can bite: `createWebhook` only enforces https when `NODE_ENV==='production'`,
and `updateWebhook` never enforced it, so non-production-created and PATCHed rows can be `http://`
today. The `apps/web` form has always required https (`MetaApiTokenManager.vue:573`), so such rows can
only have come from a direct API client or a non-production environment.

**(b) 3xx no longer delivers.** A receiver that answers a redirect now fails the delivery terminally
with `redirect-not-allowed` instead of being followed. It does not auto-disable (§3.3), so such a
subscription produces one refused delivery per event until an operator fixes the URL — noisy by design
rather than silently disabled; registered as follow-up FS-3 if the noise proves worse than the signal.

**(c) A target that resolves internally** (public-looking name → RFC1918/loopback answer) starts
failing with `dns-resolved-internal`. This was already being *attempted* before the change; only the
outcome is new.

**(d) log-level change**: `Webhook delivery error for …` at `error` becomes
`[webhook.delivery.failed]` at `warn`, and `[webhook.delivery.refused]` is new. Anything alerting on the
old free-text string must be re-pointed at the structured lines.

### Pre-merge inventory for the owner (needs a real database — not runnable from this worktree)

Read-only, counts and identifiers only. Deliberately no `SELECT url` — subscription URLs can carry
credentials (§4).

```sql
-- subscriptions that start failing (the refusal LABEL depends on the host, see §6a)
SELECT count(*) AS http_webhooks
  FROM multitable_webhooks
 WHERE active AND url ILIKE 'http://%';

-- …broken out by owner so the right people can be warned (identifier, not a value)
SELECT created_by, count(*) AS http_webhooks
  FROM multitable_webhooks
 WHERE active AND url ILIKE 'http://%'
 GROUP BY created_by
 ORDER BY http_webhooks DESC;

-- subscriptions aimed at an obviously internal literal (already failing to deliver today)
SELECT count(*) AS internal_webhooks
  FROM multitable_webhooks
 WHERE active
   AND url ~* '^https?://(127[.]|10[.]|192[.]168[.]|169[.]254[.]|0[.]0[.]0[.]0|localhost|\[::1\])';

-- how many active subscriptions exist at all, for a denominator
SELECT count(*) AS active_webhooks FROM multitable_webhooks WHERE active;

-- SCOPE CORRECTION: the four queries above are all `WHERE active`, which answers "who starts failing
-- tomorrow" but UNDER-COUNTS the population. An already-disabled `http://` row is one authenticated
-- PATCH away from being live again — `updateWebhook` accepts `active: true` (`webhook-service.ts:297`)
-- with no scheme check (`:286-293`) and does not reset `failure_count`, so it re-enters the same wall.
-- Same projection discipline: counts and the active flag only, still no `SELECT url`.
SELECT active, count(*) AS http_webhooks
  FROM multitable_webhooks
 WHERE url ILIKE 'http://%'
 GROUP BY active
 ORDER BY active DESC;
```

Two more caveats on those numbers, so nobody reads a `0` as "nothing to do":

- the internal-literal regexp is a deliberate sample of *obvious* literals, not the guard's predicate.
  It does not cover `172.16/12`–`172.31`, `0.0.0.0/8` beyond the literal `0.0.0.0`, `*.internal` /
  `*.local` names, IPv6 ULA (`fc00::/7`) or link-local (`fe80::/10`), or `::ffff:`-mapped IPv4 — all of
  which the guard DOES refuse (`webhook-ssrf-guard.ts:32`, :35, :67, :68, :51-58, :81). The count is a
  floor, not a total. Under-counting here is a conservative error in the security direction (nothing
  escapes the gate because the inventory missed it) and an optimistic one in the notification
  direction — the owner should add their own network's ranges before warning people.
- there is no equivalent inventory for (b): whether a receiver answers 3xx is not visible from the
  stored row.

## 7. What this PR deliberately does NOT do

| # | not done | why |
|---|---|---|
| FS-1 | Author-side rejection at `createWebhook` / `updateWebhook` (refuse an internal or `http://` URL at save time, and close the `NODE_ENV==='production'` hole in the existing check) | A write-path change with a 400 contract and an `apps/web` surface; this PR is the runtime containment only. Note the direction: that change would TIGHTEN the write entry, never widen it. |
| FS-2 | resolve-then-pin (`pinnedHttpsFetch`) on this path | Would replace the `fetchFn` seam five spec files inject through, and change the response contract. This PR therefore does **not** claim DNS-rebinding protection here — same limitation #5619 stated as F-1. **Consequence, stated in full (was missing from the first draft of this row): the gate resolves the name (`webhook-ssrf-guard.ts:119` returns `addresses`) and then hands the HOSTNAME to `fetchFn` (`:512`) without using them, so the transport resolves a second time. On this path the outcome of winning that race is worse than on the button path: `:539` persists `await response.text()` into `multitable_webhook_deliveries.response_body`, which the subscription's creator reads back through `listDeliveries` (`:741-756`) and `GET /webhooks/:id/deliveries` (`routes/api-tokens.ts:392-410`), so it is a READABLE SSRF, not the blind one `pinnedHttpsFetch` leaves (`webhook-pinned-fetch.ts:17` returns `{status, ok}` only). Highest-priority follow-up of this table.** |
| FS-3 | Auto-disable (or rate-limit) a subscription that permanently 3xx-refuses | Needs an operations decision about noise vs. silent disablement (§6b). |
| FS-4 | A `last_error` / `refusal_class` column on `multitable_webhook_deliveries` | A migration; the closed-set marker in `response_body` gives the operator the same fact without one. |
| FS-5 | Anything in `automation-log-redact.ts`, `errorCodeLabels.ts`, or the `apps/web` mirror | Out of scope by instruction; the redactor is shared by four channels (#5619 F-2). |
| FS-6 | DNS-resolution timeout around the gate's lookup | Inherited from #5619 F-4: a hung resolver is a latency bug, not a containment bug — and here it delays a retry tick, not a user request. |
| FS-7 | Scope the fan-out by tenant/sheet | `deliverEvent` selects subscriptions with `where('active','=',true)` alone (`:364-372`) and then filters only on the event name; the table has no tenant or sheet column (migration `zzzz20260414100002`), and `POST /api/multitable/webhooks` needs only a session (`routes/api-tokens.ts:320-325`). So one subscription receives every event of the types it subscribed to — `record.created`,
`record.updated`, `record.deleted`, `comment.created` (`webhooks.ts:39-50`) — from every sheet on the
platform. Pre-existing and orthogonal to this gate (it governs WHAT is sent to a target the subscriber chose, not WHETHER the target is reachable), and this PR neither widens nor narrows it — but it is a wider data exposure than the one being closed here, so it is registered rather than left implicit in §1. Deserves its own issue, not a rider on an SSRF wave. |
| FS-8 | Move the redirect decision out of the `try` | `handleRefusedRedirect` is called at `:533`, inside the `try` at `:508`, so a DB fault on its terminal UPDATE is caught by `:568`, mislabelled `transport-error`, and re-queued with a backoff (§3.3). Bounded by `max_retries` and containment-neutral, but the ledger lies about the cause. |
