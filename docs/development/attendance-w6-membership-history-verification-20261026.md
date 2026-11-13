# W6 calculation-group history verification — 2026-10-26

Status: Draft/HOLD; local engineering qualification only. Current-head public required CI is pending publication.

The ordinary management roster's Joined timestamp does not describe calculation attribution dates. The existing People stage now has a separate, gated read-only history consumer for one selected organization person. It uses the existing organization-scoped person search and calculation-group-memberships GET. It shows the complete returned cross-group timeline; it is not a historical population census, membership editor or new authorization surface.

Inclusive calendar dates remain unchanged. A missing end means **No recorded end**, not active/effective. The UI does not infer an organization default from an empty history. Unknown groups and missing person labels are neutral, with technical identifiers separated. Genuine names equal to IDs remain genuine.

## Design-lock gate results

| Gate | Actual evidence | Boundary |
|---|---|---|
| Original missing history | Original host1 matching red,2 existing controls passed after exact source-backed fixture correction | Initial batch-read misclassification retained as invalid controls, not product evidence |
| New consumer/projection/host/transport | Initial128 actual passed, then4 additional actual passed;44 filtered excluded |132 case invocations across phases,130 unique full names; a3-row parameterized title repeats. Not a fresh full132 run |
| Mutation controls |9 mutations,12 matching red and9 control executions; exact source restoration | Controls and filtered cases are not added to unique totals |
| Affected neighbors and registration |45 stage/host neighbors;40 frontend registration;63 backend lane guards, zero skips | Both live frontend lanes contain all4 new specs and official tokens |
| Scoped quality | Scoped lint, validate:all and web build exit0 | AV retains17 inherited diagnostics, introduced0; no full-file lint-clean claim |
| Actual backend read boundary |9 actual HTTP cases through JWT middleware, DB-hydrated RBAC, original router and isolated PostgreSQL;74 observed SQL,0 request DML,0 provider attempts;9 table fingerprints unchanged | Not full MetaSheetServer or UI-to-real-backend end-to-end acceptance; backend source unchanged |
| Schema/environment |458 actual migrations, pending0, matching ledger458; UTF8 database | Successful migration/list retained across harness continuation; own cluster stopped, data retained |
| Actual entry/OFF | Original/candidate raw People, Managers and GroupManager DOM identical; full API multisets58 requests on each side | Two passed phases retained; not ordered IO or full-document/all-resource equality |
| Actual entry/ON | English1440 and Chinese768: explicit scoped search, selection, View, Refresh and known historical ID; D−1/D dates/open end/unresolved group; each1 search and3 timeline GETs | Standard Playwright selectOption on real select; Search/View/Refresh and text input use actual keyboard actions |
| Original mobile gate |390 touch/coarse viewport retains desktop-admin hint, no history/search reads | Functional mobile editing is blocked by the original design, not claimed passed |
| Independent review | Three concrete transport/auth/capability P2s reproduced and closed; source-only Astra/high closure with no new confirmed P1/P2, independently audited by main | Review opinion is separate from runtime evidence |
| Publication / compatibility | Own Draft PR and its new-head CI must be verified after publication; new private compatibility input remains pending | Private23 does not include this change |

## Reproduction and commands

Original host reproduction used the identical AV source filename. The candidate's existing two-lane wiring includes:

- AttendanceCalculationMembershipHistory
- attendanceCalculationMembershipHost
- attendanceCalculationMembershipTimeline
- attendanceCalculationMembershipTransport

Focused frontend execution:

~~~bash
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/AttendanceCalculationMembershipHistory.spec.ts \
  tests/attendanceCalculationMembershipHost.spec.ts \
  tests/attendanceCalculationMembershipTimeline.spec.ts \
  tests/attendanceCalculationMembershipTransport.spec.ts
~~~

This command is a reproduction instruction; the recorded local result is128 initial plus4 later controls, with unchanged passed cases not rerun for bookkeeping. Vitest JSON evidence was counted from assertionResults.status, not the version's misleading header totals for filtered tests.

Registration and quality used the original required token-manifest writer/checker, bash syntax check, original frontend/backend registration guards, scoped ESLint, pnpm validate:all and the original web build. No dependencies or lock versions changed.

The isolated HTTP probe used real JWT verification and DB hydration, original attendance:admin RBAC and organization admission, and the original calculation timeline SQL. It asserted exact200/403/401 bodies for authorized full timelines, platform-admin foreign organization, delegated foreign organization, missing grant, inactive organization/account, disabled namespace and anonymous requests. Provider IO was refused. Probe source and raw logs are preserved in the task's isolated evidence directory; the published digest summary identifies that exact bounded run.

## Retained failures and limits

The initial isolated-PG start hit an overlong local socket pathname before database creation; a per-process TCP-only launch fixed that test environment. Successful migration/list evidence was preserved. A renamed log-path lookup stopped one controller after migration without executing HTTP. Subsequent probe assertions passed but the process remained alive: mixed temporary ESM/CJS imports created separate message-bus/pool instances. The harness was corrected to one core loader graph plus existing shutdown/close APIs and a zero-referenced-import-timer assertion. The final probe exited naturally0 and stopped its own cluster. No business source, assertions, timeouts or database guards changed.

The only post-test runtime delta was a three-reference local boolean rename from active to mounted to avoid a prop name collision. Original test and mutation phases remain explicitly versioned. The ESLint JSON parser's pnpm-footer failure was fixed without rerunning its successful baseline.

Three Mac headless native-menu keyboard attempts left selectedIndex0. They are retained as failed automation observations, not a confirmed application defect or a passed keyboard/humanAT gate. The supported native-select automation API then qualified application selection and downstream rendering. Native-menu keyboard behavior and human assistive-technology acceptance remain open.

OFF full body differs in the existing randomized locale-time datalist IDs; the full document also includes the new scoped static stylesheet. Raw scoped DOM and all API request multisets passed without normalization. The diagnostic random-ID comparison is not used as a normalized gate.

No Ready/merge/deploy/R71/tag/release/business configuration change. Stream/lifecycle OFF; real UAT and business50004 excluded; historical08PUT remains INCONCLUSIVE. Whole parent/allactor, owner/manual/live acceptance and frozen TRANSFER gates remain separate.
