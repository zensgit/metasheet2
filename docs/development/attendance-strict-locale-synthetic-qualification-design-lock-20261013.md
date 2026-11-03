# Strict and locale synthetic qualification — 2026-10-13

Owner authorized latest-main Strict target readiness and locale acceptance in the owned Mac mini synthetic isolated environment only. Frozen initial main: `c5ad041df1b71843b210f9b053a95967e41088ad`.

## Scope

- Fresh source checkout and isolated database/frontend/backend, two canonical UUID tenants and generated private credentials; no customer data, shared CI variables/schedules, branch policy, deployment or external writes.
- Actual backend health identity and exact /auth/me tenant proof; consumer checkout identity recorded separately. Missing/mismatched org or runtime identity cannot downgrade to unbound acceptance.
- Execute existing full Strict with all required API/import/settings gates, employee provisioning, production, desktop and mobile browser flows twice on unchanged runtime/source; Docker deployment preflight is explicitly inapplicable to a native isolated test process, never described as passed.
- Execute locale browser acceptance with real generated login/token, include second-tenant and refresh/configuration drift negatives. Actual requests/DB before-after readback must distinguish blocked writes and prior residuals.
- Only repair scoped, reproducible correctness regressions. Do not weaken guards/thresholds/schema, fabricate provenance, or treat missing/skip-shaped runtime tests as qualified.
- Implementation and independent review separate. Parent owns runtime/cleanup; Sol high handles focused verification or fixes; Luna medium inventories tooling/evidence; Astra high independently refutes the final patch/evidence.

## Completion gates

| Gate | Evidence |
|---|---|
| Target readiness | Actual /health frozen SHA, two login + /auth/me proofs, explicit synthetic binding, fresh migrations without exclusions |
| Negative binding | Missing/blank org, missing/wrong runtime SHA, second-tenant and refresh drift stop before next write; no success summary invented |
| Strict | Two full runs on the same frozen runtime/source, all five API/provision/browser gates PASS; provenance validator passes |
| Locale | Actual browser positive + identity negatives, created fixture/holiday cleanup read back |
| Correctness sensitivity | Meaningful guard mutation fails, restored source passes; focused + neighboring tests, necessary quality checks |
| Independent review | Astra review bound to exact source hashes and actual values-free receipts, actionable findings resolved |
| Cleanup | Only owned processes stopped; role/settings/record/holiday changes in isolated data compared/restored; audit metadata accounted separately |
| Deliverable | Development and verification MD with exact source/runtime, commands, results, limits and private evidence locations |

Performance scaling, Nightly/dashboard aggregation and real GitHub protection policy remain later slices. Public publication/PR/merge are not authorized by this execution request.

## Confirmed narrow consumer repair

Actual frozen-main Strict run: apiSmoke/provisioning PASS; production browser TIMEOUT awaiting removed visible `data-admin-quick-jump` select; desktop/mobile TIMEOUT awaiting Reload/刷新 while current Chinese UI renders Reload/重载. Do not change the product to recreate obsolete selectors. Adapt shared acceptance navigation and exact localized label matching to current rendered controls, preserve direct section visibility checks and all business assertions, and add focused regressions to the required Node chain. Actual locale is being run separately; only proven shared-control changes belong here.

Consumer source may advance separately from the frozen backend/frontend SHA; report both actual identities. The runtime checkout is never overwritten by consumer repairs. Public PR/merge remain a later owner authorization after completed review and concrete verification material.
