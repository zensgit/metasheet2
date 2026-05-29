# K3 WISE — Material-only / DF dry-run process control plane (2026-05-27)

Status: operational process contract. **Docs-only control plane** — it describes the handoffs, artifacts, blocked-reason mapping, and role boundaries for the **already-landed** Material-only / Data-Factory dry-run tooling. It introduces **no runtime**: it does not touch `automation-executor.ts`, **does not import workflow-job-contract**, adds no runner/report, and defines no new code-consumed enum.

It **references, does not re-derive** the existing operator docs: the C0–C11 sequence in `docs/operations/integration-k3wise-live-gate-execution-package.md`, `docs/operations/integration-k3wise-onprem-operator-handoff-checklist.md`, and the customer-sample manifests. All decision names and issue codes below are **anchored to the landed `scripts/ops/integration-k3wise-*.mjs`**, not invented here.

Post-GATE scope: #1792 is PASS for **M1 one-record Material Save-only**. This doc governs **dry-run / read-only / preflight / packaging** process only; additional K3 Save attempts, BOM, Submit, Audit, multi-record / batch, production signoff, and server-side reference resolution remain separate named opt-in gates.

## 1. Two lanes (do not merge into one linear flow)

The process has **two distinct lanes** with different terminal states. They must not be conflated — the tooling enforces the split.

### Material-only lane (dry-run readiness only)

`integration-k3wise-gate-contract-check.mjs --scope material-only` → terminal **`PASS_MATERIAL_DRY_RUN_READY`**.

- Validates only: read answers `O1-MAT` / `O1-MAT-M` / `O6`, the `materialOnlySafety` answers, and the single redacted `materialDetail` sample.
- Meaning: the customer's Material `GetDetail` dry-run inputs are ready. **Nothing more.** It does **not** authorize Save-only, Submit, Audit, BOM, or customer-trial signoff.
- **Hard boundary (tool-enforced):** a Material-only report carries `scope: "material-only"`, and the delivery-readiness compiler **fails its GATE on any non-full scope** — see `scripts/ops/integration-k3wise-delivery-readiness.mjs:289` (`a non-full scope cannot satisfy the full K3 read/list + relationship GATE`). So this lane can **never** reach `CUSTOMER_TRIAL_READY` / `CUSTOMER_TRIAL_SIGNED_OFF`.

### Full / customer-trial lane

`--scope full` (default) GATE over `O1`–`O6` + `R1`–`R7` → live evidence → delivery readiness.

- `integration-k3wise-gate-contract-check.mjs` (full) → `PASS` / `FAIL` / `GATE_BLOCKED`.
- on-site C4–C9 → `integration-k3wise-live-poc-evidence.mjs` → `PASS` / `PARTIAL` / `FAIL`.
- `integration-k3wise-delivery-readiness.mjs` → `INTERNAL_READY_WAITING_CUSTOMER_GATE` → `CUSTOMER_TRIAL_READY` → `CUSTOMER_TRIAL_SIGNED_OFF` (or `BLOCKED`).
- Only this lane can reach customer-trial signoff.

## 2. Per-step artifacts (producer → consumer)

| Step | Artifact | Produced by | Consumed by |
|---|---|---|---|
| Preflight | preflight report (`decision`) | `integration-k3wise-onprem-preflight.mjs` | operator |
| Packet build | live PoC packet `{json,md}` | `integration-k3wise-live-poc-preflight.mjs` | checker, operator |
| GATE contract check | gate-contract-check report | `integration-k3wise-gate-contract-check.mjs` (`--scope full` or `material-only`) | reviewer, delivery readiness |
| Package verify | package-verify JSON | `multitable-onprem-package-verify.sh` | delivery readiness |
| Dry-run preview | preview evidence (no secrets) | console dry-run | operator, reviewer |
| On-site evidence | filled C4–C9 evidence | customer + operator | evidence compiler |
| Evidence signoff | evidence decision (`PASS`/`PARTIAL`/`FAIL`) | `integration-k3wise-live-poc-evidence.mjs` | delivery readiness, reviewer |
| Delivery readiness | readiness decision + review note | `integration-k3wise-delivery-readiness.mjs` | reviewer, admin |

## 3. Blocked-reason taxonomy (operator/reviewer mapping — NOT a new enum)

This is a **documentation cross-reference** so operators/reviewers can classify a stop and route it to the right owner. It introduces **no new code-consumed canonical enum**; each code below is owned and emitted by its source tool (anchored at `scripts/ops/integration-k3wise-live-poc-evidence.mjs:292` for the evidence codes, and the checker/preflight/delivery-readiness sources).

| Category | Example landed codes (source) | Resolved by |
|---|---|---|
| customer-input-missing | `GATE_BLOCKED` (checker; preflight `--live` exit 2) | customer (supply GATE answers / fields) |
| evidence-invalid / incomplete | checker `FAIL` (answer/sample validation); evidence `K3_RECORD_REQUIRED` / `SAVE_ONLY_RUN_ID_REQUIRED` / `BOM_RUN_ID_REQUIRED` / `BOM_PRODUCT_SCOPE_REQUIRED`; evidence `PARTIAL` | operator (re-collect / fix packet) |
| safety-violation | evidence `SAVE_ONLY_VIOLATED` (autoSubmit/autoAudit on); `SAVE_ONLY_ROW_COUNT` / `BOM_ROW_COUNT` (rows ∉ 1–3); `LEGACY_BOM_PRODUCT_ID_USED` | operator + admin (stop, correct config) |
| packaging / environment defect | preflight env defect (exit 1: `env.database-url` / `env.jwt-secret`); delivery-readiness `BLOCKED` (missing package-verify JSON / failed smoke); `package-verify` die | operator + admin (fix deploy / package) |

## 4. Role responsibilities

Boundaries (not a staffing count — who is accountable for which artifact/gate):

- **Customer** — owns GATE answers (A.1–A.6), the redacted samples, and on-site C4–C9 execution + rollback execution. A `customer-input-missing` stop is theirs.
- **Operator** — runs preflight / packet build / checker / package-verify / dry-run; re-collects on `evidence-invalid`; never flips `autoSubmit`/`autoAudit`.
- **Reviewer** — independently confirms each gate artifact before it advances: that the checker report's `decision` and scope match the intended lane (Material-only ≠ customer-trial), that evidence `decision=PASS` with `issues=[]`, and that no `safety-violation` code is present. The reviewer is the explicit check that a Material-only `PASS_MATERIAL_DRY_RUN_READY` is **not** presented as customer-trial signoff.
- **Admin** — owns deploy/package environment + the `packaging/environment defect` category; performs no business approval.
- **Rollback-owner** — named in the GATE packet (`rollback.owner`); the only role that executes/clears test K3 rows in the full lane.

## 5. Lock / boundary (what this control plane does NOT do)

- No `automation-executor.ts` change; **does not import workflow-job-contract**; no runner, no report generator, no new schema.
- Material-only readiness is **not** customer-trial signoff (§1, tool-enforced).
- Additional K3 Save attempts / BOM / Submit / Audit / multi-record and server-side reference resolver/composition stay frozen until a separate named opt-in.

## 6. Enforcement

`multitable-onprem-package-verify.sh` asserts this control-plane doc is packaged and documents: the **Material-only lane**, the **Full / customer-trial lane**, the **Blocked-reason taxonomy**, the **Reviewer** responsibility, and the **does not import workflow-job-contract** boundary. `multitable-onprem-package-build.sh` packages the doc into the on-prem bundle.
