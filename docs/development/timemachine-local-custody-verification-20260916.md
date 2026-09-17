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

At the core-only checkpoint, remaining work was durable encrypted-keyring publication outside archive roots; explicit
trusted local-assurance admission without KMS fallback; full catalog/object/keyring
restoration; standard startup composition with locked default. Existing format-v1
KMS API and startup are unchanged. Do not mark the full Time Machine goal complete.

## Persistent package follow-up

- Current-main replay: `5dcddbd2a55437bc4272ece6308d2ca941940ef5`, merged without conflict.
- Storage code commit: `6577c27058a5bce6c8d90d5d6d52b201fdc31e0f`.
- New source: `packages/core-backend/src/multitable/recovery-local-custody-store.ts`.
- New spec: `packages/core-backend/tests/unit/multitable-recovery-local-custody-store.test.ts`.
- Final source SHA-256: `7cb6ecc0be84675e5f227bf26c957235ec644cc3b1f4fc9696b010ba02fff91e`.
- Three focused specs (store, core, existing archive crypto): 82/82 PASS.
- Core typecheck, source ESLint and diff-check PASS.
- Concurrent different packages at one ID: exactly one winner, original bytes
  retained. Same package replay succeeds. Old rotation package remains readable.
- Synthetic private directories only, cleaned after tests. Secret never passed to
  the store. No database, mounts, customer directories or flags touched.
- Independent Sol review found a real bind-mount alias P2. It was closed by equal
  root device/inode rejection plus conservative Linux mountinfo admission. Fresh
  narrow review: 0 P1 / 0 P2 / 0 P3; no reviewer tests claimed. Session closed.
- Mutation removing mount alias admission: exact synthetic mount test RED.
- Mutation removing receipt digest comparison: exact receipt test RED.
- Source restored byte-for-byte, then full 82-test run GREEN.
- Existing default backend discovery collects this unit file without shared edits.

Previous remote head `65dfa1036ead1f70129f450eee9647b494d8b9eb` was 25 SUCCESS /
1 intentional SKIP / zero pending or failure. Those results do NOT cover this new
storage commit. New exact-head remote CI must be observed separately after push.

The file layer now provides immutable encrypted package publication and checked
readback on supported local filesystems. Full catalog/object/keyring application
restore, explicit local-assurance admission, independent offline-copy rehearsal
and standard startup composition remain OPEN. File sync calls and local tests do
not establish NAS, physical power-loss or malicious-host guarantees.

## Explicit admission local checkpoint (not yet published)

Code commit `ada94eca13f5a272e3e4e883241549a34d2d2ae7`, on main replay
`5dda8b077d7816ce42d938cfb60c742b9e598233`, adds explicit opaque local admission.
Seven bounded files; no manifest format, migration, object-store or startup edit.
The session supplies a namespaced key ID and revocable runtime identity. The existing
transaction guard resolves it without treating it as a KMS adapter or selecting a
provider from archive bytes. Expected custody is supplied out-of-band.

Local gates: seven unit/neighbor files, 127/127 PASS; core typecheck and six-source
ESLint PASS; diff-check PASS. Added positives/negatives cover explicit guarded
wrap/unwrap/MAC/fingerprint, forged/copied/raw session rejection, wrong expected
custody, noncanonical/cross-custody IDs, lock/re-unlock revocation, old-key reads
after rotation and inactive production-key refusal.

Mutation removing epoch equality made the re-unlock stale-admission test RED.
Restored core source SHA-256:
`e779b41af17aded3e72c0205a369f69553ceee2610f4a4e7af45dbc953a836f8`.
The full 127-test run above followed restoration. Prior remote green remains bound
to `0d063ab7d2e457314fffabf4c8407e2c2273e4c8`, not this local checkpoint.

Still pending before publishing this follow-up: independent exact-code review and
real local seal/authenticated-manifest/reader chain test. Full synthetic database
catalog/object/custody restoration remains a subsequent acceptance gate. No new
CI, runtime enablement, customer storage or deployment proof is claimed.

### Admission follow-up gates closed

The two local follow-up gates above are now closed. Independent Sol high read-only
review of `ada94eca13f5a272e3e4e883241549a34d2d2ae7`: 0 P1 / 0 P2 / 0 P3;
session closed, no reviewer-run tests claimed. Reader-chain test commit
`2089bd08a` uses the real reserve/seal, manifest authentication and complete-section
reader functions with a local admission. A fresh session using a rotated backup
recovers the original two record payloads and retained key ID. Old revoked
admission, wrong KMS provider and locked session all refuse.

Seven focused/neighbor suites now pass 128/128; core typecheck and diff-check pass.
The test uses synthetic nonce reservation and a test object provider: it is NOT
a PostgreSQL catalog plus durable object/custody recovery drill. That integrated
gate, independent offline-copy rehearsal and startup remain OPEN. Remote checks
on earlier `0d063ab7d` do not prove this follow-up until its own matrix completes.
