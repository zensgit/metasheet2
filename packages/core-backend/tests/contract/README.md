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

This Pact set freezes the **shape** (not the values) of the 7 Wave 1 P0
endpoints plus the 3 document-semantics endpoints, the release-readiness
governance endpoint, the 5 BOM-analysis / ECO-approval endpoints, and the 5
approval-detail / BOM-substitute endpoints, while Wave 5 adds the 9 CAD
properties / review / diff endpoints as exact fixture examples that
`PLMAdapter.ts` currently calls for `apiMode='yuantus'`. PLM-Collab V1.2 adds one
parent-host-mediated interaction, `POST /api/v1/bom/multitable/{part_id}/embed-token`:
the Yuantus parent page calls it and posts the returned token into the MetaSheet iframe.
It is intentionally not a `PLMAdapter.ts` call, but it belongs in this broker artifact
because the MetaSheet embed runtime depends on the token envelope.
(Codex's PACT_FIRST plan lists 7 endpoints in Wave 1, and the consumer now
calls all 7.)

The companion provider verifier lives in the Yuantus repo at
`src/yuantus/api/tests/test_pact_provider_yuantus_plm.py`.

## Current implementation note (2026-04-11)

The pact JSON in `pacts/metasheet2-yuantus-plm.json` is **hand-authored** in
Pact v3 format. It is **not** yet generated from `@pact-foundation/pact`,
because adding that npm dependency requires explicit approval.

The `plm-adapter-yuantus.pact.test.ts` vitest test guards six things:

1. The pact JSON exists and parses as Pact v3.
2. It contains the adapter-owned interactions plus the one V1.2 parent-host-mediated
   embed-token interaction in the documented order.
3. Every adapter-owned endpoint named in the pact is also referenced by the live
   `packages/core-backend/src/data-adapters/PLMAdapter.ts` source — so those pact
   entries cannot drift away from what the adapter actually calls.
4. The Wave 3 additions lock the exact envelope for `where-used`,
   `bom compare schema`, `approval history`, `approve`, and `reject`.
5. The Wave 4 additions lock the exact envelope for approval list/detail and
   BOM substitute list/add/remove.
6. The release-readiness addition locks the exact envelope for
   `GET /api/v1/release-readiness/items/{id}`.
7. The Wave 5 additions lock the exact envelope for CAD properties, CAD view
   state, CAD review, CAD history, CAD diff, and CAD mesh stats.
8. The V1.2 addition locks the parent-host mint envelope: request `{origin}` and
   response `embed_token`, `token_type`, `expires_in`, `jti`, `aud`, and
   `embed_origin`. Token and `jti` are matched by shape, never exact value.

## aml/metadata is now live on main

`GET /api/v1/aml/metadata/{item_type_name}` was previously parked outside the
consumer pact because `PLMAdapter.ts` did not call it. This worktree closes
that gap in the contract-first way:

1. `PLMAdapter.getItemMetadata(itemType)` now calls the Yuantus metadata route.
2. Federation exposes `GET /api/federation/plm/metadata/:itemType`.
3. The SDK and `plmService` now expose `getMetadata(itemType)`.
4. The pact JSON now includes `GET /api/v1/aml/metadata/Part`.
5. The provider verifier can seed stable `Property` rows for the `Part`
   `ItemType`, so the metadata response is meaningful instead of an empty
   placeholder.

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

### Current verifier handoff state (2026-04-11)

The consumer artifact now contains the Wave 1-5 adapter interactions plus the
V1.2 parent-host-mediated embed-token interaction. To verify Yuantus against the
current artifact, copy this JSON into the Yuantus repo and rerun the provider
verifier there.

This worktree did **not** rerun provider verification, so do not treat the old
Wave 3 verifier count as evidence for the new Wave 4 interactions.

Wave 3 adds coverage for:

- `GET /api/v1/bom/{id}/where-used`
- `GET /api/v1/bom/compare/schema`
- `GET /api/v1/eco/{id}/approvals`
- `POST /api/v1/eco/{id}/approve`
- `POST /api/v1/eco/{id}/reject`

The provider keeps its state handler as a no-op by using distinct seeded ECO
fixtures for `history`, `approve`, and `reject`, so mutating approval actions
cannot contaminate later interactions in the same verifier run.

Wave 4 extends that pattern:

- list/detail approvals use separate ECO fixtures from history/action checks
- substitute list uses a pre-seeded substitute relation
- substitute add targets a fresh substitute item
- substitute remove targets a different pre-seeded substitute relation

That keeps the verifier deterministic without introducing per-state mutation
logic.

Wave 5 applies the same rule to CAD:

- read and write CAD properties use separate file fixtures
- read and write CAD view state use separate file fixtures
- read and write CAD review use separate file fixtures
- history uses a dedicated file with pre-seeded `CadChangeLog` rows
- diff uses a dedicated left/right file pair
- mesh stats uses a dedicated file plus a mocked metadata payload behind
  `FileService.download_file`

That keeps the provider-state handler as a no-op even though Wave 5 includes
three mutating CAD interactions.

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

No additional `aml/*` schema-discovery surfaces are parked right now. Future
adapter-owned schema endpoints should follow the same rule: add the consumer call
site first, then add the pact interaction in the same change. Do not add dead
`PLMAdapter` methods just to satisfy the pact sanity test; if a future interaction is
parent-host-mediated like the V1.2 embed-token mint, document that exception explicitly
and keep its own source-grounding test.

## Forward compatibility note

The `metasheet2-plm-workbench` long-running spike branch has version-aware
`approveApproval(id, **version**, comment)` and `rejectApproval(id, **version**,
comment)` for optimistic locking. Mainline already requires `version` on both
approval action call sites, so the Wave 3 pact keeps `version` required. Only
relax this field if a real mainline consumer change lands that removes or makes
`version` optional at the adapter boundary.

The full repo source-of-truth analysis lives at
`/Users/huazhou/Downloads/Github/Yuantus/docs/METASHEET_REPO_SOURCE_OF_TRUTH_INVESTIGATION_20260407.md`.
