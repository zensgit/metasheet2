# Attendance parent Return/history candidate design-lock — 2026-10-26

Status: Draft implementation locally qualified; exact-head CI pending, under the already authorized parent Return/history scope. Not merged, deployed, or a whole-parent acceptance closeout.

Source base: `9bcaf4b8197eb9752f7eb5010bc0e0ba3cd6d651`.
Comparison only: private17 `e74d103654916dec76d2b1d1fb9f9837e052f191`.
Authorities: attendance-shift-group-advanced-capability-design-lock-20260723 §5.1/§7.5 and attendance-4711-group-context-routes-design-lock-20260801 §3.1–3.5.
MAIN clarified that restoring the existing frontend group/stage is within the authorized parent scope. This proposal adds no capability or ratification gate.

## Small navigation intent

History contains only typed metadata: `groupId` (technical UUID), closed local `stage`, safe `origin`, and component/session `nonce`. There is no handle-to-group Map, per-entry private registry, count limit, expiry timer, or eviction policy. Older legitimate history entries remain usable for the current component/session.

Keep the current authentication/session signature and tenant comparison private. Regenerate the nonce on scope changes/reset and component unmount; compare private scope again before accepting intent and after asynchronous responses. Store no row, draft, person, token, or tenant identity in metadata. Technical group UUIDs in navigation history are permitted; values-free evidence does not prohibit them.

Attach metadata with `window.history.replaceState({ ...window.history.state, attendanceGroupReturn: ... }, '')`, preserving Vue Router's fields and omitting the URL argument. Attaching intent does not navigate or remount a draft.

## Route authority and safe return

Canonical params remain the sole active group/step authority. On canonical routes metadata is only checked/carried for navigation association with the same parsed canonical group; it never selects a group, local stage, editor, or authorization. Existing canonical hosts perform their unchanged authorization probe. Explicit Return validates the same-group association before passing intent to the origin. Existing direct same-group canonical pushes retain this association.

Only a noncanonical origin restore consumes intent to request an editor. Reuse the existing safe returnTo normalizer, reject its unsafe-input fallback rather than silently changing origin, and compare origin pathname and query semantics while ignoring decorative hash. Query-key ordering and equivalent encoding do not matter; order of repeated values is preserved. Unrelated query keys are allowed and preserved. No group/stage/organization query selector is introduced; those keys, if present, are ordinary origin text and never authorization or selection input.

A well-formed local intent triggers a fresh authenticated GET /api/attendance/groups/:id, with no organization override. No returned editor mounts until a successful matching-row response. Foreign IDs remain subject to server authorization. Malformed, stale-nonce, mismatched-origin/association, denied/missing, and wrong-row states do not silently seed a different group. Unknown metadata is not an authorization grant or a tamper-evident signature.

Initialize the editor once from the fresh authorized row and existing closed local stage. Later group catalog responses reconcile the list without replaying editAttendanceGroup over a new draft. Responses after navigation, scope change, or unmount are inert.

## Existing boundaries

Canonical route enums and surface parsers are unchanged; Basics/People remain local stages. No new API, business capability, flag, writer, global cross-scope cache, or query contract. Bare canonical links without source intent retain existing safe fallback behavior. Reload/unmount/scope change invalidates the nonce; no restoration across those boundaries is promised. Existing desktop/mobile gates precede the return probe.

## Actual validation and remaining gates

| Gate | Actual state |
| --- | --- |
| Original main Return/Back reproduction | 2 matching failures /13 filtered exclusions after awaiting real router navigation. Earlier attempt stopped at an unmet navigation precondition and is not defect proof. |
| Candidate scope/tab/home risks | 11 named failures and1 unchanged-scope positive control before the minimal fixes;15 filtered exclusions. |
| Metadata, local stage, origin, nonce and Return/Back/Forward | 49 actual passed,0 skipped in the two changed files before the final narrow canonical-tab fix. |
| Canonical-tab association | 2 new matching failures /27 exclusions; after bounding current-entry clearing to noncanonical parents,2 new cases plus2 existing returned-parent tab controls passed /25 exclusions. Not a fresh whole51 run. |
| Actual editor and neighbors | 214 actual passed /0 skipped in7 files, including147 admin cases with delayed-catalog draft preservation. |
| Six matching guard mutations | Nonce4red, response-scope4red, automatic-neutral2red, explicit-tab-exit2red, matching-row1red+1control, catalog-draft1red. Filtered cases excluded; original bytes restored after each. |
| Two-point required web wiring | Domain path/classifier/run and required invocation added; generated token manifest matches. No baseline tokens dropped. |
| Applicable quality | Global validate:all and initial web build exit0. After the one-line canonical-tab correction, strict production/helper lint exit0; mounted-history fixture lint has0 errors and7 one-component-per-file warnings. Final affected type-check/build each exit0. No rule/config waiver. |
| Actual main browser and screenshots | 11 actual-main synthetic scenarios closed across3 phases, including original canonical mobile/touch gate. Initial anonymous-plugin mock refusal, boot-hash assumption and nonexistent admin CSS selector are retained harness failures. Nine then one then one valid greens were retained; no full fresh matrix claim. No actual task-home transition claim from the Admin Center tab. |
| Independent closure | Initial two P2s and explicit parent-exit source risks closed. Canonical-tab association found by independent review, reproduced and minimally corrected; final source closure confirms no open P1/P2 in scope. |
| Latest-main private integration and exact-head required CI | Pending after this candidate is qualified and delivered as a Draft. Existing17-input proof does not include it. |

## Explicit exit versus invalidation

An intentional exit from a returned parent deletes only the current entry's metadata, preserving router state fields and older same-session history intents. Scope changes rotate the nonce and keep active return flows in a neutral unavailable posture, with an explicit recovery action. A response/JSON continuation that observes the change before a storage event also settles loading; obsolete generations never invalidate newer navigation.

On a canonical group route, the existing query-only top-tab action does not leave the route. Preserve its return association; this slice does not redesign that baseline routing behavior. Reports/Overview and Management home transitions after returning to the noncanonical parent clear the current intent, including a queryless origin.

## Evidence boundary

The shell history tests stub the inner admin component; the147-case mounted editor run separately proves one-time hydration and delayed catalog draft preservation. Matching metadata is navigation intent only, never authorization. Existing API401 redirect behavior is unchanged and is not claimed neutral. No screen-reader human acceptance, real tenant/provider traffic, UAT, activation or deployment is claimed. All flags remain OFF and R71 unchanged.

The previous opaque-handle/Map proposal and its syntax report are superseded. Current evidence is recorded in the isolated worktree's artifacts, including original invalid harness attempts and all correction phases; no old green head is borrowed.

Main local evidence: artifacts/attendance-parent-return-history/verification.json and four original synthetic screenshots. The full remote audit retains phase-specific raw results, source hashes and cleanup. No new metadata/API authorization authority or owner approval is implied.
