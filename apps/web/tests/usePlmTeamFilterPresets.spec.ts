import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { usePlmTeamFilterPresets } from '../src/views/plm/usePlmTeamFilterPresets'
import {
  archivePlmTeamFilterPreset,
  batchPlmTeamFilterPresets,
  clearPlmTeamFilterPresetDefault,
  duplicatePlmTeamFilterPreset,
  deletePlmTeamFilterPreset,
  listPlmTeamFilterPresets,
  renamePlmTeamFilterPreset,
  restorePlmTeamFilterPreset,
  savePlmTeamFilterPreset,
  setPlmTeamFilterPresetDefault,
  transferPlmTeamFilterPreset,
} from '../src/services/plm/plmWorkbenchClient'

vi.mock('../src/services/plm/plmWorkbenchClient', () => ({
  archivePlmTeamFilterPreset: vi.fn(),
  batchPlmTeamFilterPresets: vi.fn(),
  listPlmTeamFilterPresets: vi.fn(),
  savePlmTeamFilterPreset: vi.fn(),
  duplicatePlmTeamFilterPreset: vi.fn(),
  deletePlmTeamFilterPreset: vi.fn(),
  renamePlmTeamFilterPreset: vi.fn(),
  restorePlmTeamFilterPreset: vi.fn(),
  setPlmTeamFilterPresetDefault: vi.fn(),
  clearPlmTeamFilterPresetDefault: vi.fn(),
  transferPlmTeamFilterPreset: vi.fn(),
}))

describe('usePlmTeamFilterPresets', () => {
  const setMessage = vi.fn()
  const applyPreset = vi.fn()

  beforeEach(() => {
    vi.mocked(archivePlmTeamFilterPreset).mockReset()
    vi.mocked(batchPlmTeamFilterPresets).mockReset()
    vi.mocked(listPlmTeamFilterPresets).mockReset()
    vi.mocked(savePlmTeamFilterPreset).mockReset()
    vi.mocked(duplicatePlmTeamFilterPreset).mockReset()
    vi.mocked(deletePlmTeamFilterPreset).mockReset()
    vi.mocked(renamePlmTeamFilterPreset).mockReset()
    vi.mocked(restorePlmTeamFilterPreset).mockReset()
    vi.mocked(setPlmTeamFilterPresetDefault).mockReset()
    vi.mocked(clearPlmTeamFilterPresetDefault).mockReset()
    vi.mocked(transferPlmTeamFilterPreset).mockReset()
    setMessage.mockReset()
    applyPreset.mockReset()
  })

  it('auto-applies the default team preset on first refresh', async () => {
    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-1',
          kind: 'bom',
          scope: 'team',
          name: '关键 BOM',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: true,
          state: { field: 'path', value: 'root/a', group: '机械' },
        },
      ],
    })

    const currentState = {
      field: 'all',
      value: '',
      group: '',
    }

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => currentState,
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => true,
    })

    await model.refreshTeamPresets()

    expect(applyPreset).toHaveBeenCalledWith({
      key: 'preset-1',
      label: '关键 BOM',
      field: 'path',
      value: 'root/a',
      group: '机械',
    })
    expect(model.teamPresetKey.value).toBe('preset-1')
    expect(model.defaultTeamPresetLabel.value).toBe('关键 BOM (机械)')
  })

  it('applies an explicitly requested team preset before falling back to default', async () => {
    const requestedPresetId = ref(' preset-explicit ')
    const syncRequestedPresetId = vi.fn((value?: string) => {
      requestedPresetId.value = value || ''
    })

    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-default',
          kind: 'bom',
          scope: 'team',
          name: '默认 BOM',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: true,
          state: { field: 'path', value: 'root/default', group: '默认组' },
        },
        {
          id: 'preset-explicit',
          kind: 'bom',
          scope: 'team',
          name: '显式 BOM',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: { field: 'all', value: 'gear-box', group: '显式组' },
        },
      ],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'all', value: '', group: '' }),
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => true,
      requestedPresetId,
      syncRequestedPresetId,
    })

    await model.refreshTeamPresets()

    expect(applyPreset).toHaveBeenCalledWith({
      key: 'preset-explicit',
      label: '显式 BOM',
      field: 'all',
      value: 'gear-box',
      group: '显式组',
    })
    expect(model.teamPresetKey.value).toBe('preset-explicit')
    expect(syncRequestedPresetId).toHaveBeenCalledWith('preset-explicit')
  })

  it('reapplies the default team preset after an explicit preset becomes stale', async () => {
    const requestedPresetId = ref('')
    const syncRequestedPresetId = vi.fn((value?: string) => {
      requestedPresetId.value = value || ''
    })
    const trackedApply = vi.fn(() => requestedPresetId.value)

    vi.mocked(listPlmTeamFilterPresets)
      .mockResolvedValueOnce({
        items: [
          {
            id: 'preset-default',
            kind: 'bom',
            scope: 'team',
            name: '默认 BOM',
            ownerUserId: 'dev-user',
            canManage: true,
            isDefault: true,
            state: { field: 'path', value: 'root/default', group: '默认组' },
          },
          {
            id: 'preset-explicit',
            kind: 'bom',
            scope: 'team',
            name: '显式 BOM',
            ownerUserId: 'dev-user',
            canManage: true,
            isDefault: false,
            state: { field: 'path', value: 'root/explicit', group: '显式组' },
          },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: 'preset-default',
            kind: 'bom',
            scope: 'team',
            name: '默认 BOM',
            ownerUserId: 'dev-user',
            canManage: true,
            isDefault: true,
            state: { field: 'path', value: 'root/default', group: '默认组' },
          },
          {
            id: 'preset-explicit',
            kind: 'bom',
            scope: 'team',
            name: '显式 BOM',
            ownerUserId: 'dev-user',
            canManage: true,
            isDefault: false,
            permissions: {
              canApply: false,
            },
            state: { field: 'path', value: 'root/explicit', group: '显式组' },
          },
        ],
      })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: '', group: '' }),
      applyPreset: trackedApply,
      setMessage,
      shouldAutoApplyDefault: () => true,
      requestedPresetId,
      syncRequestedPresetId,
    })

    await model.refreshTeamPresets()
    expect(model.teamPresetKey.value).toBe('preset-default')

    model.teamPresetKey.value = 'preset-explicit'
    model.applyTeamPreset()

    expect(requestedPresetId.value).toBe('preset-explicit')

    trackedApply.mockClear()
    syncRequestedPresetId.mockClear()

    await model.refreshTeamPresets()

    expect(model.teamPresetKey.value).toBe('preset-default')
    expect(requestedPresetId.value).toBe('preset-default')
    expect(syncRequestedPresetId).toHaveBeenLastCalledWith('preset-default')
    expect(trackedApply).toHaveBeenCalledWith({
      key: 'preset-default',
      label: '默认 BOM',
      field: 'path',
      value: 'root/default',
      group: '默认组',
    })
  })

  it('clears stale team-preset drafts when refresh removes the selected preset', async () => {
    vi.mocked(listPlmTeamFilterPresets)
      .mockResolvedValueOnce({
        items: [
          {
            id: 'preset-removed',
            kind: 'bom',
            scope: 'team',
            name: '将被移除的团队预设',
            ownerUserId: 'dev-user',
            canManage: true,
            isDefault: false,
            state: { field: 'path', value: 'root/removed', group: '旧分组' },
          },
        ],
      })
      .mockResolvedValueOnce({
        items: [],
      })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/removed', group: '旧分组' }),
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()
    model.teamPresetKey.value = 'preset-removed'
    model.teamPresetName.value = '待清理团队预设'
    model.teamPresetGroup.value = '待清理分组'
    model.teamPresetOwnerUserId.value = 'owner-stale'

    await model.refreshTeamPresets()

    expect(model.teamPresetKey.value).toBe('')
    expect(model.teamPresetName.value).toBe('')
    expect(model.teamPresetGroup.value).toBe('')
    expect(model.teamPresetOwnerUserId.value).toBe('')
  })

  it('preserves create-mode team-preset drafts when refresh runs without an active selection', async () => {
    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/create', group: '创建分组' }),
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    model.teamPresetName.value = '待保存团队预设'
    model.teamPresetGroup.value = '创建分组'
    model.teamPresetOwnerUserId.value = 'owner-draft'

    await model.refreshTeamPresets()

    expect(model.teamPresetKey.value).toBe('')
    expect(model.teamPresetName.value).toBe('待保存团队预设')
    expect(model.teamPresetGroup.value).toBe('创建分组')
    expect(model.teamPresetOwnerUserId.value).toBe('owner-draft')
  })

  it('clears stale requested and selected presets when refresh keeps them but removes applyability', async () => {
    const requestedPresetId = ref('preset-locked')
    const syncRequestedPresetId = vi.fn((value?: string) => {
      requestedPresetId.value = value || ''
    })

    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-locked',
          kind: 'bom',
          scope: 'team',
          name: '只读 BOM',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          permissions: {
            canManage: true,
            canApply: false,
            canDuplicate: true,
            canShare: true,
            canDelete: true,
            canArchive: true,
            canRestore: false,
            canRename: true,
            canTransfer: true,
            canSetDefault: true,
            canClearDefault: false,
          },
          state: { field: 'path', value: 'root/locked', group: '锁定组' },
        },
      ],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/locked', group: '锁定组' }),
      applyPreset,
      setMessage,
      requestedPresetId,
      syncRequestedPresetId,
      shouldAutoApplyDefault: () => false,
    })

    model.teamPresetKey.value = 'preset-locked'
    model.teamPresetName.value = '待清理团队预设'
    model.teamPresetGroup.value = '待清理分组'
    model.teamPresetOwnerUserId.value = 'owner-stale'
    await model.refreshTeamPresets()

    expect(model.teamPresetKey.value).toBe('')
    expect(model.teamPresetName.value).toBe('')
    expect(model.teamPresetGroup.value).toBe('')
    expect(model.teamPresetOwnerUserId.value).toBe('')
    expect(requestedPresetId.value).toBe('')
    expect(syncRequestedPresetId).toHaveBeenLastCalledWith(undefined)
  })

  it('refreshes, saves, toggles default, applies, and deletes team presets', async () => {
    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-1',
          kind: 'bom',
          scope: 'team',
          name: '关键 BOM',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: { field: 'path', value: 'root/a', group: '机械' },
        },
      ],
    })
    vi.mocked(savePlmTeamFilterPreset).mockResolvedValue({
      id: 'preset-2',
      kind: 'bom',
      scope: 'team',
      name: '新团队预设',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: false,
      state: { field: 'all', value: 'motor', group: '关键件' },
    })
    vi.mocked(setPlmTeamFilterPresetDefault).mockResolvedValue({
      id: 'preset-1',
      kind: 'bom',
      scope: 'team',
      name: '关键 BOM',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: true,
      state: { field: 'path', value: 'root/a', group: '机械' },
    })
    vi.mocked(clearPlmTeamFilterPresetDefault).mockResolvedValue({
      id: 'preset-1',
      kind: 'bom',
      scope: 'team',
      name: '关键 BOM',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: false,
      state: { field: 'path', value: 'root/a', group: '机械' },
    })
    vi.mocked(deletePlmTeamFilterPreset).mockResolvedValue({
      id: 'preset-1',
      message: 'PLM team preset deleted successfully',
    })

    const currentState = {
      field: 'all',
      value: 'motor',
      group: '',
    }

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => currentState,
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()

    expect(model.teamPresets.value).toHaveLength(1)

    model.teamPresetKey.value = 'preset-1'
    const appliedPreset = model.applyTeamPreset()

    expect(applyPreset).toHaveBeenCalledWith({
      key: 'preset-1',
      label: '关键 BOM',
      field: 'path',
      value: 'root/a',
      group: '机械',
    })
    expect(appliedPreset?.id).toBe('preset-1')

    model.teamPresetName.value = '新团队预设'
    model.teamPresetGroup.value = '关键件'
    model.teamPresetOwnerUserId.value = 'owner-stale'
    const savedPreset = await model.saveTeamPreset()

    expect(savePlmTeamFilterPreset).toHaveBeenCalledWith('bom', '新团队预设', {
      field: 'all',
      value: 'motor',
      group: '关键件',
    })
    expect(savedPreset?.id).toBe('preset-2')
    expect(model.teamPresetKey.value).toBe('preset-2')
    expect(model.teamPresetName.value).toBe('')
    expect(model.teamPresetGroup.value).toBe('')
    expect(model.teamPresetOwnerUserId.value).toBe('')

    model.teamPresetKey.value = 'preset-1'
    await model.setTeamPresetDefault()

    expect(setPlmTeamFilterPresetDefault).toHaveBeenCalledWith('preset-1')
    expect(model.teamPresets.value.find((preset) => preset.id === 'preset-1')?.isDefault).toBe(true)

    await model.clearTeamPresetDefault()

    expect(clearPlmTeamFilterPresetDefault).toHaveBeenCalledWith('preset-1')
    expect(model.teamPresets.value.find((preset) => preset.id === 'preset-1')?.isDefault).toBe(false)

    model.teamPresetKey.value = 'preset-1'
    await model.deleteTeamPreset()

    expect(deletePlmTeamFilterPreset).toHaveBeenCalledWith('preset-1')
    expect(model.teamPresets.value.some((preset) => preset.id === 'preset-1')).toBe(false)
  })

  it('demotes the previous default preset permissions immediately after a default switch', async () => {
    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-default-old',
          kind: 'bom',
          scope: 'team',
          name: '旧默认预设',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: true,
          permissions: {
            canManage: true,
            canApply: true,
            canSetDefault: false,
            canClearDefault: true,
          },
          state: { field: 'path', value: 'root/old', group: '机械' },
        },
        {
          id: 'preset-default-new',
          kind: 'bom',
          scope: 'team',
          name: '新默认预设',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          permissions: {
            canManage: true,
            canApply: true,
            canSetDefault: true,
            canClearDefault: false,
          },
          state: { field: 'path', value: 'root/new', group: '共享' },
        },
      ],
    })
    vi.mocked(setPlmTeamFilterPresetDefault).mockResolvedValue({
      id: 'preset-default-new',
      kind: 'bom',
      scope: 'team',
      name: '新默认预设',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: true,
      permissions: {
        canManage: true,
        canApply: true,
        canSetDefault: false,
        canClearDefault: true,
      },
      state: { field: 'path', value: 'root/new', group: '共享' },
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({
        field: 'all',
        value: '',
      }),
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()
    model.teamPresetKey.value = 'preset-default-new'
    await model.setTeamPresetDefault()

    expect(model.teamPresets.value.find((preset) => preset.id === 'preset-default-old')).toMatchObject({
      isDefault: false,
      permissions: {
        canSetDefault: true,
        canClearDefault: false,
      },
    })
  })

  it('returns null when apply or save does not complete a team preset takeover', async () => {
    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-guarded',
          kind: 'bom',
          scope: 'team',
          name: '不可应用预设',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          permissions: {
            canApply: false,
            canManage: true,
          },
          state: { field: 'path', value: 'root/guarded', group: '受限组' },
        },
      ],
    })
    vi.mocked(savePlmTeamFilterPreset).mockRejectedValue(new Error('save failed'))

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/local', group: '本地组' }),
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()

    model.teamPresetKey.value = 'preset-guarded'
    expect(model.applyTeamPreset()).toBeNull()

    model.teamPresetName.value = '失败团队预设'
    model.teamPresetGroup.value = '失败组'
    expect(await model.saveTeamPreset()).toBeNull()
    expect(model.teamPresetsError.value).toBe('save failed')
  })

  it('syncs requested preset id after save, set-default, and clear-default actions', async () => {
    const requestedPresetId = ref('')
    const syncRequestedPresetId = vi.fn((value?: string) => {
      requestedPresetId.value = value || ''
    })
    const trackedApply = vi.fn(() => requestedPresetId.value)

    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({ items: [] })
    vi.mocked(savePlmTeamFilterPreset).mockResolvedValue({
      id: 'preset-saved',
      kind: 'where-used',
      scope: 'team',
      name: '共享父件',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: false,
      state: { field: 'parent', value: 'assy', group: '装配' },
    })
    vi.mocked(setPlmTeamFilterPresetDefault).mockResolvedValue({
      id: 'preset-saved',
      kind: 'where-used',
      scope: 'team',
      name: '共享父件',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: true,
      state: { field: 'parent', value: 'assy', group: '装配' },
    })
    vi.mocked(clearPlmTeamFilterPresetDefault).mockResolvedValue({
      id: 'preset-saved',
      kind: 'where-used',
      scope: 'team',
      name: '共享父件',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: false,
      state: { field: 'parent', value: 'assy', group: '装配' },
    })

    const model = usePlmTeamFilterPresets({
      kind: 'where-used',
      label: 'Where-Used',
      getCurrentPresetState: () => ({ field: 'parent', value: 'assy', group: '装配' }),
      applyPreset: trackedApply,
      setMessage,
      requestedPresetId,
      syncRequestedPresetId,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()
    model.teamPresetName.value = '共享父件'
    model.teamPresetGroup.value = '装配'
    await model.saveTeamPreset()

    expect(syncRequestedPresetId).toHaveBeenCalledWith('preset-saved')
    expect(trackedApply).toHaveReturnedWith('preset-saved')

    model.teamPresetKey.value = 'preset-saved'
    await model.setTeamPresetDefault()

    expect(syncRequestedPresetId).toHaveBeenLastCalledWith('preset-saved')
    expect(trackedApply).toHaveReturnedWith('preset-saved')

    const clearedPreset = await model.clearTeamPresetDefault()

    expect(syncRequestedPresetId).toHaveBeenLastCalledWith('preset-saved')
    expect(trackedApply).toHaveReturnedWith('preset-saved')
    expect(clearedPreset?.id).toBe('preset-saved')
  })

  it('archives the current team preset by clearing requested identity and restores it back into the URL identity', async () => {
    const requestedPresetId = ref('preset-archive')
    const syncRequestedPresetId = vi.fn((value?: string) => {
      requestedPresetId.value = value || ''
    })
    const trackedApply = vi.fn(() => requestedPresetId.value)

    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-archive',
          kind: 'bom',
          scope: 'team',
          name: '待归档团队预设',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: true,
          state: { field: 'path', value: 'root/archive', group: '机械' },
        },
      ],
    })
    vi.mocked(archivePlmTeamFilterPreset).mockResolvedValue({
      id: 'preset-archive',
      kind: 'bom',
      scope: 'team',
      name: '待归档团队预设',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: false,
      isArchived: true,
      archivedAt: '2026-03-10T08:00:00.000Z',
      state: { field: 'path', value: 'root/archive', group: '机械' },
    })
    vi.mocked(restorePlmTeamFilterPreset).mockResolvedValue({
      id: 'preset-archive',
      kind: 'bom',
      scope: 'team',
      name: '待归档团队预设',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: false,
      isArchived: false,
      state: { field: 'path', value: 'root/archive', group: '机械' },
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/archive', group: '机械' }),
      applyPreset: trackedApply,
      setMessage,
      requestedPresetId,
      syncRequestedPresetId,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()
    expect(model.teamPresetKey.value).toBe('preset-archive')
    expect(model.canArchiveTeamPreset.value).toBe(true)
    expect(model.canRestoreTeamPreset.value).toBe(false)
    model.teamPresetSelection.value = ['preset-archive']
    model.teamPresetOwnerUserId.value = 'owner-stale'
    requestedPresetId.value = ' preset-archive '

    await model.archiveTeamPreset()

    expect(archivePlmTeamFilterPreset).toHaveBeenCalledWith('preset-archive')
    expect(syncRequestedPresetId).toHaveBeenLastCalledWith(undefined)
    expect(requestedPresetId.value).toBe('')
    expect(model.teamPresetKey.value).toBe('')
    expect(model.teamPresetSelection.value).toEqual([])
    expect(model.teamPresetOwnerUserId.value).toBe('')
    expect(model.canArchiveTeamPreset.value).toBe(false)
    expect(model.teamPresets.value[0]).toMatchObject({
      id: 'preset-archive',
      isArchived: true,
      isDefault: false,
    })

    model.teamPresetKey.value = 'preset-archive'
    expect(model.canApplyTeamPreset.value).toBe(false)
    expect(model.canRestoreTeamPreset.value).toBe(true)
    model.teamPresetName.value = '待清空名称'
    model.teamPresetGroup.value = '待清空分组'
    model.teamPresetOwnerUserId.value = 'owner-stale'
    await model.restoreTeamPreset()

    expect(restorePlmTeamFilterPreset).toHaveBeenCalledWith('preset-archive')
    expect(syncRequestedPresetId).toHaveBeenLastCalledWith('preset-archive')
    expect(trackedApply).toHaveReturnedWith('preset-archive')
    expect(model.teamPresetKey.value).toBe('preset-archive')
    expect(model.teamPresets.value[0]).toMatchObject({
      id: 'preset-archive',
      isArchived: false,
    })
    expect(model.canApplyTeamPreset.value).toBe(true)
    expect(model.teamPresetName.value).toBe('')
    expect(model.teamPresetGroup.value).toBe('')
    expect(model.teamPresetOwnerUserId.value).toBe('')
  })

  it('blocks deleting a non-managed preset', async () => {
    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-3',
          kind: 'where-used',
          scope: 'team',
          name: '共享父件',
          ownerUserId: 'other-user',
          canManage: false,
          isDefault: false,
          state: { field: 'parent', value: 'assy', group: '装配' },
        },
      ],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'where-used',
      label: 'Where-Used',
      getCurrentPresetState: () => ({ field: 'all', value: 'assy', group: '' }),
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()
    model.teamPresetKey.value = 'preset-3'
    await model.deleteTeamPreset()

    expect(deletePlmTeamFilterPreset).not.toHaveBeenCalled()
    expect(setMessage).toHaveBeenCalledWith('仅创建者可删除Where-Used团队预设。', true)
  })

  it('returns owner-specific denial messages for readonly team preset management actions', async () => {
    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-readonly-active',
          kind: 'bom',
          scope: 'team',
          name: '只读激活预设',
          ownerUserId: 'owner-a',
          canManage: false,
          isDefault: false,
          permissions: {
            canManage: false,
            canApply: true,
            canDelete: false,
            canArchive: false,
            canSetDefault: false,
          },
          state: { field: 'path', value: 'root/active', group: 'A组' },
        },
        {
          id: 'preset-readonly-default',
          kind: 'bom',
          scope: 'team',
          name: '只读默认预设',
          ownerUserId: 'owner-a',
          canManage: false,
          isDefault: true,
          permissions: {
            canManage: false,
            canApply: true,
            canClearDefault: false,
          },
          state: { field: 'path', value: 'root/default', group: '默认组' },
        },
        {
          id: 'preset-readonly-archived',
          kind: 'bom',
          scope: 'team',
          name: '只读归档预设',
          ownerUserId: 'owner-a',
          canManage: false,
          isDefault: false,
          isArchived: true,
          permissions: {
            canManage: false,
            canApply: false,
            canRestore: false,
          },
          state: { field: 'path', value: 'root/archived', group: '归档组' },
        },
      ],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/active', group: 'A组' }),
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()

    model.teamPresetKey.value = 'preset-readonly-active'
    await model.deleteTeamPreset()
    await model.archiveTeamPreset()
    await model.setTeamPresetDefault()

    model.teamPresetKey.value = 'preset-readonly-default'
    await model.clearTeamPresetDefault()

    model.teamPresetKey.value = 'preset-readonly-archived'
    await model.restoreTeamPreset()

    expect(deletePlmTeamFilterPreset).not.toHaveBeenCalled()
    expect(archivePlmTeamFilterPreset).not.toHaveBeenCalled()
    expect(setPlmTeamFilterPresetDefault).not.toHaveBeenCalled()
    expect(clearPlmTeamFilterPresetDefault).not.toHaveBeenCalled()
    expect(restorePlmTeamFilterPreset).not.toHaveBeenCalled()
    expect(setMessage).toHaveBeenNthCalledWith(1, '仅创建者可删除BOM团队预设。', true)
    expect(setMessage).toHaveBeenNthCalledWith(2, '仅创建者可归档BOM团队预设。', true)
    expect(setMessage).toHaveBeenNthCalledWith(3, '仅创建者可设置BOM默认团队预设。', true)
    expect(setMessage).toHaveBeenNthCalledWith(4, '仅创建者可取消BOM默认团队预设。', true)
    expect(setMessage).toHaveBeenNthCalledWith(5, '仅创建者可恢复BOM团队预设。', true)
  })

  it('honors granular action denials for active team presets', async () => {
    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-guarded',
          kind: 'bom',
          scope: 'team',
          name: '受限预设',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          permissions: {
            canManage: true,
            canApply: false,
            canDuplicate: false,
            canShare: false,
            canDelete: false,
            canArchive: false,
            canRestore: false,
            canRename: false,
            canTransfer: false,
            canSetDefault: false,
            canClearDefault: false,
          },
          state: { field: 'path', value: 'root/guarded', group: '受限组' },
        },
      ],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/guarded', group: '受限组' }),
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()
    model.teamPresetKey.value = 'preset-guarded'
    model.teamPresetName.value = '受限预设副本'
    model.teamPresetOwnerUserId.value = 'owner-b'

    await model.applyTeamPreset()
    await model.shareTeamPreset()
    await model.duplicateTeamPreset()
    await model.renameTeamPreset()
    await model.transferTeamPreset()
    await model.deleteTeamPreset()
    await model.archiveTeamPreset()
    await model.setTeamPresetDefault()
    await model.clearTeamPresetDefault()

    expect(applyPreset).not.toHaveBeenCalled()
    expect(duplicatePlmTeamFilterPreset).not.toHaveBeenCalled()
    expect(renamePlmTeamFilterPreset).not.toHaveBeenCalled()
    expect(transferPlmTeamFilterPreset).not.toHaveBeenCalled()
    expect(deletePlmTeamFilterPreset).not.toHaveBeenCalled()
    expect(archivePlmTeamFilterPreset).not.toHaveBeenCalled()
    expect(setPlmTeamFilterPresetDefault).not.toHaveBeenCalled()
    expect(clearPlmTeamFilterPresetDefault).not.toHaveBeenCalled()
    expect(model.canApplyTeamPreset.value).toBe(false)
    expect(model.canDuplicateTeamPreset.value).toBe(false)
    expect(model.canShareTeamPreset.value).toBe(false)
    expect(model.canDeleteTeamPreset.value).toBe(false)
    expect(model.canArchiveTeamPreset.value).toBe(false)
    expect(model.canRenameTeamPreset.value).toBe(false)
    expect(model.canTransferTeamPreset.value).toBe(false)
    expect(model.canSetTeamPresetDefault.value).toBe(false)
    expect(model.canClearTeamPresetDefault.value).toBe(false)
  })

  it('honors granular restore denials for archived team presets', async () => {
    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-archived-guarded',
          kind: 'where-used',
          scope: 'team',
          name: '受限归档预设',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          isArchived: true,
          permissions: {
            canManage: true,
            canApply: false,
            canDuplicate: true,
            canShare: false,
            canDelete: true,
            canArchive: false,
            canRestore: false,
            canRename: false,
            canTransfer: false,
            canSetDefault: false,
            canClearDefault: false,
          },
          state: { field: 'parent', value: 'assy-guarded', group: '归档组' },
        },
      ],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'where-used',
      label: 'Where-Used',
      getCurrentPresetState: () => ({ field: 'parent', value: 'assy-guarded', group: '归档组' }),
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()
    model.teamPresetKey.value = 'preset-archived-guarded'

    await model.restoreTeamPreset()

    expect(restorePlmTeamFilterPreset).not.toHaveBeenCalled()
    expect(model.canRestoreTeamPreset.value).toBe(false)
    expect(setMessage).toHaveBeenLastCalledWith('当前Where-Used团队预设不可恢复。', true)
  })

  it('reports share gating precisely for readonly and explicitly unshareable team presets', async () => {
    const buildShareUrl = vi.fn(() => 'http://example.test/plm?bomTeamPreset=preset-share-locked')
    const copyShareUrl = vi.fn().mockResolvedValue(true)

    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-share-readonly',
          kind: 'bom',
          scope: 'team',
          name: '只读分享预设',
          ownerUserId: 'owner-a',
          canManage: false,
          isDefault: false,
          permissions: {
            canManage: false,
            canApply: true,
            canShare: false,
          },
          state: { field: 'path', value: 'root/readonly', group: '只读组' },
        },
        {
          id: 'preset-share-locked',
          kind: 'bom',
          scope: 'team',
          name: '受限分享预设',
          ownerUserId: 'owner-b',
          canManage: false,
          isDefault: false,
          permissions: {
            canManage: true,
            canApply: true,
            canShare: false,
          },
          state: { field: 'path', value: 'root/locked', group: '受限组' },
        },
      ],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/readonly', group: '只读组' }),
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => false,
      buildShareUrl,
      copyShareUrl,
    })

    await model.refreshTeamPresets()

    model.teamPresetKey.value = 'preset-share-readonly'
    await model.shareTeamPreset()

    model.teamPresetKey.value = 'preset-share-locked'
    await model.shareTeamPreset()

    expect(buildShareUrl).not.toHaveBeenCalled()
    expect(copyShareUrl).not.toHaveBeenCalled()
    expect(setMessage).toHaveBeenNthCalledWith(1, '仅创建者可分享BOM团队预设。', true)
    expect(setMessage).toHaveBeenNthCalledWith(2, '当前BOM团队预设不可分享。', true)
  })

  it('blocks sharing archived team presets before explicit share permissions can bypass restore-first gating', async () => {
    const buildShareUrl = vi.fn(() => 'http://example.test/plm?bomTeamPreset=preset-share-archived')
    const copyShareUrl = vi.fn().mockResolvedValue(true)

    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-share-archived',
          kind: 'bom',
          scope: 'team',
          name: '归档共享预设',
          ownerUserId: 'owner-a',
          canManage: true,
          isArchived: true,
          isDefault: false,
          permissions: {
            canManage: true,
            canApply: true,
            canShare: true,
          },
          state: { field: 'path', value: 'root/archived', group: '归档组' },
        },
      ],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/archived', group: '归档组' }),
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => false,
      buildShareUrl,
      copyShareUrl,
    })

    await model.refreshTeamPresets()
    model.teamPresetKey.value = 'preset-share-archived'

    await model.shareTeamPreset()

    expect(buildShareUrl).not.toHaveBeenCalled()
    expect(copyShareUrl).not.toHaveBeenCalled()
    expect(setMessage).toHaveBeenLastCalledWith('请先恢复BOM团队预设，再执行分享。', true)
  })

  it('blocks transferring archived team presets before validating the target owner input', async () => {
    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-archived-transfer',
          kind: 'bom',
          scope: 'team',
          name: '归档 BOM 预设',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          isArchived: true,
          archivedAt: '2026-03-26T08:00:00.000Z',
          permissions: {
            canManage: true,
            canApply: false,
            canDuplicate: true,
            canShare: false,
            canDelete: true,
            canArchive: false,
            canRestore: true,
            canRename: false,
            canTransfer: true,
            canSetDefault: false,
            canClearDefault: false,
          },
          state: { field: 'path', value: 'root/archived', group: '归档组' },
        },
      ],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/archived', group: '归档组' }),
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()
    model.teamPresetKey.value = 'preset-archived-transfer'
    model.teamPresetOwnerUserId.value = 'owner-b'

    expect(model.canTransferTargetTeamPreset.value).toBe(false)
    expect(model.canTransferTeamPreset.value).toBe(false)

    await model.transferTeamPreset()

    expect(transferPlmTeamFilterPreset).not.toHaveBeenCalled()
    expect(setMessage).toHaveBeenLastCalledWith('请先恢复BOM团队预设，再执行转移所有者。', true)
  })

  it('duplicates a visible preset and renames the owned copy while keeping requested identity aligned', async () => {
    const requestedPresetId = ref('preset-source')
    const syncRequestedPresetId = vi.fn((value?: string) => {
      requestedPresetId.value = value || ''
    })
    const trackedApply = vi.fn(() => requestedPresetId.value)

    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-source',
          kind: 'bom',
          scope: 'team',
          name: '共享 BOM',
          ownerUserId: 'owner-a',
          canManage: false,
          isDefault: false,
          state: { field: 'path', value: 'root/shared', group: '共享组' },
        },
      ],
    })
    vi.mocked(duplicatePlmTeamFilterPreset).mockResolvedValue({
      id: 'preset-copy',
      kind: 'bom',
      scope: 'team',
      name: '共享 BOM（副本）',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: false,
      state: { field: 'path', value: 'root/shared', group: '共享组' },
    })
    vi.mocked(renamePlmTeamFilterPreset).mockResolvedValue({
      id: 'preset-copy',
      kind: 'bom',
      scope: 'team',
      name: '共享 BOM 自定义副本',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: false,
      state: { field: 'path', value: 'root/shared', group: '共享组' },
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/shared', group: '共享组' }),
      applyPreset: trackedApply,
      setMessage,
      requestedPresetId,
      syncRequestedPresetId,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()

    model.teamPresetKey.value = 'preset-source'
    model.teamPresetGroup.value = '待清空分组'
    model.teamPresetOwnerUserId.value = 'owner-stale'
    expect(model.canDuplicateTeamPreset.value).toBe(true)
    expect(model.canRenameTeamPreset.value).toBe(false)
    await model.duplicateTeamPreset()

    expect(duplicatePlmTeamFilterPreset).toHaveBeenCalledWith('preset-source', undefined)
    expect(syncRequestedPresetId).toHaveBeenLastCalledWith('preset-copy')
    expect(trackedApply).toHaveReturnedWith('preset-copy')
    expect(model.teamPresetKey.value).toBe('preset-copy')
    expect(model.teamPresetName.value).toBe('')
    expect(model.teamPresetGroup.value).toBe('')
    expect(model.teamPresetOwnerUserId.value).toBe('')

    model.teamPresetName.value = '共享 BOM 自定义副本'
    model.teamPresetGroup.value = '重命名前草稿'
    model.teamPresetOwnerUserId.value = 'owner-stale-2'
    expect(model.canRenameTeamPreset.value).toBe(true)
    await model.renameTeamPreset()

    expect(renamePlmTeamFilterPreset).toHaveBeenCalledWith('preset-copy', '共享 BOM 自定义副本')
    expect(syncRequestedPresetId).toHaveBeenLastCalledWith('preset-copy')
    expect(trackedApply).toHaveReturnedWith('preset-copy')
    expect(model.teamPresets.value.find((preset) => preset.id === 'preset-copy')?.name).toBe('共享 BOM 自定义副本')
    expect(model.teamPresetName.value).toBe('')
    expect(model.teamPresetGroup.value).toBe('')
    expect(model.teamPresetOwnerUserId.value).toBe('')
  })

  it('transfers the current team preset to a new owner without losing the explicit id', async () => {
    const requestedPresetId = ref('preset-transfer')
    const syncRequestedPresetId = vi.fn((value?: string) => {
      requestedPresetId.value = value || ''
    })
    const trackedApply = vi.fn(() => requestedPresetId.value)

    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-transfer',
          kind: 'bom',
          scope: 'team',
          name: '可转移预设',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: { field: 'path', value: 'root/shared', group: '共享组' },
        },
      ],
    })
    vi.mocked(transferPlmTeamFilterPreset).mockResolvedValue({
      id: 'preset-transfer',
      kind: 'bom',
      scope: 'team',
      name: '可转移预设',
      ownerUserId: 'owner-b',
      canManage: false,
      isDefault: false,
      state: { field: 'path', value: 'root/shared', group: '共享组' },
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/shared', group: '共享组' }),
      applyPreset: trackedApply,
      setMessage,
      requestedPresetId,
      syncRequestedPresetId,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()

    model.teamPresetKey.value = 'preset-transfer'
    model.teamPresetSelection.value = ['preset-transfer']
    model.teamPresetOwnerUserId.value = 'owner-b'
    expect(model.canTransferTeamPreset.value).toBe(true)
    await model.transferTeamPreset()

    expect(transferPlmTeamFilterPreset).toHaveBeenCalledWith('preset-transfer', 'owner-b')
    expect(syncRequestedPresetId).toHaveBeenLastCalledWith('preset-transfer')
    expect(trackedApply).toHaveReturnedWith('preset-transfer')
    expect(model.teamPresetKey.value).toBe('preset-transfer')
    expect(model.teamPresetSelection.value).toEqual([])
    expect(model.teamPresetOwnerUserId.value).toBe('')
    expect(model.showManagementActions.value).toBe(false)
    expect(model.canShareTeamPreset.value).toBe(false)
    expect(model.canTransferTeamPreset.value).toBe(false)
    expect(model.teamPresets.value.find((preset) => preset.id === 'preset-transfer')?.ownerUserId).toBe('owner-b')
    expect(model.teamPresets.value.find((preset) => preset.id === 'preset-transfer')?.canManage).toBe(false)
  })

  it('clears stale owner transfer input when switching to a non-manageable team preset', async () => {
    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-readonly',
          kind: 'bom',
          scope: 'team',
          name: '共享 BOM',
          ownerUserId: 'owner-b',
          canManage: false,
          isDefault: false,
          state: { field: 'path', value: 'root/shared', group: '共享组' },
        },
      ],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/shared', group: '共享组' }),
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()

    model.teamPresetOwnerUserId.value = 'stale-user'
    model.teamPresetKey.value = 'preset-readonly'
    await nextTick()

    expect(model.teamPresetOwnerUserId.value).toBe('')
    expect(model.showManagementActions.value).toBe(false)
    expect(model.canShareTeamPreset.value).toBe(false)
  })

  it('blocks readonly team preset transfer before validating the owner input', async () => {
    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-readonly-transfer',
          kind: 'bom',
          scope: 'team',
          name: '只读 BOM 预设',
          ownerUserId: 'owner-b',
          canManage: false,
          isDefault: false,
          permissions: {
            canManage: false,
            canApply: true,
            canTransfer: false,
          },
          state: { field: 'path', value: 'root/readonly', group: '共享组' },
        },
      ],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/readonly', group: '共享组' }),
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()
    model.teamPresetKey.value = 'preset-readonly-transfer'
    await nextTick()

    expect(model.teamPresetOwnerUserId.value).toBe('')
    expect(model.canTransferTargetTeamPreset.value).toBe(false)
    expect(model.canTransferTeamPreset.value).toBe(false)

    await model.transferTeamPreset()

    expect(transferPlmTeamFilterPreset).not.toHaveBeenCalled()
    expect(setMessage).toHaveBeenLastCalledWith('仅创建者可转移BOM团队预设。', true)
  })

  it('blocks readonly team preset rename before validating the name input', async () => {
    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-readonly-rename',
          kind: 'bom',
          scope: 'team',
          name: '只读 BOM 预设',
          ownerUserId: 'owner-b',
          canManage: false,
          isDefault: false,
          permissions: {
            canManage: false,
            canApply: true,
            canRename: false,
          },
          state: { field: 'path', value: 'root/readonly', group: '共享组' },
        },
      ],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/readonly', group: '共享组' }),
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()
    model.teamPresetKey.value = 'preset-readonly-rename'
    await nextTick()

    expect(model.teamPresetName.value).toBe('')
    expect(model.canRenameTeamPreset.value).toBe(false)

    await model.renameTeamPreset()

    expect(renamePlmTeamFilterPreset).not.toHaveBeenCalled()
    expect(setMessage).toHaveBeenLastCalledWith('仅创建者可重命名BOM团队预设。', true)
  })

  it('clears rename, group, and owner drafts when switching the selected team preset', async () => {
    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-a',
          kind: 'bom',
          scope: 'team',
          name: '预设 A',
          ownerUserId: 'owner-a',
          canManage: true,
          isDefault: false,
          state: { field: 'path', value: 'root/a', group: 'A组' },
        },
        {
          id: 'preset-b',
          kind: 'bom',
          scope: 'team',
          name: '预设 B',
          ownerUserId: 'owner-b',
          canManage: true,
          isDefault: false,
          state: { field: 'path', value: 'root/b', group: 'B组' },
        },
      ],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/a', group: 'A组' }),
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()

    model.teamPresetKey.value = 'preset-a'
    model.teamPresetName.value = '重命名草稿'
    model.teamPresetGroup.value = '草稿分组'
    model.teamPresetOwnerUserId.value = 'owner-next'

    model.teamPresetKey.value = 'preset-b'
    await nextTick()

    expect(model.teamPresetName.value).toBe('')
    expect(model.teamPresetGroup.value).toBe('')
    expect(model.teamPresetOwnerUserId.value).toBe('')
  })

  it('blocks generic management actions until the pending preset selector target is applied', async () => {
    const requestedPresetId = ref('preset-applied')
    const syncRequestedPresetId = vi.fn((value?: string) => {
      requestedPresetId.value = value || ''
    })
    const buildShareUrl = vi.fn(() => 'http://example.test/plm?bomTeamPreset=preset-pending')
    const copyShareUrl = vi.fn(async () => true)

    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-applied',
          kind: 'bom',
          scope: 'team',
          name: '已应用 BOM 预设',
          ownerUserId: 'owner-a',
          canManage: true,
          isDefault: false,
          permissions: {
            canApply: true,
            canManage: true,
            canShare: true,
            canRename: true,
          },
          state: { field: 'path', value: 'root/a', group: 'A组' },
        },
        {
          id: 'preset-pending',
          kind: 'bom',
          scope: 'team',
          name: '待应用 BOM 预设',
          ownerUserId: 'owner-b',
          canManage: true,
          isDefault: false,
          permissions: {
            canApply: true,
            canManage: true,
            canDuplicate: true,
            canShare: true,
            canRename: true,
          },
          state: { field: 'path', value: 'root/b', group: 'B组' },
        },
      ],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/a', group: 'A组' }),
      applyPreset,
      setMessage,
      requestedPresetId,
      syncRequestedPresetId,
      shouldAutoApplyDefault: () => false,
      buildShareUrl,
      copyShareUrl,
    })

    await model.refreshTeamPresets()
    model.teamPresetKey.value = 'preset-pending'
    model.teamPresetName.value = '待重命名 BOM 预设'
    await nextTick()

    expect(model.canApplyTeamPreset.value).toBe(true)
    expect(model.canDuplicateTeamPreset.value).toBe(true)
    expect(model.canShareTeamPreset.value).toBe(false)
    expect(model.canRenameTeamPreset.value).toBe(false)
    expect(model.canDeleteTeamPreset.value).toBe(false)

    await model.shareTeamPreset()
    await model.renameTeamPreset()

    expect(buildShareUrl).not.toHaveBeenCalled()
    expect(copyShareUrl).not.toHaveBeenCalled()
    expect(renamePlmTeamFilterPreset).not.toHaveBeenCalled()
    expect(setMessage).toHaveBeenCalledWith('请先应用BOM团队预设，再执行管理操作。', true)
  })

  it('blocks management actions while a local preset owner still owns the current state', async () => {
    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-local-owner-drift',
          kind: 'bom',
          scope: 'team',
          name: '待取消默认 BOM 预设',
          ownerUserId: 'owner-a',
          canManage: true,
          isDefault: true,
          permissions: {
            canApply: true,
            canManage: true,
            canRename: true,
            canClearDefault: true,
          },
          state: { field: 'path', value: 'root/a', group: 'A组' },
        },
      ],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/a', group: 'A组' }),
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => false,
      hasPendingExternalOwnerDrift: () => true,
    })

    await model.refreshTeamPresets()
    model.teamPresetKey.value = 'preset-local-owner-drift'
    await nextTick()

    expect(model.canApplyTeamPreset.value).toBe(true)
    expect(model.canRenameTeamPreset.value).toBe(false)
    expect(model.canClearTeamPresetDefault.value).toBe(false)

    await model.clearTeamPresetDefault()

    expect(clearPlmTeamFilterPresetDefault).not.toHaveBeenCalled()
    expect(setMessage).toHaveBeenCalledWith('请先应用BOM团队预设，再执行管理操作。', true)
  })

  it('allows restoring an archived preset while a local preset owner still owns the current state', async () => {
    const trackedApply = vi.fn()

    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-local-restore',
          kind: 'bom',
          scope: 'team',
          name: '待恢复 BOM 团队预设',
          ownerUserId: 'owner-a',
          canManage: true,
          isDefault: false,
          isArchived: true,
          permissions: {
            canApply: false,
            canManage: true,
            canRestore: true,
          },
          state: { field: 'path', value: 'root/team', group: '团队组' },
        },
      ],
    })
    vi.mocked(restorePlmTeamFilterPreset).mockResolvedValue({
      id: 'preset-local-restore',
      kind: 'bom',
      scope: 'team',
      name: '待恢复 BOM 团队预设',
      ownerUserId: 'owner-a',
      canManage: true,
      isDefault: false,
      isArchived: false,
      permissions: {
        canApply: true,
        canManage: true,
      },
      state: { field: 'path', value: 'root/team', group: '团队组' },
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/local', group: '本地组' }),
      applyPreset: trackedApply,
      setMessage,
      shouldAutoApplyDefault: () => false,
      hasPendingExternalOwnerDrift: () => true,
    })

    await model.refreshTeamPresets()
    model.teamPresetKey.value = 'preset-local-restore'
    model.teamPresetName.value = '待清空名称'
    model.teamPresetGroup.value = '待清空分组'
    model.teamPresetOwnerUserId.value = 'owner-stale'

    expect(model.canRestoreTeamPreset.value).toBe(true)

    await model.restoreTeamPreset()

    expect(restorePlmTeamFilterPreset).toHaveBeenCalledWith('preset-local-restore')
    expect(trackedApply).not.toHaveBeenCalled()
    expect(model.teamPresetKey.value).toBe('preset-local-restore')
    expect(model.teamPresetName.value).toBe('')
    expect(model.teamPresetGroup.value).toBe('')
    expect(model.teamPresetOwnerUserId.value).toBe('')
    expect(model.teamPresets.value.find((preset) => preset.id === 'preset-local-restore')?.isArchived).toBe(false)
  })

  it('keeps readonly management controls hidden while the pending preset selector target stays applyable', async () => {
    const requestedPresetId = ref('preset-readonly-current')
    const syncRequestedPresetId = vi.fn((value?: string) => {
      requestedPresetId.value = value || ''
    })

    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-readonly-current',
          kind: 'bom',
          scope: 'team',
          name: '当前只读 BOM 预设',
          ownerUserId: 'owner-a',
          canManage: false,
          isDefault: false,
          permissions: {
            canApply: true,
            canManage: false,
            canDuplicate: true,
            canShare: false,
          },
          state: { field: 'path', value: 'root/current', group: '当前组' },
        },
        {
          id: 'preset-editable-pending',
          kind: 'bom',
          scope: 'team',
          name: '待应用 BOM 预设',
          ownerUserId: 'owner-b',
          canManage: true,
          isDefault: false,
          permissions: {
            canApply: true,
            canManage: true,
            canDuplicate: true,
            canShare: true,
          },
          state: { field: 'path', value: 'root/pending', group: '待应用组' },
        },
      ],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/current', group: '当前组' }),
      applyPreset,
      setMessage,
      requestedPresetId,
      syncRequestedPresetId,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()
    model.teamPresetKey.value = 'preset-editable-pending'
    await nextTick()

    expect(model.showManagementActions.value).toBe(false)
    expect(model.canApplyTeamPreset.value).toBe(true)
    expect(model.canDuplicateTeamPreset.value).toBe(true)
    expect(model.canShareTeamPreset.value).toBe(false)
  })

  it('clears a pending selector target when the applied route owner turns stale on refresh', async () => {
    const requestedPresetId = ref('preset-applied')
    const syncRequestedPresetId = vi.fn((value?: string) => {
      requestedPresetId.value = value || ''
    })

    vi.mocked(listPlmTeamFilterPresets)
      .mockResolvedValueOnce({
        items: [
          {
            id: 'preset-applied',
            kind: 'bom',
            scope: 'team',
            name: '已应用 BOM 预设',
            ownerUserId: 'owner-a',
            canManage: true,
            isDefault: false,
            permissions: {
              canApply: true,
              canManage: true,
            },
            state: { field: 'path', value: 'root/a', group: 'A组' },
          },
          {
            id: 'preset-pending',
            kind: 'bom',
            scope: 'team',
            name: '待应用 BOM 预设',
            ownerUserId: 'owner-b',
            canManage: true,
            isDefault: false,
            permissions: {
              canApply: true,
              canManage: true,
            },
            state: { field: 'path', value: 'root/b', group: 'B组' },
          },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: 'preset-applied',
            kind: 'bom',
            scope: 'team',
            name: '已应用 BOM 预设',
            ownerUserId: 'owner-a',
            canManage: true,
            isDefault: false,
            permissions: {
              canApply: false,
              canManage: true,
            },
            state: { field: 'path', value: 'root/a', group: 'A组' },
          },
          {
            id: 'preset-pending',
            kind: 'bom',
            scope: 'team',
            name: '待应用 BOM 预设',
            ownerUserId: 'owner-b',
            canManage: true,
            isDefault: false,
            permissions: {
              canApply: true,
              canManage: true,
            },
            state: { field: 'path', value: 'root/b', group: 'B组' },
          },
        ],
      })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/a', group: 'A组' }),
      applyPreset,
      setMessage,
      requestedPresetId,
      syncRequestedPresetId,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()
    model.teamPresetKey.value = 'preset-pending'
    model.teamPresetName.value = '待清理名称'
    model.teamPresetGroup.value = '待清理分组'
    model.teamPresetOwnerUserId.value = 'owner-stale'

    await model.refreshTeamPresets()

    expect(requestedPresetId.value).toBe('')
    expect(model.teamPresetKey.value).toBe('')
    expect(model.teamPresetName.value).toBe('')
    expect(model.teamPresetGroup.value).toBe('')
    expect(model.teamPresetOwnerUserId.value).toBe('')
    expect(model.showManagementActions.value).toBe(true)
    expect(model.canShareTeamPreset.value).toBe(false)
  })

  it('still allows duplicating the pending preset selector target before apply', async () => {
    const requestedPresetId = ref('preset-applied')
    const syncRequestedPresetId = vi.fn((value?: string) => {
      requestedPresetId.value = value || ''
    })
    const trackedApply = vi.fn(() => requestedPresetId.value)

    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-applied',
          kind: 'where-used',
          scope: 'team',
          name: '已应用 Where-Used 预设',
          ownerUserId: 'owner-a',
          canManage: true,
          isDefault: false,
          permissions: {
            canApply: true,
            canManage: true,
            canDuplicate: true,
          },
          state: { field: 'parent', value: 'assy-a', group: 'A组' },
        },
        {
          id: 'preset-pending',
          kind: 'where-used',
          scope: 'team',
          name: '待复制 Where-Used 预设',
          ownerUserId: 'owner-b',
          canManage: false,
          isDefault: false,
          permissions: {
            canApply: true,
            canManage: false,
            canDuplicate: true,
          },
          state: { field: 'parent', value: 'assy-b', group: 'B组' },
        },
      ],
    })
    vi.mocked(duplicatePlmTeamFilterPreset).mockResolvedValue({
      id: 'preset-copy',
      kind: 'where-used',
      scope: 'team',
      name: '待复制 Where-Used 预设（副本）',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: false,
      state: { field: 'parent', value: 'assy-b', group: 'B组' },
    })

    const model = usePlmTeamFilterPresets({
      kind: 'where-used',
      label: 'Where-Used',
      getCurrentPresetState: () => ({ field: 'parent', value: 'assy-a', group: 'A组' }),
      applyPreset: trackedApply,
      setMessage,
      requestedPresetId,
      syncRequestedPresetId,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()
    model.teamPresetKey.value = 'preset-pending'
    await nextTick()

    await model.duplicateTeamPreset()

    expect(duplicatePlmTeamFilterPreset).toHaveBeenCalledWith('preset-pending', undefined)
    expect(model.teamPresetKey.value).toBe('preset-copy')
    expect(syncRequestedPresetId).toHaveBeenLastCalledWith('preset-copy')
    expect(trackedApply).toHaveReturnedWith('preset-copy')
  })

  it('still allows applying the pending preset selector target while generic management stays frozen', async () => {
    const requestedPresetId = ref('preset-applied')
    const syncRequestedPresetId = vi.fn((value?: string) => {
      requestedPresetId.value = value || ''
    })
    const trackedApply = vi.fn(() => requestedPresetId.value)

    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-applied',
          kind: 'bom',
          scope: 'team',
          name: '已应用 BOM 预设',
          ownerUserId: 'owner-a',
          canManage: true,
          isDefault: false,
          permissions: {
            canApply: true,
            canManage: true,
            canShare: true,
          },
          state: { field: 'path', value: 'root/a', group: 'A组' },
        },
        {
          id: 'preset-pending',
          kind: 'bom',
          scope: 'team',
          name: '待应用 BOM 预设',
          ownerUserId: 'owner-b',
          canManage: true,
          isDefault: false,
          permissions: {
            canApply: true,
            canManage: true,
            canShare: true,
          },
          state: { field: 'path', value: 'root/b', group: 'B组' },
        },
      ],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/a', group: 'A组' }),
      applyPreset: trackedApply,
      setMessage,
      requestedPresetId,
      syncRequestedPresetId,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()
    model.teamPresetKey.value = 'preset-pending'
    await nextTick()

    await model.applyTeamPreset()

    expect(syncRequestedPresetId).toHaveBeenLastCalledWith('preset-pending')
    expect(trackedApply).toHaveReturnedWith('preset-pending')
    expect(model.teamPresetKey.value).toBe('preset-pending')
  })

  it('clears stale batch selection when applying, saving, and duplicating a single preset target', async () => {
    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-a',
          kind: 'bom',
          scope: 'team',
          name: '预设 A',
          ownerUserId: 'owner-a',
          canManage: true,
          isDefault: false,
          state: { field: 'path', value: 'root/a', group: 'A组' },
        },
        {
          id: 'preset-b',
          kind: 'bom',
          scope: 'team',
          name: '预设 B',
          ownerUserId: 'owner-b',
          canManage: true,
          isDefault: false,
          state: { field: 'path', value: 'root/b', group: 'B组' },
        },
      ],
    })
    vi.mocked(savePlmTeamFilterPreset).mockResolvedValue({
      id: 'preset-saved',
      kind: 'bom',
      scope: 'team',
      name: '新团队预设',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: false,
      state: { field: 'path', value: 'root/saved', group: '保存组' },
    })
    vi.mocked(duplicatePlmTeamFilterPreset).mockResolvedValue({
      id: 'preset-copy',
      kind: 'bom',
      scope: 'team',
      name: '预设 A（副本）',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: false,
      state: { field: 'path', value: 'root/a', group: 'A组' },
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/saved', group: '保存组' }),
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()

    model.teamPresetSelection.value = ['preset-a', 'preset-b']
    model.teamPresetKey.value = 'preset-a'
    model.applyTeamPreset()
    expect(model.teamPresetSelection.value).toEqual([])

    model.teamPresetSelection.value = ['preset-a', 'preset-b']
    model.teamPresetName.value = '新团队预设'
    model.teamPresetGroup.value = '保存组'
    await model.saveTeamPreset()
    expect(model.teamPresetSelection.value).toEqual([])

    model.teamPresetSelection.value = ['preset-a', 'preset-b']
    model.teamPresetKey.value = 'preset-a'
    await model.duplicateTeamPreset()
    expect(model.teamPresetSelection.value).toEqual([])
  })

  it('clears stale batch selection when promoting a local preset into team targets', async () => {
    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({ items: [] })
    vi.mocked(savePlmTeamFilterPreset)
      .mockResolvedValueOnce({
        id: 'preset-promoted',
        kind: 'where-used',
        scope: 'team',
        name: '共享父件 团队',
        ownerUserId: 'dev-user',
        canManage: true,
        isDefault: false,
        state: { field: 'parent', value: 'assy-1', group: '装配' },
      })
      .mockResolvedValueOnce({
        id: 'preset-created',
        kind: 'where-used',
        scope: 'team',
        name: '共享父件 默认',
        ownerUserId: 'dev-user',
        canManage: true,
        isDefault: false,
        state: { field: 'parent', value: 'assy-2', group: '默认组' },
      })
    vi.mocked(setPlmTeamFilterPresetDefault).mockResolvedValue({
      id: 'preset-created',
      kind: 'where-used',
      scope: 'team',
      name: '共享父件 默认',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: true,
      state: { field: 'parent', value: 'assy-2', group: '默认组' },
    })

    const model = usePlmTeamFilterPresets({
      kind: 'where-used',
      label: 'Where-Used',
      getCurrentPresetState: () => ({ field: 'parent', value: 'assy-1', group: '装配' }),
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()

    model.teamPresetSelection.value = ['preset-stale-a', 'preset-stale-b']
    await model.promoteFilterPresetToTeam({
      key: 'local-1',
      label: '共享父件',
      field: 'parent',
      value: 'assy-1',
      group: '装配',
    })
    expect(model.teamPresetSelection.value).toEqual([])

    model.teamPresetSelection.value = ['preset-stale-a', 'preset-stale-b']
    await model.promoteFilterPresetToTeamDefault({
      key: 'local-2',
      label: '共享父件 默认',
      field: 'parent',
      value: 'assy-2',
      group: '默认组',
    })
    expect(model.teamPresetSelection.value).toEqual([])
  })

  it('clears requested identity and stale form fields after deleting the current team preset', async () => {
    const requestedPresetId = ref('preset-delete')
    const syncRequestedPresetId = vi.fn((value?: string) => {
      requestedPresetId.value = value || ''
    })

    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-delete',
          kind: 'where-used',
          scope: 'team',
          name: '待删除团队预设',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: { field: 'parent', value: 'assy-delete', group: '删除组' },
        },
      ],
    })
    vi.mocked(deletePlmTeamFilterPreset).mockResolvedValue({
      id: 'preset-delete',
      message: 'PLM team preset deleted successfully',
    })

    const model = usePlmTeamFilterPresets({
      kind: 'where-used',
      label: 'Where-Used',
      getCurrentPresetState: () => ({ field: 'parent', value: 'assy-delete', group: '删除组' }),
      applyPreset,
      setMessage,
      requestedPresetId,
      syncRequestedPresetId,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()

    model.teamPresetKey.value = 'preset-delete'
    model.teamPresetName.value = '即将删除'
    model.teamPresetGroup.value = '旧分组'
    model.teamPresetSelection.value = ['preset-delete']
    model.teamPresetOwnerUserId.value = 'owner-stale'

    await model.deleteTeamPreset()

    expect(deletePlmTeamFilterPreset).toHaveBeenCalledWith('preset-delete')
    expect(syncRequestedPresetId).toHaveBeenLastCalledWith(undefined)
    expect(requestedPresetId.value).toBe('')
    expect(model.teamPresetKey.value).toBe('')
    expect(model.teamPresetName.value).toBe('')
    expect(model.teamPresetGroup.value).toBe('')
    expect(model.teamPresetSelection.value).toEqual([])
    expect(model.teamPresetOwnerUserId.value).toBe('')
    expect(model.teamPresets.value).toHaveLength(0)
  })

  it('promotes a local preset into a team preset and resolves duplicate names safely', async () => {
    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-existing',
          kind: 'bom',
          scope: 'team',
          name: '关键件',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: { field: 'component', value: 'gear', group: '机械' },
        },
      ],
    })
    vi.mocked(savePlmTeamFilterPreset).mockResolvedValue({
      id: 'preset-promoted',
      kind: 'bom',
      scope: 'team',
      name: '关键件 团队',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: false,
      state: { field: 'component', value: 'gear-next', group: '机械' },
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'all', value: '', group: '' }),
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()
    model.teamPresetOwnerUserId.value = 'owner-stale'
    const saved = await model.promoteFilterPresetToTeam({
      key: 'bom:local-1',
      label: '关键件',
      field: 'component',
      value: 'gear-next',
      group: '机械',
    })

    expect(savePlmTeamFilterPreset).toHaveBeenCalledWith('bom', '关键件 团队', {
      field: 'component',
      value: 'gear-next',
      group: '机械',
    })
    expect(saved?.id).toBe('preset-promoted')
    expect(model.teamPresetKey.value).toBe('preset-promoted')
    expect(model.teamPresetOwnerUserId.value).toBe('')
    expect(setMessage).toHaveBeenCalledWith('已将BOM本地预设提升为团队预设：关键件 团队')
  })

  it('promotes a local preset into a default team preset', async () => {
    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({ items: [] })
    vi.mocked(savePlmTeamFilterPreset).mockResolvedValue({
      id: 'preset-created',
      kind: 'where-used',
      scope: 'team',
      name: '共享父件',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: false,
      state: { field: 'parent_number', value: 'assy-01', group: '装配' },
    })
    vi.mocked(setPlmTeamFilterPresetDefault).mockResolvedValue({
      id: 'preset-created',
      kind: 'where-used',
      scope: 'team',
      name: '共享父件',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: true,
      state: { field: 'parent_number', value: 'assy-01', group: '装配' },
    })

    const model = usePlmTeamFilterPresets({
      kind: 'where-used',
      label: 'Where-Used',
      getCurrentPresetState: () => ({ field: 'all', value: '', group: '' }),
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()
    model.teamPresetOwnerUserId.value = 'owner-stale'
    const saved = await model.promoteFilterPresetToTeamDefault({
      key: 'where-used:local-1',
      label: '共享父件',
      field: 'parent_number',
      value: 'assy-01',
      group: '装配',
    })

    expect(savePlmTeamFilterPreset).toHaveBeenCalledWith('where-used', '共享父件', {
      field: 'parent_number',
      value: 'assy-01',
      group: '装配',
    })
    expect(setPlmTeamFilterPresetDefault).toHaveBeenCalledWith('preset-created')
    expect(saved?.id).toBe('preset-created')
    expect(model.teamPresetKey.value).toBe('preset-created')
    expect(model.teamPresets.value.find((preset) => preset.id === 'preset-created')?.isDefault).toBe(true)
    expect(model.teamPresetOwnerUserId.value).toBe('')
    expect(setMessage).toHaveBeenCalledWith('已将Where-Used本地预设提升为默认团队预设：共享父件')
  })

  it('keeps the promoted team preset applied when defaulting fails after creation', async () => {
    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({ items: [] })
    vi.mocked(savePlmTeamFilterPreset).mockResolvedValue({
      id: 'preset-created',
      kind: 'where-used',
      scope: 'team',
      name: '共享父件',
      ownerUserId: 'dev-user',
      canManage: true,
      isDefault: false,
      state: { field: 'parent_number', value: 'assy-01', group: '装配' },
    })
    vi.mocked(setPlmTeamFilterPresetDefault).mockRejectedValue(new Error('default failed'))

    const trackedApply = vi.fn(() => 'applied')
    const model = usePlmTeamFilterPresets({
      kind: 'where-used',
      label: 'Where-Used',
      getCurrentPresetState: () => ({ field: 'all', value: '', group: '' }),
      applyPreset: trackedApply,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()
    model.teamPresetOwnerUserId.value = 'owner-stale'
    const saved = await model.promoteFilterPresetToTeamDefault({
      key: 'where-used:local-1',
      label: '共享父件',
      field: 'parent_number',
      value: 'assy-01',
      group: '装配',
    })

    expect(savePlmTeamFilterPreset).toHaveBeenCalledWith('where-used', '共享父件', {
      field: 'parent_number',
      value: 'assy-01',
      group: '装配',
    })
    expect(setPlmTeamFilterPresetDefault).toHaveBeenCalledWith('preset-created')
    expect(saved?.id).toBe('preset-created')
    expect(model.teamPresetKey.value).toBe('preset-created')
    expect(model.teamPresets.value.find((preset) => preset.id === 'preset-created')?.isDefault).toBe(false)
    expect(model.teamPresetOwnerUserId.value).toBe('')
    expect(model.teamPresetsError.value).toBe('default failed')
    expect(setMessage).toHaveBeenCalledWith('已将Where-Used本地预设提升为团队预设，但设为默认失败：共享父件', true)
  })

  it('batch archives manageable team presets and clears explicit identity for archived selections', async () => {
    const requestedPresetId = ref('preset-owned')
    const syncRequestedPresetId = vi.fn((value?: string) => {
      requestedPresetId.value = value || ''
    })

    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-owned',
          kind: 'bom',
          scope: 'team',
          name: '待批量归档',
          ownerUserId: 'dev-user',
          canManage: true,
          permissions: {
            canManage: true,
            canApply: true,
            canDuplicate: true,
            canShare: true,
            canDelete: true,
            canArchive: true,
            canRestore: false,
            canRename: true,
            canTransfer: true,
            canSetDefault: true,
            canClearDefault: false,
          },
          isDefault: false,
          isArchived: false,
          state: { field: 'path', value: 'root/a', group: '机械' },
        },
        {
          id: 'preset-readonly',
          kind: 'bom',
          scope: 'team',
          name: '只读团队预设',
          ownerUserId: 'other-user',
          canManage: false,
          isDefault: false,
          isArchived: false,
          state: { field: 'path', value: 'root/b', group: '共享' },
        },
        {
          id: 'preset-archived',
          kind: 'bom',
          scope: 'team',
          name: '已归档团队预设',
          ownerUserId: 'dev-user',
          canManage: true,
          permissions: {
            canManage: true,
            canApply: false,
            canDuplicate: true,
            canShare: false,
            canDelete: true,
            canArchive: false,
            canRestore: true,
            canRename: false,
            canTransfer: false,
            canSetDefault: false,
            canClearDefault: false,
          },
          isDefault: false,
          isArchived: true,
          archivedAt: '2026-03-11T09:00:00.000Z',
          state: { field: 'path', value: 'root/c', group: '归档' },
        },
      ],
    })
    vi.mocked(batchPlmTeamFilterPresets).mockResolvedValue({
      action: 'archive',
      processedIds: ['preset-owned'],
      skippedIds: ['preset-readonly', 'preset-archived'],
      items: [
        {
          id: 'preset-owned',
          kind: 'bom',
          scope: 'team',
          name: '待批量归档',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          isArchived: true,
          archivedAt: '2026-03-11T10:00:00.000Z',
          state: { field: 'path', value: 'root/a', group: '机械' },
        },
      ],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/a', group: '机械' }),
      applyPreset,
      setMessage,
      requestedPresetId,
      syncRequestedPresetId,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()
    model.teamPresetKey.value = 'preset-owned'
    model.teamPresetOwnerUserId.value = 'owner-stale'
    model.teamPresetSelection.value = ['preset-owned', 'preset-readonly', 'preset-archived']

    await model.archiveTeamPresetSelection()

    expect(batchPlmTeamFilterPresets).toHaveBeenCalledWith('archive', ['preset-owned'])
    expect(model.teamPresetKey.value).toBe('')
    expect(model.teamPresetOwnerUserId.value).toBe('')
    expect(requestedPresetId.value).toBe('')
    expect(model.teamPresetSelection.value).toEqual(['preset-readonly', 'preset-archived'])
    expect(setMessage).toHaveBeenCalledWith('已批量归档BOM团队预设 1 项，跳过 2 项。')
  })

  it('keeps the canonical preset route owner when batch archiving a pending local selector target', async () => {
    const requestedPresetId = ref('preset-a')
    const syncRequestedPresetId = vi.fn((value?: string) => {
      requestedPresetId.value = value || ''
    })
    const trackedApply = vi.fn(() => requestedPresetId.value)

    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-a',
          kind: 'bom',
          scope: 'team',
          name: '已应用 BOM 预设',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: { field: 'path', value: 'root/a', group: 'A组' },
        },
        {
          id: 'preset-b',
          kind: 'bom',
          scope: 'team',
          name: '待归档 BOM 预设',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: { field: 'path', value: 'root/b', group: 'B组' },
        },
      ],
    })
    vi.mocked(batchPlmTeamFilterPresets).mockResolvedValue({
      action: 'archive',
      processedIds: ['preset-b'],
      skippedIds: [],
      items: [
        {
          id: 'preset-b',
          kind: 'bom',
          scope: 'team',
          name: '待归档 BOM 预设',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          isArchived: true,
          archivedAt: '2026-03-26T09:00:00.000Z',
          state: { field: 'path', value: 'root/b', group: 'B组' },
        },
      ],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/a', group: 'A组' }),
      applyPreset: trackedApply,
      setMessage,
      requestedPresetId,
      syncRequestedPresetId,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()
    trackedApply.mockClear()
    syncRequestedPresetId.mockClear()
    model.teamPresetKey.value = 'preset-b'
    model.teamPresetName.value = '临时草稿'
    model.teamPresetGroup.value = '临时分组'
    model.teamPresetOwnerUserId.value = 'owner-b'
    model.teamPresetSelection.value = ['preset-b']

    await model.archiveTeamPresetSelection()

    expect(batchPlmTeamFilterPresets).toHaveBeenCalledWith('archive', ['preset-b'])
    expect(syncRequestedPresetId).not.toHaveBeenCalled()
    expect(requestedPresetId.value).toBe('preset-a')
    expect(model.teamPresetKey.value).toBe('')
    expect(model.teamPresetName.value).toBe('')
    expect(model.teamPresetGroup.value).toBe('')
    expect(model.teamPresetOwnerUserId.value).toBe('')
    expect(model.teamPresetSelection.value).toEqual([])
    expect(trackedApply).not.toHaveBeenCalled()
  })

  it('clears stale readonly selections during refresh before batch actions run', async () => {
    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-readonly-refresh',
          kind: 'bom',
          scope: 'team',
          name: '刷新后只读',
          ownerUserId: 'other-user',
          canManage: false,
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
          state: { field: 'path', value: 'root/readonly', group: '只读组' },
        },
      ],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/readonly', group: '只读组' }),
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => false,
    })

    model.teamPresetSelection.value = ['preset-readonly-refresh']
    await model.refreshTeamPresets()

    expect(model.teamPresetSelection.value).toEqual([])
  })

  it('batch restores archived team presets and reapplies the restored explicit identity', async () => {
    const requestedPresetId = ref('preset-restore')
    const syncRequestedPresetId = vi.fn((value?: string) => {
      requestedPresetId.value = value || ''
    })
    const trackedApply = vi.fn(() => requestedPresetId.value)

    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-restore',
          kind: 'where-used',
          scope: 'team',
          name: '待恢复团队预设',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          isArchived: true,
          archivedAt: '2026-03-11T08:00:00.000Z',
          state: { field: 'parent', value: 'assy-01', group: '装配' },
        },
      ],
    })
    vi.mocked(batchPlmTeamFilterPresets).mockResolvedValue({
      action: 'restore',
      processedIds: ['preset-restore'],
      skippedIds: [],
      items: [
        {
          id: 'preset-restore',
          kind: 'where-used',
          scope: 'team',
          name: '待恢复团队预设',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          isArchived: false,
          state: { field: 'parent', value: 'assy-01', group: '装配' },
        },
      ],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'where-used',
      label: 'Where-Used',
      getCurrentPresetState: () => ({ field: 'parent', value: 'assy-01', group: '装配' }),
      applyPreset: trackedApply,
      setMessage,
      requestedPresetId,
      syncRequestedPresetId,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()
    model.teamPresetKey.value = 'preset-restore'
    model.teamPresetSelection.value = ['preset-restore']
    model.teamPresetName.value = '待清空名称'
    model.teamPresetGroup.value = '待清空分组'
    model.teamPresetOwnerUserId.value = 'owner-stale'

    await model.restoreTeamPresetSelection()

    expect(batchPlmTeamFilterPresets).toHaveBeenCalledWith('restore', ['preset-restore'])
    expect(syncRequestedPresetId).toHaveBeenLastCalledWith('preset-restore')
    expect(trackedApply).toHaveReturnedWith('preset-restore')
    expect(model.teamPresetKey.value).toBe('preset-restore')
    expect(model.teamPresets.value[0]?.isArchived).toBe(false)
    expect(model.teamPresetName.value).toBe('')
    expect(model.teamPresetGroup.value).toBe('')
    expect(model.teamPresetOwnerUserId.value).toBe('')
  })

  it('does not hijack the canonical preset route owner when batch restoring a pending local selector target', async () => {
    const requestedPresetId = ref('preset-a')
    const syncRequestedPresetId = vi.fn((value?: string) => {
      requestedPresetId.value = value || ''
    })
    const trackedApply = vi.fn(() => requestedPresetId.value)

    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-a',
          kind: 'bom',
          scope: 'team',
          name: '已应用 BOM 预设',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: { field: 'path', value: 'root/a', group: 'A组' },
        },
        {
          id: 'preset-b',
          kind: 'bom',
          scope: 'team',
          name: '待恢复 BOM 预设',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          isArchived: true,
          archivedAt: '2026-03-26T08:00:00.000Z',
          state: { field: 'path', value: 'root/b', group: 'B组' },
        },
      ],
    })
    vi.mocked(batchPlmTeamFilterPresets).mockResolvedValue({
      action: 'restore',
      processedIds: ['preset-b'],
      skippedIds: [],
      items: [
        {
          id: 'preset-b',
          kind: 'bom',
          scope: 'team',
          name: '待恢复 BOM 预设',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          isArchived: false,
          state: { field: 'path', value: 'root/b', group: 'B组' },
        },
      ],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/a', group: 'A组' }),
      applyPreset: trackedApply,
      setMessage,
      requestedPresetId,
      syncRequestedPresetId,
      shouldAutoApplyDefault: () => false,
    })

    await model.refreshTeamPresets()
    model.teamPresetKey.value = 'preset-b'
    model.teamPresetName.value = '待清空名称'
    model.teamPresetGroup.value = '待清空分组'
    model.teamPresetOwnerUserId.value = 'owner-stale'
    model.teamPresetSelection.value = ['preset-b']

    await model.restoreTeamPresetSelection()

    expect(batchPlmTeamFilterPresets).toHaveBeenCalledWith('restore', ['preset-b'])
    expect(syncRequestedPresetId).not.toHaveBeenCalledWith('preset-b')
    expect(requestedPresetId.value).toBe('preset-a')
    expect(model.teamPresetKey.value).toBe('preset-b')
    expect(model.teamPresetName.value).toBe('')
    expect(model.teamPresetGroup.value).toBe('')
    expect(model.teamPresetOwnerUserId.value).toBe('')
    expect(model.teamPresets.value.find((preset) => preset.id === 'preset-b')?.isArchived).toBe(false)
    expect(trackedApply).toHaveReturnedWith('preset-a')
  })

  it('does not reapply a restored team preset while a local preset owner still owns the current state', async () => {
    const requestedPresetId = ref('')
    const syncRequestedPresetId = vi.fn((value?: string) => {
      requestedPresetId.value = value || ''
    })
    const trackedApply = vi.fn()

    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-local-restore',
          kind: 'bom',
          scope: 'team',
          name: '待恢复 BOM 团队预设',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          isArchived: true,
          archivedAt: '2026-03-26T08:00:00.000Z',
          state: { field: 'path', value: 'root/team', group: '团队组' },
        },
      ],
    })
    vi.mocked(batchPlmTeamFilterPresets).mockResolvedValue({
      action: 'restore',
      processedIds: ['preset-local-restore'],
      skippedIds: [],
      items: [
        {
          id: 'preset-local-restore',
          kind: 'bom',
          scope: 'team',
          name: '待恢复 BOM 团队预设',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          isArchived: false,
          state: { field: 'path', value: 'root/team', group: '团队组' },
        },
      ],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'path', value: 'root/local', group: '本地组' }),
      applyPreset: trackedApply,
      setMessage,
      requestedPresetId,
      syncRequestedPresetId,
      shouldAutoApplyDefault: () => false,
      hasPendingExternalOwnerDrift: () => true,
    })

    await model.refreshTeamPresets()
    model.teamPresetKey.value = 'preset-local-restore'
    model.teamPresetSelection.value = ['preset-local-restore']
    model.teamPresetName.value = '待清空名称'
    model.teamPresetGroup.value = '待清空分组'
    model.teamPresetOwnerUserId.value = 'owner-stale'

    await model.restoreTeamPresetSelection()

    expect(batchPlmTeamFilterPresets).toHaveBeenCalledWith('restore', ['preset-local-restore'])
    expect(trackedApply).not.toHaveBeenCalled()
    expect(syncRequestedPresetId).not.toHaveBeenCalled()
    expect(model.teamPresetKey.value).toBe('preset-local-restore')
    expect(model.teamPresets.value.find((preset) => preset.id === 'preset-local-restore')?.isArchived).toBe(false)
    expect(model.teamPresetName.value).toBe('')
    expect(model.teamPresetGroup.value).toBe('')
    expect(model.teamPresetOwnerUserId.value).toBe('')
  })

  it('shares the current team preset through an explicit deep link without changing identity', async () => {
    const buildShareUrl = vi.fn(() => 'http://example.test/plm?panel=bom&bomTeamPreset=preset-share')
    const copyShareUrl = vi.fn(async () => true)

    vi.mocked(listPlmTeamFilterPresets).mockResolvedValue({
      items: [
        {
          id: 'preset-share',
          kind: 'bom',
          scope: 'team',
          name: '共享 BOM',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: { field: 'path', value: 'root/shared', group: '共享组' },
        },
      ],
    })

    const model = usePlmTeamFilterPresets({
      kind: 'bom',
      label: 'BOM',
      getCurrentPresetState: () => ({ field: 'all', value: '', group: '' }),
      applyPreset,
      setMessage,
      shouldAutoApplyDefault: () => false,
      buildShareUrl,
      copyShareUrl,
    })

    await model.refreshTeamPresets()
    model.teamPresetKey.value = 'preset-share'

    await model.shareTeamPreset()

    expect(model.canShareTeamPreset.value).toBe(true)
    expect(buildShareUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'preset-share',
        name: '共享 BOM',
      }),
    )
    expect(copyShareUrl).toHaveBeenCalledWith(
      'http://example.test/plm?panel=bom&bomTeamPreset=preset-share',
    )
    expect(model.teamPresetKey.value).toBe('preset-share')
    expect(setMessage).toHaveBeenCalledWith('已复制BOM团队预设分享链接。')
  })
})
