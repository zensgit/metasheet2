import { describe, expect, it, vi } from 'vitest'
import type { FilterPreset } from '../src/views/plm/plmPanelModels'
import {
  applyFilterPreset,
  buildDuplicateFilterPresetLabel,
  buildFilterPresetShareUrl,
  buildTeamFilterPresetShareUrl,
  decodeFilterPresetSharePayload,
  duplicateFilterPreset,
  exportFilterPresetsFile,
  loadStoredFilterPresets,
  mergeImportedFilterPresets,
  parseFilterPresetImport,
  persistFilterPresets,
  renameFilterPreset,
  resolveFilterPresetCatalogDraftState,
  resolveFilterPresetShareMode,
  upsertFilterPreset,
} from '../src/views/plm/plmFilterPresetUtils'

describe('plmFilterPresetUtils', () => {
  it('upserts and resolves presets by label and key', () => {
    const empty: FilterPreset[] = []
    const created = upsertFilterPreset(empty, '关键件', 'all', 'motor', '机械', 'bom')

    expect(created.presets).toHaveLength(1)
    expect(created.key).toBeTruthy()
    expect(applyFilterPreset(created.presets, created.key)?.label).toBe('关键件')

    const updated = upsertFilterPreset(created.presets, '关键件', 'path', 'root/motor', '电机', 'bom')

    expect(updated.presets).toHaveLength(1)
    expect(updated.presets[0]).toMatchObject({
      field: 'path',
      value: 'root/motor',
      group: '电机',
    })
  })

  it('parses, merges, persists, and shares filter presets', () => {
    const storage = {
      value: '',
      getItem: vi.fn(() => storage.value),
      setItem: vi.fn((_: string, next: string) => {
        storage.value = next
      }),
    }

    const imported = parseFilterPresetImport(
      JSON.stringify([
        { label: '关键件', field: 'path', value: 'root/a', group: '机械' },
        { label: '关键件', field: 'path', value: 'root/b', group: '电机' },
        { label: '可导入', field: 'bad-field', value: 'root/c', group: '' },
      ]),
      [{ value: 'all' }, { value: 'path' }],
    )

    expect(imported.entries).toHaveLength(2)
    expect(imported.duplicateCount).toBe(1)
    expect(imported.entries[1]).toMatchObject({ field: 'all' })

    const merged = mergeImportedFilterPresets(
      imported.entries,
      [{ key: 'existing', label: '关键件', field: 'all', value: 'old', group: '' }],
      'where-used',
      'merge',
    )

    expect(merged.added).toBe(1)
    expect(merged.updated).toBe(1)

    persistFilterPresets('plm:test', merged.presets, storage)
    const reloaded = loadStoredFilterPresets('plm:test', storage)

    expect(reloaded).toHaveLength(2)

    const shared = buildFilterPresetShareUrl('bom', reloaded[0]!, 'replace', '/plm', 'http://example.test')
    const encoded = new URL(shared).searchParams.get('bomPresetShare')

    expect(resolveFilterPresetShareMode('replace')).toBe('replace')
    expect(resolveFilterPresetShareMode('other')).toBe('merge')
    expect(decodeFilterPresetSharePayload(String(encoded), [{ value: 'all' }, { value: 'path' }])).toMatchObject({
      label: reloaded[0]!.label,
      value: reloaded[0]!.value,
    })
  })

  it('builds explicit team preset share links that preserve collaborative identity', () => {
    const bomUrl = buildTeamFilterPresetShareUrl(
      'bom',
      {
        id: 'bom-team-1',
        kind: 'bom',
        scope: 'team',
        name: '关键 BOM',
        ownerUserId: 'dev-user',
        canManage: true,
        isDefault: false,
        state: { field: 'path', value: 'root/a', group: '机械' },
      },
      '/plm',
      'bom',
      'http://example.test',
    )
    const whereUsedUrl = buildTeamFilterPresetShareUrl(
      'where-used',
      {
        id: 'wu-team-1',
        kind: 'where-used',
        scope: 'team',
        name: '共享父件',
        ownerUserId: 'dev-user',
        canManage: true,
        isDefault: false,
        state: { field: 'all', value: 'assy-01', group: '' },
      },
      '/plm',
      'where-used',
      'http://example.test',
    )

    const bomParams = new URL(bomUrl).searchParams
    expect(bomParams.get('panel')).toBe('product')
    expect(bomParams.get('bomTeamPreset')).toBe('bom-team-1')
    expect(bomParams.get('bomFilter')).toBe('root/a')
    expect(bomParams.get('bomFilterField')).toBe('path')

    const whereUsedParams = new URL(whereUsedUrl).searchParams
    expect(whereUsedParams.get('panel')).toBe('where-used')
    expect(whereUsedParams.get('whereUsedTeamPreset')).toBe('wu-team-1')
    expect(whereUsedParams.get('whereUsedFilter')).toBe('assy-01')
    expect(whereUsedParams.get('whereUsedFilterField')).toBeNull()
  })

  it('clears stale local preset drafts when the selected preset disappears from the catalog', () => {
    expect(resolveFilterPresetCatalogDraftState({
      availablePresets: [
        { key: 'bom:2' },
      ],
      selectedPresetKey: ' bom:1 ',
      routePresetKey: ' bom:1 ',
      nameDraft: '旧 BOM 预设',
      groupDraft: '机械',
    })).toEqual({
      nextSelectedPresetKey: '',
      nextRoutePresetKey: '',
      nextNameDraft: '',
      nextGroupDraft: '',
    })
  })

  it('preserves local preset drafts when the selected preset survives but the route owner goes stale', () => {
    expect(resolveFilterPresetCatalogDraftState({
      availablePresets: [
        { key: 'bom:2' },
      ],
      selectedPresetKey: ' bom:2 ',
      routePresetKey: ' bom:1 ',
      nameDraft: '新的 BOM 预设',
      groupDraft: '电机',
    })).toEqual({
      nextSelectedPresetKey: 'bom:2',
      nextRoutePresetKey: '',
      nextNameDraft: '新的 BOM 预设',
      nextGroupDraft: '电机',
    })
  })

  it('duplicates and renames presets while preserving explicit identity semantics', () => {
    const presets: FilterPreset[] = [
      { key: 'bom:1', label: '关键件', field: 'component', value: 'motor', group: '机械' },
      { key: 'bom:2', label: '关键件 副本', field: 'component', value: 'motor-copy', group: '机械' },
    ]

    expect(buildDuplicateFilterPresetLabel(presets, '关键件')).toBe('关键件 副本 2')

    const duplicated = duplicateFilterPreset(presets, 'bom:1', 'bom')
    expect(duplicated.preset).toMatchObject({
      label: '关键件 副本 2',
      field: 'component',
      value: 'motor',
      group: '机械',
    })
    expect(duplicated.preset?.key).not.toBe('bom:1')

    const renamed = renameFilterPreset(duplicated.presets, 'bom:1', '关键件-重命名')
    expect(renamed.error).toBeUndefined()
    expect(renamed.preset).toMatchObject({
      key: 'bom:1',
      label: '关键件-重命名',
    })

    const duplicateName = renameFilterPreset(duplicated.presets, 'bom:1', '关键件 副本')
    expect(duplicateName.error).toBe('duplicate')

    const emptyName = renameFilterPreset(duplicated.presets, 'bom:1', '   ')
    expect(emptyName.error).toBe('empty')
  })

  it('exports presets through a DOM link when presets exist', () => {
    const click = vi.fn()
    const anchor = { href: '', download: '', click } as unknown as HTMLAnchorElement
    const documentRef = {
      createElement: vi.fn(() => anchor),
    } as unknown as Document
    const urlRef = {
      createObjectURL: vi.fn(() => 'blob:plm'),
      revokeObjectURL: vi.fn(),
    }

    const ok = exportFilterPresetsFile(
      [{ key: 'bom:1', label: '关键件', field: 'all', value: 'motor', group: '' }],
      'plm-bom-filter-presets',
      documentRef,
      urlRef,
    )

    expect(ok).toBe(true)
    expect(click).toHaveBeenCalled()
    expect(urlRef.revokeObjectURL).toHaveBeenCalledWith('blob:plm')
  })
})
