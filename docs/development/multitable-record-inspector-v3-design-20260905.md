# Record Detail Panel — Design Brief (synthesis of 3 proposals × 3 judges)
> 状态:**PROPOSED**(2026-09-05)。本文由三份独立方案 × 三位评委合成;§4 列出的每条「需 owner ratify」句子在 owner 亲写 comment 前均不生效;PR-A 的合并门 = §4 第 1–3 条的 comment ID 存在。基线:#5480(可拖宽面板)+ #5481(网格提交可靠性)。

**Winner (3/3 judges): Proposal 1 "Record Detail v3"**, adopted as the base model with six grafts (§2). Grounding facts re-verified on `origin/main @177cafd3e`, `#5480` head, `#5481` head: `conditional-formatting.ts:147` already has `isEmptyValue`; `MtMenu.vue` has no keydown handling; `#5481` (OPEN) binds every `key.length === 1` key — Space included — to type-to-edit at `MetaGridTable.vue:1632`, so Proposal 1's bare-Space open is stale and is replaced by Shift+Space; INS/WB contain no `isComposing` handling; W2 lock §3.1 verbatim = `打开：与今天一致——grid 行选中 onSelectRecord → selectedRecordId 置位 → 检查器 visible="!!selectedRecordId"` — it sits under §3 交互契约, so the explicit-open change is a lock erratum, not a reinterpretation.

Files (all under `/Users/chouhua/Downloads/Github/metasheet2/apps/web/`): INS = `src/multitable/components/MetaRecordInspector.vue`, FP = `MetaRecordFieldsPanel.vue`, HP/AP/PP = History/Attachments/Provenance panels, WB = `src/multitable/views/MultitableWorkbench.vue`, GRID = `src/multitable/components/MetaGridTable.vue`, labels = `src/multitable/utils/meta-record-labels.ts`, guard = `tests/ui-foundation-style-guard.spec.ts`.

---

## 1. Chosen model

### 1.1 Open / close
- **Two workbench states.** `selectedRecordId` stays the grid cursor (row highlight, collab presence, comment scope, `aria-selected`) — 69 consumers untouched. New `inspectorOpen = ref(false)`, session-only (no storage; OD-W2-2 discipline). Mount: `:visible="inspectorOpen && !!selectedRecordId"`.
- **Open = explicit intent only:** (i) row-number cell expand icon (`data-test=grid-open-record`, `aria-label` key `grid.openRecord`, `@click.stop`, visible on row hover / focus-within, always in a11y tree); (ii) **Shift+Space** on a focused row when `!editCell` (handled *before* #5481's printable branch; bare Space is now type-to-edit); (iii) row context-menu item **— P3-7 correction (2026-09-05): NOT in PR-A.** No context-menu component exists on the PR-A head (right-click emits only `duplicate-record`); adding one is net-new UI outside PR-A's own file list (§3). Follow-up, not something to ratify against yet; (iv) `resolveDeepLink`; (v) every `selectRecord(…, { openComments: true })` caller (mention/comment click-through). All route through one `openRecord(id)` = `inspectorOpen=true; void selectRecord(id); focusTitle()`.
- **Grid `select-record` (cell click, ArrowUp/Down/Tab) never opens.** Existing phase15 pin "emits select-record on click" stays green.
- **Follow while open** (飞书 drawer habit): with `inspectorOpen` true, `select-record` navigates the panel through the existing discard-guard path; focus stays in the grid.
- **Close** (× / Esc): `inspectorOpen=false`; `selectedRecordId` **retained** (graft from P2/P3 — row highlight survives, Shift+Space reopens instantly). `onCloseDrawer` order unchanged: `flushActiveFieldEdit` → discard-guard → `showComments=false` → `resetCommentInteractionState`. Focus returns to `openerEl` (captured at mount) else `.meta-grid` root.
- **Hash**: `#recordId=` written only while `inspectorOpen && selectedRecordId`, stripped on close (URL means "this record is expanded", so a reload does not resurrect a panel the user closed).
- **Comment fetch** moves out of `selectRecord` into the open transition + follow-while-open (P12): arrowing a closed panel makes zero comment requests. Pre-check before moving: grep consumers of `commentsState`/`loadCommentsForRecord` that render with the panel closed (grid comment indicators); if any exist, keep the fetch and record it.
- Overlay ≤768 (OD-W2-6), splitter/expand (#5480): unchanged.

### 1.2 Header
One non-wrapping toolbar row + a title block. Header can no longer overflow by construction: the toolbar's only non-shrinking items are 28px icon buttons plus nav; the title block is its own row and absorbs width.
- **Row A toolbar** (`.meta-record-drawer__toolbar`, `flex-wrap:nowrap`): left = prev/next `MtIconButton` + position text via interpolated helper `recordPosition(index,total,isZh)`; right = comment chip (bespoke `<button>` + `MetaCommentActionChip`, byte-untouched rules; text label hidden by container query <480px, `aria-label` kept), copy-link icon, expand toggle (existing testid), kebab `MtIconButton` (`aria-haspopup=menu`, `aria-expanded`, `data-testid=record-inspector-menu`), close (existing `__close`).
- **Row B title block**: eyebrow line rendering `l('record.title')` (graft from P3 — keeps `meta-record-drawer-i18n.spec.ts` text pins honest, no visually-hidden trick) + primary-field title. Primary field = one hoisted helper `resolvePrimaryField(fields)` in `utils/recordDisplay.ts`, replacing WB's two divergent idioms (L1013 `bulkFillRecordName`, ~L2385). If `canEditField(primary) && type==='string'` → `<input class="__title-input">`, commit on change/Enter → the same `emit('patch', primary.id, value)` sink, Escape reverts + `preventDefault`; else `<div class="__title-text" tabindex="-1">` via `formatRecordFieldValue`; empty → shared empty glyph. Re-syncs from `record.data` on prop change (server rejection cannot leave a stale optimistic title). Primary field stays in the field list (parity; FP `visibleFields` pins unchanged).
- **Kebab menu** = `MtMenu` + `MtMenuItem` **with arrow-key roving added to `MtMenu` as an additive kit change** (ArrowUp/Down/Home/End, Enter/Space activate, Escape closes → focus trigger; `role=menu/menuitem`). Pre-check in PR-A: `MtMenuItem` must pass `role="menuitemcheckbox"`/`aria-checked` through attrs; if it cannot, fall back to P1's bespoke `MetaRecordActionMenu.vue` (same contract). Items in order, every existing `v-if`/emit/handler preserved: watch (`menuitemcheckbox`, `aria-checked=recordSubscribed`, disabled while `subscriptionLoading` — removes the bespoke `--watching` pressed class, closing the "MtButton has no pressed variant" gap without a primitive change), comment inbox (`RouterLink`, `hasRouter`-gated, unread badge), automation (`canManageAutomation`), permissions (`canManageRecordPermissions`), duplicate (`record && canCreate`), separator, delete (`resolvedCanDelete`, danger class anchor kept).
- Lock banner: unchanged, below the sticky tabs bar.
- Splitter: DOM moved to the end of the root (absolute positioning keeps it visually identical) so it is the last Tab stop, not the first.

### 1.3 Body
- **Tabs bar** (sticky, existing): four tabs; `@container (width < 420px)` → tabs `flex:1; min-width:0` so they never wrap at the 360 floor (graft from P2/P3; `flex-wrap:wrap` kept as no-container-query fallback). Right-aligned hide-empty toggle (`MtButton`, `aria-pressed`, `data-testid=record-inspector-hide-empty`; APG toggle-button shape — constant visible label `record.hideEmpty`, state carried by `aria-pressed` only, PR-B1 round 2), details tab only.
- **Sections** (new `MetaRecordFieldSection.vue`, button `aria-expanded`/`aria-controls`, ids off `useId()`): §1 = view-ordered fields (`grid.visibleFields ∩ layer-3 ∩ layer-2`, via useMultitableGrid L522–537 order, fail-soft on stale ids); §1 is always headerless and always expanded (PR-B1 round 2 correction, 2026-09-05: the §1.6 mocks show the in-view fields directly under the tabs bar with no §1 heading — an earlier draft of this sentence read "expanded, headerless when §2 is empty", which round 1 implemented as a collapsible "Fields in this view" heading; struck); §2 = "hidden in this view" (`recordHiddenFieldsHeading(count,isZh)`), the only headed section, collapsed by default, component-local state. Passed as new optional prop `inspectorFieldLayout: { ordered, hiddenInView }` WB→INS→FP; absent prop → today's flat `props.fields` path (deprecated `MetaRecordDrawer` consumers, router-less specs). Applying layer-2 here closes P8 — declared behaviour change with negative golden N3.
- **Single column at every width** (parity with both benchmarks; P3's ≥520px two-column field grid rejected by all judges). Only editors widen.
- **Hide empty**: session-only (OD-W2-2). Predicate = the existing `isEmptyValue` in `conditional-formatting.ts:147`, **exported and also called by field-display.ts's empty-glyph branch (L106–115)** so glyph and filter share one definition (no second predicate). Never hides: primary field, focused field, field with AI status/error, field with comment presence, field with a pending server error. Hidden = (empty at snapshot) ∩ (empty now), the snapshot retaken on record-id / toggle change (PR-B1 round 2 correction, 2026-09-05 — an earlier draft read "hidden set snapshotted on record-id / toggle change", which round 1 implemented as snapshot-only and a just-filled field vanished on blur): a field that gains a value becomes visible immediately and stays visible; a field that loses its value stays visible until the next snapshot (record change / toggle), so a value being cleared cannot vanish mid-edit.
- **Link chips**: `MetaCellRenderer` with `:fetch-record` threaded WB `fetchLinkedRecordFn` → INS → FP; chips open the existing `MetaLinkedRecordPopover` (nesting cap 1 preserved by that component). `open-link-picker` button stays beside the chips. HI-1: same `getRecord` read, second host — proved by mutation (drop the prop → chips non-clickable, zero fetch).
- **Attachments**: `MetaAttachmentList` already renders thumbnails + lightbox (P17 = PRESENT); CSS-only 3-up gallery at ≥480px container width.
- **Field-anchored server errors** (graft from P2, PR-B2): additive `lastPatchFailure` ref in `useMultitableGrid.patchCell` catch (rollback and `error.value` untouched); WB `onDrawerPatch` routes `fieldErrors`/400/422/`VALIDATION_ERROR` to `inspectorFieldErrors[fieldId]` instead of toast; all other codes keep the toast; `VERSION_CONFLICT` shows the existing conflict banner + field marker. FP keeps a per-field draft so the rejected value stays in the control, renders `role=alert` under it, sets `aria-invalid` + `aria-describedby`, clears on next successful patch of that field or record change.
- **Copy link**: emits `copy-link`; WB writes `window.location.href` (already carries `#recordId=` while open) via `navigator.clipboard.writeText`; item disabled when clipboard API absent; `aria-live=polite` status via `record.copyLinkDone`/`record.copyLinkFailed`.
- **Editor parity** (P10) deferred: `MetaCellEditor` calls `inputRef.focus()` at mount (L841) and is #5481 territory; revisit after #5481 with an autofocus opt-out prop.

### 1.4 Wide-screen (PR-C, gated hard-false until OD-W2-1 addendum)
`twoColumn = viewportWidth >= INSPECTOR_TWO_COLUMN_MIN_VIEWPORT(1440) && panelWidth >= 2*MIN_PANEL_WIDTH(720)` — reachable only via expand or drag-to-max. When true: two tablists (L `details|attachments`, R `comments|history`), each a complete APG tablist with its own `aria-label` key and exactly one `tabindex=0`; the single root dispatcher resolves the list via `target.closest('[role=tablist]')`. `activeTab` becomes `{ primary, activity }`; `openComments` true-transition selects `comments` in the activity list; the comment chip focuses the composer. Shrinking below either gate collapses to the single four-tab tablist. Push semantics (OD-W2-3a) kept; no modal/fullscreen.

### 1.5 Keyboard (all inspector keys in the single root `onInspectorKeydown`; grid keys in `MetaGridTable.onKeydown`)
Dispatch order: (1) Escape — if kebab open → close menu, `preventDefault`, return; else existing bare-key / `defaultPrevented` guard → `emit('close')` (title input, rich editor, menu each `preventDefault` their own Escape). (2) `target.closest('[role=separator]')` → splitter keys (unchanged). (3) **Prev/next = `(meta|ctrl)+shift` + `event.code === 'Comma' | 'Period'`** (graft from P2; layout-independent, no caret collision; Alt+Arrow rejected — macOS Option+Arrow has caret semantics; `j`/`k` dropped — IME/type-to-edit hazard, no `isComposing` handling exists). Bounds → no emit. Listed in the `?` overlay via `kbd.recordPrev`/`kbd.recordNext`. (4) `target.closest('[role=tablist]')` → Arrow/Home/End within that list (single or per-column). Nothing else inspected; mod+z/y and `?` bubble to `onGlobalKeydown`.
Tab-switch focus (lock §3.3; shipped in PR-A): pointer activation → focus first focusable in the new tabpanel (else the panel itself — 2026-09-05 correction: this previously read "`tabindex=-1`", but the shipped tabpanel markup carries `tabindex="0"`, so the panel is itself a Tab stop, see the tab-order line below); arrow activation → focus stays on the tab (APG).
FP-local: plain `<textarea>` `mod+Enter` → `blur()` (one `patch`, mirrors `MetaRichLongTextEditor` L78–79); Enter on single-line scalar controls commits and advances to the next editable control, Shift+Enter previous.
Grid: Shift+Space (focused row, `!editCell`) → `expand-record`. Enter untouched.
Tab order after PR-A (P3-3, 2026-09-05 correction: this line previously read "title → prev → next → …", which contradicts both the mock's own §1.6 layout and the shipped DOM — Row A, the toolbar, precedes Row B, the title, in both. Second correction, 2026-09-05 round 3, probed against the shipped DOM on this head: the previous version listed `hide-empty`, which is PR-B1 and not on this head, and omitted the tabpanel stop — the tabpanel carries `tabindex="0"` in the pre-existing markup and IS a Tab stop): prev → next → comment chip → copy-link → expand → kebab → close → title input → active tab → tabpanel → field controls → splitter. `hide-empty` joins this order once PR-B1 lands (ahead of the field controls, where the previous version of this line placed it).

### 1.6 ASCII mocks (i18n keys; `{pf}` = primary field value; `n/N` = position; `‖` = splitter)

**360px (push floor; also ≤768 overlay width)**
```
┌‖──────────────────────────────────────────┐
│‖ [‹][›] n/N            [💬][🔗][⤢][⋯][×]  │  Row A: one row, never wraps (~270px content)
│‖ record.title (eyebrow, --ms-text-3)      │
│‖ ┌──────────────────────────────────────┐ │  Row B: {pf} 18px; <input> if editable
│‖ │ {pf}                                 │ │
│‖ └──────────────────────────────────────┘ │
│‖ [record-lock-banner]  (only when locked) │
│‖ [details][history][comments][attach]     │  sticky; @container <420: flex:1 tabs, one row
│‖                    [☐ record.hideEmpty]  │  wraps under pill only at 360
│‖ {field.name}                    [AI][💬] │
│‖ [ editor / read value                  ] │
│‖ {link field}                             │
│‖ (chip)(chip)(chip)  [record.editLinks]   │  chip → MetaLinkedRecordPopover
│‖ {attachment field}                       │
│‖ [▣][▣][+]                                │  MetaAttachmentList (wrap <480)
│‖ ▸ recordHiddenFieldsHeading(n)           │  collapsed section
│‖ ▸ record.provenance (unchanged)          │
└‖──────────────────────────────────────────┘
⋯ menu (role=menu, arrow roving):
  ☑ record.watching / ☐ record.watch   (menuitemcheckbox)
    comment.inbox (badge)              (RouterLink, hasRouter)
    record.workflow · record.permissions · record.duplicate
    ─────
    record.delete                      (danger)
```

**560px (user-dragged)** — same DOM; only widths and the chip label change
```
┌‖──────────────────────────────────────────────────────────┐
│‖ [‹][›] n/N                  [💬 record.comment][🔗][⤢][⋯][×] │
│‖ record.title                                             │
│‖ ┌──────────────────────────────────────────────────────┐ │
│‖ │ {pf}                                                 │ │
│‖ └──────────────────────────────────────────────────────┘ │
│‖ [details][history][comments][attachments] [☐ hideEmpty] │  one line
│‖ {field.name}                                    [AI][💬] │
│‖ [ editor ............................................. ] │  still ONE column (parity)
│‖ {field.name}                                        [💬] │
│‖ [ editor ............................................. ] │
│‖ ⚠ {fieldErrors[id]}  [record.fieldErrorRetry]            │  role=alert (PR-B2), draft kept in control
│‖ {attachment field}                                       │
│‖ [▣][▣][▣][+]                                             │  3-up gallery ≥480 container
└‖──────────────────────────────────────────────────────────┘
```

**≥1440px viewport, panel at 720 (expand / drag-to-max; PR-C, gated)**
```
┌── grid (push, ≥40vw, interactive) ──┬‖────────────────────────────────────────────────────────────────┐
│                                     │‖ [‹][›] n/N                        [💬 record.comment][🔗][⤡][⋯][×] │
│                                     │‖ record.title                                                   │
│                                     │‖ ┌────────────────────────────────────────────────────────────┐ │
│                                     │‖ │ {pf}                                                       │ │
│                                     │‖ └────────────────────────────────────────────────────────────┘ │
│                                     │‖ ┌ L (min 360) ─────────────────┐ ┌ R (min 360) ───────────────┐ │
│                                     │‖ │ [details][attachments] [☐]   │ │ [comments][history]        │ │  two tablists
│                                     │‖ │ {field}             [AI][💬] │ │ ┌ comment thread ────────┐ │ │
│                                     │‖ │ [ editor ................. ] │ │ │ …                      │ │ │
│                                     │‖ │ (chip)(chip) [editLinks]     │ │ └────────────────────────┘ │ │
│                                     │‖ │ ▸ hiddenFieldsHeading(n)     │ │ [ composer ............. ] │ │
│                                     │‖ │ ▸ record.provenance          │ │                            │ │
│                                     │‖ └──────────────────────────────┘ └────────────────────────────┘ │
└─────────────────────────────────────┴‖────────────────────────────────────────────────────────────────┘
Below either gate (or addendum unratified): the 560 layout at full width, single four-tab tablist.
```

---

## 2. Grafted ideas from non-winners and why

| Graft | From | Why |
|---|---|---|
| Keep `selectedRecordId` on close; hash written only while open | P2 (retain) + P3 amendment text | P1 cleared the cursor the user just chose; retaining keeps highlight/collab and makes Shift+Space reopen instant. Hash-strip on close is P1's, chosen so a reload does not reopen a closed panel. |
| Field-anchored PATCH errors (`lastPatchFailure` additive ref + `fieldErrors` prop + `role=alert`/`aria-invalid`/`aria-describedby`, mutation-backed test) | P2 | Synthesis P2 is S1; `client.ts` already normalises `fieldErrors`, only `patchCell` drops them. None of P1's phases touched it. |
| §3.3 tab-switch focus with pointer→first-control / arrow→stay split | P2 | Lock clause unimplemented (synthesis P1); the split is the APG-correct reading. |
| Comment fetch out of `selectRecord` (P12) with positive control | P2 | Explicit-open creates a "cursor moves, panel closed" state where the eager fetch is pure waste. |
| `mod+shift+Comma/Period` via `event.code` for prev/next | P2 | P1's Alt+Arrow claim is false on macOS (caret semantics); `j`/`k` is an IME hazard with no `isComposing` handling in INS/WB. |
| Enter-advance on single-line scalar controls, FP-local | P2 | Daily-edit throughput; never at the root dispatcher. |
| Reuse/export existing `isEmptyValue` and make the glyph branch call it | P3 | P1 would have added a second emptiness predicate beside the existing one (single-definition rule). |
| Session-only hide-empty, focused-field exemption, hidden-set snapshot | P3 | P1 persisted to localStorage on the strength of #5480 (still OPEN) — an OD-W2-2 storage surface; session-only needs no ratify. |
| `record.title` as an eyebrow line | P3 | Keeps i18n spec pins honest without a visually-hidden heading. |
| Container-query `flex:1` tabs <420px | P2/P3 | Four tabs at 360 never wrap. |
| `resolvePrimaryField` hoisted from WB L1013 | P3/P2 | WB label and INS title cannot diverge. |
| Token migration + `TARGET_FILES += 6` (five B3 migrations + the new `MetaRecordFieldSection.vue`, enrolled token-only by B1), zero allowlist, reintroduce-one-hex probe | P3 | UF-6's own prescribed onboarding path; CSS-only PR. |
| Drafted Chinese amendment wording (W2-A1/A2) | P3 | Owner-facing ratify text, adapted in §4 to the retained-cursor/hash-strip decisions. |
| Explicit frozen-spec churn list | P3 | P1 overclaimed "eight specs stay green"; t5-migration L117–285 and i18n L61 pin header buttons. |

Rejected: P3's two-column field grid (contradicts both benchmarks), P2's fullscreen/`aria-modal` (new OD-W2-3 state, no reported pain), P2's per-sheet persisted `inspectorOpen`/hide-empty (OD-W2-2), P2's `step`→`loadMore`/`goToPage` (inspector-initiated fetch, HI-1), P2's `MetaCellEditor` reuse now (mount-time focus, #5481 collision), P1's bespoke menu as first choice (parallel to `MtMenu`; kept only as fallback).

---

## 3. Phased PR plan

Merge order: `#5480` → `#5481` → PR-A (rebased; verify Space is printable on #5481's head before adding Shift+Space) → PR-B1/B2/B3 (independent of each other) → PR-C.

### PR-A — Kill both complaints (header + explicit open + focus)
Merge gate: the §3.1 erratum comment ID (§4 item 1) must exist; everything else is lock-compliant today. Structure as two commits so the header commit can be split off if the owner wants it sooner.
- **Files**: INS (toolbar row, title block, kebab, Escape order, focus capture/restore, splitter DOM-last, prev/next chord, §3.3 tab-switch focus, container-query tabs), `ui/MtMenu.vue` (additive arrow roving), `utils/recordDisplay.ts` (`resolvePrimaryField`), labels (`record.moreActions`, `record.copyLink*` reserved, `record.positionOf`, `record.titleFieldAria`, `kbd.recordPrev/Next`), WB (`inspectorOpen`, `openRecord`, hash watcher condition, `onCloseDrawer` keeps id + focus restore, comment fetch move, `resolveDeepLink`/mention paths → `openRecord`, two idioms → `resolvePrimaryField`), GRID (`expand-record` emit, row-number icon, Shift+Space case before printable branch, context-menu item, `grid.openRecord` label).
- **Behaviours**: §1.1, §1.2, §1.5 (chord, Escape order, tab-switch focus). Title editing included (same `patch` sink).
- **Tests to pin** (new `multitable-record-inspector-header.spec.ts` + edits): toolbar has exactly one `__toolbar` row whose child set = {nav, comment-chip?, copy-link, expand, menu, close}; source-text provision `flex-wrap: nowrap` on the toolbar (jsdom caveat stated); menu items present iff their gate prop is true, each gate toggled individually (fixture-shape rule), each click emits exactly once; watch item `aria-checked` mirrors subscription and calls the same client method; delete keeps the danger anchor; Escape with menu open closes menu and emits no `close`; MtMenu roving: ArrowDown/Up/Home/End move focus among items, Escape returns focus to trigger; title: editable only when `canEditField(primary) && type==='string'`, change emits `patch(primary.id, value)`, Escape reverts + `preventDefault` (root emits no close), prop change re-syncs input; opener refocused on unmount, detached opener → no throw, `.meta-grid` fallback; splitter is the last focusable; chord from inside a text input emits `navigate` with the neighbour id, bounds → no emit, chord without shift ignored, bare ArrowUp/Down in inputs emit nothing; mod+z still bubbles; tab-switch focus: click → first control focused, arrow → tab retains focus. Workbench spec: `select-record` with panel closed does not mount the inspector and writes no hash; `expand-record`/`resolveDeepLink`/mention path mount it and write the hash; with panel open, `select-record` navigates and consults the discard guard; close keeps `selectedRecordId`, strips the hash, resets comment state; zero comment fetches across three arrow selections with the panel closed, one fetch once opened. Grid spec: Shift+Space (no `editCell`) emits `expand-record`; Shift+Space with `editCell` emits nothing; bare Space on an editable cell still starts type-to-edit (#5481 pin); row-number icon emits with `.stop` (no `select-record` side effect). Frozen-spec churn (state line numbers in PR body): `multitable-record-drawer-t5-migration.spec.ts` helpers open the menu first and assert `.mt-menu-item`; `multitable-record-drawer-duplicate.spec.ts`; `meta-record-drawer-i18n.spec.ts` L61 (`删除` after menu open; `record.title` still in textContent via eyebrow); `multitable-record-drawer.spec.ts` `[title=…]` lookups.
- **Mutations to run**: delete the Escape-menu guard → "Escape in menu emits no close" red only; delete `inspectorOpen=true` in `openRecord` → open tests red, close tests untouched; delete the `.stop` on the row icon → side-effect test red; delete the hash-watcher `inspectorOpen` conjunct → "closed writes no hash" red; delete `openerEl.focus()` → restore test red; delete the comment-fetch move → zero-fetch test red, positive control still green.
- **Real-browser** (Chromium 1366×768, all header gates true — the owner's repro): `header.scrollWidth === header.clientWidth` at 360/560/720 panel widths; header height ≤ toolbar + eyebrow + title; four tabs on one row at 360; cell click with panel closed does not open; icon / Shift+Space / context menu open; × and Esc close and the row stays highlighted with focus back on the grid; menu renders above the panel and grid (z-index vs overlay ≤768); chord works with caret inside a textarea and does not move the caret.

### PR-B — Fields and editing (three independently mergeable slices)
**B1 — order, sections, hide-empty, chips, gallery, copy link, textarea chords.**
- Files: WB (`inspectorFieldLayout` computed, `fetchLinkedRecordFn` pass-through, `copy-link` handler), INS (props pass-through, hide-empty toggle, `copy-link` emit), FP (sections, hide-empty filter + snapshot + exemptions, link chips via `MetaCellRenderer`, gallery CSS, `mod+Enter` on textarea, Enter-advance), new `MetaRecordFieldSection.vue`, `conditional-formatting.ts` (export `isEmptyValue`), `field-display.ts` (glyph branch calls it), labels (`record.hideEmpty`, `recordHiddenFieldsHeading`, `record.copyLinkDone/Failed`, `record.editLinks`; the round-1 `record.showEmpty` / `record.fieldsInView` keys were removed in round 2), `utils/recordDisplay.ts` (`canEditField` hoisted).
- Tests (new `multitable-record-fields-sections.spec.ts`): order follows `ordered` not `fields` (reversed fixture); hidden-in-view collapsed by default, heading count via helper, `aria-expanded` toggles; **N3 negative golden**: property-hidden field absent from details though present in `fields`; absent prop → rendered field ids identical to `fields` (legacy path); hide-empty hides exactly the predicate-empty fields, never primary/focused/AI-active/commented/errored, snapshot recomputes on record-id change, state resets on remount; glyph⇔predicate agreement over the full fixture set; chips clickable iff `fetchRecord` passed, click opens the popover with the same record id; copy-link writes `href` containing `#recordId=`, clipboard-absent → item disabled, rejection → failed key in the live region; textarea `mod+Enter` → exactly one `patch`; Enter on a single-line control commits and moves focus to the next editable control, Shift+Enter previous, textarea/select untouched.
- Mutations: remove the `isEmptyValue` export use in the glyph branch → agreement test red; drop `:fetch-record` → chip test red and `fetchRecord` never called (HI-1 mechanical); delete layer-2 intersection → N3 red; delete the focused-field exemption → exemption test red.
- Real-browser: 360/560/720 — sections collapse/expand, hide-empty count, chip opens nested popover (cap 1), thumbnails 3-up at ≥480, copy link toast.

**B2 — field-anchored server errors.**
- Files: `composables/useMultitableGrid.ts` (`lastPatchFailure`), WB (`onDrawerPatch` routing, `inspectorFieldErrors`), INS (`fieldErrors` prop), FP (draft map, alert, aria wiring). Pre-check: read `packages/core-backend` `patchRecords` error shape for `fieldErrors` presence per type; state findings in PR body.
- Tests: composable — rejected `patchRecords` with `fieldErrors` populates `lastPatchFailure` AND still sets `error.value` and rolls back; workbench — 422 with `fieldErrors` → no toast + `[data-test=drawer-field-error]` under that field; 403 still toasts; `VERSION_CONFLICT` → conflict banner + field marker; FP — rejected value stays in the control, `aria-invalid="true"`, `aria-describedby` resolves to the alert, cleared after a successful patch of the same field and on record change, other fields unaffected.
- Mutations: delete the `lastPatchFailure` assignment → only the new composable test red (nothing else); delete the 422 routing branch → toast reappears, inline test red.
- Real-browser: reject a patch against a running backend, confirm the alert reads out (VoiceOver/NVDA spot check) and the toast does not fire.

**B3 — token migration + UF-6 onboarding (CSS-only).**
- Files: INS/FP/HP/AP/PP `<style>`, guard `TARGET_FILES += 5`, zero allowlist; P14 bare loading/empty divs → `AsyncStateBlock`/`EmptyState`.
- Tests: guard red against the pre-change files (positive control), green after; `uiFoundationTexture.spec.ts` picks up HP/AP.
- Mutations: reintroduce one hex literal → guard red.
- Real-browser: comment-active colours pixel-unchanged (screenshot diff), watching state readable in the menu, no tint regressions the owner objects to.

### PR-C — Wide-screen side-by-side (needs OD-W2-1 addendum)
- Files: INS (`twoColumn` computed, `INSPECTOR_TWO_COLUMN_MIN_VIEWPORT`, dual tablist render, `{primary, activity}` active state, per-tablist arrow scoping, composer focus from chip), `multitable-record-inspector.spec.ts` ("exactly one `tabindex=0`" becomes "exactly one per tablist").
- Ships with `twoColumn` hard-set to `false` until the addendum comment ID exists; the flip is a one-line follow-up.
- Tests: viewport 1440 + width 720 → two tablists, each one `tabindex=0`, union of ids = `TAB_ORDER`, arrows stay within their list, `openComments` true-transition selects `comments` in the activity list, chip focuses the composer; shrink → single tablist with active tab mapped; positive control: force `twoColumn=false` at 1440 → single tablist (gate is load-bearing); 1439 or 719 → single.
- Mutations: delete the viewport conjunct → 1439 test red; delete the width conjunct → 719 test red.
- Real-browser at 1440 and 1512: expand → two columns, comments composer usable, grid still interactive (push), no body horizontal scroll; drag below 720 collapses.

---

## 4. Needs owner ratify (exact sentences)

1. **W2 lock §3.1 勘误 W2-E1（打开）— blocks PR-A merge**
   「§3.1 打开（勘误 2026-09）：grid 单元格/行的单击与方向键移动仅置位 `selectedRecordId`（行高亮、协作光标、评论作用域沿用），不再令检查器可见。检查器可见 = `!!selectedRecordId && inspectorOpen`；`inspectorOpen` 仅由显式动作置位：(i) grid 行号单元格的展开钮；(ii) grid keydown 中 Shift+Space 于聚焦行且非编辑态（bare Space 归 #5481 type-to-edit）；(iii) 行上下文菜单「打开记录」（P3-7 更正 2026-09-05：PR-A 未随附此项——PR-A 头上不存在任何行上下文菜单组件，右键仅发出 `duplicate-record`；本项为后续 follow-up，在其落地前不构成 PR-A 范围内可测能力，owner 勘误此句时不应据此认为该入口已交付）；(iv) `resolveDeepLink` 及所有 `selectRecord(..., { openComments: true })` 调用方；(v) 打开态下的行选中与检查器内 prev/next 保持 `inspectorOpen=true`（跟随）。`inspectorOpen` 为会话内状态，不跨会话持久化（沿用 OD-W2-2 约束）；进入工作台缺省为关闭。」
2. **W2 lock §3.1 勘误 W2-E2（关闭）— same comment**
   「§3.1 关闭（勘误 2026-09）：close 钮 / Esc 置 `inspectorOpen=false` 并保留 `selectedRecordId`（行高亮与协作光标不丢）；`#recordId=` hash 仅在 `inspectorOpen && selectedRecordId` 时写入，关闭即剥离；`onCloseDrawer` 的 flushActiveFieldEdit → discard-guard → showComments=false → resetCommentInteractionState 顺序不变；关闭后焦点回到打开者（缺省 `.meta-grid` 根）。Esc 关闭由检查器根 `onInspectorKeydown` 处理（S3 已落地，本条记为对「沿用 workbench 根 onGlobalKeydown」的勘误），`defaultPrevented` 或带修饰键时不关闭；溢出菜单打开时 Esc 仅关菜单。」
3. **W2 lock §3.3 澄清 — same comment**
   「§3.3 面板内焦点（澄清）：指针激活 tab → 焦点进入该 tabpanel 首个可聚焦控件（无则 tabpanel 本身）；方向键激活 → 焦点留在 tab（APG），下一次 Tab 进入 tabpanel。检查器 prev/next 键位 = `(meta|ctrl)+shift+Comma/Period`（按 `event.code`），列入 `?` 快捷键面板。」
4. **W2 lock §1.2 / §2 acknowledgements — same comment, no wording change**
   「知悉：权限/自动化/复制/删除/关注/收件箱入口移入检查器头部锚定的溢出菜单，仍为头部启动、仍为模态/外部启动（§1.2 非目标不变）；§2 附件面板的两层可见性规则同样施加于字段面板（property.hidden 字段不再于「字段」tab 渲染，负向 golden N3），记为行为变更。」
5. **W2 lock OD-W2-1 增补（PR-C flip）— separate comment**
   「OD-W2-1 增补（2026-09）：视口 ≥1440 且面板宽 ≥720 时，四面板改由两个相邻 tablist 承载（左：details、attachments；右：comments、history），每个 tablist 为完整 APG tablist、各自 roving tabindex；任一阈值以下沿用 OD-W2-1 的单一四 tab tablist。不新增第五面板、不删 tab。`INSPECTOR_TWO_COLUMN_MIN_VIEWPORT=1440` 为检查器专属常量，与 §3.4 的 `RAIL_NARROW_BREAKPOINT=768` 无关、不分叉该阈值。」
6. **W2 lock OD-W2-2 side question — owner may decline; default is session-only**
   「OD-W2-2 追问：是否允许「隐藏空字段」按查看者跨会话持久化（localStorage，与 #5480 面板宽度同款腐坏安全读写）？未裁前保持会话内状态。」
7. **W2 lock HI-1 declaration (no wording change; PR body statement)**
   「HI-1 声明：字段面板的关联记录 chip 复用 grid 已授权的 `fetchLinkedRecordFn`（同一 `getRecord` 读、第二宿主），变异探针（移除 `:fetch-record` → chip 不可点、零 fetch）随 PR-B1 落地；prev/next 仍限于已加载窗口，跨页导航属 WB 数据流变更，留 owner 另裁。」
8. **Comment-affordance lock 补记 — one-line comment**
   「补记（2026-09）：检查器头部 comment 按钮保持 bespoke `<button>` + `MetaCommentActionChip`，三条 comment-active 规则与 token 逐字节不动，不移入溢出菜单；仅在检查器容器宽度 <480px 时以 CSS 隐藏其文字标签（`aria-label` 保留）。MtButton 迁移仍按 OD-CA-3=B 另开。」
9. **UI-foundation lock UF-6 onboarding — acknowledgement of the visible tint change**
   「UF-6 纳管（2026-09）：`ui-foundation-style-guard.spec.ts` TARGET_FILES 增补 MetaRecordInspector / MetaRecordFieldsPanel / MetaRecordHistoryPanel / MetaRecordAttachmentsPanel / MetaRecordProvenancePanel / MetaRecordFieldSection 六文件（前五为 PR-B3 迁移；第六为 PR-B1 新建组件，自引入切片起即 token-only 纳管，2026-09-05 round 2 增补），零 allowlist；P15 记录的两个未 token 化字面量映射到既有 `--ms-*` token，不新增 token；tinted 背景改以 border+text token 表达（可见变化，知悉）；变异探针：回填一个 hex → 守卫必红。」
10. **Mt* kit additive change — acknowledgement**
    「`MtMenu` 增补方向键 roving（ArrowUp/Down/Home/End、Esc 回焦触发器）为 additive-only 变更；`MtMenuItem` 允许透传 `role="menuitemcheckbox"` + `aria-checked`。若透传不可行，改用多维表内的 `MetaRecordActionMenu.vue`，不改 kit 契约。」
11. **B2 error routing — acknowledgement (2c data flow, additive)**
    「知悉：`patchCell` 新增 `lastPatchFailure` 只读引用（回滚与 `error.value` 不变）；`onDrawerPatch` 对 `fieldErrors`/400/422/VALIDATION_ERROR 改为字段内联提示、其余错误码沿用 toast，记为行为变更。」

---

## 5. Benchmark parity checklist (final acceptance, real browser: Chromium at 1366×768, 1440×900, 1512×982; widths 360 / 560 / 720; overlay at 768)

Open/close
- [ ] Cell click / ArrowUp/Down with panel closed: no panel, no `#recordId=` in URL, no comment request (Network tab)
- [ ] Row-number icon, Shift+Space, context-menu item, deep link, comment click-through each open the panel and write the hash
- [ ] With panel open, cell click / arrows navigate the panel; focus stays in the grid
- [ ] × and Esc close; row stays highlighted; focus lands on the opener / `.meta-grid`; hash stripped
- [ ] Esc inside rich editor, title input, or open kebab does not close the panel; second Esc does
- [ ] ≤768: overlay, rail/inspector mutual exclusivity, no body horizontal scroll

Header
- [ ] All gates true (watch, comment, inbox, automation, permissions, duplicate, delete): toolbar on one row at 360, `scrollWidth === clientWidth`, height ≤ toolbar + eyebrow + title
- [ ] Title shows the primary field; editable when permitted; Enter commits, Esc reverts
- [ ] Kebab: arrow keys rove, watch shows checked state, danger item last, menu above panel and grid
- [ ] Comment chip visible with amber active state; label hidden <480, `aria-label` present
- [ ] Copy link writes a URL that reopens the same record on load

Body
- [ ] Four tabs on one row at 360
- [ ] Fields follow view order; "hidden in this view" section collapsed with count; property-hidden field absent from details
- [ ] Hide-empty hides empties, count shown, focused/commented/errored/primary fields never hidden
- [ ] Link chip opens nested record popover (cap 1); edit-links button still present
- [ ] Attachment thumbnails as a 3-up gallery ≥480, lightbox opens
- [ ] Rejected PATCH shows inline alert at the field, value retained, no toast; 403 still toasts (B2)
- [ ] `mod+Enter` in textarea commits once; Enter advances between single-line controls
- [ ] Prev/next chord works with caret in a text control; bounds do nothing; listed in `?` overlay

Wide (PR-C, only after item 5 ratified)
- [ ] ≥1440 + expand: comments/history column beside fields; grid still interactive; drag <720 collapses to single tablist
- [ ] Each tablist has exactly one Tab stop; arrows do not cross tablists

Cross-cutting
- [ ] Style guard green with six files in `TARGET_FILES` (five B3 migrations + `MetaRecordFieldSection.vue`, enrolled by B1); comment-active colours pixel-identical before/after
- [ ] Every "no X happens" tick above has its positive control run in the same session (fetch-once-opened, toast-on-403, type-to-edit on bare Space)
- [ ] Each ratify item in §4 cited by owner-authored comment ID in the PR body; no item satisfied by a lock-text edit alone