import { describe, expect, it } from 'vitest'
import {
  BRIDGE_AGENT_CONFIG_CHECK_LABELS,
  bridgeAgentConfigCheckLabel,
  buildBridgeAgentChangeSuggestion,
  buildImplementationChecklist,
  computeBridgeAgentConfigCheck,
  type BridgeAgentConfigCheckItem,
  type BridgeAgentConfigCheckLabelKey,
  type BridgeAgentSuggestionObjectDraft,
} from '../src/services/integration/bridgeAgentConfigCheck'

// BA-UI-3 (docs/development/bridge-agent-admin-page-design-lock-20260707.md §3 BA-UI-3): pure-util
// spec for the config-validation checklist + change-suggestion builder. Pure, framework-free module —
// no DOM, no Vue, no fetch. Sentinel discipline mirrors IntegrationBridgeAgentSection.spec.ts: plant a
// secret/host-shaped string in every surface this module reads (system.config for the checklist,
// operator-typed drafts for the suggestion builder) and assert it never reaches any output string.

const SENTINEL_HOST_URL = 'http://10.0.0.9:19091/'
const SENTINEL_SECRET = 'SENTINEL-CONFIG-sk-a1b2c3d4e5'
const SENTINEL_CONNECTION_STRING = 'Server=10.0.0.9;Database=K3;Password=SENTINEL-PW-x7y8z9;'

function itemFor(items: BridgeAgentConfigCheckItem[], id: BridgeAgentConfigCheckItem['id']): BridgeAgentConfigCheckItem {
  const item = items.find((entry) => entry.id === id)
  if (!item) throw new Error(`missing checklist item: ${id}`)
  return item
}

describe('computeBridgeAgentConfigCheck', () => {
  it('returns exactly the 6 fixed items, in a stable order, for a fully-sane config', () => {
    const items = computeBridgeAgentConfigCheck({
      config: { baseUrl: 'http://127.0.0.1:19091/', authMode: 'shared-secret', sampleLimit: 3, maxLimit: 20 },
      objectNames: ['material', 'bom', 'bom_child'],
    })
    expect(items.map((item) => item.id)).toEqual([
      'requiredFields', 'limits', 'authMode', 'localhostBoundary', 'rawSqlForbidden', 'objectAllowlist',
    ])
    for (const item of items) {
      expect(item.status).toBe('pass')
    }
  })

  it('never throws on absent/malformed config or objectNames', () => {
    expect(() => computeBridgeAgentConfigCheck({})).not.toThrow()
    expect(() => computeBridgeAgentConfigCheck({ config: null, objectNames: null })).not.toThrow()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => computeBridgeAgentConfigCheck({ config: 'not-an-object' as any, objectNames: 'not-an-array' as any })).not.toThrow()
    const items = computeBridgeAgentConfigCheck({})
    expect(items).toHaveLength(6)
    expect(itemFor(items, 'requiredFields').status).toBe('fail')
    expect(itemFor(items, 'objectAllowlist').status).toBe('warn')
  })

  // --- requiredFields --------------------------------------------------------------------------
  describe('requiredFields', () => {
    it('passes when baseUrl is present', () => {
      const item = itemFor(computeBridgeAgentConfigCheck({ config: { baseUrl: 'http://127.0.0.1:19091/' } }), 'requiredFields')
      expect(item.status).toBe('pass')
      expect(item.labelKey).toBe('requiredFields.present')
    })
    it('falls back to bridgeUrl, then url', () => {
      expect(itemFor(computeBridgeAgentConfigCheck({ config: { bridgeUrl: 'http://127.0.0.1:19091/' } }), 'requiredFields').status).toBe('pass')
      expect(itemFor(computeBridgeAgentConfigCheck({ config: { url: 'http://127.0.0.1:19091/' } }), 'requiredFields').status).toBe('pass')
    })
    it('fails when none of baseUrl/bridgeUrl/url is a non-empty string', () => {
      const item = itemFor(computeBridgeAgentConfigCheck({ config: { baseUrl: '   ' } }), 'requiredFields')
      expect(item.status).toBe('fail')
      expect(item.labelKey).toBe('requiredFields.missing')
    })
  })

  // --- limits ------------------------------------------------------------------------------------
  describe('limits', () => {
    it('passes when unconfigured (defaults apply)', () => {
      expect(itemFor(computeBridgeAgentConfigCheck({ config: {} }), 'limits').status).toBe('pass')
    })
    it('passes when configured sanely', () => {
      expect(itemFor(computeBridgeAgentConfigCheck({ config: { sampleLimit: 5, maxLimit: 50 } }), 'limits').status).toBe('pass')
    })
    it('fails on an invalid-shaped sampleLimit (not a positive integer)', () => {
      const item = itemFor(computeBridgeAgentConfigCheck({ config: { sampleLimit: -1 } }), 'limits')
      expect(item.status).toBe('fail')
      expect(item.labelKey).toBe('limits.fail')
      expect(itemFor(computeBridgeAgentConfigCheck({ config: { sampleLimit: 'abc' } }), 'limits').status).toBe('fail')
      expect(itemFor(computeBridgeAgentConfigCheck({ config: { sampleLimit: 1.5 } }), 'limits').status).toBe('fail')
    })
    it('fails on an invalid-shaped maxLimit', () => {
      expect(itemFor(computeBridgeAgentConfigCheck({ config: { maxLimit: 0 } }), 'limits').status).toBe('fail')
    })
    it('fails when sampleLimit exceeds maxLimit', () => {
      expect(itemFor(computeBridgeAgentConfigCheck({ config: { sampleLimit: 30, maxLimit: 20 } }), 'limits').status).toBe('fail')
    })
    it('fails when maxLimit exceeds the 500 adapter ceiling', () => {
      expect(itemFor(computeBridgeAgentConfigCheck({ config: { maxLimit: 501 } }), 'limits').status).toBe('fail')
    })
  })

  // --- authMode ----------------------------------------------------------------------------------
  describe('authMode', () => {
    it('passes (declared) when authMode is a non-empty string, regardless of its value', () => {
      expect(itemFor(computeBridgeAgentConfigCheck({ config: { authMode: 'none' } }), 'authMode').status).toBe('pass')
      expect(itemFor(computeBridgeAgentConfigCheck({ config: { authMode: 'shared-secret' } }), 'authMode').status).toBe('pass')
    })
    it('warns (undeclared) when authMode is absent', () => {
      const item = itemFor(computeBridgeAgentConfigCheck({ config: {} }), 'authMode')
      expect(item.status).toBe('warn')
      expect(item.labelKey).toBe('authMode.undeclared')
    })
  })

  // --- localhostBoundary ---------------------------------------------------------------------------
  describe('localhostBoundary', () => {
    it('passes for 127.0.0.1 and localhost-shaped baseUrl', () => {
      expect(itemFor(computeBridgeAgentConfigCheck({ config: { baseUrl: 'http://127.0.0.1:19091/' } }), 'localhostBoundary').status).toBe('pass')
      expect(itemFor(computeBridgeAgentConfigCheck({ config: { baseUrl: 'http://localhost:19091/' } }), 'localhostBoundary').status).toBe('pass')
    })
    it('warns (unknown) when no baseUrl-like field is present at all', () => {
      const item = itemFor(computeBridgeAgentConfigCheck({ config: {} }), 'localhostBoundary')
      expect(item.status).toBe('warn')
      expect(item.labelKey).toBe('localhostBoundary.unknown')
    })
    it('fails for a non-loopback host, and the host string never appears in any locale label', () => {
      const item = itemFor(computeBridgeAgentConfigCheck({ config: { baseUrl: SENTINEL_HOST_URL } }), 'localhostBoundary')
      expect(item.status).toBe('fail')
      expect(item.labelKey).toBe('localhostBoundary.fail')
      expect(bridgeAgentConfigCheckLabel(item.labelKey, 'en')).not.toContain('10.0.0.9')
      expect(bridgeAgentConfigCheckLabel(item.labelKey, 'zh-CN')).not.toContain('10.0.0.9')
    })
    it('fails for an unparsable baseUrl string', () => {
      expect(itemFor(computeBridgeAgentConfigCheck({ config: { baseUrl: 'not a url' } }), 'localhostBoundary').status).toBe('fail')
    })
  })

  // --- rawSqlForbidden -----------------------------------------------------------------------------
  describe('rawSqlForbidden', () => {
    it('passes when no raw-SQL-shaped key is present', () => {
      expect(itemFor(computeBridgeAgentConfigCheck({ config: { baseUrl: 'http://127.0.0.1:19091/' } }), 'rawSqlForbidden').status).toBe('pass')
    })
    it('fails when a top-level raw-SQL-shaped key is present', () => {
      for (const key of ['sql', 'rawSql', 'rawSQL', 'queryText', 'statement']) {
        const item = itemFor(computeBridgeAgentConfigCheck({ config: { [key]: 'SELECT 1' } }), 'rawSqlForbidden')
        expect(item.status, `key=${key}`).toBe('fail')
      }
    })
    it('fails when a raw-SQL-shaped key is nested under config.options', () => {
      const item = itemFor(computeBridgeAgentConfigCheck({ config: { options: { rawSql: 'SELECT 1' } } }), 'rawSqlForbidden')
      expect(item.status).toBe('fail')
    })
  })

  // --- objectAllowlist ------------------------------------------------------------------------------
  describe('objectAllowlist', () => {
    it('passes when material/bom/bom_child-style objects are all present (case/prefix-insensitive)', () => {
      const item = itemFor(computeBridgeAgentConfigCheck({ objectNames: ['T_Material', 'T_BOM', 'T_BOM_CHILD'] }), 'objectAllowlist')
      expect(item.status).toBe('pass')
      expect(item.labelKey).toBe('objectAllowlist.complete')
    })
    it('warns (empty) when the object list is empty', () => {
      const item = itemFor(computeBridgeAgentConfigCheck({ objectNames: [] }), 'objectAllowlist')
      expect(item.status).toBe('warn')
      expect(item.labelKey).toBe('objectAllowlist.empty')
    })
    it('warns (partial) when some expected objects are missing', () => {
      const item = itemFor(computeBridgeAgentConfigCheck({ objectNames: ['material'] }), 'objectAllowlist')
      expect(item.status).toBe('warn')
      expect(item.labelKey).toBe('objectAllowlist.partial')
    })
  })

  // --- SENTINEL: config-sourced secrets never leak into any checklist label ------------------------
  it('SENTINEL: a secret/host/connection-string value planted in config never appears in any item label, any locale', () => {
    const items = computeBridgeAgentConfigCheck({
      config: {
        baseUrl: SENTINEL_HOST_URL,
        sharedSecretEnvVar: SENTINEL_SECRET,
        connectionString: SENTINEL_CONNECTION_STRING,
        authMode: SENTINEL_SECRET,
      },
      objectNames: [`table_${SENTINEL_SECRET}`],
    })
    const allLabelKeys = Object.keys(BRIDGE_AGENT_CONFIG_CHECK_LABELS) as BridgeAgentConfigCheckLabelKey[]
    for (const labelKey of allLabelKeys) {
      expect(bridgeAgentConfigCheckLabel(labelKey, 'en')).not.toContain(SENTINEL_SECRET)
      expect(bridgeAgentConfigCheckLabel(labelKey, 'en')).not.toContain('10.0.0.9')
      expect(bridgeAgentConfigCheckLabel(labelKey, 'en')).not.toContain('SENTINEL-PW')
      expect(bridgeAgentConfigCheckLabel(labelKey, 'zh-CN')).not.toContain(SENTINEL_SECRET)
      expect(bridgeAgentConfigCheckLabel(labelKey, 'zh-CN')).not.toContain('10.0.0.9')
      expect(bridgeAgentConfigCheckLabel(labelKey, 'zh-CN')).not.toContain('SENTINEL-PW')
    }
    // the actually-produced items for this input, same assertion, belt-and-suspenders
    for (const item of items) {
      expect(bridgeAgentConfigCheckLabel(item.labelKey, 'en')).not.toContain(SENTINEL_SECRET)
      expect(bridgeAgentConfigCheckLabel(item.labelKey, 'zh-CN')).not.toContain(SENTINEL_SECRET)
    }
  })
})

describe('BRIDGE_AGENT_CONFIG_CHECK_LABELS (values-free label map)', () => {
  const allKeys = Object.keys(BRIDGE_AGENT_CONFIG_CHECK_LABELS) as BridgeAgentConfigCheckLabelKey[]
  const DIGIT_RUN_TOO_LONG = /\d{5,}/
  const HAS_URL_SCHEME = /https?:\/\//i

  it('has exactly the 14 expected label keys', () => {
    expect(allKeys.length).toBe(14)
  })

  it.each(allKeys)('%s has a non-empty zh AND en entry', (key) => {
    const entry = BRIDGE_AGENT_CONFIG_CHECK_LABELS[key]
    expect(entry.zh.trim().length).toBeGreaterThan(0)
    expect(entry.en.trim().length).toBeGreaterThan(0)
  })

  it.each(allKeys)('%s is values-free (no digit-run > 4, no http(s):// scheme)', (key) => {
    const entry = BRIDGE_AGENT_CONFIG_CHECK_LABELS[key]
    expect(entry.zh).not.toMatch(DIGIT_RUN_TOO_LONG)
    expect(entry.en).not.toMatch(DIGIT_RUN_TOO_LONG)
    expect(entry.zh).not.toMatch(HAS_URL_SCHEME)
    expect(entry.en).not.toMatch(HAS_URL_SCHEME)
  })

  it('bridgeAgentConfigCheckLabel returns the zh text for zh-CN and en text for en, per exact key', () => {
    expect(bridgeAgentConfigCheckLabel('requiredFields.present', 'zh-CN')).toBe(BRIDGE_AGENT_CONFIG_CHECK_LABELS['requiredFields.present'].zh)
    expect(bridgeAgentConfigCheckLabel('requiredFields.present', 'en')).toBe(BRIDGE_AGENT_CONFIG_CHECK_LABELS['requiredFields.present'].en)
  })
})

describe('buildBridgeAgentChangeSuggestion', () => {
  it('produces the guided "no valid input yet" text when there are no valid drafts', () => {
    const result = buildBridgeAgentChangeSuggestion([], 'en')
    expect(result.entries).toHaveLength(0)
    expect(result.text).toMatch(/no valid object\/field names/i)
  })

  it('ignores blank/whitespace-only drafts without counting them as invalid', () => {
    const result = buildBridgeAgentChangeSuggestion([{ objectName: '   ', fieldKeys: [] }], 'en')
    expect(result.entries).toHaveLength(0)
    expect(result.invalidObjectCount).toBe(0)
  })

  it('renders one entry per valid draft, object-only (no field mappings) branch', () => {
    const result = buildBridgeAgentChangeSuggestion([{ objectName: 'material_extra', fieldKeys: [] }], 'en')
    expect(result.entries).toEqual([{ objectName: 'material_extra', fieldKeys: [] }])
    expect(result.text).toContain('1. Object: material_extra')
    expect(result.text).toContain('(object only, no field mappings)')
  })

  it('renders field mappings, joined, and numbers multiple entries in order', () => {
    const result = buildBridgeAgentChangeSuggestion([
      { objectName: 'material_extra', fieldKeys: ['field_a', 'field_b'] },
      { objectName: 'bom_child', fieldKeys: ['child_qty'] },
    ], 'en')
    expect(result.text).toContain('1. Object: material_extra')
    expect(result.text).toContain('New field mappings: field_a, field_b')
    expect(result.text).toContain('2. Object: bom_child')
    expect(result.text).toContain('New field mappings: child_qty')
  })

  it('includes an optional target-instance header line when targetLabel is given', () => {
    const result = buildBridgeAgentChangeSuggestion([{ objectName: 'material_extra', fieldKeys: [] }], 'en', 'Legacy SQL Bridge')
    expect(result.text).toContain('Target instance: Legacy SQL Bridge')
  })

  it('renders the zh copy under zh-CN', () => {
    const result = buildBridgeAgentChangeSuggestion([{ objectName: 'material_extra', fieldKeys: ['field_a'] }], 'zh-CN')
    expect(result.text).toContain('变更建议 / 实施清单')
    expect(result.text).toContain('1. 对象：material_extra')
    expect(result.text).toContain('新增字段映射：field_a')
  })

  // --- SENTINEL: operator-typed secret/host/connection-string-shaped names never leak -------------
  it('SENTINEL: a secret-shaped object name is dropped (never echoed), only counted', () => {
    const result = buildBridgeAgentChangeSuggestion([
      { objectName: `password=${SENTINEL_SECRET}`, fieldKeys: [] },
    ], 'en')
    expect(result.entries).toHaveLength(0)
    expect(result.invalidObjectCount).toBe(1)
    expect(result.text).not.toContain(SENTINEL_SECRET)
    expect(result.text).not.toContain('password=')
  })

  it('SENTINEL: a connection-string-shaped object name is dropped, never echoed', () => {
    const result = buildBridgeAgentChangeSuggestion([
      { objectName: SENTINEL_CONNECTION_STRING, fieldKeys: [] },
    ], 'en')
    expect(result.entries).toHaveLength(0)
    expect(result.invalidObjectCount).toBe(1)
    expect(result.text).not.toContain('SENTINEL-PW')
    expect(result.text).not.toContain('10.0.0.9')
  })

  it('SENTINEL: a secret/host-shaped field key is dropped from a VALID object entry, only counted, never echoed', () => {
    const result = buildBridgeAgentChangeSuggestion([
      { objectName: 'material_extra', fieldKeys: ['field_a', `token=${SENTINEL_SECRET}`, SENTINEL_HOST_URL] },
    ], 'en')
    expect(result.entries).toEqual([{ objectName: 'material_extra', fieldKeys: ['field_a'] }])
    expect(result.invalidFieldKeyCount).toBe(2)
    expect(result.text).not.toContain(SENTINEL_SECRET)
    expect(result.text).not.toContain('10.0.0.9')
    expect(result.text).toContain('(2 field name(s) were ignored')
  })

  it('rejects an overlong "identifier" (a plausible way to smuggle a long secret) even without special characters', () => {
    const longButIdentifierShaped = `a${'b'.repeat(80)}`
    const result = buildBridgeAgentChangeSuggestion([{ objectName: longButIdentifierShaped, fieldKeys: [] }], 'en')
    expect(result.entries).toHaveLength(0)
    expect(result.invalidObjectCount).toBe(1)
    expect(result.text).not.toContain(longButIdentifierShaped)
  })

  it('never throws on malformed drafts (non-array fieldKeys, non-string names)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const drafts = [{ objectName: 123 as any, fieldKeys: 'not-an-array' as any }, null as any, undefined as any]
    expect(() => buildBridgeAgentChangeSuggestion(drafts, 'en')).not.toThrow()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => buildBridgeAgentChangeSuggestion('not-an-array' as any, 'en')).not.toThrow()
  })
})

// BA-APPLY-1 (docs/development/bridge-agent-controlled-apply-design-lock-20260708.md §2 形态 A): the
// change-suggestion drafts above rendered as a fixed-schema, machine-readable checklist instead of
// prose. This is form A's entire scope — an EXPORT/render only, zero platform write, zero Agent write.
// ALLOWED_OPS is hardcoded HERE (not imported from source) so that a source mutation adding a third —
// or a write/delete/make-writable-shaped — operation literal is caught by these tests even though the
// mutated code still "type-checks" against its own (mutated) union.
describe('buildImplementationChecklist (BA-APPLY-1)', () => {
  const ALLOWED_OPS = ['add_readonly_object', 'add_readonly_field']

  function allOpsAreAllowlisted(checklist: { operations: { op: string }[] }): boolean {
    return checklist.operations.every((operation) => ALLOWED_OPS.includes(operation.op))
  }

  it('serializes to exactly { schemaVersion, operations } — no counts, no targetLabel/system-name, no free text', () => {
    const result = buildImplementationChecklist([{ objectName: 'material_extra', fieldKeys: ['field_a'] }])
    expect(Object.keys(result.checklist).sort()).toEqual(['operations', 'schemaVersion'])
    expect(result.checklist.schemaVersion).toBe(1)
    expect(JSON.parse(JSON.stringify(result.checklist))).toEqual({
      schemaVersion: 1,
      operations: [{ op: 'add_readonly_field', objectName: 'material_extra', fieldKeys: ['field_a'] }],
    })
  })

  it('empty/no-valid-draft input yields an empty operations array, never throwing', () => {
    expect(buildImplementationChecklist([]).checklist).toEqual({ schemaVersion: 1, operations: [] })
    expect(buildImplementationChecklist([{ objectName: '   ', fieldKeys: [] }]).checklist.operations).toEqual([])
  })

  // --- op-derivation branches (the literal that a mutant flipping the derived op would break) -----
  it('object-only draft (zero valid field keys) yields exactly op=add_readonly_object', () => {
    const result = buildImplementationChecklist([{ objectName: 'material_extra', fieldKeys: [] }])
    expect(result.checklist.operations).toEqual([
      { op: 'add_readonly_object', objectName: 'material_extra', fieldKeys: [] },
    ])
  })

  it('draft with >=1 valid field key yields exactly op=add_readonly_field, carrying every valid key', () => {
    const result = buildImplementationChecklist([{ objectName: 'bom_child', fieldKeys: ['child_qty', 'child_uom'] }])
    expect(result.checklist.operations).toEqual([
      { op: 'add_readonly_field', objectName: 'bom_child', fieldKeys: ['child_qty', 'child_uom'] },
    ])
  })

  it('one operation per row (never per field key) — multiple rows preserve order', () => {
    const result = buildImplementationChecklist([
      { objectName: 'material_extra', fieldKeys: [] },
      { objectName: 'bom_child', fieldKeys: ['child_qty'] },
    ])
    expect(result.checklist.operations).toEqual([
      { op: 'add_readonly_object', objectName: 'material_extra', fieldKeys: [] },
      { op: 'add_readonly_field', objectName: 'bom_child', fieldKeys: ['child_qty'] },
    ])
  })

  // --- exact-registered enum lock ------------------------------------------------------------------
  it('every produced op is in the hardcoded ALLOWED_OPS allowlist (mutation gate: a 3rd/write-shaped op fails this)', () => {
    const result = buildImplementationChecklist([
      { objectName: 'material_extra', fieldKeys: [] },
      { objectName: 'bom_child', fieldKeys: ['child_qty'] },
    ])
    expect(result.checklist.operations.length).toBeGreaterThan(0)
    expect(allOpsAreAllowlisted(result.checklist)).toBe(true)
  })

  it('a draft with an injected op-like field cannot smuggle a write/delete-shaped op — output op is always derived', () => {
    const hostileDraft = { objectName: 'material_extra', fieldKeys: [], op: 'delete_object' } as unknown as BridgeAgentSuggestionObjectDraft
    const result = buildImplementationChecklist([hostileDraft])
    expect(result.checklist.operations).toEqual([
      { op: 'add_readonly_object', objectName: 'material_extra', fieldKeys: [] },
    ])
    expect(allOpsAreAllowlisted(result.checklist)).toBe(true)
  })

  // --- SAFE_IDENTIFIER gate reuse (independent of buildBridgeAgentChangeSuggestion) ------------------
  it('reuses the safe-identifier gate independently: invalid object/field names are dropped, only counted', () => {
    const result = buildImplementationChecklist([
      { objectName: `password=${SENTINEL_SECRET}`, fieldKeys: [] },
      { objectName: 'material_extra', fieldKeys: ['field_a', `token=${SENTINEL_SECRET}`] },
    ])
    expect(result.invalidObjectCount).toBe(1)
    expect(result.invalidFieldKeyCount).toBe(1)
    expect(result.checklist.operations).toEqual([
      { op: 'add_readonly_field', objectName: 'material_extra', fieldKeys: ['field_a'] },
    ])
  })

  // --- SENTINEL: full serialized artifact scan ------------------------------------------------------
  it('SENTINEL: a secret/host/connection-string planted in a draft name never appears anywhere in the serialized checklist', () => {
    const result = buildImplementationChecklist([
      { objectName: SENTINEL_CONNECTION_STRING, fieldKeys: [] },
      { objectName: SENTINEL_HOST_URL, fieldKeys: [SENTINEL_SECRET] },
      { objectName: 'material_extra', fieldKeys: ['field_a', SENTINEL_SECRET, SENTINEL_HOST_URL] },
    ])
    const serialized = JSON.stringify(result.checklist)
    expect(serialized).not.toContain(SENTINEL_SECRET)
    expect(serialized).not.toContain('SENTINEL-PW')
    expect(serialized).not.toContain('10.0.0.9')
    expect(serialized).not.toContain(SENTINEL_CONNECTION_STRING)
    // the two hostile rows (bad object name / bad field keys) are dropped entirely; the one surviving
    // row is exactly the sanitized entry — no partial/mangled leakage.
    expect(result.checklist.operations).toEqual([
      { op: 'add_readonly_field', objectName: 'material_extra', fieldKeys: ['field_a'] },
    ])
    expect(result.invalidObjectCount).toBe(2)
    expect(result.invalidFieldKeyCount).toBe(2)
  })

  it('never throws on malformed drafts (non-array fieldKeys, non-string names, non-array input)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const drafts = [{ objectName: 123 as any, fieldKeys: 'not-an-array' as any }, null as any, undefined as any]
    expect(() => buildImplementationChecklist(drafts)).not.toThrow()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => buildImplementationChecklist('not-an-array' as any)).not.toThrow()
  })
})
