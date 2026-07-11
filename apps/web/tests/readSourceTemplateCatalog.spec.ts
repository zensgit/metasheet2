import { describe, expect, it } from 'vitest'
import {
  BRIDGE_AGENT_KIND,
  BRIDGE_AGENT_REQUIRED_CONFIG_FIELDS,
} from '../src/services/integration/bridgeAgentConfigCheck'
import {
  createReadSourceCompositionDraft,
  type ReadSourceCompositionDraft,
} from '../src/services/integration/readSourceCompositions'
import {
  createReadSourceConfigDraft,
  READ_SOURCE_MODE_REQUIRED_FIELDS,
  READ_SOURCE_MODES,
  type ReadSourceConfigDraft,
} from '../src/services/integration/readSourceConfigs'
import { readSourceModePreset } from '../src/services/integration/readSourceModePresets'
import {
  INTEGRATION_TEMPLATE_CATALOG,
  INTEGRATION_TEMPLATE_SEEDS_WIZARD,
  integrationTemplateCatalogEntriesFor,
  integrationTemplateCatalogEntry,
  isBridgeTemplateEntry,
  isCompositionTemplateEntry,
  isReadSourceTemplateEntry,
  seedCompositionDraft,
  seedReadSourceDraft,
  type ReadSourceTemplateCatalogEntry,
} from '../src/services/integration/readSourceTemplateCatalog'

// TC-1 connector/experience template catalog (design-lock
// docs/development/integration-connector-template-catalog-design-lock-20260708.md, #3879).
//
// This spec is the anti-drift gate mirroring readSourceModePresets.spec.ts's own discipline: catalog
// entries are a curated PRESENTATION mapping over existing kind/mode/preset primitives — zero new
// backend/runtime, zero hand-copied required-field vocabulary, zero real business values.

const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

// values-free scan (mirrors fieldHints.spec.ts's DIGIT_RUN_TOO_LONG/HAS_URL_SCHEME, extended with a
// credential-shaped-keyword check per this design-lock's stricter "even as an example" bar).
const DIGIT_RUN_TOO_LONG = /\d{5,}/
const HAS_URL_SCHEME = /https?:\/\//i
const HAS_HOST_SHAPE = /\b(?:[a-z0-9-]+\.){2,}[a-z]{2,}\b/i
const HAS_IPV4_SHAPE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/
const HAS_CREDENTIAL_KEYWORD = /(password|secret|token|apikey|api[_-]?key|authorization|credential)/i

function allStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(allStrings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(allStrings)
  return []
}

describe('readSourceTemplateCatalog (TC-1 tripwire)', () => {
  it('every entry declares a kebab-case id, unique across the catalog', () => {
    const ids = INTEGRATION_TEMPLATE_CATALOG.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id, id).toMatch(ID_PATTERN)
    }
  })

  it('every entry has non-empty zh+en title and one-liner', () => {
    for (const entry of INTEGRATION_TEMPLATE_CATALOG) {
      expect(entry.title.zh.trim().length, `${entry.id} title.zh`).toBeGreaterThan(0)
      expect(entry.title.en.trim().length, `${entry.id} title.en`).toBeGreaterThan(0)
      expect(entry.oneLiner.zh.trim().length, `${entry.id} oneLiner.zh`).toBeGreaterThan(0)
      expect(entry.oneLiner.en.trim().length, `${entry.id} oneLiner.en`).toBeGreaterThan(0)
    }
  })

  it('every entry declares seedsWizard in the closed enum', () => {
    for (const entry of INTEGRATION_TEMPLATE_CATALOG) {
      expect(INTEGRATION_TEMPLATE_SEEDS_WIZARD, entry.id).toContain(entry.seedsWizard)
    }
  })

  it('covers the v1 candidate set named in the design-lock: both K3 WISE kinds, the bridge kind, all 4 generic-HTTP modes, and the two-hop composition', () => {
    const targetKinds = INTEGRATION_TEMPLATE_CATALOG.map((entry) => entry.targetKind)
    expect(targetKinds).toContain('erp:k3-wise-webapi')
    expect(targetKinds).toContain('erp:k3-wise-sqlserver')
    expect(targetKinds).toContain(BRIDGE_AGENT_KIND)

    const httpModes = INTEGRATION_TEMPLATE_CATALOG
      .filter((entry) => entry.targetKind === 'http' && isReadSourceTemplateEntry(entry))
      .map((entry) => (entry as ReadSourceTemplateCatalogEntry).seed.mode)
    expect(new Set(httpModes)).toEqual(new Set(READ_SOURCE_MODES))

    const compositionEntries = integrationTemplateCatalogEntriesFor('composition')
    expect(compositionEntries.length).toBeGreaterThanOrEqual(1)
  })

  it('SINGLE-SOURCE (read-source templates): requiredFieldKeys === the REAL READ_SOURCE_MODE_REQUIRED_FIELDS[mode], by identity — not a copy', () => {
    for (const entry of INTEGRATION_TEMPLATE_CATALOG) {
      if (!isReadSourceTemplateEntry(entry)) continue
      const real = READ_SOURCE_MODE_REQUIRED_FIELDS[entry.seed.mode]
      expect(entry.requiredFieldKeys, entry.id).toBe(real)
      expect(entry.requiredFieldKeys, entry.id).toEqual(real)
    }
  })

  it('SINGLE-SOURCE (read-source templates): title/oneLiner are composed from the REAL readSourceModePreset copy, not a re-described duplicate', () => {
    for (const entry of INTEGRATION_TEMPLATE_CATALOG) {
      if (!isReadSourceTemplateEntry(entry)) continue
      const preset = readSourceModePreset(entry.seed.mode)
      expect(entry.title.zh, entry.id).toContain(preset.title.zh)
      expect(entry.title.en, entry.id).toContain(preset.title.en)
      expect(entry.oneLiner.zh, entry.id).toContain(preset.oneLiner.zh)
      expect(entry.oneLiner.en, entry.id).toContain(preset.oneLiner.en)
    }
  })

  it('SINGLE-SOURCE (bridge template): requiredFieldKeys mirrors BRIDGE_AGENT_REQUIRED_CONFIG_FIELDS and seed.kind === BRIDGE_AGENT_KIND', () => {
    const bridgeEntries = INTEGRATION_TEMPLATE_CATALOG.filter(isBridgeTemplateEntry)
    expect(bridgeEntries.length).toBeGreaterThanOrEqual(1)
    for (const entry of bridgeEntries) {
      expect(entry.requiredFieldKeys, entry.id).toEqual(BRIDGE_AGENT_REQUIRED_CONFIG_FIELDS)
      expect(entry.seed.kind, entry.id).toBe(BRIDGE_AGENT_KIND)
      expect(entry.targetKind, entry.id).toBe(BRIDGE_AGENT_KIND)
    }
  })

  it('SINGLE-SOURCE (composition template): requiredFieldKeys derives from the REAL createReadSourceCompositionDraft() field set', () => {
    const compositionEntries = INTEGRATION_TEMPLATE_CATALOG.filter(isCompositionTemplateEntry)
    expect(compositionEntries.length).toBeGreaterThanOrEqual(1)
    const realKeys = Object.keys(createReadSourceCompositionDraft())
    for (const entry of compositionEntries) {
      expect(entry.requiredFieldKeys, entry.id).toEqual(realKeys)
    }
  })

  it('VALUES-FREE: no digit-run>4, no URL scheme, no host/IP shape, no credential keyword anywhere in title/oneLiner/seed', () => {
    for (const entry of INTEGRATION_TEMPLATE_CATALOG) {
      const strings = [
        ...allStrings(entry.title),
        ...allStrings(entry.oneLiner),
        ...allStrings(entry.seed),
      ]
      for (const value of strings) {
        expect(value, `${entry.id}: ${value}`).not.toMatch(DIGIT_RUN_TOO_LONG)
        expect(value, `${entry.id}: ${value}`).not.toMatch(HAS_URL_SCHEME)
        expect(value, `${entry.id}: ${value}`).not.toMatch(HAS_HOST_SHAPE)
        expect(value, `${entry.id}: ${value}`).not.toMatch(HAS_IPV4_SHAPE)
        expect(value, `${entry.id}: ${value}`).not.toMatch(HAS_CREDENTIAL_KEYWORD)
      }
    }
  })

  it('integrationTemplateCatalogEntry() resolves a known id and returns null for an unknown one', () => {
    expect(integrationTemplateCatalogEntry('k3-wise-webapi-single-record')?.id).toBe('k3-wise-webapi-single-record')
    expect(integrationTemplateCatalogEntry('does-not-exist')).toBeNull()
  })

  it('integrationTemplateCatalogEntriesFor() filters by seedsWizard exactly', () => {
    for (const kind of INTEGRATION_TEMPLATE_SEEDS_WIZARD) {
      const entries = integrationTemplateCatalogEntriesFor(kind)
      for (const entry of entries) {
        expect(entry.seedsWizard).toBe(kind)
      }
    }
    const total = INTEGRATION_TEMPLATE_SEEDS_WIZARD
      .reduce((sum, kind) => sum + integrationTemplateCatalogEntriesFor(kind).length, 0)
    expect(total).toBe(INTEGRATION_TEMPLATE_CATALOG.length)
  })

  // --- ROUND-TRIP GOLDEN (design-lock §5.1) ---------------------------------------------------------
  // Selecting a template must reach EXACTLY the draft state a user reaches by manually performing the
  // equivalent action — deep-equal against a fresh draft with only the manual action applied.

  describe('round-trip golden: read-source templates', () => {
    for (const entry of INTEGRATION_TEMPLATE_CATALOG.filter(isReadSourceTemplateEntry)) {
      it(`${entry.id}: seedReadSourceDraft(fresh draft) === manually selecting mode "${entry.seed.mode}" on a fresh draft`, () => {
        const seeded: ReadSourceConfigDraft = createReadSourceConfigDraft()
        seedReadSourceDraft(seeded, entry)

        // "Manual selection" = exactly what IntegrationReadSourceWizard.vue's selectMode() does: set
        // draft.mode, touch nothing else.
        const manual: ReadSourceConfigDraft = createReadSourceConfigDraft()
        manual.mode = entry.seed.mode

        expect(seeded).toEqual(manual)
        expect(seeded.mode).toBe(entry.seed.mode)
      })
    }
  })

  describe('round-trip golden: composition template', () => {
    for (const entry of INTEGRATION_TEMPLATE_CATALOG.filter(isCompositionTemplateEntry)) {
      it(`${entry.id}: seedCompositionDraft(fresh draft) === the authoring panel's own pre-existing sourceTarget default`, () => {
        const seeded: ReadSourceCompositionDraft = createReadSourceCompositionDraft()
        seedCompositionDraft(seeded, entry)

        // "Manual" baseline = the authoring panel's OWN default assignment
        // (IntegrationReadSourceCompositionAuthoringPanel.vue: `draft.sourceTarget = 'internal_id'`),
        // reproduced here rather than imported (that assignment lives inline in a .vue script setup
        // block, not an exported function) — this is the exact behavior under test.
        const manual: ReadSourceCompositionDraft = createReadSourceCompositionDraft()
        manual.sourceTarget = 'internal_id'

        expect(seeded).toEqual(manual)
        expect(entry.seed.sourceTarget).toBe('internal_id')
      })
    }
  })

  it('ZERO NEW SHAPE: every read-source template seed.mode is a member of the real READ_SOURCE_MODES set', () => {
    for (const entry of INTEGRATION_TEMPLATE_CATALOG.filter(isReadSourceTemplateEntry)) {
      expect(READ_SOURCE_MODES, entry.id).toContain(entry.seed.mode)
    }
  })
})
