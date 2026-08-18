# Approval Form Builder Parity — F4 Execution Ledger

**Slice:** F4 (delta §5 F4 + §10 FB-D8) — production mount of the Designer 2.0 form builder behind
the existing `approvalCanvasV2` flag.
**Authority:** `docs/development/approval-form-builder-parity-delta-design-20260811.md` (RATIFIED
2026-08-17). F0-F3 landed on `main` before this slice; this document records F4 only.
**PR:** https://github.com/zensgit/metasheet2/pull/4994
**Head SHA (implementation commit, pre-rebase-for-docs):** `6412181abec247ee450179ee69abcf317935967a`
**Base at push time:** `origin/main@65a5bb4c9b` (post P7-R2 #4981 / P5 L5-A #4980 / D-1 #4979; the
rebase onto this base was a clean auto-merge — the only touched-by-both files were
`.github/workflows/approval-web-guard.yml` and `apps/web/scripts/run-required-web-tests.sh`, and
both merges landed disjoint added lines with zero conflict markers).
**Status:** NOT MERGED. Non-draft PR opened per task instruction; owner merge/UAT/flag-enablement
decisions remain pending (delta §9).

## 1. What this slice delivered

Mounted `ApprovalFormPalette` + `ApprovalFormBuilder` (which internally hosts
`ApprovalFormFieldInspector`, per F3) into `TemplateAuthoringView.vue`'s `fields` authoring section,
gated by the flag `productFeatures.approvalCanvasV2` already introduced by the Canvas V2 line. No
new environment flag was added (FB-D8).

- Flag OFF (default): `ApprovalFormInlineEditor` renders unchanged — same props/events contract F0
  extracted, same toolbar, same click-to-append behavior.
- Flag ON, once hydrated: Designer 2.0 (palette + N+1 semantic slots + inspector) is the form
  surface. The legacy 添加字段 toolbar button is hidden (superseded by the palette); the 撤销/重做
  toolbar buttons are rewired to the builder's own session history.

## 2. Files changed

| File | Nature of change |
|---|---|
| `apps/web/src/views/approval/TemplateAuthoringView.vue` | Production mount: imports, `formSessionHydrated`/`showFormBuilderV2`/`formBuilderSessionEpoch` state, `onFormBuilderDraftChange` (the ONE draft-mirroring writer), `reseedFormBuilderSessionIfActive` (the ONE deliberate resync, at the 3 pre-existing server-round-trip sites), `onFormUndoRedoClick` (toolbar rewiring), route-leave drag-state clearing, template mount (`v-if`/`v-else` against the legacy editor), three-region responsive CSS. |
| `apps/web/src/approvals/components/ApprovalFormBuilder.vue` | Additive `defineExpose`: `undo`, `redo`, `canUndo`, `canRedo` (F2/F3 built the history mechanics; no UI trigger existed before this slice). |
| `apps/web/src/approvals/approvalFormCommands.ts` | Doc-comment correction only (no code change): the "unmounted in production" clause in two comments is now false post-F4; the surrounding substantive claim (no number-display/date_range authoring affordance in the Designer 2.0 inspector) is unchanged and flagged as a residual below. |
| `apps/web/src/approvals/approvalFormAuthoringAdapter.ts` | Doc-comment correction only, same reason. |
| `apps/web/tests/approval-form-builder-slots.spec.ts` | FB-D8 pin flipped: asserts `TemplateAuthoringView.vue` is the exactly-one flag-gated mounter (source-level check), keeps the `ApprovalFormInlineEditor` positive control. |
| `apps/web/tests/approval-form-palette-chips.spec.ts` | Doc-comment correction (same "no production mount until F4" → now mounted). |
| `apps/web/tests/approvalTemplateAuthoring.spec.ts` | New `describe('F4 production mount...')`: flag OFF positive control, flag ON + hydrated M7 census, hydration gate (in-flight fetch), hydration single-seed (re-entry via tab switch), post-save resync. |
| `apps/web/tests/approval-form-builder-route-leak.spec.ts` (new) | Real-router (`createMemoryHistory`) spec constructing the cancelled-navigation drag leak. |
| `apps/web/verification/approval-form-builder-mounted-harness.{html,ts}` (new) | Mounts the REAL `TemplateAuthoringView.vue` + real Vue Router + real Element Plus, flag/permission overrides via existing `localStorage` dev-override paths, no backend required. |
| `apps/web/verification/approval-form-builder-mounted-matrix.spec.ts` (new) | The B1-B12 real-Chromium matrix, mouse-driven (`locator.dragTo`). |
| `apps/web/playwright.approval-verification.config.ts` | `testMatch` extended to the new mounted-matrix spec. |
| `apps/web/playwright.verification.config.ts` | `testIgnore` extended to keep the new spec out of the multitable lane. |
| `.github/workflows/approval-browser-verify.yml` | Path filter extended: `ApprovalFormFieldInspector.vue`, `TemplateAuthoringView.vue`, the new harness/spec files. |
| `.github/workflows/approval-web-guard.yml` | Path filter (both `pull_request` and `push` blocks) + canary run-list extended with `approval-form-builder-route-leak`. |
| `apps/web/scripts/run-required-web-tests.sh` | Same token added to the always-on Canvas V2 batch. |

## 3. Three F2-gate handoff conditions — implementation and proof

### 3.1 Mouse-driven B1-B12

`apps/web/verification/approval-form-builder-mounted-matrix.spec.ts` drives all 13 rows (B8 split
into 8a/8b) with `locator.dragTo()` (real Chromium mouse-down/move/up sequences that arm native
HTML5 drag — confirmed empirically; a manual low-level `mouse.down/move/up` sequence did NOT
reliably arm native drag on the small move-handle icon during development, consistent with known
Chromium/CDP behavior, so `locator.dragTo()` is used throughout) against the mounted production
surface. See §5 for the full run.

### 3.2 Hydration-gated mount

- `formSessionHydrated` (a `ref<boolean>`, default `false`) is set to `true` exactly once per view
  instance: synchronously in the new-template branch of `loadTemplateForEdit`, and in that
  function's `finally` block for the edit-mode async-fetch branch (success or failure).
- `showFormBuilderV2 = computed(() => canvasV2Enabled.value && formSessionHydrated.value)` gates the
  mount. Both inputs only ever transition false→true for the life of one view instance.
- No `:key` on the mounted `<ApprovalFormBuilder>` is derived from `draft` — `formBuilderSessionEpoch`
  is the only key, bumped exclusively by `reseedFormBuilderSessionIfActive()` at the three existing
  server-round-trip call sites (`persistDraft` update branch, `persistDraft` create branch,
  `createFromPreset`) that already call the legacy `reseedFormHistoryFromDraft()`.
- `onFormBuilderDraftChange` mirrors every builder commit into `draft.value` (so save/publish, the
  header field count, and the dirty-check all stay in sync with the builder's session) without
  reseeding the builder itself.

**Mutation proof (manual, reverted before commit):** coupling the wrapper's `:key` to
`activeAuthoringSection` (a plausible "only mount when the tab is active" mistake) turned the
hydration-single-seed test RED: `expected 'field_...' to be 'fldloc_...'` (the re-mounted session's
default selection — the FIRST field — replaced the deliberately-selected appended field). Reverted;
`diff` against a pre-mutation backup confirmed byte-identical restoration.

### 3.3 Route-level drag-state clearing

`TemplateAuthoringView.vue`'s pre-existing `onBeforeRouteLeave` dirty-draft guard now clears the
shared drag session (`formBuilderRef.value?.getDragSession().clear()`) as its **first statement**,
before the (cancellable) `ElMessageBox.confirm` dirty-draft check. `ApprovalFormBuilder`'s own
`onBeforeUnmount` (F2) already clears on a genuine unmount; this closes the gap where a navigation
is attempted and then CANCELLED (user picks 留下) — no unmount occurs, but a drag was already
visually interrupted by the confirm dialog.

**Discriminating test:** `apps/web/tests/approval-form-builder-route-leak.spec.ts`, using a REAL
`createMemoryHistory()` router (not the `vue-router` mock `approvalTemplateAuthoring.spec.ts` uses,
under which `onBeforeRouteLeave` is a documented no-op). The test dirties the draft, begins a real
`dragstart` on a second palette chip, asserts `data-drag-active="true"` (positive control), forces
`ElMessageBox.confirm` to reject (simulating 留下), attempts `router.push('/elsewhere')`, confirms
the navigation was cancelled (`router.currentRoute.value.path` unchanged, component still mounted),
and asserts the drag state is gone regardless.

**Mutation proof (manual, reverted before commit):** commenting out the
`getDragSession().clear()` call turned the test RED: `expected 'true' to be null`. Reverted;
`diff` confirmed byte-identical restoration.

## 4. Flag-gate pin (flipped FB-D8 pin + behavioral suite)

`approval-form-builder-slots.spec.ts`'s no-production-mount pin now asserts `mounters` (files under
`src/views` referencing `<ApprovalFormBuilder`/`<ApprovalFormPalette`) equals exactly
`['src/views/approval/TemplateAuthoringView.vue']`, keeps the `ApprovalFormInlineEditor` positive
control, and additionally checks the mount markers sit inside a wrapper carrying `v-else` /
`v-if="...showFormBuilderV2..."` (source-level defense-in-depth). The behavioral proof —
mounted-iff-flag, with a legacy-editor-functional positive control on the OFF side — lives in
`approvalTemplateAuthoring.spec.ts`'s `F4 production mount` describe block.

**Mutation proof (manual, reverted before commit):** neutralizing `canvasV2Enabled` out of
`showFormBuilderV2`'s computation (`computed(() => formSessionHydrated.value)`) turned the flag-OFF
mounted test RED (Designer 2.0 rendered even with the flag off). Reverted; `diff` confirmed
byte-identical restoration.

## 5. B1-B12 real-browser matrix results

Run: `pnpm --filter @metasheet/web exec playwright test --config playwright.approval-verification.config.ts`
(local, exact head `6412181abe` post-rebase). 20/20 passed — the F2 lane's 10 pre-existing tests plus
F4's 13 new ones (B8 split 8a/8b), zero cross-contamination (each targets its own harness/spec file).

| Row | Result | Notes |
|---|---|---|
| B1 | PASS | Palette click append; new field selected; 撤销 becomes enabled (one history entry). |
| B2 | PASS | Real mouse drag onto the start slot; exact order; unique ids. |
| B3 | PASS | Real mouse drags onto a middle slot then the end slot; exact order both times. |
| B4 | PASS | Real mouse drag of the move handle reproduces the SAME order a keyboard 上移 produces; selection retained. |
| B5 | PASS | Drag dropped outside the canvas: zero mutation; 撤销 stays disabled. |
| B6 | PASS | Inspector label edit commits, persists in the DOM; undo/redo restore value and selection/focus. |
| B7 | PASS | Deleting a field another field's visibility depends on is refused; both fields remain. |
| B8a | PASS | Flag OFF: zero Designer 2.0 elements; legacy fallback visible. |
| B8b | PASS | Read-only (network-intercepted unsupported-type template): zero slots/handles/move buttons. |
| B9 | PASS | 1440x900 / 1024x768 / 768x1024 / 390x844: zero document horizontal overflow at every width; builder visible throughout. |
| B10 | PASS | Slot click + ArrowDown/Enter (no drag) inserts a field; keyboard-reachable 下移 moves it; inspector label edit configures it — full add/move/configure without pointer drag. |
| B11 | PASS | Network-intercepted edit-mode load of a template carrying an unsupported (`signature`) field type: whole-template lock + disabled save, IDENTICAL on both flag states. |
| B12 | PASS | `attachment` absent from the palette; inspector HTML for a `number` field contains no `currencySymbol`/`thousandsSeparator` affordance (residual — see §6). |

Screenshots (`afb-mounted-b*.png`) were captured as supporting evidence per each test; uploaded by
CI as workflow artifacts (`approval-browser-verify.yml`'s existing `afb-*.png` glob covers them).

## 6. Known residual — not introduced by this mount, now reachable

`ApprovalFormFieldInspector.vue` (F3, pre-existing) has no controls for number display props
(currency symbol / thousands separator / uppercase-CNY) or `date_range` granularity — Lock-8
L8-B/L8-C scoped that authoring affordance to `ApprovalFormInlineEditor.vue` only, and F0-F3's
delta scope never extended it. Before F4 this gap was moot (no production mount existed). After F4,
with the flag ON: a `date_range` field added via the v2 palette has no in-surface way to set its
granularity and will fail backend publish validation, and a `number` field's display props are
frozen (preserved via the adapter's shallow-merge patch semantics — verified: `updateFormFieldProperties`
spreads `{...current, ...(patch.key !== undefined ? {key: patch.key} : {})}` per key, so untouched
exotic properties survive any commit) but not editable. The legacy fallback is unreachable while the
flag is ON (mutually exclusive `v-if`/`v-else`).

**Recommendation:** the owner should not enable `canvasV2` for tenants relying on `date_range` or
number-display authoring until a follow-up slice adds those inspector controls. Not a defect this
slice introduces; documented per M8 because mounting is what makes it reachable for the first time.

## 7. Deferred / owner-gated (per delta §7.1 item 8, §9)

- Branch-protection addition for `approval-browser-verify.yml` — explicit owner action; until then
  its evidence is exact-head, not "required".
- Merge, tenant UAT, canary observation, flag enablement — all owner-gated. Flag stays OFF.
- The §6 inspector-gap follow-up.
