# Verification: Internal-Trial Runbook Update — Host-Shell Path & Public Posture

**Date**: 2026-05-08
**Design**: `docs/development/integration-k3wise-internal-trial-runbook-update-design-20260508.md`
**Files under verification**:
- `docs/operations/integration-k3wise-internal-trial-runbook.md`
- `.gitignore`

---

## 1. Host-Shell Mint and Smoke — recipe was actually executed end-to-end today

The Node mint heredoc and the smoke + summary commands in the new section are
the literal commands run on machine 142 (`racknerd-0de8668`, Ubuntu 5.15,
node v20.20.2, pnpm 10.33.0) on 2026-05-08 against main `36ca525` (PR #1437
merge SHA, which contains PR #1433 + #1437).

Result captured:

```
token file: /tmp/metasheet-142-admin-fresh-20260508T083206Z.jwt
  size: 312 bytes
  perm: 600
  owner: mainuser:mainuser
  jwt 3-segment shape match: 1

smoke exit=0
ok: true
authenticated: true
signoff.internalTrial: pass
signoff.reason: authenticated smoke passed
summary: {"pass":10,"skipped":0,"fail":0}
```

Summary script with `--require-auth-signoff` rendered "Internal trial
signoff: **PASS** / Status: **PASS** / 10 pass / 0 skipped / 0 fail" with all
ten individual checks (`api-health`, `integration-plugin-health`,
`k3-wise-frontend-route`, `auth-me`, `integration-route-contract`, the four
control-plane list probes, `staging-descriptor-contract`) marked `pass`.

Artifact leak self-check on
`artifacts/integration-k3wise/internal-trial/postdeploy-smoke/integration-k3wise-postdeploy-smoke.json`:

| Pattern | Count |
|---|---|
| `eyJ…` JWT-shape | 0 |
| `Bearer …` header | 0 |
| `"authorization"` / `"token"` / `"access_token"` JSON field with non-redacted value | 0 |
| Literal token value match (`grep -F`) | 0 |

The recipe is reproducible and leak-free.

## 2. Public Surface Access Posture — observed today

From workstation outside 142:

```
$ nc -z -w 5 142.171.239.56 8081
Connection to 142.171.239.56 port 8081 [tcp/sunproxyadmin] succeeded!

$ curl -sS --max-time 8 -o /dev/null -w "%{http_code}\n" http://142.171.239.56:8081/health
000
$ curl -sS --max-time 8 -o /dev/null -w "%{http_code}\n" http://142.171.239.56:8081/api/health
000
$ curl -sS --max-time 8 -o /dev/null -w "%{http_code}\n" http://142.171.239.56:8081/
000
# All three: curl: (52) Empty reply from server
```

From workstation outside 142, full smoke against `:8081`:

```
smoke exit=1
ok: false
signoff.internalTrial: blocked
summary: {"pass":0,"skipped":0,"fail":10}
```

(Each check `error: "fetch failed"` — same root cause as the curl error 52.)

From 142 host shell against the same `:8081`:

```
smoke exit=0
ok: true
signoff.internalTrial: pass
summary: {"pass":10,"skipped":0,"fail":0}
```

Same code, same backend, same token in both runs (token written to a
host-local `0600` file). Only difference: source IP. Confirms the runbook's
"TCP-allow / HTTP-deny by source" wording.

## 3. Heredoc-vs-resolver consistency (simplified extract, not byte mirror)

The Node mint heredoc in the runbook section is a **simplified extract** of
the deploy-host fallback inner script in
`scripts/ops/resolve-k3wise-smoke-token.sh` (lines ~175–289 at commit
`854b27bd9`), not a byte-for-byte mirror.

What is preserved:

- Admin-selection SQL — same `users` / `user_roles` join, same WHERE clauses,
  same ORDER BY tiebreakers (collapsed to a single-line string for heredoc
  compatibility).
- `authService.createToken({ … })` field set and call shape, including the
  `'K3 WISE Smoke Admin'` default `name` fallback.
- `JWT_EXPIRY=2h` default and the `K3_WISE_SMOKE_TENANT_ID=default` env shape.
- Exit codes `2` (no tenant) and `4` (no admin).

What is omitted (intentionally — none apply when the recipe always supplies
an explicit `--tenant-id default`):

- The auto-discover-tenant pathway (`tableExists`, `collectTenantIds`,
  `inferSingletonTenantId`).
- The `DATABASE_URL` existence guard (resolver exit code `3`).
- The multi-tenant ambiguity guard (resolver exit code `5`).
- GHA-only env-passing scaffolding (`SSH_KEY_B64` etc.) — not applicable when
  running directly on the deploy host.

The runbook explicitly tells operators to re-derive the heredoc when the
resolver changes upstream — so it's a tested simplified extract at this point
in time, not a maintained fork.

## 4. `.gitignore` rule effective

```bash
mkdir -p artifacts/integration-k3wise/internal-trial/test-marker
echo test > artifacts/integration-k3wise/internal-trial/test-marker/file
git status --porcelain artifacts/integration-k3wise/internal-trial/
# expected: empty
rm -rf artifacts/integration-k3wise/internal-trial/test-marker
```

Empty `git status` confirms the rule excludes the path.

## 5. Existing test suites unaffected

Doc-only PR + one ignore rule. No script change.

```bash
pnpm verify:integration-k3wise:onprem-preflight   # 14/14 PASS
pnpm verify:integration-k3wise:poc                # 37 unit + mock chain PASS
```

Both were last green on the merge of PR #1437; this PR doesn't touch any
source they cover, so they remain green.

## CI status

Not modified. No CI workflow file is touched.

## Deployment impact

**None.** Doc + ignore rule only.

## Customer GATE status

Outside the GATE block. Stage 1 Lock memory remains in force.

## Worktree

Branch: `codex/integration-k3wise-internal-trial-runbook-update-20260508`
(forked from `origin/main` at `34d731670`).
Cwd: `/Users/chouhua/Downloads/Github/metasheet2`.
