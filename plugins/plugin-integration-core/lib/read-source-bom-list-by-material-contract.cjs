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

// The confirmed contract is DOC-DERIVED with no by-material example in the docs (#3683
// getListDocProvidedByMaterialExample=false); BL2/BL3 MUST prove it on real hardware before it is trusted.
// runtimeValidated stays false in BL1 by construction.
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
  runtimeValidated: false,
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

module.exports = {
  K3WISE_BOM_LIST_BY_MATERIAL_PRESET,
  K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES,
  K3_WISE_BOM_LIST_BY_MATERIAL_FAILED,
  safeBomListByMaterialErrorCode,
  isBomListByMaterialPresetConfig,
}
