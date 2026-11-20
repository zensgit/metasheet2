# Shift segment keyboard and accessible field repair

Draft/HOLD. Refs parent attendance-shift-group-advanced-capability-design-lock-20260723 §7.5. No new calculation or writer capability.

## Reproduced problem
Actual main entry with two segments exposes four visible controls under the same generic time name, plus four clipped canonical inputs in Chromium's accessibility tree. Native keyboard removal of the final row leaves focus on the document body. Existing visible typed values, order/overlap errors and invalid-save no-request guard passed.

## Minimal contract
- Visible segment time controls have localized segment number plus Start/End names.
- In explicitly named segment fields, compatibility value inputs keep the original model/name/data attributes and event behavior, remain outside Tab order, and are absent from the accessibility tree.
- Sibling time fields without an explicit accessible name preserve their existing context-bearing compatibility input. No global hiding of unlabeled siblings.
- Keyboard add focuses the new row's visible Start; reorder focuses the moved row; remove focuses the surviving adjacent row. Do not add global focus handlers.
- No change to segment arithmetic, validation budgets, definition saves, authorization, flags, backend, schemas or API contracts.

## Gates
| Gate | Required evidence |
| --- | --- |
| Existing behavior | Original segment analysis tests plus affected locale/segment neighbor |
| Field/focus red-green | New exact names, hidden-value accessibility and native focus assertions; preserve original cases |
| Guard sensitivity | Revert field-name or focus repair separately; matching negatives red; exact restoration |
| Actual host | Real main entry, visible localized inputs, native keyboard, Chromium AX tree and screenshot; no real data |
| Integration | Existing segment spec present in both domain and required web lanes; validate:all |
| Review | Independent scoped review, main disposition, Draft PR and exact-head CI pending until terminal |

## Boundaries
Synthetic local validation is not a human screen-reader trial or complete parent product acceptance. No merge, deployment, R71/tag/release/config change. Stream/lifecycle OFF; real UAT and business50004 excluded.

## Local qualification

- Main actual original host: four identically named visible fields, duplicate compatibility values in AX, native Remove leaves BODY focus.
- Four focused red cases; 63 initial affected cases green, zero skipped. Initial full validate:all exit0.
- Independent review found sibling context regression; one new boundary red, then two affected cases green (13 filtered exclusions). Conditional hiding restores sibling baseline. Final affected web type check and scoped ESLint exit0; scoped ESLint reports two multi-component fixture warnings, not zero warnings.
- Three matching mutation groups and the updated conditional-hide negative each go red; source restored exactly.
- Actual main entry at1440/en,768/zh,375/en: qualified names, no segment canonical textboxes in AX, native Tab/Enter/Space action flow, overlap/order guard, invalid Save zero request, adjacent flex-context preserved; three screenshots visually reviewed. No writes/external traffic/page errors. This is not a human screen-reader trial.
- Exact-head required CI remains pending until separately recorded on the Draft PR.
