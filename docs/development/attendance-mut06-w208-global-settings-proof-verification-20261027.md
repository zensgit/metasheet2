# MUT06 W2-08 global settings read verification — 2026-10-27

Refs #4556. Draft/HOLD; no runtime or configuration change.

The existing registered W2 integration file now contains seven additional parameter cases. They use the production plugin work-date resolver, native PostgreSQL calls, two synthetic organizations, a decoy configuration key, exact read SQL/bind assertions, and actual published shift identities. All fixture writes and resolver reads share a physical transaction; rollback restores the prior global settings row.

| Evidence | Actual result |
|---|---|
| First native phase | New 7 cases plus 1 existing org-scope neighbor passed; 10 other cases excluded |
| Wrong-key mutation | 1 matching failure; 17 excluded |
| Normalization bypass | 2 matching failures, array-source rejection control passed; 15 excluded |
| Review cleanup fix | Snapshot uses Pool.query before explicit checkout; one affected case passed, 17 excluded |
| Quality | validate:all exit 0 before final test-only cleanup change; production inputs unchanged |
| Explicit file lint | Baseline/current retain the same 11 existing diagnostics; introduced zero; not a clean whole-file lint claim |
| Database lifecycle | Isolated UTF8 database, same 452 migration ledger; no migration replay; owned cluster stopped and data retained |

Mutations were restored byte-for-byte. Original W2 file remains an exact prefix. The final cleanup change does not alter resolver calls, fixtures, assertions or budgets; six earlier cases are source-applicable evidence, not a claim of a fresh seven-case final run. The current PR's whole W2 file must actually execute all 18 cases before CI closeout.

Commands (from core-backend, with the isolated database configured):

- `vitest --config vitest.integration.config.ts run tests/integration/attendance-work-date-resolver-w2.db.test.ts -t 'MUT06 W2-08|loads org-scoped published candidates only'`
- Targeted mutation selectors: `camel case and fractional floor`; `camel case and fractional floor|snake case alias|invalid source array rejects`.
- Final affected selector: `camel case and fractional floor`.
- Root quality: `pnpm validate:all`.

This is direct resolver/DB evidence, not HTTP authentication proof. A deployment-global settings read does not become a tenant-scoped query merely because the caller supplies an organization. The existing settings writer still authorizes the actor organization and writes one global key; its single-tenant/per-customer enablement restriction remains unchanged. Writer authority, the active-current caller, the complete MUT06 query denominator and owner acceptance remain open. No merge, deployment, feature enablement, live-provider verification or production acceptance is claimed.
