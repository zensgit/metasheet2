/**
 * A2 shortcut config governance + prompt assembly — unit legs of A2-T11 / A2-T4
 * (docs/development/multitable-ai-shortcut-backend-a2-design-20260611.md §2.1).
 *
 * Locked caps: options ≤50 items × each ≤100 chars; targetLang ≤32 chars;
 * instruction ≤500 chars. Source fields must exist on the sheet and be
 * non-computed (formula/lookup/rollup rejected). Prompts are SERVER-SIDE
 * templates per kind — user data enters slots only.
 */
import { describe, expect, it } from 'vitest'

import {
  AI_SHORTCUT_KINDS,
  AI_SHORTCUT_MAX_INSTRUCTION_LENGTH,
  AI_SHORTCUT_MAX_OPTIONS,
  AI_SHORTCUT_MAX_OPTION_LENGTH,
  AI_SHORTCUT_MAX_TARGET_LANG_LENGTH,
  buildAiShortcutPrompt,
  parseAiShortcutConfig,
  validateAiShortcutFieldProperty,
  validateAiShortcutSourceFields,
  type AiShortcutConfig,
} from '../../src/multitable/ai-shortcut-config'

const VALID = { kind: 'summarize', sourceFieldIds: ['fld_a'] }

function expectError(value: unknown, fragment: string) {
  const parsed = parseAiShortcutConfig(value)
  expect(parsed.ok).toBe(false)
  if (!parsed.ok) expect(parsed.error).toContain(fragment)
}

describe('parseAiShortcutConfig (A2-T11 shape governance)', () => {
  it('accepts the four ratified kinds', () => {
    expect(AI_SHORTCUT_KINDS).toEqual(['summarize', 'classify', 'extract', 'translate'])
    for (const kind of AI_SHORTCUT_KINDS) {
      const parsed = parseAiShortcutConfig({ kind, sourceFieldIds: ['fld_a'] })
      expect(parsed.ok).toBe(true)
    }
  })

  it('rejects a bad kind', () => {
    expectError({ kind: 'imagine', sourceFieldIds: ['fld_a'] }, 'kind')
  })

  it('rejects non-object / missing sourceFieldIds / empty sourceFieldIds', () => {
    expectError('summarize', 'aiShortcut')
    expectError({ kind: 'summarize' }, 'sourceFieldIds')
    expectError({ kind: 'summarize', sourceFieldIds: [] }, 'sourceFieldIds')
    expectError({ kind: 'summarize', sourceFieldIds: ['fld_a', 7] }, 'sourceFieldIds')
  })

  it('enforces the locked params caps (options ≤50×100, targetLang ≤32, instruction ≤500)', () => {
    expectError(
      { ...VALID, kind: 'classify', params: { options: Array.from({ length: AI_SHORTCUT_MAX_OPTIONS + 1 }, (_, i) => `c${i}`) } },
      'options',
    )
    expectError(
      { ...VALID, kind: 'classify', params: { options: ['x'.repeat(AI_SHORTCUT_MAX_OPTION_LENGTH + 1)] } },
      'options',
    )
    expectError(
      { ...VALID, kind: 'translate', params: { targetLang: 'x'.repeat(AI_SHORTCUT_MAX_TARGET_LANG_LENGTH + 1) } },
      'targetLang',
    )
    expectError(
      { ...VALID, params: { instruction: 'x'.repeat(AI_SHORTCUT_MAX_INSTRUCTION_LENGTH + 1) } },
      'instruction',
    )
    // boundary values pass
    const ok = parseAiShortcutConfig({
      kind: 'classify',
      sourceFieldIds: ['fld_a'],
      params: {
        options: Array.from({ length: AI_SHORTCUT_MAX_OPTIONS }, (_, i) => `c${i}`),
        targetLang: 'x'.repeat(AI_SHORTCUT_MAX_TARGET_LANG_LENGTH),
        instruction: 'x'.repeat(AI_SHORTCUT_MAX_INSTRUCTION_LENGTH),
      },
    })
    expect(ok.ok).toBe(true)
  })

  it('rejects unknown params keys (nothing unscanned can ride along)', () => {
    expectError({ ...VALID, params: { systemPrompt: 'override' } }, 'params')
  })
})

describe('validateAiShortcutSourceFields (exists + non-computed)', () => {
  const fieldTypeById = new Map<string, string>([
    ['fld_a', 'string'],
    ['fld_num', 'number'],
    ['fld_formula', 'formula'],
    ['fld_lookup', 'lookup'],
    ['fld_rollup', 'rollup'],
  ])

  const config = (ids: string[]): AiShortcutConfig => ({ kind: 'summarize', sourceFieldIds: ids, params: {} })

  it('accepts plain existing fields', () => {
    expect(validateAiShortcutSourceFields(config(['fld_a', 'fld_num']), fieldTypeById)).toBeNull()
  })

  it('rejects a missing source field', () => {
    expect(validateAiShortcutSourceFields(config(['fld_ghost']), fieldTypeById)).toContain('fld_ghost')
  })

  it('rejects computed source fields (formula / lookup / rollup)', () => {
    for (const id of ['fld_formula', 'fld_lookup', 'fld_rollup']) {
      expect(validateAiShortcutSourceFields(config([id]), fieldTypeById)).toContain(id)
    }
  })
})

describe('validateAiShortcutFieldProperty (field create/update chokepoint)', () => {
  const queryReturning = (rows: unknown[]) => async () => ({ rows })

  it('returns null when the property has no aiShortcut key', async () => {
    expect(await validateAiShortcutFieldProperty(queryReturning([]), 'sheet_1', {})).toBeNull()
    expect(await validateAiShortcutFieldProperty(queryReturning([]), 'sheet_1', undefined)).toBeNull()
  })

  it('surfaces a parse error for a bad kind', async () => {
    const error = await validateAiShortcutFieldProperty(queryReturning([]), 'sheet_1', {
      aiShortcut: { kind: 'imagine', sourceFieldIds: ['fld_a'] },
    })
    expect(error).toContain('kind')
  })

  it('surfaces a missing source field against the sheet', async () => {
    const error = await validateAiShortcutFieldProperty(queryReturning([]), 'sheet_1', {
      aiShortcut: { kind: 'summarize', sourceFieldIds: ['fld_a'] },
    })
    expect(error).toContain('fld_a')
  })

  it('passes a valid config whose sources exist and are non-computed', async () => {
    const query = queryReturning([{ id: 'fld_a', type: 'string' }])
    const error = await validateAiShortcutFieldProperty(query, 'sheet_1', {
      aiShortcut: { kind: 'summarize', sourceFieldIds: ['fld_a'] },
    })
    expect(error).toBeNull()
  })
})

describe('buildAiShortcutPrompt (server-side templates, data into slots only)', () => {
  it('summarize: includes the task header and labeled source values', () => {
    const parsed = parseAiShortcutConfig({ kind: 'summarize', sourceFieldIds: ['fld_a'] })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const prompt = buildAiShortcutPrompt(parsed.config, [{ name: 'Notes', value: 'hello world' }])
    expect(prompt).toContain('summary')
    expect(prompt).toContain('Notes: hello world')
  })

  it('classify: lists the allowed options', () => {
    const parsed = parseAiShortcutConfig({ kind: 'classify', sourceFieldIds: ['fld_a'], params: { options: ['red', 'blue'] } })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const prompt = buildAiShortcutPrompt(parsed.config, [{ name: 'Color note', value: 'crimson-ish' }])
    expect(prompt).toContain('red')
    expect(prompt).toContain('blue')
  })

  it('translate: carries targetLang; extract: carries instruction', () => {
    const translate = parseAiShortcutConfig({ kind: 'translate', sourceFieldIds: ['fld_a'], params: { targetLang: 'French' } })
    expect(translate.ok).toBe(true)
    if (translate.ok) {
      expect(buildAiShortcutPrompt(translate.config, [{ name: 'Body', value: 'hi' }])).toContain('French')
    }
    const extract = parseAiShortcutConfig({ kind: 'extract', sourceFieldIds: ['fld_a'], params: { instruction: 'find the date' } })
    expect(extract.ok).toBe(true)
    if (extract.ok) {
      expect(buildAiShortcutPrompt(extract.config, [{ name: 'Body', value: 'due 2026-06-11' }])).toContain('find the date')
    }
  })

  it('stringifies structured values and tolerates null', () => {
    const parsed = parseAiShortcutConfig({ kind: 'summarize', sourceFieldIds: ['fld_a', 'fld_b'] })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const prompt = buildAiShortcutPrompt(parsed.config, [
      { name: 'Tags', value: ['a', 'b'] },
      { name: 'Empty', value: null },
    ])
    expect(prompt).toContain('["a","b"]')
    expect(prompt).toContain('Empty:')
  })
})
