'use strict'

const appManifest = require('./app.manifest.json')
const installer = require('./lib/installer.cjs')

// --------------------------------------------------------------------------
// Local helpers
// --------------------------------------------------------------------------

/**
 * v1 tenantId extraction. Matches the existing convention used by
 * packages/core-backend/src/routes/plm-workbench.ts and workflow.ts.
 *
 * TODO(phase-1b): replace with AsyncLocalStorage tenantContext.getTenantId()
 * once the plugin-context injection is available for plugins.
 */
function getTenantId(req) {
  return req.user?.tenantId?.toString() || 'default'
}

function getUserId(req) {
  const u = req.user
  if (!u) return null
  return u.id || u.sub || u.userId || null
}

/**
 * v1 whitelist of template ids. v2 will expand this as templates proliferate
 * and/or user-uploaded templates become allowed.
 */
const ALLOWED_TEMPLATE_IDS = new Set(['after-sales-default'])

/**
 * Build a ProjectTemplateBlueprint from the plugin's app.manifest.json.
 *
 * v1 mapping is intentionally minimal: it only populates the structural
 * fields that runInstall's validateBlueprint will check. Automation / views /
 * roles / notifications arrays are left empty at this point — they will be
 * populated by the thin adapter layer in a follow-up commit (task #10).
 */
function buildBlueprintFromManifest(manifest) {
  return {
    id: 'after-sales-default',
    version: manifest.version || '0.1.0',
    displayName: manifest.displayName || 'After Sales Default Template',
    appId: manifest.id,
    objects: Array.isArray(manifest.objects) ? manifest.objects.map((o) => ({ ...o })) : [],
    views: [],
    automations: [],
    roles: [],
    notifications: [],
    configDefaults: {},
  }
}

/**
 * Map InstallerError.code to HTTP status codes per
 * platform-project-creation-flow-design-20260407.md §4.3.
 */
function installerErrorToHttpStatus(code) {
  switch (code) {
    case installer.ERROR_CODES.ALREADY_INSTALLED:
      return 409
    case installer.ERROR_CODES.NO_INSTALL_TO_REBUILD:
      return 404
    case installer.ERROR_CODES.VALIDATION_FAILED:
    case installer.ERROR_CODES.INVALID_TEMPLATE_ID:
      return 400
    case installer.ERROR_CODES.CORE_OBJECT_FAILED:
    case installer.ERROR_CODES.LEDGER_WRITE_FAILED:
      return 500
    default:
      return 500
  }
}

function sendInstallerError(res, err) {
  const status = installerErrorToHttpStatus(err.code)
  const payload = {
    ok: false,
    error: { code: err.code, message: err.message },
  }
  if (err.meta && typeof err.meta === 'object') {
    payload.error.details = err.meta
  }
  res.status(status).json(payload)
}

function sendUnauthorized(res) {
  res.status(401).json({
    ok: false,
    error: { code: 'UNAUTHORIZED', message: 'User ID not found' },
  })
}

// --------------------------------------------------------------------------
// Plugin entry
// --------------------------------------------------------------------------

module.exports = {
  async activate(context) {
    const logger = context.logger || console

    // Health / manifest probes (unchanged from skeleton)
    context.api.http.addRoute('GET', '/api/after-sales/health', async (_req, res) => {
      res.json({
        ok: true,
        plugin: 'plugin-after-sales',
        appId: appManifest.id,
        ts: Date.now(),
      })
    })

    context.api.http.addRoute('GET', '/api/after-sales/app-manifest', async (_req, res) => {
      res.json({
        ok: true,
        data: appManifest,
      })
    })

    // ------------------------------------------------------------------
    // GET /api/after-sales/projects/current
    //
    // Returns a ProjectCurrentResponse (see #5 §5.2.1). Used by the frontend
    // AfterSalesView state machine on mount to decide which sub-view to
    // render: not-installed / installed / partial / failed.
    // ------------------------------------------------------------------
    context.api.http.addRoute(
      'GET',
      '/api/after-sales/projects/current',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          const tenantId = getTenantId(req)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          res.json({ ok: true, data: current })
        } catch (err) {
          if (err instanceof installer.InstallerError) {
            sendInstallerError(res, err)
            return
          }
          logger.error && logger.error('after-sales loadCurrent failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to load current state' },
          })
        }
      },
    )

    // ------------------------------------------------------------------
    // POST /api/after-sales/projects/install
    //
    // Triggers the installer orchestrator. Accepts ProjectCreateRequest
    // (see #4 §4.1). The `projectId` field is ignored in v1; the installer
    // always generates `${tenantId}:after-sales`.
    //
    // TODO(phase-1b): add after_sales:admin permission check once a shared
    // withPermission helper is available. For v1 we only require an
    // authenticated user.
    // ------------------------------------------------------------------
    context.api.http.addRoute(
      'POST',
      '/api/after-sales/projects/install',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }

          const body = (req && req.body) || {}

          const templateId = typeof body.templateId === 'string' ? body.templateId : ''
          if (!ALLOWED_TEMPLATE_IDS.has(templateId)) {
            res.status(400).json({
              ok: false,
              error: {
                code: installer.ERROR_CODES.INVALID_TEMPLATE_ID,
                message: `unknown templateId: ${templateId || '(empty)'}`,
              },
            })
            return
          }

          const mode = body.mode === 'reinstall' ? 'reinstall' : 'enable'
          const displayName = typeof body.displayName === 'string' ? body.displayName : ''
          const config =
            body.config && typeof body.config === 'object' && !Array.isArray(body.config)
              ? body.config
              : {}

          const tenantId = getTenantId(req)
          const blueprint = buildBlueprintFromManifest(appManifest)

          const result = await installer.runInstall({
            context,
            tenantId,
            blueprint,
            mode,
            displayName,
            config,
          })

          res.json({
            ok: true,
            data: {
              projectId: result.projectId,
              appId: result.appId,
              routes: {
                home: '/p/plugin-after-sales/after-sales',
                apiBase: '/api/after-sales',
              },
              installResult: result,
            },
          })
        } catch (err) {
          if (err instanceof installer.InstallerError) {
            sendInstallerError(res, err)
            return
          }
          logger.error && logger.error('after-sales runInstall failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Install failed' },
          })
        }
      },
    )

    // Communication / events (unchanged from skeleton)
    context.communication.register('after-sales', {
      async getManifest() {
        return appManifest
      },
    })

    context.api.events.emit('after-sales.plugin.activated', {
      plugin: 'plugin-after-sales',
      appId: appManifest.id,
    })

    logger.info && logger.info('After-sales plugin activated')
  },

  async deactivate() {},
}
