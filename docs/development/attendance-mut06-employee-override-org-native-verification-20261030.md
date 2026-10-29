# MUT06 employee override organization read: native verification

This adds one real-PostgreSQL regression to the existing timezone policy-store integration file. An active employee legally belongs to two organizations, with exactly one eligible override in the second organization. The second organization's full source frame must be returned first; reading the first organization must then return null.

Production source already contains the correct organization predicate. This is a discriminating coverage addition, not an observed production leak or runtime repair.

## Scope and fixture

The existing isolated D1 schema and actual timezone-policy migration are reused. The case reads back the validated users foreign key and enabled member trigger before creating a legal active dual-organization subject and one valid override. It does not alter schema, triggers, constraints or policies. This is the existing minimal native fixture, not the full production migration stack.

All setup, native store reads and snapshots use one real PoolClient inside BEGIN/ROLLBACK. The original nineteen expanded cases and helpers remain byte-identical after removing the added case and necessary createHash import. The selected case captures four completed real queries in order: member/override for the positive organization, then member/override for the organization with no override. Full users, memberships, overrides, policies and audit snapshots remain unchanged across those reads. Fixture inserts are rolled back.

## Actual selected execution

- Unchanged production source: **1 passed /19 filtered**, from actual assertion leaf statuses. Both active-member checks reach the real override query; result-row counts are 1/1/1/0.
- Neutralize only the employee-read organization comparison while retaining all three placeholders and bindings: **1 matching failed leaf /19 filtered**. The exact positive source frame still passes; result-row counts become 1/1/1/1, and the sole new null assertion fails.
- These are **one distinct new case, one positive execution, one fault execution and one source-fault kind**. Filtered old cases are not passes. No unchanged green suite, restored-green phase, composition suite or whole-file twenty-case run was repeated locally.
- Runtime restored exactly to SHA256 `c212912cecbbbddb78a6683771a914e10dfb96f39ed493812f43d6cfc60e3b94`. One owned PostgreSQL start, stop exit0, port closed and owned data retained.

The controller retained a reporting failure after the intended red: it expected matcher spelling `toBeNull` in Vitest's JSON message, which instead contains `to be null`. The selected failed leaf, sole new null oracle and actual SQL receipts were qualified directly from the saved report without changing assertions or rerunning tests. An initial read-only summarizer's missing Path alias was corrected before writing its proof; that harness history is retained separately.

Actual execution audit SHA256: `75080c388ee3b2028fc544c726e64824bf160e9ec132cb5748b90cc6940bbe1d`. Qualified final-state SHA256: `0274f981cb03c92b9de775ce2d340b8539527f646ca9c95a091b37725b77968b`.

## Quality and gates

Explicit baseline/current lint retains one existing project-inclusion diagnostic (1/1); AST lint is0/0. Virtual-source type comparison uses the same logical filename and project compiler options, with target1/1 and transitive1/1 diagnostics, introduced0. Candidate source was never overwritten for baseline quality checks. These are qualified comparisons, not whole-workspace lint/typecheck/validate-all zero claims.

The existing filename and CI registration are unchanged. Current-head unfiltered whole-file twenty-case CI evidence must be collected after publication; local 1/19 cannot substitute for it.

| Existing contract gate | Evidence | Limit |
| --- | --- | --- |
| Advanced attendance §7.4/MUT06 organization facet | Legal dual-org positive/absence oracle, actual four-query receipts and matching predicate fault | Direct store read path only |
| Preserve guards and source | Original19 bodies/helpers retained; runtime, migrations, config, workflows, dependencies, flags and budgets unchanged | No parent-denominator or source-newness waiver |
| Delivery | Draft/HOLD, external writes OFF | No Ready, merge, deploy, R71 change, target install/migration or provider/live write |

HTTP/JWT, actual management authorization, loader/full-worker admission, full production schema, Redis/live acceptance and whole MUT06 completion are not established by this case. Global construction52 and semantic/org/newness93 remain held pending their exact parent dispositions.

With an owned synthetic database supplied securely through ATTENDANCE_TEST_DATABASE_URL, the selected command is:

```sh
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-timezone-policy-store.db.test.ts --watch=false --cache=false --testNamePattern='MUT06_EMPLOYEE_OVERRIDE_ORG_NATIVE:'
```

Stream/lifecycle/externalwrites remain OFF; real UAT50004 excluded; historical08PUT INCONCLUSIVE. No customer data or provider sends.

Independent source/execution review: **0 confirmed findings, 0 necessary corrections**; review SHA256 `0986c06cc35d2ebf5b3392335a85a148cd43cee18512d8583cd57cebd6dae09d`. Main independently rebound source/receipts/restoration and retained both harness histories without suite reruns.
