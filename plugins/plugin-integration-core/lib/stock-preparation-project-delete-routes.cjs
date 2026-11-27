'use strict'

const { isPlainObject, isValidStockPrepProjectNo } = require('./stock-preparation-common.cjs')
const { resolveProvenOwnTenant } = require('./stock-preparation-operator-scope.cjs')

function isProjectDeleteEnabled(env = process.env) {
  return env.STOCK_PREPARATION_PROJECT_DELETE_ENABLED === 'true'
}

function refusal(status, code) {
  return Object.assign(new Error(code), { status, code })
}

function createProjectDeleteHandlers({ database, authorizeWithin, service, tenantPrincipalDirectory, resolveBoundTarget, sendOk }) {
  function principal(req) {
    const user = req.user || req.authUser
    if (!user || typeof user.id !== 'string' || !user.id.trim()) throw refusal(401, 'UNAUTHENTICATED')
    // jwt-middleware stamps this before it can backfill user.tenantId from a request header.
    // Membership alone cannot choose a current tenant for an administrator belonging to two.
    if (typeof req.authenticatedTenantId !== 'string' || !req.authenticatedTenantId.trim()) {
      throw refusal(403, 'OPERATOR_SCOPE_TENANT_REQUIRED')
    }
    return resolveProvenOwnTenant({
      user,
      authenticatedTenantId: req.authenticatedTenantId,
      explicitTenantIds: [req.body?.tenantId, req.query?.tenantId, req.headers?.['x-tenant-id']],
      tenantPrincipalDirectory,
    })
  }

  async function checkAuthority(scope) {
    if (typeof authorizeWithin !== 'function' || typeof database?.transaction !== 'function') {
      throw refusal(503, 'STOCK_PREPARATION_PROJECT_DELETE_UNAVAILABLE')
    }
    try {
      await database.transaction(async tx => {
        await tx.query("SET LOCAL lock_timeout = '500ms'")
        await authorizeWithin(tx, { actor: scope.actorId, tenantId: scope.tenantId })
      })
    } catch (error) {
      if (error.code === '55P03') throw refusal(409, 'STOCK_PREPARATION_PROJECT_DELETE_BUSY')
      throw error
    }
  }

  async function run(req, res, confirm) {
    if (!req.user && !req.authUser) throw refusal(401, 'UNAUTHENTICATED')
    if (!isProjectDeleteEnabled()) throw refusal(404, 'STOCK_PREPARATION_PROJECT_DELETE_DISABLED')
    const scope = await principal(req)
    await checkAuthority(scope)
    const body = req.body === undefined ? {} : req.body
    const projectNo = req.params?.projectNo
    if (!isValidStockPrepProjectNo(projectNo) || Object.keys(req.query || {}).length || !isPlainObject(body)) {
      throw refusal(422, 'STOCK_PREPARATION_PROJECT_DELETE_INVALID')
    }
    const validBody = confirm
      ? Object.keys(body).length === 2 && Object.hasOwn(body, 'challengeId') && typeof body.challengeId === 'string'
        && Object.hasOwn(body, 'code') && typeof body.code === 'string'
      : Object.keys(body).length === 0
    if (!validBody) throw refusal(422, 'STOCK_PREPARATION_PROJECT_DELETE_INVALID')
    if (!service) throw refusal(503, 'STOCK_PREPARATION_PROJECT_DELETE_UNAVAILABLE')
    const boundTarget = await resolveBoundTarget(scope.tenantId)
    const input = { tenantId: scope.tenantId, actor: scope.actorId, projectNo, boundTarget }
    const result = confirm
      ? await service.confirm({ ...input, challengeId: body.challengeId, verificationCode: body.code })
      : await service.preview(input)
    res.setHeader?.('Cache-Control', 'no-store')
    return sendOk(res, result)
  }

  return {
    async stockPreparationProjectDeleteAccess(req, res) {
      if (!req.user && !req.authUser) throw refusal(401, 'UNAUTHENTICATED')
      res.setHeader?.('Cache-Control', 'no-store')
      if (!isProjectDeleteEnabled() || !service) return sendOk(res, { mayDelete: false })
      try {
        await checkAuthority(await principal(req))
        return sendOk(res, { mayDelete: true })
      } catch (error) {
        if (error.status === 403) return sendOk(res, { mayDelete: false })
        throw error
      }
    },
    stockPreparationProjectDeletePreview: (req, res) => run(req, res, false),
    stockPreparationProjectDeleteConfirm: (req, res) => run(req, res, true),
  }
}

module.exports = { createProjectDeleteHandlers, isProjectDeleteEnabled }
