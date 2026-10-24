# Attendance W6 navigation fidelity repair design lock — 2026-10-25

Status: **Draft / HOLD for merge and enablement**. This is a bounded read-side
repair of existing W6-R8, under the current user's all-DingTalk-closeout Draft
fix authorization. Stage 1 wrote this lock and focused failing frontend tests.
Main independently froze and ran the original red before authorizing Stage 2.
Stage 2 navigation/list implementation is authored; execution and independent
review remain with main. Roster safety explicitly depends on Draft #6534 at
`e429121eede5064da590b4a0a4dd6d1ec15fabc3` and a future new owned combined
fixture with actual runtime proof. These gates remain pending.

- Baseline: `8a426818804897a20f7674c39c56b3a445909c3a`.
- Branch: `codex/attendance-w6-navigation-fidelity-20261025`.
- Scope: preserve the group and stage when a W6 domain/conflict action opens its
  existing editor. Backend capability DTO residuals belong to the independent
  backend audit.
- No provider/customer-data work, application writes, flags, calculator changes,
  R71, merge, deployment, or enablement is authorized by this document.

## 1. Authorization and historical limitation

The existing W6 lock
(`attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md`,
status header and §9/§10) durably ratifies W6-1 only; its header still records
later W6 slices as HOLD. The W6-234 report
(`attendance-issue-4556-w6-234-development-verification-20260813.md`,
authorization note ~L23 and residual §6.3) records an in-session W6-2/3 grant
and explicitly does not backfill a durable owner ledger entry.

The current user's Draft repair authorization permits this bounded repair.
It is neither historical ratification nor evidence that the earlier ledger
gap was closed, and grants no enablement authority. Neither this lock nor green
tests may be cited as authorization to merge, deploy, change flags, or close
#4556. Historical documents remain unchanged.

## 2. Source facts on the baseline

Paths below are under `apps/web/`; anchors use symbols and approximate lines.

| Fact | Source |
| --- | --- |
| All four `group_stage` references become the generic groups-list href | `src/views/attendance/attendanceGroupEffectivePolicyLabels.ts`, `resolveAttendanceGroupEffectivePolicyEditorNavigationV1`, ~L325 |
| Both domain and conflict buttons pass only `nav.href` to router navigation | `src/views/attendance/AttendanceGroupEffectivePolicyPanel.vue`, template ~L100/~L154, `navigate` ~L236 |
| The editor already accepts an exact group and stage; the selector alone only sets stage | `src/views/AttendanceView.vue`, `editAttendanceGroup` ~L29288, `selectAttendanceGroupStage` ~L29334 |
| Panel and editor are siblings inside the authorized host | `src/views/attendance/AttendanceGroupContextHost.vue` ~L25–35; `AttendanceExperienceView.vue` ~L28–40 |
| A delayed group list rehydrates route group/stage | `src/views/AttendanceView.vue`, `loadAttendanceGroups` ~L29464 |
| Assigning the selected group triggers member/manager requests | `src/views/AttendanceView.vue`, group watcher ~L31104 |
| Route A can coexist with an editor temporarily selecting B | `tests/attendance-admin-regressions.spec.ts`, test beginning ~L3947 |

The closed #4711 route contract remains
`schedule | calendar | rules`. Its §3.1 explicitly leaves `basics | people`
as ordinary editor stages outside that route family. W6-R8 and W6 §5.3 already
require the existing builder or stage selector. The report's disclosed generic
fallback is the behavior being repaired; it does not prove exact-stage fidelity.

## 3. Observable action contract

Keep the existing `editorRef` union and fail-closed parser unchanged.

| Input reference | Resolver result / panel action |
| --- | --- |
| `group_stage: basics` or `people` | `{ kind: 'group-stage', groupId, stage }`; emit `open-group-stage` with exactly `{ groupId, stage }` |
| `group_stage: schedule` | `{ kind: 'route', href }` using the existing #4711 builder, step `schedule`, no surface |
| `group_stage: policies` | `{ kind: 'route', href }` using that builder, step `rules`, no surface |
| Valid `group_context_route` | Preserve the existing builder, step/surface validation, normalized return target, and router push |
| Unknown stage/kind or illegal step/surface | Parser returns null; no domain/conflict navigation action |

The exact group ID comes from the authorized panel/host context, never from a
caller-selected organization, first list item, display label, or aggregate hint.
Internal stage actions have no href and cause no router push. Both action kinds
cause zero application writes; opening the panel still makes only its existing
explicit aggregate GET.

Do not add route steps, query aliases, history/local-storage stage state,
caller-supplied section IDs, or a second editor. Basics/people selection is an
ordinary in-memory editor action, not a durable stage authority. Refresh and
Back/Forward continue to reconstruct the canonical route's group, step, and
surface; this repair makes no refresh-persistence promise for basics/people.

## 4. Host/editor implementation boundary, pending independent review

The required delivery path crosses the real components:
panel → authorized group host → experience composition → admin center → live
AttendanceView. A typed event/prop or narrowly exposed selector may bridge the
existing components; this lock does not prescribe a new orchestration framework.

At consumption, require a ready, current-session host and a target ID matching
its authorized route group. Preserve permission and session fences. The editor
must show that same group and exact requested stage even if a list interaction
previously selected B while the route remains A. Reuse existing seeding and
stage selection. When the same group is already selected, repeated actions must
preserve unsaved field edits.

Account for initial/delayed list hydration before claiming the action settled:
it must not immediately undo the explicit selection or substitute the first
group. Do not solve that by retaining a competing durable stage override.
The coordinating implementation must review event timing and hydration together;
Stage 1 does not assert that every related selection race is repaired.

Unknown/deleted/inaccessible groups retain neutral unavailable behavior, without
falling through to another editor. Each backend endpoint remains responsible for
authorization; a successful host probe is not perpetual authorization. Session
changes invalidate pending action/result delivery. Gate-OFF DOM/network behavior,
the existing attendance-admin audience, and the authoritative group ID remain
unchanged. No new eager fetch or write belongs to this action.

## 5. Verification gates and evidence state

| Gate | Required proof | Stage 1 state |
| --- | --- | --- |
| Original red | Existing pure resolver returns generic list instead of exact stage action or route; actual panel domain/conflict clicks expose the same gap | Main reports original-red-v2-state: exit 1, 55 actual passed + 11 named red, zero skipped/pending; writer did not run it |
| Closed contract positives/negatives | Exact basics/people actions; schedule/policies canonical hrefs; retained group-context route positives; unknown-stage parser/UI negatives | Stage 1 original red reported by main; Stage 2 unrun |
| Real host-to-editor integration | Mount the real panel, host, admin wrapper, and AttendanceView together; route A/editor B action restores A and exact stage | Authored in attendanceGroupEffectivePolicyStageNavigation.spec.ts; unrun |
| Repeat/hydration safety | Preserve edits on repeated same-group action; repeat after manual tab changes; delayed list response cannot undo the completed action; include target outside first list page | Pending |
| Session and org safety | W6 action/list ownership survives navigation/session changes; denied/cross-org and unknown/deleted probes stay unavailable; roster result ownership is separately supplied by #6534 | Standalone nav/list coverage authored; dependency and combined runtime proof pending |
| Gate-OFF and writes | Panel absent and zero aggregate requests when OFF; navigation actions make no application writes; permission/identity gates retained | Existing coverage retained; integration verification pending |
| History compatibility | Existing schedule/rules/calendar route and Back/Forward behavior retained; no basics/people durable alias introduced | Pending |
| Required CI coverage | Changed/focused specs execute in attendance-web-guard and required web gate, with manifest parity where applicable | Stage 2 registrations authored; generator/checks unrun and main-owned |
| W6 people → roster compatibility | Exact #6534 e429 input plus this W6 patch in a new owned compatibility fixture; actual runtime of existing roster guards and new W6-people interaction races | PENDING; not closed by standalone W6 tests or prose |

Synthetic slot callbacks and admin-wrapper stubs cannot satisfy the real
integration gate. Stage-1 panel tests mount the actual panel but deliberately do
not claim host-to-editor proof. No tests are skipped to create a green result.

Unknown/deleted actor labels are a separate existing people-surface limitation:
the W6 neutral-label helper has no live panel call site, and the live editor
renders raw IDs. Reaching the people stage does not close that limitation.
Stale member/manager response delivery belongs to #6534 at exact e429. The
combined W6-people interaction needs actual adversarial runtime proof in a new
owned fixture before any end-to-end roster safety claim.

## 6. Stage 1 handoff record

Exact Stage 1 changed paths:

1. `docs/development/attendance-w6-navigation-fidelity-design-lock-20261025.md`
2. `apps/web/tests/attendanceGroupEffectivePolicyLabels.spec.ts`
3. `apps/web/tests/AttendanceGroupEffectivePolicyPanel.spec.ts`

No production source, backend, historical ratification document, workflow, or
test runner is changed. No test/install/build/PG/browser/server/commit/push is
performed in Stage 1. Red is expected from source inspection, not yet observed.
After handoff the writer stops edits so the coordinating session can freeze the
files and run the original red under its global heavy-work slot.

## 7. Stage 2 navigation/list implementation, pending main execution

Main reported stable Stage 1 freeze and original-red-v2-state: 55 actual passed
plus 11 named red, exit 1, zero skip/pending. The initial main preflight used
incorrect wrapper paths and executed no tests; corrected views/attendance paths
preserved the red. These are the coordinating user's results, not writer runs.

### 7.1 Required dependency and approved disposition

Existing Draft #6534 at
`e429121eede5064da590b4a0a4dd6d1ec15fabc3` already owns member/manager loads,
both label resolvers, and synchronous group/org/plugin roster invalidation.
Main reports its final 13/13 validation. This writer inspected its source and
accepts that result as user-supplied evidence; no validation was rerun here.

The first Stage 2 candidate independently duplicated that roster fix. After
the dependency was identified, main approved removing only the duplicate
implementation and separating the probe bodies from standalone W6 collection.
The full prior source, patch, spec and exact roster test bodies are preserved
under the artifact location in §7.4. Nothing in #6534 or an earlier fixture was
modified, replaced or rebased.

On the public W6 branch, these four functions and the original roster watcher
were initially restored byte-for-byte from this branch's own
`8a426818804897a20f7674c39c56b3a445909c3a` baseline:

- loadAttendanceGroupMembers
- loadAttendanceGroupManagers
- resolveAttendanceGroupMemberLabels
- resolveAttendanceGroupManagerLabels

The four baseline function bodies were also byte-equal between 8a426818 and
#6534's fdb30a671 baseline. W6 retains no duplicate response-fence implementation, roster counters or changed roster watcher. The measured Addendum 9 later adds only two lifecycle request-entry guards; the original disposition snapshot remains retained.

**Dependency gate remains PENDING:** main must construct a new owned
compatibility fixture from this W6 patch and the exact approved #6534 input,
preserve the dependency's roster implementation, and run actual W6-people →
roster race proofs there. Existing continuous roster guards remain in #6534.
Its prior 13/13 does not prove the new combined interaction; archived test source
does not prove runtime compatibility. No skip, conditional test or artifact-path
collection substitutes for that gate.

Public W6 ancestry remains its fresh-main baseline. Do not cherry-pick #6534
into this branch, reparent it onto a private composite, or churn #6534/newhead.
A compatibility fixture is evidence only, not public branch ancestry. All PRs
remain Draft/HOLD. Historical ratification/ledger limitations in §1 remain
unchanged; no dependency or combined green authorizes enablement or merge.

### 7.2 Retained W6 implementation and standalone tests

- The resolver maps schedule/policies through existing schedule/rules builders.
  Basics/people emit the exact typed internal group-stage action.
- The real host → Experience → AdminCenter → AttendanceView bridge checks the
  authorized current group and session. Experience compares the source route
  context object and ID, including A→B→A navigation, before forwarding a fresh
  request prop.
- AttendanceView restores authorized A even if its editor selected B and A is
  absent from the first 200 list items. Same-group actions use the existing
  selector without reseeding unsaved fields. A local interaction revision
  protects the current editor during list reconciliation; it stores no second
  stage authority or durable route/query/history/local-storage alias.
- List-only activity/generation/session checks protect list completion and held
  list controls after unmount. Both label resolvers retain own-baseline bytes; the two loaders add only the Addendum 9 entry guard. Their existing response behavior still depends on #6534.
- Probe and aggregate response IDs must match the requested group. A held W6
  action is inert after session/navigation changes, while loading, or after
  aggregate refresh returns 403/404.
- No writer, permission, API, flag or calculator is changed. The inherited
  batch/resolve POST is still a read, not an application write.

The public standalone stage-navigation spec mounts real RouterView,
Experience, host, panel, AdminCenter and AttendanceView. Its mounted-hook
observer locates the real host only for stale-source public-event delivery;
no editor component is stubbed or replaced with a synthetic slot. IO, rollout
inputs and principal are mocked. Probe 403/404 fixtures prove browser posture,
not live cross-org DB authorization.

Standalone W6 covers NEW navigation, intent and list behavior. The 38 expanded
roster/control cases from the first candidate are no longer collected here;
their exact source and harness are preserved, not skipped or conditionally
passed. The list-only held-control assertion remains in the public navigation
test. Roster runtime behavior is an explicit dependency proof in main's future
combined fixture, not a dropped or closed gate.

### 7.3 Remaining execution and mutation gates

No Stage 2 tests or generators have been executed by this writer.

| Gate | Required evidence | State |
| --- | --- | --- |
| Original resolver/panel regression | Main's original 11 named red, then implementation green with canonical route positives | Original red reported; Stage 2 run pending |
| Exact A/stage bridge, repeated edits, late list | Real standalone component-chain run; remove forwarding or make selector-only to get named red; unconditional same-group reseeding must lose edits; removing list preservation must fail delayed-list case | Pending |
| Current route/session action ownership | Old-source A-B-A and mismatched-target tests; neuter source/session guard for matching named red | Pending |
| List ownership | Held list control after navigation cannot request; stale list completion cannot overwrite accepted intent/edits | Pending |
| Identity/unavailable behavior | Wrong probe/aggregate ID and 403/404/session negatives; remove equality/status guards for matching named red | Pending |
| Required two-lane wiring | Regenerate/check sorted manifest; execute focused specs and appropriate neighbors, preserving all old physical tokens | Pending; main-owned |
| #6534 existing roster guards | Exact e429 dependency input and continuous guards remain intact | Dependency required; not implemented in W6 |
| NEW combined W6-people/roster safety | New owned fixture, exact compatible inputs, actual runtime of existing roster guards plus adversarial new interaction probes (headers, JSON, catch/finally, session and A-B-A), with matching mutation proofs | PENDING; cannot be closed by source restoration or prose |
| Type/build/browser and independent review | Main's scoped checks and review on the frozen input | Pending |

The archived probes were written against existing roster entrypoints and can
be considered by main for independent baseline reproduction; they were not
executed by this writer and are not claimed to reproduce anything yet. Their
2 held-control + 20 header/JSON/error/finally + 8 session + 8 label cases are
preserved exactly. Any additional combined test bodies must exercise the real
new W6 action into roster loading, not only manual row selection.

A mutation requires a named matching assertion failure. Collection errors,
unhandled exceptions, timeouts, skips and incidental worker failures are not
successful mutation captures. Restore only the mutation, preserving all other
uncommitted work.

### 7.4 Preserved probe source and evidence location

Define A as `R/artifacts/attendance-w6-navigation-fidelity-20261025`.
The approved-disposition archive is:

`A/6534-approved-disposition-20261024T201408782987Z/`

- stage-navigation.spec.ts.snapshot: exact full pre-disposition spec and harness.
- roster-interaction-probes.exact.ts.txt: exact removed describe section.
- probe-family-1..4.exact.ts.txt: exact declaration/body slices for each family.
- probe-preservation.json: original source path, line anchors, case inventory
  and SHA-256 for the full source, section and four family bodies.
- tracked-working-tree-before-disposition.patch and
  AttendanceView.vue.before-disposition.snapshot: original implementation.
- design-lock.before-disposition.snapshot and SHA256SUMS: prior lock and hashes.

These artifact paths are not wired into CI or Vitest collection. The earlier
pre-6534-disposition snapshot is also retained unchanged. Artifact preservation
is evidence retention only; actual combined runtime remains mandatory.

### 7.5 Registration, scope and exact changed-path inventory

attendance-web-guard.yml registers the new standalone spec in its push filter,
changed-file classifier and targeted command. The required script explicitly
names labels, panel, existing host gate and standalone navigation. Existing
physical tokens are retained; the sorted manifest adds those four tokens.
Main owns generator regeneration/check and all execution.

1. docs/development/attendance-w6-navigation-fidelity-design-lock-20261025.md
2. apps/web/src/views/attendance/attendanceGroupEffectivePolicyLabels.ts
3. apps/web/src/views/attendance/AttendanceGroupEffectivePolicyPanel.vue
4. apps/web/src/views/attendance/AttendanceGroupContextHost.vue
5. apps/web/src/views/attendance/AttendanceExperienceView.vue
6. apps/web/src/views/attendance/AttendanceAdminCenter.vue
7. apps/web/src/views/AttendanceView.vue
8. apps/web/src/views/attendance/useAttendanceGroupRouteContext.ts
9. apps/web/tests/attendanceGroupEffectivePolicyLabels.spec.ts
10. apps/web/tests/AttendanceGroupEffectivePolicyPanel.spec.ts
11. apps/web/tests/attendanceGroupEffectivePolicyStageNavigation.spec.ts
12. apps/web/tests/attendance-web-guard-workflow.spec.ts
13. .github/workflows/attendance-web-guard.yml
14. apps/web/scripts/run-required-web-tests.sh
15. apps/web/scripts/run-required-web-tests.tokens

No test, generator, build, install, PG, browser, server, commit or push was run
by this writer. Backend capability DTOs and authoritativeResults/calculator
constants, R71 and historical owner ledger are outside this write scope.
Unknown/deleted actor-neutral labels remain the separate existing limitation
in §5. No all-races or product-completion claim is made.

After this handoff, source edits stop for main to freeze and refute. Dependency,
combined runtime, standalone execution and review gates all remain pending.

## 8. Same canonical route intent (queryless entry included)

Independent review identified duplicated-route editor selection, then a queryless entry whose benign returnTo normalization remounted the editor. Main observed 2 named reds for each counterexample, with filtered exclusions not counted. The canonical URL builder is unchanged. Only group_stage schedule/policies targets carry a typed sameRouteStage intent. Before routing, the panel compares current and destination through the existing canonical group-route parser (group/step/surface); when that canonical destination is already active, it consumes the existing authorized editor bridge synchronously and preserves the accepted current URL, including a valid queryless spelling. Other route destinations still use the original router.push. Ordinary group_context_route targets retain their route-only shape. No post-navigation asynchronous callback or new durable route state remains. Earlier duplicate-result asynchronous replay was an intermediate attempt; its three delayed-completion tests and source snapshot are retained in artifacts, not claimed as final-source requirements. Final queryless/duplicate positives, normal neighboring tests, current quality/build and independent review must be executed before closure.

## 9. Measured incremental request-entry gap

The NEW exact-e429 combined fixture actually ran 83 cases: 81 passed, two held-control probes failed. Main targeted only those two and observed the precise extra calls: one GET to old A/members and one to old A/managers after editor unmount. Existing e429 response fences prevented stale response application, but did not refuse a new call at loader entry. This is not a navigation failure, production authorization bypass or the historical08am cause.

Reuse this patch's own editor-lifetime flag (renamed from the list-only flag), adding exactly one early active/session check to each member/manager loader. Do not change e429 itself, its response fences, label resolvers, watchers, API paths/parameters, writer or permissions. Public loaders differ from own main only by the new prefix; combined loader suffixes remain byte-exact e429, and both combined label resolvers remain fully byte-exact e429. Public standalone adds both held-control negatives under its existing two CI registrations. Archived probe bodies and previous exact-four-function composition receipt remain historical evidence, not current whole-function equality claims. The new prefix and new combined source must be frozen and run; expected new combined inventory is 85 (17 navigation + 48 composed roster/W6 probes + original20roster). Matching removal must produce the same two named failures. No expected count is a result; previous failure remains retained.

## 10. Current main-owned local gate disposition (supersedes authored-pending snapshots)

| Gate | Observed evidence |
| --- | --- |
| Original resolver/panel reproduction | 55 controls + 11 named red, zero skip; product baseline unchanged then. |
| Closed resolver/panel/domain gates | 45 labels + 26 panel + 2 host gate + 32 workflow cases passed across retained phases. Those inputs/branches remain unchanged by the final entry guards; not a claim of rerunning all 105 later. |
| Final continuous real component chain | Current standalone navigation 17/17, including repeated draft preservation, routeA/editorB, queryless schedule/policies, session/denial/ID negatives and both disposed reload controls. |
| Reviewed candidate regressions | Duplicate path and queryless normalization each independently reproduced 2 named reds before minimal repair. Final removal of canonical same-path consumption yields 4 matching reds/11 exclusions, exact restore. |
| Required roster dependency interaction | New own fixture `1ba50ea32070e07ce06e3c7a66381a2709de3f65`, base8a426, exact e429 input and 21 frozen paths. Actual 85/85: public17 + archived38 + NEW W6-people10 + originalroster20. Not 85+17 unique. Two measured entry fixes preserve e429 suffixes and both full label resolvers; not a Git-ancestor/merge claim. |
| Incremental disposed-loader mutation | Remove only two entry guards: original two matching reds/46 filtered exclusions return; exact source restored. Prior83=81passed/2failed and targeted request-path proof retained. |
| Quality/build | Current validate:all and web build exit0, scoped touched TS/Vue/tests ESLint0. Explicit full AttendanceView ESLint remains exit1 on ownmain and candidate: the same 17 diagnostics with identical source contexts, zero introduced; not falsely reported full-file green and not refactored here. |
| Actual main browser | Real index.html→main.ts→App/router→host/panel/admin/editor: 1366/768 current desktop phase passed exact group/stage, queryless URL and unsaved-name behavior; real pointer trials, panel bounds and source hashes passed, zero app writes/provider forwards/page errors. 390's unchanged product mobile-admin gate was observed in the earlier same-source phase and retained, not rerun or called mobile-editor success. Three selected synthetic screenshots visually reviewed. Own Vite processes/ports stopped. |
| Browser harness limits | First cache preflight ran zero pages; corrected only tool binary cache selection. First page attempt exposed four missing exact readonly mock paths and a new harness's unratified20pxminimum; current design lock requires visible/clickable/no overflow, and inherited native19px buttons passed genuine pointer trials. Exact client response fixtures were completed; no wildcard IO or product CSS/permissions/budget was changed. Historical failures and actual dimensions retained. |
| Independent reviews | Sol/high source review identified the two reproduced navigation P2s, then found no confirmed introduced P1/P2 after repair. A separate readonly Sol/high review verified the measured two-entry-guard delta and exact suffix proofs, no confirmed P1/P2. Main owns all executions. |
| Current-head required CI | PENDING Draft publication and fresh exact-SHA terminal checks. No prior PR green is borrowed. |

Evidence: artifacts/attendance-w6-navigation-fidelity-20261025. Current execution state is entry-guard-final-state.json; browser-main-independent-audit.json links the distinct viewport phases and selected images. Composition/entry suffix proof is combined-roster/composition-entry-guard-source-manifest.json. Earlier attempts, source snapshots and all named mutation outcomes are retained. Source-only probe preparation was not counted as runtime success. This closes only this local navigation/dependency gate; neutral actor labels, owner/manual/frozen/live acceptance and whole-goal completion remain separate.
