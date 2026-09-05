# Time Machine D5 expiry fixture hardening

Status: owner-authorized local CI repair; publication and remote CI pending.

## Scope and binding

- Base: `70dc72d7671cad9cea1925ed93f90d3d9c746aeb`.
- Code: `e98e171abe700ec460566bddf35f86fb866489a2`.
- Code tree: `b83cfa9e14369b50fe1c92580fffe927a3841a6d`.
- Branch: `codex/tm-d5-expiry-fixture-hardening-20260905`.
- Only code path: `packages/core-backend/tests/integration/multitable-recovery-archive-restore-jobs-realdb.test.ts`.
- Documentation: this design and the matching verification report only.

The published D8 checkout is frozen and was not edited. Production source,
migrations, workflows, Vitest configuration, shared fixtures, and token TTL
policy are unchanged. The default token duration in this test remains `10m`.

## Reproduced cause

Required Node20 job `101240622471` in run `33941820323` failed while preparing
the zero-write job in the archive-expiry test. The observed stack ends at
`prepareRecoveryArchiveRestorePlan`, source line 592 on the frozen base.

`mintExactArchiveRecoveryIdentity` delegates signing to jsonwebtoken. Its issued
time is floored to whole seconds, so the test's former `1s` token has only a
fraction of a second remaining when minted late in a second. Preparation verifies
the JWT, acquires database fences/locks, inserts the prepared plan, then checks
the exact persisted binding and `token_expires_at > clock_timestamp()` again.

A real PG15 probe aligned minting to approximately 600 ms into a second and
inserted a 1.1-second database delay before the final prepared-plan SELECT. The
old fixture had 388 ms remaining before that delay. The SELECT returned
`state=prepared`, `exact_binding=true`, `row_version=1`, and `token_live=false`;
the unchanged service threw the same identity-invalid error at line 592.
This proves a fixture timing defect reproducing the observed CI failure site.
The CI log does not contain the actual token lifetime or elapsed lock timing,
so that individual CI execution's timing cannot be reconstructed exactly.

## Fixture contract

1. Replace the three `1s` fixture tokens with `5s` tokens. This provides roughly
   four to five seconds for legitimate setup despite whole-second JWT rounding.
2. Give the partial job and zero archive ten-second database-derived deadlines.
   Use the partial deadline for its lease, and the zero plan's exact object
   deadline for its resume bound. This preserves the plan/lease/archive bounds.
3. Wait for both returned job resume deadlines and the archive deadline before
   exercising live-job archive-expiry refusal and the two-job sweep.
4. Read each relevant burn's persisted `retain_until` before pruning or starting
   the held-burn race. Do not infer it from the requested token duration.
5. Retain all original assertions and add an unused-plan sweep assertion of zero
   before expiry. Keep its post-expiry sweep count and row-state assertions.
6. Keep database polling at 50 ms, with a 15-second watchdog to observe the
   ten-second deadlines even when the final poll is delayed by scheduling.

The fixture uses the actual PostgreSQL clock. Faking JavaScript time would not
advance `clock_timestamp()`, and rewriting persisted deadlines would bypass their
immutability contract. The selected approach therefore spends real elapsed time
but waits on observed deadlines rather than fixed sleeps. It is bounded evidence,
not a guarantee under arbitrarily long process suspension. The 1.1-second delay
and phase-alignment probe are temporary verification instrumentation only.

## Acceptance

Old fixture under the constrained boundary must be RED; the fixed fixture under
the identical probe must be GREEN. Removing the expiry wait must still make the
post-expiry assertion RED. Run the focused expiry/prune tests, the complete owning
real-DB suite without skips, nearest non-DB units, core typecheck, scoped lint,
and diff checks. Audit zero synthetic residue before stopping the owned PG15
instance and deleting only its data directory and temporary dependency links.

No production/provider/KMS, real-tenant, staging, deployment, flag, dispatch,
Ready, PR merge, or remote CI result is established here. Whole-sheet recovery
remains PARKED. The verification report records the exact commands and artifacts.
