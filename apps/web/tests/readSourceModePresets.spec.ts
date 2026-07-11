import { describe, expect, it } from 'vitest'
import {
  READ_SOURCE_MODE_PRESETS,
  readSourceModePreset,
} from '../src/services/integration/readSourceModePresets'
import {
  READ_SOURCE_MODE_REQUIRED_FIELDS,
  READ_SOURCE_MODES,
} from '../src/services/integration/readSourceConfigs'

// IU-3 preset-module tripwire (design-lock
// docs/development/integration-iu3-read-source-wizard-design-lock-20260707.md §2/§3, #3797):
// the preset cards are a PRESENTATION mapping over the four existing READ_SOURCE_MODES values —
// this spec is the anti-drift gate. If a future change adds a mode to READ_SOURCE_MODES without a
// preset card, or lets a card's requiredFieldKeys diverge from the REAL
// READ_SOURCE_MODE_REQUIRED_FIELDS constant, these tests go red.

describe('readSourceModePresets (IU-3 tripwire)', () => {
  it('every mode in READ_SOURCE_MODES has exactly one preset card, in the same canonical order', () => {
    // Set-equality in BOTH directions: a mode without a card fails, and a card whose id is not a
    // registered mode fails. Order preserved so wizards/tests can rely on the canonical sequence.
    expect(READ_SOURCE_MODE_PRESETS.map((preset) => preset.id)).toEqual([...READ_SOURCE_MODES])
  })

  it('every card requiredFieldKeys === READ_SOURCE_MODE_REQUIRED_FIELDS[mode] (the real constant, not a copy)', () => {
    for (const preset of READ_SOURCE_MODE_PRESETS) {
      // toBe (identity), not just toEqual: the module must expose the REAL constant's array — a
      // hand-maintained copy that happens to match today would still fail here, by design.
      expect(preset.requiredFieldKeys, preset.id).toBe(READ_SOURCE_MODE_REQUIRED_FIELDS[preset.id])
      expect(preset.requiredFieldKeys, preset.id).toEqual(READ_SOURCE_MODE_REQUIRED_FIELDS[preset.id])
    }
  })

  it('every card carries non-empty zh+en title and one-liner (values-free presentation copy)', () => {
    for (const preset of READ_SOURCE_MODE_PRESETS) {
      expect(preset.title.zh.trim().length, `${preset.id} title.zh`).toBeGreaterThan(0)
      expect(preset.title.en.trim().length, `${preset.id} title.en`).toBeGreaterThan(0)
      expect(preset.oneLiner.zh.trim().length, `${preset.id} oneLiner.zh`).toBeGreaterThan(0)
      expect(preset.oneLiner.en.trim().length, `${preset.id} oneLiner.en`).toBeGreaterThan(0)
    }
  })

  it('readSourceModePreset() resolves each registered mode and throws on an unknown one', () => {
    for (const mode of READ_SOURCE_MODES) {
      expect(readSourceModePreset(mode).id).toBe(mode)
    }
    expect(() => readSourceModePreset('bulk_export' as (typeof READ_SOURCE_MODES)[number])).toThrow(/unknown read-source mode/)
  })
})
