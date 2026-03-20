# Multitable On-Prem Package Layout

Goal: deliver a full-app `multitable/platform` package without requiring `git pull` on the target host.

## Build on the release machine

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable
chmod +x scripts/ops/multitable-onprem-package-build.sh scripts/ops/multitable-onprem-package-verify.sh
PACKAGE_VERSION=2.5.1 \
PACKAGE_TAG=pilot-r2 \
INSTALL_DEPS=1 \
BUILD_WEB=1 \
BUILD_BACKEND=1 \
scripts/ops/multitable-onprem-package-build.sh
```

For a corrective reroll, do not run the build script bare. Its defaults are `INSTALL_DEPS=0`, `BUILD_WEB=0`, and `BUILD_BACKEND=0`, which only repackage whatever `dist/` is already on disk.

Output directory:

- `output/releases/multitable-onprem/*.tgz`
- `output/releases/multitable-onprem/*.zip`
- `output/releases/multitable-onprem/*.sha256`
- `output/releases/multitable-onprem/SHA256SUMS`
- `output/releases/multitable-onprem/*.json`

## GitHub Actions build

Workflow:

```text
.github/workflows/multitable-onprem-package-build.yml
```

The workflow builds:

- one `.tgz`
- one Windows-friendly `.zip`
- checksum files
- metadata json

The workflow already supports GitHub Release publishing through `publish_release=true`.

For a corrective reroll such as `v2.5.1`, set:

- `package_version=2.5.1`
- `package_tag=<your-reroll-tag>`

## Verify before delivery

```bash
scripts/ops/multitable-onprem-package-verify.sh output/releases/multitable-onprem/<PACKAGE_NAME>.tgz
scripts/ops/multitable-onprem-package-verify.sh output/releases/multitable-onprem/<PACKAGE_NAME>.zip
```

## Minimum package contents

```text
metasheet/
  apps/web/dist/
  packages/core-backend/dist/
  plugins/plugin-attendance/
  scripts/ops/
    multitable-onprem-package-install.sh
    multitable-onprem-package-upgrade.sh
    multitable-onprem-deploy-easy.sh
    multitable-onprem-healthcheck.sh
  docker/app.env.multitable-onprem.template
  ops/nginx/multitable-onprem.conf.example
  docs/deployment/multitable-windows-onprem-easy-start-20260319.md
```

## Package mode

This package is:

- not attendance-only
- `PRODUCT_MODE=platform`
- intended for full-app deployment with multitable enabled

Current plugin policy:

- ships `plugin-attendance` alongside the core app
- does not restrict the app shell to `/attendance`

## Customer delivery checklist

Before sending a package to a customer or field team, use:

- `/Users/huazhou/Downloads/Github/metasheet2-multitable/docs/deployment/multitable-onprem-customer-delivery-checklist-20260319.md`
