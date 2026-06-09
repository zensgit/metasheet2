# Data Factory Large-BOM C3/C4 Entity-Machine Validation Runbook

Date: 2026-06-08

This runbook validates the large-BOM background expansion + checkpoint apply route chain on an entity machine. It is a validation gate before any production/batch rollout.

## Scope

Validate the route chain:

1. start a large-BOM expansion job;
2. run the expansion from the configured PLM SQL source;
3. create the C3 plan artifact from the completed expansion;
4. create a C4 checkpoint apply job from that plan;
5. run checkpoint apply chunks against the configured stock-preparation target;
6. re-check idempotence and evidence hygiene.

This runbook does not authorize production rollout by itself.

## Preconditions

- The deployed package contains the C3/C4 large-BOM route stack.
- The stock-preparation table action is configured server-side.
- The action source is a read-only SQL source.
- The target binding is server-side and target readiness is green.
- Durable plugin storage is enabled. Memory-only storage must fail closed.
- Operator has:
  - integration read permission for expansion/plan;
  - integration write/admin permission for checkpoint apply;
  - permission to inspect the target sheet directly for rollback/idempotence verification.
- Run first on a sandbox or owner-approved validation project, not production.

## Values-Free Evidence Rule

Evidence posted to issues must include only:

- route name;
- status token;
- booleans such as `authoritative`, `artifactRevisionPresent`, `planRevisionPresent`, `targetRevisionPresent`, `approvalPresent`;
- counts such as `rowsExpanded`, `readCount`, `created`, `updated`, `inactive`, `skipped`, `held`, `failed`;
- error type/code tokens;
- whether a job id is present.

Never post:

- project number;
- component code/name/material/source id;
- parent/path/idempotency key;
- raw payload JSON;
- target sheet id or field ids;
- PLM rows;
- credentials, tokens, connection strings, raw SQL, or value-bearing stack traces.

## Validation Steps

### 1. Preflight

Record values-free preflight evidence:

```text
packageFingerprint=<commit-or-release-tag>
routeStackPresent=true|false
authReadRoundTrip=true|false
authWriteRoundTrip=true|false
durableStorage=true|false
targetReadiness=ready|not_ready
```

Stop if `durableStorage=false` or `targetReadiness!=ready`.

### 2. Start Expansion Job

Call:

```text
POST /api/integration/table-actions/{actionId}/large-bom/expansion-jobs
body: { "parameters": { "projectNo": "<operator-local project number>" } }
```

Expected values-free response:

```text
status=queued
largeBom=true
authoritative=false
jobIdPresent=true
projectNoPresent=true
artifactRevisionPresent=false
planRevisionPresent=false
```

Stop if the response exposes a project number, component value, source binding, target sheet id, or principal.

### 3. Run Expansion

Call:

```text
POST /api/integration/table-actions/{actionId}/large-bom/expansion-jobs/{jobId}/run
body: {}
```

Expected values-free response:

```text
status=completed
authoritative=true
artifactRevisionPresent=true
planRevisionPresent=false
rowsExpanded=<count>
readCount=<count>
errorTypes=[]
scaleErrorTypes=[]
```

Stop rules:

- `status=failed`;
- `authoritative=false`;
- any bounded/scale error such as `max_rows_exceeded` or `read_page_limit_exceeded`;
- values leak in response.

If this hits a scale/bounded error, do not continue to C4. Route it back to the large-BOM background-expansion design/runtime track.

### 4. Create Plan Artifact

Call:

```text
POST /api/integration/table-actions/{actionId}/large-bom/expansion-jobs/{jobId}/plan
body: {}
```

Expected values-free response:

```text
status=completed
authoritative=true
artifactRevisionPresent=true
planRevisionPresent=true
plan.expandedRows=<count>
plan.existingRows=<count>
plan.counts.add=<count>
plan.counts.update=<count>
plan.counts.skip=<count>
plan.counts.inactive=<count>
plan.counts.manual_confirm=<count>
```

If `manual_confirm>0`, stop unless the owner has explicitly reviewed the held groups and approved the apply posture. For unresolved duplicate/source-correction groups, do not continue apply.

### 5. Create Checkpoint Apply Job

Call:

```text
POST /api/integration/table-actions/{actionId}/large-bom/expansion-jobs/{jobId}/apply-jobs
body: {
  "confirm": {
    "acceptManualConfirmHold": true|false
  }
}
```

Use `acceptManualConfirmHold=true` only when held rows are explicitly expected to remain held and the owner has approved that posture. It does not make held rows writeable.

Expected values-free response:

```text
status=queued
planRevisionPresent=true
targetRevisionPresent=true
approvalPresent=true
counts.created=0
counts.updated=0
counts.inactive=0
counts.skipped=0
counts.held=0
counts.failed=0
```

Stop if a read-only user can create the apply job.

### 6. Run Checkpoint Apply

Call until terminal:

```text
POST /api/integration/table-actions/{actionId}/large-bom/expansion-jobs/{jobId}/apply-jobs/{applyJobId}/run
body: {}
```

Expected terminal values-free response:

```text
status=succeeded|partial
planRevisionPresent=true
targetRevisionPresent=true
approvalPresent=true
counts.created=<count>
counts.updated=<count>
counts.inactive=<count>
counts.skipped=<count>
counts.held=<count>
counts.failed=<count>
errorCodes=[]
```

Pass condition:

- `failed=0`;
- `held=0` for a clean validation sample, or held rows are explicitly expected and owner-approved;
- target row count changes match `created`;
- updates/inactive decisions affect existing rows only.

Stop rules:

- read-only user can run apply;
- response includes raw values;
- writes land outside the configured stock-preparation target;
- `update` or `inactive` creates a missing row;
- `manual_confirm` writes anything;
- `failed>0` without a reviewed root cause.

### 7. Idempotence Re-Check

Run a fresh expansion + plan on the same validation project after apply.

Expected values-free signal:

```text
secondPlan.counts.add=0
secondPlan.counts.manual_confirm=0 for the clean sample
secondPlan.counts.update=<count> or secondPlan.counts.skip=<count>
```

`update` is acceptable if string-vs-number normalization still produces refresh differences. The hard pass signal is `add=0`: the writer must not create duplicate rows for the same applied large-BOM result.

### 8. Rollback / Cleanup

For sandbox validation, clean up only through the target system's normal admin surface.

If rollback is needed:

- remove rows created by this validation run using operator-local keys;
- do not post those keys to issue evidence;
- keep held/manual-confirm rows untouched because they should not have been written.

## Issue Evidence Template

```text
Large-BOM C3/C4 entity-machine validation

packageFingerprint=
durableStorage=
targetReadiness=

start:
  status=
  jobIdPresent=
  projectNoPresent=

run:
  status=
  authoritative=
  artifactRevisionPresent=
  rowsExpanded=
  readCount=
  errorTypes=

plan:
  planRevisionPresent=
  expandedRows=
  existingRows=
  add=
  update=
  skip=
  inactive=
  manual_confirm=

apply:
  status=
  targetRevisionPresent=
  approvalPresent=
  created=
  updated=
  inactive=
  skipped=
  held=
  failed=
  errorCodes=

idempotence:
  secondPlan.add=
  secondPlan.updateOrSkip=
  duplicateRowsCreated=false

valuesFreeEvidence=true
operatorDecision=pass|hold|fail
```

## Gate Outcome

Only after this validation passes may the team discuss production/batch rollout. A failed or held validation keeps production/batch closed and routes the result back to the relevant slice:

- bounded/scale failure: large-BOM background expansion capacity;
- manual-confirm/duplicate held: D4 duplicate policy track;
- write failure: C4 target write/readiness track;
- values leak: evidence/redaction hardening.
