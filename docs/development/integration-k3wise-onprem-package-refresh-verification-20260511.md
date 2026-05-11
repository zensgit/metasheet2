# K3 WISE On-Prem Package Refresh Verification - 2026-05-11

## Scope

Verify the on-prem package built from `main` after PR #1468 so the Windows/entity-machine deployment can test the simplified K3 WISE setup page.

Workflow run:

- `https://github.com/zensgit/metasheet2/actions/runs/25677648370`
- conclusion: `success`
- head SHA: `158bd831eef5b6b43354bc40c79d85a6259d2b3d`

## Artifact Download

Command:

```bash
rm -rf /tmp/ms2-onprem-25677648370
mkdir -p /tmp/ms2-onprem-25677648370
gh run download 25677648370 \
  --repo zensgit/metasheet2 \
  -D /tmp/ms2-onprem-25677648370
```

Downloaded files:

```text
/tmp/ms2-onprem-25677648370/multitable-onprem-package-25677648370-1/SHA256SUMS
/tmp/ms2-onprem-25677648370/multitable-onprem-package-25677648370-1/metasheet-multitable-onprem-v2.5.0-k3wise-ui-20260511.json
/tmp/ms2-onprem-25677648370/multitable-onprem-package-25677648370-1/metasheet-multitable-onprem-v2.5.0-k3wise-ui-20260511.tgz
/tmp/ms2-onprem-25677648370/multitable-onprem-package-25677648370-1/metasheet-multitable-onprem-v2.5.0-k3wise-ui-20260511.tgz.sha256
/tmp/ms2-onprem-25677648370/multitable-onprem-package-25677648370-1/metasheet-multitable-onprem-v2.5.0-k3wise-ui-20260511.zip
/tmp/ms2-onprem-25677648370/multitable-onprem-package-25677648370-1/metasheet-multitable-onprem-v2.5.0-k3wise-ui-20260511.zip.sha256
```

## Checksums

```text
0899742c649654e056a5433b10ae0fa4a841167c137287e8b43e25fcbb1e465f  metasheet-multitable-onprem-v2.5.0-k3wise-ui-20260511.tgz
6a3c0a1885aaaa0ab5ccd4220fff07d73080a40c6fe4cd63198815e1b9144ce5  metasheet-multitable-onprem-v2.5.0-k3wise-ui-20260511.zip
```

## Package Metadata

```json
{
  "name": "metasheet-multitable-onprem-v2.5.0-k3wise-ui-20260511",
  "version": "2.5.0",
  "tag": "k3wise-ui-20260511",
  "attendanceOnly": false,
  "productMode": "platform",
  "includedPlugins": ["plugin-attendance", "plugin-integration-core"],
  "archive": "metasheet-multitable-onprem-v2.5.0-k3wise-ui-20260511.tgz",
  "archiveZip": "metasheet-multitable-onprem-v2.5.0-k3wise-ui-20260511.zip",
  "checksumFile": "SHA256SUMS",
  "generatedAt": "2026-05-11T14:52:51Z"
}
```

## Verify Script

Commands:

```bash
scripts/ops/multitable-onprem-package-verify.sh \
  /tmp/ms2-onprem-25677648370/multitable-onprem-package-25677648370-1/metasheet-multitable-onprem-v2.5.0-k3wise-ui-20260511.zip

scripts/ops/multitable-onprem-package-verify.sh \
  /tmp/ms2-onprem-25677648370/multitable-onprem-package-25677648370-1/metasheet-multitable-onprem-v2.5.0-k3wise-ui-20260511.tgz
```

Result:

```text
metasheet-multitable-onprem-v2.5.0-k3wise-ui-20260511.zip: OK
metasheet-multitable-onprem-v2.5.0-k3wise-ui-20260511.tgz: OK
```

## K3 WISE Content Checks

The zip contains the integration runtime and required migration assets:

```text
plugins/plugin-integration-core/
packages/core-backend/migrations/008_plugin_infrastructure.sql
packages/core-backend/migrations/056_add_users_must_change_password.sql
packages/core-backend/migrations/057_create_integration_core_tables.sql
docs/operations/integration-k3wise-live-gate-execution-package.md
```

The zip contains the built K3 WISE setup page assets:

```text
apps/web/dist/assets/IntegrationK3WiseSetupView-BJqzI4DQ.js
apps/web/dist/assets/IntegrationK3WiseSetupView-BaXm3-j_.css
```

The built JavaScript includes the simplified UI copy:

```text
基础连接
多维表清洗准备
高级 WebAPI 设置
Pipeline 执行参数
Dry-run 后推送
```

## Result

The `k3wise-ui-20260511` on-prem package is ready for the next Windows/entity-machine deployment test.

Use:

```text
metasheet-multitable-onprem-v2.5.0-k3wise-ui-20260511.zip
```

Do not use older K3 WISE packages for UI verification, because they do not include the simplified setup page.
