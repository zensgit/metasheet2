'use strict'

// B4 — the approved K3 WISE material-list read binding (S5, per the owner's 20260805 rulings:
// B4ProvenanceDecision=ACTION_PROFILE_VERSION_PLUS_APPROVED_CONFIG_IDENTITY, execution order
// "认证 K3 read profile 并产出 B4 → 冻结 provenance → 构建最终包").
//
// Shape follows the BL1 precedent (read-source-bom-list-by-material-contract.cjs): PURE, LATENT,
// values-free metadata. No adapter, no runtime, no route, no network. This module DECLARES the
// frozen binding content so the runtime mint has a single reviewed source of truth; it executes
// nothing.
//
// TWO-LAYER FREEZE (deliberate, both honest):
//   * CODE layer (this module + its test): the config TEMPLATE below is frozen with the
//     canonical placeholder systemId 'b4-template'; the test pins its store contentKey as a
//     literal. Any content drift — a field added, a mapping changed — is a test RED before it
//     can reach a mint.
//   * RUNTIME layer (the mint, on the target environment): systemId becomes the customer's
//     real external-system id, the store MINTS approvedConfigVersion (contentKeyFor EXCLUDES
//     the caller version — read-source-config-store.cjs — so the caller cannot pick it), and
//     the provenance record captures the REAL identity triple
//     {actionProfileVersion, approvedConfigVersion, configContentKey}.
//
// PROFILE ID GRAMMAR (a correction caught by this certification work): the read-smoke PRESET id
// is 'k3wise.material-list.v1' (hyphen), but actionProfileVersion must satisfy the certification
// module's PROFILE_ID_PATTERN, whose segments allow only [a-z0-9_] — hyphens are INVALID (the
// GIP precedent is bridge.bounded_read.v2, underscore). The two ids therefore differ by exactly
// that grammar: preset 'k3wise.material-list.v1' <-> profile 'k3wise.material_list.v1'. The test
// pins BOTH facts (underscore form valid, hyphen form invalid) so nobody "fixes" one into the
// other.
//
// SUBSET / ROW-BOUND OWNERSHIP: the five-column projection and the 10-per-call / page 1..10
// bounds are PRESET-owned (read-smoke.cjs 'k3wise.material-list.v1', BL0 lock: field list and
// pagination are preset/config-owned, never runtime-request-owned; the adapter THROWS above the
// list bound). This module carries a MIRROR of the expected projection and the test asserts it
// equals the live preset — same tripwire pattern as the endpoint-vocabulary mirror.

const K3WISE_MATERIAL_LIST_ACTION_PROFILE_VERSION = 'k3wise.material_list.v1'
const K3WISE_MATERIAL_LIST_PRESET_ID = 'k3wise.material-list.v1'

// The canonical placeholder the CODE-layer freeze is computed against. Never a real system id.
const B4_TEMPLATE_SYSTEM_ID = 'b4-template'

// Mirror of the preset's projection (owner-ratified data subset). FItemID leads: it is the
// intake's REQUIRED internal id (S4/#4757 — without it every list row was un-ingestable).
const K3WISE_MATERIAL_LIST_EXPECTED_PROJECTION = Object.freeze([
  'FItemID', 'FNumber', 'FName', 'FModel', 'FUnitID',
])

// The frozen config content. Everything here participates in the store contentKey.
// fieldMap carries ONLY the mapping the intake cannot derive by alias: FUnitID -> baseUnit
// (owner ruling: "FUnitID 也需要通过 B4 fieldMap 明确映射,不能依赖 intake 自动识别").
// FItemID/FNumber/FName/FModel are intake-alias-covered (stock-preparation-readonly-intake.cjs)
// and deliberately NOT remapped — a second mapping for an alias-covered column would be a second
// record point for the same fact.
const K3WISE_MATERIAL_LIST_B4_TEMPLATE = Object.freeze({
  version: 1,
  systemId: B4_TEMPLATE_SYSTEM_ID,
  requiredKind: 'erp:k3-wise-webapi',
  object: 'material',
  mode: 'list_page',
  readPath: '/K3API/Material/GetList',
  readMethod: 'POST',
  operations: Object.freeze(['read']),
  containerPaths: Object.freeze(['Data.DATA']),
  actionProfileVersion: K3WISE_MATERIAL_LIST_ACTION_PROFILE_VERSION,
  fieldMap: Object.freeze([
    Object.freeze({ source: 'FUnitID', target: 'baseUnit' }),
  ]),
})

// Build the mint-ready config for a real environment: the ONLY degrees of freedom are the real
// systemId (required) — everything else is the frozen template. There is deliberately no way to
// override any other field through this builder.
function buildK3WiseMaterialListB4Config({ systemId } = {}) {
  if (typeof systemId !== 'string' || systemId.trim().length === 0) {
    throw new Error('buildK3WiseMaterialListB4Config requires the real external-system id')
  }
  return {
    ...K3WISE_MATERIAL_LIST_B4_TEMPLATE,
    operations: [...K3WISE_MATERIAL_LIST_B4_TEMPLATE.operations],
    containerPaths: [...K3WISE_MATERIAL_LIST_B4_TEMPLATE.containerPaths],
    fieldMap: K3WISE_MATERIAL_LIST_B4_TEMPLATE.fieldMap.map((entry) => ({ ...entry })),
    systemId: systemId.trim(),
  }
}

module.exports = {
  B4_TEMPLATE_SYSTEM_ID,
  K3WISE_MATERIAL_LIST_ACTION_PROFILE_VERSION,
  K3WISE_MATERIAL_LIST_PRESET_ID,
  K3WISE_MATERIAL_LIST_EXPECTED_PROJECTION,
  K3WISE_MATERIAL_LIST_B4_TEMPLATE,
  buildK3WiseMaterialListB4Config,
}
