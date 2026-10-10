'use strict'

// 备料「成员与权限」— the plugin half of slice S5b (ADR adr-stock-prep-project-sheets-20261008
// §11.4–§11.6; register R-39).
//
// WHAT LIVES HERE: the page's default-OFF switch and the routes' PURE request checks. Nothing in this
// file performs IO, and nothing in it decides who may do what — that is the host's narrow members
// port (packages/core-backend/src/services/stock-preparation-members.ts), which the four routes in
// http-routes.cjs call after the plugin's own WORKBENCH_ADMIN gate and this switch:
//
//   GET   …/members                                    describe (roles, members, this app's audit)
//   POST  …/members/custom-roles                       create a server-generated stock-prep_c_ role
//   PATCH …/members/custom-roles/:roleId               rename / change its stock-prep:* codes
//   POST  …/members/custom-roles/:roleId/project-targets add project sheets to its scope (G1, add-only)
//
// Appoint / revoke and the plugin admission stay on the EXISTING delegation routes
// (core-backend routes/admin-users.ts `/api/admin/role-delegation/...`), which the web page calls
// directly; this plugin adds no second way to write `user_roles` or `user_namespace_admissions`.

const { isValidStockPrepProjectNo } = require('./stock-preparation-common.cjs')

/** The operator switch. Default OFF; exact literal 'true' only (no trim, no case folding); per request. */
const STOCK_PREP_MEMBERS_PAGE_ENABLED_ENV = 'STOCK_PREP_MEMBERS_PAGE_ENABLED'
const STOCK_PREP_MEMBERS_PAGE_DISABLED_CODE = 'STOCK_PREP_MEMBERS_PAGE_DISABLED'
const STOCK_PREP_MEMBERS_REQUEST_INVALID_CODE = 'STOCK_PREP_MEMBERS_REQUEST_INVALID'

/** Project sheets per add call. The host port enforces the same bound on what it is handed. */
const STOCK_PREP_MEMBERS_MAX_PROJECTS_PER_CALL = 50

/** The closed body allowlists. A key outside them is a 400 before anything else happens. */
const STOCK_PREP_MEMBERS_CUSTOM_ROLE_CREATE_KEYS = Object.freeze(['name', 'permissionCodes'])
const STOCK_PREP_MEMBERS_CUSTOM_ROLE_UPDATE_KEYS = Object.freeze(['name', 'permissionCodes'])
const STOCK_PREP_MEMBERS_PROJECT_TARGETS_KEYS = Object.freeze(['projectNos'])

function stockPrepMembersPageEnabled(env = process.env) {
  return Boolean(env) && env[STOCK_PREP_MEMBERS_PAGE_ENABLED_ENV] === 'true'
}

class StockPrepMembersRequestError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'StockPrepMembersRequestError'
    this.status = 400
    this.code = STOCK_PREP_MEMBERS_REQUEST_INVALID_CODE
    this.details = details
  }
}

/**
 * The project numbers a project-sheet add names: 1..50 plain project numbers, de-duplicated in order.
 * Values-free refusals: the field is named, the number is not echoed.
 */
function normalizeStockPrepMembersProjectNos(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > STOCK_PREP_MEMBERS_MAX_PROJECTS_PER_CALL) {
    throw new StockPrepMembersRequestError(`projectNos must list 1-${STOCK_PREP_MEMBERS_MAX_PROJECTS_PER_CALL} project numbers`, { field: 'projectNos' })
  }
  const out = []
  for (const entry of raw) {
    const projectNo = typeof entry === 'string' ? entry.trim() : ''
    if (!projectNo || !isValidStockPrepProjectNo(projectNo)) {
      throw new StockPrepMembersRequestError('every projectNos entry must be a plain project number', { field: 'projectNos' })
    }
    if (!out.includes(projectNo)) out.push(projectNo)
  }
  return out
}

module.exports = {
  STOCK_PREP_MEMBERS_CUSTOM_ROLE_CREATE_KEYS,
  STOCK_PREP_MEMBERS_CUSTOM_ROLE_UPDATE_KEYS,
  STOCK_PREP_MEMBERS_MAX_PROJECTS_PER_CALL,
  STOCK_PREP_MEMBERS_PAGE_DISABLED_CODE,
  STOCK_PREP_MEMBERS_PAGE_ENABLED_ENV,
  STOCK_PREP_MEMBERS_PROJECT_TARGETS_KEYS,
  STOCK_PREP_MEMBERS_REQUEST_INVALID_CODE,
  StockPrepMembersRequestError,
  normalizeStockPrepMembersProjectNos,
  stockPrepMembersPageEnabled,
}
