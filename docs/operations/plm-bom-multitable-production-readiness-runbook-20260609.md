# PLM BOM Multitable Production Readiness Runbook

Date: 2026-06-09

Scope: MetaSheet2 consumer-side readiness for the PLM-integrated BOM multitable read path. This runbook covers the deployed read-side chain:

- Yuantus provider: `bom_multitable` entitlement, BOM read projection, integration capabilities, and PLM-minted embed tokens.
- MetaSheet2 consumer: PLM adapter capability discovery, workbench relay, read-only BOM review UI, token-bound embed route, served-tenant cross-check, and single-use embed token replay protection.

Non-goals for this runbook:

- No PLM authority writeback.
- No SSO or token exchange.
- No provider-side revoke or consume callback.
- No full REST/UI productization for per-source PLM tenant configuration; if #2418 lands, REST payloads can carry `options.tenantId` / `options.orgId`, while operator UI productization remains separate.
- No replacement for customer UAT signoff.

## 1. Development Target

Use the earlier PLM integrated multitable plan as the development target, in this order:

1. Read-side production readiness: make the current provider and consumer read path operable, observable, and fail-closed.
2. Per-source tenant configuration productization: remove any deployment-only ambiguity around the PLM tenant served by `PLM_EMBED_DATA_SOURCE_ID`.
3. SSO or token exchange spine: upgrade the read-only embed token into a user/session bridge only after the read path is stable.
4. Large BOM and performance hardening: validate deep BOM trees, row counts, latency, and paging or streaming boundaries.
5. Collaboration fields: keep MetaSheet-owned fields independent from PLM authority fields.
6. Governed writeback: write PLM authority data only through explicit PLM-governed endpoints.
7. Permission synchronization: align PLM authority, MetaSheet collaboration visibility, and embed session scope.

The current production gate is item 1 only.

## 2. Required MetaSheet2 Configuration

Set these in the MetaSheet2 deployment that hosts the embedded BOM review UI.

| Setting | Required | Purpose | Readiness rule |
| --- | --- | --- | --- |
| `PRODUCT_MODE` / `ENABLE_PLM` | Yes | Enables `/api/plm-workbench` and `/api/plm-embed`. | PLM routes must be enabled in the target deployment. |
| `PLM_EMBED_ALLOWED_ORIGINS` | Yes | Single source for allowed PLM parent origins, backend `embed_origin` check, frontend parent-origin allowlist, and edge CSP value. | Explicit origins only. Never use `*`. |
| `PLM_EMBED_DATA_SOURCE_ID` | Yes | Server-bound PLM data source used by `/api/plm-embed/bom-review/context`. | Must identify the Yuantus PLM source for this deployment. Never accept source id from the iframe. |
| `PLM_EMBED_AUDIENCE` | Yes | Expected JWT `aud`. | Must match Yuantus token minting. Default is `metasheet2.embed`. |
| `YUANTUS_EMBED_PUBLIC_KEY` | Yes | Base64 raw Ed25519 public key for offline verification. | Public key only. Never configure a Yuantus private key in MetaSheet2. |
| `YUANTUS_EMBED_KEY_ID` | Yes | Expected key id for the configured public key. | Must match Yuantus minting key id. Default is `embed-1`. |
| `REDIS_URL` | Yes | Shared single-use `jti` consume store. | Required. No in-memory fallback is allowed. |

Current tenant configuration caveat:

- The embed relay compares `claims.tenant_id` to the tenant actually served by the configured PLM adapter: the final `x-tenant-id` header after `connect()`.
- This is the sound check. It intentionally does not compare against a lower-precedence fallback field.
- Today, REST/UI data-source configuration does not provide a clean nested `connection.headers` path for per-source tenant setup. REST-created sources normally inherit global PLM tenant configuration unless a source carries explicit tenant options.
- If #2418 lands, REST payloads can set `options.tenantId` / `options.orgId` for per-source tenant scope; the operator UI for that configuration remains a separate productization slice.
- If this deployment needs multiple PLM tenants in parallel, productize per-source tenant configuration as a separate slice before go-live.

## 3. Required Yuantus Configuration

The Yuantus deployment must provide:

- `bom_multitable` entitlement for the tenant being embedded.
- The BOM multitable projection endpoint.
- The integration capabilities manifest advertising `bom_multitable`.
- The embed-token mint endpoint.
- Ed25519 signing key configured only on Yuantus.
- The same audience value as MetaSheet2 `PLM_EMBED_AUDIENCE`.
- The same parent origin value that MetaSheet2 lists in `PLM_EMBED_ALLOWED_ORIGINS`.

The token must be scoped to:

- `feature_key = "bom_multitable"`
- `typ = "embed"`
- `aud = <MetaSheet2 embed audience>`
- `embed_origin = <allowed PLM parent origin>`
- `tenant_id = <Yuantus tenant>`
- `part_id = <Part to show>`
- finite `exp`
- non-empty `jti`

## 4. Edge CSP Requirement

MetaSheet2 exposes the desired frame policy through:

```text
GET /api/plm-embed/config
```

The response includes:

- `allowed_origins`
- `frame_ancestors`

Application code computes this value and fails closed to:

```text
frame-ancestors 'none'
```

The actual `Content-Security-Policy` header for the SPA HTML document must be set by the deployment edge or reverse proxy. Express does not set the SPA HTML CSP header for this route.

Production rule:

- Edge HTML response for `/plm-embed/bom-review` must include `Content-Security-Policy: frame-ancestors <explicit PLM origins>`.
- Do not use `*`.
- Do not rely only on iframe-side checks.

## 5. Preflight Checklist

Run these before customer UAT.

1. Confirm PLM routes are enabled.

   ```bash
   curl -fsS "$METASHEET_BASE_URL/api/plm-embed/config" | jq .
   ```

   Expected:

   - HTTP 200.
   - `data.allowed_origins` is non-empty.
   - No entry is `*`.
   - `data.frame_ancestors` contains only explicit PLM origins.

2. Confirm Redis is reachable from the MetaSheet2 runtime.

   ```bash
   redis-cli -u "$REDIS_URL" PING
   ```

   Expected:

   ```text
   PONG
   ```

   If Redis is down on first embed use, the embed path fails closed with 503 until the MetaSheet2 process is restarted after Redis is restored.

3. Confirm the configured data source serves the expected tenant.

   - `PLM_EMBED_DATA_SOURCE_ID` points to the intended Yuantus source.
   - The adapter's served `x-tenant-id` matches the Yuantus token `tenant_id`.
   - Do not treat a UI fallback field as authoritative.

4. Confirm Yuantus token minting.

   - Mint a token for a known entitled tenant and Part.
   - Decode without logging the token itself.
   - Confirm `aud`, `feature_key`, `embed_origin`, `tenant_id`, `part_id`, `exp`, and `jti`.

5. Smoke the embed data route with a one-time token.

   Store the token in a local secure temp file or secret manager reference. Do not put it in a URL.

   ```bash
   curl -fsS \
     -H "X-PLM-Embed-Token: $(cat /secure/plm-embed-token.txt)" \
     "$METASHEET_BASE_URL/api/plm-embed/bom-review/context" | jq .
   ```

   Expected:

   - HTTP 200 for a valid first use.
   - `data.available = true`.
   - `data.part_id` matches the token-bound part.
   - `data.context` is present for an entitled part with a readable BOM.

6. Confirm replay rejection.

   Re-run the exact same curl with the same token.

   Expected:

   - HTTP 401.
   - Error code `EMBED_TOKEN_REPLAYED`.

7. Confirm browser smoke.

   - Open the PLM parent page.
   - Parent mints a token after checking entitlement.
   - Parent loads `/plm-embed/bom-review` in an iframe.
   - Parent sends `postMessage({ type: "plm-embed:token", token }, <metasheet-origin>)` after iframe load, with retry.
   - The iframe renders the read-only BOM review table.

## 6. Failure Triage

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `/api/plm-embed/config` returns empty `allowed_origins` | `PLM_EMBED_ALLOWED_ORIGINS` missing or only `*`. | Set explicit PLM origins and redeploy. |
| Iframe stays on `awaiting-token` | Parent did not post token, posted too early without retry, posted from an unallowed origin, or used wrong target origin. | Check parent postMessage timing and exact origin. |
| Iframe shows `not-configured` | Allowlist is empty after fail-closed filtering. | Fix `PLM_EMBED_ALLOWED_ORIGINS`. |
| Iframe shows transient error after token was accepted | The single-use token was already consumed before a provider degradation. | Reopen or reload from PLM so the parent mints and posts a new token. Do not retry the old token. |
| API returns 401 `EMBED_TOKEN_REQUIRED` | Embed token header missing. | Ensure the parent posts a token and the iframe sends it on embed API calls. |
| API returns 401 `INVALID_EMBED_TOKEN` | Malformed, expired, wrong audience, wrong type, missing `jti`, or bad signature. | Re-mint token. Check public key, key id, audience, clocks, and JWT claims. |
| API returns 401 `EMBED_TOKEN_REPLAYED` | Same token reused. | Re-mint token from PLM. |
| API returns 403 `EMBED_FEATURE_MISMATCH` | Token is for a different feature. | Mint with `feature_key = "bom_multitable"`. |
| API returns 403 `EMBED_ORIGIN_NOT_ALLOWED` | Token `embed_origin` is not in `PLM_EMBED_ALLOWED_ORIGINS`. | Align Yuantus mint config and MetaSheet2 allowlist. |
| API returns 403 `EMBED_TENANT_MISMATCH` | Token tenant differs from the tenant actually served by `PLM_EMBED_DATA_SOURCE_ID`. | Fix token tenant or data-source tenant. Do not bypass this check. |
| API returns 503 `embed verification not configured` | `YUANTUS_EMBED_PUBLIC_KEY` missing or invalid. | Set the public key and matching `YUANTUS_EMBED_KEY_ID`, then redeploy. |
| API returns 503 `embed replay store unavailable` | Redis unavailable or first Redis connection failed and was memoized null. | Restore Redis and restart MetaSheet2 if first connect failed. |
| API returns 503 `embed data source not configured` | `PLM_EMBED_DATA_SOURCE_ID` missing. | Set data source id and redeploy. |
| API returns 503 `embed data source unsupported` | `PLM_EMBED_DATA_SOURCE_ID` points at a source kind that cannot serve Yuantus PLM embed reads. | Point `PLM_EMBED_DATA_SOURCE_ID` at the Yuantus PLM source. |
| API returns 503 `embed data source unavailable` | Data source missing or cannot connect. | Check data source id, Yuantus URL, credentials, network, and PLM availability. |
| Browser navigates to login on embed failure | Embed API call is not using the embed service path or suppression option. | Use `/plm-embed/bom-review`; token-bound service calls suppress session-login redirects. |

## 7. Rollback and Disablement

Fast fail-closed options:

1. Remove the PLM parent entry point so customers stop opening the iframe.
2. Remove `PLM_EMBED_ALLOWED_ORIGINS` or set it empty. The iframe will not accept parent tokens and `/config` will fail closed.
3. Remove `PLM_EMBED_DATA_SOURCE_ID`. The data route returns 503.
4. Disable PLM mode for deployments that should not expose PLM routes.

Do not disable Redis as a rollback unless you intentionally want all embed data calls to fail closed with 503.

Standalone PLM workbench read-only capability discovery is separate from the token-bound embed route. Verify whether the customer depends on standalone workbench access before disabling broader PLM mode.

## 8. Signoff Checklist

Record the evidence before go-live:

- [ ] `PRODUCT_MODE` / `ENABLE_PLM` enables PLM routes.
- [ ] `PLM_EMBED_ALLOWED_ORIGINS` contains explicit PLM origin(s), no `*`.
- [ ] Edge CSP for `/plm-embed/bom-review` uses explicit `frame-ancestors`.
- [ ] `PLM_EMBED_DATA_SOURCE_ID` points to the intended Yuantus source.
- [ ] Served tenant equals Yuantus token `tenant_id`.
- [ ] `PLM_EMBED_AUDIENCE` matches Yuantus minting.
- [ ] `YUANTUS_EMBED_PUBLIC_KEY` and `YUANTUS_EMBED_KEY_ID` match Yuantus signing config.
- [ ] Redis `PING` succeeds from the runtime environment.
- [ ] Valid first-use token renders a BOM review.
- [ ] Reusing the same token returns 401 `EMBED_TOKEN_REPLAYED`.
- [ ] Wrong origin returns 403.
- [ ] Wrong tenant returns 403 and does not query BOM.
- [ ] Parent postMessage uses the MetaSheet2 iframe origin as `targetOrigin`, not `*`.
- [ ] No PLM authority writeback is exposed from the embed view.

## 9. Evidence Template

```text
Customer / environment:
MetaSheet2 build:
Yuantus build:
MetaSheet2 origin:
PLM parent origin:
Data source id:
Served tenant:
Audience:
Redis check:
Config endpoint check:
CSP header check:
Happy-path token id / jti hash reference:
Replay rejection evidence:
Wrong-origin evidence:
Wrong-tenant evidence:
Operator:
Date:
```

Do not paste raw embed tokens, private keys, Redis URLs with credentials, or customer BOM data into the evidence record.
