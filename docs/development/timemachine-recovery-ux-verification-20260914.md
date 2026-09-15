# Time Machine Recovery UX Verification

## Current-Main Replay 2026-09-15

Local replay code `30a359631c9f7b534235e56a6c1ce687a4f3477f`, tree `9e914e5165212244f6b65c7ee99a1abc637a1b43`; ordered parents are original #5709 `478ed2da6cb22d5677a8f23f7df949f6b37b8b6f` and main `4bae83d67867b2e2d5e7e318ae89597184a291e3`. Fresh isolated replay worktree preserves the original frozen worktree. True merge is conflict-free, with no manual resolution. All 47 original candidate paths are byte-identical after replay; relative-main remains exactly those 47 paths, no unexpected files.

On this replay: ten direct frontend files 241/241 PASS; required-web exits 0, all groups pass (last group 456 files/6741 tests; overlapping groups are not summed). Web application vue-tsc and core tsc PASS; OpenAPI parity PASS; official frozen/live package provenance equal; diff-check PASS. The new sheet-trash spec remains in both domain guard and required-web (the latter uses its basename filter). No product edits, new mutation, DB run or browser/UAT claim in this replay. Prior exact-SHA DB/browser/mutation evidence remains scoped to the entries below, supported by the byte-equivalence proof, not relabeled as rerun. Logs `/private/tmp/tm-ux-replay-{web,required-web,openapi}.log` are local evidence only. Publication targets the existing Draft #5709 by ordinary fast-forward; fresh remote CI is required. No Ready/merge/flag/dispatch/deployment.

## Exact Code and Release Boundary

- Main baseline: `c13e40769690a4ed51b3f3a7ac2f8026638f3e88`.
- Carried configuration-history Draft: #5704 at
  `e92e462b84e74aa242382c2f31eab326ceb60854`, retained by true merge.
- Recovery code commit: `6f035bdb60560b63ffb30c14db0a6fdf89af905f`.
- Code tree: `6ff6959d51b10660c9acccb3f74c1dbc134c34b5`.
- Branch: `codex/timemachine-recovery-ux-20260914`.
- Recovery commit: 28 files, +2442/-132. Relative to main, the code candidate
  includes 35 files, including the earlier configuration-history evidence.
- This report and screenshots are a report-only child, not additional runtime code.
- Publication is Draft/HOLD only. Remote exact-head CI and merged-main evidence
  are NOT claimed by this local report. No Ready, merge, flag change, dispatch,
  staging, deployment, real tenant, production or permanent-delete operation.

## Delivered Surface

| Surface | Recovery object | Authority and evidence |
| --- | --- | --- |
| Recycle bin | Whole soft-deleted table | New permission-filtered list; existing lifecycle restore writer; retained records/fields/views, last-sheet empty-base recovery |
| History | Current deleted record | Historical before-side display; current server tombstone lookup; explicit confirmation and matching record/sheet reply |
| Configuration history | Field/view/permission/table-setting definition | Readable action/name/order/diff; existing server preview/execute and undelete gates, no fabricated field values |
| Time/actor | Viewer-local time; available actor name | Browser timezone and selected UI locale; honest ID fallback; no assumed production setting |

Record details remain limited to the current two-layer-visible field metadata and
server-masked values. Missing details are indicated. Row recovery does not use the
live-version restore API. Purged tables and unavailable tombstones cannot be
re-created by this change. Config undelete may remain disabled by the existing
server flag; this UI reports the refusal without enabling it.

## Local Gates

| Gate | Result |
| --- | --- |
| Four parent frontend specs | 137/137 PASS: API client, table recycle bin, config history, sheet-delete workbench |
| Five history/record frontend specs | 71/71 PASS: inline diff, record trash, modal migration, current-field wiring, pinned deep link |
| Required web script | Frozen code PASS, all groups; final group 456 files / 6699 tests. Groups overlap, so counts are not summed as distinct tests |
| Backend TypeScript | PASS, `pnpm --filter @metasheet/core-backend exec tsc --noEmit` |
| Web application TypeScript | PASS, `pnpm --filter @metasheet/web exec vue-tsc --noEmit -p tsconfig.app.json` |
| New/changed component and composable lint | PASS after replacing a constant-condition pagination loop; no rule suppression |
| OpenAPI | Official build/guard/validate PASS; parity 1/1 PASS; four generated artifacts deterministic |
| CI selector union | Existing path/test tokens preserved; new table-trash spec in both multitable guard and required-web |
| Sealed provenance | Official live/frozen comparison differenceCount=0; no pin edits; complete 11-file S5 chain PASS |
| Diff | `git diff --check` PASS |

The OpenAPI parity test already expected a closed field-type enum but omitted the
pre-existing `duration` member. Its expected list was aligned with the existing
runtime/source enum; no field capability was added.

The full web project typecheck previously encountered the existing Vite dependency
typing conflict; the application tsconfig above is the verified scope. Broad
targeted lint also observes baseline errors outside the changed logic: the API
client's existing unused comment-reaction import, config spec escape warnings,
and an existing backend-route semicolon. This is not a repository-wide lint PASS.
No dependency/lockfile change or unrelated lint cleanup is included.

## PostgreSQL Authority

Dedicated disposable PostgreSQL 15, synthetic fixtures only:

- Fresh full migration stream: 402 migrations applied; second replay no-op.
- CI-matching Node 20 combined run: 5 files, 68/68 PASS, zero skipped tests.
- `multitable-dangling-link-repair-realdb.test.ts`: 30/30, including the new table
  list. Covers lifecycle vs record-write authority, explicit read deny, group/role
  precedence, cross-base cursor rejection, protected sheets, Unicode normalization,
  list pagination, soft-delete/restore fidelity and repeated restore.
- `multitable-record-recycle-bin.test.ts`: 10/10.
- `multitable-conditional-rule-trash-realdb.test.ts`: 6/6.
- `multitable-undelete-config-realdb.test.ts`: 16/16.
- `multitable-tombstone-field-rehydrate-revision-realdb.test.ts`: 6/6.
- After mutation restoration the same combined suite passed 68/68 again.
- Fixture base/sheet prefixes: zero; other database connections: zero. Dedicated
  database dropped; database-prefix and backend residue zero; dedicated PG stopped
  and its port had no response. No shared/customer DB was used.

These are real SQL/Express route tests with controlled test identity injection,
not a real-login browser UAT. Initial runs under the machine-default Node runtime
had one transient route refusal and one connection reset in existing neighboring
tests. Isolated checks and two combined runs under installed Node 20 passed. The
observations are retained locally; runtime causation is not claimed.

## Discriminating Checks

| Changed guard | Counterexample |
| --- | --- |
| SQL vs shared permission/People normalization | Old whitespace normalization: two real-DB failures, then canonical ECMAScript trim parity GREEN |
| Lifecycle list admission | Replacing lifecycle authority with record-write: unauthorized list returned 200 instead of 403; restored GREEN |
| Table/config dialog scope | Neutralized generation guards: four stale-response cases RED; restored combined 61/61 GREEN |
| Table page/restore coordination | Red-first additions: confirmation remained enabled during load-more, retry lost its cursor, list permission copy was wrong; three RED then 16/16 table tests GREEN |
| Record restore identity | Missing/mismatched restored ID/sheet never becomes local success; same-ID old-finally cannot clear a newer operation |
| Current tombstone selection | Historical ID absent from current pages remains unavailable; later-page matches can be confirmed; hidden fields remain excluded |
| Record pagination coordination | Deferred restore blocks page load; deferred page load blocks restore; late closed/reopened replies ignored |

## Browser Evidence

Real Vue components in a local Vite preview with explicitly synthetic API replies.
Chromium checked 1440x960 and 390x960: table confirmation/cancel/success, current
record details and restore, readable deleted-field configuration, disabled config
undelete refusal, zero page errors and zero dialog horizontal overflow. Viewer
timezone checks covered Asia/Taipei and America/New_York with different correct
local display times for the same server timestamp.

The first sandboxed browser launch failed before any page load with macOS Mach-port
permission denial. The bounded unsandboxed local Chromium run then passed. This
does not stand in for browser -> authenticated backend -> PostgreSQL acceptance.

Screenshots: `artifacts/timemachine-recovery-ux-20260914/` contains desktop/mobile
table restore, history, record restore and configuration history images, all
synthetic. The local harness is in the worktree's ignored `apps/web/tmp/`; screenshots
are presentation evidence, not a new required-browser CI lane.

## Review Provenance

- Sol implemented backend authority and tests. A separate Sol read-only reviewer
  found the two Unicode normalization issues, independently reproduced/fixed by
  the coordinator; final backend-only review: 0 P1/P2/P3.
- Terra implemented record-history UI/composable/tests. Coordinator reviewed and
  added final pagination/restore serialization and stale-response checks.
- Claude CLI `fable` resolved to `claude-fable-5-1` for an actual bounded read-only
  table-trash/client review. Pagination coordination/retry/copy and identity test
  gaps were addressed with red-first tests. Its suggestion about the pre-existing
  general restoreSheet client method is outside this modal's validated scope.
  No unreturned or unexecuted external review is counted as approval.
- Coordinator final scoped review: no known P1/P2 in this recovery delta. Kimi/Grok
  installation checks are not review evidence. No model changed flags or remote
  PR state. Earlier #5704 reports remain historical SHA-bound evidence.

## Operational Notes

Dependencies were reused through ignored worktree symlinks. OpenAPI tooling used
the already-installed SDK dependency tree. The initial full S5 run could not find
the existing `mssql` package; resolving that installed package with temporary
NODE_PATH yielded all 11 files PASS, without install or lock changes.

Local logs are under `/private/tmp/tm-recovery-*-20260914.log`; they are session-local
and not remote CI artifacts. GitHub checks on the publication head must be observed
independently before any later owner-authorized merge.

## Current-Main Replay: 2026-09-14

This section supplements the original checkpoint above; it does not rewrite its
base, test counts or browser-evidence boundary.

- Existing Draft PR: #5709.
- Previous published head: `d824103bfcb7c2b2e0857f0de4d6e7e982ded3a8`.
  Its remote checks reached 28 SUCCESS and 1 intentional Strict E2E SKIPPED,
  with zero pending/failure. These results belong to that old head only.
- Replayed main: `7e74936dc5734d98f2acebfcc737120febafc530`.
- True-merge code head: `cdde5df52223263fa16ee76812d7335b81b978e9`.
- Code tree: `d36f9b97c8bd8df257ea7cc6e50c64e36150f366`.
- Ordered parents: previous published head first, replayed main second.
- Only manual resolution: the declaration conflict in
  `apps/web/tests/multitable-workbench-sheet-delete.spec.ts`. All three captures
  for table trash, record history and field manager are retained. Runtime files
  merged automatically, preserving main's managed-field refusal and localization.
- Relative-main scope before this report appendix: the same 44 files,
  +2994/-161. No new recovery capability or restore writer change in this replay.

### Replayed-Tree Gates

| Gate | Result |
| --- | --- |
| Recovery/client/workbench frontend | 8 files / 211 tests PASS |
| Managed-field guard, permission matrix, audit neighbors | 3 files / 113 tests PASS |
| Required web script | All groups PASS; final group 456 files / 6721 tests; groups overlap |
| Core TypeScript and web application tsconfig | Both PASS using installed Node 20 |
| OpenAPI parity | 1/1 PASS; source/generated files byte-identical to previous published head |
| Selectors | plugin-tests, multitable web guard and required-web byte-identical to previous published head; no lost selectors |
| Provenance | Main's pin retained byte-for-byte; official six-section live/frozen differenceCount=0 |
| Sealed export | Full 11-file S5 chain PASS |
| Diff and review | Diff check PASS; independent Luna read-only replay review: zero P1/P2 in the examined union |

Fresh isolated PostgreSQL 15: all 402 migrations applied, second replay no-op.
The original five recovery suites plus `multitable-config-history-api-realdb.test.ts`
passed 6 files / 77 tests with zero skips on Node 20. This includes actor-name
enrichment and permission-filtered history alongside table/record/config recovery.
Fixture base/sheet prefixes and other connections were zero; the exact disposable
database was dropped, database/backend-prefix residue was zero, and the dedicated
PG was stopped with no response on its loopback port. No shared database was used.

Luna ran no tests or writes; the coordinator ran the gates above. No old mutation
result is relabeled as a new mutation run. New remote exact-head CI remains a
separate post-push gate. This appendix is a report-only child of the merge code
head; it grants no Ready/merge, flag, dispatch, deployment or production authority.

## History Request-Lifetime Fix

- Code head: `8a55e082cfda598b138f1e7bb1249c5f08f893b3`.
- Code tree: `98efd303b723dc4ccdd1c7075a0e5f515f02f017`.
- Parent: `947eaa44b16553aae5d10d690c3a2020125e1a48`.
- Replayed main remains `7e74936dc5734d98f2acebfcc737120febafc530`.
- Exact code delta: six frontend files, +499/-32. No backend, migration,
  OpenAPI, selector, package, provenance pin or restore writer changes.

The completion audit found stale configuration-list results after filter/scope
changes and analogous history list/page/detail/pin races. Generation checks now
cover success, catch and finally; close/unmount/scope invalidation handles an
away-and-back scope as well. Pin-only navigation does not reload the normal list
or collapse its expanded row. Existing record recovery relay remains unchanged.

### Final Local Gates

| Gate | Result |
| --- | --- |
| Recovery/history/config/trash neighbors | 11 files / 188 tests PASS on Node 20 |
| Required web | All groups PASS; final group 456 files / 6740 tests; overlapping groups not summed |
| Actual required collection | Updated workbench 26/26, history composable 16/16 and pin modal 6/6 present in required-web output |
| Web application typecheck | `vue-tsc --noEmit -p tsconfig.app.json` PASS |
| Six-file ESLint | Zero errors; nine multiple-component warnings in the workbench test's capture-stub pattern |
| Browser | 1440px and 390px Chromium PASS: table confirmation/cancel/restore, deleted-record details/restore/return, config display/refusal; zero page errors or horizontal overflow |
| Timezones | Asia/Taipei and America/New_York display assertions PASS |
| Source boundaries | Backend, plugins, workflows and required-web script byte-identical to parent |
| Diff | `git diff --check` PASS; all mutations restored |

Red-first configuration tests: six failures. Neutralizing its request guard
reproduced six failures; neutralizing scope invalidation reproduced two failures.
History red-first: five failures; the initial four-family mutation produced four
failures. Review-added stale page/detail/pin catch/finally negatives produced five
failures when those guards were removed. Making pin-only changes reload the list
produced one exact failure. All were restored; the final two-file restoration run
passed 22/22. Production hashes after the last restoration:

- HistoryCenterModal: `396596e09241fe1aa3857ec22d761d03aa9f0b86338d7488ae2168c9b4730b41`.
- useHistoryCenter: `c4d95fe114587b85744f11f65e64ad602d094a52e65f6b78017b6c68c4f7e001`.
- MultitableWorkbench: `0cddbd2302a6aeb23f439a48aa1e0f988c498ad733fce3631c62bd74dd10dd48`.

Terra implemented the four history-owned files; the coordinator implemented the
two configuration-list files. Sol high independently reviewed the frozen six-file
production delta: zero P1/P2. Sol ran no tests. Its requested stale-rejection,
pin-loading, list-independence and observed-close coverage was added and mutation
verified by the coordinator. No external reviewer remained running.

### Failed Attempts and Evidence Boundaries

One expanded run overlapped required-web and typecheck: its unchanged
`multitable-workbench-history-field-scope-wiring.spec.ts` timed out during its
dynamic Workbench import, followed by a missing-chip failure (181 PASS / 2 FAIL).
The identical 11-file command, after competing heavy tasks ended and before new
edits, passed 183/183. With the five additional negatives it passed 188/188; the
final required-web run also passed. No timeout was increased and no neighbor
assertion was weakened. The failed attempt is retained, not erased as a pass.

Chromium's first sandboxed launch failed at macOS Mach-port registration before
tests. The same scoped script outside that sandbox passed. Screenshots and log
under `/private/tmp/tm-history-race-browser-20260914*` are synthetic component
evidence, not authenticated browser-to-DB UAT. The viewer preview runs on loopback
only; no backend, production or customer data was accessed.

The six-file fix leaves the prior 402-migration replay and 6-file/77-test real-DB
code byte-identical; these are reused prior-checkpoint results, not a new DB run.
Local logs use `/private/tmp/tm-history-*-20260914.log`. This report appendix is
documentation-only relative to the code head above. Fresh published exact-head CI
is still a separate gate; no Ready, merge, flag, dispatch or deployment is granted.

## Current-Main Replay: 2026-09-15

- Previous published head: `3ffb95b23a0021fce281f7c529f98c1e643419fc`.
  Its 28 SUCCESS / 1 intentional Strict E2E SKIPPED and all 13 protected checks
  are prior-head evidence, not validation of this new replay.
- Incoming main: `a7128c2f187f90e595fc93afa70c712e17031589`.
  Since the previous base, it contains three stock-prep commits from #5721,
  #5720 and #5722, affecting 17 plugin-integration-core files.
- True-merge code head: `6346a0eddfc7d3209e352211d0aec52ad7b916cf`.
- Code tree: `02d5acaad177916863b26c0b906a93befcb86c12`.
- Ordered parents are the previous published head first, incoming main second.
- No conflicts or manual resolutions; `git show --remerge-diff` is empty.
  All 47 TM-owned paths are byte-identical to the previous published head;
  all 17 incoming-main paths are byte-identical to main. Their intersection
  is empty. No extra runtime, dependency, workflow or migration edit occurred.

### New Replay Gates

| Gate | Result |
| --- | --- |
| Recovery/history/config/trash neighbors | 11 files / 188 tests PASS |
| Required web | All groups PASS; final group 456 files / 6740 tests; overlapping groups not summed |
| Web application typecheck | `vue-tsc --noEmit -p tsconfig.app.json` PASS on Node 20 |
| Incoming plugin neighbors | 10 files PASS, including MVP persist/repair routes, provisioning, target-field probe, sync-run persist, runtime persist and HTTP routes |
| Sealed export | Complete 11-file S5 chain PASS |
| Official provenance | Main's pin retained byte-for-byte; frozen/live differenceCount=0 |
| Synthetic browser | 1440px and 390px table/record recovery, deletion details and config refusal PASS; zero page errors/overflow |
| Viewer timezones | Asia/Taipei and America/New_York assertions PASS |
| Diff | `git diff --check` PASS |

Main's two changed pin values cover stock-prep sync-run persist and plugin HTTP
routes. Neither recovery code nor its selectors required a pin refresh. All
OpenAPI, core recovery routes/tests and migrations remain byte-identical to the
previous candidate. Therefore the earlier 402-migration replay and 6-file/77-test
isolated PostgreSQL results remain explicitly reused evidence; no new DB run or
new mutation run is claimed here. The dedicated DB remains stopped.

Independent Luna high read-only review of the frozen merged tree: zero P1/P2
within this replay. It checked ownership/equivalence, test-chain and pin retention,
and the lack of changes to TM route/permission/restore contracts; it did not rerun
tests or certify all upstream stock-prep functionality. The coordinator ran the
gates above. The reviewer session was closed.

Session-local logs and fresh browser images are under
`/private/tmp/tm-current-main-replay-*-20260915*`. Synthetic component screenshots
are still not authenticated browser-to-database UAT. This appendix is a separate
report-only child of the merge code head. New published-head CI must be observed
after ordinary push to the existing Draft #5709. No Ready, merge, auto-merge,
flag, dispatch, deployment, production or real customer data action is authorized.

### Same-Window Main Advancement

Before push, main advanced once more through #5712. The preceding replay and its
report child `0c6285aa0db4cb9f0fef79c73558121807963c61` were kept locally, not
published as a current-main candidate. No force update or history rewrite occurred.

- New exact main: `c6f2d437a8810a822fb4210976aaf6af9ed3af74`.
- Final true-merge code head: `3134d8762827adbae3fc7ae6a2253c93fff2ea45`.
- Code tree: `a88502714619d7e5a5c9eb2bf2d8276e7c10a086`.
- Ordered parents: `0c6285aa0db4cb9f0fef79c73558121807963c61`, then new main.
- Incoming delta: eight files for network/no-response versus HTTP gateway copy,
  their tests and required-web enrolment. The only common path was required-web.
  The merge was automatic with no conflicts or manual resolutions. The other
  seven incoming files exactly match main; all TM-owned non-shared blobs match
  the preceding candidate.
- Required-web preserves both parent token sets, including bare-basename filters.
  The network-copy whole-file token and `multitable-sheet-trash` both remain.
  Independent review also checked selector multiplicities with zero loss/extra.

Fresh gates on this final code tree:

| Gate | Result |
| --- | --- |
| Recovery plus network-error neighbors | 15 files / 264 tests PASS |
| Backend network-copy CI wiring | 1 file / 7 tests PASS |
| Required web | All groups PASS; final group 456 files / 6741 tests |
| Web application typecheck | PASS on Node 20 |
| Synthetic browser and timezones | Both viewports and timezones PASS; zero page errors/overflow |
| Official provenance | Frozen/live differenceCount=0 |
| Diff and merge resolution | Diff check PASS; empty remerge-diff |

Luna high separately reviewed this new frozen delta: zero P1/P2. Restore POSTs
still have no automatic retry; error codes/status and current failure state remain
intact without emitting recovery success. HTTP gateway wording is preserved.
The reviewer performed no tests/writes/network access and was closed. Prior
plugin/S5 and real-DB gates remain scoped to their byte-identical modules; no
second DB or new mutation execution is claimed.

Logs and synthetic screenshots use `/private/tmp/tm-current-main-replay2-*`.
The new main's long CI was still pending, with no observed failure, during local
verification. Neither it nor fresh published-head CI is claimed terminal by this
report. Publication remains an ordinary push to Draft #5709 only, without Ready,
merge, flag, dispatch, staging, deployment, production or customer-data operations.
