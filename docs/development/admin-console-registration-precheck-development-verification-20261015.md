# Admin-console registration precheck: development and verification

## Scope and release boundary

Follow-up for the already authorized #6407–#6410 release chain. No new capability, deployment, real tenant reads, CI-variable/protection changes, or business-system writes. Merge remains gated on each exact published head's applicable CI and independent review; local qualification is not remote CI success.

The first refreshed Plugin runs failed one registration contract assertion: an existing-email precheck called full profile resolution, which could open the attendance bootstrap transaction. The original null/no-transaction assertion was retained, not weakened. Native reproduction at `1383c28fe0` failed the same assertion (60 passed, one failed across four files).

## Implementation and independent correction

Grok implemented the first bounded read-only existence check (`a5599f42b0`). Sol high review found a P2 counterexample: an unbackfilled legacy username equal to a registering email could be shadowed by a new account. Native green tests did not override this HOLD.

After the Grok follow-up spent several minutes without source changes, its session was closed and the coordinator implemented the minimal correction (`e11e0a0857`); implementation and Sol review remained separate. Registration now uses one parameterized `SELECT 1`, retaining email normalization and the supported pre-cutover username/mobile reservation. It does not map a profile, resolve RBAC, open bootstrap transactions, or write roles on a hit. The existing alias-cutover loader, alias ownership/creation transaction, retries, and error discrimination are unchanged. No new alias-backfill mechanism or concurrency guarantee was added.

The pure email existence check deliberately remains conservative after alias cutover. Alias-only equivalence/races continue to be rejected inside the existing creation transaction, not claimed as universal no-transaction fast paths. Pre-existing concurrent cross-column legacy writers are outside this correction's guarantees.

## Frozen qualification and latest main

- `5be23bc7008c171a1f087de7a61e6dcc75dcf63e`: corrected combined source including main `0528447731`; full native registration qualification below.
- `d72982143fe42ab8a98b732fcafa8a92e55b46f0`: integrates main `519263ae37` (#6405), preserving the union of role-members/localized builtin presentation and the incoming reserved-name refusal rules. Workflow count changes and existing test chains are retained.
- Auth/RBAC source and affected registration dependencies are unchanged between these two snapshots. Earlier DB/API/mutation evidence retains its original SHA; it is projected, not relabeled as a rerun on the later snapshot. Sol independently verified this boundary and the role/UI/workflow union.

## Native Mac mini verification

All runs use the task-owned synthetic source/runtime, never the staging or customer database. Test counts below are per command and may overlap; they are not a distinct-test total.

| Source | Command / evidence | Result |
|---|---|---|
| `5be23bc700` | `run-checks.py register-precheck` (four unit files) | 67 passed |
| `5be23bc700` | `run-checks.py backend` (ten neighboring files) | 331 passed |
| `5be23bc700` | `run-checks.py latest-main-neighbor` | 15 passed |
| `5be23bc700` | `run-checks.py atomic-db` | 11 native DB tests passed |
| `5be23bc700` | `run-checks.py register-db` | 3 native DB tests passed |
| `5be23bc700` | `register-precheck-mutations.py` | Profile-read, normalization removal, and legacy-namespace removal each assertion-red; bytes restored and tracked tree clean |
| `5be23bc700` | `run-checks.py quality` | `validate:all` passed |
| `d72982143f` | `run-checks.py role-backend` | 251 passed |
| `d72982143f` | `run-checks.py role-web` | 27 passed |
| `d72982143f` | `run-checks.py quality` | `validate:all` passed |
| `d72982143f` | `run-ci-wiring-qualification.py` | 304 guard/neighbor tests passed, zero skips; both deletion mutations assertion-red and bytes restored |

The actual product backend's health source matched `5be23bc700`; four synthetic accounts passed real login and tenant checks. For two regular subjects in different synthetic organizations, unauthenticated duplicate registration returned exact 409 without changing their attendance role/witness state. Authenticated `/auth/me` then provided a positive bootstrap control. An email-shaped legacy username with no email or alias reservation also returned 409; user count and alias ownership stayed unchanged and username login remained usable before and after the attempt.

The first API harness attempted four registrations and hit the production-default three-attempt rate limiter. This was a harness failure, not waived or counted green. The corrected harness makes three total attempts; no rate-limit configuration or middleware was disabled.

## Review, restoration, and evidence

Sol high source review: PASS at `5be23bc700`, after resolving the earlier P2 HOLD. Separate bounded latest-main role/workflow union review: PASS at `d72982143f`. These are independent static reviews, distinct from parent-run native tests.

The complete task-owned database was freshly restored; all 445 table counts and content hashes matched the baseline (four users, zero sessions). Owned backend, web, and PostgreSQL were stopped. Static latest-main tests subsequently ran without starting these processes. No other worktree or shared runtime was altered.

Values-free receipts, historical failures, mutation receipts, source-equality checks, and the independent reports are under `artifacts/admin-issues-20261014/`. Public branch projections must preserve latest-main ancestry, all unrelated blobs, and the qualified union on overlapping files. Each updated head must pass fresh CI; no historical head's green checks authorize merge. Closeout remains pending until sequential merges and final main automatic CI actually pass.
