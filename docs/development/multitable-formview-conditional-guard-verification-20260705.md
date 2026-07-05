# Multitable — public-form conditional show-IF/required-IF guard: CI gap closure (verification)

Date: 2026-07-05
Grounded on: `origin/main` @ `1fb2c10c4a151d1997eae5ea6cb009b9e51bf765`
Worktree: `/private/tmp/gap-mt-df` (fresh `git worktree add ... origin/main`)

## 1. Proof the gap was real (before this change)

```
$ grep -n "field-visibility\|MetaFormView\|conditional-formatting" \
    .github/workflows/multitable-web-guard.yml
(no matches in paths:)

$ grep -n "vitest run" .github/workflows/multitable-web-guard.yml
        run: pnpm --filter @metasheet/web exec vitest run multitable-rollup-aggregation-fe multitable-trash-fe multitable-history-fe multitable-kanban-view multitable-field-manager multitable-sheet-cursor-state multitable-record-permission-manager multitable-sheet-permission-manager multitable-yjs-scalar-cell multitable-yjs-cell-editor multitable-conditional-rule multitable-person-picker multitable-cell-renderer-person-inactive meta-toolbar-filter-builder meta-filter-group meta-grid-table multitable-grid multitable-restore-preview-dialog multitable-restore-batch-dialog multitable-config-history-modal multitable-workbench-restore-wiring multitable-config-revert-refresh multitable-reset-confirm-dialog multitable-reset-tsource-picker --reporter=dot
```

`multitable-field-visibility`, `multitable-required-if`, and
`multitable-conditional-formatting` are absent from that filter, and none of
`field-visibility.ts` / `MetaFormView.vue` / `conditional-formatting.ts` are in
the `paths:` block (confirmed against the full workflow file — see the
`design-20260705.md` companion doc for the full paths listing at time of
survey).

`plugin-tests.yml` only runs `pnpm --filter @metasheet/web build` for the web
app (`grep -n "vitest\|apps/web" .github/workflows/plugin-tests.yml` shows no
`vitest run` against `apps/web`). `multitable-browser-verify.yml` triggers on
`conditional-formatting.ts` but only runs
`pnpm --filter @metasheet/web exec playwright test --config
playwright.verification.config.ts` — a Playwright browser lane, not `vitest`,
and it does not reference `field-visibility.ts` or `MetaFormView.vue` at all.

Net: prior to this PR, a regression to any of these three files could merge
to `main` fully green.

## 2. Baseline: the existing specs pass today (GREEN)

```
$ pnpm --filter @metasheet/web exec vitest run \
    multitable-field-visibility multitable-required-if \
    multitable-conditional-formatting --reporter=dot

 ✓ tests/multitable-conditional-formatting.spec.ts  (25 tests) 3ms
 ✓ tests/multitable-field-visibility.spec.ts  (8 tests) 15ms
 ✓ tests/multitable-required-if.spec.ts  (13 tests) 23ms

 Test Files  3 passed (3)
      Tests  46 passed (46)
```

## 3. Observed RED — the discriminator is sound

Two independent temporary reverts were made **locally only**, run, observed
red, then the files were restored byte-for-byte (`git status --porcelain`
confirmed clean / `git diff --stat` empty after restore, before any commit was
made). No product code changes are included in this PR.

### 3a. Revert the `validate()` hidden-field exemption (`MetaFormView.vue`)

Changed the submit-gate loop from the visible-only set to the full field list:

```diff
- for (const f of editableFields.value) {
+ for (const f of props.fields) {
    const v = formData[f.id]
    if (fieldIsRequired(f) && isEmptyFormValue(v)) {
```

Re-ran `vitest run multitable-required-if --reporter=verbose`:

```
 ✓ ... condition TRUE → empty conditionally-required field BLOCKS submit
 × ... condition TRUE but field FILLED → submit allowed
   → expected "spy" to be called 1 times, but got 0 times
 ✓ ... condition FALSE → conditionally-required field is OPTIONAL
 × ... HIDDEN field with requiredWhen → NOT required (does not block submit)
   → expected "spy" to be called 1 times, but got 0 times
 ✓ ... static required still blocks regardless of any requiredWhen

 Test Files  1 failed (1)
      Tests  2 failed | 11 passed (13)
```

This is exactly the regression class the guard exists to prevent: a hidden
`requiredWhen`-satisfied field silently blocks public-form submission (spy
never called ⇒ submit was blocked). Reverted the file back
(`git diff --stat` empty afterward), re-ran the full 3-file suite — back to
46/46 green.

### 3b. Revert `isFieldVisible`'s rule evaluation (`field-visibility.ts`)

```diff
  const rule = getFieldVisibilityRule(field)
  if (!rule) return true
- return evaluateConditionRule(rule, recordData, fieldsById, options)
+ return true // BUG-INJECTED: always visible regardless of rule
```

Re-ran `vitest run multitable-field-visibility --reporter=dot`:

```
 × isFieldVisible — evaluator > dangling dependency reference ⇒ hidden
   → expected true to be false
 × MetaFormView — conditional field visibility (live) > hides the rule-gated
   field until its dependency satisfies the condition
   → expected <input ...> to be null

 Test Files  1 failed (1)
      Tests  3 failed | 5 passed (8)
```

Reverted the file back, re-ran the full 3-file suite — back to 46/46 green.
Both RED observations prove the specs are sound fail-first discriminators for
the guard, not tautologies.

## 4. CI-gate wiring proof (after the fix)

Ran the exact updated `vitest run` command from the modified
`multitable-web-guard.yml` (all 26 filter terms, including the 3 newly added)
against the untouched worktree:

```
 Test Files  41 passed (41)
      Tests  419 passed (419)
```

41 files matched (38 previously-covered + 3 newly wired), confirming:

- the new filter terms (`multitable-field-visibility`, `multitable-required-if`,
  `multitable-conditional-formatting`) resolve to exactly the 3 intended spec
  files with no accidental substring collisions against any other spec name.
- the whole targeted guard suite is green with the addition, so wiring it in
  will not turn `multitable-web-guard.yml` red on arrival.

## 5. What was NOT changed

- No product/runtime source in the final diff (`git diff --stat` against
  `origin/main` for this branch touches only `.github/workflows/
  multitable-web-guard.yml` plus these two docs).
- No CI workflow was made a *required* status check here (out of scope) —
  only the existing targeted-guard workflow's trigger surface and test
  selection were widened, matching the `approval-web-guard.yml` precedent.

## 6. What a human must still check

- Whether `multitable-web-guard.yml` is (or should be) a required check on
  branch protection — this PR does not change that, only what it runs.
- Whether the `conditional-formatting.ts` addition to this workflow's paths
  causes any duplicate/redundant run alongside `multitable-browser-verify.yml`
  on the same PR (both would now trigger on that file — intentional, since
  they test different things: unit logic vs. browser rendering, but worth a
  human eyeballing CI time impact).
- I did not run the workflow in GitHub Actions itself (only reproduced the
  exact `vitest run` command locally); a human should watch the PR's Checks
  tab to confirm `Multitable Web Guard` actually fires and passes on this PR
  (it should, since it edits `multitable-web-guard.yml` itself, which is
  already in the trigger paths).
