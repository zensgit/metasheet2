// IU-3 read-source config wizard — preset card metadata (design-lock
// docs/development/integration-iu3-read-source-wizard-design-lock-20260707.md, #3797, §2).
//
// Presentation-layer mapping ONLY, over the four EXISTING `READ_SOURCE_MODES` values — this module
// invents NO new mode and NO new required-field vocabulary. `requiredFieldKeys` is read straight off
// the real source of truth (`readSourceConfigs.ts` `READ_SOURCE_MODE_REQUIRED_FIELDS`), never a
// hand-copied list, so a future change to that constant cannot silently drift from what the wizard
// displays as "the fields this mode needs".
//
// The preset array is BUILT FROM `READ_SOURCE_MODES` (not `Object.keys(PRESET_COPY)`) so a future mode
// added there with no matching card throws here at import time — fails loudly in dev/build rather
// than silently rendering an incomplete card deck. `readSourceModePresets.spec.ts` also asserts this
// as an explicit tripwire (mode-set coverage + requiredFieldKeys deep-equality against the real
// constant), per the design-lock's "未来加 mode 未配卡片则红" acceptance clause.
//
// values-free (design-lock §2/§3): titles/one-liners describe the SHAPE of a read (single record /
// paged list / header-with-lines / rule-resolved lookup) only — no business value example (material
// number, BOM number, etc.) ever appears here. Same zh+en discipline as errorCodeLabels.ts/fieldHints.ts.

import { READ_SOURCE_MODE_REQUIRED_FIELDS, READ_SOURCE_MODES, type ReadSourceMode } from './readSourceConfigs'

export type ReadSourceModePresetCopy = { zh: string; en: string }

export interface ReadSourceModePreset {
  id: ReadSourceMode
  title: ReadSourceModePresetCopy
  oneLiner: ReadSourceModePresetCopy
  requiredFieldKeys: string[]
}

const PRESET_COPY: Record<ReadSourceMode, { title: ReadSourceModePresetCopy; oneLiner: ReadSourceModePresetCopy }> = {
  single_record: {
    title: { zh: '单记录读', en: 'Single record' },
    oneLiner: {
      zh: '按业务键定位并读取单条记录。',
      en: 'Locates and reads exactly one record by its business key.',
    },
  },
  list_page: {
    title: { zh: '列表分页读', en: 'Paged list' },
    oneLiner: {
      zh: '按分页读取一组记录列表，不按单个业务键定位。',
      en: 'Reads a paged list of records, without locating by a single business key.',
    },
  },
  detail_with_lines: {
    title: { zh: '主从明细读', en: 'Header with lines' },
    oneLiner: {
      zh: '同时读取一条表头记录与其对应的明细行数组。',
      en: 'Reads one header record together with its associated line-item array.',
    },
  },
  resolver_lookup: {
    title: { zh: '解析定位读', en: 'Resolver lookup' },
    oneLiner: {
      zh: '候选记录可能不止一条时，按规则解析定位出唯一一条。',
      en: 'When more than one candidate record may match, resolves a single one by rule.',
    },
  },
}

// Exported (not just internal) so the wizard/tests can iterate cards in the canonical mode order
// without re-deriving it from `Object.keys`.
export const READ_SOURCE_MODE_PRESETS: readonly ReadSourceModePreset[] = READ_SOURCE_MODES.map((mode) => {
  const copy = PRESET_COPY[mode]
  if (!copy) {
    // Fails loudly at import time — see module header. A future mode must get a PRESET_COPY entry
    // in the same change that adds it to READ_SOURCE_MODES, or every consumer of this module breaks
    // immediately (not silently).
    throw new Error(`readSourceModePresets: no preset copy registered for read-source mode "${mode}"`)
  }
  return {
    id: mode,
    title: copy.title,
    oneLiner: copy.oneLiner,
    // Real source of truth, not a copy — see module header.
    requiredFieldKeys: READ_SOURCE_MODE_REQUIRED_FIELDS[mode],
  }
})

const PRESETS_BY_ID = new Map<ReadSourceMode, ReadSourceModePreset>(
  READ_SOURCE_MODE_PRESETS.map((preset) => [preset.id, preset]),
)

export function readSourceModePreset(mode: ReadSourceMode): ReadSourceModePreset {
  const preset = PRESETS_BY_ID.get(mode)
  if (!preset) {
    throw new Error(`readSourceModePresets: unknown read-source mode "${mode}"`)
  }
  return preset
}
