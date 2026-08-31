'use strict'

// STOCK-PREPARATION DEPLOYMENT PREFLIGHT — one call that answers "is this deployment ready to run
// stock-prep, and if not, exactly what do I run to fix it".
//
// WHY THIS EXISTS (two real incidents, one deployment session)
//
// Deploying the product does NOT make stock-prep usable. Two managed multitable objects are created
// ON DEMAND (they are not in the SQL migration chain), and the sandbox WRITE authorization is a
// separate env allowlist. Nothing told the operator any of that, and the readiness surfaces that
// did exist were four separate polls (`target/readiness`, `sandbox-target/readiness`,
// `mvp/readiness`, `confirmation-decisions/readiness`) none of which mentions the env allowlist.
//
//   INCIDENT 1 — an operator picked a sandbox objectId by hand and was refused for being outside
//   the `plm_stock_preparation_sandbox` namespace. The refusal did not name the namespace.
//
//   INCIDENT 2 — two people configured the same instance in parallel and chose DIFFERENT sandbox
//   objectIds, so the installed customer pack declared one target while the table that actually
//   existed carried another name. A dry-run fails with a missing-target error that never mentions
//   the PACK'S OWN declared name, so the operator has nothing to compare against.
//
// Incident 2 is the reason check 3 below reads `targetObjectId` OFF THE PACK and inspects THAT
// object, and the reason its fix line quotes the pack's declared id verbatim: an operator following
// the fix line cannot invent a third name, because the name is handed to them.
//
// THE CONTRACT
//
//   ready    — boolean; true only when `blockers` is empty
//   blockers — ordered, most-blocking first. Each carries a stable machine `code`, a human `what`,
//              and a `fix` that is THE LITERAL THING TO RUN: an exact HTTP method+path+JSON body,
//              or an exact `KEY=value` env line.
//   posture  — INFORMATIONAL fences. Never blockers, and deliberately never carrying a `fix`.
//
// WHY FENCES ARE POSTURE AND NOT BLOCKERS. Production Apply closed, K3 external write permanently
// disabled, the B2a registry dormant, the outbound HTTP write gate unset — every one of those is the
// CORRECT state of a healthy deployment. Reporting them as blockers would make "ready" mean
// "everything is switched on", and a fix line next to "B2a dormant" or "outbound write gate unset"
// would be a preflight nudging an operator toward ARMING a gate. Unset is right; the preflight says
// so and offers nothing to run.
//
// READ-ONLY BY CONSTRUCTION. Every check here is an inspection: it reuses the EXISTING inspection
// functions (`inspectConfirmationDecisionTarget`, `inspectStockPreparationCanonicalTarget`,
// `inspectStockPreparationSandboxTarget`) rather than re-deriving what "ready" means, and those call
// only `findObjectSheet` / `resolveFieldIds`. Nothing here provisions, ensures, installs or writes.
// A preflight that repaired what it found would be a provisioning route wearing a read-tier gate.
//
// VALUES-FREE. Everything quoted in a response is DEPLOYMENT-AUTHORED: objectIds, `ext_` logical
// field ids, packIds, env var names, namespace prefixes. No customer business value, no credential,
// no host or IP is read by this module, let alone echoed. The env fix lines name the KEY and use a
// placeholder for the path, because a deployment's filesystem layout is topology, not config.

const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
} = require('./stock-preparation-templates.cjs')
const {
  SANDBOX_OBJECT_ID_NAMESPACE,
  inspectStockPreparationCanonicalTarget,
  inspectStockPreparationSandboxTarget,
  isSandboxNamespaceObjectId,
} = require('./stock-preparation-target-provisioning.cjs')
const {
  inspectConfirmationDecisionTarget,
} = require('./stock-preparation-confirmation-decisions.cjs')
const {
  resolveStockPrepApplySandboxPolicy,
  resolveStockPrepApplyProductionPolicy,
} = require('./stock-preparation-table-actions.cjs')
const {
  K3_WISE_EXTERNAL_WRITE_DISABLED,
} = require('./k3-external-write-permanent-fence.cjs')
const {
  OUTBOUND_HTTP_WRITE_TARGETS_ENV,
} = require('./outbound-http-write-gate.cjs')

// ---------------------------------------------------------------------------
// The deployment vocabulary the fix lines quote.
//
// These four env keys are OWNED by packages/core-backend/src/plugin-runtime-config.ts (the first
// three) and by stock-preparation-table-actions.cjs (the sandbox pair). Neither exports them as a
// constant, so they are restated here — and a suite asserts the restatement against those two
// sources, so a rename there fails loudly rather than turning a fix line into a lie.
// ---------------------------------------------------------------------------

const CUSTOMER_PACKS_PATH_ENV = 'INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH'
const EXT_FIELD_MAPPING_PATH_ENV = 'INTEGRATION_CORE_STOCK_PREPARATION_EXT_FIELD_MAPPING_PATH'
const B2A_REGISTRY_PATH_ENV = 'INTEGRATION_CORE_B2A_REGISTRY_PATH'
const SANDBOX_MODE_ENV = 'STOCK_PREP_SANDBOX_MODE'
const SANDBOX_TARGET_OBJECT_IDS_ENV = 'STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS'

/**
 * The namespace incident 1's refusal failed to name. Quoted in the fix line so it cannot be guessed.
 *
 * TAKEN FROM THE GUARD, not restated: it is the same constant `assertSandboxObjectId` enforces, so a
 * rename there cannot leave this quoting a namespace nothing checks.
 */
const SANDBOX_OBJECT_ID_NAMESPACE_PREFIX = SANDBOX_OBJECT_ID_NAMESPACE

const CANONICAL_TARGET_OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId

/**
 * The blocker vocabulary. Frozen and exported: a caller (a runbook, a dashboard, a follow-up suite)
 * branches on these, so they are part of the contract, not incidental strings.
 */
const PREFLIGHT_BLOCKER_CODES = Object.freeze({
  CONFIRMATION_LEDGER_NOT_READY: 'STOCK_PREP_CONFIRMATION_LEDGER_NOT_READY',
  CUSTOMER_PACK_NOT_CONFIGURED: 'STOCK_PREP_CUSTOMER_PACK_NOT_CONFIGURED',
  PACK_TARGET_MISSING: 'STOCK_PREP_PACK_TARGET_MISSING',
  PACK_TARGET_INCOMPLETE: 'STOCK_PREP_PACK_TARGET_INCOMPLETE',
  EXT_FIELD_MAPPING_NOT_CONFIGURED: 'STOCK_PREP_EXT_FIELD_MAPPING_NOT_CONFIGURED',
  SANDBOX_MODE_NOT_ENABLED: 'STOCK_PREP_SANDBOX_MODE_NOT_ENABLED',
  SANDBOX_ALLOWLIST_MISSING_TARGET: 'STOCK_PREP_SANDBOX_ALLOWLIST_MISSING_TARGET',
})

const PREFLIGHT_BLOCKER_CODE_ORDER = Object.freeze([
  PREFLIGHT_BLOCKER_CODES.CONFIRMATION_LEDGER_NOT_READY,
  PREFLIGHT_BLOCKER_CODES.CUSTOMER_PACK_NOT_CONFIGURED,
  PREFLIGHT_BLOCKER_CODES.PACK_TARGET_MISSING,
  PREFLIGHT_BLOCKER_CODES.PACK_TARGET_INCOMPLETE,
  PREFLIGHT_BLOCKER_CODES.EXT_FIELD_MAPPING_NOT_CONFIGURED,
  PREFLIGHT_BLOCKER_CODES.SANDBOX_MODE_NOT_ENABLED,
  PREFLIGHT_BLOCKER_CODES.SANDBOX_ALLOWLIST_MISSING_TARGET,
])

// The route the preflight itself is served on, stated once and reused by the runbook suite.
const PREFLIGHT_ROUTE_PATH = '/api/integration/stock-preparation/preflight'

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/**
 * An HTTP fix. `run` is the one-line paste-able form; `method`/`path`/`body` are the same thing
 * structured, so a dashboard does not have to parse prose back apart.
 *
 * `body` is JSON-stringified into `run` with no whitespace, because the operator copies `run`.
 */
function httpFix({ method, path, body }) {
  const payload = isPlainObject(body) ? body : {}
  return Object.freeze({
    kind: 'http',
    method,
    path,
    body: Object.freeze({ ...payload }),
    run: `${method} ${path} ${JSON.stringify(payload)}`,
  })
}

/**
 * An env fix. `value` is either a literal the server can compute (a mode flag, an allowlist the
 * server already knows every member of) or an explicit PLACEHOLDER for something only the operator
 * knows (a filesystem path). A placeholder is marked, so a caller can tell "paste this" from
 * "fill this in" without pattern-matching the string.
 */
function envFix({ name, value, placeholder = false }) {
  return Object.freeze({
    kind: 'env',
    name,
    value,
    placeholder: placeholder === true,
    run: `${name}=${value}`,
  })
}

function blocker({ code, what, fix, detail }) {
  return Object.freeze({
    code,
    what,
    fix,
    ...(detail === undefined ? {} : { detail: Object.freeze({ ...detail }) }),
  })
}

/**
 * The declared target of every configured pack, deduplicated by objectId.
 *
 * `targetObjectId` is read OFF THE PACK — never off a request, never off the sandbox env, never off
 * whatever table happens to exist. That is the whole point of check 3: the pack's declaration is the
 * authority, so a mismatch between it and the deployment is visible instead of silent.
 */
function declaredPackTargets(packCatalog) {
  const packs = packCatalog && typeof packCatalog.list === 'function' ? packCatalog.list() : []
  const byObjectId = new Map()
  for (const pack of packs) {
    const objectId = typeof pack.targetObjectId === 'string' ? pack.targetObjectId : CANONICAL_TARGET_OBJECT_ID
    const extensionFieldIds = Array.isArray(pack.extensionFields)
      ? pack.extensionFields.map((field) => field.id).filter((id) => typeof id === 'string' && id)
      : []
    const existing = byObjectId.get(objectId)
    if (existing) {
      existing.packIds.push(pack.packId)
      for (const fieldId of extensionFieldIds) {
        if (!existing.extensionFieldIds.includes(fieldId)) existing.extensionFieldIds.push(fieldId)
      }
      continue
    }
    byObjectId.set(objectId, {
      objectId,
      isCanonical: objectId === CANONICAL_TARGET_OBJECT_ID,
      packIds: [pack.packId],
      extensionFieldIds: [...extensionFieldIds],
    })
  }
  return [...byObjectId.values()].sort((left, right) => (left.objectId < right.objectId ? -1 : left.objectId > right.objectId ? 1 : 0))
}

/**
 * Inspect ONE declared target through the module that owns the notion of "ready" for it.
 *
 * The canonical and sandbox inspectors are two entry points to one function, and the split matters
 * for evidence shaping: the canonical one reports its objectId in the clear, the sandbox one hashes
 * it. The preflight quotes the declared objectId itself in the FIX line either way (it is
 * deployment-authored config, and the whole incident was an operator not knowing it), so what the
 * inspector's own evidence does with it is left exactly as that module decided.
 */
async function inspectDeclaredTarget({ context, projectId, target }) {
  if (target.isCanonical) {
    return inspectStockPreparationCanonicalTarget({
      context,
      projectId,
      permission: 'admin',
      extensionFieldIds: target.extensionFieldIds,
    })
  }
  return inspectStockPreparationSandboxTarget({
    context,
    projectId,
    objectId: target.objectId,
    permission: 'admin',
    extensionFieldIds: target.extensionFieldIds,
  })
}

/** The ensure call that CREATES a declared target — the fix that would have ended incident 2. */
function ensureFixForTarget(target) {
  if (target.isCanonical) {
    return httpFix({
      method: 'POST',
      path: '/api/integration/stock-preparation/target/ensure',
      body: {},
    })
  }
  // The pack's OWN declared objectId, quoted verbatim. An operator following this line cannot
  // invent a third name, which is exactly how the two parallel configurations diverged.
  return httpFix({
    method: 'POST',
    path: '/api/integration/stock-preparation/sandbox-target/ensure',
    body: { objectId: target.objectId },
  })
}

/**
 * The three fences that are read off SERVER STATE, plus the one that is a compile-time constant.
 *
 * Nothing here carries a `fix`, and `assertNoPostureFix` in the suite proves it stays that way.
 */
function buildPosture({ config, b2aTrialRegistry, env }) {
  const productionPolicy = resolveStockPrepApplyProductionPolicy(config)
  const outboundConfigured = typeof (env && env[OUTBOUND_HTTP_WRITE_TARGETS_ENV]) === 'string'
    && String(env[OUTBOUND_HTTP_WRITE_TARGETS_ENV]).trim().length > 0
  return Object.freeze({
    productionApply: Object.freeze({
      state: productionPolicy === undefined ? 'closed' : 'configured',
      canonicalObjectId: CANONICAL_TARGET_OBJECT_ID,
      note: productionPolicy === undefined
        ? 'production Apply is closed: no server-config production policy is present, so the canonical target is not appliable. This is the expected posture and there is nothing to run.'
        : 'a server-config production Apply policy is present. That is an owner decision recorded elsewhere; the preflight only reports it.',
    }),
    k3ExternalWrite: Object.freeze({
      state: 'permanently_disabled',
      code: K3_WISE_EXTERNAL_WRITE_DISABLED,
      note: 'K3 external write is refused permanently and structurally. A K3 target dry-run still works and its apply is always refused; that is the fence, not a fault.',
    }),
    b2aTrialRegistry: Object.freeze({
      state: b2aTrialRegistry ? 'armed' : 'dormant',
      envVar: B2A_REGISTRY_PATH_ENV,
      note: b2aTrialRegistry
        ? 'the B2a trial registry is armed: every gated stock-prep source read must match a live registration.'
        : 'the B2a trial registry is dormant, which is the correct posture here. Arming it is an owner decision; the preflight deliberately offers nothing to run.',
    }),
    outboundHttpWrite: Object.freeze({
      state: outboundConfigured ? 'set' : 'unset',
      envVar: OUTBOUND_HTTP_WRITE_TARGETS_ENV,
      note: outboundConfigured
        ? 'a generic outbound HTTP write allowlist is configured; only its listed targets are authorized.'
        : 'the outbound HTTP write gate is unset, which means deny — the correct posture. The preflight deliberately offers nothing to run.',
    }),
  })
}

/**
 * THE preflight. Read-only aggregation over the existing inspection functions and the server-held
 * config the routes already build once at registration.
 *
 * @param {object}  options.context          plugin context (used only for the multitable inspections)
 * @param {string}  options.projectId        the auth-derived staging project id
 * @param {object}  options.packCatalog      the server-held customer-pack allowlist
 * @param {object}  options.extFieldMapping  the built source->`ext_` mapping, or null when unconfigured
 * @param {object}  options.config           server config (production Apply policy, sandbox policy override)
 * @param {object}  options.b2aTrialRegistry the built B2a registry, or null when dormant
 * @param {object}  options.env              the process environment to read the env gates from
 */
async function computeStockPreparationPreflight({
  context,
  projectId,
  packCatalog,
  extFieldMapping,
  config,
  b2aTrialRegistry,
  env = process.env,
} = {}) {
  const blockers = []
  const checks = {}

  // ---- 1. the confirmation-decision LEDGER -------------------------------------------------
  // A managed multitable object that the SQL migration chain does not create. Without it the
  // confirmation queue — the operator's whole entry surface — has nothing behind it.
  const ledger = await inspectConfirmationDecisionTarget({ context, projectId, permission: 'admin' })
  checks.confirmationLedger = Object.freeze({
    ready: ledger.ready === true,
    present: ledger.present === true,
    mode: ledger.mode,
    objectId: ledger.evidence && ledger.evidence.objectId,
    missingFieldCount: Array.isArray(ledger.missingFields) ? ledger.missingFields.length : 0,
  })
  if (ledger.ready !== true) {
    blockers.push(blocker({
      code: PREFLIGHT_BLOCKER_CODES.CONFIRMATION_LEDGER_NOT_READY,
      what: ledger.present === true
        ? `the confirmation-decision ledger object "${checks.confirmationLedger.objectId}" exists but is missing ${checks.confirmationLedger.missingFieldCount} of its manifest columns, so the confirmation queue cannot be served`
        : `the confirmation-decision ledger object "${checks.confirmationLedger.objectId}" does not exist. It is created on demand and is NOT part of the SQL migration chain, so deploying the product does not create it`,
      fix: httpFix({
        method: 'POST',
        path: '/api/integration/stock-preparation/confirmation-decisions/ensure',
        body: {},
      }),
      detail: { mode: ledger.mode, missingFieldCount: checks.confirmationLedger.missingFieldCount },
    }))
  }

  // ---- 2. is any CUSTOMER PACK configured? -------------------------------------------------
  const targets = declaredPackTargets(packCatalog)
  const packIds = packCatalog && Array.isArray(packCatalog.packIds) ? [...packCatalog.packIds] : []
  checks.customerPacks = Object.freeze({
    configured: packIds.length > 0,
    packCount: packIds.length,
    packIds: Object.freeze(packIds),
    declaredTargetObjectIds: Object.freeze(targets.map((target) => target.objectId)),
  })
  if (packIds.length === 0) {
    blockers.push(blocker({
      code: PREFLIGHT_BLOCKER_CODES.CUSTOMER_PACK_NOT_CONFIGURED,
      what: `no customer pack is configured, so there is nothing to install and no declared target to check. The pack set is server-held and comes from the deploy-time JSON file named by ${CUSTOMER_PACKS_PATH_ENV}`,
      fix: envFix({
        name: CUSTOMER_PACKS_PATH_ENV,
        value: '/absolute/path/to/customer-packs.json',
        placeholder: true,
      }),
    }))
  }

  // ---- 3. the target each configured pack DECLARES ------------------------------------------
  // INCIDENT 2. Read `targetObjectId` off the pack and inspect THAT object — not the canonical
  // default, not whatever sandbox table happens to exist. The fix quotes the pack's own id.
  const declaredTargets = []
  for (const target of targets) {
    const inspected = await inspectDeclaredTarget({ context, projectId, target })
    const missingFields = Array.isArray(inspected.evidence && inspected.evidence.missingFields)
      ? inspected.evidence.missingFields
      : []
    declaredTargets.push(Object.freeze({
      objectId: target.objectId,
      declaredByPackIds: Object.freeze([...target.packIds]),
      isCanonical: target.isCanonical,
      ready: inspected.ready === true,
      mode: inspected.mode,
      missingFields: Object.freeze([...missingFields]),
    }))
    if (inspected.ready === true) continue
    const missing = /_missing$/.test(String(inspected.mode || ''))
    if (missing) {
      blockers.push(blocker({
        code: PREFLIGHT_BLOCKER_CODES.PACK_TARGET_MISSING,
        what: `customer pack ${target.packIds.map((packId) => `"${packId}"`).join(', ')} declares targetObjectId "${target.objectId}", and no object with that id exists on this deployment. Create the object the pack DECLARES — do not point the pack at a table that happens to exist under another name, and do not invent a third id`,
        fix: ensureFixForTarget(target),
        detail: { targetObjectId: target.objectId, mode: inspected.mode, packIds: [...target.packIds] },
      }))
      continue
    }
    // The fix is the pack install, which is additive and adds the pack's `ext_` columns. It does
    // NOT add the frozen template's own columns — the installer never calls `ensureObject`, and
    // `ensure` refuses an incomplete target outright (TARGET_SCHEMA_INCOMPLETE). So the two halves
    // of the missing set are split and STATED, rather than letting one fix line imply it covers
    // both: a missing template column means the object was not built by the platform's ensure path,
    // and telling an operator that install repairs it would be a fix line that cannot work.
    const missingExtensionFields = missingFields.filter((fieldId) => target.extensionFieldIds.includes(fieldId))
    const missingTemplateFields = missingFields.filter((fieldId) => !target.extensionFieldIds.includes(fieldId))
    blockers.push(blocker({
      code: PREFLIGHT_BLOCKER_CODES.PACK_TARGET_INCOMPLETE,
      what: `the declared target "${target.objectId}" exists but is missing ${missingFields.length} column(s) the pack needs: ${missingFields.join(', ')}. Installing the pack adds its \`ext_\` columns additively${missingTemplateFields.length ? `, and covers only ${missingExtensionFields.length} of them — ${missingTemplateFields.join(', ')} belong to the frozen manifest, so this object was not built by the platform's own ensure path and install will not add them` : ''}`,
      fix: httpFix({
        method: 'POST',
        path: `/api/integration/stock-preparation/customer-packs/${target.packIds[0]}/install`,
        body: { mode: 'install' },
      }),
      detail: {
        targetObjectId: target.objectId,
        mode: inspected.mode,
        missingFields: [...missingFields],
        missingExtensionFields,
        missingTemplateFields,
      },
    }))
  }
  checks.declaredTargets = Object.freeze(declaredTargets)

  // ---- 4. the source -> `ext_` FIELD MAPPING ------------------------------------------------
  // A pack says WHICH tenant columns exist; the mapping says WHERE their values come from. Without
  // it the refresh runs and writes no `ext_` value at all — a silent, not a loud, failure.
  checks.extFieldMapping = Object.freeze({ configured: Boolean(extFieldMapping) })
  if (!extFieldMapping) {
    blockers.push(blocker({
      code: PREFLIGHT_BLOCKER_CODES.EXT_FIELD_MAPPING_NOT_CONFIGURED,
      what: `no source->\`ext_\` field mapping is configured, so a refresh installs the columns and then writes no \`ext_\` value into them. The mapping is server-held and comes from the deploy-time JSON file named by ${EXT_FIELD_MAPPING_PATH_ENV}`,
      fix: envFix({
        name: EXT_FIELD_MAPPING_PATH_ENV,
        value: '/absolute/path/to/ext-field-mapping.json',
        placeholder: true,
      }),
    }))
  }

  // ---- 5. SANDBOX WRITE AUTHORIZATION -------------------------------------------------------
  // Installing columns and writing rows are TWO independent authorizations. A deployment that has
  // installed the pack and left this closed gets a confusing LATE failure: install succeeds, dry-run
  // succeeds, apply is refused. So the allowlist is checked against each pack's DECLARED target.
  const sandboxPolicy = resolveStockPrepApplySandboxPolicy(config, env)
  const sandboxEnabled = Boolean(sandboxPolicy && sandboxPolicy.enabled === true)
  const configuredAllowlist = sandboxPolicy && Array.isArray(sandboxPolicy.allowedTargetObjectIds)
    ? [...sandboxPolicy.allowedTargetObjectIds]
    : []
  // THE ALLOWLIST IS THE ONE INPUT ON THIS ROUTE WHOSE CONTENT IS UNCONSTRAINED.
  //
  // Everything else the preflight quotes is deployment-AUTHORED and shape-checked upstream: objectIds
  // come off packs the normalizer validated through `assertSandboxObjectId`, env PATHS are named by
  // key and never read. This one is different. `resolveStockPrepApplySandboxPolicy` splits
  // STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS on commas and trims — that is all — so whatever a polluted
  // environment holds becomes an "objectId" here, and from here it reached `fix.run` (as
  // `KEY=<the values>`), `detail.currentAllowlist`, and `checks…allowlist`. All three render in the
  // install page's preflight panel to any stock-prep:read viewer. By convention that env holds
  // sandbox objectIds, which are identifier-class and safe to show; NOTHING ENFORCED IT.
  //
  // So it is enforced here, at the point of REPORTING, through the same predicate the provisioning
  // guard uses. Non-conforming entries never appear anywhere in the response — not even truncated or
  // hashed — and are represented only by a COUNT, which is enough for an operator to learn the
  // environment is polluted without the response becoming the thing that publishes it.
  //
  // This changes what the preflight SAYS, never what apply DOES: `resolveStockPrepApplySandboxPolicy`
  // is untouched and the write gate still reads the raw env. Dropping a non-conforming entry from the
  // suggested `fix` line is deliberate and is the correct advice either way — the write gate would
  // refuse such a target anyway, so re-pasting it would only carry the pollution forward.
  const allowlist = configuredAllowlist.filter((entry) => isSandboxNamespaceObjectId(entry))
  const droppedNonNamespaceEntries = configuredAllowlist.length - allowlist.length
  // The canonical production target is NEVER appliable on the sandbox path regardless of allowlist
  // membership (the apply gate refuses it structurally, and production Apply is a separate owner
  // gate reported under `posture`). Listing it would be advice that cannot work, so a
  // canonical-declaring pack raises no allowlist blocker.
  const sandboxDeclaredTargets = targets.filter((target) => !target.isCanonical)
  const unlistedTargets = sandboxDeclaredTargets.filter((target) => !allowlist.includes(target.objectId))
  checks.sandboxWriteAuthorization = Object.freeze({
    modeEnabled: sandboxEnabled,
    allowlist: Object.freeze([...allowlist]),
    allowlistedCount: allowlist.length,
    declaredSandboxTargetObjectIds: Object.freeze(sandboxDeclaredTargets.map((target) => target.objectId)),
    unlistedDeclaredTargetObjectIds: Object.freeze(unlistedTargets.map((target) => target.objectId)),
    objectIdNamespacePrefix: SANDBOX_OBJECT_ID_NAMESPACE_PREFIX,
    // A COUNT, never the entries: how many configured allowlist members sit outside the namespace
    // and were therefore withheld from every field above. Non-zero means the env is polluted.
    droppedNonNamespaceEntries,
  })
  if (sandboxDeclaredTargets.length > 0 && !sandboxEnabled) {
    blockers.push(blocker({
      code: PREFLIGHT_BLOCKER_CODES.SANDBOX_MODE_NOT_ENABLED,
      what: `sandbox write authorization is off, so installing the pack's columns succeeds and writing rows is refused. Installing columns and writing rows are two independent authorizations and both must be open`,
      fix: envFix({ name: SANDBOX_MODE_ENV, value: 'true' }),
    }))
  }
  if (unlistedTargets.length > 0) {
    // The value is COMPUTED: the entries already allowlisted, plus every declared target that is
    // not. The operator pastes one line and cannot drop an existing entry or mistype a new one.
    const merged = [...allowlist]
    for (const target of unlistedTargets) {
      if (!merged.includes(target.objectId)) merged.push(target.objectId)
    }
    blockers.push(blocker({
      code: PREFLIGHT_BLOCKER_CODES.SANDBOX_ALLOWLIST_MISSING_TARGET,
      what: `the sandbox write allowlist does not contain ${unlistedTargets.map((target) => `"${target.objectId}"`).join(', ')}, which ${unlistedTargets.length === 1 ? 'is' : 'are'} declared by a configured customer pack. Column install will succeed and row apply will be refused — a late, confusing failure. Every declared sandbox target must be in the \`${SANDBOX_OBJECT_ID_NAMESPACE_PREFIX}\` namespace and listed here${droppedNonNamespaceEntries > 0 ? `. ${droppedNonNamespaceEntries} configured entr${droppedNonNamespaceEntries === 1 ? 'y is' : 'ies are'} outside that namespace and ${droppedNonNamespaceEntries === 1 ? 'was' : 'were'} withheld from this line and from the allowlist reported above — the environment holds something that is not a sandbox objectId, and it is not shown here` : ''}`,
      fix: envFix({ name: SANDBOX_TARGET_OBJECT_IDS_ENV, value: merged.join(',') }),
      detail: {
        missingFromAllowlist: unlistedTargets.map((target) => target.objectId),
        // The NAMESPACE-CONFORMING members only (see the filter above). A non-conforming entry is
        // counted, never carried.
        currentAllowlist: [...allowlist],
        droppedNonNamespaceEntries,
      },
    }))
  }

  // Ordered, most-blocking first: the vocabulary order IS the order to fix them in.
  blockers.sort((left, right) => PREFLIGHT_BLOCKER_CODE_ORDER.indexOf(left.code) - PREFLIGHT_BLOCKER_CODE_ORDER.indexOf(right.code))

  return Object.freeze({
    ready: blockers.length === 0,
    blockerCount: blockers.length,
    blockers: Object.freeze(blockers),
    checks: Object.freeze(checks),
    posture: buildPosture({ config, b2aTrialRegistry, env }),
  })
}

module.exports = {
  B2A_REGISTRY_PATH_ENV,
  CANONICAL_TARGET_OBJECT_ID,
  CUSTOMER_PACKS_PATH_ENV,
  EXT_FIELD_MAPPING_PATH_ENV,
  PREFLIGHT_BLOCKER_CODES,
  PREFLIGHT_BLOCKER_CODE_ORDER,
  PREFLIGHT_ROUTE_PATH,
  SANDBOX_MODE_ENV,
  SANDBOX_OBJECT_ID_NAMESPACE_PREFIX,
  SANDBOX_TARGET_OBJECT_IDS_ENV,
  computeStockPreparationPreflight,
  __internals: {
    buildPosture,
    declaredPackTargets,
    ensureFixForTarget,
    envFix,
    httpFix,
  },
}
