# W6 policy workspace delivery lock — 2026-10-26

Status: local engineering gates qualified; Draft/HOLD, remote exact-head CI pending.
This is a bounded frontend delivery under the existing W6 gate, not a new ratification,
enablement, release, provider/UAT or whole-parent acceptance record.

## Inherited scope

- Parent attendance-shift-group-advanced-capability-design-lock-20260723.md
  §5.1 and §7.5: source/effect must be visible in policy summaries.
- attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md
  §5 items 1–5 and OD-W6-7: reuse the existing closed aggregate, gate and editors.
- This slice implements the user's current bounded instructions.
  It does not rewrite the older W6 lock's historical authorization record.

## Workspace contract

1. Gate OFF returns the sole original legacy-slot element VNode. The legacy section,
   its directives, six-card renderer, getters, drawers and writer handlers stay exact.
   No added wrapper, Fragment, comment or scoped style belongs to the TS component.
   The same-filename OFF comparison below verifies the unchanged scoped DOM and ordered API ledger.
2. Gate ON replaces the old summary renderer with the existing aggregate panel and an
   explicitly named tool list. Only original titles and action objects enter the tool
   list; local values/details/policyLines do not pose as an effective read model.
   Fixed groups retain nine actions, scheduled/free groups eight. The tool grid/cards/
   action rows/buttons are rendered by an AttendanceView-owned named slot, retaining
   its scoped style ownership. The TS child owns only the guard and slot invocation;
   it adds no magic scope ID and no copied/globalized stylesheet.
3. The canonical route keeps its existing host panel and receives no second panel in
   AttendanceView. Generic/returned-parent workspaces mount one panel for the selected
   persisted group. Unsaved selection shows neutral save-first text and no aggregate.
4. The panel starts collapsed (zero GET); each explicit open/refresh uses its existing
   aggregate GET. No second status cache, API, feature flag, server enum or writer.
   Labels remain the existing server-fresh closed labels. Unknown labels retain the
   existing unrecognized indicator; no new valid fallback is introduced. Denial is neutral.
5. Existing seven domain-summary keys remain unchanged. Basics is metadata/conflict
   scope in the existing contract, not a new domains.basics row. Coverage,
   comprehensive-hours and advanced-control copy do not become new closed domains.
   A demand for independent status on those capabilities requires an owner contract
   amendment; this proposal stops that extension here.
6. An optional delegated editorRef event uses the shared closed target mapping extracted
   from the existing #6539 resolver. Both default href resolution and delegated navigation
   use that one mapping: basics/people select a local stage; schedule/policies map to
   canonical schedule/rules with null surface. Route targets call AttendanceView's original
   openAttendanceGroupRoute, retaining #6553 originStage/history capture. No href decoding,
   duplicated route spelling, or router.push bypass. Existing default navigation outputs
   and the canonical Panel/host/Experience sameRouteStage/source guards remain unchanged.
7. Selection sources are immutable object identities renewed synchronously on
   group/org/canonical/gate/stale transitions. A -> B -> A cannot revive the old source.
   Active/session/current-source/current-group checks guard delegated navigation.
   Panel instance keys include group/org/revision; old payloads/actions are rejected.
8. W6 ON generic catalog reload updates the catalog only; explicit selection uses the
   original handler. It does not auto-select the first row or replay a selected row over
   dirty form fields. Canonical/returned-parent hydration retains reviewed #6539/#6553 behavior.
   Gate OFF retains the original auto-selection behavior.

## Inherited gates and bounded disposition

- Fresh-main review of actual #6539/#6553 heads, parents and minimum dependency domain.
- OFF full DOM/API byte equality including legacy slot scope attributes/comments.
- ON saved/unsaved/canonical/returned-parent, all five labels, 9/8 original tool actions,
  actual AV scope ownership on grid/card/action/button descendants and browser layout.
- Both mapped group_stage refs from domain/conflict via Back/Return; the fixture must
  first prove a real synthetic return scope, web-history metadata and fresh matching probe.
- Captured obsolete callback rejection versus a reused live B button positive control.
- Denials, malformed/unknown enums, group/org/session switching and late payloads.
- Dirty draft preservation on mount and delayed catalogs; no double aggregate requests.
- Native keyboard request isolation; strict synthetic network allowlist, zero writers.
- Focused and neighboring specs; guard mutations must individually go red, then restore.
- Official token-manifest regeneration, lane guards, type/build and bounded browser widths are qualified below.
  Terminal exact-head CI and human assistive-technology trials remain separate.

No flag changes, R71, merge, deploy, UAT/business50004, real tenant/provider access,
new owner domain, runtime command, or customer acceptance is authorized by this file.

## Attempt2 source disposition

The independent source review confirmed W6-SRC-01/02 (navigation mapping and scoped
style ownership), plus W6-TEST-01/02 (live-node reuse and incomplete return fixture).
This attempt changes only those source paths and their focused cases. Attempt1 candidate,
patch, pins and README are retained under the proposal's history/attempt1 directory.
The source-review findings are closed and the resulting code was then independently executed
by the main agent. The earlier proposal history remains a source record; runtime results below
are not attributed to the reviewer.


## Main-agent verification — 2026-10-26

| Gate | Actual evidence |
| --- | --- |
| Source | Fresh main9bcaf4b8197eb9752f7eb5010bc0e0ba3cd6d651, actual #6539 and #6553 ancestors; dependency merge0595fda,28 paths exact input UNION. No private20 history is published |
| Focused plus neighbors | Eight frontend files,314 actual passed,0 skipped: workspace14, mounted stage/navigation29, existing panel26, labels45, host gate2, parent history29, return helper22, admin regressions147 |
| Wiring | Official manifest regenerated. Two backend lane guards63/63 passed,0 skipped; source wildcard and both web-lane registrations retained |
| Guard sensitivity | Five isolated mutations: source identity1 red, canonical stage mapping2 red, OFF wrapper1 red, unknown domain label1 red, selection panel key1 red. All restored. One earlier wrong-posture fallback mutation was invalid and excluded |
| Quality | validate:all0, web build0, strict scoped ESLint for six changed files0. Full AV baseline15errors/2warnings equals candidate15/2; introduced0, not full-file lint0 |
| OFF actual entry | Original dependency AV versus candidate at the same filename:8 raw scoped section/drawer snapshots byte-equal,58 ordered API ledger rows exactly equal, feature false, no aggregate GET |
| ON actual entry | 1440en and768zh, native controls, one collapsed panel, explicit open/refresh one GET each,7 server rows,9 tool actions and scoped layout; schedule/policies canonical routes capture policies origin and Return performs a fresh matching probe |
| Mobile | Actual375zh touch/coarse is blocked by the existing desktop gate; no mobile editor/panel or aggregate/detail GET |
| Network | All app HTTP synthetic;0 application write attempts, provider attempts, external forwarding and page errors. Owned servers stopped and ports closed |
| Review | Astra/high2P2 and2test-source findings source-closed; main executed and audited actual source/DOM/request/mutation evidence separately |

Positive browser rows exercise Effective, Org default and Preview only plus a conflict row.
The45-case label suite exhaustively checks all five closed bilingual labels; denial and
unknown-label behavior have mounted tests. This is not a new browser matrix of every enum,
callback, A-B-A, org/session transition or every parent frontend/AT gate.

The OFF differential replaces only AV with original dependency bytes while all candidate
common files are fixed. It does not claim the whole tree is main or the unpublished20-input
fixture. The visual supplement only scrolls existing regions into view; it does not replay or
replace the five passing behavior phases.

[Scoped verification](../../artifacts/attendance-w6-policy-workspace/verification.json)
records code/test hashes, screenshot hashes and the source/phase boundaries.

## Remaining authority and acceptance

- This cumulative Draft depends on #6539 and #6553, which remain Draft/unmerged. It targets
  main because the required test20 workflow accepts main/develop PR bases. Refresh/review
  the cumulative diff after parent disposition; no merge authority is implied.
- Existing W6 defaults and server/org rollout gates remain unchanged. Mocked feature=true
  demonstrates the UI only; no running configuration was enabled.
- This does not invent status domains for coverage/comprehensive-hours/advanced tools or
  close all parent FE04/FE05/FE06 acceptance. Human AT and wider editor/preview matrices remain.
- #6512 owner approval, frozen transfer adapters, W8/manual/soak, caller rollback and live
  provider/staging/activation gates remain separately tracked.
- All PRs Draft/HOLD; no merge/deploy/R71/tag/release/business-config change.
  Stream/lifecycle OFF; real UAT/business50004 excluded; historical08am PUT inconclusive.
