# ACP-1B full-application synthetic acceptance

Status: final combined code tree `a08ebc39e300994ad022f19f1918e19162d6b5ce`
passes local full-application synthetic acceptance. Draft/HOLD publication and
its own natural exact-head CI remain pending. No deployed or real-data UAT claim.

## Current final-tree evidence (2026-09-08)

- Remote dependencies were read serially before this verification: #5564 OPEN
  Draft at `10f12e5ae41534e053af0900075d86897ea0762a`; #5559 OPEN Draft at
  `5f006a9e0cc4ba5dce2e7f2b77495f0452cf3ada`. Product dependency #5564 has
  terminal 25 SUCCESS + 1 SKIPPED, zero pending/failure. These are dependency
  checks, not this acceptance PR's checks.
- Remote main is `2366157fc13ff2b011a519eb0956a1fe7927aad2`; its intervening
  stock-prep documentation delta does not overlap this acceptance scope. Fresh
  open-attendance PR search still identifies #5559 as component acceptance and
  #5145 as the separate owner-held session-org picker, not duplicate full-app work.
- Final worktree: `/private/tmp/codex-attendance-full-app-final-20260908`.
  True merge `d31913669e9a20c3681fd3924a5b5920c6ed0695` has first parent exact
  #5564 above and second parent exact #5559 above. There was no rebase/conflict.
- Exactly THREE old full-app checkpoints were consolidated, not four:
  `99a6beb878b4bd45dc5ae05df2df48d318666ba1` ->
  `a0a6fa92d3a514c1ae303d57af8903bc7731a62c` ->
  `c04e35b007f5359a452d06c34896e462f7f2299e`.
  Range-diff explains the squash; all three resulting full-app files at
  `a08ebc39e300994ad022f19f1918e19162d6b5ce` equal the old final tree byte-for-byte.
- Actual stacked PR delta relative to #5564 is six added paths: frozen component
  runner/fixture/MD plus new full-app runner/fixture/MD. No third dependency PR.
- Exact #5564 byte-equivalence was checked individually for all eight paths:
  `plugins/plugin-attendance/index.cjs`,
  `plugins/plugin-attendance/lib/attendance-record-read-identity.cjs`,
  `packages/core-backend/tests/unit/attendance-record-read-identity.test.ts`,
  `packages/core-backend/tests/integration/attendance-plugin.test.ts`,
  `docs/development/attendance-record-read-tenant-verification-20260908.md`,
  `packages/core-backend/tests/unit/w7-w6r5-guard/classification.ts`,
  `packages/core-backend/tests/unit/attendance-w7-w6r5-preservation-guard.test.ts`,
  `packages/core-backend/tests/integration/attendance-w4c3a-p09-p10-p24-routes.db.test.ts`.
  Frozen component runner/fixture/MD also each match #5559 exactly.
- On final code SHA `a08ebc39e300994ad022f19f1918e19162d6b5ce`, Node20 positive
  invocation exited 0 with BASELINE_PASS and databases/backends/ports all zero.
  Evidence: `tmp/acp-full-42efd2f6d58a4ddab3ab2581bd9cc565/` in this worktree.
  Actual `narrow-review-section.png`, `desktop-denied-section.png`,
  `narrow-canonical-report.png`, `narrow-grid-consumed.png`, and
  `narrow-custom-retained.png` were visually inspected: explicit review controls,
  clear refused-confirmation state, Normal result, cleared proposal fields and
  retained custom content are visible. Screenshots contain synthetic values and
  remain local; they are not customer data or values-free diagnostic logs.
- Identity/proposal unit suites pass 68/68; inherited-config runner typecheck
  exits 0; diff-check passes. No new product or shared-surface edit was made.
- Disconnect-apply on that same code SHA deliberately exits 1 at
  APPLY_HTTP_STATUS (404), full pre-apply snapshot unchanged, source-seed
  diagnostic PASS, cleanup all zero. Evidence:
  `tmp/acp-full-3de1c4771d284df880d366613b7a8b9c/`.
- Foreign-tenant on the same code SHA deliberately exits 1 at APPLY_HTTP_STATUS
  (403 / ATTENDANCE_CLEANING_FORBIDDEN), full snapshot unchanged, source-seed
  diagnostic PASS, cleanup all zero. Evidence:
  `tmp/acp-full-011d890a61724cfcb055c5a0d1e24dfb/`.
- Response-timeout on the same code SHA deliberately exits 1 at
  response-timeout-control, fixed ACCEPTANCE_ERROR diagnostic, browser faults
  empty and cleanup all zero. Evidence:
  `tmp/acp-full-e1f8937fdc874c37a8a6b959ae605e69/`.
- Final evidence update changes only this MD; executable runner, fixture and
  dependencies remain the exact positive/negative-tested code bytes above.
- Custom-wipe mutation below is retained historical RED evidence, not a claim
  that it was rerun on the new SHA. Its owning cleaning-authority module is
  byte-identical between the historical mutation baseline and this final tree.

The single-org login is real and tenant-bound. This does not implement or verify
the separately owned shell organization picker (#5145); it verifies current
attendance organization context and rejects a foreign organization selection.
Raw punch and leave/travel facts are not freely rewritten: this ratified slice
reviews eligible daily anomalies and applies the existing normal correction.
The historical ledgers below retain failed runs and earlier pending states;
this section supersedes their topology and local-verification status.

## Earlier local acceptance checkpoint (historical)

- Runner source checkpoint: `16f09dae6` (three-file workstream; prior failures retained).
- Combined verification checkpoint: `300b9bed5` (full SHA available from Git).
- Node 20.20.2 real-app invocation exited 0 with `BASELINE_PASS`, exact API refusal
  census PASS, and cleanup `databases=0, backends=0, ports=0`.
- Real UI login, sync-created projection/anchor, grid proposal, explicit review
  and apply, canonical Normal return, custom content after apply/resync, consumed
  proposal, stale-tab retry zero-write, foreign-record denial and revoked apply
  zero-write all executed. Setup actor had zero roles/global permissions and
  did not alter reviewer authority.
- Evidence directory in the combined worktree:
  `tmp/acp-full-2afc5b6926674de79844b0ef87ecef04/`.
  `narrow-canonical-cell.png` and `narrow-canonical-report.png` were visually read:
  the real Normal cell and Punch result heading are visible at 390px. The runner
  also checks the cell bounding box lies inside that viewport. Earlier desktop,
  narrow retained-custom and cleared-proposal screenshots were visually read.
- The preceding `7ecdbcfd2` replay failed on a non-unique result locator because
  two report fields can display Normal. It exited 1 and cleaned all owned state;
  selecting the first matching result cell resolves the test ambiguity without
  changing product layout. The `006425458` functional pass still had insufficient
  viewport screenshot framing; explicit element screenshot plus viewport bounds
  establishes the stronger evidence above. Neither earlier image is substituted
  for final narrow result evidence.
- Related unit suites `attendance-record-read-identity.test.ts` and
  `attendance-report-cleaning-proposal.test.ts` passed 68/68 on the combined tree;
  inherited-backend-config standalone runner typecheck passed at `3cca3c8c8`.
- Frozen product four-path bytes equal `48a613b9`, inherited component three-path
  bytes equal #5559 `5f006a9e`; combined worktree clean after verification.

This does not establish final-publication-tree CI, merge, deployment or real-data
UAT. The earlier Draft topology stacked on #5564 exact `6b69a88c`, true-merge #5559
exact `5f006a9e`, then carry these three full-app files: real PR delta six files,
three inherited and three new, with two unmerged dependencies.

## Strict API refusal census follow-up

Combined checkpoint `29be99a2e` reproduced the previously unclassified 404 as
`foreign-org-canary:attendance-holidays:404`; all unknown route shapes were empty.
The invocation exited 1 with `UNEXPECTED_API_FAILURE` and cleanup reported zero
owned databases, backends and ports. This failure is retained, not reclassified as
a passing run. Source inspection shows GET `/api/attendance/holidays` invokes
`resolveAttendanceGroupRouteActorContext` before data queries; an organization
selector differing from the authenticated organization returns exactly
`{ ok: false, error: { code: 'NOT_FOUND', message: 'Group not found' } }`.
The successor runner awaits that specific foreign-org UI request and asserts the
complete refusal payload and 404 status. Only that route/stage/status is allowed
by the census; the primary foreign record request still requires 403 and no canary.
No runtime or authorization policy was changed.

Successor combined `1de25cb872b4dddcbce125bc58b470f217af6d29` passed the full
functional run, exact refusal census, custom preservation after apply/resync,
stale-tab zero-write and revoked/foreign controls (exit 0, cleanup all zero).
Source checkpoint was `f9c9fe24f`; standalone inherited-backend-config TypeScript
check and diff-check passed. Screenshots are retained under
`tmp/acp-full-bc29d8840be341c7a372235f88c606ee/` in the combined worktree.
Visual inspection confirmed the desktop canonical Normal row, narrow custom
content and cleared proposal fields. The narrow canonical screenshot framed a
summary rather than the record after viewport reflow; the successor explicitly
scrolls the actual Normal cell into view after resizing. Final publication-tree
replay and final screenshot review remain pending; no overall completion claim.

## Exact baseline and dependency

- Fresh remote main: `17173f639399476434db5a214a1aa3bdcf5f09e1`.
- Frozen component acceptance dependency: PR #5559,
  `5f006a9e0cc4ba5dce2e7f2b77495f0452cf3ada`.
- Local true merge: `0a3a547dbbdd64eda344f2164e36274729b443d5`;
  first parent is the fresh main above, second parent is the frozen dependency.
- The dependency introduces exactly three files, byte-equivalent to #5559.
  No product delta or old stacked product branch was imported.
- #5559 is not merged by this local integration and remains independently frozen.
- This is a manual local synthetic acceptance lane, not required CI or production UAT.

## Authorized incremental files

1. `scripts/attendance/acceptance/acp1b-full-app-realdb.mts`
2. `scripts/attendance/acceptance/acp1b-full-app-realdb-fixture.mts`
3. This document.

Inherited test assets must remain unchanged. Runtime/shared/permission changes
require a new exact scope decision if a real application failure establishes a gap.

## Product contract and real application path

Reuse ratified ACP-1B OD-ATC-11R(a), OD-ATC-12A(a), and W4. Editable projection
values cannot select a canonical target. Server-owned anchors, DB-fresh actor
authority and concurrent-version checks remain authoritative. A proposal is not
raw attendance-table write access.

The audited existing path is LoginView -> AttendanceExperienceView ->
AttendanceAdminCenter -> AttendanceView -> AttendanceReportFieldsSection ->
report-record synchronization -> popup MultitableWorkbench -> MetaCellEditor ->
multitable patch -> attendance cleaning review -> explicit apply confirmation.

The current shell does not have an organization picker. AttendanceView has an
organization ID input initialized from the authenticated tenant. Acceptance uses
a single-organization login and verifies tenant equality; editing this input
must not grant access to another organization. Open PR #5145 already owns a
separate session-organization switcher; this work does not duplicate it.

## Acceptance requirements

- Seed only a fresh synthetic login identity, necessary existing authorization,
  and canonical/prior calculation baseline. No precreated projection, anchor or
  proposal; no dev-token injection and no API response fulfillment.
- Type credentials in the actual LoginView, then navigate the real application.
- Synchronize from the attendance UI and verify the actual server creates the
  projection and anchor. Open its popup through the real report-table link.
- Save the proposal through actual grid editors and the real multitable API.
- Before confirmation, canonical state and application effects remain unchanged.
- Apply uses the closed expectedVersion request; success produces exactly one
  correction with the expected canonical result and preserves custom content.
- Return to attendance and the table; distinguish visible UI evidence from
  supporting API/DB assertions. A consumed notice alone is not result-content proof.
- Repeat/failed submissions, revoked membership and foreign-tenant requests must
  not produce unauthorized or duplicate writes. Preserve discriminating mutation
  failures instead of converting them into skip/success.
- Exercise desktop and 390-pixel narrow layouts with screenshots. Record real
  viewport failures rather than substituting a component-only harness.
- Use Node 20 and a newly owned nonce PostgreSQL cluster with dynamic loopback
  ports, restricted networking and bounded cleanup. Verify zero owned residue;
  never stop the shared PostgreSQL instance.

## Evidence ledger

This table is the initial checkpoint ledger. Later dated/checkpoint sections,
especially Final publication candidate below, supersede its pending statuses;
earlier failures remain preserved as historical evidence.

| Requirement | Current evidence |
| --- | --- |
| Fresh main / open attendance PR audit | Complete; no duplicate full-app cleaning PR found |
| Dependency topology / inherited byte equality | Complete; exact three-file diff is empty against #5559 |
| Real route and grid write chain | Runtime basic path proven on combined 1bbf1efd; custom extension pending |
| Login / sync / grid proposal / apply / return | Basic path PASS; not full acceptance |
| Negative controls / mutation / repeat | Foreign canary and revoked zero-write PASS; response timeout RED with cleanup PASS; remaining controls pending |
| Desktop / narrow screenshots | Basic screenshots exist and partial visual review; final framing pending |
| Focused gates / cleanup residue | Basic invocations cleanup0; one runner defect required explicit owned recovery, recorded below |
| Draft/HOLD publication / exact-head checks | Pending |

No persistent feature enablement, workflow dispatch, deployment, customer data,
production access, Ready transition or remote PR merge is authorized here.

## Initial runtime evidence (not completion)

The first Node 20 run entered the real Admin Center after a successful UI login;
observed API responses were 200 and browser page errors were absent. It failed
at the test's organization-input locator: the input is present in Reports mode,
not Admin mode. The runner now verifies the Admin page's visible scoped project
against the login JWT tenant. The original failure screenshot is retained in
`tmp/acp-full-731f21f08f2b4277b021a678b4741ace/failure.png`.
Cleanup reported zero owned databases, backends and ports. No product code was
changed to accommodate this test-locator correction.

Three subsequent carrier failures localized a checkbox test interaction issue:
the real boolean editor confirms on native change and immediately unmounts.
The runner's `setChecked` postcondition tried to inspect the unmounted input.
It now performs a native click and requires both the actual patch response and
the persisted database value. No runtime change or permission grant was needed.

The next two runs reached actual UI confirmation after real login, successful
non-degraded sync, popup grid rendering, and persisted reason/request edits.
Both returned HTTP 503; the diagnostic run identified
`ATTENDANCE_CLEANING_UNAVAILABLE`. The complete canonical/projection/effect
snapshot was unchanged after refusal, and every run reported cleanup with zero
owned databases, backends and ports. This is an unresolved apply-path failure,
not full-loop acceptance. Some background UI requests also returned 403 and
still require endpoint-level classification; they have not been waived.

Custom-field UI creation is not currently covered. The test actor has no schema
management permission, and none has been added to make acceptance pass. The
component dependency's custom-value DB preservation evidence remains separate
from this full-application test's outstanding requirement.

### Apply failure localized and resolved in the runner

A read-only diagnostic of `readAttendanceCleaningSourceSeed`, after the refused
real HTTP operation, showed actor checks succeeded but sheet-scope lookup had
only one row. The existing authority requires both the report-field catalog and
report-record sheets. The runner had omitted the actual **Sync catalog** UI
operation. Adding that existing operation, with its real HTTP and availability
assertions, resolved the 503 without any product change or direct schema seed.

Run `acp-full-7f3c3c49949e471abe3fa20ff015b54b` passed the actual apply assertions:
canonical status normal; exactly one edit, completed cleaning operation,
manual-override calculation and internal event; zero notifications; proposal
requested=false and reason=null. Its `narrow-consumed.png` is retained. The run
then failed while preparing the later revocation control because the record
inspector covered the narrow grid. The runner now uses the inspector's existing
close button before further grid editing. This run is partial evidence, not a
complete pass; earlier carrier failures remain part of the record.

### Baseline and blocking foreign-organization negative

The actual narrow Inspector path subsequently passed: wait for selected-record
deep-link hydration, edit through its existing controls, require real patch 200
and persisted values. Revocation confirmation returned 403 with an unchanged
full snapshot. A further baseline also rendered the corrected single record as
Normal in the real Reports page, with desktop and narrow screenshots.

**P1 / STOP: synthetic cross-organization disclosure reproduced.** Under the
coordinator-approved scratch-only canary extension, a second synthetic user and
organization were created. The login actor received no membership or new grant.
The real Reports UI selected the foreign organization and canary user. Its
records response was HTTP 200 with one row whose ID equaled the canary record.
Values-free evidence: `foreignStatus=200`, `foreignRows=1`, `canaryVisible=true`,
`loginHasForeignMembership=false`. The runner fails at `FOREIGN_CANARY_DISCLOSED`;
this is not an empty-result/status-code difference and must not be waived.

Audited chain: `handleAttendanceRecordsGet` in attendance `index.cjs:30545` uses
`attendance:read`; `getOrgId` at line 6447 accepts the query organization ahead
of authenticated context. The other-user administrator check and SQL org/user
predicates do not establish membership in that chosen organization. An owning
route repair requires a separately bounded scope decision; no runtime change
has been made in this test-only branch. All canary data was confined to this
invocation's private database; final cleanup reported databases/backends/ports=0.

Full goal remains incomplete. Outstanding: repair and refute the demonstrated
isolation gap, repeat/mutation controls, custom-field coverage, final focused
gates, screenshots review, and Draft/HOLD publication.

## Separate tenant-read P1 repair and combined baseline

The discovered synthetic foreign-canary disclosure is repaired in separate
Draft/HOLD PR #5564, head `e1ae1a1875833083ad5d9c9d49cb340f8bca39ef`, base
`2794494f0258835911186fc976fa4f4089ed72c8`. It changes exactly five owning
product/test/document paths. Its runtime bytes are equivalent to the product
checkpoint used in combined `1bbf1efd27f86dac27e71a133c7a4ec1db7b40bf`.
That combined basic run returned foreign status403, zero foreign rows, no
canary match, real-login actor foreign membership0, and revoked apply zero
writes. This does not mean main or a deployed application contains the fix.

## Independent configuration actor and custom field extension

The coordinator approved only the original three full-app files. Existing
authority is POST `/api/multitable/fields` in `univer-meta.ts` ->
`resolveSheetCapabilitiesForAccess` -> `applyContextSheetSchemaWriteGrant` in
`multitable/permission-service.ts`. A direct `spreadsheet_permissions` grant of
`multitable:write` on the exact generated sheet supplies read+write and therefore
schema management on that sheet. This is existing behavior, not a new policy.

The isolated setup fixture creates a normal active same-org user, no global
permissions and no roles, and that one sheet grant. Real UI login and grid
entry succeeded. The first field locator clicked the unrelated column-visibility
menu; a screenshot distinguished it from the top-level field manager. Corrected
manager selection then produced real POST fields201 and one string custom
field. The setup context was closed and its direct grant removed/membership
revoked. The original review user's role/permissions/membership/sheet-grant
snapshot remained identical. No rights were added to make its edit succeed.

Review custom editing is still under verification. The far-right grid cell's
first click opens the Inspector over the second click, so the subsequent
revision uses the existing selected-cell Enter-key edit path. A stale second
real review tab and repeat synchronization checks have been added but have
not yet passed; their existence is not acceptance evidence.

## Runner lifecycle defect, recovery, and discriminating negative

On combined `38a573d0d`, a newly created response promise timed out before its
delayed await while custom editing was still pending. Node exited with an
unhandled rejection. **That invocation did not execute normal finally cleanup.**
Owner nonce `aa0b3850aed946a58d57071fc7c24a67`, postmaster PID79567,
`SHOW data_directory`, and its only `acp_full_` database were checked before
manual recovery. Only that synthetic database was dropped and that exact
private server was stopped; `pg_ctl status` confirmed no server. Its owner/log
directory was retained. The shared PostgreSQL instance was not touched.

All delayed response/popup waits now immediately capture settlement and rethrow
failure on explicit await; custom edit uses Promise.all. No global rejection
handler, swallowed acceptance failure, or success exit is installed.
Combined `3257f6620` exercised `response-timeout`: after owned DB/server/browser
startup, a100ms nonexistent-response wait rejects while a250ms local page task
is pending. Result: FAIL at `response-timeout-control`, exit1, followed by actual
finally `cleanup: PASS`, databases/backends/ports=0. This intentional delay is
the lifecycle fault injection, not arbitrary sleep used to make product data
appear. A separate custom-edit failure after Promise.all likewise completed
normal cleanup0. Preserve both failures and the earlier manual recovery.

## Custom + stale-tab + resync positive evidence

Combined `26c419245` (source `044fad4d41ea7b9a30158d1fdd6e83e5662c5bf3`)
completed with exit0. The real setup UI creates the custom field; the original
review actor writes it through grid keyboard editing with unchanged authority.
After explicit cleaning apply and again after real UI report-record resync,
the same projection record's same custom field retains its exact value.
Canonical correction effects remain exactly one.

A second actual review tab held the original reviewed version. Its confirmation
after first-tab success returned503 / ATTENDANCE_CLEANING_UNAVAILABLE (the
existing readSeed stale-version contract), with the full data snapshot unchanged.
Reloading that tab shows no remaining proposal. This is a reachable UI repeat,
not a manufactured API-only button. Resync requires re-entering the explicit
date/user controls after the earlier page reload; a disabled button was not
force-clicked. Foreign canary403/no rows/no leak and revoked apply403/zero-write
also pass in this same extended run. Finally reports databases/backends/ports0.

Remaining: discriminating product mutation controls, API-error classification,
final screenshot/content review, final gates, and a separate Draft/HOLD test PR.
No full acceptance or deployed fix is claimed.

## Earlier publication candidate (historical)

The preceding paragraphs are a chronological failure/progress ledger, not the
current acceptance verdict. Full functional positive acceptance now passes.

- Fresh main readback: `2794494f0258835911186fc976fa4f4089ed72c8`.
- Product dependency #5564: `6b69a88c8c2563c803bb831ee7bf35bc427759ef`, OPEN Draft.
- Component dependency #5559: `5f006a9e0cc4ba5dce2e7f2b77495f0452cf3ada`, OPEN Draft.
- Publication worktree: `/private/tmp/codex-attendance-full-app-delivery-20260908`.
- True dependency merge: `878347a486629082c5fbaf4bf8a23ffba9f7a5df`, first parent
  #5564 and second parent #5559, no conflicts or product changes.
- Full-app source consolidated from `38e2bbc9f7e350d5ed5c9c01102f25c2b3709afd`
  into `99a6beb878b4bd45dc5ae05df2df48d318666ba1`. Subsequent runner change
  captures the actual review/refusal section in addition to viewport screenshots.
- Relative to the intended #5564 branch base, exactly six files: inherited
  component runner/fixture/MD and new full-app runner/fixture/MD. All dependency
  product and inherited component bytes match their exact frozen heads.
- The actual publication-tree positive run at `99a6beb878b4bd45dc5ae05df2df48d318666ba1`
  passed with exit0, no unexpected API/browser/network errors, cleanup all zero.
  Screenshots: `tmp/acp-full-2e7f9952e1af4274be4d423916e6cc0a/`. The narrow
  canonical result image was visually read and shows the actual Normal cell.
- On that same tree, disconnect-apply deliberately returned404, asserted the
  entire pre-apply snapshot unchanged, failed `APPLY_HTTP_STATUS` with exit1,
  and cleaned all owned databases/backends/ports. The independent source-seed
  diagnostic passed, distinguishing a disconnected apply path from bad setup.
- Dedicated identity/proposal unit tests passed68/68 and runner typecheck passed.

### Mutation record

On clean combined `32eee100275cb6a33b2f880a5b1c494e2265af22`, the owning
verification copy temporarily changed projection cleanup to null every existing
projection key before clearing the two managed proposal fields. The real apply
returned200, then the custom preservation assertion failed at
`custom-preservation-after-apply` with `CUSTOM_VALUE_LOST_ON_APPLY`, exit1 and
cleanup all zero. The mutation was restored and source diff checked empty;
it was never committed/pushed and is absent from this publication candidate.
This discriminates destructive cleanup from preservation, not merely failed API
reachability. Source product byte equality was checked again before final replay.

### Reproduction

From the publication worktree, with its normal dependencies available and no
ambient DB/API configuration or root `.env`, use Node20.20.2:

```sh
PATH=/Users/chouhua/.nvm/versions/node/v20.20.2/bin:$PATH packages/core-backend/node_modules/.bin/tsx scripts/attendance/acceptance/acp1b-full-app-realdb.mts /opt/homebrew/opt/postgresql@15/bin
```

Append `disconnect-apply`, `foreign-tenant`, or `response-timeout` for intentional
negative invocations (expected exit1, never green or skip). Every invocation
creates a distinct synthetic database and local server; no shared DB is used.
The custom-wipe mutation above is intentionally not a runtime option.

```sh
cd packages/core-backend
PATH=/Users/chouhua/.nvm/versions/node/v20.20.2/bin:$PATH node_modules/.bin/vitest run tests/unit/attendance-record-read-identity.test.ts tests/unit/attendance-report-cleaning-proposal.test.ts --watch=false --reporter=dot
```

Runner typecheck uses an ignored `tmp/tsconfig.full-app.json` extending the backend
tsconfig, including backend src/core/types and the two new `.mts` files. Overrides:
module=ESNext, moduleResolution=node, lib=[ES2022,DOM], allowImportingTsExtensions=true,
noEmit=true, rootDir/baseUrl=`..`; paths resolve pg to backend `@types/pg/index.d.ts`
and vite to web `vite/dist/node/index.d.ts`. Command from the repository root:

```sh
PATH=/Users/chouhua/.nvm/versions/node/v20.20.2/bin:$PATH packages/core-backend/node_modules/.bin/tsc -p tmp/tsconfig.full-app.json
git diff --check
```

Publication and natural exact-head CI are recorded separately after creation.
Neither dependency is merged, enabled, deployed or declared real-data UAT here.
