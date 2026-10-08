'use strict'

// THE MVP SELECT VOCABULARIES — the 18 contract-keyed option sets declared by the nine frozen
// stock-preparation MVP table templates.
//
// WHY THIS FILE EXISTS (a live outage, 2026-08-31). The MVP templates declare their select fields as
// `optionSource: { type: 'contract', key: 'stock_preparation_*_v1' }`. That declaration named a
// vocabulary that NOTHING IN THE PLUGIN COULD RESOLVE:
//
//   * `/mvp/ensure` builds each field's `property` in buildMvpTargetDescriptor and copies the
//     optionSource into `property.stockPreparationMvp.optionSource` as METADATA. It never wrote
//     `property.options`, so every select was created with an EMPTY allowed set.
//   * `/mvp/options/sync` normalised only what the CALLER handed it. With no `optionSets` in the
//     body it took the `mvp_options_not_supplied` branch and returned `ok: true` having patched
//     nothing — and the per-field skip reason it recorded was literally `contract_not_available`.
//
// The multitable record validator reads `property.options: [{ value }]` (extractSelectOptions,
// packages/core-backend/src/multitable/field-codecs.ts) and refuses anything outside it. So the first
// real `mvp-persist` on a fresh deployment failed five times over with `Invalid select option … 'draft'`
// (Snapshot Status, Line Status, Run Type, Status, Project Status) and had to be unblocked by
// hand-seeding the options. The only place these vocabularies were ever written down was
// `buildOptionSetsFixture()` in scripts/ops/stock-preparation-mvp-postdeploy-smoke.mjs — an ops script
// the server cannot import. This module is that fixture, moved to where the server can reach it.
//
// WHAT BELONGS HERE, AND WHAT DOES NOT. These are PLATFORM ENUM LITERALS: the closed vocabularies the
// plugin's own writers emit and its own readers fold against. They are design constants, exactly like
// `PREP_STATUSES` or `LINE_STATUSES`, and they are committed in this repository. They are NOT customer
// values, and nothing customer-shaped may ever be added here — a per-customer vocabulary is
// deployment data and rides `/mvp/options/sync`'s request body, which still wins over every default
// below (see syncStockPreparationMvpOptions).
//
// KEPT HONEST BY A CROSS-CHECK, NOT BY CARE. The catalog is a literal table rather than a set of
// imports, deliberately: importing `stock-preparation-project-reads.cjs` (which pulls in the whole
// table-action stack) from a module the provisioning path requires would build a dependency cycle for
// a handful of strings. Instead `__tests__/stock-preparation-mvp-option-catalog.test.cjs` imports the
// runtime constants live and asserts every value a writer can emit is a member of the matching set —
// so a new status added to `PREP_STATUSES` and forgotten here reddens instead of reaching a customer
// as `Invalid select option`.

/** One frozen option set in the shape the validator reads back: `[{ value }]`, keyed `value`. */
function set(values) {
  return Object.freeze(values.map((value) => Object.freeze({ value })))
}

/**
 * THE CATALOG. Key => the closed vocabulary for every MVP select field declaring that contract key.
 *
 * Two sets are deliberately WIDER than the values today's writers emit, and both widenings are
 * one-directional (an option nothing writes is inert; a missing option is an outage):
 *
 *   stock_preparation_project_status_v1 — carries all five members of `PROJECT_STATUS_VALUES`
 *     (stock-preparation-project-reads.cjs), the closed enum the READ route already folds against.
 *     The ops fixture listed only three, which would have made a stored `paused`/`closed` unwritable
 *     by the very route that reports it.
 *   stock_preparation_match_method_v1 — carries `manual_confirm` alongside the five `MATCH_METHODS`,
 *     because a human confirmation stamps that method on a mapping row.
 */
const STOCK_PREPARATION_MVP_CONTRACT_OPTION_SETS = Object.freeze({
  // plm_stock_preparation_project.projectStatus
  stock_preparation_project_status_v1: set(['active', 'paused', 'closed', 'archived', 'completed']),
  // plm_stock_preparation_bom_snapshot_batch.snapshotStatus — a planned batch is always 'draft'.
  stock_preparation_snapshot_status_v1: set(['draft', 'active', 'superseded', 'rejected']),
  // plm_stock_preparation_bom_snapshot_line.lineStatus — LINE_STATUSES.
  stock_preparation_bom_line_status_v1: set(['active', 'inactive', 'incomplete']),
  // plm_stock_preparation_erp_material_master.materialStatus
  stock_preparation_material_status_v1: set(['active', 'inactive', 'disabled']),
  // plm_stock_preparation_material_mapping.versionPolicy — VERSION_POLICIES.
  stock_preparation_version_policy_v1: set(['drawing_and_version', 'drawing_only', 'category_rule', 'manual']),
  // material_mapping.matchStatus and line.mappingStatus — MATCH_STATUSES / MATERIAL_MATCH_STATUSES.
  stock_preparation_match_status_v1: set(['matched', 'pending_confirm', 'multi_candidate', 'not_found', 'version_conflict']),
  // plm_stock_preparation_material_mapping.matchMethod — MATCH_METHODS + the human stamp.
  stock_preparation_match_method_v1: set([
    'historical_confirmed',
    'exact_code_candidate',
    'normalized_code_candidate',
    'name_spec_candidate',
    'none',
    'manual_confirm',
  ]),
  // plm_stock_preparation_unit_conversion_rule.scopeType — UNIT_SCOPE_PRIORITIES keys.
  stock_preparation_unit_scope_type_v1: set(['material', 'category', 'generic']),
  // plm_stock_preparation_unit_conversion_rule.roundingRule
  stock_preparation_rounding_rule_v1: set(['none', 'ceil', 'floor', 'nearest', 'pack_size']),
  // plm_stock_preparation_unit_conversion_rule.source
  stock_preparation_unit_rule_source_v1: set(['manual', 'system_candidate']),
  // plm_stock_preparation_line.unitStatus — UNIT_STATUSES.
  stock_preparation_unit_status_v1: set(['converted', 'missing_rule', 'conflict']),
  // plm_stock_preparation_line.prepStatus — PREP_STATUSES.
  stock_preparation_prep_status_v1: set(['draft', 'held']),
  // plm_stock_preparation_exception_confirmation.exceptionType — EXCEPTION_TYPES.
  stock_preparation_exception_type_v1: set([
    'missing_mapping',
    'multi_candidate',
    'version_conflict',
    'erp_item_missing',
    'unit_missing',
    'unit_conflict',
    'invalid_qty',
    'missing_child_bom',
  ]),
  // plm_stock_preparation_exception_confirmation.severity
  stock_preparation_exception_severity_v1: set(['info', 'warning', 'blocking']),
  // plm_stock_preparation_exception_confirmation.status
  stock_preparation_exception_status_v1: set(['open', 'resolved', 'ignored', 'deferred']),
  // plm_stock_preparation_exception_confirmation.resolutionAction — RESOLUTION_ACTIONS.
  stock_preparation_resolution_action_v1: set(['mapping_confirmed', 'unit_rule_confirmed', 'accepted_change', 'manual_hold']),
  // plm_stock_preparation_run.runType — a BOM snapshot sync run is 'plm_sync'.
  stock_preparation_run_type_v1: set(['plm_sync', 'erp_material_sync', 'mapping_match', 'unit_match', 'prep_generate']),
  // plm_stock_preparation_run.status
  stock_preparation_run_status_v1: set(['running', 'succeeded', 'failed', 'partial']),
})

const STOCK_PREPARATION_MVP_CONTRACT_OPTION_KEYS = Object.freeze(
  Object.keys(STOCK_PREPARATION_MVP_CONTRACT_OPTION_SETS).sort(),
)

/**
 * The contract-keyed defaults for exactly the templates being targeted, as a plain (mutable) object
 * ready to be merged UNDER the caller's own sets.
 *
 * Scoped to the given templates on purpose: `syncStockPreparationMvpOptions` rejects any source key
 * not declared by a targeted template (OPTION_SYNC_UNKNOWN_SOURCE), so handing it the whole catalog
 * for a single-table sync would turn every other key into a self-inflicted 422.
 *
 * A declared contract key with no catalog entry is simply absent — the field then takes the existing
 * `contract_not_available` skip, which is the current behaviour rather than a new failure.
 */
function contractOptionSetsForTemplates(templates) {
  const out = {}
  for (const template of Array.isArray(templates) ? templates : []) {
    for (const field of (template && Array.isArray(template.fields)) ? template.fields : []) {
      const source = field && field.optionSource
      if (!source || source.type !== 'contract') continue
      const declared = STOCK_PREPARATION_MVP_CONTRACT_OPTION_SETS[source.key]
      if (!declared) continue
      // Cloned: the caller hands this to the option-set normalizer, and the frozen catalog must not
      // be reachable from anything downstream that might mutate an option entry in place.
      out[source.key] = declared.map((option) => ({ ...option }))
    }
  }
  return out
}

module.exports = {
  STOCK_PREPARATION_MVP_CONTRACT_OPTION_SETS,
  STOCK_PREPARATION_MVP_CONTRACT_OPTION_KEYS,
  contractOptionSetsForTemplates,
}
