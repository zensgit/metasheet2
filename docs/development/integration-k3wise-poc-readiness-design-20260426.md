# K3 WISE PoC Readiness — Runbook + Mock Fixtures · Design

> Date: 2026-04-26
> Trigger: customer GATE answer wait; need pre-customer-reply preparation
> Scope: PoC readiness only — no Stage 2 vendor abstraction, no real SQL Server driver, no productionization of mocks
> Series follow-up: integration-core safety audit complete (PRs #1175 / #1176 / #1177 / #1182 / #1183 / #1184 + #1168 / #1169)

## Problem

The customer GATE answer email is in flight. Before they reply, the team needs:

1. **A runbook that reflects today's actual capability** — the K3 WISE PoC was hardened across 8 PRs today (input bool / numeric / synonym / packet safety / adapter / pipeline-runner). The runbook at `packages/core-backend/claudedocs/integration-plm-k3wise-mvp.md` predates all that and doesn't mention any of the field-acceptance contract or the new error messages.
2. **A "the moment customer replies, we run X" execution plan** — currently the steps are scattered across multiple design docs. Need them in one place, in order, with failure→action mapping.
3. **A way to prove the PoC chain is wired correctly before risking customer time** — currently we have unit tests per layer but no end-to-end smoke that exercises preflight → adapter → evidence compile against a mock. A "✓ link works" signal is cheap to produce and removes a class of "did we break something subtle?" risk.

## Solution

Three concrete deliverables, all bundled in one PR (coherent theme, manageable diff):

### 1. Runbook update (`packages/core-backend/claudedocs/integration-plm-k3wise-mvp.md`)

Targeted edits, no rewrites:

- **§5.2 K3 WISE WebAPI target — 安全规则**: append two bullets covering the autoSubmit/autoAudit input hardening contract (PR #1183) and the historical bug it fixed.
- **§9.5 (NEW) 客户 GATE 答卷回卷后的执行顺序**: 8-step linear table with command + expected output + failure handling per step. Single source of truth for "now what?" once GATE answers arrive.
- **§9.6 (NEW) 字段输入规约**: one table per field type (bool / numeric ID / status / BOM productId) listing what's accepted, what's rejected, and which PR added the hardening. Customers don't need to memorize this — they just need to know that "natural typing works".
- **§9.7 (NEW) 错误处理快查表**: 9-row "if you see this error → do this" table covering the most likely failure paths.
- **§10.1 Mock 验收**: add the new mock-poc-demo command + explicit "mock pass ≠ customer live pass" caveat.
- **§14 当前仓库验证命令**: add the 3 new commands; refresh date and result line.

No new top-level sections. Existing structure preserved. Length grows ~120 lines.

### 2. Mock fixtures + demo (`scripts/ops/fixtures/integration-k3wise/`)

Brand-new directory, 6 files:

- **`README.md`**: index + the "mock pass ≠ customer live pass" caveat.
- **`gate-sample.json`**: customer GATE answer template, copy-and-edit. Includes a `_comment` field documenting the bool/numeric/Chinese acceptance contract right at the top so customers see it.
- **`evidence-sample.json`**: customer evidence template for after-live-PoC. Same `_comment` discipline.
- **`mock-k3-webapi-server.mjs`**: minimal in-process HTTP mock for K3 WISE WebAPI (Login / Health / Material/BOM Save/Submit/Audit). ~100 lines, no dependencies. Exports `createMockK3WebApiServer({ logger, knownBadFNumbers })` with `start(port=0)` returning the ephemeral URL and `stop()`. NOT a CLI server — only used in-process by the demo.
- **`mock-sqlserver-executor.mjs`**: function-style mock executor with the K3 WISE SQL Server channel safety contract baked in:
  - `query()` only accepts SELECT
  - `exec()` rejects writes to `t_ICItem` / `t_ICBOM` / other K3 core tables
  - `exec()` requires the table name to start with the configured middle-table prefix (default `integration_`)
  - All queries logged for assertion
- **`run-mock-poc-demo.mjs`**: end-to-end smoke that loads the gate sample, runs preflight (in-memory), spins up both mocks, drives K3 testConnection + Save-only upsert + SQL readonly probe + SQL core-write rejection check, composes evidence from real upsert results, runs evidence compiler, asserts PASS. Prints 9 step-pass lines + a final closing assertion.

### 3. Verification MD (`docs/development/integration-k3wise-poc-readiness-verification-20260426.md`)

Documents the runbook updates and the demo command output, with the explicit "mock pass ≠ customer live pass" disclaimer.

## Why combine into one PR

Each piece is small (~50-150 lines), but together they form one coherent PoC-readiness deliverable. Splitting would force the runbook update to reference fixtures that don't exist yet, or force the fixtures PR to ship without runbook context. Keeping them together means one CI run, one review pass, one revertable commit.

## Files changed

- `packages/core-backend/claudedocs/integration-plm-k3wise-mvp.md` — targeted edits in §5.2, §9 (3 new subsections), §10.1, §14 (~+120 lines)
- `scripts/ops/fixtures/integration-k3wise/README.md` — new (~30 lines)
- `scripts/ops/fixtures/integration-k3wise/gate-sample.json` — new (~50 lines)
- `scripts/ops/fixtures/integration-k3wise/evidence-sample.json` — new (~50 lines)
- `scripts/ops/fixtures/integration-k3wise/mock-k3-webapi-server.mjs` — new (~100 lines)
- `scripts/ops/fixtures/integration-k3wise/mock-sqlserver-executor.mjs` — new (~75 lines)
- `scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs` — new (~150 lines)
- `docs/development/integration-k3wise-poc-readiness-design-20260426.md` — this doc
- `docs/development/integration-k3wise-poc-readiness-verification-20260426.md` — companion verification

Total: 9 files, ~620 lines added, 0 deleted.

## Acceptance criteria

- [x] `node scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs` prints `✓ K3 WISE PoC mock chain verified end-to-end (PASS)` ending
- [x] Demo exercises 9 numbered steps: preflight, mock K3 start, mock SQL ready, K3 testConnection, SQL testConnection, Save-only upsert (writes 2, 0 submit, 0 audit), SQL readonly probe (1 canned row), SQL safety guard (rejects t_ICItem INSERT), evidence compile (PASS, 0 issues)
- [x] Mock K3 server stops cleanly on every exit path (try/finally around the demo body)
- [x] Mock SQL executor enforces the K3 core-table write rejection (test by attempting `INSERT INTO dbo.t_ICItem` and asserting the throw)
- [x] gate-sample.json content is byte-equivalent to `sampleGate()` output from preflight script (no drift at PR time)
- [x] evidence-sample.json content is byte-equivalent to `sampleEvidence()` output from evidence script
- [x] Runbook §9.5 covers the 8-step execution order with command + expected output + failure handling
- [x] Runbook §9.6 lists every field-type contract (bool / numeric ID / status / BOM productId) with PR cross-reference
- [x] Runbook §9.7 covers the 9 most likely error paths with "怎么办" actions
- [x] Runbook §14 references the 3 new verification commands
- [x] Existing preflight tests continue to pass (no regression)
- [x] Existing evidence tests (31/31) continue to pass

## Out of scope (explicit per user direction)

- **No Stage 2 vendor abstraction.** The mock K3 server is not a step toward a generic ERP simulator. It only exists to verify our adapter wiring.
- **No real SQL Server driver.** The mock executor is function-style, in-process, no `mssql` / `tedious` dependency added.
- **Mock server stays test-only.** Not exposed as a CLI service, no production wiring, no Docker image.
- **No adapter contract changes.** This PR validates the existing contract; if the demo exposed a real bug we'd file a separate fix PR.
- **No new integration test infrastructure beyond the demo script.** Unit tests stay where they are. The demo is the integration smoke.
- **No customer-side changes.** Customer still gets the same script invocations (preflight + evidence). The fixtures help us test internally; customers can copy them as templates if useful.

## Cross-references

- Audit series: PR #1175 / #1176 / #1177 / #1182 (evidence), #1168 / #1169 (preflight), #1183 (K3 adapter), #1184 (pipeline-runner)
- Runbook: `packages/core-backend/claudedocs/integration-plm-k3wise-mvp.md`
- Customer-facing scripts: `scripts/ops/integration-k3wise-live-poc-preflight.mjs`, `scripts/ops/integration-k3wise-live-poc-evidence.mjs`
- Companion verification: `docs/development/integration-k3wise-poc-readiness-verification-20260426.md`
