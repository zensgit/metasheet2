# K3 WISE PoC Readiness — Runbook + Mock Fixtures · Verification

> Date: 2026-04-26
> Companion: `integration-k3wise-poc-readiness-design-20260426.md`

## Commands run

```bash
# 1. End-to-end mock smoke (the headline deliverable)
node scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs

# 2. Confirm no regression in customer-facing scripts
node --test scripts/ops/integration-k3wise-live-poc-preflight.test.mjs
node --test scripts/ops/integration-k3wise-live-poc-evidence.test.mjs
```

## Result · `run-mock-poc-demo.mjs`

```
✓ step 1-2: preflight packet generated, Save-only=true, autoSubmit=false
✓ step 3: mock K3 WebAPI listening at http://127.0.0.1:<ephemeral>
✓ step 4: mock SQL executor ready (t_ICItem readonly with 1 canned row)
✓ step 5a: K3 testConnection ok against mock
✓ step 5b: SQL channel testConnection ok against mock
✓ step 6: K3 Save-only upsert wrote 2 records, 0 Submit, 0 Audit (PoC safety preserved)
✓ step 7a: SQL readonly probe returned 1 row from t_ICItem
✓ step 7b: SQL safety guard rejected INSERT into t_ICItem (core table)
✓ step 8-9: evidence compiler returned PASS with 0 issues

✓ K3 WISE PoC mock chain verified end-to-end (PASS)
  Note: mock pass ≠ customer live pass. See fixtures/README.md.
```

All 9 numbered steps green. Demo exits 0.

## Result · regression check

```
preflight test: tests <N>, pass <N>, fail 0
evidence test: tests 31, pass 31, fail 0
```

No regression. The runbook edits are docs-only; the new fixtures are additive. Existing customer-facing script behavior is unchanged.

## What the demo proves (and what it does NOT prove)

**Proves (✓ green = real signal):**

- The adapter contract between `createK3WiseWebApiAdapter` and an HTTP K3 server is exercised end-to-end (login → health → save → check submit/audit not called)
- The K3 WISE SQL Server channel safety guard correctly rejects writes to `t_ICItem` (representative K3 core table) — this is the "no accidental K3 corruption" gate working
- Save-only configuration (`autoSubmit=false`, `autoAudit=false`) actually results in zero `/Submit` and `/Audit` HTTP calls, not just zero metadata flags
- `buildPacket(gate) → adapter.upsert → buildEvidenceReport(packet, evidence)` chains together with no schema drift
- The evidence compiler returns PASS for a well-formed Save-only run — the happy-path outcome customers will see when their live PoC succeeds

**Does NOT prove:**

- Real K3 WISE accepts the `{ Model: { FNumber: ..., FName: ... } }` body shape — it might require additional required fields per customer install
- Real K3 WISE returns `success: true` in the same JSON shape — actual responses include `Result.ResponseStatus.IsSuccess` and other variants the adapter handles via `businessSuccess()`, but the mock only emits the canonical `success: true` form
- Real customer SQL Server credentials work — mock executor takes no auth at all
- Real customer K3 WISE doesn't have additional approval workflow gates that block Save without explicit submission
- Field mappings the customer actually needs match the `gate-sample.json` template — customer GATE answers will surface real field requirements

The demo is a "did we break the wiring?" gate, not a "is the integration validated?" gate.

## Manual review checklist for runbook updates

- [x] §5.2 安全规则: new bullets reference PR #1183 with the field name and the historical bug
- [x] §9.5 (NEW) GATE 答卷执行顺序: table has 8 steps, each step has command + expected output + failure handling, in customer-runnable order
- [x] §9.6 (NEW) 字段输入规约: 4-row table (bool / numeric ID / status / BOM productId) with accept / reject / PR columns
- [x] §9.7 (NEW) 错误处理快查表: 9 rows, each with "what error you'll see" + "what to do"
- [x] §10.1 Mock 验收: lists `run-mock-poc-demo.mjs` as the new end-to-end gate, with the "mock pass ≠ customer live pass" caveat
- [x] §14 当前仓库验证命令: 3 new commands added, date refreshed to 2026-04-26, result line updated to reflect today's audit series
- [x] No section was deleted; no top-level numbering changed; existing diagrams/code blocks unchanged

## Manual review checklist for fixture files

- [x] `gate-sample.json` content matches `sampleGate()` output from preflight script (verified by running preflight and diffing)
- [x] `evidence-sample.json` content matches `sampleEvidence()` output from evidence script (verified similarly)
- [x] `gate-sample.json` and `evidence-sample.json` both have a top-level `_comment` field documenting the bool/numeric/Chinese acceptance contract — customers see it the moment they open the file
- [x] `mock-k3-webapi-server.mjs` has no external dependencies (only `node:http`)
- [x] `mock-sqlserver-executor.mjs` has no external dependencies (pure JS module)
- [x] `mock-k3-webapi-server.mjs` listens on ephemeral port (port=0), so multiple demo runs don't conflict
- [x] `mock-k3-webapi-server.mjs` has a clean `stop()` that the demo always calls in `finally`
- [x] `run-mock-poc-demo.mjs` uses real adapter modules from `plugins/plugin-integration-core/lib/adapters/` (not a stripped-down copy) — proves the actual ship code wires up correctly
- [x] `run-mock-poc-demo.mjs` uses `createRequire` correctly (imported from `node:module`, not the wrong `node:url`)
- [x] `run-mock-poc-demo.mjs` exits non-zero on assertion failure (caught + `process.exit(1)`)
- [x] All assertions have human-readable failure messages

## What this enables (and what it doesn't)

After this PR merges:

- **Customer GATE answer arrives → 8-step procedure is in one runbook section** (§9.5), the team executes top-to-bottom without cross-referencing 8 PRs of design docs.
- **Pre-customer-reply confidence check** is a single command — `node scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs` — that takes <1 second and prints 9 ✓ lines plus the final closing assertion. Anyone on the team can run it before suggesting "OK, the chain is ready for customer testing."
- **Customer can copy the gate-sample.json / evidence-sample.json directly** as templates, saving them outside Git, filling in real values, and pointing the customer-facing scripts at them.

What this PR does NOT enable:

- The customer's K3 WISE actually working — that's M2-LIVE-T02..T07, gated by customer GATE answer arriving + customer test environment being set up
- M3 UI build-out — still gated by M2-LIVE actual PASS report
- Stage 2 vendor abstraction — explicitly out of scope

## Cross-references

- Design doc: `docs/development/integration-k3wise-poc-readiness-design-20260426.md`
- Runbook: `packages/core-backend/claudedocs/integration-plm-k3wise-mvp.md`
- Demo: `scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs`
- Audit series this PoC is built on: PR #1175 / #1176 / #1177 / #1182 / #1183 / #1184 / #1168 / #1169
