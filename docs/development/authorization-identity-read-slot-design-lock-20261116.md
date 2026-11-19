# Authorization identity-read slot (P2a)

## Scope

Only self-built `CONSUME_CLASS_DECISION` may supply an own optional `identityRead`.
Its closed shape is `{ sourceIntegrationIds: readonly string[] }`, nonempty and
dense, with canonical hyphenated UUID spellings. Uppercase is accepted and
normalized to lowercase before deduplication and code-unit sorting. No UUID
version or variant restriction applies. Other intents and takeover reject the
field before any SQL, including explicit undefined. Absence preserves legacy
behavior, including missing-user behavior.

The new slot, source list and list elements use own data descriptors, never
accessor values. A closed source list has only its own length and dense index
keys: symbol/non-index extension keys and custom inherited properties are
refused. Standard Array.prototype (or no prototype) is accepted. Reflection
failures in this new slot map to the fixed values-free plan-invalid error with
no original cause; legacy generic field access is not changed by this rule.

The shared pure normalizer is used by both the entry and the optional third
argument of `discoverPrivilegeRolePlan`. The factory deep-freezes its normalized
slot on the original lockPlan. WeakSet registration and exact object identity
remain mandatory. Revalidation returns void and checks roles, not identity.

## Lock and failure contract

Order: RC pin, existing timeout window, R0 shared (respecting shared try), optional
R1, single-key shared `hashtext('directory:identity-maintenance')` R2, canonical
sorted exclusive R2F through `acquireSourceSyncFreezeLock`, role share, sorted
admission locks, sorted user mutexes. No lower-rank supplementation or new hook.

Missing role/user/source rejects before afterAcquire and work. Only the new
branch rejects missing users at entry. After R5, a single nonlocking source-ID
SELECT checks existence. It does not stabilize configuration, prevent ABA or
prove identity/source relationships against nonparticipating writers.

Held identity/source state records successful acquisitions privately and
immutably, independently of mutable raw plans. `requireIdentityRead` requires
the real receiver token, open state and its actual connection, then exact
canonical set equality. Borrowed methods, copies, other transactions, closed
tokens and tokens without the slot cannot attest held identity locks. The
highest acquired rank derives from successful acquisition state for this branch.

Timeouts restore before minting. Logical/non-SQL failures restore while usable;
failed SQL or a heard connection loss does not issue restore SQL. Restore
failure also prevents callbacks. The transaction runner rolls back and the
borrow listener is removed in finally. Test runners do not prove real rollback.

## Verification gates

| Gate | Required evidence |
| --- | --- |
| Unit | Legacy whole files; shape/UUID/ordering/held/receiver/cleanup negatives |
| Composition | Frozen original plan, brand/equality, role drift and empty-role baseline |
| Static boundary | Exact imports; no production slot caller or acquisition bypass |
| Real PG | Multiple connections, observed blockers, releases, timeouts and rollback |
| Discriminating mutation | Independent main reviewer, one change from a passing baseline |
| Delivery | Source pins, preservation checks, unrun gates explicitly recorded |

The serialization test remains in the existing whole-file EXPECT_DB lane and
excluded from the default no-DB lane. Existing cases and wiring remain unioned.
Real-PG execution and discriminating mutations are delegated to the main
reviewer; author-side syntax checks do not satisfy those gates.

No production caller, schema, migration, flag, converted-writer change, external
IO or legacy business-writer adaptation belongs to this slice. This is not full
B2, writer closure, production proof or business acceptance.
