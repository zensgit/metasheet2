# Webhook SUBSCRIPTION delivery — SSRF gate: verification (F-3 of #5619)

Worktree `metasheet-wt-w3a`, branch `fix/webhook-service-ssrf-guard`, stacked on
`fix/automation-webhook-ssrf-guard` @ `d096f4039`. Run 2026-09-11, Node v25.9.0, vitest 1.6.1, no
`DATABASE_URL`. Design doc: `docs/development/webhook-service-ssrf-guard-design-20260912.md`.

---

## 1. Commands and exit codes

| command (cwd `packages/core-backend`) | result |
|---|---|
| `npx tsc --noEmit` | **exit 0** (run twice: after the source change, and again after the spec changes) |
| `npx eslint src/multitable/webhook-service.ts` | **exit 0**, 0 findings. (From the repo ROOT eslint errors with "TSConfig does not include this file" — a pre-existing config fact about `packages/**`, not a finding about this change.) |
| `npx vitest run tests/unit/webhook-service-ssrf.test.ts` | **51 passed / 51** (new spec) |
| `npx vitest run tests/unit/webhook-service-ssrf.test.ts tests/unit/api-token-webhook.test.ts tests/unit/webhook-retry-policy-service.test.ts tests/unit/automation-send-webhook-ssrf.test.ts tests/unit/send-webhook-action-hardening.test.ts tests/unit/automation-classb-outbound.test.ts` | **6 files, 179 passed / 179** (51 + 46 + 9 + 62 + 3 + 8) |
| `npx vitest --config vitest.integration.config.ts run tests/integration/multitable-webhook-{durable-dedup,event-bridge,retry-tick}.test.ts` | **13 skipped / 13** — the three real-DB specs COLLECT cleanly (so the edits compile) and skip on the absent `DATABASE_URL`. Not executed here; see §6. |

The full `core-backend` suite was deliberately not run (host memory/disk budget for this task); the
affected-spec set above is the evidence.

## 2. Runtime facts this round depends on — measured, not quoted

Both are asserted inside the spec, so a future runtime change reds the suite instead of silently
invalidating the reasoning.

1. **`fetch`'s default redirect really is `follow`** — the thing `redirect: 'manual'` overrides:
   `new Request(url, { method: 'POST' }).redirect === 'follow'`, and `… { redirect: 'manual' }` reads
   back `'manual'`. In-process, no socket
   (`tests/unit/webhook-service-ssrf.test.ts` → "runtime precondition: the platform default really is
   `follow`").
2. **A credential-bearing URL makes the NATIVE client throw at request CONSTRUCTION, with the whole URL
   in the message**: `await fetch('https://svc:<pw>@203.0.113.10/hook?token=…', …)` rejects with
   `TypeError: Request cannot be constructed from a URL that includes credentials: …<pw>…` before any
   socket is opened. The spec asserts the message contains `includes credentials` AND the password —
   if a future runtime instead opened a connection, that assertion fails loudly rather than the
   leak-proof tests passing vacuously. **No network request is made by this suite**: the throw precedes
   DNS/TCP, and every other case injects a mock `fetchFn` plus a deterministic resolver.

## 3. Coverage map of the new spec (`tests/unit/webhook-service-ssrf.test.ts`, 51 tests)

| block | n | what it pins |
|---|---|---|
| internal targets refused before any request | 27 | 22 parametrised targets (http/ftp scheme, 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16 incl. the metadata address, 0.0.0.0, `::1`, `::`, `fd00::/8`, `fe80::/10`, both IPv4-mapped forms, `localhost`, `*.localhost`, `*.internal`, `*.local`, unparseable, empty) each asserting **`fetch` called 0 times** plus the closed-set log; multi-record DNS answer with one internal address; unresolvable name (fail-closed); a LYING resolver seam (still refused → the seam cannot disable the gate); `signPayload` called 0 times on refusal and exactly 1 time on the allowed path (gate is before the HMAC); refusal log contains none of the host / userinfo password / `token=` query / subscription secret |
| refusal bookkeeping | 3 | closed-set marker persisted in `response_body` and no URL in the write; the existing retry ledger is reused (`status='pending'`, `attempt_count=1`, `failure_count=1`); terminates at `max_retries` (no infinite re-check); a STALE `http_status`/`response_body` from an earlier attempt is not re-persisted |
| every entry point is gated | 2 | `deliverEvent` fan-out → row created, `fetch` 0; `retryFailedDeliveries` tick → claimed row processed (`retried === 1`), `fetch` 0 |
| redirect posture | 9 | the two runtime-precondition assertions; the dispatch init carries `redirect: 'manual'`; 301/302/303/307/308 each → exactly ONE request, `Location` never read (`headers.get` not called), body never read, terminal row (`status='failed'`, `next_retry_at: null`, `WEBHOOK_TARGET_REJECTED:redirect-not-allowed`), and the internal `Location` value absent from the log; the browser-profile `opaqueredirect` (status 0) shape; a 2xx still succeeds |
| failure logging is values-free | 7 | a transport error whose **`message` getter throws** is still classified (`conn-refused`) — proof the log path never reads `message`; ENOTFOUND/EAI_AGAIN → `dns-failure`, `CERT_HAS_EXPIRED` → `tls-failure`, `ECONNRESET` → `transport-error`; our own abort → `timeout`; an HTTP 503 still stores the RECEIVER's body and adds no new log line |
| native request-construction exception | 3 | the runtime precondition above; the log contains `invalid-request` and none of the password / `token=` / the client's own free text; the persisted row likewise, carrying `WEBHOOK_DELIVERY_FAILED:invalid-request` |

## 4. Mutation probes

Each mutant was applied to `src/multitable/webhook-service.ts`, measured against the new spec, then
reverted inside a `finally`, with the restore verified byte-for-byte by sha256
(`35b5e819491a076e349ae631a7b8ded1f18eea3075aef6340f27519a70946cba` before and after every probe — the
driver asserts equality, so a failed restore aborts the run). Nothing was left on disk.

| # | mutation | result (baseline 51/51 green) |
|---|---|---|
| M1 | delete the SSRF gate block entirely | **32 failed / 19 passed** |
| M2 | drop `redirect: 'manual'` from the fetch init | **1 failed / 50 passed** — "the dispatch asks for manual redirects" |
| M3 | put the transport's free text back in the failure log (`failure: err.message`) | **2 failed / 49 passed** — "a transport failure is labelled structurally; `message` is never read" (the throwing getter explodes) and "the delivery log has the class, not the credentials" |
| M4 | move the gate to AFTER the dispatch (same code, later position) | **30 failed / 21 passed** |
| M5 | stop treating a 3xx as a refusal (`if (false && isRefusedRedirectStatus(response))`) | **6 failed / 45 passed** — all five status codes plus the opaque-redirect case |
| M6 | put the URL back into the persisted delivery row marker | **2 failed / 49 passed** — the two "no credentials in the row/log" cases |

Honest negative result on **M2**: only the init assertion reds. A behavioural test cannot catch a
missing `redirect: 'manual'` in-process, because the injected mock `fetchFn` never follows anything —
which is precisely why that one-line init assertion exists. (#5619 recorded the same limitation for the
same reason.)

M1 vs M4 also reads as a placement proof: M4 keeps the gate but lets the request go out first, and 30
cases still red on `fetch` call counts — i.e. the tests measure *never sent*, not *eventually refused*.

## 5. Existing specs that had to change, and why

The gate resolves the target, so specs that drive real delivery would otherwise have hit real DNS
(`example.com`) or been refused as unresolvable (`sink.test`, a reserved TLD). Each now injects the
deterministic public resolver through the new third constructor argument — a resolver seam, not a
bypass; the guard still judges the address it returns.

| file | change |
|---|---|
| `tests/unit/api-token-webhook.test.ts` | `SsrfLookupFn` import + `publicLookup`; 5 `new WebhookService(db, fetch)` sites gain the seam. 46/46 still pass, assertions untouched. |
| `tests/integration/multitable-webhook-durable-dedup.test.ts` | same, 1 site |
| `tests/integration/multitable-webhook-event-bridge.test.ts` | same, 1 site |
| `tests/integration/multitable-webhook-retry-tick.test.ts` | same, 6 sites |

Not changed, on purpose:

- `tests/unit/webhook-retry-policy-service.test.ts` — exercises `createWebhook` / `computeBackoffMs`
  only; never dispatches, so the gate is not on its path (9/9 green, unmodified).
- `tests/integration/multitable-p2-fwb-eight-scenario-matrix.test.ts` — constructs a `WebhookService`
  for the bridge but seeds no `multitable_webhooks` rows, so no delivery ever runs.
- `tests/integration/rc-regression.test.ts` — its webhook section drives a spec-local
  `InMemoryWebhookService` clone (`:338`), not the product class. Left as-is; noted in the design doc
  §4 so nobody reads it as coverage of this gate.

## 6. What was NOT run here

- **The three real-DB integration specs** (13 tests). They collect and skip without `DATABASE_URL`;
  their first real execution is the PR's real-DB lane. What they would newly prove: the gate and the
  refusal bookkeeping against actual Postgres rows (the unit spec proves them against a mock
  query-builder).
- **The full `core-backend` suite** — out of the host budget for this task; the 6 affected unit files
  are the evidence offered instead.
- **The pre-merge inventory SQL** (design §6) — needs a real database and read-only credentials; it is
  an owner step, not a worktree step.
- **Any live egress test.** By construction: no test in this change opens a socket.

## 7. Residual risk, stated plainly

1. **No resolve-then-pin on this path.** The gate resolves the name and judges the answer, then `fetch`
   resolves it again. A DNS rebind between the two is not defended against here, exactly as on the
   rule-driven path (#5619 F-1). This PR does not claim rebinding protection. The button path, which
   dispatches through `pinnedHttpsFetch`, is the one that does.
2. **Write-time is still open.** `createWebhook` enforces https only when `NODE_ENV==='production'` and
   `updateWebhook` enforces nothing, so an internal/`http://` URL can still be STORED; it simply never
   gets delivered to. Closing that is FS-1 and would tighten, never widen, the write entry.
3. **The subscription row itself still holds the URL and secret verbatim** and is returned to its
   creator by `GET /api/multitable/webhooks`. This change guarantees the LOG and the DELIVERY ROW, not
   the subscription record.
4. **`deliverEvent`'s fire-and-forget catch** still logs `err.message`; after this change only DB errors
   from `executeDelivery` can reach it, but it is free text and it was left alone (out of scope).
5. **A permanently 3xx-answering subscription never auto-disables** (§3.3 of the design): it emits one
   first-hop request per matching event forever. That is unchanged egress volume versus today, but it is
   noise a follow-up may want to cap (FS-3).
