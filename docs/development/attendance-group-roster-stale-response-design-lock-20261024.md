# Attendance group roster stale responses — 2026-10-24

Status: implementation under the owner-authorized attendance closeout, Draft/HOLD only. No merge, deployment, business configuration, R71/tag/release change, Stream/lifecycle enablement, real UAT or business error 50004 work. Historical 08:00 PUT remains inconclusive and unrelated to this source finding.

Base: `fdb30a671686db8dbdbdf606f3a6f1b98add9969`.

## Problem and bounded repair

The member/owner readers share the selected group lists. An earlier group's success or 403 can commit after a later group's response, including after A → B → A. The page session can remain valid throughout. This bug already exists on main and is not introduced by the five-surface composition.

A small sibling module binds each read to its generation, group, presentation organization and existing page session. Selection/context invalidation is synchronous, independently of the queued loader watcher. Check after headers and JSON before committing rows, total, permission posture, labels, errors or loading state. Label reads share their parent read's validity. Clearing the selection stops loading. No writer, endpoint, permission, timeout, method conversion or configuration is added or changed; existing current-request behavior remains authoritative.

## Verification gates

| Gate | Evidence at preparation |
| --- | --- |
| Original real-host reproduction | 2 normal B-first controls passed,16 named late-response cases failed,exit1; both arrays/counts and actual DOM affected; source unchanged |
| First candidate same original tests | 18/18 actual passed,zero skip,exit0; original test bytes unchanged |
| Empty selection | Additional two cases caught pending-loading state after generation invalidation;2 matching red/18 filtered; loading reset corrected; final combined20/20 passed |
| Both CI execution points | New spec and source in domain trigger/classifier, actual targeted execution; required runner live token plus generated manifest; domain/static wiring verified; full lane guards63/63 passed |
| Restoration and mutations | Original helper/source bytes archived; generation and post-JSON guards each yield1 matching red/19 filtered; all seven frozen path bytes restored |
| Neighbor, quality, independent review | Actual-host/session/wiring neighbors97/97; pnpm validate:all exit0; gpt-6.1-sol/high read-only review found no confirmed introduced P1/P2 within reviewed scope |
| Synthetic browser and exact-head required CI | Actual app entry at1366/390 retains B member/owner rows after delayed A; screenshots recorded. Exact-head required CI pending publication; local tests do not substitute |

Actual assertions are counted from assertionResults, not Vitest header totals. Filtered cases are excluded, not passes. The tests use synthetic fixtures in an owned Mac mini worktree, mock HTTP IO, and block real fetch. They exercise the actual AttendanceView and existing page-session guard; they do not prove server authentication or a live environment. Evidence remains under the owned remote artifacts directory.

This slice makes no claim that all historical incidents or all attendance issues are closed. Refs #4556.

The read-only review records limits for an org change or same-task A-B-A with no successor read, and pending-unmount under an inherited guard; these are not claimed as directly verified supported-UI scenarios. No blanket lifecycle guarantee or server authorization bypass claim is made. Screenshot framing was corrected from a clipped element capture to a viewport capture; both original capture receipts are retained.
