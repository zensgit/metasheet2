# Requester revoke verification — 2026-10-27

This is controlled synthetic functional evidence on the owned isolated PostgreSQL16 UTF8 clone. Canonical source and live demo were untouched. The existing458-migration ledger and protected constraint definitions were retained; migrations were not replayed. Every owned PG start was stopped in finally with PID checks and retained data.

## Actual phases

1. Original runtime: RW_SELF failed with403 Insufficient permissions; RW_OTHER_ACTIONS passed all8 denial arms. One failed/one passed/9excluded, not11passes.
2. Initial fix: whole native file11actual passes/0skip (sentinel1 + original4 + new6). Added act-only and nonliteral cases later passed2/11excluded.
3. Eight isolated faults: broaden all actions; remove org/user/active membership predicates individually; omit server marker; remove requester identity; accept read as write; coerce action. Nine matching failures total because identity has2 negatives; each group has one actual RW_SELF control. Source restored exactly between groups. Selected restoration2passed/11excluded. Neighbor approval-product-service unit190passed.
4. Initial type-check failed on the added org_id access missing from the old row type. Fix: local SELECT-star generic intersection only, preserving SQL/runtime. Not called a green quality run.
5. Independent review P2: foreign writer and lost-org requester with fieldWrites:{} received400 with current-node details before identity checks. Both actually red; normal revoke and authorized-owner invalid-rider controls passed (2red/2pass/12excluded). No unauthorized revoke was demonstrated.
6. Final relocation: marked-revoke identity/membership executes after inherited attendance exclusion, before instance-derived errors. Eight affected cases passed/8excluded, including both exact403/no-details refusals, normal revoke, non-requester/admin denial, act-only compatibility and original legitimate-owner400 refusal. Final backend type-check and production validate:all both actually exited0. Unmarked service callers keep their old path; the190-unit green is retained by this marked-only scope, not claimed rerun.
7. Same-path/config stdin eslint with explicit no-ignore and project:null compared original/current source. Existing diagnostics are retained, introduced0. Original four it-call text/budgets are byte-identical by TypeScript AST; current source declares16calls (sentinel1 + original4 + new11).

The initial whole11, later2 and final affected8 are separate phases. Do not call their sum a unique count or a fresh final whole16. The final dedicated CI lane must execute all16 with zero skip.

## Reproduction commands

Using the pinned owned wrapper (Node20.20.2/pnpm9.15.9):

- `pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/approval-revoke-terminal-guard.db.test.ts` with EXPECT_DB=1 and the owned cloned DB; later runs use the exact named affected filters recorded in receipts.
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-product-service.test.ts`.
- `pnpm --filter @metasheet/core-backend type-check` and `pnpm validate:all`.
- Explicit same-path/config no-ignore eslint via stdin, original HEAD source versus current.

Raw proof files: `requester-revoke-baseline-red-state.json`, `requester-revoke-positive-state.json`, `requester-revoke-mutations-quality-state.json`, `requester-revoke-p2-authorization-state.json`, `final-explicit-lint-and-ast-state.json`, `main-independent-local-final-audit.json`. Original harness label claiming no runtime change in the positive run is explicitly corrected in `positive-state-label-disposition.json`; the raw proof is preserved.

Real DB users, sessions, active memberships and effective permissions are asserted through authentication and /auth/me, with user-role/empty-permission token claims. Scoped AuthService token trust is disabled around requests; the RBAC module's import-time trust remains inherited, but the empty claims convey no grants. No req.user/RBAC mocks, constraint bypass, provider calls or real personnel are used.

Negative snapshots cover the complete instance, assignment and record rows. This does not fingerprint every outbox table, certify all graphs/authorization configurations or establish linearizable concurrent membership removal. No frontend change, blanket act grant, live directory/template/permission/config change, secret-value inspection or deployment. Draft/HOLD and all parent exclusions remain.
