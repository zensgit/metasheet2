# Admin console issues 1 to 5 design lock

Owner authorized 2026-10-14. Baseline ec8d97cc481d3c6835a97c197a93cd00d10151e2. Scope derives from the supplied issue document's first five items only. Screenshots are reports, not proof of current-main reproduction. No password, user identity, host or customer content belongs in public evidence.

## Ordered slices

1. Items4/5: reproduce role revoke/readback and direct grant/effective-permission mismatch using synthetic subjects. Show selected role membership, visible success/failure beside controls, refresh the intended user's state after writes. Separate direct grants, inherited grants and effective permissions; explain blocked namespace admission without implicitly enabling it. Inspect persisted membership, legacy claims, cache, write/read and effective authorization before attributing cause. Preserve admin/delegated scope and existing tenant/admission security. No blanket bypass or synthetic green from unreachable dependencies.
2. Items1/2: password helper/validation matches actual server policy (currently minimum8; no invented complexity). Surface readable inline errors. Bound multitable field picker to viewport, allow vertical and necessary horizontal scrolling without breaking field selection or grid scrolling.
3. Item3: paginated role members within existing authorized scope. Chinese presentation for built-in names/descriptions; stable identifiers and custom labels unchanged. Do not rewrite global seed data or leak unauthorized member details.

## Gates

| Gate | Requirement |
| --- | --- |
| Current baseline | Fetch/reconcile latest main before public review/merge |
| Reproduction | Each reported correctness issue has a focused reproduction or explicit non-reproduction and runtime-version uncertainty |
| Implementation | Surgical changes; extract helpers from already large views |
| Tests | Exact positive and negative assertions, neighboring file, role revoke失权, direct grant readback, admission-disabled negative and second tenant/scope deny |
| UI specs | Wire new specs into domain guard and required web-test script; retain union of existing chain |
| Native qualification | Mac mini dedicated synthetic environment, actual DB/browser evidence, source identity, restore/shutdown |
| Independent review | Grok implementation, Sol medium for UI / high for authorization; concrete adversarial review and mutation of correctness guards |
| Quality | validate:all before PR preparation |
| Deliverables | Concern-separated local commits, development/verification MD and PR bodies with results/limits |
| Publication | New public push/Draft PR awaits explicit owner approval; no merge or deployment inferred |

No deployment, customer data, real CI variables/protection, external writes or flag enablement. Preserve unrelated worktrees. Existing6393 main-CI watcher remains independent. No DeepSeek.
