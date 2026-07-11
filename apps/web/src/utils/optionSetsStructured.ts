// D2 (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-5, site 5
// — "结构化编辑器" disposition, gated on IU-2 landing + IntegrationFieldOptionSyncPanel landing
// (#3822)): pure parse/serialize logic for the `optionSets JSON` textarea's structured
// (repeatable-row) view. Kept framework-agnostic and separate from the Vue component so the
// structured<->JSON contract is directly unit-testable without mounting anything — this is the
// module the byte-equivalence tests exercise.
//
// CLOSED-SHAPE contract this module structures (the "closed shape" the design-lock's main-loop
// disposition calls out, unlike sites 1-4's open/free-form JSON):
//   { [fieldKey: string]: Array<{ value: string; label: string; ...extra }> }
// optionally wrapped as `{ optionSets: <that map>, ...otherTopLevelKeys }` (the shape
// `IntegrationWorkbenchView.vue`'s `stockPreparationOptionSyncPlaceholder` and
// `buildStockPreparationOptionSyncPayload` already recognize — see that view's
// `payloadCarriesActionBindings` for why per-option `actionBindings` must round-trip untouched:
// they are a real, supported field this editor does not offer row UI for, but must never drop).
//
// Anything outside this closed shape — invalid JSON, a non-object document, the legacy
// `optionSources`/`configInfo` alias keys (a different data model the stock-preparation
// compatibility route still accepts), a field whose value isn't an array, or an array element
// that isn't a plain `{ value: string, label: string, ... }` object — is deliberately NOT
// structurable: `parseOptionSets` returns `{ ok: false }` and the caller must fall back to the
// expert JSON textarea, verbatim, rather than guess/coerce/drop anything (never silent data loss).
//
// Byte-equivalence design: `parseOptionSets` never clones option entries — it hands back the
// SAME parsed objects (`OptionSetsOptionEntry`), so any keys beyond `value`/`label` (e.g.
// `actionBindings`) and their original key order survive untouched as long as the caller mutates
// `.value`/`.label` in place instead of rebuilding entries. `serializeOptionSets` reproduces the
// original top-level key order for the wrapped shape by spreading `originalRecord` before
// re-assigning `optionSets` (a JS object-literal duplicate-key re-assignment keeps the key's
// FIRST position, only updating its value — see the module's own test file for a pinned case).

export interface OptionSetsOptionEntry {
  value: string
  label: string
  // Preserved-but-not-editable-here extra keys (e.g. `actionBindings`). Indexed access is typed
  // `unknown` deliberately — this module never inspects or interprets extra keys, only carries
  // them through.
  [key: string]: unknown
}

export interface OptionSetsFieldRow {
  fieldKey: string
  options: OptionSetsOptionEntry[]
}

export interface OptionSetsParseSuccess {
  ok: true
  /** Whether the source document used the `{ optionSets: {...} }` wrapper (true) or was a bare
   *  `{ [fieldKey]: [...] }` map at the top level (false). Preserved across serialize so editing
   *  never changes which shape the user originally chose. Blank/empty source text defaults to
   *  wrapped (matches the view's own placeholder / canonical new-document shape). */
  wrapped: boolean
  rows: OptionSetsFieldRow[]
  /** The raw parsed top-level object when `wrapped` (used to preserve sibling keys, e.g. a
   *  `projectId` alongside `optionSets`, and their original relative key order). Empty for bare
   *  documents (the map itself IS the whole document — no room for siblings) and for blank/fresh
   *  source text. */
  originalRecord: Record<string, unknown>
}

export interface OptionSetsParseFailure {
  ok: false
}

export type OptionSetsParseResult = OptionSetsParseSuccess | OptionSetsParseFailure

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse optionSets JSON text into the structured (repeatable-row) shape. Returns `{ ok: false }`
 * for anything outside the closed shape this editor supports — callers must treat that as
 * "not structurable" and fall back to the expert JSON textarea WITHOUT altering the source text.
 */
export function parseOptionSets(text: string): OptionSetsParseResult {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return { ok: true, wrapped: true, rows: [], originalRecord: {} }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false }
  }
  if (!isPlainObject(parsed)) return { ok: false }
  if ('optionSources' in parsed || 'configInfo' in parsed) return { ok: false }

  let mapSource: Record<string, unknown>
  let wrapped: boolean
  if ('optionSets' in parsed) {
    if (!isPlainObject(parsed.optionSets)) return { ok: false }
    mapSource = parsed.optionSets
    wrapped = true
  } else {
    mapSource = parsed
    wrapped = false
  }

  const rows: OptionSetsFieldRow[] = []
  for (const [fieldKey, rawOptions] of Object.entries(mapSource)) {
    if (!Array.isArray(rawOptions)) return { ok: false }
    const options: OptionSetsOptionEntry[] = []
    for (const rawOption of rawOptions) {
      if (!isPlainObject(rawOption)) return { ok: false }
      if (typeof rawOption.value !== 'string' || typeof rawOption.label !== 'string') return { ok: false }
      options.push(rawOption as OptionSetsOptionEntry)
    }
    rows.push({ fieldKey, options })
  }

  return { ok: true, wrapped, rows, originalRecord: wrapped ? parsed : {} }
}

/**
 * Serialize structured rows back to the SAME JSON text shape the raw textarea would hold
 * (2-space indent, `wrapped`/`originalRecord` preserved from the matching `parseOptionSets`
 * call). Byte-identical to the source text when called with zero row edits (idempotent).
 */
export function serializeOptionSets(
  rows: OptionSetsFieldRow[],
  wrapped: boolean,
  originalRecord: Record<string, unknown> = {},
): string {
  const map: Record<string, unknown> = {}
  for (const row of rows) {
    map[row.fieldKey] = row.options
  }
  const doc: Record<string, unknown> = wrapped ? { ...originalRecord, optionSets: map } : map
  return JSON.stringify(doc, null, 2)
}

/** Field keys that appear on more than one row — serializing silently keeps only the LAST one
 *  (plain JS object keys can't hold duplicates). Callers surface this as a visible, values-free
 *  warning (never silently drop without telling the user) rather than blocking the edit. */
export function findDuplicateFieldKeys(rows: OptionSetsFieldRow[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.fieldKey)) duplicates.add(row.fieldKey)
    seen.add(row.fieldKey)
  }
  return Array.from(duplicates)
}
