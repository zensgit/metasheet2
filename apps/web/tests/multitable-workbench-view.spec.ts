import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, reactive, ref, type App as VueApp, type Component } from 'vue'

const showErrorSpy = vi.fn()
const showSuccessSpy = vi.fn()
const pushSpy = vi.fn().mockResolvedValue(undefined)
const useMultitableSheetRealtimeMock = vi.fn()
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
  useMultitableComments: () => ({
    comments: ref([]),
    loading: ref(false),
    submitting: ref(false),
    resolvingIds: ref<string[]>([]),
    updatingIds: ref<string[]>([]),
    deletingIds: ref<string[]>([]),
    error: ref<string | null>(null),
    loadComments: loadCommentsSpy,
    addComment: addCommentSpy,
    updateComment: vi.fn(),
    deleteComment: vi.fn(),
    resolveComment: resolveCommentSpy,
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

vi.mock('../src/multitable/components/MetaViewTabBar.vue', () => ({
  default: defineComponent({
    name: 'MetaViewTabBar',
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
    },
    emits: ['import', 'export-csv'],
    render() {
      const fieldIds = (this.$props.fields as Array<{ id?: string }>)
        .map((field) => field.id ?? '')
        .filter((fieldId) => fieldId.length > 0)
        .join(',')
      return h(
        'div',
        { 'data-toolbar-field-ids': fieldIds },
        [
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
        ],
      )
    },
  }),
}))
vi.mock('../src/multitable/components/MetaGridTable.vue', () => ({
  default: defineComponent({
    name: 'MetaGridTable',
    emits: ['select-record', 'open-comments', 'open-field-comments'],
    render() {
      return h('div', [
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
            'data-open-comments': 'rec_1',
            onClick: () => this.$emit('open-comments', 'rec_1'),
          },
          'open-comments',
        ),
        h(
          'button',
          {
            'data-open-field-comments': 'rec_1/fld_title',
            onClick: () => this.$emit('open-field-comments', { recordId: 'rec_1', fieldId: 'fld_title' }),
          },
          'open-field-comments',
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
vi.mock('../src/multitable/components/MetaRecordDrawer.vue', () => ({
  default: defineComponent({
    name: 'MetaRecordDrawer',
    props: {
      visible: { type: Boolean, default: false },
      record: { type: Object, default: null },
    },
    emits: ['close', 'toggle-comments', 'comment-field', 'navigate', 'delete', 'patch'],
    render() {
      if (!this.$props.visible) return null
      const recordId = (this.$props.record as { id?: string } | null)?.id ?? ''
      return h('div', { 'data-record-drawer': recordId }, [
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
      ])
    },
  }),
}))
vi.mock('../src/multitable/components/MetaCommentsDrawer.vue', () => ({
  default: defineComponent({
    name: 'MetaCommentsDrawer',
    props: {
      visible: { type: Boolean, default: false },
      targetFieldId: { type: String, default: null },
      mentionSuggestions: { type: Array, default: () => [] },
    },
    emits: ['close', 'submit', 'reply', 'cancel-reply', 'update:draft'],
    render() {
      if (!this.$props.visible) return null
      return h('div', {
        'data-current-comment-field': this.$props.targetFieldId ?? '',
        'data-mention-suggestions-count': String((this.$props.mentionSuggestions as unknown[]).length),
      }, [
        h(
          'button',
          {
            'data-set-comment-draft': 'true',
            onClick: () => this.$emit('update:draft', 'Need review'),
          },
          'set-comment-draft',
        ),
        h(
          'button',
          {
            'data-submit-comment': 'true',
            onClick: () => this.$emit('submit', { content: 'Need review', mentions: [] }),
          },
          'submit-comment',
        ),
        h(
          'button',
          {
            'data-reply-comment': 'comment_parent_1',
            onClick: () => this.$emit('reply', 'comment_parent_1'),
          },
          'reply-comment',
        ),
        h(
          'button',
          {
            'data-cancel-reply': 'true',
            onClick: () => this.$emit('cancel-reply'),
          },
          'cancel-reply',
        ),
        h(
          'button',
          {
            'data-close-comments': 'true',
            onClick: () => this.$emit('close'),
          },
          'close-comments',
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
    },
    emits: ['create-field', 'update:dirty'],
    render() {
      const fieldIds = (this.$props.fields as Array<{ id?: string }>)
        .map((field) => field.id ?? '')
        .filter((fieldId) => fieldId.length > 0)
        .join(',')
      return h(
        'div',
        { 'data-field-manager-field-ids': fieldIds },
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
      activeBaseId: { type: String, default: '' },
      canCreate: { type: Boolean, default: false },
    },
    emits: ['select', 'create'],
    render() {
      return h('div', [
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

async function flushUi(cycles = 5): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
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
      createSheet: vi.fn(),
      createBase: vi.fn(),
      createField: vi.fn(),
      preparePersonField: vi.fn(),
      updateField: vi.fn(),
      deleteField: vi.fn(),
      createView: vi.fn(),
      updateView: vi.fn(),
      deleteView: vi.fn(),
      listSheetPermissions: vi.fn().mockResolvedValue({ items: [] }),
      listSheetPermissionCandidates: vi.fn().mockResolvedValue({ items: [] }),
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
    canUndo: ref(false),
    canRedo: ref(false),
    groupFieldId: ref<string | null>(null),
    groupField: ref(null),
    hiddenFieldIds: ref<string[]>([]),
    columnWidths: ref<Record<string, number>>({}),
    linkSummaries: ref<Record<string, Record<string, unknown[]>>>({}),
    attachmentSummaries: ref<Record<string, Record<string, unknown[]>>>({}),
    fieldPermissions: ref({}),
    viewPermission: ref(null),
    capabilityOrigin: ref(null),
    rowActions: ref(null),
    rowActionOverrides: ref<Record<string, { canEdit: boolean; canDelete: boolean; canComment: boolean }>>({}),
    conflict: ref(null),
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
    setGroupField: vi.fn(),
    goToPage: vi.fn(),
    patchCell: vi.fn(),
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
    loadCommentsSpy = vi.fn()
    addCommentSpy = vi.fn()
    resolveCommentSpy = vi.fn()
    mentionInboxSummaryMock = null
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
    vi.clearAllMocks()
  })

  function mountWorkbench(initialProps?: { baseId?: string; sheetId?: string; viewId?: string; recordId?: string; commentId?: string; fieldId?: string; openComments?: boolean }) {
    let hostState!: { baseId?: string; sheetId?: string; viewId?: string; recordId?: string; commentId?: string; fieldId?: string; openComments?: boolean }
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
    expect(showSuccessSpy).toHaveBeenCalledWith('2 record(s) imported')
  })

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

    let exportedBlob: Blob | null = null
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const createObjectURLMock = vi.fn((blob: Blob | MediaSource) => {
      exportedBlob = blob as Blob
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

      expect(createObjectURLMock).toHaveBeenCalledTimes(1)
      const csv = exportedBlob
        ? await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result ?? ''))
          reader.onerror = () => reject(reader.error)
          reader.readAsText(exportedBlob as Blob)
        })
        : ''
      expect(csv).toContain('Title')
      expect(csv).not.toContain('View Hidden')
      expect(csv).not.toContain('Hidden value')
      expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:multitable-export')
    } finally {
      clickSpy.mockRestore()
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
    }
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
    expect(showSuccessSpy).toHaveBeenCalledWith('Loaded the latest row state')

    ;(container?.querySelector('.mt-workbench__conflict-btn--primary') as HTMLButtonElement | null)?.click()
    await flushUi()
    expect(gridMock.retryConflict).toHaveBeenCalledTimes(1)
    expect(showSuccessSpy).toHaveBeenLastCalledWith('Change reapplied')

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

  it('maps person field creation through the prepared link preset', async () => {
    mountWorkbench()
    await flushUi()

    workbenchMock.client.preparePersonField.mockResolvedValue({
      targetSheet: { id: 'sheet_people', baseId: 'base_ops', name: 'People' },
      fieldProperty: {
        foreignSheetId: 'sheet_people',
        limitSingleRecord: true,
        refKind: 'user',
      },
    })

    container!.querySelector<HTMLButtonElement>('[data-create-person-field="true"]')!.click()
    await flushUi()

    expect(workbenchMock.client.preparePersonField).toHaveBeenCalledWith('sheet_orders')
    expect(workbenchMock.client.createField).toHaveBeenCalledWith({
      sheetId: 'sheet_orders',
      name: 'Owner',
      type: 'link',
      property: {
        foreignSheetId: 'sheet_people',
        limitSingleRecord: true,
        refKind: 'user',
      },
    })
  })

  it('merges person field manager property overrides into the prepared link preset', async () => {
    mountWorkbench()
    await flushUi()

    workbenchMock.client.preparePersonField.mockResolvedValue({
      targetSheet: { id: 'sheet_people', baseId: 'base_ops', name: 'People' },
      fieldProperty: {
        foreignSheetId: 'sheet_people',
        limitSingleRecord: true,
        refKind: 'user',
      },
    })

    container!.querySelector<HTMLButtonElement>('[data-create-person-field-multi="true"]')!.click()
    await flushUi()

    expect(workbenchMock.client.createField).toHaveBeenCalledWith({
      sheetId: 'sheet_orders',
      name: 'Approvers',
      type: 'link',
      property: {
        foreignSheetId: 'sheet_people',
        limitSingleRecord: false,
        refKind: 'user',
      },
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

  it('passes scoped row edit gating into kanban and timeline views', async () => {
    workbenchMock.views.value = [
      { id: 'view_kanban', sheetId: 'sheet_orders', name: 'Kanban', type: 'kanban' },
      { id: 'view_timeline', sheetId: 'sheet_orders', name: 'Timeline', type: 'timeline', config: { zoom: 'week' } },
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
    expect(showSuccessSpy).toHaveBeenCalledWith('Timeline updated')
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

    container!.querySelector<HTMLButtonElement>('[data-select-record="rec_1"]')!.click()
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

  it('prompts before closing the comments drawer when a comment draft exists', async () => {
    mountWorkbench()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-select-record="rec_1"]')!.click()
    await flushUi()
    container!.querySelector<HTMLButtonElement>('[data-toggle-comments="true"]')!.click()
    await flushUi()
    container!.querySelector<HTMLButtonElement>('[data-set-comment-draft="true"]')!.click()
    await flushUi()

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    container!.querySelector<HTMLButtonElement>('[data-close-comments="true"]')!.click()
    await flushUi()

    expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved comment draft?')
    expect(container!.querySelector('[data-close-comments="true"]')).toBeTruthy()
  })

  it('prompts before closing the record drawer when record-scoped drafts are present', async () => {
    mountWorkbench()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-select-record="rec_1"]')!.click()
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
})
