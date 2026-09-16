# Local custody core verification

Status: local core verified; full LC storage/application acceptance remains OPEN.
Owner approved LC-1 through LC-6 for isolated development and synthetic recovery.
No flags, deployment, customer storage, production data or startup activation.

## Exact evidence

- Main base: `021647c9ef5587a2796eccafafecc426067b63a2`.
- Code commit: `dc3b66310f050901cc44dd5a158a0dad538323d6`.
- Code and test files: `recovery-local-custody.ts` and
  `multitable-recovery-local-custody.test.ts` under core-backend.
- Source SHA-256 after both mutations were restored:
  `ff517d1a86333573123e6b843368994cce8757e0a675c3b3042010fa7734a4fa`.
- Focused command: `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/multitable-recovery-local-custody.test.ts tests/unit/multitable-recovery-archive-crypto.test.ts --reporter=dot`.
- Result: 2 files / 75 tests PASS (18 local custody, 57 existing archive crypto).
- Core typecheck, scoped source ESLint and diff-check: PASS.
- Initial missing-module failure was collection RED, not behavioral evidence.
- Independent Sol high read-only review of the frozen code commit: 0 P1 / 0 P2 /
  0 P3. Reviewer inspected code and contract but did not rerun tests. Session closed.

## Discriminating checks

1. Removing retained versions from rotation made old-DEK recovery fail.
2. Adding active wrapping-key identity to the DEK fingerprint made rotation change
   the fingerprint. The stable-identity assertion failed.
3. Both mutations were restored byte-for-byte before the final 75-test run.

Tests cover locked startup, wrong secret/custody, closed and bounded backup shape,
nonce/ciphertext/tag tampering, generation/key/wrapped identity binding, all crypto
verbs refusing nonzero/unknown transaction depth, retained manifest MAC, version
capacity, caller-buffer isolation and values-free errors.

## Synthetic separate-process recovery

An isolated temporary directory holds encrypted archive content and a separate
encrypted custody package. A fresh Node process starts locked, obtains a synthetic
32-byte recovery secret through stdin, unlocks the package, verifies the manifest,
unwraps the DEK and recovers synthetic record content. Temporary files are removed.
No secret is placed in command arguments or customer storage.

This is crypto-artifact recovery, NOT a PostgreSQL catalog/object/custody integrated
restore. No database was started or migrated in this slice. No NAS, power-loss,
malicious-host, anti-rollback or physical-memory-erasure assurance is claimed.

## CI and remaining acceptance

`plugin-tests.yml` runs `pnpm --filter @metasheet/core-backend test` for Node18/20.
The new unit file uses the existing default Vitest discovery and is not excluded.
No shared workflow, selector, provenance pin or dependency changed.
Remote exact-head results are pending publication; local green is not remote CI.

Remaining: durable encrypted-keyring publication outside archive roots; explicit
trusted local-assurance admission without KMS fallback; full catalog/object/keyring
restoration; standard startup composition with locked default. Existing format-v1
KMS API and startup are unchanged. Do not mark the full Time Machine goal complete.
