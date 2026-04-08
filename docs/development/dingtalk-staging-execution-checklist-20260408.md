# DingTalk Staging Execution Checklist

Date: 2026-04-08
Scope: shortest execution checklist for the staged rollout of `#725`, `#723`, and `#724`

## Inputs required from the tenant owner

- DingTalk app credentials:
  - `DINGTALK_CLIENT_ID` or `DINGTALK_APP_KEY`
  - `DINGTALK_CLIENT_SECRET` or `DINGTALK_APP_SECRET`
  - `DINGTALK_REDIRECT_URI`
  - `DINGTALK_CORP_ID` if used by the tenant
- one staging login user in DingTalk
- one staging org subtree for directory sync
- one staging attendance sample range
- one staging DingTalk group robot webhook

## Environment decisions to lock before testing

- whether `DINGTALK_AUTH_AUTO_LINK_EMAIL` stays enabled
- whether `DINGTALK_AUTH_AUTO_PROVISION` stays disabled for staging
- the exact callback domain registered in DingTalk

## Execution order

1. Deploy `#725`, `#723`, and `#724` together to staging.
2. Verify DingTalk login once end-to-end.
3. Verify directory credential test and one manual sync.
4. Verify one attendance dry-run sync, then one real sync.
5. Verify one DingTalk robot notification send.
6. Re-run attendance once to confirm stable repeat behavior.
7. Record any tenant-specific config adjustments before changing the PRs from draft.

## Pass criteria

- login completes and returns a normal MetaSheet session
- directory sync completes with usable run stats
- attendance sync returns success or partial with explainable `partialErrors`
- failed attendance runs do not stay in `running`
- DingTalk robot messages arrive once and non-retryable `HTTP 400` failures are not retried

## Stop conditions

- callback URI mismatch
- disabled or wrongly linked DingTalk user blocks login
- directory sync duplicates or drops obvious accounts/departments
- attendance sync leaves a run stuck in `running`
- robot webhook retries a non-retryable 4xx response

## Related docs

- `docs/development/dingtalk-stack-merge-readiness-20260408.md`
- `docs/development/dingtalk-live-tenant-validation-checklist-20260408.md`
