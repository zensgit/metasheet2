# Multitable On-Prem Customer Delivery Checklist

Date: 2026-03-19  
Scope: customer or field delivery checklist for the `multitable/platform` on-prem package

## 1. Package Files

Deliver all of these together:

1. `metasheet-multitable-onprem-<version>.tgz`
2. `metasheet-multitable-onprem-<version>.zip`
3. `metasheet-multitable-onprem-<version>.tgz.sha256`
4. `metasheet-multitable-onprem-<version>.zip.sha256`
5. `SHA256SUMS`
6. `metasheet-multitable-onprem-<version>.json`

## 2. Required Documents

Include these docs with the package:

1. `/Users/huazhou/Downloads/Github/metasheet2-multitable/docs/deployment/multitable-windows-onprem-easy-start-20260319.md`
2. `/Users/huazhou/Downloads/Github/metasheet2-multitable/docs/deployment/multitable-onprem-package-layout-20260319.md`
3. `/Users/huazhou/Downloads/Github/metasheet2-multitable/docs/deployment/multitable-internal-pilot-runbook-20260319.md`
4. `/Users/huazhou/Downloads/Github/metasheet2-multitable/docs/deployment/multitable-pilot-quickstart-20260319.md`

## 3. Environment Assumptions

Confirm these before delivery:

1. Target is `Windows Server + Ubuntu VM` or `Windows Server + WSL2`
2. Customer accepts `PRODUCT_MODE=platform`
3. Customer understands this is full-app deployment, not attendance-only shell
4. Customer has PostgreSQL and Redis available locally
5. Customer can run Node.js 20, pnpm, pm2, nginx on the Ubuntu side

## 4. Runtime Paths To Confirm

Before handoff, confirm the customer can provide:

1. host or server IP
2. database password
3. `JWT_SECRET`
4. storage path for attendance import uploads
5. storage path for multitable attachments

Recommended paths:

1. `/opt/metasheet/storage/attendance-import`
2. `/opt/metasheet/data/attachments`

## 5. Verification Before Delivery

Run these before sending the package:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable
VERIFY_REPORT_JSON=output/releases/multitable-onprem/verify/<PACKAGE_NAME>.tgz.verify.json \
VERIFY_REPORT_MD=output/releases/multitable-onprem/verify/<PACKAGE_NAME>.tgz.verify.md \
scripts/ops/multitable-onprem-package-verify.sh output/releases/multitable-onprem/<PACKAGE_NAME>.tgz

VERIFY_REPORT_JSON=output/releases/multitable-onprem/verify/<PACKAGE_NAME>.zip.verify.json \
VERIFY_REPORT_MD=output/releases/multitable-onprem/verify/<PACKAGE_NAME>.zip.verify.md \
scripts/ops/multitable-onprem-package-verify.sh output/releases/multitable-onprem/<PACKAGE_NAME>.zip
```

Then prepare one customer-facing delivery directory:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable
pnpm prepare:multitable-onprem:delivery
```

This writes a final bundle under:

```text
output/delivery/multitable-onprem/<PACKAGE_NAME>/
```

The delivery bundle now also carries direct operator helpers under:

```text
output/delivery/multitable-onprem/<PACKAGE_NAME>/ops/
```

Key helper files:

1. `onprem-release-gate-operator-commands.sh`
2. `multitable-onprem-package-install.sh`
3. `multitable-onprem-deploy-easy.sh`
4. `multitable-onprem-healthcheck.sh`
5. `multitable-onprem-package-install.env.example.sh`
6. `multitable-onprem-deploy-easy.env.example.sh`
7. `multitable-onprem-preflight.sh`
8. `multitable-onprem-preflight.env.example.sh`
9. `multitable-onprem-healthcheck.env.example.sh`
10. `metasheet-healthcheck.service.example`
11. `metasheet-healthcheck.timer.example`

The preflight env template now also defines default report outputs:

1. `/opt/metasheet/output/preflight/multitable-onprem-preflight.json`
2. `/opt/metasheet/output/preflight/multitable-onprem-preflight.md`

When the optional verify reports exist, the delivery bundle now carries them under:

```text
output/delivery/multitable-onprem/<PACKAGE_NAME>/verify/
```

If you want one command that rebuilds the package, verifies both archive formats, refreshes the delivery bundle, and emits a gate report, run:

```bash
pnpm verify:multitable-onprem:release-gate
```

If using GitHub Actions release publishing, also record:

1. workflow run id
2. release tag
3. artifact name

If this package is also being handed to an internal pilot team, generate a release-bound pilot bundle from the exact gate you just approved:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable
ONPREM_GATE_STAMP=<gate-stamp> \
ENSURE_PLAYWRIGHT=false \
pnpm prepare:multitable-pilot:release-bound
```

This writes a bound summary under:

```text
output/playwright/multitable-pilot-release-bound/<timestamp>/
```

## 6. Delivery Notes To Tell The Customer

Make these explicit:

1. Upload complete is not the same as saved record complete
2. Multitable entry route is under `/multitable`
3. The package still contains `plugin-attendance`, but the shell is not restricted to attendance
4. This package is intended for internal or controlled rollout first, not broad public rollout
5. If people import shows a mismatch in the result panel, use `Select person` or `Select people` there first before asking users to rewrite the CSV

## 7. Sign-Off

- Delivery owner:
- Package version:
- Release tag:
- Delivered date:
- Customer environment:
- Notes:

Default operator evidence to collect before final sign-off:

1. `/opt/metasheet/output/preflight/multitable-onprem-preflight.json`
2. `/opt/metasheet/output/preflight/multitable-onprem-preflight.md`

Use this template for the formal customer-side receipt or field-delivery sign-off:

- `/Users/huazhou/Downloads/Github/metasheet2-multitable/docs/deployment/multitable-customer-delivery-signoff-template-20260323.md`
