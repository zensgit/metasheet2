# Sealed-export S5 — `sqlserver.sealed_snapshot.v1` certification (2026-07-30)

## Scope

Latent S5 certification surface for the owner-ratified direct SQL Server product
profile. No S6 runtime wiring, routes, scheduler, flags, deployment, customer
source access, or external write.

## Exact coordinates

```text
profileId=sqlserver.sealed_snapshot.v1
connectorKind=data-source:sql-readonly
actionId=sealed_snapshot
implementationVersion=sealed-export.sqlserver.snapshot-action.v1
acquisitionMode=SEALED_EXPORT
supportedConsistencyProofs=SOURCE_SNAPSHOT_TXN,IMMUTABLE_SNAPSHOT_TOKEN
continuationLifetime=DURABLE_TOKEN
supportedCompletenessProofs=SIGNED_MANIFEST
recoveryStrategy=CHUNK_RESUME
customerScope=SINGLE_CUSTOMER
sourceMode=READ_ONLY
externalWrite=false
```

## Product action vs S2 fixture

| Surface | Identity | Role |
|---|---|---|
| S2 fixture | `sealed-export.sqlserver.fixture.v1` | Evidence input only |
| S5 product | `sealed_snapshot` / `sqlserver.sealed_snapshot.v1` | Named certification target |

S5 must not relabel the fixture as the production action.

## Modules

- `sqlserver-sealed-snapshot-profile.cjs` — certified profile
- `sqlserver-sealed-snapshot-service.cjs` — **only** product composition/execute root (closure-bound)
- `sqlserver-sealed-snapshot-service-core.cjs` — shared implementation core; test-support composition is not product-branded
- `sqlserver-sealed-snapshot-action.cjs` — relation catalog + pure constants (no execute export)
- `sqlserver-sealed-snapshot-source-session.cjs` — named first-party MSSQL session opener; its capture-context brand is a declared trust-minting path
- `sealed-export-binding-qualification.cjs` — strict owned-input probe/verify helpers; `probedAt` is digest-bound
- `sealed-export-signer-authority.cjs` — pure helpers + untrusted caller-built verifier only
- `sealed-export-signer-authority-store.cjs` — joins live 069 binding/qualification/signer authority with 070 public SPKI material
- `sealed-export-package-provenance.cjs` — candidate-tree module/migration/runtime package + lockfile pins (068/069/070/071)
- migration `070_create_integration_sealed_export_signer_authority.sql` — public SPKI material only (no status/expiry)
- migration `071_harden_integration_sealed_export_authority_lifecycle.sql` — prevents same-key terminal lifecycle reactivation; key rotation remains explicit

## Signer lifecycle (single truth)

| Layer | Table / shape | Owns |
|---|---|---|
| S4 activation + S5 sign/verify authority | `integration_sealed_export_authority_state` (069) | signer lifecycle plus binding/qualification currentness, expiry and exact qualification digest |
| Public verification material only | `integration_sealed_export_signer_public_keys` (070) | SPKI DER + `signer_key_id` (= SPKI sha256), scoped to the same authority coordinates |
| Private keys | process memory only | never PG |

There is no dual-write of status/expiry onto 070. S5 re-reads 069 and joins
070 before source capture, again before signing, and again for verification.
A public key may be present while 069 is revoked, expired, stale-binding or
stale-qualification; each state refuses. Split-brain negative + ACTIVE positive
controls live in `sealed-export-signer-authority*.test.cjs`.
Migration 071 makes `EXPIRED` and `REVOKED` terminal for the current signer key;
returning to `ACTIVE` requires an explicit first-party key-id rotation.

## Trust rules (post review HOLD fix)

- No public `createHarness*` / `createTrusted*` / `createFirstPartySignerAuthority` / `__internals` trust mint. The product service factory and named MSSQL session opener are the two declared first-party minting paths.
- `service.execute()` accepts only inert run data; refuses resolution/session/signer/keyring/SQL keys.
- Approved bindings, the first-party relation catalog, qualification keyring,
  artifact root, source connection, private signer material and evidence-only
  observers are construction-bound. Per-run overrides are refused.
- Public-key enrollment and 069 activation are separate first-party authority
  operations. The service receives an authority DB handle, not a caller-built
  lifecycle snapshot.
- Qualification candidates expire after five minutes. A separate activation
  path must verify and persist the exact candidate digest in 069; S5 execution
  only accepts that live digest.
- Zero-row captures refuse before signing because the existing S4 persisted
  generation contract requires positive row and byte counts.

## Evidence

- Hermetic suites under `plugins/plugin-integration-core/__tests__/sealed-export-*s5*`
  and related module tests.
- Hermetic capture-core → S3 → S4 integration
  (`sealed-export-s5-product-to-s3-s4-integration.test.cjs`):
  capture once via the explicitly non-product test core → interrupt after ≥1 receipt → resume from
  receipts + frozen chunks with `dataStreamReadCount === 1` → `stageAndSeal` on the
  signed hermetic manifest; independent binding / chunk / totalRows / whole-artifact /
  rowset tamper gates each refuse with their own reason plus a positive control.
  Reuses S3 private-ingestion + S4 generation services (no duplicated engines,
  no runtime wiring).
- Real SQL Server 2019/2022 source/action workflow:
  `.github/workflows/sealed-export-s5-sqlserver.yml`
- The workflow uses real SQL Server snapshot transactions and proves a
  concurrent full-table mutation while the finalized artifact remains entirely
  the pre-mutation state. Snapshot proof binds the enabled database capability,
  current-session isolation level `5`, and one session/database/transaction
  identity across metadata and every streamed row; it does not require the
  server-wide snapshot-transaction DMV. The evidence relation is large enough
  to exercise multiple 1 MiB chunks and external-sort runs without shrinking
  production chunk sizes for test convenience. The product action connects as
  an ephemeral SQL login granted only `SELECT` on the certified relation; the
  separate fixture-control connection performs the concurrent mutation. Its
  gate-check also runs migrations 068–071 against
  real PostgreSQL and proves revoke → same-key activate is rejected while
  revoke → new-key rotate remains available. The product-action jobs exercise
  the production authority store contract over a hermetic DB adapter; they do
  not claim a combined SQL Server + PostgreSQL end-to-end runtime.
- Repository-frozen provenance pins prove candidate-tree consistency only.
  Evidence includes the frozen-manifest digest and explicitly requires an
  independent package/release pin before S6 delivery.
- Values-free evidence requires `runtimeReachable=false`,
  `customerSourceUsed=false`, `externalWrite=false`.

## Explicitly excluded

Routes, scheduler, runtime consumer, production package delivery, preflight,
flag enablement, rollout, customer-source access, external write (S6+).
