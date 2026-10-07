# D-H2 bounded metadata prerequisite verification

Baseline: `a68c2fd44538bc3ea3097f395b153b361baa3b0a`.
Contract: `multitable-timemachine-dh2-owned-capture-design-lock-20261001.md`.
Before publication the owned branch fast-forwarded to captured fresh main
`8e2e40d1252bdb7104bd0d54b12a397f90ef1f9a`. Its six inherited paths do not overlap this
slice; all thirteen owned input hashes stayed identical. Tested capture/migration inputs remain
unchanged, and whole-repository quality is rerun on the resulting tree.

The internal reader uses one RR snapshot for seven relational sections and attachment metadata.
SQL withholds an oversized row and its identity before transfer. A private executor owns connection
acquisition, BEGIN, capture, timeout restoration and confirmed read-only COMMIT. Expiry discards
the connection and prevents later SQL. Native acquisition requires an explicit finite timeout;
no shared pool configuration or capture-budget default is changed.

## Verified commands

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/multitable-recovery-archive-bounded-source.test.ts tests/unit/multitable-recovery-archive-capture-executor.test.ts tests/unit/multitable-recovery-archive-relational-source.test.ts tests/unit/multitable-recovery-archive-writer-block.test.ts --reporter=verbose`: four files, 87 PASS, zero skips.
- `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-recovery-archive-bounded-source-realdb.test.ts --reporter=verbose`, with the explicit real-DB step marker and an owned synthetic PG15.17 profile: 24 PASS, zero skips. All twelve frozen inputs matched before and after execution.
- `node --test scripts/ops/multitable-d2-archive-ci-wiring.test.mjs scripts/ops/multitable-d2-archive-fail-not-skip.test.mjs`: nine PASS, zero skips; every armed archive spec refuses missing DB configuration.
- `node --test plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs plugins/plugin-integration-core/__tests__/sealed-export-s5-product-to-s3-s4-integration.test.cjs`: two PASS. Only the workflow evidence pin changed; the other pin values remain identical.
- `pnpm validate:all` and backend `tsc --noEmit`: exit 0.

The DB run uses seven actual migrations in an owned scratch database. Evidence covers complete
populated/empty/cross-scope projection, SQL payload/identity suppression, cumulative bytes, actual
blocked-query `57014`, RC/autocommit/xid-replacement refusals, restored timeout, a concurrent writer
commit under the same RR snapshot, and advisory-lock exclusion/absence controls.

The executor cases verify confirmed COMMIT with a healthy idle connection, five stalled transport
stages closing the exact backend, no subsequent SQL after expiry, late acquisition without BEGIN,
native pool waiter removal while preserving its independent owner, and an accepted synthetic
handshake connection closing with zero retained clients/sockets. Scratch cleanup is strict,
without forced cleanup and with zero remaining scratch databases/connections.

Six saved-byte mutations each produced the matching assertion failure: payload SQL suppression,
identity SQL suppression, cumulative byte accounting, xid equality, owned-client destruction and
the post-completion deadline. Original source bytes were restored exactly; the full focused suites
passed afterward. Selected mutation failures are not added to the whole-file PASS counts.

Artifacts reside under `artifacts/tm-owned-capture-20261001/`; initial socket-path startup failure,
the unsupported test-polling helper failure, their repairs and all intermediate runs are preserved.
This report describes local evidence, not a CI execution on an unpublished head.

## Remaining gates

| Gate | Status |
| --- | --- |
| Exact committed RC claim capability and fresh RR owner/generation/reservation/pin rechecks | OPEN |
| Future coverage identities and owner-aware nonce/finalize/cleanup composition | OPEN |
| Full D-H2/D-I0, D-L and D7 durable-provider/KMS/fault acceptance | OPEN |
| New-head whole-file CI execution | OPEN |
| Owner ratification, merge, staging enablement/deployment and business acceptance | OPEN |

The manual HTTP/runtime path is not switched. No migration, provider/KMS activation, feature flag,
real data, customer storage, prune, delete worker or key retirement is introduced. This source
prerequisite does not establish a new same-archive APFS drill or overall Time Machine completion.
