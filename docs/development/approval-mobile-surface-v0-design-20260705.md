# T3-1 v0 mobile approval surface — i18n follow-up (design)

Date: 2026-07-05
Ballot: `docs/development/approval-automation-third-batch-ballot-20260702.md`, section **T3-1 — mobile approval surface**

## Important grounding note — read this first

This PR does **not** build T3-1 v0 from scratch. On a fresh clone of `origin/main`
(forked at `bba53d1e3f68b57a268b595231691a7308fd450f`), the T3-1 v0 mobile approval
surface — flag gate (Q11), responsive card list (Q10), restricted action set (Q8),
unified-endpoint + refresh-on-4xx concurrency (Q7), read-only cached list (Q6) —
was **already implemented and merged** via **PR #3517**
(`feat(approval): T3-1 v0 mobile approval surface (responsive web, flag-gated
default-off)`, merged 2026-07-03, commits `7ea3481e1` / `9bc7350e3`).

That PR's own description honestly flagged one build-contract must-fix as
**unresolved**:

> **i18n tension:** the approval module has **no i18n infra** (100% hardcoded
> 中文, no `useLocale`). I matched the module's convention + reused its
> status/date helpers; genuinely new strings are `加载中…` / `暂无审批` /
> `审批申请`. Retrofitting half-i18n into one module would be worse — flagging
> for your call.

The ballot's T3-1 build contract is explicit:

> All user-facing labels must go through i18n, including mobile-only
> empty/error/action states.

That must-fix was real and confirmed still open on `origin/main` at fork time
(grep for `useLocale`/`isZh`/`$t(` across the mobile-surface files returned
nothing). **This PR is the smallest verifiable remaining T3-1 v0 slice**: it
closes that specific, named gap. It does not re-touch Q1–Q11 rollout
behavior, which is already shipped and unaffected here.

## What this slice locks

1. **Scope is exactly the NEW strings T3-1 v0 introduced**, not a general
   approval-module i18n audit:
   - `ApprovalMobileList.vue` (new component, #3517): loading text, empty-list
     default, per-status label map, per-row title fallback, and the date
     formatter's hardcoded `zh-CN` locale.
   - `ApprovalCenterView.vue`'s four mobile-only `empty-text` props (one per
     tab: pending / mine / cc / completed), which were inline Chinese string
     literals introduced alongside the `<ApprovalMobileList>` mount points.
   - `ApprovalDetailView.vue`'s T3-1 diff was re-audited and introduces **no**
     new user-facing strings (it only adds `v-if="!isMobileLayout"` gates
     around desktop-only action buttons that already existed pre-#3517), so
     it needed no i18n change.
   - The rest of the approval module (desktop `ApprovalCenterView.vue` labels,
     `ApprovalDetailView.vue`'s pre-existing action buttons, `api.ts`, etc.)
     is pre-existing, non-i18n'd, and **out of scope** — that debt predates
     T3-1 and is not implied by this ballot rung. Retrofitting the whole
     module in one slice would violate scope discipline in the other
     direction.

2. **No new i18n mechanism.** The app already has an established convention —
   `useLocale()` (`isZh` boolean + `setLocale`) plus a local `computed`
   bilingual dictionary per component/composable — used in ~77 files
   including `ApprovalInboxView.vue` and
   `multitable/composables/useNotificationInbox.ts`. This slice reuses that
   exact pattern rather than introducing a new i18n library or key-catalog
   scheme, keeping the module's convention consistent.

3. **Explicit-override semantics preserved.** `ApprovalMobileList`'s
   `emptyText` prop stays a caller-supplied override (e.g. "no search
   results" copy from `ApprovalCenterView.vue`); the localized default
   (`t.value.empty`) is only used when the caller does not pass one. Locale
   never overrides an explicit override.

4. **No behavior change to Q1–Q11.** This slice does not touch
   `stores/featureFlags.ts`, the `approvalMobile` gate, the responsive
   viewport logic, the action-set restriction, or the unified-endpoint
   concurrency path. The mobile surface remains **default OFF**, unchanged
   from #3517.

## Non-goals (unchanged from the ballot, restated for this slice)

- No native app / PWA (Q1). No out-of-app push (Q2–Q5). No offline mutation
  queue (Q6 stays read-only cached list). No new backend contract (Q7 stays
  the version-less `/actions` endpoint). No new mobile action types beyond
  approve/reject/comment/initiate (Q8). No full `/m/*` route tree (Q10).
- No i18n audit of the pre-existing (non-mobile) approval module — that is a
  separate, larger cleanup outside T3-1's scope.
- No CI workflow changes: repo-wide search found no `.github/workflows/*.yml`
  gate that references `ApprovalCenterView.vue`, `ApprovalMobileList.vue`, or
  any `approvalMobile*` spec by path/name (the one existing scoped gate,
  `approval-web-guard.yml`, is filtered to the template-authoring/detail-field
  helper surface and does not match any file this slice touches). There is
  no explicit allowlist to add this slice's new spec to.

## Reviewer must-check

- Confirm the scope call above (new-strings-only vs. whole-module i18n) is
  the right cut, not scope creep the other way (i.e., not under-scoped).
- Confirm the `useLocale`/`isZh` local-dictionary pattern is still the
  intended app convention (vs. a newer i18n approach adopted elsewhere since
  #3517 merged).
- This PR is a PROPOSAL; merging it both treats the T3-1 ballot defaults as
  adopted (consistent with the "Voting examples" line `T3-1 all ✅` in the
  ballot doc, which remains formally unchecked `⬜` per-line in the table
  itself) and accepts this specific follow-up slice.
