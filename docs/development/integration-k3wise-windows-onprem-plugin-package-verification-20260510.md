# Verification: Integration Core Is Bundled in the Windows On-Prem Package

**Date**: 2026-05-10
**Design**:
`docs/development/integration-k3wise-windows-onprem-plugin-package-design-20260510.md`

---

## 1. Local Checks

Executed before PR:

```
$ bash -n scripts/ops/multitable-onprem-package-build.sh
# exit 0

$ bash -n scripts/ops/multitable-onprem-package-verify.sh
# exit 0

$ git diff --check origin/main...HEAD
# exit 0

$ pnpm -F plugin-integration-core test:runtime
# plugin-runtime-smoke: all assertions passed

$ pnpm -F plugin-integration-core test:http-routes
# http-routes: REST auth/list/upsert/run/dry-run/staging/replay tests passed

$ pnpm -F plugin-integration-core test:http-routes-plm-k3wise-poc
# REST PLM -> K3 WISE mock control-plane chain passed

$ pnpm verify:integration-k3wise:poc
# 37 tests pass + mock chain PASS
```

## 2. Package Build and Verify

```
$ PACKAGE_TAG=k3plugin-local-20260510 scripts/ops/multitable-onprem-package-build.sh
# exit 0

$ scripts/ops/multitable-onprem-package-verify.sh \
    output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-k3plugin-local-20260510.zip
metasheet-multitable-onprem-v2.5.0-k3plugin-local-20260510.zip: OK
[multitable-onprem-package-verify] Package verify OK
```

The generated metadata includes both runtime plugins:

```json
{
  "includedPlugins": [
    "plugin-attendance",
    "plugin-integration-core"
  ]
}
```

The zip contains the integration-core route owner and K3 WISE adapters:

```
$ unzip -l output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-k3plugin-local-20260510.zip \
    | rg 'plugins/plugin-integration-core/(plugin.json|index.cjs|lib/http-routes.cjs|lib/adapters/k3-wise)'
... plugins/plugin-integration-core/plugin.json
... plugins/plugin-integration-core/index.cjs
... plugins/plugin-integration-core/lib/http-routes.cjs
... plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs
... plugins/plugin-integration-core/lib/adapters/k3-wise-sqlserver-channel.cjs
```

Package-shaped offline mock chain also runs from the extracted zip:

```
$ tmpdir=$(mktemp -d)
$ unzip -q output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-k3plugin-local-20260510.zip -d "$tmpdir"
$ pkg_root=$(find "$tmpdir" -mindepth 1 -maxdepth 1 -type d | head -n 1)
$ node "$pkg_root/scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs"
# K3 WISE PoC mock chain verified end-to-end (PASS)
```

## 3. Acceptance Criteria

- Package build succeeds.
- Package verify succeeds.
- The zip contains `plugins/plugin-integration-core`.
- The zip contains the integration HTTP route owner and K3 WISE adapters.
- The plugin runtime smoke test passes.
- The integration HTTP route tests pass.
- The K3 WISE offline PoC still passes.

All criteria passed locally.

## 4. Deployment Expectation

After deploying a package built from this change, authenticated requests to the
K3 WISE setup backend endpoints should no longer return Express `Cannot GET`
404 responses because the plugin route owner is present:

```
GET /api/integration/health
GET /api/integration/external-systems?kind=erp%3Ak3-wise-webapi
GET /api/integration/staging/descriptors
```

If these endpoints still fail, the next diagnostic should be plugin activation
status via `/api/plugins` and backend logs, not frontend routing.
