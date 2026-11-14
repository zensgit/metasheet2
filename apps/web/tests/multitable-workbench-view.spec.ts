import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, reactive, ref, type App as VueApp, type Component, type PropType } from 'vue'
// P3-2 (2026-09-05): pure-function coverage for the mentionDisplayFieldId unification lives here,
// beside the WB `mentionDisplayFieldId` computed it replaces — see that describe block below.
import { resolveMentionDisplayField, resolvePrimaryField } from '../src/multitable/utils/recordDisplay'
import { recordLabel } from '../src/multitable/utils/meta-record-labels'
import { workbenchLabel } from '../src/multitable/utils/workbench-labels'
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
// Record inspector v3 PR-B1 round 2 (2026-09-05, refuter P2 "WB producer + WB→INS wiring untested"):
// the same holder also records the LATEST `inspectorFieldLayout` and `fetchRecord` props the stub was
// rendered with, and `gridStubSeen.fetchRecord` records what the MetaGridTable stub received on its
// own `:fetch-record` binding — so the HI-1 "same function the grid already receives" claim is
// asserted by IDENTITY between the two stubs, not by a stringified attr or a source-text regex.
const { inspectorStubSeen, gridStubSeen } = vi.hoisted(() => ({
  inspectorStubSeen: {
    openerEl: null as HTMLElement | null,
    renders: 0,
    fieldLayout: undefined as { ordered: Array<{ id: string }>; hiddenInView: Array<{ id: string }> } | null | undefined,
    fetchRecord: undefined as ((recordId: string) => Promise<unknown>) | undefined,
    // #5795: the server-side mention search the workbench hands the inspector.
    mentionSearch: undefined as ((query: string) => Promise<{ items: unknown[]; requiresQuery: boolean; hasMore: boolean }>) | undefined,
    // The attachment upload / delete the workbench hands the inspector (they hold the grid's undo).
    uploadFn: undefined as ((file: File, context?: { recordId?: string; fieldId?: string }) => Promise<unknown>) | undefined,
    deleteAttachmentFn: undefined as ((attachmentId: string, context?: { recordId?: string; fieldId?: string }) => Promise<unknown>) | undefined,
    // The record the drawer shows (the grid's row, or the workbench's copy of it).
    record: null as { id: string; version: number; data: Record<string, unknown> } | null,
  },
  gridStubSeen: {
    fetchRecord: undefined as ((recordId: string) => Promise<unknown>) | undefined,
    mentionSearch: undefined as ((query: string) => Promise<unknown>) | undefined,
  },
}))
// PR-B2 round 2 (2026-09-05, record inspector v3 §1.3): the stub's answer to the workbench's
// `canAnchorFieldError(recordId, fieldId)` query (the real MetaRecordInspector exposes it via
// `defineExpose`; the workbench calls it through `recordInspectorRef` before writing an inline entry).
// Default `true` = "details tab active, field row rendered"; a test flips it to `false` to play "the
// alert could not render" (attachments tab / hidden field / closed inspector) and asserts the toast
// fallback. Re-armed to `true` in the PR-B2 describe's own beforeEach (clearAllMocks keeps
// implementations, so a per-test `false` would otherwise leak). Its call args are asserted too: the
// workbench must ask about the record the FAILURE belongs to, not whatever is selected by then.
const { inspectorStubAnchor } = vi.hoisted(() => ({
  inspectorStubAnchor: vi.fn((_recordId: string, _fieldId: string) => true),
}))
// #5808: when `enabled`, the MetaRecordInspector stub renders the REAL shared MetaCommentsPanel (and so
// the real MetaCommentComposer) with the same comment props/emits the real inspector forwards, so the
// workbench's comment-edit path can be driven end to end. Off by default: every other test keeps the
// plain stand-in buttons. Reset in the top-level beforeEach.
// #5813: `realInspector` goes one step further — the stub renders the REAL MetaRecordInspector (and so its
// real tab bar, which unmounts the comments tabpanel on every switch) instead of the bare panel, inside
// the same `data-real-comments-panel` wrapper so the #5808 helpers keep working.
const { inspectorStubRealComments } = vi.hoisted(() => ({
  inspectorStubRealComments: { enabled: false, realInspector: false },
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
// The options the workbench created its grid with (e.g. `holdsHistory`).
let gridOptions: any
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
  useMultitableGrid: (options: unknown) => {
    gridOptions = options
    return gridMock
  },
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
    // #5813: read only by the real inspector's provenance section (opt-in `realInspector` harness).
    hasPermission: () => false,
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
// Review round 2 (S2): `toolbarMode.real` makes this double render the REAL MetaToolbar with everything the
// workbench passed, so the sheet-switch specs see the real buttons (mount identity, `disabled`, the closed-reason
// span). Off by default: every other spec keeps the stand-in below.
const toolbarMode = vi.hoisted(() => ({ real: false }))
vi.mock('../src/multitable/components/MetaToolbar.vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/multitable/components/MetaToolbar.vue')>()
  return {
  default: defineComponent({
    name: 'MetaToolbar',
    inheritAttrs: false,
    props: {
      fields: { type: Array, default: () => [] },
      // persist-display-prefs: expose the inbound row-density so the round-trip can be asserted.
      rowDensity: { type: String, default: undefined },
      // 备料分批拉取第一期 step 3: what the workbench hands the toolbar about the export buttons.
      canExport: { type: Boolean, default: undefined },
      exportClosedReason: { type: String, default: null },
      exportPending: { type: Boolean, default: false },
    },
    emits: ['add-record', 'import', 'export-csv', 'export-xlsx', 'set-row-density'],
    render() {
      if (toolbarMode.real) {
        return h(actual.default as never, {
          ...this.$attrs,
          ...this.$props,
          onAddRecord: () => this.$emit('add-record'),
          onImport: () => this.$emit('import'),
          onExportCsv: () => this.$emit('export-csv'),
          onExportXlsx: () => this.$emit('export-xlsx'),
          onSetRowDensity: (density: string) => this.$emit('set-row-density', density),
        })
      }
      const fieldIds = (this.$props.fields as Array<{ id?: string }>)
        .map((field) => field.id ?? '')
        .filter((fieldId) => fieldId.length > 0)
        .join(',')
      return h(
        'div',
        {
          'data-toolbar-field-ids': fieldIds,
          'data-toolbar-row-density': this.$props.rowDensity ?? '',
          'data-toolbar-can-export': String(this.$props.canExport),
          'data-toolbar-export-closed-reason': this.$props.exportClosedReason ?? '',
          'data-toolbar-export-pending': String(this.$props.exportPending),
        },
        [
          // The stub's xlsx button ignores any disabled state on purpose: it stands for a stale or scripted
          // emit, so the workbench's own re-check is what the closure tests exercise.
          h(
            'button',
            {
              'data-export-xlsx': 'true',
              onClick: () => this.$emit('export-xlsx'),
            },
            'export-xlsx',
          ),
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
  }
})
vi.mock('../src/multitable/components/MetaGridTable.vue', () => ({
  default: defineComponent({
    name: 'MetaGridTable',
    props: {
      // persist-display-prefs: expose the inbound display-pref props for round-trip assertions.
      columnWidths: { type: Object, default: () => ({}) },
      collapsedGroupKeys: { type: Array, default: () => [] },
      rowDensity: { type: String, default: undefined },
      // PR-B1 round 2: the grid's own `:fetch-record="fetchLinkedRecordFn"` binding, recorded into
      // `gridStubSeen` so the inspector's binding can be asserted IDENTICAL to it (HI-1).
      fetchRecord: { type: Function, default: undefined },
      mentionSearch: { type: Function, default: undefined },
    },
    // Record inspector v3 (2026-09-05, PR-A §1.1): `expand-record` added to this stub's emits —
    // `select-record` alone is now a plain cursor move (W2 lock §3.1 erratum) and no longer opens
    // the inspector; tests that need the panel OPEN click the new `data-expand-record` button
    // (mirrors the real grid's row-number icon → `expand-record`).
    emits: ['select-record', 'expand-record', 'open-comments', 'open-field-comments', 'resize-column', 'toggle-group', 'bulk-edit', 'selection-change', 'set-frozen-rows', 'open-link-picker', 'open-person-picker'],
    render() {
      gridStubSeen.fetchRecord = this.$props.fetchRecord as typeof gridStubSeen.fetchRecord
      gridStubSeen.mentionSearch = this.$props.mentionSearch as typeof gridStubSeen.mentionSearch
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
        // #5863c: row-freeze pin round-trip — mirrors the real grid's per-row pin → set-frozen-rows.
        h(
          'button',
          {
            'data-set-frozen-rows': '2',
            onClick: () => this.$emit('set-frozen-rows', 2),
          },
          'set-frozen-rows',
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
        // A link / person cell of rec_1 opens its picker (the real grid's cell editor → `open-link-picker` /
        // `open-person-picker`); the picker stubs below confirm.
        h(
          'button',
          {
            'data-open-link-picker': 'rec_1',
            onClick: () => this.$emit('open-link-picker', { recordId: 'rec_1', field: { id: 'fld_parts', name: 'Parts', type: 'link' } }),
          },
          'open-link-picker',
        ),
        h(
          'button',
          {
            'data-open-person-picker': 'rec_1',
            onClick: () => this.$emit('open-person-picker', { recordId: 'rec_1', field: { id: 'fld_owner', name: 'Owner', type: 'person' } }),
          },
          'open-person-picker',
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
vi.mock('../src/multitable/components/MetaRecordInspector.vue', async () => {
  const { default: RealMetaCommentsPanel } = await import('../src/shared/comments/components/MetaCommentsPanel.vue')
  const { default: RealMetaRecordInspector } = await vi.importActual<{ default: Component }>('../src/multitable/components/MetaRecordInspector.vue')
  return {
  default: defineComponent({
    name: 'MetaRecordInspector',
    props: {
      visible: { type: Boolean, default: false },
      record: { type: Object, default: null },
      // Round 3 (2026-09-05): declared so the workbench's `:opener-el` binding arrives as a typed
      // prop (recorded into `inspectorStubSeen` in `render` below) instead of a stringified
      // fallthrough attr — see the holder's own comment near the top of this file.
      openerEl: { type: Object as PropType<HTMLElement | null>, default: null },
      // PR-B1 round 2 (refuter P2): the two headline B1 bindings on `<MetaRecordInspector>` —
      // `:inspector-field-layout="inspectorFieldLayout"` (the WB producer's `{ ordered, hiddenInView }`)
      // and `:fetch-record="fetchLinkedRecordFn"` — declared so they arrive typed and are recorded
      // into `inspectorStubSeen` on every render (see the holder's comment near the top of this file).
      inspectorFieldLayout: { type: Object as PropType<{ ordered: Array<{ id: string }>; hiddenInView: Array<{ id: string }> } | null>, default: undefined },
      fetchRecord: { type: Function, default: undefined },
      commentTargetFieldId: { type: String, default: null },
      highlightedCommentId: { type: String, default: null },
      mentionSuggestions: { type: Array, default: () => [] },
      mentionSearch: { type: Function, default: undefined },
      uploadFn: { type: Function, default: undefined },
      deleteAttachmentFn: { type: Function, default: undefined },
      // PR-B2 (2026-09-05, record inspector v3 §1.3): declared so the workbench's `:field-errors`
      // binding arrives as a typed prop and is rendered below as the same `[data-test=
      // drawer-field-error][data-field-id]` node the real MetaRecordFieldsPanel renders.
      fieldErrors: { type: Object as PropType<Record<string, string> | null>, default: null },
      // #5808: the comment-tab props the real inspector forwards to MetaCommentsPanel, declared so the
      // opt-in real panel below receives them typed (see `inspectorStubRealComments`).
      comments: { type: Array, default: () => [] },
      commentDraft: { type: String, default: '' },
      commentEditingId: { type: String, default: null },
      commentComposerInitialMentions: { type: Array, default: () => [] },
      currentUserId: { type: String, default: null },
      canComment: { type: Boolean, default: false },
      // #5813: forwarded to the opt-in real inspector (its default tab / later switch to comments).
      openComments: { type: Boolean, default: false },
    },
    emits: [
      'close', 'toggle-comments', 'comment-field', 'navigate', 'delete', 'patch',
      'comment-submit', 'comment-reply', 'comment-cancel-reply', 'update:comment-draft',
      'comment-edit', 'comment-cancel-edit',
      // Record inspector v3 (2026-09-05, PR-B1 §1.3 "Copy link"): the real inspector's copy-link icon
      // emits `copy-link`; the workbench owns the clipboard write (`onCopyRecordLink`). The
      // `data-copy-link` button below is this stub's stand-in for that icon.
      'copy-link',
    ],
    watch: {
      // The blur-commit field below shows the record's title, but keeps what it shows while it is focused, as the
      // rich text editor does (its DOM is not rewritten under the caret).
      record(next: { data?: Record<string, unknown> } | null) {
        const field = document.querySelector<HTMLInputElement>('[data-blur-commit="fld_title"]')
        if (field && document.activeElement !== field) field.value = String(next?.data?.fld_title ?? '')
      },
    },
    methods: {
      // PR-B2 round 2: same name/signature as the real component's `defineExpose`d query; reachable
      // through the workbench's `ref="recordInspectorRef"` because Options-API methods sit on the
      // public instance. Delegates to the hoisted spy so tests can both steer and inspect it.
      canAnchorFieldError(recordId: string, fieldId: string): boolean {
        return inspectorStubAnchor(recordId, fieldId)
      },
    },
    render() {
      // Round 3 (2026-09-05): record what THIS render was given, visible or not — the real component
      // instance stays mounted across every open/close (no `v-if` at the workbench call site), so the
      // prop keeps flowing to it after `visible` drops back to false too.
      inspectorStubSeen.openerEl = (this.$props.openerEl as HTMLElement | null) ?? null
      inspectorStubSeen.renders += 1
      inspectorStubSeen.fieldLayout = this.$props.inspectorFieldLayout as typeof inspectorStubSeen.fieldLayout
      inspectorStubSeen.fetchRecord = this.$props.fetchRecord as typeof inspectorStubSeen.fetchRecord
      inspectorStubSeen.mentionSearch = this.$props.mentionSearch as typeof inspectorStubSeen.mentionSearch
      inspectorStubSeen.uploadFn = this.$props.uploadFn as typeof inspectorStubSeen.uploadFn
      inspectorStubSeen.deleteAttachmentFn = this.$props.deleteAttachmentFn as typeof inspectorStubSeen.deleteAttachmentFn
      inspectorStubSeen.record = (this.$props.record as typeof inspectorStubSeen.record) ?? null
      if (inspectorStubRealComments.realInspector) {
        // #5813: stays mounted while hidden, like the real shell at the workbench call site.
        const shownRecordId = this.$props.visible ? (this.$props.record as { id?: string } | null)?.id ?? '' : ''
        return h('div', { 'data-real-comments-panel': 'true', 'data-record-drawer': shownRecordId || undefined }, [
          h(RealMetaRecordInspector, {
            visible: this.$props.visible,
            record: this.$props.record,
            fields: [],
            canEdit: false,
            canComment: this.$props.canComment,
            canDelete: false,
            comments: this.$props.comments,
            commentDraft: this.$props.commentDraft,
            commentEditingId: this.$props.commentEditingId,
            currentUserId: this.$props.currentUserId,
            mentionSuggestions: this.$props.mentionSuggestions,
            mentionSearch: this.$props.mentionSearch,
            commentComposerInitialMentions: this.$props.commentComposerInitialMentions,
            openComments: this.$props.openComments,
            onCommentSubmit: (payload: { content: string; mentions: string[] }) => this.$emit('comment-submit', payload),
            onCommentEdit: (commentId: string) => this.$emit('comment-edit', commentId),
            onCommentCancelEdit: () => this.$emit('comment-cancel-edit'),
            onToggleComments: () => this.$emit('toggle-comments'),
            'onUpdate:commentDraft': (value: string) => this.$emit('update:comment-draft', value),
          }),
        ])
      }
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
            'data-copy-link': 'true',
            onClick: () => this.$emit('copy-link'),
          },
          'copy-link',
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
        // The inspector re-selects the record shown (after a permission change) through the same emit.
        h(
          'button',
          {
            'data-navigate-record': 'rec_1',
            onClick: () => this.$emit('navigate', 'rec_1'),
          },
          'navigate-record-1',
        ),
        // A field that commits on blur, as the drawer's text fields and its rich text editor do, inside the
        // drawer's root (as every control of the real inspector is).
        h('div', { class: 'meta-record-drawer' }, [
          h('input', {
            'data-blur-commit': 'fld_title',
            onBlur: (event: FocusEvent) => this.$emit('patch', 'fld_title', (event.target as HTMLInputElement).value),
          }),
          // A control only rec_1 shows (a field hidden on another record), and the drawer's open tab.
          this.record?.id === 'rec_1' ? h('input', { 'data-rec1-only': 'true' }) : null,
          // An editable surface, as the rich text editor's (jsdom has no isContentEditable: the cell sets it).
          h('div', { 'data-stub-editable': 'true', contenteditable: 'true', tabindex: 0 }, 'two words'),
          h('div', { role: 'tabpanel', tabindex: 0, 'data-stub-tabpanel': 'true' }),
        ]),
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
        // A second save of the same field (two saves of one field, the second made while the first is out).
        h(
          'button',
          {
            'data-patch-record-again': 'fld_title',
            onClick: () => this.$emit('patch', 'fld_title', 'Second title'),
          },
          'patch-record-again',
        ),
        // PR-B2 round 2: a second patchable field so two drawer patches can be in flight at once.
        h(
          'button',
          {
            'data-patch-record': 'fld_status',
            onClick: () => this.$emit('patch', 'fld_status', 'Patched status'),
          },
          'patch-record-status',
        ),
        // An attachment write names the record it was made on (the third argument): it can end after the
        // drawer moved to another record. One button per named record.
        h(
          'button',
          {
            'data-patch-record-for': 'rec_1',
            onClick: () => this.$emit('patch', 'fld_title', 'Stale title', 'rec_1'),
          },
          'patch-stale',
        ),
        h(
          'button',
          {
            'data-patch-record-for': 'rec_2',
            onClick: () => this.$emit('patch', 'fld_title', 'Named title', 'rec_2'),
          },
          'patch-named',
        ),
        h(
          'button',
          {
            'data-patch-record-for': 'rec_remote',
            onClick: () => this.$emit('patch', 'fld_files', ['att_2'], 'rec_remote'),
          },
          'patch-remote-files',
        ),
        // A remove that ended after the drawer moved on also names the ids it took out (the fourth argument);
        // the value is the list it started from. One button per named record.
        ...['rec_1', 'rec_2', 'rec_remote'].map((recordId) => h(
          'button',
          {
            'data-patch-removed-for': recordId,
            onClick: () => this.$emit('patch', 'fld_files', ['att_stale'], recordId, ['att_1']),
          },
          'patch-removed',
        )),
        // An upload that adds to the list names the ids it added (the fifth argument); the value is the list it
        // started from plus those ids. One button per named record.
        ...['rec_1', 'rec_2', 'rec_remote'].map((recordId) => h(
          'button',
          {
            'data-patch-added-for': recordId,
            onClick: () => this.$emit('patch', 'fld_files', ['att_stale', 'att_new'], recordId, undefined, ['att_new']),
          },
          'patch-added',
        )),
        // A clear-all that ended after the drawer moved on: every id it took out goes with it.
        h(
          'button',
          {
            'data-patch-cleared-for': 'rec_1',
            onClick: () => this.$emit('patch', 'fld_files', [], 'rec_1', ['att_1', 'att_2']),
          },
          'patch-cleared',
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
        // #5808: same bindings as MetaRecordInspector.vue's own <MetaCommentsPanel> (comments tab).
        inspectorStubRealComments.enabled
          ? h('div', { 'data-real-comments-panel': 'true' }, [
            h(RealMetaCommentsPanel, {
              comments: this.$props.comments as never,
              loading: false,
              canComment: this.$props.canComment,
              canResolve: false,
              draft: this.$props.commentDraft,
              editingCommentId: this.$props.commentEditingId,
              currentUserId: this.$props.currentUserId,
              mentionSuggestions: this.$props.mentionSuggestions as never,
              mentionSearch: this.$props.mentionSearch as never,
              composerInitialMentions: this.$props.commentComposerInitialMentions as never,
              onSubmit: (payload: { content: string; mentions: string[] }) => this.$emit('comment-submit', payload),
              onEdit: (commentId: string) => this.$emit('comment-edit', commentId),
              'onUpdate:draft': (value: string) => this.$emit('update:comment-draft', value),
            }),
          ])
          : null,
      ])
    },
  }),
  }
})
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
// The pickers: while open, one button that confirms a fixed choice (the real pickers emit `confirm` with the ids
// picked and their summaries). Closed, the link picker is the bare stand-in it was, and the person picker renders
// nothing.
vi.mock('../src/multitable/components/MetaLinkPicker.vue', () => ({
  default: defineComponent({
    name: 'MetaLinkPicker',
    props: { visible: { type: Boolean, default: false } },
    emits: ['close', 'confirm'],
    render() {
      return h('div', { 'data-stub-MetaLinkPicker': 'true' }, this.$props.visible
        ? [h(
          'button',
          {
            'data-link-picker-confirm': 'true',
            onClick: () => this.$emit('confirm', { recordIds: ['rec_part_1'], summaries: [{ id: 'rec_part_1', display: 'Part 1' }] }),
          },
          'link-picker-confirm',
        )]
        : [])
    },
  }),
}))
vi.mock('../src/multitable/components/MetaPersonPicker.vue', () => ({
  default: defineComponent({
    name: 'MetaPersonPicker',
    inheritAttrs: false,
    props: { visible: { type: Boolean, default: false } },
    emits: ['close', 'confirm'],
    render() {
      if (!this.$props.visible) return null
      return h('div', { 'data-stub-MetaPersonPicker': 'true' }, [h(
        'button',
        {
          'data-person-picker-confirm': 'true',
          onClick: () => this.$emit('confirm', { userIds: ['user_jamie'], summaries: [{ id: 'user_jamie', display: 'Jamie' }] }),
        },
        'person-picker-confirm',
      )])
    },
  }),
}))
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

/** The drawer asks for the version the server returns on every save (`patchCell`'s `onCommitted`). */
const ROW_SAVE = { onCommitted: expect.any(Function) }
import { DIALOG_META_REFRESH_INTERVAL_MS } from '../src/multitable/utils/dialog-meta-refresh'
import { CELL_WRITE_SUPERSEDED } from '../src/multitable/utils/cell-write'
import { createWorkbenchUndo, drawerCommitContainers, installWorkbenchUndo, isWorkbenchGridSurface, isWorkbenchGridTarget, textEntryHost } from '../src/multitable/utils/workbench-undo'
import { useLocale } from '../src/composables/useLocale'

/** A save's record, field, value and version (the options a call carries are pinned where they matter). */
const firstFourArgs = (calls: unknown[][]) => calls.map((call) => call.slice(0, 4))

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
    // PR-B2 round 2 (2026-09-05): the workbench routes on what `patchCell` RETURNS for its own call (a
    // `GridPatchFailure`, or null) — there is no shared "last failure" ref any more; each test's
    // `patchCell.mockImplementation` returns the failure it plays.
    // PR-B2 (2026-09-05): `lastBatchId` is what the real composable exposes for the success toast's
    // "view in history" action (`historyLinkAction(grid.lastBatchId.value)` in onDrawerPatch). It was
    // missing from this mock because, until PR-B2, no test in this file ever drove `onDrawerPatch` to its
    // SUCCESS branch — the stub's `data-patch-record` button existed but was never clicked.
    lastBatchId: ref<string | null>(null),
    // The composable's count of cell writes not yet answered (the leave-page prompts read it).
    pendingCellWriteCount: ref(0),
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
    toolbarMode.real = false
    inspectorStubSeen.openerEl = null
    inspectorStubSeen.renders = 0
    inspectorStubSeen.fieldLayout = undefined
    inspectorStubSeen.fetchRecord = undefined
    inspectorStubSeen.uploadFn = undefined
    inspectorStubSeen.deleteAttachmentFn = undefined
    gridOptions = undefined
    inspectorStubRealComments.enabled = false
    inspectorStubRealComments.realInspector = false
    gridStubSeen.fetchRecord = undefined
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

  // #5750: an embedding host re-sends the same mt:navigate context on a timer (once a second in the
  // report). The host/URL base id is a slug, while workbench.activeBaseId is whatever the LOADED
  // context said (useMultitableWorkbench.syncContextState overwrites it with ctx.base.id /
  // ctx.sheet.baseId) -- so a verbatim comparison of the two can miss forever and every tick
  // re-enters applyExternalContext (and, when the user is busy or has drafts open, the defer toast).
  async function replayExternalContextSync(
    hostState: any,
    context: { baseId: string; sheetId: string; viewId: string },
    times: number,
  ) {
    const results: Array<{ status: string; context: { baseId: string; sheetId: string; viewId: string } }> = []
    for (let i = 0; i < times; i += 1) {
      results.push(await hostState.workbenchRef.requestExternalContextSync(context, { requestId: `req_${i}` }))
      await flushUi()
    }
    return results
  }

  it('#5750 short-circuits repeated external context syncs whose base id is spelled differently from the loaded base', async () => {
    const hostState = mountWorkbench({ baseId: 'base-ops-slug', sheetId: 'sheet_orders', viewId: 'view_grid' })
    await flushUi()
    // What the first load already wrote into the state: the CONTEXT's base id, not the URL slug.
    workbenchMock.activeBaseId.value = 'base_ops'
    workbenchMock.sheets.value = [{ id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null }]
    await flushUi()
    workbenchMock.syncExternalContext.mockClear()

    const results = await replayExternalContextSync(
      hostState,
      { baseId: 'base-ops-slug', sheetId: 'sheet_orders', viewId: 'view_grid' },
      5,
    )

    expect(workbenchMock.syncExternalContext).not.toHaveBeenCalled()
    expect(results.map((result) => result.status)).toEqual(['applied', 'applied', 'applied', 'applied', 'applied'])
    // The echo carries the base the workbench is really on, so the embed host can pin it in the URL.
    expect(results[0].context).toEqual({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' })
  })

  it('#5750 keeps syncing when the base id is not the only difference, or when the active sheet is not known to live in the active base', async () => {
    const hostState = mountWorkbench({ baseId: 'base-ops-slug', sheetId: 'sheet_orders', viewId: 'view_grid' })
    await flushUi()
    workbenchMock.activeBaseId.value = 'base_ops'
    workbenchMock.sheets.value = [{ id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null }]
    await flushUi()
    workbenchMock.syncExternalContext.mockClear()

    // A different sheet is never ignored, whatever the base id says.
    await hostState.workbenchRef.requestExternalContextSync(
      { baseId: 'base-ops-slug', sheetId: 'sheet_deals', viewId: 'view_grid' },
      { requestId: 'req_other_sheet' },
    )
    await flushUi()
    expect(workbenchMock.syncExternalContext).toHaveBeenCalledTimes(1)

    // Neither is a different view.
    await hostState.workbenchRef.requestExternalContextSync(
      { baseId: 'base-ops-slug', sheetId: 'sheet_orders', viewId: 'view_gallery' },
      { requestId: 'req_other_view' },
    )
    await flushUi()
    expect(workbenchMock.syncExternalContext).toHaveBeenCalledTimes(2)

    // And the base id is only ignored when the loaded sheet list PROVES the active sheet lives in
    // the active base: an unknown active sheet keeps the strict comparison.
    workbenchMock.sheets.value = []
    await flushUi()
    await hostState.workbenchRef.requestExternalContextSync(
      { baseId: 'base-ops-slug', sheetId: 'sheet_orders', viewId: 'view_grid' },
      { requestId: 'req_unknown_sheet' },
    )
    await flushUi()
    expect(workbenchMock.syncExternalContext).toHaveBeenCalledTimes(3)
  })

  // #5750 review: a host that posts only { baseId } gets sheetId/viewId filled in from the CURRENT
  // ones (MultitableEmbedHost.handleNavigateMessage), so it lands on exactly the comparison above.
  // A base id the workbench knows is a real base switch and must never be ignored -- otherwise that
  // request is answered 'applied' while the frame stays where it was.
  it('#5750 never ignores a base id that names another KNOWN base', async () => {
    const hostState = mountWorkbench({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' })
    await flushUi()
    workbenchMock.activeBaseId.value = 'base_ops'
    workbenchMock.sheets.value = [{ id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null }]
    await flushUi()
    workbenchMock.syncExternalContext.mockClear()

    // base_sales comes from the listBases() mock -- a known base, same sheet/view as now.
    await hostState.workbenchRef.requestExternalContextSync(
      { baseId: 'base_sales', sheetId: 'sheet_orders', viewId: 'view_grid' },
      { requestId: 'req_known_other_base' },
    )
    await flushUi()
    expect(workbenchMock.syncExternalContext).toHaveBeenCalledTimes(1)

    // An UNKNOWN id for the base the active sheet already lives in is still ignored (that is the
    // URL-slug case this fast path exists for).
    await hostState.workbenchRef.requestExternalContextSync(
      { baseId: 'base-ops-slug', sheetId: 'sheet_orders', viewId: 'view_grid' },
      { requestId: 'req_slug' },
    )
    await flushUi()
    expect(workbenchMock.syncExternalContext).toHaveBeenCalledTimes(1)
  })

  // #5750 follow-up: the LOADED context, not the caller, decides the active triple --
  // useMultitableWorkbench.syncContextState falls activeViewId back to views[0] when the requested
  // view is not in ctx.views (a deleted/renamed view id in the host's URL is the common case). The
  // sync SUCCEEDS there, so the request is 'applied' while the workbench sits on another view; an
  // echo carrying the REQUESTED view hands the embed host a dead triple to pin into the URL and
  // re-send forever. The echo has to report what is on screen.
  it('#5750 follow-up echoes the RESOLVED context (dead viewId falls back to views[0]) instead of the requested one', async () => {
    const hostState = mountWorkbench({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' })
    await flushUi()
    workbenchMock.syncExternalContext.mockClear()
    // The composable's real view fallback, in mock form.
    workbenchMock.syncExternalContext.mockImplementation(
      async ({ baseId, sheetId, viewId }: { baseId?: string; sheetId?: string; viewId?: string }) => {
        workbenchMock.activeBaseId.value = baseId ?? ''
        workbenchMock.activeSheetId.value = sheetId ?? ''
        const viewExists = workbenchMock.views.value.some((view) => view.id === viewId)
        workbenchMock.activeViewId.value = viewExists ? (viewId ?? '') : (workbenchMock.views.value[0]?.id ?? '')
        return true
      },
    )

    const result = await hostState.workbenchRef.requestExternalContextSync(
      { baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_deleted' },
      { requestId: 'req_dead_view' },
    )
    await flushUi()

    // The request still goes out verbatim -- only the ECHO is resolved.
    expect(workbenchMock.syncExternalContext).toHaveBeenCalledTimes(1)
    expect(workbenchMock.syncExternalContext).toHaveBeenCalledWith({
      baseId: 'base_ops',
      sheetId: 'sheet_orders',
      viewId: 'view_deleted',
    })
    expect(workbenchMock.activeViewId.value).toBe('view_grid')
    expect(result.context.viewId).not.toBe('view_deleted')
    expect(result).toEqual({
      status: 'applied',
      context: { baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' },
      requestId: 'req_dead_view',
    })
  })

  // Same resolution for the DEFERRED path: the replay echo (an emitted event, not a return value)
  // is the only answer a host gets for a request that was parked, so it must resolve too.
  it('#5750 follow-up echoes the RESOLVED context on the deferred replay path as well', async () => {
    const hostState = mountWorkbench({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' })
    await flushUi()
    workbenchMock.syncExternalContext.mockImplementation(
      async ({ baseId, sheetId, viewId }: { baseId?: string; sheetId?: string; viewId?: string }) => {
        workbenchMock.activeBaseId.value = baseId ?? ''
        workbenchMock.activeSheetId.value = sheetId ?? ''
        const viewExists = workbenchMock.views.value.some((view) => view.id === viewId)
        workbenchMock.activeViewId.value = viewExists ? (viewId ?? '') : (workbenchMock.views.value[0]?.id ?? '')
        return true
      },
    )

    // Park the request behind an open dirty draft, then clear it so the replay runs.
    const managerButtons = Array.from(container!.querySelectorAll('.mt-workbench__mgr-btn')) as HTMLButtonElement[]
    managerButtons.find((button) => button.textContent?.includes('Fields'))?.click()
    await flushUi()
    container!.querySelector<HTMLButtonElement>('[data-field-manager-dirty="true"]')!.click()
    await flushUi()

    const deferred = await hostState.workbenchRef.requestExternalContextSync(
      { baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_deleted' },
      { requestId: 'req_dead_view_replay' },
    )
    expect(deferred.status).toBe('deferred')

    container!.querySelector<HTMLButtonElement>('[data-field-manager-clean="true"]')!.click()
    await flushUi()

    expect(hostState.externalContextResults).toContainEqual({
      status: 'applied',
      context: { baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' },
      requestId: 'req_dead_view_replay',
    })
  })

  // #5750 follow-up, review round 2: echoing "what is on screen" is only honest while what is on
  // screen is still THIS request's resolution. applyExternalContext awaits, and the composable
  // documents that window as reachable (loadBaseContext applies the context and only then awaits
  // /fields, so a rail click or a second sync can move the active triple inside it -- pinned green by
  // tests/multitable-external-context-sync.spec.ts, where a sheet_orders sync resolves true with
  // sheet_deals on screen). An intruder's triple echoed as 'applied' would make the embed host pin
  // the sheet the host never asked for and drop the navigation while reporting success.
  it('#5750 follow-up echoes the REQUEST, not the intruding triple, when another sheet lands during the apply', async () => {
    const hostState = mountWorkbench({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' })
    await flushUi()
    workbenchMock.syncExternalContext.mockClear()
    workbenchMock.syncExternalContext.mockImplementation(
      async ({ baseId, sheetId, viewId }: { baseId?: string; sheetId?: string; viewId?: string }) => {
        // This sync's own application...
        workbenchMock.activeBaseId.value = baseId ?? ''
        workbenchMock.activeSheetId.value = sheetId ?? ''
        workbenchMock.activeViewId.value = viewId ?? ''
        await Promise.resolve()
        // ...then the rail click that lands inside the /fields await window.
        workbenchMock.selectSheet('sheet_orders')
        workbenchMock.selectView('view_grid')
        return true
      },
    )

    const result = await hostState.workbenchRef.requestExternalContextSync(
      { baseId: 'base_ops', sheetId: 'sheet_people', viewId: 'view_people' },
      { requestId: 'req_raced_sheet' },
    )
    await flushUi()

    expect(workbenchMock.activeSheetId.value).toBe('sheet_orders')
    expect(result).toEqual({
      status: 'applied',
      context: { baseId: 'base_ops', sheetId: 'sheet_people', viewId: 'view_people' },
      requestId: 'req_raced_sheet',
    })
  })

  // Same race, one level finer: the intruder stays on the sheet and only changes the VIEW. The view
  // the request named EXISTS here, so the views[0] fallback cannot explain the difference -- someone
  // else moved, and the echo must not report their view as this request's result.
  it('#5750 follow-up echoes the REQUEST when a concurrent writer switches to another existing view', async () => {
    const hostState = mountWorkbench({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' })
    await flushUi()
    workbenchMock.syncExternalContext.mockClear()
    workbenchMock.syncExternalContext.mockImplementation(
      async ({ baseId, sheetId, viewId }: { baseId?: string; sheetId?: string; viewId?: string }) => {
        workbenchMock.activeBaseId.value = baseId ?? ''
        workbenchMock.activeSheetId.value = sheetId ?? ''
        workbenchMock.activeViewId.value = viewId ?? ''
        await Promise.resolve()
        workbenchMock.selectView('view_timeline')
        return true
      },
    )

    const result = await hostState.workbenchRef.requestExternalContextSync(
      { baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_gallery' },
      { requestId: 'req_raced_view' },
    )
    await flushUi()

    expect(workbenchMock.activeViewId.value).toBe('view_timeline')
    // view_gallery is a real view of this sheet, so nothing about it licenses the swap.
    expect(workbenchMock.views.value.some((view) => view.id === 'view_gallery')).toBe(true)
    expect(result).toEqual({
      status: 'applied',
      context: { baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_gallery' },
      requestId: 'req_raced_view',
    })
  })

  // ...and the base half. A host that posts only { baseId } has the sheet/view filled in from the
  // current ones, so a base switch that is stomped back leaves a triple whose sheet AND view still
  // match the request -- only the base gives the race away.
  it('#5750 follow-up echoes the REQUEST when the base switch is stomped back by another writer', async () => {
    const hostState = mountWorkbench({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' })
    await flushUi()
    workbenchMock.syncExternalContext.mockClear()
    workbenchMock.syncExternalContext.mockImplementation(
      async ({ baseId, sheetId, viewId }: { baseId?: string; sheetId?: string; viewId?: string }) => {
        workbenchMock.activeBaseId.value = baseId ?? ''
        workbenchMock.activeSheetId.value = sheetId ?? ''
        workbenchMock.activeViewId.value = viewId ?? ''
        await Promise.resolve()
        workbenchMock.selectBase('base_ops')
        return true
      },
    )

    const result = await hostState.workbenchRef.requestExternalContextSync(
      { baseId: 'base_sales', sheetId: 'sheet_orders', viewId: 'view_grid' },
      { requestId: 'req_raced_base' },
    )
    await flushUi()

    expect(workbenchMock.activeBaseId.value).toBe('base_ops')
    expect(result).toEqual({
      status: 'applied',
      context: { baseId: 'base_sales', sheetId: 'sheet_orders', viewId: 'view_grid' },
      requestId: 'req_raced_base',
    })
  })

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

  // 备料分批拉取第一期 step 3 (PR A): a sheet the server stamped closed for generic grid export arrives with
  // `capabilities.gridExportClosure` (and canExport false). The toolbar gets the reason (buttons disabled, not
  // hidden), and EVERY client-side export entry re-checks before building a file — selected rows included,
  // because those are generated in the browser and the server's 403 cannot stop them.
  describe('grid export closure (pilot stock-preparation sheet)', () => {
    const CLOSED_REASON_EN = workbenchLabel('notice.gridExportClosed', false)
    function closeActiveSheet() {
      workbenchMock.capabilities.value = { ...workbenchMock.capabilities.value, canExport: false, gridExportClosure: { reason: 'stock_prep_pilot' } } as never
    }
    function withDownloadSpies<T>(run: (spies: { createObjectURL: ReturnType<typeof vi.fn>; downloads: string[] }) => Promise<T>): Promise<T> {
      const downloads: string[] = []
      const originalCreateObjectURL = URL.createObjectURL
      const originalRevokeObjectURL = URL.revokeObjectURL
      const createObjectURL = vi.fn(() => 'blob:multitable-export')
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        downloads.push(this.download)
      })
      return run({ createObjectURL, downloads }).finally(() => {
        clickSpy.mockRestore()
        Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
      })
    }

    it('ordinary sheet: the toolbar gets no closure reason and export opens the dialog as before', async () => {
      mountWorkbench()
      await flushUi()
      const toolbar = container!.querySelector<HTMLElement>('[data-toolbar-export-closed-reason]')!
      expect(toolbar.getAttribute('data-toolbar-export-closed-reason')).toBe('')
      expect(toolbar.getAttribute('data-toolbar-can-export')).toBe('true')
      container!.querySelector<HTMLButtonElement>('[data-export-csv="true"]')!.click()
      await flushUi()
      expect(document.body.querySelector('.meta-export__btn--primary')).not.toBeNull()
      expect(showErrorSpy).not.toHaveBeenCalled()
    })

    it('closed sheet: the toolbar gets the reason, and a stale csv / xlsx emit opens no dialog, builds no file and calls no route', async () => {
      closeActiveSheet()
      await withDownloadSpies(async ({ createObjectURL, downloads }) => {
        mountWorkbench()
        await flushUi()
        const toolbar = container!.querySelector<HTMLElement>('[data-toolbar-export-closed-reason]')!
        expect(toolbar.getAttribute('data-toolbar-export-closed-reason')).toBe(CLOSED_REASON_EN)
        expect(toolbar.getAttribute('data-toolbar-can-export')).toBe('false')
        for (const selector of ['[data-export-csv="true"]', '[data-export-xlsx="true"]']) {
          container!.querySelector<HTMLButtonElement>(selector)!.click()
          await flushUi()
          expect(document.body.querySelector('.meta-export__btn--primary'), selector).toBeNull()
        }
        expect(showErrorSpy).toHaveBeenCalledWith(CLOSED_REASON_EN)
        expect(workbenchMock.client.exportSheet).not.toHaveBeenCalled()
        expect(createObjectURL).not.toHaveBeenCalled()
        expect(downloads).toEqual([])
      })
    })

    for (const format of ['csv', 'xlsx'] as const) {
      it(`the dialog re-checks at confirm: selected rows (${format}) of a sheet closed while the dialog was open are not generated`, async () => {
        buildXlsxBufferMock.mockClear()
        await withDownloadSpies(async ({ createObjectURL, downloads }) => {
          mountWorkbench()
          await flushUi()
          container!.querySelector<HTMLButtonElement>('[data-select-rows="rec_1"]')!.click()
          await flushUi()
          container!.querySelector<HTMLButtonElement>('[data-export-csv="true"]')!.click()
          await flushUi()
          document.body.querySelector<HTMLInputElement>('.meta-export__opt input[value="selected"]')!.click()
          document.body.querySelector<HTMLInputElement>(`.meta-export__opt input[value="${format}"]`)!.click()
          await flushUi()
          // The server closes the sheet and the context reloads while the dialog is still open.
          closeActiveSheet()
          await flushUi()
          document.body.querySelector<HTMLButtonElement>('.meta-export__btn--primary')!.click()
          for (let i = 0; i < 10; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10))
            await flushUi()
          }
          expect(downloads).toEqual([])
          expect(createObjectURL).not.toHaveBeenCalled()
          expect(buildXlsxBufferMock).not.toHaveBeenCalled()
          expect(workbenchMock.client.exportSheet).not.toHaveBeenCalled()
          expect(showErrorSpy).toHaveBeenCalledWith(CLOSED_REASON_EN)
        })
      })
    }

    // Review round 1, fix 3: switching from an OPEN sheet to a CLOSED one. Until the new sheet's /context lands the
    // capabilities (and the closure marker) are still the open sheet's — the stale window. No export may start in it.
    it('switch open → closed: in the stale window no export starts; once the closed context lands the reason shows', async () => {
      workbenchMock.capabilitiesSheetId = ref('sheet_orders')
      workbenchMock.sheets.value = [
        { id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null },
        { id: 'sheet_pilot', baseId: 'base_ops', name: 'Pilot', description: null },
      ]
      await withDownloadSpies(async ({ createObjectURL, downloads }) => {
        mountWorkbench()
        await flushUi()
        const toolbar = () => container!.querySelector<HTMLElement>('[data-toolbar-export-closed-reason]')!
        expect(toolbar().getAttribute('data-toolbar-can-export')).toBe('true') // the open sheet, own capabilities

        workbenchMock.selectSheet('sheet_pilot') // the switch; capabilities are still sheet_orders'
        await flushUi()
        // Round 2: the pair stays mounted (can-export unchanged) but pending → disabled; no reason yet.
        expect(toolbar().getAttribute('data-toolbar-export-pending')).toBe('true')
        expect(toolbar().getAttribute('data-toolbar-export-closed-reason')).toBe('')
        for (const selector of ['[data-export-csv="true"]', '[data-export-xlsx="true"]']) {
          container!.querySelector<HTMLButtonElement>(selector)!.click()
          await flushUi()
          expect(document.body.querySelector('.meta-export__btn--primary'), selector).toBeNull()
        }
        expect(workbenchMock.client.exportSheet).not.toHaveBeenCalled()
        expect(createObjectURL).not.toHaveBeenCalled()
        expect(downloads).toEqual([])

        // The closed sheet's context lands: its capabilities, now owned by the active sheet.
        closeActiveSheet()
        workbenchMock.capabilitiesSheetId.value = 'sheet_pilot'
        await flushUi()
        expect(toolbar().getAttribute('data-toolbar-export-closed-reason')).toBe(CLOSED_REASON_EN)
        expect(toolbar().getAttribute('data-toolbar-can-export')).toBe('false')
        container!.querySelector<HTMLButtonElement>('[data-export-csv="true"]')!.click()
        await flushUi()
        expect(document.body.querySelector('.meta-export__btn--primary')).toBeNull()
        expect(showErrorSpy).toHaveBeenCalledWith(CLOSED_REASON_EN)
      })
    })

    it('switch open → open: export works again once the new sheet’s own context lands (ordinary sheets unaffected after load)', async () => {
      workbenchMock.capabilitiesSheetId = ref('sheet_orders')
      workbenchMock.sheets.value = [
        { id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null },
        { id: 'sheet_other', baseId: 'base_ops', name: 'Other', description: null },
      ]
      mountWorkbench()
      await flushUi()
      workbenchMock.selectSheet('sheet_other')
      await flushUi()
      workbenchMock.capabilitiesSheetId.value = 'sheet_other'
      await flushUi()
      const toolbar = container!.querySelector<HTMLElement>('[data-toolbar-export-closed-reason]')!
      expect(toolbar.getAttribute('data-toolbar-can-export')).toBe('true')
      container!.querySelector<HTMLButtonElement>('[data-export-csv="true"]')!.click()
      await flushUi()
      expect(document.body.querySelector('.meta-export__btn--primary')).not.toBeNull()
    })

    // Review round 2 (S2): the same switches against the REAL MetaToolbar (toolbarMode.real), so what the user sees is
    // asserted on the real buttons — mount identity, `disabled`, and the closed-reason span.
    describe('sheet switch on the REAL MetaToolbar', () => {
      const realCsv = () => container!.querySelector<HTMLButtonElement>('button[title="Export CSV"]')
      const realXlsx = () => container!.querySelector<HTMLButtonElement>('button[aria-label="Export Excel"]:not([data-export-closed])')
      const closedWrapper = () => container!.querySelector<HTMLElement>('[data-testid="meta-toolbar-export-closed"]')
      function twoSheets(second: string) {
        toolbarMode.real = true
        useLocale().setLocale('en')
        workbenchMock.capabilitiesSheetId = ref('sheet_orders')
        workbenchMock.sheets.value = [
          { id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null },
          { id: second, baseId: 'base_ops', name: 'Second', description: null },
        ]
      }

      it('ordinary → ordinary: the pair stays MOUNTED (same nodes), disabled in the window, enabled when the context lands', async () => {
        twoSheets('sheet_other')
        mountWorkbench()
        await flushUi()
        const csv = realCsv()
        const xlsx = realXlsx()
        expect(csv).not.toBeNull()
        expect(xlsx).not.toBeNull()
        expect(csv!.disabled).toBe(false)

        workbenchMock.selectSheet('sheet_other')
        await flushUi()
        expect(realCsv()).toBe(csv) // not unmounted / remounted
        expect(realXlsx()).toBe(xlsx)
        expect(csv!.disabled).toBe(true)
        expect(xlsx!.disabled).toBe(true)
        expect(closedWrapper()).toBeNull()

        workbenchMock.capabilitiesSheetId.value = 'sheet_other' // the new sheet's own context lands
        await flushUi()
        expect(realCsv()).toBe(csv)
        expect(csv!.disabled).toBe(false)
        expect(xlsx!.disabled).toBe(false)
      })

      it('closed → open: the previous sheet\'s closed reason is NOT shown in the window; enabled export once the context lands', async () => {
        twoSheets('sheet_open')
        closeActiveSheet()
        mountWorkbench()
        await flushUi()
        expect(closedWrapper()?.getAttribute('title')).toBe(CLOSED_REASON_EN)

        workbenchMock.selectSheet('sheet_open')
        await flushUi()
        expect(closedWrapper()).toBeNull() // no stale reason
        expect(realCsv()).toBeNull() // the closed sheet's capabilities still say no export; nothing enabled

        workbenchMock.capabilities.value = { ...workbenchMock.capabilities.value, canExport: true, gridExportClosure: undefined } as never
        workbenchMock.capabilitiesSheetId.value = 'sheet_open'
        await flushUi()
        expect(closedWrapper()).toBeNull()
        expect(realCsv()?.disabled).toBe(false)
      })

      it('open → closed: disabled in the window (no reason), then the reason with both buttons disabled', async () => {
        twoSheets('sheet_pilot')
        mountWorkbench()
        await flushUi()
        expect(realCsv()?.disabled).toBe(false)

        workbenchMock.selectSheet('sheet_pilot')
        await flushUi()
        expect(realCsv()?.disabled).toBe(true)
        expect(closedWrapper()).toBeNull()

        closeActiveSheet()
        workbenchMock.capabilitiesSheetId.value = 'sheet_pilot'
        await flushUi()
        expect(closedWrapper()?.getAttribute('title')).toBe(CLOSED_REASON_EN)
        const closedButtons = Array.from(closedWrapper()!.querySelectorAll<HTMLButtonElement>('button[data-export-closed]'))
        expect(closedButtons.map((b) => b.disabled)).toEqual([true, true])
        expect(realCsv()).toBeNull() // the enabled pair is gone; only the disabled closed pair remains
      })
    })

    it('control: the same selected-rows csv export on an ordinary sheet still downloads', async () => {
      await withDownloadSpies(async ({ downloads }) => {
        mountWorkbench()
        await flushUi()
        container!.querySelector<HTMLButtonElement>('[data-select-rows="rec_1"]')!.click()
        await flushUi()
        container!.querySelector<HTMLButtonElement>('[data-export-csv="true"]')!.click()
        await flushUi()
        document.body.querySelector<HTMLInputElement>('.meta-export__opt input[value="selected"]')!.click()
        await flushUi()
        document.body.querySelector<HTMLButtonElement>('.meta-export__btn--primary')!.click()
        await flushUi()
        expect(downloads).toEqual(['Orders.csv'])
      })
    })
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

  it('a form view shows its own record (the form context\'s), not the grid\'s row of it, and submits with its version', async () => {
    workbenchMock.views.value = [
      { id: 'view_form', sheetId: 'sheet_orders', name: 'Form', type: 'form' },
    ]
    workbenchMock.activeViewId.value = 'view_form'
    workbenchMock.client.loadFormContext.mockResolvedValue({
      fields: [{ id: 'fld_title', name: 'Title', type: 'text' }],
      record: { id: 'rec_1', version: 9, data: { fld_title: 'Form record' } },
      rowActions: { canEdit: true, canDelete: true, canComment: true },
    })
    workbenchMock.client.submitForm.mockResolvedValue({ mode: 'update', record: { id: 'rec_1', version: 10, data: { fld_title: 'Form record' } }, attachmentSummaries: {} })
    mountWorkbench({ viewId: 'view_form', recordId: 'rec_1' })
    await flushUi(8)
    // The grid's page holds rec_1 too, at another version.
    expect(gridMock.rows.value.find((r: { id: string }) => r.id === 'rec_1')).toMatchObject({ version: 1 })
    container!.querySelector<HTMLButtonElement>('[data-form-submit="true"]')!.click()
    await flushUi()
    expect(workbenchMock.client.submitForm).toHaveBeenCalledWith('view_form', expect.objectContaining({ recordId: 'rec_1', expectedVersion: 9 }))
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

  // #5795: the mention-candidate endpoint is search-required, so opening a thread must NOT fetch a
  // term-less roster any more; instead the workbench hands every mention editor a search bound to the
  // active sheet (the SAME function to the grid and the inspector), and remembers what it returned.
  it('opens comments without a term-less mention request and wires a sheet-bound mention search', async () => {
    mountWorkbench()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-open-comments="rec_1"]')!.click()
    await flushUi()

    expect(workbenchMock.client.listCommentMentionSuggestions).not.toHaveBeenCalled()
    expect(container!.querySelector('[data-mention-suggestions-count="0"]')).not.toBeNull()
    const search = inspectorStubSeen.mentionSearch
    expect(typeof search).toBe('function')
    expect(gridStubSeen.mentionSearch).toBe(search)

    // An empty term is asked of the server, whose `requiresQuery` marker is passed through untouched.
    workbenchMock.client.listCommentMentionSuggestions.mockResolvedValueOnce({
      items: [], total: 0, limit: 20, query: '', hasMore: false, requiresQuery: true, minQueryLength: 1,
    })
    await expect(search!('')).resolves.toEqual({ items: [], requiresQuery: true, hasMore: false })
    expect(workbenchMock.client.listCommentMentionSuggestions).toHaveBeenLastCalledWith({
      spreadsheetId: 'sheet_orders',
      q: '',
      limit: 20,
    })

    // A real term returns the matches and remembers them (labels of picked people stay resolvable).
    const found = await search!('ja')
    expect(workbenchMock.client.listCommentMentionSuggestions).toHaveBeenLastCalledWith({
      spreadsheetId: 'sheet_orders',
      q: 'ja',
      limit: 20,
    })
    expect(found).toEqual({
      items: [{ id: 'user_jamie', label: 'Jamie', subtitle: 'jamie@example.com' }],
      requiresQuery: false,
      hasMore: false,
    })
    await flushUi()
    expect(container!.querySelector('[data-mention-suggestions-count="1"]')).not.toBeNull()
  })

  // #5808: an old comment whose mentions are NOT `@[label](id)` tokens in its body (e.g. created via the
  // API with an explicit `mentions` array). Since #5795 there is no roster to find their names in, so
  // the list response carries `mentionLabels`; a mention nobody could name must still survive the edit.
  // Driven through the REAL MetaCommentsPanel + MetaCommentComposer (see inspectorStubRealComments).
  describe('#5808 editing a comment keeps mentions that are not tokens in its body', () => {
    const MENTION_SEARCH_SETTLE_MS = 220

    function composerChipLabels(): string[] {
      return Array.from(container!.querySelectorAll('.meta-comment-composer__mention-chip span:first-child'))
        .map((node) => node.textContent?.trim() ?? '')
    }

    async function openEditOf(comment: Record<string, unknown>) {
      inspectorStubRealComments.enabled = true
      mountWorkbench()
      await flushUi()
      container!.querySelector<HTMLButtonElement>('[data-open-comments="rec_1"]')!.click()
      await flushUi()
      commentsStateMock.comments.value = [comment]
      await flushUi()
      const editButton = Array.from(container!.querySelectorAll<HTMLButtonElement>('[data-real-comments-panel] .meta-comments-drawer__reply'))
        .find((button) => button.textContent?.trim() === 'Edit')
      expect(editButton).toBeTruthy()
      editButton!.click()
      await flushUi()
      const textarea = container!.querySelector<HTMLTextAreaElement>('[data-real-comments-panel] textarea')
      expect(textarea).not.toBeNull()
      return textarea!
    }

    async function typeInto(textarea: HTMLTextAreaElement, value: string) {
      textarea.value = value
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await flushUi()
    }

    async function submitComposer() {
      container!.querySelector<HTMLButtonElement>('[data-real-comments-panel] .meta-comment-composer__submit')!.click()
      await flushUi()
    }

    it('shows the server label or a neutral placeholder, and a keystroke + save keeps both ids', async () => {
      const textarea = await openEditOf({
        id: 'comment_api_1',
        containerId: 'sheet_orders',
        targetId: 'rec_1',
        authorId: 'user_1',
        content: 'Please double-check the totals',
        mentions: ['user_fake_robin', 'user_fake_gone'],
        mentionLabels: { user_fake_robin: 'Robin Example' },
        resolved: false,
        createdAt: '2026-09-01T00:00:00.000Z',
      })

      expect(textarea.value).toBe('Please double-check the totals')
      expect(composerChipLabels()).toEqual(['@Robin Example', '@Unknown user'])
      const composer = container!.querySelector('[data-real-comments-panel] .meta-comment-composer')!
      expect(composer.textContent).not.toContain('user_fake_gone')
      expect(composer.textContent).not.toContain('user_fake_robin')

      await typeInto(textarea, 'Please double-check the totals!')
      expect(composerChipLabels()).toEqual(['@Robin Example', '@Unknown user'])

      await submitComposer()
      expect(commentsStateMock.updateComment).toHaveBeenCalledTimes(1)
      expect(commentsStateMock.updateComment).toHaveBeenCalledWith('comment_api_1', {
        content: 'Please double-check the totals!',
        mentions: ['user_fake_robin', 'user_fake_gone'],
      })
      // resolving a label never issues a mention search
      expect(workbenchMock.client.listCommentMentionSuggestions).not.toHaveBeenCalled()
    })

    it('a body token keeps its own label even when a remembered search hit names the same id differently', async () => {
      inspectorStubRealComments.enabled = true
      mountWorkbench()
      await flushUi()
      container!.querySelector<HTMLButtonElement>('[data-open-comments="rec_1"]')!.click()
      await flushUi()
      // a search remembers `user_jamie` as "Jamie" (the default client mock)
      await inspectorStubSeen.mentionSearch!('ja')
      await flushUi()
      commentsStateMock.comments.value = [{
        id: 'comment_token_1',
        containerId: 'sheet_orders',
        targetId: 'rec_1',
        authorId: 'user_1',
        content: '@[J. Example](user_jamie) hi',
        mentions: ['user_jamie'],
        mentionLabels: { user_jamie: 'Jamie' },
        resolved: false,
        createdAt: '2026-09-01T00:00:00.000Z',
      }]
      await flushUi()
      Array.from(container!.querySelectorAll<HTMLButtonElement>('[data-real-comments-panel] .meta-comments-drawer__reply'))
        .find((button) => button.textContent?.trim() === 'Edit')!
        .click()
      await flushUi()
      const textarea = container!.querySelector<HTMLTextAreaElement>('[data-real-comments-panel] textarea')!
      expect(textarea.value).toBe('@J. Example hi')
      expect(composerChipLabels()).toEqual(['@J. Example'])

      await typeInto(textarea, '@J. Example hi!')
      await submitComposer()
      expect(commentsStateMock.updateComment).toHaveBeenCalledWith('comment_token_1', {
        content: '@[J. Example](user_jamie) hi!',
        mentions: ['user_jamie'],
      })
    })

    it('a mention picked during the edit survives later searches (the edit starts from a snapshot)', async () => {
      const textarea = await openEditOf({
        id: 'comment_api_2',
        containerId: 'sheet_orders',
        targetId: 'rec_1',
        authorId: 'user_1',
        content: 'Totals',
        mentions: ['user_fake_robin'],
        mentionLabels: { user_fake_robin: 'Robin Example' },
        resolved: false,
        createdAt: '2026-09-01T00:00:00.000Z',
      })

      await typeInto(textarea, 'Totals @ja')
      await new Promise((resolve) => setTimeout(resolve, MENTION_SEARCH_SETTLE_MS))
      await flushUi()
      const suggestion = container!.querySelector<HTMLButtonElement>('[data-real-comments-panel] .meta-comment-composer__suggestion')
      expect(suggestion?.textContent).toContain('Jamie')
      suggestion!.click()
      await flushUi()
      expect(composerChipLabels()).toEqual(['@Robin Example', '@Jamie'])

      // a second search refreshes the workbench's remembered-people cache
      await typeInto(textarea, `${textarea.value}@jo`)
      await new Promise((resolve) => setTimeout(resolve, MENTION_SEARCH_SETTLE_MS))
      await flushUi()
      expect(workbenchMock.client.listCommentMentionSuggestions).toHaveBeenCalledTimes(2)
      expect(composerChipLabels()).toEqual(['@Robin Example', '@Jamie'])

      await submitComposer()
      expect(commentsStateMock.updateComment).toHaveBeenCalledWith('comment_api_2', {
        content: 'Totals @[Jamie](user_jamie) @jo',
        mentions: ['user_fake_robin', 'user_jamie'],
      })
    })

    it('mention ids that are Object.prototype keys open the edit and are kept under a placeholder', async () => {
      // an own non-string value and an inherited string are not labels either (read by own string key only)
      const labels = Object.assign(Object.create({ user_fake_inherited: 'Fake Inherited' }), { user_fake_numeric: 42 })
      const textarea = await openEditOf({
        id: 'comment_proto_1',
        containerId: 'sheet_orders',
        targetId: 'rec_1',
        authorId: 'user_1',
        content: 'Odd ids',
        mentions: ['constructor', 'toString', '__proto__', 'user_fake_inherited', 'user_fake_numeric'],
        mentionLabels: labels,
        resolved: false,
        createdAt: '2026-09-01T00:00:00.000Z',
      })
      expect(textarea.value).toBe('Odd ids')
      expect(composerChipLabels()).toEqual(Array(5).fill('@Unknown user'))

      await typeInto(textarea, 'Odd ids!')
      await submitComposer()
      expect(commentsStateMock.updateComment).toHaveBeenCalledWith('comment_proto_1', {
        content: 'Odd ids!',
        mentions: ['constructor', 'toString', '__proto__', 'user_fake_inherited', 'user_fake_numeric'],
      })
    })

    // Fix round: a person picked for one NEW comment must not be mentioned again by the next one. The
    // workbench clears the draft after a send and on a record switch but keeps passing the same empty
    // `initialMentions`, so only the composer can drop the picked chip.
    async function openNewCommentOn(recordId: string) {
      container!.querySelector<HTMLButtonElement>(`[data-open-comments="${recordId}"]`)!.click()
      await flushUi()
      const textarea = container!.querySelector<HTMLTextAreaElement>('[data-real-comments-panel] textarea')
      expect(textarea).not.toBeNull()
      return textarea!
    }

    async function pickJamie(textarea: HTMLTextAreaElement) {
      await typeInto(textarea, '@ja')
      await new Promise((resolve) => setTimeout(resolve, MENTION_SEARCH_SETTLE_MS))
      await flushUi()
      const suggestion = container!.querySelector<HTMLButtonElement>('[data-real-comments-panel] .meta-comment-composer__suggestion')
      expect(suggestion?.textContent).toContain('Jamie')
      suggestion!.click()
      await flushUi()
      expect(composerChipLabels()).toEqual(['@Jamie'])
    }

    it('after sending a comment that mentions someone, the next comment mentions nobody', async () => {
      inspectorStubRealComments.enabled = true
      mountWorkbench()
      await flushUi()
      const textarea = await openNewCommentOn('rec_1')
      await pickJamie(textarea)
      await submitComposer()
      expect(addCommentSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({
        targetId: 'rec_1',
        content: '@[Jamie](user_jamie)',
        mentions: ['user_jamie'],
      }))
      expect(textarea.value).toBe('')
      expect(composerChipLabels()).toEqual([])

      await typeInto(textarea, 'thanks everyone')
      await submitComposer()
      expect(addCommentSpy).toHaveBeenCalledTimes(2)
      expect(addCommentSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({
        targetId: 'rec_1',
        content: 'thanks everyone',
        mentions: [],
      }))
    })

    it('a person picked on one record is not mentioned by a note sent on the next record', async () => {
      inspectorStubRealComments.enabled = true
      mountWorkbench()
      await flushUi()
      const textarea = await openNewCommentOn('rec_1')
      await pickJamie(textarea)

      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
      const nextTextarea = await openNewCommentOn('rec_2')
      const confirmMessages = confirmSpy.mock.calls.map((call) => call[0])
      confirmSpy.mockRestore()
      expect(confirmMessages).toEqual(['Discard unsaved record changes?'])
      expect(container!.querySelector('[data-record-drawer="rec_2"]')).toBeTruthy()
      expect(nextTextarea.value).toBe('')
      expect(composerChipLabels()).toEqual([])

      await typeInto(nextTextarea, 'note for record two')
      await submitComposer()
      expect(addCommentSpy).toHaveBeenCalledTimes(1)
      expect(addCommentSpy).toHaveBeenCalledWith(expect.objectContaining({
        targetId: 'rec_2',
        content: 'note for record two',
        mentions: [],
      }))
    })

    // #5813: the REAL inspector unmounts its comments tabpanel on every tab switch; the picked (or
    // removed) mentions must come back with the tab, and still be cleared by a send / record switch /
    // another edit — including one that happens while the comments tab is away.
    describe('#5813 switching inspector tabs keeps the picked and removed mentions', () => {
      const DISCARD_COMMENT_EDIT_PROMPT = 'Discard your unsaved edit to this comment?'

      function inspectorTab(label: string): HTMLButtonElement {
        const tab = Array.from(container!.querySelectorAll<HTMLButtonElement>('[data-real-comments-panel] [role="tab"]'))
          .find((button) => button.textContent?.trim() === label)
        expect(tab).toBeTruthy()
        return tab!
      }

      function composerTextarea(): HTMLTextAreaElement | null {
        return container!.querySelector<HTMLTextAreaElement>('[data-real-comments-panel] .meta-comment-composer textarea')
      }

      async function switchToTab(label: string) {
        inspectorTab(label).click()
        await flushUi()
      }

      async function roundTripTabs(): Promise<HTMLTextAreaElement> {
        await switchToTab('Details')
        expect(composerTextarea()).toBeNull()
        await switchToTab('Comments')
        const textarea = composerTextarea()
        expect(textarea).not.toBeNull()
        return textarea!
      }

      async function mountRealInspector() {
        inspectorStubRealComments.enabled = true
        inspectorStubRealComments.realInspector = true
        mountWorkbench()
        await flushUi()
      }

      async function removeChip(label: string) {
        const chip = Array.from(container!.querySelectorAll<HTMLButtonElement>('.meta-comment-composer__mention-chip'))
          .find((button) => button.querySelector('span')?.textContent?.trim() === label)
        expect(chip).toBeTruthy()
        chip!.click()
        await flushUi()
      }

      async function openEditInRealInspector(comment: Record<string, unknown>) {
        commentsStateMock.comments.value = [...(commentsStateMock.comments.value as unknown[]), comment] as never
        await flushUi()
        const editButton = Array.from(container!.querySelectorAll<HTMLButtonElement>('[data-real-comments-panel] .meta-comments-drawer__reply'))
          .filter((button) => button.textContent?.trim() === 'Edit')
          .at(-1)
        expect(editButton).toBeTruthy()
        editButton!.click()
        await flushUi()
      }

      const apiComment = (id: string, content: string, mentions: string[], mentionLabels: Record<string, string>) => ({
        id,
        containerId: 'sheet_orders',
        targetId: 'rec_1',
        authorId: 'user_1',
        content,
        mentions,
        mentionLabels,
        resolved: false,
        createdAt: '2026-09-01T00:00:00.000Z',
      })

      it('new comment: a person picked before a tab switch is still mentioned after it', async () => {
        await mountRealInspector()
        await openNewCommentOn('rec_1')
        await pickJamie(composerTextarea()!)

        const textarea = await roundTripTabs()
        expect(textarea.value).toBe('@Jamie ')
        expect(composerChipLabels()).toEqual(['@Jamie'])

        await submitComposer()
        expect(addCommentSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({
          targetId: 'rec_1',
          content: '@[Jamie](user_jamie)',
          mentions: ['user_jamie'],
        }))

        // after the send, the next comment mentions nobody — tab switch or not
        expect(composerChipLabels()).toEqual([])
        const next = await roundTripTabs()
        expect(composerChipLabels()).toEqual([])
        await typeInto(next, 'thanks everyone')
        await submitComposer()
        expect(addCommentSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({
          content: 'thanks everyone',
          mentions: [],
        }))
      })

      it('edit: a mention removed before a tab switch stays removed and is not saved', async () => {
        await mountRealInspector()
        await openNewCommentOn('rec_1')
        await openEditInRealInspector(apiComment(
          'comment_api_5813',
          'Please double-check the totals',
          ['user_fake_robin', 'user_fake_gone'],
          { user_fake_robin: 'Robin Example' },
        ))
        expect(composerChipLabels()).toEqual(['@Robin Example', '@Unknown user'])
        await removeChip('@Robin Example')
        expect(composerChipLabels()).toEqual(['@Unknown user'])

        const textarea = await roundTripTabs()
        expect(textarea.value).toBe('Please double-check the totals')
        expect(composerChipLabels()).toEqual(['@Unknown user'])

        await typeInto(textarea, 'Please double-check the totals!')
        await submitComposer()
        expect(commentsStateMock.updateComment).toHaveBeenCalledTimes(1)
        expect(commentsStateMock.updateComment).toHaveBeenCalledWith('comment_api_5813', {
          content: 'Please double-check the totals!',
          mentions: ['user_fake_gone'],
        })
      })

      it("edit: opening a different comment after a tab switch starts from that comment's mentions", async () => {
        await mountRealInspector()
        await openNewCommentOn('rec_1')
        await openEditInRealInspector(apiComment('comment_a', 'First', ['user_fake_robin'], { user_fake_robin: 'Robin Example' }))
        await removeChip('@Robin Example')
        expect(composerChipLabels()).toEqual([])
        await roundTripTabs()
        expect(composerChipLabels()).toEqual([])

        await openEditInRealInspector(apiComment('comment_b', 'Second', ['user_fake_robin', 'user_fake_sam'], {
          user_fake_robin: 'Robin Example',
          user_fake_sam: 'Sam Example',
        }))
        expect(composerTextarea()!.value).toBe('Second')
        expect(composerChipLabels()).toEqual(['@Robin Example', '@Sam Example'])
        await roundTripTabs()
        expect(composerChipLabels()).toEqual(['@Robin Example', '@Sam Example'])
      })

      it('edit: the header Comments button ends the edit and clears its text, so no mention-less copy is sent', async () => {
        await mountRealInspector()
        await openNewCommentOn('rec_1')
        await openEditInRealInspector(apiComment(
          'comment_toggle_5813',
          'Hi @[Robin Example](user_fake_robin)',
          ['user_fake_robin'],
          { user_fake_robin: 'Robin Example' },
        ))
        expect(composerTextarea()!.value).toBe('Hi @Robin Example')
        expect(composerChipLabels()).toEqual(['@Robin Example'])

        const headerCommentsButton = container!.querySelector<HTMLButtonElement>('[data-real-comments-panel] .meta-record-drawer__btn--comment')
        expect(headerCommentsButton).toBeTruthy()
        // the edit has text, so dropping it is confirmed first (accepted here)
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
        try {
          headerCommentsButton!.click()
          await flushUi()
          expect(confirmSpy.mock.calls).toEqual([[DISCARD_COMMENT_EDIT_PROMPT]])
        } finally {
          confirmSpy.mockRestore()
        }

        const textarea = composerTextarea()!
        expect(textarea.value).toBe('')
        expect(composerChipLabels()).toEqual([])
        await typeInto(textarea, 'fresh note')
        await submitComposer()
        expect(commentsStateMock.updateComment).not.toHaveBeenCalled()
        expect(addCommentSpy).toHaveBeenCalledWith(expect.objectContaining({
          targetId: 'rec_1',
          content: 'fresh note',
          mentions: [],
        }))
      })

      // #5813 final review: the header Comments button is also reachable from the Details tab, where
      // the inspector does not switch back to Comments (the edit already set `openComments`), so the
      // edited text must not vanish there without a question.
      async function pressHeaderCommentsAnswering(answer: boolean): Promise<unknown[][]> {
        const headerCommentsButton = container!.querySelector<HTMLButtonElement>('[data-real-comments-panel] .meta-record-drawer__btn--comment')
        expect(headerCommentsButton).toBeTruthy()
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(answer)
        try {
          headerCommentsButton!.click()
          await flushUi()
          return confirmSpy.mock.calls.map((call) => [...call])
        } finally {
          confirmSpy.mockRestore()
        }
      }

      async function openMentionEditThenGoToDetails(id: string) {
        await mountRealInspector()
        await openNewCommentOn('rec_1')
        await openEditInRealInspector(apiComment(
          id,
          'Hi @[Robin Example](user_fake_robin)',
          ['user_fake_robin'],
          { user_fake_robin: 'Robin Example' },
        ))
        expect(composerTextarea()!.value).toBe('Hi @Robin Example')
        expect(composerChipLabels()).toEqual(['@Robin Example'])
        await switchToTab('Details')
        expect(composerTextarea()).toBeNull()
      }

      it('edit, from Details: cancelling the header Comments prompt keeps the edit, its text and its mention', async () => {
        await openMentionEditThenGoToDetails('comment_keep_5813')

        expect(await pressHeaderCommentsAnswering(false)).toEqual([[DISCARD_COMMENT_EDIT_PROMPT]])

        await switchToTab('Comments')
        const textarea = composerTextarea()!
        expect(textarea.value).toBe('Hi @Robin Example')
        expect(composerChipLabels()).toEqual(['@Robin Example'])
        await typeInto(textarea, 'Hi @Robin Example, thanks')
        await submitComposer()
        expect(addCommentSpy).not.toHaveBeenCalled()
        expect(commentsStateMock.updateComment).toHaveBeenCalledTimes(1)
        expect(commentsStateMock.updateComment).toHaveBeenCalledWith('comment_keep_5813', {
          content: 'Hi @[Robin Example](user_fake_robin), thanks',
          mentions: ['user_fake_robin'],
        })
      })

      it('edit, from Details: accepting the header Comments prompt drops the edit, and the next send is a new comment', async () => {
        await openMentionEditThenGoToDetails('comment_drop_5813')

        expect(await pressHeaderCommentsAnswering(true)).toEqual([[DISCARD_COMMENT_EDIT_PROMPT]])

        await switchToTab('Comments')
        const textarea = composerTextarea()!
        expect(textarea.value).toBe('')
        expect(composerChipLabels()).toEqual([])
        await typeInto(textarea, 'fresh note')
        await submitComposer()
        expect(commentsStateMock.updateComment).not.toHaveBeenCalled()
        expect(addCommentSpy).toHaveBeenCalledTimes(1)
        expect(addCommentSpy).toHaveBeenCalledWith(expect.objectContaining({
          targetId: 'rec_1',
          content: 'fresh note',
          mentions: [],
        }))
      })

      it('edit with an emptied text: the header Comments button ends it without asking', async () => {
        await mountRealInspector()
        await openNewCommentOn('rec_1')
        await openEditInRealInspector(apiComment('comment_empty_5813', 'Totals', ['user_fake_robin'], { user_fake_robin: 'Robin Example' }))
        await typeInto(composerTextarea()!, '   ')
        await switchToTab('Details')

        expect(await pressHeaderCommentsAnswering(false)).toEqual([])

        await switchToTab('Comments')
        const textarea = composerTextarea()!
        expect(textarea.value).toBe('')
        expect(composerChipLabels()).toEqual([])
        await typeInto(textarea, 'fresh note')
        await submitComposer()
        expect(commentsStateMock.updateComment).not.toHaveBeenCalled()
        expect(addCommentSpy).toHaveBeenCalledWith(expect.objectContaining({
          targetId: 'rec_1',
          content: 'fresh note',
          mentions: [],
        }))
      })

      it('new comment: the header Comments button keeps an unsent draft and its picked mention', async () => {
        await mountRealInspector()
        await openNewCommentOn('rec_1')
        await pickJamie(composerTextarea()!)

        // nothing is discarded on this path, so nothing is asked
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
        try {
          container!.querySelector<HTMLButtonElement>('[data-real-comments-panel] .meta-record-drawer__btn--comment')!.click()
          await flushUi()
          expect(confirmSpy).not.toHaveBeenCalled()
        } finally {
          confirmSpy.mockRestore()
        }

        expect(composerTextarea()!.value).toBe('@Jamie ')
        expect(composerChipLabels()).toEqual(['@Jamie'])
        await submitComposer()
        expect(addCommentSpy).toHaveBeenCalledWith(expect.objectContaining({
          content: '@[Jamie](user_jamie)',
          mentions: ['user_jamie'],
        }))
      })

      it('a pick made before leaving the tab is not mentioned on the next record, switched to while the tab was away', async () => {
        await mountRealInspector()
        await openNewCommentOn('rec_1')
        await pickJamie(composerTextarea()!)
        await switchToTab('Details')

        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
        container!.querySelector<HTMLButtonElement>('[data-open-comments="rec_2"]')!.click()
        await flushUi()
        confirmSpy.mockRestore()
        expect(container!.querySelector('[data-record-drawer="rec_2"]')).toBeTruthy()

        await switchToTab('Comments')
        const textarea = composerTextarea()!
        expect(textarea.value).toBe('')
        expect(composerChipLabels()).toEqual([])
        await typeInto(textarea, 'note for record two')
        await submitComposer()
        expect(addCommentSpy).toHaveBeenCalledWith(expect.objectContaining({
          targetId: 'rec_2',
          content: 'note for record two',
          mentions: [],
        }))
      })

      it('an edit ended by a record switch while the tab was away does not carry its mentions into a new comment', async () => {
        await mountRealInspector()
        await openNewCommentOn('rec_1')
        await openEditInRealInspector(apiComment('comment_c', 'Totals', ['user_fake_robin'], { user_fake_robin: 'Robin Example' }))
        expect(composerChipLabels()).toEqual(['@Robin Example'])
        await switchToTab('Details')

        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
        container!.querySelector<HTMLButtonElement>('[data-open-comments="rec_2"]')!.click()
        await flushUi()
        confirmSpy.mockRestore()

        await switchToTab('Comments')
        expect(composerChipLabels()).toEqual([])
        await typeInto(composerTextarea()!, 'fresh note')
        await submitComposer()
        expect(commentsStateMock.updateComment).not.toHaveBeenCalled()
        expect(addCommentSpy).toHaveBeenCalledWith(expect.objectContaining({
          targetId: 'rec_2',
          content: 'fresh note',
          mentions: [],
        }))
      })
    })
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

  // #5743: same contract (refresh while open, silence after close), slower clock — the cadence now
  // comes from DIALOG_META_REFRESH_INTERVAL_MS instead of a hard-coded 1200 ms.
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

    await vi.advanceTimersByTimeAsync(DIALOG_META_REFRESH_INTERVAL_MS)
    await flushUi()

    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(2)
    expect(workbenchMock.loadSheetMeta).toHaveBeenLastCalledWith('sheet_orders')

    container!.querySelector<HTMLButtonElement>('[data-close-view-manager="true"]')!.click()
    await flushUi()
    workbenchMock.loadSheetMeta.mockClear()

    await vi.advanceTimersByTimeAsync(DIALOG_META_REFRESH_INTERVAL_MS * 2)
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

  // A cell write the grid has not had an answer for yet (waiting for its record's turn, or out) counts for the
  // leave-page prompts: the grid's `pendingCellWriteCount`.
  function fireBeforeUnload(): BeforeUnloadEvent {
    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    Object.defineProperty(event, 'returnValue', {
      value: undefined,
      writable: true,
      configurable: true,
    })
    window.dispatchEvent(event)
    return event
  }

  it('blocks beforeunload while a cell write is not yet answered, and no longer once it is', async () => {
    mountWorkbench()
    await flushUi()
    expect(fireBeforeUnload().defaultPrevented).toBe(false)

    gridMock.pendingCellWriteCount.value = 1
    const blocked = fireBeforeUnload()
    expect(blocked.defaultPrevented).toBe(true)
    expect(blocked.returnValue).toBe('')

    gridMock.pendingCellWriteCount.value = 0
    expect(fireBeforeUnload().defaultPrevented).toBe(false)
  })

  it('confirmPageLeave asks the busy confirm while a cell write is not yet answered; with none it lets the page go without asking', async () => {
    const hostState = mountWorkbench()
    await flushUi()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    try {
      expect(hostState.workbenchRef.confirmPageLeave()).toBe(true)
      expect(confirmSpy).not.toHaveBeenCalled()

      gridMock.pendingCellWriteCount.value = 2
      expect(hostState.workbenchRef.confirmPageLeave()).toBe(false)
      expect(confirmSpy).toHaveBeenCalledTimes(1)
      expect(confirmSpy).toHaveBeenCalledWith('Leave the multitable while the current save or import is still running?')
      confirmSpy.mockReturnValue(true)
      expect(hostState.workbenchRef.confirmPageLeave()).toBe(true)

      gridMock.pendingCellWriteCount.value = 0
      confirmSpy.mockClear()
      expect(hostState.workbenchRef.confirmPageLeave()).toBe(true)
      expect(confirmSpy).not.toHaveBeenCalled()
    } finally {
      confirmSpy.mockRestore()
    }
  })

  // Control (passes before the change too): the count is the leave-page prompts' only. It is not part of the
  // blocking state, which also defers an external context sync.
  it('a cell write not yet answered is not a blocking state for the embed host, and does not defer an external context sync', async () => {
    const hostState = mountWorkbench()
    await flushUi()
    workbenchMock.syncExternalContext.mockClear()
    gridMock.pendingCellWriteCount.value = 1
    expect(hostState.workbenchRef.getEmbedHostState()).toMatchObject({ hasBlockingState: false, blockingReason: null, busy: false })
    const result = await hostState.workbenchRef.requestExternalContextSync(
      { baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_gallery' },
      { requestId: 'req_while_writing' },
    )
    expect(result.status).not.toBe('deferred')
    expect(workbenchMock.syncExternalContext).toHaveBeenCalledTimes(1)
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

    it('#5863c set-frozen-rows: persists frozenTopRowCount AND preserves sibling config keys', async () => {
      seedGridConfig({ ...SIBLINGS })
      mountWorkbench()
      await flushUi()
      container!.querySelector<HTMLButtonElement>('[data-set-frozen-rows="2"]')!.click()
      await flushUi()

      expect(workbenchMock.client.updateView).toHaveBeenCalledTimes(1)
      const [viewId, body] = workbenchMock.client.updateView.mock.calls[0]
      expect(viewId).toBe('view_grid')
      expect(body.config).toEqual({ ...SIBLINGS, frozenTopRowCount: 2 })
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

  // Record inspector v3 (2026-09-05, PR-B1 §1.3 "Copy link"): the inspector only emits `copy-link`;
  // the workbench writes `window.location.href` — which carries `#recordId=<id>` while the panel is
  // open (hash lifecycle above) — via `copyText` (Clipboard API, execCommand fallback on plain HTTP), and reports the outcome through
  // MetaToast (the `aria-live="polite"` / `role="status"` region, stubbed here as `showSuccessSpy` /
  // `showErrorSpy`) with the reserved `record.copyLinkDone` / `record.copyLinkFailed` keys. The
  // inspector-side "button disabled when the Clipboard API is absent" gate is pinned in
  // multitable-record-fields-sections.spec.ts (it needs the REAL inspector, stubbed out here).
  describe('copy link (§1.3 PR-B1)', () => {
    // jsdom has no `navigator.clipboard`; each test installs exactly the shape it needs and restores
    // the original descriptor (absent → deleted again) so no test sees another's stub.
    function stubClipboard(clipboard: { writeText: (text: string) => Promise<void> } | undefined): () => void {
      const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
      Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
      return () => {
        if (original) Object.defineProperty(navigator, 'clipboard', original)
        else delete (navigator as unknown as Record<string, unknown>).clipboard
      }
    }

    it('writes window.location.href (carrying #recordId=<id>) to the clipboard and reports record.copyLinkDone', async () => {
      const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
      const restore = stubClipboard({ writeText })
      try {
        mountWorkbench()
        await flushUi()
        container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
        await flushUi()
        expect(window.location.hash).toBe('#recordId=rec_1')
        container!.querySelector<HTMLButtonElement>('[data-copy-link="true"]')!.click()
        await flushUi()
        expect(writeText).toHaveBeenCalledTimes(1)
        expect(writeText.mock.calls[0][0]).toBe(window.location.href)
        expect(writeText.mock.calls[0][0]).toContain('#recordId=rec_1')
        expect(showSuccessSpy).toHaveBeenCalledWith(recordLabel('record.copyLinkDone', false), undefined)
        expect(showErrorSpy).not.toHaveBeenCalled()
      } finally {
        restore()
      }
    })

    it('a rejected clipboard write reports record.copyLinkFailed (never copyLinkDone) and does not throw', async () => {
      const writeText = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error('denied'))
      const restore = stubClipboard({ writeText })
      try {
        mountWorkbench()
        await flushUi()
        container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
        await flushUi()
        container!.querySelector<HTMLButtonElement>('[data-copy-link="true"]')!.click()
        await flushUi()
        expect(writeText).toHaveBeenCalledTimes(1)
        expect(showErrorSpy).toHaveBeenCalledWith(recordLabel('record.copyLinkFailed', false))
        expect(showSuccessSpy).not.toHaveBeenCalledWith(recordLabel('record.copyLinkDone', false), undefined)
      } finally {
        restore()
      }
    })

    it('plain-HTTP (no Clipboard API) copies through the execCommand fallback and reports record.copyLinkDone', async () => {
      const restore = stubClipboard(undefined)
      const original = Object.getOwnPropertyDescriptor(document, 'execCommand')
      const copied: string[] = []
      const execCommand = vi.fn((command: string) => {
        copied.push(`${command}:${document.querySelector('textarea')?.value ?? ''}`)
        return true
      })
      Object.defineProperty(document, 'execCommand', { configurable: true, writable: true, value: execCommand })
      try {
        mountWorkbench()
        await flushUi()
        container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
        await flushUi()
        container!.querySelector<HTMLButtonElement>('[data-copy-link="true"]')!.click()
        await flushUi()
        expect(execCommand).toHaveBeenCalledTimes(1)
        expect(copied).toEqual([`copy:${window.location.href}`])
        expect(copied[0]).toContain('#recordId=rec_1')
        expect(showSuccessSpy).toHaveBeenCalledWith(recordLabel('record.copyLinkDone', false), undefined)
        expect(showErrorSpy).not.toHaveBeenCalled()
      } finally {
        if (original) Object.defineProperty(document, 'execCommand', original)
        else Reflect.deleteProperty(document, 'execCommand')
        restore()
      }
    })

    it('with no Clipboard API at all the handler reports record.copyLinkFailed instead of throwing (positive control for the absent-API branch)', async () => {
      const restore = stubClipboard(undefined)
      try {
        expect((navigator as unknown as { clipboard?: unknown }).clipboard).toBeUndefined()
        mountWorkbench()
        await flushUi()
        container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
        await flushUi()
        container!.querySelector<HTMLButtonElement>('[data-copy-link="true"]')!.click()
        await flushUi()
        expect(showErrorSpy).toHaveBeenCalledWith(recordLabel('record.copyLinkFailed', false))
        expect(showSuccessSpy).not.toHaveBeenCalledWith(recordLabel('record.copyLinkDone', false), undefined)
      } finally {
        restore()
      }
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

  // Record inspector v3 PR-B1 round 2 (2026-09-05, refuter P2): the WB PRODUCER `inspectorFieldLayout`
  // (view order ∩ layer-2 ∩ layer-3; `hiddenInView` = the two-layer-visible remainder) and the two
  // `<MetaRecordInspector>` bindings `:inspector-field-layout` / `:fetch-record` had zero coverage —
  // dropping either binding, or replacing view order with sheet order, left tests/multitable green
  // (round-1 refuter probes M16/M17/M18b). The stub records both props on every render (holder near
  // the top of this file); these tests pin the producer's SHAPE against a fixture that exercises all
  // three layers and the `fetchRecord` binding by IDENTITY with the grid's own.
  describe('inspectorFieldLayout producer + fetchRecord wiring reach <MetaRecordInspector> (§1.3 PR-B1, round 2)', () => {
    // Sheet order (grid.fields): a, b, c, secret(layer-2 property-hidden), denied(layer-3), d.
    // Active view (grid.visibleFields): HIDES field 0 (`fld_a`) and REORDERS the rest — d, b, c — while
    // still listing the property-hidden and the permission-denied field (the producer must strike both).
    const SHEET_FIELDS = [
      { id: 'fld_a', name: 'A', type: 'string' },
      { id: 'fld_b', name: 'B', type: 'string' },
      { id: 'fld_c', name: 'C', type: 'string' },
      { id: 'fld_secret', name: 'Secret', type: 'string', property: { hidden: true } },
      { id: 'fld_denied', name: 'Denied', type: 'string' },
      { id: 'fld_d', name: 'D', type: 'string' },
    ]
    const VIEW_ORDER = [SHEET_FIELDS[5], SHEET_FIELDS[1], SHEET_FIELDS[2], SHEET_FIELDS[3], SHEET_FIELDS[4]]
    function arrangeThreeLayerFixture() {
      workbenchMock.fields.value = [...SHEET_FIELDS]
      gridMock.fields.value = [...SHEET_FIELDS]
      // `createGridMock` aliases visibleFields to the SAME ref as fields; give the view its own order.
      gridMock.visibleFields = ref([...VIEW_ORDER])
      gridMock.hiddenFieldIds.value = ['fld_a']
      // grid.fieldPermissions stays {} so `effectiveFieldPermissions` falls through to the workbench's
      workbenchMock.fieldPermissions.value = {
        fld_denied: { visible: false, readOnly: false },
      }
    }
    const ids = (fields: Array<{ id: string }> | undefined) => (fields ?? []).map((field) => field.id)

    it('`ordered` follows the VIEW order intersected with layer-2 and layer-3 (not sheet order); `hiddenInView` is the two-layer-visible remainder', async () => {
      arrangeThreeLayerFixture()
      mountWorkbench()
      await flushUi()
      expect(inspectorStubSeen.renders).toBeGreaterThan(0)
      const layout = inspectorStubSeen.fieldLayout
      expect(layout).toBeTruthy() // the binding is present — an absent prop would leave `undefined`
      // view order d, b, c — secret (layer-2) and denied (layer-3) struck; `fld_a` is view-hidden
      expect(ids(layout!.ordered)).toEqual(['fld_d', 'fld_b', 'fld_c'])
      // NOT the sheet-order two-layer list (what `twoLayerVisibleFields` alone would hand over)
      expect(ids(layout!.ordered)).not.toEqual(['fld_a', 'fld_b', 'fld_c', 'fld_d'])
      // §2 = fields this viewer may see (layer-2 ∩ layer-3) that the view hides: only `fld_a`
      expect(ids(layout!.hiddenInView)).toEqual(['fld_a'])
      // disjoint by construction, and neither list leaks a masked field
      const all = [...ids(layout!.ordered), ...ids(layout!.hiddenInView)]
      expect(new Set(all).size).toBe(all.length)
      expect(all).not.toContain('fld_secret')
      expect(all).not.toContain('fld_denied')
    })

    it('positive control for the fixture: with a view that hides nothing and reorders nothing, `ordered` equals the two-layer sheet order and `hiddenInView` is empty', async () => {
      arrangeThreeLayerFixture()
      gridMock.visibleFields = ref([...SHEET_FIELDS])
      gridMock.hiddenFieldIds.value = []
      mountWorkbench()
      await flushUi()
      expect(ids(inspectorStubSeen.fieldLayout!.ordered)).toEqual(['fld_a', 'fld_b', 'fld_c', 'fld_d'])
      expect(ids(inspectorStubSeen.fieldLayout!.hiddenInView)).toEqual([])
    })

    it('`fetchRecord` reaches the inspector as the SAME function object the grid receives (`fetchLinkedRecordFn`, HI-1) and it calls client.getRecord once with the id', async () => {
      workbenchMock.client.getRecord.mockResolvedValue({ record: { id: 'rec_x', data: {} } })
      mountWorkbench()
      await flushUi()
      expect(typeof inspectorStubSeen.fetchRecord).toBe('function')
      expect(typeof gridStubSeen.fetchRecord).toBe('function')
      // IDENTITY: one `fetchLinkedRecordFn` bound at both call sites, not two wrappers
      expect(inspectorStubSeen.fetchRecord).toBe(gridStubSeen.fetchRecord)
      workbenchMock.client.getRecord.mockClear()
      await inspectorStubSeen.fetchRecord!('rec_x')
      expect(workbenchMock.client.getRecord).toHaveBeenCalledTimes(1)
      expect(workbenchMock.client.getRecord).toHaveBeenCalledWith('rec_x')
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

    // Round 5 (2026-09-05, refuter P3 — `body` handed through as the opener): the test above focuses
    // its opener first because jsdom's `.click()` does not move focus — but "nothing focused at the
    // expand click" is exactly the production state in Safari and Firefox/macOS (a mouse click does
    // NOT focus a `<button>`) and after ANY programmatic `.click()`: `document.activeElement` is
    // `document.body` when the grid's synchronous expand handler runs. `openRecord` used to forward
    // that `body` verbatim as the opener; the inspector's body filter covered only ITS OWN
    // activeElement fallback, so the `body` reached `restoreFocusToOpener`, passed its connected check,
    // and close called `body.focus()` — never falling through to the `.meta-grid` root. `openRecord`
    // now resolves body (and a disconnected element) to `null` via `resolveOpenerEl`. Mutation: drop
    // the `candidate === document.body` clause there → this reds at `toBeNull()` (the stub is handed
    // `<body>`); the identity test above stays green, so the red is the filter's, not the wiring's.
    it('expand-open while document.activeElement is body (nothing focused) hands the inspector openerEl === null, not document.body', async () => {
      mountWorkbench()
      await flushUi()
      ;(document.activeElement as HTMLElement | null)?.blur()
      expect(document.activeElement).toBe(document.body)

      container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
      await flushUi()
      expect(container!.querySelector('[data-record-drawer="rec_1"]')).toBeTruthy() // panel open
      expect(inspectorStubSeen.openerEl).toBeNull() // body is "no opener", not an opener
      expect(inspectorStubSeen.openerEl).not.toBe(document.body)
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
  // `patchCell` would and RETURNS the `GridPatchFailure` the real `patchCell` returns for that call
  // (round 2: per-call return value, no shared ref) — and, for the conflict case, `conflict.value` (the
  // banner's own driver, unchanged by B2). The inline node is the MetaRecordInspector stub's rendering
  // of the `fieldErrors` prop (see the stub); whether the alert CAN render is the stub's
  // `canAnchorFieldError` answer (`inspectorStubAnchor`, default true). The real panel's
  // alert/aria/draft behaviour and the real inspector's `canAnchorFieldError` predicate are pinned in
  // multitable-record-inspector-field-errors.spec.ts.
  describe('onDrawerPatch — field-anchored server errors (PR-B2 §1.3)', () => {
    const ATTEMPTED = 'Patched title' // what the stub's `data-patch-record="fld_title"` button emits
    const ATTEMPTED_STATUS = 'Patched status' // …and its `fld_status` sibling

    beforeEach(() => {
      inspectorStubAnchor.mockImplementation(() => true)
    })

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
    type PlayedFailure = Record<string, unknown>
    function failureFor(fieldId: string, message: string, failure: PlayedFailure) {
      return { recordId: 'rec_1', fieldId, attemptedValue: fieldId === 'fld_title' ? ATTEMPTED : ATTEMPTED_STATUS, message, ...failure }
    }
    /** The composable's observable state after a REJECTED patchCell (rollback is internal to it): `error.value`
     *  set, and the call's own `GridPatchFailure` returned. */
    function rejectNextPatch(message: string, failure: PlayedFailure) {
      gridMock.patchCell.mockImplementation(async (_recordId: string, fieldId: string) => {
        gridMock.error.value = message
        return failureFor(fieldId, message, failure)
      })
    }
    /** The grid accepts the next save, telling the version it moved the record to, as the real `patchCell` does. */
    function acceptNextPatch() {
      gridMock.patchCell.mockImplementation(async (_recordId: string, _fieldId: string, _value: unknown, version: number, options?: { onCommitted?: (v: number) => void }) => {
        gridMock.error.value = null
        options?.onCommitted?.(version + 1)
        return null
      })
    }
    const COPY_SAVE = { onCommitted: expect.any(Function), chainVersion: false }

    it('422 with fieldErrors → NO toast, inline error under that field (no success toast either)', async () => {
      await openRec1()
      rejectNextPatch('Title is too long', { status: 422, code: 'VALIDATION_ERROR', fieldErrors: { fld_title: 'Title is too long' } })
      await patchTitle()
      expect(gridMock.patchCell).toHaveBeenCalledWith('rec_1', 'fld_title', ATTEMPTED, 1, ROW_SAVE)
      expect(showErrorSpy).not.toHaveBeenCalled()
      expect(showSuccessSpy).not.toHaveBeenCalled()
      expect(fieldErrorEl('fld_title')?.textContent).toBe('Title is too long')
      // The workbench asked the inspector about THIS record + field before writing.
      expect(inspectorStubAnchor).toHaveBeenCalledWith('rec_1', 'fld_title')
    })

    it('400 VALIDATION_ERROR with NO fieldErrors (the shape /patch actually sends) → inline too, message = the server message', async () => {
      await openRec1()
      rejectNextPatch('Select value must be string: fld_title', { status: 400, code: 'VALIDATION_ERROR' })
      await patchTitle()
      expect(showErrorSpy).not.toHaveBeenCalled()
      expect(fieldErrorEl('fld_title')?.textContent).toBe('Select value must be string: fld_title')
    })

    it('a plain 400 with a NON-validation code (record-lock refusal ships as 400 FORBIDDEN) keeps the toast, no inline (round 2: code-keyed, not status-keyed)', async () => {
      await openRec1()
      rejectNextPatch('Record is locked: rec_1', { status: 400, code: 'FORBIDDEN' })
      await patchTitle()
      expect(showErrorSpy).toHaveBeenCalledTimes(1)
      expect(showErrorSpy).toHaveBeenCalledWith('Record is locked: rec_1')
      expect(fieldErrorEl('fld_title')).toBeNull()
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
      gridMock.patchCell.mockImplementation(async () => {
        gridMock.error.value = 'Title is too long'
        return failureFor('fld_other', 'Title is too long', { recordId: 'rec_9', status: 422, code: 'VALIDATION_ERROR' })
      })
      await patchTitle()
      expect(showErrorSpy).toHaveBeenCalledWith('Title is too long')
      expect(container!.querySelector('[data-test="drawer-field-error"]')).toBeNull()
    })

    it('a failure for the SAME record but ANOTHER field is not attributed to this control either — toast, no inline (pins the fieldId half of the guard)', async () => {
      await openRec1()
      gridMock.patchCell.mockImplementation(async () => {
        gridMock.error.value = 'Status is invalid'
        return failureFor('fld_other', 'Status is invalid', { status: 422, code: 'VALIDATION_ERROR' }) // recordId stays rec_1
      })
      await patchTitle()
      expect(showErrorSpy).toHaveBeenCalledTimes(1)
      expect(showErrorSpy).toHaveBeenCalledWith('Status is invalid')
      expect(container!.querySelector('[data-test="drawer-field-error"]')).toBeNull()
    })

    it('a failure for ANOTHER record but the SAME field is not attributed to this control either — toast, no inline (round 3: pins the recordId half of the guard)', async () => {
      await openRec1()
      gridMock.patchCell.mockImplementation(async () => {
        gridMock.error.value = 'Title is too long'
        // fieldId stays fld_title (the edited field); ONLY recordId is foreign. The round-2 fixture above
        // flips both ids, so it stayed green with the recordId half of `own` deleted.
        return failureFor('fld_title', 'Title is too long', { recordId: 'rec_9', status: 422, code: 'VALIDATION_ERROR' })
      })
      await patchTitle()
      expect(showErrorSpy).toHaveBeenCalledTimes(1)
      expect(showErrorSpy).toHaveBeenCalledWith('Title is too long')
      expect(container!.querySelector('[data-test="drawer-field-error"]')).toBeNull()
      // A foreign failure never reaches the anchorability ask (`own` short-circuits before it).
      expect(inspectorStubAnchor).not.toHaveBeenCalled()
    })

    it('the LOCAL row-action refusal (error.value set, patchCell returns null) keeps today\'s toast', async () => {
      await openRec1()
      gridMock.patchCell.mockImplementation(async () => {
        gridMock.error.value = 'Record editing is not allowed for this row.'
        return null
      })
      await patchTitle()
      expect(showErrorSpy).toHaveBeenCalledWith('Record editing is not allowed for this row.')
      expect(container!.querySelector('[data-test="drawer-field-error"]')).toBeNull()
    })

    it('VERSION_CONFLICT → the existing conflict banner + a field marker carrying the banner text + the pre-existing toast (kept, round 2); marker clears with the conflict', async () => {
      await openRec1()
      gridMock.patchCell.mockImplementation(async () => {
        gridMock.error.value = 'Row changed elsewhere'
        gridMock.conflict.value = { recordId: 'rec_1', fieldId: 'fld_title', attemptedValue: ATTEMPTED, message: 'Row changed elsewhere', serverVersion: 8 }
        return failureFor('fld_title', 'Row changed elsewhere', { status: 409, code: 'VERSION_CONFLICT' })
      })
      await patchTitle()
      // Banner: exactly the pre-B2 text pinned by 'renders conflict recovery actions…' above.
      expect(container!.textContent).toContain('Update conflict')
      expect(container!.textContent).toContain('Title changed elsewhere. Latest version is 8.')
      // Toast: this path ALWAYS toasted pre-B2; round 1 suppressed it, round 2 keeps it so §4 item 11's
      // "all other codes keep the toast" holds verbatim — banner + marker + toast, exactly once.
      expect(showErrorSpy).toHaveBeenCalledTimes(1)
      expect(showErrorSpy).toHaveBeenCalledWith('Row changed elsewhere')
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

    it('a conflict raised and cleared on a field that carries a VALIDATION alert leaves that alert alone (round 2: origin-tagged clear)', async () => {
      await openRec1()
      rejectNextPatch('Title is too long', { status: 422, code: 'VALIDATION_ERROR', fieldErrors: { fld_title: 'Title is too long' } })
      await patchTitle()
      expect(fieldErrorEl('fld_title')?.textContent).toBe('Title is too long')
      // The GRID path (onPatchCell, untouched by B2) hits a VERSION_CONFLICT on the same field: the real
      // composable sets `conflict`, then the user reloads/dismisses → `conflict` clears.
      gridMock.conflict.value = { recordId: 'rec_1', fieldId: 'fld_title', attemptedValue: 'grid edit', message: 'Row changed elsewhere', serverVersion: 9 }
      await flushUi()
      gridMock.conflict.value = null
      await flushUi()
      // Round 1 wiped the validation alert here (it cleared whatever sat under `previous.fieldId`).
      expect(fieldErrorEl('fld_title')?.textContent).toBe('Title is too long')
      expect(showErrorSpy).not.toHaveBeenCalled()
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

    // A realtime merge of the open record (on the page) gives the drawer a copy of it (`deepLinkedRecord`); the drawer
    // still shows the grid's row while the record is on the page, and the copy only once it leaves the page.
    function mergeAnswer(row: { version: number; data: Record<string, unknown> }, data?: Record<string, unknown>) {
      workbenchMock.client.getRecord.mockResolvedValue({
        record: { id: 'rec_1', version: row.version, data: { ...(data ?? row.data) } },
        linkSummaries: {}, attachmentSummaries: {}, fieldPermissions: {}, viewPermissions: {}, rowActions: null,
        commentsScope: { targetType: 'meta_record', targetId: 'rec_1', containerType: 'meta_sheet', containerId: 'sheet_orders' },
      })
    }
    function realtimeMerge() {
      return (useMultitableSheetRealtimeMock.mock.calls[0]?.[0] as { mergeRemoteRecord: (recordId: string) => Promise<boolean> }).mergeRemoteRecord
    }
    /** The grid (patchCell): the row shows each save at once; each answer comes when released. */
    function heldPatches(row: { data: Record<string, unknown> } | null) {
      const answers: Array<(failure: unknown) => void> = []
      const calls: Array<[string, unknown, number]> = []
      gridMock.patchCell.mockImplementation(async (_recordId: string, fieldId: string, value: unknown, version: number, options?: { onCommitted?: (v: number) => void }) => {
        calls.push([fieldId, value, version])
        if (row) row.data[fieldId] = value
        const failure = await new Promise((resolve) => { answers.push(resolve) })
        gridMock.error.value = null
        if (!failure) options?.onCommitted?.(version + 1)
        return failure
      })
      return { answers, calls }
    }

    it('after a realtime merge of the record shown (on the page) the drawer shows the grid\'s row, not the copy: its saves are the row\'s, which the grid chains', async () => {
      await openRec1()
      const row = gridMock.rows.value.find((r: { id: string }) => r.id === 'rec_1')
      mergeAnswer(row)
      await realtimeMerge()('rec_1')
      await flushUi()
      expect(inspectorStubSeen.record).toBe(row)
      gridMock.patchCell.mockImplementation(async () => { gridMock.error.value = null; return null })
      container!.querySelector<HTMLButtonElement>('[data-patch-record="fld_title"]')!.click()
      await flushUi()
      // Chained by the grid (no `chainVersion: false`); the version returned is asked for, for the copy.
      expect(gridMock.patchCell.mock.calls.at(-1)).toEqual(['rec_1', 'fld_title', ATTEMPTED, row.version, { onCommitted: expect.any(Function) }])
    })

    it('a record opened by its link before the page\'s rows came: the drawer shows its copy until the rows hold the record, then the grid\'s row, whose saves the grid chains', async () => {
      const pageRows = gridMock.rows.value
      const pageRow = pageRows.find((r: { id: string }) => r.id === 'rec_1')
      gridMock.rows.value = []
      mergeAnswer(pageRow)
      mountWorkbench({ recordId: 'rec_1' })
      await flushUi(8)
      expect(workbenchMock.client.getRecord).toHaveBeenCalled()
      expect(inspectorStubSeen.record).toMatchObject({ id: 'rec_1', version: pageRow.version })
      gridMock.rows.value = pageRows
      await flushUi()
      const row = gridMock.rows.value.find((r: { id: string }) => r.id === 'rec_1')
      expect(inspectorStubSeen.record).toBe(row)
      gridMock.patchCell.mockImplementation(async () => { gridMock.error.value = null; return null })
      container!.querySelector<HTMLButtonElement>('[data-patch-record="fld_title"]')!.click()
      await flushUi()
      // Chained by the grid (no `chainVersion: false`); the version returned is asked for, for the copy.
      expect(gridMock.patchCell.mock.calls.at(-1)).toEqual(['rec_1', 'fld_title', ATTEMPTED, row.version, { onCommitted: expect.any(Function) }])
    })

    it('a copy of the record shown takes an accepted save and moves one version on, so the next save carries it', async () => {
      await openRec1()
      const row = gridMock.rows.value.find((r: { id: string }) => r.id === 'rec_1')
      mergeAnswer(row)
      await realtimeMerge()('rec_1')
      await flushUi()
      const start = inspectorStubSeen.record!.version
      const versions: number[] = []
      gridMock.patchCell.mockImplementation(async (_recordId: string, fieldId: string, value: unknown, version: number) => {
        versions.push(version)
        row.data[fieldId] = value
        await Promise.resolve()
        row.version += 1 // the grid's applyPatchResult
        gridMock.error.value = null
        return null
      })
      container!.querySelector<HTMLButtonElement>('[data-patch-record="fld_title"]')!.click()
      await flushUi()
      container!.querySelector<HTMLButtonElement>('[data-patch-record-again="fld_title"]')!.click()
      await flushUi()
      expect(versions).toEqual([start, start + 1])
    })

    it('a copy gone stale while another record was shown is not shown again: back on the record, the drawer shows the row, with the other user\'s change and its version', async () => {
      await openRec1()
      const row0 = gridMock.rows.value.find((r: { id: string }) => r.id === 'rec_1')
      mergeAnswer(row0)
      await realtimeMerge()('rec_1')
      await flushUi()
      container!.querySelector<HTMLButtonElement>('[data-navigate-record="rec_2"]')!.click()
      await flushUi()
      // Another user changes rec_1's status (version 2). The grid merges its row; rec_1 is not shown, so the copy stays.
      mergeAnswer({ version: 2, data: {} }, { ...row0.data, fld_status: 'theirs' })
      gridMock.mergeRemoteRecord.mockImplementation((record: { id: string; version: number; data: Record<string, unknown> }) => {
        gridMock.rows.value = gridMock.rows.value.map((r: { id: string }) => (r.id === record.id ? { ...r, version: record.version, data: { ...record.data } } : r))
        return true
      })
      await realtimeMerge()('rec_1')
      await flushUi()
      container!.querySelector<HTMLButtonElement>('[data-navigate-record="rec_1"]')!.click()
      await flushUi()
      expect(inspectorStubSeen.record).toMatchObject({ version: 2, data: { fld_status: 'theirs' } })
      const sent: Array<[string, number]> = []
      gridMock.patchCell.mockImplementation(async (_recordId: string, fieldId: string, _value: unknown, version: number) => {
        sent.push([fieldId, version])
        if (version !== 2) {
          gridMock.error.value = 'Changed elsewhere'
          return failureFor(fieldId, 'Changed elsewhere', { status: 409, code: 'VERSION_CONFLICT' })
        }
        gridMock.error.value = null
        return null
      })
      container!.querySelector<HTMLButtonElement>('[data-patch-record="fld_title"]')!.click()
      await flushUi()
      container!.querySelector<HTMLButtonElement>('[data-patch-record="fld_status"]')!.click()
      await flushUi()
      // Both are made on the row, which shows 'theirs' with its version: both are stored (the stand-in does not move
      // the row's version on; the real grid chains the second).
      expect(sent).toEqual([['fld_title', 2], ['fld_status', 2]])
      expect(showErrorSpy).not.toHaveBeenCalled()
    })

    it.each([
      ['accepted: the copy takes the save and moves one version on, so the next save carries it', null],
      ['rejected: the copy never shows the save', 'reject'],
    ] as const)('the record leaves the page while a save on its copy is out; %s', async (_name, outcome) => {
      await openRec1()
      const row = gridMock.rows.value.find((r: { id: string }) => r.id === 'rec_1')
      mergeAnswer(row)
      await realtimeMerge()('rec_1')
      await flushUi()
      const versionAtMerge = inspectorStubSeen.record!.version
      const before = inspectorStubSeen.record!.data.fld_title
      const { answers, calls } = heldPatches(row)
      container!.querySelector<HTMLButtonElement>('[data-patch-record="fld_title"]')!.click()
      await flushUi()
      gridMock.rows.value = gridMock.rows.value.filter((r: { id: string }) => r.id !== 'rec_1')
      await flushUi()
      answers[0](outcome ? failureFor('fld_title', 'Insufficient permissions', { status: 403, code: 'FORBIDDEN' }) : null)
      await flushUi()
      expect(inspectorStubSeen.record?.id).toBe('rec_1')
      if (outcome) {
        expect(inspectorStubSeen.record?.data.fld_title).toBe(before)
        return
      }
      expect(inspectorStubSeen.record).toMatchObject({ version: versionAtMerge + 1, data: { fld_title: ATTEMPTED } })
      container!.querySelector<HTMLButtonElement>('[data-patch-record-again="fld_title"]')!.click()
      await flushUi()
      expect(calls.map((call) => call[2])).toEqual([versionAtMerge, versionAtMerge + 1])
    })

    it('a save the grid replaced unsent with a newer save of the field (CELL_WRITE_SUPERSEDED) shows nothing and leaves the field\'s inline error alone: the newer save answers for the field', async () => {
      await openRec1()
      rejectNextPatch('Title is too long', { status: 422, code: 'VALIDATION_ERROR', fieldErrors: { fld_title: 'Title is too long' } })
      await patchTitle()
      expect(fieldErrorEl('fld_title')).toBeTruthy()
      showErrorSpy.mockClear()
      gridMock.patchCell.mockImplementation(async () => CELL_WRITE_SUPERSEDED)
      await patchTitle()
      expect(showSuccessSpy).not.toHaveBeenCalled()
      expect(showErrorSpy).not.toHaveBeenCalled()
      expect(fieldErrorEl('fld_title')).toBeTruthy()
    })

    it('an older save of the record that fails while this one waits (the grid\'s shared error set after the call) does not make this one\'s success a local refusal', async () => {
      await openRec1()
      rejectNextPatch('Title is too long', { status: 422, code: 'VALIDATION_ERROR', fieldErrors: { fld_title: 'Title is too long' } })
      await patchTitle()
      expect(fieldErrorEl('fld_title')).toBeTruthy()
      showErrorSpy.mockClear()
      gridMock.patchCell.mockImplementation(async () => {
        gridMock.error.value = null
        await Promise.resolve()
        gridMock.error.value = 'Status is not allowed'
        return null
      })
      await patchTitle()
      expect(showErrorSpy).not.toHaveBeenCalled()
      expect(showSuccessSpy).toHaveBeenCalledTimes(1)
      expect(fieldErrorEl('fld_title')).toBeNull()
    })

    // --- the link and person pickers answer for their own save too (the grid's shared error is not theirs) ---

    type PickerKind = 'link' | 'person'
    async function openPicker(kind: PickerKind) {
      mountWorkbench()
      await flushUi()
      container!.querySelector<HTMLButtonElement>(`[data-open-${kind}-picker="rec_1"]`)!.click()
      await flushUi()
    }
    async function confirmPicker(kind: PickerKind) {
      container!.querySelector<HTMLButtonElement>(`[data-${kind}-picker-confirm="true"]`)!.click()
      await flushUi()
    }
    const pickedPersonSummaries = () => gridMock.personSummaries.value.rec_1?.fld_owner

    it.each(['link', 'person'] as const)('a %s picker save that waits behind a failing save of the record (the grid\'s shared error set after the call) is a success: its toast, no error toast, and a person\'s summaries applied', async (kind) => {
      await openPicker(kind)
      gridMock.patchCell.mockImplementation(async () => {
        gridMock.error.value = null
        await Promise.resolve()
        gridMock.error.value = 'Status is not allowed'
        return null
      })
      await confirmPicker(kind)
      expect(gridMock.patchCell).toHaveBeenCalledTimes(1)
      expect(gridMock.patchCell.mock.calls[0].slice(0, 4)).toEqual(kind === 'link'
        ? ['rec_1', 'fld_parts', ['rec_part_1'], 1]
        : ['rec_1', 'fld_owner', ['user_jamie'], 1])
      expect(showErrorSpy).not.toHaveBeenCalled()
      expect(showSuccessSpy).toHaveBeenCalledTimes(1)
      expect(showSuccessSpy).toHaveBeenCalledWith('Linked records updated', undefined)
      if (kind === 'person') expect(pickedPersonSummaries()).toEqual([{ id: 'user_jamie', display: 'Jamie' }])
    })

    it.each(['link', 'person'] as const)('a %s picker save the grid replaced unsent with a newer save of the cell (CELL_WRITE_SUPERSEDED) shows nothing, and applies no summaries: the newer save answers for the cell', async (kind) => {
      await openPicker(kind)
      gridMock.patchCell.mockImplementation(async () => CELL_WRITE_SUPERSEDED)
      await confirmPicker(kind)
      expect(gridMock.patchCell).toHaveBeenCalledTimes(1)
      expect(showSuccessSpy).not.toHaveBeenCalled()
      expect(showErrorSpy).not.toHaveBeenCalled()
      expect(pickedPersonSummaries()).toBeUndefined()
    })

    it.each(['link', 'person'] as const)('a rejected %s picker save toasts its own failure, not the grid\'s shared error (another save\'s by then)', async (kind) => {
      await openPicker(kind)
      gridMock.patchCell.mockImplementation(async (_recordId: string, fieldId: string) => {
        gridMock.error.value = null
        await Promise.resolve()
        gridMock.error.value = 'Status is not allowed'
        return failureFor(fieldId, 'Not a valid choice', { status: 400, code: 'VALIDATION_ERROR' })
      })
      await confirmPicker(kind)
      expect(showErrorSpy).toHaveBeenCalledTimes(1)
      expect(showErrorSpy).toHaveBeenCalledWith('Not a valid choice')
      expect(showSuccessSpy).not.toHaveBeenCalled()
      expect(pickedPersonSummaries()).toBeUndefined()
    })

    // Control (passes before the change too): the composable's local refusal sets its error at the call.
    it.each(['link', 'person'] as const)('a %s picker save the grid refuses locally (no request, its error set at the call) still toasts that refusal', async (kind) => {
      await openPicker(kind)
      gridMock.patchCell.mockImplementation(async () => {
        gridMock.error.value = 'Row editing is blocked'
        return null
      })
      await confirmPicker(kind)
      expect(showErrorSpy).toHaveBeenCalledTimes(1)
      expect(showErrorSpy).toHaveBeenCalledWith('Row editing is blocked')
      expect(showSuccessSpy).not.toHaveBeenCalled()
      expect(pickedPersonSummaries()).toBeUndefined()
    })

    // --- the conflict banner's retry answers for itself too (`retryConflict` returns its own result) ---

    async function retryFromBanner() {
      mountWorkbench()
      await flushUi()
      gridMock.conflict.value = { recordId: 'rec_1', fieldId: 'fld_title', attemptedValue: 'patched', message: 'Row changed elsewhere', serverVersion: 8 }
      await flushUi()
      container!.querySelector<HTMLButtonElement>('.mt-workbench__conflict-btn--primary')!.click()
      await flushUi()
      expect(gridMock.retryConflict).toHaveBeenCalledTimes(1)
    }

    it('a retry that fails toasts the retry\'s own failure, not the grid\'s shared error', async () => {
      gridMock.retryConflict.mockImplementation(async () => {
        gridMock.error.value = 'Status is not allowed'
        return { message: 'Row changed again' }
      })
      await retryFromBanner()
      expect(showErrorSpy).toHaveBeenCalledTimes(1)
      expect(showErrorSpy).toHaveBeenCalledWith('Row changed again')
      expect(showSuccessSpy).not.toHaveBeenCalled()
    })

    it('a retry a newer save of the cell replaced unsent (false) shows nothing, also while the grid\'s shared error holds another save\'s failure', async () => {
      gridMock.retryConflict.mockImplementation(async () => {
        gridMock.error.value = 'Status is not allowed'
        return false
      })
      await retryFromBanner()
      expect(showErrorSpy).not.toHaveBeenCalled()
      expect(showSuccessSpy).not.toHaveBeenCalled()
    })

    it('a retry that is stored (true) while the grid\'s shared error holds another save\'s failure is a success', async () => {
      gridMock.retryConflict.mockImplementation(async () => {
        gridMock.error.value = 'Status is not allowed'
        return true
      })
      await retryFromBanner()
      expect(showErrorSpy).not.toHaveBeenCalled()
      expect(showSuccessSpy).toHaveBeenCalledTimes(1)
      expect(showSuccessSpy).toHaveBeenCalledWith('Change reapplied', undefined)
    })

    it.each([
      ['same-record', 'success'], ['same-record', 'failure'],
      ['another-record', 'success'], ['another-record', 'failure'],
      ['round-trip', 'success'], ['round-trip', 'failure'],
    ])('B2 lifetime: %s late %s preserves the newer field error', async (navigation, outcome) => {
      await openRec1()
      let settle: ((result: PlayedFailure | null) => void) | undefined
      gridMock.patchCell.mockImplementationOnce(() => new Promise<PlayedFailure | null>(resolve => { settle = resolve }))
      await patchTitle()
      if (navigation !== 'same-record') {
        container!.querySelector<HTMLButtonElement>('[data-navigate-record="rec_2"]')!.click()
        await flushUi()
        if (navigation === 'round-trip') {
          container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
          await flushUi()
        }
      }
      const currentRecord = navigation === 'another-record' ? 'rec_2' : 'rec_1'
      expect(container!.querySelector(`[data-record-drawer="${currentRecord}"]`)).toBeTruthy()
      inspectorStubAnchor.mockImplementation((recordId: string) => recordId === currentRecord)
      rejectNextPatch('Newer edit rejected', { recordId: currentRecord, status: 400, code: 'VALIDATION_ERROR' })
      await patchTitle()
      expect(fieldErrorEl('fld_title')?.textContent).toBe('Newer edit rejected')
      // A different field's successful patch clears the composable's shared error, not this alert.
      acceptNextPatch()
      container!.querySelector<HTMLButtonElement>('[data-patch-record="fld_status"]')!.click()
      await flushUi()
      expect(fieldErrorEl('fld_title')?.textContent).toBe('Newer edit rejected')
      settle!(outcome === 'success' ? null : failureFor('fld_title', 'Old edit rejected', { status: 400, code: 'VALIDATION_ERROR' }))
      await flushUi()
      expect(fieldErrorEl('fld_title')?.textContent).toBe('Newer edit rejected')
    })

    it.each([false, true])('B2 context: round-trip=%s gates an old rejection without a newer request', async (roundTrip) => {
      await openRec1()
      let settle: ((failure: PlayedFailure) => void) | undefined
      gridMock.patchCell.mockImplementationOnce(() => new Promise<PlayedFailure>(resolve => { settle = resolve }))
      await patchTitle()
      if (roundTrip) {
        container!.querySelector<HTMLButtonElement>('[data-navigate-record="rec_2"]')!.click()
        await flushUi()
        container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
        await flushUi()
      }
      expect(container!.querySelector('[data-record-drawer="rec_1"]')).toBeTruthy()
      settle!(failureFor('fld_title', 'Old context rejected', { status: 400, code: 'VALIDATION_ERROR' }))
      await flushUi()
      if (roundTrip) {
        expect(fieldErrorEl('fld_title')).toBeNull()
        expect(showErrorSpy).toHaveBeenCalledWith('Old context rejected')
      } else {
        expect(fieldErrorEl('fld_title')?.textContent).toBe('Old context rejected')
        expect(showErrorSpy).not.toHaveBeenCalled()
      }
    })

    // Every move to another record commits the drawer's focused field first (releaseDrawerFocus in selectRecord), not
    // only the drawer's own previous / next: here the record in the address (the browser's back / forward), a
    // deep link to a record off the page while a deep-linked record is shown, and a declined discard prompt.
    it('a move through the record in the address commits the focused field to the record it was typed on, and gives it the focus back', async () => {
      const host = mountWorkbench()
      await flushUi()
      container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
      await flushUi()
      const field = container!.querySelector<HTMLInputElement>('[data-blur-commit="fld_title"]')!
      field.focus()
      field.value = 'typed on rec_1'
      acceptNextPatch()
      host.recordId = 'rec_2'
      await flushUi(8)
      expect(container!.querySelector('[data-record-drawer="rec_2"]')).toBeTruthy()
      expect(gridMock.patchCell.mock.calls).toEqual([['rec_1', 'fld_title', 'typed on rec_1', 1, ROW_SAVE]])
      expect(document.activeElement).toBe(field)
      expect(field.value).toBe('Beta')
    })

    it('a deep link to a record off the page, while a deep-linked record is shown, commits the focused field to the record shown before it is replaced', async () => {
      workbenchMock.client.getRecord.mockResolvedValueOnce({
        record: { id: 'rec_remote', version: 4, data: { fld_title: 'Remote' } },
        commentsScope: { containerType: 'meta_sheet', containerId: 'sheet_orders', targetType: 'meta_record', targetId: 'rec_remote' },
        linkSummaries: {},
      })
      const host = mountWorkbench({ recordId: 'rec_remote' })
      await flushUi(8)
      expect(container!.querySelector('[data-record-drawer="rec_remote"]')).toBeTruthy()
      const field = container!.querySelector<HTMLInputElement>('[data-blur-commit="fld_title"]')!
      field.focus()
      field.value = 'typed on rec_remote'
      workbenchMock.client.getRecord.mockResolvedValueOnce({
        record: { id: 'rec_far', version: 9, data: { fld_title: 'Far' } },
        commentsScope: { containerType: 'meta_sheet', containerId: 'sheet_orders', targetType: 'meta_record', targetId: 'rec_far' },
        linkSummaries: {},
      })
      acceptNextPatch()
      // The far record's comments are still loading: the focus comes back without waiting for them.
      loadCommentsSpy.mockImplementationOnce(() => new Promise(() => {}))
      host.recordId = 'rec_far'
      await flushUi(8)
      expect(container!.querySelector('[data-record-drawer="rec_far"]')).toBeTruthy()
      expect(gridMock.patchCell.mock.calls).toEqual([['rec_remote', 'fld_title', 'typed on rec_remote', 4, COPY_SAVE]])
      expect(document.activeElement).toBe(field)
    })

    // A deep link to a record off the page, while the record shown is deep-linked too and has a draft: the copy the
    // drawer shows is replaced only once the discard prompt is accepted.
    async function openRemoteWithCommentDraft() {
      workbenchMock.client.getRecord.mockResolvedValueOnce({
        record: { id: 'rec_remote', version: 4, data: { fld_title: 'Remote' } },
        commentsScope: { containerType: 'meta_sheet', containerId: 'sheet_orders', targetType: 'meta_record', targetId: 'rec_remote' },
        linkSummaries: {},
      })
      const host = mountWorkbench({ recordId: 'rec_remote' })
      await flushUi(8)
      expect(container!.querySelector('[data-record-drawer="rec_remote"]')).toBeTruthy()
      container!.querySelector<HTMLButtonElement>('[data-toggle-comments="true"]')!.click()
      await flushUi()
      container!.querySelector<HTMLButtonElement>('[data-set-comment-draft="true"]')!.click()
      await flushUi()
      return host
    }
    async function deepLinkToFar(host: { recordId?: string }, answer: boolean) {
      workbenchMock.client.getRecord.mockResolvedValueOnce({
        record: { id: 'rec_far', version: 9, data: { fld_title: 'Far' } },
        commentsScope: { containerType: 'meta_sheet', containerId: 'sheet_orders', targetType: 'meta_record', targetId: 'rec_far' },
        linkSummaries: {},
      })
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(answer)
      try {
        host.recordId = 'rec_far'
        await flushUi(8)
        // Asked once, not a second time by the move itself.
        expect(confirmSpy).toHaveBeenCalledTimes(1)
        expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved record changes?')
      } finally {
        confirmSpy.mockRestore()
      }
    }

    it('a deep link to a record off the page, discard prompt declined: the drawer still shows the deep-linked record it showed, with its copy', async () => {
      const host = await openRemoteWithCommentDraft()
      await deepLinkToFar(host, false)
      expect(container!.querySelector('[data-record-drawer="rec_remote"]')).toBeTruthy()
      expect(container!.querySelector('[data-record-drawer="rec_far"]')).toBeNull()
      expect(inspectorStubSeen.record).toMatchObject({ id: 'rec_remote', version: 4, data: { fld_title: 'Remote' } })
    })

    it('the same with the caret in a field: the field is committed to the record shown, which stays, and gets the focus back', async () => {
      const host = await openRemoteWithCommentDraft()
      const field = container!.querySelector<HTMLInputElement>('[data-blur-commit="fld_title"]')!
      field.focus()
      field.value = 'typed on rec_remote'
      acceptNextPatch()
      await deepLinkToFar(host, false)
      expect(firstFourArgs(gridMock.patchCell.mock.calls)).toEqual([['rec_remote', 'fld_title', 'typed on rec_remote', 4]])
      expect(container!.querySelector('[data-record-drawer="rec_remote"]')).toBeTruthy()
      expect(inspectorStubSeen.record).toMatchObject({ id: 'rec_remote', data: { fld_title: 'typed on rec_remote' } })
      expect(document.activeElement).toBe(field)
    })

    // Control (passes before the change too): accepted, the drawer moves on.
    it('a deep link to a record off the page, discard prompt accepted: the drawer shows the new record', async () => {
      const host = await openRemoteWithCommentDraft()
      await deepLinkToFar(host, true)
      expect(container!.querySelector('[data-record-drawer="rec_far"]')).toBeTruthy()
      expect(container!.querySelector('[data-record-drawer="rec_remote"]')).toBeNull()
      expect(inspectorStubSeen.record).toMatchObject({ id: 'rec_far', version: 9, data: { fld_title: 'Far' } })
    })

    it('a reload with the caret in a changed drawer field: the write the unload flushes is counted, so the leave prompt is shown', async () => {
      await openRec1()
      // The grid counts a write from its call on (synchronously), as the real patchCell does.
      let answer: () => void = () => {}
      gridMock.patchCell.mockImplementation((_r: string, _f: string, _v: unknown, version: number, options?: { onCommitted?: (v: number) => void }) => {
        gridMock.pendingCellWriteCount.value += 1
        return new Promise((resolve) => {
          answer = () => { gridMock.pendingCellWriteCount.value -= 1; options?.onCommitted?.(version + 1); resolve(null) }
        })
      })
      const field = container!.querySelector<HTMLInputElement>('[data-blur-commit="fld_title"]')!
      field.focus()
      field.value = 'typed'
      const event = fireBeforeUnload()
      expect(gridMock.patchCell).toHaveBeenCalledTimes(1)
      expect(event.defaultPrevented).toBe(true)
      answer()
      await flushUi()
      expect(fireBeforeUnload().defaultPrevented).toBe(false)
    })

    it('a same-record refresh of a deep-linked record that has a draft does not ask the discard prompt, and refreshes the copy (control)', async () => {
      await openRemoteWithCommentDraft()
      workbenchMock.client.getRecord.mockResolvedValueOnce({
        record: { id: 'rec_remote', version: 5, data: { fld_title: 'Remote v5' } },
        commentsScope: { containerType: 'meta_sheet', containerId: 'sheet_orders', targetType: 'meta_record', targetId: 'rec_remote' },
        linkSummaries: {},
      })
      gridMock.retryConflict.mockResolvedValue(true)
      gridMock.conflict.value = { recordId: 'rec_remote', fieldId: 'fld_title', attemptedValue: 'x', message: 'Row changed elsewhere', serverVersion: 5 }
      await flushUi()
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
      try {
        container!.querySelector<HTMLButtonElement>('.mt-workbench__conflict-btn--primary')!.click()
        await flushUi(8)
        expect(confirmSpy).not.toHaveBeenCalled()
        expect(inspectorStubSeen.record).toMatchObject({ id: 'rec_remote', version: 5, data: { fld_title: 'Remote v5' } })
      } finally {
        confirmSpy.mockRestore()
      }
    })

    it('a declined discard prompt keeps the record: the focused field is committed to it and gets the focus back', async () => {
      await openRec1()
      container!.querySelector<HTMLButtonElement>('[data-toggle-comments="true"]')!.click()
      await flushUi()
      container!.querySelector<HTMLButtonElement>('[data-set-comment-draft="true"]')!.click()
      await flushUi()
      const field = container!.querySelector<HTMLInputElement>('[data-blur-commit="fld_title"]')!
      field.focus()
      field.value = 'typed on rec_1'
      acceptNextPatch()
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
      try {
        container!.querySelector<HTMLButtonElement>('[data-navigate-record="rec_2"]')!.click()
        await flushUi()
        expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved record changes?')
      } finally {
        confirmSpy.mockRestore()
      }
      expect(container!.querySelector('[data-record-drawer="rec_1"]')).toBeTruthy()
      expect(gridMock.patchCell.mock.calls).toEqual([['rec_1', 'fld_title', 'typed on rec_1', 1, ROW_SAVE]])
      expect(document.activeElement).toBe(field)
    })

    // The drawer's previous / next chord moves on with the caret still in a field (a click in jsdom does not move
    // the focus either, like the chord): the field is blurred first, so it commits to the record it was typed on,
    // and then gets the focus back, so the chord and Esc go on working.
    it('navigating with the caret still in a field commits that field to the record it was typed on, moves on, and gives the focus back', async () => {
      await openRec1()
      const field = container!.querySelector<HTMLInputElement>('[data-blur-commit="fld_title"]')!
      field.focus()
      field.value = 'typed on rec_1'
      const blurred = vi.fn()
      field.addEventListener('blur', blurred)
      acceptNextPatch()
      container!.querySelector<HTMLButtonElement>('[data-navigate-record="rec_2"]')!.click()
      await flushUi()
      expect(blurred).toHaveBeenCalledTimes(1)
      expect(gridMock.patchCell.mock.calls).toEqual([['rec_1', 'fld_title', 'typed on rec_1', 1, ROW_SAVE]])
      expect(container!.querySelector('[data-record-drawer="rec_2"]')).toBeTruthy()
      expect(document.activeElement).toBe(field)
      // The focus comes back only once the drawer shows rec_2: the field shows rec_2's title, not rec_1's typing.
      expect(field.value).toBe('Beta')
    })

    it('the focus is not given back when something else took it during the switch', async () => {
      await openRec1()
      const field = container!.querySelector<HTMLInputElement>('[data-blur-commit="fld_title"]')!
      const other = container!.querySelector<HTMLButtonElement>('[data-navigate-record="rec_1"]')!
      field.focus()
      acceptNextPatch()
      container!.querySelector<HTMLButtonElement>('[data-navigate-record="rec_2"]')!.click()
      other.focus()
      await flushUi()
      expect(document.activeElement).toBe(other)
    })

    it('a rich text editor gets the focus back with the caret at the end of its text', async () => {
      await openRec1()
      const editor = container!.querySelector<HTMLElement>('[data-stub-editable]')!
      Object.defineProperty(editor, 'isContentEditable', { value: true, configurable: true })
      editor.focus()
      document.getSelection()!.collapse(editor, 0)
      container!.querySelector<HTMLButtonElement>('[data-navigate-record="rec_2"]')!.click()
      await flushUi()
      expect(document.activeElement).toBe(editor)
      const selection = document.getSelection()!
      expect(selection.isCollapsed).toBe(true)
      expect(selection.anchorNode).toBe(editor)
      expect(selection.anchorOffset).toBe(editor.childNodes.length)
    })

    it('the focus goes to the drawer\'s open tab when the focused control is gone on the next record', async () => {
      await openRec1()
      // a tab panel outside the drawer, before it in the page: never the one that gets the focus
      const decoy = document.body.insertBefore(document.createElement('div'), document.body.firstChild)
      decoy.setAttribute('role', 'tabpanel')
      decoy.tabIndex = 0
      try {
        container!.querySelector<HTMLInputElement>('[data-rec1-only]')!.focus()
        container!.querySelector<HTMLButtonElement>('[data-navigate-record="rec_2"]')!.click()
        await flushUi()
        expect(container!.querySelector('[data-rec1-only]')).toBeNull()
        expect(document.activeElement).toBe(container!.querySelector('[data-stub-tabpanel]'))
      } finally {
        decoy.remove()
      }
    })

    it('a move leaves a focused control outside the drawer alone', async () => {
      await openRec1()
      const outside = document.body.appendChild(document.createElement('input'))
      try {
        outside.focus()
        const blurred = vi.fn()
        outside.addEventListener('blur', blurred)
        container!.querySelector<HTMLButtonElement>('[data-navigate-record="rec_2"]')!.click()
        await flushUi()
        expect(container!.querySelector('[data-record-drawer="rec_2"]')).toBeTruthy()
        expect(blurred).not.toHaveBeenCalled()
        expect(document.activeElement).toBe(outside)
      } finally {
        outside.remove()
      }
    })

    it('re-selecting the record shown leaves the focused field alone', async () => {
      await openRec1()
      const field = container!.querySelector<HTMLInputElement>('[data-blur-commit="fld_title"]')!
      field.focus()
      field.value = 'still typing'
      container!.querySelector<HTMLButtonElement>('[data-navigate-record="rec_1"]')!.click()
      await flushUi()
      expect(document.activeElement).toBe(field)
      expect(gridMock.patchCell).not.toHaveBeenCalled()
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

    // --- a patch that names its record (an attachment write that ended after the drawer moved on) ---

    async function openRec1ThenRec2() {
      await openRec1()
      container!.querySelector<HTMLButtonElement>('[data-navigate-record="rec_2"]')!.click()
      await flushUi()
      expect(container!.querySelector('[data-record-drawer="rec_2"]')).toBeTruthy()
    }
    async function patchFor(recordId: string) {
      container!.querySelector<HTMLButtonElement>(`[data-patch-record-for="${recordId}"]`)!.click()
      await flushUi()
    }

    it('a patch naming rec_1 while rec_2 is shown goes to rec_1, with rec_1\'s own version, and never to rec_2', async () => {
      await openRec1ThenRec2()
      gridMock.rows.value[0].version = 7 // rec_1 moved on; rec_2 stays at 1
      acceptNextPatch()
      await patchFor('rec_1')
      expect(gridMock.patchCell).toHaveBeenCalledTimes(1)
      expect(gridMock.patchCell).toHaveBeenCalledWith('rec_1', 'fld_title', 'Stale title', 7, ROW_SAVE)
      expect(gridMock.patchCell.mock.calls.some((call: unknown[]) => call[0] === 'rec_2')).toBe(false)
    })

    it('the edit gate is asked about the named record: rec_1 refused while rec_2 is editable → no patch, the edit-blocked toast', async () => {
      await openRec1ThenRec2()
      gridMock.rowActionOverrides.value = { rec_1: { canEdit: false, canDelete: false, canComment: false } }
      acceptNextPatch()
      await patchFor('rec_1')
      expect(gridMock.patchCell).not.toHaveBeenCalled()
      expect(showErrorSpy).toHaveBeenCalledTimes(1)
      expect(showErrorSpy).toHaveBeenCalledWith('Record editing is not allowed for this row.') // wb('toast.recordEditBlocked', en)
      expect(gridMock.resolveRowActions).toHaveBeenCalledWith('rec_1')
    })

    it('a patch naming the record shown (rec_2) is a plain drawer patch: rec_2 at its version, success toast, and it clears the field\'s inline error', async () => {
      await openRec1ThenRec2()
      inspectorStubAnchor.mockImplementation((recordId: string) => recordId === 'rec_2')
      rejectNextPatch('Title too long', { recordId: 'rec_2', status: 400, code: 'VALIDATION_ERROR' })
      await patchTitle()
      expect(fieldErrorEl('fld_title')?.textContent).toBe('Title too long')
      gridMock.patchCell.mockClear()
      acceptNextPatch()
      await patchFor('rec_2')
      expect(gridMock.patchCell).toHaveBeenCalledTimes(1)
      expect(gridMock.patchCell).toHaveBeenCalledWith('rec_2', 'fld_title', 'Named title', 1, ROW_SAVE)
      expect(fieldErrorEl('fld_title')).toBeNull()
      expect(showSuccessSpy).toHaveBeenCalledTimes(1)
      expect(showErrorSpy).not.toHaveBeenCalled()
    })

    it('a patch naming a record that is neither in the page nor deep-linked is dropped: no patch, no toast', async () => {
      await openRec1ThenRec2()
      gridMock.rows.value = gridMock.rows.value.filter((row: { id: string }) => row.id !== 'rec_1')
      await flushUi()
      expect(container!.querySelector('[data-record-drawer="rec_2"]')).toBeTruthy()
      acceptNextPatch()
      await patchFor('rec_1')
      expect(gridMock.patchCell).not.toHaveBeenCalled()
      expect(showErrorSpy).not.toHaveBeenCalled()
      expect(showSuccessSpy).not.toHaveBeenCalled()
    })

    it('a named rec_1 patch that succeeds after the switch leaves rec_2\'s inline error on the same field alone', async () => {
      await openRec1ThenRec2()
      inspectorStubAnchor.mockImplementation((recordId: string) => recordId === 'rec_2')
      rejectNextPatch('Title too long', { recordId: 'rec_2', status: 400, code: 'VALIDATION_ERROR' })
      await patchTitle()
      expect(fieldErrorEl('fld_title')?.textContent).toBe('Title too long')
      acceptNextPatch()
      await patchFor('rec_1')
      expect(gridMock.patchCell).toHaveBeenLastCalledWith('rec_1', 'fld_title', 'Stale title', 1, ROW_SAVE)
      expect(fieldErrorEl('fld_title')?.textContent).toBe('Title too long')
    })

    // Two answers from the inspector: the real one (it can anchor only on the record it shows), and one that
    // would anchor anything, so the toast cannot come only from the inspector's answer.
    it.each([
      ['answers per record', (recordId: string) => recordId === 'rec_2'],
      ['would anchor anything', () => true],
    ])('a named rec_1 patch rejected after the switch (inspector %s) toasts and is never written inline on rec_2', async (_label, answer) => {
      await openRec1ThenRec2()
      inspectorStubAnchor.mockImplementation(answer)
      rejectNextPatch('Stale title rejected', { status: 400, code: 'VALIDATION_ERROR' }) // the failure is rec_1's
      await patchFor('rec_1')
      expect(gridMock.patchCell).toHaveBeenCalledWith('rec_1', 'fld_title', 'Stale title', 1, ROW_SAVE)
      expect(inspectorStubAnchor).toHaveBeenCalledWith('rec_1', 'fld_title')
      expect(showErrorSpy).toHaveBeenCalledTimes(1)
      expect(showErrorSpy).toHaveBeenCalledWith('Stale title rejected')
      expect(container!.querySelector('[data-test="drawer-field-error"]')).toBeNull()
      gridMock.error.value = null
    })

    it('an attachment delete on a deep-linked record ends after the drawer moved on: the linked copy still takes the new version, and its later patch carries it', async () => {
      workbenchMock.client.getRecord.mockResolvedValueOnce({
        record: { id: 'rec_remote', version: 4, data: { fld_title: 'Remote', fld_files: ['att_1', 'att_2'] } },
        commentsScope: { containerType: 'meta_sheet', containerId: 'sheet_orders', targetType: 'meta_record', targetId: 'rec_remote' },
        linkSummaries: {},
        attachmentSummaries: { fld_files: [{ id: 'att_1', filename: 'a.txt' }, { id: 'att_2', filename: 'b.txt' }] },
      })
      mountWorkbench({ recordId: 'rec_remote' })
      await flushUi(8)
      expect(container!.querySelector('[data-record-drawer="rec_remote"]')).toBeTruthy()
      container!.querySelector<HTMLButtonElement>('[data-navigate-record="rec_2"]')!.click()
      await flushUi()
      expect(container!.querySelector('[data-record-drawer="rec_2"]')).toBeTruthy()
      workbenchMock.client.deleteAttachment = vi.fn().mockResolvedValue({ deleted: 'att_1' })
      await inspectorStubSeen.deleteAttachmentFn!('att_1', { recordId: 'rec_remote', fieldId: 'fld_files' })
      await flushUi()
      expect(workbenchMock.client.deleteAttachment).toHaveBeenCalledWith('att_1')
      acceptNextPatch()
      await patchFor('rec_remote')
      // version 4, plus one for the delete that ended while rec_2 was shown
      expect(gridMock.patchCell).toHaveBeenCalledTimes(1)
      expect(gridMock.patchCell).toHaveBeenCalledWith('rec_remote', 'fld_files', ['att_2'], 5, COPY_SAVE)
      expect(container!.querySelector('[data-record-drawer="rec_2"]')).toBeTruthy()
    })

    // Deep link to rec_remote (not in the page, version 4), then move the drawer to the page record rec_2.
    async function openRemoteThenRec2(files: string[] = ['att_1', 'att_2']) {
      workbenchMock.client.getRecord.mockResolvedValueOnce({
        record: { id: 'rec_remote', version: 4, data: { fld_title: 'Remote', fld_files: files } },
        commentsScope: { containerType: 'meta_sheet', containerId: 'sheet_orders', targetType: 'meta_record', targetId: 'rec_remote' },
        linkSummaries: {},
        attachmentSummaries: { fld_files: files.map((id) => ({ id, filename: `${id}.txt` })) },
      })
      mountWorkbench({ recordId: 'rec_remote' })
      await flushUi(8)
      expect(container!.querySelector('[data-record-drawer="rec_remote"]')).toBeTruthy()
      container!.querySelector<HTMLButtonElement>('[data-navigate-record="rec_2"]')!.click()
      await flushUi()
      expect(container!.querySelector('[data-record-drawer="rec_2"]')).toBeTruthy()
    }

    it('two named patches for the deep-linked rec_remote after the move: each carries the version the one before left (4, then 5)', async () => {
      await openRemoteThenRec2()
      acceptNextPatch()
      await patchFor('rec_remote')
      await patchFor('rec_remote')
      expect(gridMock.patchCell.mock.calls).toEqual([
        ['rec_remote', 'fld_files', ['att_2'], 4, COPY_SAVE],
        ['rec_remote', 'fld_files', ['att_2'], 5, COPY_SAVE],
      ])
    })

    it('an attachment delete on the page record rec_2 leaves the deep-linked rec_remote copy alone: its later patch carries its own version 4', async () => {
      await openRemoteThenRec2()
      workbenchMock.client.deleteAttachment = vi.fn().mockResolvedValue({ deleted: 'att_9' })
      await inspectorStubSeen.deleteAttachmentFn!('att_9', { recordId: 'rec_2', fieldId: 'fld_files' })
      await flushUi()
      expect(workbenchMock.client.deleteAttachment).toHaveBeenCalledWith('att_9')
      acceptNextPatch()
      await patchFor('rec_remote')
      expect(gridMock.patchCell.mock.calls).toEqual([['rec_remote', 'fld_files', ['att_2'], 4, COPY_SAVE]])
    })

    // --- a remove that ended after the drawer moved on also names the ids it took out ---

    async function patchRemovedFor(recordId: string) {
      container!.querySelector<HTMLButtonElement>(`[data-patch-removed-for="${recordId}"]`)!.click()
      await flushUi()
    }

    it('a remove naming rec_1 (no longer shown): rec_1\'s list as it is now minus the removed ids, at rec_1\'s version; the list it started from is not written', async () => {
      await openRec1ThenRec2()
      // the delete's reload: att_1 still listed, and att_x added meanwhile; rec_1 moved on, rec_2 stays at 1
      gridMock.rows.value[0].data = { ...gridMock.rows.value[0].data, fld_files: ['att_1', 'att_x'] }
      gridMock.rows.value[0].version = 7
      acceptNextPatch()
      await patchRemovedFor('rec_1')
      expect(gridMock.patchCell.mock.calls).toEqual([['rec_1', 'fld_files', ['att_x'], 7, ROW_SAVE]])
    })

    it('a remove naming rec_1 whose list no longer holds the removed id (the server took it out): nothing written, no toast', async () => {
      await openRec1ThenRec2()
      gridMock.rows.value[0].data = { ...gridMock.rows.value[0].data, fld_files: ['att_x'] }
      acceptNextPatch()
      await patchRemovedFor('rec_1')
      expect(gridMock.patchCell).not.toHaveBeenCalled()
      expect(showErrorSpy).not.toHaveBeenCalled()
      expect(showSuccessSpy).not.toHaveBeenCalled()
    })

    // While the record is shown the removed ids are ignored: the panel already sent its current list. Both
    // lists of rec_2 would give another value (or no write) if they were used.
    it.each([
      ['still holds att_1', ['att_1', 'att_y']],
      ['no longer holds att_1', ['att_y']],
    ])('a remove naming the record shown (rec_2, which %s): the value as given, at rec_2\'s version', async (_label, files) => {
      await openRec1ThenRec2()
      gridMock.rows.value[1].data = { ...gridMock.rows.value[1].data, fld_files: files }
      acceptNextPatch()
      await patchRemovedFor('rec_2')
      expect(gridMock.patchCell.mock.calls).toEqual([['rec_2', 'fld_files', ['att_stale'], 1, ROW_SAVE]])
    })

    it('a remove naming the deep-linked rec_remote (no longer shown): rebuilt from the deep-linked copy minus the removed ids, at its version 4', async () => {
      await openRemoteThenRec2(['att_1', 'att_2', 'att_3'])
      acceptNextPatch()
      await patchRemovedFor('rec_remote')
      expect(gridMock.patchCell.mock.calls).toEqual([['rec_remote', 'fld_files', ['att_2', 'att_3'], 4, COPY_SAVE]])
    })

    // In the app the delete comes first, and it takes the id out of the deep-linked copy: the rebuild then has
    // nothing left to take out, and nothing is written.
    it('a remove naming the deep-linked rec_remote after its delete went through the workbench: nothing written', async () => {
      await openRemoteThenRec2(['att_1', 'att_2'])
      workbenchMock.client.deleteAttachment = vi.fn().mockResolvedValue({ deleted: 'att_1' })
      await inspectorStubSeen.deleteAttachmentFn!('att_1', { recordId: 'rec_remote', fieldId: 'fld_files' })
      await flushUi()
      acceptNextPatch()
      await patchRemovedFor('rec_remote')
      expect(gridMock.patchCell).not.toHaveBeenCalled()
    })

    async function patchClearedFor(recordId: string) {
      container!.querySelector<HTMLButtonElement>(`[data-patch-cleared-for="${recordId}"]`)!.click()
      await flushUi()
    }

    // A late clear-all names every id it took out: all of them come out of the list as it is now, and an
    // attachment added meanwhile stays.
    it.each([
      ['both still listed', ['att_1', 'att_2', 'att_x'], ['att_x']],
      ['one already taken out', ['att_1', 'att_x'], ['att_x']],
      ['both still listed, nothing else', ['att_1', 'att_2'], []],
    ])('a clear-all naming rec_1 (no longer shown), %s: rec_1\'s list as it is now minus every cleared id', async (_label, files, expected) => {
      await openRec1ThenRec2()
      gridMock.rows.value[0].data = { ...gridMock.rows.value[0].data, fld_files: files }
      gridMock.rows.value[0].version = 7
      acceptNextPatch()
      await patchClearedFor('rec_1')
      expect(gridMock.patchCell.mock.calls).toEqual([['rec_1', 'fld_files', expected, 7, ROW_SAVE]])
    })

    // --- an upload that adds to the list names the ids it added: they go after the record's list as it is now ---

    async function patchAddedFor(recordId: string) {
      container!.querySelector<HTMLButtonElement>(`[data-patch-added-for="${recordId}"]`)!.click()
      await flushUi()
    }

    // The stub's value is the list the upload started from plus its file (['att_stale', 'att_new']); written as
    // given, it would drop what the list holds by now.
    it.each([
      ['someone else added att_x meanwhile', ['att_1', 'att_x'], ['att_1', 'att_x', 'att_new']],
      ['it already holds the uploaded id', ['att_1', 'att_new'], ['att_1', 'att_new']],
      ['it is empty', undefined, ['att_new']],
    ])('an upload naming rec_1 (no longer shown), whose list changed while it ran (%s): rec_1\'s list as it is now, then the ids it added, at rec_1\'s version', async (_label, files, expected) => {
      await openRec1ThenRec2()
      gridMock.rows.value[0].data = { ...gridMock.rows.value[0].data, fld_files: files }
      gridMock.rows.value[0].version = 7
      acceptNextPatch()
      await patchAddedFor('rec_1')
      expect(firstFourArgs(gridMock.patchCell.mock.calls)).toEqual([['rec_1', 'fld_files', expected, 7]])
    })

    it('an upload naming the record shown (rec_2), whose list changed while it ran: also its list as it is now, then the ids it added', async () => {
      await openRec1ThenRec2()
      gridMock.rows.value[1].data = { ...gridMock.rows.value[1].data, fld_files: ['att_y'] }
      acceptNextPatch()
      await patchAddedFor('rec_2')
      expect(firstFourArgs(gridMock.patchCell.mock.calls)).toEqual([['rec_2', 'fld_files', ['att_y', 'att_new'], 1]])
      expect(showSuccessSpy).toHaveBeenCalledTimes(1)
    })

    it('an upload naming the deep-linked rec_remote (no longer shown): the deep-linked copy\'s list, then the ids it added, at its version 4', async () => {
      await openRemoteThenRec2(['att_1', 'att_2'])
      acceptNextPatch()
      await patchAddedFor('rec_remote')
      expect(firstFourArgs(gridMock.patchCell.mock.calls)).toEqual([['rec_remote', 'fld_files', ['att_1', 'att_2', 'att_new'], 4]])
    })

    // --- the drawer's upload or delete request itself fails after the drawer moved on: a toast, since the panel's
    // error line is the shown record's ---

    async function rec2WithFieldAlert() {
      await openRec1ThenRec2()
      inspectorStubAnchor.mockImplementation((recordId: string) => recordId === 'rec_2')
      rejectNextPatch('Title too long', { recordId: 'rec_2', status: 400, code: 'VALIDATION_ERROR' })
      await patchTitle()
      expect(fieldErrorEl('fld_title')?.textContent).toBe('Title too long')
      expect(showErrorSpy).not.toHaveBeenCalled()
    }

    it('an upload for rec_1 that fails after the drawer moved to rec_2 toasts the generic upload failure (not the server\'s text), passes the failure on, and leaves rec_2\'s field alert alone', async () => {
      await rec2WithFieldAlert()
      workbenchMock.client.uploadAttachment = vi.fn(() => Promise.reject(new Error('fake-report.pdf is too large')))
      await expect(inspectorStubSeen.uploadFn!(new File(['x'], 'fake-report.pdf'), { recordId: 'rec_1', fieldId: 'fld_files' }))
        .rejects.toThrow('fake-report.pdf is too large')
      await flushUi()
      expect(showErrorSpy).toHaveBeenCalledTimes(1)
      expect(showErrorSpy).toHaveBeenCalledWith('Failed to upload attachment')
      expect(fieldErrorEl('fld_title')?.textContent).toBe('Title too long')
      expect(gridMock.patchCell).toHaveBeenCalledTimes(1) // the title patch above; the failed upload patches nothing
    })

    it('a delete for rec_1 that fails after the drawer moved to rec_2 toasts the generic remove failure, passes the failure on, and leaves rec_2\'s field alert alone', async () => {
      await rec2WithFieldAlert()
      workbenchMock.client.deleteAttachment = vi.fn(() => Promise.reject(new Error('att_1 is locked by fake-user')))
      await expect(inspectorStubSeen.deleteAttachmentFn!('att_1', { recordId: 'rec_1', fieldId: 'fld_files' }))
        .rejects.toThrow('att_1 is locked by fake-user')
      await flushUi()
      expect(showErrorSpy).toHaveBeenCalledTimes(1)
      expect(showErrorSpy).toHaveBeenCalledWith('Failed to remove attachment')
      expect(fieldErrorEl('fld_title')?.textContent).toBe('Title too long')
    })

    // Control (passes before the change too): while the record is still shown, the panel shows the failure itself.
    it('an upload or delete for the record shown (rec_2) that fails is passed on without a toast', async () => {
      await rec2WithFieldAlert()
      workbenchMock.client.uploadAttachment = vi.fn(() => Promise.reject(new Error('upload failed')))
      workbenchMock.client.deleteAttachment = vi.fn(() => Promise.reject(new Error('delete failed')))
      const context = { recordId: 'rec_2', fieldId: 'fld_files' }
      await expect(inspectorStubSeen.uploadFn!(new File(['x'], 'a.txt'), context)).rejects.toThrow('upload failed')
      await expect(inspectorStubSeen.deleteAttachmentFn!('att_1', context)).rejects.toThrow('delete failed')
      await flushUi()
      expect(showErrorSpy).not.toHaveBeenCalled()
    })

    // --- round 2: the alert must be able to RENDER, or the toast stays (refuter P2: silent failure) ---

    it('field-routed rejection the inspector CANNOT anchor (attachments tab / hidden field) → toast with the server message, NO entry written', async () => {
      await openRec1()
      inspectorStubAnchor.mockImplementation(() => false)
      rejectNextPatch('Attachment id too long', { status: 400, code: 'VALIDATION_ERROR' })
      await patchTitle()
      expect(inspectorStubAnchor).toHaveBeenCalledWith('rec_1', 'fld_title')
      expect(showErrorSpy).toHaveBeenCalledTimes(1)
      expect(showErrorSpy).toHaveBeenCalledWith('Attachment id too long')
      expect(container!.querySelector('[data-test="drawer-field-error"]')).toBeNull()
      // …and nothing surfaces later either: the inspector "opens the details tab" (stub: anchorable again),
      // the map is still empty — there is no orphan entry waiting to double-report.
      inspectorStubAnchor.mockImplementation(() => true)
      await flushUi()
      expect(container!.querySelector('[data-test="drawer-field-error"]')).toBeNull()
      expect(showErrorSpy).toHaveBeenCalledTimes(1)
    })

    it('VERSION_CONFLICT the inspector cannot anchor → banner + toast, NO field marker', async () => {
      await openRec1()
      inspectorStubAnchor.mockImplementation(() => false)
      gridMock.patchCell.mockImplementation(async () => {
        gridMock.error.value = 'Row changed elsewhere'
        gridMock.conflict.value = { recordId: 'rec_1', fieldId: 'fld_title', attemptedValue: ATTEMPTED, message: 'Row changed elsewhere', serverVersion: 8 }
        return failureFor('fld_title', 'Row changed elsewhere', { status: 409, code: 'VERSION_CONFLICT' })
      })
      await patchTitle()
      expect(container!.textContent).toContain('Update conflict')
      expect(showErrorSpy).toHaveBeenCalledWith('Row changed elsewhere')
      expect(fieldErrorEl('fld_title')).toBeNull()
    })

    it('a rejection landing AFTER the user navigated to another record asks about the ORIGINAL record and never writes into the new record\'s map', async () => {
      await openRec1()
      let settle: ((failure: Record<string, unknown>) => void) | null = null
      gridMock.patchCell.mockImplementation(() => new Promise<Record<string, unknown>>((resolve) => { settle = resolve }))
      container!.querySelector<HTMLButtonElement>('[data-patch-record="fld_title"]')!.click()
      await flushUi()
      // In flight: user moves to rec_2 (the workbench resets the map on that edge).
      container!.querySelector<HTMLButtonElement>('[data-navigate-record="rec_2"]')!.click()
      await flushUi()
      expect(container!.querySelector('[data-record-drawer="rec_2"]')).toBeTruthy()
      // The real inspector answers false for a record it is not showing; the stub plays that answer.
      inspectorStubAnchor.mockImplementation((recordId: string) => recordId === 'rec_2')
      gridMock.error.value = 'Title is too long'
      settle!(failureFor('fld_title', 'Title is too long', { status: 400, code: 'VALIDATION_ERROR' }))
      await flushUi()
      expect(inspectorStubAnchor).toHaveBeenCalledWith('rec_1', 'fld_title') // asked about rec_1, not rec_2
      expect(showErrorSpy).toHaveBeenCalledWith('Title is too long')
      expect(container!.querySelector('[data-test="drawer-field-error"]')).toBeNull()
    })

    it('an EMPTY anchored message falls back to the toast with the generic label (nothing to render inline)', async () => {
      await openRec1()
      rejectNextPatch('', { status: 400, code: 'VALIDATION_ERROR' })
      await patchTitle()
      expect(fieldErrorEl('fld_title')).toBeNull()
      expect(showErrorSpy).toHaveBeenCalledTimes(1)
      expect(showErrorSpy).toHaveBeenCalledWith('Failed to patch cell') // metaCoreLabel('grid.errorPatchCell', en)
    })

    it('…and in zh-CN the generic label is the localised copy, not the English literal (round 3: pins the zh half of metaCoreLabel(\'grid.errorPatchCell\'))', async () => {
      useLocale().setLocale('zh-CN') // reset to 'en' by the top-level afterEach
      await openRec1()
      rejectNextPatch('', { status: 400, code: 'VALIDATION_ERROR' })
      await patchTitle()
      expect(fieldErrorEl('fld_title')).toBeNull()
      expect(showErrorSpy).toHaveBeenCalledTimes(1)
      expect(showErrorSpy).toHaveBeenCalledWith('更新单元格失败') // metaCoreLabel('grid.errorPatchCell', zh) — meta-core-labels.ts
      expect(showErrorSpy).not.toHaveBeenCalledWith('Failed to patch cell')
    })

    // --- round 2: per-call failure — two in-flight drawer patches never read each other's outcome ---

    it('two in-flight patches whose rejections settle in the SAME flush each get their own alert / toast (no cross-talk)', async () => {
      await openRec1()
      const pending: Array<{ fieldId: string; resolve: (failure: Record<string, unknown>) => void }> = []
      gridMock.patchCell.mockImplementation((_recordId: string, fieldId: string) =>
        new Promise<Record<string, unknown>>((resolve) => { pending.push({ fieldId, resolve }) }))
      container!.querySelector<HTMLButtonElement>('[data-patch-record="fld_title"]')!.click()
      container!.querySelector<HTMLButtonElement>('[data-patch-record="fld_status"]')!.click()
      await flushUi()
      expect(pending.map((p) => p.fieldId)).toEqual(['fld_title', 'fld_status'])
      // Both rejections land in one microtask flush. The composable's single `error.value` (a real shared
      // ref, unchanged by B2) ends up holding the LAST message — fld_status's 403 text — which is exactly
      // what a shared-slot read after `await` would mis-attribute to fld_title.
      for (const p of pending) {
        const message = p.fieldId === 'fld_title' ? 'Title is too long' : 'Insufficient permissions'
        gridMock.error.value = message
        p.resolve(failureFor(p.fieldId, message, p.fieldId === 'fld_title'
          ? { status: 400, code: 'VALIDATION_ERROR' }
          : { status: 403, code: 'FORBIDDEN' }))
      }
      await flushUi()
      // fld_title: its OWN validation message, inline.
      expect(fieldErrorEl('fld_title')?.textContent).toBe('Title is too long')
      // fld_status: its OWN 403, toasted once — and no inline node for it.
      expect(showErrorSpy).toHaveBeenCalledTimes(1)
      expect(showErrorSpy).toHaveBeenCalledWith('Insufficient permissions')
      expect(fieldErrorEl('fld_status')).toBeNull()
      expect(showSuccessSpy).not.toHaveBeenCalled()
    })
  })
  // '?' toggles the shortcuts overlay, except while typing. A form control was already excluded; an
  // editable surface (the rich-text editor is a contenteditable div) now is too.
  describe("the '?' shortcut and typing targets", () => {
    it("a '?' typed in an editable surface does not toggle the shortcuts overlay; from a non-editable element (or a contenteditable=\"false\" one) it still does", async () => {
      mountWorkbench()
      await flushUi()
      const root = container!.querySelector('.mt-workbench') as HTMLElement
      expect(root).toBeTruthy()
      const overlay = () => container!.querySelector('.mt-workbench__shortcuts-overlay')
      const press = async (el: HTMLElement) => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }))
        await flushUi()
      }
      const made: HTMLElement[] = []
      const editable = (value: string, parent: HTMLElement = root) => {
        const el = document.createElement('div')
        el.setAttribute('contenteditable', value)
        parent.appendChild(el)
        made.push(el)
        return el
      }
      try {
        // editable surfaces: "true", "", "plaintext-only", a plain child inside an editor, and a
        // contenteditable="false" chip inside an editor (it sits in an editable ancestor)
        const editor = editable('true')
        const child = document.createElement('span')
        editor.appendChild(child)
        for (const el of [editor, editable(''), editable('plaintext-only'), child, editable('false', editor)]) {
          await press(el)
          expect(overlay()).toBeNull()
        }
        // not editable: a standalone contenteditable="false" element toggles, as the main area does
        await press(editable('false'))
        expect(overlay()).not.toBeNull()
      } finally {
        for (const el of made) el.remove()
      }
    })
  })
  // mod+z / mod+y / mod+shift+z belong to the workbench while it is mounted (utils/workbench-undo.ts, on
  // the document, capture phase): the browser's own, page-wide undo never runs. A text control's chord is
  // its own step or nothing; the grid's undo/redo runs only from a non-text target in the workbench (or
  // the page itself after a press in it), and nothing runs outside it.
  describe('workbench-owned undo (utils/workbench-undo.ts)', () => {
    const made: HTMLElement[] = []
    const removers: Array<() => void> = []
    afterEach(() => {
      while (removers.length) removers.pop()!()
      while (made.length) made.pop()!.remove()
    })
    const CHORDS: KeyboardEventInit[] = [
      { key: 'z', metaKey: true }, { key: 'z', ctrlKey: true }, { key: 'Z', metaKey: true, shiftKey: true },
      { key: 'z', ctrlKey: true, shiftKey: true }, { key: 'y', ctrlKey: true }, { key: 'y', metaKey: true },
    ]
    function withProps<T extends Event>(event: T, props: Record<string, unknown>): T {
      for (const [name, value] of Object.entries(props)) {
        if ((event as unknown as Record<string, unknown>)[name] !== value) Object.defineProperty(event, name, { value })
      }
      return event
    }
    /** A root standing in for `.mt-workbench` with a grid surface in it (the grid / the record drawer), an
     *  element outside it (a teleported dialog), and the module installed on the document the way the
     *  workbench installs it. */
    function rig() {
      let clock = 0
      const root = document.createElement('div')
      const gridSurface = root.appendChild(document.createElement('div'))
      const outside = document.createElement('div')
      document.body.append(root, outside)
      made.push(root, outside)
      const undo = createWorkbenchUndo({ now: () => clock, isInsideWorkbench: (node) => root.contains(node), isGridSurface: (node) => gridSurface.contains(node) })
      const grid = { undo: 0, redo: 0 }
      removers.push(installWorkbenchUndo(undo, { undo: () => { grid.undo += 1 }, redo: () => { grid.redo += 1 } }))
      const add = <T extends HTMLElement>(el: T, where: HTMLElement = root): T => { where.appendChild(el); return el }
      const editable = (where: HTMLElement = root) => {
        const el = add(document.createElement('div'), where)
        el.setAttribute('contenteditable', 'true')
        el.tabIndex = 0
        return el
      }
      const setContent = (host: HTMLElement, next: string) => {
        if (host instanceof HTMLInputElement || host instanceof HTMLTextAreaElement) host.value = next
        else host.innerHTML = next
      }
      /** One user edit the way a browser reports it: beforeinput, the DOM change, input. */
      const edit = (host: HTMLElement, next: string, inputType = 'insertText', advance = 100) => {
        clock += advance
        host.dispatchEvent(withProps(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType }), { inputType }))
        setContent(host, next)
        host.dispatchEvent(withProps(new InputEvent('input', { bubbles: true, inputType }), { inputType }))
      }
      /** An edit through the editor's own execCommand: `input` with no `beforeinput`. */
      const commandEdit = (host: HTMLElement, next: string, inputType = 'insertText') => {
        setContent(host, next)
        host.dispatchEvent(withProps(new InputEvent('input', { bubbles: true, inputType }), { inputType }))
      }
      /** What the module decides for this keydown (decided directly, not dispatched). */
      const key = (target: EventTarget, init: KeyboardEventInit, extra: Record<string, unknown> = {}) => {
        const event = withProps(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }), { target, ...extra })
        return undo.decide(event)
      }
      /** A keydown dispatched for real: was it default-prevented, and did the grid's undo/redo run. */
      const press = (target: EventTarget, init: KeyboardEventInit) => {
        const before = { ...grid }
        const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
        target.dispatchEvent(event)
        return { prevented: event.defaultPrevented, undo: grid.undo - before.undo, redo: grid.redo - before.redo }
      }
      const pause = (ms: number) => { clock += ms }
      return { undo, root, gridSurface, outside, add, editable, edit, commandEdit, key, press, pause, grid }
    }
    const value = (el: HTMLElement) => (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.innerHTML)

    it('every chord is default-prevented from every target, in every state: inside the workbench, on the page itself, and outside it', () => {
      const { add, editable, edit, press, root, outside } = rig()
      const textarea = add(document.createElement('textarea'))
      const text = add(Object.assign(document.createElement('input'), { type: 'text' }))
      const editor = editable()
      const date = add(Object.assign(document.createElement('input'), { type: 'date' }))
      const select = add(document.createElement('select'))
      const checkbox = add(Object.assign(document.createElement('input'), { type: 'checkbox' }))
      const outsideText = add(Object.assign(document.createElement('input'), { type: 'text' }), outside)
      const outsideButton = add(document.createElement('button'), outside)
      // a control that stops propagation of every key (like the comment affordance buttons)
      const stopper = add(document.createElement('button'))
      stopper.addEventListener('keydown', (event) => event.stopPropagation())
      edit(textarea, 'typed')
      for (const target of [textarea, text, editor, date, select, checkbox, root, document.body, outsideText, outsideButton, stopper]) {
        for (const init of CHORDS) {
          expect(press(target, init).prevented, `${(target as HTMLElement).tagName} ${JSON.stringify(init)}`).toBe(true)
          expect(press(target, { ...init, isComposing: true })).toEqual({ prevented: true, undo: 0, redo: 0 })
          // Safari reports the key that ends a composition with keyCode 229 and isComposing false
          expect(press(target, { ...init, keyCode: 229 })).toEqual({ prevented: true, undo: 0, redo: 0 })
        }
      }
      expect(press(textarea, { key: 'z' }).prevented).toBe(false)
      expect(press(textarea, { key: 'x', metaKey: true }).prevented).toBe(false)
    })

    it('where the chord goes when no control step applies: a text control never hands it on; the grid runs from a non-text target inside, and from the page itself only after a press or focus on a grid surface; nothing outside', () => {
      const { add, edit, key, root, gridSurface, outside } = rig()
      const inside = add(Object.assign(document.createElement('input'), { type: 'text' }))
      const insideButton = add(document.createElement('button'))
      const gridButton = add(document.createElement('button'), gridSurface)
      const gridText = add(Object.assign(document.createElement('input'), { type: 'text' }), gridSurface)
      const date = add(Object.assign(document.createElement('input'), { type: 'date' }))
      const outsideText = add(Object.assign(document.createElement('input'), { type: 'text' }), outside)
      const outsideButton = add(document.createElement('button'), outside)
      const mousedown = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      expect(key(inside, { key: 'z', metaKey: true })).toBe('swallow')
      expect(key(inside, { key: 'Z', metaKey: true, shiftKey: true })).toBe('swallow')
      expect(key(inside, { key: 'y', metaKey: true })).toBe('swallow')
      expect(key(insideButton, { key: 'z', metaKey: true })).toBe('grid-undo')
      expect(key(gridButton, { key: 'z', metaKey: true })).toBe('grid-undo')
      expect(key(date, { key: 'y', metaKey: true })).toBe('grid-redo')
      expect(key(root, { key: 'Z', metaKey: true, shiftKey: true })).toBe('grid-redo')
      expect(key(outsideButton, { key: 'z', metaKey: true })).toBe('swallow')
      expect(key(outsideText, { key: 'z', metaKey: true })).toBe('swallow')
      // the page itself: the grid's after a press or focus on a grid surface (the title committed by
      // Enter); nothing after one elsewhere in the workbench (a rail or manager rename whose input went
      // away), in an overlay (a popover's background, a dialog's button, which Safari does not focus)
      mousedown(gridButton)
      expect(key(document.body, { key: 'z', metaKey: true })).toBe('grid-undo')
      mousedown(insideButton)
      expect(key(document.body, { key: 'z', metaKey: true })).toBe('swallow')
      gridText.focus()
      expect(key(document.body, { key: 'z', metaKey: true })).toBe('grid-undo')
      inside.focus()
      expect(key(document.body, { key: 'Z', metaKey: true, shiftKey: true })).toBe('swallow')
      mousedown(gridButton)
      mousedown(outsideButton)
      expect(key(document.body, { key: 'z', metaKey: true })).toBe('swallow')
      mousedown(gridButton)
      // a press on the page itself (outside every control) changes nothing either way
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      expect(key(document.body, { key: 'z', metaKey: true })).toBe('grid-undo')
      mousedown(outsideButton)
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      expect(key(document.body, { key: 'z', metaKey: true })).toBe('swallow')
      outsideText.focus()
      expect(key(document.body, { key: 'z', metaKey: true })).toBe('swallow')
      // a control outside the workbench still has its own history
      edit(outsideText, 'filter value')
      expect(key(outsideText, { key: 'z', metaKey: true })).toBe('restored')
      expect(outsideText.value).toBe('')
      expect(key(outsideText, { key: 'z', metaKey: true })).toBe('swallow')
    })

    it('typing is undone and redone burst by burst from the control\'s own history, then the chord does nothing; Cmd+Y is never a text redo; new typing clears redo', () => {
      const { add, edit, key, pause } = rig()
      for (const host of [add(document.createElement('textarea')), add(Object.assign(document.createElement('input'), { type: 'text' }))]) {
        edit(host, 'a'); edit(host, 'ab'); edit(host, 'abc')
        pause(2000)
        edit(host, 'abc d'); edit(host, 'abc de')
        expect(key(host, { key: 'z', metaKey: true })).toBe('restored')
        expect(value(host)).toBe('abc')
        expect(key(host, { key: 'z', ctrlKey: true })).toBe('restored')
        expect(value(host)).toBe('')
        expect(key(host, { key: 'z', metaKey: true })).toBe('swallow')
        expect(value(host)).toBe('')
        expect(key(host, { key: 'Z', metaKey: true, shiftKey: true })).toBe('restored')
        expect(value(host)).toBe('abc')
        expect(key(host, { key: 'y', metaKey: true })).toBe('swallow') // Cmd+Y is never a text redo
        expect(value(host)).toBe('abc')
        expect(key(host, { key: 'y', ctrlKey: true })).toBe('restored')
        expect(value(host)).toBe('abc de')
        expect(key(host, { key: 'y', ctrlKey: true })).toBe('swallow')
        expect(key(host, { key: 'z', metaKey: true })).toBe('restored')
        edit(host, 'abcX')
        expect(key(host, { key: 'Z', metaKey: true, shiftKey: true })).toBe('swallow')
        expect(value(host)).toBe('abcX')
      }
    })

    it('a different kind of edit starts a new step, and every paste or line break is a step of its own', () => {
      const { add, edit, key } = rig()
      const host = add(document.createElement('textarea'))
      edit(host, 'ab'); edit(host, 'abc')
      edit(host, 'ab', 'deleteContentBackward')
      edit(host, 'ab pasted', 'insertFromPaste')
      edit(host, 'ab pasted pasted', 'insertFromPaste')
      edit(host, 'ab pasted pasted\n', 'insertLineBreak')
      edit(host, 'ab pasted pasted\n\n', 'insertLineBreak')
      for (const expected of ['ab pasted pasted\n', 'ab pasted pasted', 'ab pasted', 'ab', 'abc', '']) {
        expect(key(host, { key: 'z', metaKey: true })).toBe('restored')
        expect(host.value).toBe(expected)
      }
      expect(key(host, { key: 'z', metaKey: true })).toBe('swallow')
    })

    it('a step that would change nothing (a beforeinput no edit followed) is skipped: one press always does something', () => {
      const { add, edit, key, pause } = rig()
      const host = add(document.createElement('textarea'))
      edit(host, 'ab')
      pause(2000)
      // Backspace in a box with nothing to delete, or an edit someone cancelled: beforeinput, no input
      host.dispatchEvent(withProps(new InputEvent('beforeinput', { bubbles: true, cancelable: true }), { inputType: 'deleteContentBackward' }))
      expect(key(host, { key: 'z', metaKey: true })).toBe('restored')
      expect(host.value).toBe('')
    })

    it('a restore tells the control\'s listeners (input), plain box and editable surface alike, and is not itself recorded as an edit', () => {
      const { add, editable, edit, key } = rig()
      const host = add(document.createElement('textarea'))
      const editor = editable()
      for (const el of [host, editor]) {
        const seen: string[] = []
        el.addEventListener('input', () => { seen.push(value(el)) })
        edit(el, 'one')
        seen.length = 0
        expect(key(el, { key: 'z', metaKey: true })).toBe('restored')
        expect(seen).toEqual([''])
        expect(key(el, { key: 'Z', metaKey: true, shiftKey: true })).toBe('restored')
        expect(value(el)).toBe('one')
        expect(key(el, { key: 'Z', metaKey: true, shiftKey: true })).toBe('swallow')
      }
    })

    it('content no recorded edit produced (a re-render, a chip, a picked suggestion) drops the history, at the next chord or the next edit', () => {
      const { add, editable, edit, key } = rig()
      const text = add(document.createElement('textarea'))
      edit(text, 'typed')
      text.value = 'rewritten by a re-render'
      expect(key(text, { key: 'z', metaKey: true })).toBe('swallow')
      expect(text.value).toBe('rewritten by a re-render')
      // typing straight after a rewrite (no chord in between) starts a fresh history from the rewrite
      const other = add(document.createElement('textarea'))
      edit(other, 'typed')
      other.value = 'REWRITTEN'
      edit(other, 'REWRITTEN!')
      expect(key(other, { key: 'z', metaKey: true })).toBe('restored')
      expect(other.value).toBe('REWRITTEN')
      expect(key(other, { key: 'z', metaKey: true })).toBe('swallow')
      const editor = editable()
      edit(editor, 'hi @')
      editor.innerHTML = 'hi <span contenteditable="false" data-mention-id="u1">@Jamie</span>'
      expect(key(editor, { key: 'z', metaKey: true })).toBe('swallow')
      expect(editor.innerHTML).toContain('data-mention-id')
    })

    it('a formatting-only change in an editable surface is an edit too, and a formatting-only rewrite is a rewrite (content is compared as HTML)', () => {
      const { editable, edit, key } = rig()
      const editor = editable()
      edit(editor, 'word')
      edit(editor, '<b>word</b>', 'formatBold')
      expect(key(editor, { key: 'z', metaKey: true })).toBe('restored')
      expect(editor.innerHTML).toBe('word')
      edit(editor, 'word!')
      editor.innerHTML = '<i>word!</i>'
      expect(key(editor, { key: 'z', metaKey: true })).toBe('swallow')
      expect(editor.innerHTML).toBe('<i>word!</i>')
    })

    it('an edit with no beforeinput (the rich editor\'s paste, drop and toolbar go through execCommand) is a step of its own, back to the content just before it', () => {
      const { add, editable, edit, commandEdit, key } = rig()
      // a paste into an editor that was never typed into: the paste event is the checkpoint
      const editor = editable()
      editor.innerHTML = 'rich'
      editor.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }))
      commandEdit(editor, 'rich PASTED')
      expect(key(editor, { key: 'z', metaKey: true })).toBe('restored')
      expect(editor.innerHTML).toBe('rich')
      expect(key(editor, { key: 'z', metaKey: true })).toBe('swallow')
      // drop and cut are checkpoints too
      for (const gesture of ['drop', 'cut']) {
        const surface = editable()
        surface.innerHTML = `before ${gesture}`
        surface.dispatchEvent(new Event(gesture, { bubbles: true, cancelable: true }))
        commandEdit(surface, `after ${gesture}`)
        expect(key(surface, { key: 'z', metaKey: true }), gesture).toBe('restored')
        expect(surface.innerHTML).toBe(`before ${gesture}`)
      }
      // a toolbar press (focus stays in the editor) after typing: typing, then bold, are two steps
      const other = editable()
      other.focus()
      expect(document.activeElement).toBe(other)
      edit(other, 'word')
      const bold = add(document.createElement('button'))
      bold.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      commandEdit(other, '<b>word</b>', 'formatBold')
      expect(key(other, { key: 'z', metaKey: true })).toBe('restored')
      expect(other.innerHTML).toBe('word')
      expect(key(other, { key: 'z', metaKey: true })).toBe('restored')
      expect(other.innerHTML).toBe('')
      // the toolbar press makes the checkpoint: the editor was re-rendered while it kept focus, so the
      // bold goes back to the re-rendered content, never to the stale typing before it
      edit(other, 'typed')
      other.innerHTML = 'from a re-render'
      bold.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      commandEdit(other, '<b>from a re-render</b>', 'formatBold')
      expect(key(other, { key: 'z', metaKey: true })).toBe('restored')
      expect(other.innerHTML).toBe('from a re-render')
      // focus alone makes the checkpoint: a toolbar edit on content the editor got from a re-render
      const third = editable()
      third.innerHTML = 'from the server'
      third.focus()
      commandEdit(third, '<b>from the server</b>', 'formatBold')
      expect(key(third, { key: 'z', metaKey: true })).toBe('restored')
      expect(third.innerHTML).toBe('from the server')
    })

    it('an input-method composition is one step back to the content before it; the marked text is never a step (Chromium and Safari orders)', () => {
      const { add, edit, key, pause } = rig()
      type Order = 'chromium' | 'safari' | 'safari-no-delete'
      const composition = (host: HTMLInputElement, marked: string[], committed: string, order: Order) => {
        host.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
        for (const text of marked) {
          pause(1500) // longer than the burst window: a pause on the candidate list
          host.dispatchEvent(withProps(new InputEvent('beforeinput', { bubbles: true, cancelable: false, inputType: 'insertCompositionText' }), { inputType: 'insertCompositionText', isComposing: true }))
          host.value = `ok ${text}`
          host.dispatchEvent(withProps(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText' }), { inputType: 'insertCompositionText', isComposing: true }))
        }
        pause(1500)
        if (order === 'safari' || order === 'safari-no-delete') {
          if (order === 'safari') {
            host.dispatchEvent(withProps(new InputEvent('beforeinput', { bubbles: true, cancelable: false }), { inputType: 'deleteCompositionText', isComposing: true }))
            host.value = 'ok '
            host.dispatchEvent(withProps(new InputEvent('input', { bubbles: true }), { inputType: 'deleteCompositionText', isComposing: true }))
          }
          host.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: committed }))
          host.dispatchEvent(withProps(new InputEvent('beforeinput', { bubbles: true, cancelable: true }), { inputType: 'insertFromComposition' }))
          host.value = `ok ${committed}`
          host.dispatchEvent(withProps(new InputEvent('input', { bubbles: true }), { inputType: 'insertFromComposition' }))
        } else {
          host.dispatchEvent(withProps(new InputEvent('beforeinput', { bubbles: true, cancelable: false }), { inputType: 'insertCompositionText', isComposing: true }))
          host.value = `ok ${committed}`
          host.dispatchEvent(withProps(new InputEvent('input', { bubbles: true }), { inputType: 'insertCompositionText', isComposing: true }))
          host.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: committed }))
        }
      }
      for (const order of ['chromium', 'safari', 'safari-no-delete'] as Order[]) {
        const host = add(Object.assign(document.createElement('input'), { type: 'text' }))
        edit(host, 'ok ')
        pause(2000)
        composition(host, ['n', 'ni', 'ni hao'], '你好', order)
        expect(key(host, { key: 'z', metaKey: true }), order).toBe('restored')
        expect(host.value).toBe('ok ')
        expect(key(host, { key: 'z', metaKey: true })).toBe('restored')
        expect(host.value).toBe('')
        expect(key(host, { key: 'Z', metaKey: true, shiftKey: true })).toBe('restored')
        expect(key(host, { key: 'Z', metaKey: true, shiftKey: true })).toBe('restored')
        expect(host.value).toBe('ok 你好')
        // typing after the composition is recorded again, burst by burst
        pause(2000)
        edit(host, 'ok 你好 a')
        pause(2000)
        edit(host, 'ok 你好 ab')
        expect(key(host, { key: 'z', metaKey: true }), order).toBe('restored')
        expect(host.value).toBe('ok 你好 a')
        expect(key(host, { key: 'z', metaKey: true })).toBe('restored')
        expect(host.value).toBe('ok 你好')
      }
    })

    it('the Edit menu\'s undo (beforeinput historyUndo/historyRedo) is cancelled: the control\'s own step when it has one, never the grid', () => {
      const { add, edit, grid } = rig()
      const host = add(document.createElement('textarea'))
      host.focus()
      edit(host, 'typed')
      const menu = (inputType: string) => {
        const event = withProps(new InputEvent('beforeinput', { bubbles: true, cancelable: true }), { inputType })
        host.dispatchEvent(event)
        return event.defaultPrevented
      }
      expect(menu('historyUndo')).toBe(true)
      expect(host.value).toBe('')
      expect(menu('historyRedo')).toBe(true)
      expect(host.value).toBe('typed')
      expect(menu('historyRedo')).toBe(true)
      expect(menu('historyUndo')).toBe(true)
      expect(menu('historyUndo')).toBe(true)
      expect(host.value).toBe('')
      expect(grid).toEqual({ undo: 0, redo: 0 })
      // aimed at a control that does not have focus: cancelled, and the control is left as it is
      edit(host, 'typed again')
      host.blur()
      expect(menu('historyUndo')).toBe(true)
      expect(host.value).toBe('typed again')
    })

    it('a held key in a text control stops at its last step (never the grid); a held key on the grid itself still runs the grid\'s', () => {
      const { add, edit, key, root } = rig()
      const host = add(document.createElement('textarea'))
      edit(host, 'typed')
      expect(key(host, { key: 'z', metaKey: true, repeat: true })).toBe('restored')
      expect(key(host, { key: 'z', metaKey: true, repeat: true })).toBe('swallow')
      expect(key(host, { key: 'z', metaKey: true })).toBe('swallow')
      expect(key(root, { key: 'z', metaKey: true, repeat: true })).toBe('grid-undo')
    })

    it('after a restore the next typing starts a new step, even within the burst window', () => {
      const { add, edit, key, pause } = rig()
      const host = add(document.createElement('textarea'))
      edit(host, 'a')
      pause(2000)
      edit(host, 'ab')
      expect(key(host, { key: 'z', metaKey: true })).toBe('restored')
      expect(host.value).toBe('a')
      edit(host, 'ax') // 100ms later: same kind, inside the window, with an earlier step still there
      expect(key(host, { key: 'z', metaKey: true })).toBe('restored')
      expect(host.value).toBe('a')
      expect(key(host, { key: 'z', metaKey: true })).toBe('restored')
      expect(host.value).toBe('')
    })

    it('consecutive deletes are one step; a restore puts a plain box\'s selection back where it was', () => {
      const { add, edit, key, pause } = rig()
      const host = add(document.createElement('textarea'))
      edit(host, 'abcdef')
      pause(2000)
      host.setSelectionRange(3, 3)
      edit(host, 'abdef', 'deleteContentBackward'); edit(host, 'adef', 'deleteContentBackward')
      expect(key(host, { key: 'z', metaKey: true })).toBe('restored')
      expect(host.value).toBe('abcdef')
      expect([host.selectionStart, host.selectionEnd]).toEqual([3, 3])
      expect(key(host, { key: 'z', metaKey: true })).toBe('restored')
      expect(host.value).toBe('')
    })

    it('a number box takes no snapshot while it holds a draft its value cannot report ("-", "1." read as "")', () => {
      const { add, key, edit, pause } = rig()
      const host = add(Object.assign(document.createElement('input'), { type: 'number' }))
      let bad = true
      Object.defineProperty(host, 'validity', { get: () => ({ badInput: bad }) })
      expect(key(host, { key: 'z', metaKey: true })).toBe('swallow')
      // '1', pause, '.', pause, '5': the box shows "1." (reads "") when the '5' comes, so no snapshot then
      bad = false
      edit(host, '1')
      pause(2000)
      edit(host, '') // the "." : value reads "" from now on
      bad = true
      pause(2000)
      host.dispatchEvent(withProps(new InputEvent('beforeinput', { bubbles: true, cancelable: true }), { inputType: 'insertText' }))
      host.value = '1.5'
      bad = false
      host.dispatchEvent(withProps(new InputEvent('input', { bubbles: true }), { inputType: 'insertText' }))
      expect(key(host, { key: 'z', metaKey: true })).toBe('restored')
      expect(host.value).toBe('1')
      // a box holding a bad draft with an earlier step: the chord does nothing (its value is misread)
      pause(2000)
      edit(host, '') // '1-': reads ""
      bad = true
      expect(key(host, { key: 'z', metaKey: true })).toBe('swallow')
      expect(key(host, { key: 'Z', metaKey: true, shiftKey: true })).toBe('swallow')
    })

    it('a layout whose key is not a Latin letter is matched by the key\'s position (code); a Latin key wins over its position (QWERTZ); Alt held is never ours (Windows AltGr)', () => {
      const { root, key, add } = rig()
      expect(key(root, { key: 'я', code: 'KeyZ', metaKey: true })).toBe('grid-undo')
      expect(key(root, { key: 'Я', code: 'KeyZ', metaKey: true, shiftKey: true })).toBe('grid-redo')
      expect(key(root, { key: 'н', code: 'KeyY', ctrlKey: true })).toBe('grid-redo')
      expect(key(root, { key: 'ч', code: 'KeyX', metaKey: true })).toBe('none')
      // QWERTZ: the key labelled Z sits at code KeyY
      expect(key(root, { key: 'z', code: 'KeyY', ctrlKey: true })).toBe('grid-undo')
      expect(key(root, { key: 'y', code: 'KeyZ', ctrlKey: true })).toBe('grid-redo')
      // Windows AltGr = Ctrl+Alt: Polish AltGr+Z types 'ż', Shift+AltGr+Z 'Ż'
      const box = add(document.createElement('textarea'))
      expect(key(box, { key: 'ż', code: 'KeyZ', ctrlKey: true, altKey: true })).toBe('none')
      expect(key(box, { key: 'Ż', code: 'KeyZ', ctrlKey: true, altKey: true, shiftKey: true })).toBe('none')
      expect(key(root, { key: 'z', code: 'KeyZ', ctrlKey: true, altKey: true })).toBe('none')
      expect(key(root, { key: 'z', code: 'KeyZ', metaKey: true, altKey: true })).toBe('none')
    })

    it('an editable surface\'s restore puts the caret back where it was, not at the end', () => {
      const { editable, edit, key, pause } = rig()
      const editor = editable()
      editor.focus()
      edit(editor, 'hello world')
      pause(2000)
      const text = editor.firstChild!
      const selection = document.getSelection()!
      const caret = document.createRange()
      caret.setStart(text, 5)
      caret.collapse(true)
      selection.removeAllRanges()
      selection.addRange(caret)
      edit(editor, 'hello, world')
      expect(key(editor, { key: 'z', metaKey: true })).toBe('restored')
      expect(editor.innerHTML).toBe('hello world')
      const range = document.getSelection()!.getRangeAt(0)
      expect(range.startContainer.textContent).toBe('hello world')
      expect(range.startOffset).toBe(5)
    })

    it('each control keeps at most 100 steps', () => {
      const { add, edit, key } = rig()
      const host = add(document.createElement('textarea'))
      for (let i = 1; i <= 150; i += 1) edit(host, `${host.value}${i},`, 'insertFromPaste')
      let restored = 0
      for (let i = 0; i < 200 && key(host, { key: 'z', metaKey: true }) === 'restored'; i += 1) restored += 1
      expect(restored).toBe(100)
    })

    it('a DOM change is not a commit: after a blur and back, the control\'s typing is still its own to undo', () => {
      const { add, edit, key } = rig()
      const host = add(document.createElement('textarea'))
      host.focus()
      edit(host, 'Please re-check')
      host.dispatchEvent(new Event('change', { bubbles: true }))
      host.blur()
      host.focus()
      expect(key(host, { key: 'z', metaKey: true })).toBe('restored')
      expect(host.value).toBe('')
    })

    it('beginCommit: settled (the server accepted it) ends the history at the commit; edits made since stay undoable, also within the same burst, across overlapping commits, and after an undo in flight; unsettled (rejected) keeps it all', () => {
      const { undo, add, edit, key, pause } = rig()
      const box = () => {
        const row = add(document.createElement('div'))
        row.className = 'meta-record-drawer__field'
        return { row, el: row.appendChild(document.createElement('textarea')) }
      }
      // settled with nothing typed since: no step left
      const a = box()
      edit(a.el, 'committed')
      undo.beginCommit([a.row])()
      expect(key(a.el, { key: 'z', metaKey: true })).toBe('swallow')
      expect(a.el.value).toBe('committed')
      // typed while the patch is in flight, straight on (inside the burst window): its own step
      const b = box()
      edit(b.el, 'committed')
      const settleB = undo.beginCommit([b.row])
      edit(b.el, 'committed and more')
      settleB()
      expect(key(b.el, { key: 'z', metaKey: true })).toBe('restored')
      expect(b.el.value).toBe('committed')
      expect(key(b.el, { key: 'z', metaKey: true })).toBe('swallow')
      // two overlapping commits of one field, settled in either order
      for (const order of ['in order', 'reversed']) {
        const c = box()
        edit(c.el, 'one')
        const first = undo.beginCommit([c.row])
        pause(2000)
        edit(c.el, 'one two')
        const second = undo.beginCommit([c.row])
        pause(2000)
        edit(c.el, 'one two three')
        if (order === 'in order') { first(); second() } else { second(); first() }
        expect(key(c.el, { key: 'z', metaKey: true }), order).toBe('restored')
        expect(c.el.value).toBe('one two')
        expect(key(c.el, { key: 'z', metaKey: true }), order).toBe('swallow')
      }
      // an undo while the patch is in flight, then typing: settle removes nothing that is still there
      const d = box()
      edit(d.el, 'sent')
      const settleD = undo.beginCommit([d.row])
      expect(key(d.el, { key: 'z', metaKey: true })).toBe('restored')
      expect(d.el.value).toBe('')
      pause(2000)
      edit(d.el, 'again')
      settleD()
      expect(key(d.el, { key: 'z', metaKey: true })).toBe('restored')
      expect(d.el.value).toBe('')
      // an undo and a redo while the patch is in flight: the commit still ends the history
      const g = box()
      edit(g.el, 'X')
      pause(2000)
      edit(g.el, 'XY')
      const settleG = undo.beginCommit([g.row])
      expect(key(g.el, { key: 'z', metaKey: true })).toBe('restored')
      expect(key(g.el, { key: 'Z', metaKey: true, shiftKey: true })).toBe('restored')
      expect(g.el.value).toBe('XY')
      settleG()
      expect(key(g.el, { key: 'z', metaKey: true })).toBe('swallow')
      expect(g.el.value).toBe('XY')
      // a control marked twice (a contenteditable chip inside the editor maps back to the editor)
      const e = add(document.createElement('div'))
      e.className = 'meta-record-drawer__field'
      const editor = e.appendChild(document.createElement('div'))
      editor.setAttribute('contenteditable', 'true')
      edit(editor, 'x <span contenteditable="false">@chip</span>')
      const settleE1 = undo.beginCommit([e, e])
      pause(2000)
      edit(editor, 'x <span contenteditable="false">@chip</span> y')
      settleE1()
      settleE1()
      expect(key(editor, { key: 'z', metaKey: true })).toBe('restored')
      expect(editor.innerHTML).toBe('x <span contenteditable="false">@chip</span>')
      // rejected (never settled): the typing stays undoable
      const f = box()
      edit(f.el, 'rejected draft')
      undo.beginCommit([f.row])
      expect(key(f.el, { key: 'z', metaKey: true })).toBe('restored')
      expect(f.el.value).toBe('')
    })

    it('beginCommit: a step from before an accepted commit never comes back (undone in flight, redone once accepted); a commit after an undo marks the step on top, so a redo in flight stays undoable; an edit with no beforeinput or a composition made in flight stays undoable', () => {
      const { undo, add, edit, commandEdit, key, pause } = rig()
      const box = () => {
        const row = add(document.createElement('div'))
        row.className = 'meta-record-drawer__field'
        return { row, el: row.appendChild(document.createElement('textarea')) }
      }
      const z = { key: 'z', metaKey: true }
      const shiftZ = { key: 'Z', metaKey: true, shiftKey: true }
      // undone while in flight, redone after it was accepted: back at the committed text, and no further
      const a = box()
      edit(a.el, 'X')
      const settleA = undo.beginCommit([a.row])
      expect(key(a.el, z)).toBe('restored')
      expect(a.el.value).toBe('')
      settleA()
      expect(key(a.el, shiftZ)).toBe('restored')
      expect(a.el.value).toBe('X')
      expect(key(a.el, z)).toBe('swallow')
      expect(a.el.value).toBe('X')
      // two bursts, both undone in flight and both redone after: still no step back past the commit
      const b = box()
      edit(b.el, 'X')
      pause(2000)
      edit(b.el, 'XY')
      const settleB = undo.beginCommit([b.row])
      expect(key(b.el, z)).toBe('restored')
      expect(key(b.el, z)).toBe('restored')
      expect(b.el.value).toBe('')
      settleB()
      expect(key(b.el, shiftZ)).toBe('restored')
      expect(key(b.el, shiftZ)).toBe('restored')
      expect(b.el.value).toBe('XY')
      expect(key(b.el, z)).toBe('swallow')
      expect(b.el.value).toBe('XY')
      // two overlapping commits, both undone in flight, accepted in reverse order, then redone: the later
      // commit still holds
      const r = box()
      edit(r.el, 'one')
      const first = undo.beginCommit([r.row])
      pause(2000)
      edit(r.el, 'one two')
      const second = undo.beginCommit([r.row])
      expect(key(r.el, z)).toBe('restored')
      expect(key(r.el, z)).toBe('restored')
      expect(r.el.value).toBe('')
      second()
      first()
      expect(key(r.el, shiftZ)).toBe('restored')
      expect(key(r.el, shiftZ)).toBe('restored')
      expect(r.el.value).toBe('one two')
      expect(key(r.el, z)).toBe('swallow')
      expect(r.el.value).toBe('one two')
      // committed after an undo (the step on top is the first burst), then redone in flight: the redo is
      // an edit since the commit, undoable back to the committed text
      const c = box()
      edit(c.el, 'X')
      pause(2000)
      edit(c.el, 'XY')
      expect(key(c.el, z)).toBe('restored')
      const settleC = undo.beginCommit([c.row])
      expect(key(c.el, shiftZ)).toBe('restored')
      settleC()
      expect(key(c.el, z)).toBe('restored')
      expect(c.el.value).toBe('X')
      expect(key(c.el, z)).toBe('swallow')
      // an edit through the editor's own command (no beforeinput) while in flight
      const d = box()
      edit(d.el, 'sent')
      const settleD = undo.beginCommit([d.row])
      commandEdit(d.el, 'sent pasted')
      settleD()
      expect(key(d.el, z)).toBe('restored')
      expect(d.el.value).toBe('sent')
      expect(key(d.el, z)).toBe('swallow')
      // a composition while in flight
      const e = box()
      edit(e.el, 'ok')
      const settleE = undo.beginCommit([e.row])
      e.el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      e.el.dispatchEvent(withProps(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertCompositionText' }), { inputType: 'insertCompositionText', isComposing: true }))
      e.el.value = 'ok 中'
      e.el.dispatchEvent(withProps(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText' }), { inputType: 'insertCompositionText', isComposing: true }))
      e.el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }))
      settleE()
      expect(key(e.el, z)).toBe('restored')
      expect(e.el.value).toBe('ok')
      expect(key(e.el, z)).toBe('swallow')
      // a beforeinput no edit followed (Backspace at the start) between an undo and a redo: the commit's
      // mark is the highest step number, not the top one's
      const f = box()
      edit(f.el, 'X')
      pause(2000)
      edit(f.el, 'XY')
      expect(key(f.el, z)).toBe('restored')
      expect(f.el.value).toBe('X')
      f.el.dispatchEvent(withProps(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward' }), { inputType: 'deleteContentBackward' }))
      expect(key(f.el, shiftZ)).toBe('restored')
      expect(f.el.value).toBe('XY')
      undo.beginCommit([f.row])()
      expect(key(f.el, z)).toBe('swallow')
      expect(f.el.value).toBe('XY')
      // committed before the control had a step of its own (focused, nothing typed): typing since is undoable
      const g = box()
      g.el.value = 'saved'
      g.el.focus()
      undo.beginCommit([g.row])()
      edit(g.el, 'saved more')
      expect(key(g.el, z)).toBe('restored')
      expect(g.el.value).toBe('saved')
      // a key that changes nothing between an undo made in flight and a redo, before or after the
      // server accepted: still no step back past the commit
      const noop = (el: HTMLElement) => el.dispatchEvent(withProps(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward' }), { inputType: 'deleteContentBackward' }))
      for (const when of ['before the accept', 'after the accept']) {
        const q = box()
        edit(q.el, 'X')
        pause(2000)
        edit(q.el, 'XY')
        const settleQ = undo.beginCommit([q.row])
        expect(key(q.el, z), when).toBe('restored')
        expect(q.el.value).toBe('X')
        if (when === 'after the accept') settleQ()
        noop(q.el)
        expect(key(q.el, shiftZ), when).toBe('restored')
        expect(q.el.value).toBe('XY')
        if (when === 'before the accept') settleQ()
        expect(key(q.el, z), when).toBe('swallow')
        expect(q.el.value, when).toBe('XY')
      }
      // two such keys apart (each its own step) between an undo in flight and a redo, and two before a commit
      const t = box()
      edit(t.el, 'X')
      pause(2000)
      edit(t.el, 'XY')
      const settleT = undo.beginCommit([t.row])
      expect(key(t.el, z)).toBe('restored')
      noop(t.el)
      pause(2000)
      noop(t.el)
      expect(key(t.el, shiftZ)).toBe('restored')
      settleT()
      expect(key(t.el, z)).toBe('swallow')
      expect(t.el.value).toBe('XY')
      const u = box()
      edit(u.el, 'X')
      pause(2000)
      edit(u.el, 'XY')
      expect(key(u.el, z)).toBe('restored')
      noop(u.el)
      pause(2000)
      noop(u.el)
      const settleU = undo.beginCommit([u.row])
      expect(key(u.el, shiftZ)).toBe('restored')
      settleU()
      expect(key(u.el, z)).toBe('restored')
      expect(u.el.value).toBe('X')
      // undo, a key that changes nothing, then the commit (of what the box shows), then a redo in flight:
      // the redo is an edit since the commit, undoable back to the committed text
      const m = box()
      edit(m.el, 'X')
      pause(2000)
      edit(m.el, 'XY')
      expect(key(m.el, z)).toBe('restored')
      noop(m.el)
      const settleM = undo.beginCommit([m.row])
      expect(key(m.el, shiftZ)).toBe('restored')
      expect(m.el.value).toBe('XY')
      settleM()
      expect(key(m.el, z)).toBe('restored')
      expect(m.el.value).toBe('X')
      expect(key(m.el, z)).toBe('swallow')
      // two undos, that key, a redo, the commit, then a redo in flight: the same
      const n = box()
      edit(n.el, 'X')
      pause(2000)
      edit(n.el, 'XY')
      expect(key(n.el, z)).toBe('restored')
      expect(key(n.el, z)).toBe('restored')
      expect(n.el.value).toBe('')
      noop(n.el)
      expect(key(n.el, shiftZ)).toBe('restored')
      expect(n.el.value).toBe('X')
      const settleN = undo.beginCommit([n.row])
      expect(key(n.el, shiftZ)).toBe('restored')
      expect(n.el.value).toBe('XY')
      settleN()
      expect(key(n.el, z)).toBe('restored')
      expect(n.el.value).toBe('X')
      expect(key(n.el, z)).toBe('swallow')
      expect(n.el.value).toBe('X')
      // typed, deleted, typed again (each its own step): an undo drops nothing, each one goes back one step
      const k1 = box()
      edit(k1.el, 'a')
      edit(k1.el, '', 'deleteContentBackward')
      edit(k1.el, 'a')
      for (const expected of ['', 'a', '']) {
        expect(key(k1.el, z)).toBe('restored')
        expect(k1.el.value).toBe(expected)
      }
      expect(key(k1.el, z)).toBe('swallow')
      // a redo after a key that changed nothing drops that step only: the steps below it stay
      const k2 = box()
      edit(k2.el, 'a')
      pause(2000)
      edit(k2.el, 'ab')
      pause(2000)
      edit(k2.el, 'abc')
      expect(key(k2.el, z)).toBe('restored')
      noop(k2.el)
      expect(key(k2.el, shiftZ)).toBe('restored')
      expect(k2.el.value).toBe('abc')
      for (const expected of ['ab', 'a', '']) {
        expect(key(k2.el, z)).toBe('restored')
        expect(k2.el.value).toBe(expected)
      }
      expect(key(k2.el, z)).toBe('swallow')
      // the same at a commit that is then rejected (never settled): the steps below it stay
      const k3 = box()
      edit(k3.el, 'a')
      pause(2000)
      edit(k3.el, 'ab')
      expect(key(k3.el, z)).toBe('restored')
      noop(k3.el)
      undo.beginCommit([k3.row])
      expect(key(k3.el, z)).toBe('restored')
      expect(k3.el.value).toBe('')
    })

    it('reset drops every control\'s history (the drawer showing another record reuses its controls, maybe with equal content)', () => {
      const { undo, add, edit, key } = rig()
      const notes = add(document.createElement('textarea'))
      edit(notes, 'text meant for A')
      edit(notes, '', 'deleteContentBackward')
      // the drawer moves to record B, whose Notes is empty too: the same element, equal content
      undo.reset()
      expect(key(notes, { key: 'z', metaKey: true })).toBe('swallow')
      expect(notes.value).toBe('')
      expect(key(notes, { key: 'Z', metaKey: true, shiftKey: true })).toBe('swallow')
      // typing in B starts B's own history
      edit(notes, 'for B')
      expect(key(notes, { key: 'z', metaKey: true })).toBe('restored')
      expect(notes.value).toBe('')
    })

    it('drawerCommitContainers: the field\'s fields-panel row, plus the title input when the field is the primary one', () => {
      const { add } = rig()
      const rowA = add(document.createElement('div'))
      rowA.className = 'meta-record-drawer__field'
      rowA.dataset.fieldId = 'fld_a'
      const rowB = add(document.createElement('div'))
      rowB.className = 'meta-record-drawer__field'
      rowB.dataset.fieldId = 'fld_b'
      const title = add(Object.assign(document.createElement('input'), { className: 'meta-record-drawer__title-input' }))
      expect(drawerCommitContainers('fld_a', 'fld_a')).toEqual([rowA, title])
      expect(drawerCommitContainers('fld_b', 'fld_a')).toEqual([rowB])
      expect(drawerCommitContainers('fld_missing', null)).toEqual([])
    })

    it('isWorkbenchGridSurface: the grid itself and its cells, the drawer\'s title and fields; not a button, link, menu item or file input there, or anything inside one (an icon pressed on a focused button), nor the grid\'s footer and bars or the drawer\'s other panels', () => {
      const { add } = rig()
      const host = add(document.createElement('div'))
      host.innerHTML = `
        <div class="meta-grid" tabindex="0" data-k="grid">
          <div class="meta-grid__bulk-bar"><button data-k="bulk-delete"><span data-k="bulk-delete-label">Delete selected</span></button></div>
          <table><tbody><tr>
            <td class="meta-grid__check-col"><input data-k="row-check" type="checkbox"></td>
            <td class="meta-grid__cell" data-k="cell"><span data-k="cell-text">v</span></td>
            <td class="meta-grid__cell"><input data-k="cell-editor"><input type="file" data-k="cell-file"><button data-k="cell-button"><span data-k="cell-button-icon">x</span></button></td>
          </tr></tbody><tfoot><tr><td class="meta-grid__foot-cell"><select data-k="foot-select"></select></td></tr></tfoot></table>
          <div class="meta-grid__pagination"><select data-k="page-size"></select></div>
        </div>
        <div class="meta-record-drawer" data-k="drawer">
          <div class="meta-record-drawer__header"><button data-k="next">next</button>
            <div class="meta-record-drawer__titleblock"><input data-k="title" class="meta-record-drawer__title-input"></div>
          </div>
          <div class="meta-record-drawer__body"><button role="tab" data-k="tab">Details</button>
            <div role="tabpanel" tabindex="0" data-k="details-panel">
              <div class="meta-record-drawer__fields"><div class="meta-record-drawer__field">
                <input data-k="field"><textarea data-k="field-text"></textarea><select data-k="field-select"></select>
                <button data-k="comment-anchor"><span><svg viewBox="0 0 16 16"><path data-k="anchor-path" d="M0 0h16v16H0z"></path></svg></span></button>
                <a href="#x" data-k="link"><span data-k="link-label">link</span></a><div role="menuitem" data-k="menuitem"><span data-k="menuitem-label">m</span></div>
                <div role="button" data-k="role-button"><span data-k="role-button-label">r</span></div>
                <input type="file" data-k="field-file">
              </div></div>
              <div class="meta-record-approval-panel"><span data-k="approval">x</span></div>
            </div>
            <div role="tabpanel" tabindex="0" data-k="comments-panel"><textarea data-k="composer"></textarea><button data-k="send">Send</button></div>
            <div class="meta-record-attachments-panel"><input type="file" data-k="file"><span data-k="drop-zone">drop</span><button data-k="remove">x</button></div>
          </div>
        </div>`
      const at = (k: string) => host.querySelector(`[data-k="${k}"]`)!
      expect(isWorkbenchGridSurface(at('cell-text').firstChild!), 'a text node').toBe(true)
      for (const k of ['grid', 'cell', 'cell-text', 'cell-editor', 'title', 'field', 'field-text', 'field-select']) expect(isWorkbenchGridSurface(at(k)), k).toBe(true)
      for (const k of [
        'bulk-delete', 'bulk-delete-label', 'row-check', 'cell-file', 'cell-button', 'cell-button-icon', 'foot-select', 'page-size',
        'drawer', 'next', 'tab', 'details-panel', 'comment-anchor', 'anchor-path', 'link', 'link-label', 'menuitem', 'menuitem-label',
        'role-button', 'role-button-label', 'field-file', 'approval',
        'comments-panel', 'composer', 'send', 'file', 'drop-zone', 'remove',
      ]) {
        expect(isWorkbenchGridSurface(at(k)), k).toBe(false)
      }
    })

    it('isWorkbenchGridTarget: a focused drawer tab panel itself is not the grid\'s (Cmd+Z there does nothing); a control in it, a panel elsewhere and the grid are', () => {
      const drawer = document.body.appendChild(document.createElement('div'))
      drawer.className = 'meta-record-drawer'
      const panel = drawer.appendChild(document.createElement('div'))
      panel.setAttribute('role', 'tabpanel')
      const button = panel.appendChild(document.createElement('button'))
      const elsewhere = document.body.appendChild(document.createElement('div'))
      elsewhere.setAttribute('role', 'tabpanel')
      const gridRoot = document.body.appendChild(document.createElement('div'))
      gridRoot.className = 'meta-grid'
      try {
        expect(isWorkbenchGridTarget(panel)).toBe(false)
        expect(isWorkbenchGridTarget(button)).toBe(true)
        expect(isWorkbenchGridTarget(elsewhere)).toBe(true)
        expect(isWorkbenchGridTarget(gridRoot)).toBe(true)
        // Through the module: a chord on the panel does nothing, on the button in it the grid's undo runs.
        const undo = createWorkbenchUndo({ isInsideWorkbench: () => true, isGridTarget: isWorkbenchGridTarget })
        const chord = (target: EventTarget) => undo.decide(withProps(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }), { target }))
        expect(chord(panel)).toBe('swallow')
        expect(chord(button)).toBe('grid-undo')
      } finally {
        drawer.remove()
        elsewhere.remove()
        gridRoot.remove()
      }
    })

    it('classifies text-entry hosts: textarea, editable contenteditable (and a child), text-like inputs; not date/time, select, checkbox', () => {
      const { add, editable } = rig()
      const editor = editable()
      const child = document.createElement('span')
      editor.appendChild(child)
      expect(textEntryHost(child)).toBe(editor)
      const off = add(document.createElement('div'))
      off.setAttribute('contenteditable', 'false')
      expect(textEntryHost(off)).toBeNull()
      for (const t of ['text', 'search', 'number', 'email']) {
        const el = add(Object.assign(document.createElement('input'), { type: t }))
        expect(textEntryHost(el), t).toBe(el)
      }
      for (const t of ['date', 'time', 'datetime-local', 'month', 'week', 'checkbox', 'radio', 'range', 'file']) {
        expect(textEntryHost(add(Object.assign(document.createElement('input'), { type: t }))), t).toBeNull()
      }
      expect(textEntryHost(add(document.createElement('select')))).toBeNull()
    })

    describe('through the real workbench', () => {
      const fire = (el: EventTarget, init: KeyboardEventInit) => {
        gridMock.undo.mockClear()
        gridMock.redo.mockClear()
        const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
        el.dispatchEvent(event)
        return { prevented: event.defaultPrevented, undo: gridMock.undo.mock.calls.length, redo: gridMock.redo.mock.calls.length }
      }
      const typeInto = (el: HTMLInputElement, next: string) => {
        el.dispatchEvent(withProps(new InputEvent('beforeinput', { bubbles: true, cancelable: true }), { inputType: 'insertText' }))
        el.value = next
        el.dispatchEvent(withProps(new InputEvent('input', { bubbles: true }), { inputType: 'insertText' }))
      }

      it('installed on mount: typing is undone with no grid call, and then the chord does nothing; non-text targets and the page itself run the grid\'s; outside the workbench nothing runs; a control that stops propagation cannot get past it; removed on unmount', async () => {
        mountWorkbench()
        await flushUi()
        const root = container!.querySelector('.mt-workbench') as HTMLElement
        const add = <T extends HTMLElement>(el: T, where: HTMLElement = root): T => { where.appendChild(el); made.push(el); return el }
        const text = add(Object.assign(document.createElement('input'), { type: 'text' }))
        const date = add(Object.assign(document.createElement('input'), { type: 'date' }))
        const select = add(document.createElement('select'))
        const stopper = add(document.createElement('button'))
        stopper.addEventListener('keydown', (event) => event.stopPropagation())
        const outsideText = add(Object.assign(document.createElement('input'), { type: 'text' }), document.body)
        const main = container!.querySelector('.mt-workbench__main') as HTMLElement
        text.focus()
        typeInto(text, 'typed')
        expect(fire(text, { key: 'z', metaKey: true })).toEqual({ prevented: true, undo: 0, redo: 0 })
        expect(text.value).toBe('')
        expect(fire(text, { key: 'z', metaKey: true })).toEqual({ prevented: true, undo: 0, redo: 0 })
        expect(fire(text, { key: 'Z', metaKey: true, shiftKey: true })).toEqual({ prevented: true, undo: 0, redo: 0 })
        expect(text.value).toBe('typed')
        expect(fire(text, { key: 'y', ctrlKey: true })).toEqual({ prevented: true, undo: 0, redo: 0 })
        expect(fire(text, { key: 'z', metaKey: true, isComposing: true })).toEqual({ prevented: true, undo: 0, redo: 0 })
        for (const el of [date, select, main, stopper]) {
          expect(fire(el, { key: 'z', metaKey: true }), (el as HTMLElement).tagName).toEqual({ prevented: true, undo: 1, redo: 0 })
          expect(fire(el, { key: 'Z', metaKey: true, shiftKey: true })).toEqual({ prevented: true, undo: 0, redo: 1 })
        }
        expect(fire(outsideText, { key: 'z', metaKey: true })).toEqual({ prevented: true, undo: 0, redo: 0 })
        // the page itself: the grid's only after a press or focus on the grid (.meta-grid) or the drawer's
        // fields (.meta-record-drawer__fields); after the last focus was a non-grid control (here the text
        // box) or an overlay, nothing
        expect(fire(document.body, { key: 'z', metaKey: true })).toEqual({ prevented: true, undo: 0, redo: 0 })
        const gridSurface = add(Object.assign(document.createElement('div'), { className: 'meta-grid' }))
        const drawerSurface = add(Object.assign(document.createElement('div'), { className: 'meta-record-drawer__fields' }))
        gridSurface.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
        expect(fire(document.body, { key: 'z', metaKey: true })).toEqual({ prevented: true, undo: 1, redo: 0 })
        outsideText.focus()
        expect(fire(document.body, { key: 'z', metaKey: true })).toEqual({ prevented: true, undo: 0, redo: 0 })
        drawerSurface.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
        expect(fire(document.body, { key: 'Z', metaKey: true, shiftKey: true })).toEqual({ prevented: true, undo: 0, redo: 1 })
        main.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
        expect(fire(document.body, { key: 'z', metaKey: true })).toEqual({ prevented: true, undo: 0, redo: 0 })
        app!.unmount()
        app = null
        expect(fire(document.body, { key: 'z', metaKey: true })).toEqual({ prevented: false, undo: 0, redo: 0 })
      })

      async function openDrawerWithTitle() {
        mountWorkbench()
        await flushUi()
        container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_1"]')!.click()
        await flushUi()
        const drawer = container!.querySelector('[data-record-drawer="rec_1"]') as HTMLElement
        expect(drawer).toBeTruthy()
        // fld_title is the primary field: its commit covers the title input (a stand-in here: the stub
        // drawer has none; the real title is covered in multitable-record-inspector-header.spec.ts)
        const title = Object.assign(document.createElement('input'), { type: 'text', className: 'meta-record-drawer__title-input' })
        drawer.appendChild(title)
        made.push(title)
        title.focus()
        return { drawer, title }
      }
      const clickPatch = () => container!.querySelector<HTMLButtonElement>('[data-patch-record="fld_title"]')!.click()

      it('Cmd+Z with the focus on a drawer tab panel itself does nothing; on a button in the drawer the grid\'s undo runs, as before', async () => {
        await openDrawerWithTitle()
        const panel = container!.querySelector<HTMLElement>('[data-stub-tabpanel]')!
        panel.focus()
        expect(fire(panel, { key: 'z', metaKey: true })).toEqual({ prevented: true, undo: 0, redo: 0 })
        const button = container!.querySelector<HTMLButtonElement>('[data-navigate-record="rec_1"]')!
        button.focus()
        expect(fire(button, { key: 'z', metaKey: true })).toEqual({ prevented: true, undo: 1, redo: 0 })
      })

      it('wiring: a drawer commit the server accepted ends the field\'s history (the title, via the primary field); a rejected one is never settled', async () => {
        const { title } = await openDrawerWithTitle()
        typeInto(title, 'Renamed')
        clickPatch()
        await flushUi()
        expect(gridMock.patchCell).toHaveBeenCalledWith('rec_1', 'fld_title', 'Patched title', 1, ROW_SAVE)
        title.focus()
        expect(fire(title, { key: 'z', metaKey: true })).toEqual({ prevented: true, undo: 0, redo: 0 })
        expect(title.value).toBe('Renamed')
        gridMock.patchCell.mockImplementation(async (_recordId: string, fieldId: string) => {
          gridMock.error.value = 'Server said no'
          return { recordId: 'rec_1', fieldId, attemptedValue: 'Patched title', message: 'Server said no', status: 500 }
        })
        typeInto(title, 'Renamed again')
        clickPatch()
        await flushUi()
        title.focus()
        expect(fire(title, { key: 'z', metaKey: true })).toEqual({ prevented: true, undo: 0, redo: 0 })
        expect(title.value).toBe('Renamed')
        gridMock.error.value = null
      })

      it('wiring: the commit is marked when the patch starts, so typing while it is in flight stays undoable once it is accepted', async () => {
        const { title } = await openDrawerWithTitle()
        let accept: (value: null) => void = () => {}
        gridMock.patchCell.mockImplementation(() => new Promise((resolve) => { accept = resolve }))
        typeInto(title, 'Renamed')
        clickPatch()
        await flushUi()
        typeInto(title, 'Renamed and more') // straight on, while the patch is in flight
        accept(null)
        await flushUi()
        title.focus()
        expect(fire(title, { key: 'z', metaKey: true })).toEqual({ prevented: true, undo: 0, redo: 0 })
        expect(title.value).toBe('Renamed')
        expect(fire(title, { key: 'z', metaKey: true })).toEqual({ prevented: true, undo: 0, redo: 0 })
        expect(title.value).toBe('Renamed')
      })

      it('the drawer showing another record drops its controls\' histories: equal content in both records never brings record A\'s typing into record B', async () => {
        const { drawer } = await openDrawerWithTitle()
        const notes = document.createElement('textarea')
        drawer.appendChild(notes)
        made.push(notes)
        notes.focus()
        typeInto(notes as unknown as HTMLInputElement, 'text meant for A')
        notes.dispatchEvent(withProps(new InputEvent('beforeinput', { bubbles: true, cancelable: true }), { inputType: 'deleteContentBackward' }))
        notes.value = ''
        notes.dispatchEvent(withProps(new InputEvent('input', { bubbles: true }), { inputType: 'deleteContentBackward' }))
        container!.querySelector<HTMLButtonElement>('[data-expand-record="rec_2"]')!.click()
        await flushUi()
        // the stand-in control is kept across the switch, as the real reused drawer controls are
        if (!notes.isConnected) document.body.appendChild(notes)
        notes.focus()
        expect(fire(notes, { key: 'z', metaKey: true })).toEqual({ prevented: true, undo: 0, redo: 0 })
        expect(notes.value).toBe('')
        expect(fire(notes, { key: 'Z', metaKey: true, shiftKey: true })).toEqual({ prevented: true, undo: 0, redo: 0 })
        expect(notes.value).toBe('')
      })

      it('a view change drops the controls\' histories too (a view\'s inputs are reused across views)', async () => {
        mountWorkbench()
        await flushUi()
        const root = container!.querySelector('.mt-workbench') as HTMLElement
        const field = document.createElement('input')
        root.appendChild(field)
        made.push(field)
        field.focus()
        typeInto(field, 'typed in view 1')
        field.dispatchEvent(withProps(new InputEvent('beforeinput', { bubbles: true, cancelable: true }), { inputType: 'deleteContentBackward' }))
        field.value = ''
        field.dispatchEvent(withProps(new InputEvent('input', { bubbles: true }), { inputType: 'deleteContentBackward' }))
        workbenchMock.activeViewId.value = 'view_gallery'
        await flushUi()
        if (!field.isConnected) root.appendChild(field)
        field.focus()
        expect(fire(field, { key: 'z', metaKey: true })).toEqual({ prevented: true, undo: 0, redo: 0 })
        expect(field.value).toBe('')
      })

      it('a rename outside the grid surfaces (its input goes away, focus falls to the page): Cmd+Z does nothing, never the grid', async () => {
        mountWorkbench()
        await flushUi()
        const root = container!.querySelector('.mt-workbench') as HTMLElement
        const rename = document.createElement('input')
        root.appendChild(rename)
        rename.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
        rename.focus()
        typeInto(rename, 'Sheet renamed')
        rename.remove() // Enter: the rename commits and its input unmounts
        expect(document.activeElement).toBe(document.body)
        expect(fire(document.body, { key: 'z', metaKey: true })).toEqual({ prevented: true, undo: 0, redo: 0 })
        expect(fire(document.body, { key: 'Z', metaKey: true, shiftKey: true })).toEqual({ prevented: true, undo: 0, redo: 0 })
      })

      it('a press on what is not a cell edit, in the grid or the drawer (Delete selected, the footer; a comment sent, resolved or deleted; an upload), whose control then goes away: Cmd+Z on the page does nothing, never the grid', async () => {
        mountWorkbench()
        await flushUi()
        const root = container!.querySelector('.mt-workbench') as HTMLElement
        const add = (html: string) => {
          const el = document.createElement('div')
          el.innerHTML = html
          root.appendChild(el)
          made.push(el)
          return el
        }
        const grid = add('<div class="meta-grid" tabindex="0"><div class="meta-grid__bulk-bar"><button>Delete selected</button></div><div class="meta-grid__foot"><select></select></div></div>')
        const drawer = add('<div class="meta-record-drawer"><div role="tabpanel"><textarea></textarea><button>Send</button><button>Resolve</button></div><div class="meta-record-drawer__fields"><input type="file"></div></div>')
        const press = (el: HTMLElement) => {
          grid.querySelector<HTMLElement>('.meta-grid')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
          el.focus()
          el.remove() // disabled or unmounted once pressed: focus falls to the page
          expect(document.activeElement).toBe(document.body)
        }
        const [send, resolve] = Array.from(drawer.querySelectorAll('button'))
        // (the footer's aggregation select goes when its last aggregation is removed; the file input is
        // disabled for the whole upload, whose patch comes only once it ends)
        for (const el of [grid.querySelector('button')!, grid.querySelector('select')!, send, resolve, drawer.querySelector('textarea')!, drawer.querySelector<HTMLElement>('input[type="file"]')!]) {
          press(el)
          expect(fire(document.body, { key: 'z', metaKey: true }), el.textContent || el.tagName).toEqual({ prevented: true, undo: 0, redo: 0 })
          expect(fire(document.body, { key: 'Z', metaKey: true, shiftKey: true })).toEqual({ prevented: true, undo: 0, redo: 0 })
        }
      })
      it('an attachment upload or delete holds the grid\'s undo and redo until it settles, also when it fails (its patch comes only once it is done)', async () => {
        mountWorkbench()
        await flushUi()
        const held = () => gridOptions.holdsHistory()
        expect(typeof inspectorStubSeen.uploadFn).toBe('function')
        expect(typeof inspectorStubSeen.deleteAttachmentFn).toBe('function')
        expect(held()).toBe(false)
        const context = { recordId: 'rec_1', fieldId: 'fld_files' }
        // upload: held while the request is out; released when it lands
        const upload = createDeferred<unknown>()
        workbenchMock.client.uploadAttachment = vi.fn(() => upload.promise)
        const uploading = inspectorStubSeen.uploadFn!(new File(['x'], 'a.txt'), context)
        expect(held()).toBe(true)
        upload.resolve({ id: 'att_1' })
        await expect(uploading).resolves.toEqual({ id: 'att_1' })
        expect(held()).toBe(false)
        // an upload that fails releases it too
        const failing = createDeferred<unknown>()
        workbenchMock.client.uploadAttachment = vi.fn(() => failing.promise)
        const failed = inspectorStubSeen.uploadFn!(new File(['x'], 'b.txt'), context)
        expect(held()).toBe(true)
        failing.reject(new Error('upload failed'))
        await expect(failed).rejects.toThrow('upload failed')
        expect(held()).toBe(false)
        // two at once: held until both are done
        const first = createDeferred<unknown>()
        const second = createDeferred<unknown>()
        workbenchMock.client.uploadAttachment = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
        const one = inspectorStubSeen.uploadFn!(new File(['x'], 'c.txt'), context)
        const two = inspectorStubSeen.uploadFn!(new File(['x'], 'd.txt'), context)
        first.resolve({ id: 'att_c' })
        await one
        expect(held()).toBe(true)
        second.resolve({ id: 'att_d' })
        await two
        expect(held()).toBe(false)
        // delete: held through the request and the reload after it
        const removal = createDeferred<unknown>()
        const reload = createDeferred<void>()
        workbenchMock.client.deleteAttachment = vi.fn(() => removal.promise)
        gridMock.loadViewData = vi.fn(() => reload.promise)
        const deleting = inspectorStubSeen.deleteAttachmentFn!('att_1', context)
        expect(held()).toBe(true)
        removal.resolve({ deleted: 'att_1' })
        await flushUi()
        expect(gridMock.loadViewData).toHaveBeenCalledTimes(1)
        expect(held()).toBe(true)
        reload.resolve()
        await deleting
        expect(held()).toBe(false)
        // a delete that fails releases it too
        workbenchMock.client.deleteAttachment = vi.fn(() => Promise.reject(new Error('delete failed')))
        await expect(inspectorStubSeen.deleteAttachmentFn!('att_2', context)).rejects.toThrow('delete failed')
        expect(held()).toBe(false)
      })

      it('wiring: a local refusal (the row cannot be edited; no server answer) is not a commit: the typing stays undoable', async () => {
        const { title } = await openDrawerWithTitle()
        gridMock.patchCell.mockImplementation(async () => {
          gridMock.error.value = 'Not editable'
          return null
        })
        typeInto(title, 'Renamed')
        clickPatch()
        await flushUi()
        title.focus()
        expect(fire(title, { key: 'z', metaKey: true })).toEqual({ prevented: true, undo: 0, redo: 0 })
        expect(title.value).toBe('')
        gridMock.error.value = null
      })

      // A patch that names a record the drawer no longer shows (an attachment write that ended after a switch)
      // is not a commit of the controls now on screen: the typing on the record shown stays undoable. The
      // patch of the record shown (no record named, or the shown one named) still ends it.
      it.each([
        ['names rec_1, no longer shown', '[data-patch-record-for="rec_1"]', ['rec_1', 'fld_title', 'Stale title', 1], ''],
        ['names no record (the one shown)', '[data-patch-record="fld_title"]', ['rec_2', 'fld_title', 'Patched title', 1], 'typed on B'],
        ['names rec_2, the one shown', '[data-patch-record-for="rec_2"]', ['rec_2', 'fld_title', 'Named title', 1], 'typed on B'],
      ])('wiring: after a switch to rec_2, an accepted title patch that %s', async (_label, button, call, afterUndo) => {
        const { title } = await openDrawerWithTitle()
        container!.querySelector<HTMLButtonElement>('[data-navigate-record="rec_2"]')!.click()
        await flushUi()
        const drawer = container!.querySelector('[data-record-drawer="rec_2"]') as HTMLElement
        expect(drawer).toBeTruthy()
        // the stand-in control is kept across the switch, as the real reused title input is (inside the drawer)
        if (!title.isConnected) drawer.appendChild(title)
        title.focus()
        typeInto(title, 'typed on B') // after the switch, which drops every history
        container!.querySelector<HTMLButtonElement>(button)!.click()
        await flushUi()
        expect(gridMock.patchCell).toHaveBeenCalledTimes(1)
        expect(gridMock.patchCell).toHaveBeenCalledWith(...call, ROW_SAVE)
        title.focus()
        expect(fire(title, { key: 'z', metaKey: true })).toEqual({ prevented: true, undo: 0, redo: 0 })
        expect(title.value).toBe(afterUndo)
      })
    })
  })
})
