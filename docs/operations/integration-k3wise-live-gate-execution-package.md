# K3 WISE Live GATE Execution Package

## Purpose

Capture, in one place, what the customer must supply for a live K3 WISE PoC,
how each customer-supplied value maps into our two preflight inputs (env-form
and GATE JSON), and how the live execution proceeds from the moment the GATE
answers arrive to the moment the evidence compiler returns `decision=PASS`.

This document does **not** repeat content already covered by:

- `docs/operations/k3-poc-onprem-preflight-runbook.md` — fix recipes for the
  on-prem preflight script and the Docker-deployed bridge-IP recipe.
- `docs/operations/integration-k3wise-internal-trial-runbook.md` — post-deploy
  authenticated smoke (signoff that the metasheet control plane is alive
  before any K3 conversation begins).

Read this package alongside those two; this one focuses on the live PoC
preflight and Save-only PoC, which they only touch tangentially.

## When to use

- After the on-prem deploy is up and the internal-trial postdeploy smoke
  signed off.
- Before sending the GATE intake template to the customer.
- During customer answer review (does the answer satisfy the hard contracts?).
- During live PoC execution (which command runs when, what counts as PASS).

## Conventions

- The single source of truth for the GATE JSON shape is the script's own
  `--print-sample` output:
  ```bash
  node scripts/ops/integration-k3wise-live-poc-preflight.mjs --print-sample
  ```
  When a field name in this document conflicts with the latest script
  output, the script wins.
- Hard contracts (the conditions under which `normalizeGate()` throws) are
  enforced by `scripts/ops/integration-k3wise-live-poc-preflight.mjs` —
  errors carry a `field` path so operators can fix the GATE answer in place.
- No real secrets appear in this document, in checked-in templates, or in
  any artifact path under `artifacts/integration-k3wise/`. The schema uses
  `<fill-outside-git>` as the only sanctioned placeholder for credential
  values.
- **Live preflight (Stage C step C2 onward) is gated by customer GATE
  arrival**. Until the customer has supplied A.1–A.6 answers,
  `--live` runs return `exit 2 / decision=GATE_BLOCKED` by design (the
  on-prem preflight script raises `gate-blocked` for any missing K3
  field). Do not bypass this gate — it is the contract, not a defect.

---

## Stage A — Customer GATE intake (the field list)

The customer must answer all rows below. Operator-side fields
(`DATABASE_URL`, `JWT_SECRET`, etc.) are **not** customer-facing and are
deliberately omitted from this list.

### A.1 Test scope (required)

| Field | Purpose | Hard constraint |
|---|---|---|
| Test tenant id | metasheet tenant scope on our side | non-empty string |
| Test workspace id | metasheet workspace scope | non-empty string |
| Operator label | written into `packet.operator` for audit | non-empty string |
| K3 environment label | `k3Wise.environment`; **production is rejected** | one of `test` / `testing` / `uat` / `sandbox` / `staging` / `dev` / `development` |

### A.2 K3 WISE connection (required)

| Field | Purpose | Hard constraint |
|---|---|---|
| K3 WISE version | `k3Wise.version` (audit) | non-empty string |
| K3 WebAPI URL | `k3Wise.apiUrl` | http or https; URL must NOT contain userinfo and must NOT contain query parameters whose key matches secret patterns (`access_token` / `token` / `password` / `secret` / `sign[ature]` / `api_key` / `session_id` / `auth`) |
| K3 account id (acctId) | `k3Wise.acctId` | non-empty string |
| K3 credentials | one of: `credentials.sessionId`, OR `credentials.username` + `credentials.password` | at least one complete pair |
| `autoSubmit` | must be `false` (Save-only safety) | enforced — packet build throws if true |
| `autoAudit` | must be `false` | enforced — packet build throws if true |

### A.3 PLM source (required)

| Field | Purpose | Hard constraint |
|---|---|---|
| PLM kind | `plm.kind` (default `plm:yuantus-wrapper`) | non-empty string |
| Read method | `plm.readMethod` (e.g., `api`, `db`, …) | non-empty string |
| PLM base URL | `plm.baseUrl` | recommended for `kind` values that talk over HTTP; the live preflight validates it as http/https when supplied |
| PLM credentials | `plm.credentials.{username,password}` or equivalent | at least one complete pair |
| Test product id (BOM) | `plm.defaultProductId` or `bom.productId` (one of) | required when `bom.enabled=true` |

### A.4 Field mappings (required)

| Field | Purpose | Hard constraint |
|---|---|---|
| Material mapping | `fieldMappings.material[]` | non-empty array; must map both `FNumber` (K3 material code) and `FName` (K3 material name) targets |
| BOM mapping (if BOM enabled) | `fieldMappings.bom[]` | must map all of: `FParentItemNumber` (parent material), `FChildItems[].FItemNumber` (child material code; `FChildItemNumber` accepted as alias), `FChildItems[].FQty` (child quantity; `FQty` accepted as alias) |

### A.5 SQL Server channel (optional)

If the customer wants the SQL Server side-channel (e.g., for read-only probes
or middle-table writes), they fill this section. Otherwise leave
`sqlServer.enabled=false`.

| Field | Purpose | Hard constraint |
|---|---|---|
| `sqlServer.enabled` | toggle SQL Server channel | boolean (`true`/`false`/`1`/`0`/`yes`/`no` accepted) |
| `sqlServer.mode` | `readonly` / `middle-table` / `stored-procedure` | one of those three; otherwise build throws |
| `sqlServer.server` / `sqlServer.database` | connection target | non-empty when `mode != readonly` |
| `sqlServer.allowedTables[]` | tables this channel may touch | when `mode != readonly`, must NOT contain K3 core business tables (`t_icitem`, `t_icbom`, `t_icbomchild`); build throws if it does |
| `sqlServer.middleTables[]` | middle-table targets | required when `mode = middle-table`; same K3-core-table prohibition |
| `sqlServer.storedProcedures[]` | allowed stored-procedure names | required when `mode = stored-procedure` |
| `sqlServer.writeCoreTables` | explicit attempt to write K3 core tables | must be `false`; build throws if `true` (Save-only safety) |
| `sqlServer.credentials` | DB credentials | structured like K3 / PLM credentials |

### A.6 Rollback contract (required)

| Field | Purpose | Hard constraint |
|---|---|---|
| `rollback.owner` | named human (customer K3 admin) responsible for rollback | non-empty string |
| `rollback.strategy` | textual rollback recipe (e.g., "disable test records", "TEST-* prefix and ignore") | non-empty string |

---

## Stage B — Field ↔ env / JSON mapping (operator side)

Two preflight scripts consume customer-supplied K3 connection info at
different points; the same answer feeds both.

| GATE JSON path | on-prem preflight `--live` env | Where it surfaces |
|---|---|---|
| `k3Wise.apiUrl` | `K3_API_URL` (or `K3_BASE_URL`) | TCP-probe in C2; configured in K3 external system in C4 |
| `k3Wise.acctId` | `K3_ACCT_ID` | preflight presence check; recorded in packet |
| `k3Wise.credentials.username` | `K3_USERNAME` | presence check only — value never persisted |
| `k3Wise.credentials.password` | `K3_PASSWORD` | presence check only — value never persisted |
| `tenantId` | (consumed by metasheet runtime, not preflight env) | tenant scope for control-plane lists |
| `--gate-file <path>` | (no env equivalent) | `--live` mode requires the file path |

**Operator-only env (not from customer)**: `DATABASE_URL`, `JWT_SECRET`. These
configure our deployment, not the customer's K3.

---

## Stage C — Execution sequence with PASS/FAIL gates

Each step has a single PASS condition; anything else is FAIL. Move on to the
next step only after PASS.

| Step | Name | When | Command / Entry | PASS | FAIL |
|---|---|---|---|---|---|
| **C0** | Mock chain smoke (no GATE needed) | Anytime | `pnpm verify:integration-k3wise:poc` | 37 unit tests + 9-step end-to-end mock chain all green (mock K3 WebAPI + mock SQL + Save-only upsert + safety guard rejects core-table INSERT + evidence compiler PASS) | Any sub-step fails |
| **C1** | On-prem preflight (mock mode) | After deploy, before GATE arrives | `node scripts/ops/integration-k3wise-onprem-preflight.mjs --mock --out-dir <art>` | exit 0; `decision=PASS`; `pg.tcp-reachable` / `pg.migrations-aligned` / `fixtures.k3wise-mock` all `pass`; all K3 / gate checks `skip` | exit 1 (mandatory env defect) |
| **C2** | On-prem preflight `--live` | Once GATE answers received | `node scripts/ops/integration-k3wise-onprem-preflight.mjs --live --gate-file <path> --out-dir <art>` with `K3_API_URL` / `K3_ACCT_ID` / `K3_USERNAME` / `K3_PASSWORD` injected | exit 0; `k3.live-config` `pass` (4 fields present); `k3.live-reachable` `pass` (TCP to K3 host:port); `gate.file-present` `pass` | exit 1 (mandatory) or exit 2 (`GATE_BLOCKED` — customer field still missing) |
| **C3** | Build live PoC packet + GATE contract validation | After C2 PASS | `node scripts/ops/integration-k3wise-live-poc-preflight.mjs --input <gate.json> --out-dir <packet-dir>` | `integration-k3wise-live-poc-packet.{json,md}` written; `safety.saveOnly=true / autoSubmit=false / autoAudit=false`; checklist contains `GATE-01 / CONN-01 / CONN-02 / DRY-01 / SAVE-01 / FAIL-01 / ROLLBACK-01` (plus `BOM-01` when BOM enabled) | `normalizeGate` throws (error includes `field` path of the offending key) |
| **C4** | testConnection — PLM + K3 (control plane) | After C3 | metasheet console: register both external systems → testConnection | both return `ok=true` | either non-ok (GATE field wrong / customer network / credentials) |
| **C5** | Material dry-run, 1–3 rows | After C4 PASS | metasheet console: trigger dry-run pipeline | dry-run report shows mappings applied correctly, target record preview matches | mapping incomplete or validation rule mismatch |
| **C6** | **Material Save-only PoC** | After C5 PASS | trigger manual pipeline; `writeMode=saveOnly` | 1–3 rows written into K3, response carries externalId / billNo; `autoSubmit=false / autoAudit=false` enforced via `packet.options.target` | row count 0 or > 3; `autoSubmit` or `autoAudit` true; no K3 record returned |
| **C7** | (Optional) BOM Save-only PoC | When `bom.enabled=true` and C6 PASS | manual BOM pipeline | 1–3 BOMs written; product scope sourced from `bom.productId` or `plm.defaultProductId` (NOT `pipeline.options.source.productId`) | evidence compiler raises `LEGACY_BOM_PRODUCT_ID_USED` |
| **C8** | Dead-letter replay | After C6 PASS | introduce a controlled failure → enters dead-letter → fix → replay | replayed run writes successfully | replay still fails |
| **C9** | Rollback rehearsal | After C8 PASS | customer K3 admin executes per `rollback.owner` / `rollback.strategy` | test rows identifiable (e.g., `TEST-` prefix) and removed/disabled per strategy | owner unreachable or strategy not exercised |
| **C10** | **Evidence compiler signoff** | After C9 PASS | `node scripts/ops/integration-k3wise-live-poc-evidence.mjs --packet <packet.json> --evidence <evidence.json>` | `decision=PASS` and `issues=[]` | `decision=FAIL` if any of `SAVE_ONLY_VIOLATED` / `SAVE_ONLY_ROW_COUNT` / `SAVE_ONLY_RUN_ID_REQUIRED` / `K3_RECORD_REQUIRED` / `BOM_PRODUCT_SCOPE_REQUIRED` / `BOM_RUN_ID_REQUIRED` / `BOM_ROW_COUNT` / `BOM_K3_RECORD_REQUIRED` / `BOM_K3_RESPONSE_REQUIRED` / `LEGACY_BOM_PRODUCT_ID_USED` fires; `decision=PARTIAL` when non-fail issues remain (typically checklist gaps) |

---

## Stage D — Existing-doc coverage and remaining gaps

| Resource | Path / entry | What it covers | Gap |
|---|---|---|---|
| GATE schema (authoritative) | `node scripts/ops/integration-k3wise-live-poc-preflight.mjs --print-sample` | Complete JSON template for A.1–A.6 | It's a schema, not a guide; raw JSON is unfriendly to a customer reviewer |
| GATE field semantics | `scripts/ops/integration-k3wise-live-poc-preflight.mjs` (`normalizeGate()` and its throws) | The exact text of every hard-constraint failure | No human-readable (especially Chinese) explanation for non-engineer reviewers |
| On-prem preflight runbook | `docs/operations/k3-poc-onprem-preflight-runbook.md` (PR #1437) | C1 / C2 operations, fix recipes for all 8 check IDs, Docker bridge-IP recipe | Does not explain field semantics — points at the schema |
| Internal-trial postdeploy | `docs/operations/integration-k3wise-internal-trial-runbook.md` | Post-deploy auth smoke (control plane) before K3 enters the picture; host-shell mint pattern | Concerns metasheet itself, not K3 / PLM |
| Mock chain | `scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs` + `pnpm verify:integration-k3wise:poc` | C0 end-to-end | Already complete |
| Evidence compiler | `scripts/ops/integration-k3wise-live-poc-evidence.mjs` (`evaluateMaterialSaveOnly` / `evaluateBom` / `determineDecision`) | C10 issue codes and their triggers | No on-site evidence-collection template |

**Remaining gaps (priority order)**:

1. **Customer-facing GATE intake template** — semi-structured (e.g., a fillable
   YAML or wiki page) carrying A.1–A.6 in plain language, with constraint
   notes inline ("environment must not be production", "BOM mapping must
   include FParentItemNumber"), and the `<fill-outside-git>` placeholder
   convention for secrets. Useful **before** the customer answers.
2. **On-site evidence collection template** — slot-per-step JSON skeleton
   covering C4–C9 (runId, externalId / billNo, dead-letter row id, rollback
   evidence). Drops directly into `--evidence <file>` of the compiler.
   Useful **during** PoC execution.
3. **Field-semantics explainer** (Chinese) — design intent behind each hard
   constraint ("why production is forbidden", "why BOM requires product
   scope", "why core-table writes are blocked"). Best written **after** the
   first real PoC, driven by actual customer questions.

Items 1 and 2 are non-blocking but high-leverage; item 3 is best deferred
until there is real friction to capture.

---

## Stage E — Secret hygiene

The whole flow is designed so secrets never enter:

- This document.
- The GATE intake template (uses `<fill-outside-git>` placeholder).
- Any committed file under `docs/`, `scripts/`, or `artifacts/`.
- Any chat/log paste of preflight / smoke output (the scripts redact at
  storage time and at render time).

Operator pre-share self-check (run before posting any artifact JSON or MD):

```bash
ART=<artifact-dir>
grep -cE '"password":\s*"[^<]' "$ART"/*.json
grep -cE 'eyJ[A-Za-z0-9_-]{20,}' "$ART"/*.json "$ART"/*.md
grep -oE '[?&](access[-_]?token|token|password|secret|sign(ature)?|api[-_]?key|session(_)?id|auth)=[^&"[:space:]]+' \
    "$ART"/*.json "$ART"/*.md \
  | grep -vEc '=(<redacted>|%3Credacted%3E)$'
grep -oE 'postgres(ql)?://[^:/?@[:space:]]+:[^@[:space:]]+@' "$ART"/*.json "$ART"/*.md \
  | grep -vEc ':(<redacted>|%3Credacted%3E)@$'
```

All four counts must be `0`. Anything else means the artifact has either been
post-edited or the sanitizer regressed — do not share. The full rationale
for these checks lives in `docs/operations/k3-poc-onprem-preflight-runbook.md`
under "Sharing the artifact safely".

---

## See also

- `scripts/ops/integration-k3wise-live-poc-preflight.mjs` — packet builder and `--print-sample` schema source.
- `scripts/ops/integration-k3wise-live-poc-evidence.mjs` — evidence compiler with the C10 contract.
- `scripts/ops/integration-k3wise-onprem-preflight.mjs` — on-prem preflight (C1 / C2).
- `scripts/ops/integration-k3wise-postdeploy-smoke.mjs` — internal-trial smoke (after backend boot, before K3 conversation).
- `scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs` — mock chain (C0).
- `docs/operations/k3-poc-onprem-preflight-runbook.md` — recipes for C1/C2 failure modes.
- `docs/operations/integration-k3wise-internal-trial-runbook.md` — post-deploy auth smoke (sequenced before C0 once a real deployment is up).
