# Contract Tests

This directory holds the consumer-side Pact contract tests for the Metasheet2
PLM adapter against Yuantus.

## What lives here

```
contract/
├── README.md                                  ← this file
├── plm-adapter-yuantus.pact.test.ts          ← vitest sanity test
└── pacts/
    └── metasheet2-yuantus-plm.json           ← the canonical pact artifact
```

## Why this exists

Metasheet2 already calls Yuantus PLM in production through `PLMAdapter.ts`
when running in `apiMode='yuantus'`. Without a contract test, any field
rename on the Yuantus side would silently break Metasheet at runtime.

This Pact set freezes the **shape** (not the values) of the 6 Wave 1 P0
endpoints plus the 3 document-semantics endpoints and the 5 BOM-analysis /
ECO-approval endpoints that `PLMAdapter.ts` currently calls for
`apiMode='yuantus'`.
(Codex's PACT_FIRST plan lists 7 endpoints in Wave 1 — see "Discrepancy
with codex plan" below.)

The companion provider verifier lives in the Yuantus repo at
`src/yuantus/api/tests/test_pact_provider_yuantus_plm.py`.

## Current implementation note (2026-04-07)

The pact JSON in `pacts/metasheet2-yuantus-plm.json` is **hand-authored** in
Pact v3 format. It is **not** yet generated from `@pact-foundation/pact`,
because adding that npm dependency requires explicit approval.

The `plm-adapter-yuantus.pact.test.ts` vitest test guards four things:

1. The pact JSON exists and parses as Pact v3.
2. It contains the 14 currently used interactions in the documented order.
3. Every endpoint named in the pact is also referenced by the live
   `packages/core-backend/src/data-adapters/PLMAdapter.ts` source — so the
   pact cannot drift away from what the adapter actually calls.
4. The Wave 3 additions lock the exact envelope for `where-used`,
   `bom compare schema`, `approval history`, `approve`, and `reject`.

## Discrepancy with codex's PACT_FIRST plan

`docs/PACT_FIRST_INTEGRATION_PLAN_20260407.md` lists 7 endpoints in Wave 1
P0, including `GET /api/v1/aml/metadata/{item_type_name}`. When the
contract test was first authored that endpoint was included, and the test
**immediately failed** with:

> PLMAdapter.ts no longer references /api/v1/aml/metadata/; pact has drifted
> from the consumer.

A grep across `metasheet2/packages/core-backend/src` confirmed no caller.
The endpoint exists in Yuantus (`router.py:52`) and is intended for
front-end form rendering, but the metasheet2 adapter does not yet use it.

Per the contract-first principle, the pact must freeze what the consumer
**actually** calls, not what is planned. The metadata endpoint has been
moved to Wave 1.5 and will be added to this pact as soon as PLMAdapter
starts calling it. When that happens:

1. Add the call site in `PLMAdapter.ts`
2. Add a new interaction back into `pacts/metasheet2-yuantus-plm.json`
3. Add the path back into `WAVE_1_P0_PATHS` in the test
4. Re-copy JSON to `Yuantus/contracts/pacts/`

This drift catch is the pact gate working correctly on day one. The cost
of removing one anticipated endpoint is much smaller than the cost of
discovering an aspirational pact never matches the consumer.

## Running the test

```bash
# from packages/core-backend/
npm run test:contract
```

This runs under the existing vitest harness with no new dependencies.

## Provider verification (Yuantus side)

To verify Yuantus against this pact, copy or symlink the JSON into the
Yuantus contracts directory and run the provider verifier:

```bash
cp pacts/metasheet2-yuantus-plm.json \
   /Users/huazhou/Downloads/Github/Yuantus/contracts/pacts/

cd /Users/huazhou/Downloads/Github/Yuantus
./.venv/bin/python -m pytest \
   src/yuantus/api/tests/test_pact_provider_yuantus_plm.py
```

### Current verifier state (2026-04-11)

Wired end-to-end with `pact-python 3.2.1`. The provider verifier now starts
the FastAPI app, seeds an isolated test DB, and replays all 14 interactions.

**Current result: 14 passing, 0 failing.**

Wave 3 adds coverage for:

- `GET /api/v1/bom/{id}/where-used`
- `GET /api/v1/bom/compare/schema`
- `GET /api/v1/eco/{id}/approvals`
- `POST /api/v1/eco/{id}/approve`
- `POST /api/v1/eco/{id}/reject`

The provider keeps its state handler as a no-op by using distinct seeded ECO
fixtures for `history`, `approve`, and `reject`, so mutating approval actions
cannot contaminate later interactions in the same verifier run.

To install `pact-python` and run locally:

```bash
./.venv/bin/pip install pact-python
```

## Upgrading to a real consumer pact later

When `@pact-foundation/pact` is approved as a devDependency, replace the
hand-authored JSON with a real generated artifact:

```bash
npm install --save-dev @pact-foundation/pact
```

Then rewrite `plm-adapter-yuantus.pact.test.ts` to:

1. Construct a `Pact` instance via `new PactV3({ consumer: 'Metasheet2', provider: 'YuantusPLM' })`.
2. For each Wave 1 endpoint, declare the interaction via `pact.addInteraction()`.
3. Call the actual `PLMAdapter` method against the mock URL.
4. `pact.executeTest(...)` writes the artifact to `pacts/metasheet2-yuantus-plm.json`.

The artifact path stays the same, so the Yuantus provider verifier does not
need to be reconfigured. The current sanity test serves as an executable
specification of what the generated pact must contain.

## Still intentionally outside the pact

The following surfaces remain outside the pact because `PLMAdapter.ts` does
not currently call them on `main`:

- `GET /api/v1/aml/metadata/{item_type_name}`
- `GET /api/v1/bom/{line_id}/substitutes`
- `POST /api/v1/bom/{line_id}/substitutes`
- `DELETE /api/v1/bom/substitutes/{substitute_id}`

## Forward compatibility note

The `metasheet2-plm-workbench` long-running spike branch has version-aware
`approveApproval(id, **version**, comment)` and `rejectApproval(id, **version**,
comment)` for optimistic locking. Mainline already requires `version` on both
approval action call sites, so the Wave 3 pact keeps `version` required. Only
relax this field if a real mainline consumer change lands that removes or makes
`version` optional at the adapter boundary.

The full repo source-of-truth analysis lives at
`/Users/huazhou/Downloads/Github/Yuantus/docs/METASHEET_REPO_SOURCE_OF_TRUTH_INVESTIGATION_20260407.md`.
