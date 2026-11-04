# DingTalk default-off staging smoke checklist

**Date:** 2026-07-08

**Status:** CHECKLIST only. No staging run recorded here. Companion to the
`docker/app.staging.env.example` hygiene pass (DT-HARDEN-11) and roadmap
§6.10 (`dingtalk-sync-integrated-roadmap-20260708.md`). Corrected against
main `017e6956d3` on 2026-11-03; still not exercised.

**Why:** the four features below are all default-off (flag or unset secret).
Unit tests exercise the enabled and disabled code paths in isolation, but a
real deploy can still ship with a feature silently mis-wired end to end (env
key not passed through compose, wrong corp/agent id, etc.). Run each check
once per deploy that changes DingTalk-related env or code, before signing
off the release.

## 1. E1 container login (`DINGTALK_CONTAINER_LOGIN_ENABLED`)

- [ ] With the flag unset/`false`: `POST /api/auth/login/dingtalk/container` returns
  `404 container_login_disabled`.
- [ ] With the flag `true` and a real in-container `authCode`: the route
  exchanges it for a session JWT via the same `resolveLocalUser` policy
  gates as web OAuth (corp allowlist from `DINGTALK_ALLOWED_CORP_IDS`
  applies here too).

## 2. Work notification (`DINGTALK_AGENT_ID` / `DINGTALK_NOTIFY_AGENT_ID`)

- [ ] With both unset (`DINGTALK_AGENT_ID` empty or absent, the
  `DINGTALK_NOTIFY_AGENT_ID` alias left commented out) and no stored
  `workNotificationAgentId` on the integration: a triggered work-notification
  send fails closed with `DINGTALK_AGENT_ID, DINGTALK_NOTIFY_AGENT_ID, or
  directory workNotificationAgentId is not configured` (no silent no-op).
  Precondition: the app key/secret must resolve first (env or stored),
  otherwise `DINGTALK_APP_KEY or DINGTALK_CLIENT_ID is not configured` (or
  `DINGTALK_APP_SECRET or DINGTALK_CLIENT_SECRET is not configured`) is
  reported before the agent-id error.
- [ ] With `DINGTALK_AGENT_ID` set (the alias is only read when
  `DINGTALK_AGENT_ID` is empty or absent): a real work notification is
  delivered to a test DingTalk user via the configured agent.

## 3. Approval card (`APPROVAL_CARD_LINK_SECRET`, `PUBLIC_APP_URL`)

- [ ] With the public URL unset (env and stored): the approval-card send
  action fails with the documented `PUBLIC_APP_URL or APP_BASE_URL (...) is
  required` error. The send checks the URL first, then the approval instance,
  then the assignee's DingTalk binding, then the secret
  (`automation-executor.ts`), so the secret error cannot be observed while
  the URL is unset.
- [ ] With the public URL set, `APPROVAL_CARD_LINK_SECRET` blank in env, no
  stored per-integration secret, and the assignee linked to a DingTalk
  account with an active local user: the send fails with the documented
  `APPROVAL_CARD_LINK_SECRET (...) is required` error — not a silently
  unsigned link.
- [ ] With both configured: an approval triggers a card whose decision deep
  link resolves through `$PUBLIC_APP_URL` and validates its HMAC signature
  on click-through.

## 4. Directory sync

- [ ] A manual sync of a directory integration completes and reflects
  department/user changes in the local directory. The corp id is stored on
  the integration (directory sync does not read env `DINGTALK_CORP_ID`);
  `DINGTALK_ALLOWED_CORP_IDS` is checked when an integration is created,
  updated or tested.
- [ ] Creating, updating or testing a directory integration whose corpId is
  not in `DINGTALK_ALLOWED_CORP_IDS` is rejected: create/update → 400
  `DIRECTORY_CREATE_FAILED` / `DIRECTORY_UPDATE_FAILED` with the sentence
  `Directory integration corpId <id> is not allowed by
  DINGTALK_ALLOWED_CORP_IDS`; test → `DIRECTORY_TEST_FAILED` carrying the
  same sentence (`assertDingTalkCorpAllowed` is reached only from
  `normalizeIntegrationInput` in `directory-sync.ts`; sync and batch paths
  cannot raise it). Use a made-up `<id>` for the rehearsal; evidence never
  records a real corp id.

## Notes

- `DINGTALK_ALLOWED_CORP_IDS` empty means no corp-id check on login (see
  `runtime-policy.ts`). The code refuses auto-provision while the allowlist
  is empty (`dingtalk-oauth.ts`, DT-HARDEN-09); turning
  `DINGTALK_AUTH_AUTO_PROVISION` on is an owner decision.
- This checklist does not gate a release by itself; treat it as a manual
  operator pass alongside the existing attendance staging-smoke runbooks.
