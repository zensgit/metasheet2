# 审批 requester 属性 runtime (title + RA-1b role) — 开发及验证 MD (2026-06-27)

> Goal: 当前开发计划未完成项 → 完成所有可建开发 → 开发及验证MD. Built on the closed-out RA Phase A (department: #3288/#3292/#3294/#3296 + docs reconcile #3304, on `origin/main`). Delivered on branch `claude/approval-requester-title-rt-20260627` (rebased onto latest `origin/main`; diff = additions only, no revert of #3304/other main work).

## 1. Unfinished items — what was buildable vs gated
**Built this round (decisions locked):** `requester.title` (RATIFIED, D-title=YES) + RA-1b `requester.role` (RATIFIED, fresh `user_roles` + curated vocab).
**Decision-gated — NOT buildable without an owner call (documented, not silently "done"):**
- `requester.level` — DEFERRED: no numeric seniority column in `directory_*`; needs an authored `title→rank` mapping (product decision).
- W7 **rejection / cross-base / approverField-native-person** backwrite — demand-gated; cross-base is a major redo (permission/lock/audit/target-resolution). Needs a named scenario + security decision.
- Amount-line enhancements (overridable line amount, backend strict `amount = qty×price`, discount/tax, mixed rules+formula) — product/security decisions.
- Canvas polish (drag-connect E2E, pan/zoom, copy/paste, gallery, mobile, in-canvas config) — UX tail, not a flow blocker.

## 2. requester.title — implementation
Mirrors the shipped requester.department slice exactly:
- **Resolver** (`ApprovalDirectoryOrg.ts`): lift `a.title` → `requester_snapshot.directoryTitle`, frozen at create from directory-sync `directory_accounts.title` (server-resolved, NOT actor/token).
- **Threading** (`ApprovalProductService.ts`): `requesterContext = { department, title }` at create + both dispatch re-thread sites.
- **Evaluator** (`ApprovalConditionFormula.ts`): `title` allowlisted (string `==`/`!=` only; ordering rejected by string-typing; fail-closed on absent).
- **Wedge guard generalized**: `runtimeGraphUsesRequesterDepartment` → `runtimeGraphUsesRequesterAttribute(graph, attr)`; unresolved title on a title-routed template rejects-at-create — 503 `APPROVAL_REQUESTER_TITLE_UNRESOLVED` / 422 `APPROVAL_REQUESTER_TITLE_REQUIRED`.
- **Dry-run preview** (`approvals.ts`): threads a sample `requester.title` (RA-3, non-authoritative).

## 3. RA-1b requester.role — implementation
- **Fresh provenance** (NEW `ApprovalRequesterRoles.ts`): `resolveApprovalRequesterRoleIds` = a read-only `SELECT role_id FROM user_roles WHERE user_id=$1` at create (deduped, parameterized) — **NOT** the login-time token-claim `requester_snapshot.roles`. Frozen into `requester_snapshot.directoryRoles`, reloaded at dispatch (mirrors department/title). Throws on read failure (for the 503/422 split). Lives outside `ApprovalDirectoryOrg` (which is CI-locked to `directory_*`) because `user_roles` is an RBAC table.
- **`in`-grammar** (`ApprovalConditionFormula.ts`): new `in` keyword (comparison precedence) + bracketed string-array literals + a `membership` AST node, **SCOPED to `requester.role` membership only**. Fail-closed parse/type rejects: `in` on a non-role LHS, non-array RHS, non-string / nested / empty array, `>32` elements (DoS cap), and scalar `requester.role == "x"`. Semantics: requester's frozen role set **∩** literal array ≠ ∅.
- **Keystone**: the `membership` node is added to `astReferencesRequesterAttribute`, so role usage is visible to the wedge guard; the create-time guard rejects an unresolved role set (503 `APPROVAL_REQUESTER_ROLE_UNRESOLVED` / 422 `APPROVAL_REQUESTER_ROLE_REQUIRED`).

## 4. Adversarial verification
- **`requester.title`** (built by the first orchestration workflow with 5 parallel verifiers): **0 P1**; trust-boundary **SOUND** (reads only the frozen directory title; form field `requester` + quoted literal cannot spoof); fail-closed **CORRECT**. One P2 (dry-run preview not threaded for title) — **fixed** (this diff threads title + a preview test).
- **RA-1b `requester.role`**: the second workflow's 4 adversarial reviewers **all died on a transient `502 / DNS (www.reclaude.ai no such host)` infra outage**, and the impl agent's *return* was stream-timeout-truncated (the implementation itself completed). RA-1b was therefore reviewed by the **main loop** against the same lenses — in-grammar correctness (tokenizer/parser/type/eval; `in` scoped to role; array strings-only/≤32/comma-separated/no-trailing-comma; scalar `requester.role ==` type-rejected), trust-boundary (fresh `user_roles`, not token; frozen; no spoof), fail-closed (reject-at-create + eval), and the keystone wedge-guard detection — **no bugs found** — plus the full passing suite. **An independent adversarial verification pass is recommended before merge** (re-run once the sub-agent infra recovers).

## 5. Verification log
- Unit **166/166** (`approval-condition-formula` + `approval-graph-executor` + `approval-product-service` + `approval-rbac-boundary`) — title + RA-1b together.
- Real-DB **4/4** on the live dev DB (`metasheet-dev-postgres`): `approval-requester-title.db.test.ts` (2) + `approval-requester-role.db.test.ts` (2) — each proves create→persist→reload→dispatch routing on the frozen `directoryTitle` / `directoryRoles` (the wire-vs-fixture trap), not a create-only false-green.
- **tsc clean** (0 errors). Both new `.db` tests wired into `plugin-tests.yml` (Postgres lane) + `vitest.config.ts` (no-DB exclude).
- **Rebased** onto latest `origin/main` (commit verified): diff vs main = additions only; #3304 + multitable/attendance work intact.

## 6. Invariants — CONFIRMED
- `requester.title`/`role` read ONLY the frozen server-resolved snapshot (directory `title` / fresh `user_roles`), never `actor`/token/`formData`; a form field named `requester` cannot spoof; frozen at create + reloaded at dispatch (proven by the `.db` round-trips). ✓
- Absent title/role on a routed template fails-closed at create (503/422) like department — never phantom-route / never silent defaultEdge. ✓
- New `requester_snapshot` fields (`directoryTitle`, `directoryRoles`) round-trip through real DB write+reload (proven). ✓
- `requester.level` remains parse/publish fail-closed (deferred); department behavior unchanged; `requester.role` rejected with any operator other than `in`. ✓
