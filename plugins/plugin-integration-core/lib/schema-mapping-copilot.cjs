'use strict'

/**
 * 列映射副驾 — SCHEMA-MAPPING COPILOT. The first AI feature on the governed AI boundary.
 *
 * ── WHAT IT IS ──────────────────────────────────────────────────────────────────────────────────
 *
 * A customer's PLM source ships columns with ZERO semantics (generic numbered slots — `Bom_ExAttr1`,
 * `ExAttr7`, …); the meaning of each slot lives in the vendor's per-customer dictionary tables. Today
 * a human stares at those columns + dictionaries and hand-authors the mapping. This module lets the AI
 * PROPOSE, for each opaque column, what it means and WHY — grounded in the same deterministic signals
 * the human would read — so onboarding stops being a guessing game against `ExAttr`.
 *
 * ── THE DISCIPLINE (why every guarantee below is structural, not prose) ─────────────────────────────
 *
 *   1. THE AI PROPOSES; A HUMAN CONFIRMS; THE CONFIRMED PRESET IS THE AUTHORITATIVE ARTIFACT.
 *      `proposeColumnMappings()` returns SUGGESTIONS ONLY — `authoritativePreset` is ALWAYS null. It has
 *      no code path that writes a preset. The ONLY path to an authoritative artifact is
 *      `confirmColumnMappingPreset()`, which takes the HUMAN's confirmed semantics and produces a
 *      DETERMINISTIC vendor preset (the #5385 preset schema), validated by `validateVendorPreset`. The
 *      AI's free text NEVER becomes the artifact — it is evidence a human reads to confirm.
 *
 *   2. BUSINESS DATA IS ROUTED LOCAL-ONLY. Customer PLM schema/dictionary data is BUSINESS class, so
 *      every call to the boundary carries `dataClass: 'business'` (`SCHEMA_MAPPING_COPILOT_DATA_CLASS`).
 *      The governed boundary then refuses to route it to any cloud provider (structural, fail-closed).
 *      This module never constructs a model call itself — it calls `governedAi.suggest()` and nothing
 *      else reaches a provider.
 *
 *   3. FAIL-OPEN. If the boundary is absent (host did not wire it) or returns `available: false` (AI
 *      off / routed-away / metered-out / provider error), the copilot degrades to the existing MANUAL
 *      mapping: it returns the deterministic hints with `aiAvailable: false` and `manualFallback: true`
 *      and NEVER throws. The copilot is an accelerator, never a dependency.
 *
 *   4. THE DETERMINISTIC DISCOVERY GROUNDS AND CROSS-CHECKS THE AI. We reuse the preset-discovery
 *      machinery (`lib/source-vendor-presets/preset-schema.cjs`: `selectVendorPreset` to detect the
 *      vendor family, `isFamilyColumn` to classify a column as a generic slot, `LABEL_HINT_VOCABULARY`
 *      to rank a dictionary label, `findValueShapeViolation` to scrub secret-shaped samples before they
 *      would ever be sent) to GATHER the signals AND to cross-check each AI proposal — so a suggestion
 *      that contradicts the deterministic evidence is flagged, not trusted.
 *
 * Consumed by: plugins/plugin-integration-core/lib/http-routes.cjs (the integration:admin
 * propose/confirm endpoints). The boundary it consumes: packages/core-backend/src/services/
 * governed-ai-service.ts (`GovernedAiService.suggest`), documented in
 * docs/development/governed-ai-service-boundary-20260901.md.
 */

const {
  LABEL_HINT_VOCABULARY,
  isFamilyColumn,
  findValueShapeViolation,
  selectVendorPreset,
  validateVendorPreset,
  SOURCE_VENDOR_PRESET_SCHEMA_MARKER,
  SUPPORTED_PRESET_VERSIONS,
} = require('./source-vendor-presets/preset-schema.cjs')

/** The feature tag handed to the boundary for metering + audit. */
const SCHEMA_MAPPING_COPILOT_FEATURE = 'schema-mapping-copilot'
/**
 * THE PRIVACY PIN. Customer PLM schema + dictionary data is BUSINESS class. Every boundary call MUST
 * carry this — the boundary then routes it local-only and refuses any cloud provider. Weakening this to
 * 'non-sensitive' or omitting it is exactly what the witnessed-RED privacy test forbids.
 */
const SCHEMA_MAPPING_COPILOT_DATA_CLASS = 'business'

/** How many opaque columns we will ground per request (defense against a runaway catalog). */
const MAX_GROUNDED_COLUMNS = 60
/** Per-source content cap (the boundary also caps; this is the copilot's own belt). */
const MAX_SIGNAL_CONTENT_CHARS = 500

const COPILOT_ERROR_CODES = Object.freeze({
  SIGNALS_INVALID: 'SCHEMA_MAPPING_COPILOT_SIGNALS_INVALID',
  CONFIRM_INVALID: 'SCHEMA_MAPPING_COPILOT_CONFIRM_INVALID',
  CONFIRM_PRESET_INVALID: 'SCHEMA_MAPPING_COPILOT_CONFIRM_PRESET_INVALID',
})

class SchemaMappingCopilotError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'SchemaMappingCopilotError'
    this.code = code
    if (details && typeof details === 'object') this.details = details
  }
}

// ---------------------------------------------------------------------------
// Signal gathering — reuse the deterministic discovery machinery.
// ---------------------------------------------------------------------------

function asString(value) {
  return typeof value === 'string' ? value : ''
}

function trimTo(value, cap) {
  const s = asString(value)
  return s.length > cap ? s.slice(0, cap) : s
}

/**
 * Deterministic label hint: match a dictionary label against the CLOSED vocabulary that lives in code
 * (LABEL_HINT_VOCABULARY), never in data. Returns the semantic key ('quantity' | 'unit' |
 * 'material-code') or null. This is the same ranking vocabulary the preset schema pins.
 */
function deriveLabelHint(label) {
  const text = asString(label)
  if (!text) return null
  for (const [hint, pattern] of Object.entries(LABEL_HINT_VOCABULARY)) {
    if (pattern.test(text)) return hint
  }
  return null
}

/**
 * Gather the signals a human would stare at, cross-checked by the deterministic discovery:
 *   - `familyDetection`: which vendor family this catalog is (selectVendorPreset over the table names);
 *   - `columnSignals`: per opaque column — is it a generic-slot family member (isFamilyColumn), what
 *     dictionary label names it, the label's deterministic hint, and a values-free sample shape;
 *   - `groundingSources`: the boundary grounding list (each `content` scrubbed of secret shapes);
 *   - `scrubbedCount`: how many values were dropped as secret-shaped (never sent).
 *
 * `presetCatalog` is the SERVER-held vendor preset catalog (committed, values-free structure), never
 * request-supplied — the caller loads it deterministically.
 */
function gatherSchemaSignals(input) {
  if (!input || typeof input !== 'object') {
    throw new SchemaMappingCopilotError(COPILOT_ERROR_CODES.SIGNALS_INVALID, 'signals must be an object')
  }
  const tableNames = Array.isArray(input.tableNames) ? input.tableNames.filter((t) => typeof t === 'string') : []
  const columns = Array.isArray(input.columns) ? input.columns : []
  const dictionaryRows = Array.isArray(input.dictionaryRows) ? input.dictionaryRows : []
  const presetCatalog = Array.isArray(input.presetCatalog) ? input.presetCatalog : []

  if (columns.length === 0) {
    throw new SchemaMappingCopilotError(
      COPILOT_ERROR_CODES.SIGNALS_INVALID,
      'signals.columns must be a non-empty array of { id, name } — the opaque columns to map',
    )
  }

  // (1) Detect the vendor family deterministically. Fail-closed: an ambiguous / no match selects
  //     nothing, and the copilot proceeds family-agnostically (native-column hints only).
  let familyDetection = { presetId: null, reason: 'NO_PRESET_MATCHED' }
  if (presetCatalog.length > 0 && tableNames.length > 0) {
    try {
      const selection = selectVendorPreset(presetCatalog, tableNames)
      familyDetection = {
        presetId: selection.selected ? selection.selected.presetId : null,
        reason: selection.reason,
      }
    } catch (err) {
      // A broken catalog must not take down the copilot; degrade to family-agnostic.
      familyDetection = { presetId: null, reason: 'CATALOG_INVALID' }
    }
  }
  const selectedPreset = familyDetection.presetId
    ? presetCatalog.find((p) => p && p.presetId === familyDetection.presetId) || null
    : null
  const families = selectedPreset && selectedPreset.genericColumnFamilies && typeof selectedPreset.genericColumnFamilies === 'object'
    ? Object.entries(selectedPreset.genericColumnFamilies)
    : []
  // The detected family's own semanticExpectations (committed, values-free structure). The confirm
  // form seeds from these so the human confirms COMPLETE, valid expectations against the AI's evidence.
  const baseSemanticExpectations = selectedPreset && Array.isArray(selectedPreset.semanticExpectations)
    ? selectedPreset.semanticExpectations
    : []

  // (2) Index dictionary rows by the column they name (rows-name-columns mechanism).
  const labelByColumn = new Map()
  let scrubbedCount = 0
  for (const row of dictionaryRows) {
    if (!row || typeof row !== 'object') continue
    const columnName = asString(row.columnName)
    const label = asString(row.label)
    if (!columnName || !label) continue
    // Scrub: a secret-shaped label is dropped, never indexed and never sent.
    if (findValueShapeViolation(columnName) || findValueShapeViolation(label)) {
      scrubbedCount += 1
      continue
    }
    labelByColumn.set(columnName.toLowerCase(), {
      label,
      type: asString(row.type) || null,
      enabled: row.enabled === undefined ? null : Boolean(row.enabled),
    })
  }

  // (3) Per-column signals + grounding sources.
  const columnSignals = []
  const groundingSources = []
  for (const column of columns.slice(0, MAX_GROUNDED_COLUMNS)) {
    if (!column || typeof column !== 'object') continue
    const id = asString(column.id) || asString(column.name)
    const name = asString(column.name)
    if (!id || !name) continue
    // Scrub a secret-shaped column name outright.
    if (findValueShapeViolation(name)) {
      scrubbedCount += 1
      continue
    }

    // Which generic-slot family (if any) is this a member of?
    let familyName = null
    for (const [famName, family] of families) {
      try {
        if (isFamilyColumn(family, name)) {
          familyName = famName
          break
        }
      } catch {
        // A malformed family declaration is ignored for classification.
      }
    }

    const dict = labelByColumn.get(name.toLowerCase()) || null
    const labelHint = dict ? deriveLabelHint(dict.label) : null

    // Values-free-ish sample shape: numbers describing the data, never raw values. If the caller
    // passed raw `sample`, we scrub it and keep only a coarse shape.
    const shape = summarizeSampleShape(column.sampleShape, column.sample)
    if (shape.dropped) scrubbedCount += shape.dropped

    const signal = {
      id,
      name,
      family: familyName,
      isGenericSlot: Boolean(familyName),
      dictLabel: dict ? dict.label : null,
      dictType: dict ? dict.type : null,
      dictEnabled: dict ? dict.enabled : null,
      labelHint,
      sampleShape: shape.shape,
    }
    columnSignals.push(signal)
    groundingSources.push({
      id: `col:${id}`,
      label: name,
      content: trimTo(describeSignal(signal), MAX_SIGNAL_CONTENT_CHARS),
    })
  }

  if (columnSignals.length === 0) {
    throw new SchemaMappingCopilotError(
      COPILOT_ERROR_CODES.SIGNALS_INVALID,
      'no usable columns after scrubbing — every column was empty or secret-shaped',
    )
  }

  return {
    familyDetection,
    selectedPresetId: familyDetection.presetId,
    baseSemanticExpectations,
    columnSignals,
    groundingSources,
    scrubbedCount,
  }
}

/** Coarse, values-free description of a column's samples. Raw values are scrubbed, never summarized. */
function summarizeSampleShape(sampleShape, rawSample) {
  // Prefer a caller-supplied values-free shape.
  if (sampleShape && typeof sampleShape === 'object') {
    const out = {}
    for (const key of ['nonNullRatio', 'distinctRatio', 'numericRatio', 'maxLength']) {
      const v = sampleShape[key]
      if (typeof v === 'number' && Number.isFinite(v)) out[key] = v
    }
    return { shape: out, dropped: 0 }
  }
  // Derive a coarse shape from raw samples WITHOUT ever surfacing a value. Any secret-shaped sample
  // is counted as dropped (belt over the boundary's own redaction).
  if (Array.isArray(rawSample) && rawSample.length > 0) {
    let nonNull = 0
    let numeric = 0
    let maxLen = 0
    let dropped = 0
    for (const value of rawSample) {
      if (value === null || value === undefined || value === '') continue
      const s = String(value)
      if (findValueShapeViolation(s)) {
        dropped += 1
        continue
      }
      nonNull += 1
      if (s.length > maxLen) maxLen = s.length
      if (Number.isFinite(Number(s))) numeric += 1
    }
    const total = rawSample.length
    return {
      shape: {
        nonNullRatio: Number((nonNull / total).toFixed(2)),
        numericRatio: nonNull > 0 ? Number((numeric / nonNull).toFixed(2)) : 0,
        maxLength: maxLen,
      },
      dropped,
    }
  }
  return { shape: {}, dropped: 0 }
}

/** A one-line, values-free-ish signal string for the grounding content. */
function describeSignal(signal) {
  const parts = []
  parts.push(`column "${signal.name}"`)
  if (signal.family) parts.push(`generic-slot family "${signal.family}"`)
  if (signal.dictLabel) parts.push(`dictionary label "${signal.dictLabel}"`)
  if (signal.dictType) parts.push(`dictionary type ${signal.dictType}`)
  if (signal.dictEnabled !== null) parts.push(signal.dictEnabled ? 'enabled' : 'disabled')
  if (signal.labelHint) parts.push(`deterministic label hint: ${signal.labelHint}`)
  const shape = signal.sampleShape || {}
  const shapeBits = Object.entries(shape).map(([k, v]) => `${k}=${v}`)
  if (shapeBits.length > 0) parts.push(`sample shape { ${shapeBits.join(', ')} }`)
  return parts.join('; ')
}

// ---------------------------------------------------------------------------
// The AI proposal (advisory-only, provenance-marked, fail-open).
// ---------------------------------------------------------------------------

function buildCopilotPrompt(signals) {
  const familyLine = signals.selectedPresetId
    ? `The source matches the "${signals.selectedPresetId}" vendor family. Its generic-slot columns carry per-customer dictionary-assigned meanings.`
    : `No known vendor family matched; treat each column on its own signals.`
  return (
    `You are the 列映射副驾 (schema-mapping copilot). For each opaque source column below, PROPOSE its ` +
    `most likely business meaning and explain your reasoning from the grounding ONLY. You are proposing; ` +
    `a human will review and confirm — do NOT invent values, and do NOT assert certainty.\n\n` +
    `${familyLine}\n\n` +
    `Return ONLY a JSON array, one object per column, each: ` +
    `{ "id": "<the [[col:id]] id>", "meaning": "<short business meaning, e.g. 数量 (quantity)>", ` +
    `"semantic": "<kebab id, e.g. bom-line-quantity, or empty>", "reasoning": "<one sentence citing [[id]]>", ` +
    `"confidence": "<low|medium|high>" }. Cite each column's own [[col:id]] in its reasoning.`
  )
}

/**
 * Best-effort parse of the model's JSON array into structured per-column proposals. Never throws — a
 * parse failure yields an empty array and the caller keeps the raw text as advisory blob.
 */
function parseProposals(text) {
  const s = asString(text)
  if (!s) return []
  let jsonSlice = s
  const start = s.indexOf('[')
  const end = s.lastIndexOf(']')
  if (start !== -1 && end !== -1 && end > start) jsonSlice = s.slice(start, end + 1)
  let parsed
  try {
    parsed = JSON.parse(jsonSlice)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      id: asString(item.id).replace(/^col:/, ''),
      meaning: asString(item.meaning),
      semantic: asString(item.semantic),
      reasoning: asString(item.reasoning),
      confidence: ['low', 'medium', 'high'].includes(item.confidence) ? item.confidence : 'low',
    }))
    .filter((p) => p.id)
}

/**
 * Cross-check each AI proposal against the deterministic discovery. Attaches the deterministic evidence
 * (family / dict label / hint) and flags a proposal whose claimed semantic contradicts the hint.
 */
function crossCheckProposals(proposals, columnSignals) {
  const signalById = new Map(columnSignals.map((s) => [s.id, s]))
  const out = []
  for (const signal of columnSignals) {
    const proposal = proposals.find((p) => p.id === signal.id) || null
    const deterministic = {
      family: signal.family,
      dictLabel: signal.dictLabel,
      labelHint: signal.labelHint,
      isGenericSlot: signal.isGenericSlot,
    }
    let agreesWithDiscovery = null
    if (proposal && signal.labelHint) {
      // If the deterministic hint knows the semantic, does the AI's semantic/meaning mention it?
      const claim = `${proposal.semantic} ${proposal.meaning}`.toLowerCase()
      const hintPattern = LABEL_HINT_VOCABULARY[signal.labelHint]
      agreesWithDiscovery = Boolean(
        (hintPattern && hintPattern.test(claim)) || claim.includes(signal.labelHint),
      )
    }
    out.push({
      id: signal.id,
      column: signal.name,
      // The AI half — advisory, clearly separable.
      aiMeaning: proposal ? proposal.meaning : null,
      aiSemantic: proposal ? proposal.semantic : null,
      aiReasoning: proposal ? proposal.reasoning : null,
      aiConfidence: proposal ? proposal.confidence : null,
      // The deterministic half — grounding + cross-check.
      deterministic,
      groundedByDiscovery: Boolean(signal.labelHint || signal.family),
      agreesWithDiscovery,
    })
  }
  // Include AI proposals for ids we did not have a signal for (shouldn't happen, but surface honestly).
  for (const proposal of proposals) {
    if (!signalById.has(proposal.id)) {
      out.push({
        id: proposal.id,
        column: null,
        aiMeaning: proposal.meaning,
        aiSemantic: proposal.semantic,
        aiReasoning: proposal.reasoning,
        aiConfidence: proposal.confidence,
        deterministic: { family: null, dictLabel: null, labelHint: null, isGenericSlot: false },
        groundedByDiscovery: false,
        agreesWithDiscovery: null,
      })
    }
  }
  return out
}

/** The degraded, fail-open result: deterministic hints only, no AI, manual mapping proceeds. */
function manualFallbackResult(signals, reason, message, provenance) {
  return {
    aiAvailable: false,
    reason,
    message: message || 'AI enhancement is unavailable; continue with manual mapping.',
    manualFallback: true,
    familyDetection: signals.familyDetection,
    presetId: signals.selectedPresetId || null,
    baseSemanticExpectations: signals.baseSemanticExpectations || [],
    // The deterministic hints a human uses to map by hand — the copilot degrades to exactly this.
    proposals: crossCheckProposals([], signals.columnSignals),
    citations: [],
    provenance: provenance || null,
    usage: null,
    scrubbedCount: signals.scrubbedCount,
    // STRUCTURAL: a proposal call NEVER yields an authoritative preset.
    authoritativePreset: null,
  }
}

/**
 * Ask the governed boundary to PROPOSE per-column meanings. Advisory-only, provenance-marked,
 * fail-open. `governedAi` is the injected boundary ({ suggest(request, env?) }); absent → manual
 * fallback. NEVER throws for an operational reason and NEVER returns a preset.
 */
async function proposeColumnMappings({ governedAi, signals, env, meterKey } = {}) {
  if (!signals || !Array.isArray(signals.columnSignals)) {
    throw new SchemaMappingCopilotError(COPILOT_ERROR_CODES.SIGNALS_INVALID, 'signals must be gathered first')
  }
  // FAIL-OPEN: boundary not wired → manual mapping.
  if (!governedAi || typeof governedAi.suggest !== 'function') {
    return manualFallbackResult(signals, 'boundary_absent', 'AI boundary is not configured for this deployment.', null)
  }

  let result
  try {
    result = await governedAi.suggest(
      {
        feature: SCHEMA_MAPPING_COPILOT_FEATURE,
        // THE PRIVACY PIN — business data is routed local-only by the boundary.
        dataClass: SCHEMA_MAPPING_COPILOT_DATA_CLASS,
        prompt: buildCopilotPrompt(signals),
        grounding: signals.groundingSources,
        ...(meterKey ? { meterKey } : {}),
      },
      env,
    )
  } catch (err) {
    // The boundary is fail-open by contract, but belt-and-suspenders: any throw degrades to manual.
    return manualFallbackResult(signals, 'internal_error', 'AI request faulted; continue with manual mapping.', null)
  }

  if (!result || result.available !== true) {
    const reason = result && typeof result.reason === 'string' ? result.reason : 'unavailable'
    const message = result && typeof result.message === 'string' ? result.message : undefined
    const provenance = result && result.provenance ? result.provenance : null
    return manualFallbackResult(signals, reason, message, provenance)
  }

  const proposals = parseProposals(result.suggestion)
  return {
    aiAvailable: true,
    reason: null,
    message: null,
    manualFallback: false,
    familyDetection: signals.familyDetection,
    presetId: signals.selectedPresetId || null,
    baseSemanticExpectations: signals.baseSemanticExpectations || [],
    proposals: crossCheckProposals(proposals, signals.columnSignals),
    // The raw AI text is kept for display ("AI 建议·待确认") but is NEVER the authoritative artifact.
    aiSuggestionText: asString(result.suggestion),
    aiParseError: proposals.length === 0,
    citations: Array.isArray(result.citations) ? result.citations : [],
    provenance: result.provenance || null,
    usage: result.usage || null,
    scrubbedCount: signals.scrubbedCount,
    // STRUCTURAL: still null. Only confirmColumnMappingPreset() produces a preset.
    authoritativePreset: null,
  }
}

// ---------------------------------------------------------------------------
// Human-confirm → deterministic preset (THE authoritative artifact).
// ---------------------------------------------------------------------------

const CONFIRM_SOURCES = Object.freeze(['ai-suggested', 'human-set'])
/** semanticExpectation keys carried through confirm — the preset schema owns their validation. */
const EXPECTATION_KEYS = Object.freeze([
  'semantic',
  'locus',
  'columnFamily',
  'dictionary',
  'dictionaryTypeHint',
  'labelHint',
  'valueSetTableFamily',
  'role',
  'roleColumn',
  'note',
])

/** Strip a confirmed-semantic to the bare preset-schema expectation (drop provenance + unknown keys). */
function toExpectation(confirmed) {
  const out = {}
  for (const key of EXPECTATION_KEYS) {
    if (confirmed[key] !== undefined) out[key] = confirmed[key]
  }
  return out
}

/** Derive the structural skeleton from a base preset (everything EXCEPT semanticExpectations). */
function deriveSkeletonFromPreset(basePreset) {
  if (!basePreset || typeof basePreset !== 'object') return null
  const skeleton = {}
  for (const [key, value] of Object.entries(basePreset)) {
    if (key === 'semanticExpectations') continue
    skeleton[key] = value
  }
  return skeleton
}

/**
 * THE AUTHORITATIVE STEP. Take the HUMAN-confirmed column semantics and a base structural skeleton (the
 * detected vendor family's committed preset) and produce a DETERMINISTIC vendor preset, validated by
 * `validateVendorPreset`. The AI's text is NOT here — the input is what the human confirmed.
 *
 *   - `basePreset`: the server-catalog preset for the detected family (values-free structure). NEVER
 *     request-supplied.
 *   - `confirmedSemantics`: [{ ...expectation, source: 'ai-suggested'|'human-set' }] the human confirmed.
 *   - `confirmedBy`: the authenticated actor id (SERVER-STAMPED; never request-supplied).
 *   - `now`: ISO timestamp (server clock).
 *
 * Returns { preset, provenance, aiFieldCount, humanFieldCount }. Throws SchemaMappingCopilotError
 * (CONFIRM_INVALID / CONFIRM_PRESET_INVALID) if the input is malformed or the assembled preset fails
 * deterministic validation — a confirmation can NEVER write an invalid or smuggling preset.
 */
function confirmColumnMappingPreset({ basePreset, confirmedSemantics, confirmedBy, now } = {}) {
  const skeleton = deriveSkeletonFromPreset(basePreset)
  if (!skeleton) {
    throw new SchemaMappingCopilotError(
      COPILOT_ERROR_CODES.CONFIRM_INVALID,
      'a base preset (the detected vendor family skeleton) is required to confirm a mapping',
    )
  }
  if (!Array.isArray(confirmedSemantics) || confirmedSemantics.length === 0) {
    throw new SchemaMappingCopilotError(
      COPILOT_ERROR_CODES.CONFIRM_INVALID,
      'confirmedSemantics must be a non-empty array of confirmed column meanings',
    )
  }
  const actor = asString(confirmedBy).trim()
  if (!actor) {
    throw new SchemaMappingCopilotError(
      COPILOT_ERROR_CODES.CONFIRM_INVALID,
      'confirmedBy (server-stamped actor identity) is required',
    )
  }

  const provenanceFields = []
  const expectations = []
  let aiFieldCount = 0
  let humanFieldCount = 0
  for (const confirmed of confirmedSemantics) {
    if (!confirmed || typeof confirmed !== 'object') {
      throw new SchemaMappingCopilotError(COPILOT_ERROR_CODES.CONFIRM_INVALID, 'each confirmed semantic must be an object')
    }
    const source = asString(confirmed.source)
    if (!CONFIRM_SOURCES.includes(source)) {
      throw new SchemaMappingCopilotError(
        COPILOT_ERROR_CODES.CONFIRM_INVALID,
        `each confirmed semantic must declare source ∈ [${CONFIRM_SOURCES.join(', ')}] (the AI-vs-human provenance)`,
      )
    }
    if (source === 'ai-suggested') aiFieldCount += 1
    else humanFieldCount += 1
    expectations.push(toExpectation(confirmed))
    provenanceFields.push({ semantic: asString(confirmed.semantic), source })
  }

  // Assemble the preset: the committed skeleton + the human-confirmed expectations.
  const preset = {
    ...skeleton,
    presetSchema: SOURCE_VENDOR_PRESET_SCHEMA_MARKER,
    presetVersion: SUPPORTED_PRESET_VERSIONS[SUPPORTED_PRESET_VERSIONS.length - 1],
    semanticExpectations: expectations,
  }

  // THE DETERMINISTIC GATE. The confirmed artifact must pass the #5385 preset schema — this is what
  // makes it authoritative and what structurally refuses a smuggled concrete slot or value.
  const validation = validateVendorPreset(preset)
  if (!validation.ok) {
    throw new SchemaMappingCopilotError(
      COPILOT_ERROR_CODES.CONFIRM_PRESET_INVALID,
      'the confirmed mapping did not produce a valid deterministic preset',
      { errors: validation.errors },
    )
  }

  return {
    preset,
    provenance: {
      confirmedBy: actor,
      confirmedAt: asString(now) || new Date().toISOString(),
      // Which fields the AI suggested vs the human set — the provenance the task requires.
      fields: provenanceFields,
      aiSuggested: aiFieldCount,
      humanSet: humanFieldCount,
    },
    aiFieldCount,
    humanFieldCount,
  }
}

module.exports = {
  SCHEMA_MAPPING_COPILOT_FEATURE,
  SCHEMA_MAPPING_COPILOT_DATA_CLASS,
  COPILOT_ERROR_CODES,
  MAX_GROUNDED_COLUMNS,
  SchemaMappingCopilotError,
  gatherSchemaSignals,
  buildCopilotPrompt,
  parseProposals,
  crossCheckProposals,
  proposeColumnMappings,
  deriveSkeletonFromPreset,
  confirmColumnMappingPreset,
}
