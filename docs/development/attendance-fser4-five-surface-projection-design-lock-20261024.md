# Attendance FSER-4 five-surface projection — 2026-10-24

Status: owner-authorized implementation, Draft/HOLD. The owner explicitly accepted this slice in this chat after the separate scope question. No merge, rollout, configuration change, deployment, package or R71 modification, real UAT, business error 50004, or issue closure is authorized. Stream/lifecycle remain OFF.

Base: `fdb30a671686db8dbdbdf606f3a6f1b98add9969`.
Authority: the ratified #4709 lock, member-projection amendment sections 3–4, merged prerequisite #4772, and this owner authorization. The amendment's historical OPEN header does not undo its recorded OD-4709-2=(a) ratification. This slice now implements the separately authorized frontend step; it does not alter the canonical backend derivation or assignment ownership.

## Required behavior

One strict shared parser/client/composable owns both exact response shapes, stale suppression and unavailable posture. It displays server state and reason order without deriving/sorting them. Admin projections read the existing aggregate route; employee and self trace read only the authenticated member `/me` route, never fetch an aggregate and hide fields. Unknown enum/shape, malformed JSON, failed HTTP or unavailable context clears prior data and remains unavailable, never any valid four-state posture.

| Actual surface | Required projection |
| --- | --- |
| Group fixed-schedule drawer/editor | State, desired config, coverage/drift and the existing exact-key operations; no automatic action |
| Employee schedule | Own member-safe state/desired/applicability/reasons; no aggregate/counts/raw user IDs |
| Self decision trace | Own read-only desired revision/state/applicability/reasons |
| Admin decision trace | Read-only desired revision/state/producer comparison/reasons |
| Report | Group state and counts only; no operations or raw identifiers |

Use existing authenticated group contexts: member group choices come from the existing self rules projection. Group selection is presentation context, not a change to calculation-group attribution. Current configuration/effectiveness is explicitly distinguished from frozen historical trace facts. Keep existing editor saves and assignment/apply/rebuild/clear ownership; introduce no new writer or permission bypass. No new flags or broadened rollout.

## Completion gates

1. Strict parser positives and unknown/missing/extra/nested-forbidden field negatives for both shapes. No second frontend four-state derivation or reason sorting.
2. Shared loading tests cover 401/403/404/503/network/invalid JSON, group/org/principal changes, reload, out-of-order replies and unmount. Clear old data immediately, including failed new-context reads. Self requests have no user/org selector body/query or stale identity headers.
3. All five actual hosts import/use the shared projection, with four-state fixtures and member applicability legs. Mount-removal mutations must fail the corresponding browser assertion, rather than merely testing a standalone demo.
4. Real isolated UTF8 PostgreSQL evidence for two users/same org, two orgs, active/activation/membership negatives, spoofing before SQL, exact self minimization and same-instant admin/self parity. Preserve the prerequisite's assertions and record actual assertion status, not filtered header counts. Existing unchanged evidence may be retained only with pinned source applicability, not relabeled as a rerun.
5. Three actual browser viewports with synthetic data prove readable normal/error states and no overlap; screenshots and machine-readable receipts live under remote artifacts.
6. OpenAPI lint/build/guard/generated diff and SDK applicability, both web CI wiring points, affected plugin/neighbor tests, quality, independent exact-head review and actual-head required CI. No skipped/pending entry counts as success.
7. Each mutation restores source exactly. Preserve test/hook budgets, assertions and CI gate strength. Source and tracked clean/hash receipts are pinned before/after each stage.

## Current verification record

| Gate | Current evidence | Status |
| --- | --- | --- |
| Strict shared parser and read lifecycle | 52 actual assertions, including HTTP/error/unknown shape, old-group replies, org/principal/token change and unmount; two matching-red guard mutations restored byte-for-byte | Local passed |
| Five actual hosts and membership refresh | 17 host assertions plus two subsequent membership-removal/failed-refresh assertions; 67 existing editor/trace/report neighbor assertions retained at unchanged source | Local passed |
| Member authorization and parity | Isolated UTF8 PG: 43 actual assertions, including the added coexisting-legitimate-witness/non-member subject negative; 24 real route-table/identity assertions; six PG predicate mutations each named red | Local passed |
| Browser layout and actual host reachability | Actual app entry at 1366/768/390 desktop-browser viewports: 105 normal/error checks; each of five actual source mount removals triggered its matching browser assertion; restored source hashes verified | Local passed |
| OpenAPI and SDK | Actual guard/build/SDK generation, security validation and parity commands exit 0; generated JSON/SDK AST audit confirms exact self keys, nullable historical ends, nine reasons and no existing path/schema changes | Local passed |
| Both web execution gates | Both specs present in domain workflow triggers/classification/execution and unconditional required runner; execution-wiring assertions passed | Local passed; final CI pending |
| Quality and fixed-source independent review | `pnpm validate:all` exit 0 with frozen source hashes; independent gpt-6.1-sol/high review matched all 20 source hashes before/after and found no confirmed introduced P1/P2 | Local passed |
| Exact-head required CI | Must be terminal success on the published head; local results do not substitute | Pending |

Evidence lives in the owned remote artifact directory `artifacts/attendance-fser4-five-surfaces-20261024/`; screenshots use synthetic data. PG probes exercise the canonical service against real SQL and retain original integration setup semantics; route-table tests are not a live JWT/RBAC end-to-end claim. Browser network fixtures are exported by the canonical service/key builder over isolated PG, not real tenant UAT. Narrow desktop-browser viewports do not claim mobile-device certification. The temporary probe config initially merged the broad integration include; that collection-only attempt was excluded, corrected to a single explicit probe include, and no passed positive suite was repeated. The first cold browser navigation timed out before assertions; the same unchanged 30-second navigation budget subsequently passed the full matrix.

The main agent owns integration and verification; Grok 4.7/xhigh and Kimi K3 are bounded read-only advisers, not test evidence. All source, tests, builds and original artifacts stay in the owned Mac mini copy. Global one owned heavy task.

Refs #4709; refs #4556. This slice alone is not proof that all DingTalk work or any live environment is complete.
