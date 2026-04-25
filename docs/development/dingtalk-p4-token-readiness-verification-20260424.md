# DingTalk P4 Token Readiness Verification

- Date: 2026-04-24
- Branch: `codex/dingtalk-next-slice-20260423`
- Base commit: `e25381bbe`
- Result: pass for private token readiness; remote smoke remains blocked by remaining private inputs

## Commands

```bash
git status --short
git log -3 --oneline
/bin/zsh -lc "ssh -i ~/.ssh/metasheet2_deploy -o BatchMode=yes -o StrictHostKeyChecking=no mainuser@142.171.239.56 \"docker exec metasheet-backend node -e \\\"const jwt=require('jsonwebtoken'); const payload={userId:'b928b8d9-8881-43d7-a712-842b28870494', email:'zhouhua@china-yaguang.com', role:'admin'}; process.stdout.write(jwt.sign(payload, process.env.JWT_SECRET, {algorithm:'HS256', expiresIn:'6h'}));\\\"\" > /tmp/metasheet-main-admin-6h.jwt && chmod 600 /tmp/metasheet-main-admin-6h.jwt && TOKEN_BYTES=\$(wc -c < /tmp/metasheet-main-admin-6h.jwt) && echo \"token_file=/tmp/metasheet-main-admin-6h.jwt bytes=\${TOKEN_BYTES} mode=\$(stat -f %Lp /tmp/metasheet-main-admin-6h.jwt)\""
/bin/zsh -lc "TOKEN=\$(cat /tmp/metasheet-main-admin-6h.jwt); curl -sS -m 10 -H \"Authorization: Bearer \${TOKEN}\" http://142.171.239.56:8081/api/auth/me"
DINGTALK_P4_AUTH_TOKEN="$(cat /tmp/metasheet-main-admin-6h.jwt)" node scripts/ops/dingtalk-p4-env-bootstrap.mjs --p4-env-file output/dingtalk-p4-remote-smoke-session/dingtalk-p4.env --set-from-env DINGTALK_P4_AUTH_TOKEN
node scripts/ops/dingtalk-p4-release-readiness.mjs --p4-env-file output/dingtalk-p4-remote-smoke-session/dingtalk-p4.env --regression-profile all --regression-plan-only --output-dir output/dingtalk-p4-release-readiness/142-token-readiness --allow-failures
node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('output/dingtalk-p4-release-readiness/142-token-readiness/release-readiness-summary.json','utf8')); const env=j.gates.find(g=>g.id==='env-readiness'); console.log(JSON.stringify({overallStatus:j.overallStatus, envStatus:env?.status, authTokenPresent:env?.details?.environment?.authTokenPresent, failedChecks:env?.details?.failedChecks}, null, 2));"
git status --short --ignored output/dingtalk-p4-remote-smoke-session output/dingtalk-p4-release-readiness
node -e "const {spawnSync}=require('child_process'); const r=spawnSync('git',['grep','-n','-E','DINGTALK_P4_AUTH_TOKEN=.*eyJ','--','.'],{encoding:'utf8'}); if (r.status===0) { process.stdout.write(r.stdout); process.exit(1); } if (r.status===1) { console.log('no tracked DINGTALK_P4_AUTH_TOKEN JWT pattern'); process.exit(0); } process.stderr.write(r.stderr || 'git grep failed'); process.exit(r.status ?? 1);"
git diff --check
```

## Actual Results

- Worktree was clean before this token-readiness slice.
- Latest baseline commit was `e25381bbe docs(dingtalk): prepare P4 execution inputs`.
- Token file was created at `/tmp/metasheet-main-admin-6h.jwt`.
- Token file mode was `600`.
- Token length was 260 bytes.
- `/api/auth/me` returned success for admin user `b928b8d9-8881-43d7-a712-842b28870494`.
- `dingtalk-p4-env-bootstrap.mjs --set-from-env DINGTALK_P4_AUTH_TOKEN` updated the private env and printed only `<redacted>, 260 chars`.
- Release-readiness with the tokenized env reported `authTokenPresent: true`.
- Release-readiness still reported `overallStatus: "fail"` because the remaining private inputs are not filled.
- Remaining failed readiness checks: `dingtalk_p4_group_a_webhook`, `group-a-webhook-shape`, `dingtalk_p4_group_b_webhook`, `group-b-webhook-shape`, `allowlist-present`, `person-smoke-input`, and `manual-targets-declared`.
- Generated env and readiness output directories are ignored by git.
- No tracked `DINGTALK_P4_AUTH_TOKEN` raw JWT pattern was found.
- DingTalk robot webhook URL examples already exist in tests as synthetic fixtures; no real webhook was added in this slice.
- `git diff --check` passed.

## Non-Run Items

- No real 142/staging smoke session was started.
- No DingTalk group robot webhook, robot secret, user token, public form token, or temporary password was supplied.
- No manual DingTalk client/admin evidence was collected.
- Full P4 regression was not run in this sandbox because fake API tests need local loopback listening on `127.0.0.1`.

## Acceptance

- The admin/API token input is now ready in the private ignored env file.
- Token value remains outside git-tracked files and PR comments.
- The next remote-smoke blocker is reduced to webhook and user-target inputs.
