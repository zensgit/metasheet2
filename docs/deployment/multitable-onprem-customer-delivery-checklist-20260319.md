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

1. `docs/deployment/multitable-windows-onprem-easy-start-20260319.md`
2. `docs/deployment/multitable-onprem-package-layout-20260319.md`
3. `docs/deployment/multitable-internal-pilot-runbook-20260319.md`
4. `docs/deployment/multitable-pilot-quickstart-20260319.md`

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
cd <REPO_ROOT>
scripts/ops/multitable-onprem-package-verify.sh output/releases/multitable-onprem/<PACKAGE_NAME>.tgz
scripts/ops/multitable-onprem-package-verify.sh output/releases/multitable-onprem/<PACKAGE_NAME>.zip
```

Then prepare one customer-facing delivery directory:

```bash
cd <REPO_ROOT>
pnpm prepare:multitable-onprem:delivery
```

This writes a final bundle under:

```text
output/delivery/multitable-onprem/<PACKAGE_NAME>/
```

If using GitHub Actions release publishing, also record:

1. workflow run id
2. release tag
3. artifact name

## 6. Delivery Notes To Tell The Customer

Make these explicit:

1. Upload complete is not the same as saved record complete
2. Multitable entry route is under `/multitable`
3. The package still contains `plugin-attendance`, but the shell is not restricted to attendance
4. This package is intended for internal or controlled rollout first, not broad public rollout

## 7. Sign-Off

- Delivery owner:
- Package version:
- Release tag:
- Delivered date:
- Customer environment:
- Notes:
