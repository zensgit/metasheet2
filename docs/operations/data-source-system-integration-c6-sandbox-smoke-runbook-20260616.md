# Data Source C6 External-Write Sandbox Smoke Runbook

Purpose: continue #2720 after the package/route preflight has passed but the
entity machine has no sandbox `data-source:sql-write-gated` target or active C6
pipeline yet.

This runbook sets up the minimum sandbox-only shape needed to run the C6
dry-run -> apply -> re-pull -> rollback/cleanup smoke. It does not authorize
production, batch rollout, K3 Save / Submit / Audit / BOM, raw SQL, or broad
writable grants.

## Scope

Allowed:

- configure one sandbox writable SQL data source with C6 safety flags;
- bind one `data-source:sql-write-gated` target external system to that sandbox
  data source;
- bind one active pipeline from an existing `data-source:sql-readonly` source
  to the sandbox target;
- run one values-free C6 dry-run, one token-confirmed apply, and one re-pull
  idempotence check;
- validate rollback/cleanup using operator-local sandbox target controls.

Forbidden:

- production or batch writes;
- using a production table as the sandbox target;
- MetaSheet/product-driven external DB delete;
- raw SQL / query / stored procedure / trigger paths;
- K3 Save / Submit / Audit / BOM;
- credentials, connection strings, SQL text, raw row values, payload JSON,
  target request bodies, dry-run token, private ids, or value-bearing stack
  traces in issue comments.

## Preconditions

- Deploy package `metasheet-multitable-onprem-v2.5.0-datasource-c6-ui-20260616-9fb34fd91`
  or newer.
- Confirm health is `200`.
- Confirm #2720 preflight already sees:
  - `dryRunRoutePresent=true`;
  - `applyRoutePresent=true`;
  - `targetKindRequired=data-source:sql-write-gated`;
  - `dryRunTokenGuardPresent=true`.
- Pick a sandbox database target with a small table or view-like object.
- Pick a least-privilege SQL login for that sandbox target. The account may
  write only the sandbox object required for the smoke.
- Pick one existing read-only source and one source object that can produce a
  small sample row set.

## Configure The Sandbox Write Target

Create or update a `/data-sources` row for the sandbox write target.

Required safety options inside the `/data-sources` row's `options` object:

```json
{
  "readOnly": false,
  "c6WriteTarget": true,
  "genericQueryDisabled": true
}
```

Required posture:

- owner/visibility: the same principal that owns the C6 pipeline can see this
  data-source row;
- credentials: stored only in `/data-sources`, never copied into integration
  external-system config;
- grants: least-privilege write to the sandbox object only;
- generic raw query/delete/copy paths must fail closed for this data source.

Values-free preflight to capture:

```text
sandboxWriteDataSource:
  exists=true|false
  ownerAligned=true|false
  readOnly=false
  c6WriteTarget=true
  genericQueryDisabled=true
  genericRawQueryBlocked=true|false
  genericDeleteBlocked=true|false
  credentialsCopied=false
```

Do not post the data-source id, host, database, username, password, connection
string, or table values.

## Configure The C6 Target External System

Create or update one active target external system.

Required shape:

```json
{
  "kind": "data-source:sql-write-gated",
  "role": "target",
  "status": "active",
  "config": {
    "dataSourceId": "<sandbox data-source reference>",
    "object": "<sandbox schema.table or object>",
    "keyFields": ["<stable external key field>"],
    "writableFields": ["<field written by the smoke>"]
  }
}
```

Rules:

- `keyFields` and `writableFields` must be non-empty arrays;
- the two lists must not overlap;
- keep the field set tiny for the first smoke;
- do not include credentials in this config;
- do not use a production target object.

Recommended first smoke shape:

- one key field, for example `externalId`;
- one writable field, for example `name` or `status`;
- one or two source rows only.

Values-free preflight to capture:

```text
writeGatedTarget:
  exists=true|false
  status=active|inactive|missing
  kind=data-source:sql-write-gated
  role=target
  objectConfigured=true|false
  keyFieldCount=<count>
  writableFieldCount=<count>
  credentialsCopied=false
```

Field names may be reported when they are schema metadata. Do not post row
values or private ids.

## Configure The Active C6 Pipeline

Create one active pipeline, or verify that an existing active pipeline already
has the correct immutable owner and source/target system references:

- `sourceSystemId`: an existing `data-source:sql-readonly` source external
  system;
- `targetSystemId`: the `data-source:sql-write-gated` target external system
  above;
- `createdBy`: the existing pipeline creator, or the principal that creates the
  pipeline. It must be able to see both source and target `/data-sources` rows;
- source object: small approved read-only object;
- target object: sandbox target object;
- field mappings: enough to populate every target `keyField` and
  `writableField`.

Important: normal pipeline updates preserve `createdBy`; they do not repair an
owner mismatch. If `createdBy` is missing or points at a principal that cannot
see both `/data-sources` rows, create a fresh sandbox pipeline under the correct
owner instead of assuming an update fixed it.

Minimal values-free shape:

```json
{
  "status": "active",
  "sourceSystemId": "<read-only source external-system reference>",
  "targetSystemId": "<write-gated target external-system reference>",
  "sourceObject": "<small approved source object>",
  "targetObject": "<sandbox target object>",
  "fieldMappings": [
    { "sourceField": "<source key column>", "targetField": "<target key field>" },
    { "sourceField": "<source writable column>", "targetField": "<target writable field>" }
  ]
}
```

Values-free preflight to capture:

```text
c6Pipeline:
  exists=true|false
  status=active|inactive|missing
  createdByPresent=true|false
  sourceKind=data-source:sql-readonly
  targetKind=data-source:sql-write-gated
  sourceObjectConfigured=true|false
  targetObjectConfigured=true|false
  mappingCoversKeyFields=true|false
  mappingCoversWritableFields=true|false
```

## Smoke Sequence

Run the sequence in order. Stop at the first failure and post values-free
evidence.

### 1. Dry-run

Run C6 dry-run from the UI or route.

Expected:

- dry-run returns `status=ready` or an explicit non-ready status;
- `targetMutatedDuringDryRun=false`;
- no insert/update calls are performed;
- dry-run token is present in the response field but not displayed in evidence;
- response evidence does not include row values.

Evidence:

```text
dryRun:
  status=<ready|not_ready|failed>
  httpStatus=<code>
  canApply=true|false
  counts.add=<count>
  counts.update=<count>
  counts.skip=<count>
  counts.held=<count>
  counts.failed=<count>
  rowErrorTypes=<tokens only>
  tokenPresent=true|false
  tokenDisplayed=false
  targetMutatedDuringDryRun=false
  valuesFreeEvidence=true
```

### 2. Apply

Apply only if dry-run is apply-eligible, a server token exists, and the operator
has explicitly confirmed the review.

Expected:

- read-only users cannot send apply;
- apply consumes the server token;
- apply writes only reviewed add/update rows;
- row failures are isolated;
- dead-letter/provenance evidence is values-free.

Evidence:

```text
apply:
  status=<succeeded|partial|failed|not_run>
  httpStatus=<code>
  counts.add=<count>
  counts.update=<count>
  counts.skip=<count>
  counts.held=<count>
  counts.failed=<count>
  counts.written=<count>
  deadLetters.count=<count>
  provenance.runIdPresent=true|false
  rowErrorTypes=<tokens only>
  dryRunTokenPrinted=false
  valuesFreeEvidence=true
```

### 3. Re-pull / idempotence

Run dry-run again against the same sandbox target after apply.

Expected:

- no duplicate target rows;
- `add=0`;
- `skip` or `update` is acceptable depending on target/source normalization;
- no second apply is required unless explicitly approved.

Evidence:

```text
repull:
  status=<ready|not_ready|failed>
  counts.add=0
  counts.update=<count>
  counts.skip=<count>
  duplicateRowsCreated=false
  valuesFreeEvidence=true
```

### 4. Read-only user check

Using a read-only integration user:

```text
readOnlyUser:
  dryRunAllowed=true|false
  applyButtonEnabled=false
  applyRequestSent=false
```

### 5. Controlled bad-row check

Only run this if the sandbox target can be safely reset.

Expected:

- one controlled bad row creates row-level failure evidence;
- clean sibling rows are not silently swallowed;
- no credentials, raw SQL, row values, or payload JSON appear in evidence.

Evidence:

```text
badRow:
  status=<partial|failed|not_run>
  deadLetters.count=<count>
  rowErrorTypes=<tokens only>
  valuesLeaked=false
```

### 6. Rollback / cleanup

Use operator-local sandbox target controls to restore the sandbox target to the
pre-smoke state. Do not add or exercise any MetaSheet product route for delete,
raw SQL, stored procedure, or broad cleanup.

Expected:

- cleanup is limited to the sandbox target;
- cleanup is performed outside the C6 product write path by the operator's
  approved sandbox maintenance mechanism;
- the product still exposes no generic delete/raw SQL/write-broadening path;
- a post-cleanup dry-run/re-pull shows the expected empty or baseline target
  state.

Evidence:

```text
rollback:
  status=<succeeded|failed|not_run>
  targetResetToBaseline=true|false
  productDeleteRouteUsed=false
  productRawSqlUsed=false
  productionTargetTouched=false
  valuesFreeEvidence=true
```

## Stop Rules

Stop and report HOLD if any of these occur:

- no sandbox `data-source:sql-write-gated` target exists;
- the target data-source is still `readOnly=true`;
- `c6WriteTarget` or `genericQueryDisabled` is missing/false;
- generic raw query/delete remains possible on the target data source;
- pipeline `createdBy` is missing or cannot see the source/target data source;
- mappings do not cover every key/writable field;
- dry-run mutates the target;
- token is displayed or pasted into evidence;
- apply can be sent by a read-only user;
- re-pull produces `add>0` or duplicate rows after an apparently successful
  apply;
- rollback/cleanup cannot restore the sandbox target to its pre-smoke baseline;
- cleanup requires a MetaSheet product delete/raw SQL path;
- any evidence contains credentials, connection strings, raw SQL, row values,
  payload JSON, private ids, or value-bearing stack traces.

## Issue Reply Template

```text
C6 external-write sandbox smoke

packageFingerprint=9fb34fd91
releaseAssetCheck=pass|fail
deploy.applyExit=<code>
health=200|...

sandboxWriteDataSource:
  exists=true|false
  ownerAligned=true|false
  readOnly=false
  c6WriteTarget=true|false
  genericQueryDisabled=true|false
  genericRawQueryBlocked=true|false
  genericDeleteBlocked=true|false
  credentialsCopied=false

writeGatedTarget:
  exists=true|false
  status=active|inactive|missing
  kind=data-source:sql-write-gated
  role=target
  objectConfigured=true|false
  keyFieldCount=<count>
  writableFieldCount=<count>
  credentialsCopied=false

c6Pipeline:
  exists=true|false
  status=active|inactive|missing
  createdByPresent=true|false
  sourceKind=data-source:sql-readonly
  targetKind=data-source:sql-write-gated
  sourceObjectConfigured=true|false
  targetObjectConfigured=true|false
  mappingCoversKeyFields=true|false
  mappingCoversWritableFields=true|false

dryRun:
  status=<ready|not_ready|failed|not_run>
  httpStatus=<code>
  canApply=true|false
  counts.add=<count>
  counts.update=<count>
  counts.skip=<count>
  counts.held=<count>
  counts.failed=<count>
  rowErrorTypes=<tokens only>
  tokenPresent=true|false
  tokenDisplayed=false
  targetMutatedDuringDryRun=false

apply:
  status=<succeeded|partial|failed|not_run>
  httpStatus=<code>
  counts.add=<count>
  counts.update=<count>
  counts.skip=<count>
  counts.held=<count>
  counts.failed=<count>
  counts.written=<count>
  deadLetters.count=<count>
  provenance.runIdPresent=true|false
  rowErrorTypes=<tokens only>
  dryRunTokenPrinted=false

repull:
  status=<ready|not_ready|failed|not_run>
  counts.add=<count>
  counts.update=<count>
  counts.skip=<count>
  duplicateRowsCreated=false

readOnlyUser:
  dryRunAllowed=true|false
  applyButtonEnabled=false
  applyRequestSent=false

badRow:
  status=<partial|failed|not_run>
  deadLetters.count=<count>
  rowErrorTypes=<tokens only>
  valuesLeaked=false

rollback:
  status=<succeeded|failed|not_run>
  targetResetToBaseline=true|false
  productDeleteRouteUsed=false
  productRawSqlUsed=false
  productionTargetTouched=false
  valuesFreeEvidence=true

boundaries:
  productionWrite=false
  batchWrite=false
  productExternalDbDelete=false
  k3Save=false
  k3Submit=false
  k3Audit=false
  k3BomWrite=false
  rawSql=false
  credentialsPrinted=false
  connectionStringPrinted=false
  rowValuesPrinted=false
  payloadJsonPrinted=false
  valuesFreeEvidence=true

operatorDecision=pass|hold|fail
```

## Pass Criteria

Pass requires all of:

- sandbox write target and C6 pipeline are configured and active;
- dry-run is values-free and mutates nothing;
- apply requires token + explicit confirmation + write permission;
- re-pull shows `add=0` and no duplicate target rows;
- read-only user cannot send apply;
- controlled bad-row evidence, if run, is row-level and values-free;
- rollback/cleanup restores the sandbox target baseline without using a
  MetaSheet product delete/raw SQL path;
- all forbidden boundaries remain false.

Passing this runbook closes the C6-5 sandbox smoke gate. It still does not open
production or batch rollout; those require a separate explicit gate.
