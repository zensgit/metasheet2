# DingTalk Final Closeout — Verification

- Date: 2026-05-08
- Branch: `codex/dingtalk-final-closeout-20260508` (PR #1443)
- PR head before operator rebase: `e5787cf8d3deeb38bb0d0bd6d9b973bda8cd92c0`
- origin/main HEAD after operator rebase: `c74c15a2b`
- Main commit deployed on 142 (observed 2026-05-08): `08c6036284bf975dc1396c752d07f44486c7d4b2`
- Companion document:
  `docs/development/dingtalk-final-closeout-development-20260508.md`
- Redaction policy: no real DingTalk webhook, robot `SEC...`, admin JWT, Agent
  ID value, recipient user id, temporary password, or `.env` contents appears
  in this document. Helpers are quoted with `agentIdValuePrinted=false` and
  length-only fields.

## Today's Pre-Merge Re-Verification (2026-05-08)

Read-only re-check executed against the currently deployed image
`08c6036284bf…` on 142 prior to PR #1443 merging. No private credentials
were used and no secret values were printed.

| Probe | Result |
| --- | --- |
| `docker inspect` backend image | `ghcr.io/zensgit/metasheet2-backend:08c6036284bf975dc1396c752d07f44486c7d4b2` |
| `docker inspect` web image | `ghcr.io/zensgit/metasheet2-web:08c6036284bf975dc1396c752d07f44486c7d4b2` |
| backend container state | `running` |
| web container state | `running` |
| postgres container | `running (healthy)` |
| `127.0.0.1:8900/api/health` | `200` |
| `127.0.0.1:8081/` | `200` |
| `127.0.0.1:8900/api/admin/directory/dingtalk/work-notification` (unauth probe) | `401` (route present, gate active) |
| `127.0.0.1:8900/api/auth/me` (unauth probe) | `401` (route present, gate active) |
| `dingtalk_group_deliveries` total rows | `71` |
| `dingtalk_group_deliveries` last 7d | `success=5`, `failed=2` |
| `dingtalk_person_deliveries` total rows | `10` |
| `dingtalk_person_deliveries` last 7d | `failed=1` |
| Strict secret scan over today's evidence file | `SECRET_SCAN_PASS` (0 matches) |

The 2 recent group failures observed in the last 7 days predate the PR
#1443 failure-alert path. They cannot be used to validate the new
rule-creator notification because that code path is not in image
`08c6036284bf…`.

## Verification Matrix

Status meanings: **PASS** = live-proven on the current deployed `main` image
or in CI for the recorded commit; **PENDING** = not yet live-proven, awaiting
merge/deploy or final Codex execution against 142 with the real private inputs.

| # | Gate | Source / Owner | Status |
| --- | --- | --- | --- |
| 1 | 142 backend `/api/health` returns 200 | 142 host probe | PASS (re-confirmed on `08c6036284bf…`) |
| 2 | 142 web HTTP root returns 200 | 142 host probe | PASS (re-confirmed on `08c6036284bf…`) |
| 3 | Latest `main` CI green for the deployed SHA (`08c603628…`); PR #1443 post-rebase code CI green at `ca5ea87dc…`; newer doc-only heads should use GitHub PR checks as the live source of truth | GitHub Actions | PASS for deployed SHA and referenced code head |
| 4 | DingTalk PR backlog secret-redaction set is CI-green (PRs #1269, #1366, #1272, #1267, #1265, #1263, #1260) | GitHub PR rollups | PASS |
| 5 | Live smoke preflight + robot delivery hardening PR is CI-green (#1274) | GitHub PR rollup | PASS |
| 6 | Mobile signoff into final closeout is CI-green (#1239) | GitHub PR rollup | PASS |
| 7 | Public form path coverage PRs are CI-green (#1253, #1256, #1248, #1251) | GitHub PR rollups | PASS |
| 8 | Agent ID admin route exists and is authenticated on the deployed image | 142 unauth probe → 401 | PASS |
| 9 | Agent ID real save succeeds with the populated private file | 142 helper `--save` | PENDING (must re-run after 142 redeploys post-merge) |
| 10 | Agent ID real-send work notification delivers (Agent ID required-work-notification gate) | 142 helper `--recipient-user-id-file` | PENDING (re-run after 142 redeploys post-merge) |
| 11 | A/B group robot — at least one valid message delivered on each group | 142 direct `test-send` + delivery rows | PENDING (re-run after 142 redeploys post-merge) |
| 12 | Failure-alert code path: group failure creates a rule-creator work-notification attempt and person delivery audit | Local unit test | PASS (unit test) |
| 13 | Failure-alert end-to-end on 142 after this branch deploys | Live remote smoke session | PENDING (depends on PR #1443 merge + 142 redeploy) |
| 14 | `public` / `dingtalk` / `dingtalk_granted` form paths pass on the live session | Live remote smoke session | PENDING |
| 15 | No secret leakage in branch code / docs | Local strict branch scan | PASS |
| 16 | "Must merge" PR set merged into `main` per review policy | Repository merge state | PENDING (PR #1443 CI is green, but human review and merge are still required) |
| 17 | No secret leakage anywhere in populated remote evidence packet | Repo + packet secret scans | PENDING (re-run final scan over the populated session) |

## Commands To Run (Codex, in order, after PR #1443 merges)

All commands assume Codex is running on 142 or in the trusted operator
environment. Claude does not run any of these. Replace `<...>` only with
private values that stay outside git.

### 1. Confirm 142 is on the post-merge `main` SHA

```bash
docker inspect --format '{{.Config.Image}}' metasheet-backend
docker inspect --format '{{.Config.Image}}' metasheet-web
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8900/api/health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8081/
```

Expected: both image tags equal the post-merge `main` HEAD; both HTTP
probes return `200`.

### 2. Confirm Agent ID admin route is present on the deployed image

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:8900/api/admin/directory/dingtalk/work-notification
```

Expected: `401` (unauthenticated probe rejected, route present).

### 3. Real Agent ID save (Codex only — uses private file, never echoed)

```bash
node scripts/ops/dingtalk-work-notification-admin-agent-id.mjs \
  --api-base http://127.0.0.1:8900 \
  --auth-token-file <private-admin-token-file> \
  --agent-id-file <private-agent-id-file> \
  --save
```

Expected (redaction-safe shape only):

```json
{ "status": "pass", "agentIdValuePrinted": false }
```

If the helper exits with `AGENT_ID_FILE_EMPTY`, the private Agent ID file is
still empty and must be populated outside git before retry.

### 4. Real-send work notification (Codex only — recipient list is private)

```bash
node scripts/ops/dingtalk-work-notification-admin-agent-id.mjs \
  --api-base http://127.0.0.1:8900 \
  --auth-token-file <private-admin-token-file> \
  --agent-id-file <private-agent-id-file> \
  --recipient-user-id-file <private-recipient-user-id-file>
```

Expected: `status: "pass"`, no `failures[]` entries, no Agent ID or recipient
ids printed.

### 5. Live remote smoke session and final closeout wrapper

```bash
node scripts/ops/dingtalk-p4-release-readiness.mjs \
  --p4-env-file "$HOME/.config/yuantus/dingtalk-p4-staging.env" \
  --regression-profile ops \
  --run-smoke-session \
  --smoke-output-dir output/dingtalk-p4-remote-smoke-session/142-session

node scripts/ops/dingtalk-p4-final-closeout.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --packet-output-dir artifacts/dingtalk-staging-evidence-packet/142-final \
  --docs-output-dir docs/development \
  --date 20260508
```

Expected: `closeout-summary.json` shows `overallStatus: "pass"`,
`finalStrictStatus: "pass"`, no pending checks; `closeout-summary.md` lists
A/B group robot, failure-alert, and the three form access modes as PASS.

### 6. Failure-alert end-to-end (this PR's regression case)

Trigger a real `send_dingtalk_group_message` automation step that fails on
the new image (e.g., temporarily de-authorize one of the bound robots or
target an unreachable group) and confirm:

- a new row appears in `dingtalk_group_deliveries` with `success=false`;
- a new row appears in `dingtalk_person_deliveries` for the rule creator
  whose origin shape matches `failureAlert`;
- the rule creator receives a DingTalk work notification.

Roll back the temporary fault after the run; do not leave production
destinations de-authorized.

## Current Verified Evidence (cumulative)

These are facts established prior to and during this Claude run. Quoted as
redaction-safe identifiers only.

- Pre-merge re-verification on `08c6036284bf…` (this run, see "Today's
  Pre-Merge Re-Verification" above): `/api/health=200`, `/=200`,
  admin route `401`, `auth/me 401` for unauthenticated probes.
- DB row health on 142: `dingtalk_group_deliveries` total=71 (last 7d:
  5 success / 2 failed); `dingtalk_person_deliveries` total=10 (last 7d:
  1 failed). No PII/secret values queried or printed.
- Earlier evidence on `34d731670…` (Codex, prior pass): Agent ID helper
  returned `status=pass`, `access_token_verified=true`,
  `notification_sent=true`, `saved=true`, `status_after_available=true`,
  `agent_value_printed=false`, `recipient_value_printed=false`,
  `failure_count=0`. Work-notification release gate returned `status=pass`,
  `health.ok=true`, `auth.ok=true`, `workNotification.available=true`,
  `failures=[]`. A/B group robot direct test-sends returned `204`; newest
  delivery rows showed `success=true`, `http_status=200`. These results
  must be re-run on the post-merge image because 142 has since advanced
  to `08c603628…` and will advance again after PR #1443 merges.
- Latest `main` CI known green at the Claude evidence handoff:
  `34d731670…`, `08c603628…`, and then-current HEAD `ff0a11efe…` across
  the standard required workflows. The operator rebase later used
  `origin/main=c74c15a2b`; PR #1443 post-rebase code CI passed at
  `ca5ea87dc…`. For later doc-only heads, use GitHub PR checks as the live
  source of truth.
- Open DingTalk PRs in the closeout backlog are CI-green at observation
  time:
  - Failure-alert (this PR): #1443 (post-rebase code CI green; later
    doc-only heads must be checked in GitHub; human review and merge still
    required).
  - Secret redaction / scan: #1269, #1366, #1272, #1267, #1265, #1263, #1260.
  - Preflight + live delivery: #1274.
  - Mobile signoff into closeout: #1239.
  - Closeout summary polish (deferrable): #1259, #1261, #1264.
  - Public form coverage / UX / blocked-count: #1253, #1256, #1248, #1251.
  - PRs #1248 and #1251 each show one **skipped** check; remaining required
    checks on those two PRs are green.
- Local DingTalk backend target suite passed:
  `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts tests/unit/dingtalk-work-notification.test.ts tests/unit/dingtalk-work-notification-settings.test.ts tests/unit/dingtalk-group-destination-service.test.ts tests/unit/dingtalk-group-delivery-service.test.ts tests/unit/dingtalk-person-delivery-service.test.ts tests/unit/dingtalk-oauth-login-gates.test.ts tests/unit/jwt-middleware.test.ts tests/unit/auth-login-routes.test.ts tests/integration/dingtalk-group-destination-routes.api.test.ts tests/integration/dingtalk-delivery-routes.api.test.ts --watch=false`
  with 11 files / 232 tests passed.
- Local DingTalk frontend target suite passed:
  `pnpm --filter @metasheet/web exec vitest run tests/dingtalk-public-form-link-warnings.spec.ts tests/dingtalk-recipient-field-warnings.spec.ts tests/dingtalk-auth-callback.spec.ts tests/directoryManagementView.spec.ts --watch=false`
  with 4 files / 58 tests passed.
- Backend typecheck passed:
  `pnpm --filter @metasheet/core-backend exec tsc --noEmit`.
- Backend build passed:
  `pnpm --filter @metasheet/core-backend build`.
- Web build passed:
  `pnpm --filter @metasheet/web build`. Vite emitted only the existing large
  chunk / mixed static-dynamic import warnings.
- Whitespace check passed:
  `git diff --check`.
- Strict branch secret scan passed with `SECRET_SCAN_PASS`. A broader first
  pass only matched fixed dummy test fixtures such as `dt-app-secret`; no
  real webhook, robot secret, JWT, bearer token, app secret, Agent ID value,
  or recipient user id was found in the changed files.

## Blocker Status (per delivery blocker policy)

| Blocker policy line | Required outcome | Current status |
| --- | --- | --- |
| Agent ID real work notification must pass | Live `--save` + real-send round trip on the post-merge `main` image | PENDING (re-run required on new image after PR #1443 merges) |
| A/B group robot — at least one valid message must pass | One delivered message on each of group A and group B on the post-merge image | PENDING (re-run required) |
| Failure alert must have delivery / audit and notify rule creator | Local runtime path covered; live end-to-end run after deploy still required | PENDING |
| `public` / `dingtalk` / `dingtalk_granted` form paths must pass | All three modes covered green in the live session | PENDING |
| CI and 142 health must pass | `main` CI green + 142 health 200 | PASS |
| No secret leakage | Branch code/docs strict scan + today's pre-merge evidence scan are clean; final packet scan must be repeated after final populated session | PASS for branch + this Claude run; PENDING for final packet |

Until every blocker line is PASS, delivery remains **NOT CLOSED**. The
non-blocking deferrals (shared org-level group robot catalog,
row/column-level fill assignment, finer DingTalk org governance UI,
screenshot-only archive) are explicitly excluded from this matrix.

## Acceptance Checklist For Codex Final Verification

Codex marks each item PASS only after running the corresponding command and
confirming the redaction-safe outcome. PENDING is the default.

- [ ] PR #1443 is approved by a human reviewer and squash-merged. Post-rebase
      code CI is already green at `ca5ea87dc…`; verify GitHub checks for the
      current PR head before merge.
- [ ] After merge, 142 backend and web containers run the post-merge `main`
      HEAD image (record the new SHA in this doc).
- [ ] `/api/health` returns 200 and web `/` returns 200 after the new image
      auto-deploys.
- [ ] `/api/admin/directory/dingtalk/work-notification` returns 401
      unauthenticated on the new image.
- [ ] Admin helper `--save` against the real private Agent ID file returns
      `status: "pass"` with `agentIdValuePrinted=false`.
- [ ] Admin helper real-send with `--recipient-user-id-file` returns
      `status: "pass"` and zero `failures[]`.
- [ ] Live remote smoke session reaches `finalize_pending`,
      `dingtalk-p4-final-closeout.mjs` completes, and
      `closeout-summary.json` reports `overallStatus: "pass"` with
      `finalStrictStatus: "pass"` and no pending checks.
- [ ] A/B group robot — at least one delivered message recorded for each
      group on the post-merge image; included in the final packet.
- [ ] Failure-alert end-to-end run on 142 shows: `dingtalk_group_deliveries`
      failure row, `dingtalk_person_deliveries` `failureAlert` row for the
      rule creator, and DingTalk work notification delivered to that creator.
- [ ] `public`, `dingtalk`, and `dingtalk_granted` form paths each PASS in
      the live session evidence.
- [ ] Final secret scan over the populated session and packet returns no
      findings (matches limited to redactor code, scan commands, and dummy
      fixtures).
- [ ] All PRs in the "must merge" bucket of the development doc are merged
      into `main`.
- [ ] After the must-merge set lands, 142 auto-deploys the new `main` image
      and items above are re-confirmed against that image — not against a
      manually switched feature tag.

When every box above is checked, Codex may declare the DingTalk feature
delivery **CLOSED** and update the PR / release notes accordingly. Until
then this document, and the matrix above, remain the source of truth for
closeout status.
