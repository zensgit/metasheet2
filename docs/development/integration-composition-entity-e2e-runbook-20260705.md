# Read-Source Resolver Composition — Entity-Machine E2E Acceptance Runbook — 2026-07-05

## Status

PREPARED. This runbook verifies the merged read-only composition line (#1709,
materialNumber → FItemID → FBOMNumber) against a provisioned entity
environment. It does not add runtime code and does not authorize any
write/Save/Submit/Audit path or recursive/unbounded BOM expansion.

Source of truth for the shipped line:

- arc ledger: `docs/development/integration-read-source-resolver-composition-cr0-cr3-dev-verification-20260705.md`
  (§8 records the C-R4 addendum this runbook exercises)
- direction design-lock: `docs/development/integration-read-source-resolver-composition-design-lock-20260703.md`
- sibling standalone-read-line runbook this mirrors in structure/tone/discipline:
  `docs/development/integration-core-external-api-read-self-service-entity-e2e-runbook-20260702.md`
- minimum code baseline: main at or after `9d0acd199`

## Purpose

Prove the two-step chain is usable end to end, by a real operator, against a
real deployed environment, with the same values-free discipline as the
standalone read line:

1. a consultant authors and approves two `resolver_lookup` read-source
   configs (the two hops);
2. the consultant authors and approves a composition config that wires hop 1's
   resolved output to hop 2's key;
3. an operator runs the approved composition through the C-R4-3b panel (or the
   run route directly) with only the first business key;
4. the chain resolves `FBOMNumber` without ever exposing the intermediate
   `FItemID`, and every evidence surface stays values-free;
5. draft/retired compositions and request-contract smuggling are rejected
   fail-closed with the documented coarse codes.

## Scope Fence

This run proves the **read-only** composition chain only. The following are
explicitly **not** exercised, not authorized, and must not be inferred from a
PASS result:

- any write / Save / Submit / Audit / external write / production write —
  production external write is customer-barred
  (`SaveSubmitAuditK3Write` / `externalWrite` / `productionWrite` = false);
- recursive / unbounded BOM expansion (fan-out, cycle detection, per-level
  budget) — a separate, later, un-designed rung;
- host-allowlist widening, new credential storage paths, or terminal-user
  free-form endpoint/body/filter/response-path input;
- any composition deeper than the fixed two-hop v1 shape;
- auto-selection by status/version/date (`automaticSelectionByStatusVersionDate`
  stays `false` — the chain never silently picks among candidates).

All evidence produced or pasted during this run must stay **values-free**:
material numbers, resolved values (the intermediate `FItemID`, the final
`FBOMNumber`), row content, read paths, hosts, credentials, and tenant/system
ids never leave the operator's own screen. See "Values-Free Evidence
Template" below for the exact allow/deny lists.

## Preconditions

1. Deploy a package built from main at or after `9d0acd199` — the tip of the
   C-R4 composition chain (`665504041` C-R1 → `7e9c844d4` C-R2 →
   `cfd3dcd06` C-R2 hardening → `e68fe39ce` C-R3 → `7821f7764` C-R4-1 route →
   `3779121f1` C-R4-2 vocab mirror → `4899c608d` C-R4-3a service →
   `8c6ddaa3d` C-R4-3b panel → `407d4592f` / `9d0acd199` hardening).
2. Confirm migration `063_create_integration_read_source_composition_configs.sql`
   is applied (tables `integration_read_source_composition_configs` +
   `integration_read_source_composition_config_audit` exist), **in addition
   to** migration `062_create_integration_read_source_configs.sql` (the
   composition's two steps are ordinary `read-source-configs` rows). The CI
   deploy lane (`docker-build.yml` deploy job) runs `migrate.js`
   automatically after image pull; any other deploy path MUST run the
   migration step manually before this runbook. A save-version 500 on an
   un-migrated database is a deployment gap, not a config error.
3. **K3 system credentials are registered on the deploy box.** This is a
   known, previously-hit gap on this same line: the standalone read-line's
   real-machine acceptance (`integration-core-external-api-read-self-service-line-completion-dev-verification-20260702.md`
   §8.2) hit `K3_WISE_CREDENTIALS_MISSING` on the first round because the
   registered external system had no stored credentials on that box — the
   platform chain itself was fully green. Composition adds a second outbound
   hop, so confirm credentials are registered **before** starting Phase 1;
   otherwise every run degrades to a generic hop failure that looks like a
   composition bug (see Troubleshooting).
4. Two accounts:
   - an **integration write-tier account** (consultant/admin) for all
     config-time actions (save/approve/retire, for both the step configs and
     the composition);
   - an **integration read-tier account** (operator) for the run route only.
5. One real material number the operator is authorized to test with,
   approved by the customer for this smoke. Keep it local; never paste it.
6. The target `tenantId` / `workspaceId` scope for both test users. The raw
   HTTP calls below carry them explicitly so the run does not depend on token
   claims alone.
7. Two already-approved `resolver_lookup` read-source configs are the
   building blocks this runbook creates in Phase 1 — if your box already has
   them from an earlier standalone-resolver run, you may reuse the approved
   step-1 config and skip straight to authoring the composition, but still
   re-probe step 2 if it is new.

### Known authoring-surface gap

There is no dedicated composition-authoring UI yet (only the C-R4-3b
**run** panel shipped). The two step read-source configs can be authored
through the existing consultant panel
(`IntegrationReadSourceConfigPanel.vue`, workbench "读取源配置"); the
composition config itself (save/approve/retire) has **API-only** authoring
today. This is expected, not a defect — note it in your acceptance report if
asked "why no composition-authoring screenshot."

## Operator Inputs

Fill these locally; do not paste values into GitHub comments unless
redacted.

```text
deployedMainSha=<sha>
baseUrl=<entity host>
systemId=<registered K3 external system id>
tenantId=<tenant scope of the test users>
workspaceId=<workspace scope or empty>
step1ConfigId=<step-1 read-source config id, once created>
step2ConfigId=<step-2 read-source config id, once created>
compositionId=<composition config id, once created>
sampleMaterialNumber=<private approved material number>
```

## Phase 1 — Authoring (consultant, write-tier)

### 1.1 Step-1 read-source config (material → internal_id)

This shape was live-verified on 2026-07-04 (standalone resolver smoke,
`docs/development/integration-read-source-resolver-remaining-scope-dev-verification-20260703.md`
§7.2) — treat it as the proven anchor for hop 1. The target field name below
is renamed `internal_id` (from that smoke's `resolved_item_id`) to match the
composition handoff wiring in step 1.3; the resolved field and rule are
unchanged.

Create via the read-source consultant panel (`rsc-mode` = `resolver_lookup`)
or `POST /api/integration/read-source-configs`:

```text
object=material
mode=resolver_lookup
readPath=<box's real material-detail read path, e.g. /K3API/Material/GetDetail>
keyField=FNumber
containerPaths=<box's real container path — confirm with the locate-container probe first>
resolverRule=exactly_one
fieldMap=[{ source: "<box-specific path to FItemID>", target: "internal_id" }]
```

Run the bounded locate-container probe first (same as the read-line runbook
Phase 1/2) to confirm the container path before saving. Then:

- save (draft, expect `201`);
- approve (expect `200`, `configStatus=approved`).

### 1.2 Step-2 read-source config (internal_id → bom_number)

Unlike step 1, this shape has **not** yet been proven live on this box for
the BOM-by-item read — probe it before you save/approve, using the same
consultant panel / probe workflow.

```text
object=<box's real BOM object identifier, e.g. bom>
mode=resolver_lookup
readPath=<box's real BOM-by-item read path, e.g. /K3API/BOM/GetList>
keyField=FItemId
containerPaths=<box's real container path — confirm with the locate-container probe>
resolverRule=<exactly_one preferred; use first_when_sorted / field_equals only if the
  object legitimately returns multiple rows per FItemId with a documented tie-break>
fieldMap=[{ source: "<box-specific path to FBOMNumber>", target: "bom_number" }]
```

- probe → save (draft, `201`) → approve (`200`, `configStatus=approved`).

### 1.3 Composition config (wires step 1's output to step 2's key)

No authoring UI — use the API directly as the write-tier account:

```http
POST /api/integration/read-source-compositions?tenantId=<tenantId>&workspaceId=<workspaceId>
Content-Type: application/json

{
  "config": {
    "version": 1,
    "name": "material_to_bom_v1",
    "operations": ["read"],
    "steps": [
      { "id": "resolve_item", "readSourceConfigId": "<step1ConfigId>" },
      {
        "id": "resolve_bom",
        "readSourceConfigId": "<step2ConfigId>",
        "input": { "fromStep": "resolve_item", "sourceTarget": "internal_id", "toInput": "key" }
      }
    ]
  }
}
```

Expected:

```text
compositionSaveStatus=201
compositionSaveStatusName=draft
```

**Before approving**, you may run Phase 3.1's draft-rejection negative check
right now against this same id (see Phase 3) — it is the natural point to
exercise it without needing a disposable throwaway composition.

Then approve:

```http
POST /api/integration/read-source-compositions/<compositionId>/approve?tenantId=<tenantId>&workspaceId=<workspaceId>
```

```text
compositionApproveStatus=200
compositionStatus=approved
```

## Phase 2 — Run (operator, read-tier)

Use the C-R4-3b panel (`IntegrationReadSourceCompositionPanel.vue`,
`data-testid=read-source-composition-panel`):

1. click 刷新组合列表 (`rscomp-refresh`) — the approved composition from
   Phase 1 appears in the `rscomp-select` dropdown;
2. select it;
3. enter the real material number in `rscomp-key`;
4. click 运行 (`rscomp-run`).

Or call the run route directly:

```http
POST /api/integration/read-source-compositions/<compositionId>/run?tenantId=<tenantId>&workspaceId=<workspaceId>
Content-Type: application/json

{
  "inputs": { "key": "<sample material number>" }
}
```

### Expected outcomes

Every outcome below is `HTTP 200` — the run route only returns a non-200
status for a request-contract violation (Phase 3) or an unapproved
composition (Phase 3 / 4). A resolved-vs-failed chain is expressed entirely
inside the values-free `{evidence, data}` body.

| Outcome | `evidence.ok` | `failedStep` | representative `steps[]` | `data` | Meaning |
| --- | --- | --- | --- | --- | --- |
| **Resolved** | `true` | `null` | `[{step:0,ok:true,rule:"exactly_one"},{step:1,ok:true,rule:"exactly_one"}]` | `{resolver:{target:"bom_number", value:<the resolved number>}}` | Full chain success. The resolved value renders in `rscomp-output-value` **to the authorized operator only** — never copy it into a public issue/evidence. |
| **NO_MATCH** | `false` | the failing ordinal | `{step:N, ok:false, errorCode:"READ_SOURCE_RESOLVER_NO_MATCH"}` then `{step:N+1, ok:false, errorCode:"READ_SOURCE_COMPOSITION_STEP_NOT_RUN"}` | `null` | That hop's key matched zero candidate rows (material not found, or the resolved `internal_id` has no BOM). Downstream hop never ran. |
| **AMBIGUOUS** | `false` | the failing ordinal | `{step:N, ok:false, errorCode:"READ_SOURCE_RESOLVER_AMBIGUOUS"}` | `null` | More than one candidate row matched at that hop. The platform never auto-picks by status/version/date (design-lock lock 4) — this is a hold, not a bug. |
| **STEP_OUTPUT_NOT_SCALAR** | `false` | `0` (only hop 0 can hit this in v1 — a scalar handoff is required between the two steps) | `{step:0, ok:false, errorCode:"READ_SOURCE_COMPOSITION_STEP_OUTPUT_NOT_SCALAR"}` | `null` | Hop 1 resolved, but its declared output target is not a chain-usable scalar (e.g. a boolean/object field mapped by mistake). Fix step 1's `fieldMap` target, not a data problem. |
| **STEP_FAILED (generic)** | `false` | the failing ordinal | `{step:N, ok:false, errorCode:"READ_SOURCE_COMPOSITION_STEP_FAILED"}` | `null` | A hop-level exception (kind mismatch, credentials missing, network error, malformed step config) collapsed to the coarse code — see Troubleshooting; this code alone does not tell you *which* of those it was. |
| **STEP_NOT_RUN** | `false` | (always paired with an earlier failing ordinal) | `{step:N, ok:false, errorCode:"READ_SOURCE_COMPOSITION_STEP_NOT_RUN"}` | `null` | Confirms lock 4: every ordinal after the first failure is clamped `STEP_NOT_RUN`, never executed. It never appears as the *first* failing step. |

A container-path or shape mismatch surfaces with its own specific resolver
code (`READ_SOURCE_RESOLVER_CONTAINER_NOT_FOUND` /
`READ_SOURCE_RESOLVER_SHAPE_MISMATCH`) in the same `steps[]` slot as
NO_MATCH/AMBIGUOUS above — because the resolver evaluator *returns* a
failed-but-typed outcome rather than throwing. Kind mismatch and credential
failures, by contrast, are thrown exceptions inside the hop and always
collapse to the generic `STEP_FAILED` (see Troubleshooting for how to tell
them apart).

## Phase 3 — Negative Checks

### 3.1 Run a draft (unapproved) composition

```http
POST /api/integration/read-source-compositions/<compositionId>/run?tenantId=<tenantId>&workspaceId=<workspaceId>

{ "inputs": { "key": "<placeholder>" } }
```

Run this against the composition from Phase 1.3 **before** its approve call
(or against a disposable second draft composition if you prefer to keep the
main chain uninterrupted).

Expected:

```text
draftRunStatus=409
draftRunCode=READ_SOURCE_COMPOSITION_CONFIG_NOT_APPROVED
draftRunAdapterReadExecuted=false
```

### 3.2 Body smuggle (config override)

```http
POST /api/integration/read-source-compositions/<compositionId>/run?tenantId=<tenantId>&workspaceId=<workspaceId>

{
  "inputs": { "key": "<placeholder>" },
  "config": { "steps": [] }
}
```

Expected:

```text
smuggleRunStatus=400
smuggleRunCode=READ_SOURCE_COMPOSITION_RUN_CONTRACT_INVALID
smuggleRunReason=unexpected_field
rawConfigAccepted=false
adapterReadExecuted=false
```

This is rejected by the route's own top-level body allowlist **before** the
composition or either step config is even loaded — the same discipline as
the standalone read line's smuggle rejection. A per-hop key smuggle
(`{"inputs":{"key":"...","step1Key":"..."}}`) is rejected the same way with
`smuggleRunReason=inputs_unexpected_field`, one layer deeper (after the
approved-only loads, inside the chain executor's own request normalizer) —
optional to exercise but useful if you want to confirm both smuggle layers.

## Phase 4 — Cleanup

Retire the composition, then confirm the runtime route rejects it:

```http
POST /api/integration/read-source-compositions/<compositionId>/retire?tenantId=<tenantId>&workspaceId=<workspaceId>
```

```text
compositionRetireStatus=200
compositionStatus=retired
postRetireRunStatus=409
postRetireRunCode=READ_SOURCE_COMPOSITION_CONFIG_NOT_APPROVED
postRetireAdapterReadExecuted=false
```

Then retire both step read-source configs (housekeeping — not required to
re-test, since the composition itself is already retired and the runtime
route is already unreachable):

```http
POST /api/integration/read-source-configs/<step1ConfigId>/retire?tenantId=<tenantId>&workspaceId=<workspaceId>
POST /api/integration/read-source-configs/<step2ConfigId>/retire?tenantId=<tenantId>&workspaceId=<workspaceId>
```

```text
step1RetireStatus=200
step2RetireStatus=200
```

## Values-Free Evidence Template

### MAY be pasted into issues/reports

- `deployedMainSha`;
- HTTP status codes (`201`/`200`/`404`/`409`/`400`);
- `evidence.ok` / `evidence.failedStep` (boolean / integer ordinal);
- the per-step vector `{step, ok, rule?, errorCode?}` — `rule` and
  `errorCode` are closed-vocabulary tokens (`READ_SOURCE_COMPOSITION_*`,
  `READ_SOURCE_RESOLVER_*`, `READ_SOURCE_PROBE_*`), never free text;
- config/composition **status** values (`draft`/`approved`/`retired`);
- your own derived booleans for the report (e.g. `resolvedPresent=true`,
  `writeExecuted=false`).

### MUST NOT be pasted into issues/reports

- the sample material number, or any other business key;
- any resolved value — the intermediate `internal_id`/`FItemID` or the
  final `bom_number`/`FBOMNumber`;
- row content or raw adapter/API response payloads;
- read paths, endpoints, or container paths (these are box-specific
  structural metadata — keep them in your local notes, not in a shared
  issue, unless the customer has explicitly approved sharing that shape);
- hostnames or any part of a URL beyond what this doc already shows as a
  placeholder;
- credentials, tokens, or session material;
- tenant id, system id, or config/composition ids — unless a specific
  escalation deliberately requires it and the customer has approved sharing
  it.

Composition evidence never carries a row/candidate count the way probe
evidence does (no `candidateCount`/`recordCount` field exists at the chain
level) — if you find one in a response body, stop; that is a leak, not a
feature.

## Report Back

Post only this values-free block:

```text
COMPOSITION_ENTITY_E2E
deployedMainSha=<sha>
step1SaveStatus=<201|other>
step1ApproveStatus=<200|other>
step2SaveStatus=<201|other>
step2ApproveStatus=<200|other>
compositionSaveStatus=<201|other>
compositionApproveStatus=<200|other>
draftRunStatus=<409|other>
smuggleRunStatus=<400|other>
runOutcome=<resolved|no_match|ambiguous|step_output_not_scalar|step_failed>
runEvidenceOk=<true|false>
runFailedStep=<null|0|1>
compositionRetireStatus=<200|other>
postRetireRunStatus=<409|other>
step1RetireStatus=<200|other>
step2RetireStatus=<200|other>
valuesFreeEvidence=true
materialNumberEchoed=false
resolvedValueEchoed=false
writeExecuted=false
recursiveBomExecuted=false
```

Do not include material numbers, resolved values, row content, read/container
paths, hostnames, credentials, or tenant/system ids.

## PASS Criteria

The entity-machine E2E is PASS only if:

- the deployed SHA is on or after `9d0acd199`;
- both step read-source configs and the composition config each save,
  probe (steps), and approve with the expected statuses;
- the draft-composition run rejection and the body-smuggle rejection both
  match their documented statuses/codes;
- the approved-composition run against a real material number returns
  `HTTP 200` with a values-free `{evidence, data}` body matching one of the
  documented outcomes (resolved or a coarse fail-closed code) — never an
  unhandled 500 and never a data/evidence shape outside this document;
- a resolved run's `data` contains only `{resolver:{target, value}}` for the
  **last** hop — the intermediate `internal_id` never appears anywhere in
  the response;
- retiring the composition (and then the step configs) succeeds, and the
  post-retire run is rejected `409`;
- no write/Save/Submit/Audit/external-write/recursive-BOM path is executed
  anywhere in the run.

## Troubleshooting

| Symptom | Cause | Distinguishing signal |
| --- | --- | --- |
| Run → `409 READ_SOURCE_COMPOSITION_CONFIG_NOT_APPROVED` | The **composition config itself** is `draft` or `retired`. | `GET /read-source-compositions/<id>` (or the list with `status=draft`) shows the composition's own status is not `approved` — checked *first*, before either step config loads. |
| Run → `409 READ_SOURCE_CONFIG_NOT_APPROVED` (no `COMPOSITION` prefix) | The composition **itself is approved**, but one of the **two referenced step read-source-configs** regressed to `draft`/`retired` independently. | Check each step config's own status via `GET /read-source-configs/<step1ConfigId>` and `.../<step2ConfigId>` — this is the "approved-only double gate" (gate #2), and it fires even though the composition row you loaded shows `approved`. |
| Run → `200` with `evidence.ok=false`, `steps[N].errorCode="READ_SOURCE_COMPOSITION_STEP_FAILED"`, no further detail | Could be **kind mismatch** (the step's `requiredKind` no longer matches the registered external system's `kind`) **or** a **credentials failure** (e.g. `K3_WISE_CREDENTIALS_MISSING`) **or** any other adapter-level exception (network error, malformed step config). All of these are *thrown* inside the hop and the chain executor deliberately swallows the exception to this one coarse code — unlike the standalone single-read route, which returns a distinct `409 READ_SOURCE_READ_KIND_MISMATCH`. | You cannot tell these apart from composition evidence alone. Cross-check directly: (a) compare the failing step's read-source config `requiredKind` against `GET /external-systems/<systemId>` `kind`; (b) confirm credentials are registered on the box (Preconditions §3) — the read-line's `K3_WISE_CREDENTIALS_MISSING` precedent applies identically here, just one hop deeper; (c) re-run that **step's own standalone read** (outside the composition, via its own `/read-source-configs/:id/read`) to isolate the hop. |
| Run → `200` with `evidence.ok=false`, `steps[N].errorCode="READ_SOURCE_RESOLVER_CONTAINER_NOT_FOUND"` or `"READ_SOURCE_RESOLVER_SHAPE_MISMATCH"` | **Container path mismatch** at that hop — the resolver evaluator located (or failed to locate) the configured container and returned a typed failure, rather than throwing. This is precise and points at exactly one hop's `containerPaths`. | Re-run that step's own locate-container probe (Phase 1.1/1.2) in isolation to confirm the real box's response shape; do not guess — the shape can differ per environment even for the "proven" step-1 anchor if the box's K3 instance is customized. |
| Save/approve on either step config or the composition → `500` | Migration gap. | Confirm migration `062_create_integration_read_source_configs.sql` **and** `063_create_integration_read_source_composition_configs.sql` are both applied (Preconditions §2) before assuming a config-shape bug. |
| Evidence (panel or API response) contains a material number, a resolved value, a read path, or a hostname | Values-free discipline violation. | Stop. File a blocker. Do not paste the leaking response anywhere, including into the blocker itself — describe the shape, not the value. |
| Any write/Save/Submit/Audit/external-write call is observed during this run | Security regression — this line is read-only by design. | Stop immediately and treat as a regression, not a config error. |

## Disposition

This runbook is prepared and ready for an owner-run entity-machine
acceptance pass. It authorizes no new code and no write path; a PASS closes
out the composition arc's remaining real-hardware verification gap noted in
`integration-read-source-resolver-composition-cr0-cr3-dev-verification-20260705.md`
§8, exactly as the standalone read line's own entity-machine runbook closed
out its arc on 2026-07-02.
