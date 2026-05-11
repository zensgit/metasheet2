# DingTalk Final Remote Smoke Verification

- Date: 20260511
- Generated at: 2026-05-11T05:46:54.814Z

## Commands

```bash
node scripts/ops/dingtalk-p4-smoke-status.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-live-20260510 \
  --handoff-summary artifacts/dingtalk-staging-evidence-packet/142-live-20260510-final/handoff-summary.json \
  --require-release-ready

node scripts/ops/validate-dingtalk-staging-evidence-packet.mjs \
  --packet-dir artifacts/dingtalk-staging-evidence-packet/142-live-20260510-final \
  --output-json artifacts/dingtalk-staging-evidence-packet/142-live-20260510-final/publish-check.json

node scripts/ops/dingtalk-p4-final-docs.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-live-20260510 \
  --handoff-summary artifacts/dingtalk-staging-evidence-packet/142-live-20260510-final/handoff-summary.json \
  --require-release-ready \
  --output-dir docs/development \
  --date 20260511
```

## Actual Results

- Required checks passed: 8/8
- Remaining checks: 0
- Manual evidence issues: 0
- Secret findings: 0
- Session status: **pass**
- Final strict status: **pass**
- Compiled status: **pass**
- API bootstrap status: **pass**
- Remote client status: **pass**
- Remote smoke phase: **finalize_pending**
- Smoke status: **release_ready**
- Handoff status: **pass**
- Publish status: **pass**

## Required Checks

| Doc | Step | Check | Status | Source | Evidence Snapshot | Manual Issues |
| --- | --- | --- | --- | --- | --- | --- |
| Smoke 1 | Create table and form view | `create-table-form` | pass | not_available | Redacted disposable base/sheet/form identifiers were created for the 142 smoke session. | 0 |
| Smoke 2 | Bind two DingTalk groups | `bind-two-dingtalk-groups` | pass | not_available | Two redacted DingTalk group destinations were bound and each produced one manual test delivery. | 0 |
| Smoke 1 | Set dingtalk_granted access | `set-form-dingtalk-granted` | pass | not_available | Form access mode was `dingtalk_granted`; one local user was allowlisted and no member group was required. | 0 |
| Smoke 3 | Send group message with form link | `send-group-message-form-link` | pass | manual-client | Real DingTalk A/B group screenshots showed protected form link delivery; group delivery count was 2. | 0 |
| Smoke 4 | Authorized user submit | `authorized-user-submit` | pass | manual-client | Authorized DingTalk-bound user opened the protected form and submitted successfully. | 0 |
| Smoke 5 | Unauthorized user denied | `unauthorized-user-denied` | pass | manual-client | Unauthorized DingTalk-bound user was blocked with zero record insertion. | 0 |
| Smoke 6 | Delivery history | `delivery-history-group-person` | pass | not_available | Delivery history contained two group deliveries and one person delivery. | 0 |
| Smoke 7 | No-email account create/bind | `no-email-user-create-bind` | pass | manual-admin | `ddzz` was created as an enabled no-email local user and linked to the synced DingTalk identity; temporary password redacted. | 0 |

## Failures

- None

## Evidence Hygiene

- This report is generated from redacted summaries and does not include raw tokens, full webhooks, cookies, public form tokens, or temporary passwords.
- Final raw artifacts still require human review before external sharing.
