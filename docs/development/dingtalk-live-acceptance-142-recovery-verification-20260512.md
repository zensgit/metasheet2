# DingTalk Live Acceptance 142 Recovery Verification - 2026-05-12

## Summary

Verification confirms that 142 main runtime was restored, the DingTalk
work-notification Agent ID path works with a real send, and DingTalk P4 live
acceptance has advanced to the expected manual-evidence stage.

Final status for this slice: `manual_pending`, not `closed`.

## Environment

- Repo/worktree: `/tmp/metasheet2-dingtalk-live-acceptance-20260512`.
- Main SHA on 142: `b88f6c243ce882c65dc794c188e8d0e677f6cb64`.
- Backend image: `ghcr.io/zensgit/metasheet2-backend:b88f6c243ce882c65dc794c188e8d0e677f6cb64`.
- Web image: `ghcr.io/zensgit/metasheet2-web:b88f6c243ce882c65dc794c188e8d0e677f6cb64`.
- Token delivery: local `0600` file, validated by `/api/auth/me`.
- Secret policy: all webhook, SEC, JWT, bearer, app secret, and password values
  were kept out of tracked files and command summaries.

## Commands And Results

### 142 Runtime Recovery

Command:

```bash
ssh -i ~/.ssh/metasheet2_deploy mainuser@142.171.239.56 \
  'cd /home/mainuser/metasheet2 && docker compose -f docker-compose.app.yml up -d backend web'
```

Result:

- `metasheet-backend` created and started.
- `metasheet-web` created and started.
- Postgres and Redis dependencies were already healthy.

Runtime check:

```bash
ssh -i ~/.ssh/metasheet2_deploy mainuser@142.171.239.56 \
  'docker ps --format "{{.Names}} {{.Image}} {{.Status}} {{.Ports}}" | grep -E "metasheet-(backend|web|postgres|redis)"'
```

Observed:

- `metasheet-web` running on `0.0.0.0:8081->80/tcp`.
- `metasheet-backend` running on `127.0.0.1:8900->8900/tcp`.
- `metasheet-postgres` healthy.
- `metasheet-redis` healthy.

### Health Checks

Direct 142-local backend health through SSH tunnel:

```bash
curl -fsS --max-time 15 http://127.0.0.1:18090/health
```

Result:

- HTTP 200.
- `status=ok`.
- `plugins=13`.
- `failed=0`.

142-local nginx/backend path checked over SSH:

```bash
curl -sS -i --max-time 10 http://127.0.0.1:8081/api/health
```

Result:

- HTTP 200.
- Backend health JSON returned through nginx.

Note:

- Public `http://142.171.239.56:8081` returned empty replies from this Codex
  network path after recovery. The server-local checks pass, and the smoke run
  used SSH tunnels for API automation.

### Admin Token

Existing local token files:

```bash
curl -H "Authorization: Bearer <redacted>" http://127.0.0.1:18081/api/auth/me
```

Result:

- `~/.config/metasheet/admin-token`: HTTP 401.
- `~/.config/yuantus/dingtalk-admin-token`: HTTP 401.

New local 72h admin JWT:

```bash
/tmp/metasheet-142-main-admin-72h-20260512T083235Z.jwt
/tmp/metasheet-142-main-admin-72h.jwt
```

Result:

- File permission: `0600`.
- `/api/auth/me`: HTTP 200.
- User: `zhouhua@china-yaguang.com`.
- Role: `admin`.
- `plm=true`.

### DingTalk Work Notification Agent ID

Command:

```bash
node scripts/ops/dingtalk-work-notification-admin-agent-id.mjs \
  --api-base http://127.0.0.1:18081 \
  --auth-token-file /tmp/metasheet-142-main-admin-72h.jwt \
  --agent-id-file ~/.config/yuantus/dingtalk-agent-id \
  --save \
  --output-json output/dingtalk-live-acceptance/work-notification-agent-save.json \
  --output-md output/dingtalk-live-acceptance/work-notification-agent-save.md
```

Result:

- Overall: PASS.
- Status before: configured and available.
- Access token verified: yes.
- Save result: saved.
- Status after: available.
- Agent ID value printed: no.

Real send command:

```bash
node scripts/ops/dingtalk-work-notification-admin-agent-id.mjs \
  --api-base http://127.0.0.1:18081 \
  --auth-token-file /tmp/metasheet-142-main-admin-72h.jwt \
  --agent-id-file ~/.config/yuantus/dingtalk-agent-id \
  --recipient-user-id-file ~/.config/yuantus/dingtalk-recipient-user-ids \
  --output-json output/dingtalk-live-acceptance/work-notification-real-send.json \
  --output-md output/dingtalk-live-acceptance/work-notification-real-send.md
```

Result:

- Overall: PASS.
- Recipient provided: yes.
- Access token verified: yes.
- DingTalk notification sent: yes.
- Failures: none.

### P4 Release Readiness And Live Smoke

Command:

```bash
node scripts/ops/dingtalk-p4-release-readiness.mjs \
  --p4-env-file /tmp/dingtalk-p4-live-acceptance-backend-tunnel-token.env \
  --regression-profile ops \
  --run-smoke-session \
  --smoke-output-dir output/dingtalk-p4-remote-smoke-session/142-live-20260512-token \
  --smoke-timeout-ms 120000 \
  --output-dir output/dingtalk-p4-release-readiness/142-live-20260512-token \
  --timeout-ms 120000
```

Result:

- Overall: `manual_pending`.
- Env readiness: PASS.
- Ops regression gate: PASS.
- Preflight: PASS.
- API runner: PASS.
- Non-strict compile: PASS.
- Status report: PASS.
- Remote TODO progress: `4/8`.

Completed checks:

- `create-table-form`: PASS.
- `bind-two-dingtalk-groups`: PASS.
- `set-form-dingtalk-granted`: PASS.
- `delivery-history-group-person`: PASS.

Pending manual checks:

- `send-group-message-form-link`.
- `authorized-user-submit`.
- `unauthorized-user-denied`.
- `no-email-user-create-bind`.

Evidence recorder templates are available in:

```bash
output/dingtalk-p4-remote-smoke-session/142-live-20260512-token/smoke-todo.md
```

## Earlier Failed Attempts And Fixes

- First Agent ID status check failed with `fetch failed` because public
  `http://142.171.239.56:8081` was not usable from this Codex network path.
- First P4 smoke attempt failed because API base pointed at nginx/web and
  `/health` returned SPA HTML instead of backend JSON.
- Second P4 smoke attempt failed because the env file still contained an
  expired admin token.
- Final P4 smoke attempt used direct backend tunnel plus refreshed admin token
  and reached `manual_pending`.

## Remaining Acceptance Work

The following cannot be honestly marked PASS without current-session manual
evidence:

- DingTalk group message screenshot or equivalent redacted artifact showing the
  generated smoke message/link.
- Authorized DingTalk user opens and submits the current-session protected form.
- Unauthorized DingTalk user is denied, with zero record insert delta.
- No-email DingTalk user is created/bound in admin flow and remains linked after
  refresh.

After recording those four artifacts:

```bash
node scripts/ops/dingtalk-p4-smoke-session.mjs \
  --finalize output/dingtalk-p4-remote-smoke-session/142-live-20260512-token

node scripts/ops/dingtalk-p4-final-closeout.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-live-20260512-token \
  --date 20260512
```

## Conclusion

142 runtime recovery and DingTalk automated live acceptance are complete for
this slice. Full DingTalk P4 closeout remains blocked only by the four
current-session manual evidence items listed above and the separate
Alertmanager webhook secret ops gap.
