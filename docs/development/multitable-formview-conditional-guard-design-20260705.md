# Multitable — public-form conditional show-IF/required-IF guard: CI gap closure (design)

Date: 2026-07-05
Area: multitable
Type: CI-gate wiring only (no runtime change)

## The gap

`MetaFormView.vue` implements the public-form "conditional show-IF / required-IF"
feature (design MVP 2026-06-14, A4 follow-up): a field can carry
`property.visibilityRule` (hide/show based on another field's value) and/or
`property.requiredWhen` (require it conditionally). The load-bearing invariant,
stated explicitly in the component's own comments, is:

> a field hidden by a visibility rule is never treated as conditionally required
> (`MetaFormView.vue`, around `validate()`)

and in the shared evaluator (`field-visibility.ts`):

> a field hidden by a visibility rule is NEVER conditionally required (you
> cannot fill an invisible field; it must not block submit)

This is a real correctness guard on a **public, unauthenticated** form: if it
regresses, an external form-filler can be shown a submit-blocking "required"
error on a field that isn't even rendered — the form becomes unsubmittable
with no way for the user to see why.

Both `isFieldVisible` and `isFieldConditionallyRequired` (in `field-visibility.ts`)
reuse `evaluateRule` from `conditional-formatting.ts` — the same rule grammar
that drives cell conditional-formatting.

**Before this change, none of this had CI teeth:**

- `apps/web/src/multitable/utils/field-visibility.ts`, `apps/web/src/multitable/
  components/MetaFormView.vue`, and `apps/web/src/multitable/utils/
  conditional-formatting.ts` were **not** in the `paths:` trigger list of
  `.github/workflows/multitable-web-guard.yml` — editing any of them would not
  even cause the workflow to run.
- The corresponding fail-first specs (`apps/web/tests/multitable-field-
  visibility.spec.ts`, `apps/web/tests/multitable-required-if.spec.ts`,
  `apps/web/tests/multitable-conditional-formatting.spec.ts`) were **not** in
  the `vitest run <filter>` list inside that workflow, so even a manual/
  unrelated trigger of the workflow would not execute them.
- `plugin-tests.yml` (the main PR gate) only runs `pnpm --filter @metasheet/web
  build` for the web app — a TypeScript compile check, not a behavior test. A
  logic regression (e.g. `validate()` iterating the full field list instead of
  the visible subset) compiles cleanly and would go undetected.
- `.github/workflows/multitable-browser-verify.yml` **does** trigger on
  `conditional-formatting.ts` changes, but it is a real-browser Playwright
  render/screenshot lane (cell rendering + a reaction click), not a unit test
  of the pure evaluator functions (`evaluateRule`, `sanitizeRule`,
  `composeStyleObject`, …) or of the form's submit-gate logic. It does not
  exercise `MetaFormView.vue` or `field-visibility.ts` at all.

So a revert of the "hidden field is never conditionally required" invariant —
or of the underlying visibility-hide behavior — could land on `main` fully
green. This is a toothless guard: the fix exists, the fail-first tests already
exist and are of good quality (evaluator-level + full component mount/submit
assertions), but nothing in CI runs them for the files that implement the
guard.

## The fix (CI/config only)

Wired `apps/web/tests/multitable-field-visibility.spec.ts`,
`apps/web/tests/multitable-required-if.spec.ts`, and
`apps/web/tests/multitable-conditional-formatting.spec.ts` into
`.github/workflows/multitable-web-guard.yml`:

1. Added `field-visibility.ts`, `MetaFormView.vue`, `conditional-formatting.ts`,
   and the three spec files to the `paths:` filters (both `pull_request` and
   `push: branches: [main]`) so the workflow actually runs when any of them
   change.
2. Added `multitable-field-visibility multitable-required-if
   multitable-conditional-formatting` to the `vitest run` filter list so the
   workflow, once triggered, executes those specs.

No runtime/product source was touched. `git diff` for this PR is confined to
`.github/workflows/multitable-web-guard.yml` and these two doc files.

## Why this is the smallest clean gap here

- `multitable-permission-oapi-guard-tripwire-20260705` (open PR #3574) already
  covers an OAPI-allowlist/guard reachability gap — skipped to avoid overlap.
- Several other open PRs in this window (#3618, #3602, #3593, #3591, #3582)
  are design-lock / TODO / verification-record docs, not competing CI fixes —
  no overlap with this workflow file.
- The three specs here already exist, are well-constructed (both pure-function
  and full component-mount/submit-event assertions), and pass cleanly today —
  this is a pure "wire it in" fix, the lowest-risk category the task allows.

## What a human reviewer should check

- Confirm the new `paths:` entries and vitest filter terms in
  `multitable-web-guard.yml` are exact matches for real files (see verification
  doc for the local run proving the filter resolves to exactly the intended
  spec files, no accidental substring collisions).
- Confirm no other open PR is concurrently editing
  `multitable-web-guard.yml` (would conflict/need rebase).
- This PR does not change what the guard *tests*, only what triggers it and
  what subset of already-passing specs it runs — merge risk should be limited
  to "workflow now runs slightly more often / a bit longer."
