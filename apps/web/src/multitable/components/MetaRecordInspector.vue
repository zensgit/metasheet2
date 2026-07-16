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
-->
<template>
  <div v-if="visible" class="meta-record-drawer" @keydown="onInspectorKeydown">
    <div class="meta-record-drawer__header">
      <h3 class="meta-record-drawer__title">{{ l('record.title') }}</h3>
      <div class="meta-record-drawer__nav" v-if="recordIds.length > 1">
        <button class="meta-record-drawer__nav-btn" :disabled="currentRecordIndex <= 0" :aria-label="l('record.previous')" @click="navigatePrev">&lsaquo;</button>
        <span class="meta-record-drawer__nav-pos">{{ currentRecordIndex + 1 }} / {{ recordIds.length }}</span>
        <button class="meta-record-drawer__nav-btn" :disabled="currentRecordIndex >= recordIds.length - 1" :aria-label="l('record.next')" @click="navigateNext">&rsaquo;</button>
      </div>
      <div class="meta-record-drawer__actions">
        <MtButton
          v-if="record && canLoadSubscription"
          class="meta-record-drawer__btn meta-record-drawer__btn--watch"
          :class="{ 'meta-record-drawer__btn--watching': recordSubscribed }"
          :disabled="subscriptionLoading"
          :title="l(recordSubscribed ? 'record.unwatchTitle' : 'record.watchTitle')"
          :aria-pressed="recordSubscribed"
          @click="toggleRecordSubscription"
        >
          {{ l(recordSubscribed ? 'record.watching' : 'record.watch') }}
        </MtButton>
        <button
          v-if="resolvedCanComment"
          class="meta-record-drawer__btn meta-record-drawer__btn--comment"
          :class="drawerCommentButtonClass"
          :title="l('record.comments')"
          type="button"
          @click="emit('toggle-comments')"
        >
          <MetaCommentActionChip :label="l('record.comments')" :state="drawerCommentAffordance" />
        </button>
        <!-- W2 S4 (lock §2 评论面板 row: "MetaCommentsDrawer 的 inbox RouterLink...上移到检查器头部"):
             moved verbatim from MetaCommentsDrawer.vue's own header (same route name, same badge
             rule) -- the drawer's own copy stays too (its header is unchanged, deprecated-shell
             compat), this is a second, independent instance now living at the shell level, gated
             the same way the comment-toggle button next to it already is.
             `&& hasRouter`: this shell (unlike MetaCommentsDrawer) is mounted by several PRE-EXISTING
             frozen specs (multitable-record-drawer*.spec.ts, meta-record-drawer-*.spec.ts) with no
             vue-router plugin installed at all -- `<RouterLink>`'s own `useLink()` unconditionally
             dereferences the injected router and throws if it is absent (verified: those specs crashed
             under this exact failure before this guard was added). `useRouter()` itself never throws
             (a plain `inject()`, returns undefined when absent) so the guard is safe; `v-if` false means
             `<RouterLink>` is never even instantiated, so `useLink()` never runs. Every REAL app mount
             always has a router (this is a route-driven SPA), so this only ever changes rendering in
             router-less test harnesses -- proven working WITH a router in
             multitable-record-inspector.spec.ts's own dedicated router-mounted test. -->
        <RouterLink
          v-if="resolvedCanComment && hasRouter"
          class="meta-record-drawer__inbox-link"
          :to="{ name: 'multitable-comment-inbox' }"
        >
          {{ inboxLabel }}
          <span v-if="commentUnreadCount > 0" class="meta-record-drawer__inbox-badge">{{ commentUnreadCount }}</span>
        </RouterLink>
        <MtButton v-if="canManageAutomation" class="meta-record-drawer__btn" :title="l('record.workflowTitle')" @click="emit('open-automation')">&#x2699; {{ l('record.workflow') }}</MtButton>
        <MtButton v-if="canManageRecordPermissions" class="meta-record-drawer__btn" :title="l('record.permissionsTitle')" @click="showRecordPermissions = true">&#x1F512; {{ l('record.permissions') }}</MtButton>
        <MtButton v-if="record && canCreate" class="meta-record-drawer__btn meta-record-drawer__btn--duplicate" :title="l('record.duplicateTitle')" @click="emit('duplicate')">{{ l('record.duplicate') }}</MtButton>
        <!-- gate P2: the retained `meta-record-drawer__btn` base rule (background:#fff, later-injected,
             specificity tie) beat `.mt-button--danger`'s red background while danger's white text stayed
             → white-on-white "Delete". The danger variant must own the cascade, so the base class is
             dropped HERE ONLY; `--danger` stays as a stable spec/test anchor (its bespoke rule is gone). -->
        <MtButton v-if="resolvedCanDelete" variant="danger" class="meta-record-drawer__btn--danger" @click="emit('delete')">{{ l('record.delete') }}</MtButton>
        <button class="meta-record-drawer__close" :aria-label="l('record.close')" @click="emit('close')">&times;</button>
      </div>
    </div>
    <div v-if="record" class="meta-record-drawer__body">
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
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
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
import { MtButton } from '../ui'
import MetaCommentActionChip from './MetaCommentActionChip.vue'
import MetaRecordPermissionManager from './MetaRecordPermissionManager.vue'
import MetaRecordFieldsPanel from './MetaRecordFieldsPanel.vue'
import MetaRecordHistoryPanel from './MetaRecordHistoryPanel.vue'
import MetaCommentsPanel from './MetaCommentsPanel.vue'
import MetaRecordAttachmentsPanel from './MetaRecordAttachmentsPanel.vue'
import {
  resolveCommentAffordanceStateClass,
  resolveRecordCommentAffordance,
} from '../utils/comment-affordance'
import { useLocale } from '../../composables/useLocale'
import {
  recordLabel,
  type MetaRecordLabelKey,
} from '../utils/meta-record-labels'
import { commentLabel } from '../utils/meta-comment-labels'
import type { AiShortcutState } from '../composables/useAiShortcut'
import { resolveCanComment } from '../utils/recordDisplay'

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
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'delete'): void
  (e: 'duplicate'): void
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

function selectTab(tab: InspectorTab) {
  activeTab.value = tab
}

async function moveTabFocusTo(tab: InspectorTab) {
  activeTab.value = tab
  await nextTick()
  tabRefs.value[tab]?.focus()
}

// lock §3.3: ONE root-level keydown handler covering both tab navigation and Escape-to-close.
// Deliberately NOT split into two separate `@keydown` bindings at different tree levels (e.g. one on
// the tablist, one on the shell root): reproduced in isolation (a minimal two-listener Vue 3.5.18
// component under this exact vitest/jsdom harness) that two independently-bound `@keydown` listeners
// on ancestor/descendant elements of the SAME component intermittently fail to both fire on a single
// bubbled event -- a harness/runtime interaction, not a logic bug, but the safe fix is architectural:
// one listener, dispatching internally by `event.target`, sidesteps it entirely (verified stable
// across 100+ mount/dispatch/unmount cycles after consolidating, vs. reproducibly flaky before).
//
// Two independent concerns, dispatched by key/target:
//   1. Tab navigation (Left/Right/Home/End) -- ONLY when the event originates from within the
//      tablist (a tab button or its descendant), so arrow keys typed into an unrelated field editor
//      elsewhere in the panel are never hijacked. Left/Right move focus AND activate (automatic-
//      activation model, lock §3.3 "移焦 + 激活"); Home/End jump to first/last; wraps at the ends.
//   2. Escape -- closes the inspector (same `close` emit the header's × button already uses; lock
//      §3.3 "Esc 从 panel 回到关闭/grid"), guarded so it never fires when a descendant already
//      consumed Escape (defaultPrevented) and never inspects any other key -- mod+z / mod+y / `?`
//      are untouched here and bubble to MultitableWorkbench's own `onGlobalKeydown` unmodified.
function onInspectorKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.defaultPrevented) return
    event.preventDefault()
    emit('close')
    return
  }

  const withinTablist = (event.target as HTMLElement | null)?.closest('[role="tab"]') != null
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
.meta-record-drawer { width: 360px; border-left: 1px solid #e5e7eb; background: #fff; display: flex; flex-direction: column; overflow-y: auto; }
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
  background: var(--ms-bg-card);
  box-shadow: var(--ms-shadow-pop);
  border-radius: var(--ms-radius-lg) 0 0 var(--ms-radius-lg);
}
.meta-record-drawer__header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid #eee; }
.meta-record-drawer__title { font-size: 15px; font-weight: 600; margin: 0; }
.meta-record-drawer__actions { display: flex; gap: 8px; align-items: center; }
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
   are now <MtButton> — token-styled, no longer needs bespoke hardcoded-hex. --danger's sole sharer
   (delete) now uses MtButton's own `variant="danger"`; --watch's sole sharer (watch, non-active
   state) now uses MtButton's default ghost styling — both bespoke rules removed (orphaned, no other
   sharer). --watching stays: it is the watch toggle's ACTIVE-state visual (OD-T5a option A) — MtButton
   has no built-in pressed/active variant (adding one is a primitive-contract change, out of scope),
   so the toggle's active affordance still comes from this class, now paired with `aria-pressed`. The
   base .meta-record-drawer__btn rule above and the three --comment* rules stay untouched: the comment
   button (OD-T5b) is deliberately NOT migrated this round — it remains bespoke, styled by these rules. */
.meta-record-drawer__btn--watching { border-color: #0f766e; color: #0f766e; background: #ecfdf5; }
.meta-record-drawer__btn:disabled { opacity: 0.55; cursor: not-allowed; }
.meta-record-drawer__close { border: none; background: none; font-size: 20px; cursor: pointer; color: #999; }
.meta-record-drawer__nav { display: flex; align-items: center; gap: 4px; margin-right: auto; margin-left: 8px; }
.meta-record-drawer__nav-btn { width: 24px; height: 24px; border: 1px solid #ddd; border-radius: 3px; background: #fff; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; }
.meta-record-drawer__nav-btn:hover:not(:disabled) { background: #f5f5f5; }
.meta-record-drawer__nav-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.meta-record-drawer__nav-pos { font-size: 11px; color: #999; min-width: 36px; text-align: center; }
.meta-record-drawer__body { padding: 12px 16px; flex: 1; }
.meta-record-drawer__tabs { display: inline-flex; gap: 4px; padding: 3px; margin-bottom: 14px; border: 1px solid #e5e7eb; border-radius: 999px; background: #f8fafc; }
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
