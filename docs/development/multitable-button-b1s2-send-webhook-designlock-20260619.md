# 多维表 Button 第二个外发副作用动作 (B1-S2 = `send_webhook`) — 设计锁 — 2026-06-19

> Status: **DESIGN-LOCK (待评审，不实现)。** Contract-for-review only. Runtime stays **gated on owner security sign-off** — the same path `send_notification` took (#2768 owner REQUEST-CHANGES). No implementation in this PR.
> Naming: **B1-S2** = the next side-effecting button action after `send_notification` (B1-S1 D0-A, #2768) and `update_record` (B1-S1 D0-B, #2806). It is the §3.3 sequence's terminal step: `record_click → send_notification → update_record → **send_webhook**`.
> Grounding: `origin/main` @ `14ffaf10b`. Reuses the shipped framework: the transactional `dedup → action → audit` route path (#2768), the per-row no-elevation actor re-gate pattern (#2806), the executor `executeSendWebhook` (rule path), and `WebhookService` (https-only, HMAC, delivery records).
> Why a separate, heavier review: `send_webhook` is **real external egress** — the **highest-blast-radius** button action. A field author configures the target URL, so the contract's center of gravity is SSRF and credential safety, not UX.

## 0. Headline: two controls MUST be decided before any implementation

Unlike the in-app `send_notification`, this action leaves the system boundary. Two controls are load-bearing and cannot be inferred from "enable the next action":

- **D-GATE — actor capability for egress.** `canEditRecord` is **too low**: being able to edit a row is not authorization to make the server perform outbound calls (potentially with org-held credentials) to arbitrary endpoints.
- **D-SSRF — target-URL safety.** Without it, a button is a server-side request forgery vector into the internal network. This is to `send_webhook` what §3.1 recipient-authorization was to `send_notification`: the #1 control, and skipping it = silently shipping the hole.

Review must settle both, plus **D6** (at-most-once vs at-least-once) and the **payload-interpolation** question, before implementation begins.

## 1. Enable = the same two-change pattern (already routed on `main`)

`BUTTON_ACTION_POLICIES` (`packages/core-backend/src/routes/multitable-button.ts`) gains:

```
send_webhook: { gate: <D-GATE>, sideEffecting: true, dispatchType: 'send_webhook' }
```

The silent-no-op trap that the design-lock warned about for B1-S1 (hardcoded `record_click` dispatch) is **already closed** — since #2768/#2806 the route dispatches the validated `actionType`. So enabling is one policy entry + the controls below; no dispatch rewire remains.

## 2. Payload contract

Persistent `property.actionConfig`, shape to lock:

`{ url: string; method?: 'POST' | 'PUT'; headers?: Record<string,string>; body?: string | object; secret?: string }`

Decisions for review:

- **Template interpolation of record data into `body` is OFF for MVP** (recommended). `send_notification` locked "message sent as-is, not merged with recordData" for the same reason — interpolating record values into an outbound payload is a data-exfiltration + injection surface. If interpolation is ever wanted it is its own slice with explicit field-level redaction.
- **`headers` may not set `Authorization`/secret-bearing headers from untrusted field config** without going through the credential path (§5 redaction). Decide whether arbitrary headers are allowed at all for MVP (recommend: a small fixed-key allowlist, no auth headers).

## 3. Actor gate (D-GATE)

Egress ≠ edit. Options:

- **(a) dedicated `canSendWebhook` sheet-level capability** — mirrors the shipped `canSendNotification`; admin-grantable; **defaults OFF**. *Recommended.*
- (b) admin-only (coarsest, safest, least flexible).
- (c) `canManageAutomation` (webhook config is automation-adjacent, but conflates "configure" with "trigger").

**Marked PROVISIONAL — review must decide, not inherit.** Whatever the sheet-level gate, the dispatch path re-gates at action time (mirroring #2806's no-elevation row re-gate) so a button can never egress on behalf of an actor who lacks the capability.

## 3.1 SSRF / target-URL safety (THE #1 egress control)

A field author supplies `url`. Without constraints the server can be made to call internal endpoints. **LOCK (all required):**

- **https-only.** `WebhookService` already enforces `parsed.protocol === 'https:'` (`webhook-service.ts:155`); the button path MUST enforce the same — no `http:`, no `file:`, no other schemes.
- **Block private / loopback / link-local / metadata targets** after DNS resolution: `127.0.0.0/8`, `::1`, RFC1918 (`10/8`, `172.16/12`, `192.168/16`), link-local `169.254/16` (incl. the cloud metadata IP `169.254.169.254`), `.internal`/`.local` names.
- **Resolve-then-pin** to defeat DNS-rebinding: validate the resolved IP and connect to that pinned IP (or re-validate at connect time), not a name that can re-resolve to a private address between check and use.
- **No redirects to private targets** — validate every hop, or disable redirect-following.
- **Optional admin-managed domain allowlist** as a stricter overlay.

A rejected URL → `400` writing nothing (no dedup consumed, no audit of a non-attempt — same "validate before the txn" order as #2768).

## 4. confirm (server-enforced; reuse #2768)

External egress is irreversible. Reuse the **server-enforced** confirm gate: `confirm.enabled` ⇒ server requires `confirmed===true` (FE `window.confirm` is UX only, bypassable by direct POST). No new mechanism.

## 5. Durable audit + delivery record + redaction

- Reuse the #2768 transactional audit row (`triggered_by='button'`, excluded from DF-N1 `listExecutions`/`getRecent`, retrievable by id), in the **same** `pool.transaction` as dedup.
- **Add an egress delivery record** (target [redacted], response status, duration) — reuse the `WebhookService.createDeliveryRecord` pattern.
- **Redaction is mandatory and is a review focus:** never persist or log the `secret`, the `X-Webhook-Signature`, any `Authorization` header, or the full response body. The executor already redacts the URL via `redactString` in error text; extend that discipline to the whole audit/delivery surface.

## 6. Idempotency / failure mode (D6 — resolve the reuse conflict)

There is a **direct conflict** to settle: B1-S1 locked **at-most-once** (dedup-before-act, no retry), but the reused executor `executeSendWebhook` performs **bounded retry** (`AUTOMATION_WEBHOOK_MAX_RETRIES`, at-least-once).

- **Recommend at-most-once for MVP:** dedup-before-egress, and **explicitly disable the executor's retry on the button path**. A duplicate outbound POST can double-act on an external system; for a manual button click a rare miss is safer than a double-fire. *If the retry is not explicitly disabled, the reused executor silently retries and breaks the dedup guarantee — this is the trap to lock against.*
- Alternative (at-least-once) is only safe if the requestId is forwarded as an idempotency key the receiver honors; out of MVP scope.

## 7. Failure semantics (3-way; reuse)

- `200 { status:'succeeded' }` = target returned 2xx;
- `200 { status:'failed', message }` = config/validation failure (missing URL, SSRF-rejected, or non-2xx response per policy) — **decide that a non-2xx target response = `failed`, surfaced, no retry** (recommended);
- non-2xx = permission / contract / idempotency rejection.
- Never leak the response body in the failure message (redact).

## 8. Channel boundary

B1-S2 is **generic outbound HTTPS webhook only**. Any provider-specific delivery action (the separate, older delivery-button track) is out of scope and keeps its own contract.

## 9. Prior actions unchanged

`record_click` (inert), `send_notification` (#2768), `update_record` (#2806) are untouched. This action only adds a policy entry + the egress controls above.

## 10. Reuses the shipped template

The framework (enable = policy + validated dispatch · server-confirm · requestId + dedup · `triggered_by='button'` durable audit · 3-way failure) is the same as #2768/#2806. Only the **gate (D-GATE)**, **SSRF safety (D-SSRF)**, **payload**, and **failure mode (D6)** change.

## 11. Implementation-time verification plan (after review)

Unit + real-DB/HTTP-boundary:

- SSRF: `http://`, `127.0.0.1`, `169.254.169.254`, RFC1918, `.internal`, and DNS-rebinding → **rejected, nothing sent**.
- actor unauthorized → `403`.
- confirm enforced (server, not FE).
- requestId required (side-effecting) → reject if missing; same dedup key replay → **single egress** (at-most-once, retry disabled).
- durable audit row + delivery record land, with `secret` / signature / `Authorization` / response body **redacted** (assert they are absent).
- 3-way failure incl. non-2xx target response = `failed`, surfaced, no leak.
- regression: `record_click` / `send_notification` / `update_record` unchanged.
- egress mocked at the `fetch` boundary; real-DB for dedup + audit + delivery record.

## 12. Landing

This design-lock (docs) → **review decides D-GATE (actor capability) · D-SSRF (url safety) · D6 (at-most/least-once + retry-disable) · payload-interpolation** → implementation (policy entry + actor re-gate + SSRF guard + reuse confirm/dedup/audit + delivery record + redaction + retry-disable + FE config for `url`/`method`/`headers`). Runtime does not begin until the owner signs off on the security decisions above.
