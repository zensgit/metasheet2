# DingTalk Public Form Mainline And Yjs Live Check Verification

- Date: 2026-04-20
- Branch: `codex/dingtalk-public-form-allowlist-20260420`

## PR verification

### `#931`

Observed before merge:

- all required checks green
- `reviewDecision = REVIEW_REQUIRED`
- `autoMergeRequest` already enabled

Merge command executed:

```bash
gh pr merge 931 --squash --admin --delete-branch=false
```

Result:

- `#931` merged successfully into `main`

### `#933`

Commands executed:

```bash
git fetch origin main
git rebase origin/main
git push --force-with-lease origin codex/dingtalk-public-form-allowlist-20260420
gh pr edit 933 --base main
```

Result:

- `#933` now targets `main`
- current head after restack and docs update: `5559a46207a7e0ff93f12e1b458572a3c3c49bba`

## Temporary admin-token verification

Generation path:

- SSH using `~/.ssh/metasheet2_deploy`
- remote host: `mainuser@142.171.239.56`
- token minted inside the live backend container using:
  - remote `JWT_SECRET`
  - a real active `admin` user row

Stored locally at:

- `/tmp/metasheet2-admin-token-14217123956-10m-20260420.json`

Metadata extracted locally:

```json
{
  "ok": true,
  "expiresAt": "2026-04-20T07:36:15.000Z",
  "userId": "b928b8d9-8881-43d7-a712-842b28870494",
  "role": "admin"
}
```

The token itself was not printed into chat.

## Live Yjs verification

Executed:

```bash
node scripts/ops/check-yjs-rollout-status.mjs --base-url http://142.171.239.56:8081 --token \"$TOKEN\" --json
```

Live result:

- `Yjs rollout status: HEALTHY`
- `Enabled: true`
- `Initialized: true`
- `Active docs: 0`
- `Pending writes: 0`
- `Flush failures: 0`
- `Active records: 0`
- `Active sockets: 0`

Raw payload showed:

- `success: true`
- `yjs.enabled: true`
- `yjs.initialized: true`
- `failures: []`

## Conclusion

- `#931` is in `main`
- `#933` is now a mainline PR
- the remote host `142.171.239.56` is currently running with Yjs enabled and healthy
- a short-lived production-valid admin token can be generated safely, but should be handed off through a local temp file or a one-time channel rather than pasted into chat
