<!--
  W2 S3 (design-lock: docs/development/multitable-w2-unified-record-inspector-design-lock-20260714.md
  §2 组件表 "壳" row, §3.3, §7 S3): the NEW right-side record inspector shell. Absorbs
  MetaRecordDrawer.vue's tablist + `activeTab` logic (pre-shell L44-61) + header actions (pre-shell
  L10-41) + lock banner (pre-shell L63-74) -- MOVED VERBATIM (byte-identical rendered output for the
  two existing tabs/actions) -- and mounts the two S1/S2-extracted panels (MetaRecordFieldsPanel,
  MetaRecordHistoryPanel) as children. MetaRecordDrawer.vue is now a DEPRECATED thin compat shell that
  delegates its entire render to this component (OD-W2-7=b, lock §6bis) -- its own props/emits stay
  the drawer's PUBLIC contract (barrel-export compat), forwarded 1:1 onto this component's identical
  prop/emit interface.

  ARIA tab pattern completion (lock §3.3 -- same honesty discipline as P2-2b's tree, see
  MetaSheetViewRail.vue's roving-tabindex comment block):
  - `div[role="tablist"]` (kept as the existing div, not a literal <ul> -- unchanged from the
    pre-shell markup) > `button[role="tab"]`, each carrying `aria-controls` -> its `[role="tabpanel"]`
    id; the tabpanel carries `aria-labelledby` back to the tab. Both ids are namespaced off `useId()`
    (same pattern as AttendanceCalendarPolicyQuickAdd.vue) so multiple inspector instances never
    collide.
  - Roving tabindex: exactly one tab carries tabindex="0" (== activeTab) at all times; the rest are
    "-1". Left/Right move focus AND activate (automatic-activation model -- this is a tablist, not a
    tree, so unlike MetaSheetViewRail's deliberate move-only deviation for its tree, activation-on-
    arrow IS the APG default here; lock §3.3: "移焦 + 激活"). Home/End jump to first/last. Wraps at
    the ends (Right past the last tab goes to the first, and vice-versa -- a common, APG-permitted
    choice for horizontal tabs).
  - NOT claimed (honesty clause, lock §3.3): no drag-reorder, no typeahead. `aria-controls` on the
    currently-INACTIVE tab points to an id not currently present in the DOM -- the v-if/v-else panel
    mount model is inherited unchanged from S1/S2 (lazy-unmount, not hide-via-CSS); this is a known,
    common tradeoff for tab widgets that lazy-render panel bodies, not a defect introduced here. The
    pairing is exact and meaningful for the ACTIVE tab, which is the one assistive tech round-trips.
  - Escape: bound at the shell root (bubble phase, not capture), closes via the SAME `close` emit the
    header's x button already uses (lock §3.3: "Esc 从 panel 回到关闭/grid"). Guarded by
    `event.defaultPrevented` so it does NOT fire when a descendant already consumed Escape for its own
    purpose (e.g. MetaRichLongTextEditor's mention-popover-dismiss / edit-cancel, which calls
    `preventDefault()` on its own `onEscape` -- confirmed by reading that handler). Only bare Escape
    (no modifier key) is handled, and no other key is inspected here at all, so mod+z / mod+y / `?`
    always bubble untouched to MultitableWorkbench's own `onGlobalKeydown` exactly as they do today --
    this component adds no listener that could intercept them (lock §3.3's non-negotiable).
  - Focus ring: `:focus-visible` + `--ms-color-primary`, following the same token convention already
    used by MetaSheetViewRail.vue (H4-2 lineage, #4281). NOT real-browser-verified in this PR --
    jsdom cannot render CSS, and real-browser verification is §8.3's remit (lands with the responsive
    S7 slice per lock §7); this is a same-token, zero-new-hex, low-risk addition, not a verified claim.

  W2 S5 (design-lock §2 附件面板 row, §7 S5): 4th tab, `MetaRecordAttachmentsPanel` -- mounted with the
  SAME `fields`/`fieldPermissions`/`attachmentSummariesByField`/`uploadFn`/`deleteAttachmentFn` props
  this shell already threads to the fields panel (S1) -- no new prop was added to this shell's OWN
  interface for S5, only a new tabpanel branch + TAB_ORDER entry (HI-1: the shell still makes no
  fetches of its own; the new panel owns its own already-sanctioned reads per its own file-header
  comment). Re-emits `patch` upward via the SAME `@patch` this shell already forwards from the fields
  panel (identical emit name/payload shape, one more source feeding the same sink).

  OD-W2-2 (context-driven default, lock §6bis): commentId deep-link -> comments tab, else fields
  (details). S4: `openComments` (a new prop) IS that live signal now -- the workbench already
  computes it (its `showComments` ref, `opts?.openComments === true`, itself set true whenever
  `applyCommentDeepLink` sees a `commentId` route param, per `resolveDeepLink`/`selectRecord`'s
  existing ordering: `selectedRecordId` and `showComments` are both written synchronously in the
  SAME workbench function call, before Vue's next render flush, so by the time this component's
  `setup()` first evaluates `resolveDefaultTab()` -- on the exact tick the shell mounts, since
  `visible`/`v-if` flips true in that same flush -- `props.openComments` already carries the final
  value for THIS mount). Reusing `openComments` (rather than threading a raw `commentId` prop down)
  avoids adding a second, redundant signal: every call site that sets `commentId` already routes
  through `applyCommentDeepLink`, which normalizes it into `openComments` (`Boolean(commentId)` is
  OR'd in) before it reaches here. A `watch` below additionally re-applies this signal on later
  true-transitions (e.g. clicking a field's comment icon, or a mention-notification click-through)
  without remounting the shell -- see `resolveDefaultTab()` and the `watch(() => props.openComments, ...)`
  call for the two halves of this.

  HI-1 (zero new data paths): this shell makes NO fetches of its own beyond what the pre-shell drawer
  already made (`apiClient.getRecordSubscriptionStatus` / `subscribeRecord` / `unsubscribeRecord`,
  moved verbatim, unchanged). The three mounted panels own their own already-sanctioned reads (lock §2
  table); this shell is pure composition (tablist + header actions + lock banner), same as the lock's
  own characterization of the shell row. S4's new comments-tab props are a straight prop/emit
  pass-through into MetaCommentsPanel — the underlying data source (`commentsState.*` +
  `selectedRecordCommentsScope`, both server G-8 gated) is unchanged from the pre-S4 second-drawer
  wiring, only its host component changed.

  W2 S7 (design-lock §3.4, §6bis OD-W2-6=(b), §7 S7): narrow-viewport (<= RAIL_NARROW_BREAKPOINT, the
  SAME single JS constant already defined in MultitableWorkbench.vue for the left rail — no second
  threshold here) overlay mode. This component gets NO new prop for it: MultitableWorkbench.vue binds
  `:class="{ 'meta-record-drawer--overlay': isInspectorOverlay }"` directly onto this component's tag,
  which Vue's standard fallthrough-attrs merges onto this template's single root element (the same
  mechanism this file already relies on for e.g. `<MtButton class="meta-record-drawer__btn...">`
  above) — the workbench alone owns the responsive STATE (isInspectorOverlay / mutual-exclusion with
  the rail drawer, OD-W2-6=b), this component only owns the CSS the class activates. See
  `.meta-record-drawer--overlay` below, which mirrors `.mt-workbench__rail--drawer`
  (MultitableWorkbench.vue) left<->right (anchored to the right edge instead of the left, rounded
  corners on the open/left edge instead of the open/right edge) — same tokens, same
  min(px, calc(100vw - 32px)) clamp idiom, no new hex.

  Resizable panel (2026-09-05, user request "拉长些" / more comfortable operation): PUSH-mode only
  (unchanged for the S7 overlay above, which keeps its own fixed `min(360px, 100vw-32px)` width -- a
  drag handle adds little value at <=768px, and the overlay's own responsive-safety width rule already
  wins by source order over the base `.meta-record-drawer` width rule this feature adds). Two pieces:
  (a) a `role="separator"` drag/keyboard splitter on the panel's LEFT edge — width persists to
  `localStorage` per viewer (corrupt/absent → DEFAULT_PANEL_WIDTH, same discipline as
  `../quickPhrases.ts`), clamped to `[360, min(720, 60vw)]` (P2 2026-09-05 follow-up: floor raised from
  320 to 360, see MIN_PANEL_WIDTH's own comment), exposed as the `--meta-record-drawer-width`
  CSS custom property on this root element; (b) an "expand" header toggle that snaps to the max and
  back to the last manually-chosen width. See `onSplitterPointerDown`/`onSplitterKeydown`/
  `toggleExpand` below for the mechanics, and the `.meta-record-drawer`/`__header`/`__body`/`__tabs`
  style comments below for the companion height-contract fix (sticky header+tabs, scrolling body) that
  motivated this slice: a long field list previously grew the WHOLE panel (title/tabs included, see
  those rules' own comments) rather than scrolling in place.

  P2/P3-A (2026-09-05 follow-up, real-browser measurements at a 1512px Chromium viewport, verifier P2/
  P3): two defects the jsdom-only test suite above could not itself catch (see the frozen file-header
  honesty caveats throughout this file) turned up once actually rendered. P2: at the then-320px
  minimum the un-wrapped 4-tab pill (355px) ran 36px past the panel's right edge, forcing a
  page-level horizontal scrollbar -- `.meta-record-drawer__tabs` now wraps (`flex-wrap: wrap`, kept
  `inline-flex` so the pill still hugs its own content at normal widths) and MIN_PANEL_WIDTH moved to
  360 (the pre-existing default, so nothing regresses for anyone who never drags the splitter). P3-A:
  the sticky tabs bar left a 12px strip of scrolled content visible above it once stuck --
  `.meta-record-drawer__body`'s top padding (which the bar, as its first child, sat 12px below) moved
  onto the bar's own `padding-top` instead, so that 12px is now inside the bar's own painted,
  sticking box. See `.meta-record-drawer__tabs`/`__tabs-bar`/`__body`'s own style comments for the
  full mechanics of each (including a real-browser-verified rejected approach for P3-A, recorded so it
  is not retried).
-->
<template>
  <div
    v-if="visible"
    class="meta-record-drawer"
    :style="{ '--meta-record-drawer-width': panelWidth + 'px' }"
    @keydown="onInspectorKeydown"
    @keyup="onInspectorKeyup"
  >
    <div class="meta-record-drawer__header">
      <!-- Record inspector v3 (2026-09-05, PR-A §1.2): Row A, a single non-wrapping toolbar. The
           only non-shrinking items are the 28px icon buttons + nav — every action that used to be
           its own labeled button (watch / comment-inbox / automation / permissions / duplicate /
           delete) now lives inside the kebab menu below, so this row can never overflow by
           construction (the design's own framing: "Header can no longer overflow"). -->
      <div class="meta-record-drawer__toolbar">
        <div class="meta-record-drawer__nav" v-if="recordIds.length > 1">
          <MtIconButton size="sm" :disabled="currentRecordIndex <= 0" :aria-label="l('record.previous')" :title="l('record.previous')" @click="navigatePrev">&lsaquo;</MtIconButton>
          <span class="meta-record-drawer__nav-pos">{{ recordPositionText }}</span>
          <MtIconButton size="sm" :disabled="currentRecordIndex >= recordIds.length - 1" :aria-label="l('record.next')" :title="l('record.next')" @click="navigateNext">&rsaquo;</MtIconButton>
        </div>
        <div class="meta-record-drawer__toolbar-spacer"></div>
        <!-- Comment-affordance lock (§4 item 8 acknowledgement): bespoke <button> + MetaCommentActionChip
             kept byte-identical (same three comment-active rules/tokens, unmoved from the kebab). Only
             the TEXT LABEL is hidden below a 480px CONTAINER width (`.meta-record-drawer__toolbar` is
             the `container-type: inline-size` ancestor, see the style block) — `aria-label` stays on the
             button unconditionally, so the affordance is never announced as unlabeled. -->
        <button
          v-if="resolvedCanComment"
          class="meta-record-drawer__btn meta-record-drawer__btn--comment"
          :class="drawerCommentButtonClass"
          :aria-label="l('record.comments')"
          :title="l('record.comments')"
          type="button"
          @click="emit('toggle-comments')"
        >
          <MetaCommentActionChip :label="l('record.comments')" :state="drawerCommentAffordance" />
        </button>
        <!-- Copy-link icon: PR-A scope is the button + `copy-link` emit only (§3 PR-A file line);
             the clipboard write, the disabled-when-absent gate, and the copied/failed live region
             are PR-B1 (§3 PR-B1 WB line names the copy-link handler) — WB has no listener for this
             emit yet, by design, until that slice lands. -->
        <MtIconButton size="sm" :aria-label="l('record.copyLink')" :title="l('record.copyLink')" data-testid="record-inspector-copy-link" @click="emit('copy-link')">&#x1F517;</MtIconButton>
        <button
          type="button"
          class="meta-record-drawer__btn meta-record-drawer__expand"
          :class="{ 'meta-record-drawer__expand--active': isExpanded }"
          :aria-pressed="isExpanded"
          :aria-label="l(isExpanded ? 'record.collapse' : 'record.expand')"
          :title="l(isExpanded ? 'record.collapse' : 'record.expand')"
          data-testid="record-inspector-expand-toggle"
          @click="toggleExpand"
        >{{ isExpanded ? '⤡' : '⤢' }}</button>
        <!-- Kebab menu (§1.2): watch / comment-inbox / automation / permissions / duplicate / delete —
             every existing v-if/emit/handler preserved verbatim, just re-hosted. `MtMenu` roving +
             Escape-refocus is an additive kit change (§4 item 10); `MtMenuItem` passes `role`/
             `aria-checked` through via normal Vue attrs fallthrough (verified: its root is a native
             `<button>` with no `inheritAttrs: false`, so a fallthrough `role` OVERRIDES its own
             template-declared `role="menuitem"` — no MtMenuItem/kit change needed for the watch row's
             `menuitemcheckbox`; the bespoke MetaRecordActionMenu.vue fallback named in the design was
             not needed). -->
        <MtMenu ref="kebabMenuRef" placement="bottom-end">
          <template #trigger="{ open }">
            <MtIconButton
              size="sm"
              aria-haspopup="menu"
              :aria-expanded="open"
              data-testid="record-inspector-menu"
              :aria-label="l('record.moreActions')"
              :title="l('record.moreActions')"
            >&#x22EF;</MtIconButton>
          </template>
          <MtMenuItem
            v-if="record && canLoadSubscription"
            class="meta-record-drawer__btn meta-record-drawer__btn--watch"
            :class="{ 'meta-record-drawer__btn--watching': recordSubscribed }"
            role="menuitemcheckbox"
            :aria-checked="recordSubscribed"
            :disabled="subscriptionLoading"
            :title="l(recordSubscribed ? 'record.unwatchTitle' : 'record.watchTitle')"
            @select="toggleRecordSubscription"
          >{{ l(recordSubscribed ? 'record.watching' : 'record.watch') }}</MtMenuItem>
          <!-- W2 S4 (lock §2 评论面板 row): moved verbatim from MetaCommentsDrawer.vue's own header
               (same route name, same badge rule) into the kebab (PR-A re-host). `&& hasRouter`: see
               this component's own file-header comment on router-less test harnesses. -->
          <RouterLink
            v-if="resolvedCanComment && hasRouter"
            class="meta-record-drawer__inbox-link"
            role="menuitem"
            :to="{ name: 'multitable-comment-inbox' }"
          >
            {{ inboxLabel }}
            <span v-if="commentUnreadCount > 0" class="meta-record-drawer__inbox-badge">{{ commentUnreadCount }}</span>
          </RouterLink>
          <MtMenuItem v-if="canManageAutomation" class="meta-record-drawer__btn" :title="l('record.workflowTitle')" @select="emit('open-automation')">&#x2699; {{ l('record.workflow') }}</MtMenuItem>
          <MtMenuItem v-if="canManageRecordPermissions" class="meta-record-drawer__btn" :title="l('record.permissionsTitle')" @select="showRecordPermissions = true">&#x1F512; {{ l('record.permissions') }}</MtMenuItem>
          <MtMenuItem v-if="record && canCreate" class="meta-record-drawer__btn meta-record-drawer__btn--duplicate" :title="l('record.duplicateTitle')" @select="emit('duplicate')">{{ l('record.duplicate') }}</MtMenuItem>
          <!-- gate P2 (kept verbatim): the danger class anchor stays a stable spec/test anchor even
               though the bespoke `--danger` background rule it once fought is gone in this MtMenuItem
               host — see this class's own style rule below for the current (menu-row) styling. -->
          <hr v-if="resolvedCanDelete" class="meta-record-drawer__menu-separator" />
          <MtMenuItem v-if="resolvedCanDelete" class="meta-record-drawer__btn--danger" @select="emit('delete')">{{ l('record.delete') }}</MtMenuItem>
        </MtMenu>
        <button class="meta-record-drawer__close" :aria-label="l('record.close')" @click="emit('close')">&times;</button>
      </div>
      <!-- Row B: title block. Eyebrow renders the SAME `record.title` key the pre-PR-A `<h3>` used
           (keeps `meta-record-drawer-i18n.spec.ts`'s text pins honest with no visually-hidden trick,
           graft from P3 §2) — primary-field value sits below it, editable when the primary field is
           an editable `string`. -->
      <div class="meta-record-drawer__titleblock">
        <p class="meta-record-drawer__eyebrow">{{ l('record.title') }}</p>
        <input
          v-if="canEditPrimaryTitle"
          ref="titleInputRef"
          class="meta-record-drawer__title-input"
          type="text"
          :value="primaryFieldTextValue"
          :aria-label="l('record.titleFieldAria')"
          @change="onTitleChange"
          @keydown.enter.prevent="onTitleEnter"
          @keydown.esc.prevent="onTitleEscape"
        />
        <div v-else ref="titleTextRef" class="meta-record-drawer__title-text" tabindex="-1">{{ primaryFieldDisplayText }}</div>
      </div>
    </div>
    <div
      v-if="record"
      class="meta-record-drawer__body"
      :style="tabsBarHeight > 0 ? { '--meta-record-tabs-bar-height': tabsBarHeight + 'px' } : undefined"
    >
      <!-- Resizable panel (2026-09-05): `.meta-record-drawer__tabs` is `inline-flex` (sized to its own
           pill content, well under the panel's full width) -- making IT ALONE sticky would only mask
           scrolled content directly behind the pill, leaving scrolled field rows visible in the empty
           strip to its right. This wrapper carries the sticky positioning + a FULL-WIDTH opaque
           background instead (see its own style comment below); the inner div is unchanged (still the
           `role="tablist"`, still the pill visual).
           P3-2: also bound to `setTabsBarRef` (a function ref, not a plain template ref + `watch`) so a
           ResizeObserver can (dis)connect exactly as this element mounts/unmounts under the `v-if`
           above -- see that function's own comment. NIT-A (2026-09-05 follow-up): this inline arrow
           wrapper is UNCHANGED (kept, not hoisted into a stable top-level reference) -- an earlier
           draft of this fix tried stabilizing the binding instead (`:ref="setTabsBarRef"` directly),
           reasoning that Vue's compiler would then treat this vnode as static/hoistable and skip
           re-invoking the ref on updates entirely. That reasoning was correct as far as it went (a
           stable-identifier ref IS hoisted, and does stop being re-invoked after mount), but it made
           `setTabsBarRef`'s own identity check unreachable/untestable, and is a bigger, less targeted
           deviation from the element's existing `setTabRef`-idiom siblings (see the tab buttons' own
           `:ref` just below) than the bug actually needs -- reverted in favor of the smaller fix: keep
           the inline wrapper, and make `setTabsBarRef` itself cheap to call repeatedly. See that
           function's own comment for the measured call pattern this wrapper produces (called on every
           re-render with the SAME element, not interleaved with a `null` call as originally assumed --
           verified by direct instrumentation, not by reasoning from Vue's ref-patching source alone). -->
      <div class="meta-record-drawer__tabs-bar" :ref="(el) => setTabsBarRef(el as HTMLElement | null)">
        <div class="meta-record-drawer__tabs" role="tablist" :aria-label="l('record.tabsAria')">
          <button
            v-for="tab in tabDescriptors"
            :key="tab.id"
            :ref="(el) => setTabRef(tab.id, el as HTMLButtonElement | null)"
            :id="tabButtonId(tab.id)"
            class="meta-record-drawer__tab"
            :class="{ 'meta-record-drawer__tab--active': activeTab === tab.id }"
            type="button"
            role="tab"
            :aria-selected="activeTab === tab.id"
            :aria-controls="tabPanelId(tab.id)"
            :tabindex="activeTab === tab.id ? 0 : -1"
            @click="selectTab(tab.id)"
          >{{ tab.label }}</button>
        </div>
      </div>
      <div v-if="subscriptionError" class="meta-record-drawer__watch-error">{{ subscriptionError }}</div>
      <div v-if="record?.locked" class="meta-record-drawer__lock-banner" data-test="record-lock-banner">
        <span class="meta-record-drawer__lock-icon" aria-hidden="true">&#x1F512;</span>
        <span class="meta-record-drawer__lock-status">{{ l('record.locked') }}</span>
        <span v-if="record.lockedBy" class="meta-record-drawer__lock-meta">{{ l('record.lockedBy') }}: {{ record.lockedBy }}</span>
        <span v-if="record.lockedAt" class="meta-record-drawer__lock-meta">{{ l('record.lockedAt') }}: {{ record.lockedAt }}</span>
        <MtButton
          v-if="record.canUnlock"
          class="meta-record-drawer__btn meta-record-drawer__lock-unlock"
          data-test="record-unlock-action"
          @click="emit('toggle-lock', { recordId: record.id, locked: false })"
        >{{ l('record.unlock') }}</MtButton>
      </div>
      <div
        v-if="activeTab === 'details'"
        :id="tabPanelId('details')"
        role="tabpanel"
        :aria-labelledby="tabButtonId('details')"
        tabindex="0"
        class="meta-record-drawer__tabpanel"
      >
        <MetaRecordFieldsPanel
          :record="record"
          :fields="fields"
          :can-edit="canEdit"
          :can-comment="canComment"
          :field-permissions="fieldPermissions"
          :row-actions="rowActions"
          :comment-presence="commentPresence"
          :link-summaries-by-field="linkSummariesByField"
          :person-summaries-by-field="personSummariesByField"
          :attachment-summaries-by-field="attachmentSummariesByField"
          :upload-fn="uploadFn"
          :delete-attachment-fn="deleteAttachmentFn"
          :ai-shortcut="aiShortcut"
          :button-run-pending="buttonRunPending"
          :mention-suggestions="mentionSuggestions"
          @patch="(fieldId, value) => emit('patch', fieldId, value)"
          @ai-preview="(field) => emit('ai-preview', field)"
          @ai-run="(field) => emit('ai-run', field)"
          @comment-field="(field) => emit('comment-field', field)"
          @open-link-picker="(field) => emit('open-link-picker', field)"
          @open-person-picker="(field) => emit('open-person-picker', field)"
          @run-button="(payload) => emit('run-button', payload)"
        />
        <!-- 数据来源 / Provenance: read-only row lineage for integration-fed sheets. Self-gating —
             it renders nothing unless the actor passes the integration read gate AND the sheet
             carries a readable provenance key column, and it fetches only on first expand (no new
             request on the record-open critical path). See the component's file header. -->
        <MetaRecordProvenancePanel
          :record="record"
          :fields="fields"
          :field-permissions="fieldPermissions"
        />
      </div>
      <div
        v-else-if="activeTab === 'history'"
        :id="tabPanelId('history')"
        role="tabpanel"
        :aria-labelledby="tabButtonId('history')"
        tabindex="0"
        class="meta-record-drawer__tabpanel"
      >
        <MetaRecordHistoryPanel
          :record="record"
          :fields="fields"
          :can-edit="canEdit"
          :row-actions="rowActions"
          :link-summaries-by-field="linkSummariesByField"
          :person-summaries-by-field="personSummariesByField"
          :attachment-summaries-by-field="attachmentSummariesByField"
          :sheet-id="sheetId"
          :api-client="apiClient"
          @restore="(payload) => emit('restore', payload)"
        />
      </div>
      <div
        v-else-if="activeTab === 'comments'"
        :id="tabPanelId('comments')"
        role="tabpanel"
        :aria-labelledby="tabButtonId('comments')"
        tabindex="0"
        class="meta-record-drawer__tabpanel"
      >
        <MetaCommentsPanel
          :comments="comments"
          :loading="commentsLoading"
          :can-comment="canComment"
          :can-resolve="canResolveComments"
          :draft="commentDraft"
          :highlighted-comment-id="highlightedCommentId"
          :target-field-id="commentTargetFieldId"
          :scope-label="commentsScopeLabel"
          :reply-to-comment-id="commentReplyToId"
          :editing-comment-id="commentEditingId"
          :submitting="commentSubmitting"
          :error="commentsError"
          :resolving-ids="commentResolvingIds"
          :updating-ids="commentUpdatingIds"
          :deleting-ids="commentDeletingIds"
          :reacting-keys="commentReactingKeys"
          :current-user-id="currentUserId"
          :mention-suggestions="mentionSuggestions"
          :composer-initial-mentions="commentComposerInitialMentions"
          @submit="(payload: { content: string; mentions: string[] }) => emit('comment-submit', payload)"
          @resolve="(commentId: string) => emit('comment-resolve', commentId)"
          @reply="(commentId: string) => emit('comment-reply', commentId)"
          @edit="(commentId: string) => emit('comment-edit', commentId)"
          @delete="(commentId: string) => emit('comment-delete', commentId)"
          @cancel-reply="emit('comment-cancel-reply')"
          @cancel-edit="emit('comment-cancel-edit')"
          @update:draft="(value: string) => emit('update:comment-draft', value)"
          @retry="emit('comment-retry')"
          @react="(commentId: string, emoji: string) => emit('comment-react', commentId, emoji)"
          @unreact="(commentId: string, emoji: string) => emit('comment-unreact', commentId, emoji)"
        />
      </div>
      <div
        v-else
        :id="tabPanelId('attachments')"
        role="tabpanel"
        :aria-labelledby="tabButtonId('attachments')"
        tabindex="0"
        class="meta-record-drawer__tabpanel"
      >
        <MetaRecordAttachmentsPanel
          :record="record"
          :fields="fields"
          :can-edit="canEdit"
          :field-permissions="fieldPermissions"
          :row-actions="rowActions"
          :attachment-summaries-by-field="attachmentSummariesByField"
          :upload-fn="uploadFn"
          :delete-attachment-fn="deleteAttachmentFn"
          @patch="(fieldId, value) => emit('patch', fieldId, value)"
        />
      </div>
    </div>
    <div v-else class="meta-record-drawer__empty">{{ l('record.noRecord') }}</div>
    <MetaRecordPermissionManager
      v-if="canManageRecordPermissions && record && sheetId && apiClient"
      :visible="showRecordPermissions"
      :sheet-id="sheetId"
      :record-id="record.id"
      :client="apiClient"
      @close="showRecordPermissions = false"
      @updated="emit('navigate', record!.id)"
    />
    <!-- Record inspector v3 (2026-09-05, PR-A §1.2): moved from the FIRST child (pre-PR-A) to the
         LAST — absolute positioning (unchanged, see this element's own style rule) keeps it
         visually pinned to the panel's left edge either way, but DOM order also drives Tab order,
         and a splitter reachable BEFORE any header control was a confusing first stop. Splitter
         keydown/pointerdown handling is unchanged (still dispatched from `onInspectorKeydown` by
         target — see that function's own comment for why). -->
    <div
      class="meta-record-drawer__splitter"
      role="separator"
      aria-orientation="vertical"
      :aria-valuenow="Math.round(panelWidth)"
      :aria-valuemin="MIN_PANEL_WIDTH"
      :aria-valuemax="Math.round(maxPanelWidth)"
      :aria-label="l('record.resizeHandle')"
      tabindex="0"
      data-testid="record-inspector-splitter"
      @pointerdown="onSplitterPointerDown"
    ></div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import type {
  LinkedRecordSummary,
  PersonSummary,
  MetaAttachment,
  MetaAttachmentDeleteFn,
  MetaAttachmentUploadFn,
  MetaCommentMentionSuggestion,
  MultitableComment,
  MultitableCommentPresenceSummary,
  MetaFieldPermission,
  MetaField,
  MetaRecord,
  MetaRecordSubscriptionStatus,
  MetaRowActions,
} from '../types'
import type { MultitableApiClient } from '../api/client'
import { MtButton, MtIconButton, MtMenu, MtMenuItem } from '../ui'
import MetaCommentActionChip from './MetaCommentActionChip.vue'
import MetaRecordPermissionManager from './MetaRecordPermissionManager.vue'
import MetaRecordFieldsPanel from './MetaRecordFieldsPanel.vue'
import MetaRecordProvenancePanel from './MetaRecordProvenancePanel.vue'
import MetaRecordHistoryPanel from './MetaRecordHistoryPanel.vue'
// S3a: MetaCommentsPanel's real implementation now lives in shared/comments/components/ —
// imported directly here rather than through the old-path re-export shim.
import MetaCommentsPanel from '../../shared/comments/components/MetaCommentsPanel.vue'
import MetaRecordAttachmentsPanel from './MetaRecordAttachmentsPanel.vue'
import {
  resolveCommentAffordanceStateClass,
  resolveRecordCommentAffordance,
} from '../utils/comment-affordance'
import { useLocale } from '../../composables/useLocale'
import {
  recordLabel,
  recordPosition,
  type MetaRecordLabelKey,
} from '../utils/meta-record-labels'
import { commentLabel } from '../utils/meta-comment-labels'
import type { AiShortcutState } from '../composables/useAiShortcut'
import { formatRecordFieldValue, resolveCanComment, resolvePrimaryField, textControlValue } from '../utils/recordDisplay'
import { isFieldAlwaysReadOnly } from '../utils/field-permissions'
import { isSystemField } from '../utils/system-fields'

const props = withDefaults(defineProps<{
  visible: boolean
  record?: MetaRecord | null
  fields: MetaField[]
  canEdit: boolean
  canComment: boolean
  canDelete: boolean
  // Duplicate / clone record (design 2026-06-16): sheet-level canCreateRecord (a duplicate is a create).
  // Gates the drawer's Duplicate button; the server re-enforces it (no FE permission mirror).
  canCreate?: boolean
  canManageAutomation?: boolean
  fieldPermissions?: Record<string, MetaFieldPermission> | null
  rowActions?: MetaRowActions | null
  commentPresence?: MultitableCommentPresenceSummary | null
  linkSummariesByField?: Record<string, LinkedRecordSummary[]>
  personSummariesByField?: Record<string, PersonSummary[]>
  attachmentSummariesByField?: Record<string, MetaAttachment[]>
  recordIds?: string[]
  uploadFn?: MetaAttachmentUploadFn
  deleteAttachmentFn?: MetaAttachmentDeleteFn
  canManageRecordPermissions?: boolean
  sheetId?: string
  apiClient?: MultitableApiClient
  /** A3: shared AI shortcut UI state from the workbench useAiShortcut instance. */
  aiShortcut?: AiShortcutState | null
  /** B1-e: in-flight button runs keyed `${recordId}:${fieldId}` — the SAME ref
   *  the grid (MetaGridTable) receives, so a run from either surface disables
   *  the button on both. Matches the workbench `onRunButton` pending-key format. */
  buttonRunPending?: string[]
  /** B5: people-mention candidates for rich-`longText` field editing in the drawer.
   *  Fed by the workbench's already-loaded commentMentionSuggestions (no re-fetch). Also now the
   *  comments tab's own mention-suggestion source (W2 S4) -- same underlying
   *  `commentMentionSuggestions` ref the workbench already threads in for the fields panel, no
   *  second copy. */
  mentionSuggestions?: MetaCommentMentionSuggestion[]
  // --- W2 S4 (design-lock §2 评论面板 row, §7 S4): comments-tab pass-through props. All sourced
  // from the workbench's existing `commentsState` (useMultitableComments) + `selectedRecordCommentsScope`
  // (server G-8 gated) -- the SAME data the pre-S4 second `<MetaCommentsDrawer>` consumed; only the
  // host component changed (HI-1, zero new data paths). Named with a `comment(s)` prefix throughout
  // to keep them visually grouped and to avoid any ambiguity with this shell's OWN unrelated props
  // (e.g. `canComment`/`currentUserId` are reused as-is since there's no such ambiguity for those two). */
  comments?: MultitableComment[]
  commentsLoading?: boolean
  canResolveComments?: boolean
  commentDraft?: string
  highlightedCommentId?: string | null
  commentTargetFieldId?: string | null
  commentsScopeLabel?: string | null
  commentReplyToId?: string | null
  commentEditingId?: string | null
  commentUnreadCount?: number
  commentSubmitting?: boolean
  commentsError?: string | null
  commentResolvingIds?: string[]
  commentUpdatingIds?: string[]
  commentDeletingIds?: string[]
  commentReactingKeys?: string[]
  currentUserId?: string | null
  commentComposerInitialMentions?: MetaCommentMentionSuggestion[]
  /** OD-W2-2 (context-driven default + live re-trigger, lock §6bis / file-header comment above):
   *  the workbench's `showComments` signal, forwarded as-is. `true` on THIS component's initial
   *  mount tick selects the comments tab as the default (`resolveDefaultTab()`); any LATER
   *  true-transition while already mounted (e.g. clicking a field's comment icon, a mention
   *  notification click-through) re-selects it via the `watch` below. A later false-transition is
   *  intentionally NOT treated as "switch away from comments" -- tab selection is otherwise sticky
   *  across record navigation already (S3 behavior, unchanged), and this stays consistent with it. */
  openComments?: boolean
  /** Record inspector v3 (2026-09-05, PR-A §1.1 "captured at mount"): the element the workbench's
   *  `openRecord(id, opener)` captured as the trigger of THIS open — an explicit signature
   *  handoff so a WB-level caller (row-number icon click, Shift+Space on the grid, a context-menu
   *  item) can name its own opener precisely, rather than this component guessing from
   *  `document.activeElement` at mount (which is only reliable when nothing else moved focus
   *  between the gesture and mount — see `onMounted` below for the fallback when this prop is
   *  absent, e.g. a deep-link mount with no interactive opener at all). */
  openerEl?: HTMLElement | null
}>(), {
  recordIds: () => [],
  buttonRunPending: () => [],
  comments: () => [],
  commentsLoading: false,
  canResolveComments: false,
  commentDraft: '',
  highlightedCommentId: null,
  commentTargetFieldId: null,
  commentsScopeLabel: null,
  commentReplyToId: null,
  commentEditingId: null,
  commentUnreadCount: 0,
  commentSubmitting: false,
  commentsError: null,
  commentResolvingIds: () => [],
  commentUpdatingIds: () => [],
  commentDeletingIds: () => [],
  commentReactingKeys: () => [],
  currentUserId: null,
  commentComposerInitialMentions: () => [],
  openComments: false,
  openerEl: null,
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'delete'): void
  (e: 'duplicate'): void
  /** Record inspector v3 (2026-09-05, PR-A §1.2 Row A): copy-link icon. PR-A scope is this emit
   *  only — the clipboard write + copied/failed live-region text are PR-B1 (see the button's own
   *  template comment); WB has no listener for it yet. */
  (e: 'copy-link'): void
  (e: 'patch', fieldId: string, value: unknown): void
  (e: 'toggle-lock', payload: { recordId: string; locked: boolean }): void
  (e: 'toggle-comments'): void
  (e: 'comment-field', field: MetaField): void
  (e: 'open-automation'): void
  (e: 'open-link-picker', field: MetaField): void
  (e: 'open-person-picker', field: MetaField): void
  (e: 'navigate', recordId: string): void
  /** Slice 3: request restore of this record to a prior revision. The parent (workbench) owns
   * the apiClient.restoreRecordVersion call + confirm + record refresh — consistent with how the
   * shell emits 'patch' / 'delete' / 'toggle-lock' rather than mutating directly. */
  (e: 'restore', payload: { recordId: string; targetVersion: number; expectedVersion: number; fieldIds?: string[] }): void
  /** A3: AI shortcut triggers (workbench resolves them through useAiShortcut). */
  (e: 'ai-preview', field: MetaField): void
  (e: 'ai-run', field: MetaField): void
  /** B1-e: run a button field's configured action. Same shape the grid emits
   * (`run-button { recordId, field }`) so the workbench's existing onRunButton
   * handler — which owns the runButton call + result.status branching + the
   * shared buttonRunPending key — handles both surfaces with no extra logic. */
  (e: 'run-button', payload: { recordId: string; field: MetaField }): void
  /** W2 S4: re-emitted from MetaCommentsPanel with a `comment-` prefix -- this shell's OWN
   * `delete`/`close` already mean "delete the record" / "close the inspector", so the prefix keeps
   * the panel's same-named events (`delete`, and any future collision) from silently misrouting at
   * this boundary. Every other name/payload shape is unchanged from MetaCommentsPanel's own emits
   * (which are themselves unchanged from the pre-extraction MetaCommentsDrawer). */
  (e: 'comment-submit', payload: { content: string; mentions: string[] }): void
  (e: 'comment-resolve', commentId: string): void
  (e: 'comment-reply', commentId: string): void
  (e: 'comment-edit', commentId: string): void
  (e: 'comment-delete', commentId: string): void
  (e: 'comment-cancel-reply'): void
  (e: 'comment-cancel-edit'): void
  (e: 'update:comment-draft', value: string): void
  /** Preserved gap, not a new one: the pre-extraction MetaCommentsDrawer already emitted `retry` and
   * the workbench never bound a listener for it (verified against MultitableWorkbench.vue's pre-S4
   * `<MetaCommentsDrawer @close=... @submit=...>` binding list — no `@retry`). Forwarded here for
   * interface completeness with MetaCommentsPanel's own emit set; wiring an actual retry action is
   * out of this slice's scope (HI-1 verbatim discipline — fixing latent gaps is a separate change). */
  (e: 'comment-retry'): void
  (e: 'comment-react', commentId: string, emoji: string): void
  (e: 'comment-unreact', commentId: string, emoji: string): void
}>()

const { isZh } = useLocale()
const l = (key: MetaRecordLabelKey) => recordLabel(key, isZh.value)
const inboxLabel = computed(() => commentLabel('comment.inbox', isZh.value))
// See the inbox-link template comment above: `useRouter()` is a plain (non-throwing) `inject()`, so
// capturing it once here is safe even in the several pre-existing router-less test harnesses that
// mount this shell.
const hasRouter = !!useRouter()

const showRecordPermissions = ref(false)
const kebabMenuRef = ref<InstanceType<typeof MtMenu> | null>(null)
const titleInputRef = ref<HTMLInputElement | null>(null)
const titleTextRef = ref<HTMLDivElement | null>(null)

// --- Open/focus (2026-09-05, PR-A §1.1/§1.5) ---
// This shell mounts (`v-if="visible"`) EXACTLY when the workbench flips `inspectorOpen` true — see
// MultitableWorkbench.vue's `openRecord`/hash-watcher comments — so `onMounted` here IS "the open
// transition" the design describes, with no separate WB-side `focusTitle()` call needed: capturing
// the opener and moving focus to the title both happen exactly once per open, never on a record
// switch while already open (this component stays mounted throughout "follow while open" — only its
// `record`/tab content change, not this lifecycle hook).
let restoreFocusTarget: HTMLElement | null = null
onMounted(() => {
  // `props.openerEl` (WB's `openRecord(id, opener)`, see that prop's own doc comment) wins when
  // given; falling back to `document.activeElement` covers mounts WB doesn't drive an opener for
  // (a deep-link/comment-click-through open, or a router-less spec mounting this shell directly)
  // and also naturally captures a context-menu-item opener when WB passes none — see MtMenu's own
  // comment on the identical "capture what's focused right now" idiom for why this is reliable.
  // `document.body` (or no active element at all) means nothing was actually focused — treated the
  // SAME as "no opener" so the unmount fallback below reaches `.meta-grid`, not a no-op `body.focus()`.
  const active = document.activeElement as HTMLElement | null
  restoreFocusTarget = props.openerEl ?? (active && active !== document.body ? active : null)
  void nextTick(() => {
    ;(titleInputRef.value ?? titleTextRef.value)?.focus()
  })
})
onBeforeUnmount(() => {
  const target = restoreFocusTarget
  if (target && target.isConnected && typeof target.focus === 'function') {
    target.focus()
    return
  }
  document.querySelector<HTMLElement>('.meta-grid')?.focus()
})

// --- OD-W2-1 (tabs, lock §6bis): extensible union -- S3 shipped 'details' (fields) + 'history'
// (activity); S4 added 'comments'; S5 (this slice) adds 'attachments', the 4th and final tab per lock
// §2's information architecture (字段/动态/评论/附件). TAB_ORDER drives roving-tabindex + arrow-key nav
// generically over however many entries exist, so extending this union + TAB_ORDER is the only change
// each new tab needs to make here. The rendered LABEL TEXT for 'comments' reuses the EXISTING
// 'record.comments' key (already present in meta-record-labels.ts -- it already backs the header
// comment-toggle button's title -- so no new i18n key was needed there); 'details'/'history' stay
// 'record.details'/'record.history' (详情/历史) -- the frozen i18n baseline (meta-record-drawer-i18n.
// spec.ts) pins that exact text; 'attachments' is a genuinely NEW tab (no pre-existing drawer text to
// reuse), so S5 adds a new typed key 'record.attachments' (G-10 term 附件) to meta-record-labels.ts.
// The lock's own §0/§2 prose gloss ("字段"/"动态") names the panels' conceptual identity, not a
// mandated label-string rename for the pre-existing two.
type InspectorTab = 'details' | 'history' | 'comments' | 'attachments'
const TAB_ORDER: readonly InspectorTab[] = ['details', 'history', 'comments', 'attachments']

// OD-W2-2 (context-driven default, lock §6bis): commentId deep-link -> comments, else fields
// (details). See file-header comment above for why `props.openComments` (not a raw commentId) is
// the live signal read here.
function resolveDefaultTab(): InspectorTab {
  return props.openComments ? 'comments' : 'details'
}

const activeTab = ref<InspectorTab>(resolveDefaultTab())

// OD-W2-2, second half: re-apply the same signal on any LATER true-transition while this shell stays
// mounted across a record change (`v-if="!!selectedRecordId"` in the workbench only toggles the whole
// shell's mount when selection goes empty<->non-empty, not on every record switch — see file-header
// comment). Only the true-transition switches; see the `openComments` prop doc above for why a
// false-transition does NOT switch away from comments (tab selection is already sticky otherwise).
watch(() => props.openComments, (isOpen) => {
  if (isOpen) activeTab.value = 'comments'
})
const tabRefs = ref<Partial<Record<InspectorTab, HTMLButtonElement | null>>>({})
const inspectorId = useId()

function tabButtonId(tab: InspectorTab): string {
  return `${inspectorId}-tab-${tab}`
}
function tabPanelId(tab: InspectorTab): string {
  return `${inspectorId}-panel-${tab}`
}

function tabLabelFor(id: InspectorTab): string {
  if (id === 'details') return l('record.details')
  if (id === 'history') return l('record.history')
  if (id === 'comments') return l('record.comments')
  return l('record.attachments')
}

const tabDescriptors = computed(() => TAB_ORDER.map((id) => ({
  id,
  label: tabLabelFor(id),
})))

function setTabRef(tab: InspectorTab, el: HTMLButtonElement | null) {
  tabRefs.value[tab] = el
}

// §3.3 tab-switch focus (2026-09-05, PR-A §1.5; W2 lock §3.3, unimplemented until now): pointer
// activation moves focus INTO the new tabpanel's first focusable control (else the panel itself,
// which already carries `tabindex="0"` — see the panel div's own template attribute, unchanged);
// arrow activation (`moveTabFocusTo` below) keeps focus ON the tab, per APG.
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
function focusFirstInPanel(tab: InspectorTab) {
  const panel = document.getElementById(tabPanelId(tab))
  if (!panel) return
  const first = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
  ;(first ?? panel).focus()
}

async function selectTab(tab: InspectorTab) {
  activeTab.value = tab
  await nextTick()
  focusFirstInPanel(tab)
}

async function moveTabFocusTo(tab: InspectorTab) {
  activeTab.value = tab
  await nextTick()
  tabRefs.value[tab]?.focus()
}

// lock §3.3: ONE root-level keydown handler covering tab navigation, Escape-to-close, AND (2026-09-05
// addition) the resize splitter below -- deliberately NOT split into separate `@keydown` bindings at
// different tree levels (e.g. one on the tablist, one on the splitter, one on the shell root):
// reproduced in isolation (a minimal two-listener Vue 3.5.18 component under this exact vitest/jsdom
// harness) that two independently-bound `@keydown` listeners on ancestor/descendant elements of the
// SAME component intermittently fail to both fire on a single bubbled event -- a harness/runtime
// interaction, not a logic bug, but the safe fix is architectural: one listener, dispatching
// internally by `event.target`, sidesteps it entirely (verified stable across 100+ mount/dispatch/
// unmount cycles after consolidating, vs. reproducibly flaky before). The splitter's own keydown
// handling was ORIGINALLY a second `@keydown` binding on the splitter element itself -- reproducibly
// flaky under this same harness/runtime interaction for the exact reason above (an Escape dispatched
// on the splitter intermittently never reached this root handler) -- so it was folded into this single
// dispatcher instead, the same fix already applied here for the tablist.
//
// Three independent concerns, dispatched by key/target:
//   1. Tab navigation (Left/Right/Home/End) -- ONLY when the event originates from within the
//      tablist (a tab button or its descendant), so arrow keys typed into an unrelated field editor
//      elsewhere in the panel are never hijacked. Left/Right move focus AND activate (automatic-
//      activation model, lock §3.3 "移焦 + 激活"); Home/End jump to first/last; wraps at the ends.
//   2. Resize (Left/Right/Home/End) -- ONLY when the event originates from the splitter
//      (`role="separator"`) itself; see `onSplitterKeydown` below for the ±16px step / min-max clamp.
//      Mutually exclusive with #1 by construction (the splitter is not `[role="tab"]` and a tab is
//      never `[role="separator"]`), so there is no ordering ambiguity between the two branches.
//   3. Escape -- closes the inspector (same `close` emit the header's × button already uses; lock
//      §3.3 "Esc 从 panel 回到关闭/grid"), guarded so it never fires when a descendant already
//      consumed Escape (defaultPrevented) and never inspects any other key -- mod+z / mod+y / `?`
//      are untouched here and bubble to MultitableWorkbench's own `onGlobalKeydown` unmodified.
// Record inspector v3 (2026-09-05, PR-A §1.5): dispatch order is (1) Escape, (2) splitter, (3)
// prev/next chord, (4) tablist — the design's own numbering. Escape's own first clause (kebab open
// → close the menu, not the panel) is the one addition to an otherwise-unchanged clause; see
// `kebabMenuRef`'s own template comment for why this is a defensive top-of-branch check rather than
// the primary mechanism (MtMenu's own internal Escape handling — see that file's comment — is what
// actually fires for the common case, since its open content is Teleported to `document.body` and
// never reaches this listener via bubbling at all).
function onInspectorKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    if (kebabMenuRef.value?.isOpen) {
      event.preventDefault()
      kebabMenuRef.value.close()
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.defaultPrevented) return
    event.preventDefault()
    emit('close')
    return
  }

  const target = event.target as HTMLElement | null
  if (target?.closest('[role="separator"]') != null) {
    onSplitterKeydown(event)
    return
  }

  // Prev/next chord (graft from P2, §1.5/§2): `(meta|ctrl)+shift` + `event.code === 'Comma'|'Period'`
  // — `event.code` (the physical key), not `event.key` (which shift already remaps to `<`/`>` on a
  // US layout), and layout-independent; works with the caret inside a text control since it never
  // collides with a printable character or a native caret-movement chord. Alt+Arrow was rejected
  // (macOS Option+Arrow has caret/word-jump semantics); `j`/`k` was rejected (IME hazard, no
  // `isComposing` handling exists in this file or the workbench).
  const mod = event.metaKey || event.ctrlKey
  if (mod && event.shiftKey && (event.code === 'Comma' || event.code === 'Period')) {
    event.preventDefault()
    if (event.code === 'Comma') navigatePrev()
    else navigateNext()
    return
  }

  const withinTablist = target?.closest('[role="tab"]') != null
  if (!withinTablist) return
  const idx = TAB_ORDER.indexOf(activeTab.value)
  if (idx < 0) return
  switch (event.key) {
    case 'ArrowRight':
      event.preventDefault()
      void moveTabFocusTo(TAB_ORDER[(idx + 1) % TAB_ORDER.length])
      break
    case 'ArrowLeft':
      event.preventDefault()
      void moveTabFocusTo(TAB_ORDER[(idx - 1 + TAB_ORDER.length) % TAB_ORDER.length])
      break
    case 'Home':
      event.preventDefault()
      void moveTabFocusTo(TAB_ORDER[0])
      break
    case 'End':
      event.preventDefault()
      void moveTabFocusTo(TAB_ORDER[TAB_ORDER.length - 1])
      break
    default:
      break
  }
}

// --- Resizable panel (2026-09-05, user request "拉长些" / more comfortable operation): a drag- and
// keyboard-resizable width, persisted per viewer, plus an expand-to-max toggle. Independent of the
// tab/keydown machinery above -- the splitter is `role="separator"`, not `[role="tab"]`, so
// `onInspectorKeydown`'s tablist-scoped arrow handling never sees these keys (see that function's
// `withinTablist` guard, which returns early for any target outside `[role="tab"]`); Escape typed
// while the splitter has focus still bubbles to that SAME root handler and closes the inspector like
// everywhere else in the panel -- no `.stop` here, so that stays unchanged.
// P2 (2026-09-05, real-browser follow-up, verifier P2): at the OLD 320px minimum the 4-tab pill
// (355px, un-wrapped) ran 36px past the panel's right edge and forced a page-level horizontal
// scrollbar -- a genuine overflow, not merely a real-browser-verification gap like this file's other
// jsdom-can't-render-CSS caveats. Wrapping the pill (`.meta-record-drawer__tabs`'s own `flex-wrap:
// wrap` below) fixes the overflow at any width, but 320px was ALSO simply too narrow for this panel's
// header actions (watch/comment/workflow/permissions/duplicate/delete/expand/close, up to 8 buttons)
// to read comfortably even wrapped onto two rows. Raising the floor to 360px -- the pre-existing
// DEFAULT_PANEL_WIDTH, not a new number -- means the shipped default already sat exactly at the new
// minimum: nobody who never touches the splitter loses anything, and the ARIA `aria-valuemin` / the
// Home key's jump-to-minimum both move to this same value with no separate behavior to add.
const MIN_PANEL_WIDTH = 360
const MAX_PANEL_WIDTH_CAP = 720
const DEFAULT_PANEL_WIDTH = 360
const PANEL_WIDTH_STORAGE_KEY = 'metasheet2:record-inspector-width'
const PANEL_WIDTH_STEP = 16

// Viewport-tracked (not a one-time read) so the `min(720px, 60vw)` cap -- and thus Home/End,
// pointer-drag clamping, and the expand target -- stays correct across a live window resize, mirroring
// MultitableWorkbench.vue's own `isRailNarrow`/`syncRailViewportState` resize-listener convention
// (same file-header comment lineage, S7 above) rather than inventing a second idiom for this file.
const viewportWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1280)
function syncViewportWidth() {
  viewportWidth.value = window.innerWidth
}
const maxPanelWidth = computed(() => Math.min(MAX_PANEL_WIDTH_CAP, viewportWidth.value * 0.6))

function clampPanelWidth(width: number): number {
  return Math.max(MIN_PANEL_WIDTH, Math.min(maxPanelWidth.value, width))
}

// Per-viewer (browser localStorage, no userId scoping -- unlike quickPhrases.ts's per-user keys, a
// panel width is a device/browser preference, not an identity-scoped one), corrupt-safe: an absent,
// non-numeric, non-finite, or non-positive stored value falls back to DEFAULT_PANEL_WIDTH; a numeric
// value outside the CURRENT [min, max] range (e.g. saved on a wider screen, restored on a narrower
// one) is clamped rather than discarded.
function readStoredPanelWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_PANEL_WIDTH
  try {
    const raw = window.localStorage?.getItem(PANEL_WIDTH_STORAGE_KEY)
    if (!raw) return DEFAULT_PANEL_WIDTH
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PANEL_WIDTH
    return clampPanelWidth(parsed)
  } catch {
    return DEFAULT_PANEL_WIDTH
  }
}

function persistPanelWidth(width: number) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage?.setItem(PANEL_WIDTH_STORAGE_KEY, String(Math.round(width)))
  } catch {
    // Quota/serialization failures must never block resizing itself -- persistence is best-effort.
  }
}

const panelWidth = ref(readStoredPanelWidth())
// The width to restore when the expand toggle is switched back off -- the most recent MANUALLY
// chosen width (drag or keyboard), not necessarily the mount-time one.
const lastChosenPanelWidth = ref(panelWidth.value)
// NIT-4: intentionally NOT persisted -- only `panelWidth` (the px number it produces) survives to
// `localStorage`. A reload always starts collapsed (this re-inits to `false`), even if the panel was
// expanded when the tab closed; the WIDTH itself is still remembered (it is exactly `maxPanelWidth` at
// the time, so a reload restores the same px value, just with the toggle showing its default
// "expand" affordance rather than "collapse"). This is a deliberate scope line for this feature, not
// an oversight -- expanded/collapsed is presentation state, not a value worth a second storage key.
const isExpanded = ref(false)

// NIT-1 (persist on release, not per pointermove/keydown): this used to be a blanket
// `watch(panelWidth, persist)`, firing a synchronous localStorage write on every intermediate value
// during a drag or a held-down arrow key. Persistence now happens ONLY at the three points a resize
// actually ends: `onUp` (pointerup/pointercancel, see `onSplitterPointerDown` below),
// `onInspectorKeyup` (keyup on the splitter, see below), and `toggleExpand` (a discrete click, already
// a single "release"). `panelWidth` itself is still written on every intermediate step
// (`applyPanelWidth` / the P3-1 watcher below) -- only the localStorage WRITE is deferred, so the
// visible width/ARIA stay perfectly live during a drag.

/** Manual resize (drag or keyboard): clamp, apply, remember for a later expand-toggle collapse, and
 *  always exit the expanded state -- a manual choice is no longer "the max" even if it happens to
 *  land exactly on it, so the toggle's own aria-pressed must not claim otherwise. Does NOT persist
 *  (NIT-1) -- called on every intermediate pointermove/keydown step of a resize gesture; the
 *  localStorage write happens once the gesture releases (`onUp`/`onInspectorKeyup` below). */
function applyPanelWidth(next: number) {
  const clamped = clampPanelWidth(next)
  panelWidth.value = clamped
  lastChosenPanelWidth.value = clamped
  isExpanded.value = false
}

// P3-1 (viewport shrink never re-clamped): `maxPanelWidth` is viewport-derived (see
// `syncViewportWidth`/`viewportWidth` below) and can DROP on a live window resize -- e.g. the user
// narrows the browser after dragging the panel wide. Without this watcher `panelWidth` stayed at
// whatever it was chosen at the wider viewport: the CSS `max-width: min(720px, 60vw)`
// belt-and-suspenders fallback on the root (see that rule's own comment) would visually clip the box,
// but the JS-tracked `panelWidth` and the ARIA trio it drives (`aria-valuenow`, the inline
// `--meta-record-drawer-width` var) stayed stale and GREATER than the new `aria-valuemax` -- an
// invalid ARIA state (valuenow > valuemax) the CSS clip alone does not fix. Writes `panelWidth`
// DIRECTLY rather than through `applyPanelWidth`: routing through it would also clear `isExpanded` and
// overwrite `lastChosenPanelWidth`, neither of which a viewport change should do. Does not persist
// (NIT-1) -- a viewport change is not a user choice.
watch(maxPanelWidth, (max) => {
  if (isExpanded.value) {
    // Expanded means "pinned to the max" by definition -- keep it pinned to the NEW max instead of
    // leaving it at the old (now out-of-range) one.
    panelWidth.value = max
    return
  }
  if (panelWidth.value > max) {
    panelWidth.value = clampPanelWidth(panelWidth.value)
  }
})

function toggleExpand() {
  if (isExpanded.value) {
    panelWidth.value = clampPanelWidth(lastChosenPanelWidth.value)
    isExpanded.value = false
  } else {
    lastChosenPanelWidth.value = panelWidth.value
    panelWidth.value = maxPanelWidth.value
    isExpanded.value = true
  }
  // NIT-1: the toggle click is itself a single, discrete "release" -- persist here directly rather
  // than relying on a per-render watcher.
  persistPanelWidth(panelWidth.value)
}

// Dispatched from `onInspectorKeydown` (the single root-level listener) by target, NOT bound directly
// on the splitter -- see that function's own file-header comment for why a second `@keydown` on a
// descendant element reproducibly drops events under this vitest/jsdom harness.
function onSplitterKeydown(event: KeyboardEvent) {
  switch (event.key) {
    // The handle sits on the panel's LEFT edge (the panel is anchored to the right of the
    // workbench): moving it further left grows the panel -- the same direction as the pointer-drag
    // handler below -- so ArrowLeft widens and ArrowRight narrows.
    case 'ArrowLeft':
      event.preventDefault()
      applyPanelWidth(panelWidth.value + PANEL_WIDTH_STEP)
      break
    case 'ArrowRight':
      event.preventDefault()
      applyPanelWidth(panelWidth.value - PANEL_WIDTH_STEP)
      break
    case 'Home':
      event.preventDefault()
      applyPanelWidth(MIN_PANEL_WIDTH)
      break
    case 'End':
      event.preventDefault()
      applyPanelWidth(maxPanelWidth.value)
      break
    default:
      break
  }
}

// Pointer Events + setPointerCapture on the HANDLE ITSELF (not `document`, unlike
// MetaFieldHeader.vue's pre-existing mousedown/mousemove/mouseup-on-document column-resize idiom):
// capture redirects every subsequent pointermove/pointerup to this exact element regardless of where
// the pointer travels, so the listeners can live (and be torn down) on the handle alone, and a
// mid-drag unmount (`visible` flipping false) simply removes the element -- and its own listeners --
// with nothing left listening on `document`.
function onSplitterPointerDown(event: PointerEvent) {
  // Primary-button guard: a touch/pen pointer has no meaningful "button" concept (`pointerType` is
  // not `'mouse'`, so this never applies to them) -- only a MOUSE pointerdown is checked, and only a
  // non-primary button (right-click == 2, middle-click == 1) is rejected. Returns before
  // `preventDefault()`/capture below, so a right-click here still opens its native context menu
  // instead of silently starting (or blocking) a drag.
  if (event.pointerType === 'mouse' && event.button !== 0) return
  // Same reason MetaFieldHeader.vue's own column-resize handler binds `@mousedown.stop.prevent`: a
  // drag without preventDefault starts a text selection across the panel (`touch-action: none` above
  // only covers touch scrolling, not selection).
  event.preventDefault()
  const startX = event.clientX
  const startWidth = panelWidth.value
  const handle = event.currentTarget as HTMLElement
  handle.setPointerCapture?.(event.pointerId)
  function onMove(moveEvent: PointerEvent) {
    applyPanelWidth(startWidth - (moveEvent.clientX - startX))
  }
  function onUp(upEvent: PointerEvent) {
    // NIT-2: `releasePointerCapture` has been observed to throw on some browser/input-device
    // combinations (it is already called defensively with `?.` above for jsdom, which has no real
    // implementation at all -- see the pointer-drag spec's own comment). Without this `finally`, a
    // throw here would skip the three `removeEventListener` calls below, leaving `onMove` (and this
    // very `onUp`) permanently attached to the handle -- a leaked listener that keeps applying every
    // later pointermove on this element forever, well past the drag that started it. `try/finally`
    // (not `try/catch`) is deliberate: any exception still propagates and is reported by the platform
    // (the standard behavior for a throw inside an event listener) -- this block's only job is to
    // guarantee cleanup runs, not to swallow the error.
    try {
      handle.releasePointerCapture?.(upEvent.pointerId)
    } finally {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      // NIT-1: persist on release (pointerup/pointercancel), not on every pointermove.
      persistPanelWidth(panelWidth.value)
    }
  }
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onUp)
  handle.addEventListener('pointercancel', onUp)
}

// NIT-1 (keyboard release): mirrors `onInspectorKeydown`'s single-root-listener dispatch discipline
// (see that function's own file-header comment for why a second, descendant-bound listener is
// unreliable under this vitest/jsdom harness) -- persists the CURRENT width once a splitter
// arrow/Home/End key is RELEASED, not on every keydown (a held-down key repeat-fires keydown many
// times before the eventual keyup, and `onSplitterKeydown` already applies each step live via
// `applyPanelWidth`; this only defers the localStorage write to the gesture's end).
//
// NIT-B (2026-09-05 follow-up): the original version fired on ANY keyup whose target sat inside the
// splitter -- including a Tab keyup, which merely MOVES focus onto/off the splitter and never calls
// `applyPanelWidth` at all. That wrote whatever `panelWidth` already happened to be to `localStorage`
// on every such Tab, a spurious write with no corresponding resize (harmless in effect, since the
// value written was unchanged, but a needless localStorage round-trip on pure focus movement, and a
// footgun for any future caller that assumes a keyup-on-splitter write implies an actual width
// change). Scoped to the same four keys `onSplitterKeydown` itself acts on.
const SPLITTER_RESIZE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End'])
function onInspectorKeyup(event: KeyboardEvent) {
  if (!SPLITTER_RESIZE_KEYS.has(event.key)) return
  const target = event.target as HTMLElement | null
  if (target?.closest('[role="separator"]') != null) {
    persistPanelWidth(panelWidth.value)
  }
}

onMounted(() => {
  window.addEventListener('resize', syncViewportWidth)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', syncViewportWidth)
})

// P3-2 (sticky tabs bar hides a focused/scrolled-into-view field): `.meta-record-drawer__tabs-bar`
// (see its own template/style comments) sits `position: sticky` above `.meta-record-drawer__body`'s
// scroll content, so a field scrolled into view via `scrollIntoView()` (browser default) or Tab-focus
// auto-scroll can land directly UNDER the bar, invisible. The fix is `scroll-padding-top` on the
// scroll container (`.meta-record-drawer__body`, below) set to the bar's own box height -- but that
// height is NOT a constant: tab labels are i18n'd (locale-dependent string length), and at the 360px
// minimum panel width (P2 2026-09-05 follow-up: was 320px) the tab pills wrap onto a second line,
// growing the bar. A single fixed px value would therefore be wrong by construction on at least some
// locale/viewport combinations, so the height is MEASURED live via ResizeObserver (the same
// guard-for-absence idiom already used by MetaChartRenderer.vue's `ensureResizeObserver`) and
// published as the `--meta-record-tabs-bar-height` custom property, consumed by
// `.meta-record-drawer__body`'s `scroll-padding-top: var(--meta-record-tabs-bar-height, 58px)`. The
// `58px` fallback (P3-A 2026-09-05 follow-up: was `48px`; the bar's own `padding-top` grew by 12px in
// that same follow-up, see its own comment) is the ONLY value exercised by this component's own jsdom
// tests (jsdom performs no layout, so ResizeObserver never fires here) -- a real-browser-measured
// single-line box height (Chromium, 1512px viewport), not an arithmetic re-derivation; the LIVE var is
// what real usage renders and is NOT behaviorally
// verified by this PR's test suite (same real-browser-verification caveat as this file's existing
// focus-ring and sticky-tabs-bar comments). Bound via a function ref (not a plain template ref + a
// `watch`) because the element is inside `v-if="record"` and needs to (dis)connect the observer
// exactly as it mounts/unmounts, not merely change value.
const tabsBarHeight = ref(0)
let tabsBarResizeObserver: ResizeObserver | null = null
// NIT-A (2026-09-05 follow-up): the template binds this via an INLINE arrow (`:ref="(el) =>
// setTabsBarRef(el as HTMLElement | null)"`, unchanged -- see that binding's own comment), which
// Vue's compiler cannot hoist into a static vnode (an inline function literal is a new value every
// render), so this function IS called again on every re-render of the component -- e.g. every
// pointermove of a drag, since each one writes `panelWidth` and re-renders for the live width/ARIA
// update. Measured directly (temporary call-counting instrumentation, not inferred from Vue's
// ref-patching source): those repeat calls all arrive with the SAME element already observed, not
// interleaved with an intermediate `null` call the way un-hoisted ref churn is sometimes assumed to
// work -- so `observedTabsBarElement` tracking WHICH element the live observer is currently attached
// to, and early-returning when a call's element already matches it, is enough on its own to turn every
// one of those repeat calls into a no-op. Before this guard existed, EVERY one of those repeat calls
// unconditionally tore down and reconstructed the ResizeObserver -- pure churn, since the target
// element never actually changes mid-drag (verified: 6 constructions across 1 mount + 5 forced
// re-renders without this guard, vs. 1 with it, in an isolated repro).
let observedTabsBarElement: HTMLElement | null = null
function setTabsBarRef(el: HTMLElement | null) {
  if (el === observedTabsBarElement) return
  tabsBarResizeObserver?.disconnect()
  tabsBarResizeObserver = null
  observedTabsBarElement = el
  if (!el || typeof ResizeObserver === 'undefined') return
  const target = el
  tabsBarResizeObserver = new ResizeObserver((entries) => {
    const entry = entries[0]
    if (!entry) return
    tabsBarHeight.value = entry.borderBoxSize?.[0]?.blockSize ?? target.offsetHeight
  })
  tabsBarResizeObserver.observe(target)
}
onBeforeUnmount(() => {
  tabsBarResizeObserver?.disconnect()
  tabsBarResizeObserver = null
})

const recordSubscribed = ref(false)
const subscriptionLoading = ref(false)
const subscriptionError = ref('')
let subscriptionRequestId = 0

watch(() => props.record, () => {
  recordSubscribed.value = false
  subscriptionError.value = ''
})

watch(
  [() => props.visible, () => props.record?.id, () => props.sheetId, () => props.apiClient],
  () => {
    if (props.visible) void loadRecordSubscription()
  },
  { immediate: true },
)

const currentRecordIndex = computed(() => {
  if (!props.record || !props.recordIds.length) return -1
  return props.recordIds.indexOf(props.record.id)
})

const canLoadSubscription = computed(() => !!props.apiClient && !!props.sheetId && !!props.record?.id)
const resolvedCanComment = computed(() => resolveCanComment(props.rowActions, props.canComment))
const resolvedCanDelete = computed(() => props.rowActions?.canDelete ?? props.canDelete)
const drawerCommentAffordance = computed(() => resolveRecordCommentAffordance(props.commentPresence))
const drawerCommentButtonClass = computed(() =>
  resolveCommentAffordanceStateClass('meta-record-drawer__btn--comment', drawerCommentAffordance.value),
)
const recordPositionText = computed(() => recordPosition(currentRecordIndex.value + 1, props.recordIds.length, isZh.value))

// --- Row B title block (2026-09-05, PR-A §1.2) ---
// `resolvePrimaryField` (utils/recordDisplay.ts) is the single hoisted definition WB's own
// `bulkFillRecordName`/`captureSelectionLabels` now also read — see that helper's own comment.
const primaryField = computed(() => resolvePrimaryField(props.fields))
// PR-A-local editability check for the title ONLY — deliberately not exported as a second
// `canEditField`: MetaRecordFieldsPanel.vue's own `canEditField` (the per-field-loop predicate,
// identical logic) is hoisted to `utils/recordDisplay.ts` in PR-B1 per the design's own file list;
// duplicating the four-clause body here (rather than pre-emptively naming a shared symbol PR-A
// does not own) avoids a second GLOBAL name that could drift from the real one before that hoist
// lands.
const canEditPrimaryTitle = computed(() => {
  const field = primaryField.value
  if (!field || field.type !== 'string') return false
  return props.canEdit
    && props.rowActions?.canEdit !== false
    && props.fieldPermissions?.[field.id]?.readOnly !== true
    && !isSystemField(field)
    && !isFieldAlwaysReadOnly(field)
})
const primaryFieldRawValue = computed(() => {
  const field = primaryField.value
  return field && props.record ? props.record.data[field.id] : undefined
})
// Uncontrolled `:value` bound straight to the prop (same idiom as MetaRecordFieldsPanel.vue's own
// string-field input) — Vue re-applies the DOM value whenever `record.data` actually changes (e.g.
// a server rejection reverting an optimistic edit), which is exactly the "re-syncs on prop change"
// behavior the design calls for, with no extra watcher needed.
const primaryFieldTextValue = computed(() => textControlValue(primaryFieldRawValue.value))
const primaryFieldDisplayText = computed(() => {
  const field = primaryField.value
  if (!field) return '—'
  return formatRecordFieldValue(field, primaryFieldRawValue.value, {
    linkSummariesByField: props.linkSummariesByField,
    personSummariesByField: props.personSummariesByField,
    attachmentSummariesByField: props.attachmentSummariesByField,
    isZh: isZh.value,
  })
})

function onTitleChange(event: Event) {
  const field = primaryField.value
  if (!field) return
  emit('patch', field.id, (event.target as HTMLInputElement).value)
}
function onTitleEnter(event: KeyboardEvent) {
  // Mirrors `flushActiveFieldEdit`'s discipline elsewhere in this line: blurring a text-like control
  // fires its native `change`, which is this input's own commit path — no second code path needed.
  ;(event.target as HTMLInputElement).blur()
}
function onTitleEscape(event: KeyboardEvent) {
  // Revert the DISPLAYED value only (no `patch` emitted) — `.prevent` (bound in the template) stops
  // this Escape from also reaching `onInspectorKeydown` (its own Escape branch already returns early
  // on `event.defaultPrevented`), so a title-edit Escape never closes the whole panel.
  const input = event.target as HTMLInputElement
  input.value = primaryFieldTextValue.value
}

function navigatePrev() {
  const idx = currentRecordIndex.value
  if (idx > 0) emit('navigate', props.recordIds[idx - 1])
}

function navigateNext() {
  const idx = currentRecordIndex.value
  if (idx >= 0 && idx < props.recordIds.length - 1) emit('navigate', props.recordIds[idx + 1])
}

function applySubscriptionStatus(status: MetaRecordSubscriptionStatus) {
  recordSubscribed.value = status.subscribed
}

async function loadRecordSubscription() {
  const apiClient = props.apiClient
  const sheetId = props.sheetId
  const recordId = props.record?.id
  if (!apiClient || !sheetId || !recordId) {
    recordSubscribed.value = false
    subscriptionLoading.value = false
    subscriptionError.value = ''
    return
  }
  const requestId = ++subscriptionRequestId
  subscriptionLoading.value = true
  subscriptionError.value = ''
  try {
    const status = await apiClient.getRecordSubscriptionStatus(sheetId, recordId)
    if (requestId !== subscriptionRequestId) return
    applySubscriptionStatus(status)
  } catch (error: any) {
    if (requestId !== subscriptionRequestId) return
    recordSubscribed.value = false
    subscriptionError.value = error?.message ?? l('record.errorWatchLoad')
  } finally {
    if (requestId === subscriptionRequestId) subscriptionLoading.value = false
  }
}

async function toggleRecordSubscription() {
  const apiClient = props.apiClient
  const sheetId = props.sheetId
  const recordId = props.record?.id
  if (!apiClient || !sheetId || !recordId || subscriptionLoading.value) return
  const requestId = ++subscriptionRequestId
  subscriptionLoading.value = true
  subscriptionError.value = ''
  try {
    const status = recordSubscribed.value
      ? await apiClient.unsubscribeRecord(sheetId, recordId)
      : await apiClient.subscribeRecord(sheetId, recordId)
    if (requestId !== subscriptionRequestId) return
    applySubscriptionStatus(status)
  } catch (error: any) {
    if (requestId !== subscriptionRequestId) return
    subscriptionError.value = error?.message ?? l('record.errorWatchUpdate')
  } finally {
    if (requestId === subscriptionRequestId) subscriptionLoading.value = false
  }
}

</script>

<style scoped>
/* Resizable panel (2026-09-05): width is driven by the `--meta-record-drawer-width` custom property
   set inline on this root element (see the component's `panelWidth` ref + `:style` binding above),
   with a matching `min`/`max` on the box itself as a CSS-only safety net -- the JS clamp in
   `clampPanelWidth` is the primary bound, this is a belt-and-suspenders fallback if the var is ever
   absent. `overflow-y: auto` moved from HERE to `.meta-record-drawer__body` below (item 1): before
   this change the ROOT scrolled as one unit once the tabpanel's content outgrew it, taking the header
   (title/actions) and the tabs with it (see the file-header CONTEXT this PR was scoped against);
   `position: relative` establishes the containing block the splitter (below) anchors to in PUSH mode
   -- `.meta-record-drawer--overlay` already sets its own `position: absolute` and wins by source
   order, so this is a no-op there. */
.meta-record-drawer {
  width: var(--meta-record-drawer-width, 360px);
  /* P2 (2026-09-05 follow-up): mirrors the JS `MIN_PANEL_WIDTH` bump (320 -> 360, see that constant's
     own comment) -- this is the belt-and-suspenders CSS fallback for the JS clamp, so the two must
     stay in lockstep. */
  min-width: 360px;
  max-width: min(720px, 60vw);
  border-left: 1px solid #e5e7eb; background: #fff; display: flex; flex-direction: column;
  position: relative;
}
/* W2 S7 (design-lock docs/development/multitable-w2-unified-record-inspector-design-lock-20260714.md
   §3.4/§6bis, OD-W2-6=(b)): narrow viewport (<= RAIL_NARROW_BREAKPOINT, the SAME single JS constant
   defined in MultitableWorkbench.vue — no second threshold here, applied via the `isInspectorOverlay`
   class binding on this component's tag, see file-header comment) turns this panel from an in-flow
   push column into a floating overlay — the mirror image of
   `.mt-workbench__rail--drawer` (MultitableWorkbench.vue's own <style scoped>, same UI-P2-2c origin):
   anchored to the RIGHT edge here instead of the left, rounded corners on the open/left edge instead
   of the open/right edge. Taking it out of flow (position:absolute) is what returns the width
   `.mt-workbench__main` lost to the push layout — no change needed to `.mt-workbench__main` itself,
   exactly as already documented for the rail. Width reuses this rule's own 360px push width via the
   SAME min(px, calc(100vw - 32px)) idiom as the rail drawer, so it never overflows a narrow viewport
   (no body horizontal scroll). `--ms-shadow-pop` / `--ms-bg-card` / `--ms-radius-lg` are the SAME
   existing UF tokens the rail drawer already uses — no new hex. */
.meta-record-drawer--overlay {
  position: absolute;
  inset: 0 0 0 auto;
  z-index: 5;
  width: min(360px, calc(100vw - 32px));
  /* Resizable panel (2026-09-05; P2 2026-09-05 follow-up bumped the referenced number 320 -> 360, see
     the base rule's own comment): the base `.meta-record-drawer` rule above also sets a push-mode
     `min-width` (now 360px, belt-and-suspenders for the JS-clamped push width). `min-width` wins over
     `width` in the cascade, so WITHOUT this override this rule's own narrow-viewport gutter
     (`calc(100vw - 32px)`, the whole reason this rule exists per the comment above) would stop
     holding below ~392px viewport width -- at 360px the 32px gutter is gone, and narrower than that
     the right-anchored panel clips off the left edge. This override's OWN value stays 320 (not
     re-derived from the push-mode minimum): it fully overrides the base rule regardless of what that
     rule sets (same specificity, later in source order always wins), so it is free to keep its own,
     independent overlay-mode safety floor for very narrow phones -- unaffected by, and not required
     to track, the push-mode splitter's minimum. Mirrors the width rule's own idiom (`min(px, calc(100vw
     - 32px))`) so min tracks width instead of fighting it. */
  min-width: min(320px, calc(100vw - 32px));
  max-width: none;
  background: var(--ms-bg-card);
  box-shadow: var(--ms-shadow-pop);
  border-radius: var(--ms-radius-lg) 0 0 var(--ms-radius-lg);
}
/* Resizable panel (2026-09-05): the splitter is still MOUNTED in overlay mode (no JS/v-if branch for
   it -- keeping the markup identical between modes is simpler and cheaper than threading overlay
   state down to gate rendering), but is visually and interactively hidden here -- the overlay rule
   above overrides `width` unconditionally, so dragging or expanding would update `panelWidth`/ARIA
   with no visible effect, which is worse than not offering the control at all at <=768px (see this
   file's own header comment: "a drag handle adds little value at <=768px"). `pointer-events: none`
   on top of `display: none` is redundant defense, not load-bearing on its own. */
.meta-record-drawer--overlay .meta-record-drawer__splitter,
.meta-record-drawer--overlay .meta-record-drawer__expand {
  display: none;
  pointer-events: none;
}
/* Item 1: this header is now the sticky region (title/actions) -- it lives OUTSIDE the scrolling
   `.meta-record-drawer__body` below (a sibling, not an ancestor), so it always stays visible without
   needing `position: sticky` of its own; `flex: 0 0 auto` just keeps it from ever being squeezed by
   `.meta-record-drawer__body`'s `flex: 1` on a very tall field list -- the body scrolls internally
   long before that could happen. */
/* Record inspector v3 (2026-09-05, PR-A §1.2): superseded the P3-3 wrap-to-fit mitigation below —
   moving every labeled action button (watch/workflow/permissions/duplicate/delete/comment-inbox)
   into the kebab menu means Row A's only remaining items are 28px icon buttons + the nav group, so
   the row CANNOT overflow at any width this panel supports (360-720px) and no longer needs to wrap.
   The header is now a two-row COLUMN: Row A (`__toolbar`) + Row B (`__titleblock`), each managing
   its own layout. */
.meta-record-drawer__header { display: flex; flex-direction: column; gap: 8px; padding: 12px 16px; border-bottom: 1px solid #eee; flex: 0 0 auto; }
/* Row A: `container-type: inline-size` makes this the query container for the comment chip's
   text-label hide below 480px (comment-affordance lock §4 item 8 — see `.meta-comment-action-chip__label`'s
   own rule below; the three comment-active rules/tokens above are untouched). `flex-wrap: nowrap` is
   the P3-3 replacement noted above — this row is built ONLY from non-shrinking 28px icon buttons plus
   the nav group, so it never needs to wrap. */
.meta-record-drawer__toolbar { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; container-type: inline-size; }
.meta-record-drawer__toolbar-spacer { flex: 1 1 auto; }
@container (width < 480px) {
  .meta-record-drawer__toolbar :deep(.meta-comment-action-chip__label) { display: none; }
}
.meta-record-drawer__titleblock { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.meta-record-drawer__eyebrow { margin: 0; font-size: 11px; line-height: 1.3; color: var(--ms-text-3, #999); text-transform: uppercase; letter-spacing: 0.02em; }
.meta-record-drawer__title-input, .meta-record-drawer__title-text {
  font-size: 18px; font-weight: 600; line-height: 1.3; min-width: 0; box-sizing: border-box;
}
.meta-record-drawer__title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 4px 0; }
.meta-record-drawer__title-input {
  width: 100%; padding: 6px 8px; border: 1px solid #e5e7eb; border-radius: 4px; background: #fff; font: inherit;
}
.meta-record-drawer__title-input:focus-visible { outline: 2px solid var(--ms-color-primary); outline-offset: -1px; }
.meta-record-drawer__menu-separator { margin: var(--ms-space-1, 4px) 0; border: none; border-top: 1px solid var(--ms-border, #e5e7eb); }
/* Resizable panel (2026-09-05): the drag/keyboard splitter on the panel's left edge (see the
   component's `onSplitterPointerDown`/`onSplitterKeydown`). Absolutely positioned against
   `.meta-record-drawer`'s own `position: relative` (added above) so it never participates in the
   header/body flex column and spans the panel's full height regardless of scroll position.
   NIT-3 (2026-09-05 follow-up): this originally straddled the edge (`left: -4px`, half in / half out)
   for an easy grab target -- but the half reaching OUTSIDE the panel (into `.mt-workbench__main`, the
   grid column to its left) sat at `z-index: 6`, ABOVE that column's own content, silently stealing a
   few px of its vertical scrollbar/edge hit area in push mode. The hit area now sits entirely
   `left: 0`, INSIDE the panel's own box, and is narrowed from 8px to 6px alongside the move so it
   still reads as a slim edge affordance rather than a thick strip now that it no longer needs to
   straddle anything. */
.meta-record-drawer__splitter {
  position: absolute; top: 0; bottom: 0; left: 0; width: 6px; cursor: col-resize; z-index: 6; touch-action: none;
}
.meta-record-drawer__splitter:hover, .meta-record-drawer__splitter:focus-visible {
  background: var(--ms-color-primary); opacity: 0.35;
}
.meta-record-drawer__splitter:focus-visible { outline: 2px solid var(--ms-color-primary); outline-offset: -2px; }
.meta-record-drawer__expand { font-size: 13px; line-height: 1; }
.meta-record-drawer__expand--active { border-color: var(--ms-color-primary); color: var(--ms-color-primary); }
.meta-record-drawer__btn { padding: 4px 10px; border: 1px solid #ddd; border-radius: 3px; background: #fff; cursor: pointer; font-size: 12px; }
.meta-record-drawer__btn--comment { border-radius: 999px; padding: 3px 8px; }
.meta-record-drawer__btn--comment.meta-record-drawer__btn--comment--active { border-color: var(--ms-color-comment-active-border); background: var(--ms-color-comment-active-bg); color: var(--ms-color-comment-active-text); }
.meta-record-drawer__btn--comment.meta-record-drawer__btn--comment--idle { border-color: #d8e1ee; background: #fff; color: #64748b; }
/* W2 S4: inbox link + badge moved verbatim (same values) from MetaCommentsDrawer.vue's own header
   (`.meta-comments-drawer__inbox-link`/`__inbox-badge`) — renamed under this shell's OWN
   `meta-record-drawer__` prefix (not reused verbatim) since it is a structurally distinct, second
   instance now living in the shell header rather than the deprecated drawer's header. */
.meta-record-drawer__inbox-link { color: #409eff; font-size: 12px; text-decoration: none; }
.meta-record-drawer__inbox-link:hover { text-decoration: underline; }
/* #2563eb == --ms-color-primary (tokens.css:19, exact) → tokenized; the badge bg #eff6ff and link #409eff
   are relocated verbatim from the deprecated drawer and have no design-system token yet (docket, not blind-mapped). */
.meta-record-drawer__inbox-badge { margin-left: 6px; padding: 2px 6px; border-radius: 999px; background: #eff6ff; color: var(--ms-color-primary); font-size: 11px; }
/* UI-P2-1c T5-safe (owner-ratified 2026-07-13): watch/workflow/permissions/duplicate/delete/unlock
   were <MtButton>, token-styled. Record inspector v3 (2026-09-05, PR-A §1.2) re-hosts watch/
   workflow/permissions/duplicate/delete inside the kebab as <MtMenuItem> rows (unlock stays on the
   lock banner, untouched, still <MtButton>) — --watching stays as the watch row's ACTIVE-state
   visual (OD-T5a option A; MtMenuItem, like MtButton before it, has no built-in pressed variant),
   now paired with `aria-checked` (menuitemcheckbox) instead of `aria-pressed`. --danger gets its OWN
   color rule below now that there is no `MtButton variant="danger"` supplying it. */
.meta-record-drawer__btn--watching { border-color: #0f766e; color: #0f766e; background: #ecfdf5; font-weight: 600; }
.meta-record-drawer__btn--danger { color: var(--ms-color-danger); }
.meta-record-drawer__btn:disabled { opacity: 0.55; cursor: not-allowed; }
.meta-record-drawer__close { border: none; background: none; font-size: 20px; cursor: pointer; color: #999; }
.meta-record-drawer__nav { display: flex; align-items: center; gap: 4px; }
.meta-record-drawer__nav-btn { width: 24px; height: 24px; border: 1px solid #ddd; border-radius: 3px; background: #fff; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; }
.meta-record-drawer__nav-btn:hover:not(:disabled) { background: #f5f5f5; }
.meta-record-drawer__nav-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.meta-record-drawer__nav-pos { font-size: 11px; color: #999; min-width: 36px; text-align: center; }
/* Item 1: the inner scroll body. `flex: 1` + `min-height: 0` is the standard flexbox fix for a
   scrolling flex child (without `min-height: 0` a flex item's automatic minimum size is its content
   size, so it would grow to fit everything instead of shrinking to the column's remaining space and
   scrolling) -- `.meta-record-drawer` (the flex column) and this rule are the two ends of that "flex
   chain". `overflow-y: auto` (moved down from the root, see that rule's own comment) is what makes a
   long field/history/comments/attachments list scroll IN PLACE instead of growing the whole panel (or
   the page) the way it did before this change.
   P3-A (2026-09-05 follow-up): `padding-top: 0` -- this used to be `12px` (the shorthand below was
   `padding: 12px 16px`, i.e. 12px on every side); see `.meta-record-drawer__tabs-bar`'s own comment
   for why that top padding, combined with the sticky bar sitting as this element's first child, left a
   12px strip of scrolled content visible above the bar once it stuck. The 12px is not gone -- it moved
   onto `.meta-record-drawer__tabs-bar`'s own `padding-top` instead, so it is now painted as part of
   the bar's opaque box (and therefore stuck, and covering, WITH it) rather than being this element's
   naked, unpainted padding sitting ABOVE the bar's sticky reach. Left/right/bottom padding (16px/16px/
   12px) are unchanged -- this only ever affected the FIRST child's leading offset, never the other
   three sides. */
/* P3-2 (sticky tabs bar hides a focused/scrolled-into-view field): `scroll-padding-top` shifts where
   the browser's native scroll-into-view (`scrollIntoView()`, Tab-focus auto-scroll) settles a target
   -- keeping it BELOW the sticky `.meta-record-drawer__tabs-bar` instead of directly under it. The
   value comes from the `--meta-record-tabs-bar-height` custom property, set on this element from the
   bar's own live-measured height (see the component's `tabsBarHeight`/`setTabsBarRef`); the `58px`
   fallback (P3-A 2026-09-05 follow-up: was `48px` -- bumped by the same 12px the bar's own padding-top
   grew by just above, and re-measured live rather than re-derived by arithmetic: 58px is the bar's
   actual live-measured single-line box height in Chromium at a 1512px viewport) only applies before
   that JS measurement lands (or in a ResizeObserver-less/jsdom environment) -- see that code's own
   comment for why a fixed value alone would be wrong here. */
.meta-record-drawer__body { padding: 0 16px 12px; flex: 1; min-height: 0; overflow-y: auto; scroll-padding-top: var(--meta-record-tabs-bar-height, 58px); }
/* `position: sticky` keeps the tab strip visible while `.meta-record-drawer__body` above scrolls
   underneath it (item 1's "…and tabs stay visible") -- `top: 0` sticks it flush against the body's own
   scrollport (its nearest scrolling ancestor). Spans the FULL scroll width (cancels the body's own
   left/right padding via a negative margin, then re-adds it as its own padding) rather than only the
   `.meta-record-drawer__tabs` pill's own (narrower) content width -- see the template comment on
   `.meta-record-drawer__tabs-bar` for why that distinction matters. NOT real-browser-verified in this
   PR (jsdom cannot render CSS, same caveat as this file's existing focus-ring comments below) --
   in particular whether the SAME opaque background needs to extend into `.meta-record-drawer__body`'s
   own `padding-top` (a few px at the very top of the scrollport) is a real-browser question this PR
   could not check; see the PR's manual-check note. */
/* P3-A (2026-09-05 follow-up, verifier P3): real-browser measurement found a ~12px strip of scrolled
   field content peeking through directly ABOVE this sticky bar once it engages -- `.meta-record-drawer
   __body`'s own top padding put this bar's natural resting position 12px down from the scrollport's
   actual top edge, but the bar's OWN box (its opaque `background: #fff`) only ever covered its own
   height, not that leading 12px gap the parent's padding created above it.
   Real-browser-verified rejected approach, recorded so it is not tried again: pulling the bar up with
   `margin-top: -12px` (compensated by an equal `padding-top: 12px` here, so total flow height and
   sibling spacing stay unchanged) was tried first and measured to have ZERO effect on the STUCK
   position in Chromium -- the 12px gap persisted identically whether scrolled or not, i.e. a negative
   top margin on a `position: sticky` element does not shift its stick threshold the way it shifts a
   plain in-flow box, at least for the first child of an `overflow: auto` container. The fix actually
   used instead: `.meta-record-drawer__body`'s OWN `padding-top` was moved to 0 (see that rule's own
   comment) and re-created HERE as this rule's `padding-top: 12px` -- with no parent top padding to
   sit below, this element's natural (unstuck) position is already flush with the scrollport's real
   top, so `top: 0` sticks it flush with no gap, in BOTH the unscrolled and the scrolled state
   (verified live: `barRect.top === bodyRect.top` at `scrollTop` 0 and 400 alike in a 1512px Chromium
   window). `padding-top: 12px` on this element (rather than 0) is what preserves the SAME 12px of
   visual clearance above the tab pill as before -- now painted as part of this element's own opaque
   background instead of being the parent's naked, unpainted padding, so it scrolls (and is covered)
   WITH the bar instead of staying behind it. See `.meta-record-drawer__body` below for the matching
   `scroll-padding-top` fallback bump (58px bar height measured live in Chromium at 1512px, see that
   rule's own comment). */
.meta-record-drawer__tabs-bar { position: sticky; top: 0; z-index: 2; margin: 0 -16px; padding: 12px 16px 14px; background: #fff; }
/* P2 (2026-09-05 follow-up, verifier P2): was `inline-flex` with no wrapping -- at the (then-320px,
   now 360px) panel minimum the 4-tab pill's un-wrapped content width (355px measured in Chromium) ran
   PAST the panel's own content box, forcing a page-level horizontal scrollbar (the pill's right edge
   sat ~36px outside the panel at 320px, and the overflow persisted even at 360px). `flex-wrap: wrap`
   lets the pill break its buttons onto a second row instead of overflowing horizontally, at ANY panel
   width down to the JS/CSS-enforced 360px minimum -- `display: inline-flex` is deliberately KEPT (not
   changed to a block-level `flex`): an inline-level flex container is still sized via shrink-to-fit
   (same algorithm as `inline-block`), so at a WIDE panel width (available space > the pill's own
   unwrapped content width) it still hugs its own content and reads as a compact rounded "pill", not a
   full-width bar -- switching to block-level `flex` would make it fill the ENTIRE available row width
   unconditionally (a `flex` container's used `width` is "fill available space" like any other block
   box), stretching the pill's background across the whole tabs-bar even at normal/wide widths, which
   is exactly the "pill look" this change is required to keep. */
.meta-record-drawer__tabs { display: inline-flex; flex-wrap: wrap; row-gap: 4px; column-gap: 4px; padding: 3px; border: 1px solid #e5e7eb; border-radius: 999px; background: #f8fafc; }
.meta-record-drawer__tab { min-width: 76px; padding: 5px 12px; border: none; border-radius: 999px; background: transparent; color: #64748b; cursor: pointer; font-size: 12px; font-weight: 600; }
.meta-record-drawer__tab--active { background: #111827; color: #fff; box-shadow: 0 2px 8px rgba(15, 23, 42, 0.16); }
/* W2 S3 (lock §3.3 focus ring convention, H4-2/#4281 lineage, same token as MetaSheetViewRail.vue).
   Not real-browser-verified in this PR — jsdom can't render CSS; §8.3 real-browser sweep lands with
   the responsive S7 slice. Zero new hex: reuses the existing --ms-color-primary token. */
.meta-record-drawer__tab:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 2px;
}
.meta-record-drawer__tabpanel:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: -2px;
}
.meta-record-drawer__watch-error { margin: -4px 0 12px; color: #b91c1c; font-size: 12px; }
.meta-record-drawer__empty { padding: 32px; text-align: center; color: #999; }
</style>
