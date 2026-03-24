import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { usePlmTeamViews } from '../src/views/plm/usePlmTeamViews'
import {
  archivePlmWorkbenchTeamView,
  batchPlmWorkbenchTeamViews,
  restorePlmWorkbenchTeamView,
  clearPlmWorkbenchTeamViewDefault,
  duplicatePlmWorkbenchTeamView,
  deletePlmWorkbenchTeamView,
  listPlmWorkbenchTeamViews,
  renamePlmWorkbenchTeamView,
  savePlmWorkbenchTeamView,
  setPlmWorkbenchTeamViewDefault,
  transferPlmWorkbenchTeamView,
} from '../src/services/plm/plmWorkbenchClient'

vi.mock('../src/services/plm/plmWorkbenchClient', () => ({
  archivePlmWorkbenchTeamView: vi.fn(),
  batchPlmWorkbenchTeamViews: vi.fn(),
  restorePlmWorkbenchTeamView: vi.fn(),
  listPlmWorkbenchTeamViews: vi.fn(),
  savePlmWorkbenchTeamView: vi.fn(),
  duplicatePlmWorkbenchTeamView: vi.fn(),
  deletePlmWorkbenchTeamView: vi.fn(),
  renamePlmWorkbenchTeamView: vi.fn(),
  setPlmWorkbenchTeamViewDefault: vi.fn(),
  clearPlmWorkbenchTeamViewDefault: vi.fn(),
  transferPlmWorkbenchTeamView: vi.fn(),
}))

describe('usePlmTeamViews', () => {
  const setMessage = vi.fn()
  const applyViewState = vi.fn()

  beforeEach(() => {
    vi.mocked(archivePlmWorkbenchTeamView).mockReset()
    vi.mocked(batchPlmWorkbenchTeamViews).mockReset()
    vi.mocked(restorePlmWorkbenchTeamView).mockReset()
    vi.mocked(listPlmWorkbenchTeamViews).mockReset()
    vi.mocked(savePlmWorkbenchTeamView).mockReset()
    vi.mocked(duplicatePlmWorkbenchTeamView).mockReset()
    vi.mocked(deletePlmWorkbenchTeamView).mockReset()
    vi.mocked(renamePlmWorkbenchTeamView).mockReset()
    vi.mocked(setPlmWorkbenchTeamViewDefault).mockReset()
    vi.mocked(clearPlmWorkbenchTeamViewDefault).mockReset()
    vi.mocked(transferPlmWorkbenchTeamView).mockReset()
    setMessage.mockReset()
    applyViewState.mockReset()
  })

  it('auto-applies the default documents team view on first refresh', async () => {
    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [
        {
          id: 'view-1',
          kind: 'documents',
          scope: 'team',
          name: '共享文档视角',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: true,
          state: {
            role: 'primary',
            filter: 'gear',
            sortKey: 'updated',
            sortDir: 'desc',
            columns: { mime: true },
          },
        },
      ],
    })

    const model = usePlmTeamViews({
      kind: 'documents',
      label: '文档',
      getCurrentViewState: () => ({
        role: '',
        filter: '',
        sortKey: 'updated',
        sortDir: 'desc',
        columns: {},
      }),
      applyViewState,
      setMessage,
      shouldAutoApplyDefault: () => true,
    })

    await model.refreshTeamViews()

    expect(applyViewState).toHaveBeenCalledWith({
      role: 'primary',
      filter: 'gear',
      sortKey: 'updated',
      sortDir: 'desc',
      columns: { mime: true },
    })
    expect(model.teamViewKey.value).toBe('view-1')
    expect(model.defaultTeamViewLabel.value).toBe('共享文档视角')
  })

  it('applies an explicitly requested team view before falling back to default', async () => {
    const requestedViewId = ref('view-explicit')
    const syncRequestedViewId = vi.fn()

    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [
        {
          id: 'view-default',
          kind: 'documents',
          scope: 'team',
          name: '默认文档视角',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: true,
          state: {
            role: 'secondary',
            filter: 'motor',
            sortKey: 'updated',
            sortDir: 'desc',
            columns: { mime: true },
          },
        },
        {
          id: 'view-explicit',
          kind: 'documents',
          scope: 'team',
          name: '显式文档视角',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: {
            role: 'primary',
            filter: 'gear',
            sortKey: 'name',
            sortDir: 'asc',
            columns: { role: true },
          },
        },
      ],
    })

    const model = usePlmTeamViews({
      kind: 'documents',
      label: '文档',
      getCurrentViewState: () => ({
        role: '',
        filter: '',
        sortKey: 'updated',
        sortDir: 'desc',
        columns: {},
      }),
      applyViewState,
      setMessage,
      shouldAutoApplyDefault: () => true,
      requestedViewId,
      syncRequestedViewId,
    })

    await model.refreshTeamViews()

    expect(applyViewState).toHaveBeenCalledWith({
      role: 'primary',
      filter: 'gear',
      sortKey: 'name',
      sortDir: 'asc',
      columns: { role: true },
    })
    expect(model.teamViewKey.value).toBe('view-explicit')
    expect(syncRequestedViewId).toHaveBeenCalledWith('view-explicit')
  })

  it('falls back to an applyable default when the requested team view cannot be applied', async () => {
    const requestedViewId = ref('view-explicit')
    const syncRequestedViewId = vi.fn((value?: string) => {
      requestedViewId.value = value || ''
    })

    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [
        {
          id: 'view-default',
          kind: 'documents',
          scope: 'team',
          name: '默认文档视角',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: true,
          state: {
            role: 'secondary',
            filter: 'motor',
            sortKey: 'updated',
            sortDir: 'desc',
            columns: { mime: true },
          },
        },
        {
          id: 'view-explicit',
          kind: 'documents',
          scope: 'team',
          name: '只读显式视角',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          permissions: {
            canApply: false,
          },
          state: {
            role: 'primary',
            filter: 'gear',
            sortKey: 'name',
            sortDir: 'asc',
            columns: { role: true },
          },
        },
      ],
    })

    const model = usePlmTeamViews({
      kind: 'documents',
      label: '文档',
      getCurrentViewState: () => ({
        role: '',
        filter: '',
        sortKey: 'updated',
        sortDir: 'desc',
        columns: {},
      }),
      applyViewState,
      setMessage,
      shouldAutoApplyDefault: () => true,
      requestedViewId,
      syncRequestedViewId,
    })

    await model.refreshTeamViews()

    expect(applyViewState).toHaveBeenCalledWith({
      role: 'secondary',
      filter: 'motor',
      sortKey: 'updated',
      sortDir: 'desc',
      columns: { mime: true },
    })
    expect(model.teamViewKey.value).toBe('view-default')
    expect(requestedViewId.value).toBe('view-default')
    expect(setMessage).toHaveBeenLastCalledWith('已应用文档默认团队视角：默认文档视角')
  })

  it('does not auto-apply a default team view that fails canApply gating', async () => {
    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [
        {
          id: 'view-default',
          kind: 'documents',
          scope: 'team',
          name: '只读默认文档视角',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: true,
          permissions: {
            canApply: false,
          },
          state: {
            role: 'primary',
            filter: 'gear',
            sortKey: 'updated',
            sortDir: 'desc',
            columns: { mime: true },
          },
        },
      ],
    })

    const model = usePlmTeamViews({
      kind: 'documents',
      label: '文档',
      getCurrentViewState: () => ({
        role: '',
        filter: '',
        sortKey: 'updated',
        sortDir: 'desc',
        columns: {},
      }),
      applyViewState,
      setMessage,
      shouldAutoApplyDefault: () => true,
    })

    await model.refreshTeamViews()

    expect(applyViewState).not.toHaveBeenCalled()
    expect(model.teamViewKey.value).toBe('')
    expect(setMessage).not.toHaveBeenCalled()
  })

  it('clears a stale non-applyable selection on refresh before auto-applying the default view', async () => {
    const requestedViewId = ref('')
    const syncRequestedViewId = vi.fn((value?: string) => {
      requestedViewId.value = value || ''
    })
    const workbenchApply = vi.fn(() => requestedViewId.value)
    let autoApplyDefault = false

    vi.mocked(listPlmWorkbenchTeamViews)
      .mockResolvedValueOnce({
        items: [
          {
            id: 'workbench-stale',
            kind: 'workbench',
            scope: 'team',
            name: '旧工作台视角',
            ownerUserId: 'dev-user',
            canManage: true,
            isDefault: false,
            state: {
              query: {
                documentFilter: 'legacy',
              },
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: 'workbench-default',
            kind: 'workbench',
            scope: 'team',
            name: '默认工作台视角',
            ownerUserId: 'dev-user',
            canManage: true,
            isDefault: true,
            state: {
              query: {
                documentFilter: 'default-gear',
              },
            },
          },
          {
            id: 'workbench-stale',
            kind: 'workbench',
            scope: 'team',
            name: '旧工作台视角',
            ownerUserId: 'dev-user',
            canManage: true,
            isDefault: false,
            permissions: {
              canApply: false,
            },
            state: {
              query: {
                documentFilter: 'legacy',
              },
            },
          },
        ],
      })

    const model = usePlmTeamViews({
      kind: 'workbench',
      label: '工作台',
      getCurrentViewState: () => ({
        query: {},
      }),
      applyViewState: workbenchApply,
      setMessage,
      requestedViewId,
      syncRequestedViewId,
      shouldAutoApplyDefault: () => autoApplyDefault,
    })

    await model.refreshTeamViews()
    model.teamViewKey.value = 'workbench-stale'
    requestedViewId.value = 'workbench-stale'
    autoApplyDefault = true
    workbenchApply.mockClear()
    syncRequestedViewId.mockClear()

    await model.refreshTeamViews()

    expect(model.teamViewKey.value).toBe('workbench-default')
    expect(requestedViewId.value).toBe('workbench-default')
    expect(syncRequestedViewId).toHaveBeenLastCalledWith('workbench-default')
    expect(workbenchApply).toHaveBeenCalledWith({
      query: {
        documentFilter: 'default-gear',
      },
    })
    expect(setMessage).toHaveBeenLastCalledWith('已应用工作台默认团队视角：默认工作台视角')
  })

  it('syncs requested workbench view id before applying workbench state', async () => {
    const requestedViewId = ref('')
    const syncRequestedViewId = vi.fn((value?: string) => {
      requestedViewId.value = value || ''
    })
    const workbenchApply = vi.fn(() => requestedViewId.value)

    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [
        {
          id: 'workbench-view-1',
          kind: 'workbench',
          scope: 'team',
          name: '工作台显式视角',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: {
            query: {
              documentFilter: 'gear',
              approvalsFilter: 'eco',
            },
          },
        },
      ],
    })

    const model = usePlmTeamViews({
      kind: 'workbench',
      label: '工作台',
      getCurrentViewState: () => ({
        query: {},
      }),
      applyViewState: workbenchApply,
      setMessage,
      requestedViewId,
      syncRequestedViewId,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamViews()
    model.teamViewKey.value = 'workbench-view-1'
    model.applyTeamView()

    expect(syncRequestedViewId).toHaveBeenCalledWith('workbench-view-1')
    expect(workbenchApply).toHaveReturnedWith('workbench-view-1')
  })

  it('does not apply a team view that fails explicit canApply gating', async () => {
    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [
        {
          id: 'workbench-view-1',
          kind: 'workbench',
          scope: 'team',
          name: '只读工作台视角',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          permissions: {
            canApply: false,
          },
          state: {
            query: {
              documentFilter: 'gear',
            },
          },
        },
      ],
    })

    const model = usePlmTeamViews({
      kind: 'workbench',
      label: '工作台',
      getCurrentViewState: () => ({
        query: {},
      }),
      applyViewState,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamViews()
    model.teamViewKey.value = 'workbench-view-1'
    model.applyTeamView()

    expect(applyViewState).not.toHaveBeenCalled()
    expect(setMessage).toHaveBeenLastCalledWith('请先恢复工作台团队视角，再执行应用。', true)
  })

  it('syncs workbench URL identity after save and set-default actions', async () => {
    const requestedViewId = ref('')
    const syncRequestedViewId = vi.fn((value?: string) => {
      requestedViewId.value = value || ''
    })
    const workbenchApply = vi.fn(() => requestedViewId.value)

    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [],
    })
    vi.mocked(savePlmWorkbenchTeamView).mockResolvedValue({
      id: 'workbench-saved',
      kind: 'workbench',
      scope: 'team',
      name: '我的工作台',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: false,
      state: {
        query: {
          documentFilter: 'gear',
          approvalsFilter: 'eco',
        },
      },
    })
    vi.mocked(setPlmWorkbenchTeamViewDefault).mockResolvedValue({
      id: 'workbench-saved',
      kind: 'workbench',
      scope: 'team',
      name: '我的工作台',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: true,
      state: {
        query: {
          documentFilter: 'gear',
          approvalsFilter: 'eco',
        },
      },
    })

    const model = usePlmTeamViews({
      kind: 'workbench',
      label: '工作台',
      getCurrentViewState: () => ({
        query: {
          documentFilter: 'gear',
          approvalsFilter: 'eco',
        },
      }),
      applyViewState: workbenchApply,
      setMessage,
      requestedViewId,
      syncRequestedViewId,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamViews()
    model.teamViewName.value = '我的工作台'
    await model.saveTeamView()

    expect(savePlmWorkbenchTeamView).toHaveBeenCalledWith('workbench', '我的工作台', {
      query: {
        documentFilter: 'gear',
        approvalsFilter: 'eco',
      },
    })
    expect(model.teamViewKey.value).toBe('workbench-saved')
    expect(syncRequestedViewId).toHaveBeenCalledWith('workbench-saved')
    expect(workbenchApply).toHaveLastReturnedWith('workbench-saved')

    await model.setTeamViewDefault()

    expect(setPlmWorkbenchTeamViewDefault).toHaveBeenCalledWith('workbench', 'workbench-saved')
    expect(model.teamViews.value.find((view) => view.id === 'workbench-saved')?.isDefault).toBe(true)
    expect(syncRequestedViewId).toHaveBeenLastCalledWith('workbench-saved')
    expect(workbenchApply).toHaveLastReturnedWith('workbench-saved')
  })

  it('refreshes, saves, toggles default, applies, and deletes approvals team views', async () => {
    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [
        {
          id: 'view-2',
          kind: 'approvals',
          scope: 'team',
          name: '共享审批视角',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: {
            status: 'pending',
            filter: 'eco',
            comment: '',
            sortKey: 'created',
            sortDir: 'desc',
            columns: { status: true },
          },
        },
      ],
    })
    vi.mocked(savePlmWorkbenchTeamView).mockResolvedValue({
      id: 'view-3',
      kind: 'approvals',
      scope: 'team',
      name: '新审批视角',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: false,
      state: {
        status: 'approved',
        filter: 'gear',
        comment: 'ok',
        sortKey: 'product',
        sortDir: 'asc',
        columns: { product: true },
      },
    })
    vi.mocked(setPlmWorkbenchTeamViewDefault).mockResolvedValue({
      id: 'view-2',
      kind: 'approvals',
      scope: 'team',
      name: '共享审批视角',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: true,
      state: {
        status: 'pending',
        filter: 'eco',
        comment: '',
        sortKey: 'created',
        sortDir: 'desc',
        columns: { status: true },
      },
    })
    vi.mocked(clearPlmWorkbenchTeamViewDefault).mockResolvedValue({
      id: 'view-2',
      kind: 'approvals',
      scope: 'team',
      name: '共享审批视角',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: false,
      state: {
        status: 'pending',
        filter: 'eco',
        comment: '',
        sortKey: 'created',
        sortDir: 'desc',
        columns: { status: true },
      },
    })
    vi.mocked(deletePlmWorkbenchTeamView).mockResolvedValue({
      id: 'view-2',
      message: 'PLM team view deleted successfully',
    })

    const model = usePlmTeamViews({
      kind: 'approvals',
      label: '审批',
      getCurrentViewState: () => ({
        status: 'approved',
        filter: 'gear',
        comment: 'ok',
        sortKey: 'product',
        sortDir: 'asc',
        columns: { product: true },
      }),
      applyViewState,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamViews()
    expect(applyViewState).not.toHaveBeenCalled()
    model.teamViewKey.value = 'view-2'
    model.applyTeamView()

    expect(applyViewState).toHaveBeenCalledWith({
      status: 'pending',
      filter: 'eco',
      comment: '',
      sortKey: 'created',
      sortDir: 'desc',
      columns: { status: true },
    })

    model.teamViewName.value = '新审批视角'
    await model.saveTeamView()
    expect(savePlmWorkbenchTeamView).toHaveBeenCalledWith('approvals', '新审批视角', {
      status: 'approved',
      filter: 'gear',
      comment: 'ok',
      sortKey: 'product',
      sortDir: 'asc',
      columns: { product: true },
    })

    model.teamViewKey.value = 'view-2'
    await model.setTeamViewDefault()
    expect(setPlmWorkbenchTeamViewDefault).toHaveBeenCalledWith('approvals', 'view-2')
    expect(model.teamViews.value.find((view) => view.id === 'view-2')?.isDefault).toBe(true)

    await model.clearTeamViewDefault()
    expect(clearPlmWorkbenchTeamViewDefault).toHaveBeenCalledWith('approvals', 'view-2')
    expect(model.teamViews.value.find((view) => view.id === 'view-2')?.isDefault).toBe(false)

    await model.deleteTeamView()
    expect(deletePlmWorkbenchTeamView).toHaveBeenCalledWith('view-2')
    expect(model.teamViews.value.some((view) => view.id === 'view-2')).toBe(false)
  })

  it('keeps explicit documents team view identity after clearing default', async () => {
    const requestedViewId = ref('document-view-1')
    const syncRequestedViewId = vi.fn((value?: string) => {
      requestedViewId.value = value || ''
    })

    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [
        {
          id: 'document-view-1',
          kind: 'documents',
          scope: 'team',
          name: '共享文档视角',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: true,
          state: {
            role: 'primary',
            filter: 'motor',
            version: 'latest',
            sortKey: 'updatedAt',
            sortDir: 'desc',
            columns: { name: true },
          },
        },
      ],
    })
    vi.mocked(clearPlmWorkbenchTeamViewDefault).mockResolvedValue({
      id: 'document-view-1',
      kind: 'documents',
      scope: 'team',
      name: '共享文档视角',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: false,
      state: {
        role: 'primary',
        filter: 'motor',
        version: 'latest',
        sortKey: 'updatedAt',
        sortDir: 'desc',
        columns: { name: true },
      },
    })

    const model = usePlmTeamViews({
      kind: 'documents',
      label: '文档',
      getCurrentViewState: () => ({
        role: 'secondary',
        filter: 'bearing',
        version: 'all',
        sortKey: 'name',
        sortDir: 'asc',
        columns: { version: true },
      }),
      applyViewState,
      setMessage,
      requestedViewId,
      syncRequestedViewId,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamViews()
    applyViewState.mockClear()
    syncRequestedViewId.mockClear()
    model.teamViewKey.value = 'document-view-1'

    await model.clearTeamViewDefault()

    expect(clearPlmWorkbenchTeamViewDefault).toHaveBeenCalledWith('documents', 'document-view-1')
    expect(syncRequestedViewId).toHaveBeenLastCalledWith('document-view-1')
    expect(requestedViewId.value).toBe('document-view-1')
    expect(model.teamViewKey.value).toBe('document-view-1')
    expect(model.teamViews.value.find((view) => view.id === 'document-view-1')?.isDefault).toBe(false)
    expect(applyViewState).toHaveBeenCalledWith({
      role: 'primary',
      filter: 'motor',
      version: 'latest',
      sortKey: 'updatedAt',
      sortDir: 'desc',
      columns: { name: true },
    })
  })

  it('keeps explicit documents team view identity after setting default', async () => {
    const requestedViewId = ref('document-view-2')
    const syncRequestedViewId = vi.fn((value?: string) => {
      requestedViewId.value = value || ''
    })

    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [
        {
          id: 'document-view-2',
          kind: 'documents',
          scope: 'team',
          name: '共享文档视角',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: {
            role: 'primary',
            filter: 'motor',
            version: 'latest',
            sortKey: 'updatedAt',
            sortDir: 'desc',
            columns: { name: true },
          },
        },
      ],
    })
    vi.mocked(setPlmWorkbenchTeamViewDefault).mockResolvedValue({
      id: 'document-view-2',
      kind: 'documents',
      scope: 'team',
      name: '共享文档视角',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: true,
      state: {
        role: 'primary',
        filter: 'motor',
        version: 'latest',
        sortKey: 'updatedAt',
        sortDir: 'desc',
        columns: { name: true },
      },
    })

    const model = usePlmTeamViews({
      kind: 'documents',
      label: '文档',
      getCurrentViewState: () => ({
        role: 'secondary',
        filter: 'bearing',
        version: 'all',
        sortKey: 'name',
        sortDir: 'asc',
        columns: { version: true },
      }),
      applyViewState,
      setMessage,
      requestedViewId,
      syncRequestedViewId,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamViews()
    applyViewState.mockClear()
    syncRequestedViewId.mockClear()
    model.teamViewKey.value = 'document-view-2'

    await model.setTeamViewDefault()

    expect(setPlmWorkbenchTeamViewDefault).toHaveBeenCalledWith('documents', 'document-view-2')
    expect(syncRequestedViewId).toHaveBeenLastCalledWith('document-view-2')
    expect(requestedViewId.value).toBe('document-view-2')
    expect(model.teamViewKey.value).toBe('document-view-2')
    expect(model.teamViews.value.find((view) => view.id === 'document-view-2')?.isDefault).toBe(true)
    expect(applyViewState).toHaveBeenCalledWith({
      role: 'primary',
      filter: 'motor',
      version: 'latest',
      sortKey: 'updatedAt',
      sortDir: 'desc',
      columns: { name: true },
    })
  })

  it('blocks deleting a non-managed cad team view', async () => {
    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [
        {
          id: 'cad-view',
          kind: 'cad',
          scope: 'team',
          name: '共享 CAD 视角',
          ownerUserId: 'other-user',
          canManage: false,
          isDefault: false,
          state: {
            fileId: 'cad-main',
            otherFileId: '',
            reviewState: '',
            reviewNote: '',
          },
        },
      ],
    })

    const model = usePlmTeamViews({
      kind: 'cad',
      label: 'CAD',
      getCurrentViewState: () => ({
        fileId: '',
        otherFileId: '',
        reviewState: '',
        reviewNote: '',
      }),
      applyViewState,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamViews()
    model.teamViewKey.value = 'cad-view'
    await model.deleteTeamView()

    expect(deletePlmWorkbenchTeamView).not.toHaveBeenCalled()
    expect(setMessage).toHaveBeenCalledWith('仅创建者可删除CAD团队视角。', true)
  })

  it('duplicates any visible workbench view and renames the owned copy', async () => {
    const requestedViewId = ref('')
    const syncRequestedViewId = vi.fn((value?: string) => {
      requestedViewId.value = value || ''
    })
    const workbenchApply = vi.fn(() => requestedViewId.value)

    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [
        {
          id: 'workbench-shared',
          kind: 'workbench',
          scope: 'team',
          name: '共享工作台',
          ownerUserId: 'other-user',
          canManage: false,
          isDefault: false,
          state: {
            query: {
              documentFilter: 'gear',
            },
          },
        },
      ],
    })
    vi.mocked(duplicatePlmWorkbenchTeamView).mockResolvedValue({
      id: 'workbench-copy',
      kind: 'workbench',
      scope: 'team',
      name: '共享工作台（副本）',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: false,
      state: {
        query: {
          documentFilter: 'gear',
        },
      },
    })
    vi.mocked(renamePlmWorkbenchTeamView).mockResolvedValue({
      id: 'workbench-copy',
      kind: 'workbench',
      scope: 'team',
      name: '我的工作台',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: false,
      state: {
        query: {
          documentFilter: 'gear',
        },
      },
    })

    const model = usePlmTeamViews({
      kind: 'workbench',
      label: '工作台',
      getCurrentViewState: () => ({
        query: {},
      }),
      applyViewState: workbenchApply,
      setMessage,
      shouldAutoApplyDefault: () => false,
      requestedViewId,
      syncRequestedViewId,
    })

    await model.refreshTeamViews()
    model.teamViewKey.value = 'workbench-shared'
    await model.duplicateTeamView()

    expect(duplicatePlmWorkbenchTeamView).toHaveBeenCalledWith('workbench', 'workbench-shared', undefined)
    expect(model.teamViewKey.value).toBe('workbench-copy')
    expect(syncRequestedViewId).toHaveBeenCalledWith('workbench-copy')
    expect(workbenchApply).toHaveLastReturnedWith('workbench-copy')
    expect(model.canRenameTeamView.value).toBe(false)

    model.teamViewName.value = '我的工作台'
    await model.renameTeamView()

    expect(renamePlmWorkbenchTeamView).toHaveBeenCalledWith('workbench', 'workbench-copy', '我的工作台')
    expect(model.teamViews.value.find((view) => view.id === 'workbench-copy')?.name).toBe('我的工作台')
    expect(syncRequestedViewId).toHaveBeenLastCalledWith('workbench-copy')
    expect(workbenchApply).toHaveLastReturnedWith('workbench-copy')
  })

  it('blocks sharing and transfer for readonly workbench views when permissions override legacy flags', async () => {
    const buildShareUrl = vi.fn(() => 'http://example.test/plm?workbenchTeamView=workbench-readonly')
    const copyShareUrl = vi.fn().mockResolvedValue(true)

    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [
        {
          id: 'workbench-readonly',
          kind: 'workbench',
          scope: 'team',
          name: '只读工作台视角',
          ownerUserId: 'owner-2',
          canManage: true,
          isDefault: false,
          permissions: {
            canManage: false,
            canApply: true,
            canDuplicate: true,
            canShare: false,
            canDelete: false,
            canArchive: false,
            canRestore: false,
            canRename: false,
            canTransfer: false,
            canSetDefault: false,
            canClearDefault: false,
          },
          state: {
            query: {
              documentFilter: 'readonly-doc',
              approvalsFilter: 'readonly-eco',
            },
          },
        },
      ],
    })

    const model = usePlmTeamViews({
      kind: 'workbench',
      label: '工作台',
      getCurrentViewState: () => ({
        query: {},
      }),
      applyViewState,
      setMessage,
      shouldAutoApplyDefault: () => false,
      buildShareUrl,
      copyShareUrl,
    })

    await model.refreshTeamViews()
    model.teamViewKey.value = 'workbench-readonly'
    model.teamViewOwnerUserId.value = 'owner-3'
    await nextTick()

    expect(model.showManagementActions.value).toBe(false)
    expect(model.teamViewOwnerUserId.value).toBe('')
    expect(model.canShareTeamView.value).toBe(false)
    expect(model.canTransferTeamView.value).toBe(false)

    model.teamViewOwnerUserId.value = 'owner-3'
    await model.shareTeamView()
    await model.transferTeamView()

    expect(buildShareUrl).not.toHaveBeenCalled()
    expect(copyShareUrl).not.toHaveBeenCalled()
    expect(transferPlmWorkbenchTeamView).not.toHaveBeenCalled()
    expect(setMessage).toHaveBeenNthCalledWith(1, '仅创建者可分享工作台团队视角。', true)
    expect(setMessage).toHaveBeenNthCalledWith(2, '仅创建者可转移工作台团队视角。', true)
  })

  it('allows rename, set-default, and clear-default when permissions.canManage overrides legacy false', async () => {
    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [
        {
          id: 'workbench-managed',
          kind: 'workbench',
          scope: 'team',
          name: '管理员工作台视角',
          ownerUserId: 'owner-2',
          canManage: false,
          isDefault: false,
          permissions: {
            canManage: true,
            canApply: true,
            canRename: true,
            canSetDefault: true,
            canClearDefault: true,
          },
          state: {
            query: {
              documentFilter: 'managed-doc',
            },
          },
        },
      ],
    })
    vi.mocked(renamePlmWorkbenchTeamView).mockResolvedValue({
      id: 'workbench-managed',
      kind: 'workbench',
      scope: 'team',
      name: '管理员重命名视角',
      ownerUserId: 'owner-2',
      canManage: false,
      isDefault: false,
      permissions: {
        canManage: true,
        canApply: true,
        canRename: true,
        canSetDefault: true,
        canClearDefault: true,
      },
      state: {
        query: {
          documentFilter: 'managed-doc',
        },
      },
    })
    vi.mocked(setPlmWorkbenchTeamViewDefault).mockResolvedValue({
      id: 'workbench-managed',
      kind: 'workbench',
      scope: 'team',
      name: '管理员重命名视角',
      ownerUserId: 'owner-2',
      canManage: false,
      isDefault: true,
      permissions: {
        canManage: true,
        canApply: true,
        canRename: true,
        canSetDefault: true,
        canClearDefault: true,
      },
      state: {
        query: {
          documentFilter: 'managed-doc',
        },
      },
    })
    vi.mocked(clearPlmWorkbenchTeamViewDefault).mockResolvedValue({
      id: 'workbench-managed',
      kind: 'workbench',
      scope: 'team',
      name: '管理员重命名视角',
      ownerUserId: 'owner-2',
      canManage: false,
      isDefault: false,
      permissions: {
        canManage: true,
        canApply: true,
        canRename: true,
        canSetDefault: true,
        canClearDefault: true,
      },
      state: {
        query: {
          documentFilter: 'managed-doc',
        },
      },
    })

    const model = usePlmTeamViews({
      kind: 'workbench',
      label: '工作台',
      getCurrentViewState: () => ({
        query: {},
      }),
      applyViewState,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamViews()
    model.teamViewKey.value = 'workbench-managed'
    model.teamViewName.value = '管理员重命名视角'

    await model.renameTeamView()
    await model.setTeamViewDefault()
    await model.clearTeamViewDefault()

    expect(renamePlmWorkbenchTeamView).toHaveBeenCalledWith('workbench', 'workbench-managed', '管理员重命名视角')
    expect(setPlmWorkbenchTeamViewDefault).toHaveBeenCalledWith('workbench', 'workbench-managed')
    expect(clearPlmWorkbenchTeamViewDefault).toHaveBeenCalledWith('workbench', 'workbench-managed')
    expect(model.teamViews.value.find((view) => view.id === 'workbench-managed')?.isDefault).toBe(false)
  })

  it('allows restore when permissions.canManage overrides legacy false', async () => {
    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [
        {
          id: 'cad-archived',
          kind: 'cad',
          scope: 'team',
          name: '管理员归档 CAD 视角',
          ownerUserId: 'owner-2',
          canManage: false,
          isDefault: false,
          isArchived: true,
          archivedAt: '2026-03-11T03:00:00.000Z',
          permissions: {
            canManage: true,
            canApply: true,
            canRestore: true,
          },
          state: {
            fileId: 'cad-main',
            otherFileId: '',
            reviewState: 'approved',
            reviewNote: '',
          },
        },
      ],
    })
    vi.mocked(restorePlmWorkbenchTeamView).mockResolvedValue({
      id: 'cad-archived',
      kind: 'cad',
      scope: 'team',
      name: '管理员归档 CAD 视角',
      ownerUserId: 'owner-2',
      canManage: false,
      isDefault: false,
      isArchived: false,
      permissions: {
        canManage: true,
        canApply: true,
        canRestore: true,
      },
      state: {
        fileId: 'cad-main',
        otherFileId: '',
        reviewState: 'approved',
        reviewNote: '',
      },
    })

    const model = usePlmTeamViews({
      kind: 'cad',
      label: 'CAD',
      getCurrentViewState: () => ({
        fileId: '',
        otherFileId: '',
        reviewState: '',
        reviewNote: '',
      }),
      applyViewState,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamViews()
    model.teamViewKey.value = 'cad-archived'

    await model.restoreTeamView()

    expect(restorePlmWorkbenchTeamView).toHaveBeenCalledWith('cad', 'cad-archived')
    expect(model.teamViews.value.find((view) => view.id === 'cad-archived')?.isArchived).toBe(false)
  })

  it('shares the current documents team view through an explicit deep link without changing identity', async () => {
    const buildShareUrl = vi.fn(() => 'http://example.test/plm?panel=documents&documentTeamView=view-share')
    const copyShareUrl = vi.fn().mockResolvedValue(true)

    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [
        {
          id: 'view-share',
          kind: 'documents',
          scope: 'team',
          name: '文档分享视角',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: {
            role: 'primary',
            filter: 'gear',
            sortKey: 'updated',
            sortDir: 'desc',
            columns: { mime: true },
          },
        },
      ],
    })

    const model = usePlmTeamViews({
      kind: 'documents',
      label: '文档',
      getCurrentViewState: () => ({
        role: '',
        filter: '',
        sortKey: 'updated',
        sortDir: 'desc',
        columns: {},
      }),
      applyViewState,
      setMessage,
      shouldAutoApplyDefault: () => false,
      buildShareUrl,
      copyShareUrl,
    })

    await model.refreshTeamViews()
    model.teamViewKey.value = 'view-share'

    await model.shareTeamView()

    expect(buildShareUrl).toHaveBeenCalledWith(expect.objectContaining({ id: 'view-share' }))
    expect(copyShareUrl).toHaveBeenCalledWith('http://example.test/plm?panel=documents&documentTeamView=view-share')
    expect(model.teamViewKey.value).toBe('view-share')
    expect(setMessage).toHaveBeenCalledWith('已复制文档团队视角分享链接。')
  })

  it('blocks sharing panel team views after ownership has been transferred away', async () => {
    const buildShareUrl = vi.fn(() => 'http://example.test/plm?panel=documents&documentTeamView=view-transfer')
    const copyShareUrl = vi.fn().mockResolvedValue(true)

    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [
        {
          id: 'view-transfer',
          kind: 'documents',
          scope: 'team',
          name: '已转移文档视角',
          ownerUserId: 'owner-2',
          canManage: false,
          isDefault: false,
          state: {
            role: 'primary',
            filter: 'gear',
            sortKey: 'updated',
            sortDir: 'desc',
            columns: { mime: true },
          },
        },
      ],
    })

    const model = usePlmTeamViews({
      kind: 'documents',
      label: '文档',
      getCurrentViewState: () => ({
        role: '',
        filter: '',
        sortKey: 'updated',
        sortDir: 'desc',
        columns: {},
      }),
      applyViewState,
      setMessage,
      shouldAutoApplyDefault: () => false,
      buildShareUrl,
      copyShareUrl,
    })

    await model.refreshTeamViews()
    model.teamViewKey.value = 'view-transfer'
    await nextTick()

    await model.shareTeamView()

    expect(model.showManagementActions.value).toBe(false)
    expect(model.canShareTeamView.value).toBe(false)
    expect(buildShareUrl).not.toHaveBeenCalled()
    expect(copyShareUrl).not.toHaveBeenCalled()
    expect(setMessage).toHaveBeenCalledWith('仅创建者可分享文档团队视角。', true)
  })

  it('clears stale owner transfer input when switching to a non-manageable team view', async () => {
    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [
        {
          id: 'view-readonly',
          kind: 'documents',
          scope: 'team',
          name: '只读文档视角',
          ownerUserId: 'owner-2',
          canManage: false,
          isDefault: false,
          state: {
            role: 'primary',
            filter: 'readonly-gear',
            sortKey: 'updated',
            sortDir: 'desc',
            columns: { mime: true },
          },
        },
      ],
    })

    const model = usePlmTeamViews({
      kind: 'documents',
      label: '文档',
      getCurrentViewState: () => ({
        role: '',
        filter: '',
        sortKey: 'updated',
        sortDir: 'desc',
        columns: {},
      }),
      applyViewState,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamViews()
    model.teamViewOwnerUserId.value = 'stale-owner'
    model.teamViewKey.value = 'view-readonly'
    await nextTick()

    expect(model.showManagementActions.value).toBe(false)
    expect(model.teamViewOwnerUserId.value).toBe('')
  })

  it('clears requested workbench identity and stale form state after deleting the current team view', async () => {
    const requestedViewId = ref('workbench-delete')
    const syncRequestedViewId = vi.fn((value?: string) => {
      requestedViewId.value = value || ''
    })

    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [
        {
          id: 'workbench-delete',
          kind: 'workbench',
          scope: 'team',
          name: '待删除工作台',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: {
            query: {
              documentFilter: 'delete-doc',
              approvalsFilter: 'delete-eco',
            },
          },
        },
      ],
    })
    vi.mocked(deletePlmWorkbenchTeamView).mockResolvedValue({
      id: 'workbench-delete',
      message: 'PLM team view deleted successfully',
    })

    const model = usePlmTeamViews({
      kind: 'workbench',
      label: '工作台',
      getCurrentViewState: () => ({
        query: {
          documentFilter: 'delete-doc',
          approvalsFilter: 'delete-eco',
        },
      }),
      applyViewState,
      setMessage,
      shouldAutoApplyDefault: () => false,
      requestedViewId,
      syncRequestedViewId,
    })

    await model.refreshTeamViews()
    model.teamViewKey.value = 'workbench-delete'
    model.teamViewName.value = '即将删除工作台'

    await model.deleteTeamView()

    expect(deletePlmWorkbenchTeamView).toHaveBeenCalledWith('workbench-delete')
    expect(syncRequestedViewId).toHaveBeenLastCalledWith(undefined)
    expect(requestedViewId.value).toBe('')
    expect(model.teamViewKey.value).toBe('')
    expect(model.teamViewName.value).toBe('')
    expect(model.teamViews.value).toHaveLength(0)
  })

  it('archives the current workbench team view and restores it back into URL ownership', async () => {
    const requestedViewId = ref('workbench-archive')
    const syncRequestedViewId = vi.fn((value?: string) => {
      requestedViewId.value = value || ''
    })
    const workbenchApply = vi.fn(() => requestedViewId.value)

    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [
        {
          id: 'workbench-archive',
          kind: 'workbench',
          scope: 'team',
          name: '待归档工作台',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: true,
          isArchived: false,
          state: {
            query: {
              documentFilter: 'gear',
              approvalsFilter: 'eco',
            },
          },
        },
      ],
    })
    vi.mocked(archivePlmWorkbenchTeamView).mockResolvedValue({
      id: 'workbench-archive',
      kind: 'workbench',
      scope: 'team',
      name: '待归档工作台',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: false,
      isArchived: true,
      archivedAt: '2026-03-10T08:00:00.000Z',
      state: {
        query: {
          documentFilter: 'gear',
          approvalsFilter: 'eco',
        },
      },
    })
    vi.mocked(restorePlmWorkbenchTeamView).mockResolvedValue({
      id: 'workbench-archive',
      kind: 'workbench',
      scope: 'team',
      name: '待归档工作台',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: false,
      isArchived: false,
      state: {
        query: {
          documentFilter: 'gear',
          approvalsFilter: 'eco',
        },
      },
    })

    const model = usePlmTeamViews({
      kind: 'workbench',
      label: '工作台',
      getCurrentViewState: () => ({
        query: {
          documentFilter: 'gear',
          approvalsFilter: 'eco',
        },
      }),
      applyViewState: workbenchApply,
      setMessage,
      shouldAutoApplyDefault: () => false,
      requestedViewId,
      syncRequestedViewId,
    })

    await model.refreshTeamViews()
    workbenchApply.mockClear()
    syncRequestedViewId.mockClear()
    model.teamViewKey.value = 'workbench-archive'
    await model.archiveTeamView()

    expect(archivePlmWorkbenchTeamView).toHaveBeenCalledWith('workbench', 'workbench-archive')
    expect(syncRequestedViewId).toHaveBeenLastCalledWith(undefined)
    expect(requestedViewId.value).toBe('')
    expect(model.teamViewKey.value).toBe('')
    expect(model.teamViews.value[0]).toMatchObject({
      id: 'workbench-archive',
      isArchived: true,
      archivedAt: '2026-03-10T08:00:00.000Z',
    })
    expect(workbenchApply).not.toHaveBeenCalled()

    model.teamViewKey.value = 'workbench-archive'
    await model.restoreTeamView()

    expect(restorePlmWorkbenchTeamView).toHaveBeenCalledWith('workbench', 'workbench-archive')
    expect(syncRequestedViewId).toHaveBeenLastCalledWith('workbench-archive')
    expect(requestedViewId.value).toBe('workbench-archive')
    expect(model.teamViews.value[0]).toMatchObject({
      id: 'workbench-archive',
      isArchived: false,
    })
    expect(workbenchApply).toHaveBeenLastCalledWith({
      query: {
        documentFilter: 'gear',
        approvalsFilter: 'eco',
      },
    })
  })

  it('transfers the current panel team view to a new owner without losing the explicit id', async () => {
    const requestedViewId = ref('document-view-1')
    const syncRequestedViewId = vi.fn((value?: string) => {
      requestedViewId.value = value || ''
    })

    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [
        {
          id: 'document-view-1',
          kind: 'documents',
          scope: 'team',
          name: '共享文档视角',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: {
            role: 'primary',
            filter: 'gear',
            sortKey: 'updated',
            sortDir: 'desc',
            columns: { mime: true },
          },
        },
      ],
    })
    vi.mocked(transferPlmWorkbenchTeamView).mockResolvedValue({
      id: 'document-view-1',
      kind: 'documents',
      scope: 'team',
      name: '共享文档视角',
      ownerUserId: 'owner-2',
      canManage: false,
      isDefault: false,
      state: {
        role: 'primary',
        filter: 'gear',
        sortKey: 'updated',
        sortDir: 'desc',
        columns: { mime: true },
      },
    })

    const model = usePlmTeamViews({
      kind: 'documents',
      label: '文档',
      getCurrentViewState: () => ({
        role: '',
        filter: '',
        sortKey: 'updated',
        sortDir: 'desc',
        columns: {},
      }),
      applyViewState,
      setMessage,
      shouldAutoApplyDefault: () => false,
      requestedViewId,
      syncRequestedViewId,
    })

    await model.refreshTeamViews()
    model.teamViewKey.value = 'document-view-1'
    model.teamViewOwnerUserId.value = 'owner-2'
    syncRequestedViewId.mockClear()
    applyViewState.mockClear()

    await model.transferTeamView()

    expect(transferPlmWorkbenchTeamView).toHaveBeenCalledWith('documents', 'document-view-1', 'owner-2')
    expect(syncRequestedViewId).toHaveBeenLastCalledWith('document-view-1')
    expect(requestedViewId.value).toBe('document-view-1')
    expect(model.teamViewOwnerUserId.value).toBe('')
    expect(model.teamViews.value[0]).toMatchObject({
      id: 'document-view-1',
      ownerUserId: 'owner-2',
      canManage: false,
    })
    expect(model.showManagementActions.value).toBe(false)
    expect(model.canDeleteTeamView.value).toBe(false)
    expect(applyViewState).toHaveBeenCalledWith({
      role: 'primary',
      filter: 'gear',
      sortKey: 'updated',
      sortDir: 'desc',
      columns: { mime: true },
    })
  })

  it('blocks share, transfer, and clear-default actions for archived panel team views', async () => {
    const buildShareUrl = vi.fn(() => 'http://example.test/plm?panel=documents&documentTeamView=view-archived')
    const copyShareUrl = vi.fn().mockResolvedValue(true)

    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [
        {
          id: 'view-archived',
          kind: 'documents',
          scope: 'team',
          name: '归档文档视角',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: true,
          isArchived: true,
          archivedAt: '2026-03-11T01:00:00.000Z',
          state: {
            role: 'primary',
            filter: 'archived-gear',
            sortKey: 'updated',
            sortDir: 'desc',
            columns: { mime: true },
          },
        },
      ],
    })

    const model = usePlmTeamViews({
      kind: 'documents',
      label: '文档',
      getCurrentViewState: () => ({
        role: '',
        filter: '',
        sortKey: 'updated',
        sortDir: 'desc',
        columns: {},
      }),
      applyViewState,
      setMessage,
      shouldAutoApplyDefault: () => false,
      buildShareUrl,
      copyShareUrl,
    })

    await model.refreshTeamViews()
    model.teamViewKey.value = 'view-archived'
    model.teamViewOwnerUserId.value = 'owner-2'

    await model.shareTeamView()
    await model.transferTeamView()
    await model.clearTeamViewDefault()

    expect(copyShareUrl).not.toHaveBeenCalled()
    expect(transferPlmWorkbenchTeamView).not.toHaveBeenCalled()
    expect(clearPlmWorkbenchTeamViewDefault).not.toHaveBeenCalled()
    expect(model.canShareTeamView.value).toBe(false)
    expect(model.canTransferTeamView.value).toBe(false)
    expect(model.canClearTeamViewDefault.value).toBe(false)
    expect(setMessage).toHaveBeenNthCalledWith(1, '请先恢复文档团队视角，再执行分享。', true)
    expect(setMessage).toHaveBeenNthCalledWith(2, '请先恢复文档团队视角，再执行转移所有者。', true)
    expect(setMessage).toHaveBeenNthCalledWith(3, '请先恢复文档团队视角，再取消默认。', true)
  })

  it('clears explicit documents team view identity after batch archive', async () => {
    const requestedViewId = ref('document-view-1')
    const syncRequestedViewId = vi.fn((value?: string) => {
      requestedViewId.value = value || ''
    })

    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [
        {
          id: 'document-view-1',
          kind: 'documents',
          scope: 'team',
          name: '文档视角 A',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: {
            role: 'primary',
            filter: 'gear',
            sortKey: 'updated',
            sortDir: 'desc',
            columns: { mime: true },
          },
        },
        {
          id: 'document-view-2',
          kind: 'documents',
          scope: 'team',
          name: '文档视角 B',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: {
            role: 'secondary',
            filter: 'motor',
            sortKey: 'name',
            sortDir: 'asc',
            columns: { role: true },
          },
        },
      ],
    })
    vi.mocked(batchPlmWorkbenchTeamViews).mockResolvedValue({
      action: 'archive',
      processedIds: ['document-view-1'],
      skippedIds: ['document-view-2'],
      items: [
        {
          id: 'document-view-1',
          kind: 'documents',
          scope: 'team',
          name: '文档视角 A',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          isArchived: true,
          archivedAt: '2026-03-11T03:00:00.000Z',
          state: {
            role: 'primary',
            filter: 'gear',
            sortKey: 'updated',
            sortDir: 'desc',
            columns: { mime: true },
          },
        },
      ],
    })

    const model = usePlmTeamViews({
      kind: 'documents',
      label: '文档',
      getCurrentViewState: () => ({
        role: 'primary',
        filter: 'gear',
        sortKey: 'updated',
        sortDir: 'desc',
        columns: { mime: true },
      }),
      applyViewState,
      setMessage,
      requestedViewId,
      syncRequestedViewId,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamViews()
    model.teamViewKey.value = 'document-view-1'
    model.teamViewSelection.value = ['document-view-1', 'document-view-2']
    syncRequestedViewId.mockClear()

    await model.archiveTeamViewSelection()

    expect(batchPlmWorkbenchTeamViews).toHaveBeenCalledWith('documents', 'archive', [
      'document-view-1',
      'document-view-2',
    ])
    expect(syncRequestedViewId).toHaveBeenLastCalledWith(undefined)
    expect(requestedViewId.value).toBe('')
    expect(model.teamViewKey.value).toBe('')
    expect(model.teamViewSelection.value).toEqual(['document-view-2'])
    expect(model.teamViews.value.find((view) => view.id === 'document-view-1')?.isArchived).toBe(true)
  })

  it('clears explicit workbench team view identity after batch archive', async () => {
    const requestedViewId = ref('workbench-view-1')
    const syncRequestedViewId = vi.fn((value?: string) => {
      requestedViewId.value = value || ''
    })

    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [
        {
          id: 'workbench-view-1',
          kind: 'workbench',
          scope: 'team',
          name: '工作台视角 A',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: {
            query: {
              documentRole: 'primary',
              documentFilter: 'gear',
              approvalsFilter: 'eco-a',
              cadReviewNote: 'batch-note',
            },
          },
        },
        {
          id: 'workbench-view-2',
          kind: 'workbench',
          scope: 'team',
          name: '工作台视角 B',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: {
            query: {
              documentRole: 'secondary',
              documentFilter: 'motor',
            },
          },
        },
      ],
    })
    vi.mocked(batchPlmWorkbenchTeamViews).mockResolvedValue({
      action: 'archive',
      processedIds: ['workbench-view-1'],
      skippedIds: ['workbench-view-2'],
      items: [
        {
          id: 'workbench-view-1',
          kind: 'workbench',
          scope: 'team',
          name: '工作台视角 A',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          isArchived: true,
          archivedAt: '2026-03-11T04:00:00.000Z',
          state: {
            query: {
              documentRole: 'primary',
              documentFilter: 'gear',
              approvalsFilter: 'eco-a',
              cadReviewNote: 'batch-note',
            },
          },
        },
      ],
    })

    const model = usePlmTeamViews({
      kind: 'workbench',
      label: '工作台',
      getCurrentViewState: () => ({
        query: {
          documentRole: 'primary',
          documentFilter: 'gear',
          approvalsFilter: 'eco-a',
          cadReviewNote: 'batch-note',
        },
      }),
      applyViewState,
      setMessage,
      requestedViewId,
      syncRequestedViewId,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamViews()
    model.teamViewKey.value = 'workbench-view-1'
    model.teamViewSelection.value = ['workbench-view-1', 'workbench-view-2']
    syncRequestedViewId.mockClear()

    await model.archiveTeamViewSelection()

    expect(batchPlmWorkbenchTeamViews).toHaveBeenCalledWith('workbench', 'archive', [
      'workbench-view-1',
      'workbench-view-2',
    ])
    expect(syncRequestedViewId).toHaveBeenLastCalledWith(undefined)
    expect(requestedViewId.value).toBe('')
    expect(model.teamViewKey.value).toBe('')
    expect(model.teamViewSelection.value).toEqual(['workbench-view-2'])
    expect(model.teamViews.value.find((view) => view.id === 'workbench-view-1')?.isArchived).toBe(true)
  })

  it('reapplies explicit cad team view identity after batch restore', async () => {
    const requestedViewId = ref('')
    const syncRequestedViewId = vi.fn((value?: string) => {
      requestedViewId.value = value || ''
    })

    vi.mocked(listPlmWorkbenchTeamViews).mockResolvedValue({
      items: [
        {
          id: 'cad-view-1',
          kind: 'cad',
          scope: 'team',
          name: 'CAD 归档视角',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          isArchived: true,
          archivedAt: '2026-03-11T03:00:00.000Z',
          state: {
            fileId: 'cad-main',
            otherFileId: '',
            reviewState: 'approved',
            reviewNote: 'restore-me',
          },
        },
      ],
    })
    vi.mocked(batchPlmWorkbenchTeamViews).mockResolvedValue({
      action: 'restore',
      processedIds: ['cad-view-1'],
      skippedIds: [],
      items: [
        {
          id: 'cad-view-1',
          kind: 'cad',
          scope: 'team',
          name: 'CAD 归档视角',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          isArchived: false,
          state: {
            fileId: 'cad-main',
            otherFileId: '',
            reviewState: 'approved',
            reviewNote: 'restore-me',
          },
        },
      ],
    })

    const model = usePlmTeamViews({
      kind: 'cad',
      label: 'CAD',
      getCurrentViewState: () => ({
        fileId: '',
        otherFileId: '',
        reviewState: '',
        reviewNote: '',
      }),
      applyViewState,
      setMessage,
      requestedViewId,
      syncRequestedViewId,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamViews()
    applyViewState.mockClear()
    syncRequestedViewId.mockClear()
    model.teamViewKey.value = 'cad-view-1'
    model.teamViewSelection.value = ['cad-view-1']

    await model.restoreTeamViewSelection()

    expect(batchPlmWorkbenchTeamViews).toHaveBeenCalledWith('cad', 'restore', ['cad-view-1'])
    expect(syncRequestedViewId).toHaveBeenLastCalledWith('cad-view-1')
    expect(requestedViewId.value).toBe('cad-view-1')
    expect(model.teamViewKey.value).toBe('cad-view-1')
    expect(model.teamViewSelection.value).toEqual([])
    expect(model.teamViews.value.find((view) => view.id === 'cad-view-1')?.isArchived).toBe(false)
    expect(applyViewState).toHaveBeenCalledWith({
      fileId: 'cad-main',
      otherFileId: '',
      reviewState: 'approved',
      reviewNote: 'restore-me',
    })
  })
})
