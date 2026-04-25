# DingTalk P4 User Target Readiness Verification

- Date: 2026-04-24
- Branch: `codex/dingtalk-next-slice-20260423`
- Base commit: `12f6c9fac`
- Result: pass for safe user-target readiness; remote smoke remains blocked by webhooks and remaining manual targets

## Commands

```bash
git status --short
git log -3 --oneline
ssh -i ~/.ssh/metasheet2_deploy -o BatchMode=yes -o StrictHostKeyChecking=no mainuser@142.171.239.56 "docker exec metasheet-postgres psql -U metasheet -d metasheet -Atc \"select tablename from pg_tables where schemaname='public' and (tablename ilike '%user%' or tablename ilike '%dingtalk%' or tablename ilike '%external%') order by tablename;\""
ssh -i ~/.ssh/metasheet2_deploy -o BatchMode=yes -o StrictHostKeyChecking=no mainuser@142.171.239.56 "docker exec metasheet-postgres psql -U metasheet -d metasheet -AtF '|' -c \"select u.id, coalesce(u.email,''), coalesce(u.name,''), u.is_active, coalesce(e.provider_user_id,''), coalesce(e.provider_union_id,''), coalesce(g.enabled::text,'') from users u left join user_external_identities e on e.local_user_id=u.id and e.provider='dingtalk' left join user_external_auth_grants g on g.local_user_id=u.id and g.provider='dingtalk' order by u.created_at desc limit 50;\""
ssh -i ~/.ssh/metasheet2_deploy -o BatchMode=yes -o StrictHostKeyChecking=no mainuser@142.171.239.56 "docker exec metasheet-postgres psql -U metasheet -d metasheet -AtF '|' -c \"select id, coalesce(provider_user_id,''), coalesce(provider_union_id,''), coalesce(provider_open_id,''), coalesce(local_user_id,''), coalesce(profile->>'name',''), coalesce(profile->>'email','') from user_external_identities where provider='dingtalk' order by created_at desc limit 50;\""
node scripts/ops/dingtalk-p4-env-bootstrap.mjs --p4-env-file output/dingtalk-p4-remote-smoke-session/dingtalk-p4.env --set DINGTALK_P4_ALLOWED_USER_IDS=b928b8d9-8881-43d7-a712-842b28870494 --set DINGTALK_P4_PERSON_USER_IDS=b928b8d9-8881-43d7-a712-842b28870494 --set DINGTALK_P4_AUTHORIZED_USER_ID=b928b8d9-8881-43d7-a712-842b28870494
node scripts/ops/dingtalk-p4-release-readiness.mjs --p4-env-file output/dingtalk-p4-remote-smoke-session/dingtalk-p4.env --regression-profile all --regression-plan-only --output-dir output/dingtalk-p4-release-readiness/142-user-target-readiness --allow-failures
node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('output/dingtalk-p4-release-readiness/142-user-target-readiness/release-readiness-summary.json','utf8')); const env=j.gates.find(g=>g.id==='env-readiness'); console.log(JSON.stringify({overallStatus:j.overallStatus, envStatus:env?.status, environment:env?.details?.environment, failedChecks:env?.details?.failedChecks}, null, 2));"
git status --short --ignored output/dingtalk-p4-remote-smoke-session output/dingtalk-p4-release-readiness
if git grep -n -E 'DINGTALK_P4_AUTH_TOKEN="?eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.' -- .; then exit 1; else test $? -eq 1 && echo "no tracked P4 raw JWT assignment pattern"; fi
git diff --check
```

## Actual Results

- Worktree was clean before this user-target readiness slice.
- Latest baseline commit was `12f6c9fac docs(dingtalk): record P4 token readiness`.
- 142 table discovery confirmed `users`, `user_external_identities`, and `user_external_auth_grants` are available.
- 142 has one active local user with a DingTalk external identity and DingTalk grant.
- 142 did not show a second DingTalk-bound local user in the queried rows.
- 142 did not show a no-email DingTalk external identity in the queried rows.
- Private env update printed only entry counts and field lengths.
- Release-readiness with user targets reported:
  - `authTokenPresent: true`
  - `allowedUserCount: 1`
  - `personUserCount: 1`
  - `manualTargets.authorizedUserId` populated
- Release-readiness still reported `overallStatus: "fail"` because group webhooks and the remaining manual targets are not ready.
- Remaining failed readiness checks: `dingtalk_p4_group_a_webhook`, `group-a-webhook-shape`, `dingtalk_p4_group_b_webhook`, `group-b-webhook-shape`, and `manual-targets-declared`.
- Generated env/readiness output directories are ignored by git.
- No tracked P4 raw JWT assignment pattern was found; the strict `git grep` returned no matches.
- `git diff --check` passed.

## Non-Run Items

- No real DingTalk robot webhook was supplied.
- No real DingTalk group message was sent.
- No 142 smoke session was started.
- No unauthorized or no-email manual evidence was recorded.
- Full P4 regression was not run in this sandbox because fake API tests need local loopback listening on `127.0.0.1`.

## Acceptance

- Safe user-target readiness is now complete for allowed/person/authorized fields.
- Readiness blockers are narrowed to webhooks plus unavailable unauthorized/no-email manual targets.
- No private token or webhook value was committed.
