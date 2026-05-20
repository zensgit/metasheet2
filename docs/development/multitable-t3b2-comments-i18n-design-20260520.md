# T3B2 — Comments Drawer + Composer i18n Design

- **Date**: 2026-05-20
- **Type**: implementation-ready design packet
- **Status**: implemented; paired verification in `docs/development/multitable-t3b2-comments-i18n-verification-20260520.md`
- **Preceded by**:
  - `docs/development/multitable-t3a-core-table-i18n-development-20260519.md` (merged T3A scope anchor)
  - `docs/development/multitable-t3b1-record-form-i18n-design-20260520.md` + verification (T3B1 patterns + decisions)
- **Goal**: localize the comment thread chrome that opens from any record/cell comment surface, without changing API contracts, comment payload semantics, accessibility roles, or user-authored data.

---

## 1. Decision Summary

| Finding / Decision | Resolution |
|---|---|
| **F-T3B2-A** module organization | New `apps/web/src/multitable/utils/meta-comment-labels.ts` (per-surface discipline; do not extend `meta-core-labels.ts` or `meta-record-labels.ts`). |
| **F-T3B2-B** composer default props | Keep English literal defaults in `withDefaults` (`placeholder: 'Add a comment...'`, `submitLabel: 'Send'`). The drawer ALWAYS passes locale-aware computed values, so the defaults only matter for any future composer consumer that does not localize. |
| **F-T3B2-C** cross-module key sharing | `comment.*` namespace is independent. Do NOT reuse T3A1/T3A2/T3B1 keys like `form.save` even when the literal is identical; T3A2 `cell.clearAll` vs `toolbar.clearAll` set the precedent. Helpers MAY be reused (e.g., T3A1 `commentForField`), keys MAY NOT. |
| **F-T3B2-D** helpers | 3 helpers: `emptyMessage(scopeLabel, targetFieldId, isZh)` 3-branch; `replyCount(n, isZh)` EN plural / zh singular; `editingBanner(actorLabel, isZh)` + `replyingBanner(actorLabel, isZh)` — both take a pre-resolved `actorLabel` (parent does `authorName ?? authorId` resolution; helper does not see raw fallback logic). |
| **F-T3B2-E** physical-key shortcut | `Ctrl/Cmd + Enter` literal in both locales (workbench-labels `kbd.*` + T3A1 `toolbar.undoTitle` precedent). |
| **F-T3B2-F** dead-key risk | 0 confirmed by the prior scout. Preflight grep step (T3B1 §8 step 1 pattern) is still mandatory before writing the module. |
| **F-T3B2-G** PR split | T3B2 = one PR (no further sub-splitting); ~22 source strings / 3 actually-wired files (MetaCommentsDrawer + MetaCommentComposer + the single-line MultitableWorkbench wire per M3). Affordance + ActionChip are 0-string. T3B3 picker remains a separate slice. |
| **M1** `submitButtonLabel` literal-coupled to English `'Save'` | **Fix**: add `submitKind?: 'send' \| 'save'` prop on MetaCommentComposer (default `'send'`). The submitting-state branch keys on `props.submitKind === 'save'`, not on `props.submitLabel`. MetaCommentsDrawer passes `:submit-kind="activeEditingComment ? 'save' : 'send'"`. See §6 for the full design. |
| **M2** `aria-label="Comment mention suggestions"` | Added as `comment.mentionSuggestionsAria` static key (§3); §4.2 row + §8.2 render assertion explicit. |
| **M3** `MultitableWorkbench.vue:1939` `'Discard unsaved comment draft?'` is comments-close-path chrome (`confirmDiscardCommentDraft()` native `window.confirm`) but lives outside `MetaCommentsDrawer.vue` | **INCLUDE in T3B2** (operator decision: avoid deferring to a hypothetical "Workbench confirm slice"). Adds `comment.discardDraftConfirm` static key + a single-line wire in MultitableWorkbench. See §3 + §4.4 + §11. |
| **M4** §8.3 render spec lacked capability gating | Reply / Edit / Delete / Resolve / Resolved badge are each gated (Reply: `canComment && !thread.resolved`; Edit: `canEditComment(thread)` = `canComment && isOwnComment(thread) && !thread.resolved`; Delete: `canDeleteComment(thread)` = `canComment && isOwnComment(thread) && no replies`; Resolve: `canResolve && !thread.resolved`; Resolved badge: `thread.resolved` — mutually exclusive with Resolve on a single thread). §8.3 now specifies the fixture matrix (2 threads: one editable + own-and-no-replies + unresolved, one resolved-by-other) + `currentUserId` + `canResolve` + `canComment` props explicit. |
| **S1** 5 alternative views still hardcode `label="Comments"` on MetaCommentActionChip | **Out-of-scope, explicitly noted in §4.5**. MetaCalendarView (3 sites) / MetaGalleryView (1) / MetaHierarchyView (1, h() call) / MetaTimelineView (2) / MetaKanbanView (2) — 9 sites total — keep English in T3B2. They belong to a later view-chrome slice (T3D or a dedicated view-i18n slice). Reviewer MUST NOT assume "all comment chips are localized". |
| **S2** Composable error raw, Retry localized | `MetaCommentsDrawer.vue:91-93` `<div v-if="error">{{ error }}<button>Retry</button></div>` — `error` is backend/composable text (raw user data); only the `Retry` button text localizes. §3 "Do not translate" + §4.1 row note. |
| **S3** `replyCount` test discipline | Unit spec MUST cover n=1 (singular: `1 reply` / `1 条回复`) AND n=2 (plural: `2 replies` / `2 条回复`). Zero-count is unreachable from caller (only renders when `count > 0`) — no separate test. |
| **S4** submitKind verification | Do NOT add production data-attrs for tests; do NOT inspect child component props. Verify via behavior: render with `:submit-kind="'save'"` + `:submitting="true"` + zh locale → assert button text content is `正在保存...`. Same for `'send'` → `正在发送...`. §8.2 cases rewritten. |
| **S5** §10 composer locale-aware risk wording inaccurate | Rewritten: future standalone consumer passing the unlocalized English `Send`/`Save` default for `submitLabel` while running under zh would see a mixed state (resting English + submitting localized). The current sole production consumer (MetaCommentsDrawer) always passes locale-aware props, so this is hypothetical; flagged for future consumer review. |
| **User-confirmed zh (T3B2 AskUserQuestion, 2026-05-20)** | `Send` / `Save` → `发送` / `保存`; `Resolve` / `Resolving...` / `Resolved` → `解决` / `正在解决...` / `已解决`; `Inbox` → `收件箱` (independent `comment.inbox` key, NOT reusing `workbench toolbar.commentInbox = 评论收件箱`); `${n} replies` → `${n} 条回复` (same 量词 as workbench mentionsUnread/Records); `Discard unsaved comment draft?` → `放弃未保存的评论草稿吗？` (M3, native `confirm()` text-only localization, same pattern as T3B1 `form.discardConfirm`). |

Scout result: 0 known dead keys in T3B2 scope. This is intentionally stricter than T3A2 (which documented `Choose linked records...` as unreachable and deferred).

---

## 2. Files In Scope

| File | Role |
|---|---|
| `apps/web/src/multitable/components/MetaCommentsDrawer.vue` | Comments drawer header + thread list + action buttons + reply/edit banners + composer integration + error/retry. |
| `apps/web/src/multitable/components/MetaCommentComposer.vue` | Comment authoring (text input + mention suggestions) + submit button + composer hint. NEW `submitKind` prop added per M1. |
| `apps/web/src/multitable/views/MultitableWorkbench.vue` | **One-line wire** at L1939 `confirmDiscardCommentDraft()`: replace `window.confirm('Discard unsaved comment draft?')` with `window.confirm(commentLabel('comment.discardDraftConfirm', isZh.value))`. Single import added; no other Workbench change in T3B2. |
| `apps/web/src/multitable/utils/meta-comment-labels.ts` | NEW per-surface T3B2 label module. |
| `apps/web/tests/meta-comment-labels.spec.ts` | NEW helper + static key unit coverage. |
| `apps/web/tests/meta-comments-drawer-i18n.spec.ts` | NEW focused render spec. |
| `apps/web/tests/meta-comment-composer-i18n.spec.ts` | NEW focused render spec; covers M1 submitKind + M2 aria + composerHint shortcut. |
| `docs/development/multitable-t3b2-comments-i18n-design-20260520.md` | This packet. |
| `docs/development/multitable-t3b2-comments-i18n-verification-20260520.md` | Verification packet after implementation. |

Out of scope for T3B2:

- `MetaCommentAffordance.vue` (85 lines) — presentational; 0 in-scope strings (numeric badges + emoji).
- `MetaCommentActionChip.vue` (48 lines) — presentational; `label` is a prop with no default. **The chip itself owns no translatable string**; consumers pass `label="..."` and own its locale. T3B2 does not modify the chip.
- **All 9 cross-view consumers of MetaCommentActionChip** (S1): `MetaCalendarView.vue:95,176,251`, `MetaGalleryView.vue:82`, `MetaHierarchyView.vue:469`, `MetaTimelineView.vue:95,154`, `MetaKanbanView.vue:71,130` — all pass `label="Comments"` hardcoded. **Intentionally NOT localized in T3B2**; reserved for a later view-chrome slice. MetaRecordDrawer:30 is already localized via T3B1 (`:label="l('record.comments')"`).
- `MetaLinkPicker.vue`, `linkPickerTitle`, `linkPickerSearchPlaceholder` → T3B3.
- Backend/composable error strings (`error` ref, `formatContent()` output, mention id/name raw) — user data / raw.
- Comment payload schema / mention payload / API routes — unchanged.

---

## 3. Label Module Plan

Create:

```text
apps/web/src/multitable/utils/meta-comment-labels.ts
```

Pattern follows `workbench-labels.ts` / `meta-core-labels.ts` / `meta-record-labels.ts`:

```ts
export type MetaCommentLabelKey =
  // --- MetaCommentsDrawer static ---
  | 'comment.title'
  | 'comment.inbox'
  | 'comment.loading'
  | 'comment.retry'
  | 'comment.cancel'
  | 'comment.reply'
  | 'comment.edit' | 'comment.editing'
  | 'comment.delete' | 'comment.deleting'
  | 'comment.resolve' | 'comment.resolving' | 'comment.resolved'
  // --- MetaCommentComposer static ---
  | 'comment.placeholderAdd'        // composer default placeholder (also reused by drawer "new comment" mode)
  | 'comment.placeholderEdit'       // drawer edit-mode placeholder
  | 'comment.placeholderReply'      // drawer reply-mode placeholder
  | 'comment.submitSend'            // composer submitLabel "Send" / drawer new-comment submit
  | 'comment.submitSave'            // drawer edit-mode submit
  | 'comment.submitSending'         // composer submitting-state for kind='send'
  | 'comment.submitSaving'          // composer submitting-state for kind='save'
  | 'comment.mentionSuggestionsAria'    // M2: aria-label for the mention listbox
  | 'comment.hintBase'              // composerHint without mention active
  | 'comment.hintWithMention'       // composerHint when mention suggestions visible
  // --- MultitableWorkbench cross-component wire (M3) ---
  | 'comment.discardDraftConfirm'   // window.confirm() on comments-drawer close path
```

zh decisions:

| Key | EN | ZH |
|---|---|---|
| `comment.title` | Comments | 评论 |
| `comment.inbox` | Inbox | 收件箱 |
| `comment.loading` | Loading... | 正在加载... |
| `comment.retry` | Retry | 重试 |
| `comment.cancel` | Cancel | 取消 |
| `comment.reply` | Reply | 回复 |
| `comment.edit` | Edit | 编辑 |
| `comment.editing` | Editing... | 正在编辑... |
| `comment.delete` | Delete | 删除 |
| `comment.deleting` | Deleting... | 正在删除... |
| `comment.resolve` | Resolve | 解决 |
| `comment.resolving` | Resolving... | 正在解决... |
| `comment.resolved` | Resolved | 已解决 |
| `comment.placeholderAdd` | Add a comment... | 添加评论... |
| `comment.placeholderEdit` | Edit comment… | 编辑评论… |
| `comment.placeholderReply` | Reply to thread… | 回复线程… |
| `comment.submitSend` | Send | 发送 |
| `comment.submitSave` | Save | 保存 |
| `comment.submitSending` | Sending... | 正在发送... |
| `comment.submitSaving` | Saving... | 正在保存... |
| `comment.mentionSuggestionsAria` | Comment mention suggestions | 评论提及建议 |
| `comment.hintBase` | Ctrl/Cmd + Enter to send | Ctrl/Cmd + Enter 发送 |
| `comment.hintWithMention` | Tab to mention, Ctrl/Cmd + Enter to send | Tab 提及，Ctrl/Cmd + Enter 发送 |
| `comment.discardDraftConfirm` | Discard unsaved comment draft? | 放弃未保存的评论草稿吗？ |

Accessor:

```ts
export function commentLabel(key: MetaCommentLabelKey, isZh: boolean): string {
  const entry = META_COMMENT_LABELS[key]
  return isZh ? entry.zh : entry.en
}
```

---

## 4. Exact T3B2 Chrome Targets

### 4.1 `MetaCommentsDrawer.vue` (388 lines)

| Source Line | EN | Resolution | Notes |
|---|---|---|---|
| L5 | Comments | `comment.title` | Drawer header. |
| L10 | Inbox | `comment.inbox` | RouterLink — independent key from workbench `toolbar.commentInbox` per user decision. |
| L17 | Loading... | `comment.loading` | Loading state. |
| L18 (computed) | (empty message) | `emptyMessage(scopeLabel, targetFieldId, isZh)` helper, see §5 | 3-branch logic stays at the helper boundary. |
| L36 | Reply | `comment.reply` | Action button. |
| L44 ternary | Editing... / Edit | `comment.editing` / `comment.edit` | Thread action button. |
| L50 ternary | Deleting... / Delete | `comment.deleting` / `comment.delete` | Thread action button. |
| L56 ternary | Resolving... / Resolve | `comment.resolving` / `comment.resolve` | Thread action button. |
| L57 | Resolved | `comment.resolved` | Badge. |
| L78 ternary | Editing... / Edit | reuse `comment.editing` / `comment.edit` | Reply action button (same keys as L44). |
| L84 ternary | Deleting... / Delete | reuse `comment.deleting` / `comment.delete` | Reply action button (same keys as L50). |
| L92 `{{ error }}` | (raw) | **DO NOT translate** | S2: composable error stays raw user data. Only the sibling Retry button localizes. |
| L93 | Retry | `comment.retry` | Retry button. |
| L97 interpolated | `Editing ${authorName ?? authorId}` | `editingBanner(activeEditingComment.authorName ?? activeEditingComment.authorId, isZh)` | Drawer resolves the actor fallback before calling helper. |
| L100 | Cancel | `comment.cancel` | Cancel button on the **edit banner** (`@click="emit('cancel-edit')"`). |
| L104 interpolated | `Replying to ${authorName ?? authorId}` | `replyingBanner(activeReplyComment.authorName ?? activeReplyComment.authorId, isZh)` | Same actor-fallback shape. |
| L107 | Cancel | `comment.cancel` | Cancel button on the **reply banner** (`@click="emit('cancel-reply')"`). Same key as L100 — two distinct buttons share the localized text. |
| L115 ternary (computed) | placeholder: Edit comment… / Reply to thread… / Add a comment... | Drawer-side computed: `activeEditingComment ? l('comment.placeholderEdit') : activeReplyComment ? l('comment.placeholderReply') : l('comment.placeholderAdd')` | Passed as `:placeholder` to MetaCommentComposer. |
| L116 ternary (computed) | submit-label: Save / Send | Drawer-side computed: `activeEditingComment ? l('comment.submitSave') : l('comment.submitSend')` | Passed as `:submit-label` to MetaCommentComposer. **Also adds `:submit-kind="activeEditingComment ? 'save' : 'send'"` per M1** — see §6. |
| L270-273 emptyMessage computed | 3-branch with raw `scopeLabel` interpolated | Replace local computed with helper `emptyMessage(props.scopeLabel, props.targetFieldId, isZh.value)` | Local computed name `emptyMessage` collides with helper name → import as `emptyMessageFn` (T3A2 `attachmentActionHintFn` pattern). |
| L336 plural fn | `1 reply` / `${count} replies` | `replyCount(n, isZh)` helper | en plural; zh `${n} 条回复`. |

Do not translate (T3B2):

- Comment authors (`authorName`, `authorId`), mention payload (`mention.name`, `mention.id`), thread ids, version numbers, timestamps — all user data.
- `error` ref body — backend/composable raw text (S2).
- `formatContent()` output — comment body, may contain user-authored markdown / mentions.

### 4.2 `MetaCommentComposer.vue` (303 lines)

| Source Line | EN | Resolution | Notes |
|---|---|---|---|
| L36 | aria-label `Comment mention suggestions` | `comment.mentionSuggestionsAria` (M2) | Mention listbox accessibility. Render spec asserts both locales. |
| L78 default prop | `placeholder: 'Add a comment...'` | Keep EN literal default (F-T3B2-B); drawer overrides via `:placeholder` | Defaults only matter if a future consumer doesn't localize. |
| L79 default prop | `submitLabel: 'Send'` | Keep EN literal default; drawer overrides | Same as above. |
| L110-112 submitButtonLabel computed | `submitLabel === 'Save' ? 'Saving...' : 'Sending...'` | **REWRITE per M1**: switch on `props.submitKind`, look up zh via composer-local `useLocale` + `commentLabel` | See §6 for the exact new shape. |
| L123-125 composerHint computed | `'Tab to mention, ...' / 'Ctrl/Cmd + Enter to send'` | `props.modelValue` is not the gate — `showSuggestions.value` is. Helper-free; use 2 keys: `comment.hintWithMention` / `comment.hintBase` looked up via composer-local `commentLabel`. | Physical-key string `Ctrl/Cmd + Enter` literal in both locales. |

Do not translate:

- Mention suggestion item text (mention name/id — user data).
- The literal `Ctrl/Cmd + Enter` token inside the hint strings (physical key shortcuts per workbench-labels precedent).

### 4.3 `MetaCommentAffordance.vue` (85 lines) + `MetaCommentActionChip.vue` (48 lines)

**0 in-scope strings.** Both are presentational:

- `MetaCommentAffordance.vue` renders numeric badges (`unresolvedCount`, `mentionCount`) + an emoji bubble `&#x1F4AC;`. No translatable chrome.
- `MetaCommentActionChip.vue:7` renders the parent-passed `label` prop as literal text. The component itself owns no string; localization lives at the consumer.

T3B2 does **not** modify either file.

### 4.4 `MultitableWorkbench.vue` Wire (M3 — single line)

The comments-drawer close path triggers `confirmDiscardCommentDraft()` at `MultitableWorkbench.vue:1939`, which currently calls `window.confirm('Discard unsaved comment draft?')`. T3B2 wires this single string:

```ts
// Add import alongside existing imports:
import { commentLabel } from '../utils/meta-comment-labels'

// Inside confirmDiscardCommentDraft() (no other body change):
function confirmDiscardCommentDraft() {
  if (!hasCommentDraft.value) return true
  return window.confirm(commentLabel('comment.discardDraftConfirm', isZh.value))
}
```

`isZh` is already available on `MultitableWorkbench.vue` via T2's `useLocale()` wiring. The diff is ~3 lines (1 import + 1 confirm-arg). T3B2 does NOT modify any other Workbench logic; this is the only Workbench touch in this slice.

### 4.5 Out-of-Scope Consumer Audit (S1)

`MetaCommentActionChip` is consumed in 6 components total. Status per consumer:

| Consumer | Sites | Status |
|---|---|---|
| `MetaRecordDrawer.vue:30` | 1 | ✅ Already localized in T3B1 (`:label="l('record.comments')"`). |
| `MetaCalendarView.vue:95,176,251` | 3 | ❌ `label="Comments"` hardcoded. Deferred to view-chrome slice. |
| `MetaGalleryView.vue:82` | 1 | ❌ `label="Comments"` hardcoded. Deferred. |
| `MetaHierarchyView.vue:469` | 1 | ❌ `label: 'Comments'` hardcoded in `h()` render fn. Deferred. |
| `MetaTimelineView.vue:95,154` | 2 | ❌ `label="Comments"` hardcoded. Deferred. |
| `MetaKanbanView.vue:71,130` | 2 | ❌ `label="Comments"` hardcoded. Deferred. |

**T3B2 does NOT touch the 9 hardcoded sites.** They will be addressed in a later view-chrome slice (anchored under T3D or a dedicated "alt-views-i18n" slice). Reviewers MUST NOT close T3B2 with the expectation that "all comment chips are localized" — only the record drawer's chip (via T3B1) and the drawer surface chrome (this slice) ship.

---

## 5. Helper Plan

```ts
// emptyMessage: 3-branch drawer empty-list message. scopeLabel is user data
// (field name); preserved raw. Order matters: scoped > field-only > generic.
export function emptyMessage(
  scopeLabel: string | null | undefined,
  targetFieldId: string | null | undefined,
  isZh: boolean,
): string {
  if (targetFieldId && scopeLabel) {
    return isZh
      ? `${scopeLabel} 暂无评论`
      : `No comments yet for ${scopeLabel}`
  }
  if (targetFieldId) {
    return isZh
      ? '该字段暂无评论'
      : 'No comments yet for this field'
  }
  return isZh ? '暂无评论' : 'No comments yet'
}

// replyCount: thread reply count badge. EN has singular/plural fork; zh
// uses 条 量词 (same as workbench-labels mentionsRecords).
export function replyCount(n: number, isZh: boolean): string {
  if (isZh) return `${n} 条回复`
  return `${n} ${n === 1 ? 'reply' : 'replies'}`
}

// editingBanner / replyingBanner: drawer banner copy when a thread/reply is
// being edited or replied to. The actorLabel is already resolved by the
// caller via `comment.authorName ?? comment.authorId` (user data; never
// translated).
export function editingBanner(actorLabel: string, isZh: boolean): string {
  return isZh ? `正在编辑 ${actorLabel}` : `Editing ${actorLabel}`
}
export function replyingBanner(actorLabel: string, isZh: boolean): string {
  return isZh ? `正在回复 ${actorLabel}` : `Replying to ${actorLabel}`
}
```

---

## 6. MetaCommentComposer `submitKind` Design (M1 Fix Detail)

**Current bug** (`MetaCommentComposer.vue:110-112`):

```ts
const submitButtonLabel = computed(() => {
  if (!props.submitting) return props.submitLabel
  return props.submitLabel === 'Save' ? 'Saving...' : 'Sending...'  // literal-coupled
})
```

When drawer passes `submitLabel = '保存'` (localized), the predicate `=== 'Save'` is false → submitting state silently returns `'Sending...'` (or `'正在发送...'` after T3B2) instead of `'正在保存...'`. Real i18n trap caught at design review.

**Fix**: add a `submitKind` prop and key the submitting branch on it.

```ts
// In defineProps:
withDefaults(defineProps<{
  // ...existing props
  submitKind?: 'send' | 'save'
}>(), {
  // ...existing defaults
  submitKind: 'send',
})

// Replace the submitButtonLabel computed:
const submitButtonLabel = computed(() => {
  if (!props.submitting) return props.submitLabel
  return props.submitKind === 'save'
    ? commentLabel('comment.submitSaving', isZh.value)
    : commentLabel('comment.submitSending', isZh.value)
})
```

**Drawer call-site** (`MetaCommentsDrawer.vue` around L116):

```vue
<MetaCommentComposer
  :placeholder="placeholderCopy"
  :submit-label="submitLabelCopy"
  :submit-kind="activeEditingComment ? 'save' : 'send'"
  ...
/>
```

**Implications**:

- Composer becomes locale-aware (imports `useLocale` + `commentLabel`). Acceptable architectural change — composer already manages reactive state for suggestions/mentions/submit state; adding locale is incremental.
- `submitLabel` remains a prop for the resting label (drawer-controlled). Composer falls back to it when `submitting === false`.
- `submitKind` defaults to `'send'`, preserving the current behavior for any consumer that does not pass it (e.g., a future composer reuse without a drawer).

**Test coverage** (in `meta-comment-composer-i18n.spec.ts`):

- `submitKind='send', submitting=true, zh-CN` → button text is `正在发送...`
- `submitKind='save', submitting=true, zh-CN` → button text is `正在保存...`
- `submitKind='send', submitting=true, en` → `Sending...`
- `submitKind='save', submitting=true, en` → `Saving...`
- `submitting=false` → button text is the resting `props.submitLabel` (drawer-controlled, unmodified)

---

## 7. Cross-Module Reuse Discipline

T3B2 imports the following from earlier modules — they are NOT redeclared:

- (none) — comment chrome is genuinely new; no helper or key from `workbench-labels` / `meta-core-labels` / `meta-record-labels` is reused.

The drawer wires `useLocale` once and creates two accessors:

```ts
const { isZh } = useLocale()
const l = (key: MetaCommentLabelKey) => commentLabel(key, isZh.value)
```

The composer (also locale-aware after M1 fix) does the same:

```ts
const { isZh } = useLocale()
const cl = (key: MetaCommentLabelKey) => commentLabel(key, isZh.value)
```

**Discipline**:

- Composer NEVER imports the drawer's accessor — it owns its own (`cl`).
- Drawer-resolved props (`placeholder`, `submitLabel`, `submitKind`) keep their drawer-locale; composer's internal state (`submitting` branch + `composerHint` + `mentionSuggestionsAria`) uses composer-local locale.
- Both locale-listeners observe the same `useLocale()` singleton — they switch together.

---

## 8. Test Plan

### 8.1 Helper Spec — `apps/web/tests/meta-comment-labels.spec.ts` (NEW)

Coverage:

- All 24 static keys: en + zh.
- `emptyMessage` 3 branches × en + zh (6 cases) + raw `scopeLabel` preservation.
- `replyCount(1, isZh)` → `1 reply` / `1 条回复`; `replyCount(2, isZh)` → `2 replies` / `2 条回复` (S3 explicit singular/plural coverage).
- `editingBanner` + `replyingBanner` × en + zh + Unicode actorLabel preservation.

### 8.2 MetaCommentComposer Render Spec — `apps/web/tests/meta-comment-composer-i18n.spec.ts` (NEW)

Mount/teardown matches the canonical `apps/web/tests/meta-cell-editor-i18n.spec.ts` shape (createApp + container + app?.unmount() + container?.remove() + locale reset).

**Verification posture (S4)**: assert via rendered button text, NOT via a production data-attribute or by inspecting the child component's prop value. Behavior is the contract.

Cases:

- zh-CN composer rest state with drawer-passed `submitLabel='发送'` + `submitKind='send'` → submit button textContent is `发送` when `submitting=false`.
- zh-CN composer submitting with `submitKind='send'` → submit button textContent is `正在发送...`.
- zh-CN composer submitting with `submitKind='save'` → submit button textContent is `正在保存...` **(M1 regression guard — this is exactly the bug fix target; assertion is on rendered text, not on the submitKind prop value)**.
- en composer submitting with `submitKind='save'` → submit button textContent is `Saving...`.
- en composer submitting with `submitKind='send'` → submit button textContent is `Sending...`.
- zh-CN composer with default `submitKind` (no prop passed) + `submitting=true` → defaults to `'send'` path: button textContent is `正在发送...`.
- zh-CN mention-suggestions listbox aria-label is `评论提及建议` (M2). Trigger via mention insertion (`@` keystroke) to make `showSuggestions=true`.
- zh-CN composerHint shows `Tab 提及，Ctrl/Cmd + Enter 发送` when `showSuggestions=true`; `Ctrl/Cmd + Enter 发送` when false. Physical key `Ctrl/Cmd + Enter` literal preserved in both branches.
- en composerHint preserves original English exactly.

### 8.3 MetaCommentsDrawer Render Spec — `apps/web/tests/meta-comments-drawer-i18n.spec.ts` (NEW)

**Capability gating fixtures (M4)**: action buttons are each gated by props/state. Tests MUST set fixtures to make each assertion reachable; otherwise the assertion is a false-negative trap (same class as T3A2 Workflow/Automations gate). Specifically:

- `Reply` button: requires `props.canComment === true` AND `comment.resolved === false`.
- `Edit` button: requires `canEditComment(comment)` = `props.canComment === true` AND `comment.authorId === props.currentUserId` AND `comment.resolved === false`.
- `Delete` button: requires `canDeleteComment(comment)` = `props.canComment === true` AND `comment.authorId === props.currentUserId` AND **no replies under this comment** (i.e., no other comment in the `comments` array has `parentId === comment.id`).
- `Resolve` button: requires `props.canResolve === true` AND `comment.resolved === false`.
- `Resolved` badge: requires `comment.resolved === true`. **Mutually exclusive with `Resolve` on a single thread.**

**Real prop shape (verified against `MetaCommentsDrawer.vue:148`)**: the drawer accepts a single flat `comments: MultitableComment[]` prop. The `repliesByParentId` map is an INTERNAL computed (L254) derived from `comment.parentId`. Tests pass child comments WITH `parentId` in the same `comments` array — they do NOT pass `repliesByParentId` as a prop (that name does not exist on the prop surface).

A full action-set render assertion needs at least **2 thread-root comments**:

```ts
// Thread A — root (no parentId), owned-by-current-user, unresolved → shows
// Reply/Edit/Delete/Resolve. Delete reachability requires no child comment
// in `comments` has `parentId === threadA.id`.
const threadA: MultitableComment = {
  id: 't1', parentId: null,
  authorId: 'user-self', resolved: false,
  content: '...', createdAt: '2026-05-20T00:00:00Z', ...
}
// Thread B — root, owned-by-other, resolved → shows Resolved badge only.
const threadB: MultitableComment = {
  id: 't2', parentId: null,
  authorId: 'user-other', resolved: true,
  content: '...', createdAt: '...', ...
}

mountDrawer({
  comments: [threadA, threadB],   // single flat array; NO repliesByParentId prop
  currentUserId: 'user-self',
  canComment: true,
  canResolve: true,
})
```

For reply-count cases, add child comments to the same array with `parentId` set:

```ts
const reply1: MultitableComment = { id: 'r1', parentId: 't1', authorId: '...', resolved: false, ... }
mountDrawer({
  comments: [threadA, reply1],   // reply1.parentId === threadA.id forms the internal repliesByParentId mapping
  ...
})
```

**Scoped DOM querying (Should-Fix)**: thread A globally contains 编辑/删除/解决 — so "thread B does not contain Edit/Delete/Resolve" assertions MUST query within thread B's own root element (`container.querySelectorAll('.meta-comments-drawer__item')[i]` or similar by `data-comment-id` / nth-child), NOT against `container.textContent`. A container-level not-contain assertion would be trivially false (thread A is in the container).

Cases:

- **zh-CN header**: container.textContent contains `评论`, `收件箱` (RouterLink), `正在加载...` when `loading=true`.
- **zh-CN thread A action buttons (own, unresolved, no replies under it)**: scope queries to thread A's item root; assert its textContent contains `回复`, `编辑`, `删除`, `解决`; does NOT contain `已解决`.
- **zh-CN thread B (other-authored, resolved)**: scope queries to thread B's item root; assert its textContent contains `已解决`; does NOT contain `编辑`, `删除`, `解决` (gating denies all three on this thread).
- **zh-CN progress states** — single-state-at-a-time fixtures, scoped to thread A's item root:
  - `editingCommentId === threadA.id` → thread A's Edit button textContent is `正在编辑...`.
  - `deletingIds.includes(threadA.id)` → thread A's Delete button textContent is `正在删除...`.
  - `resolvingIds.includes(threadA.id)` → thread A's Resolve button textContent is `正在解决...`.
- **zh-CN empty state**: 3 sub-cases, all with `comments: []`:
  - no `targetFieldId` → container.textContent contains `暂无评论`.
  - `targetFieldId='f1'` only → contains `该字段暂无评论`.
  - `targetFieldId='f1'` + `scopeLabel='Status'` → contains `Status 暂无评论` (preserves raw user-data scope label).
- **zh-CN error state**: `error: 'Network failed: ECONNREFUSED'` (a backend-style raw string) → drawer textContent contains the raw error verbatim AND `重试`; does NOT contain `Retry`.
- **zh-CN edit banner**: `activeEditingComment` set with `authorName='Alice'` → banner-scoped query contains `正在编辑 Alice` (raw author name preserved) + `取消` button.
- **zh-CN reply banner**: `activeReplyComment` set with `authorName='Bob'` → banner-scoped query contains `正在回复 Bob` + `取消`.
- **zh-CN composer placeholder pass-through (behavior-asserted, S4)**: with `activeEditingComment` → query the composer input's rendered `placeholder` attribute, assert `编辑评论…`; with `activeReplyComment` → `回复线程…`; with neither → `添加评论...`.
- **zh-CN composer submit pass-through (behavior-asserted, S4)**: with `activeEditingComment` + `submitting=true` → query the composer submit button's rendered textContent, assert `正在保存...`; with new-comment mode + `submitting=true` → `正在发送...`. **NO data-attribute on production code, NO direct submitKind prop inspection — DOM behavior is the contract.**
- **zh-CN reply count badge**: `comments: [threadA, oneReply]` where `oneReply.parentId === threadA.id` → thread A's reply-count badge textContent is `1 条回复`; with 3 replies (`comments: [threadA, r1, r2, r3]` all with `parentId: 't1'`) → `3 条回复`.
- **en regression**: at least one full-flow case with `setLocale('en')` to confirm English literals render exactly (`Comments`, `Inbox`, `Reply`, `Edit`, `Delete`, `Resolve`, `Resolved`, `Retry`, `Cancel`, `Add a comment...`).

### 8.4 Validation Commands

Run after implementation:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/meta-comment-labels.spec.ts \
  tests/meta-comment-composer-i18n.spec.ts \
  tests/meta-comments-drawer-i18n.spec.ts \
  tests/multitable-workbench-view.spec.ts \
  tests/meta-record-labels.spec.ts \
  tests/multitable-core-i18n.spec.ts \
  tests/link-fields-i18n.spec.ts \
  tests/meta-record-drawer-i18n.spec.ts \
  tests/meta-form-view-i18n.spec.ts \
  tests/meta-cell-editor-i18n.spec.ts \
  tests/meta-toolbar-filter-builder.spec.ts \
  tests/meta-grid-table-i18n.spec.ts \
  --watch=false

pnpm --filter @metasheet/web exec vue-tsc --noEmit
git diff --check origin/main..HEAD
```

**Workbench spec rationale (Must-Fix)**: `tests/multitable-workbench-view.spec.ts` is included because the M3 wire touches `MultitableWorkbench.vue:1939`. vue-tsc catches import shape but not the native `confirm()` behavior; running the existing Workbench spec ensures any comment-draft-confirm assertion or smoke check still passes after the wire. If the Workbench spec does not currently exercise that confirm path, the implementer should add a thin `vi.spyOn(window, 'confirm')` case to it (same pattern T3B1 used for `form.discardConfirm`) rather than mounting a parallel Workbench harness.

Path note: commands run through `pnpm --filter @metasheet/web exec`, so spec paths are package-relative (`tests/...`), not repo-relative (T3A2 / T3B1 caught this same way).

### 8.5 Implementation Preflight Grep

Before writing the module, verify each planned key has a real call-site in `MetaCommentsDrawer.vue`, `MetaCommentComposer.vue`, **OR `MultitableWorkbench.vue` (for `comment.discardDraftConfirm` only, per M3)** — no dead keys. For the new `comment.submitSending` / `comment.submitSaving` / `comment.mentionSuggestionsAria` keys — they will be wired during the M1+M2 implementation steps; preflight verifies the corresponding `'Saving...'` / `'Sending...'` / `'Comment mention suggestions'` source strings exist at their expected lines. For `comment.discardDraftConfirm`, preflight verifies the literal `'Discard unsaved comment draft?'` at `MultitableWorkbench.vue:1939`.

---

## 9. Implementation Order

1. **Preflight grep**: for each planned key in §3, verify a real call-site exists in `MetaCommentsDrawer.vue`, `MetaCommentComposer.vue`, **or `MultitableWorkbench.vue` (only `comment.discardDraftConfirm` per M3)**. Resolve any miss before writing the module.
2. Add `meta-comment-labels.ts` with typed static labels and 4 helpers (`emptyMessage` + `replyCount` + `editingBanner` + `replyingBanner`).
3. Write `meta-comment-labels.spec.ts` (helper + static key unit coverage). Run green in isolation before component wiring.
4. **M1 fix**: extend `MetaCommentComposer.vue` defineProps with `submitKind?: 'send' \| 'save'` (default `'send'`); rewrite `submitButtonLabel` computed to switch on `submitKind` + add composer-local `useLocale` + `commentLabel` imports.
5. Wire `MetaCommentComposer.vue` static chrome (M2 aria + composerHint).
6. Write `meta-comment-composer-i18n.spec.ts`. Run green.
7. Wire `MetaCommentsDrawer.vue`: imports + setup + 14 chrome wirings (per §4.1 table) + drawer-side `:placeholder` + `:submit-label` + `:submit-kind` pass-through. Use `emptyMessageFn` alias on import to avoid collision with the existing `emptyMessage` local computed.
8. Write `meta-comments-drawer-i18n.spec.ts`. Run green. **Capability fixtures per M4** — 2 threads + explicit currentUserId/canResolve/canComment.
9. **M3 wire** `MultitableWorkbench.vue:1939`: add `commentLabel` import + replace the literal confirm arg with `commentLabel('comment.discardDraftConfirm', isZh.value)`. Re-run `tests/multitable-workbench-view.spec.ts` (included in §8.4 validation set) to confirm no regression; if that spec does not currently exercise the comment-draft confirm path, add a `vi.spyOn(window, 'confirm')` case there in the same shape as T3B1's `form.discardConfirm` spy.
10. Run full focused spec set (12 files: meta-comment-labels + meta-comments-drawer-i18n + meta-comment-composer-i18n + multitable-workbench-view + meta-record-labels + multitable-core-i18n + link-fields-i18n + meta-record-drawer-i18n + meta-form-view-i18n + meta-cell-editor-i18n + meta-toolbar-filter-builder + meta-grid-table-i18n). Confirm 0 regression vs T3A1/T3A2/T3B1.
11. Write verification MD.
12. Rebase to latest `origin/main`, rerun focused tests + `vue-tsc` + diff-check.
13. Push/PR only after explicit operator go, consistent with T3A1/T3A2/T3B1 discipline.

---

## 10. Risk Register

| Risk | Mitigation |
|---|---|
| Accidentally translating user data (author names, mention text, comment body, error messages) | Tests assert raw preservation for `authorName`/`authorId`/`error` content; helper signatures take pre-resolved actorLabel/scopeLabel. |
| M1 submitButtonLabel literal-coupling | Fixed via `submitKind` prop; render spec includes the exact `submitKind='save', submitting=true, zh-CN → 正在保存...` regression-guard case (cannot ship without that test). |
| M2 aria-label silently English | `comment.mentionSuggestionsAria` is a named key in §3 + asserted in §8.2; preflight grep covers it. |
| Name collision: helper `emptyMessage` vs drawer local computed | Import as `emptyMessageFn` (T3A2 `attachmentActionHintFn` pattern). |
| Composer becoming locale-aware can produce a mixed state for a future standalone consumer | Future-only risk (S5): a future consumer that passes the unlocalized English `Send`/`Save` default for `submitLabel` while running under zh would see a mixed state — resting button shows English `Send`, submitting branch resolves to `正在发送...` via composer-local `commentLabel`. **The current sole production consumer (MetaCommentsDrawer) always passes locale-aware `submitLabel` + matching `submitKind`, so this is hypothetical in production.** Flagged for any future consumer reviewer; not a T3B2 blocker. |
| M3 cross-module wire (Workbench → meta-comment-labels) | Single import + single confirm-arg change in MultitableWorkbench. No other Workbench logic changes. Verified via (a) meta-comment-labels.spec.ts on the key value (helper layer), AND (b) `tests/multitable-workbench-view.spec.ts` included in §8.4 validation — confirms vue-tsc + the existing Workbench mount still pass after the wire. If the Workbench spec does not currently exercise the comment-draft confirm path, the implementer adds a thin `vi.spyOn(window, 'confirm')` case to it (same shape as T3B1 `form.discardConfirm` spy) rather than mounting a parallel Workbench harness. |
| Reviewer misreads "Affordance + ActionChip 0 in-scope" as "all comment chips localized" | §4.5 explicit out-of-scope consumer audit lists all 9 cross-view hardcoded `label="Comments"` sites with file+line; reviewer cannot miss it. |
| `error` string body accidentally localized | §4.1 L91 row + §3 "Do not translate" + render spec asserts a backend-style error message stays exactly as injected. |
| Physical key `Ctrl/Cmd + Enter` translated | §3 `comment.hintBase` / `hintWithMention` zh values keep the literal `Ctrl/Cmd + Enter` token; render spec asserts both locales contain it verbatim. |
| Composer + drawer locale drift | Both use the same `useLocale()` singleton; render spec exercises locale toggling and verifies both surfaces flip together. |

---

## 11. Approval Gate

T3B2 implementation can start when the operator accepts:

- New `meta-comment-labels.ts` module (24 static keys + 4 helpers).
- New `submitKind` prop on `MetaCommentComposer.vue` + composer becoming locale-aware. M1 regression-guard test (`submitKind='save'` + zh + submitting → `正在保存...`) is mandatory.
- New `comment.mentionSuggestionsAria` key wired to L36 aria attribute (M2).
- **M3 single-line wire in `MultitableWorkbench.vue:1939`** — `comment.discardDraftConfirm` for the comments-drawer close-path native confirm. Workbench imports `commentLabel` once; no other Workbench logic changes.
- **M4 capability gating discipline** for the drawer render spec: 2 thread fixtures (own-unresolved-no-replies + other-resolved) + explicit `currentUserId` / `canResolve` / `canComment` props; progress-state cases use single-state-at-a-time fixtures.
- **S4 behavior-only verification**: tests assert rendered text/attributes, not production data-attrs and not child-component prop inspection.
- 9 cross-view `label="Comments"` hardcoded sites intentionally **NOT** localized in T3B2 — deferred to a later view-chrome slice, explicitly documented in §4.5.
- `error` body stays raw user data; only `Retry` button text localizes.
- T3B split position: T3B1 (record/form) merged; T3B2 (this slice) next; T3B3 (link picker) follows.

Until then this MD is read-only planning and must not be treated as implementation authorization.
