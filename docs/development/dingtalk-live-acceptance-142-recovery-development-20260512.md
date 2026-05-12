# DingTalk Live Acceptance 142 Recovery Development - 2026-05-12

## Summary

This closeout slice restored the 142 main MetaSheet runtime and advanced the
DingTalk P4 live acceptance flow from blocked to `manual_pending`.

The key change was operational rather than product-code: the latest `main`
checkout on 142 already pointed to the intended GHCR tag, but the main
`metasheet-backend` and `metasheet-web` containers were not present/running.
After confirming Postgres and Redis were healthy, the main app containers were
started from the current immutable image tag.

## Scope

- Verified latest 142 repository HEAD: `b88f6c243ce882c65dc794c188e8d0e677f6cb64`.
- Confirmed 142 `.env` uses `IMAGE_TAG=b88f6c243ce882c65dc794c188e8d0e677f6cb64`.
- Started missing main runtime containers with `docker compose -f docker-compose.app.yml up -d backend web`.
- Verified backend/web containers are running from the expected GHCR images.
- Created local SSH tunnels for acceptance execution:
  - `127.0.0.1:18081 -> 142:127.0.0.1:8081` for web/API-through-nginx checks.
  - `127.0.0.1:18090 -> 142:127.0.0.1:8900` for direct backend checks.
- Generated a new local 72h app-admin JWT because the existing local admin token files returned `401`.
- Saved and validated the DingTalk work-notification Agent ID using the admin helper.
- Sent a real DingTalk work notification to the configured recipient using the saved Agent ID.
- Ran DingTalk P4 release readiness with the live private env, ops regression profile, and real smoke bootstrap.

## Runtime Findings

Before recovery:

- SSH to 142 succeeded.
- `metasheet-postgres` and `metasheet-redis` were running and healthy.
- `metasheet-backend` and `metasheet-web` were absent from `docker compose ps -a`.
- Public `http://142.171.239.56:8081` returned an empty reply from this Codex environment.

After recovery:

- `metasheet-backend` is running from `ghcr.io/zensgit/metasheet2-backend:b88f6c243ce882c65dc794c188e8d0e677f6cb64`.
- `metasheet-web` is running from `ghcr.io/zensgit/metasheet2-web:b88f6c243ce882c65dc794c188e8d0e677f6cb64`.
- 142-local `127.0.0.1:8081/` returns the web app.
- 142-local `127.0.0.1:8081/api/health` returns backend health through nginx.
- 142-local `127.0.0.1:8900/health` returns backend health directly.

The public-IP empty-reply behavior from this Codex host remains a network-path
observation, so live automation used SSH tunnels. The DingTalk message links
still use the configured public 142 base URL for phone/client validation.

## DingTalk Acceptance State

Work-notification Agent ID:

- Admin helper status before save: available.
- Save operation: PASS.
- Access-token validation: PASS.
- Real DingTalk notification send to configured recipient: PASS.
- Agent ID value was not printed.

P4 live smoke:

- Env readiness: PASS.
- Ops regression gate: PASS.
- API bootstrap: PASS.
- Delivery history for group/person sends: PASS.
- Overall smoke status: `manual_pending`.
- Current session directory: `output/dingtalk-p4-remote-smoke-session/142-live-20260512-token`.

Automated checks completed:

- `create-table-form`: PASS.
- `bind-two-dingtalk-groups`: PASS.
- `set-form-dingtalk-granted`: PASS.
- `delivery-history-group-person`: PASS.

Manual evidence still required:

- `send-group-message-form-link`.
- `authorized-user-submit`.
- `unauthorized-user-denied`.
- `no-email-user-create-bind`.

## Non-Goals

- No product-code change was made in this slice.
- No database schema change was made.
- No webhook, SEC secret, JWT, app secret, or temporary password was written to
  tracked documentation.
- The DingTalk OAuth Stability Lite Alertmanager webhook secret remains a
  separate ops input gap because no supported Slack/Alertmanager webhook secret
  is available locally or in GitHub Actions secrets.

## Next Steps

1. Capture current-session DingTalk mobile/client evidence for the four manual
   checks listed above.
2. Save screenshots or redacted artifacts under
   `output/dingtalk-p4-remote-smoke-session/142-live-20260512-token/workspace/artifacts/<check-id>/`.
3. Record each check with `scripts/ops/dingtalk-p4-evidence-record.mjs`.
4. Run strict finalize and final closeout after all four manual checks pass.
5. Configure a supported Alertmanager webhook secret separately, then rerun
   `DingTalk OAuth Stability Recording (Lite)` until `HEALTHY=true`.
