# DingTalk default-off staging smoke checklist

**Date:** 2026-07-08

**Status:** CHECKLIST only. No staging run recorded here. Companion to the
`docker/app.staging.env.example` hygiene pass (DT-HARDEN-11) and roadmap
§6.10 (`dingtalk-sync-integrated-roadmap-20260708.md`).

**Why:** the four features below are all default-off (flag or unset secret).
Unit tests exercise the enabled and disabled code paths in isolation, but a
real deploy can still ship with a feature silently mis-wired end to end (env
key not passed through compose, wrong corp/agent id, etc.). Run each check
once per deploy that changes DingTalk-related env or code, before signing
off the release.

## 1. E1 container login (`DINGTALK_CONTAINER_LOGIN_ENABLED`)

**2026-10-25 source correction; Draft/HOLD, planned checks only.** Source baseline
`8a426818804897a20f7674c39c56b3a445909c3a`. No live smoke was run;
historical 08am evidence remains inconclusive. This correction does not authorize
deployment, config/flag changes, R71, tag/release or signoff. Stream/lifecycle
remain OFF. Real UAT and business `50004` are excluded. Other sections remain
historical planned checks, not execution authority.

Source chain (paths under `packages/core-backend/`):
`src/index.ts` mounts `authRouter` at `/api/auth`; `src/routes/auth.ts` registers
`authRouter.post('/login/dingtalk/container', ...)`. Use
**`POST /api/auth/login/dingtalk/container`**, JSON body `{"authCode":"<single-use-code>"}`.
`src/auth/api-path-policy.ts` declares this path as an **exact** global JWT
exception; `src/auth/jwt-middleware.ts` delegates `isWhitelisted` to that policy.
No existing session JWT, admin role, OAuth state or nonce is required to reach E1.
Use ordinary POST with `Content-Type: application/json`, valid JSON and no
method-override header: parser/transport/override refusals precede the handler.

The old `POST /auth/dingtalk/container` is not the mounted endpoint.
`POST /api/auth/dingtalk/container` is not an alias: without a Bearer token,
the global gate returns HTTP 401 with
`{"ok":false,"error":{"code":"UNAUTHORIZED","message":"Missing Bearer token"}}`.
Neither that refusal nor a generic proxy/Express 404 proves E1 is disabled.

- [ ] **Planned default-OFF check**, only in a separately owner-authorized staging
  window with the flag already unset/`false`. The flag gate precedes authCode
  validation, rate limiting and exchange: `{}` must yield HTTP **404**, exactly
  `{"success":false,"error":"DingTalk container login is not enabled","code":"container_login_disabled"}`.

  Runnable example (no JWT header). Supply the approved base URL privately.
  Output is only an exact-contract comparison, never raw response values:

  ```bash
  (
    set -o pipefail
    transport_rc=0
    response="$(curl --silent --connect-timeout 5 --max-time 15 \
      --request POST "${STAGING_BASE_URL:?set approved base URL privately}/api/auth/login/dingtalk/container" \
      --header 'Content-Type: application/json' --data '{}' --write-out '\n%{http_code}')" || transport_rc=$?
    printf '%s\n%s' "$response" "$transport_rc" \
      | python3 artifacts/attendance-ops-doc-closeout-20261025/e1_response_filter.py default-off
  )
  ```

- [ ] **Planned enabled checks — HOLD**, needing separate owner approval,
  already-approved OAuth config, corp scope and synthetic account/grant policy.
  Do not enable the flag for this correction. Operator spelling stays exact
  `true`; existing E1 source accepts trimmed, case-folded `true`/`1`/`yes`
  (E1 lock §6). Unset/`false` stays OFF; do not infer strict parsing from other flags.
  When already enabled, `{}` (or absent/non-string/blank authCode) returns
  HTTP **400**, exactly
  `{"success":false,"error":"Missing required parameter: authCode"}` — **no code field**,
  without outbound exchange. A real code is trimmed, rate-limited per IP, then
  passed to `exchangeEnterpriseAuthCodeForUser` → `readDingTalkOauthConfig()` →
  app token/getuserinfo/user detail → private `resolveLocalUser` →
  permissions/session token. Config still requires client ID/secret (or app
  aliases) and redirect URI. Corp allowlist, account activation, grant,
  association and auto-provision gates still apply; keep auto-provision OFF.

  For a separately approved single login, the hidden prompt keeps the code out
  of shell history/argv. Never save the raw response. Output checks only the envelope:

  ```bash
  (
    set -o pipefail
    transport_rc=0
    response="$(python3 -c 'import getpass,json; print(json.dumps({"authCode":getpass.getpass("Single-use code: ")}))' \
      | curl --silent --connect-timeout 5 --max-time 30 \
          --request POST "${STAGING_BASE_URL:?set approved base URL privately}/api/auth/login/dingtalk/container" \
          --header 'Content-Type: application/json' --data-binary @- --write-out '\n%{http_code}')" || transport_rc=$?
    printf '%s\n%s' "$response" "$transport_rc" \
      | python3 artifacts/attendance-ops-doc-closeout-20261025/e1_response_filter.py login
  )
  ```

  The local filter emits `default_off_contract_match` or `login_envelope_match`
  plus bounded numeric HTTP status/transport exit, an allowlisted code, boolean
  retryability and numeric retryAfter (0–86400 seconds; otherwise null). It never
  prints messages, identities or tokens. A nonzero curl **or prompt pipeline** exit
  prevents success even if the complete expected JSON/status arrived. The subshell
  preserves pipeline failures without changing caller shell options. JSON numeric
  `0`/`1` are not accepted as the required boolean `false`/`true`.

  HTTP **200** is `{success:true,data:{mode:"login",user:{id,email,name,role,permissions},token,features}}`;
  `features` comes from `buildFeaturePayload(user)`. E1 has no `redirectPath`
  (the web OAuth callback does). Envelope match alone is not business acceptance.

Current handler failures (source contract; do not induce live failures here):

| Condition | HTTP | JSON body / code location |
| --- | --- | --- |
| Per-IP limiter denies before exchange | 429 | `{success:false,error:"Too many login attempts. Please try again later.",retryAfter:<seconds>}`; no `code` |
| `DingTalkBusinessError` (any provider business rejection, not only expired codes) | 401 | `{"success":false,"error":"DingTalk rejected the container auth code","code":"invalid_auth_code"}`; distinct from the JWT refusal |
| `DingTalkLoginPolicyError` | Carried `statusCode` | `{success:false,error:<policy message>,code:<policy code>}`; e.g. 403 `grant_required` / `grant_disabled` / `local_user_disabled` / `unlinked_enabled_local_user` / `unlinked_local_user`, 409 `identity_ambiguous`, 503 `grant_state_unavailable`, 502 `identity_key_unavailable`; not uniformly 403 |
| Classified recovery conflict (`sendIfRecoveryConflict` → `jsonError`) | 409 | `{"ok":false,"error":{"code":"RECOVERY_AUTHORITY_BUSY","message":"Recovery is stabilizing permissions; retry this change.","details":{"retryable":true}}}`; nested `error.code`, not E1's usual top-level `code` |
| `DingTalkRequestError` | 502 | `{success:false,error:"DingTalk authentication failed: DingTalk answered with an error status (HTTP <numeric upstream status>)"}`; numeric suffix omitted if unavailable; no `code` or provider message |
| Other exceptions | 500 | `{"success":false,"error":"DingTalk authentication failed"}`; no `code`. Includes missing OAuth config and `DingTalkCorpNotAllowedError`: the corp gate rejects, but E1 does **not** translate that class's own 403/code to HTTP 403/code |

Policy messages can contain identity values. Evidence retains only status,
code, counts and comparison booleans; never raw bodies, tokens, auth codes,
identities, hosts or config values. Do not retry a consumed/ambiguous code;
a new authorized attempt needs a fresh code.

References: [E1 lock §§1,4,6](attendance-e1-container-login-design-lock-20260706.md),
[historical E1 verification](attendance-e1-container-login-verification-20260707.md),
[DT-HARDEN-01 wire correction](dingtalk-sync-hardening-design-and-verification-20260708.md#31-dt-harden-01--e1-container-login-wire).
These do not establish a current staging run. Offline snapshot check:

```bash
python3 artifacts/attendance-ops-doc-closeout-20261025/check_e1_source_contract.py
```

This stdlib check compares documented anchors and reviewed source slices, with
in-memory failure probes; it is not TypeScript execution or live smoke.

## 2. Work notification (`DINGTALK_AGENT_ID` / `DINGTALK_NOTIFY_AGENT_ID`)

- [ ] With both unset: a triggered work-notification send fails closed with
  `DINGTALK_AGENT_ID, DINGTALK_NOTIFY_AGENT_ID, or directory
  workNotificationAgentId is not configured` (no silent no-op).
- [ ] With one of the two set: a real work notification is delivered to a
  test DingTalk user via the configured agent.

## 3. Approval card (`APPROVAL_CARD_LINK_SECRET`, `PUBLIC_APP_URL`)

- [ ] With the secret and public URL unset (and no stored per-directory
  secret/URL): the approval-card send action fails with the documented
  `APPROVAL_CARD_LINK_SECRET (...) is required` / `PUBLIC_APP_URL or
  APP_BASE_URL (...) is required` error — not a silently unsigned link.
- [ ] With both configured: an approval triggers a card whose decision deep
  link resolves through `$PUBLIC_APP_URL` and validates its HMAC signature
  on click-through.

## 4. Directory sync

- [ ] A manual sync run against a real DingTalk corp (`DINGTALK_CORP_ID`,
  `DINGTALK_ALLOWED_CORP_IDS` containing it) completes and reflects
  department/user changes in the local directory.
- [ ] A sync attempt against a corp NOT in `DINGTALK_ALLOWED_CORP_IDS` is
  rejected (`DingTalkCorpNotAllowedError`) — confirms the allowlist fence is
  live before trusting auto-provision or sync writes.

## Notes

- `DINGTALK_ALLOWED_CORP_IDS` empty means allow-ALL corp ids (see
  `runtime-policy.ts`). Do not enable `DINGTALK_AUTH_AUTO_PROVISION` on a
  deploy where this checklist has not confirmed the allowlist is populated.
- This checklist does not gate a release by itself; treat it as a manual
  operator pass alongside the existing attendance staging-smoke runbooks.
