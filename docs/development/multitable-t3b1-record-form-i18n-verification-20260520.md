# T3B1 — Record Drawer + Form View zh-CN i18n — Verification

- **Date**: 2026-05-20
- **Branch**: `frontend/multitable-t3b1-record-form-i18n-20260520` (rebased onto latest `origin/main`; no upstream drift at verification time)
- **Dev plan**: `docs/development/multitable-t3b1-record-form-i18n-design-20260520.md` (sha256 `a859c29905c810db3e8c04718aa12daf3102e8def9e8cb9f6a1613344aecdf9b`, two operator-revision rounds folded before implementation start).
- **Type**: implementation + verification.
- **K3 PoC stage-1 lock**: complies — no `/api/*` contract, no migration, no integration-core, no plugin-integration; touches frontend label modules + 2 components + tests + dev/verification MDs only.

---

## 1. Files Changed (committed PR diff)

```
A  apps/web/src/multitable/utils/meta-record-labels.ts             (NEW, ~110 lines)
M  apps/web/src/multitable/utils/meta-core-labels.ts               (attachmentActionHint + AttachmentActionMode export)
M  apps/web/src/multitable/utils/link-fields.ts                    (linkActionLabel + opt-in isZh=false)
M  apps/web/src/multitable/components/MetaRecordDrawer.vue         (22 l('record.) + 6 lc('cell.) wirings)
M  apps/web/src/multitable/components/MetaFormView.vue             ( 5 l('form.)   + 7 lc('cell.) wirings)
M  apps/web/tests/multitable-core-i18n.spec.ts                     (+4 mode-extension cases)
A  apps/web/tests/meta-record-labels.spec.ts                       (NEW, 12 cases)
A  apps/web/tests/link-fields-i18n.spec.ts                         (NEW, 7 cases)
A  apps/web/tests/meta-record-drawer-i18n.spec.ts                  (NEW, 10 cases)
A  apps/web/tests/meta-form-view-i18n.spec.ts                      (NEW, 12 cases)
A  docs/development/multitable-t3b1-record-form-i18n-design-20260520.md
A  docs/development/multitable-t3b1-record-form-i18n-verification-20260520.md (this packet)
```

The authoritative PR shape is the committed diff against `origin/main`; this packet intentionally avoids pinning an exact file or commit count because docs-only verification corrections can be appended before PR open, and the PR will be squash-merged.

Pure T3B1: no attendance / MultitableWorkbench / MultitableHomeView / backend / contract / `.mjs` leakage. Verified via `git diff --name-status origin/main..HEAD`.

## 2. Test Results (focused, post-rebase)

```
$ pnpm --filter @metasheet/web exec vue-tsc --noEmit
exit=0 (0 lines)

$ pnpm --filter @metasheet/web exec vitest run \
    tests/meta-form-view-i18n.spec.ts \
    tests/meta-record-drawer-i18n.spec.ts \
    tests/meta-record-labels.spec.ts \
    tests/multitable-core-i18n.spec.ts \
    tests/link-fields-i18n.spec.ts \
    tests/meta-cell-editor-i18n.spec.ts \
    tests/meta-toolbar-filter-builder.spec.ts \
    tests/meta-grid-table-i18n.spec.ts \
    --watch=false

✓ tests/link-fields-i18n.spec.ts          ( 7 tests)   ← T3B1 helper
✓ tests/multitable-core-i18n.spec.ts      (23 tests)   ← T3A1+T3A2+T3B1 helper
✓ tests/meta-record-labels.spec.ts        (12 tests)   ← T3B1 label module
✓ tests/meta-form-view-i18n.spec.ts       (12 tests)   ← T3B1 render
✓ tests/meta-cell-editor-i18n.spec.ts     (11 tests)   ← T3A2 regression
✓ tests/meta-toolbar-filter-builder.spec.ts ( 8 tests) ← T3A1 regression
✓ tests/meta-record-drawer-i18n.spec.ts   (10 tests)   ← T3B1 render
✓ tests/meta-grid-table-i18n.spec.ts      ( 6 tests)   ← T3A1 regression

Test Files  8 passed (8)
     Tests  89 passed (89)
```

```
$ git diff --check origin/main..HEAD
(clean)
```

T3A1 and T3A2 specs (`meta-toolbar-filter-builder`, `meta-grid-table-i18n`, `meta-cell-editor-i18n`, the 19 pre-existing T3A1+T3A2 cases in `multitable-core-i18n.spec.ts`) all pass unchanged — confirming the helper extensions (`attachmentActionHint` mode default + `linkActionLabel` isZh default) are truly backwards-compatible.

## 3. Findings Resolutions (across both design-review rounds + preflight grep)

### Round-1 findings (the M1 / S1-S5 / N1+N2 in the first review)

| Finding | Resolution |
|---|---|
| **M1** MetaFormView submit chain missing (Saving/Save/Create/Reset) | All four keys added to `meta-record-labels` `form.*` union; submit ternary + reset button localized; render spec asserts all four states in zh+en. |
| **S1** `record.workflowTitle` separate from `record.workflow` | Both keys present; §4.1 row distinction kept; render spec asserts the title is the long form. |
| **S2** `record.permissionsTitle` separate from `record.permissions` | Same pattern as S1. |
| **S3** `commentsForField` would duplicate T3A1 `commentForField` | Decision: reuse T3A1 helper from `meta-core-labels` in `MetaFormView`; do NOT introduce a duplicate. Implementation imports `commentForField` from `meta-core-labels`. `commentOnField` (T3B1) is distinct (singular EN form, RecordDrawer only). |
| **S4** `form.requiredSuffix` static key was dead | Removed; `requiredField(fieldName, isZh)` helper does full interpolation. |
| **S5** `historyActionLabel()` Created/Deleted/Updated ambiguity | 3 keys added (`record.historyActionCreated/Deleted/Updated`); function body rewired; render spec covers via the localized label module unit, not via mount (mount path requires apiClient stubbing — out of scope for focused render coverage). |
| **N1** "no dead keys" note | Added to dev MD §1; cross-references the T3A2 `Choose linked records...` precedent. |
| **N2** linkActionLabel call-site audit | Dev MD §6 lists all 4 call sites (RecordDrawer / FormView / MetaImportModal / MetaCellEditor); only the first 2 pass `isZh.value` in T3B1. |

### Round-2 findings (M1' + S2'-S4' + N1')

| Finding | Resolution |
|---|---|
| **M1'** 3 RecordDrawer FE error fallbacks missing + §4.1 L152 semantics wrong | Added `record.errorHistoryLoad` / `record.errorWatchLoad` / `record.errorWatchUpdate` keys; all 3 catch blocks rewritten to `error?.message ?? l('record.error*')`; backend `error.message` raw when present (T3A2 `cell.uploadFailed` pattern). |
| **S2'** §7.2/§7.3 missing canonical mount/teardown pointer | Both render specs explicitly model their `afterEach` on `meta-cell-editor-i18n.spec.ts` (createApp + container + app?.unmount() + container?.remove() + locale reset); comment in spec source references the canonical file. |
| **S3'** §4.1 row→key counting ambiguity for historyAction | Dev MD now lists `Created` / `Deleted` / `Updated` as 3 separate rows with explicit key references. |
| **S4'** §8 needed a preflight-grep step | Dev MD §8 step 1 = preflight grep. Verified at implementation time: every planned key has a real call-site (no dead keys), including the new M1' error-fallback keys. |
| **N1'** §2 helper-spec placement was "either/or" | Tightened to "and" — both `multitable-core-i18n.spec.ts` and `link-fields-i18n.spec.ts` are extended, plus the new `meta-record-labels.spec.ts`. |

### F-T3B-A through F-T3B-E (operator decisions before design)

| Decision | Implementation |
|---|---|
| **F-T3B-A** per-surface modules | New `meta-record-labels.ts`; T3A1/T3A2 surface keys remain in `meta-core-labels`; T3B2 + T3B3 will add their own modules. |
| **F-T3B-B** attachment helper refactor (with `mode='add'` extension) | `attachmentActionHint(..., mode?: 'drop'\|'add')` with default `'drop'` preserving T3A2 MetaCellEditor behavior; both RecordDrawer + FormView local helpers refactored to call this with `mode='add'`. No T3A2 regression (11/11 cell-editor cases still green). |
| **F-T3B-C** `linkActionLabel` opt-in zh | `linkActionLabel(field, count, isZh = false)`; only RecordDrawer + FormView pass `isZh.value`. `linkPickerTitle` + `linkPickerSearchPlaceholder` untouched (T3B3 scope). |
| **F-T3B-D** native confirm | `confirm(l('form.discardConfirm'))` — text-only zh localization, no custom modal. Render spec verifies via `vi.spyOn(window, 'confirm')`. |
| **F-T3B-E** 3-PR split | T3B1 = this PR; T3B2 (comments) + T3B3 (link picker) queued. |

## 4. Out-of-Scope (intentionally deferred)

| Item | Slice | Reason |
|---|---|---|
| `MetaCommentsDrawer.vue`, `MetaCommentComposer.vue`, `MetaCommentAffordance.vue`, `MetaCommentActionChip.vue` | T3B2 | Per F-T3B-E split. T3B1 only touches `MetaCommentActionChip` indirectly via the `:label` prop pass-through from MetaRecordDrawer. |
| `MetaLinkPicker.vue`, `linkPickerTitle`, `linkPickerSearchPlaceholder` | T3B3 | Per F-T3B-E split + F-T3B-C scope decision. |
| `MetaFormShareManager.vue` | T3C / share-permission slice | Permission/share/API manager panels per merged T3A dev MD §3.2. |
| `MetaImportModal.vue` linkActionLabel | later import-modal slice | `linkActionLabel` default `isZh=false` keeps current EN; modal not touched. |
| `MetaCellEditor.vue` link fallback (`'Choose linked records...'`) | T3B3 (with link picker) | T3A2 deferral preserved — still unreachable in current render flow; inline comment at L410 still applies. |
| Native `confirm()` styling | n/a (intentional) | Operator decision F-T3B-D: text-only. |

## 5. Acceptance Criteria

| # | Criterion | Status |
|---|---|---|
| 1 | zh-CN renders localized record/form chrome for in-scope strings | ✓ (10 RecordDrawer + 12 FormView render-spec cases) |
| 2 | en preserves existing English labels | ✓ (en cases in both render specs + jsdom default locale) |
| 3 | No translation of user data (field names, option values, URLs, emails, phone examples, backend free-form errors, attachment filenames, actorId) | ✓ (explicit spec assertions on field name preservation, option values raw, URL/email/phone format examples raw) |
| 4 | Record/Form behavior unchanged (no emit/event/state changes) | ✓ (existing emit/prop interfaces untouched; backwards-compatible helper defaults) |
| 5 | No API contract / backend route / migration / K3 / plugin-integration / OpenAPI change | ✓ (committed diff confined to `apps/web/src/multitable/{utils,components}/` + `apps/web/tests/` + `docs/development/`) |
| 6 | New helpers (recordLabel + commentOnField + historyActor + requiredField + attachmentActionHint mode + linkActionLabel isZh) have unit coverage for en+zh + edge cases | ✓ (12 record-labels + 4 mode + 7 linkActionLabel + Unicode field name preservation) |
| 7 | T3A1+T3A2 backward compat verified | ✓ (all 8 spec files green, 0 regression in pre-existing specs) |
| 8 | Verification MD records any intentionally deferred strings | ✓ (this §4) |

## 6. Git State (post-rebase)

```
$ git log --oneline origin/main..HEAD
90c871913 feat(multitable): localize MetaFormView chrome to zh-CN (T3B1)
163e098e6 feat(multitable): localize MetaRecordDrawer chrome to zh-CN (T3B1)
ac7006595 feat(multitable): add record/form i18n label module + extend helpers (T3B1)
e47d1143c docs(multitable): T3B1 record drawer + form view i18n design
```

Rebase note: branch was created from `origin/main @ 5606dac04`; during T3B1 implementation `origin/main` advanced by 1 commit (parallel-actor push). Rebased clean (no conflicts — that commit doesn't touch T3B1 files); vue-tsc + 89 focused specs re-verified green on rebased state.

## 7. Worktree-Contention Status

This T3B1 implementation completed without the parallel-actor branch contention that affected T3A1 (≥3 mid-task HEAD switches) and T3A2 (origin/main advanced mid-impl, requiring rebase). The `multitable-i18n` memory rules — durability-first commits after each §9-style sub-step, targeted `git add` only, `git show <commit>:<path>` instead of `cat` when verifying — were applied throughout but did not need to recover from any worktree clobber.

Other parallel-actor uncommitted state (`MultitableWorkbench.vue` / `MultitableHomeView.vue` / `multitable-home-view.spec.ts` / pre-existing `.tmp-*` / `docs/research/dingtalk-*` untracked artifacts) remained unmodified by this slice — confirmed via `git diff --name-status origin/main..HEAD` listing only T3B1 files.

## 8. Regression Comm-Diff (pending)

Per the session pattern from T3A1 / T3A2 (failed-test-set diff, not totals), a full-web-suite `comm -13` / `comm -23` between `origin/main` and `HEAD` failed-test sets would ratify zero regression. Not executed inline here, consistent with T3A2:

**Available evidence**:
- vue-tsc clean (post-rebase) — typecheck regression caught for free.
- All 8 T3A1+T3A2+T3B1 focused specs green (89/89), including the T3A2 backward-compat suite. The 4 new `attachmentActionHint(..., 'drop')` regression-guard cases explicitly assert the legacy default behavior is byte-identical.
- Edits are additive (new keys/helpers) or locale-conditional (en branch returns the original string verbatim, default `isZh=false` for `linkActionLabel`, default `mode='drop'` for `attachmentActionHint`). No existing en-asserting spec should observe a behavioral change.
- Default jsdom navigator language is `en-US` → `useLocale().isZh.value` starts as `false`; specs that don't call `setLocale('zh-CN')` continue to see English literals identical to the pre-T3B1 versions.

**Recommended next step (operator)**: open PR; CI will run `test (18.x)` / `test (20.x)` on a clean checkout (isolated from any local worktree state) and is the authoritative regression gate, same as T3A1 / T3A2.

## 9. Next Steps

1. **Hold push pending operator go** (consistent with session discipline: each push/PR is a separate explicit opt-in).
2. On go: `git push -u origin frontend/multitable-t3b1-record-form-i18n-20260520` → open PR → wait for CI (especially `test (18.x)` / `test (20.x)`) green → admin squash merge → `git branch -D` local stale branch.
3. After merge: **T3B2** (MetaCommentsDrawer + MetaCommentComposer + MetaCommentAffordance + MetaCommentActionChip) becomes the next anchored slice. The label-module pattern would create a new `meta-comment-labels.ts`, mirroring this slice's per-surface discipline.
