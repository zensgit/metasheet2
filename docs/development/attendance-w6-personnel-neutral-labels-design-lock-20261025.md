# W6 personnel neutral labels — Draft repair lock

Status: Draft/HOLD. The owner explicitly requested the remaining W6 personnel-label repair on 2026-10-25. This authorizes this narrow implementation and verification, not merge, deployment, enablement or production acceptance.

Baseline: actual origin/main `8a426818804897a20f7674c39c56b3a445909c3a`.

## Contract and source facts

- Parent `attendance-shift-group-advanced-capability-design-lock-20260723.md` §2 R7: unknown/deleted actors render neutral labels, no raw-ID or cross-org display fallback. FE-06 in the W8 plan is not globally certified by this slice.
- The W6 aggregate remains values-free and contains no personnel list. Its existing neutral-label helper was previously inert; this repair connects the existing group-editor personnel surfaces rather than adding identities to the aggregate.
- Current `/api/attendance-admin/users/batch/resolve` resolves within authorized scope. Its organization query admits only active users with active membership; `missingUserIds` therefore conflates nonexistent/deleted, inactive and out-of-scope users. It has no deletion/tombstone enum. A missing result or request failure must **not** be labeled deleted.
- An explicitly authorized inactive row remains its name/email with the existing Inactive secondary label. Missing name and email use the same neutral label as unresolved users. No cross-org or global retry is added.

## Minimal repair

Reuse `attendanceGroupEffectivePolicyNeutralMemberLabel('unknown', tr)` in two small member/owner DisplayLabel wrappers. Keep the original real-name-only PrimaryLabel functions byte-identical: they still control whether a genuinely resolved technical ID is visually clipped. Pending chips use the same neutral fallback and remain visually distinguishable when unresolved. Removal accessible names include the exact technical ID. Keep valid persisted names/emails, the separately marked technical identifier fields needed to distinguish same-label people, original add/remove payloads, role semantics, picker requests and secondary metadata. An identifier remains a technical field; it is not the primary display-name fallback. Do not guess deletion from missing rows, inactive status, transport errors or caller input.

No new writer, route, permission, API field, flag, dependency or database operation. Do not alter the unmerged #6534 read fences or #6539 navigation work; their later composition remains separate evidence.

## Gates

| Gate | Required evidence / current status |
|---|---|
| Original source red | Actual original-source 20 matching failures + 2 controls / 32 filtered exclusions. Independent review exposed a hidden-ID regression; its matching reproduction is 21 failures + 4 controls / 32 exclusions. The earlier 54 green is superseded. |
| Member and owner rendering | Final real AttendanceView mounted host: 57/57 actual assertions passed, zero skip. Missing/indeterminate-deleted representation and 403/404/500/network cases use neutral primary labels, with no unexpected foreign-row label leakage. Resolver authorization semantics are unchanged, not established by mocks alone. |
| Exact identity / writes | Two unresolved members/owners/pending selections with the same neutral label retain separate unclipped technical IDs and ID-bound removal names. Actual pending removal preserves the other chip and makes no member write. Original writer functions and removal targets remain exact baseline bytes; no broader resolved-duplicate-name visual certification. |
| Inactive / names | Actual member/owner positive controls preserve trimmed names, email fallback and explicitly supplied authorized Inactive secondary labels; missing results never imply deletion. |
| Mutation | Three independent mutations (neutral fallback, visual identity, accessible removal) each produced 3 matching failures + 2 positive controls / 52 exclusions; candidate bytes were restored exactly after each. |
| Browser | Actual index→main.ts→App/router→Experience→group context→AdminCenter→AttendanceView with synthetic API/auth. 1366 Chinese and 768 English passed neutral labels, separate technical-ID geometry (>1px), ID-bound remove names and inactive/foreign-label controls. 390 honestly remains blocked by the existing mobile admin gate, not editor proof. 30 actual source paths stable before/after; zero pageerrors/writes/forwarded externals. One console.error and one blocked WebSocket per viewport were counted; raw console text was not retained, so no zero-console claim. Own server exited and port closed. |
| Quality / CI | Local: host57, web wiring36, backend lane guards63, manifest check, Bash syntax, changed-file lint and validate:all passed. One earlier unchanged helper neighbor passed / 145 filtered exclusions, carried only for identical helper runtime. All 624 old required tokens preserved + one mounted token. Whole AttendanceView lint retains main's 17 diagnostics, introduced0. Production build exit0; synthetic actual main-entry browser passed with mobile gate preserved. Current-head two-lane execution/required CI remain pending until published and terminal; local green is not CI. |

Stream/lifecycle OFF; real UAT and business50004 excluded. No merge/deployment/R71/tag/release/config changes. Historical08am PUT remains inconclusive. This closes only this personnel display residue, not FE-06 across all product surfaces, full W8 acceptance or owner/live residuals.

## Durable local evidence

`artifacts/attendance-w6-actor-labels/verification.json` records phase-pinned actual assertion counts, all three matching mutations, source hashes, browser geometry and limits. Three linked PNGs contain synthetic data only. Earlier interrupted/superseded validation remains in the isolated audit receipts; no successful unchanged suite was repeated to improve a receipt. Required CI and integration with the other unmerged Drafts remain separate pending gates.
