# Time Machine current-source same-archive local acceptance

This continues the existing V1 controlled-staging goal. Local implementation and
synthetic verification do not ratify staging, publication, flags, customer data,
independent provider durability or KMS. Overall completion remains OPEN.

The fresh main baseline is `644310ba60953b021d85ae393d94ef3408e25cb9`.
The prior locally qualified candidate is `680d50d339c027a82e5cf6862459ce9b267948ac`.
Their conflict-free source union is tree `ad032398eab728446acbe1fa76f3cfe235c62a4a`;
141 candidate paths are applied in a new owned worktree, preserving current main.
This is source integration, not a new native run of either historical source.

Reuse the existing same-filename extended local backup driver and its manual HTTP,
official target, rollback and focused source-guard helpers from the same-chat
`tm-same-archive-5001-apfs-20261001` source. Keep its separate seeded control.
Do not create a second backup driver or replace a genuine generation with a seed.

Adapt only test-only capture wiring and lifecycle handling. Supply the same real
source pool through the current nativePool port, a finite connection timeout and
explicit finite capture limits. Track actual fulfilled BEGIN/COMMIT/ROLLBACK and
release for native clients so external depth observations are truthful. Do not
mutate a shared pool's options, downgrade the flags or mock the owned composer.
Use finite synthetic limits of 64 MiB accepted representations and 60 seconds;
this is neither a process RSS cap nor a production configuration choice.

Database creation/disposal must bind the known synthetic names, actual OID,
owner and cluster system identifier. Drain owned children and pools normally;
require zero clients and identity parity before non-FORCE DROP, then prove
absence. No pg_terminate_backend, wildcard drop, migration down or reused closed
PG/APFS image is permitted. Resource/process evidence is a separate runtime gate.

| Gate | Required evidence | Initial state |
| --- | --- | --- |
| Source union | Every applied candidate path equals the merged tree; main-only paths and shared main changes retained; package, lockfile and flag manifest unchanged | Root union receipt present; independent review pending |
| Existing chain reuse | Genuine captured generation, 5001 records and immutable attachment remain distinct from seeded control; old identity/backup/takeover/rollback assertions retained | Source port pending |
| Current capture port | Same native source pool, finite acquisition/capture budget, truthful depth; missing pool/budget refusal stays meaningful | Source adaptation pending |
| Normal lifecycle | Exact registered identity, zero clients, non-FORCE DROP/absence; no forced connection termination | Source adaptation pending |
| Static and type checks | Whole focused source-guard file plus neighbor; actual acceptance TypeScript configuration; no native execution inferred | Pending |
| Fixed-source native chain | New source/input/runtime freeze; genuine generation → quiesced SQL/object/custody backup → empty target import → source unavailable → fresh process restoration/takeover → exact 5001 once-only readback/drain → fresh OFF rollback; actual exits and official closure | OPEN; no old runner or resources activated |
| Discriminating negatives | Exact refusal shapes and unchanged state; matching behavioral guard RED; full restored original rerun | OPEN |
| Full staging goal | Complete current writer/fault requirements, Phase 5 live attribution, required exact-source remote CI, provider/key and exact owner target/window packet | OPEN / separately gated |

The previously reported old owned-composer task/runner restriction remains in
force while its precise saved rejection is unverified. This source-only port is
not permission to reactivate it, rename an equivalent execution or replace its
profile. No executable native attempt is authorized by this lock itself.
