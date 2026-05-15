# K3 WISE On-Prem Operator Handoff Checklist

## Purpose

Use this checklist when handing a MetaSheet on-prem package to an operator or
bridge-machine maintainer for K3 WISE / Data Factory deployment testing.

It links the already packaged runbooks into one execution order:

1. verify the exact package;
2. install or upgrade the on-prem deployment;
3. sign off the MetaSheet control plane;
4. prepare customer GATE intake;
5. execute live C2-C11 only after customer answers arrive.

This file is a checklist, not a replacement for the detailed runbooks.

## Inputs

| Input | Source | Secret? | Notes |
|---|---|---:|---|
| on-prem package zip/tgz | GitHub Actions artifact or local release output | no | Use the exact file that will be deployed. |
| package verify report | `scripts/ops/multitable-onprem-package-verify.sh` | no | Required before deploy signoff. |
| deploy env file | `docker/app.env` on the target machine | yes | Never paste values into chat or tracked docs. |
| admin token file | deploy-host generated token file | yes | Use `0600` permissions and `--token-file`; never print token. |
| customer GATE JSON | copy of `gate-intake-template.json` outside Git | yes | Customer fills real K3 / PLM / optional SQL values. |
| on-site evidence JSON | copy of `evidence-onsite-c4-c9-template.json` outside Git | no secrets | Fill run ids and K3 response ids only; no credentials. |

## Phase 0 - Package Download And Verify

Download the package artifact from the intended build run. For GitHub Actions
builds, download the artifact named like:

```text
multitable-onprem-package-<run-id>-1
```

Verify both archives before copying them to the deployment host:

```bash
VERIFY_REPORT_JSON=artifacts/integration-k3wise/delivery-readiness/package-verify.zip.json \
VERIFY_REPORT_MD=artifacts/integration-k3wise/delivery-readiness/package-verify.zip.md \
  scripts/ops/multitable-onprem-package-verify.sh <package>.zip

VERIFY_REPORT_JSON=artifacts/integration-k3wise/delivery-readiness/package-verify.tgz.json \
VERIFY_REPORT_MD=artifacts/integration-k3wise/delivery-readiness/package-verify.tgz.md \
  scripts/ops/multitable-onprem-package-verify.sh <package>.tgz
```

Minimum PASS:

- `ok=true`;
- `checksum=PASS`;
- `required-content=PASS`;
- `no-github-links=PASS`;
- required content includes:
  - `scripts/ops/fixtures/integration-k3wise/gate-intake-template.json`;
  - `scripts/ops/fixtures/integration-k3wise/evidence-onsite-c4-c9-template.json`;
  - `docs/operations/integration-k3wise-live-gate-execution-package.md`;
  - this checklist.

Stop if package verify fails. Do not patch files manually on the target host
to make a package look complete.

## Phase 1 - Install Or Upgrade

For first install, follow:

```text
docs/deployment/multitable-windows-onprem-easy-start-20260319.md
```

For upgrade, use the packaged upgrade helper from the package root:

```bash
cd /opt/metasheet
ENV_FILE=/opt/metasheet/docker/app.env \
API_BASE="http://127.0.0.1/api" \
BASE_URL="http://127.0.0.1" \
  scripts/ops/multitable-onprem-package-upgrade.sh
```

After install or upgrade:

```bash
SERVICE_MANAGER=auto \
CHECK_NGINX=1 \
  scripts/ops/multitable-onprem-healthcheck.sh
```

Stop if login, healthcheck, WebSocket, or `/api/integration/*` routes are not
available. Fix deployment first; do not start K3 live testing on a broken
control plane.

## Phase 2 - On-Prem Preflight And Internal Trial

Run mock preflight from a full repo/package checkout on the deploy host:

```bash
node scripts/ops/integration-k3wise-onprem-preflight.mjs --mock \
  --out-dir artifacts/integration-k3wise/onprem-preflight/mock
```

Expected:

- exit code `0`;
- `decision=PASS`;
- Postgres reachable;
- migrations aligned;
- K3 mock fixtures present.

Then run authenticated internal-trial smoke:

```bash
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url "$METASHEET_BASE_URL" \
  --token-file "$METASHEET_AUTH_TOKEN_FILE" \
  --tenant-id default \
  --require-auth \
  --out-dir artifacts/integration-k3wise/internal-trial/postdeploy-smoke

node scripts/ops/integration-k3wise-postdeploy-summary.mjs \
  --input artifacts/integration-k3wise/internal-trial/postdeploy-smoke/integration-k3wise-postdeploy-smoke.json \
  --require-auth-signoff
```

Expected:

- `ok=true`;
- `authenticated=true`;
- `signoff.internalTrial=pass`;
- `summary.fail=0`.

Stop if internal-trial smoke is blocked. Token expiry is an environment issue;
mint a new temporary token and rerun rather than weakening auth.

## Phase 3 - Prepare Customer GATE

Copy the customer intake template outside Git:

```bash
cp scripts/ops/fixtures/integration-k3wise/gate-intake-template.json \
  /secure/customer-gate/k3wise-gate.json
```

Customer / operator fills A.1-A.6 in the copied file only. Keep real values out
of Git, chat, and package artifacts.

Before customer answers arrive, live preflight is expected to be blocked. That
is correct:

```text
exit=2 / decision=GATE_BLOCKED
```

## Phase 4 - Live Preflight And Packet

After customer GATE answers arrive, inject K3 env values without echoing them:

```bash
node scripts/ops/integration-k3wise-onprem-preflight.mjs --live \
  --gate-file /secure/customer-gate/k3wise-gate.json \
  --out-dir artifacts/integration-k3wise/onprem-preflight/live
```

Expected:

- exit code `0`;
- `k3.live-config=pass`;
- `k3.live-reachable=pass`;
- `gate.file-present=pass`.

Then build the live PoC packet:

```bash
node scripts/ops/integration-k3wise-live-poc-preflight.mjs \
  --input /secure/customer-gate/k3wise-gate.json \
  --out-dir artifacts/integration-k3wise/live-poc/packet
```

Expected:

- `status=preflight-ready`;
- `safety.saveOnly=true`;
- `autoSubmit=false`;
- `autoAudit=false`;
- material pipeline present;
- BOM pipeline present only when requested and product scope is present.

## Phase 5 - Execute C4-C9 And Fill Evidence

Copy the on-site worksheet outside Git:

```bash
cp scripts/ops/fixtures/integration-k3wise/evidence-onsite-c4-c9-template.json \
  /secure/customer-gate/k3wise-onsite-evidence.json
```

Before filling, the worksheet should compile to `PARTIAL` with zero issues:

```bash
node scripts/ops/integration-k3wise-live-poc-evidence.mjs \
  --packet artifacts/integration-k3wise/live-poc/packet/integration-k3wise-live-poc-packet.json \
  --evidence /secure/customer-gate/k3wise-onsite-evidence.json \
  --out-dir artifacts/integration-k3wise/live-poc/evidence-template-smoke
```

During live execution, fill the copied worksheet after each step:

| Step | Evidence field | Fill only after |
|---|---|---|
| C4 PLM/K3 testConnection | `connections.plm`, `connections.k3Wise` | both connection tests return ok |
| C4 SQL optional | `connections.sqlServer` | only when SQL channel is expected |
| C5 material dry-run | `materialDryRun` | 1-3 preview rows look correct |
| C6 material Save-only | `materialSaveOnly` | 1-3 K3 records written, Submit/Audit not called |
| C6 writeback | `erpFeedback` | staging feedback fields updated |
| C7 optional BOM | `bomPoC` | BOM Save-only succeeds and product scope is explicit |
| C8 replay | `deadLetterReplay` | controlled failure is fixed and replay succeeds |
| C9 rollback | `rollback` | customer K3 admin confirms cleanup/rollback |
| final | `customerConfirmation` | customer owner confirms the evidence package |

Run the evidence compiler after updates:

```bash
node scripts/ops/integration-k3wise-live-poc-evidence.mjs \
  --packet artifacts/integration-k3wise/live-poc/packet/integration-k3wise-live-poc-packet.json \
  --evidence /secure/customer-gate/k3wise-onsite-evidence.json \
  --out-dir artifacts/integration-k3wise/live-poc/evidence
```

Expected final signoff:

- `decision=PASS`;
- `issues=[]`.

## Phase 6 - Delivery Readiness Record

Compile the handoff record before and after live evidence:

```bash
node scripts/ops/integration-k3wise-delivery-readiness.mjs \
  --postdeploy-smoke artifacts/integration-k3wise/internal-trial/postdeploy-smoke/integration-k3wise-postdeploy-smoke.json \
  --package-verify artifacts/integration-k3wise/delivery-readiness/package-verify.zip.json \
  --preflight-packet artifacts/integration-k3wise/live-poc/packet/integration-k3wise-live-poc-packet.json \
  --live-evidence-report artifacts/integration-k3wise/live-poc/evidence/integration-k3wise-live-poc-evidence-report.json \
  --out-dir artifacts/integration-k3wise/delivery-readiness/customer-signed-off \
  --fail-on-blocked
```

Expected after live PASS:

```text
decision=CUSTOMER_TRIAL_SIGNED_OFF
productionUse.ready=false
```

Production use still requires explicit customer approval, backup/rollback
approval, and a scheduled change window.

## Secret Hygiene

Never paste these into tracked files, chat, or evidence artifacts:

- JWTs or Authorization header values;
- K3 session ids;
- usernames plus passwords;
- signed URLs or query tokens;
- SQL connection strings with passwords;
- raw `DATABASE_URL` / `JWT_SECRET`;
- customer private network credentials.

Use file paths and presence booleans instead. Before sharing artifacts, run
the secret self-checks documented in:

```text
docs/operations/k3-poc-onprem-preflight-runbook.md
docs/operations/integration-k3wise-live-gate-execution-package.md
```

## Claude Code Boundary

Repo-local work does not need Claude Code. Use Claude Code on the bridge
machine only when the task requires local access to:

- Windows / WSL deployment logs;
- the customer K3 host and WebAPI port;
- SQL Server network reachability;
- a customer-approved SQL executor implementation;
- browser/UI checks from the deployment network.

When Claude Code is used on the bridge machine, give it this checklist plus
the exact package file name and require it to report only redacted artifacts.
