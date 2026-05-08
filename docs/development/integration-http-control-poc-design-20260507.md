# Integration HTTP Control PoC Design

## Context

The PLM to K3 WISE chain already had direct runner-level coverage in
`e2e-plm-k3wise-writeback.test.cjs`. That proved the runner, source adapter,
target adapter, dead-letter store, watermark store, and ERP feedback writer can
work together with mocked PLM and K3 WISE services.

The remaining gap was the REST control plane. A customer or operator will not
usually call `createPipelineRunner()` directly. They will create external
systems and pipelines through `/api/integration/*`, test the connections, run a
dry-run, then run the live pipeline and inspect run/dead-letter results.

## Change

Add `http-routes-plm-k3wise-poc.test.cjs`, a route-level mock PoC test that uses
real plugin services wherever the test can do so safely:

- real `registerIntegrationRoutes`
- real `createPipelineRunner`
- real `createAdapterRegistry`
- real `plm:yuantus-wrapper` adapter with an injected PLM client
- real `erp:k3-wise-webapi` adapter with an injected fetch mock
- real dead-letter, watermark, run-log, and ERP feedback modules
- in-memory registries and DB helpers for external systems, pipelines, runs,
  watermarks, and dead letters

The mocked external systems are intentionally small:

- PLM returns two material records: `GOOD-01` and `BAD-02`.
- K3 WISE login succeeds.
- K3 WISE material save succeeds for `GOOD-01`.
- K3 WISE material save returns a business error for `BAD-02`.

## Covered Flow

The test drives the same sequence an operator would drive from the UI or REST
API:

1. `POST /api/integration/external-systems` creates a PLM source.
2. `POST /api/integration/external-systems` creates a K3 WISE target with
   credentials.
3. `POST /api/integration/external-systems/:id/test` tests both systems.
4. `POST /api/integration/staging/install` provisions staging descriptors.
5. `POST /api/integration/pipelines` creates the PLM material to K3 WISE
   pipeline.
6. `POST /api/integration/pipelines/:id/dry-run` reads and transforms PLM
   records without touching K3 WISE.
7. `POST /api/integration/pipelines/:id/run` writes K3 WISE material records and
   records one partial failure.
8. `GET /api/integration/runs` verifies the dry-run and live run are visible.
9. `GET /api/integration/dead-letters` verifies non-admin payload redaction.
10. `GET /api/integration/dead-letters?includePayload=true` verifies admin
    payload access remains sanitized.

## Safety Boundaries

This is still an offline test. It does not contact a customer PLM, customer K3
WISE, SQL Server, or middleware database.

The test intentionally verifies the control-plane safety properties that matter
before customer GATE data arrives:

- credentials are accepted on create but not returned by route responses
- dry-run does not call K3 WISE save/submit/audit
- live run does not auto-submit or auto-audit when the pipeline says save-only
- partial K3 WISE failures create dead letters instead of hiding errors
- admin dead-letter payload inspection is sanitized
