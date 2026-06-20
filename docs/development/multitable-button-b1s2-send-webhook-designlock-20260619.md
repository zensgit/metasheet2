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
- **Block private / loopback / link-local / metadata targets** after DNS resolution, for **both IPv4 and IPv6** (an IPv6-only environment must be locked as tightly as IPv4):
  - **IPv4:** `127.0.0.0/8`, RFC1918 (`10/8`, `172.16/12`, `192.168/16`), link-local `169.254/16` (incl. the cloud metadata IP `169.254.169.254`);
  - **IPv6:** `::1` (loopback), **`fc00::/7`** (unique-local / ULA), **`fe80::/10`** (link-local), and **IPv4-mapped** `::ffff:0:0/96` (so an IPv4 private address cannot be smuggled in mapped form);
  - **name-based:** `.internal` / `.local` names.
  - Apply the check to **every** address a name resolves to — a name with multiple A/AAAA records is rejected if **any** resolved address is internal.
- **Resolve-then-pin** to defeat DNS-rebinding: validate the resolved IP and connect to that pinned IP (or re-validate at connect time), not a name that can re-resolve to a private address between check and use.
- **No redirects to private targets** — validate every hop, or disable redirect-following.
- **Optional admin-managed domain allowlist** as a stricter overlay.

**Canonical return contract (binds §6/§7):** a missing/malformed URL or any SSRF-rejected target is a **pre-transaction `400`, fail-fast** — **no dedup row consumed, no audit/delivery row written** (a non-attempt is not an execution; same validate-before-the-txn order as #2768). §6/§7 MUST NOT reclassify an SSRF/config rejection as a `200 { status:'failed' }` execution.

## 4. confirm (server-enforced; reuse #2768)

External egress is irreversible. Reuse the **server-enforced** confirm gate: `confirm.enabled` ⇒ server requires `confirmed===true` (FE `window.confirm` is UX only, bypassable by direct POST). No new mechanism.

## 5. Durable audit + delivery record + redaction

- Reuse the #2768 transactional audit row (`triggered_by='button'`, excluded from DF-N1 `listExecutions`/`getRecent`, retrievable by id), in the **same** `pool.transaction` as dedup.
- **Add an egress delivery record** (target [redacted], response status, duration) — reuse the `WebhookService.createDeliveryRecord` pattern.
- **Redaction is mandatory and is a review focus:** never persist or log the `secret`, the `X-Webhook-Signature`, any `Authorization` header, or the full response body. The executor already redacts the URL via `redactString` in error text; extend that discipline to the whole audit/delivery surface.
- **Value-level scrub is a load-bearing invariant, not just key-name redaction (#1882 F1).** The bullet above redacts the *known secret keys* by name — but a secret-shaped **value** under a **benign** key still leaks: a record field (e.g. `notes`), a `headers` value, the target URL's query string, or exception/error text can each carry a JDBC/ODBC connection string, token, or password. So **every persisted-or-logged egress surface — the audit row, the delivery record, the failure/error message, and any log line — MUST pass through the shared value-scrubber** (the `payload-redaction.cjs` *value-pattern* path, not only key-name matching) before it is written. Key-name redaction alone is insufficient. The #1882 F1 trap ("the key looks harmless but the value already leaked the secret") must not reopen on an egress action — where it is strictly worse than on the read paths it was first found on, because the data leaves the system.

### 5a. Implementation amendment — durable record + transaction order (ratified during #2966 review)

The B1-S2 implementation tightens §5 on points that could not be satisfied as literally written; all were ratified during the #2966 security review.

- **Transaction order (the §5 "same `pool.transaction` as dedup" clause).** An external HTTP egress cannot sit inside a DB transaction, so audit-in-the-same-tx-as-dedup is unsatisfiable as written. Resolved ordering: **Tx A** claims the dedup row with `outcome='pending'` and commits (so a concurrent retry sees the claim and cannot double-fire); the egress runs **between** the transactions (pinned address, retry off); **Tx B** then records the final `outcome` and the audit **atomically** in one transaction, guarded to the still-`pending` row this run claimed (`dedup_key + execution_id + outcome='pending'`; a `rowCount != 1` is fail-closed, so a prior result is never overwritten). If Tx B fails the row stays `pending` and the response is non-success — never a false egress success.
- **The dedup row carries a completion state, not mere existence.** A replay reads the **stored** `outcome`: `succeeded → succeeded`; `failed → failed` (+ stored, scrubbed message); `pending`/null → **non-success and never a second egress**. `pending` is **terminal** by design — never expired or requeued, because re-running a `pending` key would reintroduce the double-fire §6 forbids. (`null` is interpreted as unknown/pending **only** on the webhook branch; existing `send_notification` / `update_record` replay is untouched.)
- **Delivery record (the §5 "add an egress delivery record" bullet).** For v1 the **durable delivery record IS the scrubbed audit step output** (target [scrubbed], response status, duration, reached) on the `triggered_by='button'` audit row. A separate delivery table is **not** introduced — it would add a second partial-failure persistence surface, and the existing `WebhookService.createDeliveryRecord` is private and bound to registered-webhook + automation-event semantics that do not fit a button egress. A dedicated delivery table remains a future option if per-delivery observability parity is later required.
- **Header policy (v1).** A field author may set **only** `content-type` / `accept`; `Host` / auth / cookie / signature / any custom `X-*` header is not settable from field config. The HMAC signature headers are code-owned and applied last, so config can never inject or shadow them. Broader custom headers are a future design-lock, not a default.
- **Egress permission.** The gate is an **exact** grant — `admin` role **or** the exact `multitable:send_webhook` permission. A broad `multitable:*` / `*:*` wildcard does **not** confer egress.

## 6. Idempotency / failure mode (D6 — resolve the reuse conflict)

There is a **direct conflict** to settle: B1-S1 locked **at-most-once** (dedup-before-act, no retry), but the reused executor `executeSendWebhook` performs **bounded retry** (`AUTOMATION_WEBHOOK_MAX_RETRIES`, at-least-once).

- **Recommend at-most-once for MVP:** dedup-before-egress, and **explicitly disable the executor's retry on the button path**. A duplicate outbound POST can double-act on an external system; for a manual button click a rare miss is safer than a double-fire. *If the retry is not explicitly disabled, the reused executor silently retries and breaks the dedup guarantee — this is the trap to lock against.*
- Alternative (at-least-once) is only safe if the requestId is forwarded as an idempotency key the receiver honors; out of MVP scope.

## 7. Failure semantics (3-way; reuse)

Validation is **fail-fast before the transaction**; only a *reached* target yields an execution outcome:

- **`400` / `403` — pre-transaction rejection, no dedup consumed, no audit/delivery written:** config/validation (missing or malformed URL), **SSRF-rejected target (§3.1)**, actor-gate failure (§3), or missing `requestId` (§6). A non-attempt is never recorded as an execution.
- `200 { status:'succeeded' }` = the validated, non-SSRF target was reached and returned **2xx**.
- `200 { status:'failed', message }` = the target was reached but returned a **non-2xx response** (per policy) — surfaced, **no retry**. This is the **only** `200 failed` case; config/SSRF rejections are the `400` bucket above, never this one.
- Never leak the response body in the failure message (redact).

This separation is load-bearing for implementation order + idempotency: SSRF/config rejection happens **before** the dedup row is written, so it never consumes a `requestId` and never lands an audit/delivery row; only a genuine egress attempt (a reached target, whatever its response) is dedup-keyed and audited.

## 8. Channel boundary

B1-S2 is **generic outbound HTTPS webhook only**. Any provider-specific delivery action (the separate, older delivery-button track) is out of scope and keeps its own contract.

## 9. Prior actions unchanged

`record_click` (inert), `send_notification` (#2768), `update_record` (#2806) are untouched. This action only adds a policy entry + the egress controls above.

## 10. Reuses the shipped template

The framework (enable = policy + validated dispatch · server-confirm · requestId + dedup · `triggered_by='button'` durable audit · 3-way failure) is the same as #2768/#2806. Only the **gate (D-GATE)**, **SSRF safety (D-SSRF)**, **payload**, and **failure mode (D6)** change.

## 11. Implementation-time verification plan (after review)

Unit + real-DB/HTTP-boundary:

- SSRF (IPv4 **and** IPv6): `http://`, `127.0.0.1`, `169.254.169.254`, RFC1918, `::1`, `fc00::/7` (ULA), `fe80::/10` (link-local), IPv4-mapped `::ffff:7f00:1`, `.internal`, multi-record name with one internal address, and DNS-rebinding → **rejected pre-txn with `400`, nothing sent, no dedup consumed, no audit/delivery row**.
- actor unauthorized → `403` (pre-txn, no dedup/audit).
- confirm enforced (server, not FE).
- requestId required (side-effecting) → reject if missing; same dedup key replay → **single egress** (at-most-once, retry disabled).
- durable audit row + delivery record land, with `secret` / signature / `Authorization` / response body **redacted** (assert they are absent).
- **value-scrub (#1882 F1):** a secret-shaped **value** (e.g. a JDBC/ODBC connection string with an embedded password) carried under a **benign** key — a record field, a `headers` value, the URL query, or forced into the error text — does **NOT** appear verbatim in the persisted audit row, the delivery record, or the failure message. Assert the **scrubbed** form is stored, not the raw secret value (key-name redaction would pass this test while still leaking — so the assertion targets the value, under a non-secret key).
- 3-way failure incl. non-2xx target response = `failed`, surfaced, no leak.
- regression: `record_click` / `send_notification` / `update_record` unchanged.
- egress mocked at the `fetch` boundary; real-DB for dedup + audit + delivery record.

## 12. Landing

This design-lock (docs) → **review decides D-GATE (actor capability) · D-SSRF (url safety) · D6 (at-most/least-once + retry-disable) · payload-interpolation · value-level scrub (§5, load-bearing — value-pattern scrub across audit/delivery/error/log surfaces, not key-name only)** → implementation (policy entry + actor re-gate + SSRF guard + reuse confirm/dedup/audit + delivery record + redaction + retry-disable + FE config for `url`/`method`/`headers`). Runtime does not begin until the owner signs off on the security decisions above.
