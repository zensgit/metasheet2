/**
 * C1 (具名只读操作目录) — the FIXED, versioned catalog of the synthetic integration preview.
 *
 * Baseline: ipaas-yida dev doc v2.3 §10.3.1 + evidence D (C1/S2 first slice). Everything in this module
 * is a code asset: the one plan, the one named read-only operation, its fixtures, its consumer allowlist,
 * its budget and the YiDa mapping presets. A request can only SELECT ids from here; it can never supply
 * rows, an operation body, a connection, a URL, headers, credentials or a source sheet.
 *
 * The provider registered here is the ONLY data provider of the slice. It has no network, database,
 * file, environment or credential dependency (it imports nothing): it pages through frozen in-module
 * fixtures. That is a dependency-shape guarantee about trusted host code, pinned by a static test
 * (tests/unit/automation-operation-catalog.test.ts), not a JavaScript sandbox claim.
 *
 * Nothing here is a real PLM read. A future real read needs its own authorization, connection ownership,
 * fixed version, scope and per-page budget/revocation protocol; this catalog is not a stepping stone that
 * turns one on.
 */

export const SYNTHETIC_PREVIEW_PLAN_ID = 'plm-material-to-yida-preview.v1'
export const SYNTHETIC_MATERIAL_OPERATION_ID = 'plm.material.list.synthetic.v1'
export const SYNTHETIC_MATERIAL_OPERATION_VERSION = 1
export const SYNTHETIC_YIDA_PREVIEW_CONSUMER = 'yida.preview.synthetic.v1'
export const SYNTHETIC_MATERIAL_PROVIDER_ID = 'host.synthetic.material-fixtures.v1'

/**
 * Preview-only step types. They exist ONLY inside the fixed preview plan below. They are deliberately
 * NOT members of `ALL_ACTION_TYPES` (multitable/automation-actions.ts), so the ordinary rule save,
 * update, scheduling and retry entries reject them; a saved rule can never run them on a timer.
 */
export const SYNTHETIC_PREVIEW_STEP_TYPES = Object.freeze([
  'integration_preview_read',
  'integration_preview_yida',
] as const)
export type SyntheticPreviewStepType = (typeof SYNTHETIC_PREVIEW_STEP_TYPES)[number]

/** Run budget (evidence D §3.3). One run, never per node or per retry. */
export const SYNTHETIC_PREVIEW_BUDGET = Object.freeze({
  maxPages: 5,
  maxRows: 100,
  maxBytes: 256 * 1024,
  maxInFlight: 1,
  deadlineMs: 10_000,
})

/** The declared output columns of `plm.material.list.synthetic.v1` (the operation's output schema). */
export const SYNTHETIC_MATERIAL_COLUMNS = Object.freeze([
  'projectNo',
  'componentCode',
  'componentName',
  'componentSpec',
  'material',
  'sourceVersion',
  'parentComponentCode',
  'parentComponentName',
  'totalQuantity',
  'ext_blankLength',
  'ext_blankWidth',
  'ext_blankThickness',
  'blankType',
  'idempotencyKey',
] as const)
export type SyntheticMaterialColumn = (typeof SYNTHETIC_MATERIAL_COLUMNS)[number]
export type SyntheticMaterialValue = string | number | boolean | null
export type SyntheticMaterialRow = Readonly<Record<SyntheticMaterialColumn, SyntheticMaterialValue>>

export type SyntheticFixturePage = Readonly<{ rows: readonly SyntheticMaterialRow[]; nextCursor: string | null }>
export type SyntheticFixture = Readonly<{
  id: SyntheticMaterialFixtureId
  /** 'demo' fixtures are offered by the panel; 'probe' fixtures exist to show a fixed budget refusal. */
  purpose: 'demo' | 'probe'
  pages: readonly SyntheticFixturePage[]
}>

export const SYNTHETIC_MATERIAL_FIXTURE_IDS = Object.freeze([
  'synthetic-materials.two-page.v1',
  'synthetic-materials.single-page.v1',
  'synthetic-materials.repeat-cursor.v1',
  'synthetic-materials.six-page.v1',
  'synthetic-materials.too-many-rows.v1',
  'synthetic-materials.too-many-bytes.v1',
] as const)
export type SyntheticMaterialFixtureId = (typeof SYNTHETIC_MATERIAL_FIXTURE_IDS)[number]

export const SYNTHETIC_YIDA_MAPPING_PRESET_IDS = Object.freeze([
  'yida-material-v3.original.v1',
  'yida-material-v3.allocated.v1',
] as const)
export type SyntheticYidaMappingPresetId = (typeof SYNTHETIC_YIDA_MAPPING_PRESET_IDS)[number]

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}

function materialRow(index: number, overrides: Partial<Record<SyntheticMaterialColumn, SyntheticMaterialValue>> = {}): SyntheticMaterialRow {
  const n = String(index).padStart(3, '0')
  return {
    projectNo: 'SYN-P1',
    componentCode: `SYN-DRW-${n}`,
    componentName: `合成部件-${n}`,
    componentSpec: `SYN-SPEC-${n}`,
    material: 'SYN-MAT-1',
    sourceVersion: 'V1',
    parentComponentCode: null,
    parentComponentName: null,
    totalQuantity: 4,
    ext_blankLength: 1200,
    ext_blankWidth: 600,
    ext_blankThickness: 20,
    blankType: 'SYN-BLANK',
    idempotencyKey: `SYN-LINE-${n}`,
    ...overrides,
  }
}

function rowsFrom(start: number, count: number): SyntheticMaterialRow[] {
  return Array.from({ length: count }, (_, offset) => materialRow(start + offset))
}

const FIXTURES: Readonly<Record<SyntheticMaterialFixtureId, SyntheticFixture>> = deepFreeze({
  // The demo run of the slice: two provider pages, three rows, one child row.
  'synthetic-materials.two-page.v1': {
    id: 'synthetic-materials.two-page.v1',
    purpose: 'demo',
    pages: [
      { rows: [materialRow(1), materialRow(2, { componentSpec: '', parentComponentCode: 'SYN-DRW-001', parentComponentName: '合成部件-001', totalQuantity: 6, ext_blankLength: null, ext_blankWidth: null, ext_blankThickness: null, blankType: null })], nextCursor: 'synthetic-cursor-2' },
      { rows: [materialRow(3, { totalQuantity: 8 })], nextCursor: null },
    ],
  },
  'synthetic-materials.single-page.v1': {
    id: 'synthetic-materials.single-page.v1',
    purpose: 'demo',
    pages: [{ rows: [materialRow(1), materialRow(2)], nextCursor: null }],
  },
  // The provider repeats a cursor: the host terminates the run instead of reading page 3.
  'synthetic-materials.repeat-cursor.v1': {
    id: 'synthetic-materials.repeat-cursor.v1',
    purpose: 'probe',
    pages: [
      { rows: [materialRow(1)], nextCursor: 'synthetic-cursor-a' },
      { rows: [materialRow(2)], nextCursor: 'synthetic-cursor-a' },
      { rows: [materialRow(3)], nextCursor: null },
    ],
  },
  // One page more than the page budget.
  'synthetic-materials.six-page.v1': {
    id: 'synthetic-materials.six-page.v1',
    purpose: 'probe',
    pages: Array.from({ length: 6 }, (_, page) => ({
      rows: [materialRow(page + 1)],
      nextCursor: page < 5 ? `synthetic-cursor-${page + 2}` : null,
    })),
  },
  // 101 rows over two pages: the row budget ends the run on page 2.
  'synthetic-materials.too-many-rows.v1': {
    id: 'synthetic-materials.too-many-rows.v1',
    purpose: 'probe',
    pages: [
      { rows: rowsFrom(1, 60), nextCursor: 'synthetic-cursor-2' },
      { rows: rowsFrom(61, 41), nextCursor: null },
    ],
  },
  // Few rows, but each carries a long synthetic text: the 256 KiB byte budget ends the run.
  'synthetic-materials.too-many-bytes.v1': {
    id: 'synthetic-materials.too-many-bytes.v1',
    purpose: 'probe',
    pages: [
      { rows: [1, 2, 3].map((index) => materialRow(index, { componentName: `合成长文本-${'X'.repeat(100 * 1024)}` })), nextCursor: null },
    ],
  },
})

/** The v3 material rules, identical to plugins/plugin-integration-core/fixtures/yida-rule-templates/material-v3.json
 *  as imported by parseYidaRuleTemplate (pinned by the Y01 test, so the two cannot drift). */
const MATERIAL_V3_RULES = deepFreeze({
  version: 3,
  kind: 'yida-form-protocol-static',
  intent: 'create',
  businessKey: ['project', 'drawingNo', 'partName', 'specification', 'materialGrade', 'versionNo', 'parentDrawingNo'],
  emptyKeyFields: ['specification', 'parentDrawingNo'],
  fieldMap: [
    { transform: 'direct', source: 'projectNo', target: 'project', type: 'string', required: true },
    { transform: 'direct', source: 'componentCode', target: 'drawingNo', type: 'string', required: true },
    { transform: 'direct', source: 'componentName', target: 'partName', type: 'string', required: true },
    { transform: 'direct', source: 'componentSpec', target: 'specification', type: 'string', required: false },
    { transform: 'direct', source: 'material', target: 'materialGrade', type: 'string', required: true },
    { transform: 'direct', source: 'sourceVersion', target: 'versionNo', type: 'string', required: true },
    { transform: 'direct', source: 'parentComponentCode', target: 'parentDrawingNo', type: 'string', required: false },
    { transform: 'direct', source: 'parentComponentName', target: 'parentPartName', type: 'string', required: false },
    { transform: 'copy', copyOf: 'parentPartName', target: 'partCategory', type: 'string', required: false },
    { transform: 'direct', source: 'totalQuantity', target: 'totalQty', type: 'number', required: true },
    { transform: 'concat', parts: [{ source: 'ext_blankLength' }, { source: 'ext_blankWidth' }, { source: 'ext_blankThickness' }], separator: '*', blank: 'refuse', target: 'blankSize', type: 'string', required: false },
    { transform: 'direct', source: 'blankType', target: 'materialTypeText', type: 'string', required: false },
    { transform: 'constant', value: 'SYN-RULE-A', target: 'processRule', type: 'string', required: true },
    { transform: 'constant', value: 'SYN-NO', target: 'allowNegativeStock', type: 'string', required: true },
    { transform: 'constant', value: 'SYN-DEFAULT', target: 'defaultText', type: 'string', required: false },
    { transform: 'direct', source: 'idempotencyKey', target: 'sourceLineId', type: 'string', required: true },
  ],
  fieldCatalog: [
    { id: 'project', control: 'text', required: true },
    { id: 'drawingNo', control: 'text', required: true },
    { id: 'partName', control: 'text', required: true },
    { id: 'specification', control: 'text', required: false },
    { id: 'materialGrade', control: 'text', required: true },
    { id: 'versionNo', control: 'text', required: true },
    { id: 'parentDrawingNo', control: 'text', required: false },
    { id: 'parentPartName', control: 'text', required: false },
    { id: 'partCategory', control: 'text', required: false },
    { id: 'totalQty', control: 'number', required: true },
    { id: 'blankSize', control: 'text', required: false },
    { id: 'materialTypeText', control: 'text', required: false },
    { id: 'processRule', control: 'select', required: true, options: ['SYN-RULE-A', 'SYN-RULE-B'] },
    { id: 'allowNegativeStock', control: 'radio', required: true, options: ['SYN-YES', 'SYN-NO'] },
    { id: 'defaultText', control: 'text', required: false },
    { id: 'sourceLineId', control: 'text', required: true },
  ],
})

/** Synthetic locator only: it names no real YiDa app or form and is never looked up or bound. */
export const SYNTHETIC_YIDA_TARGET = deepFreeze({ appType: 'synthetic_preview_app', formUuid: 'synthetic_preview_form' })

/** Target fields the panel may show per planned row (the "preset-allowed synthetic view"). */
const MATERIAL_VIEW_FIELDS = deepFreeze([
  'project', 'drawingNo', 'partName', 'specification', 'materialGrade', 'versionNo',
  'parentDrawingNo', 'totalQty', 'blankSize', 'processRule', 'sourceLineId',
] as const)

export type SyntheticYidaAllocation =
  | Readonly<{ mode: 'original' }>
  | Readonly<{ mode: 'equal_integer'; projectField: string; quantityField: string; projects: readonly string[] }>

export type SyntheticYidaMappingPreset = Readonly<{
  id: SyntheticYidaMappingPresetId
  rules: typeof MATERIAL_V3_RULES
  target: typeof SYNTHETIC_YIDA_TARGET
  allocation: SyntheticYidaAllocation
  viewFields: readonly string[]
}>

const PRESETS: Readonly<Record<SyntheticYidaMappingPresetId, SyntheticYidaMappingPreset>> = deepFreeze({
  'yida-material-v3.original.v1': {
    id: 'yida-material-v3.original.v1',
    rules: MATERIAL_V3_RULES,
    target: SYNTHETIC_YIDA_TARGET,
    allocation: { mode: 'original' },
    viewFields: MATERIAL_VIEW_FIELDS,
  },
  'yida-material-v3.allocated.v1': {
    id: 'yida-material-v3.allocated.v1',
    rules: MATERIAL_V3_RULES,
    target: SYNTHETIC_YIDA_TARGET,
    allocation: { mode: 'equal_integer', projectField: 'projectNo', quantityField: 'totalQuantity', projects: ['SYN-PROJECT-01', 'SYN-PROJECT-02'] },
    viewFields: MATERIAL_VIEW_FIELDS,
  },
})

/** The one catalog entry (evidence D §3.1): fixed id + version, input/output schema, provider, consumers, budget. */
export const SYNTHETIC_MATERIAL_OPERATION = deepFreeze({
  id: SYNTHETIC_MATERIAL_OPERATION_ID,
  version: SYNTHETIC_MATERIAL_OPERATION_VERSION,
  providerId: SYNTHETIC_MATERIAL_PROVIDER_ID,
  input: { fixtureId: SYNTHETIC_MATERIAL_FIXTURE_IDS },
  output: { name: 'materialRows' as const, columns: SYNTHETIC_MATERIAL_COLUMNS },
  consumers: [SYNTHETIC_YIDA_PREVIEW_CONSUMER] as const,
  budget: SYNTHETIC_PREVIEW_BUDGET,
})

/** The one plan: a fixed, ordered, two-step chain. No branching, no user-authored steps. */
export const SYNTHETIC_PREVIEW_PLAN = deepFreeze({
  id: SYNTHETIC_PREVIEW_PLAN_ID,
  steps: [
    { id: 'read-materials' as const, type: 'integration_preview_read' as const, operationId: SYNTHETIC_MATERIAL_OPERATION_ID },
    {
      id: 'yida-preview' as const,
      type: 'integration_preview_yida' as const,
      consumer: SYNTHETIC_YIDA_PREVIEW_CONSUMER,
      input: { fromStep: 'read-materials' as const, output: 'materialRows' as const, columns: SYNTHETIC_MATERIAL_COLUMNS },
    },
  ],
})
export type SyntheticPreviewStepId = (typeof SYNTHETIC_PREVIEW_PLAN.steps)[number]['id']

const FIXTURE_ID_SET: ReadonlySet<string> = new Set(SYNTHETIC_MATERIAL_FIXTURE_IDS)
const PRESET_ID_SET: ReadonlySet<string> = new Set(SYNTHETIC_YIDA_MAPPING_PRESET_IDS)

export function isSyntheticMaterialFixtureId(value: unknown): value is SyntheticMaterialFixtureId {
  return typeof value === 'string' && FIXTURE_ID_SET.has(value)
}
export function isSyntheticYidaMappingPresetId(value: unknown): value is SyntheticYidaMappingPresetId {
  return typeof value === 'string' && PRESET_ID_SET.has(value)
}
export function syntheticMaterialFixture(id: SyntheticMaterialFixtureId): SyntheticFixture {
  return FIXTURES[id]
}
export function syntheticYidaMappingPreset(id: SyntheticYidaMappingPresetId): SyntheticYidaMappingPreset {
  return PRESETS[id]
}

/** Values-free catalog view for the panel: fixed ids only, demo fixtures only. */
export function describeSyntheticPreviewCatalog() {
  return Object.freeze({
    planId: SYNTHETIC_PREVIEW_PLAN_ID,
    operation: Object.freeze({ id: SYNTHETIC_MATERIAL_OPERATION_ID, version: SYNTHETIC_MATERIAL_OPERATION_VERSION }),
    consumer: SYNTHETIC_YIDA_PREVIEW_CONSUMER,
    fixtureIds: Object.freeze(SYNTHETIC_MATERIAL_FIXTURE_IDS.filter((id) => FIXTURES[id].purpose === 'demo')),
    mappingPresetIds: SYNTHETIC_YIDA_MAPPING_PRESET_IDS,
    budget: SYNTHETIC_PREVIEW_BUDGET,
  })
}

// ── Strict request ─────────────────────────────────────────────────────────

export type SyntheticPreviewRequest = Readonly<{
  planId: typeof SYNTHETIC_PREVIEW_PLAN_ID
  fixtureId: SyntheticMaterialFixtureId
  mappingPresetId: SyntheticYidaMappingPresetId
}>

const REQUEST_KEYS: readonly string[] = ['planId', 'fixtureId', 'mappingPresetId']

/**
 * Strict DTO: a plain own-data object with EXACTLY planId / fixtureId / mappingPresetId, each one of the
 * fixed catalog ids. Unknown keys (rows, url, headers, credentials, connection, sourceSheetId, synthetic,
 * tenantId, …), floating versions (`.latest`), accessors, symbols and foreign prototypes are refused.
 * Returns null on any refusal; the caller answers one fixed 400.
 */
export function parseSyntheticPreviewRequest(value: unknown): SyntheticPreviewRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.length !== REQUEST_KEYS.length) return null
  for (const key of keys) {
    if (typeof key !== 'string' || !REQUEST_KEYS.includes(key)) return null
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null
  }
  const planId = descriptors.planId.value
  const fixtureId = descriptors.fixtureId.value
  const mappingPresetId = descriptors.mappingPresetId.value
  if (planId !== SYNTHETIC_PREVIEW_PLAN_ID) return null
  if (!isSyntheticMaterialFixtureId(fixtureId) || !isSyntheticYidaMappingPresetId(mappingPresetId)) return null
  return Object.freeze({ planId: SYNTHETIC_PREVIEW_PLAN_ID, fixtureId, mappingPresetId })
}

// ── Host-registered synthetic provider ─────────────────────────────────────

export type SyntheticProviderPageRequest = Readonly<{ fixtureId: SyntheticMaterialFixtureId; cursor: string | null }>
export type SyntheticMaterialProvider = Readonly<{
  id: typeof SYNTHETIC_MATERIAL_PROVIDER_ID
  readPage(request: SyntheticProviderPageRequest): Promise<SyntheticFixturePage>
}>

/**
 * The only data provider. It reads frozen in-module fixtures by (fixtureId, cursor): cursor null is page
 * 1, `synthetic-cursor-*` selects by position in the fixture. A cursor the fixture does not contain
 * refuses. It never touches network, database, files, environment or credentials.
 */
export function createSyntheticMaterialProvider(): SyntheticMaterialProvider {
  return Object.freeze({
    id: SYNTHETIC_MATERIAL_PROVIDER_ID,
    async readPage(request: SyntheticProviderPageRequest): Promise<SyntheticFixturePage> {
      if (!isSyntheticMaterialFixtureId(request?.fixtureId)) throw new Error('SYNTHETIC_PROVIDER_INPUT')
      const fixture = FIXTURES[request.fixtureId]
      if (request.cursor === null) return fixture.pages[0]
      // A fixture's page i (i >= 1) is reached by the cursor page i-1 handed out.
      for (let index = 0; index < fixture.pages.length - 1; index += 1) {
        if (fixture.pages[index].nextCursor === request.cursor) {
          // The repeat-cursor probe hands out the same cursor twice; the host stops before asking again.
          return fixture.pages[index + 1]
        }
      }
      throw new Error('SYNTHETIC_PROVIDER_CURSOR')
    },
  })
}
