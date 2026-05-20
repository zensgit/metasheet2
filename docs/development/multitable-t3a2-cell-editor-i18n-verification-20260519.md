# T3A2 — MetaCellEditor shallow chrome zh-CN i18n — Verification

- **Date**: 2026-05-19
- **Branch**: `frontend/multitable-t3a2-cell-editor-i18n-20260519` (rebased onto `origin/main` post #1685/#1686, ahead 3 / behind 0)
- **Dev plan**: anchored in `docs/development/multitable-t3a-core-table-i18n-development-20260519.md` §3.3 / §5.6 / §7.4 / §13 (T3A2 deferral path from the merged T3A1 packet — no new dev MD).
- **Type**: implementation + verification.
- **K3 PoC stage-1 lock**: complies — no `/api/*` contract, no migration, no integration-core, no plugin-integration; touches only `meta-core-labels.ts` (frontend label module) + `MetaCellEditor.vue` (frontend chrome) + tests.

---

## 1. Files Changed

```
M  apps/web/src/multitable/utils/meta-core-labels.ts            (+76 lines: 11 cell.* keys + 2 helpers)
M  apps/web/src/multitable/components/cells/MetaCellEditor.vue  (locale-wired; 13 chrome strings + 3 fallback errors)
M  apps/web/tests/multitable-core-i18n.spec.ts                  (+6 cases for cell.*/attachment helpers)
A  apps/web/tests/meta-cell-editor-i18n.spec.ts                 (11 render cases)
A  docs/development/multitable-t3a2-cell-editor-i18n-verification-20260519.md
                                                                 (this verification packet)
```

Pure T3A2; no attendance/Workbench/HomeView/backend/contract leakage (`git diff --name-status origin/main..HEAD` confirms 5 files only: 4 frontend/test files + this verification MD).

## 2. Test Results (focused)

```
$ pnpm --filter @metasheet/web exec vue-tsc --noEmit
exit=0 (0 lines)

$ pnpm --filter @metasheet/web exec vitest run \
    tests/multitable-core-i18n.spec.ts \
    tests/meta-cell-editor-i18n.spec.ts \
    tests/meta-toolbar-filter-builder.spec.ts \
    tests/meta-grid-table-i18n.spec.ts \
    --watch=false

✓ tests/multitable-core-i18n.spec.ts        (19 tests)   ← 13 T3A1 + 6 T3A2 unit
✓ tests/meta-cell-editor-i18n.spec.ts       (11 tests)   ← T3A2 render
✓ tests/meta-toolbar-filter-builder.spec.ts ( 8 tests)   ← T3A1 regression untouched
✓ tests/meta-grid-table-i18n.spec.ts        ( 6 tests)   ← T3A1 regression untouched

Test Files  4 passed (4)
     Tests  44 passed (44)
```

```
$ git diff --check origin/main..HEAD
(clean)
```

## 3. Findings Resolutions (preflight against MD §5.6 vs real `MetaCellEditor.vue`)

| Finding | Resolution |
|---|---|
| **F-T3A2-A**: MD §4 planned `linkButtonFallback` for `'Choose linked records...'` (L410), but the static branch is **unreachable** in current render flow — `<button v-else-if="field.type === 'link'">` and the computed guard `if (type !== 'link')` are contradictory predicates. Per merged dev MD §7.6 "no dead keys". | **Skipped**. Added inline note at `MetaCellEditor.vue` linkButtonLabel computed documenting why it stays English in T3A2 and that future exposure should be localized together with `formatLinkActionLabel` (T3B). |
| **F-T3A2-B**: `cell.clearAll` has identical en/zh to `toolbar.clearAll` (T3A1). | **Kept namespaced** (own key, same values). Different surfaces, different reviewer audit paths. Spec asserts both keys explicitly. |
| **F-T3A2-C**: 3 attachment-action-hint zh translations not pre-decided. | **User-confirmed** (2026-05-19 AskUserQuestion): `拖拽文件或点击选择` / `上传新文件以替换当前文件` / `上传文件`. Baked into `attachmentActionHint` helper + spec. |
| **F-T3A2-D**: 3 attachment-activity zh per MD. | Taken from MD as-is: `正在移除... / 正在清空... / 正在上传...`. Consistent with workbench-labels loading-state convention. |
| **F-T3A2-E (new)**: `MetaYjsPresenceChip.vue` L13 carries its own default label `'Collaborating now'` (en). `MetaCellEditor` always passes a label so the default is unreachable from this surface, but the chip is reusable. | **Deferred** out of T3A2 (component out of MD §3.1 scope). Queued for T3E or a dedicated presence-i18n slice. Localizing it requires editing a separate component used in multiple consumer paths. |

## 4. Out-of-Scope (intentionally deferred to later slices)

| Item | Slice | Reason |
|---|---|---|
| `MetaYjsPresenceChip` default `label='Collaborating now'` | T3E / presence-i18n slice | Component shared across consumers; T3A2 scope = MetaCellEditor only. |
| `MetaAttachmentList` internal row UI (file remove buttons, size labels, etc.) | T3C field-management surface | Out of MD §3.1; T3A2 only touches the consumer-passed `:empty-label` prop. |
| `validateAttachmentSelection(...)` messages | n/a (deferred indefinitely) | Field-config validation layer; MD §5.6 explicitly out of shallow-chrome scope. |
| `formatLinkActionLabel(field, count)` output | T3B link picker/drawer slice | MD §5.6 explicitly defers; see F-T3A2-A inline note. |
| Yjs presence chip render spec | optional Yjs integration spec | Per advisor: `useYjsCellBinding` mock complexity > test value at T3A2; chip rendering exercised indirectly when MetaCellEditor mounts with `recordId` absent (binding inert) but full Yjs-active path is integration-level. |
| URL / email / phone placeholder examples (`https://example.com` / `name@example.com` / `+86 138 0000 0000`) | n/a (intentional) | User-data format examples per MD §5.6, NOT UI chrome. Spec asserts they stay raw in zh. |
| `<option value="">—</option>` em-dash in `<select>` | n/a (intentional) | Locale-neutral symbol. |

## 5. Acceptance Criteria (per T3A dev MD §8)

| # | Criterion | Status |
|---|---|---|
| 1 | zh-CN renders localized cell-editor chrome for in-scope strings | ✓ (11 render-spec cases) |
| 2 | en preserves existing English labels | ✓ (en cases + jsdom default locale) |
| 3 | No translation of user data (option values, URLs, emails, phone, backend free-form errors) | ✓ (explicit spec assertions + `error?.message ??` pattern preserved) |
| 4 | Cell editing behavior unchanged | ✓ (no event/emit changes; existing `confirm`/`cancel`/`yjs-commit`/`open-link-picker`/`update:modelValue` paths intact) |
| 5 | No API contract / backend route / migration / K3 / plugin-integration / OpenAPI change | ✓ (`git diff --name-only origin/main..HEAD` = 5 files, all under `apps/web/` or `docs/development/`) |
| 6 | New helpers have unit coverage for variants + fallbacks | ✓ (`attachmentActionHint` 3 variants × locales, `attachmentActivityLabel` 3 states × locales, fallback errors en+zh) |
| 7 | Focused component tests cover both zh-CN and en render | ✓ (11 cases mixed) |
| 8 | Verification MD records any intentionally deferred strings found by grep | ✓ (this §4) |

## 6. Git State

```
$ git log --oneline origin/main..HEAD
0341dd272 docs(multitable): T3A2 verification report
9615f6afa feat(multitable): localize MetaCellEditor cell chrome to zh-CN (T3A2)
2f3de9e93 feat(multitable): extend core labels with cell editor helpers (T3A2)
```

Rebase note: branch was created from `origin/main @ cbcc6bf32`; during T3A2 implementation `origin/main` advanced by 3 commits (#1685 multitable drawer/workflow fix, #1686 attendance staging migration audit docs, `66d74119a` onprem wrapper fix). Rebased clean (no conflicts — those commits don't touch `MetaCellEditor.vue` / `meta-core-labels.ts` / the 2 specs); post-rebase ahead 3/behind 0; vue-tsc + 44 focused specs re-verified green on rebased state.

## 7. Worktree-Contention Mitigation

Per the `multitable-i18n` project memory durability-first rule: both feat commits landed early (immediately after focused-specs green), making the work durable in the branch-ref before any further worktree clobbering could affect it. No `git add -A` used — targeted adds only. Current untracked `.tmp-*`, `docs/research/dingtalk-*`, and `output/attendance-*` artifacts are pre-existing local noise and are not part of the T3A2 commits, verified via `git diff --name-status origin/main..HEAD`.

## 8. Regression Comm-Diff (pending)

Per the session's pattern from T3A1 / #1671 / #1681 (failed-test-set diff, not totals), a full-web-suite `comm -13`/`comm -23` between origin/main and HEAD failed-test sets would ratify zero regression. Not executed inline here because the current shared worktree is under active parallel-actor contention (HEAD switched ≥3 times during T3A1; #1685 / #1686 pushed during T3A2 implementation), and a 3–4 minute full vitest run risks corruption by mid-run branch switches.

**What we know without it**:
- vue-tsc clean (post-rebase).
- All 4 T3A2-relevant focused specs green (19 unit + 11 cell-editor + 8 toolbar + 6 grid).
- Edits are additive (new keys/helpers) or locale-conditional (en branch returns the original string verbatim). No existing en-asserting spec should observe a behavioral change.
- Default jsdom navigator language is `en-US` → `useLocale().isZh.value` starts as `false`; specs that don't call `setLocale('zh-CN')` continue to see English literals identical to the pre-T3A2 versions.

**Recommended next step (operator)**: run the comm-diff once the parallel session is quiesced, or treat the focused-specs + vue-tsc + additive-edit reasoning as sufficient for PR open + CI as the regression gate (CI runs test 18.x / 20.x on a clean checkout, isolated from the local contended worktree). The T3A1 / #1681 PR was admin-squash-merged on the same logic + CI green.

## 9. Next Steps

1. **Hold push pending operator go** (consistent with session discipline: each push/PR is a separate explicit opt-in).
2. On go: `git push -u origin frontend/multitable-t3a2-cell-editor-i18n-20260519` → open PR → wait for CI (especially `test (18.x)` / `test (20.x)`) green → admin squash merge → `git branch -D` local stale branch.
3. After merge: T3B (MetaRecordDrawer + MetaFormView + comments drawer/composer/link picker) becomes the next anchored slice. Per the `multitable-i18n` memory it's deliberately the next, not skipped.
