# K3 WISE Staging Field Contract Guard Design - 2026-04-29

## Context

The K3 WISE postdeploy smoke already checks that the integration plugin exposes
the five staging descriptors required by the PLM-to-ERP cleansing workflow:

- `plm_raw_items`
- `standard_materials`
- `bom_cleanse`
- `integration_exceptions`
- `integration_run_log`

Before this change, that guard stopped at descriptor IDs. A deployment could
return all five descriptor IDs while omitting a critical user-facing field such
as `standard_materials.erpSyncStatus` or
`integration_exceptions.errorMessage`, and the postdeploy smoke would still
pass.

That is a real false-positive risk for the K3 WISE live PoC because the
operator workflow depends on those staging fields to inspect cleansed records,
ERP feedback, exception queues, and run logs.

## Scope

This change tightens only the postdeploy smoke contract. It does not change:

- staging installation behavior.
- multitable provisioning behavior.
- pipeline execution.
- ERP/PLM adapter behavior.
- live data mutation.

The smoke continues to call the authenticated read-only endpoint:

`GET /api/integration/staging/descriptors`

## Required Field Contract

The guard now requires the descriptor field IDs defined by
`plugins/plugin-integration-core/lib/staging-installer.cjs`:

- `plm_raw_items`: source identity, raw payload, fetch timestamp, and run ID.
- `standard_materials`: material master fields plus ERP feedback fields.
- `bom_cleanse`: parent/child BOM line fields, quantity, validity, and status.
- `integration_exceptions`: pipeline/run identity, error payloads, status, and
  human triage fields.
- `integration_run_log`: run identity, mode, counters, timestamps, and error
  summary.

The validator accepts either of these response shapes for forward compatibility:

```json
{ "fields": ["code", "name"] }
```

```json
{ "fields": [{ "id": "code" }, { "id": "name" }] }
```

## Failure Evidence

When a descriptor field is missing, the smoke fails
`staging-descriptor-contract` and records sanitized details:

```json
{
  "missingFields": {
    "standard_materials": ["erpSyncStatus"]
  }
}
```

This keeps deployment evidence actionable without exposing auth tokens or
secret-like values.

The GitHub step summary renderer now also prints known failure-detail groups
for failed checks:

- `missingAdapters`
- `missingRoutes`
- `missingFields`

That means operators can see the exact missing K3 WISE route or staging field in
the workflow summary instead of downloading the JSON artifact first.
