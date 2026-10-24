# Directory OPS-02 complete preview effects — 2026-10-24

Status: authorized final-closeout implementation, Draft/HOLD only. Base 8a426818804897a20f7674c39c56b3a445909c3a. Refs integrated roadmap §7.3 and its preview/apply parity acceptance.

## Required contract

Keep all existing preview fields. Add nonnegative prospective counts: wouldAdmitUsers, wouldBindAccounts, wouldUnbindAccounts, wouldCreateMemberGroups, wouldSyncMemberGroups, wouldAddMemberGroupMemberships, wouldRemoveMemberGroupMemberships, wouldAssignRoles and wouldAdmitNamespaces. Render all these fields in the existing preview UI. Do not claim a preview is an apply or a guarantee against concurrent changes or write failures.

- A bind/unbind is a change in confirmed linked local-user target, including clearing an old linked target after ambiguous identity resolution. Pending email/mobile candidates are not binds. Account inactivity, user-org/grant deprovision and link removal are distinct operations.
- Read ALL current integration accounts and links and construct prospective post-pull rows; apply walks inactive and absent accounts too. Preserve identity ambiguity precedence, existing-link handling, scoped admission/exclusion and same-batch identity-map updates. Distinct hypothetical admissions need distinct internal subjects; duplicate accounts must reuse the earlier subject through the same matching cascade. No hypothetical IDs leave the preview.
- Reuse actual department ancestry/group-marker/grant-set rules. Group membership counts are additions and removals against the current sets, not desired sizes. Role count is missing user/role pairs (actual apply INSERT RETURNING semantics); namespace count is absent/disabled pairs. Existing enabled grants are not new admissions; removal from a group does not invent role/namespace revocation.
- Resolve counts from a read-only snapshot and in-memory simulation. Do not call writers, claim a run lease, create users/groups, issue passwords/invites, change flags or execute apply and roll it back. Existing mocked provider pull and running-sync refusal remain; no live provider calls in validation.
- Existing platform-admin permission and route response envelope remain. Only the existing private preview response is extended; document the contract. Errors are fixed values-free codes/messages. No schema change or public OpenAPI/SDK claim if the private route is absent there.

## Explicit traversal disposition

Apply currently iterates an unordered account SELECT and updates match maps during the walk. Fix processing order to ascending external_user_id with a shared binary string comparator in BOTH preview and apply. This is a deliberate deterministic disposition of the previously unspecified same-batch order; it can determine which duplicate gets admitted first. No change to identity matching priority, permission, admission scope, deprovision policy or writer transaction boundaries. Existing group-marker lookup will also use an explicit ID order so preview uses the same legacy last-row choice for duplicate markers; no new marker or group-selection policy.

## Gates

1. Named original-source failures for new preview fields/effects, with retained positive controls.
2. Pure effect planner unit cases: distinct/duplicate new subjects, existing groups and sets, overlapping groups, duplicate plan markers, existing/missing roles and enabled/disabled/absent namespaces; no accidental revocations.
3. Existing full route and preview/matching/group/governance neighbors; full shapes and fixed failure responses.
4. Actual isolated UTF8 PG preview/apply comparisons: current links, external identities, pending matches, ambiguity/unlink, missing/inactive accounts, distinct and duplicate admissions, ancestry groups, missing/existing assignments and grant pairs, empty/config-off, cross-integration isolation. Snapshot relevant table counts/content to prove preview writes nothing. Real writes only normal apply in the isolated fixture with provider IO mocked.
5. Mutations must independently detect binding/subject collapse/group diff/role-or-namespace overcount/order drift. Restore exact source. Skips/filtered cases never count as passes.
6. Existing UI + new preview counter host cases in both domain and required lanes, registry UNION preserving old tokens; actual main-entry synthetic screenshots at1366/768/390.
7. Current-source quality, independent fixed-source review, exact-head required CI. Do not borrow another Draft's checks.

All PRs stay Draft/HOLD. No merge/deploy/R71/tag/release/business configuration changes. Stream/lifecycle OFF; real UAT and business50004 excluded. Historical08am PUT remains inconclusive. Other owner/manual closeout requirements remain open.

Known deterministic admission validation/identifier/alias conflicts do not produce a hypothetical successful admission; the existing eligibility-candidate counter remains distinct. Forecasts still do not promise success across future DB failures or concurrent changes. PostgreSQL read-only repeatable-read protects DB snapshot queries; no apply/rollback dry-run is used.

New account UUIDs do not exist during preview. Do not fabricate a UUID-based username and turn its guessed collision into a refusal. Preserve known existing IDs; compare the generator at both extreme UUID prefixes to detect whether the fixed name truncates the suffix entirely. Unknown future username collisions remain an explicitly conditional write outcome. Known fixed-prefix, email/mobile and alias conflicts are still checked; no user-generation rule is changed.

Role/namespace counters are actual association-row deltas, not a promise of effective permissions. A removed role-catalog entry was probed: actual current apply still inserts the configured user_roles rows. A proposed rejection test failed at the premise that apply would reject; it is retained as an invalid-premise diagnostic. This slice preserves apply policy and verifies row-count parity after catalog drift rather than inventing a stricter role policy.

## Local evidence and remaining gate

| Gate | Actual evidence / boundary |
| --- | --- |
| Original failures | Original host1 positive +3 field-display reds; original PG1 positive +1 missing-effects shape red. Harness-only postcheck string mismatch retained separately. |
| Full neighbors | Initial UI121 =4 new +83 view +34 workflow; backend236 =142 routes +14 pure +17 neighbors +63 lane guards. Their recorded source phases are preserved, not claimed fresh final reruns. |
| Current preview host |11/11; affected original Wave2 group16/16,67 filtered exclusions. Old headers/JSON/error/finally, A-B-A, unmount and current failed refresh covered. |
| Pure planner / ordering |14 initial pure cases plus2 new binary-order/stable-copy cases, each actually executed. |
| Isolated PG |456 migrations,pending0,UTF8.8 legacy cases passed in the first candidate phase;5 corrected/new effect cases +catalog-row parity +actual unbind parity +cross-integration parity passed in later phases.16 unique cases across recorded runs, not a fresh full16 claim. Snapshot13 tables before preview; mocked provider IO. |
| Independent mutations | Username conflict, distinct hypothetical subjects, bind count, unbind count, group diff, role overcount, namespace overcount and binary-order drift all produce named assertion failures; UI-field, workflow registration, ID-only fence and finally fence likewise red. Filtered cases never counted as passed. |
| Quality | Final production-source validate:all exit0; new unit/integration files explicitly linted. The later cross-integration addition changes only the excluded integration-test file, which passed actual PG execution and its own lint. Existing host-template lint violation reproduced on base at the same unchanged line; no adjacent template repair. |
| Browser | Actual main.ts entry; synthetic APIs only.1366/768/390 nine-field/legacy/caveat display, no panel overflow; late A cannot clear pending B or replace its result; current403 leaves no card.3 screenshots and5 scenario records. First race attempt stopped on two legitimate loading buttons sharing a label; scoped selector continuation reran only race/403. |
| Review | Astra/ultra static counterexample disposition, Kimi K3.1-pro username closure, Sol/high lifetime review; main independently executed all runtime evidence. Review is not runtime proof. |
| Required CI | Pending publication and exact-head13 checks; no prior PR's checks apply. |

Preview response ownership is scoped to a request generation and selected integration, including synchronous A-B-A invalidation and unmount. Same-ID save refresh preserves ownership. A new preview clears its old card; stale continuations cannot publish data/errors or clear a newer request's busy state.

The unbind fixture retains current schema/index guards: two distinct raw union values normalize to the same identity key, with both rows visible through the existing identity query. Initial duplicate-owner/raw-union setup attempts were refused by existing constraints and excluded; no constraint was weakened. A foreign integration with the same provider IDs in a different corp keeps its accounts/links/group/members/identities byte-equivalent across A preview and apply.

This Draft's tests are synthetic, isolated and scoped. No live directory, real tenant, effective-permission acceptance, provider write, Windows deployment, UAT or whole-product completion is claimed.
