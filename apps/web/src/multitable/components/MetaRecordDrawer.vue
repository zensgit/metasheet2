<!--
  W2 S3 (design-lock: docs/development/multitable-w2-unified-record-inspector-design-lock-20260714.md
  §7 S3, OD-W2-7=b in §6bis): DEPRECATED thin compat shell. All rendering (tablist + header actions +
  lock banner + the two S1/S2 panels + the ARIA tab-pattern completion) now lives in
  MetaRecordInspector.vue -- this component's ENTIRE template is `<MetaRecordInspector v-bind=... />`
  forwarding every emit 1:1. It is kept (not retired) because MetaRecordDrawer/MetaCommentsDrawer are
  both still barrel-exported from `apps/web/src/multitable/index.ts` and there is no audited inventory
  of out-of-repo consumers (lock §6bis Medium-4 caveat) -- retiring it is a later, consumer-audited
  major cleanup, not this slice. `MultitableWorkbench.vue` itself now renders `MetaRecordInspector`
  directly (S3 diff); this shell exists for barrel-export / external consumers only. Every existing
  `MetaRecordDrawer`-mounting spec (multitable-record-drawer*.spec.ts, meta-record-drawer-*.spec.ts)
  is UNCHANGED and stays green — it now exercises this shell -> MetaRecordInspector delegation, which
  IS the compat contract this file promises.
-->
<template>
  <MetaRecordInspector
    :visible="visible"
    :record="record"
    :fields="fields"
    :can-edit="canEdit"
    :can-comment="canComment"
    :can-delete="canDelete"
    :can-create="canCreate"
    :can-manage-automation="canManageAutomation"
    :field-permissions="fieldPermissions"
    :row-actions="rowActions"
    :comment-presence="commentPresence"
    :link-summaries-by-field="linkSummariesByField"
    :person-summaries-by-field="personSummariesByField"
    :attachment-summaries-by-field="attachmentSummariesByField"
    :record-ids="recordIds"
    :upload-fn="uploadFn"
    :delete-attachment-fn="deleteAttachmentFn"
    :can-manage-record-permissions="canManageRecordPermissions"
    :sheet-id="sheetId"
    :api-client="apiClient"
    :ai-shortcut="aiShortcut"
    :button-run-pending="buttonRunPending"
    :mention-suggestions="mentionSuggestions"
    @close="emit('close')"
    @delete="emit('delete')"
    @duplicate="emit('duplicate')"
    @patch="(fieldId: string, value: unknown) => emit('patch', fieldId, value)"
    @toggle-lock="(payload: { recordId: string; locked: boolean }) => emit('toggle-lock', payload)"
    @toggle-comments="emit('toggle-comments')"
    @comment-field="(field: MetaField) => emit('comment-field', field)"
    @open-automation="emit('open-automation')"
    @open-link-picker="(field: MetaField) => emit('open-link-picker', field)"
    @open-person-picker="(field: MetaField) => emit('open-person-picker', field)"
    @navigate="(recordId: string) => emit('navigate', recordId)"
    @restore="(payload: { recordId: string; targetVersion: number; expectedVersion: number; fieldIds?: string[] }) => emit('restore', payload)"
    @ai-preview="(field: MetaField) => emit('ai-preview', field)"
    @ai-run="(field: MetaField) => emit('ai-run', field)"
    @run-button="(payload: { recordId: string; field: MetaField }) => emit('run-button', payload)"
  />
</template>

<script setup lang="ts">
import type {
  LinkedRecordSummary,
  PersonSummary,
  MetaAttachment,
  MetaAttachmentDeleteFn,
  MetaAttachmentUploadFn,
  MetaCommentMentionSuggestion,
  MultitableCommentPresenceSummary,
  MetaFieldPermission,
  MetaField,
  MetaRecord,
  MetaRowActions,
} from '../types'
import type { MultitableApiClient } from '../api/client'
import MetaRecordInspector from './MetaRecordInspector.vue'
import type { AiShortcutState } from '../composables/useAiShortcut'

// W2 S3 (OD-W2-7=b): props/emits below are the drawer's PUBLIC compat contract, unchanged from
// pre-shell — kept byte-identical so every existing MetaRecordDrawer consumer (in-repo specs, any
// out-of-repo barrel-export consumer) needs zero changes. All values are forwarded 1:1 to
// MetaRecordInspector above; this file owns no state and no logic of its own.
withDefaults(defineProps<{
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
   *  Fed by the workbench's already-loaded commentMentionSuggestions (no re-fetch). */
  mentionSuggestions?: MetaCommentMentionSuggestion[]
}>(), {
  recordIds: () => [],
  buttonRunPending: () => [],
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
   * drawer emits 'patch' / 'delete' / 'toggle-lock' rather than mutating directly. */
  (e: 'restore', payload: { recordId: string; targetVersion: number; expectedVersion: number; fieldIds?: string[] }): void
  /** A3: AI shortcut triggers (workbench resolves them through useAiShortcut). */
  (e: 'ai-preview', field: MetaField): void
  (e: 'ai-run', field: MetaField): void
  /** B1-e: run a button field's configured action. Same shape the grid emits
   * (`run-button { recordId, field }`) so the workbench's existing onRunButton
   * handler — which owns the runButton call + result.status branching + the
   * shared buttonRunPending key — handles both surfaces with no extra logic. */
  (e: 'run-button', payload: { recordId: string; field: MetaField }): void
}>()
</script>
