# W7-R6 frozen-prior verification — 2026-10-27

Base: 5b9ec081bba822c6c4f4668552c274ecc906a7e4. Refs #4556 W7-R6. Draft/HOLD.

## Reproduction and minimal change

Three independently namespaced real group-authoritative HTTP punch calculations were frozen. Ordinary SQL changed W1 membership, group policy, or FSER schedule facts. Actual HTTP frozen_prior recompute returned200 and appended completed calculations with identical five snapshots and source-definition fingerprint, but a different semantic-input fingerprint in all three cases.

The authoritative producer includes mergePolicy=append in its semantic hash. Recompute unconditionally substituted merge. The correction reads the persisted prior merge_policy and uses it in both the frozen-prior hash and inserted metadata. current_policy retains merge. It does not copy fingerprints, rewrite historical rows, change hash schema, enable calculators, or decide current-policy semantics.

## Gate table

| Gate | Actual result |
| --- | --- |
| Initial fixture prerequisite | First run: existing T-M5 passed1; new3 refused403 because the synthetic users had no stored attendance-admin authority. Fixed only new fixtures; this is not runtime red evidence. |
| Product red | With stored permission, all3 actual HTTP cases failed semantic fingerprint equality. Seven unrelated cases filtered, not passes. |
| Corrected behavior | New3 passed; one affected manual-override plus current-policy overlay neighbor passed,12 filtered. |
| Read-trace discrimination | For each family, inject one native SELECT FROM ONLY at its recompute seam under its synthetic prefix: exactly1 matching failure,2 passing controls,7 excluded. All three mutations restored exact runtime bytes. |
| Final strengthened gate | Conservative identifier detector catches ONLY, schema qualification, comma joins and subqueries for the bounded W7 relation set. Final new3 passed,7 excluded. Native record-read and calculation-append positive controls observed. |
| Snapshot/provenance | Five PostgreSQL text snapshots, source and semantic fingerprints, persisted merge policy equal; original whole calculation reread byte-equal. New identity/version and recompute provenance remain distinct. |
| Preservation | All9 original test/hook calls remain byte-identical by TypeScript AST extraction; original budgets and existing cleanup untouched. |
| Quality | Focused lint exit0 with1 unchanged existing any warning; pnpm validate:all exit0. |
| Independent review | Source review accepted runtime delta. ONLY-gap fixed and proven by mutations; immutable fixture retention documented without disabling triggers. |
| CI registration | Existing whole-file plugin-tests attendance lane and strict wiring corpus retain registration. Exact-head remote CI remains pending publication. |

Commands: targeted Vitest integration config on attendance-w7-1b-cutover-e2e.db.test.ts with -t W7-R6; one neighbor from attendance-w4c3c-manual-recompute-retirement.db.test.ts with -t 'manual override freezes snapshot'. Mutation runs use the same three-case filter. Do not count excluded tests or repeated controls as additional unique coverage.

Native PostgreSQL was isolated UTF8 with a452-entry migration ledger, cloned from a clean template with identical migration-source tree. Migrations were not replayed. Every controller stopped only its own unchanged postmaster and retained its data. New random synthetic fixtures remain intact in the disposable database because calculation history is append-only; no row-cleanup success is claimed.

No merge/deployment/R71/tag/release/config changes. Stream/lifecycle/external writes OFF. Real UAT and business50004 excluded; historical08PUT inconclusive. This finite recompute gate does not close owner acceptance, stored detail/trace presentation, current-policy decisions, MUT06, EP01, or full product/production acceptance.
