# Existing personnel label and annual identity repair — 2026-10-25

Authorized existing-surface repair, delivered only as Draft/HOLD. Base: `9bcaf4b8197eb9752f7eb5010bc0e0ba3cd6d651`.
Reported drift from `8a426818804897a20f7674c39c56b3a445909c3a`: #6514 stock-preparation stores only; attendance unchanged.

## Scope facts and assumptions

Parent: attendance-shift-group-advanced-capability-design-lock-20260723.md R7 and §7.5: neutral unknown identity, org scoped reads, no raw-ID primary fallback. Preserve annual L5c advisory preview, confirm snapshot, idempotency and policy gates; S6 cap 50, dedup, sequential per-person writes and retry semantics.

Current useAttendanceAdminUsers.formatUserLabel falls back to ID for genuine blank identities. Exact retained sentinel is name=null, email=id, empty role and created_at: technical Current value, never trusted identity. Real supplied name=id remains valid; no UUID heuristic. Picker emits only supplied friendly identity. Annual subject formatting accepts an ID-bound trusted name, otherwise localized neutral primary plus explicit technical ID.

Current loadAnnualLeaveBalance clears at manual query start but reads live displayName after await. Capture target/name/org/scope and use a local request epoch with existing immutable session guard. New manual query (including empty), scope changes, stale session and unmount invalidate. Both awaits and all response/error/finally writes require ownership; returned userId must match. Selecting another person alone must preserve prior result and pending captured request. Scope A-B-A cannot revive old A.

Single-adjust search/preview capture scope/session/target/delta; selection invalidates search, manual input revokes trusted identity. Preview is advisory, never a write. Confirm payload, routes, amount formulas and authorization stay unchanged. Bulk labels bind to IDs; chips remove by ID, confirmed result rows use frozen row labels.

Existing balance state/types and query logic now live in `apps/web/src/views/attendance/useAttendanceAnnualBalance.ts`; identity formatting lives in `attendancePersonnelIdentity.ts`. No generic request framework. Full-view mounted tests remain in the existing attendance-admin-regressions suite; formatter and picker controls reuse attendanceLocaleControls, attendanceUserPickerEndpoint, useAttendanceAdminUsers. These four files already have domain + required wiring; no lane token or manifest changes. The separate pure bulk spec is untouched.

No creator-label, backend, API, permission, provider or flag change. Actual main-entry browser evidence uses only synthetic local reads; writes and external network are refused. The three existing annual write/retry functions and styles are byte-identical to the base. Two fixture hosts isolate mounted component lifecycles without disabling lint rules.

## Gates

| Gate | Actual evidence |
| --- | --- |
| Original wrong-person display | One matching failure: A balance was labelled Bob after selecting B; 169 filtered exclusions |
| Four changed existing specs | First full run 211 actual passes, zero skip; after test-only host/assertion changes, affected 3 cases revalidated, other cases carried by unchanged source |
| Ownership / identity mutations | Seven narrow guard removals produce 5/1/2/3/4/1/1 matching failures with positive controls; exact source restored |
| Technical retained-value gap | Initial mutation survived; real input assertion added, mutation now red, affected two cases green |
| Bulk scope name lifetime | Introduced P2 independently found, matching red reproduced and fixed; invalid readonly-computed stimulus excluded, corrected global stimulus red/green |
| Lint | No introduced diagnostics; AV17 / locale5 / picker2 inherited diagnostics remain, other changed files clean |
| Global quality and build | `pnpm validate:all` and web build exit0 on 9bc base |
| Browser | Real main/App/router host: 1440 zh and768 en capture A identity while B is selected; neutral subject keeps explicit ID;375 original mobile-admin gate retained |
| Browser IO / cleanup | Zero application writes, forwarded external requests, page errors; one intentionally refused bootstrap405 per context; own server stopped and port closed |
| F1 wiring | All four existing specs remain in both domain and required lanes; no workflow/runner tokens changed |
| Independent review | Source P2 closure independently reviewed; main independently verified runtime/status/source evidence |
| Remote required CI | PENDING new candidate head; never borrowed from another PR |

Evidence: `artifacts/attendance-personnel-label-provenance/verification.json`. Runtime receipts remain in the isolated validation artifacts. The full211 run preceded test-only fixture extraction; it is not claimed as a fresh final-head rerun. Filtered cases are exclusions, never passes. Existing writer payload/transaction tests prove only their original phases; no full transaction/rollback, parent responsive, native popup, live provider or UAT acceptance is claimed.375 is a product gate boundary, not editor coverage. All PRs Draft/HOLD; Stream/lifecycle OFF; no merge/deploy/R71/tag/release/config changes; real UAT/business50004 excluded; historical08am PUT INCONCLUSIVE.
