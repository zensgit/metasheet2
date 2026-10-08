import { describe, expect, test } from 'vitest'

import {
  PLUGIN_SHEET_SCOPE_MODE_ENV,
  resolvePluginSheetScopeMode,
} from '../pluginSheetScopeMode'

describe('plugin sheet-scope enforcement mode (P0-S S4)', () => {
  test('env key name is the documented flag', () => {
    expect(PLUGIN_SHEET_SCOPE_MODE_ENV).toBe('MULTITABLE_PLUGIN_SHEET_SCOPE_MODE')
  })

  test('unset defaults to observe (non-breaking)', () => {
    expect(resolvePluginSheetScopeMode({})).toBe('observe')
  })

  test.each(['', 'ENFORCE', 'Enforce', 'observe', 'strict', 'true', '1'])(
    'only exact "enforce" hardens; %j => observe',
    (value) => {
      expect(resolvePluginSheetScopeMode({ [PLUGIN_SHEET_SCOPE_MODE_ENV]: value })).toBe('observe')
    },
  )

  test('exact "enforce" is honored', () => {
    expect(resolvePluginSheetScopeMode({ [PLUGIN_SHEET_SCOPE_MODE_ENV]: 'enforce' })).toBe('enforce')
  })
})
