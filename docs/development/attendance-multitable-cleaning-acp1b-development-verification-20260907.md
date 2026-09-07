# ACP-1B development and verification

Status: IN PROGRESS / DRAFT-HOLD. This report is not completion or release evidence.

## Post-publication CI correction (current, 2026-09-08)

Draft/HOLD #5542 published at 8faebc105c090b11336a65c08756cf4d5141b044.
That head is **not CI green**. Two independent failures are established:

1. Three Linux postgres:16 lanes reject the new anchor migration with
   `ATTENDANCE_CLEANING_ANCHOR_SCHEMA_DRIFT` (comments, org-writer W4-S1,
   recovery-schema-drift). The precise semantic/catalog difference remains
   unproven. PG15-alpine parity and migration-replay pass. The original pin
   also passes native macOS arm64 PG16.15 (26/26), and C/en_US.UTF-8 minimal
   schema captures are identical. Therefore "major16 always fails" is refuted.
   No migration pin weakening or guessed normalization has been made.
2. Node18/20 fail the attendance corpus wiring gate: the new DB suite makes
   the exact family 110 rather than 109 and lacked the two required wiring
   points. Local correction adds exactly one whole-file argument and quoted
   no-DB exclusion, one corpus member, and a fail-loud test-specific DB guard.
   The existing step-specific DB environment value is retained, not propagated
   to another step. Full wiring now passes 262/262. Independent removal of
   exclusion, whole-file argument and environment each fails; restoration passes.
   Without the explicit test DB URL the real suite now fails, never skip-greens.

Workflow/config strict union is checked against both published HEAD and main:
removing exactly the new lines produces byte-identical prior files. Official
`computePackageProvenancePinSet` reports only `evidenceFiles.pluginTestsWorkflow`
changed. Old-pin positive verification fails; updated pin passes provenance and
all five S5 script suites (6/6 script processes), frozen/live diff zero.

Discarded mutation attempts are not evidence: an early orchestration restored
files before subprocess completion; a subsequent ambiguous restoration anchor
temporarily inserted lines in another step. Both were corrected and serial
terminal runs used instead. One restored run's Python YAML subprocess stalled,
was bounded/terminated, and is recorded as failed; the next bounded run passes.

Private PG16.15 runtime was built from the official PostgreSQL source archive,
SHA256 `c1575341fa7bd40f5274ea465b34390f4dc64cdd0770af327005caaeb9f6b7ed`.
It occupies about 274MiB with source/build files, not a global installation.
macOS libc and Linux CI libc are not claimed equivalent. The capture harness
uses unique synthetic databases, explicit role, loopback port allowlist, emits
explicit migration outcome and closes owned pools before dropping its own DB.
At this correction checkpoint task PG15/PG16 instances are running for isolated
verification; the earlier shutdown record below predates these new instances.

## Current delivery snapshot (supersedes chronological pending notes below)

Candidate product/CI head: `a71d0020bd9e45725c79cd2420a39d74bbb5aa03`.
Live main readback: `976711b254d129e6c23bf8327c4be67018942ba3`.
The sections below retain failed attempts and intermediate states as history,
not as current blockers. No production or customer-data verification is claimed.

The user-visible path is attendance report fields → open multitable → edit the
two proposal fields → load proposals → review → explicit confirm. Canonical
attendance remains authoritative; arbitrary cell edits do not become attendance
facts. This ratified slice corrects the five anomalous daily statuses to normal,
not raw punch timestamps, business-trip, leave or overtime facts.

| Gate | Verified local evidence |
| --- | --- |
| Real PostgreSQL authority, W4 registry and HTTP | Node 18 and 20: 74/74 each |
| Dedicated plugin unit suites | 45/45 |
| Dedicated UI plus workflow contract after final P2 fix | 41 + 6 = 47/47 |
| Administrator / self-service neighbors | 144/144 and 59/59 |
| Original attendance web command | 65 files / 1257 tests on 15d0d7f1; later UI delta separately verified |
| Required-web command | 13 batches, 514 files / 7228 tests PASS, terminal exit 0 on a71d0020 |
| Type/syntax/diff checks | backend tsc, vue-tsc, CJS syntax, diff-check PASS |
| Browser positive control | Real Vue/Chromium, synthetic intercepted API; not full-stack E2E |
| Final narrow review | No P1; one metadata ordering P2 reproduced RED then fixed |

Task synthetic database cleanup is complete: exact owned full database dropped,
remaining task-prefixed databases and active backends both zero; dedicated PG15
instance stopped. Local evidence/results are retained. Pending delivery steps:
ordinary push and Draft/HOLD publication with exact-head CI readback. No Ready,
merge, flag enablement, workflow dispatch or deployment is authorized by this report.

## Authority and baseline

Owner ratified OD-ATC-12A(a) in the owning task; the exact approved contract is
`attendance-multitable-cleaning-acp1b-apply-route-decision-20260907.md`.
OD-ATC-11R(a) remains the canonical-anchor authority. The coordination window
permits current-main synchronization and the ratified shared/DB/W4 implementation.

- Original implementation baseline: `2ba43e2d28fbe0fdb8961fa5af54abadb81ef608`.
- Preserved ten-file product checkpoint: `3ae07e303890398198f87cbb8241a8675f0e22ba`.
- Main synchronized: `cae4619032d9cd32aea5aec13297561f29ca1f6f`.
- True merge: `2488ef6687eacc18f510907d987c135b4bb7967e`, first parent checkpoint,
  second parent main. Six upstream paths had no intersection with ACP paths.
- Duplicate-row repair correction: `cec882918`.

## Delivered locally so far

The projection descriptor adds two user-owned proposal fields. The dedicated
policy accepts only literal boolean true and defaults off. The daily sync supplies
canonical identity through the attendance-only core port. The anchor migration
adds immutable identity, composite source constraints and nonempty-down refusal.
Duplicate rows now stop before managed first-row repair.

The apply route, locked W4 authorization/replay and pending-proposal UI are now
implemented locally; the chronological evidence below distinguishes each gate.
Required CI selection and candidate review are implemented; publication is pending.
No public PR has been published for this implementation. No runtime flag has been enabled.

## Evidence and defects

Dependencies were restored with `pnpm install --frozen-lockfile --ignore-scripts
--prefer-offline`; no lockfile or manifest change. Node 24.14.1 and Node 20.20.2
each passed both dedicated unit files (40 tests). Backend `type-check` passed after
fixing an unknown-to-number narrowing error. This does not substitute for Node 18,
web, full W4 or required remote CI evidence.

The duplicate-row regression first failed against patch-first behavior. Removing
the new duplicate `continue` made the same test fail again; restoring it returned
40/40 green. The test preserves the exact versions and contents of both rows.

The new real-PostgreSQL test reproduced a separate runtime defect: PostgreSQL
returns DATE as a JavaScript Date, whereas the digest expects a canonical date
string. The refresh failed with the fixed values-free authority error. Selecting
`work_date::text` fixes this without timezone conversion. Removing the cast made
the database test fail again. The database suite also checks immutable identity,
populated-down refusal, replay, record-delete cascade and empty down/down/reapply.
It uses synthetic fixture tables; it does not yet prove actual route authorization
or W4 transactional behavior.

The suite uses only an explicit local `ATTENDANCE_TEST_DATABASE_URL`, creates a
unique `attendance_acp_` scratch database, closes its pool before dropping the
database, and asserts exact database residue zero. No application URL fallback.
Node20 repeated this initial database gate five times successfully. Final SQL
census reported zero `attendance_acp_` databases and zero matching active backends;
the task-owned local PostgreSQL instance was then stopped cleanly. This repeat
preceded the later selector fix and is not evidence for that later candidate.

## Outstanding adversarial review

### Latest local checkpoint (2026-09-07)

Anchor/migration checkpoint: `5d1ba2f87fd909d5e6236f373afab9c77dd5dcf2`.
Subsequent work adds the two-connection scope-read → concurrent CREATE → fence
regression. It proves a committed duplicate causes the old anchor to be revoked;
mutating the duplicate threshold to 1000 retains one anchor and makes the count
assertion RED. The restored Node20 suite passes 9/9. Per-test projection cleanup
also permits running these cases individually.

The pure operation-identity helper now derives a deterministic UUIDv5 from the
proposal digest and a separate stable source reference from organization/record.
The first new test failed while the helper was absent. Including the managed
fingerprint in the stable source reference made its resync-replay test RED;
restoration returned the dedicated unit suites to 41/41. This is identity planning
evidence only; no W4 apply or cleanup replay execution is claimed yet.

The database suite now contains eight tests. Node 18.20.8 and Node 20.20.2 each
passed five consecutive runs on the same restored candidate, with PostgreSQL
15.17 and `RBAC_BYPASS=false`. These are migration/anchor tests, not HTTP permission
or W4 apply proof. Exact/prefix scratch database and backend counts were zero and
the owning PostgreSQL instance stopped cleanly after the final runs.

The migration now rejects catalog drift instead of replacing existing objects,
checks a pre-existing guard-function collision, and takes an exclusive table lock
inside the same transaction before count/drop. A two-connection test proves an
in-flight anchor INSERT commits before down counts and therefore makes down refuse.
Removing that lock made exactly this assertion fail; it was restored before repeats.

The catalog signature includes column collations, index access methods/opclasses/
collations, trigger names and function names/schema in addition to the structural
shape. Cross-major PostgreSQL rendering portability remains unverified; PG15 green
is not proof for PG14/16/17. Additional corruption/mutation cases remain pending.

Whole-group withholding now expands the caller's supplied IDs to all matching rows
using the registry project and existing `getObjectFieldId` implementation. A 56-row
fixture with only the first 50 supplied previously retained an anchor; it now clears
it. Refresh takes the existing create fence and locks all sheet rows in ID order
before checking the group and the canonical source. Concurrent CREATE/PATCH and
the later W4 lock-order interaction still require dedicated two-connection proof.

The review notes below retain the original findings; this checkpoint supersedes
their implementation status only where explicit evidence above is stated.

Sol independently confirmed the PostgreSQL date mismatch. Sol also found that
the plugin's duplicate query is capped at 50 and precedes a separate anchor
transaction. The core refresh must prove the entire duplicate group and concurrent
insertion behavior. This is an open P1; the current patch-first regression alone
does not close it.

Sol identified two further findings. The migration currently accepts a same-name
table without validating its catalog shape (open P1). The selector recognized only
`w4`, omitting the existing `w4_group` pointer-owning domain (P2). A new failing unit
case reproduced the latter; the implementation now reuses the existing domain
predicate and refuses an invalid current pointer instead of falling back to latest.
Both unit files and backend typecheck returned green; real-DB and mutation coverage
for this selector change remains pending.

Next gates: reproduce remaining review findings, enforce authoritative duplicate
census and migration drift refusal, implement locked W4 apply/replay, add dedicated
Vue UI/tests, run Node18/20 and isolated DB mutation matrix, then request only the
mechanical shared CI-selector coordination window. Publication remains Draft/HOLD.

## DB-fresh actor gate checkpoint (2026-09-08)

The attendance-owned authority helper now locks active user, same-org membership,
and existing grant rows before resolving DB-fresh attendance administrator access.
JWT identity alone and generic multitable write permission cannot grant approval.
The helper is not yet wired into the W4 apply route; this is not end-to-end proof.

Node20 dedicated PostgreSQL suite: 10/10 PASS, including wrong organization,
token-subject mismatch, generic-write-only actor, revoked membership, inactive
account and pending activation. Removing the attendance-specific permission guard
produced the expected RED (generic write incorrectly resolved); restoring it gave
10/10 PASS. Backend `tsc --noEmit` passed before the final test-only additions.

Read-only replay review found that existing generic W4 completed replay returns
before class-00/10/11 locks. ACP must not reuse this path without its locked
authorization and cleanup checks. Coordination interpreted the existing ratified
contract without new owner ratification: cleanup requires the original operation
actor plus current access; suspended ACP cleanup performs no new DML and retries
only after posture recovers. Cross-admin and suspended cleanup writes remain out
of this slice.

Registry now defers only an internal ACP manual-edit single-command decision with
the canonical source-reference format. Default callers retain ordinary fast replay,
including while suspended. Locked replay returns a frozen actual organization
witness only, not executable item witnesses. Boundary takes class-11 before the
cleanup hook and never executes, seals or enqueues that completed operation again.
The trusted plugin caller is still pending.

Node20 registry whole-file: 13/13 PASS, including allow-new first claim,
missing/claimed/canceled locator refusal, original-actor congruence, membership
revocation, suspended ACP/ordinary controls, complete boundary 00/10/11 order,
ordinary boundary zero-lock replay, and two-stage decision drift. Removing the
missing-locator guard produced RED by wrongly claiming a new operation. Skipping
replay class-11 produced RED by observing two locks instead of three. Both mutations
were restored. Existing real-plugin W4 route neighbor: 32/32 PASS; its fixture
internally enables RBAC bypass, so this is NOT ACP strict-route permission evidence.

Dedicated anchor/authority PostgreSQL suite: 11/11 PASS after adding effective
sheet/proposal-field/row access, hidden/read-only fields, duplicates and deleted
sheet negatives, with positive recovery controls between denials. Existing grant
rows are locked and existing multitable permission logic is reused. The helper is
not yet wired to the public ACP route. Full route, cleanup CAS, concurrent grant
revocation and UI acceptance remain pending.

Subsequent refute-first review reproduced two additional P1 cases. Role-only admin
without the attendance permission family wrongly passed; it now fails. Attendance
namespace admission is resolved on the same transaction using existing pure
namespace derivation and actual role/admission rows, never the global-pool resolver;
missing/disabled namespace also fails. Existing wildcard semantics are preserved.

An actual second connection could INSERT a new field deny while the earlier
SERIALIZABLE transaction held all existing grant rows. Row locks alone therefore
did not prove authority stability. The ACP-only internal boundary entry now selects
a fixed SHARE NOWAIT relation fence immediately after BEGIN and before even the
first SELECT set_config. It locks the 14 explicitly named authority/schema/policy
relations in the registry wrapper; ordinary W4 entry does not take this fence.
This is table-wide serialization, NOT per-subject concurrency. It can temporarily
block unrelated grant, user, sheet-schema and settings writers. The runtime remains
default OFF and this performance limitation is part of release review.

Real PostgreSQL proof: deny committed immediately before the fence is observed and
refused; deny inserted while the fence is held waits; a pre-existing writer gives
fixed busy and rollback leaves zero relation ShareLocks. A mutation inserting
SELECT set_config before the fence recreates the old-snapshot wrong allowance and
turns the test RED. Restored Node20 combined registry/authority/W4 neighbor: 56/56
PASS. These still do not prove the not-yet-wired ACP HTTP apply or cleanup effects.

## SERIALIZABLE projection phantom and candidate repair (2026-09-08 local)

Integrated HEAD is `e88175d69c125fc28d72c6e14743471627771adf`, with product
checkpoint `7f218673f3bd0790ebaf39dbd3d9c9ae7639aa9d` as first parent and main
`976711b254d129e6c23bf8327c4be67018942ba3` as second parent. The following
evidence is from uncommitted follow-up work, not the earlier green checkpoint.

The actual SERIALIZABLE wrapper establishes its snapshot before the existing
transaction-scoped sheet fence. A second connection commits a duplicate projection
through the canonical create fence in that interval. The access check incorrectly
returns the projection instead of refusing. The dedicated regression was RED;
the earlier READ COMMITTED sync test did not cover this schedule.
There was no canonical attendance mutation in this reproduction.

Two Node20 / PostgreSQL15 experiments pass, but are not a production fix:

- A pre-BEGIN session lock on `hashtext(canonicalSheetFenceKey(sheetId))` excludes
  the writer's one-argument transaction lock. A two-int lock with the same hash
  does not conflict. Exact unlock allows the writer to proceed.
- A synthetic inverse-order holder demonstrates that initial try-lock success
  does not prevent a later wait cycle. A bounded lock timeout, rollback and exact
  unlock release the waiter; both backends then have zero advisory locks. This
  is a candidate-protocol hazard, not evidence that an existing W4 caller takes
  that synthetic lock or has a production deadlock.

The coordinator authorized a bounded production candidate within the existing
files. It now runs through the ACP-specific record boundary. No writer flag is
enabled. This is a transaction/source milestone, not HTTP apply or UI completion.

### Actual candidate order and resource gates

The ACP boundary performs an idle probe and same-client non-authorizing lookup of
the daily and catalog sheets. Each attempt acquires session locks in actual signed
PG key order, deduplicating hashes, then begins SERIALIZABLE. Its first transaction
statement locks the fixed **16** relations (the original 14 plus leave/overtime
definitions) in SHARE NOWAIT mode. The boundary rechecks the exact sheet scope in
that snapshot before normal W4 class-00, class-10 and class-11 processing. Only
after target locking does the adapter enter source/projection/anchor row locking.

Mechanical caller audit: RecordService create takes the same one-argument fence
with writer flags OFF; the optional link plan is null in that posture. Attendance
sync's anchor refresh/withhold ports open separate short pool transactions, not a
W4-held callback. Ordinary W4 execute does not request either ACP fence. The
bounded independent callgraph/resource/snapshot review found no new P1; its P2
about optional sheet IDs is closed by mandatory paired options and pre-query
refusal tests. The source-seed actor pre-read is a separate short transaction;
its temporary FOR SHARE locks do not survive into W4 or grant authority to apply.

Every attempt releases only its recorded session locks in reverse order, including
partial busy, body refusal and 40001 retry. Existing same-backend locks are refused
without changing their reentrant count. Lost acquisition/BEGIN/COMMIT/ROLLBACK or
unlock results produce an uncertain-connection error; actual boundary tests prove
pg `release(error)` destroys that client. The boundary maps this to fixed 503
`ATTENDANCE_CLEANING_OUTCOME_UNKNOWN`, never a blind apply retry or raw error.

The original duplicate test is now GREEN on the real wrapper. Removing its session
acquisition makes the original wrong allowance RED again. Catalog insertion is
observed; a concurrent catalog edit triggers 40001 and one whole-attempt retry.
Removing catalog FOR UPDATE yields one attempt instead of two (RED). Removing the
two definition-table fences independently makes both in-flight-definition refusal
tests RED. All mutations are restored.

Restored Node20 combined scope is **71/71**: dedicated authority 26, registry 13,
existing plugin W4 HTTP neighbors 32. Node18 dedicated authority + registry is
**39/39**, not the full 71. Backend type-check and diff-check pass. Focused source
ESLint exits zero with 0 errors and 22 warnings in `src/index.ts`; no auto-fix.
The existing 32 HTTP tests are not the still-unimplemented ACP apply endpoint.
The intermediate catalog fixture collision was a test cleanup defect, corrected by
removing its own two physical fields; it was retained as a failed run, not counted
as a product concurrency defect. The full synthetic migration DB remains task-owned
and running for the next route tests; only per-suite scratch DB residue is cleared.

Remaining before publication: real ACP HTTP adapter and exact business fingerprint/
dual-CAS checks, canonical apply plus durable cleanup-only replay, user-visible UI,
final repeated gates and required CI selector union, final isolated DB cleanup.

### HTTP and fresh-source follow-up (uncommitted)

Snapshot/resource checkpoint: `e2ff06648635358b3d866a6082b597d4f7df7fcd`.
Its parent already includes main `976711b254d129e6c23bf8327c4be67018942ba3`,
which the publication-ref readback still reports unchanged.

The new HTTP entry test first returned 404 (missing route). Minimal route wiring
and a handler in the attendance-owned sibling module now pass that test with
`RBAC_BYPASS=false`: ACP is default-off, only expectedVersion is accepted, extra
authority fields are rejected without echoing their values, and no ACP operation
is created. This is exactly one HTTP entry test, not successful canonical apply.
The dedicated cleaning boundary is now connected to the existing manual-edit
adapter. Only the isolated synthetic test DB temporarily enables the policy and
restores its prior settings; no runtime flag or external environment is enabled.

A fresh-source checker adds strict proposal version, canonical digest, managed
fingerprint, calculation selector/id/version, source identity and proposal digest
comparisons, and accepts only the five ratified anomalous statuses. Its new unit
test was RED when absent; dedicated unit suites now pass **44/44** on Node20.
The checker and stable completed-operation readback are installed in the actual
manual adapter. Concurrent HTTP dual-CAS acceptance remains outstanding.

The follow-up adapter factory now prepares server-derived manual input only:
fixed normal target, no metric override, original calculation seed, bounded audit
reference, and notification suppression. Fresh admission refuses any source
operation appearing after the route pre-read. Removing that refusal makes its
unit test RED; the guard is restored. Recovery reconstructs the original command
from the immutable audit and calculation rather than current projection values.
It binds the original live actor, selected calculation, exact reason/evidence and
anchor lifetime (including PostgreSQL timestamp precision). Cleanup reuses the existing
plugin `multitable/records.ts` transaction-injected CAS patch with revision logging;
cleanup can reuse it without adopting the REST writer's event fan-out or adding a
new shared patch API.

Node20 real HTTP scope passes **35/35**: 32 ordinary W4 neighbors, one strict-body/
default-off case, and two ACP cases (authoritative and shadow). Both ACP cases use
`RBAC_BYPASS=false`, real plugin/server/PostgreSQL and synthetic managed projection
fixtures; they do not prove the projection sync writer end-to-end. Each asserts
one canonical calculation, audit, completed operation and W4 event, zero notified
edits, and cleanup of only the two proposal fields while retaining custom content.
The authoritative case injects a row-specific cleanup SQL failure: canonical
commit survives as `applied_pending_cleanup`; another administrator, revoked
membership, changed reason and withdrawal cannot consume the proposal. After a
simulated legitimate sync/anchor refresh, retry consumes the original operation
without another canonical effect. Subsequent managed-value tampering with the
stored fingerprint unchanged is rejected through HTTP in both postures (2/2).
Discriminating HTTP mutation: removing only the recomputed-managed-fingerprint
comparison changed both expected 409 responses to 200, making both cases RED.
The comparison is restored; the stored fingerprint alone is demonstrably unsafe.

Concurrent proposal edit (both HTTP postures): an independent PostgreSQL client
holds the projection row; bounded condition polling of `pg_blocking_pids` proves
the HTTP transaction is actually waiting. The writer changes the reason and
increments version, then commits. Pre-fix both cases returned an incorrect 403:
the projection-access catch masked a SERIALIZABLE failure as authorization denial.
The attendance-owned catch now preserves 40001/40P01 for the existing operation
retry loop; an authorized stale proposal version returns a fixed 409 conflict.
Both cases pass after the fix, preserve the concurrent reason/version, retain
the anomalous canonical status and create no audit or ACP operation. This proves
the concurrent proposal side only, not the still-pending canonical/cleanup races.
Restored Node20 combined real-DB run passes **74/74** (HTTP 35, dedicated authority
26, registry 13); backend `tsc --noEmit` and `git diff --check` also pass. This is
local uncommitted evidence, not an exact-head CI or publication claim.

The same server-observed concurrency barrier now also holds the canonical row
while a second client changes its timezone, then releases the waiting HTTP apply.
Both postures reject with 409, preserve the new canonical field and proposal, and
create no ACP effect. Removing only the canonical-source-digest comparison makes
both HTTP cases incorrectly return 200 (mutation RED); the comparison is restored.
An earlier attempt to directly alter W4-owned status was correctly rejected by
the existing pointer/snapshot DB trigger. That fixture-construction failure is
retained, and no trigger was disabled. This timezone case proves concurrent
canonical-fact freshness, not replacement by a newly appended calculation; the
selected-calculation replacement and cleanup races still require distinct gates.

### Review UI first integration (uncommitted)

The attendance-owned report-fields GET now includes a read-only cleaning review
descriptor only when both existing policies permit it and an existing daily sheet
belongs to the organization project. It neither provisions a sheet nor grants
record access. Logic stays in the sibling module; index wiring is minimal.
The report-fields section uses existing GET `/api/multitable/records` with its
field/record read checks and physical requested-field filter. It shows loaded
proposals, cursor pagination, an explicit review/confirm step and only sends
`expectedVersion` to apply. Consumed, pending cleanup and unconfirmed outcomes
are distinct; server error values are never rendered. Metadata from another
organization/default-OFF does not expose the entry.

Pre-implementation unit descriptor and web-entry tests were RED. Current local
Node20 scope: descriptor/proposal/catalog **45/45**, report-fields web **34/34**,
real HTTP **35/35** including descriptor metadata in both ACP postures; vue-tsc
and diff-check pass. The web test runner emitted an existing websocket-port-in-use
warning but all assertions completed. Initial HTTP metadata fixtures used a random
sheet id unlike the real provisioning id; they now use `getObjectSheetId`, without
loosening ownership checks. Real browser end-to-end, generic-list live integration,
async organization-switch negatives and UI mutation remain outstanding; these
unit tests are not a claim of browser acceptance or full product completion.

Follow-up live generic-list proof: both ACP HTTP postures call the exact existing
list URL used by the UI and receive the pending physical-field record/version.
With a real field permission hiding reason, the response omits that field; hiding
the requested field instead makes filtering fail with a values-free 400. Exact
temporary permission rows are removed in finally. No shared permission code is
changed, and a descriptor is not counted as an authorization gate.

Six focused organization UI cases pass: unavailable/cross-org metadata, late
old-org list response, confirmation invalidation, and late apply response. After
switching organization no old proposal/confirmation/result is shown and no old
request is automatically resubmitted. Removing the list-response identity guard
makes the old-org reason visible and the test RED; guard restored and all six
pass. The suite now collects 37 cases; only these six were rerun after this delta.
Live-list permission proof passes both HTTP cases. Browser positive control,
selected-calculation replacement, cleanup race and CI union remain outstanding.

Browser positive control now passes with installed Chromium, real Vue component
and a loopback Vite harness, using explicitly synthetic intercepted API responses.
Command: Node20 `node tmp/acp1b-browser-verification.mjs` from the worktree root.
The harness checks no POST before confirmation, exact `{expectedVersion}` payload
and organization header, pending-cleanup messaging, explicit retry and consumed
row removal; no page errors. Screenshots under `tmp/acp1b-browser-{review,pending,
consumed}.png` were visually inspected. The ignored harness is local evidence,
not a new CI selector or claimed real-backend browser E2E. Initial harness runs
failed loudly: middleware after Vite's fallback loaded the main application and
timed out. Registering the isolated page before the fallback fixed that harness
defect; no product authentication or dependency failure was silently skipped.

### New selected calculation while HTTP waits

The real-DB fixture helper now supports appending version 2 inside the competing
client's transaction, with complete calculation/segment snapshots and the normal
authoritative pointer guard intact. After `pg_blocking_pids` proves the HTTP
request waits on its canonical row, that transaction appends the new calculation
and commits. Both authoritative/current-pointer and shadow/latest-completed
postures return 409 and leave no ACP operation or edit audit. A trusted anchor
refresh is required before the independent successful apply path proceeds.

Pre-fix shadow returned 503 from PostgreSQL 23505 on `uq_arc_record_version`:
its SERIALIZABLE snapshot predates the concurrent append, and the unique version
constraint rolls back the attempted operation. The attendance handler now maps
only this exact code/constraint pair to a values-free 409 after boundary rollback;
other database failures remain unchanged. Focused HTTP postures pass 2/2 after
the change; diagnostic-only code/constraint logging was removed. Cleanup race,
anchor recreation precision negatives, final CI union/review and cleanup remain.

Cleanup-only replay race now has an actual independent projection writer and
server-observed lock wait. The writer changes a custom field and version while
the original actor retries cleanup; retry returns 409, preserves the complete
new projection, and the canonical manual calculation/audit remain exactly one.
The fixture is restored only for subsequent independent recovery negatives.

Anchor-lifetime integration: delete/reinsert the exact synthetic anchor with a
creation timestamp one PostgreSQL microsecond after the completed operation.
Cleanup refuses with 409 and preserves the pending proposal. Removing the native
precision `anchor_epoch_matches` guard makes this real HTTP case wrongly consume
the proposal with 200 (mutation RED); guard restored. The exact original synthetic
anchor is restored in finally, without disabling its immutability trigger.

Candidate consolidation: Node20 real-DB authority/registry/HTTP passes 74/74,
plugin unit 45/45, backend tsc, vue-tsc, CJS syntax and diff-check pass. Focused
ESLint reports zero errors and 22 pre-existing core index warnings, without auto-fix.
The combined frontend invocation passed report-fields 37 and self-service 59, but
its administrator worker hit the default JS heap limit: this run is FAILED (96
assertions passed, 144 unproven), not a green batch. The existing required script's
single-fork 8GB administrator invocation is the appropriate follow-up resource lane.
That follow-up completed **144/144**. Node18 also passes the same full real-DB
scope **74/74**, not only the earlier 39-test authority/registry subset.

Final metadata negative reproduced a new exposure: report-fields supports a
legacy query organization override, so an administrator from another organization
could receive the added cleaning descriptor. Its readback now invokes the same
database-fresh actor/membership/admin/namespace authority through a read-only
attendance port before computing the descriptor. A JWT organization-equality-only
attempt also denied legitimate sessions without an organization claim, so it was
replaced with actual current membership verification, never a header fallback.
The existing report-fields behavior is unchanged. This metadata check is not a
replacement for the apply or generic-list server permissions.

## Product checkpoint and CI tail

Product checkpoint `c659265f72019347958500fcbeba48720b27d644` is clean and retains
the existing main `976711b254d129e6c23bf8327c4be67018942ba3`; live main was unchanged
before the tail. The two shared CI files were identical to that main before edits.
The tail adds the exact report-fields spec to both executable commands and adds
its test path plus the two attendance CJS paths to attendance push/classifier
coverage. No old tokens, paths or flags are removed.

Using Vitest 1.6.1's actual `globTestFiles` and parsed CLI filters against current
web configuration, attendance coverage is 63→64 tokens / 64→65 files; required
coverage is 444→445 tokens / 513→514 files. In each lane the sole newly collected
file is `tests/AttendanceReportFieldsSection.spec.ts`; no previous file is lost.
Full local file census is retained at `tmp/acp1b-ci-census.json` with its harness.
The dedicated spec now pins the parsed executable argv and classifier/push paths.
Removing its workflow token fails that assertion; restoring and independently
removing the required-script token also fails. Both mutations are restored.
Initial census parsing preserved empty arguments across multiline shell whitespace;
normalizing shell whitespace fixed the harness, not a selector/product defect.

Retained failed setup evidence: an early static authority import initialized the
DB pool before test environment setup, causing a driver-default connection error
and timeout. Imports are now inside the test after server initialization; real-DB
commands set both DATABASE_URL and ATTENDANCE_TEST_DATABASE_URL before startup.
That setup failure is not classified as a product assertion failure.

Completed since the initial checkpoint: concurrent HTTP dual-CAS/cleanup races,
anchor recreation precision negatives, discriminating mutations, user-visible
review UI, and CI selector union. The full attendance web command passed on
15d0d7f1 (65 files / 1257 tests). Required-web execution and final task DB
shutdown/cleanup were subsequently completed as recorded in the current snapshot.

Final narrow review found no P1 and one metadata request-order P2. Three new
deferred-response cases were RED before the fix: stale success cleared current
loading; a late old response replaced the new catalog; stale error cleared loading
and displayed an old error. A request epoch now guards success, catch and finally.
After the fix, the dedicated UI suite passes 41/41, the workflow contract 6/6,
and vue-tsc passes. This does not expand apply authority or change backend logic.

Final required-web command: Node20, `NODE_OPTIONS=--max-old-space-size=8192`,
web cwd, `bash scripts/run-required-web-tests.sh`. All 13 batches pass: file
counts 35,1,2,2,6,27,3,2,2,2,1,4,427 (514 total); assertions
605,23,21,28,58,376,185,95,7,71,9,104,5646 (7228 total). Terminal exit 0.
No Vitest Unhandled Errors/Rejection/Uncaught Exception or fatal heap report.
The Vue async-loader warning and mocked import Error belong to the deliberate
`multitable-chart-load-error.spec.ts` negative (explicit throw at line 70); its
four cases pass. Expected network-failure warnings and nonfatal WebSocket port
warnings remain visible in the retained log; they were not suppressed.

Prepublication OPEN attendance-related audit found no competing ACP implementation.
Historical #4630 at 7d8ba0d1 has broad index/types/registry path overlap, but is an
old diverged stack (56 ahead / 1187 behind main), not an active ACP write lock.
Its diff contains no ACP cleaning/projection-anchor implementation. It was not
absorbed or rebased. Coordinator confirmed this distinction; #5362/#5364 remain
untouched. Main still read back as 976711b254d129e6c23bf8327c4be67018942ba3.

## Exact current file census

1. `docs/development/attendance-multitable-cleaning-acp1b-apply-route-decision-20260907.md`
2. `docs/development/attendance-multitable-cleaning-acp1b-development-verification-20260907.md`
3. `packages/core-backend/src/attendance/attendance-multitable-cleaning-authority.ts`
4. `packages/core-backend/src/db/migrations/zzzz20260907110000_create_attendance_report_projection_anchors.ts`
5. `packages/core-backend/src/db/types.ts`
6. `packages/core-backend/src/index.ts`
7. `packages/core-backend/src/types/plugin.ts`
8. `packages/core-backend/tests/unit/attendance-report-cleaning-proposal.test.ts`
9. `packages/core-backend/tests/unit/attendance-report-field-catalog.test.ts`
10. `packages/core-backend/tests/integration/attendance-report-cleaning-proposal.db.test.ts`
11. `plugins/plugin-attendance/index.cjs`
12. `plugins/plugin-attendance/lib/attendance-report-cleaning-proposal.cjs`
13. `packages/core-backend/src/attendance/w4c0-operation-registry.ts`
14. `packages/core-backend/src/attendance/w4c3c-record-operation-boundary.ts`
15. `packages/core-backend/tests/integration/attendance-w4c0-operation-registry.db.test.ts`
16. `packages/core-backend/tests/integration/attendance-w4c3c-record-operation-routes.db.test.ts`
17. `apps/web/src/views/attendance/AttendanceReportFieldsSection.vue`
18. `apps/web/tests/AttendanceReportFieldsSection.spec.ts`
19. `.github/workflows/attendance-web-guard.yml`
20. `apps/web/scripts/run-required-web-tests.sh`
