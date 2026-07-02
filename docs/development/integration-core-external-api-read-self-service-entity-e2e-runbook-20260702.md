# External API Read Self-Service — Entity-Machine E2E Runbook — 2026-07-02

## Status

PREPARED. This runbook verifies the merged external-API read self-service line
against a provisioned entity environment. It does not add runtime code and does
not authorize any write/delete path.

Source of truth for the shipped line:

- completion report:
  `docs/development/integration-core-external-api-read-self-service-line-completion-dev-verification-20260702.md`
- minimum code baseline: main at or after `57937db0a`

## Scope

This runbook proves the S0 -> S3 read-only self-service chain is usable end to
end on a real deployed environment:

1. consultant creates a read-source config through the self-service panel;
2. consultant runs a locate-container probe;
3. consultant saves a version;
4. consultant approves the version;
5. runtime caller reads through
   `POST /api/integration/read-source-configs/:id/read` with only named inputs;
6. evidence remains values-free and data is limited to the configured fieldMap.

## Out Of Scope

The following remain separate gates and must not be inferred from this run:

- write/delete, Save/Submit/Audit, production or external writes;
- host-allowlist widening;
- terminal-user free-form endpoint/body/filter/response-path input;
- `resolver_lookup` runtime execution;
- recursive composition, BOM explosion, or material-to-bill resolver chains;
- new credential storage paths.

## Preconditions

1. Deploy a package built from main at or after `57937db0a`.
2. Confirm migration `062_create_integration_read_source_configs.sql` is applied
   (tables `integration_read_source_configs` + `integration_read_source_config_audit`
   exist). The CI deploy lane (`docker-build.yml` deploy job) runs `migrate.js`
   automatically after image pull; any other deploy path MUST run the migration
   step manually before this runbook. A save-version 500 on an un-migrated
   database is a deployment gap, not a config error.
3. The environment has one registered external system that is safe for read-only
   smoke testing.
4. Credentials are stored through the existing backend credential store; do not
   paste credentials into the read-source config.
5. Pick one non-sensitive sample key approved by the operator/customer.
6. Pick a small values-safe fieldMap target list. Do not include secret fields
   or customer identifiers in evidence.
7. Use an integration write/operator user for config-time actions. Use an
   integration read-capable user for runtime read.
8. Know the target `tenantId` / `workspaceId` scope for the test user. The raw
   HTTP calls below carry them explicitly so the run does not depend on token
   claims alone.

## Operator Inputs

Fill these locally; do not paste values into GitHub comments unless redacted.

```text
deployedMainSha=<sha>
baseUrl=<entity host>
systemId=<registered external system id>
requiredKind=<external system kind>
object=<object name>
mode=<single_record|list_page|detail_with_lines>
readPath=<relative path only>
readMethod=<GET|POST>
sampleKey=<private approved key>
fieldMapTargets=<target field names only>
tenantId=<tenant scope of the test users>
workspaceId=<workspace scope or empty>
boundedSmoke=true
```

### K3-kind constraint hint (erp:k3-wise-webapi systems)

The K3 WISE adapter hard-restricts read objects and key fields:

- `single_record`: `object=material`, `keyField=FNumber`;
- `list_page`: `object=material`, no runtime key by default;
- `detail_with_lines`: `object=material-bom`, `keyField=FBillNo`.

A config outside these bounds will save and approve normally but the probe/read
will fail with a coarse `READ_SOURCE_PROBE_REJECTED` — that is the adapter
scope guard, not an S1 validation problem.

## Test Steps

### 1. Config-time panel smoke

Open the Integration workbench read-source config panel and create a draft using
the selected registered system.

Expected:

- the panel accepts only the four configured read modes;
- `readPath` is stored as a relative path;
- no credential field is visible or persisted in the config;
- probe/save buttons remain disabled until required mode fields are present.

### 2. Locate-container probe

Enable the bounded-smoke checkbox (`data-testid=rsc-bounded-smoke`; it defaults
to OFF) — the expected block below requires `boundedSmokeExecuted=true` and a
record count. Then run the probe with the approved sample key when the mode
declares a key.

Expected values-free evidence:

```text
probeHttpOk=true
probeOk=true
containerLocated=true
boundedSmokeExecuted=true
recordCount=<0..10>
capReached=<true|false>
containerAliases=<alias list only>
containerTypes=<type per alias>
containerArrayLengths=<count/null per alias>
rawValuesIncluded=false
credentialIncluded=false
readPathIncluded=false
sampleKeyEchoed=false
writeExecuted=false
```

Stop if:

- probe evidence includes row values, field values, host, credential material,
  raw path text, or the sample key;
- probe requires a raw endpoint/body/filter supplied by the runtime caller;
- write/delete/Save/Submit/Audit is invoked.

### 3. Save version

Save the same config twice.

Expected:

```text
firstSaveStatus=201
firstSaveStatusName=draft
secondSaveStatus=200
secondSaveReused=true
versionStable=true
auditActions=save_version,reuse_version
storedCredentialReferenceOnly=true
probeResponseStored=false
```

### 4. Approve

Approve the draft version.

Expected:

```text
approveStatus=200
configStatus=approved
auditAction=status_change
auditDetailValuesFree=true
```

### 5. Runtime read

Call the runtime route as an integration read-capable user:

```http
POST /api/integration/read-source-configs/<configId>/read?tenantId=<tenantId>&workspaceId=<workspaceId>
Content-Type: application/json

{
  "inputs": {
    "key": "<private sample key>"
  }
}
```

For modes without a key, omit `inputs.key` only if the saved config declares no
key field.

Expected:

```text
runtimeHttpOk=true
runtimeEvidenceOk=true
runtimeDataPresent=true
runtimeRecordCount=<0..10; detail_with_lines sums header+lines and may reach 20>
runtimeEvidenceValuesFree=true
runtimeDataOnlyFieldMapTargets=true
unmappedRawFieldsDropped=true
sampleKeyEchoedInEvidence=false
rawEndpointBodyFilterAccepted=false
writeExecuted=false
```

Negative control in the same deployed build:

```http
POST /api/integration/read-source-configs/<configId>/read?tenantId=<tenantId>&workspaceId=<workspaceId>

{
  "inputs": { "key": "<private sample key>" },
  "config": { "readPath": "https://evil.example.invalid/path" }
}
```

Expected:

```text
runtimeSmuggleStatus=400
runtimeSmuggleCode=READ_SOURCE_READ_CONTRACT_INVALID
rawPathEchoed=false
adapterReadExecuted=false
```

### 6. Retire

Retire the approved config, then call the runtime read route again.

Expected:

```text
retireStatus=200
configStatus=retired
postRetireRuntimeStatus=409
postRetireRuntimeCode=READ_SOURCE_CONFIG_NOT_APPROVED
postRetireAdapterReadExecuted=false
```

## Report Back

Post only this values-free block:

```text
EXTERNAL_API_READ_SELF_SERVICE_ENTITY_E2E
deployedMainSha=<sha>
configMode=<single_record|list_page|detail_with_lines>
probeOk=<true|false>
containerLocated=<true|false>
probeRecordCount=<count>
saveFirstStatus=<201|other>
saveSecondReused=<true|false>
approveStatus=<200|other>
runtimeEvidenceOk=<true|false>
runtimeRecordCount=<count>
runtimeDataOnlyFieldMapTargets=<true|false>
runtimeSmuggleStatus=<400|other>
retireStatus=<200|other>
postRetireRuntimeStatus=<409|other>
rawValuesIncluded=false
sampleKeyEchoed=false
credentialIncluded=false
writeExecuted=false
resolverLookupExecuted=false
```

Do not include sample keys, row values, hostnames, credentials, raw response
payloads, material numbers, bill numbers, customer ids, or field values.

## PASS Criteria

The entity-machine E2E is PASS only if:

- the deployed SHA is on or after `57937db0a`;
- probe, save/reuse, approve, runtime read, smuggle rejection, and retire
  rejection all match the expected statuses;
- runtime evidence is values-free;
- runtime data contains only configured fieldMap target fields;
- no write/delete/Save/Submit/Audit path is executed;
- `resolver_lookup` is not executed.

## Failure Handling

- If save-version returns 500, check migration 062 first (Preconditions step 2)
  before anything else.
- If probe fails before outbound, inspect S1 config validation errors; do not
  loosen endpoint/path rules. On K3-kind systems also re-check the object /
  keyField constraint hint above (adapter scope guard rejects out-of-bound
  objects with a coarse code AFTER S1 passes).
- If probe succeeds but runtime read fails, compare the approved stored config
  and runtime `{inputs}` only; do not add raw runtime config keys.
- If evidence leaks values, stop and file a blocker. Do not post raw logs.
- If a write path is touched, stop and treat it as a security regression.
