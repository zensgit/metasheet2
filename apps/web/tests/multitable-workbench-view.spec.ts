import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, reactive, ref, type App as VueApp, type Component, type PropType } from 'vue'
// P3-2 (2026-09-05): pure-function coverage for the mentionDisplayFieldId unification lives here,
// beside the WB `mentionDisplayFieldId` computed it replaces — see that describe block below.
import { resolveMentionDisplayField, resolvePrimaryField } from '../src/multitable/utils/recordDisplay'
import type { MetaField } from '../src/multitable/types'

const showErrorSpy = vi.fn()
const showSuccessSpy = vi.fn()
// G-10 follow-up: captures the xlsx tab name the export path passes down, without writing a real
// workbook (buildXlsxBuffer's own trim/slice/default behavior is covered by multitable/xlsx-mapping.test.ts).
// vi.hoisted: the mocked module is imported synchronously by MultitableWorkbench.vue, so a plain
// top-level const would still be in its TDZ when the factory runs.
const { buildXlsxBufferMock } = vi.hoisted(() => ({ buildXlsxBufferMock: vi.fn(() => new Uint8Array([1, 2, 3])) }))
// Round 3 (2026-09-05, record inspector v3 refuter finding): identity capture of the `openerEl` prop
// the workbench binds via `:opener-el="inspectorOpenerEl"` on `<MetaRecordInspector>`. An
// HTMLElement cannot round-trip through a DOM attribute (a fallthrough attr would stringify it to
// "[object HTMLButtonElement]"), so the MetaRecordInspector stub below declares the prop and writes
// the LATEST value it was rendered with — plus a render counter, so an "unchanged after close"
// assertion can prove the stub really re-rendered rather than the holder simply being stale — into
// this hoisted holder. `vi.hoisted` for the same reason as `buildXlsxBufferMock` above. Reset per
// test in `beforeEach`.
const { inspectorStubSeen } = vi.hoisted(() => ({
  inspectorStubSeen: { openerEl: null as HTMLElement | null, renders: 0 },
}))
vi.mock('../src/multitable/import/xlsx-mapping', async () => {
  const actual = await vi.importActual<any>('../src/multitable/import/xlsx-mapping')
  return { ...actual, buildXlsxBuffer: buildXlsxBufferMock }
})
const pushSpy = vi.fn().mockResolvedValue(undefined)
const useMultitableSheetRealtimeMock = vi.fn()
// The workflow-designer manager button is gated on caps.canManageAutomation AND
// featureFlags.hasFeature('workflow') (introduced after this spec was last authored — see
// multitable-workbench-1672-1673.spec.ts's #1673 gate tests, which added this same partial mock).
// No test in this file exercises the negative "flag off" branch, so a constant `true` is safe:
// the workflow button also stays hidden in every other test here because canManageAutomation
// defaults false (see the "Workflow/Automations are excluded" comment below).
vi.mock('../src/stores/featureFlags', async () => {
  const actual = await vi.importActual<any>('../src/stores/featureFlags')
  return {
    ...actual,
    useFeatureFlags: () => ({ ...actual.useFeatureFlags(), hasFeature: (feature: string) => feature === 'workflow' }),
  }
})
let sheetPresenceStateMock: any
let commentInboxStateMock: any
const { authAccessSnapshot, bulkImportRecordsMock } = vi.hoisted(() => ({
  authAccessSnapshot: {
    email: 'dev@example.com',
    roles: [] as string[],
    permissions: ['multitable:write'] as string[],
    isAdmin: false,
  },
  bulkImportRecordsMock: vi.fn(),
}))

const FAVORITE_BASES_KEY = 'metasheet:multitable:favorite-base-ids:v1'
const RECENT_BASES_KEY = 'metasheet:multitable:recent-base-opens:v1'

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({
      push: pushSpy,
    }),
  }
})

function stubComponent(name: string) {
  return defineComponent({
    name,
    render() {
      return h('div', { [`data-stub-${name}`]: 'true' })
    },
  })
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let workbenchMock: any
let gridMock: any
let loadCommentsSpy: ReturnType<typeof vi.fn>
let addCommentSpy: ReturnType<typeof vi.fn>
let resolveCommentSpy: ReturnType<typeof vi.fn>
let mentionInboxSummaryMock: any
let commentsStateMock: any
const subscribeToMultitableCommentSheetRealtimeMock = vi.fn(() => vi.fn())

vi.mock('../src/multitable/composables/useMultitableWorkbench', () => ({
  useMultitableWorkbench: () => workbenchMock,
}))

vi.mock('../src/multitable/composables/useMultitableGrid', () => ({
  useMultitableGrid: () => gridMock,
}))

vi.mock('../src/multitable/composables/useMultitableCapabilities', () => ({
  useMultitableCapabilities: (source: { value?: Record<string, boolean> } | undefined) => ({
    canRead: computed(() => source?.value?.canRead ?? true),
    canCreateRecord: computed(() => source?.value?.canCreateRecord ?? true),
    canEditRecord: computed(() => source?.value?.canEditRecord ?? true),
    canDeleteRecord: computed(() => source?.value?.canDeleteRecord ?? true),
    canManageFields: computed(() => source?.value?.canManageFields ?? true),
    canManageSheetAccess: computed(() => source?.value?.canManageSheetAccess ?? true),
    canManageViews: computed(() => source?.value?.canManageViews ?? true),
    canComment: computed(() => source?.value?.canComment ?? true),
    canManageAutomation: computed(() => source?.value?.canManageAutomation ?? false),
    canExport: computed(() => source?.value?.canExport ?? true),
  }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getAccessSnapshot: () => authAccessSnapshot,
    getCurrentUserId: vi.fn().mockResolvedValue('user_1'),
  }),
}))

vi.mock('../src/multitable/composables/useMultitableComments', () => ({
  useMultitableComments: () => (commentsStateMock = {
    comments: ref([]),
    loading: ref(false),
    submitting: ref(false),
    resolvingIds: ref<string[]>([]),
    updatingIds: ref<string[]>([]),
    deletingIds: ref<string[]>([]),
    reactingKeys: ref<string[]>([]),
    error: ref<string | null>(null),
    loadComments: loadCommentsSpy,
    addComment: addCommentSpy,
    updateComment: vi.fn(),
    deleteComment: vi.fn(),
    resolveComment: resolveCommentSpy,
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
  }),
}))

vi.mock('../src/multitable/composables/useMultitableCommentInbox', () => ({
  useMultitableCommentInbox: () => (commentInboxStateMock = {
    unreadCount: ref(0),
    refreshUnreadCount: vi.fn().mockResolvedValue(0),
  }),
}))

vi.mock('../src/multitable/composables/useMultitableCommentInboxSummary', () => ({
  useMultitableCommentInboxSummary: () => (mentionInboxSummaryMock = {
    summary: ref(null as null | {
      spreadsheetId: string
      unresolvedMentionCount: number
      unreadMentionCount: number
      mentionedRecordCount: number
      unreadRecordCount: number
      items: Array<{ rowId: string; mentionedCount: number; unreadCount: number; mentionedFieldIds: string[] }>
    }),
    loading: ref(false),
    error: ref<string | null>(null),
    unreadMentionCount: computed(() => mentionInboxSummaryMock?.summary?.value?.unreadMentionCount ?? 0),
    unreadRecordCount: computed(() => mentionInboxSummaryMock?.summary?.value?.unreadRecordCount ?? 0),
    loadSummary: vi.fn().mockResolvedValue(undefined),
    markRead: vi.fn().mockResolvedValue(undefined),
    clearSummary: vi.fn(),
    onRealtimeCommentCreated: vi.fn(),
    onRealtimeCommentUpdated: vi.fn(),
    onRealtimeCommentResolved: vi.fn(),
    onRealtimeCommentDeleted: vi.fn(),
  }),
}))

vi.mock('../src/multitable/composables/useMultitableCommentRealtime', () => ({
  useMultitableCommentRealtime: vi.fn(),
}))

vi.mock('../src/multitable/composables/useMultitableSheetRealtime', () => ({
  useMultitableSheetRealtime: (...args: unknown[]) => useMultitableSheetRealtimeMock(...args),
}))

vi.mock('../src/multitable/composables/useMultitableSheetPresence', () => ({
  useMultitableSheetPresence: () => (sheetPresenceStateMock = {
    presence: ref(null),
    activeUsers: ref([] as Array<{ id: string }>),
    activeCollaborators: ref([] as Array<{ id: string }>),
    activeCollaboratorCount: computed(() => sheetPresenceStateMock?.activeCollaborators.value.length ?? 0),
    remoteCursors: ref([] as unknown[]),
    remoteCursorsByCell: ref({} as Record<string, unknown>),
    setLocalCursor: vi.fn(),
    reconnect: vi.fn(),
    disconnect: vi.fn(),
  }),
}))

vi.mock('../src/multitable/composables/useMultitableCommentPresence', () => ({
  useMultitableCommentPresence: () => ({
    presenceByRecordId: ref({}),
    loading: ref(false),
    error: ref<string | null>(null),
    loadPresence: vi.fn().mockResolvedValue(undefined),
    clearPresence: vi.fn(),
  }),
}))

vi.mock('../src/multitable/realtime/comments-realtime', () => ({
  subscribeToMultitableCommentSheetRealtime: (...args: unknown[]) => subscribeToMultitableCommentSheetRealtimeMock(...args),
  subscribeToMultitableCommentsRealtime: vi.fn(() => vi.fn()),
}))

vi.mock('../src/multitable/import/bulk-import', () => ({
  bulkImportRecords: bulkImportRecordsMock,
}))

vi.mock('../src/multitable/components/MetaSheetViewRail.vue', () => ({
  default: defineComponent({
    name: 'MetaSheetViewRail',
    props: {
      canCreateSheet: { type: Boolean, default: false },
    },
    emits: ['create-sheet', 'select-sheet', 'select-view'],
    render() {
      return h('div', [
        this.$props.canCreateSheet
          ? h(
              'button',
              {
                'data-create-sheet': 'true',
                onClick: () => this.$emit('create-sheet', 'Sheet 2'),
              },
              'create-sheet',
            )
          : null,
        h(
          'button',
          {
            'data-select-sheet': 'sheet_sales',
            onClick: () => this.$emit('select-sheet', 'sheet_sales'),
          },
          'select-sheet',
        ),
        h(
          'button',
          {
            'data-select-view': 'view_gallery',
            onClick: () => this.$emit('select-view', 'view_gallery'),
          },
          'select-view',
        ),
      ])
    },
  }),
}))
vi.mock('../src/multitable/components/MetaToolbar.vue', () => ({
  default: defineComponent({
    name: 'MetaToolbar',
    props: {
      fields: { type: Array, default: () => [] },
      // persist-display-prefs: expose the inbound row-density so the round-trip can be asserted.
      rowDensity: { type: String, default: undefined },
    },
    emits: ['add-record', 'import', 'export-csv', 'set-row-density'],
    render() {
      const fieldIds = (this.$props.fields as Array<{ id?: string }>)
        .map((field) => field.id ?? '')
        .filter((fieldId) => fieldId.length > 0)
        .join(',')
      return h(
        'div',
        { 'data-toolbar-field-ids': fieldIds, 'data-toolbar-row-density': this.$props.rowDensity ?? '' },
        [
          h(
            'button',
            {
              'data-add-record': 'true',
              onClick: () => this.$emit('add-record'),
            },
            'add-record',
          ),
          h(
            'button',
            {
              'data-open-import': 'true',
              onClick: () => this.$emit('import'),
            },
            'open-import',
          ),
          h(
            'button',
            {
              'data-export-csv': 'true',
              onClick: () => this.$emit('export-csv'),
            },
            'export-csv',
          ),
          h(
            'button',
            {
              'data-set-row-density': 'compact',
              onClick: () => this.$emit('set-row-density', 'compact'),
            },
            'set-row-density-compact',
          ),
        ],
      )
    },
  }),
}))
vi.mock('../src/multitable/components/MetaGridTable.vue', () => ({
  default: defineComponent({
    name: 'MetaGridTable',
    props: {
      // persist-display-prefs: expose the inbound display-pref props for round-trip assertions.
      columnWidths: { type: Object, default: () => ({}) },
      collapsedGroupKeys: { type: Array, default: () => [] },
      rowDensity: { type: String, default: undefined },
    },
    // Record inspector v3 (2026-09-05, PR-A §1.1): `expand-record` added to this stub's emits —
    // `select-record` alone is now a plain cursor move (W2 lock §3.1 erratum) and no longer opens
    // the inspector; tests that need the panel OPEN click the new `data-expand-record` button
    // (mirrors the real grid's row-number icon → `expand-record`).
    emits: ['select-record', 'expand-record', 'open-comments', 'open-field-comments', 'resize-column', 'toggle-group', 'bulk-edit', 'selection-change'],
    render() {
      return h('div', {
        'data-grid-column-widths': JSON.stringify(this.$props.columnWidths ?? {}),
        'data-grid-collapsed-keys': JSON.stringify(this.$props.collapsedGroupKeys ?? []),
        'data-grid-row-density': this.$props.rowDensity ?? '',
      }, [
        h(
          'button',
          {
            'data-select-record': 'rec_1',
            onClick: () => this.$emit('select-record', 'rec_1'),
          },
          'select-record-1',
        ),
        h(
          'button',
          {
            'data-select-record': 'rec_2',
            onClick: () => this.$emit('select-record', 'rec_2'),
          },
          'select-record-2',
        ),
        h(
          'button',
          {
            'data-expand-record': 'rec_1',
            onClick: () => this.$emit('expand-record', 'rec_1'),
          },
          'expand-record-1',
        ),
        h(
          'button',
          {
            'data-expand-record': 'rec_2',
            onClick: () => this.$emit('expand-record', 'rec_2'),
          },
          'expand-record-2',
        ),
        h(
          'button',
          {
            'data-open-comments': 'rec_1',
            onClick: () => this.$emit('open-comments', 'rec_1'),
          },
          'open-comments',
        ),
        // Round 4 (2026-09-05, stale-opener P2): a second row's comment click-through, so the
        // "expand-open row 1 → close → comment-open row 2" sequence can be driven end to end
        // (mirrors the real grid's per-row `.meta-grid__comment-action` button → `open-comments`).
        h(
          'button',
          {
            'data-open-comments': 'rec_2',
            onClick: () => this.$emit('open-comments', 'rec_2'),
          },
          'open-comments-2',
        ),
        h(
          'button',
          {
            'data-open-field-comments': 'rec_1/fld_title',
            onClick: () => this.$emit('open-field-comments', { recordId: 'rec_1', fieldId: 'fld_title' }),
          },
          'open-field-comments',
        ),
        h(
          'button',
          {
            'data-resize-column': 'fld_title',
            onClick: () => this.$emit('resize-column', 'fld_title', 222),
          },
          'resize-column',
        ),
        h(
          'button',
          {
            'data-toggle-group': 'todo',
            onClick: () => this.$emit('toggle-group', 'todo'),
          },
          'toggle-group',
        ),
        h(
          'button',
          {
            'data-bulk-edit': 'true',
            onClick: () => this.$emit('bulk-edit', { mode: 'clear', recordIds: ['rec_1'] }),
          },
          'bulk-edit',
        ),
        h(
          'button',
          {
            'data-select-rows': 'rec_1',
            onClick: () => this.$emit('selection-change', ['rec_1']),
          },
          'selection-change',
        ),
      ])
    },
  }),
}))
vi.mock('../src/multitable/components/MetaFormView.vue', () => ({
  default: defineComponent({
    name: 'MetaFormView',
    emits: ['submit', 'update:dirty'],
    render() {
      return h('div', [
        h(
          'button',
          {
            'data-form-dirty': 'true',
            onClick: () => this.$emit('update:dirty', true),
          },
          'form-dirty',
        ),
        h(
          'button',
          {
            'data-form-submit': 'true',
            onClick: () => this.$emit('submit', { fld_title: 'Saved title' }),
          },
          'form-submit',
        ),
      ])
    },
  }),
}))
// W2 S3/S4: MultitableWorkbench.vue now renders MetaRecordInspector.vue directly (the shell that
// absorbed the drawer's tablist/header/lock-banner rendering — MetaRecordDrawer.vue itself is now
// a deprecated thin compat shell no longer mounted by the workbench, OD-W2-7=b). S4 additionally
// absorbed the SECOND drawer (MetaCommentsDrawer.vue) — the workbench no longer mounts it either;
// comments state/emits now flow straight into THIS component (comments-tab props, `comment-`
// prefixed emits, see MetaRecordInspector.vue's own emit block for why the prefix). This stub folds
// what used to be the separate MetaCommentsDrawer stub's clickable stand-ins into this one — same
// data-testids the pre-S4 tests already used (data-submit-comment / data-set-comment-draft /
// data-reply-comment / data-cancel-reply / data-current-comment-field / data-highlighted-comment /
// data-mention-suggestions-count), MINUS `data-close-comments` (no such affordance exists anymore —
// comments has no close chrome of its own now, lock §2 "不含它自己的 __header...close 钮"; the two
// tests that exercised it were removed, see below). Everything else is otherwise unchanged from the
// pre-S3 MetaRecordDrawer stub — same props/emits contract, same fixture shape.
vi.mock('../src/multitable/components/MetaRecordInspector.vue', () => ({
  default: defineComponent({
    name: 'MetaRecordInspector',
    props: {
      visible: { type: Boolean, default: false },
      record: { type: Object, default: null },
      // Round 3 (2026-09-05): declared so the workbench's `:opener-el` binding arrives as a typed
      // prop (recorded into `inspectorStubSeen` in `render` below) instead of a stringified
      // fallthrough attr — see the holder's own comment near the top of this file.
      openerEl: { type: Object as PropType<HTMLElement | null>, default: null },
      commentTargetFieldId: { type: String, default: null },
      highlightedCommentId: { type: String, default: null },
      mentionSuggestions: { type: Array, default: () => [] },
      // PR-B2 (2026-09-05, record inspector v3 §1.3): declared so the workbench's `:field-errors`
      // binding arrives as a typed prop and is rendered below as the same `[data-test=
      // drawer-field-error][data-field-id]` node the real MetaRecordFieldsPanel renders.
      fieldErrors: { type: Object as PropType<Record<string, string> | null>, default: null },
    },
    emits: [
      'close', 'toggle-comments', 'comment-field', 'navigate', 'delete', 'patch',
      'comment-submit', 'comment-reply', 'comment-cancel-reply', 'update:comment-draft',
    ],
    render() {
      // Round 3 (2026-09-05): record what THIS render was given, visible or not — the real component
      // instance stays mounted across every open/close (no `v-if` at the workbench call site), so the
      // prop keeps flowing to it after `visible` drops back to false too.
      inspectorStubSeen.openerEl = (this.$props.openerEl as HTMLElement | null) ?? null
      inspectorStubSeen.renders += 1
      if (!this.$props.visible) return null
      const recordId = (this.$props.record as { id?: string } | null)?.id ?? ''
      return h('div', {
        'data-record-drawer': recordId,
        'data-current-comment-field': this.$props.commentTargetFieldId ?? '',
        'data-highlighted-comment': this.$props.highlightedCommentId ?? '',
        'data-mention-suggestions-count': String((this.$props.mentionSuggestions as unknown[]).length),
      }, [
        // PR-B2 (2026-09-05): one node per `fieldErrors` entry, mirroring the real panel's markup, so the
        // `onDrawerPatch` routing tests can assert "inline under THAT field" through this stub. The real
        // panel's alert/aria/draft behaviour is pinned in multitable-record-inspector-field-errors.spec.ts.
        ...Object.entries((this.$props.fieldErrors as Record<string, string> | null) ?? {}).map(([fieldId, message]) =>
          h('div', { 'data-test': 'drawer-field-error', 'data-field-id': fieldId, role: 'alert' }, message),
        ),
        h(
          'button',
          {
            'data-close-drawer': 'true',
            onClick: () => this.$emit('close'),
          },
          'close-drawer',
        ),
        h(
          'button',
          {
            'data-toggle-comments': 'true',
            onClick: () => this.$emit('toggle-comments'),
          },
          'toggle-comments',
        ),
        h(
          'button',
          {
            'data-comment-field': 'fld_title',
            onClick: () => this.$emit('comment-field', { id: 'fld_title', name: 'Title', type: 'string' }),
          },
          'comment-field',
        ),
        h(
          'button',
          {
            'data-navigate-record': 'rec_2',
            onClick: () => this.$emit('navigate', 'rec_2'),
          },
          'navigate-record',
        ),
        h(
          'button',
          {
            'data-delete-record': 'true',
            onClick: () => this.$emit('delete'),
          },
          'delete-record',
        ),
        h(
          'button',
          {
            'data-patch-record': 'fld_title',
            onClick: () => this.$emit('patch', 'fld_title', 'Patched title'),
          },
          'patch-record',
        ),
        h(
          'button',
          {
            'data-set-comment-draft': 'true',
            onClick: () => this.$emit('update:comment-draft', 'Need review'),
          },
          'set-comment-draft',
        ),
        h(
          'button',
          {
            'data-submit-comment': 'true',
            onClick: () => this.$emit('comment-submit', { content: 'Need review', mentions: [] }),
          },
          'submit-comment',
        ),
        h(
          'button',
          {
            'data-reply-comment': 'comment_parent_1',
            onClick: () => this.$emit('comment-reply', 'comment_parent_1'),
          },
          'reply-comment',
        ),
        h(
          'button',
          {
            'data-cancel-reply': 'true',
            onClick: () => this.$emit('comment-cancel-reply'),
          },
          'cancel-reply',
        ),
      ])
    },
  }),
}))
vi.mock('../src/multitable/components/MetaMentionPopover.vue', () => ({
  default: defineComponent({
    name: 'MetaMentionPopover',
    props: {
      visible: { type: Boolean, default: false },
      items: { type: Array, default: () => [] },
    },
    emits: ['close', 'select-record'],
    render() {
      if (!this.$props.visible) return null
      const firstItem = (this.$props.items as Array<{ rowId: string; mentionedFieldIds: string[] }>)[0] ?? null
      return h('div', { 'data-mention-popover': 'true' }, [
        h(
          'button',
          {
            'data-mention-popover-select': firstItem?.rowId ?? '',
            onClick: () => this.$emit('select-record', {
              rowId: firstItem?.rowId ?? '',
              fieldId: firstItem?.mentionedFieldIds?.[0] ?? null,
              mentionedFieldIds: firstItem?.mentionedFieldIds ?? [],
            }),
          },
          'mention-select',
        ),
        h(
          'button',
          {
            'data-mention-popover-close': 'true',
            onClick: () => this.$emit('close'),
          },
          'mention-close',
        ),
      ])
    },
  }),
}))
vi.mock('../src/multitable/components/MetaLinkPicker.vue', () => ({ default: stubComponent('MetaLinkPicker') }))
vi.mock('../src/multitable/components/MetaFieldManager.vue', () => ({
  default: defineComponent({
    name: 'MetaFieldManager',
    props: {
      visible: { type: Boolean, default: false },
      fields: { type: Array, default: () => [] },
      hierarchyParentFieldIds: { type: Array, default: () => [] },
    },
    emits: ['create-field', 'update:dirty'],
    render() {
      const fieldIds = (this.$props.fields as Array<{ id?: string }>)
        .map((field) => field.id ?? '')
        .filter((fieldId) => fieldId.length > 0)
        .join(',')
      const hierarchyParentFieldIds = (this.$props.hierarchyParentFieldIds as string[])
        .filter((fieldId) => fieldId.length > 0)
        .join(',')
      return h(
        'div',
        {
          'data-field-manager-field-ids': fieldIds,
          'data-field-manager-hierarchy-parent-ids': hierarchyParentFieldIds,
        },
        [
          h(
            'button',
            {
              'data-create-person-field': 'true',
              onClick: () => this.$emit('create-field', { sheetId: 'sheet_orders', name: 'Owner', type: 'person' }),
            },
            'create-person-field',
          ),
          h(
            'button',
            {
              'data-create-person-field-multi': 'true',
              onClick: () => this.$emit('create-field', {
                sheetId: 'sheet_orders',
                name: 'Approvers',
                type: 'person',
                property: { limitSingleRecord: false },
              }),
            },
            'create-person-field-multi',
          ),
          h(
            'button',
            {
              'data-field-manager-dirty': 'true',
              onClick: () => this.$emit('update:dirty', true),
            },
            'field-manager-dirty',
          ),
          h(
            'button',
            {
              'data-field-manager-clean': 'true',
              onClick: () => this.$emit('update:dirty', false),
            },
            'field-manager-clean',
          ),
        ],
      )
    },
  }),
}))
vi.mock('../src/multitable/components/MetaViewManager.vue', () => ({
  default: defineComponent({
    name: 'MetaViewManager',
    props: {
      visible: { type: Boolean, default: false },
      fields: { type: Array, default: () => [] },
    },
    emits: ['close', 'update:dirty'],
    render() {
      if (!this.$props.visible) return null
      const fieldIds = (this.$props.fields as Array<{ id?: string }>)
        .map((field) => field.id ?? '')
        .filter((fieldId) => fieldId.length > 0)
        .join(',')
      return h('div', {
        'data-view-manager': 'true',
        'data-view-manager-field-ids': fieldIds,
      }, [
        h(
          'button',
          {
            'data-view-manager-dirty': 'true',
            onClick: () => this.$emit('update:dirty', true),
          },
          'view-manager-dirty',
        ),
        h(
          'button',
          {
            'data-close-view-manager': 'true',
            onClick: () => this.$emit('close'),
          },
          'close-view-manager',
        ),
      ])
    },
  }),
}))
vi.mock('../src/multitable/components/MetaSheetPermissionManager.vue', () => ({
  default: defineComponent({
    name: 'MetaSheetPermissionManager',
    props: {
      visible: { type: Boolean, default: false },
      sheetId: { type: String, default: '' },
    },
    emits: ['close', 'updated'],
    render() {
      if (!this.$props.visible) return null
      return h('div', {
        'data-sheet-permission-manager': 'true',
        'data-sheet-permission-manager-sheet-id': this.$props.sheetId,
      }, [
        h(
          'button',
          {
            'data-sheet-permission-updated': 'true',
            onClick: () => this.$emit('updated'),
          },
          'permission-updated',
        ),
        h(
          'button',
          {
            'data-close-sheet-permission-manager': 'true',
            onClick: () => this.$emit('close'),
          },
          'close-permission-manager',
        ),
      ])
    },
  }),
}))
vi.mock('../src/multitable/components/MetaKanbanView.vue', () => ({
  default: defineComponent({
    name: 'MetaKanbanView',
    props: {
      canEdit: { type: Boolean, default: false },
    },
    render() {
      return h('div', {
        'data-kanban-can-edit': String(this.$props.canEdit),
      })
    },
  }),
}))
vi.mock('../src/multitable/components/MetaGalleryView.vue', () => ({
  default: defineComponent({
    name: 'MetaGalleryView',
    props: {
      viewConfig: { type: Object, default: null },
    },
    emits: ['update-view-config'],
    render() {
      return h(
        'button',
        {
          'data-gallery-config': JSON.stringify(this.$props.viewConfig ?? null),
          onClick: () => this.$emit('update-view-config', {
            config: {
              titleFieldId: 'fld_title',
              coverFieldId: 'fld_cover',
              fieldIds: ['fld_status'],
              columns: 4,
              cardSize: 'large',
            },
          }),
        },
        'gallery-config',
      )
    },
  }),
}))
vi.mock('../src/multitable/components/MetaCalendarView.vue', () => ({ default: stubComponent('MetaCalendarView') }))
vi.mock('../src/multitable/components/MetaTimelineView.vue', () => ({
  default: defineComponent({
    name: 'MetaTimelineView',
    props: {
      viewConfig: { type: Object, default: null },
      canEdit: { type: Boolean, default: false },
    },
    emits: ['update-view-config', 'patch-dates'],
    render() {
      return h('div', {
        'data-timeline-can-edit': String(this.$props.canEdit),
      }, [
        h(
          'button',
          {
            'data-timeline-config': JSON.stringify(this.$props.viewConfig ?? null),
            onClick: () => this.$emit('update-view-config', {
              config: {
                startFieldId: 'fld_start',
                endFieldId: 'fld_end',
                labelFieldId: 'fld_title',
                zoom: 'month',
              },
            }),
          },
          'timeline-config',
        ),
        h(
          'button',
          {
            'data-timeline-patch': 'true',
            onClick: () => this.$emit('patch-dates', {
              recordId: 'rec_1',
              version: 3,
              startFieldId: 'fld_start',
              endFieldId: 'fld_end',
              startValue: '2026-03-25',
              endValue: '2026-03-27',
            }),
          },
          'timeline-patch',
        ),
      ])
    },
  }),
}))
vi.mock('../src/multitable/components/MetaGanttView.vue', () => ({
  default: defineComponent({
    name: 'MetaGanttView',
    props: {
      sheetId: { type: String, default: '' },
      canEdit: { type: Boolean, default: false },
    },
    emits: ['patch-dates'],
    render() {
      return h('div', {
        'data-gantt-sheet-id': this.$props.sheetId,
        'data-gantt-can-edit': String(this.$props.canEdit),
      }, [
        h(
          'button',
          {
            'data-gantt-patch': 'true',
            onClick: () => this.$emit('patch-dates', {
              recordId: 'rec_1',
              version: 4,
              startFieldId: 'fld_start',
              endFieldId: 'fld_end',
              startValue: '2026-04-01',
              endValue: '2026-04-04',
            }),
          },
          'gantt-patch',
        ),
      ])
    },
  }),
}))
vi.mock('../src/multitable/components/MetaHierarchyView.vue', () => ({
  default: defineComponent({
    name: 'MetaHierarchyView',
    props: {
      canEdit: { type: Boolean, default: false },
    },
    emits: ['reparent-record'],
    render() {
      return h('div', {
        'data-hierarchy-can-edit': String(this.$props.canEdit),
      }, [
        h(
          'button',
          {
            'data-hierarchy-reparent': 'true',
            onClick: () => this.$emit('reparent-record', {
              recordId: 'rec_1',
              version: 5,
              parentFieldId: 'fld_parent',
              parentRecordId: 'rec_parent',
            }),
          },
          'hierarchy-reparent',
        ),
      ])
    },
  }),
}))
vi.mock('../src/multitable/components/MetaImportModal.vue', () => ({
  default: defineComponent({
    name: 'MetaImportModal',
    props: {
      visible: { type: Boolean, default: false },
      fields: { type: Array, default: () => [] },
    },
    emits: ['update:dirty', 'close', 'cancel-import', 'import'],
    render() {
      if (!this.$props.visible) return null
      const fieldIds = (this.$props.fields as Array<{ id?: string }>)
        .map((field) => field.id ?? '')
        .filter((fieldId) => fieldId.length > 0)
        .join(',')
      return h('div', [
        h('div', { 'data-import-field-ids': fieldIds }),
        h(
          'button',
          {
            'data-import-dirty': 'true',
            onClick: () => this.$emit('update:dirty', true),
          },
          'import-dirty',
        ),
        h(
          'button',
          {
            'data-import-submit': 'true',
            onClick: () => this.$emit('import', {
              records: [
                { fld_title: 'Alpha', fld_status: 'Open' },
                { fld_title: 'alpha', fld_status: 'Closed' },
              ],
              rowIndexes: [0, 1],
              failures: [],
            }),
          },
          'import-submit',
        ),
      ])
    },
  }),
}))

vi.mock('../src/multitable/components/MetaBasePicker.vue', () => ({
  default: defineComponent({
    name: 'MetaBasePicker',
    props: {
      bases: { type: Array, default: () => [] },
      activeBaseId: { type: String, default: '' },
      canCreate: { type: Boolean, default: false },
    },
    emits: ['select', 'create', 'toggle-favorite'],
    render() {
      const bases = this.$props.bases as Array<{ id: string; name: string; isFavorite?: boolean; lastOpenedAt?: string | null }>
      return h('div', [
        h(
          'div',
          { 'data-base-picker-order': 'true' },
          bases.map((base) => `${base.id}:${base.isFavorite ? 'favorite' : 'normal'}:${base.lastOpenedAt ? 'recent' : 'stale'}`).join('|'),
        ),
        ...bases.map((base) =>
          h(
            'button',
            {
              'data-toggle-favorite-base': base.id,
              onClick: () => this.$emit('toggle-favorite', base.id),
            },
            `favorite-${base.id}`,
          ),
        ),
        h(
          'button',
          {
            'data-select-base': 'base_sales',
            'data-active-base-id': this.$props.activeBaseId,
            onClick: () => this.$emit('select', 'base_sales'),
          },
          this.$props.activeBaseId || 'no-base',
        ),
        this.$props.canCreate
          ? h(
              'button',
              {
                'data-create-base': 'true',
                onClick: () => this.$emit('create', 'Base 2'),
              },
              'create-base',
            )
          : null,
      ])
    },
  }),
}))

vi.mock('../src/multitable/components/MetaToast.vue', () => ({
  default: defineComponent({
    name: 'MetaToast',
    setup(_, { expose }) {
      expose({
        showError: showErrorSpy,
        showSuccess: showSuccessSpy,
      })
      return () => h('div', { 'data-toast': 'true' })
    },
  }),
}))

import MultitableWorkbench from '../src/multitable/views/MultitableWorkbench.vue'
import { useLocale } from '../src/composables/useLocale'

async function flushUi(cycles = 5): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

// UI-P2-2c (design docs/development/multitable-ui-p2-2c-responsive-design-20260714.md §6): shape copied
// verbatim from apps/web/tests/useAttendanceAdminRailNavigation.spec.ts's own setViewportWidth helper —
// same jsdom idiom (redefine window.innerWidth, dispatch a real 'resize' event) for the same reason
// (MultitableWorkbench's syncRailViewportState listens for 'resize', not a matchMedia mock).
function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  })
  window.dispatchEvent(new Event('resize'))
}

function createWorkbenchMock() {
  const activeBaseId = ref('base_ops')
  const activeSheetId = ref('sheet_orders')
  const activeViewId = ref('view_grid')
  const views = ref([
    { id: 'view_grid', sheetId: 'sheet_orders', name: 'Grid', type: 'grid' },
    { id: 'view_gallery', sheetId: 'sheet_orders', name: 'Gallery', type: 'gallery', config: { columns: 3 } },
    { id: 'view_timeline', sheetId: 'sheet_orders', name: 'Timeline', type: 'timeline', config: { zoom: 'week' } },
  ])
  return {
    client: {
      listBases: vi.fn().mockResolvedValue({
        bases: [
          { id: 'base_ops', name: 'Ops Base' },
          { id: 'base_sales', name: 'Sales Base' },
        ],
      }),
      loadFormContext: vi.fn(),
      getRecord: vi.fn(),
      listRecordSummaries: vi.fn().mockResolvedValue({
        records: [{ id: 'rec_existing', display: 'Alpha' }],
        displayMap: { rec_existing: 'Alpha' },
      }),
      listCommentMentionSuggestions: vi.fn().mockResolvedValue({
        items: [{ id: 'user_jamie', label: 'Jamie', subtitle: 'jamie@example.com' }],
        total: 1,
        limit: 100,
      }),
      markCommentRead: vi.fn().mockResolvedValue(undefined),
      createSheet: vi.fn(),
      createBase: vi.fn(),
      createField: vi.fn(),
      preparePersonField: vi.fn(),
      exportSheet: vi.fn(),
      updateField: vi.fn(),
      deleteField: vi.fn(),
      createView: vi.fn(),
      updateView: vi.fn(),
      deleteView: vi.fn(),
      listSheetPermissions: vi.fn().mockResolvedValue({ items: [] }),
      listSheetPermissionCandidates: vi.fn().mockResolvedValue({ items: [] }),
      listPersonFieldDirectory: vi.fn().mockResolvedValue({ items: [], total: 0, query: '' }),
      updateSheetPermission: vi.fn().mockResolvedValue({}),
      patchRecords: vi.fn(),
      submitForm: vi.fn(),
    },
    sheets: ref([{ id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null }]),
    fields: ref([]),
    views,
    activeBaseId,
    activeSheetId,
    activeViewId,
    capabilities: ref({
      canRead: true,
      canCreateRecord: true,
      canEditRecord: true,
      canDeleteRecord: true,
      canManageFields: true,
      canManageSheetAccess: true,
      canManageViews: true,
      canComment: true,
      canManageAutomation: false, canExport: true,
    }),
    capabilityOrigin: ref({
      source: 'global-rbac',
      hasSheetAssignments: false,
    }),
    fieldPermissions: ref({}),
    viewPermissions: ref({}),
    activeView: computed(() => views.value.find((view) => view.id === activeViewId.value) ?? null),
    loading: ref(false),
    error: ref<string | null>(null),
    loadSheets: vi.fn().mockResolvedValue(true),
    loadBaseContext: vi.fn().mockResolvedValue(true),
    loadSheetMeta: vi.fn().mockResolvedValue(true),
    switchBase: vi.fn().mockResolvedValue(true),
    syncExternalContext: vi.fn().mockResolvedValue(true),
    selectBase: vi.fn((baseId: string) => { activeBaseId.value = baseId }),
    selectSheet: vi.fn((sheetId: string) => { activeSheetId.value = sheetId }),
    selectView: vi.fn((viewId: string) => { activeViewId.value = viewId }),
  }
}

function createGridMock() {
  const fields = ref([
    { id: 'fld_title', name: 'Title', type: 'string', order: 1 },
    { id: 'fld_status', name: 'Status', type: 'select', order: 2, options: [{ value: 'todo' }] },
  ])
  const mock = {
    fields,
    rows: ref([
      { id: 'rec_1', version: 1, data: { fld_title: 'Alpha' } },
      { id: 'rec_2', version: 1, data: { fld_title: 'Beta' } },
    ]),
    loading: ref(false),
    currentPage: ref(1),
    totalPages: ref(1),
    page: ref({ offset: 0, limit: 50, total: 0, hasMore: false }),
    visibleFields: fields,
    sortRules: ref([]),
    filterRules: ref([]),
    filterConjunction: ref('and'),
    filterGroups: ref([]),
    canLoadMore: ref(false),
    canUndo: ref(false),
    canRedo: ref(false),
    groupFieldId: ref<string | null>(null), groupFieldIds: ref([]),
    groupField: ref(null), groupFields: ref([]),
    hiddenFieldIds: ref<string[]>([]),
    columnWidths: ref<Record<string, number>>({}),
    linkSummaries: ref<Record<string, Record<string, unknown[]>>>({}),
    personSummaries: ref<Record<string, Record<string, unknown[]>>>({}),
    attachmentSummaries: ref<Record<string, Record<string, unknown[]>>>({}),
    fieldPermissions: ref({}),
    viewPermission: ref(null),
    capabilityOrigin: ref(null),
    rowActions: ref(null),
    rowActionOverrides: ref<Record<string, { canEdit: boolean; canDelete: boolean; canComment: boolean }>>({}),
    conflict: ref(null),
    // PR-B2 (2026-09-05): the composable's additive `lastPatchFailure` ref the workbench routes on.
    lastPatchFailure: ref(null),
    // PR-B2 (2026-09-05): `lastBatchId` is what the real composable exposes for the success toast's
    // "view in history" action (`historyLinkAction(grid.lastBatchId.value)` in onDrawerPatch). It was
    // missing from this mock because, until PR-B2, no test in this file ever drove `onDrawerPatch` to its
    // SUCCESS branch — the stub's `data-patch-record` button existed but was never clicked.
    lastBatchId: ref<string | null>(null),
    error: ref<string | null>(null),
    sortFilterDirty: ref(false),
    toggleFieldVisibility: vi.fn(),
    addSortRule: vi.fn(),
    removeSortRule: vi.fn(),
    addFilterRule: vi.fn(),
    updateFilterRule: vi.fn(),
    removeFilterRule: vi.fn(),
    clearFilters: vi.fn(),
    applySortFilter: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    setGroupField: vi.fn(), setGroupFields: vi.fn(),
    goToPage: vi.fn(),
    patchCell: vi.fn(),
    bulkPatch: vi.fn(),
    createRecord: vi.fn(),
    deleteRecord: vi.fn(),
    mergeRemoteRecord: vi.fn().mockReturnValue(true),
    applyRemoteRecordPatch: vi.fn().mockReturnValue(true),
    removeRemoteRecord: vi.fn().mockReturnValue(true),
    loadViewData: vi.fn(),
    reloadCurrentPage: vi.fn(),
    dismissConflict: vi.fn(),
    retryConflict: vi.fn(),
    setColumnWidth: vi.fn(),
    setSearchQuery: vi.fn(),
  }
  mock.resolveRowActions = vi.fn((recordId?: string | null) => {
    if (recordId && mock.rowActionOverrides.value[recordId]) {
      return mock.rowActionOverrides.value[recordId]
    }
    return mock.rowActions.value
  })
  return mock
}

describe('MultitableWorkbench view wiring', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    // W2 S7 test-isolation fix: `window.location` is a SINGLE shared jsdom object across every test
    // in this file (unlike `container`, which is fresh per test). MultitableWorkbench's pre-existing
    // `watch(selectedRecordId, ...)` (URL-hash sync) writes `#recordId=...` via `history.replaceState`
    // whenever a test selects a record and never explicitly deselects before ending — harmless before
    // S7 because nothing else read that residue back. S7's mutual-exclusion watch, added below in the
    // component, DOES react to `selectedRecordId` transitions: `mountWorkbench()`'s `onMounted` calls
    // `parseDeepLink()`, which reads a leftover `#recordId=...` hash from a PRIOR test and re-selects
    // that record on the NEXT test's mount — this reset makes each test start from a clean URL, same
    // hygiene `FAVORITE_BASES_KEY`/`RECENT_BASES_KEY` already get below.
    try { window.history.replaceState(null, '', window.location.pathname + window.location.search) } catch { /* jsdom URL edge case, non-fatal */ }
    localStorage.removeItem(FAVORITE_BASES_KEY)
    localStorage.removeItem(RECENT_BASES_KEY)
    loadCommentsSpy = vi.fn()
    addCommentSpy = vi.fn()
    resolveCommentSpy = vi.fn()
    mentionInboxSummaryMock = null
    commentsStateMock = null
    sheetPresenceStateMock = null
    useMultitableSheetRealtimeMock.mockReset()
    subscribeToMultitableCommentSheetRealtimeMock.mockReset()
    bulkImportRecordsMock.mockReset()
    authAccessSnapshot.email = 'dev@example.com'
    authAccessSnapshot.roles = []
    authAccessSnapshot.permissions = ['multitable:write']
    authAccessSnapshot.isAdmin = false
    workbenchMock = createWorkbenchMock()
    gridMock = createGridMock()
    inspectorStubSeen.openerEl = null
    inspectorStubSeen.renders = 0
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.useRealTimers()
    showErrorSpy.mockReset()
    showSuccessSpy.mockReset()
    pushSpy.mockReset()
    localStorage.removeItem(FAVORITE_BASES_KEY)
    localStorage.removeItem(RECENT_BASES_KEY)
    useLocale().setLocale('en')
    vi.clearAllMocks()
  })

  function mountWorkbench(initialProps?: { baseId?: string; sheetId?: string; viewId?: string; recordId?: string; commentId?: string; fieldId?: string; openComments?: boolean; mode?: string }) {
    let hostState!: { baseId?: string; sheetId?: string; viewId?: string; recordId?: string; commentId?: string; fieldId?: string; openComments?: boolean; mode?: string }
    const externalContextResults: Array<{
      status: 'applied' | 'failed' | 'superseded'
      context: { baseId: string; sheetId: string; viewId: string }
      reason?: 'sync-failed' | 'superseded'
      requestId?: string | number
    }> = []
    const workbenchRef = ref<any>(null)
    workbenchMock.activeBaseId.value = initialProps?.baseId ?? 'base_ops'
    workbenchMock.activeSheetId.value = initialProps?.sheetId ?? 'sheet_orders'
    workbenchMock.activeViewId.value = initialProps?.viewId ?? 'view_grid'
    const Host = defineComponent({
      setup() {
        hostState = reactive({
          baseId: initialProps?.baseId ?? 'base_ops',
          sheetId: initialProps?.sheetId ?? 'sheet_orders',
          viewId: initialProps?.viewId ?? 'view_grid',
          recordId: initialProps?.recordId,
          commentId: initialProps?.commentId,
          fieldId: initialProps?.fieldId,
          openComments: initialProps?.openComments,
          mode: initialProps?.mode,
        })
        return () => h(MultitableWorkbench as Component, {
          ...hostState,
          ref: workbenchRef,
          onExternalContextResult: (payload: typeof externalContextResults[number]) => externalContextResults.push(payload),
        })
      },
    })

    app = createApp(Host)
    app.mount(container!)
    return Object.assign(hostState, { externalContextResults, workbenchRef })
  }

  it('filters property-hidden fields from manager surfaces while keeping view-hidden fields configurable', async () => {
    workbenchMock.fields.value = [
      { id: 'fld_title', name: 'Title', type: 'string' },
      { id: 'fld_view_hidden', name: 'View Hidden', type: 'string' },
      { id: 'fld_secret', name: 'Secret', type: 'string', property: { hidden: true } },
    ]
    gridMock.fields.value = [
      { id: 'fld_title', name: 'Title', type: 'string' },
      { id: 'fld_view_hidden', name: 'View Hidden', type: 'string' },
      { id: 'fld_secret', name: 'Secret', type: 'string', property: { hidden: true } },
    ]
    gridMock.hiddenFieldIds.value = ['fld_view_hidden']
    workbenchMock.fieldPermissions.value = {
      fld_title: { visible: true, readOnly: false },
      fld_view_hidden: { visible: false, readOnly: false },
      fld_secret: { visible: false, readOnly: false },
    }

    mountWorkbench()
    await flushUi()

    expect(container!.querySelector('[data-toolbar-field-ids]')?.getAttribute('data-toolbar-field-ids'))
      .toBe('fld_title,fld_view_hidden')

    const managerButtons = Array.from(container!.querySelectorAll('.mt-workbench__mgr-btn')) as HTMLButtonElement[]
    managerButtons.find((button) => button.textContent?.includes('Fields'))?.click()
    await flushUi()

    expect(container!.querySelector('[data-field-manager-field-ids]')?.getAttribute('data-field-manager-field-ids'))
      .toBe('fld_title,fld_view_hidden')

    container!.querySelector<HTMLButtonElement>('[data-open-import="true"]')!.click()
    await flushUi()

    expect(container!.querySelector('[data-import-field-ids]')?.getAttribute('data-import-field-ids'))
      .toBe('fld_title')

    managerButtons.find((button) => button.textContent?.includes('Views'))?.click()
    await flushUi()

    expect(container!.querySelector('[data-view-manager-field-ids]')?.getAttribute('data-view-manager-field-ids'))
      .toBe('fld_title,fld_view_hidden')
  })

  it('passes active-sheet hierarchy parent field ids into the field manager', async () => {
    workbenchMock.fields.value = [
      { id: 'fld_title', name: 'Title', type: 'string' },
      { id: 'fld_parent', name: 'Parent', type: 'link', property: { foreignSheetId: 'sheet_orders', limitSingleRecord: true } },
      { id: 'fld_other_parent', name: 'Other Parent', type: 'link', property: { foreignSheetId: 'sheet_other', limitSingleRecord: true } },
    ]
    workbenchMock.views.value = [
      ...workbenchMock.views.value,
      { id: 'view_hierarchy', sheetId: 'sheet_orders', name: 'Hierarchy', type: 'hierarchy', config: { parentFieldId: ' fld_parent ' } },
      { id: 'view_other_hierarchy', sheetId: 'sheet_other', name: 'Other Hierarchy', type: 'hierarchy', config: { parentFieldId: 'fld_other_parent' } },
    ]

    mountWorkbench()
    await flushUi()

    const managerButtons = Array.from(container!.querySelectorAll('.mt-workbench__mgr-btn')) as HTMLButtonElement[]
    managerButtons.find((button) => button.textContent?.includes('Fields'))?.click()
    await flushUi()

    expect(container!.querySelector('[data-field-manager-hierarchy-parent-ids]')?.getAttribute('data-field-manager-hierarchy-parent-ids'))
      .toBe('fld_parent')
  })

  it('opens sheet access manager and refreshes sheet state after updates', async () => {
    mountWorkbench()
    await flushUi()

    const managerButtons = Array.from(container!.querySelectorAll('.mt-workbench__mgr-btn')) as HTMLButtonElement[]
    managerButtons.find((button) => button.textContent?.includes('Access'))?.click()
    await flushUi()

    expect(container!.querySelector('[data-sheet-permission-manager]')).not.toBeNull()
    expect(container!.querySelector('[data-sheet-permission-manager-sheet-id]')?.getAttribute('data-sheet-permission-manager-sheet-id'))
      .toBe('sheet_orders')

    workbenchMock.loadSheetMeta.mockClear()
    gridMock.loadViewData.mockClear()

    container!.querySelector<HTMLButtonElement>('[data-sheet-permission-updated="true"]')!.click()
    await flushUi()

    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledWith('sheet_orders')
    expect(gridMock.loadViewData).toHaveBeenCalledWith(0)
  })

  it('shows access manager independently from field manager capability', async () => {
    workbenchMock.capabilities.value = {
      canRead: true,
      canCreateRecord: false,
      canEditRecord: false,
      canDeleteRecord: false,
      canManageFields: false,
      canManageSheetAccess: true,
      canManageViews: false,
      canComment: true,
      canManageAutomation: false, canExport: true,
    }

    mountWorkbench()
    await flushUi()

    const managerButtons = Array.from(container!.querySelectorAll('.mt-workbench__mgr-btn')) as HTMLButtonElement[]
    expect(managerButtons.some((button) => button.textContent?.includes('Fields'))).toBe(false)
    expect(managerButtons.some((button) => button.textContent?.includes('Access'))).toBe(true)
  })

  it('shows a workspace role access banner by default', async () => {
    mountWorkbench()
    await flushUi()

    const banner = container!.querySelector('[data-capability-origin-banner="true"]')
    expect(banner).not.toBeNull()
    expect(banner?.getAttribute('data-capability-origin-source')).toBe('global-rbac')
    expect(banner?.textContent).toContain('Workspace role access')
    expect(banner?.textContent).toContain('follows your workspace multitable permissions')
  })

  it('prefers grid capability origin when a sheet grant expands access', async () => {
    workbenchMock.capabilityOrigin.value = {
      source: 'global-rbac',
      hasSheetAssignments: false,
    }
    gridMock.capabilityOrigin.value = {
      source: 'sheet-grant',
      hasSheetAssignments: true,
    }

    mountWorkbench()
    await flushUi()

    const banner = container!.querySelector('[data-capability-origin-banner="true"]')
    expect(banner?.getAttribute('data-capability-origin-source')).toBe('sheet-grant')
    expect(banner?.textContent).toContain('Shared sheet access')
    expect(banner?.textContent).toContain('direct sheet share')
  })

  it('explains which actions are limited when sheet scope narrows access', async () => {
    workbenchMock.capabilityOrigin.value = {
      source: 'sheet-scope',
      hasSheetAssignments: true,
    }
    workbenchMock.capabilities.value = {
      canRead: true,
      canCreateRecord: false,
      canEditRecord: false,
      canDeleteRecord: false,
      canManageFields: false,
      canManageSheetAccess: false,
      canManageViews: true,
      canComment: true,
      canManageAutomation: false, canExport: true,
    }

    mountWorkbench()
    await flushUi()

    const banner = container!.querySelector('[data-capability-origin-banner="true"]')
    expect(banner?.getAttribute('data-capability-origin-source')).toBe('sheet-scope')
    expect(banner?.textContent).toContain('Restricted sheet access')
    expect(banner?.textContent).toContain('record creation, editing, deletion, field changes, and sheet access changes are limited on this sheet')
  })

  it('surfaces create-record validation failures from required-field sheets', async () => {
    gridMock.createRecord.mockImplementation(async () => {
      gridMock.error.value = 'Material Code is required'
    })

    mountWorkbench()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-add-record="true"]')!.click()
    await flushUi()

    expect(gridMock.createRecord).toHaveBeenCalledTimes(1)
    expect(showErrorSpy).toHaveBeenCalledWith('Material Code is required')
  })

  it('shows an explicit admin access banner for administrator contexts', async () => {
    workbenchMock.capabilityOrigin.value = {
      source: 'admin',
      hasSheetAssignments: false,
    }

    mountWorkbench()
    await flushUi()

    const banner = container!.querySelector('[data-capability-origin-banner="true"]')
    expect(banner?.getAttribute('data-capability-origin-source')).toBe('admin')
    expect(banner?.textContent).toContain('Admin access')
    expect(banner?.textContent).toContain('administrator role')
  })

  it('filters readonly fields from import surfaces', async () => {
    workbenchMock.fields.value = [
      { id: 'fld_title', name: 'Title', type: 'string' },
      { id: 'fld_locked', name: 'Locked', type: 'string', property: { readonly: true } },
    ]
    gridMock.fields.value = [...workbenchMock.fields.value]
    workbenchMock.fieldPermissions.value = {
      fld_title: { visible: true, readOnly: false },
      fld_locked: { visible: true, readOnly: true },
    }

    mountWorkbench()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-open-import="true"]')!.click()
    await flushUi()

    expect(container!.querySelector('[data-import-field-ids]')?.getAttribute('data-import-field-ids'))
      .toBe('fld_title')
  })

  it('includes writable sheet fields that are hidden only in the current grid view', async () => {
    workbenchMock.fields.value = [
      { id: 'fld_title', name: 'Title', type: 'string' },
      { id: 'fld_owner_repair', name: 'Owner Repair', type: 'link', property: { refKind: 'user', foreignSheetId: 'sheet_people', limitSingleRecord: true } },
    ]
    gridMock.fields.value = [...workbenchMock.fields.value]
    gridMock.hiddenFieldIds.value = ['fld_owner_repair']
    workbenchMock.fieldPermissions.value = {
      fld_title: { visible: true, readOnly: false },
      fld_owner_repair: { visible: true, readOnly: false },
    }

    mountWorkbench()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-open-import="true"]')!.click()
    await flushUi()

    expect(container!.querySelector('[data-import-field-ids]')?.getAttribute('data-import-field-ids'))
      .toBe('fld_title,fld_owner_repair')
  })

  it('imports duplicate first-field values without implicit dedupe', async () => {
    bulkImportRecordsMock.mockResolvedValue({
      attempted: 2,
      succeeded: 2,
      failed: 0,
      firstError: null,
      failures: [],
    })
    workbenchMock.fields.value = [
      { id: 'fld_title', name: 'Title', type: 'string', order: 1 },
      { id: 'fld_status', name: 'Status', type: 'string', order: 2 },
    ]
    gridMock.fields.value = [...workbenchMock.fields.value]

    mountWorkbench()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-open-import="true"]')!.click()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-import-submit="true"]')!.click()
    await flushUi()

    expect(workbenchMock.client.listRecordSummaries).not.toHaveBeenCalled()
    expect(bulkImportRecordsMock).toHaveBeenCalledTimes(1)
    expect(bulkImportRecordsMock).toHaveBeenCalledWith(expect.objectContaining({
      sheetId: 'sheet_orders',
      viewId: 'view_grid',
      records: [
        { fld_title: 'Alpha', fld_status: 'Open' },
        { fld_title: 'alpha', fld_status: 'Closed' },
      ],
    }))
    expect(showSuccessSpy).toHaveBeenCalledWith('2 records imported', undefined)
  })

  it('localizes workbench import success toast in zh-CN', async () => {
    useLocale().setLocale('zh-CN')
    bulkImportRecordsMock.mockResolvedValue({
      attempted: 2,
      succeeded: 2,
      failed: 0,
      firstError: null,
      failures: [],
    })
    workbenchMock.fields.value = [
      { id: 'fld_title', name: 'Title', type: 'string', order: 1 },
      { id: 'fld_status', name: 'Status', type: 'string', order: 2 },
    ]
    gridMock.fields.value = [...workbenchMock.fields.value]

    mountWorkbench()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-open-import="true"]')!.click()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-import-submit="true"]')!.click()
    await flushUi()

    expect(showSuccessSpy).toHaveBeenCalledWith('2 条记录已导入', undefined)
  })

  // A2 (see the "Export (A2: column/row selection via MetaExportDialog)" block in
  // MultitableWorkbench.vue, ~L3553): the dialog's default row scope is 'all', which now routes
  // through the MASK-PRESERVING BACKEND ROUTE (workbench.client.exportSheet), not the client-side
  // doExportCsv/doExportXlsx this test used to validate directly. exportSheet re-applies the same
  // field_permissions mask server-side, so client-side scoping is no longer "the whole story" for
  // this path — but scopedGridFields (fed into the dialog's `fields` prop and, on confirm, into
  // exportSheet's `fieldIds`) still does the SAME masking (grid.fieldPermissions[id].visible !== false,
  // ~L1347) before the request is ever sent. This test now asserts that surviving client-side
  // contract: the request sent to the backend route only carries the visible field id.
  it('exports only scoped visible grid fields', async () => {
    gridMock.fields.value = [
      { id: 'fld_title', name: 'Title', type: 'string' },
      { id: 'fld_view_hidden', name: 'View Hidden', type: 'string' },
    ]
    gridMock.visibleFields.value = [...gridMock.fields.value]
    gridMock.rows.value = [
      { id: 'rec_1', version: 1, data: { fld_title: 'Alpha', fld_view_hidden: 'Hidden value' } },
    ]
    gridMock.fieldPermissions.value = {
      fld_title: { visible: true, readOnly: false },
      fld_view_hidden: { visible: false, readOnly: false },
    }

    const exportedBlob = new Blob(['Title\nAlpha'], { type: 'text/csv' })
    workbenchMock.client.exportSheet.mockResolvedValue({ blob: exportedBlob, filename: 'sheet_orders.csv' })

    let capturedBlob: Blob | null = null
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const createObjectURLMock = vi.fn((blob: Blob | MediaSource) => {
      capturedBlob = blob as Blob
      return 'blob:multitable-export'
    })
    const revokeObjectURLMock = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURLMock })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURLMock })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      mountWorkbench()
      await flushUi()

      container!.querySelector<HTMLButtonElement>('[data-export-csv="true"]')!.click()
      await flushUi()

      // A2: export buttons now open the export-options dialog (column/row picker);
      // confirm it (defaults = all scoped columns, all rows) to fire the export.
      const confirmBtn = document.body.querySelector<HTMLButtonElement>('.meta-export__btn--primary')
      expect(confirmBtn).not.toBeNull()
      confirmBtn!.click()
      await flushUi()

      expect(workbenchMock.client.exportSheet).toHaveBeenCalledWith({
        sheetId: 'sheet_orders',
        viewId: 'view_grid',
        fieldIds: ['fld_title'],
        format: 'csv',
      })
      expect(createObjectURLMock).toHaveBeenCalledTimes(1)
      expect(capturedBlob).toBe(exportedBlob)
      expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:multitable-export')
    } finally {
      clickSpy.mockRestore()
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
    }
  })

  // G-10 follow-up (owner ruling 2026-07-15, 普通用户面优先显示名称): the export download filename is a
  // normal-user surface. When the backend route returns no Content-Disposition filename, the fallback
  // must be the active sheet's display NAME ('Orders', already in workbench.sheets scope) — never the
  // raw sheet id ('sheet_orders').
  it('export filename fallback uses the sheet display name, not the raw sheet id', async () => {
    workbenchMock.client.exportSheet.mockResolvedValue({
      blob: new Blob(['Title\nAlpha'], { type: 'text/csv' }),
      filename: '',
    })
    const downloads: string[] = []
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:multitable-export') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download)
    })
    try {
      mountWorkbench()
      await flushUi()

      container!.querySelector<HTMLButtonElement>('[data-export-csv="true"]')!.click()
      await flushUi()
      document.body.querySelector<HTMLButtonElement>('.meta-export__btn--primary')!.click()
      await flushUi()

      expect(downloads).toEqual(['Orders.csv'])
    } finally {
      clickSpy.mockRestore()
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
    }
  })

  // G-10 follow-up: the selected-rows client-side export path names BOTH the downloaded file and the
  // xlsx workbook tab after the sheet's display name (previously both were the raw sheet id).
  it('selected-rows xlsx export names the file and the workbook tab after the sheet display name', async () => {
    const downloads: string[] = []
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:multitable-export') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download)
    })
    buildXlsxBufferMock.mockClear()
    try {
      mountWorkbench()
      await flushUi()

      // Select a row (grid multi-select), then open the export dialog and switch to selected+xlsx.
      container!.querySelector<HTMLButtonElement>('[data-select-rows="rec_1"]')!.click()
      await flushUi()
      container!.querySelector<HTMLButtonElement>('[data-export-csv="true"]')!.click()
      await flushUi()
      const selectedRadio = document.body.querySelector<HTMLInputElement>('.meta-export__opt input[value="selected"]')
      expect(selectedRadio).not.toBeNull()
      expect(selectedRadio!.disabled).toBe(false)
      selectedRadio!.click()
      document.body.querySelector<HTMLInputElement>('.meta-export__opt input[value="xlsx"]')!.click()
      await flushUi()
      document.body.querySelector<HTMLButtonElement>('.meta-export__btn--primary')!.click()
      // The xlsx path lazily `import('xlsx')` before building — module loading can take macrotask
      // time, so poll (bounded) rather than relying on microtask flushes alone.
      for (let i = 0; i < 100 && downloads.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        await flushUi()
      }

      expect(downloads).toEqual(['Orders.xlsx'])
      expect(buildXlsxBufferMock).toHaveBeenCalledTimes(1)
      expect(buildXlsxBufferMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ sheetName: 'Orders' }))
    } finally {
      clickSpy.mockRestore()
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
    }
  })

  // G-10 follow-up: bulk-edit failure samples (dialog error + toast, normal-user surfaces) lead with
  // the record's display name resolved from the already-loaded rows ('rec_1' → its Title value
  // 'Alpha'), never the bare record id. The reason string stays raw.
  it('bulk-edit failure samples lead with the record display name, not the raw record id', async () => {
    gridMock.bulkPatch.mockResolvedValue({
      updated: [],
      failed: [{ recordId: 'rec_1', reason: 'locked' }],
    })
    mountWorkbench()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-bulk-edit="true"]')!.click()
    await flushUi()
    // Real MetaBulkEditDialog (teleported): clear mode only needs a field selection to submit.
    const fieldSelect = document.body.querySelector<HTMLSelectElement>('.meta-bulk-edit__select')
    expect(fieldSelect).not.toBeNull()
    fieldSelect!.value = 'fld_title'
    fieldSelect!.dispatchEvent(new Event('change'))
    await flushUi()
    document.body.querySelector<HTMLButtonElement>('.meta-bulk-edit__btn--primary')!.click()
    await flushUi()

    expect(gridMock.bulkPatch).toHaveBeenCalledWith({ fieldId: 'fld_title', value: null, recordIds: ['rec_1'] })
    const errorEl = document.body.querySelector('.meta-bulk-edit__error')
    expect(errorEl?.textContent).toContain('Alpha: locked')
    expect(errorEl?.textContent).not.toContain('rec_1')
    expect(showErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Alpha: locked'))
  })

  it('syncs external base/sheet/view props after mount', async () => {
    const hostState = mountWorkbench()
    await flushUi()

    expect(useMultitableSheetRealtimeMock).toHaveBeenCalledTimes(1)
    expect(useMultitableSheetRealtimeMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      selectedRecordId: expect.any(Object),
      visibleRecordIds: expect.any(Object),
      structuralFieldIds: expect.any(Object),
      reloadCurrentSheetPage: expect.any(Function),
      reloadSelectedRecordContext: expect.any(Function),
      applyRemoteRecordPatch: expect.any(Function),
      mergeRemoteRecord: expect.any(Function),
      removeLocalRecord: expect.any(Function),
    }))

    workbenchMock.syncExternalContext.mockClear()

    hostState.baseId = 'base_sales'
    hostState.sheetId = 'sheet_deals'
    hostState.viewId = 'view_board'
    await flushUi()

    expect(workbenchMock.syncExternalContext).toHaveBeenCalledWith({
      baseId: 'base_sales',
      sheetId: 'sheet_deals',
      viewId: 'view_board',
    })
  })

  it('hydrates local realtime merge handlers with record context', async () => {
    mountWorkbench()
    await flushUi()

    workbenchMock.client.getRecord.mockResolvedValue({
      record: { id: 'rec_1', version: 7, data: { fld_title: 'Remote Alpha' } },
      linkSummaries: { fld_link: [{ id: 'rec_link', label: 'Linked row' }] },
      attachmentSummaries: { fld_files: [{ id: 'att_1', filename: 'brief.txt', mimeType: 'text/plain', size: 10, url: '/x', thumbnailUrl: null, uploadedAt: null }] },
      commentsScope: { targetType: 'meta_record', targetId: 'rec_1', containerType: 'meta_sheet', containerId: 'sheet_orders' },
      fieldPermissions: {},
      viewPermissions: {},
      rowActions: null,
    })

    const realtimeOptions = useMultitableSheetRealtimeMock.mock.calls[0]?.[0] as {
      applyRemoteRecordPatch: (payload: {
        recordId: string
        version?: number
        fieldIds: string[]
        patch: Record<string, unknown>
      }) => Promise<boolean>
      mergeRemoteRecord: (recordId: string) => Promise<boolean>
      removeLocalRecord: (recordId: string) => boolean
    }

    await expect(realtimeOptions.applyRemoteRecordPatch({
      recordId: 'rec_1',
      version: 8,
      fieldIds: ['fld_title'],
      patch: { fld_title: 'Remote cell' },
    })).resolves.toBe(true)
    expect(gridMock.applyRemoteRecordPatch).toHaveBeenCalledWith('rec_1', {
      version: 8,
      patch: { fld_title: 'Remote cell' },
    })
    expect(workbenchMock.client.getRecord).not.toHaveBeenCalled()

    await expect(realtimeOptions.mergeRemoteRecord('rec_1')).resolves.toBe(true)
    expect(workbenchMock.client.getRecord).toHaveBeenCalledWith('rec_1', {
      sheetId: 'sheet_orders',
      viewId: 'view_grid',
    })
    expect(gridMock.mergeRemoteRecord).toHaveBeenCalledWith(
      { id: 'rec_1', version: 7, data: { fld_title: 'Remote Alpha' } },
      expect.objectContaining({
        linkSummaries: { fld_link: [{ id: 'rec_link', label: 'Linked row' }] },
        attachmentSummaries: { fld_files: [expect.objectContaining({ id: 'att_1' })] },
      }),
    )

    expect(realtimeOptions.removeLocalRecord('rec_2')).toBe(true)
    expect(gridMock.removeRemoteRecord).toHaveBeenCalledWith('rec_2')
  })

  it('opens workflow designer with multitable context when automation is enabled', async () => {
    workbenchMock.capabilities.value.canManageAutomation = true
    mountWorkbench()
    await flushUi()

    const workflowButton = Array.from(container!.querySelectorAll('.mt-workbench__mgr-btn')).find((button) =>
      button.textContent?.includes('Workflow'),
    ) as HTMLButtonElement | undefined
    workflowButton?.click()
    await flushUi()

    expect(pushSpy).toHaveBeenCalledWith({
      name: 'workflow-designer',
      query: {
        baseId: 'base_ops',
        sheetId: 'sheet_orders',
        viewId: 'view_grid',
        recordId: undefined,
      },
    })
  })

  it('replays the latest busy external context after form submit settles', async () => {
    workbenchMock.views.value = [
      { id: 'view_form', sheetId: 'sheet_orders', name: 'Form', type: 'form' },
      { id: 'view_gallery', sheetId: 'sheet_orders', name: 'Gallery', type: 'gallery', config: { columns: 3 } },
    ]
    workbenchMock.activeViewId.value = 'view_form'
    gridMock.fields.value = [{ id: 'fld_title', name: 'Title', type: 'text' }]
    const submitDeferred = createDeferred<any>()
    workbenchMock.client.submitForm.mockImplementation(() => submitDeferred.promise)
    workbenchMock.syncExternalContext.mockImplementation(async ({ baseId, sheetId, viewId }: { baseId?: string; sheetId?: string; viewId?: string }) => {
      workbenchMock.activeBaseId.value = baseId ?? ''
      workbenchMock.activeSheetId.value = sheetId ?? ''
      workbenchMock.activeViewId.value = viewId ?? ''
      return true
    })
    const hostState = mountWorkbench({ viewId: 'view_form' })
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-form-submit="true"]')!.click()
    await nextTick()

    const deferredResult = await hostState.workbenchRef.requestExternalContextSync(
      { baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_gallery' },
      { requestId: 'req_busy_replay' },
    )
    expect(deferredResult).toEqual({
      status: 'deferred',
      context: { baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_gallery' },
      reason: 'busy',
      requestId: 'req_busy_replay',
    })
    expect(hostState.externalContextResults).toEqual([])

    submitDeferred.resolve({
      mode: 'update',
      record: { id: 'rec_1', version: 2, data: { fld_title: 'Saved title' } },
      attachmentSummaries: {},
    })
    await flushUi()

    expect(workbenchMock.syncExternalContext).toHaveBeenCalledWith({
      baseId: 'base_ops',
      sheetId: 'sheet_orders',
      viewId: 'view_gallery',
    })
    expect(hostState.externalContextResults).toContainEqual({
      status: 'applied',
      context: { baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_gallery' },
      requestId: 'req_busy_replay',
    })
  })

  it('defers external prop-driven context sync until unsaved drafts are cleared', async () => {
    const hostState = mountWorkbench()
    await flushUi()

    const managerButtons = Array.from(container!.querySelectorAll('.mt-workbench__mgr-btn')) as HTMLButtonElement[]
    managerButtons.find((button) => button.textContent?.includes('Fields'))?.click()
    await flushUi()
    container!.querySelector<HTMLButtonElement>('[data-field-manager-dirty="true"]')!.click()
    await flushUi()

    workbenchMock.syncExternalContext.mockClear()

    hostState.baseId = 'base_sales'
    hostState.sheetId = 'sheet_sales'
    hostState.viewId = 'view_gallery'
    await flushUi()

    expect(workbenchMock.syncExternalContext).not.toHaveBeenCalled()
    expect(showErrorSpy).toHaveBeenCalledWith('Host multitable context changed while unsaved drafts are open. Resolve or discard changes to continue.')

    container!.querySelector<HTMLButtonElement>('[data-field-manager-clean="true"]')!.click()
    await flushUi()

    expect(workbenchMock.syncExternalContext).toHaveBeenCalledWith({
      baseId: 'base_sales',
      sheetId: 'sheet_sales',
      viewId: 'view_gallery',
    })
  })

  it('renders conflict recovery actions and wires reload / retry / dismiss', async () => {
    mountWorkbench()
    await flushUi()

    gridMock.conflict.value = {
      recordId: 'rec_1',
      fieldId: 'fld_title',
      attemptedValue: 'patched',
      message: 'Row changed elsewhere',
      serverVersion: 8,
    }
    gridMock.fields.value = [{ id: 'fld_title', name: 'Title', type: 'string' }]
    gridMock.retryConflict.mockResolvedValue(true)
    await flushUi()

    expect(container?.textContent).toContain('Update conflict')
    expect(container?.textContent).toContain('Title changed elsewhere. Latest version is 8.')

    ;(container?.querySelector('.mt-workbench__conflict-btn') as HTMLButtonElement | null)?.click()
    await flushUi()
    expect(gridMock.reloadCurrentPage).toHaveBeenCalledTimes(1)
    expect(showSuccessSpy).toHaveBeenCalledWith('Loaded the latest row state', undefined)

    ;(container?.querySelector('.mt-workbench__conflict-btn--primary') as HTMLButtonElement | null)?.click()
    await flushUi()
    expect(gridMock.retryConflict).toHaveBeenCalledTimes(1)
    expect(showSuccessSpy).toHaveBeenLastCalledWith('Change reapplied', undefined)

    const dismissButton = Array.from(container?.querySelectorAll('.mt-workbench__conflict-btn') ?? []).find((button) =>
      (button as HTMLButtonElement).textContent?.includes('Dismiss'),
    ) as HTMLButtonElement | undefined
    dismissButton?.click()
    expect(gridMock.dismissConflict).toHaveBeenCalledTimes(1)
  })

  it('shows an error when user base switch fails', async () => {
    mountWorkbench()
    await flushUi()

    workbenchMock.switchBase.mockImplementation(async () => {
      workbenchMock.error.value = 'base switch failed'
      return false
    })

    container!.querySelector<HTMLButtonElement>('[data-select-base="base_sales"]')!.click()
    await flushUi()

    expect(workbenchMock.switchBase).toHaveBeenCalledWith('base_sales')
    expect(showErrorSpy).toHaveBeenCalledWith('base switch failed')
    expect(localStorage.getItem(RECENT_BASES_KEY)).not.toContain('base_sales')
  })

  it('records successful workbench base switches as recent opens', async () => {
    mountWorkbench()
    await flushUi()

    workbenchMock.switchBase.mockImplementation(async (baseId: string) => {
      workbenchMock.activeBaseId.value = baseId
      return true
    })

    container!.querySelector<HTMLButtonElement>('[data-select-base="base_sales"]')!.click()
    await flushUi()

    const recent = JSON.parse(localStorage.getItem(RECENT_BASES_KEY) ?? '[]') as Array<{ baseId: string }>
    expect(recent.map((entry) => entry.baseId)).toEqual(['base_sales', 'base_ops'])
    expect(container!.querySelector('[data-base-picker-order]')?.textContent).toContain('base_sales:normal:recent')
  })

  it('sorts workbench base picker favorites and toggles them without switching base', async () => {
    localStorage.setItem(FAVORITE_BASES_KEY, JSON.stringify(['base_sales']))

    mountWorkbench()
    await flushUi()

    expect(container!.querySelector('[data-base-picker-order]')?.textContent).toBe(
      'base_sales:favorite:stale|base_ops:normal:recent',
    )

    container!.querySelector<HTMLButtonElement>('[data-toggle-favorite-base="base_sales"]')!.click()
    await flushUi()

    expect(workbenchMock.switchBase).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem(FAVORITE_BASES_KEY) ?? '[]')).toEqual([])
    expect(container!.querySelector('[data-base-picker-order]')?.textContent).toBe(
      'base_ops:normal:recent|base_sales:normal:stale',
    )
  })

  it('prompts before switching sheets when context-level drafts are present', async () => {
    mountWorkbench()
    await flushUi()

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const managerButtons = Array.from(container!.querySelectorAll('.mt-workbench__mgr-btn')) as HTMLButtonElement[]
    managerButtons.find((button) => button.textContent?.includes('Fields'))?.click()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-field-manager-dirty="true"]')!.click()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-select-sheet="sheet_sales"]')!.click()
    await flushUi()

    expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved changes before leaving the current sheet or view?')
    expect(workbenchMock.selectSheet).not.toHaveBeenCalled()
  })

  it('creates a new sheet inside the switched base and syncs into the created sheet context', async () => {
    mountWorkbench()
    await flushUi()

    workbenchMock.switchBase.mockImplementation(async (baseId: string) => {
      workbenchMock.activeBaseId.value = baseId
      return true
    })
    workbenchMock.client.createSheet.mockResolvedValue({
      sheet: { id: 'sheet_new', baseId: 'base_sales', name: 'Sheet 2', seeded: true },
    })
    workbenchMock.syncExternalContext.mockResolvedValue(true)

    container!.querySelector<HTMLButtonElement>('[data-select-base="base_sales"]')!.click()
    await flushUi()
    container!.querySelector<HTMLButtonElement>('[data-create-sheet="true"]')!.click()
    await flushUi()

    expect(workbenchMock.client.createSheet).toHaveBeenCalledWith({
      name: 'Sheet 2',
      baseId: 'base_sales',
      seed: true,
    })
    expect(workbenchMock.syncExternalContext).toHaveBeenCalledWith({
      baseId: 'base_sales',
      sheetId: 'sheet_new',
    })
  })

  it('keeps base and sheet creation available when the current sheet is read-only but the user still has global multitable write', async () => {
    workbenchMock.capabilities.value = {
      canRead: true,
      canCreateRecord: false,
      canEditRecord: false,
      canDeleteRecord: false,
      canManageFields: false,
      canManageSheetAccess: false,
      canManageViews: false,
      canComment: true,
      canManageAutomation: false, canExport: true,
    }
    authAccessSnapshot.permissions = ['multitable:write']

    mountWorkbench()
    await flushUi()

    expect(container!.querySelector('[data-create-base="true"]')).not.toBeNull()
    expect(container!.querySelector('[data-create-sheet="true"]')).not.toBeNull()
  })

  it('hides base and sheet creation when global multitable write is absent', async () => {
    workbenchMock.capabilities.value = {
      canRead: true,
      canCreateRecord: false,
      canEditRecord: false,
      canDeleteRecord: false,
      canManageFields: false,
      canManageSheetAccess: false,
      canManageViews: false,
      canComment: true,
      canManageAutomation: false, canExport: true,
    }
    authAccessSnapshot.permissions = ['multitable:read']

    mountWorkbench()
    await flushUi()

    expect(container!.querySelector('[data-create-base="true"]')).toBeNull()
    expect(container!.querySelector('[data-create-sheet="true"]')).toBeNull()
  })

  // #2735 (2026-06-16, "native person/member field") made newly-created person fields
  // first-class native `type:'person'` — sent straight through createField, NOT rewritten to a
  // `link`+refKind:user preset against a system People sheet (see the "Native person (人员, design
  // 2026-06-16)" comment on onCreateField in MultitableWorkbench.vue). preparePersonField / the
  // link-preset path stay intact for existing legacy link-backed person fields, but the create-new
  // path this test drives no longer calls them — coexistence-only, not a revert.
  it('passes native person field creation straight through to createField', async () => {
    mountWorkbench()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-create-person-field="true"]')!.click()
    await flushUi()

    expect(workbenchMock.client.preparePersonField).not.toHaveBeenCalled()
    expect(workbenchMock.client.createField).toHaveBeenCalledWith({
      sheetId: 'sheet_orders',
      name: 'Owner',
      type: 'person',
      property: undefined,
    })
  })

  it('passes native person field manager property overrides straight through to createField', async () => {
    mountWorkbench()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-create-person-field-multi="true"]')!.click()
    await flushUi()

    expect(workbenchMock.client.preparePersonField).not.toHaveBeenCalled()
    expect(workbenchMock.client.createField).toHaveBeenCalledWith({
      sheetId: 'sheet_orders',
      name: 'Approvers',
      type: 'person',
      property: { limitSingleRecord: false },
    })
  })

  it('persists active gallery view config updates through the workbench client', async () => {
    mountWorkbench({ viewId: 'view_gallery' })
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-gallery-config]')!.click()
    await flushUi()

    expect(workbenchMock.client.updateView).toHaveBeenCalledWith('view_gallery', {
      config: {
        titleFieldId: 'fld_title',
        coverFieldId: 'fld_cover',
        fieldIds: ['fld_status'],
        columns: 4,
        cardSize: 'large',
      },
    })
    expect(workbenchMock.loadSheetMeta).toHaveBeenCalled()
    expect(gridMock.loadViewData).toHaveBeenCalled()
  })

  it('passes scoped row edit gating into kanban, timeline, gantt and hierarchy views', async () => {
    workbenchMock.views.value = [
      { id: 'view_kanban', sheetId: 'sheet_orders', name: 'Kanban', type: 'kanban' },
      { id: 'view_timeline', sheetId: 'sheet_orders', name: 'Timeline', type: 'timeline', config: { zoom: 'week' } },
      { id: 'view_gantt', sheetId: 'sheet_orders', name: 'Gantt', type: 'gantt', config: { zoom: 'week' } },
      { id: 'view_hierarchy', sheetId: 'sheet_orders', name: 'Hierarchy', type: 'hierarchy', config: { parentFieldId: 'fld_parent' } },
    ]
    gridMock.rowActions.value = {
      canEdit: false,
      canDelete: true,
      canComment: true,
    }

    mountWorkbench({ viewId: 'view_kanban' })
    await flushUi()

    expect(container!.querySelector('[data-kanban-can-edit]')?.getAttribute('data-kanban-can-edit')).toBe('false')

    workbenchMock.activeViewId.value = 'view_timeline'
    await flushUi()

    expect(container!.querySelector('[data-timeline-can-edit]')?.getAttribute('data-timeline-can-edit')).toBe('false')

    workbenchMock.activeViewId.value = 'view_gantt'
    await flushUi()

    expect(container!.querySelector('[data-gantt-sheet-id]')?.getAttribute('data-gantt-sheet-id')).toBe('sheet_orders')
    expect(container!.querySelector('[data-gantt-can-edit]')?.getAttribute('data-gantt-can-edit')).toBe('false')

    workbenchMock.activeViewId.value = 'view_hierarchy'
    await flushUi()

    expect(container!.querySelector('[data-hierarchy-can-edit]')?.getAttribute('data-hierarchy-can-edit')).toBe('false')
  })

  it('honors forced Gantt mode from direct smoke routes', async () => {
    workbenchMock.views.value = [
      { id: 'view_grid', sheetId: 'sheet_orders', name: 'Grid', type: 'grid' },
    ]

    mountWorkbench({ viewId: 'view_grid', mode: 'gantt' })
    await flushUi()

    expect(container!.querySelector('[data-gantt-sheet-id]')?.getAttribute('data-gantt-sheet-id')).toBe('sheet_orders')
    expect(container!.querySelector('[data-select-record="rec_1"]')).toBeNull()
  })

  it('patches timeline date updates through patchRecords and refreshes the active page', async () => {
    mountWorkbench({ viewId: 'view_timeline' })
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-timeline-patch="true"]')!.click()
    await flushUi()

    expect(workbenchMock.client.patchRecords).toHaveBeenCalledWith({
      sheetId: 'sheet_orders',
      viewId: 'view_timeline',
      changes: [
        { recordId: 'rec_1', fieldId: 'fld_start', value: '2026-03-25', expectedVersion: 3 },
        { recordId: 'rec_1', fieldId: 'fld_end', value: '2026-03-27', expectedVersion: 3 },
      ],
    })
    expect(gridMock.loadViewData).toHaveBeenCalled()
    expect(showSuccessSpy).toHaveBeenCalledWith('Dates updated', undefined)
  })

  it('patches gantt resize date updates through patchRecords and refreshes the active page', async () => {
    workbenchMock.views.value = [
      ...workbenchMock.views.value,
      { id: 'view_gantt', sheetId: 'sheet_orders', name: 'Gantt', type: 'gantt', config: { zoom: 'week' } },
    ]

    mountWorkbench({ viewId: 'view_gantt' })
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-gantt-patch="true"]')!.click()
    await flushUi()

    expect(workbenchMock.client.patchRecords).toHaveBeenCalledWith({
      sheetId: 'sheet_orders',
      viewId: 'view_gantt',
      changes: [
        { recordId: 'rec_1', fieldId: 'fld_start', value: '2026-04-01', expectedVersion: 4 },
        { recordId: 'rec_1', fieldId: 'fld_end', value: '2026-04-04', expectedVersion: 4 },
      ],
    })
    expect(gridMock.loadViewData).toHaveBeenCalled()
    expect(showSuccessSpy).toHaveBeenCalledWith('Dates updated', undefined)
  })

  it('patches hierarchy reparent updates through patchRecords and refreshes the active page', async () => {
    workbenchMock.views.value = [
      ...workbenchMock.views.value,
      { id: 'view_hierarchy', sheetId: 'sheet_orders', name: 'Hierarchy', type: 'hierarchy', config: { parentFieldId: 'fld_parent' } },
    ]

    mountWorkbench({ viewId: 'view_hierarchy' })
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-hierarchy-reparent="true"]')!.click()
    await flushUi()

    expect(workbenchMock.client.patchRecords).toHaveBeenCalledWith({
      sheetId: 'sheet_orders',
      viewId: 'view_hierarchy',
      changes: [
        { recordId: 'rec_1', fieldId: 'fld_parent', value: ['rec_parent'], expectedVersion: 5 },
      ],
    })
    expect(gridMock.loadViewData).toHaveBeenCalled()
    expect(showSuccessSpy).toHaveBeenCalledWith('Hierarchy updated', undefined)
  })

  it('blocks timeline patch updates when scoped rowActions disallow edits', async () => {
    gridMock.rowActions.value = {
      canEdit: false,
      canDelete: true,
      canComment: true,
    }

    mountWorkbench({ viewId: 'view_timeline' })
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-timeline-patch="true"]')!.click()
    await flushUi()

    expect(workbenchMock.client.patchRecords).not.toHaveBeenCalled()
    expect(gridMock.loadViewData).not.toHaveBeenCalled()
    expect(showErrorSpy).toHaveBeenCalledWith('Record editing is not allowed for this row.')
  })

  it('blocks form submit updates when scoped rowActions disallow edits', async () => {
    workbenchMock.views.value = [
      { id: 'view_form', sheetId: 'sheet_orders', name: 'Form', type: 'form' },
    ]
    workbenchMock.activeViewId.value = 'view_form'
    gridMock.rowActions.value = {
      canEdit: false,
      canDelete: false,
      canComment: true,
    }

    mountWorkbench({ viewId: 'view_form', recordId: 'rec_1' })
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-form-submit="true"]')!.click()
    await flushUi()

    expect(workbenchMock.client.submitForm).not.toHaveBeenCalled()
    expect(showErrorSpy).toHaveBeenCalledWith('Record editing is not allowed for this row.')
  })

  it('prompts before switching records when record-scoped drafts are present', async () => {
    mountWorkbench()
    await flushUi()

    // Record inspector v3 (2026-09-05, PR-A §1.1): plain `select-record` no longer opens the
    // inspector (W2 lock §3.1 erratum) — `expand-record` (the row-number icon in the real grid) is
    // this stub's explicit-open equivalent.
    container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
    await flushUi()
    container!.querySelector<HTMLButtonElement>('[data-toggle-comments="true"]')!.click()
    await flushUi()
    container!.querySelector<HTMLButtonElement>('[data-set-comment-draft="true"]')!.click()
    await flushUi()

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    container!.querySelector<HTMLButtonElement>('[data-select-record="rec_2"]')!.click()
    await flushUi()

    expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved record changes?')
    expect(container!.querySelector('[data-record-drawer="rec_1"]')).toBeTruthy()
    expect(container!.querySelector('[data-record-drawer="rec_2"]')).toBeNull()
  })

  it('prefers server-provided commentsScope when a deep-linked record is loaded', async () => {
    workbenchMock.client.getRecord.mockResolvedValue({
      sheet: { id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', fieldOrder: [] },
      fields: [],
      record: { id: 'rec_remote', version: 4, data: { fld_title: 'Remote' } },
      capabilities: {
        canRead: true,
        canCreateRecord: true,
        canEditRecord: true,
        canDeleteRecord: true,
        canManageFields: true,
        canManageSheetAccess: true,
        canManageViews: true,
        canComment: true,
        canManageAutomation: false, canExport: true,
      },
      commentsScope: {
        containerType: 'meta_sheet',
        containerId: 'sheet_orders',
        targetType: 'meta_record',
        targetId: 'rec_remote',
        targetFieldId: 'fld_notes',
      },
      linkSummaries: {},
      attachmentSummaries: {},
    })
    mountWorkbench({ recordId: 'rec_remote' })
    await flushUi(8)

    expect(loadCommentsSpy).toHaveBeenCalledWith({
      containerType: 'meta_sheet',
      containerId: 'sheet_orders',
      targetType: 'meta_record',
      targetId: 'rec_remote',
      targetFieldId: 'fld_notes',
    })

    container!.querySelector<HTMLButtonElement>('[data-toggle-comments="true"]')!.click()
    await flushUi()
    expect(container!.querySelector('[data-current-comment-field="fld_notes"]')).toBeTruthy()
    container!.querySelector<HTMLButtonElement>('[data-submit-comment="true"]')!.click()
    await flushUi()

    expect(addCommentSpy).toHaveBeenCalledWith({
      containerType: 'meta_sheet',
      containerId: 'sheet_orders',
      targetType: 'meta_record',
      targetId: 'rec_remote',
      targetFieldId: 'fld_notes',
      content: 'Need review',
      mentions: [],
    })
  })

  it('loads comment mention suggestions for the active sheet when opening comments', async () => {
    mountWorkbench()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-open-comments="rec_1"]')!.click()
    await flushUi()

    expect(workbenchMock.client.listCommentMentionSuggestions).toHaveBeenCalledWith({
      spreadsheetId: 'sheet_orders',
      limit: 100,
    })
    expect(container!.querySelector('[data-mention-suggestions-count="1"]')).not.toBeNull()
  })

  it('applies route-provided fieldId when opening a deep-linked comment thread', async () => {
    gridMock.fields.value = [{ id: 'fld_notes', name: 'Notes', type: 'text' }]
    workbenchMock.client.getRecord.mockResolvedValueOnce({
      record: { id: 'rec_remote', version: 3, data: { fld_notes: 'Existing note' } },
      commentsScope: {
        containerType: 'meta_sheet',
        containerId: 'sheet_orders',
        targetType: 'meta_record',
        targetId: 'rec_remote',
      },
      linkSummaries: {},
      attachmentSummaries: {},
    })

    mountWorkbench({ recordId: 'rec_remote', commentId: 'c_route', fieldId: 'fld_notes', openComments: true })
    await flushUi(8)

    expect(container!.querySelector('[data-current-comment-field="fld_notes"]')).not.toBeNull()

    container!.querySelector<HTMLButtonElement>('[data-submit-comment="true"]')!.click()
    await flushUi()

    expect(addCommentSpy).toHaveBeenCalledWith(expect.objectContaining({
      targetId: 'rec_remote',
      targetFieldId: 'fld_notes',
      content: 'Need review',
      mentions: [],
    }))
  })

  it('derives field context from a highlighted reply when the deep link omits fieldId', async () => {
    gridMock.fields.value = [{ id: 'fld_notes', name: 'Notes', type: 'text' }]
    loadCommentsSpy.mockImplementation(async () => {
      commentsStateMock.comments.value = [
        {
          id: 'c_root',
          containerId: 'sheet_orders',
          targetId: 'rec_remote',
          fieldId: 'fld_notes',
          targetFieldId: 'fld_notes',
          mentions: [],
          authorId: 'user_2',
          content: 'Field thread root',
          resolved: false,
          createdAt: '2026-04-01T09:00:00.000Z',
        },
        {
          id: 'c_reply',
          containerId: 'sheet_orders',
          targetId: 'rec_remote',
          fieldId: null,
          targetFieldId: null,
          parentId: 'c_root',
          mentions: [],
          authorId: 'user_3',
          content: 'Reply in the same thread',
          resolved: false,
          createdAt: '2026-04-01T10:00:00.000Z',
        },
      ]
    })
    workbenchMock.client.getRecord.mockResolvedValueOnce({
      record: { id: 'rec_remote', version: 3, data: { fld_notes: 'Existing note' } },
      commentsScope: {
        containerType: 'meta_sheet',
        containerId: 'sheet_orders',
        targetType: 'meta_record',
        targetId: 'rec_remote',
      },
      linkSummaries: {},
      attachmentSummaries: {},
    })

    mountWorkbench({ recordId: 'rec_remote', commentId: 'c_reply', openComments: true })
    await flushUi(10)

    expect(loadCommentsSpy).toHaveBeenCalled()
    expect(container!.querySelector('[data-current-comment-field="fld_notes"]')).not.toBeNull()
  })

  it('submits field-scoped replies with targetFieldId and parentId', async () => {
    gridMock.fields.value = [{ id: 'fld_title', name: 'Title', type: 'string' }]
    mountWorkbench()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-open-field-comments="rec_1/fld_title"]')!.click()
    await flushUi()
    container!.querySelector<HTMLButtonElement>('[data-reply-comment="comment_parent_1"]')!.click()
    await flushUi()
    container!.querySelector<HTMLButtonElement>('[data-submit-comment="true"]')!.click()
    await flushUi()

    expect(addCommentSpy).toHaveBeenCalledWith({
      targetType: 'meta_record',
      targetId: 'rec_1',
      baseId: 'base_ops',
      sheetId: 'sheet_orders',
      viewId: 'view_grid',
      recordId: 'rec_1',
      containerType: 'meta_sheet',
      containerId: 'sheet_orders',
      targetFieldId: 'fld_title',
      content: 'Need review',
      mentions: [],
      parentId: 'comment_parent_1',
    })
  })

  // W2 S4 (OD-W2-7=b): comments no longer has its own close chrome distinct from the inspector's —
  // the two pre-S4 tests that lived here ("prompts before closing the comments drawer.../localizes
  // the unsaved comment draft confirm copy in zh-CN") pinned a `data-close-comments` affordance that
  // no longer exists (see onToggleComments' own doc comment in MultitableWorkbench.vue). Replaced
  // with a test documenting the new behavior: re-clicking the comment-toggle button while a draft is
  // pending does NOT prompt (there is nothing to "close" anymore — see the surviving
  // "prompts before closing the record drawer..." test below for where the comment-draft-discard
  // guard now lives, `hasRecordScopedDrafts` already folds in `hasCommentDraft`).
  it('re-clicking the comment-toggle button while a draft is pending does not prompt (no more close-comments-only affordance)', async () => {
    mountWorkbench()
    await flushUi()

    // Record inspector v3 (2026-09-05, PR-A §1.1): `expand-record` is this stub's explicit-open
    // equivalent — plain `select-record` no longer opens the inspector.
    container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
    await flushUi()
    container!.querySelector<HTMLButtonElement>('[data-toggle-comments="true"]')!.click()
    await flushUi()
    container!.querySelector<HTMLButtonElement>('[data-set-comment-draft="true"]')!.click()
    await flushUi()

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    container!.querySelector<HTMLButtonElement>('[data-toggle-comments="true"]')!.click()
    await flushUi()

    expect(confirmSpy).not.toHaveBeenCalled()
    // The record drawer (whole inspector) is still open — only the whole-inspector close (below)
    // guards a comment draft now.
    expect(container!.querySelector('[data-record-drawer="rec_1"]')).toBeTruthy()
  })

  it('prompts before closing the record drawer when record-scoped drafts are present', async () => {
    mountWorkbench()
    await flushUi()

    // Record inspector v3 (2026-09-05, PR-A §1.1): `expand-record` is this stub's explicit-open
    // equivalent — plain `select-record` no longer opens the inspector.
    container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
    await flushUi()
    container!.querySelector<HTMLButtonElement>('[data-toggle-comments="true"]')!.click()
    await flushUi()
    container!.querySelector<HTMLButtonElement>('[data-set-comment-draft="true"]')!.click()
    await flushUi()

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    container!.querySelector<HTMLButtonElement>('[data-close-drawer="true"]')!.click()
    await flushUi()

    expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved record changes?')
    expect(container!.querySelector('[data-record-drawer="rec_1"]')).toBeTruthy()
  })

  it('refreshes sheet metadata while the view manager is open and stops after close', async () => {
    vi.useFakeTimers()
    mountWorkbench()
    await flushUi()

    workbenchMock.loadSheetMeta.mockClear()

    const managerButtons = Array.from(container!.querySelectorAll('.mt-workbench__mgr-btn')) as HTMLButtonElement[]
    managerButtons.find((button) => button.textContent?.includes('Views'))?.click()
    await flushUi()

    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(1)
    expect(workbenchMock.loadSheetMeta).toHaveBeenLastCalledWith('sheet_orders')

    await vi.advanceTimersByTimeAsync(1200)
    await flushUi()

    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(2)
    expect(workbenchMock.loadSheetMeta).toHaveBeenLastCalledWith('sheet_orders')

    container!.querySelector<HTMLButtonElement>('[data-close-view-manager="true"]')!.click()
    await flushUi()
    workbenchMock.loadSheetMeta.mockClear()

    await vi.advanceTimersByTimeAsync(2400)
    await flushUi()

    expect(workbenchMock.loadSheetMeta).not.toHaveBeenCalled()
  })

  it('restarts dialog metadata refresh immediately when the active sheet changes mid-refresh', async () => {
    vi.useFakeTimers()
    const firstRefresh = createDeferred<boolean>()
    workbenchMock.loadSheetMeta.mockImplementationOnce(() => firstRefresh.promise)
    mountWorkbench()
    await flushUi()

    workbenchMock.loadSheetMeta.mockClear()

    const managerButtons = Array.from(container!.querySelectorAll('.mt-workbench__mgr-btn')) as HTMLButtonElement[]
    managerButtons.find((button) => button.textContent?.includes('Views'))?.click()
    await flushUi()

    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(1)
    expect(workbenchMock.loadSheetMeta).toHaveBeenLastCalledWith('sheet_orders')

    workbenchMock.activeSheetId.value = 'sheet_sales'
    await flushUi()
    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(1)

    firstRefresh.resolve(true)
    await flushUi()

    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(2)
    expect(workbenchMock.loadSheetMeta).toHaveBeenLastCalledWith('sheet_sales')
  })

  it('blocks beforeunload when a child component reports unsaved drafts', async () => {
    mountWorkbench({ viewId: 'view_grid' })
    await flushUi()

    const managerButtons = Array.from(container!.querySelectorAll('.mt-workbench__mgr-btn')) as HTMLButtonElement[]
    managerButtons.find((button) => button.textContent?.includes('Fields'))?.click()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-field-manager-dirty="true"]')!.click()
    await flushUi()

    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    Object.defineProperty(event, 'returnValue', {
      value: undefined,
      writable: true,
      configurable: true,
    })
    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(event.returnValue).toBe('')
  })

  it('blocks beforeunload when the import modal reports an unsaved draft', async () => {
    mountWorkbench()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-open-import="true"]')!.click()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-import-dirty="true"]')!.click()
    await flushUi()

    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    Object.defineProperty(event, 'returnValue', {
      value: undefined,
      writable: true,
      configurable: true,
    })
    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(event.returnValue).toBe('')
  })

  it('shows a mention chip only when unresolved mentions exist', async () => {
    mountWorkbench()
    await flushUi()

    expect(mentionInboxSummaryMock.loadSummary).toHaveBeenCalledWith({ spreadsheetId: 'sheet_orders' })
    expect(container!.querySelector('.mt-workbench__mention-chip')).toBeNull()

    mentionInboxSummaryMock.summary.value = {
      spreadsheetId: 'sheet_orders',
      unresolvedMentionCount: 3,
      unreadMentionCount: 2,
      mentionedRecordCount: 2,
      unreadRecordCount: 1,
      items: [{ rowId: 'rec_1', mentionedCount: 3, unreadCount: 2, mentionedFieldIds: ['fld_title'] }],
    }
    await flushUi()

    const chip = container!.querySelector('.mt-workbench__mention-chip')
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toContain('Mentions')
    expect(chip!.textContent).toContain('2')
  })

  it('shows an active collaborator chip when other users are viewing the same sheet', async () => {
    mountWorkbench()
    await flushUi()

    expect(container!.querySelector('.mt-workbench__presence-chip')).toBeNull()

    sheetPresenceStateMock.activeCollaborators.value = [{ id: 'user_a' }, { id: 'user_b' }]
    await flushUi()

    const chip = container!.querySelector<HTMLDivElement>('.mt-workbench__presence-chip')
    expect(chip).not.toBeNull()
    expect(chip?.textContent).toContain('2')
    expect(chip?.textContent).toContain('active collaborators')
    expect(chip?.getAttribute('title')).toBe('Active now: user_a, user_b')
  })

  it('shows a persistent comment inbox entry and routes to the inbox view', async () => {
    mountWorkbench()
    await flushUi()

    const inboxButton = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Comment Inbox'))

    expect(inboxButton).not.toBeNull()
    expect(inboxButton?.getAttribute('title')).toBe('Open comment inbox')

    inboxButton?.click()
    await flushUi()

    expect(pushSpy).toHaveBeenCalledWith({
      name: 'multitable-comment-inbox',
    })
  })

  it('shows unread attention on the persistent comment inbox entry', async () => {
    mountWorkbench()
    await flushUi()

    commentInboxStateMock.unreadCount.value = 2
    await flushUi()

    const inboxButton = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Comment Inbox'))

    expect(inboxButton).not.toBeNull()
    expect(inboxButton?.textContent).toContain('2')
    expect(inboxButton?.className).toContain('mt-workbench__mgr-btn--attention')
    expect(inboxButton?.getAttribute('title')).toBe('2 comment updates need attention')
  })

  it('does not show inbox attention when only mention summary remains unread-free', async () => {
    mountWorkbench()
    await flushUi()

    mentionInboxSummaryMock.summary.value = {
      spreadsheetId: 'sheet_orders',
      unresolvedMentionCount: 3,
      unreadMentionCount: 0,
      mentionedRecordCount: 2,
      unreadRecordCount: 0,
      items: [{ rowId: 'rec_1', mentionedCount: 3, unreadCount: 0, mentionedFieldIds: ['fld_title'] }],
    }
    commentInboxStateMock.unreadCount.value = 0
    await flushUi()

    const inboxButton = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Comment Inbox'))

    expect(inboxButton).not.toBeNull()
    expect(inboxButton?.textContent).not.toContain('3')
    expect(inboxButton?.className).not.toContain('mt-workbench__mgr-btn--attention')
    expect(inboxButton?.getAttribute('title')).toBe('Open comment inbox')
  })

  it('opens the mention popover and selects a mentioned record', async () => {
    mountWorkbench()
    await flushUi()

    mentionInboxSummaryMock.summary.value = {
      spreadsheetId: 'sheet_orders',
      unresolvedMentionCount: 1,
      unreadMentionCount: 1,
      mentionedRecordCount: 1,
      unreadRecordCount: 1,
      items: [{ rowId: 'rec_2', mentionedCount: 1, unreadCount: 1, mentionedFieldIds: ['fld_title'] }],
    }
    await flushUi()

    container!.querySelector<HTMLButtonElement>('.mt-workbench__mention-chip')!.click()
    await flushUi()

    expect(container!.querySelector('[data-mention-popover="true"]')).not.toBeNull()

    container!.querySelector<HTMLButtonElement>('[data-mention-popover-select="rec_2"]')!.click()
    await flushUi()

    expect(loadCommentsSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      containerId: 'sheet_orders',
      targetId: 'rec_2',
    }))
    expect(mentionInboxSummaryMock.markRead).toHaveBeenCalledWith({ spreadsheetId: 'sheet_orders' })
  })

  // T2 i18n: real Workbench locale render assertions (unblocked by the
  // jsdom-localStorage baseline fix). Targets are only buttons that the
  // DEFAULT workbenchMock renders: Fields/Access/Views (caps default true)
  // + Comment Inbox/Dashboard/API & Webhooks (no capability gate).
  // Workflow/Automations are excluded — canManageAutomation defaults false.
  it('renders the workbench toolbar in zh-CN when locale is zh-CN', async () => {
    useLocale().setLocale('zh-CN')
    mountWorkbench()
    await nextTick()
    const text = container!.textContent ?? ''
    for (const s of ['字段', '权限', '视图', '评论收件箱', '仪表盘', 'API 与 Webhook']) {
      expect(text, `missing zh string: ${s}`).toContain(s)
    }
    expect(text).not.toContain('Comment Inbox')
  })

  it('renders the workbench toolbar in English when locale is en', async () => {
    useLocale().setLocale('en')
    mountWorkbench()
    await nextTick()
    const text = container!.textContent ?? ''
    for (const s of ['Fields', 'Access', 'Views', 'Comment Inbox', 'Dashboard', 'API & Webhooks']) {
      expect(text, `missing en string: ${s}`).toContain(s)
    }
    expect(text).not.toContain('评论收件箱')
  })

  // ----------------------------------------------------------------------------
  // persist-display-prefs (2026-06-16): column width / row density / group
  // collapse now persist into view.config via client.updateView. KEYSTONE: every
  // write must spread the FULL existing config (backend whole-replaces config), so
  // these tests seed sibling keys (frozen + aggregations) and assert they SURVIVE.
  // ----------------------------------------------------------------------------
  describe('display-prefs persistence (view.config)', () => {
    function seedGridConfig(config: Record<string, unknown>) {
      // view_grid is the default active view; give it a config with sibling keys.
      workbenchMock.views.value = workbenchMock.views.value.map((v: { id: string }) =>
        v.id === 'view_grid' ? { ...v, config } : v,
      )
    }
    const SIBLINGS = { frozenLeftColumnIds: ['fld_title'], aggregations: { fld_qty: 'sum' } }

    it('row density: persists rowDensity AND preserves sibling config keys', async () => {
      seedGridConfig({ ...SIBLINGS })
      mountWorkbench()
      await flushUi()
      container!.querySelector<HTMLButtonElement>('[data-set-row-density="compact"]')!.click()
      await flushUi()

      expect(workbenchMock.client.updateView).toHaveBeenCalledTimes(1)
      const [viewId, body] = workbenchMock.client.updateView.mock.calls[0]
      expect(viewId).toBe('view_grid')
      expect(body.config).toEqual({ ...SIBLINGS, rowDensity: 'compact' })
      // pure-display path: no row refetch
      expect(gridMock.loadViewData).not.toHaveBeenCalled()
      // background refresh so the next merge sees this write
      expect(workbenchMock.loadSheetMeta).toHaveBeenCalled()
      // optimistic-local: toolbar reflects the new density immediately
      expect(container!.querySelector('[data-toolbar-row-density]')?.getAttribute('data-toolbar-row-density')).toBe('compact')
    })

    it('group collapse: persists scoped {fieldId, fieldIds, collapsedKeys} AND preserves siblings', async () => {
      seedGridConfig({ ...SIBLINGS })
      // nested grouping: collapse is scoped to the ORDERED group field ids (single-level here)
      gridMock.groupFieldId.value = 'fld_status'
      gridMock.groupFieldIds.value = ['fld_status']
      mountWorkbench()
      await flushUi()
      container!.querySelector<HTMLButtonElement>('[data-toggle-group="todo"]')!.click()
      await flushUi()

      expect(workbenchMock.client.updateView).toHaveBeenCalledTimes(1)
      const body = workbenchMock.client.updateView.mock.calls[0][1]
      // persists the ordered fieldIds[] (new, scope guard) + legacy fieldId (level-1, back-compat)
      expect(body.config).toEqual({ ...SIBLINGS, groupCollapse: { fieldId: 'fld_status', fieldIds: ['fld_status'], collapsedKeys: ['todo'] } })
      // optimistic-local: the controlled prop fed back to the grid reflects the collapse
      expect(container!.querySelector('[data-grid-collapsed-keys]')?.getAttribute('data-grid-collapsed-keys')).toBe('["todo"]')
    })

    it('column width: ONE debounced server write per drag, preserving siblings', async () => {
      vi.useFakeTimers()
      seedGridConfig({ ...SIBLINGS })
      mountWorkbench()
      await flushUi()
      // Simulate a drag: three resize emits in quick succession.
      const resizeBtn = container!.querySelector<HTMLButtonElement>('[data-resize-column="fld_title"]')!
      resizeBtn.click(); resizeBtn.click(); resizeBtn.click()
      await flushUi()
      // Before the debounce elapses: no PATCH yet, but the grid prop already shows the width (instant).
      expect(workbenchMock.client.updateView).not.toHaveBeenCalled()
      expect(container!.querySelector('[data-grid-column-widths]')?.getAttribute('data-grid-column-widths')).toBe('{"fld_title":222}')
      // Advance past the debounce → exactly one trailing write.
      vi.advanceTimersByTime(500)
      await flushUi()
      expect(workbenchMock.client.updateView).toHaveBeenCalledTimes(1)
      const body = workbenchMock.client.updateView.mock.calls[0][1]
      expect(body.config).toEqual({ ...SIBLINGS, columnWidths: { fld_title: 222 } })
      vi.useRealTimers()
    })

    it('column width: a pending drag does NOT persist after switching views (no cross-view write)', async () => {
      vi.useFakeTimers()
      seedGridConfig({ ...SIBLINGS })
      mountWorkbench()
      await flushUi()
      // Arm the debounce on view_grid...
      container!.querySelector<HTMLButtonElement>('[data-resize-column="fld_title"]')!.click()
      await flushUi()
      // ...then switch views BEFORE the debounce elapses.
      workbenchMock.activeViewId.value = 'view_gallery'
      await flushUi()
      vi.advanceTimersByTime(500)
      await flushUi()
      // The armed timer must bail on the view change: neither view gets a width PATCH.
      expect(workbenchMock.client.updateView).not.toHaveBeenCalled()
      vi.useRealTimers()
    })

    it('survives reload: seeded config re-derives the display-pref props (no interaction)', async () => {
      // legacy single-field groupCollapse (no fieldIds) still applies when grouping by that one field
      seedGridConfig({
        ...SIBLINGS,
        rowDensity: 'expanded',
        columnWidths: { fld_title: 333 },
        groupCollapse: { fieldId: 'fld_status', collapsedKeys: ['done'] },
      })
      gridMock.groupFieldId.value = 'fld_status'
      gridMock.groupFieldIds.value = ['fld_status']
      mountWorkbench()
      await flushUi()
      expect(container!.querySelector('[data-toolbar-row-density]')?.getAttribute('data-toolbar-row-density')).toBe('expanded')
      expect(container!.querySelector('[data-grid-column-widths]')?.getAttribute('data-grid-column-widths')).toBe('{"fld_title":333}')
      expect(container!.querySelector('[data-grid-collapsed-keys]')?.getAttribute('data-grid-collapsed-keys')).toBe('["done"]')
    })

    it('stale-key guard: a collapse set authored on another field does NOT apply after regroup', async () => {
      seedGridConfig({ groupCollapse: { fieldId: 'fld_other', collapsedKeys: ['x'] } })
      gridMock.groupFieldId.value = 'fld_status' // grouped by a DIFFERENT field than the saved set
      gridMock.groupFieldIds.value = ['fld_status']
      mountWorkbench()
      await flushUi()
      expect(container!.querySelector('[data-grid-collapsed-keys]')?.getAttribute('data-grid-collapsed-keys')).toBe('[]')
    })

    it('stale-key guard (nested): a collapse set authored on a DIFFERENT ordered field list does NOT apply', async () => {
      // composite keys are only valid under the exact ordered fieldIds they were authored on; a reorder
      // (or different second level) must invalidate them so the wrong groups never collapse.
      seedGridConfig({ groupCollapse: { fieldId: 'fld_status', fieldIds: ['fld_status', 'fld_region'], collapsedKeys: ['todo\u001feast'] } })
      gridMock.groupFieldId.value = 'fld_status'
      gridMock.groupFieldIds.value = ['fld_status', 'fld_city'] // same level-0, DIFFERENT level-1
      mountWorkbench()
      await flushUi()
      expect(container!.querySelector('[data-grid-collapsed-keys]')?.getAttribute('data-grid-collapsed-keys')).toBe('[]')
    })

    it('nested collapse: a composite-key set authored on the SAME ordered field list DOES apply', async () => {
      seedGridConfig({ groupCollapse: { fieldId: 'fld_status', fieldIds: ['fld_status', 'fld_region'], collapsedKeys: ['todo\u001feast'] } })
      gridMock.groupFieldId.value = 'fld_status'
      gridMock.groupFieldIds.value = ['fld_status', 'fld_region'] // exact same ordered list
      mountWorkbench()
      await flushUi()
      expect(container!.querySelector('[data-grid-collapsed-keys]')?.getAttribute('data-grid-collapsed-keys')).toBe('["todo\\u001feast"]')
    })

    it('backward-compat: absent config yields current defaults (normal density, no widths, no collapse)', async () => {
      seedGridConfig({}) // empty config — pre-arc state
      mountWorkbench()
      await flushUi()
      expect(container!.querySelector('[data-toolbar-row-density]')?.getAttribute('data-toolbar-row-density')).toBe('normal')
      expect(container!.querySelector('[data-grid-column-widths]')?.getAttribute('data-grid-column-widths')).toBe('{}')
      expect(container!.querySelector('[data-grid-collapsed-keys]')?.getAttribute('data-grid-collapsed-keys')).toBe('[]')
    })
  })

  // UI-P2-2b (design docs/development/multitable-ui-p2-2b-vertical-tree-design-20260713.md §2.1/§3.1,
  // §8.2-T7): the rail is now a persistent collapsible <aside> wrapping the base-bar + the
  // MetaSheetViewRail tree (mocked above). Collapse is a workbench-local `railCollapsed` ref — v-show
  // hides both the rail-stub and the base-bar (display:none => unfocusable/unclickable/out of the a11y
  // tree, directly assertable via style.display in jsdom). Count-conservation across the round-trip is
  // already covered by meta-sheet-view-rail.spec.ts's own T3 (this component is mocked here); T7 only
  // proves the workbench-level collapse wiring itself.
  describe('UI-P2-2b — rail collapse (T7)', () => {
    function railStubRoot(): HTMLElement {
      const rail = container!.querySelector('.mt-workbench__rail') as HTMLElement
      expect(rail).toBeTruthy()
      // rail-head (base-bar + toggle) is always the first child; the MetaSheetViewRail stub is the
      // second — structurally stable regardless of whether the base-bar itself is v-if-rendered.
      return rail.children[1] as HTMLElement
    }

    it('defaults to expanded: rail stub and base-bar are visible, toggle aria-expanded=true', async () => {
      mountWorkbench()
      await flushUi()
      const toggle = container!.querySelector('[data-testid="rail-collapse-toggle"]') as HTMLButtonElement
      expect(toggle).toBeTruthy()
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(railStubRoot().style.display).not.toBe('none')
      const baseBar = container!.querySelector('.mt-workbench__base-bar') as HTMLElement | null
      expect(baseBar).toBeTruthy() // listBases() mock resolves 2 bases -> basePickerBases.length > 0
      expect(baseBar!.style.display).not.toBe('none')
    })

    it('clicking the collapse toggle hides the rail stub AND the base-bar (display:none), flips aria-expanded to false', async () => {
      mountWorkbench()
      await flushUi()
      const toggle = container!.querySelector('[data-testid="rail-collapse-toggle"]') as HTMLButtonElement
      toggle.click()
      await flushUi()
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(railStubRoot().style.display).toBe('none')
      const baseBar = container!.querySelector('.mt-workbench__base-bar') as HTMLElement
      expect(baseBar.style.display).toBe('none')
    })

    it('clicking again restores the rail stub and base-bar to visible (round-trip)', async () => {
      mountWorkbench()
      await flushUi()
      const toggle = container!.querySelector('[data-testid="rail-collapse-toggle"]') as HTMLButtonElement
      toggle.click()
      await flushUi()
      toggle.click()
      await flushUi()
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(railStubRoot().style.display).not.toBe('none')
      const baseBar = container!.querySelector('.mt-workbench__base-bar') as HTMLElement
      expect(baseBar.style.display).not.toBe('none')
    })
  })

  // UI-P2-2c (design docs/development/multitable-ui-p2-2c-responsive-design-20260714.md §6): the rail
  // auto-collapses below RAIL_NARROW_BREAKPOINT (768px, window.innerWidth) and, if the user re-expands it
  // while narrow, becomes an absolute-positioned "drawer" overlay (`.mt-workbench__rail--drawer`) instead
  // of squeezing .mt-workbench__main. These are STATE assertions (classes/attributes/focus), not CSS/
  // layout assertions — the actual positioning/shadow/z-index rendering is a real-browser verification
  // gap documented in the design MD §7, not claimed as proven here.
  describe('UI-P2-2c — responsive rail (narrow-width auto-collapse + drawer)', () => {
    function railEl(): HTMLElement {
      const rail = container!.querySelector('.mt-workbench__rail') as HTMLElement
      expect(rail).toBeTruthy()
      return rail
    }

    beforeEach(() => setViewportWidth(1280))
    afterEach(() => setViewportWidth(1280))

    it('desktop width (>= breakpoint): mounting behaves exactly like pre-2c — no auto-collapse, no drawer class', async () => {
      setViewportWidth(1280)
      mountWorkbench()
      await flushUi()
      const toggle = container!.querySelector('[data-testid="rail-collapse-toggle"]') as HTMLButtonElement
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(railEl().classList.contains('mt-workbench__rail--collapsed')).toBe(false)
      expect(railEl().classList.contains('mt-workbench__rail--drawer')).toBe(false)
    })

    it('narrow width at mount: auto-collapses to the icon-strip (no drawer)', async () => {
      setViewportWidth(600)
      mountWorkbench()
      await flushUi()
      const toggle = container!.querySelector('[data-testid="rail-collapse-toggle"]') as HTMLButtonElement
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(railEl().classList.contains('mt-workbench__rail--collapsed')).toBe(true)
      expect(railEl().classList.contains('mt-workbench__rail--drawer')).toBe(false)
    })

    it('resizing to narrow after mount auto-collapses; resizing back to wide does NOT force re-expand', async () => {
      setViewportWidth(1280)
      mountWorkbench()
      await flushUi()
      const toggle = container!.querySelector('[data-testid="rail-collapse-toggle"]') as HTMLButtonElement
      expect(toggle.getAttribute('aria-expanded')).toBe('true')

      setViewportWidth(600)
      await flushUi()
      expect(toggle.getAttribute('aria-expanded')).toBe('false')

      setViewportWidth(1280)
      await flushUi()
      // Deliberate asymmetry (design MD §2): leaving narrow never force-writes railCollapsed.
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
    })

    it('re-expanding the rail while narrow enters drawer mode; the same toggle closes it back to the icon-strip', async () => {
      setViewportWidth(600)
      mountWorkbench()
      await flushUi()
      const toggle = container!.querySelector('[data-testid="rail-collapse-toggle"]') as HTMLButtonElement
      expect(railEl().classList.contains('mt-workbench__rail--collapsed')).toBe(true)

      toggle.click()
      await flushUi()
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(railEl().classList.contains('mt-workbench__rail--drawer')).toBe(true)
      expect(railEl().classList.contains('mt-workbench__rail--collapsed')).toBe(false)

      toggle.click()
      await flushUi()
      expect(railEl().classList.contains('mt-workbench__rail--drawer')).toBe(false)
      expect(railEl().classList.contains('mt-workbench__rail--collapsed')).toBe(true)
    })

    it('Escape from inside the rail closes the drawer and returns focus to the toggle', async () => {
      setViewportWidth(600)
      mountWorkbench()
      await flushUi()
      const toggle = container!.querySelector('[data-testid="rail-collapse-toggle"]') as HTMLButtonElement
      toggle.click()
      await flushUi()
      expect(railEl().classList.contains('mt-workbench__rail--drawer')).toBe(true)

      toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await flushUi()

      expect(railEl().classList.contains('mt-workbench__rail--drawer')).toBe(false)
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(document.activeElement).toBe(toggle)
    })

    it('Escape from outside the rail (main content) does NOT close the drawer — scoped, not global', async () => {
      setViewportWidth(600)
      mountWorkbench()
      await flushUi()
      const toggle = container!.querySelector('[data-testid="rail-collapse-toggle"]') as HTMLButtonElement
      toggle.click()
      await flushUi()
      expect(railEl().classList.contains('mt-workbench__rail--drawer')).toBe(true)

      const main = container!.querySelector('.mt-workbench__main') as HTMLElement
      expect(main).toBeTruthy()
      main.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await flushUi()

      expect(railEl().classList.contains('mt-workbench__rail--drawer')).toBe(true)
    })
  })

  // W2 S7 (design docs/development/multitable-w2-unified-record-inspector-design-lock-20260714.md
  // §3.4/§6bis, OD-W2-6=(b)): the right record inspector becomes a narrow-width overlay drawer using
  // the SAME `isRailNarrow`/`RAIL_NARROW_BREAKPOINT` signal as the left rail (P2-2c, describe block
  // above) — no second breakpoint constant — and is MUTUALLY EXCLUSIVE with the rail drawer while
  // narrow: opening one auto-closes the other. These are STATE assertions (classes/attributes/DOM
  // presence), not CSS/layout assertions — the actual overlay positioning/shadow/clamp rendering is
  // real-browser-verified separately (apps/web/verification/inspector-overlay*).
  describe('W2 S7 — responsive inspector overlay + rail mutual exclusion (OD-W2-6=b)', () => {
    function railEl(): HTMLElement {
      const rail = container!.querySelector('.mt-workbench__rail') as HTMLElement
      expect(rail).toBeTruthy()
      return rail
    }

    function toggleEl(): HTMLButtonElement {
      return container!.querySelector('[data-testid="rail-collapse-toggle"]') as HTMLButtonElement
    }

    function inspectorEl(): HTMLElement | null {
      return container!.querySelector('[data-record-drawer]')
    }

    beforeEach(() => setViewportWidth(1280))
    afterEach(() => setViewportWidth(1280))

    it('desktop width (>= breakpoint): selecting a record never touches rail state, and toggling the rail never closes the inspector — both stay open together (OD-W2-3=a, byte-unchanged)', async () => {
      setViewportWidth(1280)
      mountWorkbench()
      await flushUi()

      expect(toggleEl().getAttribute('aria-expanded')).toBe('true') // rail starts expanded (pre-S7 default)

      // Record inspector v3 (2026-09-05, PR-A §1.1): `expand-record` (this stub's explicit-open
      // equivalent) — plain `select-record` no longer opens the inspector (W2 lock §3.1 erratum).
      container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
      await flushUi()
      expect(inspectorEl()).toBeTruthy() // inspector opened
      expect(inspectorEl()!.classList.contains('meta-record-drawer--overlay')).toBe(false) // push, not overlay
      expect(toggleEl().getAttribute('aria-expanded')).toBe('true') // rail UNTOUCHED by opening the inspector

      toggleEl().click() // collapse the rail
      await flushUi()
      expect(toggleEl().getAttribute('aria-expanded')).toBe('false')
      expect(inspectorEl()).toBeTruthy() // inspector UNAFFECTED by collapsing the rail — still open
      expect(railEl().classList.contains('mt-workbench__rail--drawer')).toBe(false) // desktop never enters drawer mode

      toggleEl().click() // re-expand the rail
      await flushUi()
      expect(toggleEl().getAttribute('aria-expanded')).toBe('true')
      expect(inspectorEl()).toBeTruthy() // inspector still open — both open together at desktop
    })

    it('narrow width: the open inspector carries the overlay class; resizing to wide removes it (push); resizing back to narrow re-applies it (round-trip)', async () => {
      setViewportWidth(600)
      mountWorkbench()
      await flushUi()

      container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
      await flushUi()
      expect(inspectorEl()).toBeTruthy()
      expect(inspectorEl()!.classList.contains('meta-record-drawer--overlay')).toBe(true)

      setViewportWidth(1280)
      await flushUi()
      expect(inspectorEl()).toBeTruthy() // stays open across the resize
      expect(inspectorEl()!.classList.contains('meta-record-drawer--overlay')).toBe(false)

      setViewportWidth(600)
      await flushUi()
      expect(inspectorEl()).toBeTruthy()
      expect(inspectorEl()!.classList.contains('meta-record-drawer--overlay')).toBe(true)
    })

    it('narrow width: opening the inspector while the rail drawer is open closes the rail drawer', async () => {
      setViewportWidth(600)
      mountWorkbench()
      await flushUi()

      toggleEl().click() // narrow + re-expand -> rail drawer opens (P2-2c)
      await flushUi()
      expect(railEl().classList.contains('mt-workbench__rail--drawer')).toBe(true)
      expect(inspectorEl()).toBeNull()

      container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
      await flushUi()
      expect(inspectorEl()).toBeTruthy() // inspector opened
      expect(railEl().classList.contains('mt-workbench__rail--drawer')).toBe(false) // rail drawer auto-closed
      expect(railEl().classList.contains('mt-workbench__rail--collapsed')).toBe(true) // back to icon-strip
    })

    it('narrow width: opening the rail drawer while the inspector is open closes the inspector', async () => {
      setViewportWidth(600)
      mountWorkbench()
      await flushUi()

      container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
      await flushUi()
      expect(inspectorEl()).toBeTruthy()
      expect(railEl().classList.contains('mt-workbench__rail--drawer')).toBe(false)

      toggleEl().click() // narrow + re-expand -> rail drawer opens
      await flushUi()
      expect(railEl().classList.contains('mt-workbench__rail--drawer')).toBe(true)
      expect(inspectorEl()).toBeNull() // inspector auto-closed
    })

    // Regression test (2026-09-05): `openRecord`/`resolveDeepLink` used to set `inspectorOpen=true`
    // BEFORE calling `selectRecord`, whose OWN discard-guard can still abort the navigation — a
    // DECLINED confirm then left `inspectorOpen=true` dangling (reopening the panel on the
    // PREVIOUSLY selected record) even though the navigation itself was cancelled. Repro needs the
    // panel CLOSED with a genuinely dirty draft still held: the rail-drawer mutual-exclusion watcher
    // (just above) force-closes the inspector WITHOUT running `confirmDiscardRecordChanges` (a
    // separate, pre-existing, undisputed behavior) — a dirty comment draft set before that survives
    // it untouched, unlike `onCloseDrawer`'s own close path, which clears it via its own guard.
    it('a declined discard-confirm on expand-record (closed panel, dirty draft) leaves the panel closed and the selection unchanged', async () => {
      setViewportWidth(600)
      mountWorkbench()
      await flushUi()

      container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
      await flushUi()
      container!.querySelector<HTMLButtonElement>('[data-toggle-comments="true"]')!.click()
      await flushUi()
      container!.querySelector<HTMLButtonElement>('[data-set-comment-draft="true"]')!.click()
      await flushUi()

      // Force-close WITHOUT the discard guard (rail-drawer mutual exclusion) — the draft survives.
      toggleEl().click()
      await flushUi()
      expect(inspectorEl()).toBeNull() // panel closed, selectedRecordId (rec_1) retained underneath

      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
      container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_2"]')!.click()
      await flushUi()

      expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved record changes?')
      // The navigation was cancelled — the panel must stay CLOSED, not reopen on rec_1.
      expect(inspectorEl()).toBeNull()
    })

    it('narrow width: switching from one selected record to another while the rail drawer is open still closes the drawer', async () => {
      setViewportWidth(600)
      mountWorkbench()
      await flushUi()

      // Open the rail drawer first (no inspector open yet), then OPEN the inspector on rec_2 while
      // it's open — proving the guard fires on "the inspector actually opened", not just "some
      // record got selected" (record inspector v3, 2026-09-05, PR-A §1.1: `expand-record`, this
      // stub's explicit-open equivalent, since plain `select-record` no longer opens the panel).
      toggleEl().click()
      await flushUi()
      expect(railEl().classList.contains('mt-workbench__rail--drawer')).toBe(true)

      container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_2"]')!.click()
      await flushUi()
      expect(inspectorEl()).toBeTruthy()
      expect(railEl().classList.contains('mt-workbench__rail--drawer')).toBe(false)
    })
  })

  // Record inspector v3 (2026-09-05, PR-A §1.1, W2 lock §3.1 erratum): the `#recordId=` hash means
  // "this record is EXPANDED" — written only while `inspectorOpen && selectedRecordId`, stripped the
  // moment either goes false. A plain cursor move (select-record, panel closed) must write nothing.
  describe('hash lifecycle (§1.1)', () => {
    function hash(): string {
      return window.location.hash
    }

    it('select-record with the panel closed writes no hash', async () => {
      mountWorkbench()
      await flushUi()
      expect(hash()).toBe('')
      container!.querySelector<HTMLButtonElement>('[data-select-record="rec_1"]')!.click()
      await flushUi()
      expect(hash()).toBe('')
    })

    it('expand-record writes #recordId=<id>; close strips it (selectedRecordId itself survives)', async () => {
      mountWorkbench()
      await flushUi()
      container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
      await flushUi()
      expect(hash()).toBe('#recordId=rec_1')
      container!.querySelector<HTMLButtonElement>('[data-close-drawer="true"]')!.click()
      await flushUi()
      expect(hash()).toBe('')
    })
  })

  // Record inspector v3 (2026-09-05, PR-A §1.1, §2 graft table "comment fetch out of selectRecord
  // (P12)"): a closed-panel `select-record` (arrow/click cursor move) must make ZERO comment
  // requests; the positive control proves the fetch-once-opened path is still live (not merely
  // silenced everywhere).
  describe('comment fetch gating (§1.1 P12)', () => {
    it('three closed-panel select-record calls make zero comment fetches; expand-record then fetches exactly once', async () => {
      mountWorkbench()
      await flushUi()
      loadCommentsSpy.mockClear()

      container!.querySelector<HTMLButtonElement>('[data-select-record="rec_1"]')!.click()
      await flushUi()
      container!.querySelector<HTMLButtonElement>('[data-select-record="rec_2"]')!.click()
      await flushUi()
      container!.querySelector<HTMLButtonElement>('[data-select-record="rec_1"]')!.click()
      await flushUi()
      expect(loadCommentsSpy).not.toHaveBeenCalled()

      // Positive control: the SAME record, now opened, DOES fetch — proving the gate is load-bearing
      // (not merely a dead branch that never fires under this harness).
      container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
      await flushUi()
      expect(loadCommentsSpy).toHaveBeenCalledTimes(1)
    })
  })

  // Also required by the design brief directly (§1.1): a plain cursor move must not merely "write
  // no hash" (the hash-lifecycle describe's own assertion above) — the inspector shell itself must
  // never mount/show at all while the panel is closed.
  describe('closed select-record does not mount/show the inspector (§1.1)', () => {
    it('select-record with the panel closed does not mount/show the inspector', async () => {
      mountWorkbench()
      await flushUi()
      expect(container!.querySelector('[data-record-drawer]')).toBeNull()
      container!.querySelector<HTMLButtonElement>('[data-select-record="rec_1"]')!.click()
      await flushUi()
      expect(container!.querySelector('[data-record-drawer]')).toBeNull()
    })
  })

  // P2-B (2026-09-05, verified finding): "close retains selectedRecordId" had NO assertion in this
  // suite before this — re-adding `selectedRecordId.value = null` inside `onCloseDrawer` (the
  // pre-PR-A behavior, when `selectedRecordId` alone WAS the panel's visibility) would leave every
  // pre-existing test in this file green. Proven here via the grid's own `selected-record-id` prop
  // (WB → MetaGridTable, `:selected-record-id="selectedRecordId"`) — the grid stub declares no such
  // prop, so Vue's normal attrs-fallthrough renders it as a literal DOM attribute on the stub's root.
  describe('close retains selectedRecordId (§1.1, P2-B)', () => {
    function gridSelectedRecordId(): string | null {
      return container!.querySelector('[data-grid-column-widths]')?.getAttribute('selected-record-id') ?? null
    }

    it('expand-record selects the row; closing the panel keeps that row selected — only the panel itself closes', async () => {
      mountWorkbench()
      await flushUi()
      expect(gridSelectedRecordId()).toBeNull()

      container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
      await flushUi()
      expect(gridSelectedRecordId()).toBe('rec_1')
      expect(container!.querySelector('[data-record-drawer]')).toBeTruthy()

      container!.querySelector<HTMLButtonElement>('[data-close-drawer="true"]')!.click()
      await flushUi()
      expect(container!.querySelector('[data-record-drawer]')).toBeNull() // panel closed
      expect(gridSelectedRecordId()).toBe('rec_1') // row STAYS selected — the P2-B assertion itself
    })
  })

  // Round 3 (2026-09-05, refuter finding on round 2): round 2 covered `openRecord`'s STATE but never
  // that the captured opener actually REACHES the child — the `:opener-el="inspectorOpenerEl"`
  // binding on `<MetaRecordInspector>` (MultitableWorkbench.vue template) had zero coverage as a
  // binding. The stub near the top of this file now declares `openerEl` and records the exact object
  // it was rendered with (`inspectorStubSeen`), so this asserts the wiring by IDENTITY.
  describe('opener-el wiring: openRecord\'s captured opener reaches <MetaRecordInspector openerEl> by identity (§1.1, round 3)', () => {
    it('expand-record with a focused opener passes that exact element as openerEl; after the inspector emits close the workbench CLEARS it (null)', async () => {
      mountWorkbench()
      await flushUi()
      expect(inspectorStubSeen.renders).toBeGreaterThan(0) // the stub really rendered (holder is live)
      expect(inspectorStubSeen.openerEl).toBeNull() // nothing opened yet → the ref's initial null

      // A real, connected element as the opener. The grid's `expand-record` handler
      // (`onExpandRecord(id)` → `openRecord(id)`) passes NO explicit opener, so `openRecord` falls back
      // to `document.activeElement` at the instant the grid's synchronous emit handler runs — exactly
      // what the real grid's row-number icon relies on (see `openRecord`'s own doc comment). jsdom's
      // `.click()` does NOT move focus, so focusing the opener first and then clicking the stub's
      // expand button leaves it as the active element for that capture.
      const opener = document.createElement('button')
      opener.textContent = 'row-expand-opener'
      document.body.appendChild(opener)
      opener.focus()
      expect(document.activeElement).toBe(opener)

      container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
      await flushUi()
      expect(container!.querySelector('[data-record-drawer]')).toBeTruthy() // panel open
      expect(inspectorStubSeen.openerEl).toBe(opener) // IDENTITY — the exact element, not a stringified attr
      const rendersWhileOpen = inspectorStubSeen.renders

      // Close via the inspector's own `close` emit (× and Esc both route to `onCloseDrawer`).
      // `onCloseDrawer` sets `inspectorOpen=false`, RETAINS `selectedRecordId`, and — round 4
      // (2026-09-05, refuter P2) — CLEARS `inspectorOpenerEl`, so the child is handed `null` after
      // close. Round 3 pinned the opposite ("retained") with a "safe by construction" argument that
      // was false: not every later open goes through `openRecord` (the `openComments: true`
      // click-through callers and `resolveDeepLink` do not), so a retained opener WAS consulted stale
      // — see the next two tests.
      container!.querySelector<HTMLButtonElement>('[data-close-drawer="true"]')!.click()
      await flushUi()
      expect(container!.querySelector('[data-record-drawer]')).toBeNull() // panel closed
      expect(inspectorStubSeen.renders).toBeGreaterThan(rendersWhileOpen) // the stub DID re-render on close…
      expect(inspectorStubSeen.openerEl).toBeNull() // …and was handed null — the opener is consumed by the close
      expect(opener.isConnected).toBe(true) // (the element itself is untouched — only the workbench's reference is dropped)

      opener.remove()
    })

    // Round 4 (2026-09-05, refuter P2, reproduced in Chromium on the round-3 head): expand-icon open
    // (opener A) → Escape → focus back on A (correct) → focus + click row 2's grid comment button C
    // (`.meta-grid__comment-action`) → panel opens on record 2 via `onOpenRecordComments` →
    // `selectRecord(rec_2, { openComments: true })`, which never goes through `openRecord` → Escape →
    // focus landed on A (row 1's stale expand icon), not on C. Root cause: `inspectorOpenerEl` kept A
    // across the close and the comment path never overwrote it, so the inspector's
    // `props.openerEl ?? <activeElement at open>` preference picked the stale A over C. Fixed on both
    // sides: `onCloseDrawer` nulls the opener, and `selectRecord`'s open branch nulls it on any
    // opener-less FRESH open. The inspector's own fallback then restores focus to C — pinned against
    // the real component in multitable-record-inspector-header.spec.ts (round 4 block).
    it('stale opener: expand-open (opener A) → close → comment click-through open hands the inspector openerEl === null, not A', async () => {
      mountWorkbench()
      await flushUi()

      const openerA = document.createElement('button')
      openerA.textContent = 'row-1-expand-icon'
      document.body.appendChild(openerA)
      openerA.focus()
      container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
      await flushUi()
      expect(container!.querySelector('[data-record-drawer="rec_1"]')).toBeTruthy()
      expect(inspectorStubSeen.openerEl).toBe(openerA) // positive control: the expand path DOES pass A

      container!.querySelector<HTMLButtonElement>('[data-close-drawer="true"]')!.click()
      await flushUi()
      expect(container!.querySelector('[data-record-drawer]')).toBeNull()

      // Row 2's comment button, focused the way a real click leaves it, then the grid's
      // `open-comments` emit → `onOpenRecordComments` → `selectRecord(rec_2, { openComments: true })`.
      const commentBtnC = document.createElement('button')
      commentBtnC.textContent = 'row-2-comment-button'
      document.body.appendChild(commentBtnC)
      commentBtnC.focus()
      expect(document.activeElement).toBe(commentBtnC)
      container!.querySelector<HTMLButtonElement>('[data-open-comments="rec_2"]')!.click()
      await flushUi()
      expect(container!.querySelector('[data-record-drawer="rec_2"]')).toBeTruthy() // panel open on record 2
      expect(inspectorStubSeen.openerEl).toBeNull() // NOT openerA — the stale-opener bug itself
      expect(inspectorStubSeen.openerEl).not.toBe(openerA)

      openerA.remove()
      commentBtnC.remove()
    })

    // The open-side half of the fix is independently load-bearing: two close paths bypass
    // `onCloseDrawer` entirely (the rail-drawer watcher, and the `selectedRecordId → null` force-close
    // watcher that a record delete trips — see the P3-5 block below), so a close-side reset alone
    // would leave A behind for the next opener-less open. Mutation: delete only the
    // `inspectorOpenerEl.value = null` in `onCloseDrawer` → this test stays green; delete only the
    // `else if (!inspectorOpen.value) inspectorOpenerEl.value = null` in `selectRecord` → this reds.
    it('stale opener via a close that bypasses onCloseDrawer: expand-open (A) → record deleted (force-close) → comment click-through open hands openerEl === null', async () => {
      gridMock.deleteRecord.mockResolvedValueOnce(true)
      mountWorkbench()
      await flushUi()

      const openerA = document.createElement('button')
      document.body.appendChild(openerA)
      openerA.focus()
      container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
      await flushUi()
      expect(inspectorStubSeen.openerEl).toBe(openerA)

      container!.querySelector<HTMLButtonElement>('[data-delete-record="true"]')!.click()
      await flushUi()
      expect(gridMock.deleteRecord).toHaveBeenCalledWith('rec_1')
      expect(container!.querySelector('[data-record-drawer]')).toBeNull() // force-closed by the watcher, not via onCloseDrawer

      const commentBtnC = document.createElement('button')
      document.body.appendChild(commentBtnC)
      commentBtnC.focus()
      container!.querySelector<HTMLButtonElement>('[data-open-comments="rec_2"]')!.click()
      await flushUi()
      expect(container!.querySelector('[data-record-drawer="rec_2"]')).toBeTruthy()
      expect(inspectorStubSeen.openerEl).toBeNull()

      openerA.remove()
      commentBtnC.remove()
    })

    // Preserved behaviour (not a fix): an opener-less call while the panel is ALREADY open — a comment
    // click-through on another row from inside an open panel — leaves the CURRENT open's opener in
    // place; only a fresh (closed → open) opener-less open resets it. Pinned so the round-4 reset is
    // visibly scoped to the closed→open edge, not "every openComments call nulls the opener".
    it('an opener-less comment click-through while the panel is already open keeps the current opener (only a fresh open resets it)', async () => {
      mountWorkbench()
      await flushUi()

      const openerA = document.createElement('button')
      document.body.appendChild(openerA)
      openerA.focus()
      container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
      await flushUi()
      expect(container!.querySelector('[data-record-drawer="rec_1"]')).toBeTruthy()
      expect(inspectorStubSeen.openerEl).toBe(openerA)

      container!.querySelector<HTMLButtonElement>('[data-open-comments="rec_2"]')!.click()
      await flushUi()
      expect(container!.querySelector('[data-record-drawer="rec_2"]')).toBeTruthy() // panel followed to record 2, still open
      expect(inspectorStubSeen.openerEl).toBe(openerA) // unchanged — this open never closed

      openerA.remove()
    })
  })

  // P3-5 (2026-09-05, verified finding): the force-close watcher
  // (`watch(selectedRecordId, rid => { if (!rid) inspectorOpen.value = false }`) had ZERO coverage.
  // Deleting a record while the panel is open nulls `selectedRecordId` (`onDeleteRecord`) WITHOUT
  // going through `onCloseDrawer` — this watcher is the ONLY thing that resets `inspectorOpen` in
  // that path. Because `visible = inspectorOpen && !!selectedRecordId`, the panel closing right
  // after the delete is NOT, by itself, proof the watcher ran (`!!selectedRecordId` alone already
  // hides it) — the discriminating assertion is what happens on the NEXT plain cursor move: with the
  // watcher in place, `inspectorOpen` is back to `false`, so a later PLAIN `select-record` on a
  // different row must NOT reopen the panel; with the watcher deleted, `inspectorOpen` stays stuck
  // `true` from before the delete, and that same plain select-record WOULD reopen it (`visible =
  // true && !!rec_2` = true) — a real explicit-open-discipline violation.
  describe('force-close watcher resets inspectorOpen when selectedRecordId is cleared out-of-band (§1.1, P3-5)', () => {
    it('deleting the open record closes the panel, and a later plain select-record on another row does NOT reopen it', async () => {
      gridMock.deleteRecord.mockResolvedValueOnce(true)
      mountWorkbench()
      await flushUi()

      container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
      await flushUi()
      expect(container!.querySelector('[data-record-drawer]')).toBeTruthy()

      container!.querySelector<HTMLButtonElement>('[data-delete-record="true"]')!.click()
      await flushUi()
      expect(gridMock.deleteRecord).toHaveBeenCalledWith('rec_1')
      expect(container!.querySelector('[data-record-drawer]')).toBeNull() // panel closed by the delete

      // The discriminating step: a PLAIN cursor move (not expand-record) on a DIFFERENT record must
      // not reopen the panel — it would, if `inspectorOpen` were left stuck `true` by the delete.
      container!.querySelector<HTMLButtonElement>('[data-select-record="rec_2"]')!.click()
      await flushUi()
      expect(container!.querySelector('[data-record-drawer]')).toBeNull()
    })
  })

  // P3-2 (2026-09-05, verified finding): `mentionDisplayFieldId` (above) is now routed through
  // `resolveMentionDisplayField` — pure-function coverage of both branches named by the finding,
  // plus a source pin proving the WB computed actually calls it (a future edit re-forking the two
  // idioms would not itself red any DOM-level test, since no mock in this file renders
  // `displayFieldId`).
  describe('mention display field resolution unification (P3-2)', () => {
    const TEXT_PRIMARY: MetaField[] = [
      { id: 'fld_name', name: 'Name', type: 'string' } as MetaField,
      { id: 'fld_qty', name: 'Qty', type: 'number' } as MetaField,
    ]
    const NON_TEXT_PRIMARY: MetaField[] = [
      { id: 'fld_qty', name: 'Qty', type: 'number' } as MetaField,
      { id: 'fld_status', name: 'Status', type: 'select' } as MetaField,
      { id: 'fld_notes', name: 'Notes', type: 'longText' } as MetaField,
    ]

    it('when the primary field IS text (string/longText), it wins — same field the title/bulk-fill idioms already read', () => {
      expect(resolveMentionDisplayField(TEXT_PRIMARY)?.id).toBe('fld_name')
      expect(resolveMentionDisplayField(TEXT_PRIMARY)?.id).toBe(resolvePrimaryField(TEXT_PRIMARY)?.id)
    })

    it('when the primary field is NOT text, falls back to the first string/longText field instead (mention chips need a readable value)', () => {
      expect(resolvePrimaryField(NON_TEXT_PRIMARY)?.id).toBe('fld_qty') // the primary field itself is NOT text
      expect(resolveMentionDisplayField(NON_TEXT_PRIMARY)?.id).toBe('fld_notes') // mention display falls back
    })

    it('no string/longText field anywhere resolves to undefined (never throws)', () => {
      const noTextFields: MetaField[] = [{ id: 'fld_qty', name: 'Qty', type: 'number' } as MetaField]
      expect(resolveMentionDisplayField(noTextFields)).toBeUndefined()
    })

    it('[source] MultitableWorkbench.vue routes mentionDisplayFieldId through resolveMentionDisplayField, not a second inline .find() idiom', () => {
      const src = readFileSync(join(__dirname, '..', 'src/multitable/views/MultitableWorkbench.vue'), 'utf8')
      const block = src.match(/const mentionDisplayFieldId = computed\(\(\) =>[\s\S]*?\n\)/)?.[0] ?? ''
      expect(block).toMatch(/resolveMentionDisplayField\(grid\.visibleFields\.value\)/)
      expect(block).toMatch(/resolveMentionDisplayField\(grid\.fields\.value\)/)
    })
  })

  // Record inspector v3 PR-B2 (2026-09-05, docs/development/multitable-record-inspector-v3-design-20260905.md
  // §1.3 "Field-anchored server errors", §3 B2 "workbench" tests, §4 item 11). The composable is mocked
  // (`gridMock`), so each test plays the composable: it sets `error.value` exactly as the real
  // `patchCell` would, plus the additive `lastPatchFailure` the routing reads — and, for the conflict
  // case, `conflict.value` (the banner's own driver, unchanged by B2). The inline node is the
  // MetaRecordInspector stub's rendering of the `fieldErrors` prop (see the stub); the real panel's
  // alert/aria/draft behaviour is pinned in multitable-record-inspector-field-errors.spec.ts.
  describe('onDrawerPatch — field-anchored server errors (PR-B2 §1.3)', () => {
    const ATTEMPTED = 'Patched title' // what the stub's `data-patch-record` button emits for fld_title

    async function openRec1() {
      mountWorkbench()
      await flushUi()
      container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
      await flushUi()
      expect(container!.querySelector('[data-record-drawer="rec_1"]')).toBeTruthy()
    }
    function fieldErrorEl(fieldId: string): HTMLElement | null {
      return container!.querySelector<HTMLElement>(`[data-test="drawer-field-error"][data-field-id="${fieldId}"]`)
    }
    async function patchTitle() {
      container!.querySelector<HTMLButtonElement>('[data-patch-record="fld_title"]')!.click()
      await flushUi()
    }
    /** The composable's observable state after a REJECTED patchCell (rollback is internal to it). */
    function rejectNextPatch(message: string, failure: Record<string, unknown>) {
      gridMock.patchCell.mockImplementation(async () => {
        gridMock.error.value = message
        gridMock.lastPatchFailure.value = { recordId: 'rec_1', fieldId: 'fld_title', attemptedValue: ATTEMPTED, message, ...failure }
      })
    }
    function acceptNextPatch() {
      gridMock.patchCell.mockImplementation(async () => {
        gridMock.error.value = null
        gridMock.lastPatchFailure.value = null
      })
    }

    it('422 with fieldErrors → NO toast, inline error under that field (no success toast either)', async () => {
      await openRec1()
      rejectNextPatch('Title is too long', { status: 422, code: 'VALIDATION_ERROR', fieldErrors: { fld_title: 'Title is too long' } })
      await patchTitle()
      expect(gridMock.patchCell).toHaveBeenCalledWith('rec_1', 'fld_title', ATTEMPTED, 1)
      expect(showErrorSpy).not.toHaveBeenCalled()
      expect(showSuccessSpy).not.toHaveBeenCalled()
      expect(fieldErrorEl('fld_title')?.textContent).toBe('Title is too long')
    })

    it('400 VALIDATION_ERROR with NO fieldErrors (the shape /patch actually sends) → inline too, message = the server message', async () => {
      await openRec1()
      rejectNextPatch('Select value must be string: fld_title', { status: 400, code: 'VALIDATION_ERROR' })
      await patchTitle()
      expect(showErrorSpy).not.toHaveBeenCalled()
      expect(fieldErrorEl('fld_title')?.textContent).toBe('Select value must be string: fld_title')
    })

    it('403 still toasts (positive control for "no toast") and renders NO inline error', async () => {
      await openRec1()
      rejectNextPatch('Insufficient permissions', { status: 403, code: 'FORBIDDEN' })
      await patchTitle()
      expect(showErrorSpy).toHaveBeenCalledTimes(1)
      expect(showErrorSpy).toHaveBeenCalledWith('Insufficient permissions')
      expect(fieldErrorEl('fld_title')).toBeNull()
    })

    it('a failure recorded for a DIFFERENT record/field is never attributed to this control — toast as before', async () => {
      await openRec1()
      rejectNextPatch('Title is too long', { recordId: 'rec_9', fieldId: 'fld_other', status: 422, code: 'VALIDATION_ERROR' })
      await patchTitle()
      expect(showErrorSpy).toHaveBeenCalledWith('Title is too long')
      expect(container!.querySelector('[data-test="drawer-field-error"]')).toBeNull()
    })

    it('the LOCAL row-action refusal (error.value set, no lastPatchFailure) keeps today\'s toast', async () => {
      await openRec1()
      gridMock.patchCell.mockImplementation(async () => {
        gridMock.error.value = 'Record editing is not allowed for this row.'
        gridMock.lastPatchFailure.value = null
      })
      await patchTitle()
      expect(showErrorSpy).toHaveBeenCalledWith('Record editing is not allowed for this row.')
      expect(container!.querySelector('[data-test="drawer-field-error"]')).toBeNull()
    })

    it('VERSION_CONFLICT → the existing conflict banner + a field marker carrying the banner text, NO toast; marker clears with the conflict', async () => {
      await openRec1()
      gridMock.patchCell.mockImplementation(async () => {
        gridMock.error.value = 'Row changed elsewhere'
        gridMock.conflict.value = { recordId: 'rec_1', fieldId: 'fld_title', attemptedValue: ATTEMPTED, message: 'Row changed elsewhere', serverVersion: 8 }
        gridMock.lastPatchFailure.value = { recordId: 'rec_1', fieldId: 'fld_title', attemptedValue: ATTEMPTED, message: 'Row changed elsewhere', status: 409, code: 'VERSION_CONFLICT' }
      })
      await patchTitle()
      // Banner: exactly the pre-B2 text pinned by 'renders conflict recovery actions…' above.
      expect(container!.textContent).toContain('Update conflict')
      expect(container!.textContent).toContain('Title changed elsewhere. Latest version is 8.')
      // Pre-B2 this path ALSO toasted (double signal); B2 suppresses the toast for this code.
      expect(showErrorSpy).not.toHaveBeenCalled()
      // Field marker with the SAME text as the banner — compared against the banner's own text node, not a
      // literal, so the two can never drift (the banner copy is `fmtConflictMessage`'s full sentence).
      const bannerText = container!.querySelector('.mt-workbench__conflict-copy span')?.textContent
      expect(bannerText).toContain('Title changed elsewhere. Latest version is 8.')
      expect(fieldErrorEl('fld_title')?.textContent).toBe(bannerText)
      // Reload / retry / dismiss all null `conflict` in the real composable; the marker follows it.
      gridMock.conflict.value = null
      await flushUi()
      expect(fieldErrorEl('fld_title')).toBeNull()
    })

    it('a later SUCCESSFUL patch of the same field clears its inline error and toasts success as before', async () => {
      await openRec1()
      rejectNextPatch('Title is too long', { status: 422, code: 'VALIDATION_ERROR', fieldErrors: { fld_title: 'Title is too long' } })
      await patchTitle()
      expect(fieldErrorEl('fld_title')).toBeTruthy()
      acceptNextPatch()
      await patchTitle()
      expect(fieldErrorEl('fld_title')).toBeNull()
      expect(showSuccessSpy).toHaveBeenCalledTimes(1)
      expect(showErrorSpy).not.toHaveBeenCalled()
    })

    it('record change clears inline errors (navigate to another record from the inspector)', async () => {
      await openRec1()
      rejectNextPatch('Title is too long', { status: 422, code: 'VALIDATION_ERROR', fieldErrors: { fld_title: 'Title is too long' } })
      await patchTitle()
      expect(fieldErrorEl('fld_title')).toBeTruthy()
      container!.querySelector<HTMLButtonElement>('[data-navigate-record="rec_2"]')!.click()
      await flushUi()
      expect(container!.querySelector('[data-record-drawer="rec_2"]')).toBeTruthy()
      expect(container!.querySelector('[data-test="drawer-field-error"]')).toBeNull()
    })
  })
})
