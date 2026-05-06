# K3 WISE Preflight URL Secret Guard Development - 2026-05-06

## Context

The K3 WISE live PoC preflight packet is safe to archive only when customer
secrets remain in credential placeholders. Existing preflight redaction covered
secret-like object keys such as `password`, `token`, and `apiKey`, but endpoint
URLs were only checked for syntax and protocol.

That left a customer-input path where values such as these could be copied into
the generated packet and Markdown evidence:

- `k3Wise.apiUrl=https://user:password@k3.example.test/K3API/`
- `k3Wise.apiUrl=https://k3.example.test/K3API/?token=...`
- `plm.baseUrl=https://plm.example.test/api?api_key=...`

## Change

`scripts/ops/integration-k3wise-live-poc-preflight.mjs` now rejects endpoint
URLs that contain:

- inline URL username or password components
- secret-like query parameter keys matched by the existing
  `SECRET_KEY_PATTERN`

The guard is applied to:

- required `k3Wise.apiUrl`
- optional `plm.baseUrl`

Non-secret query parameters are still accepted, so customer routing metadata
such as `?tenant=demo` remains supported.

## Customer Contract

Credentials must be supplied through the dedicated `credentials` objects and are
rendered as `<set-at-runtime>` placeholders in generated packets. Endpoint URLs
must only describe the host, path, and non-secret routing parameters.

The fixture README and `gate-sample.json` comment were updated to make this
explicit before customers fill the GATE answer template.

## Files

- `scripts/ops/integration-k3wise-live-poc-preflight.mjs`
- `scripts/ops/integration-k3wise-live-poc-preflight.test.mjs`
- `scripts/ops/fixtures/integration-k3wise/gate-sample.json`
- `scripts/ops/fixtures/integration-k3wise/README.md`
