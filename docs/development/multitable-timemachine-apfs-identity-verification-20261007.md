# Time Machine APFS identity repair verification

Status: local repair verified; Draft/HOLD. Whole TM completion remains OPEN.
Source parent: `f817f010fce37e903440eb8a2a5ca69caf070c6f`.
The committed-source receipt records the final commit and all eight PR source files.

Darwin runtime filesystem numbers do not identify a stable filesystem type.
This host reports APFS 26 and HFS 25. Both existing stores previously selected 25,
rejecting real APFS roots and accidentally selecting HFS. The shared helper now
requires the native literal APFS name through fixed bounded `/bin/df` execution.
Linux's three allowed types and existing mountinfo isolation are unchanged.

## Gate results

| Design-lock gate | Evidence | Result |
| --- | --- | --- |
| Genuine pre-repair baseline | Complete two existing leaf suites: 29 cases, 3 PASS, 26 fixed-code refusals, 0 skip | PASS |
| Type/command/error boundaries | Whole helper file: 30 cases; explicit Type, fixed argv/env/bounds, malformed/other/network output, execution refusal, Linux parity | PASS |
| Existing stores and neighbors | Final seven whole files: 167 PASS, 0 FAIL, 0 skip, including startup and application | PASS |
| Native production providers | Real APFS roots: immutable PUT/HEAD/GET/replay/reopen, pin/delete persistence, four contender pairs using separate provider instances in one process, two transaction refusals | PASS |
| Separate process custody | Fresh Node process reads pinned ciphertext and both encrypted packages; starts locked, unlocks the rotated package, restores a retained old DEK | PASS |
| Writable non-APFS refusal | Owned HFS image, private owner directory, successful write/fsync/read control, four leaf refusals and empty directory afterward | PASS |
| Guard negatives | Three separate whole-file mutants: 27/3 of 30, 21/1 of 22, 7/1 of 8; each matching rejection assertion fails | PASS |
| Exact restoration | Seven source/lock files restored byte-for-byte, followed by the final seven-file 167-case run | PASS |
| Review and checks | Independent bounded source review, backend tsc, focused helper-spec tsc, configured `pnpm validate:all`, diff check | PASS |
| Ordinary exact-head CI | Linux Node 18/20 collection; native macOS evidence is separate | OPEN at publication |

The focused final command is `pnpm --filter @metasheet/core-backend exec vitest run`
with these complete files, without a test-name filter:

- `tests/unit/multitable-recovery-local-filesystem.test.ts`
- `tests/unit/multitable-recovery-archive-file-store.test.ts`
- `tests/unit/multitable-recovery-local-custody-store.test.ts`
- `tests/unit/multitable-recovery-local-custody.test.ts`
- `tests/unit/multitable-recovery-archive-object-store.test.ts`
- `tests/unit/multitable-recovery-local-startup.test.ts`
- `tests/unit/multitable-recovery-archive-application.test.ts`

The existing `plugin-tests.yml` Run core-backend tests step runs the package's
default Vitest discovery. The new helper spec matches that discovery, is not excluded
and ran under the same default configuration locally. No workflow, package chain or
provenance vector was changed. Remote collection is still an exact-head CI gate.

## Native evidence and preserved failures

Native Node is `v24.14.1`. Read-only libSystem `statfs64` confirms selected APFS roots
are local, writable and ownership checking is enabled. The genuine HFS negative is
also local, writable, ownership-enabled and privately owned. It is not a `/dev`
metadata-only substitute. The HFS image was created solely for synthetic negative
testing, officially detached with exit 0, and independently absent from the live
image inventory afterward. Its image and all attempted APFS packages are retained.

The first ignored proof harness failed at ESM/CommonJS import before provider I/O.
The second reached two encrypted package publications but serialized a wrapped
Uint8Array incorrectly across JSON; those packages remain intact. The corrected
explicit `.cts` harness encodes encrypted wrapped bytes as base64, uses fresh roots
and succeeds. Recovery secrets travel only through process memory and a child pipe.
Both first failures, source snapshots and the final controller readback are retained.
They are harness failures, not product guard-negative evidence.

A first mutation-result reader incorrectly expected an AssertionError label in
Vitest 1 JSON failureMessages. Actual messages contain the matching resolved-instead-
of-rejecting assertion. Source had already been restored. The first 27/3 run and
reader erratum are retained; the qualified runs record actual subprocess exits.
An early startup-neighbor invocation named a nonexistent application file: only the
20-case startup file actually ran. The final seven-file invocation uses the correct
archive-application filename and positively verifies all seven collections.

Evidence is under ignored `artifacts/tm-apfs-identity-20261007/`: baseline receipts,
native setup/provider/cleanup receipts and scripts, raw whole-file logs/JSON,
`mutations-qualified/` originals and results, and independent `review/` receipts.
Root records which controller receipts were saved after execution; they are not
represented as pre-execution freezes. Private device/path state is not public proof.

## Remaining boundary

This repairs filesystem type admission on the selected ownership-enabled APFS roots.
It does not newly establish automatic rejection of arbitrary noowners-configured
APFS volumes. Hostile same-UID/root mutation, hot-remount, NAS and power loss remain
outside the existing contract. Linux parity uses unit controls; it is not a new Linux
native filesystem qualification. macOS native evidence is not inferred from Linux CI.

Whole-system backup and recovery of the same authenticated archive, interrupted
owned-generation continuation, lifecycle, Phase 5 failure attribution, owner staging
authorization, deployment and business acceptance remain OPEN. Existing flags stay
OFF; this slice introduces no flags, migrations, key retirement or activation.
