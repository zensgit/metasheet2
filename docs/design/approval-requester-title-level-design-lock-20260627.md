# requester.title / requester.level — Design Lock

> Status: **RATIFIED (owner 2026-06-27: D-title = YES, D-level = DEFER) — RUNTIME NOT BUILT** (next slice after RA-1a department). Schema verified on `origin/main`.

## Facts (directory schema)
- `directory_accounts.title` — a TEXT column populated by **directory-sync upsert** (DingTalk admin data), **server-resolved (not request-sourced)**. NOTE: per-tenant/provider fill-rate varies — `title` is **not guaranteed present** for every requester; an unset title on a title-routed template fails-closed at create (the wedge guard), same as department.
- **NO** numeric seniority/grade/rank/level column anywhere in `directory_*` (`directory_departments.order_index` = dept sort order; `…alerts.level` = severity). `title` is free-text, no machine ordinal.
- The resolver (`ApprovalDirectoryOrg.ts:166-185`) already has the account in hand — `a.title` is one column away.

## Decisions (owner, 2026-06-27)
- **D-title = YES** — ship `requester.title == "经理"` string equality (`==`/`!=`) as the next slice.
- **D-level = DEFER** — no numeric source exists; revisit only with a real ordinal source or an authored `title → rank` mapping. Don't fake an ordinal.

## Build (mirrors RA-1a department; 3 edits + guard generalization)
1. **Resolver**: add `a.title` to the SELECT → `ApprovalRequesterOrgRelations.primaryTitle` → `requester_snapshot.directoryTitle` (frozen at create, `ApprovalProductService.ts:2902-2914`).
2. **requesterContext**: extend `{ department }` → `{ department, title }` at create (`:2926`) + both dispatch re-thread sites (`:3165/:3331`).
3. **Evaluator**: `RA1A_REQUESTER_ATTRS` add `title: 'string'`; add an `evaluateRequester` `title` branch (`ApprovalConditionFormula.ts:597`); `==`/`!=` only (string-typed → ordering auto-rejected by the numeric-operand type check).
4. **Wedge guard**: generalize `runtimeGraphUsesRequesterDepartment` → `runtimeGraphUsesRequesterAttribute(graph, attr)` (it already calls the token-aware `formulaReferencesRequesterAttribute(expr, attr)`); reject-at-create for an unresolved `title` on a title-routed template (503 transient / 422 genuine), same posture as department.
- Tests: evaluator unit (`==`/`!=` + parse-reject others + token-aware literal), resolver real-DB title lift, round-trip create→reload→dispatch, wedge guard for title.

## Out of scope
- `requester.level` numeric (needs the mapping decision above).
- title case/whitespace normalization — same `==` footgun as department; document for authors.
