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
- `scripts/ops/multitable-onprem-package-verify.sh` — package-content verifier
  that proves the deployed zip/tgz contains the K3 operator scripts and docs.

Read this package alongside those two; this one focuses on the live PoC
preflight and Save-only PoC, which they only touch tangentially.

## When to use

- After the on-prem deploy is up and the internal-trial postdeploy smoke
  signed off.
- After the downloaded on-prem package has produced a package verifier JSON
  report.
- Before sending `scripts/ops/fixtures/integration-k3wise/gate-intake-template.json`
  to the customer for completion outside Git.
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
- The customer-facing intake template is
  `scripts/ops/fixtures/integration-k3wise/gate-intake-template.json`.
  It is a fillable wrapper around the script sample: it keeps the same
  accepted JSON shape, adds A.1–A.6 review notes, defaults SQL Server to
  disabled, and must be copied outside Git before real values are entered.
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

Start from the checked-in customer template:

```bash
cp scripts/ops/fixtures/integration-k3wise/gate-intake-template.json \
  /secure/customer-gate/k3wise-gate.json
```

Only the copied file should receive real customer values. Keep the checked-in
template free of real hosts, account ids, passwords, tokens, and SQL
credentials.

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
| K3 credentials | one of: `credentials.sessionId`, OR `credentials.username` + `credentials.password` | C2 and C3 both accept either credential shape. For C2, inject `K3_SESSION_ID` for sessionId-only customers, or `K3_USERNAME` + `K3_PASSWORD` for username/password customers. |
| `autoSubmit` | must be `false` (Save-only safety) | enforced — packet build throws if true |
| `autoAudit` | must be `false` | enforced — packet build throws if true |

**C2/C3 credential parity**: the live PoC preflight
(`integration-k3wise-live-poc-preflight.mjs`'s `assertK3AuthContract`) and the
on-prem preflight (`integration-k3wise-onprem-preflight.mjs --live`) now accept
the same two credential shapes: `sessionId`, or `username` + `password`. C2 only
records presence booleans such as `sessionIdPresent=true`; it never writes the
raw session id, username password, or password into artifacts.

### A.3 PLM source (required)

| Field | Purpose | Hard constraint |
|---|---|---|
| PLM kind | `plm.kind` (default `plm:yuantus-wrapper`) | optional string in script; defaults applied if missing |
| Read method | `plm.readMethod` (e.g., `api`, `db`, …) | enforced — `requiredString` throws if missing |
| PLM base URL | `plm.baseUrl` | optional; the live preflight validates it as http/https when supplied |
| PLM credentials | `plm.credentials.{username,password}` or equivalent | **customer intake requirement** — needed at C4 (testConnection); **C3 live-preflight does NOT enforce its presence**, so a missing PLM credential will only surface at C4. Operator-review the GATE answer before C4. |
| Test product id (BOM) | `plm.defaultProductId` or `bom.productId` (one of) | enforced — packet build throws when `bom.enabled=true` and neither is supplied |

### A.4 Field mappings (required)

| Field | Purpose | Hard constraint |
|---|---|---|
| Material mapping | `fieldMappings.material[]` | non-empty array; must map both `FNumber` (K3 material code) and `FName` (K3 material name) targets |
| BOM mapping (if BOM enabled) | `fieldMappings.bom[]` | must map all of: `FParentItemNumber` (parent material), `FChildItems[].FItemNumber` (child material code; `FChildItemNumber` accepted as alias), `FChildItems[].FQty` (child quantity; `FQty` accepted as alias) |

### A.5 SQL Server channel (optional)

If the customer wants the SQL Server side-channel (e.g., for read-only probes
or middle-table writes), they fill this section. Otherwise leave
`sqlServer.enabled=false`.

**Script-enforced (build throws if violated)**:

| Field | Purpose | Hard constraint |
|---|---|---|
| `sqlServer.enabled` | toggle SQL Server channel | accepted booleans: `true`/`false`/`1`/`0`/`yes`/`no` (case-insensitive) |
| `sqlServer.mode` | `readonly` / `middle-table` / `stored-procedure` | one of those three; otherwise build throws |
| `sqlServer.allowedTables[]` | tables this channel may touch | when `mode != readonly`, must NOT contain K3 core business tables (`t_icitem`, `t_icbom`, `t_icbomchild`); build throws if it does |
| `sqlServer.writeCoreTables` | explicit attempt to write K3 core tables | when `true` and `mode != readonly`, build throws (Save-only safety) |

**Operator-reviewed (NOT script-enforced today)**:

| Field | Purpose | Operator review |
|---|---|---|
| `sqlServer.server` / `sqlServer.database` | connection target | Operator must confirm both are present and correct before C4. The script accepts missing values (falls back to `<provided-by-customer>` placeholder when generating the packet). |
| `sqlServer.middleTables[]` | middle-table targets when `mode = middle-table` | Operator must confirm the table list is non-empty and **does not include K3 core tables**. The script's core-table prohibition only cross-checks `allowedTables`, not `middleTables`; a `middle-table` mode with `t_icitem` in `middleTables` will pass C3 silently. |
| `sqlServer.storedProcedures[]` | allowed stored-procedure names when `mode = stored-procedure` | Operator must confirm the procedure list is non-empty and matches the customer's stored-procedure interface contract. The script accepts an empty array. |
| `sqlServer.credentials` | DB credentials | Operator-reviewed at intake; surfaces at C4 testConnection if missing. C3 does not enforce. |

These C3 gaps are intentionally surfaced here so operators do not assume a
green C3 means the SQL Server channel is fully validated. The on-site review
of A.5 must be explicit. A future preflight enhancement would extend the
core-table prohibition to `middleTables` / `storedProcedures` as well.

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
| `k3Wise.credentials.sessionId` | `K3_SESSION_ID` | presence check only — value never persisted |
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
| **C0.5** | Package verify report | After downloading the on-prem zip/tgz and before deploy signoff | see [C0.5 package verify report](#c05-package-verify-report) | verifier exits 0 and writes `package-verify.json` with `ok=true`; `required-content` / `checksum` / `no-github-links` PASS | verifier exits non-zero, missing K3 readiness scripts/docs, checksum mismatch, or delivery docs contain forbidden GitHub links |
| **C1** | On-prem preflight (mock mode) | After deploy, before GATE arrives | `node scripts/ops/integration-k3wise-onprem-preflight.mjs --mock --out-dir <art>` (see [C1 prerequisites](#c1-prerequisites) below) | exit 0; `decision=PASS`; `pg.tcp-reachable` / `pg.migrations-aligned` / `fixtures.k3wise-mock` all `pass`; all K3 / gate checks `skip` | exit 1 (mandatory env defect — `env.database-url` and/or `env.jwt-secret` not satisfied; see [C1 prerequisites](#c1-prerequisites)) |
| **C2** | On-prem preflight `--live` | Once GATE answers received | `node scripts/ops/integration-k3wise-onprem-preflight.mjs --live --gate-file <path> --out-dir <art>` with `K3_API_URL` / `K3_ACCT_ID` plus either `K3_SESSION_ID` or `K3_USERNAME` + `K3_PASSWORD` injected | exit 0; `k3.live-config` `pass` (endpoint, acctId, and one credential shape present); `k3.live-reachable` `pass` (TCP to K3 host:port); `gate.file-present` `pass` | exit 1 (mandatory) or exit 2 (`GATE_BLOCKED` — customer field still missing). For per-error-code fix recipes (`ECONNREFUSED` / `ENOTFOUND` / `EHOSTUNREACH` / `ETIMEDOUT`) on `pg.tcp-reachable` and `k3.live-reachable`, see `docs/operations/k3-poc-onprem-preflight-runbook.md` § "Per-check failure recipes". |
| **C3** | Build live PoC packet + GATE contract validation | After C2 PASS | `node scripts/ops/integration-k3wise-live-poc-preflight.mjs --input <gate.json> --out-dir <packet-dir>` | `integration-k3wise-live-poc-packet.{json,md}` written; `safety.saveOnly=true / autoSubmit=false / autoAudit=false`; checklist contains `GATE-01 / CONN-01 / CONN-02 / DRY-01 / SAVE-01 / FAIL-01 / ROLLBACK-01` (plus `BOM-01` when BOM enabled) | `normalizeGate` throws (error includes `field` path of the offending key) |
| **C4** | testConnection — PLM + K3 (control plane) | After C3 | metasheet console: register both external systems → testConnection | both return `ok=true` | either non-ok (GATE field wrong / customer network / credentials) |
| **C5** | Material dry-run, 1–3 rows | After C4 PASS | metasheet console: trigger dry-run pipeline | dry-run report shows mappings applied correctly; `preview.records[].targetPayload.Data` matches the material template (`FNumber`, `FName`, optional `FModel`, `FBaseUnitID`) and contains no secret fields | mapping incomplete or validation rule mismatch |
| **C6** | **Material Save-only PoC** | After C5 PASS | trigger manual pipeline; `writeMode=saveOnly` | 1–3 rows written into K3, response carries externalId / billNo; `autoSubmit=false / autoAudit=false` enforced via `packet.options.target` | row count 0 or > 3; `autoSubmit` or `autoAudit` true; no K3 record returned |
| **C7** | (Optional) BOM Save-only PoC | When `bom.enabled=true` and C6 PASS | manual BOM pipeline | 1–3 BOMs written; dry-run preview used the BOM template (`FParentItemNumber`, `FChildItemNumber`, `FQty`, optional `FUnitID`, `FEntryID`); product scope sourced from `bom.productId` or `plm.defaultProductId` (NOT `pipeline.options.source.productId`) | evidence compiler raises `LEGACY_BOM_PRODUCT_ID_USED` |
| **C8** | Dead-letter replay | After C6 PASS | introduce a controlled failure → enters dead-letter → fix → replay | replayed run writes successfully | replay still fails |
| **C9** | Rollback rehearsal | After C8 PASS | customer K3 admin executes per `rollback.owner` / `rollback.strategy` | test rows identifiable (e.g., `TEST-` prefix) and removed/disabled per strategy | owner unreachable or strategy not exercised |
| **C10** | **Evidence compiler signoff** | After C9 PASS | copy `scripts/ops/fixtures/integration-k3wise/evidence-onsite-c4-c9-template.json` outside Git, fill it, then run `node scripts/ops/integration-k3wise-live-poc-evidence.mjs --packet <packet.json> --evidence <filled-evidence.json>` | `decision=PASS` and `issues=[]` | `decision=FAIL` if any of `SAVE_ONLY_VIOLATED` / `SAVE_ONLY_ROW_COUNT` / `SAVE_ONLY_RUN_ID_REQUIRED` / `K3_RECORD_REQUIRED` / `BOM_PRODUCT_SCOPE_REQUIRED` / `BOM_RUN_ID_REQUIRED` / `BOM_ROW_COUNT` / `BOM_K3_RECORD_REQUIRED` / `BOM_K3_RESPONSE_REQUIRED` / `LEGACY_BOM_PRODUCT_ID_USED` fires; `decision=PARTIAL` when non-fail issues remain (typically checklist gaps) |
| **C11** | **Delivery readiness compiler** | After C10 PASS, or earlier to show what remains blocked | see [C11 delivery readiness compiler](#c11-delivery-readiness-compiler) | before C10: `decision=CUSTOMER_TRIAL_READY`; after C10: `decision=CUSTOMER_TRIAL_SIGNED_OFF`; `productionUse.ready=false` remains explicit | `decision=BLOCKED`, missing package verify JSON, failed postdeploy smoke, failed preflight packet, or failed live evidence |

### C0.5 package verify report

Run this against the exact package that will be installed. Capture both JSON
and Markdown reports; the JSON report becomes an input to the delivery
readiness compiler.

```bash
VERIFY_REPORT_JSON=artifacts/integration-k3wise/delivery-readiness/package-verify.json \
VERIFY_REPORT_MD=artifacts/integration-k3wise/delivery-readiness/package-verify.md \
  scripts/ops/multitable-onprem-package-verify.sh <metasheet-multitable-onprem.zip-or.tgz>
```

The verifier must find `scripts/ops/integration-k3wise-delivery-readiness.mjs`
inside the package and must prove this runbook documents the
`--package-verify` readiness gate. If either check fails, do not deploy the
package for customer GATE work.

### C11 delivery readiness compiler

After C3, run the compiler without live evidence to get a customer-trial-ready
record:

```bash
node scripts/ops/integration-k3wise-delivery-readiness.mjs \
  --postdeploy-smoke artifacts/integration-k3wise/internal-trial/postdeploy-smoke/integration-k3wise-postdeploy-smoke.json \
  --package-verify artifacts/integration-k3wise/delivery-readiness/package-verify.json \
  --preflight-packet <packet-dir>/integration-k3wise-live-poc-packet.json \
  --out-dir artifacts/integration-k3wise/delivery-readiness/customer-ready \
  --fail-on-blocked
```

After C10 PASS, add the live evidence report to produce the final customer
trial signoff artifact:

```bash
node scripts/ops/integration-k3wise-delivery-readiness.mjs \
  --postdeploy-smoke artifacts/integration-k3wise/internal-trial/postdeploy-smoke/integration-k3wise-postdeploy-smoke.json \
  --package-verify artifacts/integration-k3wise/delivery-readiness/package-verify.json \
  --preflight-packet <packet-dir>/integration-k3wise-live-poc-packet.json \
  --live-evidence-report <evidence-dir>/integration-k3wise-live-poc-evidence-report.json \
  --out-dir artifacts/integration-k3wise/delivery-readiness/customer-signed-off \
  --fail-on-blocked
```

The output files are `integration-k3wise-delivery-readiness.json` and
`integration-k3wise-delivery-readiness.md`. They are readiness records, not
production approval. Production use still requires customer signoff,
backup/rollback approval, and a scheduled change window.

### C4-C9 on-site evidence worksheet

Start the live evidence package from the checked-in worksheet:

```bash
cp scripts/ops/fixtures/integration-k3wise/evidence-onsite-c4-c9-template.json \
  /secure/customer-gate/k3wise-onsite-evidence.json
```

The checked-in worksheet is intentionally incomplete. Before it is filled,
it should compile to `PARTIAL`, not `FAIL`:

```bash
node scripts/ops/integration-k3wise-live-poc-evidence.mjs \
  --packet <packet-dir>/integration-k3wise-live-poc-packet.json \
  --evidence scripts/ops/fixtures/integration-k3wise/evidence-onsite-c4-c9-template.json \
  --out-dir artifacts/integration-k3wise/live-evidence/template-smoke
```

During C4-C9, update only the copied file outside Git. Fill run ids, request
ids, K3 external ids / bill numbers, staging feedback rows, replay proof,
rollback proof, and customer confirmation. Do not paste credentials, bearer
headers, signed URLs, K3 session values, SQL connection strings, or passwords
into evidence fields.

### C1 prerequisites

`integration-k3wise-onprem-preflight.mjs` always validates `DATABASE_URL`
and `JWT_SECRET` first. The C1 PASS criterion above assumes both are
already present in the operator's shell. Two operating modes:

1. **Real deploy host** (the canonical path). `DATABASE_URL` and
   `JWT_SECRET` must already be exported. For a Docker-deployed
   metasheet on-prem box, the bridge-IP recipe in
   `docs/operations/k3-poc-onprem-preflight-runbook.md` § "Running
   against a Docker-deployed metasheet" shows how to inherit them
   safely from the running backend container without printing secret
   values.
2. **Workstation rehearsal** (no real deploy host yet). Pass
   `--skip-tcp --skip-migrations` to bypass the Postgres TCP probe and
   migration alignment query, and supply synthetic `DATABASE_URL` (any
   well-formed `postgres://` string) and `JWT_SECRET` (any 32+ char
   string). Example:
   ```bash
   DATABASE_URL='postgres://rehearsal:<fill-outside-git>@127.0.0.1:65432/rehearsal' \
   JWT_SECRET="$(printf 'r%.0s' {1..40})" \
   node scripts/ops/integration-k3wise-onprem-preflight.mjs --mock \
     --skip-tcp --skip-migrations \
     --out-dir <art>
   ```

Same prerequisites apply to C2 (which also runs `env.database-url` /
`env.jwt-secret` first) plus C2's own K3 env requirements.

---

## Stage D — Existing-doc coverage and remaining gaps

| Resource | Path / entry | What it covers | Gap |
|---|---|---|---|
| GATE schema (authoritative) | `node scripts/ops/integration-k3wise-live-poc-preflight.mjs --print-sample` | Complete JSON template for A.1–A.6 | It's a schema, not a guide; raw JSON is unfriendly to a customer reviewer |
| Customer-facing intake template | `scripts/ops/fixtures/integration-k3wise/gate-intake-template.json` | Fillable A.1–A.6 wrapper with inline review notes, secret placeholders, Save-only defaults, and SQL disabled by default | None for pre-answer intake; filled copies must stay outside Git |
| GATE field semantics | `scripts/ops/integration-k3wise-live-poc-preflight.mjs` (`normalizeGate()` and its throws) | The exact text of every hard-constraint failure | No human-readable (especially Chinese) explanation for non-engineer reviewers |
| On-prem preflight runbook | `docs/operations/k3-poc-onprem-preflight-runbook.md` (PR #1437) | C1 / C2 operations, fix recipes for all 8 check IDs, Docker bridge-IP recipe | Does not explain field semantics — points at the schema |
| Internal-trial postdeploy | `docs/operations/integration-k3wise-internal-trial-runbook.md` | Post-deploy auth smoke (control plane) before K3 enters the picture; host-shell mint pattern | Concerns metasheet itself, not K3 / PLM |
| Package verifier + delivery readiness | `scripts/ops/multitable-onprem-package-verify.sh` + `scripts/ops/integration-k3wise-delivery-readiness.mjs` | C0.5 package evidence and C11 readiness decisions (`INTERNAL_READY_WAITING_CUSTOMER_GATE` / `CUSTOMER_TRIAL_READY` / `CUSTOMER_TRIAL_SIGNED_OFF`) | Does not replace customer evidence; it compiles existing evidence into one signoff artifact |
| Mock chain | `scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs` + `pnpm verify:integration-k3wise:poc` | C0 end-to-end | Already complete |
| Evidence compiler | `scripts/ops/integration-k3wise-live-poc-evidence.mjs` (`evaluateMaterialSaveOnly` / `evaluateBom` / `determineDecision`) | C10 issue codes and their triggers plus `--print-onsite-evidence-template` | Covered by `scripts/ops/fixtures/integration-k3wise/evidence-onsite-c4-c9-template.json` for C4-C9 collection |

**Remaining gaps (priority order)**:

1. **Field-semantics explainer** (Chinese) — design intent behind each hard
   constraint ("why production is forbidden", "why BOM requires product
   scope", "why core-table writes are blocked"). Best written **after** the
   first real PoC, driven by actual customer questions.

The customer-facing GATE intake template is now covered by the checked-in
fixture above. The on-site evidence collection template is also covered by
`evidence-onsite-c4-c9-template.json`. The remaining field-semantics
explainer is best deferred until there is real friction to capture.

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

### Shell-pipeline exit-code hygiene

When wrapping any preflight script in a shell pipeline (`node … | head -n …`,
`| grep …`, `| tee …`), set `set -o pipefail` first or capture `$?` before
the pipe. Without `pipefail`, the pipeline's exit status is `head` / `grep`'s
(usually `0`) rather than the script's, so an evidence-capture wrapper
silently records `exit: 0` even when the preflight returned `exit: 1` or
`exit: 2`. This is a common false-PASS source in custom evidence harnesses.

```bash
set -o pipefail
node scripts/ops/integration-k3wise-onprem-preflight.mjs --mock --out-dir <art> | tee preflight.log
echo "exit=$?"   # now reports the script's actual exit code
```

Or, equivalently:

```bash
node scripts/ops/integration-k3wise-onprem-preflight.mjs --mock --out-dir <art>
EXIT=$?
# ... pipe / tee / head freely afterward
```

---

## See also

- `scripts/ops/integration-k3wise-live-poc-preflight.mjs` — packet builder and `--print-sample` schema source.
- `scripts/ops/fixtures/integration-k3wise/gate-intake-template.json` — customer-facing fillable GATE intake template.
- `scripts/ops/fixtures/integration-k3wise/evidence-onsite-c4-c9-template.json` — operator-facing fillable C4-C9 evidence worksheet.
- `scripts/ops/integration-k3wise-live-poc-evidence.mjs` — evidence compiler with the C10 contract.
- `scripts/ops/integration-k3wise-delivery-readiness.mjs` — final readiness compiler that consumes postdeploy smoke, package verify, preflight packet, and optional live evidence.
- `scripts/ops/multitable-onprem-package-verify.sh` — package-content verifier; set `VERIFY_REPORT_JSON` to feed C11.
- `scripts/ops/integration-k3wise-onprem-preflight.mjs` — on-prem preflight (C1 / C2).
- `scripts/ops/integration-k3wise-postdeploy-smoke.mjs` — internal-trial smoke (after backend boot, before K3 conversation).
- `scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs` — mock chain (C0).
- `docs/operations/k3-poc-onprem-preflight-runbook.md` — recipes for C1/C2 failure modes.
- `docs/operations/integration-k3wise-internal-trial-runbook.md` — post-deploy auth smoke (sequenced before C0 once a real deployment is up).
