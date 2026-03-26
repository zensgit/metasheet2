import { describe, expect, it } from 'vitest'
import {
  buildPlmLocalFilterPresetRouteOwnerWatchKey,
  resolvePlmLocalFilterPresetRouteIdentity,
} from '../src/views/plm/plmLocalFilterPresetRouteIdentity'

describe('plmLocalFilterPresetRouteIdentity', () => {
  it('keeps the route owner when the live filter still matches the preset snapshot', () => {
    expect(resolvePlmLocalFilterPresetRouteIdentity({
      routePresetKey: 'bom:shared',
      selectedPresetKey: 'bom:shared',
      nameDraft: '共享 BOM',
      groupDraft: '机械',
      activePreset: {
        key: 'bom:shared',
        label: '共享 BOM',
        field: 'path',
        value: 'root/a',
        group: '机械',
      },
      currentState: {
        field: 'path',
        value: 'root/a',
      },
    })).toEqual({
      nextRoutePresetKey: 'bom:shared',
      nextSelectedPresetKey: 'bom:shared',
      nextNameDraft: '共享 BOM',
      nextGroupDraft: '机械',
      shouldClear: false,
    })
  })

  it('clears both query owner and selector when the stale route owner still owns the selector', () => {
    expect(resolvePlmLocalFilterPresetRouteIdentity({
      routePresetKey: 'bom:shared',
      selectedPresetKey: 'bom:shared',
      nameDraft: '共享 BOM 草稿',
      groupDraft: '机械草稿',
      activePreset: {
        key: 'bom:shared',
        label: '共享 BOM',
        field: 'path',
        value: 'root/a',
      },
      currentState: {
        field: 'path',
        value: 'root/b',
      },
    })).toEqual({
      nextRoutePresetKey: '',
      nextSelectedPresetKey: '',
      nextNameDraft: '',
      nextGroupDraft: '',
      shouldClear: true,
    })
  })

  it('clears only the stale route owner when the user already has a different pending selector target', () => {
    expect(resolvePlmLocalFilterPresetRouteIdentity({
      routePresetKey: 'bom:shared',
      selectedPresetKey: 'bom:pending',
      nameDraft: '待应用 BOM',
      groupDraft: '待应用分组',
      activePreset: {
        key: 'bom:shared',
        label: '共享 BOM',
        field: 'path',
        value: 'root/a',
      },
      currentState: {
        field: 'path',
        value: 'root/c',
      },
    })).toEqual({
      nextRoutePresetKey: '',
      nextSelectedPresetKey: 'bom:pending',
      nextNameDraft: '待应用 BOM',
      nextGroupDraft: '待应用分组',
      shouldClear: true,
    })
  })

  it('can preserve the selected key when an imported preset updates the stale route owner in place', () => {
    expect(resolvePlmLocalFilterPresetRouteIdentity({
      routePresetKey: 'bom:shared',
      selectedPresetKey: 'bom:shared',
      nameDraft: '共享 BOM 新版',
      groupDraft: '导入分组',
      activePreset: {
        key: 'bom:shared',
        label: '共享 BOM',
        field: 'path',
        value: 'root/b',
      },
      currentState: {
        field: 'path',
        value: 'root/a',
      },
      preserveSelectedPresetKeyOnClear: true,
    })).toEqual({
      nextRoutePresetKey: '',
      nextSelectedPresetKey: 'bom:shared',
      nextNameDraft: '共享 BOM 新版',
      nextGroupDraft: '导入分组',
      shouldClear: true,
    })
  })

  it('changes the route-owner watch key when an imported preset updates the same key in place', () => {
    expect(buildPlmLocalFilterPresetRouteOwnerWatchKey({
      key: 'bom:shared',
      label: '共享 BOM',
      field: 'path',
      value: 'root/a',
    })).not.toBe(buildPlmLocalFilterPresetRouteOwnerWatchKey({
      key: 'bom:shared',
      label: '共享 BOM',
      field: 'path',
      value: 'root/b',
    }))
  })
})
