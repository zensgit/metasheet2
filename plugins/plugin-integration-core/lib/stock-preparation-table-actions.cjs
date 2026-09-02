'use strict'

// #2253 C5-1: backend parameterized table action contract for PLM project BOM
// -> stock-preparation. This module wires the already-landed C2/C3/C4 helpers
// without adding UI, migrations, external DB writes, or K3 paths.

const crypto = require('node:crypto')

const {
  PLM_STOCK_PREPARATION_BOM_READ_PLAN,
  STOCK_PREPARATION_BOM_SOURCE_KINDS,
  expandPlmProjectBom,
  isLargeBomBoundedExpansion,
  summarizeBomExpansionForEvidence,
} = require('./stock-preparation-bom-expansion.cjs')
const {
  DECISIONS,
  duplicateExpandedKeyDiagnosticsForRows,
  planStockPreparationConflicts,
  summarizeConflictPlanForEvidence,
} = require('./stock-preparation-conflict-planner.cjs')
const {
  buildConflictPolicyReview,
  loadTableScopeConflictPolicies,
  normalizeRunOnlyConflictPolicyReview,
  POLICY_BOUNDARY_STORED,
} = require('./stock-preparation-conflict-policies.cjs')
// W4 carry opt-in: the deploy-time carryPolicy knob is validated through the
// carry module's OWN closed vocabulary (configuration-not-code: the config can
// only say what the policy module can mean).
const { normalizeCarryPolicy } = require('./stock-preparation-carry-policy.cjs')
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE,
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
  normalizeStockPreparationTemplate,
} = require('./stock-preparation-templates.cjs')
const {
  applyStockPreparationPlan,
  summarizeApplyResultForEvidence,
  // ONE definition of logical->physical translation, not two. This file used to
  // carry its own byte-identical copy of `mapFieldName`, and the `pre_mapped`
  // translation-mode contract depends on the two agreeing; sharing the writer's
  // makes that agreement structural instead of a comment. It also means the
  // writer's refusal to fall back on an unmapped `ext_` id applies here too.
  __internals: { mapFieldName },
} = require('./stock-preparation-apply-writer.cjs')
const {
  assertExtensionFieldIdValid,
  isTenantExtensionField,
} = require('./stock-preparation-extension-namespace.cjs')
const {
  extFieldMappingTargetIds,
  isNormalizedExtFieldMapping,
  summarizeExtFieldMappingForEvidence,
} = require('./stock-preparation-ext-field-mapping.cjs')
const {
  normalizeStockPrepApplyProductionPolicy,
  assertProductionPolicyNotExpired,
} = require('./stock-preparation-production-policy.cjs')
const {
  B2A_PURPOSE_STOCK_PREPARATION_MVP_PERSIST,
  B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
  assertB2aReadAuthorization,
  assertB2aFullBatchComplete,
  assertB2aSchemaContract,
  assertB2aSourceUnchangedAfterRead,
  b2aSchemaContractEvidence,
  runB2aGuardedSourceRead,
  readPlanSourceObjects,
} = require('./b2a-trial-registry.cjs')

const PLM_STOCK_PREPARATION_ACTION_ID = 'plm.stock-preparation.pull-bom.v1'
const TABLE_ACTION_KIND = 'parameterized_table_action'
const GENERIC_TABLE_ACTION_KIND = 'apply_to_target_table'
const DRY_RUN_TOKEN_PREFIX = 'integration:table-action:dry-run-token:'
const DEFAULT_DRY_RUN_TOKEN_TTL_MS = 30 * 60 * 1000
const DEFAULT_EXISTING_ROWS_PAGE_LIMIT = 1000
const DEFAULT_EXISTING_ROWS_MAX_PAGES = 100
const HARD_APPLY_BLOCKING_ROW_ERROR_TYPES = new Set(['missing_child_bom'])

class StockPreparationTableActionError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationTableActionError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', `${field} is required`, { field })
  }
  return normalized
}

function positiveInteger(value, field, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', `${field} must be a positive integer`, { field })
  }
  return number
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function hashJson(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex')
}

function normalizeFieldIdMap(value, field) {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) {
    throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', `${field} must be an object`, { field })
  }
  const out = {}
  for (const [logical, physical] of Object.entries(value)) {
    const logicalName = optionalString(logical)
    const physicalName = optionalString(physical)
    if (logicalName && physicalName) out[logicalName] = physicalName
  }
  return out
}

function normalizeTarget(input = {}) {
  if (!isPlainObject(input)) {
    throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', 'target must be an object', { field: 'target' })
  }
  return {
    sheetId: requiredString(input.sheetId, 'target.sheetId'),
    objectId: optionalString(input.objectId) || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId,
    keyField: optionalString(input.keyField) || 'idempotencyKey',
    fieldIdMap: normalizeFieldIdMap(input.fieldIdMap, 'target.fieldIdMap'),
  }
}

function normalizeSource(input = {}) {
  if (!isPlainObject(input)) {
    throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', 'source must be an object', { field: 'source' })
  }
  const kind = optionalString(input.kind) || 'data-source:sql-readonly'
  if (!STOCK_PREPARATION_BOM_SOURCE_KINDS.includes(kind)) {
    throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', 'source.kind must be data-source:sql-readonly or bridge:legacy-sql-readonly', {
      field: 'source.kind',
    })
  }
  const readPlan = cloneJson(input.readPlan || PLM_STOCK_PREPARATION_BOM_READ_PLAN)
  if (!isPlainObject(readPlan)) {
    throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', 'source.readPlan must be an object', { field: 'source.readPlan' })
  }
  if (!input.readPlan || !optionalString(input.readPlan.sourceKind)) {
    readPlan.sourceKind = kind
  }
  if (optionalString(readPlan.sourceKind) !== kind) {
    throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', 'source.readPlan.sourceKind must match source.kind', {
      field: 'source.readPlan.sourceKind',
    })
  }
  return {
    externalSystemId: requiredString(input.externalSystemId, 'source.externalSystemId'),
    workspaceId: optionalString(input.workspaceId) || undefined,
    kind,
    readPlan,
  }
}

/**
 * The tenant `ext_` columns this action WRITES, and therefore the ones its
 * target must bind a physical id for.
 *
 * Plain `string[]`, deliberately: an action config is snapshotted through
 * `cloneJson` into a large-BOM job row (`actionSnapshot`), so anything that does
 * not survive a JSON round-trip would silently vanish on the stored path and
 * quietly weaken the completeness gate. The list is normally produced by
 * `extFieldMappingTargetIds(mapping)` (stock-preparation-ext-field-mapping.cjs);
 * the mapping object itself stays a runtime input and never enters this config.
 *
 * Fail-closed: every entry must be a valid tenant extension id that does not
 * collide with the template catalog, and duplicates are an error rather than
 * being deduped — a config that lists a column twice is a config someone should
 * look at.
 */
function normalizeActionExtensionFieldIds(input, template) {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) {
    throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', 'extensionFieldIds must be an array', {
      field: 'extensionFieldIds',
    })
  }
  const templateIds = template.fields.map((field) => field.id)
  const seen = new Set()
  const out = []
  for (let index = 0; index < input.length; index += 1) {
    const id = input[index]
    try {
      assertExtensionFieldIdValid(id, { templateFieldIds: templateIds })
    } catch (error) {
      throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', 'extensionFieldIds entry is not a valid tenant extension field id', {
        field: `extensionFieldIds[${index}]`,
        namespaceReason: error && error.reason ? error.reason : 'UNKNOWN',
      })
    }
    if (seen.has(id)) {
      throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', 'extensionFieldIds must be unique', {
        field: `extensionFieldIds[${index}]`,
      })
    }
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * W4 carry opt-in (execution-plan W4a; adjudication Layer 3). Deploy-time config
 * (the INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON world), validated
 * through the carry module's OWN closed vocabulary so config and runtime can
 * never disagree about what a policy means. Absent => null => the key is not
 * added to the normalized action at all (conditional spread, like
 * extensionFieldIds), so every existing config snapshot/hash is byte-identical
 * and the planner runs exactly the pre-wiring path. The normalized object is
 * plain JSON, so it survives the cloneJson ride into a large-BOM job's
 * actionSnapshot unchanged.
 */
function normalizeActionCarryPolicy(input) {
  if (input === undefined || input === null) return null
  try {
    return normalizeCarryPolicy(input)
  } catch (error) {
    throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', 'carryPolicy is not a valid carry policy', {
      field: 'carryPolicy',
      carryPolicyReason: error && error.reason ? error.reason : 'UNKNOWN',
    })
  }
}

function normalizeStockPreparationActionConfig(input = {}) {
  if (!isPlainObject(input)) {
    throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', 'action config must be an object', { field: 'action' })
  }
  const actionId = optionalString(input.actionId) || PLM_STOCK_PREPARATION_ACTION_ID
  if (actionId !== PLM_STOCK_PREPARATION_ACTION_ID) {
    throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', `unsupported actionId: ${actionId}`, { field: 'actionId' })
  }
  const kind = optionalString(input.kind) || TABLE_ACTION_KIND
  if (kind !== TABLE_ACTION_KIND) {
    throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', `unsupported action kind: ${kind}`, { field: 'kind' })
  }
  const template = normalizeStockPreparationTemplate(input.template || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
  const extensionFieldIds = normalizeActionExtensionFieldIds(input.extensionFieldIds, template)
  const carryPolicy = normalizeActionCarryPolicy(input.carryPolicy)
  return {
    actionId,
    kind,
    label: optionalString(input.label) || 'PLM project BOM -> stock preparation',
    configured: true,
    source: normalizeSource(input.source),
    target: normalizeTarget(input.target),
    template,
    // Spread CONDITIONALLY: an action config is snapshotted and hashed in
    // several places, and an unconditional key would move every legacy shape
    // for a feature that config did not ask for.
    ...(extensionFieldIds.length ? { extensionFieldIds } : {}),
    ...(carryPolicy ? { carryPolicy } : {}),
    conflictStrategy: isPlainObject(input.conflictStrategy) ? cloneJson(input.conflictStrategy) : {},
    pageLimit: positiveInteger(input.pageLimit, 'pageLimit', undefined),
    maxPages: positiveInteger(input.maxPages, 'maxPages', undefined),
    maxReadCount: positiveInteger(input.maxReadCount, 'maxReadCount', undefined),
    maxElapsedMs: positiveInteger(input.maxElapsedMs, 'maxElapsedMs', undefined),
    maxDepth: input.maxDepth,
    maxRows: input.maxRows,
  }
}

function targetFieldMapHasExplicitBindings(fieldIdMap = {}) {
  return Object.keys(fieldIdMap || {}).some((field) => optionalString(fieldIdMap[field]))
}

// The human band AS THIS TEMPLATE DECLARES IT — read off the template's own ownership marks rather
// than the frozen HUMAN_PRESERVED_FIELD_IDS list, so a target bound to a template that legitimately
// carries a different set (the sandbox twin, a customer-restamped one) is measured against its own
// columns and never against ids it does not have.
function humanPreservedTemplateFieldIds(template) {
  return template.fields
    .filter((field) => field.ownership === 'human_preserved')
    .map((field) => field.id)
}

function plmSystemFieldIds(template) {
  return template.fields
    .filter((field) => field.ownership === 'plm_system')
    .map((field) => field.id)
}

function assertTargetFieldMapCompleteness(action) {
  if (!targetFieldMapHasExplicitBindings(action.target.fieldIdMap)) return
  // The gate used to cover ONLY the frozen template's plm_system columns, which
  // was complete for as long as no other column could be written. It no longer
  // is: a source->`ext_` mapping puts tenant extension columns into the write
  // payload, and an `ext_` id absent from the map is now a hard failure at the
  // records-API boundary (apply-writer `mapFieldName`) rather than a silent
  // fallback. Covering them HERE turns that late, per-row failure into an
  // up-front, whole-config one — which is the only place a deployer can fix it.
  const extensionFieldIds = Array.isArray(action.extensionFieldIds) ? action.extensionFieldIds : []
  // ...and the HUMAN band, for the same reason one step later in time.
  //
  // The gate used to stop at the plm_system columns plus the declared `ext_` ones, on the reading
  // that apply never writes a human column so a target need not bind one. Apply does not — but the
  // K2 CARRY confirm does (stock-preparation-confirm-writes.cjs applyCarryViaConfirm), and it
  // reaches those columns through this very `fieldIdMap`. So a config binding exactly what this gate
  // asked for passed at deploy time and then refused the first real carry, per request, with a 409
  // the deployer had no way to anticipate — the human band is precisely the band whose whole purpose
  // is to survive a re-key, and the operator met the refusal while trying to save their own work.
  //
  // THIS GATE IS THE ONLY PLACE A DEPLOYER LEARNS WHICH COLUMNS MUST BE BOUND — its 422 is the list
  // they copy from (docs/development/takeover-beiliao-20260821/r6-upgrade-222-runbook.md §4:
  // "列出缺的列照抄即可"). Naming the human band here turns a late, per-click refusal into one
  // up-front, fixable failure, and it costs nothing an in-flow config does not already have: every
  // sanctioned producer emits the whole template today — the offline generator
  // (scripts/ops/stock-preparation-derive-target-binding.mjs, 33/33 ids), the canonical and sandbox
  // ensure verbs (both resolve `templateFieldIds(template)`), and the sandbox twin restamp (the same
  // 33-field template under a new objectId). Only a hand-built map that stopped at this gate's old
  // answer is affected, and for that map this is the message it should have had.
  const humanFieldIds = humanPreservedTemplateFieldIds(action.template)
  const requiredFields = plmSystemFieldIds(action.template)
    .concat(humanFieldIds)
    .concat(extensionFieldIds)
  const missingFields = requiredFields.filter((field) => !optionalString(action.target.fieldIdMap[field]))
  if (missingFields.length === 0) return
  throw new StockPreparationTableActionError(
    422,
    'TARGET_SCHEMA_INCOMPLETE',
    'target.fieldIdMap is missing C5 PLM/system fields',
    {
      targetObjectId: action.target.objectId,
      fieldMapMode: 'explicit',
      missingFields,
      requiredFields,
      // Values-free split so a deployer can tell "the canonical schema drifted"
      // from "a pack column is not bound yet" without diffing two lists.
      ...(missingFields.some((field) => isTenantExtensionField(field))
        ? { missingExtensionFields: missingFields.filter((field) => isTenantExtensionField(field)) }
        : {}),
      // ...and the third kind, added with the human band: "the columns the operator writes in are
      // not bound". Conditional for the same reason as the stanza above — a config missing none of
      // them produces a byte-identical refusal to the one it produced before the band was required.
      ...(missingFields.some((field) => humanFieldIds.includes(field))
        ? { missingHumanFields: missingFields.filter((field) => humanFieldIds.includes(field)) }
        : {}),
    },
  )
}

/**
 * The two halves of "this action writes tenant columns" must agree.
 *
 * `action.extensionFieldIds` is the DURABLE half — it rides the JSON config and
 * the stored job snapshot, and it is what the completeness gate above checks the
 * target against. `extFieldMapping` is the RUNTIME half — the branded object
 * that actually produces the values. A mapping that writes a column the config
 * never declared would slip past the gate and only fail at the records-API
 * boundary, so it is refused here instead.
 *
 * The reverse (a declared id that the mapping does not fill) is NOT an error: a
 * deployer may legitimately bind a column ahead of wiring its source.
 */
function assertExtFieldMappingAgreesWithAction(action, extFieldMapping) {
  if (extFieldMapping === undefined || extFieldMapping === null) return
  if (!isNormalizedExtFieldMapping(extFieldMapping)) {
    throw new StockPreparationTableActionError(
      422,
      'TABLE_ACTION_CONFIG_INVALID',
      'extFieldMapping must be a normalized ext field mapping (normalizeExtFieldMapping)',
      { field: 'extFieldMapping' },
    )
  }
  const declared = new Set(Array.isArray(action.extensionFieldIds) ? action.extensionFieldIds : [])
  const undeclared = extFieldMappingTargetIds(extFieldMapping).filter((id) => !declared.has(id))
  if (undeclared.length === 0) return
  throw new StockPreparationTableActionError(
    422,
    'TARGET_SCHEMA_INCOMPLETE',
    'extFieldMapping writes extension columns the action config does not declare',
    {
      targetObjectId: action.target.objectId,
      mappingId: extFieldMapping.mappingId,
      undeclaredExtensionFields: undeclared,
    },
  )
}

function assertStockPreparationTargetReady(input = {}) {
  const action = normalizeStockPreparationActionConfig(input)
  assertTargetFieldMapCompleteness(action)
  return action
}

function publicActionMetadata(action) {
  const configured = Boolean(action && action.configured === true)
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    kind: TABLE_ACTION_KIND,
    label: 'Apply to target table',
    configured,
    display: {
      genericActionKind: GENERIC_TABLE_ACTION_KIND,
      commandLabel: 'Apply to target table',
      commandLabelZh: 'Apply 到目标表',
      targetLabel: 'configured target table',
      targetLabelZh: '已配置目标表',
      presetLabel: 'PLM stock-preparation preset',
      presetLabelZh: 'PLM 备料预设',
      policyLabel: 'fresh dry-run token + server recompute',
      policyLabelZh: 'fresh dry-run token + 服务端重新计算',
    },
    parameters: [{
      id: 'projectNo',
      label: 'Project number',
      type: 'string',
      required: true,
      trim: true,
    }],
    permissions: {
      dryRun: 'read',
      apply: 'write',
    },
    evidence: {
      valuesFreeIssueEvidence: true,
    },
  }
}

function normalizeActionList(actions) {
  if (actions === undefined || actions === null) return []
  if (Array.isArray(actions)) return actions
  if (isPlainObject(actions)) return Object.values(actions)
  throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', 'table actions config must be an array/object')
}

/**
 * The registry, and THE ONE SEAM THAT MAKES REBINDING A SOURCE A RUNTIME ACT.
 *
 * `actions` is still the deploy-time config, still drained into a Map ONCE at construction (which
 * happens inside `createHandlers`, i.e. at plugin activation). That is correct for everything in it
 * — the target sheet, the template, the read plan, the bounds — because all of those are decisions
 * a deployment makes about ITSELF and a restart is a fine cadence for changing them.
 *
 * `source.externalSystemId` is not that kind of fact, and treating it as one is the single biggest
 * onboarding cost this product has. It is a foreign key into a table the customer's own admin
 * already manages from the same workbench, and "point us at your PLM instead of the demo source"
 * was a change that required an implementer to SSH in, edit
 * INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON, and `pm2 restart` — because the value was
 * captured in this Map at activation and every later request read the snapshot.
 *
 * `resolveSourceBinding` is how that stops being true, and WHERE it sits is the whole design:
 *
 *   * it is consulted INSIDE `getTableAction`, which every stock-prep route already calls per
 *     request (dry-run, apply, mvp-persist, large-BOM start/run, reconcile, readiness, the hub
 *     overview join). So a binding written at 10:00 is read by the 10:00:01 request. No restart, no
 *     plugin reload, no cache to invalidate — because there is no cache: the override was never
 *     read until the request asked for it.
 *   * it is consulted AFTER `cloneJson`, so the override mutates this request's private copy and
 *     the deploy-time snapshot in `configs` is never written to. Two tenants resolving different
 *     sources concurrently cannot see each other's.
 *   * it overrides EXACTLY ONE FIELD. `kind`, `readPlan`, `workspaceId`, target, template and bounds
 *     all stay deploy-time. A persisted value that could move `kind` or `readPlan` would let a
 *     workbench click change WHAT IS READ and HOW, not merely WHERE FROM, and would put a
 *     request-reachable path into the B2a registration's `sourceSystemType` / `objectScope`
 *     matching. It cannot: this assigns to `externalSystemId` and nothing else.
 *   * the override is then RE-NORMALIZED through `normalizeSource`, so a stored empty string, a
 *     stored non-string, or a stored value that would fail `requiredString` is refused HERE rather
 *     than reaching `loadTableActionSourceAdapter` as a malformed lookup.
 *
 * FAIL-CLOSED, in both of its directions:
 *   * a resolver that THROWS propagates. It does not fall back to the env default — "the binding
 *     table is unreachable" and "no binding exists" are different facts, and quietly serving the
 *     synthetic demo source because a query failed is exactly the silent-wrong-source failure this
 *     whole line exists to prevent.
 *   * a resolver that returns null/undefined means NO OVERRIDE, and the env default stands. That is
 *     the pre-migration state and it is byte-identical to the behaviour before this seam existed —
 *     which is what lets an existing deployment upgrade without touching anything.
 *   * a wired resolver invoked WITHOUT a tenant scope is refused, not skipped. Silently declining to
 *     look up an override because the caller forgot to pass a tenant would resolve the env default
 *     while an admin's chosen source sat unread in the table, and it would do so invisibly. Every
 *     stock-prep call site passes a scope; a future one that forgets gets a 500 naming the omission.
 *
 * NOTE WHAT THIS DOES NOT RELAX. `loadTableActionSourceAdapter` still re-checks the resolved system:
 * it must exist in the caller's tenant, and `system.kind` must equal `action.source.kind`, or the
 * read is refused with TABLE_ACTION_SOURCE_INVALID before any adapter is built. So a binding row
 * left dangling by a later delete, or one written against a system whose kind no longer matches,
 * fails loudly at read time rather than reading the wrong place.
 */
function createStockPreparationTableActionRegistry({ actions, resolveSourceBinding } = {}) {
  const configs = new Map()
  for (const action of normalizeActionList(actions)) {
    const normalized = normalizeStockPreparationActionConfig(action)
    configs.set(normalized.actionId, normalized)
  }
  const sourceBindingResolver = typeof resolveSourceBinding === 'function' ? resolveSourceBinding : null

  async function applyPersistedSourceBinding(action, input) {
    if (!sourceBindingResolver) return action
    const tenantId = optionalString(input.tenantId)
    if (!tenantId) {
      throw new StockPreparationTableActionError(
        500,
        'TABLE_ACTION_SOURCE_BINDING_SCOPE_REQUIRED',
        'a persisted source binding is configured but this table-action lookup carried no tenant scope',
        { actionId: action.actionId },
      )
    }
    const bound = optionalString(await sourceBindingResolver({
      tenantId,
      workspaceId: optionalString(input.workspaceId),
      actionId: action.actionId,
    }))
    if (!bound) return action
    // Re-normalize rather than assigning in place: `normalizeSource` is the ONE definition of what a
    // valid source is, and a stored value has to clear the same bar a configured one does.
    return { ...action, source: normalizeSource({ ...action.source, externalSystemId: bound }) }
  }

  return {
    async listTableActions() {
      const action = configs.get(PLM_STOCK_PREPARATION_ACTION_ID)
      // Deliberately NOT binding-resolved: `publicActionMetadata` projects the action's SHAPE
      // (parameters, permissions, labels, whether it is configured at all) and names no source, so
      // resolving one here would be a per-request lookup nothing reads.
      return [publicActionMetadata(action)]
    },
    async getTableAction(input = {}) {
      const actionId = optionalString(input.actionId) || PLM_STOCK_PREPARATION_ACTION_ID
      if (actionId !== PLM_STOCK_PREPARATION_ACTION_ID) {
        throw new StockPreparationTableActionError(404, 'TABLE_ACTION_NOT_FOUND', `table action not found: ${actionId}`, { actionId })
      }
      const action = configs.get(actionId)
      if (!action) {
        throw new StockPreparationTableActionError(422, 'TABLE_ACTION_NOT_CONFIGURED', `table action is not configured: ${actionId}`, { actionId })
      }
      return applyPersistedSourceBinding(cloneJson(action), input)
    },
  }
}

function normalizeActionParameters(value) {
  if (!isPlainObject(value)) {
    throw new StockPreparationTableActionError(400, 'TABLE_ACTION_PARAMETERS_INVALID', 'parameters must be an object', { field: 'parameters' })
  }
  const allowed = new Set(['projectNo'])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new StockPreparationTableActionError(400, 'TABLE_ACTION_PARAMETERS_INVALID', `unsupported parameter: ${key}`, { field: `parameters.${key}` })
    }
  }
  const projectNo = optionalString(value.projectNo)
  if (!projectNo) {
    throw new StockPreparationTableActionError(400, 'TABLE_ACTION_PARAMETERS_INVALID', 'projectNo is required', { field: 'parameters.projectNo' })
  }
  return { projectNo }
}

function ensureRecordsApi(recordsApi) {
  if (!recordsApi || typeof recordsApi.queryRecords !== 'function') {
    throw new StockPreparationTableActionError(501, 'TABLE_ACTION_RECORDS_API_UNAVAILABLE', 'table action requires multitable.records.queryRecords')
  }
  return recordsApi
}

function ensureWriteRecordsApi(recordsApi) {
  ensureRecordsApi(recordsApi)
  if (typeof recordsApi.createRecord !== 'function' || typeof recordsApi.patchRecord !== 'function') {
    throw new StockPreparationTableActionError(501, 'TABLE_ACTION_RECORDS_API_UNAVAILABLE', 'table action apply requires queryRecords/createRecord/patchRecord')
  }
  return recordsApi
}

function unmapRecordFields(record, fieldIdMap = {}) {
  const data = isPlainObject(record && record.data) ? record.data : record
  const inverse = {}
  for (const [logical, physical] of Object.entries(fieldIdMap || {})) inverse[physical] = logical
  const out = {}
  for (const [field, value] of Object.entries(data || {})) {
    out[inverse[field] || field] = value
  }
  return out
}

async function readExistingStockPreparationRows(recordsApi, target, projectNo, options = {}) {
  const api = ensureRecordsApi(recordsApi)
  const limit = positiveInteger(options.limit, 'existingRows.limit', DEFAULT_EXISTING_ROWS_PAGE_LIMIT)
  const maxPages = positiveInteger(options.maxPages, 'existingRows.maxPages', DEFAULT_EXISTING_ROWS_MAX_PAGES)
  const rows = []
  const filters = {
    [mapFieldName('projectNo', target.fieldIdMap)]: projectNo,
  }
  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * limit
    const pageRows = await api.queryRecords({
      sheetId: target.sheetId,
      filters,
      limit,
      offset,
    })
    if (!Array.isArray(pageRows)) {
      throw new StockPreparationTableActionError(500, 'TABLE_ACTION_RECORDS_API_INVALID', 'queryRecords must return an array')
    }
    rows.push(...pageRows.map((row) => unmapRecordFields(row, target.fieldIdMap)))
    if (pageRows.length < limit) return rows
  }
  throw new StockPreparationTableActionError(422, 'TABLE_ACTION_EXISTING_ROWS_TOO_LARGE', 'existing stock-preparation rows exceeded maxPages', {
    maxPages,
  })
}

// ── #4160: logical-key <-> physical fieldId translation, bound to the ONE records entry point ──────
//
// The frozen templates declare LOGICAL field keys ('snapshotBatchId'); provisioning materializes each
// one as a DERIVED physical fieldId ('fld_<sha1(projectId:objectId:fieldId)>' — see the platform's
// getObjectFieldId). The multitable records service only ever speaks physical ids: an unknown key is
// rejected outright by buildNormalizedPatch (writes) and normalizeQueryFilters (filters), and the rows
// it returns are keyed by physical id. So EVERY stock-preparation read and write must translate.
//
// The translation is bound HERE — inside the single target-scoped records API that every stock-prep
// records call already goes through — precisely so that "forgot to call resolveFieldIds" stops being a
// convention a module can silently omit (which is exactly how #4160 shipped) and becomes structurally
// impossible. There are exactly TWO modes and a target that declares NEITHER is REJECTED (fail-closed):
//
//   'logical'    (default) — the caller passes `provisioning` + the staging `projectId`; the map is
//                  resolved HERE from the target's frozen template via provisioning.resolveFieldIds.
//                  Writes (data / changes) and reads (filters) are translated key-by-key, an UNKNOWN
//                  logical key THROWS (never a silent drop), and returned rows are translated BACK so
//                  callers keep reading/writing logical keys.
//   'pre_mapped'          — the C4 apply path only: its writer already maps every payload key through
//                  the operator-configured `target.fieldIdMap`, so this API must not map a second time.
//                  Both of its call sites pass the mode EXPLICITLY — an opt-out you cannot fall into.
const FIELD_ID_TRANSLATION_MODES = Object.freeze(['logical', 'pre_mapped'])
const MVP_TEMPLATE_BY_OBJECT_ID = new Map(
  // The confirmation-decision LEDGER template rides the same registry so its
  // scoped records API translates logical keys exactly like the MVP tables'.
  // It is NOT thereby part of the frozen nine-table MVP surface.
  //
  // The CANONICAL main-table template rides it too. It was added for ONE consumer
  // — confirm-writes' applyCarryViaConfirm, whose K2 confirm write used to address
  // a provisioning-resolved canonical sheet by logical field keys — and that
  // consumer NO LONGER USES IT: the carry executor now takes the bound table
  // action's `target` and translates through the target's own `fieldIdMap`,
  // because this registry is keyed by objectId and a sandbox twin's restamped
  // objectId is not in it (see that module's carry header). The entry is retained
  // rather than removed: membership grants TRANSLATION only, never authorization,
  // and each module's own guard (confirm-writes MVP_OBJECT_ID_SET, the ledger's
  // pinned OBJECT_ID, the carry executor's bound target) stays the wall.
  [...STOCK_PREPARATION_MVP_TABLE_TEMPLATES, STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE, STOCK_PREPARATION_MAIN_TABLE_TEMPLATE]
    .map((template) => [template.objectId, template]),
)

// Resolve the target objectId's frozen logical field ids to physical ids. Fail-closed on every step:
// an unknown objectId, a provisioning API without resolveFieldIds, or ANY declared logical field the
// platform did not resolve — a partial map would silently drop columns on write.
async function resolveTargetFieldIds(provisioning, projectId, objectId) {
  const template = MVP_TEMPLATE_BY_OBJECT_ID.get(objectId)
  if (!template) {
    throw new StockPreparationTableActionError(500, 'TABLE_ACTION_FIELD_IDS_UNRESOLVED', 'target objectId has no frozen stock-preparation template to resolve field ids from', { objectId })
  }
  if (!provisioning || typeof provisioning.resolveFieldIds !== 'function' || !optionalString(projectId)) {
    throw new StockPreparationTableActionError(503, 'TABLE_ACTION_FIELD_IDS_UNRESOLVED', 'target-scoped records API requires multitable.provisioning.resolveFieldIds and the resolution projectId', { objectId })
  }
  const fieldIds = template.fields.map((field) => field.id)
  const resolved = await provisioning.resolveFieldIds({ projectId, objectId, fieldIds })
  const map = {}
  const missingFields = []
  for (const fieldId of fieldIds) {
    const physical = optionalString(isPlainObject(resolved) ? resolved[fieldId] : null)
    if (physical) map[fieldId] = physical
    else missingFields.push(fieldId)
  }
  if (missingFields.length > 0) {
    throw new StockPreparationTableActionError(500, 'TABLE_ACTION_FIELD_IDS_UNRESOLVED', 'target-scoped records API could not resolve every declared field id', { objectId, missingFields })
  }
  return map
}

function validateResolvedTargetFieldIds(objectId, candidate) {
  const template = MVP_TEMPLATE_BY_OBJECT_ID.get(objectId)
  if (!template || !isPlainObject(candidate)) {
    throw new StockPreparationTableActionError(500, 'TABLE_ACTION_FIELD_IDS_UNRESOLVED', 'pre-resolved target field ids are invalid', { objectId })
  }
  const expected = template.fields.map((field) => field.id)
  if (Object.keys(candidate).length !== expected.length) {
    throw new StockPreparationTableActionError(500, 'TABLE_ACTION_FIELD_IDS_UNRESOLVED', 'pre-resolved target field ids are incomplete', { objectId })
  }
  const out = {}
  for (const fieldId of expected) {
    const physical = optionalString(candidate[fieldId])
    if (!physical) {
      throw new StockPreparationTableActionError(500, 'TABLE_ACTION_FIELD_IDS_UNRESOLVED', 'pre-resolved target field ids are incomplete', { objectId })
    }
    out[fieldId] = physical
  }
  return out
}

function invertFieldIdMap(fieldIds) {
  const inverse = {}
  for (const [logical, physical] of Object.entries(fieldIds)) inverse[physical] = logical
  return inverse
}

// Fail-closed key translation: an unknown logical key THROWS. Silently dropping it would write a row
// that is missing a column the caller believed it had written — a green lie.
function toPhysicalFieldId(logicalKey, fieldIds, objectId, part) {
  const physical = fieldIds[logicalKey]
  if (!physical) {
    throw new StockPreparationTableActionError(500, 'TABLE_ACTION_UNKNOWN_LOGICAL_FIELD', 'records API call used a field the target template does not declare', {
      field: logicalKey,
      part,
      targetObjectId: objectId,
    })
  }
  return physical
}

function toPhysicalKeys(source, fieldIds, objectId, part) {
  const out = {}
  for (const [key, value] of Object.entries(isPlainObject(source) ? source : {})) {
    out[toPhysicalFieldId(key, fieldIds, objectId, part)] = value
  }
  return out
}

// Reverse direction: the records service returns { id, sheetId, version, data: { <physical>: value } }.
// Only `data` keys are translated — id / sheetId / version (and the recordId the callers patch by) are
// platform identities and pass through untouched. A physical key with no logical twin (a field outside
// the frozen template) is passed through as-is rather than dropped.
function toLogicalRecord(record, inverse) {
  if (!isPlainObject(record) || !isPlainObject(record.data)) return record
  const data = {}
  for (const [key, value] of Object.entries(record.data)) {
    data[Object.prototype.hasOwnProperty.call(inverse, key) ? inverse[key] : key] = value
  }
  return { ...record, data }
}

async function createTargetScopedRecordsApi(recordsApi, target, options = {}) {
  const readOnly = options.readOnly === true
  const api = readOnly ? ensureRecordsApi(recordsApi) : ensureWriteRecordsApi(recordsApi)
  const mode = optionalString(options.fieldIdTranslation) || 'logical'
  if (!FIELD_ID_TRANSLATION_MODES.includes(mode)) {
    throw new StockPreparationTableActionError(500, 'TABLE_ACTION_FIELD_ID_TRANSLATION_INVALID', 'unsupported fieldIdTranslation mode', { fieldIdTranslation: mode })
  }
  const objectId = optionalString(target && target.objectId)
  const fieldIds = mode === 'logical'
    ? options.resolvedFieldIds
      ? validateResolvedTargetFieldIds(objectId, options.resolvedFieldIds)
      : await resolveTargetFieldIds(options.provisioning, options.projectId, objectId)
    : null
  const inverse = fieldIds ? invertFieldIdMap(fieldIds) : null

  function withTargetSheet(input = {}) {
    if (input.sheetId && input.sheetId !== target.sheetId) {
      throw new StockPreparationTableActionError(403, 'TABLE_ACTION_TARGET_SCOPE_VIOLATION', 'records API call attempted to leave configured target sheet')
    }
    return { ...input, sheetId: target.sheetId }
  }

  async function queryRecords(input = {}) {
    const scoped = withTargetSheet(input)
    if (mode === 'pre_mapped') return api.queryRecords(scoped)
    if (scoped.filters !== undefined) scoped.filters = toPhysicalKeys(scoped.filters, fieldIds, objectId, 'filters')
    const rows = await api.queryRecords(scoped)
    // A non-array passes straight through so each caller's own "queryRecords must return an array"
    // guard still fires (rather than being masked by a mapping TypeError).
    return Array.isArray(rows) ? rows.map((row) => toLogicalRecord(row, inverse)) : rows
  }

  const scopedApi = { queryRecords }
  if (readOnly) return scopedApi

  scopedApi.createRecord = async function createRecord(input = {}) {
    const scoped = withTargetSheet(input)
    if (mode === 'pre_mapped') return api.createRecord(scoped)
    scoped.data = toPhysicalKeys(scoped.data, fieldIds, objectId, 'data')
    return toLogicalRecord(await api.createRecord(scoped), inverse)
  }
  scopedApi.patchRecord = async function patchRecord(input = {}) {
    const scoped = withTargetSheet(input)
    if (mode === 'pre_mapped') return api.patchRecord(scoped)
    scoped.changes = toPhysicalKeys(scoped.changes, fieldIds, objectId, 'changes')
    return toLogicalRecord(await api.patchRecord(scoped), inverse)
  }
  return scopedApi
}

function emptyPlan() {
  return {
    valid: true,
    runId: 'dry-run',
    plannedAt: null,
    decisions: [],
    counts: {
      [DECISIONS.ADD]: 0,
      [DECISIONS.UPDATE]: 0,
      [DECISIONS.SKIP]: 0,
      [DECISIONS.INACTIVE]: 0,
      [DECISIONS.MANUAL_CONFIRM]: 0,
    },
    summary: {
      runIdPresent: false,
      plannedAtPresent: false,
      counts: {
        [DECISIONS.ADD]: 0,
        [DECISIONS.UPDATE]: 0,
        [DECISIONS.SKIP]: 0,
        [DECISIONS.INACTIVE]: 0,
        [DECISIONS.MANUAL_CONFIRM]: 0,
      },
      expandedRows: 0,
      existingRows: 0,
      rowErrors: 0,
      humanPreservedFields: [],
      plmSystemFields: [],
      conflictTypes: [],
    },
  }
}

function buildRevision({ action, parameters, expansion, existingRows, conflictPolicyReview, plan }) {
  return hashJson({
    actionId: action.actionId,
    parameters,
    source: {
      externalSystemId: action.source.externalSystemId,
      workspaceId: action.source.workspaceId,
      readPlan: action.source.readPlan,
    },
    target: action.target,
    expansion: {
      status: expansion.status,
      rows: expansion.rows,
      errors: expansion.errors,
      rowErrors: expansion.rowErrors,
    },
    existingRows,
    conflictPolicyReview: conflictPolicyReview || null,
    plan: plan
      ? {
          counts: plan.counts,
          valid: plan.valid === true,
          conflictTypes: plan.summary && plan.summary.conflictTypes,
          duplicateExpandedKeyResolution: plan.summary && plan.summary.duplicateExpandedKeyResolution,
          // A dry-run token is a promise about WHAT WILL BE WRITTEN, so the pack-aware
          // writable/human bands belong in the revision: if a pack install lands between
          // dry-run and apply, the projected payloads move and the token must stop matching.
          // Spread CONDITIONALLY — stableStringify emits explicitly-undefined keys, so an
          // unconditional key would move every legacy revision hash.
          ...(plan.summary && plan.summary.packAwareOwnership
            ? { packAwareOwnership: plan.summary.packAwareOwnership }
            : {}),
        }
      : null,
  })
}

// Confirmation-ledger readback merge (FIRST CUT: duplicate_expanded_key x
// keep_multiple_rows only). The ledger review arrives in the SAME shape the
// stored table-scope review uses ({ policies: [{ fingerprint, policy }] }), so
// the planner consumes ONE review vocabulary. When the stored table-scope
// policy and a confirmed ledger decision disagree on a fingerprint, NEITHER
// wins: the selection is dropped and the planner holds the group.
function mergeTableScopeConflictPolicyReviews(tableScopeReview, confirmationDecisionReview) {
  const existingRows = isPlainObject(tableScopeReview) && Array.isArray(tableScopeReview.policies)
    ? tableScopeReview.policies
    : []
  const confirmedRows = isPlainObject(confirmationDecisionReview) && Array.isArray(confirmationDecisionReview.policies)
    ? confirmationDecisionReview.policies
    : []
  const byFingerprint = new Map()
  const conflicts = new Set()
  for (const row of existingRows) {
    if (!isPlainObject(row) || typeof row.fingerprint !== 'string' || typeof row.policy !== 'string') continue
    byFingerprint.set(row.fingerprint, { ...row })
  }
  for (const row of confirmedRows) {
    if (!isPlainObject(row) || typeof row.fingerprint !== 'string' || typeof row.policy !== 'string') continue
    const existing = byFingerprint.get(row.fingerprint)
    if (existing && existing.policy !== row.policy) {
      // Two durable sources disagree. Removing the selection makes the planner
      // hold the group; neither source silently wins.
      byFingerprint.delete(row.fingerprint)
      conflicts.add(row.fingerprint)
      continue
    }
    if (!conflicts.has(row.fingerprint)) byFingerprint.set(row.fingerprint, { ...row })
  }
  return {
    scope: 'table_scope',
    policies: Array.from(byFingerprint.values()),
    confirmationDecisionPolicyCount: confirmedRows.length,
    conflictingPolicyCount: conflicts.size,
  }
}

function confirmationDecisionEvidence(review, inputRevision) {
  if (!isPlainObject(review)) return undefined
  return {
    inputRevision,
    matchedPolicyCount: Number(review.confirmationDecisionPolicyCount || 0),
    conflictingPolicyCount: Number(review.conflictingPolicyCount || 0),
  }
}

function duplicateReviewEffectSummary(resolution) {
  if (!isPlainObject(resolution) || resolution.conflictType !== 'duplicate_expanded_key') return null
  const effects = new Map()
  const resolved = Array.isArray(resolution.resolvedPolicies) ? resolution.resolvedPolicies : []
  for (const row of resolved) {
    if (isPlainObject(row) && typeof row.fingerprint === 'string') effects.set(row.fingerprint, 'add_decisions_require_ack')
  }
  const held = Array.isArray(resolution.heldPolicies) ? resolution.heldPolicies : []
  for (const row of held) {
    if (isPlainObject(row) && typeof row.fingerprint === 'string' && !effects.has(row.fingerprint)) {
      effects.set(row.fingerprint, 'manual_confirm_held')
    }
  }
  if (effects.size === 0) return null
  return effects
}

function conflictPolicyReviewForEvidence(review, plan) {
  if (!isPlainObject(review)) return review
  const resolution = plan && plan.summary && plan.summary.duplicateExpandedKeyResolution
  const effects = duplicateReviewEffectSummary(resolution)
  if (!effects) return review
  let resolvedCount = 0
  let heldCount = 0
  const selectedPolicies = Array.isArray(review.selectedPolicies)
    ? review.selectedPolicies.map((row) => {
        if (!isPlainObject(row) || typeof row.fingerprint !== 'string') return row
        const writeEffect = effects.get(row.fingerprint)
        if (!writeEffect) return { ...row }
        if (writeEffect === 'add_decisions_require_ack') resolvedCount += 1
        if (writeEffect === 'manual_confirm_held') heldCount += 1
        return { ...row, writeEffect }
      })
    : review.selectedPolicies
  let writeEffect = review.writeEffect
  if (resolvedCount > 0 && heldCount > 0) {
    writeEffect = 'mixed_duplicate_resolution'
  } else if (resolvedCount > 0) {
    writeEffect = 'add_decisions_require_ack'
  }
  return {
    ...review,
    writeEffect,
    selectedPolicies,
  }
}

function tokenStoreKey(token) {
  return `${DRY_RUN_TOKEN_PREFIX}${token}`
}

function requireTokenStore(tokenStore) {
  if (!tokenStore || typeof tokenStore.get !== 'function' || typeof tokenStore.set !== 'function') {
    throw new StockPreparationTableActionError(501, 'TABLE_ACTION_TOKEN_STORE_UNAVAILABLE', 'table action requires plugin storage for dry-run tokens')
  }
  return tokenStore
}

async function createDryRunToken(tokenStore, record) {
  const store = requireTokenStore(tokenStore)
  const token = crypto.randomBytes(24).toString('base64url')
  await store.set(tokenStoreKey(token), {
    ...record,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + DEFAULT_DRY_RUN_TOKEN_TTL_MS).toISOString(),
  })
  return token
}

async function consumeDryRunToken(tokenStore, token, expected) {
  const store = requireTokenStore(tokenStore)
  const dryRunToken = optionalString(token)
  if (!dryRunToken) {
    throw new StockPreparationTableActionError(400, 'TABLE_ACTION_DRY_RUN_TOKEN_REQUIRED', 'dryRunToken is required for apply', { field: 'confirm.dryRunToken' })
  }
  const key = tokenStoreKey(dryRunToken)
  const stored = await store.get(key)
  if (typeof store.delete === 'function') await store.delete(key)
  if (!isPlainObject(stored)) {
    throw new StockPreparationTableActionError(409, 'TABLE_ACTION_DRY_RUN_TOKEN_INVALID', 'dryRunToken is missing, expired, or already used')
  }
  const expiresAt = Date.parse(stored.expiresAt)
  if (!Number.isNaN(expiresAt) && expiresAt < Date.now()) {
    throw new StockPreparationTableActionError(409, 'TABLE_ACTION_DRY_RUN_TOKEN_INVALID', 'dryRunToken is expired')
  }
  if (stored.actionId !== expected.actionId || stored.parametersHash !== expected.parametersHash || (expected.revision && stored.revision !== expected.revision)) {
    throw new StockPreparationTableActionError(409, 'TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH', 'dryRunToken does not match the current dry-run revision')
  }
  return stored
}

// `installedFieldProperties` (OPTIONAL) is the ownership projection of what is actually
// installed on the target sheet — the `property.stockPreparation` stanza per column. It is
// threaded through, never fetched here: this module still has no fields-listing primitive
// (multitable provisioning exposes only per-field reads, and adding an enumeration primitive
// would be a plugin-API contract change handing every plugin whole-schema access).
//
// THE SEAM IS NOW PLUGGED IN. The gap this comment used to describe — "no pack-installation
// registry exists to enumerate the pack's ids, so today's HTTP route supplies nothing" — was
// closed by the customer-pack INSTALL LEDGER (integration_stock_prep_pack_installs, migration
// 076) plus the read-back seam in stock-preparation-pack-installed-fields.cjs: the ledger names
// the candidate `ext_` ids, readObjectFieldsContent says which of them are still live and how
// they are classified, and the small-BOM dry-run/apply routes now supply the result here. The
// large-BOM checkpoint path still supplies nothing and stays on the legacy bands; it plans into
// a stored job, so wiring it is a separate change.
//
// The LEGACY POSTURE remains safe by construction and remains the fallback: omission yields
// exactly the pre-pack writable set, and since the pack's `ext_` columns are then in neither
// band, the refresh writes strictly FEWER columns rather than more. That is why the seam
// degrades to `undefined` on any ledger/host read failure instead of failing the refresh.
// See derivePackAwarePlmWritableFields in the conflict planner.
//
// `extFieldMapping` (OPTIONAL) is the third input of the same family and is threaded the same way:
// produced once at route registration from server config (stock-preparation-ext-field-mapping-
// config.cjs), never built here, never request-influenced. Absent -> `rowFromPart` adds no key.
//
// THE TWO MUST TRAVEL TOGETHER OR NOT AT ALL. `installedFieldProperties` decides whether an `ext_`
// column is in the planner's writable band; `extFieldMapping` decides whether a row carries an
// `ext_` value at all. Supply the mapping without the bands and the expansion produces values the
// planner then drops on the floor — the same "built but never reached" defect one layer down.
// Supply the bands without the mapping and the refresh widens over columns nothing fills. On the
// SMALL route both are resolved per request, immediately before one in-process expansion, so they
// cannot disagree, and they are wired together here.
//
// THE LARGE-BOM CHECKPOINT PATH IS STILL UNWIRED, AND THAT IS NOT "INERT". It supplies neither
// input. Because `installedFieldProperties` is absent the planner's band is template-only
// (derivePackAwarePlmWritableFields, packAware=false), so `pickFields` leaves every `ext_` id out of
// the update patch — and a patch does not blank what it omits. Any `ext_` value an earlier SMALL-
// path refresh wrote SURVIVES while every canonical column around it moves to today's source: the
// row reads fresh and its tenant columns sit at an older epoch. Nor is the path an operator's
// choice, or even stable — `read_time_limit_exceeded` is a bounded-expansion trigger, so one
// unchanged project can go small one day and large the next because the source was slow. The two
// large-BOM route families therefore stamp a conditional, values-free
// `extFieldMappingConfiguredButNotAppliedOnThisPath` notice onto every response
// (`largeBomJobResponse` in http-routes.cjs) so the divergence is announced rather than silent.
//
// WHAT ACTUALLY REMAINS OPEN, stated precisely, because the earlier version of this note overstated
// it and risked deferring a small change forever:
//   * the mapping does NOT need to enter `job.actionSnapshot`. `installedFieldProperties` does not
//     either — `planLargeBomBackgroundExpansionJob` takes it as an ordinary runtime parameter — so
//     "a branded object cannot survive `cloneJson`" was never the obstacle.
//   * the mapping's OUTPUT is already revision-covered: `expansionArtifactRevision` hashes
//     `expansion.rows`, so rows produced under a different mapping produce a different
//     `artifactRevision`. Only the mapping's IDENTITY (mappingId/mappingVersion) is uncovered.
//   * the one genuinely open item is that plan-time bands are read LIVE in a later request than the
//     one that sealed the artifact. That is a PRE-EXISTING property of `installedFieldProperties` on
//     this path, not something the mapping introduces — the same seam was already unwired here
//     before any mapper existed.
// So wiring this is threading two existing runtime parameters plus stamping the mapping id into the
// job for evidence; it is not migration-shaped. It is out of scope here only because it needs its
// own route-level tests for the stale-artifact case.
/**
 * THE B2a SEAM for every stock-preparation path that reads an external source through this module.
 *
 * WHERE IT SITS AND WHY. Each caller invokes this AFTER `normalizeActionParameters` (which is where
 * `projectNo` becomes a validated string) and BEFORE `computeDryRun` (which is the first thing that
 * touches `sourceAdapter` — `expandPlmProjectBom` is its first statement). Nothing between those two
 * points performs a source read, so a refusal here means the external system was never contacted.
 * That is asserted, not asserted-by-reading: the RED suite drives every refusal through a
 * call-recording fake adapter and requires `read` to have been called exactly zero times.
 *
 * It is deliberately NOT inside `computeDryRun`. That function is also the large-BOM planner's
 * compute path and takes no tenant; putting the gate there would either need a tenant plumbed into a
 * pure planning function or would silently skip when one was absent — a gate that is easy to omit is
 * not a gate.
 *
 * EVERY INPUT IS SERVER-RESOLVED. `registry` is built once at route registration from server config;
 * `tenantId` is the route's own resolved tenant (the SAME value `loadTableActionSourceAdapter` scopes
 * the external-system lookup with, so the gate and the adapter can never be talking about different
 * tenants); `externalSystemId`/`systemKind` come off the normalized action config; `purpose` is a
 * frozen module constant per call site. The request body's key allowlist
 * (`normalizeTableActionBody`) does not contain any of them, and `normalizeActionParameters` accepts
 * exactly one key (`projectNo`), so none of this is request-supplied.
 *
 * Returns `null` when the registry is dormant — callers then add nothing to their evidence, which is
 * what keeps a dormant deployment byte-identical.
 */
async function assertB2aTrialForStockPreparationRead({ registry, store, operationClaim, tenantId, action, parameters, purpose, runId, now }) {
  const source = (action && action.source) || {}
  return assertB2aReadAuthorization({
    registry,
    store,
    // Migration 078: the DB-enforced one-shot claim. Threaded, never defaulted — an armed read that
    // arrives here without it is refused by the guard, not quietly given the kv-only path.
    operationClaim,
    tenantScope: tenantId,
    // The system TYPE the runtime can actually verify is the adapter kind
    // (`data-source:sql-readonly` / `bridge:legacy-sql-readonly`). Naming it here rather than a
    // human product label means a binding repointed at a different adapter kind stops matching a
    // registration written for the old one — which is the property worth having. The product name a
    // human would use lives in the reviewed file's prose fields, not in anything code can check.
    sourceSystemType: source.kind,
    sourceBindingRef: source.externalSystemId,
    dataScopeRef: parameters ? parameters.projectNo : null,
    // The plan's OWN object list, so a plan repointed at one extra table stops matching a
    // registration that did not enumerate it.
    sourceObjects: readPlanSourceObjects(source.readPlan),
    purpose,
    runId,
    now,
  })
}

/**
 * THE READ-HARDENING AND FULL-BATCH SEAM, for every stock-preparation path that expands a BOM.
 *
 * All three entry points (dry-run, apply, MVP-persist) funnel through `computeDryRun`, so this is
 * the one place the four properties can be enforced once rather than three times:
 *
 *   R-05  a source timeout or a row/page bound surfaces as the FIXED B2a code, mapped from the
 *         underlying cause class at the seam — `runB2aGuardedSourceRead` for a throw,
 *         `assertB2aFullBatchComplete` for the bounds the expander catches and returns as data.
 *   R-06  the schema contract is pinned on the first armed read and compared on every one after,
 *         BEFORE the source is touched and therefore before any plan, row, revision or evidence.
 *   E3-02 an incomplete batch refuses BEFORE the plan is built, rather than planning off a partial
 *         read that merely cannot be applied. WHICH fixed code depends on what explains the
 *         shortfall: a hardened bound names itself (`B2A_SOURCE_TIMEOUT` / `B2A_PAGE_LIMIT_EXCEEDED`,
 *         which is what R-05 asks for and what a caller can act on), and everything else — a broken
 *         cursor, an unclassifiable read failure, a source that moved mid-read — names the property
 *         (`C6_FULL_BATCH_INCOMPLETE`). All of them carry `fullBatch: false` and produce no plan.
 *   E3-05 the source schema is re-read after the batch and must not have moved under it.
 *
 * ALL FOUR ARE ARMED-ONLY. `b2aTrialRegistration` is `null` on a dormant deployment and every one of
 * these calls returns immediately, so the dormant path performs the same reads, builds the same
 * plan, and produces the same evidence keys it did before this seam existed.
 *
 * BOUNDED PAGING AND THE REGISTRATION SCOPE — CHECKED, AND THE ANSWER IS NO. §6.1's record carries
 * `sourceReadOperationLimit` (fixed at 1, and about OPERATIONS, not pages) and `artifactReplayLimit`
 * (fixed at 0). There is no page-, row- or time-bound field in the registration schema, so an armed
 * read's paging limits are the ACTION's (`action.maxPages`/`maxRows`/`maxReadCount`/`maxElapsedMs`),
 * exactly as they are when dormant. Adding such a field was explicitly out of scope, and inventing
 * one to clamp against would be a new schema key, not a use of an existing one.
 */
async function assertB2aReadHardeningBeforeExpansion({ b2aTrialRegistration, b2aClaimStore, action, sourceAdapter, extFieldMapping, now }) {
  if (!b2aTrialRegistration) return null
  return assertB2aSchemaContract({
    store: b2aClaimStore,
    authorization: b2aTrialRegistration,
    sourceAdapter,
    // The PLAN's own objects — the same list the guard matched against `objectScope`, so the contract
    // covers exactly what the read will touch and not a hardcoded roster that would keep passing
    // when the plan grew a section.
    sourceObjects: readPlanSourceObjects(action.source.readPlan),
    extFieldMapping,
    now,
  })
}
// `confirmationDecisionResolver` (OPTIONAL) is the FOURTH member of the same
// server-held input family as `installedFieldProperties` / `extFieldMapping`:
// resolved by the route module at request time from server-side context (the
// staging ledger sheet), threaded here as a parameter, and NEVER
// request-supplied — the route body allowlists cannot even name it. Absent, the
// plan is byte-identical to the pre-ledger behaviour. Present, it is consulted
// ONLY when the first plan holds manual-confirm rows: it recomputes nothing
// itself and returns confirmed duplicate_expanded_key x keep_multiple_rows
// decisions for the CURRENT input revision as a table-scope policy review,
// which is merged and the plan recomputed once. A confirmed decision therefore
// downgrades a hold ONLY when its stored fingerprint matches today's input —
// any stale confirmation leaves the hold standing.
async function computeDryRun({ action, parameters, sourceAdapter, recordsApi, plannedAt, runId, runOnlyReview, tableScopeReview, installedFieldProperties, extFieldMapping, confirmationDecisionResolver, b2aTrialRegistration, b2aClaimStore, b2aNow }) {
  assertExtFieldMappingAgreesWithAction(action, extFieldMapping)
  // R-06, BEFORE the first source row. A drifted schema refuses here, which is before `expansion`,
  // before `plan`, before `revision` and before any evidence exists to be produced.
  const b2aSchemaContract = await assertB2aReadHardeningBeforeExpansion({
    b2aTrialRegistration, b2aClaimStore, action, sourceAdapter, extFieldMapping, now: b2aNow,
  })
  const expansion = await runB2aGuardedSourceRead(b2aTrialRegistration, () => expandPlmProjectBom({
    sourceAdapter,
    projectNo: parameters.projectNo,
    readPlan: action.source.readPlan,
    pageLimit: action.pageLimit,
    maxPages: action.maxPages,
    maxReadCount: action.maxReadCount,
    maxElapsedMs: action.maxElapsedMs,
    maxDepth: action.maxDepth,
    maxRows: action.maxRows,
    extFieldMapping,
    // E3-02's 断游标 half. Armed only: a page that claims `done: false` and offers no cursor stops
    // being a silent truncation and becomes a refusal.
    requireCompleteBatch: Boolean(b2aTrialRegistration),
  }))
  // R-05 + E3-02, result side: the expander CATCHES its own bounds and returns them as global error
  // entries, so a truncated batch arrives as data rather than as a throw. Classified here, before
  // the plan.
  assertB2aFullBatchComplete(b2aTrialRegistration, expansion.errors)
  // E3-05: the source must not have changed shape while the batch was being read.
  await assertB2aSourceUnchangedAfterRead({
    authorization: b2aTrialRegistration,
    contract: b2aSchemaContract,
    sourceAdapter,
    sourceObjects: readPlanSourceObjects(action.source.readPlan),
    extFieldMapping,
  })
  const hasGlobalErrors = Array.isArray(expansion.errors) && expansion.errors.length > 0
  const hasHardRowErrors = hasHardApplyBlockingRowErrors(expansion)
  if (expansion.status === 'not_found') {
    const revision = buildRevision({ action, parameters, expansion, existingRows: [] })
    // `extFieldMapping` rides this early return too. Without it the evidence stanza would appear or
    // vanish according to whether the PROJECT exists in the source, which is a property of the data;
    // whether a mapping is configured is a property of the deployment, and evidence should only ever
    // report the second.
    return { expansion, existingRows: [], plan: emptyPlan(), revision, canApply: false, hasGlobalErrors, extFieldMapping, b2aSchemaContract }
  }
  const existingRows = await readExistingStockPreparationRows(recordsApi, action.target, parameters.projectNo)
  const duplicateDiagnostics = duplicateExpandedKeyDiagnosticsForRows(expansion.rows)
  let conflictPolicyReview = buildConflictPolicyReview({
    diagnostics: duplicateDiagnostics,
    runOnlyReview,
    tableScopeReview,
  })
  function planWithReview(review) {
    return planStockPreparationConflicts({
      template: action.template,
      conflictStrategy: action.conflictStrategy,
      expandedRows: expansion.rows,
      existingRows,
      rowErrors: expansion.rowErrors,
      runId: runId || `table-action:${action.actionId}`,
      plannedAt: plannedAt || new Date().toISOString(),
      duplicatePolicyReview: review,
      installedFieldProperties,
      // W4 carry: threaded from the deploy-time action config (undefined when the
      // config never opted in — the planner is then byte-identical to pre-wiring).
      carryPolicy: action.carryPolicy,
    })
  }
  let plan = planWithReview(conflictPolicyReview)
  // The revision the LEDGER binds its decisions to is the PRE-MERGE one: it is
  // what reconcile stores (prepareStockPreparationConfirmationDecisions calls
  // computeDryRun WITHOUT a resolver) and it stays stable across dry-run ->
  // reconcile -> confirm -> dry-run as long as the actual inputs are unchanged.
  const confirmationInputRevision = buildRevision({ action, parameters, expansion, existingRows, conflictPolicyReview, plan })
  let confirmationReview
  if (typeof confirmationDecisionResolver === 'function' && plan.counts[DECISIONS.MANUAL_CONFIRM] > 0) {
    const resolved = await confirmationDecisionResolver({
      projectNo: parameters.projectNo,
      plan,
      sourceRevision: confirmationInputRevision,
    })
    const mergedTableScopeReview = mergeTableScopeConflictPolicyReviews(tableScopeReview, resolved)
    if (mergedTableScopeReview.confirmationDecisionPolicyCount > 0 || mergedTableScopeReview.conflictingPolicyCount > 0) {
      conflictPolicyReview = buildConflictPolicyReview({
        diagnostics: duplicateDiagnostics,
        runOnlyReview,
        tableScopeReview: mergedTableScopeReview,
      })
      plan = planWithReview(conflictPolicyReview)
      confirmationReview = mergedTableScopeReview
    }
  }
  const revision = buildRevision({ action, parameters, expansion, existingRows, conflictPolicyReview, plan })
  return {
    expansion,
    existingRows,
    plan,
    revision,
    canApply: !hasGlobalErrors && !hasHardRowErrors,
    hasGlobalErrors,
    conflictPolicyReview,
    confirmationDecision: confirmationDecisionEvidence(confirmationReview, confirmationInputRevision),
    // Returned so evidence can name WHICH mapping produced the `ext_` half of these rows. It is not
    // an input to `buildRevision`: the revision already covers the expansion the mapping produced,
    // and hashing the mapping as well would move every stored revision for deployments that have
    // none.
    extFieldMapping,
    // `null` when dormant, so a caller merging it into evidence adds no key at all.
    b2aSchemaContract,
  }
}

function evidenceForDryRun({ action, parameters, expansion, plan, revision, canApply, conflictPolicyReview, extFieldMapping, confirmationDecision }) {
  const planEvidence = summarizeConflictPlanForEvidence(plan)
  if (planEvidence && conflictPolicyReview) planEvidence.conflictPolicyReview = conflictPolicyReviewForEvidence(conflictPolicyReview, plan)
  return {
    actionId: action.actionId,
    projectNoPresent: Boolean(parameters.projectNo),
    dryRunRevision: revision,
    canApply: canApply === true,
    expansion: summarizeBomExpansionForEvidence(expansion),
    plan: planEvidence,
    // CONDITIONAL like extFieldMapping below: no ledger consultation, no key —
    // deployments without the ledger produce byte-identical evidence. The
    // stanza itself is values-free (a revision hash and two counts).
    ...(confirmationDecision ? { confirmationDecision: cloneJson(confirmationDecision) } : {}),
    // CONDITIONAL, so a deployment with no mapping produces byte-identical evidence to the one it
    // produced before this key existed. With a mapping the projection is the module's own
    // values-free one: schema ids, coercion types and counts, never a source cell.
    ...(extFieldMapping ? { extFieldMapping: summarizeExtFieldMappingForEvidence(extFieldMapping) } : {}),
  }
}

function largeBomBoundedPreview(expansion) {
  if (!isLargeBomBoundedExpansion(expansion)) return undefined
  const evidence = summarizeBomExpansionForEvidence(expansion)
  return evidence.boundedPreview
}

function dryRunStatus(dryRun) {
  if (dryRun.expansion.status === 'not_found') return 'not_found'
  if (isLargeBomBoundedExpansion(dryRun.expansion)) return 'large_bom_bounded'
  if (dryRun.canApply) return dryRun.plan.valid ? 'ready' : 'manual_confirm_required'
  return 'failed'
}

function hasHardApplyBlockingRowErrors(expansion) {
  const rowErrors = Array.isArray(expansion && expansion.rowErrors) ? expansion.rowErrors : []
  return rowErrors.some((entry) => isPlainObject(entry) && HARD_APPLY_BLOCKING_ROW_ERROR_TYPES.has(entry.type))
}

async function dryRunStockPreparationAction(input = {}) {
  const action = assertStockPreparationTargetReady(input.action)
  const parameters = normalizeActionParameters(input.parameters)
  // B2a: BEFORE the source is read. Dormant unless INTEGRATION_CORE_B2A_REGISTRY_PATH is set.
  const b2aTrialRegistration = await assertB2aTrialForStockPreparationRead({
    registry: input.b2aTrialRegistry,
    store: input.b2aClaimStore,
    operationClaim: input.b2aOperationClaim,
    tenantId: input.tenantId,
    action,
    parameters,
    runId: input.b2aRunId,
    purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
    now: input.now,
  })
  const runOnlyReview = normalizeRunOnlyConflictPolicyReview(input.conflictPolicyReview)
  const tableScopeReview = input.policyStore
    ? await loadTableScopeConflictPolicies({ action, policyStore: input.policyStore })
    : null
  const dryRun = await computeDryRun({
    action,
    parameters,
    sourceAdapter: input.sourceAdapter,
    recordsApi: input.recordsApi,
    plannedAt: input.plannedAt,
    runId: input.runId,
    runOnlyReview,
    tableScopeReview,
    installedFieldProperties: input.installedFieldProperties,
    // The RUNTIME half of "this action writes tenant columns". Server-held, resolved once at route
    // registration (stock-preparation-ext-field-mapping-config.cjs) and threaded — never fetched
    // here, and never request-influenced. Absent/null is the default and reproduces the pre-mapper
    // row shape exactly; `computeDryRun` reconciles a present one against `action.extensionFieldIds`
    // before a single row is read.
    extFieldMapping: input.extFieldMapping,
    // Confirmation-ledger readback, same server-held family (see computeDryRun).
    confirmationDecisionResolver: input.confirmationDecisionResolver,
    // B2a read hardening (R-05/R-06) and the full-batch guards (E3-02/E3-05). Every one of them
    // is a no-op when `b2aTrialRegistration` is null, which is the dormant case.
    b2aTrialRegistration,
    b2aClaimStore: input.b2aClaimStore,
    b2aNow: input.now,
  })
  let dryRunToken = null
  if (dryRun.canApply) {
    dryRunToken = await createDryRunToken(input.tokenStore, {
      actionId: action.actionId,
      parametersHash: hashJson(parameters),
      revision: dryRun.revision,
      conflictPolicyReview: runOnlyReview,
    })
  }
  return {
    action: publicActionMetadata(action),
    status: dryRunStatus(dryRun),
    largeBom: isLargeBomBoundedExpansion(dryRun.expansion),
    boundedPreview: largeBomBoundedPreview(dryRun.expansion),
    dryRunToken,
    revision: dryRun.revision,
    canApply: dryRun.canApply,
    counts: cloneJson(dryRun.plan.counts),
    evidence: {
      ...evidenceForDryRun({
        action,
        parameters,
        expansion: dryRun.expansion,
        plan: dryRun.plan,
        revision: dryRun.revision,
        canApply: dryRun.canApply,
        conflictPolicyReview: dryRun.conflictPolicyReview,
        extFieldMapping: dryRun.extFieldMapping,
        confirmationDecision: dryRun.confirmationDecision,
      }),
      // CONDITIONAL, and merged HERE rather than inside `evidenceForDryRun`, for two reasons: the
      // dormant payload then has provably not one extra key (the ext-field-mapping wiring suite
      // compares route evidence against a recomputed baseline by deepEqual and would catch a stray
      // one), and `evidenceForDryRun` stays a pure function of the plan, which the large-BOM path
      // also calls without ever having a tenant.
      ...(b2aTrialRegistration ? { b2aTrialRegistration } : {}),
      // R-06's values-free half: one digest, three integers and two booleans — no column name, no
      // object name. Conditional for the same reason as the stanza above: a dormant deployment adds
      // no key, so its evidence stays byte-identical to what it produced before R-06 existed.
      ...(dryRun.b2aSchemaContract ? { b2aSchemaContract: b2aSchemaContractEvidence(dryRun.b2aSchemaContract) } : {}),
    },
  }
}

// Internal handoff for the confirmation-decision RECONCILE route. It repeats
// the readonly table-action plan SERVER-SIDE — the request contributes only
// parameters and the (validated) run-only policy review, never a plan or
// revision — and returns exactly the values-free trio the ledger needs. It is
// deliberately called WITHOUT confirmationDecisionResolver so the revision it
// yields is the ledger's stable PRE-MERGE input revision (see computeDryRun).
async function prepareStockPreparationConfirmationDecisions(input = {}) {
  const action = assertStockPreparationTargetReady(input.action)
  const parameters = normalizeActionParameters(input.parameters)
  const runOnlyReview = normalizeRunOnlyConflictPolicyReview(input.conflictPolicyReview)
  const tableScopeReview = input.policyStore
    ? await loadTableScopeConflictPolicies({ action, policyStore: input.policyStore })
    : null
  const dryRun = await computeDryRun({
    action,
    parameters,
    sourceAdapter: input.sourceAdapter,
    recordsApi: input.recordsApi,
    plannedAt: input.plannedAt,
    runId: input.runId,
    runOnlyReview,
    tableScopeReview,
    installedFieldProperties: input.installedFieldProperties,
    extFieldMapping: input.extFieldMapping,
  })
  if (dryRun.expansion.status === 'not_found') {
    throw new StockPreparationTableActionError(404, 'CONFIRMATION_DECISION_SOURCE_PROJECT_NOT_FOUND', 'source project was not found')
  }
  if (isLargeBomBoundedExpansion(dryRun.expansion)) {
    throw new StockPreparationTableActionError(409, 'CONFIRMATION_DECISION_SOURCE_EXPANSION_BOUNDED', 'source expansion requires the large-BOM workflow')
  }
  return {
    action,
    parameters,
    plan: dryRun.plan,
    revision: dryRun.revision,
    canApply: dryRun.canApply,
  }
}

// Internal handoff for the MVP snapshot committer. This deliberately returns the
// value-bearing expansion only to the route module in-process; no HTTP handler
// serializes it. The same bounded expansion and conflict checks as the visible
// dry-run are recomputed immediately before the internal-only persist.
async function prepareStockPreparationMvpSnapshot(input = {}) {
  const action = assertStockPreparationTargetReady(input.action)
  const parameters = normalizeActionParameters(input.parameters)
  // B2a: this handoff RE-READS the external source (it recomputes a full dry-run), so it is gated on
  // the same footing as the visible dry-run — before `computeDryRun`, before any adapter call. It
  // carries its OWN purpose: a registration written for the refresh action does not implicitly
  // authorize committing that customer's BOM into the MVP snapshot tables, and an entry with
  // `forbidReuse: true` will say so.
  const b2aTrialRegistration = await assertB2aTrialForStockPreparationRead({
    registry: input.b2aTrialRegistry,
    store: input.b2aClaimStore,
    operationClaim: input.b2aOperationClaim,
    tenantId: input.tenantId,
    action,
    parameters,
    runId: input.b2aRunId,
    purpose: B2A_PURPOSE_STOCK_PREPARATION_MVP_PERSIST,
    now: input.now,
  })
  const dryRun = await computeDryRun({
    action,
    parameters,
    sourceAdapter: input.sourceAdapter,
    recordsApi: input.recordsApi,
    plannedAt: input.plannedAt,
    runId: input.runId,
    runOnlyReview: null,
    tableScopeReview: null,
    // `extFieldMapping` is NOT wired here, deliberately, and for a different reason than the
    // large-BOM path: this handoff never writes the canonical sheet. It feeds the MetaSheet-internal
    // MVP snapshot tables through stock-preparation-expansion-snapshot-mapper.cjs, which projects
    // each expansion row onto a CLOSED snapshot-line vocabulary (`toSnapshotLine` / `sourceIdentity`
    // name every key they read). A tenant `ext_` key is not in it, so wiring the mapping here would
    // coerce values that the very next function drops — production for no consumer, which is the
    // defect this change exists to remove, not to reproduce. Carrying `ext_` into a snapshot line is
    // a snapshot-schema change with its own migration.
    // B2a read hardening (R-05/R-06) and the full-batch guards (E3-02/E3-05). Every one of them
    // is a no-op when `b2aTrialRegistration` is null, which is the dormant case.
    b2aTrialRegistration,
    b2aClaimStore: input.b2aClaimStore,
    b2aNow: input.now,
  })
  if (dryRun.expansion.status === 'not_found') {
    throw new StockPreparationTableActionError(404, 'STOCK_PREPARATION_MVP_SOURCE_PROJECT_NOT_FOUND', 'source project was not found')
  }
  if (isLargeBomBoundedExpansion(dryRun.expansion)) {
    throw new StockPreparationTableActionError(409, 'STOCK_PREPARATION_MVP_SOURCE_EXPANSION_BOUNDED', 'source expansion requires the large-BOM workflow')
  }
  if (!dryRun.canApply || !dryRun.plan.valid) {
    throw new StockPreparationTableActionError(409, 'STOCK_PREPARATION_MVP_SOURCE_EXPANSION_NOT_READY', 'source expansion is not ready for internal persistence')
  }
  return {
    action,
    parameters,
    expansionResult: dryRun.expansion.rows,
    revision: dryRun.revision,
    evidence: {
      ...evidenceForDryRun({
        action,
        parameters,
        expansion: dryRun.expansion,
        plan: dryRun.plan,
        revision: dryRun.revision,
        canApply: dryRun.canApply,
        conflictPolicyReview: dryRun.conflictPolicyReview,
        extFieldMapping: dryRun.extFieldMapping,
        confirmationDecision: dryRun.confirmationDecision,
      }),
      ...(b2aTrialRegistration ? { b2aTrialRegistration } : {}),
      // R-06's values-free half: one digest, three integers and two booleans — no column name, no
      // object name. Conditional for the same reason as the stanza above: a dormant deployment adds
      // no key, so its evidence stays byte-identical to what it produced before R-06 existed.
      ...(dryRun.b2aSchemaContract ? { b2aSchemaContract: b2aSchemaContractEvidence(dryRun.b2aSchemaContract) } : {}),
    },
  }
}

// FOS-4b-3 (sandbox-only apply) — P0 gate. apply may run ONLY when sandbox mode is enabled AND the target
// is in the sandbox allowlist, and NEVER against the production canonical stock-prep object. Fail-closed by
// default: a missing/disabled policy, an unallowlisted target, or the prod canonical → 403. This is the
// FIRST thing apply does (before token consume / dry-run / write). Production apply = separate FOS-4b-3-prod
// owner gate. Error is values-free (only a coarse reason).
function assertStockPrepApplySandboxAllowed(target, sandboxPolicy) {
  // Mirror the writer's target identity: objectId defaults to the prod canonical when unset, so a target
  // missing objectId is treated as canonical (and rejected) rather than slipping through on sheetId.
  const objectId = (target && optionalString(target.objectId)) || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
  // Defense-in-depth: the prod canonical target is never appliable on the sandbox path, regardless of policy.
  if (objectId === STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId) {
    throw new StockPreparationTableActionError(403, 'STOCK_PREP_APPLY_SANDBOX_ONLY', 'apply is sandbox-only; the production canonical stock-prep target is not appliable (production apply is a separate owner gate)', { reason: 'prod_canonical' })
  }
  const policy = isPlainObject(sandboxPolicy) ? sandboxPolicy : {}
  if (policy.enabled !== true) {
    throw new StockPreparationTableActionError(403, 'STOCK_PREP_APPLY_SANDBOX_ONLY', 'apply is sandbox-only; sandbox mode is not enabled', { reason: 'sandbox_disabled' })
  }
  const allowed = Array.isArray(policy.allowedTargetObjectIds) ? policy.allowedTargetObjectIds : []
  if (!allowed.includes(objectId)) {
    throw new StockPreparationTableActionError(403, 'STOCK_PREP_APPLY_SANDBOX_ONLY', 'apply target is not in the sandbox allowlist', { reason: 'target_not_allowlisted' })
  }
}

// FOS-4b-3: resolve the sandbox policy from server config. Explicit config wins (config-file / tests);
// otherwise the recommended env gate STOCK_PREP_SANDBOX_MODE=true + STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS
// (comma-separated allowlist). Absent / mode!=='true' → undefined → apply fail-closed (gate rejects).
function resolveStockPrepApplySandboxPolicy(config, env = process.env) {
  if (config && isPlainObject(config.stockPrepApplySandbox)) {
    return config.stockPrepApplySandbox
  }
  if (env && env.STOCK_PREP_SANDBOX_MODE === 'true') {
    return {
      enabled: true,
      allowedTargetObjectIds: String(env.STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    }
  }
  return undefined
}

// FOS-4b-3-prod P2: resolve the production policy from SERVER CONFIG ONLY (no env — dormant by default).
// Absent → undefined → the apply path stays on the sandbox gate (canonical rejected). A production policy is
// only ever present when an owner explicitly sets context.config.stockPrepApplyProduction. There is
// deliberately no env switch: production must require explicit server config, never an environment variable.
function resolveStockPrepApplyProductionPolicy(config) {
  if (config && isPlainObject(config.stockPrepApplyProduction)) {
    return config.stockPrepApplyProduction
  }
  return undefined
}

// FOS-4b-3-prod P2: the SINGLE apply gate for BOTH write entry points (small-BOM in-function + large-BOM
// route), so route parity is structural and the two paths cannot drift. It branches on the PRESENCE of a
// production policy (not on validation success): a configured production policy takes the production path and
// ANY failure is a hard reject (never a silent demotion to sandbox); absent → the unchanged sandbox gate
// (canonical rejected). The controlled canonical exception requires a valid + unexpired + in-window policy,
// an EXPLICIT canonical objectId, and matching route + action. Returns { mode, maxCleanRows } for the later
// post-plan bound. Values-free errors (coarse reason only). now is the caller-supplied current time.
function assertStockPrepApplyAllowed(target, gateContext = {}) {
  const { sandboxPolicy, productionPolicy, now, route, actionId } = gateContext
  if (productionPolicy !== undefined && productionPolicy !== null) {
    const policy = normalizeStockPrepApplyProductionPolicy(productionPolicy) // throws (422) on malformed
    assertProductionPolicyNotExpired(policy, now) // throws (422) expired / expiry_too_far / missing_now
    const objectId = target && optionalString(target.objectId)
    // Require an EXPLICIT canonical objectId — an omitted/defaulted objectId must not authorize a prod write.
    if (!objectId || objectId !== policy.authorizedTargetObjectId) {
      throw new StockPreparationTableActionError(403, 'STOCK_PREP_PRODUCTION_APPLY_DENIED', 'production apply target is not the authorized canonical target', { reason: 'target_mismatch' })
    }
    if (policy.allowedRoute !== 'both' && policy.allowedRoute !== route) {
      throw new StockPreparationTableActionError(403, 'STOCK_PREP_PRODUCTION_APPLY_DENIED', 'production apply route is not authorized', { reason: 'route_mismatch' })
    }
    if (!actionId || policy.allowedActionId !== actionId) {
      throw new StockPreparationTableActionError(403, 'STOCK_PREP_PRODUCTION_APPLY_DENIED', 'production apply action is not authorized', { reason: 'action_mismatch' })
    }
    return { mode: 'production', maxCleanRows: policy.maxCleanRows }
  }
  // No production policy configured → sandbox gate (unchanged; canonical rejected; sandbox allowlist).
  assertStockPrepApplySandboxAllowed(target, sandboxPolicy)
  return { mode: 'sandbox', maxCleanRows: null }
}

// FOS-4b-3-prod P2: post-plan, pre-write bound. Only enforced on the production path; rejects before any
// write if the plan's clean (add/update) row count exceeds the authorized maxCleanRows.
function assertProductionCleanRowsWithinBound(gateResult, cleanRowCount) {
  if (gateResult && gateResult.mode === 'production' && cleanRowCount > gateResult.maxCleanRows) {
    throw new StockPreparationTableActionError(403, 'STOCK_PREP_PRODUCTION_APPLY_DENIED', 'production apply clean-row count exceeds the authorized bound', { reason: 'max_clean_rows_exceeded' })
  }
}

async function applyStockPreparationAction(input = {}) {
  const action = assertStockPreparationTargetReady(input.action)
  // FOS-4b-3-prod P2: shared apply gate FIRST — fail-closed before any token consume, dry-run, or write.
  // No production policy → sandbox gate (canonical rejected). A configured production policy may authorize
  // the canonical (small route) per the controlled exception.
  const applyGate = assertStockPrepApplyAllowed(action.target, {
    sandboxPolicy: input.sandboxPolicy,
    productionPolicy: input.productionPolicy,
    now: input.now,
    route: 'small',
    actionId: action.actionId,
  })
  const parameters = normalizeActionParameters(input.parameters)
  // B2a: BEFORE the token is consumed and long before the re-expansion. Ahead of the token consume
  // on purpose — a refusal must not burn a single-use dry-run token, or an operator who is simply
  // outside their registered scope would also lose the artifact that proves what they planned.
  const b2aTrialRegistration = await assertB2aTrialForStockPreparationRead({
    registry: input.b2aTrialRegistry,
    store: input.b2aClaimStore,
    operationClaim: input.b2aOperationClaim,
    tenantId: input.tenantId,
    action,
    parameters,
    runId: input.b2aRunId,
    // The SAME purpose the dry-run used. Apply re-expands the identical source read; splitting them
    // into two purposes would mean a deployment could register a customer for planning and then find
    // apply refused with a valid token in hand, which is a worse failure than the gate prevents.
    purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
    now: input.now,
  })
  const tokenRecord = await consumeDryRunToken(input.tokenStore, input.dryRunToken, {
    actionId: action.actionId,
    parametersHash: hashJson(parameters),
  })
  // Stored boundary: consumeDryRunToken returns the record verbatim from the token store and merges
  // nothing from the request, so this content is server-minted and was already validated at
  // selection time. Re-validating it as a fresh selection would 422 an in-flight token issued before
  // the policy-honesty guard landed — turning a stored artifact into a new failure.
  const runOnlyReview = normalizeRunOnlyConflictPolicyReview(tokenRecord.conflictPolicyReview, { boundary: POLICY_BOUNDARY_STORED })
  const tableScopeReview = input.policyStore
    ? await loadTableScopeConflictPolicies({ action, policyStore: input.policyStore })
    : null
  const dryRun = await computeDryRun({
    action,
    parameters,
    sourceAdapter: input.sourceAdapter,
    recordsApi: input.recordsApi,
    plannedAt: input.plannedAt,
    runId: input.runId,
    runOnlyReview,
    tableScopeReview,
    installedFieldProperties: input.installedFieldProperties,
    // Apply RE-EXPANDS the source and compares the recomputed revision against the token, so it must
    // expand with the SAME mapping the dry-run used. Passing it on one path and not the other would
    // turn every apply into a TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH.
    extFieldMapping: input.extFieldMapping,
    // Same token-parity requirement for the ledger readback: a dry-run whose
    // plan a confirmed decision downgraded minted its token on the MERGED
    // revision, so apply must consult the same server-held resolver. A decision
    // confirmed or superseded between the two calls changes the recomputed
    // revision and fails the token check — fail-closed, never fail-open.
    confirmationDecisionResolver: input.confirmationDecisionResolver,
    // B2a read hardening (R-05/R-06) and the full-batch guards (E3-02/E3-05). Every one of them
    // is a no-op when `b2aTrialRegistration` is null, which is the dormant case.
    b2aTrialRegistration,
    b2aClaimStore: input.b2aClaimStore,
    b2aNow: input.now,
  })
  if (tokenRecord.revision !== dryRun.revision) {
    throw new StockPreparationTableActionError(409, 'TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH', 'dryRunToken does not match the current dry-run revision')
  }
  if (!dryRun.canApply) {
    throw new StockPreparationTableActionError(409, 'TABLE_ACTION_DRY_RUN_NOT_APPLYABLE', 'current dry-run is not applyable')
  }
  if (dryRun.plan.counts[DECISIONS.MANUAL_CONFIRM] > 0 && input.acceptManualConfirmHold !== true) {
    throw new StockPreparationTableActionError(409, 'TABLE_ACTION_MANUAL_CONFIRM_REQUIRED', 'manual-confirm rows require acceptManualConfirmHold=true')
  }
  const duplicateResolution = dryRun.plan.summary && dryRun.plan.summary.duplicateExpandedKeyResolution
  if (duplicateResolution && Number(duplicateResolution.resolvedGroupCount || 0) > 0 && input.acceptDuplicateResolution !== true) {
    throw new StockPreparationTableActionError(409, 'TABLE_ACTION_DUPLICATE_RESOLUTION_REVIEW_REQUIRED', 'resolved duplicate groups require acceptDuplicateResolution=true')
  }
  // FOS-4b-3-prod P2: post-plan production bound — clean (add/update) rows must be within maxCleanRows.
  // No-op on the sandbox path (mode!=='production'); rejects before any write on the production path.
  const cleanRowCount = (dryRun.plan.counts[DECISIONS.ADD] || 0) + (dryRun.plan.counts[DECISIONS.UPDATE] || 0)
  assertProductionCleanRowsWithinBound(applyGate, cleanRowCount)
  const applyResult = await applyStockPreparationPlan({
    permission: input.permission,
    plan: dryRun.plan,
    target: action.target,
    template: action.template,
    // Same projection the plan was built from, so the writer's human wall rejects the
    // pack's `ext_` human columns BY NAME rather than by their absence from the template.
    installedFieldProperties: input.installedFieldProperties,
    // C4 apply: the writer already maps every payload key through the operator-configured
    // target.fieldIdMap, so the scoped API must NOT translate a second time (#4160).
    recordsApi: await createTargetScopedRecordsApi(input.recordsApi, action.target, { fieldIdTranslation: 'pre_mapped' }),
  })
  return {
    action: publicActionMetadata(action),
    status: applyResult.status,
    permission: applyResult.permission,
    dryRunRevision: dryRun.revision,
    apply: summarizeApplyResultForEvidence(applyResult),
    evidence: {
      actionId: action.actionId,
      projectNoPresent: Boolean(parameters.projectNo),
      dryRunRevision: dryRun.revision,
      dryRun: evidenceForDryRun({
        action,
        parameters,
        expansion: dryRun.expansion,
        plan: dryRun.plan,
        revision: dryRun.revision,
        canApply: dryRun.canApply,
        conflictPolicyReview: dryRun.conflictPolicyReview,
        extFieldMapping: dryRun.extFieldMapping,
      }),
      apply: summarizeApplyResultForEvidence(applyResult),
      ...(b2aTrialRegistration ? { b2aTrialRegistration } : {}),
      // R-06's values-free half: one digest, three integers and two booleans — no column name, no
      // object name. Conditional for the same reason as the stanza above: a dormant deployment adds
      // no key, so its evidence stays byte-identical to what it produced before R-06 existed.
      ...(dryRun.b2aSchemaContract ? { b2aSchemaContract: b2aSchemaContractEvidence(dryRun.b2aSchemaContract) } : {}),
    },
  }
}

module.exports = {
  DEFAULT_DRY_RUN_TOKEN_TTL_MS,
  GENERIC_TABLE_ACTION_KIND,
  PLM_STOCK_PREPARATION_ACTION_ID,
  TABLE_ACTION_KIND,
  StockPreparationTableActionError,
  applyStockPreparationAction,
  assertProductionCleanRowsWithinBound,
  assertStockPrepApplyAllowed,
  assertStockPrepApplySandboxAllowed,
  assertStockPreparationTargetReady,
  createStockPreparationTableActionRegistry,
  resolveStockPrepApplyProductionPolicy,
  resolveStockPrepApplySandboxPolicy,
  resolveTargetFieldIds,
  createTargetScopedRecordsApi,
  dryRunStockPreparationAction,
  prepareStockPreparationConfirmationDecisions,
  prepareStockPreparationMvpSnapshot,
  normalizeActionParameters,
  normalizeStockPreparationActionConfig,
  publicActionMetadata,
  __internals: {
    assertB2aTrialForStockPreparationRead,
    assertExtFieldMappingAgreesWithAction,
    assertTargetFieldMapCompleteness,
    buildRevision,
    confirmationDecisionEvidence,
    mergeTableScopeConflictPolicyReviews,
    consumeDryRunToken,
    createDryRunToken,
    hashJson,
    normalizeActionExtensionFieldIds,
    plmSystemFieldIds,
    readExistingStockPreparationRows,
    stableStringify,
    targetFieldMapHasExplicitBindings,
    unmapRecordFields,
  },
}
