import { describe, expect, it } from 'vitest'
import { resolvePlmLocalFilterPresetRouteIdentity } from '../src/views/plm/plmLocalFilterPresetRouteIdentity'

describe('plmLocalFilterPresetRouteIdentity', () => {
  it('keeps the route owner when the live filter still matches the preset snapshot', () => {
    expect(resolvePlmLocalFilterPresetRouteIdentity({
      routePresetKey: 'bom:shared',
      selectedPresetKey: 'bom:shared',
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
      shouldClear: false,
    })
  })

  it('clears both query owner and selector when the stale route owner still owns the selector', () => {
    expect(resolvePlmLocalFilterPresetRouteIdentity({
      routePresetKey: 'bom:shared',
      selectedPresetKey: 'bom:shared',
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
      shouldClear: true,
    })
  })

  it('clears only the stale route owner when the user already has a different pending selector target', () => {
    expect(resolvePlmLocalFilterPresetRouteIdentity({
      routePresetKey: 'bom:shared',
      selectedPresetKey: 'bom:pending',
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
      shouldClear: true,
    })
  })

  it('can preserve the selected key when an imported preset updates the stale route owner in place', () => {
    expect(resolvePlmLocalFilterPresetRouteIdentity({
      routePresetKey: 'bom:shared',
      selectedPresetKey: 'bom:shared',
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
      shouldClear: true,
    })
  })
})
