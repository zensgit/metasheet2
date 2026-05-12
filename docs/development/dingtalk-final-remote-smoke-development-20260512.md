# DingTalk Final Remote Smoke Development

Date: 2026-05-12

## Scope

This closeout documents the final DingTalk P4 live acceptance pass for the 142 deployment after the backend/web images were updated to the immutable `e40ac3f909a2c5cad5072bc0e75f351c89513d10` tag.

The goal was to close the remaining manual gates without committing raw secrets, webhook URLs, JWTs, temporary passwords, or screenshot originals.

## Implementation Notes

- Created a clean final smoke session for the current 142 image tag.
- Re-ran the P4 remote smoke bootstrap against 142 through an SSH tunnel to the backend API.
- Calibrated the no-email account target to the current `ddzz` DingTalk/local user state instead of reusing a stale external ID from an older session.
- Recorded user-provided DingTalk mobile screenshots as manual-client evidence for group message visibility, authorized submission, and unauthorized denial.
- Verified the no-email local user bind through the 142 database using the `users`, `user_external_identities`, and `user_external_auth_grants` truth sources.
- Stored only redacted admin evidence in the smoke artifact note; the temporary password was not printed or committed.
- Ran strict finalization and generated the evidence packet locally; raw artifacts remain outside Git for release-owner review.

## Smoke Session

- Session: `142-session-e40ac3f9-ddzz-20260512`
- Local session path: `/tmp/metasheet2-migration-provider-superseded-noop-20260512/output/dingtalk-p4-remote-smoke-session/142-session-e40ac3f9-ddzz-20260512`
- Local evidence packet path: `/tmp/metasheet2-migration-provider-superseded-noop-20260512/artifacts/dingtalk-staging-evidence-packet/142-session-e40ac3f9-ddzz-20260512-final`
- Final status: `release_ready`

## Completed Checks

| Check | Result | Evidence |
| --- | --- | --- |
| Create table and form view | PASS | API bootstrap created disposable base, sheet, field, and form view. |
| Bind two DingTalk groups | PASS | Two group destinations were created and test-send delivery rows were recorded. |
| Set `dingtalk_granted` form access | PASS | Form share was active and restricted to the allowed local user scope. |
| Send group message with form link | PASS | User-provided DingTalk screenshots showed A/B group cards and form entry; API delivery rows existed for the current session. |
| Authorized user submit | PASS | User-provided DingTalk screenshots showed form open and successful submission. |
| Unauthorized user denied | PASS | User-provided DingTalk screenshot showed the selected-user/member-group denial message; evidence recorded `submitBlocked=true` and `recordInsertDelta=0`. |
| Delivery history group/person | PASS | API delivery history contained group and person sends. |
| No-email account create/bind | PASS | 142 DB/admin verification confirmed `ddzz` has blank email, active local account, enabled DingTalk auth grant, and linked DingTalk identity. |

## Security Handling

- No webhook URL, `SEC` signing secret, JWT, bearer token, public form token, cookie, or temporary password was committed.
- The docs only reference local artifact paths and redacted evidence summaries.
- Raw screenshots are intentionally not committed in this docs-only closeout.

## Follow-up

- If the release owner wants auditable screenshot archival in Git, run the existing screenshot archive workflow separately with a redaction review first.
- The 142 deployment remains on the `e40ac3f909a2c5cad5072bc0e75f351c89513d10` runtime image while this docs-only closeout is reviewed.
