# DingTalk Live Acceptance Manual Evidence Gap Verification - 2026-05-12

## Summary

This verification records why the current DingTalk live acceptance remains `manual_pending` and why the available screenshots must not be used as strict current-session PASS evidence.

Result: not CLOSED. The live 142 runtime is healthy, automated smoke checks are partly complete, but four manual evidence items remain pending.

## Verification Matrix

| Gate | Result | Evidence |
| --- | --- | --- |
| 142 backend health | PASS | Server-local `/api/health` returned `status=ok`, `plugins=13` |
| 142 web entry | PASS | Server-local `/` returned HTTP 200 |
| Runtime image check | PASS | backend/web are both on `b88f6c243ce882c65dc794c188e8d0e677f6cb64` |
| Current smoke status | PENDING | `142-live-20260512-token` is `manual_pending`, `4/8` complete |
| Screenshot freshness | FAIL for strict reuse | Latest supplied DingTalk screenshots are dated 2026-05-10 and show prior smoke context |
| No-email target | FAIL for strict create/bind proof | Generated target is already linked to an admin local user |
| Secret hygiene | PASS | This doc records redacted ids only and no webhook/JWT/SEC/password values |
| Local doc validation | PASS | `git diff --check`, secret-pattern scan, and DingTalk evidence tests passed |

## Commands Run

Repository/worktree state:

```bash
git status --short --branch
git rev-parse --short HEAD
```

Evidence contract inspection:

```bash
sed -n '640,710p' scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs
sed -n '450,530p' scripts/ops/dingtalk-p4-evidence-record.mjs
```

Current smoke status:

```bash
SESSION=/tmp/metasheet2-dingtalk-live-acceptance-20260512/output/dingtalk-p4-remote-smoke-session/142-live-20260512-token
sed -n '1,220p' "$SESSION/smoke-status.md"
sed -n '1,220p' "$SESSION/smoke-todo.md"
```

142 health and runtime:

```bash
ssh -i ~/.ssh/metasheet2_deploy -o BatchMode=yes -o StrictHostKeyChecking=no mainuser@142.171.239.56 \
  "docker ps --format '{{.Names}} {{.Image}}' | grep -E 'metasheet-(backend|web)' && \
   curl -fsS http://127.0.0.1:8081/api/health | head -c 220 && printf '\n' && \
   curl -fsSI http://127.0.0.1:8081/ | head -5"
```

No-email directory state, with sensitive values omitted from the report:

```bash
ssh -i ~/.ssh/metasheet2_deploy -o BatchMode=yes -o StrictHostKeyChecking=no mainuser@142.171.239.56 \
  "docker exec metasheet-postgres psql -U metasheet -d metasheet -Atc \"<redacted directory account query>\""
```

Screenshot freshness:

```bash
find /Users/chouhua/Downloads -maxdepth 1 -type f \( -name '*.JPG' -o -name '*.PNG' -o -name '*.jpg' -o -name '*.png' \) -print0 \
  | xargs -0 stat -f '%Sm %N' -t '%Y-%m-%d %H:%M:%S' \
  | sort \
  | tail -12
```

Local validation:

```bash
git diff --check
git diff -- docs/development/dingtalk-live-acceptance-manual-evidence-gap-development-20260512.md docs/development/dingtalk-live-acceptance-manual-evidence-gap-verification-20260512.md \
  | rg -n "<strict secret value pattern>" \
  || true
node --test scripts/ops/dingtalk-p4-evidence-record.test.mjs scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs
```

## Observed Results

142 runtime:

```text
metasheet-web ghcr.io/zensgit/metasheet2-web:b88f6c243ce882c65dc794c188e8d0e677f6cb64
metasheet-backend ghcr.io/zensgit/metasheet2-backend:b88f6c243ce882c65dc794c188e8d0e677f6cb64
backend /api/health: status ok, plugins 13
web /: HTTP 200
```

Current smoke status:

```text
Overall status: manual_pending
Progress: 4/8 complete, 4 remaining
Pending: send-group-message-form-link
Pending: authorized-user-submit
Pending: unauthorized-user-denied
Pending: no-email-user-create-bind
```

Screenshot freshness scan:

```text
2026-05-10 17:07:05 IMG_1149.PNG
2026-05-10 17:07:35 IMG_1150.PNG
2026-05-10 17:08:05 IMG_1151.PNG
2026-05-10 18:34:29 178bb7b3c1961dd8ae1bea9a1e4f4548.JPG
2026-05-10 20:56:05 56e648b6002e4185c1cb2cbe384090f9.JPG
2026-05-10 21:14:07 894a95ca7a48f3fa4d5d8131ed992fea.JPG
2026-05-10 21:14:09 3e630dade053bf7152a9f50d080faeca.JPG
```

Directory state:

```text
Generated no-email target ending 1174: blank email, active, already linked to admin local user.
ddzz target ending 9104: blank email, active, already linked to a no-email local user.
```

Local validation:

```text
git diff --check: pass
secret-pattern scan: 0 matches
node --test DingTalk evidence suites: 45 tests, 45 pass, 0 fail
```

## Evidence Contract Result

The strict no-email check cannot be recorded as PASS unless all required admin evidence fields are present and true/non-empty:

- `emailWasBlank`
- `createdLocalUserId`
- `boundDingTalkExternalId`
- `accountLinkedAfterRefresh`
- `temporaryPasswordRedacted`

Because the generated active-session target is already linked to an admin local user, using it would misrepresent the create-and-bind workflow.

## Remaining Manual Acceptance Items

The following must still be captured against the current generated session before the final closeout can be marked CLOSED:

- Current DingTalk group message screenshot or delivery artifact for `send-group-message-form-link`.
- Authorized-user current-session form submit success evidence for `authorized-user-submit`.
- Unauthorized-user current-session denial evidence plus zero record insert proof for `unauthorized-user-denied`.
- A no-email DingTalk directory account create/bind artifact set that matches strict `no-email-user-create-bind` semantics.

## Conclusion

142 is healthy and the automated DingTalk smoke bootstrap remains usable, but the final DingTalk closeout is still blocked by manual evidence quality.

The correct status is:

```text
manual_pending
```

Do not mark the final DingTalk matrix CLOSED until fresh current-session manual evidence is recorded and `dingtalk-p4-smoke-session.mjs --finalize` succeeds.
