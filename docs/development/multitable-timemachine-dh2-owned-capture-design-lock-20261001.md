# Time Machine D-H2 owned capture

Status: development, default-OFF. Authoritative parent: the D-H2 and D-I0 gates in
`multitable-timemachine-phase-d1-durable-archive-design-lock-20260826.md`.
Baseline: `a68c2fd44538bc3ea3097f395b153b361baa3b0a`.

## Required result

Claim commits the exact archive block, generation, future identities and source pin intents in a
short fence-first READ COMMITTED transaction. Only after that commit may a different REPEATABLE
READ transaction capture all seven relational sections and attachment descriptors. Capture must
hold no advisory fence and perform no attachment, provider or KMS IO. Successful detached capture
does not authorize prune, encryption, publication or recovery.

The first implementation step replaces unbounded `jsonb_agg` capture with bounded row reads inside
one RR transaction. A trusted caller must supply positive integral byte and elapsed-time limits;
there is no invented default retention, lease or capture budget. PostgreSQL suppresses a row's
payload before transfer when it exceeds the remaining byte budget. Query timeout uses the remaining
elapsed-time budget. Canonical admission and attachment-reference validation retain the existing
closed shapes. The byte budget measures serialized database payloads, not process RSS.

The connection-owning metadata executor enforces a deadline through acquisition, BEGIN, source
reads, timeout restoration and confirmed COMMIT. On deadline or failure it poisons the private SQL
wrapper and destroys/removes the acquired client; losing continuations cannot issue later SQL or
return a busy connection to the pool. A late acquisition is discarded before BEGIN. Native
`connectionTimeoutMillis` must be explicitly positive and no larger than the capture budget,
bounding pool queue entries and handshakes before a client is acquired. Shared pool options are
never changed. The native acquisition resource boundary is this declared timeout; public capture
success also requires completion inside the overall deadline. No transport default is invented.

This reader is an internal prerequisite. It must not replace the manual HTTP path until committed
claim authority, exact generation/block/pin/reservation rechecks and owner-aware downstream
nonce/finalize/cleanup compose into the complete protocol. Existing one-statement manual capture
remains unchanged during this step. A reader alone does not prove fresh-after-claim ordering.

## Gates

| Gate | Required evidence | Initial status |
| --- | --- | --- |
| Bounded source | Populated and empty scope; parity with existing canonical projection; all seven sections and attachment metadata | LOCAL PASS 2026-10-07 |
| Transaction | RR required, stable xid, no advisory fence; same snapshot across concurrent writer commit | LOCAL PASS 2026-10-07 |
| Budgets | Oversized individual row withheld by SQL; cumulative byte limit; elapsed-time limit; values-free refusal | LOCAL PASS 2026-10-07 |
| Regression | Existing relational source and writer-block neighboring tests; whole-file real-DB CI registration | LOCAL PASS; CI registered, execution OPEN |
| Committed claim | RC fence first, exact persisted generation/reservations/pins, capability minted after commit, separate fresh RR | OPEN |
| Ownership | Actor/scope/key/source/lease/ABA mismatches; stale cleanup cannot release a successor; crash remains identifiable | OPEN |
| Full composition | Future coverage identities, nonce reservation, out-of-transaction crypto, owner-aware finalize and cleanup | OPEN |

No migration, new feature flag, HTTP route, provider adapter or KMS activation is authorized by this
slice. Full D-H2, D-L and D7 acceptance and owner staging/merge gates remain OPEN.
