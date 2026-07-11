'use strict'

// K3 WISE BOM/GetList-by-material-id — BL1 CONTRACT / PRESET METADATA ONLY (#1709, per
// docs/development/integration-k3wise-bom-list-by-material-id-design-lock-20260705.md).
//
// Scope fence (BL0 ladder, BL1 = "Contract/config/preset metadata; Runtime opened: None"): this module
// is PURE, LATENT metadata + a registered coarse-code family. It has NO adapter, NO request builder, NO
// probe/read runtime, NO route, NO network, NO K3 call, NO write. The standalone BOM/GetList-by-material
// READ runtime is BL2 (a separate owner opt-in); the package + entity-machine smoke is BL3; the
// composition rerun is BL4. This module only DECLARES the confirmed second-hop contract so BL2 has a
// single, reviewed, values-free source of truth to lock against — it does not execute anything.
//
// Provenance of the K3-facing shape: the deployed configured BOM resolver failed the entity-machine probe
// with UnsupportedAdapterOperationError (blocked before outbound) and its misconfigured filter field made
// K3 reject the request (scalar-Data status envelope, no rows). The correct contract was then supplied
// from the customer's K3 WebAPI docs (#3683): the by-material BOM query filters on FPercentItemID (the
// parent-material column), returns the row array under Data.DATA (uppercase), and the BOM number lives in
// FBOMNumber. The upstream-produced scalar is the material's FItemID value (hop-1's resolver output), which
// fills the [FPercentItemID] filter — so inputName=FItemID (the produced scalar) and filterField=
// FPercentItemID (the K3 query column) are consistent, not contradictory.
//
// VALUES-FREE: every constant here is a K3 FIELD-KEY NAME, an endpoint path, or a structural token — never
// a business value (material number, BOM number, row value). The preset OWNS the endpoint/filter/field
// list/container (BL0 request-contract lock: "endpoint, body, filter expression, field list, response
// containers, and resolver rule are preset/config-owned, never runtime-request-owned").

// The contract was DOC-DERIVED with no by-material example in the docs (#3683
// getListDocProvidedByMaterialExample=false; byMaterialExampleInDocs stays false as a docs fact). The
// controlled runtimeValidated false->true transition happened at BL3 (#3701, 2026-07-06): standalone
// entity-machine smoke PASS on release multitable-onprem-bom-list-bl3-20260706-1e18f85d5 — happy path
// (candidateCount=1, resolved, rule=exactly_one) AND the fail-closed policy check (multi-BOM parent ->
// K3_WISE_BOM_LIST_BY_MATERIAL_AMBIGUOUS, policyConsistent) both proven on real hardware.
const K3WISE_BOM_LIST_BY_MATERIAL_PRESET = Object.freeze({
  preset: 'k3wise.bom-list-by-material-id.v1',
  requiredKind: 'erp:k3-wise-webapi',
  object: 'material-bom-list',
  mode: 'resolver_lookup',
  endpointClass: 'GetList',
  readMethod: 'POST',
  // Doc-derived endpoint; the deployed system's base-URL prefix (e.g. an /K3API/ segment) is registered
  // external-system config, not part of this preset. BL2 locks the exact runtime path + the guard check.
  readPath: 'BOM/GetList',
  // hop-1's approved upstream read produces this scalar (the material's item id); a standalone BL3 smoke
  // may supply it as one private operator key. It is NOT the K3 query column name — see filterField.
  inputName: 'FItemID',
  // The K3 BOM/GetList query column that carries the parent-material id (#3683 live contract).
  filterField: 'FPercentItemID',
  // K3 GetList filter is a bracketed field-key expression: `[<fieldKey>] <op> <value>`. BL2 owns escaping.
  filterDialect: 'bracketed_field_key_expression',
  requestBodyRoot: 'Data',
  selectPage: 2,
  // Row array container in the response envelope {StatusCode, Message, Data:{ROWCOUNT,PAGESIZE,PAGEINDEX,DATA}}.
  rowContainerPath: 'Data.DATA',
  // The winning row's BOM-number field.
  outputField: 'FBOMNumber',
  // No auto-pick: reuse the resolver_lookup unique-only fail-closed multiplicity policy (owner c126/c127).
  resolverRulePolicy: 'unique_only_fail_closed',
  automaticSelectionByStatusVersionDate: false,
  // Per EII-R0 (#3674) + operator confirmation: for this customer the material input is the ERP/K3 key
  // (identity class); PLM drawing→ERP-material mapping is a separate DRAW/XREF concern, out of this chain.
  entryIdentifierClass: 'ID',
  liveContractSource: 'customer_k3_webapi_docs',
  // #3683 caveat: the docs give no by-material example; filterField is derived from the BOM template
  // schema + the generic Filter dialect. Latent until BL2/BL3 prove it.
  byMaterialExampleInDocs: false,
  runtimeValidated: true,
})

// Registered coarse-code family (BL0 error taxonomy). EXACT registered values only — never a
// regex/prefix match. BL2's runtime uses these so a second-hop failure never collapses into a generic
// composition failure during standalone diagnosis. An unknown producer code degrades to the safe fallback.
const K3_WISE_BOM_LIST_BY_MATERIAL_FAILED = 'K3_WISE_BOM_LIST_BY_MATERIAL_FAILED'
const K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES = Object.freeze([
  'K3_WISE_BOM_LIST_BY_MATERIAL_NOT_CONFIGURED',
  'K3_WISE_BOM_LIST_BY_MATERIAL_KEY_INVALID',
  'K3_WISE_BOM_LIST_BY_MATERIAL_REJECTED',
  K3_WISE_BOM_LIST_BY_MATERIAL_FAILED,
  'K3_WISE_BOM_LIST_BY_MATERIAL_SHAPE_MISMATCH',
  'K3_WISE_BOM_LIST_BY_MATERIAL_NOT_FOUND',
  'K3_WISE_BOM_LIST_BY_MATERIAL_AMBIGUOUS',
  'K3_WISE_BOM_LIST_BY_MATERIAL_FIELD_MISSING',
])
const K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODE_SET = new Set(K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES)

// Exact-registered guard (mirrors safeErrorCode in read-source-probe-contract.cjs). Unknown / non-string
// → the generic FAILED fallback, never a passthrough (a leaked business-shaped token cannot ride through).
function safeBomListByMaterialErrorCode(value) {
  if (typeof value !== 'string') return K3_WISE_BOM_LIST_BY_MATERIAL_FAILED
  const code = value.trim()
  return K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODE_SET.has(code) ? code : K3_WISE_BOM_LIST_BY_MATERIAL_FAILED
}

// A shape check BL2 can call to confirm a candidate read-source config matches this preset's identity
// before it wires the runtime (pure predicate; reads only structural fields, never values).
function isBomListByMaterialPresetConfig(config) {
  return Boolean(
    config
    && typeof config === 'object'
    && config.mode === K3WISE_BOM_LIST_BY_MATERIAL_PRESET.mode
    && config.requiredKind === K3WISE_BOM_LIST_BY_MATERIAL_PRESET.requiredKind
    && config.object === K3WISE_BOM_LIST_BY_MATERIAL_PRESET.object,
  )
}

// ── BL2 additions (still pure metadata/predicates; no require, no runtime) ───────────────────────────
//
// BL2 review lock 1 (owner review of #3689, recorded in the BL1 dev-verification MD §4): the identity
// predicate above is NOT a full contract validation. Before any runtime consumes a config that carries
// this preset's identity, the FULL confirmed contract must hold — otherwise a config that "looks like
// the preset" but whose key fields drifted would ride the by-material runtime with a wrong filter
// column / container / output field. This check is values-free: it compares config STRUCTURE against
// the preset constants and returns a coarse drift token (never a config value).

// The confirmed key is the material's numeric FItemID (BL0 lock: "If the confirmed contract requires
// numeric FItemID, non-numeric input fails before any K3 call"). Digits only, bounded — the runtime
// composes the K3 filter with the bare validated number, so no quoting/escaping surface exists at all.
const K3_WISE_BOM_LIST_BY_MATERIAL_KEY_PATTERN = /^[0-9]{1,20}$/

function isBomListByMaterialKeyValid(value) {
  // Safe-integer bound: a precision-lossy large double (e.g. 1e20) can stringify into a digits-only run
  // that no longer equals the caller's intended id — reject it rather than filter on a corrupted key.
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 && K3_WISE_BOM_LIST_BY_MATERIAL_KEY_PATTERN.test(String(value))
  if (typeof value !== 'string') return false
  return K3_WISE_BOM_LIST_BY_MATERIAL_KEY_PATTERN.test(value.trim())
}

// Full-field contract lock. `config` is an S1-normalized read-source config that already matched the
// identity predicate. Returns null when every preset-owned field matches the confirmed contract, else a
// coarse values-free drift token. filterDialect / requestBodyRoot / selectPage / the filter operator and
// body field list are NOT checked here because the config cannot express them at all — they are pinned
// as constants inside the BL2 adapter read mode (the stronger lock).
function bomListByMaterialContractViolation(config) {
  if (!isBomListByMaterialPresetConfig(config)) return 'preset_identity_mismatch'
  if (config.keyField !== K3WISE_BOM_LIST_BY_MATERIAL_PRESET.filterField) return 'filter_field_drift'
  if (config.keyEncoding !== 'numeric_id') return 'key_encoding_drift'
  if (config.readMethod !== K3WISE_BOM_LIST_BY_MATERIAL_PRESET.readMethod) return 'read_method_drift'
  // The deployed system's base-URL prefix (e.g. /K3API) is registered external-system config; the preset
  // owns the trailing endpoint. Anything not ending in the confirmed endpoint is a drift.
  const readPath = typeof config.readPath === 'string' ? config.readPath : ''
  if (readPath !== `/${K3WISE_BOM_LIST_BY_MATERIAL_PRESET.readPath}` && !readPath.endsWith(`/${K3WISE_BOM_LIST_BY_MATERIAL_PRESET.readPath}`)) {
    return 'read_path_drift'
  }
  const containers = config.containerPaths
  if (!Array.isArray(containers) || containers.length !== 1 || containers[0] !== K3WISE_BOM_LIST_BY_MATERIAL_PRESET.rowContainerPath) {
    return 'row_container_drift'
  }
  // unique_only_fail_closed (owner c126/c127) maps to the resolver vocabulary's exactly_one — no sorted
  // auto-pick, no discriminator auto-pick (automaticSelectionByStatusVersionDate=false).
  if (config.resolverRule !== 'exactly_one') return 'resolver_rule_drift'
  const fieldMap = config.fieldMap
  if (!Array.isArray(fieldMap) || fieldMap.length !== 1 || !fieldMap[0] || fieldMap[0].source !== K3WISE_BOM_LIST_BY_MATERIAL_PRESET.outputField) {
    return 'output_field_drift'
  }
  return null
}

// BL0 error-taxonomy mapping: when the shared resolver evaluator fails a by-material lookup, the generic
// resolver code is remapped to this preset's registered family so a second-hop list failure never collapses
// into a generic resolver/composition failure during standalone diagnosis. EXACT keys only — an unmapped
// producer code is left to the caller's safe fallback, never prefix-matched.
const K3_WISE_BOM_LIST_BY_MATERIAL_RESOLVER_CODE_MAP = Object.freeze({
  READ_SOURCE_RESOLVER_NO_MATCH: 'K3_WISE_BOM_LIST_BY_MATERIAL_NOT_FOUND',
  READ_SOURCE_RESOLVER_AMBIGUOUS: 'K3_WISE_BOM_LIST_BY_MATERIAL_AMBIGUOUS',
  // Cap reached = uniqueness cannot be proven within the bounded read — same fail-closed family bucket.
  READ_SOURCE_RESOLVER_CAP_REACHED: 'K3_WISE_BOM_LIST_BY_MATERIAL_AMBIGUOUS',
  READ_SOURCE_RESOLVER_FIELD_MISSING: 'K3_WISE_BOM_LIST_BY_MATERIAL_FIELD_MISSING',
  READ_SOURCE_RESOLVER_SHAPE_MISMATCH: 'K3_WISE_BOM_LIST_BY_MATERIAL_SHAPE_MISMATCH',
  READ_SOURCE_RESOLVER_CONTAINER_NOT_FOUND: 'K3_WISE_BOM_LIST_BY_MATERIAL_SHAPE_MISMATCH',
  READ_SOURCE_RESOLVER_RULE_NOT_SUPPORTED: K3_WISE_BOM_LIST_BY_MATERIAL_FAILED,
  READ_SOURCE_RESOLVER_RULE_INVALID: K3_WISE_BOM_LIST_BY_MATERIAL_FAILED,
  READ_SOURCE_RESOLVER_FAILED: K3_WISE_BOM_LIST_BY_MATERIAL_FAILED,
})

module.exports = {
  K3WISE_BOM_LIST_BY_MATERIAL_PRESET,
  K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES,
  K3_WISE_BOM_LIST_BY_MATERIAL_FAILED,
  K3_WISE_BOM_LIST_BY_MATERIAL_RESOLVER_CODE_MAP,
  safeBomListByMaterialErrorCode,
  isBomListByMaterialPresetConfig,
  isBomListByMaterialKeyValid,
  bomListByMaterialContractViolation,
}
