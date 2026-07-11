// Connector / experience template catalog — TC-1 "seed-the-wizard" v1 (design-lock
// docs/development/integration-connector-template-catalog-design-lock-20260708.md, #3879, §1-§3).
//
// A curated, platform-maintained catalog of named "connection + read-source + composition" templates.
// Each entry is a values-free, presentation-layer config SEED over an EXISTING wizard/preset — this
// module invents NO new connector kind, NO new read-source mode, NO new composition shape, and owns
// no service call of its own (zero backend, zero runtime — design-lock §2 hard lock). Selecting a
// template pre-fills the SAME wizard state (`ReadSourceConfigDraft` / `ReadSourceCompositionDraft`)
// a user reaches by manually clicking the corresponding preset/mode card — see `seedReadSourceDraft` /
// `seedCompositionDraft` below, each a one-field assignment mirroring the wizard's own
// `selectMode()`/manual-edit effect exactly (IntegrationReadSourceWizard.vue / the composition
// authoring panel's `draft.sourceTarget` default), so the seed round-trip is provably a single
// initial-state injection, not a second configuration path.
//
// Single-source discipline (design-lock §2/§3, same range as readSourceModePresets.ts's own header):
// `requiredFieldKeys` for a read-source template is read straight off `readSourceModePreset(mode)` —
// itself sourced from `READ_SOURCE_MODE_REQUIRED_FIELDS` in readSourceConfigs.ts — never a hand-copied
// list. Calling `readSourceModePreset()` also means a template referencing a mode with no registered
// preset card throws at import time (readSourceModePresets.ts's own tripwire), so this module can never
// silently drift from the real mode/required-field vocabulary. The bridge template's
// `requiredFieldKeys` and `seed.kind` are read off `BRIDGE_AGENT_REQUIRED_CONFIG_FIELDS` /
// `BRIDGE_AGENT_KIND` (bridgeAgentConfigCheck.ts) for the same reason. The composition template's
// `requiredFieldKeys` is derived from `Object.keys(createReadSourceCompositionDraft())` — the real
// draft factory's own field set, not a hand-typed list.
//
// values-free (design-lock §3 hard lock): every title/oneLiner/seed value here is placeholder-shaped
// only — no real material/host/tenant/database/credential value, not even as an "example". Where the
// design-lock's own prose gives an example shape ("示例：单据编号形如 XX-000000"), copy here stays at
// that same level of abstraction. `readSourceTemplateCatalog.spec.ts` sentinel-scans every string field
// for digit-run>4 / URL-scheme / credential-shaped keywords as a standing tripwire.
//
// Non-goals (design-lock §6): this is NOT a marketplace (no third-party entries, no rating/install),
// NOT customer-authored (no "save as template" in v1), and does NOT touch the wizard's own interaction
// skeleton, byte-equal invariants, or approval/probe paths — those all stay exactly as IU-3/IU-4 left
// them. TC-2+ (onboarding flow riding probe/BA-UI-2, additional template batches, in-catalog search) are
// separate, later, explicit opt-ins (design-lock §4) — out of scope here.

import {
  BRIDGE_AGENT_KIND,
  BRIDGE_AGENT_REQUIRED_CONFIG_FIELDS,
} from './bridgeAgentConfigCheck'
import {
  createReadSourceCompositionDraft,
  type ReadSourceCompositionDraft,
} from './readSourceCompositions'
import type { ReadSourceConfigDraft, ReadSourceMode } from './readSourceConfigs'
import { readSourceModePreset } from './readSourceModePresets'

export type IntegrationTemplateCatalogCopy = { zh: string; en: string }

export const INTEGRATION_TEMPLATE_SEEDS_WIZARD = ['read-source', 'composition', 'bridge'] as const
export type IntegrationTemplateSeedsWizard = typeof INTEGRATION_TEMPLATE_SEEDS_WIZARD[number]

interface IntegrationTemplateCatalogEntryBase {
  // Stable kebab-case identifier (design-lock §3).
  id: string
  title: IntegrationTemplateCatalogCopy
  oneLiner: IntegrationTemplateCatalogCopy
  // Descriptive metadata ONLY — which existing connector kind this template suits. Never applied to a
  // draft (a real systemId/requiredKind always comes from picking an actual registered external system,
  // which is tenant data, not template data); it exists purely to label the card / drive the catalog's
  // "kind/mode exists in the real source set" coverage tripwire.
  targetKind: string
  requiredFieldKeys: string[]
}

export interface ReadSourceTemplateCatalogEntry extends IntegrationTemplateCatalogEntryBase {
  seedsWizard: 'read-source'
  // The ENTIRE seed: exactly the one field IntegrationReadSourceWizard.vue's own `selectMode()` sets.
  // Anything wider (readMethod, keyEncoding, requiredKind, …) would make the seeded draft diverge from
  // what manual preset-card selection reaches — the design-lock §5.1 round-trip golden depends on this
  // seed staying exactly this narrow.
  seed: { mode: ReadSourceMode }
}

export interface CompositionTemplateCatalogEntry extends IntegrationTemplateCatalogEntryBase {
  seedsWizard: 'composition'
  // sourceTarget only — step1ConfigId/step2ConfigId are always an ACTUAL approved resolver_lookup read
  // source id (tenant runtime data), so a template can never pre-select them without ceasing to be
  // values-free. 'internal_id' mirrors the authoring panel's own pre-existing default
  // (IntegrationReadSourceCompositionAuthoringPanel.vue `draft.sourceTarget = 'internal_id'`), so this
  // seed is — by design — a no-op against a fresh panel: proof that the template is initial-state
  // injection, not a second path (design-lock §2).
  seed: { sourceTarget: string }
}

export interface BridgeTemplateCatalogEntry extends IntegrationTemplateCatalogEntryBase {
  seedsWizard: 'bridge'
  // No interactive wizard exists for this entry point in v1: the Bridge-Agent section (BA-UI-1..3) is
  // read-only observability/probe over an ALREADY-connected instance, with no authoring draft to seed.
  // The entry is catalog-DATA-complete (covers `bridge:legacy-sql-readonly` per the design-lock's v1
  // candidate set) but has no interactive picker wiring in TC-1 — see readSourceTemplateCatalog.spec.ts
  // and the TC-1 verification MD for the explicit scoping note. `seed.kind` is carried for forward
  // compatibility with a later TC that deep-links into that section.
  //
  // Note on requiredFieldKeys for this entry: `BRIDGE_AGENT_REQUIRED_CONFIG_FIELDS` is a ONE-OF
  // precedence list (bridgeAgentConfigCheck.ts's requiredFieldsCheck passes if ANY one of
  // baseUrl/bridgeUrl/url is present — the real Bridge-Agent adapter accepts exactly one connection
  // field, not all three), unlike a read-source template's requiredFieldKeys, which IS an all-required
  // set. The field name is shared across the union purely for a uniform catalog entry shape; the
  // single-source discipline (real constant, never hand-copied) is what's being verified either way.
  seed: { kind: string }
}

export type IntegrationTemplateCatalogEntry =
  | ReadSourceTemplateCatalogEntry
  | CompositionTemplateCatalogEntry
  | BridgeTemplateCatalogEntry

function readSourceEntry(
  id: string,
  targetKindLabel: IntegrationTemplateCatalogCopy,
  targetKind: string,
  mode: ReadSourceMode,
): ReadSourceTemplateCatalogEntry {
  // Reads the REAL preset (readSourceModePresets.ts) rather than re-describing the mode's shape from
  // scratch — "消费既有 typed 模块, 不得另建一套重复的标题/说明词汇" (design-lock §2/§3). Composing the
  // catalog's copy from `preset.title`/`preset.oneLiner` also means a future edit to the preset copy
  // propagates here automatically instead of drifting.
  const preset = readSourceModePreset(mode)
  return {
    id,
    title: {
      zh: `${targetKindLabel.zh} · ${preset.title.zh}`,
      en: `${targetKindLabel.en} · ${preset.title.en}`,
    },
    oneLiner: {
      zh: `${targetKindLabel.zh}：${preset.oneLiner.zh}`,
      en: `${targetKindLabel.en}: ${preset.oneLiner.en}`,
    },
    targetKind,
    seedsWizard: 'read-source',
    seed: { mode },
    // Real source of truth, not a copy — see module header.
    requiredFieldKeys: preset.requiredFieldKeys,
  }
}

// v1 candidate set (design-lock §1 table): K3 WISE WebAPI read-source, K3 WISE SQL read-source
// (advanced connector — 2026-05-12 advanced-connectors lock's "高级连接默认隐藏" convention: this
// template is still catalog-listed, the UI decides whether/where to surface "advanced" entries), the
// legacy-SQL Bridge-Agent read-only kind, generic HTTP read-source across all four existing
// `READ_SOURCE_MODES`, and the fixed two-hop composition shape. The catalog is a SUBSET projection of
// whatever kind/mode set exists on main — never a superset (design-lock §1): if main ever adds a mode
// this file doesn't enumerate, nothing here goes red (a template is opt-in curation, not exhaustive
// coverage); if this file ever references a mode/kind that does NOT exist on main, `readSourceModePreset`
// (or the direct BRIDGE_AGENT_* import) throws at import time instead.
export const INTEGRATION_TEMPLATE_CATALOG: readonly IntegrationTemplateCatalogEntry[] = [
  readSourceEntry(
    'k3-wise-webapi-single-record',
    { zh: 'K3 WISE WebAPI', en: 'K3 WISE WebAPI' },
    'erp:k3-wise-webapi',
    'single_record',
  ),
  readSourceEntry(
    'k3-wise-sqlserver-list-page',
    { zh: 'K3 WISE SQL 读取通道（高级）', en: 'K3 WISE SQL channel (advanced)' },
    'erp:k3-wise-sqlserver',
    'list_page',
  ),
  {
    id: 'bridge-legacy-sql-readonly',
    title: { zh: '遗留 SQL 库（Bridge-Agent 只读）', en: 'Legacy SQL database (Bridge-Agent, read-only)' },
    oneLiner: {
      zh: '经由本机 Bridge-Agent 只读暴露白名单表/视图，不接受任意 SQL、不做写入。',
      en: 'Exposes an allowlisted set of tables/views read-only via the local Bridge-Agent — no free-form SQL, no writes.',
    },
    targetKind: BRIDGE_AGENT_KIND,
    seedsWizard: 'bridge',
    seed: { kind: BRIDGE_AGENT_KIND },
    // Real source of truth, not a copy — see module header.
    requiredFieldKeys: [...BRIDGE_AGENT_REQUIRED_CONFIG_FIELDS],
  },
  readSourceEntry(
    'http-read-single-record',
    { zh: '通用 HTTP 读取源', en: 'Generic HTTP read source' },
    'http',
    'single_record',
  ),
  readSourceEntry(
    'http-read-list-page',
    { zh: '通用 HTTP 读取源', en: 'Generic HTTP read source' },
    'http',
    'list_page',
  ),
  readSourceEntry(
    'http-read-detail-with-lines',
    { zh: '通用 HTTP 读取源', en: 'Generic HTTP read source' },
    'http',
    'detail_with_lines',
  ),
  readSourceEntry(
    'http-read-resolver-lookup',
    { zh: '通用 HTTP 读取源', en: 'Generic HTTP read source' },
    'http',
    'resolver_lookup',
  ),
  {
    id: 'two-hop-composition',
    title: { zh: '两跳组合（读→解析→读）', en: 'Two-hop composition (read → resolve → read)' },
    oneLiner: {
      zh: '固定的两跳读取组合：第一跳的解析输出作为第二跳的业务 key，形状与向导手动搭建的完全一致。',
      en: 'A fixed two-hop read composition: hop 1\'s resolved output becomes hop 2\'s business key — the exact same shape the wizard builds manually.',
    },
    targetKind: 'composition:two-hop',
    seedsWizard: 'composition',
    // Mirrors the authoring panel's own pre-existing default — see the interface doc comment above.
    seed: { sourceTarget: 'internal_id' },
    // Derived from the real draft factory's field set, not a hand-typed list — see module header.
    requiredFieldKeys: Object.keys(createReadSourceCompositionDraft()),
  },
] as const

const CATALOG_BY_ID = new Map<string, IntegrationTemplateCatalogEntry>(
  INTEGRATION_TEMPLATE_CATALOG.map((entry) => [entry.id, entry]),
)

export function integrationTemplateCatalogEntry(id: string): IntegrationTemplateCatalogEntry | null {
  return CATALOG_BY_ID.get(id) ?? null
}

export function integrationTemplateCatalogEntriesFor(
  seedsWizard: IntegrationTemplateSeedsWizard,
): IntegrationTemplateCatalogEntry[] {
  return INTEGRATION_TEMPLATE_CATALOG.filter((entry) => entry.seedsWizard === seedsWizard)
}

export function isReadSourceTemplateEntry(
  entry: IntegrationTemplateCatalogEntry,
): entry is ReadSourceTemplateCatalogEntry {
  return entry.seedsWizard === 'read-source'
}

export function isCompositionTemplateEntry(
  entry: IntegrationTemplateCatalogEntry,
): entry is CompositionTemplateCatalogEntry {
  return entry.seedsWizard === 'composition'
}

export function isBridgeTemplateEntry(
  entry: IntegrationTemplateCatalogEntry,
): entry is BridgeTemplateCatalogEntry {
  return entry.seedsWizard === 'bridge'
}

// --- seed application (pure — no Vue, no DOM) ------------------------------------------------------
//
// Each function mutates ONLY the field the corresponding wizard's own manual-selection path would set,
// so calling it on a fresh draft reaches byte-for-byte the same state manual selection reaches
// (design-lock §5.1 round-trip golden). Neither function saves, probes, validates, or navigates —
// selection is initial-state injection only; every downstream action still flows through the existing
// wizard/panel/service code, untouched.

// Mirrors IntegrationReadSourceWizard.vue's `selectMode()` exactly (one field, no side effects).
export function seedReadSourceDraft(draft: ReadSourceConfigDraft, entry: ReadSourceTemplateCatalogEntry): void {
  draft.mode = entry.seed.mode
}

// Mirrors IntegrationReadSourceCompositionAuthoringPanel.vue's own `sourceTarget` default assignment.
export function seedCompositionDraft(draft: ReadSourceCompositionDraft, entry: CompositionTemplateCatalogEntry): void {
  draft.sourceTarget = entry.seed.sourceTarget
}
