# DingTalk Public Form Mainline And Yjs Live Check Development

- Date: 2026-04-20
- Branch: `codex/dingtalk-public-form-allowlist-20260420`

## Scope

This round focused on operational progression rather than new product code:

1. promote the protected public-form hotfix PR into `main`
2. restack the allowlist PR directly onto `main`
3. perform a live Yjs status check against `142.171.239.56`
4. generate a short-lived admin token through the running remote backend environment, without exposing the token in chat

## Mainline progression

### `#931` merged

Pull request [#931](https://github.com/zensgit/metasheet2/pull/931) was merged into `main` via:

```bash
gh pr merge 931 --squash --admin --delete-branch=false
```

### `#933` restacked onto `main`

After `#931` landed, the allowlist PR no longer needed to target the old stacked base.

This round:

- rebased `codex/dingtalk-public-form-allowlist-20260420` onto `origin/main`
- force-pushed the rebased branch
- changed [#933](https://github.com/zensgit/metasheet2/pull/933) to base on `main`

## Temporary admin-token workflow

The token workflow was intentionally handled as an operations-only action:

- connect to the live host with the existing deploy SSH key
- execute a one-off Node script inside the running backend container
- query a currently active `admin` user from the remote database
- sign a JWT with the live `JWT_SECRET`
- set `expiresIn: '10m'`
- write the resulting token JSON to a local temp file with `0600` permissions

This avoided:

- exposing the token in chat history
- hard-coding a long-lived credential
- using a local/dev secret that would not match production

## Yjs live check

The freshly generated short-lived token was then used to run:

```bash
node scripts/ops/check-yjs-rollout-status.mjs --base-url http://142.171.239.56:8081 --token \"$TOKEN\" --json
```

That produced a live, current remote answer instead of relying only on the earlier `r4` rollout evidence.

## Claude Code CLI

This round also used Claude Code CLI in read-only mode to confirm the safest user-facing guidance for temporary admin-token handoff. The implementation and remote checks were still executed directly.
