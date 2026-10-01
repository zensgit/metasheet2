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
