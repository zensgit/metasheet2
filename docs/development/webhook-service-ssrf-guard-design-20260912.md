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
packages/core-backend/src/multitable/webhook-service.ts:483   await this.fetchFn(wh.url, { method: 'POST', ... })
```

(`grep -n "fetchFn"` over the file returns the field declaration :165, the seam field :172, the
constructor :174-178 and that one call.) There is no separate "test delivery" endpoint and no second retry client: both
entry points funnel into the same method.

| entry point | caller | reaches |
|---|---|---|
| `deliverEvent()` fan-out | `webhook-event-bridge.ts:86` (EventBus bridge) and `automation-durable-consumer-handlers.ts:108` (durable outbox consumer) | `executeDelivery()` fire-and-forget per matching subscription (`:383`) |
| `retryFailedDeliveries()` tick | `services/WebhookRetryScheduler.ts:151` (60s interval, optional Redis leader lock) | `executeDelivery()` for every claimed `pending` row (`:694`) |

Both therefore pass through ONE gate. A row queued before this change is re-judged on its next attempt,
because the gate runs per attempt, inside `executeDelivery`, not at enqueue time.

Retry/dead-letter semantics as they already existed (unchanged by this PR): failure →
`handleDeliveryFailure` → exponential backoff (`computeBackoffMs`, per-webhook policy columns) while
`attempt_count < max_retries`, else `status='failed'`; `failure_count` on the webhook row increments and
at `WEBHOOK_MAX_CONSECUTIVE_FAILURES` (default 10) the subscription is set `active=false`. There is no
dead-letter table; a terminal row simply sits `failed` and is readable through
`GET /api/multitable/webhooks/:id/deliveries`.

## 3. What changed

### 3.1 The gate (`webhook-service.ts:408-458`)

`checkWebhookTargetUrl(wh.url, this.ssrfLookupFn)` runs inside `executeDelivery`, **after** the webhook
row is loaded and **before** anything else. Placement is load-bearing three ways, the same argument the
rule-driven path makes at `automation-executor.ts:4128`:

1. **Before the header/HMAC assembly** (`:463-475`): a refused target never has
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
  consecutive events — the same operator signal an unreachable endpoint produces today;
- a **transient** resolver failure (`dns-unresolved`) keeps today's retry behaviour instead of dropping
  the event. Before this change the same failure arrived as an `ENOTFOUND` transport error and was
  retried; making the refusal terminal would have silently converted a DNS blip into lost events.

This is deliberately NOT a class-driven branch: `webhook-refusal-class.ts` states that a label must
never be able to change a delivery decision, and nothing here reads the label to decide anything. The
one policy difference below is read off the RESPONSE, not off a label.

### 3.3 Redirects are not followed (`:483-507`, `:586-617`)

The gate judges exactly one URL, so the dispatch has to stop at it. `redirect: 'manual'` is now passed
in the fetch init, and a 3xx is a **terminal** refusal
(`WEBHOOK_TARGET_REJECTED:redirect-not-allowed`, reusing #5619's literal), written by
`handleRefusedRedirect`: `status='failed'`, `next_retry_at=NULL`, no backoff row.

Why terminal here when a target refusal is not: a retry of a refused **target** dispatches nothing,
while a retry after a 3xx re-sends the same body to the same first hop, which will answer 3xx again —
real repeated egress with no chance of success. The check runs **before** the response body is read, so
nothing from the redirect response — `Location` above all — is read, logged or persisted. The spec pins
that with `expect(headers.get).not.toHaveBeenCalled()`.

`failure_count` is deliberately not touched on this path: auto-disable is the flap counter for a
receiver that cannot be reached, and this receiver answered. The cost is stated in §6.

### 3.4 The failure log is a closed set (`:539-573`)

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
  what can reach that line is a DB error; it is out of scope and left alone.
- `tests/integration/rc-regression.test.ts` contains a spec-local `InMemoryWebhookService`
  reimplementation (`:338`) that does NOT go through this gate. It is a test double, not product code,
  and it is deliberately left as-is so it keeps testing what it was written to test.

## 5. Allowlist / escape hatch: deliberately none

Neither sibling egress path has an env switch or an internal-target exemption, and this one does not
invent the first. A deployment that must reach an internal receiver exposes it through a reverse proxy
as an https public endpoint — the same answer as #5619 §5.

## 6. Behaviour changes to flag in the release note

**(a) https-only.** A subscription with an `http://` URL that used to be delivered now fails with
`scheme-not-allowed`, and — because refusals go through the existing ledger — auto-disables after 10
consecutive events (`active=false`). Same posture as the other two egress paths. Note the population
this can bite: `createWebhook` only enforces https when `NODE_ENV==='production'`, and `updateWebhook`
never enforced it, so non-production-created and PATCHed rows can be `http://` today.

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
-- subscriptions that start failing on scheme-not-allowed
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
```

There is no equivalent inventory for (b): whether a receiver answers 3xx is not visible from the stored
row.

## 7. What this PR deliberately does NOT do

| # | not done | why |
|---|---|---|
| FS-1 | Author-side rejection at `createWebhook` / `updateWebhook` (refuse an internal or `http://` URL at save time, and close the `NODE_ENV==='production'` hole in the existing check) | A write-path change with a 400 contract and an `apps/web` surface; this PR is the runtime containment only. Note the direction: that change would TIGHTEN the write entry, never widen it. |
| FS-2 | resolve-then-pin (`pinnedHttpsFetch`) on this path | Would replace the `fetchFn` seam five spec files inject through, and change the response contract. This PR therefore does **not** claim DNS-rebinding protection here — same limitation #5619 stated as F-1. |
| FS-3 | Auto-disable (or rate-limit) a subscription that permanently 3xx-refuses | Needs an operations decision about noise vs. silent disablement (§6b). |
| FS-4 | A `last_error` / `refusal_class` column on `multitable_webhook_deliveries` | A migration; the closed-set marker in `response_body` gives the operator the same fact without one. |
| FS-5 | Anything in `automation-log-redact.ts`, `errorCodeLabels.ts`, or the `apps/web` mirror | Out of scope by instruction; the redactor is shared by four channels (#5619 F-2). |
| FS-6 | DNS-resolution timeout around the gate's lookup | Inherited from #5619 F-4: a hung resolver is a latency bug, not a containment bug — and here it delays a retry tick, not a user request. |
