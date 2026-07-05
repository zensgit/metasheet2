# T3-1 v0 mobile approval surface — i18n follow-up (verification)

Date: 2026-07-05
Companion design doc: `docs/development/approval-mobile-surface-v0-design-20260705.md`
Branch: `claude/build-t3-1-mobile-v0-20260705`
Grounded on `origin/main` at fork: `bba53d1e3f68b57a268b595231691a7308fd450f`
(one doc-only commit, `28136b5c3` "docs(integration): recursive expansion
direction design-lock", landed on `origin/main` after the fork; unrelated to
this slice, not rebased onto to keep this verification's numbers reproducible
against the exact SHA tested).

## What this PR is and is not

This is **not** the initial T3-1 v0 build — that already shipped and merged as
PR #3517 before this session started (see design doc's grounding note). This
PR is a narrowly-scoped **follow-up slice**: it closes the one build-contract
must-fix ("all user-facing labels via i18n") that #3517 explicitly and
honestly flagged as unresolved. Q1–Q11 rollout behavior is unchanged.

## Files touched

- `apps/web/src/views/approval/ApprovalMobileList.vue` — replaced hardcoded
  Chinese literals (`加载中…`, `暂无审批`, `审批申请`, the 5-entry status-label
  map, and the hardcoded `toLocaleString('zh-CN')` date format) with a
  `useLocale()`-driven `computed` bilingual dictionary (`t`), mirroring the
  app's existing `ApprovalInboxView.vue` pattern. `emptyText` prop default
  changed from a hardcoded string to `undefined`, with a new
  `resolvedEmptyText` computed that falls back to the localized default only
  when the caller does not supply an override.
- `apps/web/src/views/approval/ApprovalCenterView.vue` — the four mobile-only
  `:empty-text="…"` literals (pending/mine/cc/completed tabs) replaced with a
  new `mobileEmptyText` computed keyed off the same `useLocale()` `isZh`.
- `apps/web/tests/approvalMobileResponsive.spec.ts` — **existing, previously
  merged** spec updated: added `useLocale().setLocale('zh-CN')` (+
  `localStorage.setItem('metasheet_locale', 'zh-CN')`) in `beforeEach`. This
  was required because the spec's fixtures/assertions are Chinese
  (`'待处理'`, `'张三'`) and jsdom's default `navigator.language` is
  English-like, so once labels became locale-aware this spec would otherwise
  non-deterministically depend on environment default rather than an
  explicit pin — confirmed necessary by running it red first (see below).
  Mirrors the existing zh-pin convention used by
  `attendance-experience-mobile-zh.spec.ts` et al.
- `apps/web/tests/approvalMobileI18n.spec.ts` — **new**, the fail-first spec
  for this slice (below).
- `docs/development/approval-mobile-surface-v0-design-20260705.md`,
  `docs/development/approval-mobile-surface-v0-verification-20260705.md` —
  this pair.

`ApprovalDetailView.vue` was audited (`git show 9bc7350e3 -- ...`) and
confirmed to introduce no new user-facing strings in its T3-1 diff — not
touched.

## Fail-first test

**Name:** `apps/web/tests/approvalMobileI18n.spec.ts` →
`ApprovalMobileList — i18n retrofit (T3-1 build-contract must-fix)`
(3 cases: renders English labels when locale is `en`; renders Chinese labels
when locale is `zh-CN`; an explicit `emptyText` prop always overrides the
localized default in either locale).

**RED-before condition, actually reproduced:** `git stash push -- apps/web/src/views/approval/ApprovalMobileList.vue`
(reverting only the component back to its pre-retrofit, #3517-merged,
hardcoded-Chinese state) and re-running the new spec:

```
❯ renders English labels when the locale is "en" ...
  expected ' 加载中… ' to be 'Loading…'
❯ renders Chinese labels when the locale is "zh-CN" ...
  expected ' 加载中… ' to be '加载中…'   (whitespace mismatch: literal vs. trimmed t.value.loading)
Test Files  1 failed (1)
     Tests  2 failed | 1 passed (3)
```

i.e. with the hardcoded strings restored, the component renders the same
Chinese text regardless of the active locale — the English-locale assertion
fails outright, and even the Chinese-locale assertion fails on an incidental
whitespace difference (`{{ ... }}` interpolation of the old template's bare
text node vs. the new `{{ t.loading }}` binding), confirming the test
actually exercises rendered output rather than trivially matching. This is a
sound discriminator: reverting the i18n retrofit reliably turns the new spec
red. `git stash pop` restored the fix; the spec was re-run and passes (below).

## Default-off proof (unaffected by this slice)

This slice does not touch `apps/web/src/stores/featureFlags.ts`,
`useMobileViewport.ts`, or any `hasFeature('approvalMobile')` call site. The
existing default-off proof from #3517 remains intact and was re-run
unmodified and green:

- `tests/featureFlagsApprovalMobile.spec.ts` (3 tests, unmodified) — proves
  `DEFAULT_FEATURES.approvalMobile === false`, `boolOrDefault` resolves to
  `false` absent an explicit backend/override boolean (no admin/mode
  inference), and an explicit backend/dev-override boolean flips it on.
- `tests/approvalMobileResponsive.spec.ts` → `'flag OFF + narrow viewport →
  keeps the desktop table, no mobile list'` (unmodified assertion logic,
  only the locale pin added) — still proves flag-absent ⇒ the mobile card
  list is not exposed even on a narrow viewport.

## Test runs (this session, against the fork SHA above)

- `npx vue-tsc -b` — clean, no errors.
- Targeted suite (9 files covering the mobile surface + adjacent approval
  center specs that could plausibly regress):
  `approval-center.spec.ts`, `approval-e2e-lifecycle.spec.ts`,
  `approvalCenterRemindBadge.spec.ts`, `approvalCenterSourceFilter.spec.ts`,
  `approvalCenterUnreadBadge.spec.ts`, `platform-shell-nav.spec.ts`,
  `approvalMobileI18n.spec.ts`, `approvalMobileResponsive.spec.ts`,
  `approvalMobileDetailActions.spec.ts` → **9 files / 93 tests, all green.**
- Full `apps/web` `vitest run` (437 files / 4659 tests): 16 files / 106 tests
  failed. **Verified pre-existing and unrelated**, not introduced by this
  slice: re-ran the full suite with this slice's runtime changes stashed
  (`git stash push -- apps/web/src/views/approval/ApprovalMobileList.vue
  apps/web/src/views/approval/ApprovalCenterView.vue
  apps/web/tests/approvalMobileResponsive.spec.ts`) and confirmed
  `featureFlags.spec.ts`'s 3 failures reproduce identically with or without
  this change. The remaining failures are in unrelated areas
  (`multitable-workbench-*`, `attendance-*`, `k3WiseSetup`, etc.) — the same
  categories #3517's own PR description already called out as pre-existing
  FE baseline noise (`featureFlags.spec` / `multitable-workbench-1672-1673`).
  None of the 16 failing files touch the approval-mobile surface or this
  slice's edited files.

## Explicitly NOT built / NOT verified here

- **No i18n audit of the rest of the approval module.** The desktop
  `ApprovalCenterView.vue` labels, `ApprovalDetailView.vue`'s pre-existing
  action buttons/dialogs, `approvals/api.ts` messages, etc. remain 100%
  hardcoded Chinese, exactly as before. That is pre-existing debt that
  predates T3-1 and is a separate, much larger cleanup — explicitly out of
  scope per the design doc.
- **No CI workflow wiring.** Repo-wide search found no `.github/workflows/*`
  gate keyed on `ApprovalCenterView.vue`, `ApprovalMobileList.vue`, or any
  `approvalMobile*` spec path — the one scoped approval gate
  (`approval-web-guard.yml`) filters on a disjoint set of paths (template
  authoring / detail-field helpers) that this slice does not touch. There is
  no existing allowlist to add the new spec to; it will only run as part of
  a full `apps/web` vitest invocation, which (per that workflow's own
  comment) is not currently a required PR gate for this app.
- **No change to Q1–Q11 runtime behavior.** Not re-verified beyond confirming
  the existing specs for those behaviors still pass unmodified.
- **Not independently adversarially reviewed.** Built and self-verified by an
  unattended L2 agent — see PR warning banner.

## What a human reviewer should check

1. Whether the new-strings-only scope cut (vs. a full approval-module i18n
   pass) is the right call, or whether the reviewer wants the debt closed
   more broadly in a follow-up.
2. Whether reusing the `useLocale()`/`isZh` local-dictionary convention (vs.
   some other i18n mechanism used more broadly at the point of review) is
   still correct.
3. Re-run the fail-first spec's RED condition independently if desired:
   `git stash` (or hand-revert) `ApprovalMobileList.vue` only, re-run
   `apps/web` `vitest run approvalMobileI18n`, confirm 2/3 red, then restore.
