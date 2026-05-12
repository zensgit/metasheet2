# K3 WISE Template On-Prem Package Refresh Development - 2026-05-12

## Purpose

Produce a Windows/on-prem deployment package after the K3 WISE material/BOM
document-template work landed in main.

This is an operations packaging slice. The product code already landed through
PR #1476:

- merge commit: `de3ba19ae`
- scope: K3 WISE material/BOM template registry, dry-run K3 `Data` payload
  preview, setup-page template preview, and package verify coverage

The package in this refresh was built from current main:

- package source SHA: `6777e3d80ab66ab5b489da2c3ae4b46c7f532524`
- package tag: `k3wise-templates-6777e3d`

## Workflow

Triggered GitHub Actions workflow:

- workflow: `Multitable On-Prem Package Build`
- run id: `25718709234`
- run URL: `https://github.com/zensgit/metasheet2/actions/runs/25718709234`
- branch/ref: `main`
- package tag: `k3wise-templates-6777e3d`
- publish release: `false`

Command:

```bash
gh workflow run "Multitable On-Prem Package Build" \
  --repo zensgit/metasheet2 \
  --ref main \
  -f package_tag=k3wise-templates-6777e3d \
  -f publish_release=false
```

## Output

Artifact:

- `multitable-onprem-package-25718709234-1`

Files:

- `metasheet-multitable-onprem-v2.5.0-k3wise-templates-6777e3d.zip`
- `metasheet-multitable-onprem-v2.5.0-k3wise-templates-6777e3d.tgz`
- `metasheet-multitable-onprem-v2.5.0-k3wise-templates-6777e3d.json`
- `SHA256SUMS`

Local download path used for verification:

```text
/tmp/metasheet2-k3wise-onprem-25718709234/
```

## Deployment Meaning

Use the new `k3wise-templates-6777e3d` zip for the next Windows/entity-machine
installation test.

It supersedes earlier K3 WISE packages for ERP/PLM template testing because it
includes:

- simplified K3 WISE setup page
- K3 WISE material/BOM document template registry
- K3 setup-page template mapping table and read-only JSON preview
- dry-run target K3 `Data` payload preview
- K3 offline PoC mock chain updated to the v1 BOM template fields
- packaged integration plugin backend and K3 operator runbooks

## Deployment Order

For a Windows/on-prem test box:

1. Install or upgrade with the generated zip.
2. Run the multitable on-prem preflight.
3. Log in and open the K3 WISE setup page.
4. Save K3 WebAPI configuration.
5. Review `K3 单据模板` for material and BOM mappings.
6. Use the JSON preview to confirm the generated `{ "Data": ... }` payload.
7. Create draft pipelines.
8. Run dry-run first and inspect `preview.records[].targetPayload.Data`.
9. Only then enable Save-only live execution for 1-3 test rows.

Submit/Audit remains outside this package refresh. It still needs explicit
customer approval through the GATE process.

## Non-Goals

This refresh does not:

- publish a GitHub Release
- add or change database migrations
- run against a real customer K3 WISE endpoint
- validate customer unit-code dictionaries beyond the seed `PCS` / `EA` / `KG`
- enable purchase order, sales order, stock-in, or other K3 document templates
- deploy to the Windows server from this local session
