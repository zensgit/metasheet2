# T3B2 — Comments Drawer + Composer i18n Verification

- **Date**: 2026-05-20
- **Scope**: `MetaCommentsDrawer.vue`, `MetaCommentComposer.vue`, the single comment-draft confirm wire in `MultitableWorkbench.vue`, and the new `meta-comment-labels.ts` label module.
- **Design packet**: `docs/development/multitable-t3b2-comments-i18n-design-20260520.md`
- **Status**: implemented and locally verified.

## Implementation Summary

- Added `apps/web/src/multitable/utils/meta-comment-labels.ts` with a dedicated `comment.*` namespace, English/zh-CN labels, and helpers for empty states, reply counts, and edit/reply banners.
- Wired `MetaCommentsDrawer.vue` to `useLocale()` and the comment label module for drawer title, inbox link, loading, action buttons, retry/cancel, banners, empty states, reply count, composer placeholder, and composer resting submit label.
- Wired `MetaCommentComposer.vue` to localize mention-suggestion `aria-label`, composer hints, and submitting states.
- Added `submitKind?: 'send' | 'save'` to `MetaCommentComposer.vue` so submitting copy keys off semantic intent instead of comparing `submitLabel === 'Save'`.
- Wired `MultitableWorkbench.vue` comment-drawer close confirmation through `comment.discardDraftConfirm` while preserving the native `window.confirm()` behavior.
- Preserved raw user/backend data: author names, comment body, mention labels, scope labels, and `error` body remain untranslated.

## Boundary Check

| Area | Result |
|---|---|
| Backend/API | Not touched |
| Comment payload semantics | Not changed |
| `attendance_*` / migrations | Not touched |
| `meta_*` direct writes | Not touched |
| `MetaCommentAffordance.vue` / `MetaCommentActionChip.vue` | Not touched |
| Cross-view `label="Comments"` consumers | Deferred by design; not touched |
| T3B3 link picker | Not touched |

## Test Coverage Added

| File | Coverage |
|---|---|
| `apps/web/tests/meta-comment-labels.spec.ts` | 24 static keys, empty-state helper branches, reply singular/plural, edit/reply banner helpers |
| `apps/web/tests/meta-comment-composer-i18n.spec.ts` | zh-CN resting labels, `submitKind` send/save submitting states, English submitting regression, localized mention aria + hint |
| `apps/web/tests/meta-comments-drawer-i18n.spec.ts` | zh-CN header/loading/actions/progress states, raw error body + localized retry, edit/reply banners, placeholders, empty states, English regression |
| `apps/web/tests/multitable-workbench-view.spec.ts` | Existing English comment-draft confirm regression plus new zh-CN confirm assertion |

## Verification Commands

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/meta-comment-labels.spec.ts \
  tests/meta-comment-composer-i18n.spec.ts \
  tests/meta-comments-drawer-i18n.spec.ts --watch=false
```

Result: PASS, 13 tests across 3 files.

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-workbench-view.spec.ts --watch=false -t "comment draft"
```

Result: PASS, 2 selected comment-draft confirm tests. A full-file exploratory run currently fails on the unrelated `opens workflow designer with multitable context when automation is enabled` test because that fixture does not enable the `workflow` feature flag; the T3B2 acceptance run is scoped to the comment-draft confirm path touched by this slice.

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-comment-composer.spec.ts \
  tests/multitable-comments-drawer.spec.ts --watch=false
```

Result: PASS, 9 existing adjacent tests across 2 files.

```bash
pnpm --filter @metasheet/web type-check
```

Result: PASS.

```bash
pnpm --filter @metasheet/web build
```

Result: PASS. Vite emitted existing large-chunk warnings only.

```bash
git diff --check
```

Result: PASS.

## Acceptance Notes

- `Ctrl/Cmd + Enter` remains literal in both locales.
- `Send`/`Save` zh-CN copy is `发送`/`保存`; submitting states are `正在发送...`/`正在保存...`.
- `Resolve`/`Resolving...`/`Resolved` zh-CN copy is `解决`/`正在解决...`/`已解决`.
- `Inbox` zh-CN copy is `收件箱`.
- `Discard unsaved comment draft?` zh-CN copy is `放弃未保存的评论草稿吗？`.
- Reply count uses `1 reply` / `2 replies` in English and `${n} 条回复` in zh-CN.
- The composer default props remain English literals for future consumers that do not pass localized props; the drawer always passes localized values.
