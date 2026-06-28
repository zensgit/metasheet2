# RA-1b curated-vocabulary enforcement — development & verification (2026-06-27)

> Follow-up to #3309 (RA-1b `requester.role` grammar + fresh `user_roles` provenance, on `main`). Closes the **open** P1: the ratified **D-role-vocabulary** ("approval-curated subset of RBAC roles") was decided but **not enforced** — an author could route `requester.role in ["admin"]` on a system role. Branch `claude/approval-ra1b-curated-vocab-20260627`. Design lock: `docs/design/approval-requester-role-ra1b-design-lock-20260627.md` (status → RUNTIME SHIPPED + CURATED-VOCABULARY ENFORCED).

## 1. Problem
The shipped `requester.role in [...]` runtime exposed **every** RBAC role: the resolver froze all `user_roles`, the author picker listed all roles, and publish did **zero** literal validation. An author could therefore route on `admin`/system roles — contradicting the owner decision *"do not expose system/admin roles to approval-formula authors."*

## 2. Design (owner-corrected — the SHARP boundary correction)
- **Curated source** — new `roles.approval_usable boolean NOT NULL DEFAULT false` (secure-by-default; every role, incl. admin, excluded until an admin opts it in).
- **PUBLISH is the hard gate** — `requester.role in [uncurated literal]` is rejected at graph-validation (`APPROVAL_REQUESTER_ROLE_NOT_CURATED`, 400), **independent of any picker**. An author-side picker may filter, but must not be the only gate.
- **DRY-RUN shares the same check** — no "preview-passes / publish-fails" divergence.
- **Boundary precision (owner P1)** — do **NOT** narrow the shared `listDirectoryRoles` picker: it also serves **`static_role` approver selection** (`useApprovalDirectory.loadRoles()`). Curation scopes **only** the formula `requester.role`, not static-role assignee nodes. → a **dedicated** `formula-roles` endpoint returns curated-only; `static_role` keeps the full catalog.
- **Curated-freeze** — the resolver returns only the requester's curated roles, so system roles never enter `requester_snapshot.directoryRoles`.
- **Genuine-empty → DEFAULT** — `role` is a routing *predicate*, not a *key*: a requester with zero curated roles routes to the condition's default edge (membership = false), **not** a 422 reject; only a transient `user_roles` read failure → 503. (Department/title remain routing keys and keep reject-on-absence.)

## 3. Implementation
- **Migration** `zzzz20260627150000_add_approval_usable_to_roles.ts` — `roles.approval_usable boolean NOT NULL DEFAULT false`; idempotent (`checkTableExists` + `checkColumnExists`), reversible `down`.
- **Curated source** (`approval-directory.ts`) — `fetchCuratedApprovalRoleIds(queryFn?)` = `SELECT id FROM roles WHERE approval_usable = true` (trim/blank-strip → `Set`). Accepts a transaction-scoped query fn (publish) or defaults to the pooled `query` (dry-run).
- **Literal extraction** (`ApprovalConditionFormula.ts`) — `extractRequesterRoleLiterals(expression)` parses to the AST and walks `membership`/`unary`/`binary`/`compare` nodes, collecting the unique role-id literals of every `requester.role in [...]` (incl. nested in AND/OR/NOT). `[]` on parse error / non-role formulas. *(There is no `paren`/`group` AST node — parens flatten during parsing; `aggregate` is a leaf — so no membership-containing node is unreachable: the walk cannot be bypassed by parenthesising or nesting.)*
- **Publish hard gate** (`ApprovalProductService.publishTemplate` → `validateApprovalConditionFormulasAgainstFormSchema`) — accepts an optional `curatedRoleIds: ReadonlySet<string> | null`; fetched **once per publish** on the transaction client, and only when `runtimeGraphUsesRequesterAttribute(graph, 'role')`. For each condition branch, any `extractRequesterRoleLiterals` literal **not** in the curated set throws `ServiceError(400, 'APPROVAL_REQUESTER_ROLE_NOT_CURATED')` — placed **outside** the schema-validation try/catch so the 400 is not re-wrapped as a 500 graph-invalid. `createTemplate`/`updateTemplate` pass `null` (drafts are not the gate).
- **Dry-run** (`routes/approvals.ts`) — runs the identical curated check before evaluation; uncurated literal → `success:false / APPROVAL_REQUESTER_ROLE_NOT_CURATED`. Skips the DB read entirely when the formula has no role literals.
- **Dedicated picker endpoint** — `GET /api/approval-templates/directory/formula-roles` → `listFormulaConditionRoles()` (curated-only), gated `authenticate` + `rbacGuard('approval-templates:manage')`. **`listDirectoryRoles` / `GET …/directory/roles` is untouched** (still ALL roles, for static_role).
- **Curated-freeze resolver** (`ApprovalRequesterRoles.ts`) — `resolveApprovalRequesterRoleIds` now `INNER JOIN roles r ON r.id = ur.role_id … AND r.approval_usable = true`; a system role the requester holds can never enter the snapshot. Still throws on read failure (for the 503).
- **Genuine-empty semantics** (`ApprovalProductService.ts`) — `directoryRoles` is **always** frozen as an array including `[]` (never omitted); `requesterContext.roles` threads `[]` (not `null`) at create + both dispatch sites; the create-time role wedge guard now rejects **only** a transient read failure (503), the genuine-empty **422 is removed**.
- **Frontend** (`useApprovalDirectory.ts`) — `loadRoles()` is **byte-unchanged** (still `/directory/roles`, all roles, for the static_role picker); only a TODO documents that a future dedicated formula-condition picker should point at `/directory/formula-roles`, and that the BE gate is the security boundary regardless. *(The dedicated FE picker is a non-security UX follow-up; the BE endpoint + publish/dry-run gate are the must-haves and are shipped.)*

## 4. Verification (independent, on the real dev DB)
**Three boundary properties — all proven, not just inspected:**
1. **No publish bypass.** Real-DB test *"FAILS publish when a requester.role literal is UNCURATED (APPROVAL_REQUESTER_ROLE_NOT_CURATED)"* ✓. Static analysis: `publishTemplate` is the **sole** producer of the published/active definition (`SET status='published', active_version_id=$1` — the only `'published'` writes in the service); instance creation requires `status==='published'`; `createTemplate`/`updateTemplate` only mutate drafts. The AST extractor reaches every membership node (parens flatten, `aggregate` is a leaf). So an uncurated literal cannot reach runtime by any path.
2. **`static_role` picker intact.** Real-DB tests *"/directory/formula-roles returns ONLY approval_usable roles"* ✓ **and** *"/directory/roles is UNCHANGED — still returns ALL roles"* ✓. BE diff appends new functions (no edit to `listDirectoryRoles`); FE `loadRoles()` byte-unchanged.
3. **Genuine-empty → DEFAULT.** Real-DB test *"a requester with ZERO curated roles routes to the DEFAULT edge (NOT a 422 reject)"* ✓ (a requester holding only an uncurated role → curated set `[]` → membership false → default).

**Suites (worktree, run by me):**
- **Unit 175/175** — `approval-condition-formula` + `approval-product-service` + `approval-rbac-boundary` (incl. *dry-run rejects an UNCURATED requester.role literal — preview matches publish*) + `approval-requester-roles` + `approval-graph-executor`.
- **Real-DB / API 19/19, 0 skipped** — `approval-requester-role.db.test.ts` (4: sentinel + freeze-from-user_roles round-trip + uncurated-publish-fails + zero-curated→default) and `approval-directory-endpoints.api.test.ts` (incl. formula-roles curated / roles-unchanged / 403 non-manager / least-privilege). The **`DATABASE_URL`-set sentinel** guards against the silent-skip trap — the suites executed against the migrated dev DB, they did not skip.
- **tsc** clean (0 errors) — incl. the `runtimeGraphUsesRequesterAttribute` param widening (`RuntimeGraph` → `ApprovalGraph`) and the transaction-client `client.query.bind(client)`.
- **Migration exercised independently** — the DB suites get the column from their own `ADD COLUMN IF NOT EXISTS` bootstrap, so the migration file itself was proven separately: ran the real runner (`tsx src/db/migrate.ts`) against a scratch DB → `zzzz20260627150000` applied last in the chain (correct ordering) yielding `approval_usable | NOT NULL | DEFAULT false`; `rollback` then dropped it cleanly (`down()` proven).

## 5. Invariants — CONFIRMED
- An uncurated/admin `requester.role` literal can **never** be published or pass dry-run (proven; secure-by-default column). ✓
- `static_role` approver selection is **unaffected** — `/directory/roles` + `loadRoles()` still return all roles. ✓
- A system role the requester holds **never** enters `requester_snapshot.directoryRoles` (INNER-JOIN curated freeze). ✓
- Zero curated roles routes to **default**, not a 422; only a transient read failure fails closed (503). Department/title (routing keys) keep reject-on-absence. ✓
- New `roles.approval_usable` is secure-by-default (`NOT NULL DEFAULT false`); migration idempotent + reversible. ✓

## 6. Deploy preflight — secure-by-default is a behavior change (REQUIRED before prod deploy)
`approval_usable` defaults to **false** for every existing role. So any **already-published** template that routes on `requester.role` will, for **new** instances created after deploy, freeze a curated set of `[]` and route those branches to **DEFAULT** until an admin sets `approval_usable = true` on the intended roles. (In-flight instances keep their already-frozen roles — not retroactively re-curated.) RA-1b role-routing is only days old (#3309), so the expected count is ~0, but **verify on prod before deploy**:

```sql
SELECT count(*) AS active_defs_routing_on_role
FROM approval_published_definitions
WHERE is_active = true AND runtime_graph::text LIKE '%requester.role%';
```
If > 0: in the **same deploy**, set `approval_usable = true` on the roles those templates route on, or routing flips to DEFAULT under them. (Illustrative run on the dev test DB returned 0.) Fail-safe direction either way: an unset/uncurated role degrades to DEFAULT, never to a wrong-but-confident route.

## 7. Deliberately deferred (NOT silently dropped)
- **FE dedicated formula-condition role picker** — wire a curated picker to `/directory/formula-roles`. Non-security UX (BE gate already enforces); documented TODO in `useApprovalDirectory.ts`.
- Decision-gated remainder (unchanged from #3309 MD): `requester.level`, W7 rejection/cross-base backwrite, amount enhancements, canvas polish — each needs an owner call.
