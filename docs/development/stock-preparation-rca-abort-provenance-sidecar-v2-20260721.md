# RC-A Abort-Provenance Sidecar v2 — 4XX Sub-Classification (2026-07-21)

Issue: #4437. Purpose: **accelerate** the RC-A auth diagnostic so ONE flag-OFF run with a
known-good token is dispositive — no "try v1, then maybe cut v2" two-step. Test-only client
change; no service change, no RC-A package republish, no flag/PM2 interaction.

## 1. Why

The sidecar v1 run returned `authReadResult=HTTP_4XX` (service reachable and answering; client,
runtime, transport, service-liveness all cleared — the abort mystery was a v1 wrapper artifact).
A 4XX on `GET /api/integration/status` can be several distinct things, and v1 could not tell them
apart, forcing a second round-trip. The owner's plan (known-good token → 2XX or 4XX; if 4XX, cut
v2) can be collapsed to a single run by shipping the discriminator now.

## 2. The closed 4XX surface (mapped from code, not guessed)

`GET /api/integration/status` is gated by two stacked auth layers; the exact non-2xx codes are a
closed set (values-free — the server's own error codes, not business data):

| HTTP | Server `error.code` | Layer | Meaning for a known-good-token run |
|---|---|---|---|
| 401 | `UNAUTHORIZED` | global JWT gate | token still missing / invalid / expired (token problem persists) |
| 403 | `PASSWORD_CHANGE_REQUIRED` | global JWT gate | the token's account is flagged for forced password change (account state) |
| 401 | `UNAUTHENTICATED` | plugin requireAccess | no user resolved at the plugin layer (structurally odd token) |
| 403 | `FORBIDDEN` | plugin requireAccess | valid token, no forced-change, but lacks `integration:read` (permission) |
| 404 | — | — | not reachable for auth failures (route mounted); a 404 would mean route/base-URL/deploy |
| 2XX | — | — | healthy — the fast-track condition |

(Sources: `packages/core-backend/src/auth/jwt-middleware.ts` UNAUTHORIZED/PASSWORD_CHANGE_REQUIRED;
`plugins/plugin-integration-core/lib/http-routes.cjs` requireAccess UNAUTHENTICATED/FORBIDDEN.)

## 3. Change

Two closed-vocabulary, values-free fields added to
`scripts/ops/stock-preparation-rca-abort-provenance.mjs`:

- `authReadStatusClass = HTTP_2XX | HTTP_401 | HTTP_403 | HTTP_404 | HTTP_409 | HTTP_4XX_OTHER |
  HTTP_5XX | OTHER | UNAVAILABLE` — from the numeric HTTP status (a closed protocol enum).
- `authReadReasonClass = NONE | UNAUTHORIZED | PASSWORD_CHANGE_REQUIRED | UNAUTHENTICATED |
  FORBIDDEN | OTHER | UNAVAILABLE` — the server's own `body.error.code` matched against the
  four-code allowlist; anything else (or absent) folds to `OTHER`, so no free-text can reach the
  output. `NONE` on 2xx; `UNAVAILABLE` when a transport/abort rejection produced no HTTP response.

Everything else about the client is unchanged (exact-SHA helper binding, fixed `timeoutMs=15000`,
one internal read-only GET, DIAGNOSTIC_COMPLETE contract, token scrub).

## 4. Verification

- `node --test` suite 42 → **45/45** (v1 unchanged; new: status-class boundaries, reason-class
  allowlist incl. an `MAT-001-SECRET`-shaped code folding to `OTHER`, and an end-to-end run for
  each of 401/403-pwchange/403-forbidden/2xx plus the transport-abort UNAVAILABLE arm).
- CLI end-to-end: dead port → `authReadStatusClass=UNAVAILABLE` / `authReadReasonClass=UNAVAILABLE`.
- Mutation battery **6/6 RED** (merge 401/403 classes, open the reason allowlist, drop the 2xx→NONE
  rule, ignore the body, mislabel 401→403, swap the two field wirings); clean rerun 45/45.
- CI: covered by the existing `stock-preparation-prep-line-extended-smoke.yml` contract job
  (Node 20 path filter already lists this client + its test).

## 5. Operating the single dispositive run (owner-directed; operator action)

Publish a sidecar **v2** (this client + the byte-exact RC-A helpers, same packaging as the v1
no-Git sidecar), then run ONCE, flag OFF, with a **known-good token** (short-lived, `integration:read`
or `role:admin`, **not** flagged for forced password change):

```
node scripts/ops/stock-preparation-rca-abort-provenance.mjs \
  --helper <sidecar>/scripts/ops/stock-preparation-prep-line-extended-smoke.mjs \
  --base-url <internal-base-url> [--tenant-id <tenant>]
```

Routing from that single run (owner-court):

- `authReadStatusClass=HTTP_2XX` + hygiene PASS ⇒ the conditional RC-A flag-ON window is authorized.
- `HTTP_401` / `UNAUTHORIZED` ⇒ token still invalid (re-issue).
- `HTTP_403` / `PASSWORD_CHANGE_REQUIRED` ⇒ clear the account's forced-password-change, re-run.
- `HTTP_403` / `FORBIDDEN` ⇒ grant `integration:read` to the token's principal, re-run.
- `HTTP_404` ⇒ route not mounted / wrong base URL ⇒ deployment-side, not token.

Same discipline as v1: flag stays OFF, one internal GET, no full smoke, no approved config, no
PM2/redeploy/package edit, no retries. Sidecar publish + entity-machine run remain owner/operator
actions; this PR only ships the tested client.
