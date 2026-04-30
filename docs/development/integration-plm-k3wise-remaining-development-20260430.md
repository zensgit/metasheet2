# PLM -> K3 WISE Integration Remaining Development - 2026-04-30

## Current Answer

The codebase is past backend MVP and mock PoC readiness. It is not yet "done" as a customer-live integration because the next blocking input is external: the K3 WISE customer GATE answer and real test account-set evidence.

Practical remaining volume:

| Goal | Remaining development | Calendar estimate |
|---|---:|---:|
| Run first customer K3 WISE Live PoC on test account set | 2-4 small PRs if customer responses expose gaps; otherwise mostly configuration/evidence | 2-5 engineering days after GATE arrives |
| Internal pilot deploy for the existing K3 WISE setup/control-plane flow | 0-1 small docs/config/signoff PR plus authenticated postdeploy smoke validation | 0.5-1 day if token, tenant, and integration permissions are seeded; 1-2 days if fallback token or permission seeding needs fixes |
| Production-ready K3 WISE connector | 8-12 PRs | 3-5 weeks, depends on customer K3 workflow complexity |
| Vendor-platform phase for second ERP/PLM adapter | 10-16 PRs after K3 PoC PASS | 6-10 weeks to useful platform foundation |

## Already Done

- `plugin-integration-core` system plugin exists with external-system registry, credential storage, adapter registry, pipelines, runner, run logs, dead letters, watermarks, ERP feedback, and staging descriptors.
- K3 WISE WebAPI target adapter and constrained SQL Server channel exist.
- PLM wrapper and generic HTTP adapter exist.
- Pipeline runner handles transform, validation, idempotency, watermark, dead letter, replay, dry-run, target write, and ERP feedback.
- K3 WISE Live PoC scripts exist for preflight, mock chain, postdeploy smoke, and evidence compilation.
- Frontend K3 WISE setup page can collect WebAPI, SQL Server, staging, pipeline, dry-run/run, and observation inputs.
- M2 safety hardening covers boolean/numeric/Chinese hand-edit cases across preflight, evidence, adapter, runner, and setup helpers.

## Remaining Before Customer Live PoC PASS

| Item | Status | Notes |
|---|---|---|
| Customer GATE JSON | blocked externally | Must include K3 WISE version, URL, acctId, credentials mode, field mappings, SQL Server scope, rollback plan |
| Real `external-systems/:id/test` against customer K3 | not run | Requires network and customer credentials |
| Material dry-run with real PLM sample | not run | Should preview 1-3 cleaned records before writing |
| Material Save-only write | not run | Must prove zero Submit/Audit |
| BOM product scope and simple BOM Save-only write | not run | Requires real PLM productId or adapter filters |
| Evidence report PASS | not run | Use `integration-k3wise-live-poc-evidence.mjs` |

## Remaining Before Production

- K3 error-code dictionary and customer-facing translation.
- Multi-account-set and organization strategy.
- Customer approval-flow handling for Submit/Audit after Save-only PoC.
- Complex BOM support: alternates, substitutes, losses, versions, effective dates.
- Rate limits, retries, compensation, and high-concurrency idempotency validation.
- Production SQL Server executor/proxy implementation and permission review.
- Rollback/cleanup SOP signed off by customer.
- Observability dashboard and alert thresholds for integration runs.

## Platformization Boundary

Do not start full vendor-platform work until K3 WISE Live PoC PASS. Safe work during customer wait:

- tighten existing K3 setup/runbook/tests
- reduce CI false-reds
- improve evidence and diagnostics
- prepare internal pilot deployment

Internal pilot readiness now requires authenticated postdeploy smoke evidence:
`authenticated=true`, `signoff.internalTrial=pass`, `summary.fail=0`, and PASS
for `auth-me`, `integration-route-contract`, the four control-plane list probes,
and `staging-descriptor-contract`. Mock PASS and public-only smoke PASS do not
replace this gate.

Defer until after PoC PASS:

- vendor profile registry
- adapter builder
- schema catalog
- marketplace
- second ERP adapter
