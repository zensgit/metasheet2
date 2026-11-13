# Attendance owner roster creator labels

Date: 2026-10-26
Base: `9bcaf4b8197eb9752f7eb5010bc0e0ba3cd6d651`
Status: authorized existing-surface repair; local gates complete across explicit source phases, Draft/HOLD publication and current-head CI pending.

## Contract and assumptions

The Created by cell in AttendanceView owner roster currently renders the raw actor ID as its sole label. The ID remains the durable identity. Only the existing attendance-scoped directory response may supply its friendly label. This repair is limited to that cell and the existing owner resolver input.

- Empty creator (both camel/snake aliases empty after trimming) stays `-`.
- Nonempty creator shows a separate visible technical ID and a primary label: authorized directory name, then email, then localized User / 用户.
- A real directory name equal to the ID is preserved. No UUID/name heuristic, owner-name substitution, deleted-user inference, or inactive inference.
- Collect all owner IDs first in existing order, then distinct nonempty creator IDs; deduplicate across both passes. Camel alias precedes snake alias. Do not mutate roster rows.
- Reuse the current owner label cache and exactly one existing batch POST per nonempty roster resolution. Keep scope payload, request ordering, group-response fence, session guard, error fallbacks, and no retry behavior unchanged. Baseline has no numeric collector cap; do not invent a cap, pagination, second request, or global fallback.
- New pure collector/presentation helper lives beside AttendanceView in `src/views/attendance/`; AttendanceView contains only template and thin bridges. Do not rewrite roster loading, permissions, writers, routes, API contracts, flags or configuration.

Read contracts: `attendance-group-admin-ux-owner-role-design-20260529.md` (identity separate from attendance membership; use batch directory machinery), `attendance-group-admin-ux-member-label-enrichment-design-20260528.md` (labels are hints, ID remains visible; scoped best-effort enrichment). Their historical baseline statements do not override current code or the explicit repair authorization.

## Gates

| Gate | Actual evidence / boundary |
| --- | --- |
| C1/C2/C3 | Original main4 matching red and10 pure controls. First full160 cases had101pass/59fail due new test leaving shared locale Chinese. Test-only finally restore; affected60pass,100unchanged earlier passes carried, no full rerun claim |
| Own-directory guard | New prototype-name case red: unresolved constructor displayed Object. Own-property lookup only; current affected15pass including11pure+4mounted,146 other original cases carried. Total161-case coverage across phases; not fresh final whole-suite execution |
| Correctness mutations | Six original narrow removals1/4/2/1/4/4 matching red with controls; new own-property guard removal1red+2controls. Each source phase restored; filtered cases excluded |
| F1 / strict manifest | New spec in domain paths/classifier/run and required exec. Original generator exposed625vs624; exact new token recorded, no dropped token or guard waiver.38 frontend+63 backend registration guards actualpassed, zero skip |
| Quality | No introduced lint diagnostics; AV17 inherited, other changed files clean. Current production guard followed by validate:all and web build exit0 |
| Independent review | Initial source-only review plus bounded own-property closure; main independently reproduced and audited runtime. No model opinion substituted for tests |
| Browser | Actual main/App/router/Experience/AdminCenter/AttendanceView:1440zh,768en,768en403,375zh. All creator labels/IDs measured, no owner substitution/status inference, exact one scoped roster batch; original main count control also1 |
| Browser corrections | Missing fixed-schedule read mapping, wrong owner-table ancestry, inapplicable annual/mobile gate, and unrelated rotation fixture caused retained harness failures. Narrow fixes only; one-roster request budget/assertions/no-write gates unchanged |
| Browser source carry | Final own-property line added after four successful browser scenarios. AST-extracted actual fixture projection28 comparisons equal old/new, AV/styles unchanged; current affected15 and guard mutation are fresh. No final-helper browser rerun claimed |
| Cleanup / IO | Own servers exited and ports closed; no browser app writes/external forwarding/pageerrors. Intentional bootstrap405 and denied-directory403 console categories recorded, not zero-console claim |
| Remote required CI | PENDING candidate head; never borrowed from other PRs |

Evidence: `artifacts/attendance-creator-neutral-labels/verification.json`. Main receipts retain every original failure, status JSON, restore, source-phase hash and request trace. Current helper supports genuine own entries including name=id; pre-existing normalizer filtering of prototype-named IDs remains outside this helper closure, so no end-to-end prototype-ID support is claimed. Mobile query-section group workspace is explicitly allowed by original #4354; native horizontal table scroll is used, no global admin gate bypass or full parent responsive acceptance claim.

Only creator input and presentation changed; the four roster loader/resolver functions, group/owner writers and styles are byte-identical to base. No backend/API/permission/provider/flag/config change. All PRs Draft/HOLD; no merge/deploy/R71/tag/release change; Stream/lifecycle OFF; realUAT/business50004 excluded; historical08PUT INCONCLUSIVE.
