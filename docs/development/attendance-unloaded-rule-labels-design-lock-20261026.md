# Linked rule display honesty
Draft/HOLD. Refs attendance-shift-group-advanced-capability-design-lock-20260723 §5.1 / §7.5.

## Reproduction and scope
A saved group has a nonempty linked ruleSetId absent from the loaded catalog. Actual main-entry synthetic browser renders Default in the policy card while showing the unresolved ID as Rule set in card and drawer. No default inheritance was established by that lookup failure.

## Contract
- No link still displays the existing Default / workspace-default posture.
- A loaded link keeps the exact loaded name.
- A nonempty unresolved link displays localized Linked rule set is not loaded; never Default or the ID as its primary name.
- Preserve the unresolved identifier separately as explicitly labelled Rule set ID technical metadata, and retain the existing not-loaded status.
- No new query, permission, writer, calculator, policy-state inference, schema, flag or provider behavior.
- Configuration IDs here are not actor identities: this repair does not claim a new actor-R7 security finding or deleted-record inference.
- This does not complete the universal legacy summary source/effect crosswalk.

## Gates
| Gate | Evidence required |
| --- | --- |
| Reproduction | Actual main-entry card/drawer plus exact failing mounted cases |
| Counter-controls | No link / loaded link unchanged; no writer from opening drawer |
| Targeted regression | New cases and existing group manager neighbor |
| Mutation | Independently restore misleading Default and raw primary ID; matching negatives red |
| Actual UI | Synthetic real main entry in English/Chinese, strict readonly endpoints, screenshots |
| Quality / review | validate:all, independent review, main disposition, Draft PR |
| Current-head CI | Pending until remote required checks all terminal success |

No merge/deploy/R71/tag/release/config changes; Stream/lifecycle OFF; real UAT/business50004 excluded. Human/live/owner and route-return residuals remain separate.

## Actual scoped qualification

- Target functions byte-equal between actual private17 browser baseline and fresh main; fresh-main mounted reproduction2matchingred+2positivecontrols,146filtered exclusions.
- Four new cases plus existing group-manager neighbor5actualpassed; separate new local-search/CSV case1actualpassed with exact9column row and zero new apiFetch calls. Source phases are retained; no fresh six-case/full151 run is claimed.
- Two precise matching mutations1red each,150filtered exclusions each; exact restore. An initial wrong identical import-helper replacement was no-op and is excluded from negative evidence.
- Actual main entry1440/en,768/zh,375/en: neutral primary card/drawer, explicit Rule set ID, six screenshots visually reviewed, no app writes/external/page errors. Desktop responsive context, not mobile touch UAT.
- validate:all0 and changed-test ESLint0. No full mega-Vue ESLint claim. Independent Sol/medium review found no confirmed introducedP1/P2; main audited runtime and later additive CSV/search case.
- Shared helper intentionally changes displayed CSV/search/import-batch names for unresolved links; it changes no server query or calculation.
- Exact-head required CI pending until separately recorded on the Draft PR.
