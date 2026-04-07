'use strict'

/**
 * Installer orchestrator (thin shell) for plugin-after-sales.
 *
 * Design source:
 * - docs/development/platform-object-model-and-template-installer-design-20260407.md §3 §4 §6 §8 §9
 * - docs/development/platform-project-builder-and-template-architecture-design-20260407.md §6.2 §6.3
 *
 * Responsibilities (v1):
 *  1. validateBlueprint — basic structural checks on the template blueprint
 *  2. loadInstallLedger — read the single ledger row for (tenant_id, app_id)
 *  3. writeInstallLedger — UPSERT a terminal-state row (installed|partial|failed)
 *  4. getProjectId — return the v1 pseudo project id `${tenantId}:${appId}`
 *  5. runInstall — the 11-step orchestration flow with enable/reinstall branching
 *  6. loadCurrent — read the installed state for the GET /projects/current route
 *
 * Non-responsibilities (deferred):
 *  - Automation registration and RBAC application.
 *  - Install-time automation/role registration (thin adapter layer is task #10).
 *  - Helper expression resolution (runs at automation execution time, not here).
 *  - Recipient placeholder expansion and notification delivery (run in the
 *    notification adapter layer).
 *  - Refund approval submission orchestration (runs in the approval bridge
 *    adapter layer).
 *
 * Invariants (hard constraints from design docs):
 *  - Ledger only records terminal states (installed|partial|failed). No
 *    pending/installing rows are ever written.
 *  - `mode='enable'` + existing ledger row -> ALREADY_INSTALLED error, no DDL/DML.
 *  - `mode='reinstall'` + no ledger row -> NO_INSTALL_TO_REBUILD error.
 *  - Core-object failure still writes a ledger row with status='failed' so the
 *    current endpoint can return the failed state for retry-via-reinstall.
 *  - The only case where no ledger row exists after a failure is a
 *    ledger-write-failed error (chicken-and-egg), handled by LEDGER_WRITE_FAILED.
 *  - `failed` retry is driven by the frontend choosing mode='reinstall' based on
 *    current.status. This orchestrator does NOT auto-downgrade enable to reinstall.
 *
 * Non-goals (never do these in v1):
 *  - Drop, delete, truncate, alter-column on any multitable object
 *  - Inject types into packages/core-backend/src/db/types.ts
 *  - Implement a plugin-side migration runner
 *  - Evaluate any expression language beyond the computeSlaDueAt(priority) helper
 */

const LEDGER_TABLE = 'plugin_after_sales_template_installs'

const ERROR_CODES = Object.freeze({
  VALIDATION_FAILED: 'validation-failed',
  ALREADY_INSTALLED: 'already-installed',
  NO_INSTALL_TO_REBUILD: 'no-install-to-rebuild',
  CORE_OBJECT_FAILED: 'core-object-failed',
  LEDGER_WRITE_FAILED: 'ledger-write-failed',
  INVALID_TEMPLATE_ID: 'invalid-template-id',
})

const VALID_MODES = new Set(['enable', 'reinstall'])
const VALID_STATUSES = new Set(['installed', 'partial', 'failed'])

class InstallerError extends Error {
  constructor(code, message, meta) {
    super(message)
    this.name = 'InstallerError'
    this.code = code
    this.meta = meta || null
  }
}

/**
 * v1 pseudo projectId derivation.
 * v2 will replace this with user-supplied real values; the column in the
 * ledger table already holds the final string shape so no backfill is needed.
 */
function getProjectId(tenantId, appId) {
  if (!tenantId) {
    throw new InstallerError(ERROR_CODES.VALIDATION_FAILED, 'tenantId is required')
  }
  if (!appId) {
    throw new InstallerError(ERROR_CODES.VALIDATION_FAILED, 'appId is required')
  }
  return `${tenantId}:${appId}`
}

/**
 * Minimal blueprint validation (v1).
 * Rejects blueprints that do not have the top-level structure required by
 * ProjectTemplateBlueprint (see #2 §2 of the design docs).
 */
function validateBlueprint(blueprint) {
  if (!blueprint || typeof blueprint !== 'object') {
    throw new InstallerError(ERROR_CODES.VALIDATION_FAILED, 'blueprint is not an object')
  }
  if (!blueprint.id || typeof blueprint.id !== 'string') {
    throw new InstallerError(ERROR_CODES.VALIDATION_FAILED, 'blueprint.id missing')
  }
  if (!blueprint.version || typeof blueprint.version !== 'string') {
    throw new InstallerError(ERROR_CODES.VALIDATION_FAILED, 'blueprint.version missing')
  }
  if (!blueprint.appId || typeof blueprint.appId !== 'string') {
    throw new InstallerError(ERROR_CODES.VALIDATION_FAILED, 'blueprint.appId missing')
  }
  if (!Array.isArray(blueprint.objects) || blueprint.objects.length === 0) {
    throw new InstallerError(
      ERROR_CODES.VALIDATION_FAILED,
      'blueprint.objects must be a non-empty array',
    )
  }
  for (const obj of blueprint.objects) {
    if (!obj || typeof obj !== 'object') {
      throw new InstallerError(ERROR_CODES.VALIDATION_FAILED, 'object descriptor not an object')
    }
    if (!obj.id || typeof obj.id !== 'string') {
      throw new InstallerError(ERROR_CODES.VALIDATION_FAILED, 'object.id missing')
    }
    if (!['multitable', 'service', 'hybrid'].includes(obj.backing)) {
      throw new InstallerError(
        ERROR_CODES.VALIDATION_FAILED,
        `object.backing invalid for ${obj.id}`,
      )
    }
  }
}

/**
 * Load the single ledger row for (tenantId, appId).
 * Returns null if no row exists. Returns the row object with jsonb columns
 * parsed into JS values.
 */
async function loadInstallLedger(database, tenantId, appId) {
  const sqlText = `
    SELECT
      id,
      tenant_id,
      app_id,
      project_id,
      template_id,
      template_version,
      mode,
      status,
      created_objects_json,
      created_views_json,
      warnings_json,
      display_name,
      config_json,
      last_install_at,
      created_at
    FROM ${LEDGER_TABLE}
    WHERE tenant_id = $1 AND app_id = $2
    LIMIT 1
  `
  const rows = await database.query(sqlText, [tenantId, appId])
  const list = Array.isArray(rows) ? rows : rows && rows.rows
  if (!list || list.length === 0) {
    return null
  }
  return normalizeLedgerRow(list[0])
}

function normalizeLedgerRow(raw) {
  return {
    id: raw.id,
    tenantId: raw.tenant_id,
    appId: raw.app_id,
    projectId: raw.project_id,
    templateId: raw.template_id,
    templateVersion: raw.template_version,
    mode: raw.mode,
    status: raw.status,
    createdObjects: parseJsonColumn(raw.created_objects_json, [], 'created_objects_json'),
    createdViews: parseJsonColumn(raw.created_views_json, [], 'created_views_json'),
    warnings: parseJsonColumn(raw.warnings_json, [], 'warnings_json'),
    displayName: raw.display_name || '',
    config: parseJsonColumn(raw.config_json, {}, 'config_json'),
    lastInstallAt: raw.last_install_at,
    createdAt: raw.created_at,
  }
}

function parseJsonColumn(value, fallback, columnName) {
  if (value == null) return fallback
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch (err) {
      console.warn(`[after-sales installer] Failed to parse ledger JSON column: ${columnName}`, err)
      return fallback
    }
  }
  return value
}

function getProvisioningApi(context) {
  return context &&
    context.api &&
    context.api.multitable &&
    context.api.multitable.provisioning &&
    typeof context.api.multitable.provisioning.ensureObject === 'function'
    ? context.api.multitable.provisioning
    : null
}

function shouldProvisionObjectInMultitable(obj) {
  if (!obj || typeof obj !== 'object') return false
  if (obj.backing === 'multitable') return true
  return obj.provisioning && typeof obj.provisioning === 'object' && obj.provisioning.multitable === true
}

/**
 * UPSERT a ledger row with terminal state. Caller supplies fully formed row.
 * Returns the persisted row (with id).
 *
 * The UPSERT relies on the unique index (tenant_id, app_id) established by the
 * 20260407140000 migration.
 */
async function writeInstallLedger(database, row) {
  if (!VALID_STATUSES.has(row.status)) {
    throw new InstallerError(
      ERROR_CODES.LEDGER_WRITE_FAILED,
      `invalid ledger status: ${row.status}`,
    )
  }
  if (!VALID_MODES.has(row.mode)) {
    throw new InstallerError(
      ERROR_CODES.LEDGER_WRITE_FAILED,
      `invalid ledger mode: ${row.mode}`,
    )
  }

  const sqlText = `
    INSERT INTO ${LEDGER_TABLE} (
      tenant_id, app_id, project_id, template_id, template_version,
      mode, status,
      created_objects_json, created_views_json, warnings_json,
      display_name, config_json,
      last_install_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7,
      $8::jsonb, $9::jsonb, $10::jsonb,
      $11, $12::jsonb,
      now()
    )
    ON CONFLICT (tenant_id, app_id) DO UPDATE SET
      project_id = EXCLUDED.project_id,
      template_id = EXCLUDED.template_id,
      template_version = EXCLUDED.template_version,
      mode = EXCLUDED.mode,
      status = EXCLUDED.status,
      created_objects_json = EXCLUDED.created_objects_json,
      created_views_json = EXCLUDED.created_views_json,
      warnings_json = EXCLUDED.warnings_json,
      display_name = EXCLUDED.display_name,
      config_json = EXCLUDED.config_json,
      last_install_at = now()
    RETURNING id, tenant_id, app_id, project_id, template_id, template_version,
              mode, status,
              created_objects_json, created_views_json, warnings_json,
              display_name, config_json,
              last_install_at, created_at
  `

  let result
  try {
    result = await database.query(sqlText, [
      row.tenantId,
      row.appId,
      row.projectId,
      row.templateId,
      row.templateVersion,
      row.mode,
      row.status,
      JSON.stringify(row.createdObjects || []),
      JSON.stringify(row.createdViews || []),
      JSON.stringify(row.warnings || []),
      row.displayName || '',
      JSON.stringify(row.config || {}),
    ])
  } catch (err) {
    throw new InstallerError(
      ERROR_CODES.LEDGER_WRITE_FAILED,
      `ledger UPSERT failed: ${err && err.message ? err.message : err}`,
    )
  }

  const list = Array.isArray(result) ? result : result && result.rows
  if (!list || list.length === 0) {
    throw new InstallerError(ERROR_CODES.LEDGER_WRITE_FAILED, 'ledger UPSERT returned no row')
  }
  return normalizeLedgerRow(list[0])
}

/**
 * Main orchestrator entry point.
 *
 * Expected input:
 *   {
 *     context,            // plugin context (for context.api.database access)
 *     tenantId,           // from tenant context injection at the route layer
 *     blueprint,          // ProjectTemplateBlueprint (typically from app.manifest.json)
 *     mode,               // 'enable' | 'reinstall'
 *     displayName,        // optional; from ProjectCreateRequest.displayName
 *     config,             // optional; from ProjectCreateRequest.config
 *   }
 *
 * Returns TemplateInstallResult-shaped object:
 *   {
 *     projectId, appId, status, createdObjects, createdViews, warnings, reportRef
 *   }
 *
 * Throws InstallerError with code corresponding to the error table in
 * platform-project-creation-flow-design §4.3.
 */
async function runInstall(input) {
  const { context, tenantId, blueprint, mode, displayName, config } = input || {}

  if (!context || !context.api || !context.api.database) {
    throw new InstallerError(
      ERROR_CODES.VALIDATION_FAILED,
      'context.api.database is required for installer',
    )
  }
  if (!VALID_MODES.has(mode)) {
    throw new InstallerError(ERROR_CODES.VALIDATION_FAILED, `invalid mode: ${mode}`)
  }

  // Step 1: validate blueprint
  validateBlueprint(blueprint)

  // Step 2-3: load ledger + branch on mode
  const existingRow = await loadInstallLedger(context.api.database, tenantId, blueprint.appId)

  if (mode === 'enable' && existingRow) {
    throw new InstallerError(
      ERROR_CODES.ALREADY_INSTALLED,
      'after-sales is already installed for this tenant',
      { reportRef: existingRow.id, projectId: existingRow.projectId },
    )
  }
  if (mode === 'reinstall' && !existingRow) {
    throw new InstallerError(
      ERROR_CODES.NO_INSTALL_TO_REBUILD,
      'no existing install found; call with mode=enable first',
    )
  }

  // Step 4: generate projectId (v1 pseudo value)
  const projectId = getProjectId(tenantId, blueprint.appId)
  const provisioning = getProvisioningApi(context)
  const objectSheetIds = new Map()

  // Step 5-10: execute installation
  // v1 SIMULATION: iterate blueprint declarations and treat them as "created".
  // Real multitable/workflow/notification/RBAC wire-up will land in follow-up
  // commits once this orchestrator flow is merged and the routes expose it.
  const createdObjects = []
  const createdViews = []
  const warnings = []

  try {
    for (const obj of blueprint.objects) {
      if (shouldProvisionObjectInMultitable(obj)) {
        if (provisioning) {
          const provisioned = await provisioning.ensureObject({
            projectId,
            descriptor: obj,
          })
          if (provisioned && provisioned.sheet && provisioned.sheet.id) {
            objectSheetIds.set(obj.id, provisioned.sheet.id)
          }
        }
        createdObjects.push(obj.id)
      } else if (obj.backing === 'service' || obj.backing === 'hybrid') {
        // service/hybrid-backed objects are managed by the plugin's own service
        // layer, not by the template installer. Skipped intentionally unless
        // blueprint-level multitable projection is explicitly enabled.
      }
    }

    for (const view of blueprint.views || []) {
      if (provisioning && typeof provisioning.ensureView === 'function') {
        const sheetId = objectSheetIds.get(view.objectId)
        if (sheetId) {
          await provisioning.ensureView({
            projectId,
            sheetId,
            descriptor: view,
          })
        }
      }
      createdViews.push(view.id)
    }

    // TODO(phase-1b): register AutomationRuleDraft via workflow service adapter
    // TODO(phase-1b): apply RolePermissionMatrix via RBAC adapter
  } catch (err) {
    // Core-object failure: still write ledger row with status='failed' so the
    // current endpoint can return `failed` and the frontend can retry with
    // mode='reinstall'. The only case where no row is written is if the
    // ledger UPSERT itself throws (LEDGER_WRITE_FAILED).
    try {
      await writeInstallLedger(context.api.database, {
        tenantId,
        appId: blueprint.appId,
        projectId,
        templateId: blueprint.id,
        templateVersion: blueprint.version,
        mode,
        status: 'failed',
        createdObjects,
        createdViews,
        warnings: [String(err && err.message ? err.message : err)],
        displayName: displayName || '',
        config: config || {},
      })
    } catch (writeErr) {
      // Chicken-and-egg: ledger write itself failed. Surface this distinctly.
      throw new InstallerError(
        ERROR_CODES.LEDGER_WRITE_FAILED,
        `core-object failure and ledger write also failed: ${writeErr.message || writeErr}`,
      )
    }
    throw new InstallerError(
      ERROR_CODES.CORE_OBJECT_FAILED,
      `core object creation failed: ${err && err.message ? err.message : err}`,
    )
  }

  // Step 11: determine terminal status and write ledger
  const status = warnings.length === 0 ? 'installed' : 'partial'

  const ledgerRow = await writeInstallLedger(context.api.database, {
    tenantId,
    appId: blueprint.appId,
    projectId,
    templateId: blueprint.id,
    templateVersion: blueprint.version,
    mode,
    status,
    createdObjects,
    createdViews,
    warnings,
    displayName: displayName || '',
    config: config || {},
  })

  return {
    projectId,
    appId: blueprint.appId,
    status,
    createdObjects,
    createdViews,
    warnings,
    reportRef: ledgerRow.id,
  }
}

/**
 * Read the current install state for the GET /api/after-sales/projects/current
 * endpoint. Returns a ProjectCurrentResponse-shaped object (see #4 §2.3 and
 * #5 §5.2.1 for the canonical form).
 *
 * Note: `displayName` and `config` are populated from the ledger row so the
 * frontend can populate the reinstall request body directly from this response
 * without relying on local cache.
 */
async function loadCurrent(context, tenantId, appId) {
  if (!context || !context.api || !context.api.database) {
    throw new InstallerError(
      ERROR_CODES.VALIDATION_FAILED,
      'context.api.database is required for loadCurrent',
    )
  }
  const row = await loadInstallLedger(context.api.database, tenantId, appId)
  if (!row) {
    return { status: 'not-installed' }
  }
  return {
    status: row.status,
    projectId: row.projectId,
    displayName: row.displayName,
    config: row.config,
    installResult: {
      projectId: row.projectId,
      status: row.status,
      createdObjects: row.createdObjects,
      createdViews: row.createdViews,
      warnings: row.warnings,
      reportRef: row.id,
    },
    reportRef: row.id,
  }
}

module.exports = {
  LEDGER_TABLE,
  ERROR_CODES,
  InstallerError,
  getProjectId,
  validateBlueprint,
  loadInstallLedger,
  writeInstallLedger,
  runInstall,
  loadCurrent,
}
