# Assignment identity neutral labels — separate repair lock

Status: Draft/HOLD. This existing-display repair falls within the ongoing user-authorized DingTalk closeout scope. It is a separate candidate from #6543 and is not a new owner ratification or authority to merge, deploy, enable flags or claim product acceptance.

Runtime baseline: actual main `8a426818804897a20f7674c39c56b3a445909c3a`. Publication base: fresh origin/main `9bcaf4b8197eb9752f7eb5010bc0e0ba3cd6d651`. Its only incoming commit is stock-prep #6514 (12 disjoint paths). Web, OpenAPI, attendance plugin, scripts and package/lock objects are identical; all four candidate runtime/test files are preserved exactly. The owned branch was fast-forwarded locally with no GitHub PR merge. Unchanged frontend/negative/build/browser results are carried with this source proof; global validate:all was run once on9bc because the new integration-plugin source affects global validation inputs.

## Contract and source triggers

Parent `attendance-shift-group-advanced-capability-design-lock-20260723.md` R7 (L215-219) requires neutral labels for unknown/deleted actors, and §7.5 (L609-617) includes no raw ID fallback. W8 plan FE-06 (L348-364) is historically unsearched/unresolved, not global certification or runtime authorization; §2.2 (L126-127) requires a separate gated repair.

At this baseline, AttendanceView's direct/rotation identity cells condition their primary labels on a nonempty `attendanceAssignmentUserPrimaryLabel`, leaving only technical IDs when unresolved. `formatTemporaryReplacementAssignmentOption` and `formatShiftSwapAssignmentOption` use raw user IDs as primary fallbacks. The swap formatter feeds both shared selects and dedicated card options. These are existing-display branches, not new scheduling capability.

Batch identity normalization is text-based: `normalizeBatchUserIds` in `packages/core-backend/src/routes/attendance-admin.ts` L609-621 trims, removes empty entries and deduplicates legacy text IDs; `invalidUserIds` remains empty. The later invalid guard is not evidence of UUID-only validation. This repair preserves existing resolver IDs/scope and adds mounted legacy-ID request/display controls; it changes no backend validation.

## Bounded implementation

- Reuse `attendanceGroupEffectivePolicyNeutralMemberLabel('unknown', tr)`.
- Preserve genuine PrimaryLabel name/email semantics, including trimming, byte-for-byte. Table technical ID spans remain separate and visible; existing secondary metadata is unchanged.
- For unresolved/nameless option actors, render neutral primary text plus a localized explicit User ID suffix, then the original shift/date/slot text. Distinct unresolved users with identical shift/date/slot must remain distinguishable.
- Preserve resolved option output byte-for-byte. No deleted inference from missing, inactive, 403/404/500 or transport failure.
- Resolver scope, requests, cache, sequence guards, eligibility, option values, selections, writer payloads, APIs, permissions and flags remain unchanged. No global retry or lookup.
- Creator/CreatedBy fields are outside this slice; they need a distinct resolver contract. Member/owner/pending, roster, capability and navigation work and the main lane's private composition remain untouched.

## Verification design

No new DOM hook is introduced. Original-source red checks the existing direct/rotation technical ID spans first, then actual identity text for the neutral primary label, followed by the existing label hook. Option assertions use actual native option text and values. Shared selects and the dedicated card are mounted through real AttendanceView; the dedicated selectors are scoped to the actual card root, with no card/View stub. Resolved name/email/inactive output and actual selection/write-payload cases are independent baseline-positive controls, whose passing runtime results still require main's execution.

## Actual local gates and pending publication

| Gate | Actual evidence / scope |
| --- | --- |
| Original-source red | 24 matching failures +9 positive controls /252 filtered exclusions; exit1. Invalid fixture attempts retained and excluded from final proof. |
| Candidate mounted hosts | 33 actual passed /252 exclusions. After a test-only props alias correction, only affected selfservice22 were repeated (22 passed /106 exclusions); admin11 are retained for exact unchanged file bytes, not claimed as a fresh final full33 run. |
| Identity / scope / writes | Unknown/nameless/error/legacy-text cases, bilingual labels, known name/email/inactive controls, actual second-target selections and exact option/payload IDs are covered by the mounted cases. No deleted inference/global retry; server authorization unchanged, not proven by these UI mocks. |
| Existing neighbors | Four actual existing controls passed /281 exclusions; unchanged successful suites were retained. |
| Six matching mutations | direct-table8red+2controls/275excluded; rotation8+2/275; raw option fallback24+9/252; technical suffix27+6/252; dedicated target1+1/283; temporary target1+2/282. Product bytes restored exactly. |
| Browser | Actual index/main.ts/App/router/Experience/AdminCenter-or-Overview/AttendanceView and real dedicated card. Four failed scenarios corrected in verification scope and passed: admin1366zh/768en, dedicated768en/390zh. Original mobile390 gate and shared-swap option assertions retained for identical912-input source freeze; not a fresh five-scenario aggregate run. Native option values/text, second selection, visible table IDs and layout checked; zero current pageerrors/writes/forwarded externals; one deliberately refused bootstrap405 console error per fresh context; own server stopped/port closed. Native-popup/real-user UAT and mobile admin editor are not certified. |
| Lint / quality / build | No introduced lint diagnostics (admin0, selfservice95 inherited, AttendanceView17 inherited; no whole-file lint-clean claim). Helper lint0. Original validate:all/build0; fresh-main9bc validate:all0. |
| Independent review | Sol/high source-only review of final9bc diff found no concrete introducedP1/P2; main audited actual evidence independently. Model opinion is not runtime proof. |
| Current-head CI | PENDING until candidate commit is published and all latest required checks reach terminal success with matching actual SHA. |
| Global parent scope | Parent §7.5 names375/768/1440; this bounded1366/768/390 proof does not close all parent responsive/FE-06/W8/owner/live gates. Full latest-main/all-Draft composition remains separate. |

The initial browser run remains failed: strict URL omitted the existing rail hash, the script wrongly expected opening a dedicated card to close an already-open shared disclosure, and a known scoped cancel-rounds/pending GET lacked a fixture. Bounded diagnostics proved those causes. Verification was corrected to exact canonical URL and the existing initially-closed disclosure flow; scoped GET was mocked explicitly. Budgets, product source, write/IO gates and native-label assertions were preserved. No successful mobile/shared/unit/negative/build suite was repeated merely to improve a receipt.

Public evidence: `artifacts/attendance-assignment-neutral-labels/verification.json` and linked synthetic screenshots. Detailed phase logs, invalid attempts and source-applicability receipts remain in the owned audit copy. Source-only worker handoff is historical; actual runtime was executed by the main agent as recorded above.

Stream/lifecycle OFF; real UAT and business50004 excluded. No merge/deploy/R71/tag/release/config changes. This bounded repair does not certify global FE-06, W8 closure or business acceptance.
