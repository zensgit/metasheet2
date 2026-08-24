# role-cascade witness — schema-resolution false ABSENT (reproduction record)

Date: 2026-08-24 · Reproduced by: independent re-run, not relayed
Subject: `scripts/ops/multitable-role-cascade-witness.mjs` + `scripts/ops/multitable-l1-battery.mjs` on
`origin/main` `c345c6b405` (witness merged by #5131, merge commit `771cd9be20`)

## Verdict

**CONFIRMED.** The shipped witness prints `CASCADE ABSENT (premise CONFIRMED)` with exit 0 against a
database whose `roles:delete` cascade into a recovery-authority-triggered child is LIVE.

## Preconditions — weaker than the originating report claimed

The originating report constructed it with an explicitly set `search_path = shadow, live, public`.
It also fires under the **stock default** `search_path` (`"$user", public`), with no `SET`, no DSN
`options=`, and no `ALTER ROLE`: it is enough that the connecting role owns a schema named after
itself containing a table named `roles`.

## Fixture (PG 15.15-alpine)

Database `realistic`, owner `metasheet`, connected as `metasheet`:

- `public.roles`, `public.user_roles.role_id -> public.roles(id) ON DELETE CASCADE`
- `trg_user_roles_recovery_authority_lock` on `public.user_roles`, function
  `public.metasheet_recovery_authority_user_trigger` (member of `AUTHORITY_TRIGGER_FUNCTIONS`)
- the accident: `CREATE SCHEMA metasheet; CREATE TABLE metasheet.roles (id uuid PRIMARY KEY);`
  `SHOW search_path` -> `"$user", public` (untouched)

## Observed, via the shipped `buildProbeSource()` probe

Before the accident (honest resolution):

    PRESENCE {"roles":1,"recovery_authority_relations":1,"roles_referencing_fks":1}
    ROWS [{"child_schema":"public","child_table":"user_roles",
           "conname":"user_roles_role_id_fkey","confdeltype":"c"}]

After the accident, same database, same role, same DSN:

    PRESENCE {"roles":1,"recovery_authority_relations":1,"roles_referencing_fks":0}
    ROWS []

Fed to the shipped `parseWitnessObservation` -> `classifyObservation` -> `renderSummary`:

    verdict   ABSENT
    premise   CONFIRMED
    headline  CASCADE ABSENT (premise CONFIRMED)
    exitCode  0
    reason    no_cascading_fk
    target    production

## Why the positive control does not catch it

Both gated counters are satisfied by the wrong pair of relations:

- `roles_relations = 1` is satisfied by the DECOY (`to_regclass('roles')` resolves to
  `metasheet.roles`) — the control resolves the relation the SAME way the query does, so it fails
  for the SAME reason. It is a coupled control, not an independent one.
- `recovery_authority_relations = 1` is satisfied by the REAL child (`public.user_roles`), counted
  globally with no binding to the resolved `roles`.

The one payload field that does move — `roles_referencing_fks`, 1 -> 0 — is documented as
"AUDIT-ONLY and decides nothing" and never reaches the decision path.

## Why the existing docblock and golden do not cover it

`multitable-l1-battery.mjs:425-431` states: "a decoy `roles` in a schema **that is not on the path**
can neither be mistaken for the real one nor hide it." True, and scoped exactly to the case it
names. The on-path case is not addressed, and the golden covers only the off-path case.

## Required properties of any fix

1. Determine the target relation independently of the coupled resolution, and return
   **INDETERMINATE** — never ABSENT — when it cannot be uniquely determined.
2. Do not hard-code `public.`: the repo's real-DB goldens run in per-run random schemas.
3. Publish which relation the verdict decided on, so a verdict is auditable after the fact.
4. Add a real-DB negative golden for "live and decoy both on the path, decoy first", and a mutation
   that deletes the ambiguity gate must red it.

## Operational status at time of writing

`gh run list --workflow=multitable-role-cascade-witness.yml` returns **zero runs**: the witness has
never been dispatched against any target. No ABSENT verdict is in circulation and nothing needs
retracting. The fix can land before first dispatch.

## Fix, and what each door is for

Landed in the same PR as this record.

- **The query binds canonically.** `buildRoleCascadeWitnessQuery(schema)` binds
  `to_regclass('<schema>.roles')`. Production passes `EXPECTED_AUTHORITY_SCHEMA`, DERIVED from the
  containment census's own `EXPECTED_AUTHORITY_TRIGGERS` (all nine `schemaName: 'public'`) rather
  than retyped, and refusing rather than picking if that set ever spans two schemas. The real-DB
  goldens pass the per-run random schema they just created, so nothing is hard-coded.
  **This is what converges**: every shadow vector is answered without being enumerated.
- **Four doors, each with its own reason, none of which may read as ABSENT.**
  1. `canonical_relation_absent` — no ordinary `<canonical>.roles` at all.
  2. `binding_mismatch` — the session's own `roles` resolves elsewhere. Measured: with this door
     disabled the one-wrong-schema case returns PRESENT, not a false ABSENT, because the query was
     still bound correctly. The door earns its place as REFUSAL — an environment whose own view
     disagrees with the canonical binding should yield no verdict at all — not as correction.
  3. `relation_ambiguous` — more or fewer than one `roles` visible on the search_path. DIAGNOSTIC
     only: a session looking at exactly ONE wrong schema satisfies it, which is why counting
     candidates was insufficient on its own and must never be traded against door 2.
  4. `relations_absent` — no canonical-schema relation carries a recovery-authority trigger. The
     carrier count is now SCOPED to the canonical schema; counting globally is what let the old
     control stay satisfied by a real child while the resolved `roles` sat elsewhere.
- **The summary names what it bound to.** The line that lied read
  `relation presence (positive control): roles=1, recovery_authority_relations=1`. It now reports
  the canonical relation, the session's resolution, and the visible count.
- **`roles_referencing_fks` stays audit-only** and still decides nothing.

## Verification

Every lane that can exercise this code, armed, against PG 15.15-alpine — `0 skipped` throughout,
because a skipped golden is not a green one:

| lane | arming | result |
| --- | --- | --- |
| `multitable-role-cascade-witness.test.mjs` | `ROLE_CASCADE_WITNESS_DB_GOLDENS=1` | 64/64, 0 skipped |
| `multitable-l1-battery.test.mjs` (contract) | — | 63/63 |
| `multitable-l1-battery-workflow.test.mjs` | `L1_BATTERY_DOCKER_GOLDENS=1` | 42/42, 0 skipped |
| `create-l1-battery-admin-on-staging.test.mjs` | `L1_ADMIN_DOCKER_GOLDENS=1` | 29/29, 0 skipped |
| `multitable-recovery-schema-containment.test.mjs` | — | 19/19 |

`evidence.posture.role_delete_cascade_present` and `…role_delete_triggered_children` are unchanged;
`…role_delete_binding` is ADDED alongside them, so no consumer of the posture object loses a field.

Five new real-DB negative goldens, each of which returned a false ABSENT before the fix:
`"$user"`-shaped decoy in front of canonical; one-wrong-schema-only (visible count is exactly 1, so
the ambiguity door is open and only door 2 catches it); canonical-first with a second visible
`roles`; a `pg_temp` `roles`; and a trigger carrier in another schema feeding the positive control.

Mutations, each reverted in isolation and the file restored byte-identical
(`multitable-l1-battery.mjs` sha256 `84ee1fc23f9ff6e3…`):

| mutation | reds | stays green |
| --- | --- | --- |
| door 2 (canonical OID equality) neutered | `$user`, one-wrong-schema, `pg_temp` | ambiguity, door-4 |
| door 3 (visible-count) neutered | ambiguity | door-2 goldens, door-4 |
| query binding reverted to bare `to_regclass('roles')` | the three door-2 goldens + the static binding pin | — |
| carrier control unscoped to a global count | door-4 golden | all others |

Two pinned tests had their invariant **inverted, not widened** — one in each test file — because the
invariant they pinned (that both queries session-resolve `roles`, and that neither hard-codes a
schema) WAS the defect. Widening would have left the old assertions standing and both shapes green.


## Second review round — two more holes, both confirmed on PG 15

### The positive control could be fed by an IMPOSTOR carrier

Scoping the carrier count to the canonical schema constrained the carrier table's schema and the
trigger function's NAME — but not the function's SCHEMA, nor the trigger's identity. Constructed:

- `canon.roles`, `canon.user_roles` with a live CASCADE and no trigger
- `canon.decoy_carrier` carrying a trigger that calls `evil.metasheet_recovery_authority_user_trigger`

All four doors opened, `ROWS []`, **ABSENT / exit 0** — on a catalog whose recovery-authority surface
is not the canonical one at all. The verdict happens to be defensible for that fixture; what is not
defensible is the control, whose entire job is to establish that this database can answer the
question. A database whose real triggers had been dropped and replaced would have read as CONFIRMED.

**Fix**: `canonical_exact_carriers` counts how many of the census's EXACT identities are present —
carrier schema + table, trigger name, and function schema + name — derived from
`EXPECTED_AUTHORITY_TRIGGERS` and rebased onto the bound schema. One exact match is enough; "is all
of it intact" is the battery's Phase-0 `triggerCoverage`, which the witness deliberately does not
re-implement. Door 4 now decides on this. The loose count stays as audit-only.

**The witness query stays wide.** Narrowing it to the census's table list would be the enumeration
trap: stale the first time the migration covers one more table, silently. A test pins that it never
grows the exact-identity tuple list.

Re-run of the reviewer's own fixture against the fixed head: **INDETERMINATE / exit 2 /
`relations_absent`**.

### The four doors were source-text guarded, not behaviour guarded

Replacing the battery's `if (bindingRow.session_binds_canonical !== true)` with `if (false)` left its
contract suite green at **63/63**. The tests scanned the source for the failure strings.

**Fix**: the doors moved into one exported pure function, `classifyRoleCascadeBinding`, shared by the
battery's preflight and the witness's classifier — each mapping a door to its own vocabulary. The
battery's preflight is now a single delegation with no inline conditions, and a negative pin fails if
one reappears. The doors are tested with real inputs, including order-of-doors and fail-closed-on-junk.

Re-run of that same mutation against the fixed head: battery **64/65**, witness **46/49** — reds.
Each of the four doors, neutered alone, now reds both suites.

### Mutation results, round two

| mutation | reds |
| --- | --- |
| any one of the four doors neutered in the shared classifier | battery + witness |
| function SCHEMA unconstrained in the exact-carrier control | impostor-function golden + static pin |
| trigger NAME unconstrained | renamed-trigger golden + static pin |

The trigger-name conjunct initially survived its mutation at 66/66 — asserted in source, exercised by
nothing. A golden was added for it rather than the claim being kept. An unexercised conjunct is a
claim, not a check.

### Comment drift

Live comments still described the removed binding as the contract. The worst was the battery
contract suite's own failure message, which told whoever red it that the query "must resolve through
the session search_path" — it would have walked the next maintainer straight back into the defect.
Corrected at six sites, and the presence-control docblock rewritten rather than patched.

## Final state

| lane | arming | result |
| --- | --- | --- |
| `multitable-role-cascade-witness.test.mjs` | `ROLE_CASCADE_WITNESS_DB_GOLDENS=1` | 67/67, 0 skipped |
| `multitable-l1-battery.test.mjs` | — | 65/65 |
| `multitable-l1-battery-workflow.test.mjs` | `L1_BATTERY_DOCKER_GOLDENS=1` | 42/42, 0 skipped |
| `create-l1-battery-admin-on-staging.test.mjs` | `L1_ADMIN_DOCKER_GOLDENS=1` | 29/29, 0 skipped |
| `multitable-recovery-schema-containment.test.mjs` | — | 19/19 |
| `integration-guard-required-wiring-contract.test.mjs` | — | 62/62 |
