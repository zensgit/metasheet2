# Integration K3 WISE PoC Fixtures

Fixtures and mock server for the K3 WISE Live PoC chain. Used to:

1. Provide copy-and-edit JSON templates for customer GATE answers and post-run evidence.
2. Verify the preflight + adapter + evidence chain end-to-end against in-process mocks **before** a live customer run.

## Files

| File | Purpose |
|---|---|
| `gate-sample.json` | Customer GATE answer template. Customer copies, fills in real values (K3 version, URLs, credentials placeholders), saves outside Git. Endpoint URLs must not include inline username/password or secret-like query params; use credential fields instead. |
| `evidence-sample.json` | Customer-side evidence template after live PoC. Customer fills in run IDs, K3 record IDs, statuses, etc. |
| `mock-k3-webapi-server.mjs` | Minimal in-process HTTP mock for K3 WISE WebAPI: Login / Health / Material / BOM Save / Submit / Audit. NOT a full K3 simulator. |
| `mock-sqlserver-executor.mjs` | Mock SQL executor: read-only on K3 core tables, writeable on integration middle tables, rejects writes to `t_ICItem` / `t_ICBOM`. |
| `run-mock-poc-demo.mjs` | End-to-end smoke: loads gate sample → preflight → spins up mock K3 → adapter Save-only → SQL channel readonly probe → evidence compile → asserts PASS. |

## Local verification

From repo root:

```bash
node scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs
```

Expected output ends with `✓ K3 WISE PoC mock chain verified end-to-end (PASS)`.

**Mock pass ≠ customer live pass.** This proves the wiring works. Real-customer K3 WISE may reject payloads, return non-standard responses, hold different field constraints, or require approval workflows we haven't modeled. Use this only to gate "do we have a runnable chain?", not "is the customer integration validated?".
