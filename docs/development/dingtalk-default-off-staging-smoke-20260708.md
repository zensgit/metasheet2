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

- [ ] With the flag unset/`false`: `POST /auth/dingtalk/container` returns
  `404 container_login_disabled`.
- [ ] With the flag `true` and a real in-container `authCode`: the route
  exchanges it for a session JWT via the same `resolveLocalUser` policy
  gates as web OAuth (corp allowlist from `DINGTALK_ALLOWED_CORP_IDS`
  applies here too).

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
