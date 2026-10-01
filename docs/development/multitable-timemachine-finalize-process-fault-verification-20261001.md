# Manual finalize process-fault verification

Status: bounded local synthetic acceptance, Draft/HOLD. Contract:
`multitable-timemachine-finalize-process-fault-design-lock-20261001.md`.
This validates the current manual source-recheck profile, not the original D-H2
durable archive-block/RR path, full D7 or actual staging acceptance.

## Frozen source and validation

- Implementation checkout: `086528126a9e717f3f4a15812fcbc52f811a1708`, with
  pre-code lock `749d7122a3` and the tracked checkpoint producer repair.
- Independent publication composition: `c9337d3e73e7f175727c3993fd5e8d4c44e5357a`,
  based on Draft #6201 `3fda6713e2b81da79419da89ad590fc4d2ce26bf`, with the same
  lock and three-file test delta. All six recorded runtime/test hashes match.
  Production `src`/`core`, routes, schema, defaults and lease policy are unchanged.
- Both exclusively owned PostgreSQL 15 / short APFS temporary-root runs use the
  tracked official runner and cache-only wrappers. Neither wrapper supplies or
  overwrites database URLs. The tracked producer supplies its owned matching pair.
- Each run passes nine neighbor files / 239 Vitest tests / zero skipped, two
  canonical replays (33 migrations / 1026 catalog objects), the earlier genuine
  late-MAC and eleven-object positive, both new script outcomes, and subsequent
  ordinary manual/HTTP/attachment-stage/private-backend-drain assertions.
  The 239 repeated tests overlap; the two script outcomes are recorded separately.
- Implementation additionally passes 38 unit and six wiring tests, acceptance
  plus explicit child typing, and `pnpm validate:all`. Independent composition
  passes `pnpm validate:all`; its subsequent typing-only include addition passes
  `tsc --listFiles`, actually collecting both the child fixture and sibling helper.
  All old acceptance includes and required test selectors remain present.

## Parent test-lane repair and published CI

The source parent is synchronized to Draft #6201
`44b46c1a2a445ea97b5e9a0aa69f0644c169fcb1`. Its workflow alias producer fix
`eb66e3f1bc60416ff4684b54a51936f7492b119c` adds the same explicit test DB URL
to the existing exact multitable step and keeps the child equality guard strict.
That parent locally passes its parsed fourteen-file archive roster: 312 tests,
D2b 25, zero skipped; fifty wiring/neighbor tests, RED/restored alias mutation,
validation and read-only audit pass. Its retained dependency-relink limitation
and original 3fda standard-lane failure remain in the parent verification report.
This child changes no runtime/helper/fixture bytes during parent synchronization;
new publication-head CI remains a separate gate.

Original child dispatch `36808533496`, head
`4812b9996e6b088929b10d1d2020b5c2c6768b9c`, has a complete successful Node 18
job `110198178426`. Its strict step 87 window actually executes all nine files /
239 tests / zero skipped in three batches, the late-MAC positive/refusal, and both
new fault outcomes with four attachments, fifteen objects and fourteen nonces.
Both observe PostgreSQL blocking and SIGKILL; committed outcome observes a live
lease after COMMIT. Archive 101 is intentionally Node 20-only and skipped here.
Complete log (7,543,187 bytes / twenty-nine validated ranges) SHA256:
`b86e48d7a72b3ef05c620c1c1fe95e61f60fd5ed7f5dccbc4342dff591f02e57`.
The old Node 20 run and repaired publication-head dispatch are not covered by
this successful Node 18 evidence. A first log-census attempt incorrectly expected
one combined test summary; its failure is retained and the actual three batches
are parsed independently. It is not a runtime test failure.

## Actual process outcomes

Each case derives its four source attachments/pins, fifteen uploaded objects and
fourteen permanent nonce reservations from a real authorized manual capture.
Parent and child verify the genuine synthetic custody MAC; no verified catalog
state is fabricated. The ordinary checkpoint injects the existing real command
factory after its owned attachment directory is configured.

| Outcome | Observed proof |
| --- | --- |
| Before COMMIT | Successful real catalog CAS is paused at transaction depth 1. Another connection sees the complete prepublication snapshot; `pg_blocking_pids` proves the expired-owner contender blocked by that transaction after actual lease expiry. SIGKILL and child close cause rollback; abandonment wins. Original-namespace cleanup requires all fifteen terminal receipts before each of the four source-pin releases. |
| Committed response loss | The contender is blocked while the lease is live. Genuine COMMIT wins; an immediate DB-clock query observes the lease still live at depth 0 before the response barrier and SIGKILL. Verified objects, coverage and archive references are atomic. The blocked contender and a refreshed CAS after actual expiry refuse; fresh-process same-request retry returns the same recoverable generation with zero provider verbs, custody/MAC calls or source reads. Verified cleanup refuses before provider calls. |

Full-row/digest comparisons preserve prepared data, permanent nonces, original
bindings, staging key references, key row and hot history. Retry provider
construction still performs filesystem admission IO; this is not zero filesystem
IO. Barriers and the thirty-second fixture lease exist only in test seams/input.

## Fresh current-main local APFS composition

Private validation branch `codex/tm-current-main-apfs-20261001` freezes composite
`4079bad87d86b8712987f889728a7453b8efa9b8` on observed main
`0386f47fdc9a3e88f38e06c46547389fda42d3d7`. All twenty-four main Tasks/auth/web
changes are preserved byte-identically; nine candidate production paths equal
4812/eb66, five backup helpers equal PR #6183, and the acceptance includes retain
the exact union of all three sources. The Phase 5 parser is outside this recovery
dependency closure and its live attribution remains separate.

The fresh exclusively owned APFS/PG run completes the same real manual generation
backup, source unavailable, initially empty independent target, official FD3
launcher and scalar/attachment/history recovery. Two fresh flag-OFF processes
prove HTTP response parity and no writes across twenty-two compared tables
(including records/revisions; this is not twenty-two archive-only tables).
The separate seeded 5001-row control completes two chunks and 5001 derived effects.
Driver and outer runner exit 0; actual PG startup identity, stop 0/status 3,
zero databases/backends, driver group/scoped processes, PID, listener and all
three exclusively owned roots are checked. Complete log SHA256:
`176283cb1cc65a94a2f19db8e925104979085a2541c6fba654aad449fb03dd84`.

Acceptance typing actually collects the finalize child/helper and manual target /
rollback; fifty wiring/neighbor tests pass. Independent source/log/census/lifecycle
review is CLEAR. The actual shared login path runs, but this recovery harness does
not separately assert the Tasks feature payload. Evidence and driver:
`artifacts/tm-current-main-apfs-20261001/` in the private acceptance checkout.
This proves that exact private LOCAL composition, not a main merge, complete CI,
actual staging/full D7, physical attestation, per-child cache-off or power loss.
Historical c933/a1d runs keep their original source and environment identities.

## Evidence and boundaries

Complete official logs: implementation SHA256
`f18c7d6033f7096d96030af2bea41add764e217ae2ed8ff59a7758b01000db95`;
independent log (14,249 bytes) SHA256
`3c406ebd6ed193836dc87e418c6c1dfd3db2378f01c3156cbe8e40dc97acded7`.
Both runners exit 0. Nine recorded child PIDs are gone; five SIGKILL outcomes are
observed. The fresh retry's PID is not separately persisted, but its close/exit 0
is asserted by the harness. Owned PG PID, listener, connections and roots are zero.

Retained implementation evidence: `artifacts/tm-finalize-cas-crash/` in the
implementation checkout. Independent evidence, source/collection hashes and
scoped lifecycle driver: `artifacts/tm-finalize-process-fault-independent-c9337d3/`.
The failed setup attempt is retained: eager test import captured the default
attachment root before configuration, and neither new child case executed.
The corrected helper receives the late-loaded real factory. No production fix
or timestamp rewrite was needed. Earlier post-COMMIT observation weakness is
corrected; no new runtime mutation probe is claimed.

The existing backend workflow's ordinary checkpoint executes both cases;
publication-head Node 18/20 CI and main-required merge-window CI remain separate
pending gates. SIGKILL is not power loss, remote durability or erasure proof.
Full D7/D-L, live Phase 5 attribution, staging profile/window/deployment/rollback
and production acceptance remain open; the overall goal remains ACTIVE.
