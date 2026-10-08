# Time Machine D-H2 committed claim

Status: bounded development, default-OFF. Parent authority is D-H2/D-I0 in
`multitable-timemachine-phase-d1-durable-archive-design-lock-20260826.md`.
Baseline: `c1e4250e6f1043239b563a342ffa2187061532a3`, prerequisite Draft #6223.

## Required result

A new internal claim owns one native READ COMMITTED connection. Its first business statement is
the source-free canonical fence prelude. It takes the source-free actor/request lock in the same
order as legacy manual admission, then locks the active key/version, authorizes the exact
actor/scope/request, reads existing heads without row locks, and claims the archive writer block.
One transaction persists the building generation, all ten future reservations, every attachment
source pin intent and the request binding. Only confirmed COMMIT may issue a private capability.
An existing request returns its existing generation without a new capability. No same-generation
reclaim, resume, heartbeat or HTTP caller is added by this slice.

The capability separately binds the actual sheet block tuple and the generation build owner tuple.
The block's returned fence is never replaced by generation fence `1`. Existing observed operation
and section heads are separate from the future reservation vector; neither is a current-row hash.
All scope rows must be live and match sheet/base/workspace. Purged or purge-claimed attachments
refuse. Attachment pin metadata uses explicit byte/time budgets and SQL withholding before transfer.
Pin intents are not immutable blob verification.

The native pool must declare a positive connection timeout no larger than the supplied deadline.
Acquisition, queries, COMMIT, timeout restoration and capability freezing share that deadline.
Source-free session timeout configuration happens before BEGIN; subsequent business statements
receive the remaining server timeout, so a blocked backend also exits after socket destruction.
Failure destroys/removes the owned connection; late continuations and retained authorizer queries
cannot issue SQL after release. An ambiguous COMMIT is not retried or reported as rollback.
The database retains an identifiable committed claim if COMMIT happened without a confirmed reply.

## Future coverage contract

Owned claims use one PostgreSQL clock value obtained after the canonical fence. It supplies the
generation and all reservation `created_at` values and the exact block/generation/pin lease.
Existing legacy reservation/consume SQL and global writer refusal remain unchanged. The owned
insertion is checked by the existing bootstrap/checkpoint reservation-plan validator.

For subsequent owned-only finalize, section revision IDs will equal the corresponding reserved
operation IDs. Revision/section operation timestamps will come directly from section reservation
timestamps; membership/parent timestamps will come from the parent reservation. PostgreSQL precision
must be retained with INSERT SELECT, while canonical coverage uses the existing UTC millisecond SQL
format. PK collisions and exact timestamp/row mismatches refuse the whole finalize. This slice
persists the identities/timestamps; predicted coverage, consumption and finalize remain OPEN.

## Gates

| Gate | Required evidence | State |
| --- | --- | --- |
| Commit authority | Pre-COMMIT invisibility, complete post-COMMIT visibility, deferred failure and lost reply issue no capability | LOCAL PASS |
| Ordering | Real fence wait observes the writer's new head; RR-before-fence mutation reds | LOCAL PASS |
| Identity | Distinct fences; scope/auth/key/request refusal; replay has no capability; clone/forge refused | LOCAL PASS |
| Pin intents | Empty/multiple complete sets, purge refusal, SQL byte withholding and cumulative budget | LOCAL PASS |
| Native lifetime | Explicit finite acquisition, deadline/discard, no late SQL or premature COMMIT success | LOCAL PASS |
| Regression | Existing writer refusal/manual behavior, whole real-DB registration, focused neighbors | LOCAL PASS |
| Exact-source CI execution | Whole new DB file plus neighbors from the published claim SHA, terminal raw log and checkout binding | OPEN |
| Complete D-H2 | Same fresh RR exact owner/reservation/pin capture, out-of-TX objects/crypto, owned finalize/abandonment | OPEN |

There is no migration, new flag, role grant, provider/KMS operation, nonce/seal, archive publication or
prune in this increment. Writer/deleter closure, full D-H2/D-L/D7, D1 owner ratification, merge and
staging remain separate OPEN gates. Retained local key stores remain preserved.
