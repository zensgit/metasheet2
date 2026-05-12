# K3 WISE Template On-Prem Package Refresh Verification - 2026-05-12

## Scope

Verify the on-prem package built from main after PR #1476 so the next
Windows/entity-machine deployment can test:

- K3 WISE setup page template cards
- material/BOM field mapping table
- read-only K3 `Data` JSON preview
- dry-run target payload preview
- Save-only material/BOM mock chain

Workflow run:

- URL: `https://github.com/zensgit/metasheet2/actions/runs/25718709234`
- workflow: `Multitable On-Prem Package Build`
- conclusion: `success`
- head SHA: `6777e3d80ab66ab5b489da2c3ae4b46c7f532524`
- event: `workflow_dispatch`

## Artifact Download

Command:

```bash
rm -rf /tmp/metasheet2-k3wise-onprem-25718709234
mkdir -p /tmp/metasheet2-k3wise-onprem-25718709234
gh run download 25718709234 \
  --repo zensgit/metasheet2 \
  -n multitable-onprem-package-25718709234-1 \
  -D /tmp/metasheet2-k3wise-onprem-25718709234
```

Downloaded files:

```text
/tmp/metasheet2-k3wise-onprem-25718709234/SHA256SUMS
/tmp/metasheet2-k3wise-onprem-25718709234/metasheet-multitable-onprem-v2.5.0-k3wise-templates-6777e3d.json
/tmp/metasheet2-k3wise-onprem-25718709234/metasheet-multitable-onprem-v2.5.0-k3wise-templates-6777e3d.tgz
/tmp/metasheet2-k3wise-onprem-25718709234/metasheet-multitable-onprem-v2.5.0-k3wise-templates-6777e3d.tgz.sha256
/tmp/metasheet2-k3wise-onprem-25718709234/metasheet-multitable-onprem-v2.5.0-k3wise-templates-6777e3d.zip
/tmp/metasheet2-k3wise-onprem-25718709234/metasheet-multitable-onprem-v2.5.0-k3wise-templates-6777e3d.zip.sha256
```

## Checksums

```text
47b990a95f65bd00aa6a1b505f3c858db915e7b1a7b461ce6a01121a646e031e  metasheet-multitable-onprem-v2.5.0-k3wise-templates-6777e3d.zip
38d2d1785a6266c8266cc0c06b7f518947286c7df22187a57b5c4a1cad5557b1  metasheet-multitable-onprem-v2.5.0-k3wise-templates-6777e3d.tgz
```

## Package Metadata

```json
{
  "name": "metasheet-multitable-onprem-v2.5.0-k3wise-templates-6777e3d",
  "version": "2.5.0",
  "tag": "k3wise-templates-6777e3d",
  "attendanceOnly": false,
  "productMode": "platform",
  "includedPlugins": ["plugin-attendance", "plugin-integration-core"],
  "archive": "metasheet-multitable-onprem-v2.5.0-k3wise-templates-6777e3d.tgz",
  "archiveZip": "metasheet-multitable-onprem-v2.5.0-k3wise-templates-6777e3d.zip",
  "checksumFile": "SHA256SUMS",
  "generatedAt": "2026-05-12T06:58:37Z"
}
```

## Verify Script

Commands:

```bash
scripts/ops/multitable-onprem-package-verify.sh \
  /tmp/metasheet2-k3wise-onprem-25718709234/metasheet-multitable-onprem-v2.5.0-k3wise-templates-6777e3d.zip

scripts/ops/multitable-onprem-package-verify.sh \
  /tmp/metasheet2-k3wise-onprem-25718709234/metasheet-multitable-onprem-v2.5.0-k3wise-templates-6777e3d.tgz
```

Result:

```text
metasheet-multitable-onprem-v2.5.0-k3wise-templates-6777e3d.zip: OK
metasheet-multitable-onprem-v2.5.0-k3wise-templates-6777e3d.tgz: OK
```

## K3 WISE Content Checks

The zip contains the template runtime:

```text
plugins/plugin-integration-core/lib/adapters/k3-wise-document-templates.cjs
plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs
```

The zip contains the built K3 WISE setup page assets:

```text
apps/web/dist/assets/IntegrationK3WiseSetupView-DUXQEbav.css
apps/web/dist/assets/IntegrationK3WiseSetupView-B4rDUAbD.js
```

The zip contains the K3 PoC scripts and runbooks:

```text
scripts/ops/integration-k3wise-live-poc-preflight.mjs
scripts/ops/integration-k3wise-live-poc-evidence.mjs
scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs
docs/operations/integration-k3wise-live-gate-execution-package.md
docs/operations/k3-poc-onprem-preflight-runbook.md
```

## Result

The `k3wise-templates-6777e3d` on-prem package is ready for the next
Windows/entity-machine deployment test.

Use:

```text
/tmp/metasheet2-k3wise-onprem-25718709234/metasheet-multitable-onprem-v2.5.0-k3wise-templates-6777e3d.zip
```

Do not use older K3 WISE packages for ERP/PLM template verification, because
they do not include PR #1476's template registry and dry-run K3 payload preview.

## Remaining Live Blocker

Customer live K3 WISE remains blocked on GATE answers. The package is ready for
local/on-prem configuration and dry-run preview testing, but a real K3 Save-only
run still needs customer K3 URL, account set, credentials, unit-code mapping,
and rollback agreement.
