'use strict'

// 一个项目一张备料表 — THE PROJECT OVERVIEW (S3 of ADR adr-stock-prep-project-sheets-20261008 §5;
// register R-37; owner Q5: 宿主级只读 + O1 + O2(a), NO O3).
//
// WHAT THIS IS. One plugin-managed multitable sheet per tenant staging project
// (`plm_stock_preparation_project_overview`, template in stock-preparation-templates.cjs), ONE ROW PER
// REGISTRY ROW, keyed by `projectNo`. Every cell is a PROJECTION of facts the plugin already holds:
//   * the registry row (status, the three O2(a) project-level texts, `last_pull_*`, the bounded
//     counts and their 「截至」 clock);
//   * a bounded count of THAT project's sheet (rows / active rows / 采购未完成 / 仓库未完成), taken
//     through the same binding the pull resolves, narrowed to the project's own number;
//   * the confirmation ledger's PENDING count per project (the directory's own reader);
//   * the O1 deep link: `/multitable/<sheetId>/<待填写 view id>` — the registry's sheet id and the
//     view id the host derives for (staging project, objectId, 'prep-todo'). NEVER a request value.
//
// WHAT THIS IS NOT. Not a second writer of the project sheet (O3 was ruled out): nothing here reads
// a row of the overview back into a project sheet. Not a permission mechanism: the HOST makes the
// overview read-only for every person (system kind `stock_prep_overview`, stamped at provisioning;
// capability clamp; automations and comments refused), and this module REFUSES to use a sheet the host
// does not report as stamped — fail-closed, so an older host cannot leave an unclamped overview behind.
// The plugin's own records writes do not go through people's capabilities, which is how the
// projection can be written at all — but only through the host's DEDICATED overview port
// (`records.stockPreparationOverview`, fix round 2 F3): the generic record writes refuse the overview for
// every plugin, so a pipeline / the multitable target adapter, whose sheet id comes from configuration,
// cannot reach it.
//
// WHO CREATES IT (fix round 1, R6). Only the PULL tier: the project-target create route ensures it
// (when a project is registered and the overview is absent) and so does the explicit
// `POST …/project-overview/ensure`. Both grant the configured G1 roles READ on it through the host's
// overview read port (`grantProjectOverviewRoles`). The OPERATE refresh never provisions: it projects
// into an EXISTING overview and answers 409 STOCK_PREPARATION_PROJECT_OVERVIEW_ABSENT otherwise.
//
// THE STAMP IS CHECKED BEFORE ANY WRITE (fix round 1, R8). The host must DECLARE that it stamps
// (`provisioning.supportsSystemKindStamp === true`, 503 otherwise, before any IO); the derived id is
// looked up first and an existing sheet that is not stamped is 409 NOT_STAMPED with nothing created; the
// host stamps on INSERT and refuses — inside its own transaction — to adopt an existing sheet of another
// kind (`SHEET_SYSTEM_KIND_CONFLICT`, mapped to the same 409). A database without the column (42703) is a
// typed values-free 503.
//
// WHEN IT IS WRITTEN. Every write of the overview holds the tenant's OVERVIEW advisory lock
// (`store.tryWithOverviewLock`, fix round 1 R3) — a TRY-lock since fix round 2 (F4): nobody waits for it
// holding a pooled connection; a busy refresh is 409 BUSY and a busy event leaves its project dirty for the
// running writer to re-project (see "NEVER WAIT FOR THE OVERVIEW LOCK" below):
//   * the REFRESH (`refreshProjectOverview`, the OPERATE route) rebuilds every row within bounds (at most
//     the registry's 200 rows; each project's sheet read through at most PULL_TARGET_MAX_PAGES pages —
//     past that the counts are a floor and `countsBounded` says so), deletes duplicate rows per project
//     and rows of projects no longer registered, and writes only rows whose projection changed — 「截至」
//     alone never causes a write (R7). The registry's count columns are stamped only when the measured
//     counts differ from what it holds, so the registry's `counts_at` and the overview's 「截至」 agree;
//   * the PER-EVENT update (`updateProjectOverviewRow`, R5) does the same for ONE project after a create,
//     archive, restore, project-fields change, dry-run / apply outcome or confirmation. Best-effort by
//     contract: the caller never lets it fail the event, and a missing overview makes it a no-op.
// Nothing here runs on a timer.
//
// VALUES-FREE SURFACE. Refusals and the summaries carry ids, enums, counts and booleans. The three
// project-level texts travel ONLY into the overview cells and the project-fields response — never into
// an audit row, a refusal detail or a log line.

const {
  STOCK_PREPARATION_PROJECT_OVERVIEW_TABLE_TEMPLATE,
  STOCK_PREPARATION_PROJECT_OVERVIEW_VIEWS,
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  buildSheetStructureFromMvpTableTemplate,
  pickTemplateLabel,
  resolveTemplateLabelLocale,
} = require('./stock-preparation-templates.cjs')
const { resolveStockPreparationOwnBase } = require('./stock-preparation-own-base.cjs')
const { STOCK_PREPARATION_TODO_VIEW_LOGICAL_ID } = require('./stock-preparation-target-provisioning.cjs')
const {
  MAX_PROJECT_TARGETS_PER_TENANT,
  buildProjectTargetBinding,
} = require('./stock-preparation-project-targets.cjs')
const { createTargetScopedRecordsApi } = require('./stock-preparation-table-actions.cjs')
const { pendingDecisionCountsByProjectNo } = require('./stock-preparation-operator-project-directory.cjs')
const { PULL_TARGET_PAGE_LIMIT, PULL_TARGET_MAX_PAGES } = require('./stock-preparation-pull-target-scan.cjs')

const TEMPLATE = STOCK_PREPARATION_PROJECT_OVERVIEW_TABLE_TEMPLATE
const STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID = TEMPLATE.objectId
// The host's `meta_sheets.system_kind` for the overview. MUST equal the literal in
// packages/core-backend/src/multitable/system-sheet-predicate.ts (the overview suite pins the two
// against the host source, the way own-base.cjs pins core's base-id rule).
const STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND = 'stock_prep_overview'
const STOCK_PREPARATION_PROJECT_OVERVIEW_FIELD_IDS = Object.freeze(TEMPLATE.fields.map((field) => field.id))
// The overview never holds more rows than the registry may (archived included).
const MAX_PROJECT_OVERVIEW_ROWS = MAX_PROJECT_TARGETS_PER_TENANT
// Reading the overview back (to decide create vs patch, and which rows are duplicates / orphans) is
// bounded: two pages of the host's page size cover 200 rows with room for the duplicates a race left.
// S3 follow-up D: EVERY page is read BEFORE anything is deleted — deleting while paging by offset shifts
// the rows after the deleted ones forward, so the next page skips them (and a skipped project then looks
// rowless and gets a duplicate created).
const OVERVIEW_READ_PAGE_LIMIT = 500
const OVERVIEW_READ_MAX_PAGES = 2
// The per-event update reads only ONE project's rows; more than this many is not a race residue.
const OVERVIEW_PROJECT_ROW_READ_LIMIT = 50
// Fix round 1 (R6): the OPERATE refresh is a bounded rebuild a floor operator can click; within this
// window after a refresh started (per tenant, per process) another click answers 200 `fresh: false` with
// no refresh IO. Stated in register R-37.
const PROJECT_OVERVIEW_REFRESH_COOLDOWN_MS = 60 * 1000

// The main-template columns the per-project count reads (ADR §5): the project narrowing, the
// validity flag, and the two 「完成」 booleans whose NOT-true rows are the two 未完成 counts.
const PROJECT_SHEET_COUNT_FIELD_IDS = Object.freeze(['projectNo', 'active', 'procurementDone', 'warehouseDone'])

const HOST_UNSUPPORTED_CODE = 'STOCK_PREPARATION_PROJECT_OVERVIEW_HOST_UNSUPPORTED'
const NOT_STAMPED_CODE = 'STOCK_PREPARATION_PROJECT_OVERVIEW_NOT_STAMPED'
const ABSENT_CODE = 'STOCK_PREPARATION_PROJECT_OVERVIEW_ABSENT'

class StockPreparationProjectOverviewError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationProjectOverviewError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new StockPreparationProjectOverviewError(400, 'STOCK_PREPARATION_PROJECT_OVERVIEW_INPUT_INVALID', `${field} is required`, { field })
  }
  return normalized
}

function nonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

// ── THE POSTURE — the server-side `stockPrepPosture` (ADR §5 「状态」) ────────────────────────────
//
// WORD FOR WORD the web's projectPosture.ts, plus 「已归档」 FIRST. The home's four filters and the
// overview's 「状态」 column must be the same predicate with the same wording, so a cross-language
// mirror spec (apps/web/tests, the `*-vocab-mirror` precedent) drives both with the same inputs and
// asserts key / zh / en equal. The overview never sees `busy` / `notYours` / `progressUnknown`: it is
// a sheet, not a screen, and every count it projects was measured.
const POSTURE_ARCHIVED = Object.freeze({ key: 'archived', zh: '已归档', en: 'Archived', tone: 'neutral' })
const POSTURE_NOT_PULLED = Object.freeze({ key: 'not_pulled', zh: '还没拉过', en: 'Not pulled yet', tone: 'neutral' })
const POSTURE_READY = Object.freeze({ key: 'ready', zh: '可以导出', en: 'Ready to export', tone: 'success' })

function projectOverviewPosture(input = {}) {
  if (input.archived === true) return POSTURE_ARCHIVED
  const pending = nonNegativeInt(input.pendingDecisionCount)
  if (pending > 0) {
    return { key: 'pending_decision', zh: `等您拿主意 ${pending} 件`, en: `${pending} waiting on your decision`, tone: 'warning' }
  }
  const missing = nonNegativeInt(input.missingComponentsCount)
  if (missing > 0) {
    return { key: 'blocked', zh: `卡住了:缺件 ${missing} 种`, en: `Blocked: ${missing} missing part(s)`, tone: 'danger' }
  }
  const pulled = nonNegativeInt(input.pulledRowCount)
  if (pulled > 0) return POSTURE_READY
  return POSTURE_NOT_PULLED
}

// ── O1: THE DEEP LINK ──────────────────────────────────────────────────────────────────────────────
//
// The SAME path shape the workbench shell pushes for 「打开」 (StockPreparationWorkspace.vue
// `handleOpenFillTarget`: `/multitable/<sheetId>/<viewId>`). Two handles, URL-encoded; `null` when
// either is missing so a cell never carries a half link. PURE, and its only inputs are the registry
// row's sheet id and the host-derived view id — no route hands it anything from a request.
function buildProjectOverviewDeepLink({ sheetId, todoViewId } = {}) {
  const sheet = optionalString(sheetId)
  const view = optionalString(todoViewId)
  if (!sheet || !view) return null
  return `/multitable/${encodeURIComponent(sheet)}/${encodeURIComponent(view)}`
}

/** The 待填写 view id of ONE project sheet, derived by the host for (staging project, objectId). */
function projectTodoViewId({ provisioning, projectId, objectId }) {
  if (!provisioning || typeof provisioning.getObjectViewId !== 'function') return null
  const id = provisioning.getObjectViewId(projectId, objectId, STOCK_PREPARATION_TODO_VIEW_LOGICAL_ID)
  return optionalString(id)
}

// ── THE SHEET ──────────────────────────────────────────────────────────────────────────────────────

function buildProjectOverviewDescriptor(options = {}) {
  const structure = buildSheetStructureFromMvpTableTemplate(TEMPLATE, options)
  const templateById = new Map(TEMPLATE.fields.map((field) => [field.id, field]))
  return {
    id: structure.objectId,
    name: structure.label,
    description: 'MetaSheet-managed stock-preparation project overview (a read-only projection of the project-sheet registry).',
    fields: structure.fields.map((field) => {
      const templateField = templateById.get(field.id)
      const property = field.property ? JSON.parse(JSON.stringify(field.property)) : {}
      property.stockPreparationProjectOverview = {
        ownership: templateField.ownership,
        required: templateField.required === true,
        key: templateField.key === true,
      }
      return { ...field, property }
    }),
  }
}

function pickViewName(view, locale) {
  const resolved = locale === undefined ? resolveTemplateLabelLocale() : locale
  return pickTemplateLabel(view, resolved)
}

/** One of the two provisioned views: a grid filtered on the `status` column (ADR §5 「两张视图」). */
function buildProjectOverviewViewDescriptor({ provisioning, projectId, view, locale } = {}) {
  const statusFieldId = provisioning.getFieldId(projectId, STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID, 'status')
  return {
    id: view.id,
    objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID,
    name: pickViewName(view, locale),
    type: 'grid',
    filterInfo: {
      conjunction: 'and',
      conditions: [{ fieldId: statusFieldId, operator: 'is', value: view.status }],
    },
    config: { stockPreparation: { projectOverview: { logicalId: view.id, status: view.status } } },
  }
}

/** The two view handles, derived — they say nothing about whether the views exist. */
function projectOverviewViewHandles({ provisioning, projectId } = {}) {
  const out = { activeViewId: null, archivedViewId: null }
  if (!provisioning || typeof provisioning.getObjectViewId !== 'function') return out
  const [active, archived] = STOCK_PREPARATION_PROJECT_OVERVIEW_VIEWS
  out.activeViewId = optionalString(provisioning.getObjectViewId(projectId, STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID, active.id))
  out.archivedViewId = optionalString(provisioning.getObjectViewId(projectId, STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID, archived.id))
  return out
}

function requireProvisioning(provisioning) {
  const required = ['findObjectSheet', 'ensureObject', 'resolveFieldIds', 'getFieldId', 'getObjectViewId']
  const missing = required.filter((method) => !provisioning || typeof provisioning[method] !== 'function')
  if (missing.length) {
    throw new StockPreparationProjectOverviewError(501, 'STOCK_PREPARATION_PROJECT_OVERVIEW_PROVISIONING_UNAVAILABLE', 'multitable provisioning API is unavailable for the project overview', { requiredMethods: missing })
  }
  return provisioning
}

/**
 * Fix round 1 (R8c): the host must DECLARE that it stamps a requested `systemKind` at INSERT and reports
 * it back (`supportsSystemKindStamp`, the `records.supportsFilterValueLists` idiom). Checked BEFORE any IO:
 * an older host would create an ordinary, writable, deletable sheet where a read-only one was meant, and
 * a write already made cannot be taken back by refusing afterwards.
 */
function assertHostStampsSystemKind(provisioning) {
  if (provisioning && provisioning.supportsSystemKindStamp === true) return
  throw new StockPreparationProjectOverviewError(
    503,
    HOST_UNSUPPORTED_CODE,
    'this host cannot provision the project overview read-only; nothing was written',
    { objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID, reason: 'stamp_not_declared' },
  )
}

/**
 * THE STAMP IS THE PRECONDITION. The host reports `systemKind` on the sheet it found or created;
 * anything but the overview kind refuses, because an overview the host does not clamp is a second,
 * writable copy of every project's numbers.
 */
function assertOverviewStamped(sheet, mode) {
  const kind = sheet && typeof sheet.systemKind === 'string' ? sheet.systemKind : null
  if (kind === STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND) return
  throw new StockPreparationProjectOverviewError(
    409,
    NOT_STAMPED_CODE,
    mode === 'existing'
      ? 'a sheet already sits at the project overview\'s id but the host does not report it as a stock-prep overview system sheet; nothing was written, and it must be removed by an administrator before the overview can be provisioned'
      : 'the host created the project overview sheet without the stock-prep overview system kind; this host cannot make the overview read-only',
    { objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID, mode, reportedKind: kind === null ? 'none' : 'other' },
  )
}

/**
 * Host errors this module turns into its own values-free refusals (E2 / R8c). Anything else is returned
 * as-is for the route's values-free wrapper to answer.
 */
function mapHostOverviewError(error) {
  if (error instanceof StockPreparationProjectOverviewError) return error
  const code = error && typeof error.code === 'string' ? error.code : null
  if (code === 'SHEET_SYSTEM_KIND_CONFLICT') {
    const mapped = new StockPreparationProjectOverviewError(409, NOT_STAMPED_CODE, 'a sheet already sits at the project overview\'s id without the overview system kind; the host refused to adopt it and nothing was written', { objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID, mode: 'existing', reportedKind: 'other' })
    mapped.cause = error
    return mapped
  }
  if (code === '42703') {
    const mapped = new StockPreparationProjectOverviewError(503, HOST_UNSUPPORTED_CODE, 'this database cannot record the project overview\'s system kind yet; nothing was written', { objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID, reason: 'column_missing' })
    mapped.cause = error
    return mapped
  }
  return error
}

/**
 * The overview as the host has it — or null when there is none — WITHOUT creating anything. A sheet at
 * the derived id that the host does not report as stamped is 409 NOT_STAMPED; a host that returns a
 * sheet without the `systemKind` key at all is the older-host 503.
 */
async function findProjectOverviewSheet({ provisioning, projectId } = {}) {
  const api = requireProvisioning(provisioning)
  assertHostStampsSystemKind(api)
  const scopedProjectId = requiredString(projectId, 'projectId')
  let existing
  try {
    existing = await api.findObjectSheet({ projectId: scopedProjectId, objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID })
  } catch (error) {
    throw mapHostOverviewError(error)
  }
  if (!existing) return null
  if (!isPlainObject(existing) || !Object.prototype.hasOwnProperty.call(existing, 'systemKind')) {
    throw new StockPreparationProjectOverviewError(503, HOST_UNSUPPORTED_CODE, 'this host does not report the project overview\'s system kind; nothing was written', { objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID, reason: 'kind_not_reported' })
  }
  assertOverviewStamped(existing, 'existing')
  return {
    sheetId: String(existing.id),
    ...projectOverviewViewHandles({ provisioning: api, projectId: scopedProjectId }),
  }
}

/**
 * ENSURE-IF-ABSENT by the derived objectId (the PULL tier's leg, R6): the overview is created ONCE per
 * tenant staging project, in the pair's base (one-way anchor, own-base.cjs), stamped `stock_prep_overview`
 * by the host on INSERT, with its two views; a later call finds it and writes nothing. Order, each step
 * refusing before the next writes: the host's stamp declaration (no IO) → the lookup of the derived id
 * (an unstamped sheet there is 409 with nothing created) → own-base → the stamped ensure.
 */
async function ensureProjectOverviewSheet({ provisioning, projectId, tenantId, locale, env } = {}) {
  const api = requireProvisioning(provisioning)
  assertHostStampsSystemKind(api)
  const scopedProjectId = requiredString(projectId, 'projectId')
  const found = await findProjectOverviewSheet({ provisioning: api, projectId: scopedProjectId })
  if (found) return { ...found, created: false, ownBaseSource: 'unchanged' }
  const ownBase = await resolveStockPreparationOwnBase({
    provisioning: api,
    projectId: scopedProjectId,
    objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID,
    tenantId,
    explicitBaseId: null,
    locale,
    env,
  })
  let ensured
  try {
    ensured = await api.ensureObject({
      projectId: scopedProjectId,
      baseId: ownBase.baseId,
      descriptor: buildProjectOverviewDescriptor({ locale }),
      // The host-owned stamp (Q5). The plugin-scope wrapper admits it ONLY from this plugin, for this
      // objectId and this kind; the host writes it on INSERT, refuses to adopt an existing sheet of
      // another kind inside its transaction, and reports it back.
      systemKind: STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND,
    })
  } catch (error) {
    throw mapHostOverviewError(error)
  }
  const sheet = ensured && ensured.sheet
  assertOverviewStamped(sheet, 'created')
  const resolved = await api.resolveFieldIds({ projectId: scopedProjectId, objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID, fieldIds: STOCK_PREPARATION_PROJECT_OVERVIEW_FIELD_IDS })
  const missingFields = STOCK_PREPARATION_PROJECT_OVERVIEW_FIELD_IDS.filter((id) => !optionalString(isPlainObject(resolved) ? resolved[id] : null))
  if (missingFields.length) {
    throw new StockPreparationProjectOverviewError(422, 'STOCK_PREPARATION_PROJECT_OVERVIEW_SCHEMA_INCOMPLETE', 'created project overview sheet is missing template fields', { objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID, missingFields })
  }
  const sheetId = String(sheet.id)
  const views = { created: 0, skipped: typeof api.ensureView === 'function' ? null : 'api_unavailable' }
  if (typeof api.ensureView === 'function') {
    for (const view of STOCK_PREPARATION_PROJECT_OVERVIEW_VIEWS) {
      // S3 follow-up E: the overview's own provisioning marker — the host's plugin-scope admits a view on the
      // stamped overview only with it (and strips it before the host's ensureView).
      await api.ensureView({
        projectId: scopedProjectId,
        sheetId,
        descriptor: buildProjectOverviewViewDescriptor({ provisioning: api, projectId: scopedProjectId, view, locale }),
        systemKind: STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND,
      })
      views.created += 1
    }
  }
  return {
    sheetId,
    created: true,
    ...projectOverviewViewHandles({ provisioning: api, projectId: scopedProjectId }),
    views,
    ownBaseSource: ownBase.source,
    ownBaseCreated: ownBase.created === true,
  }
}

/**
 * Fix round 1 (R1): G1 for the overview — ask the host to grant the configured roles `spreadsheet:read`
 * on it (the host port's literal; role subjects, add-only, the overview kind re-checked by the host).
 * Values-free summary. `no_roles_configured` is G2 (an admin grants read by hand), `api_unavailable` an
 * older host; a host REFUSAL (a role outside the namespace, an unknown role, a sheet the plugin does not
 * own) propagates — configuration faults the puller must see, exactly as G1 on a project sheet.
 */
async function grantProjectOverviewRoles({ provisioning, projectId, sheetId, roleIds, actorId } = {}) {
  const roles = Array.isArray(roleIds) ? roleIds.filter((id) => typeof id === 'string' && id.trim()) : []
  if (roles.length === 0) return { attempted: false, skipped: 'no_roles_configured', roleCount: 0, granted: 0, alreadyGranted: 0 }
  if (!provisioning || typeof provisioning.grantOverviewRoleRead !== 'function') {
    return { attempted: false, skipped: 'api_unavailable', roleCount: roles.length, granted: 0, alreadyGranted: 0 }
  }
  const result = await provisioning.grantOverviewRoleRead({
    projectId,
    sheetId,
    objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID,
    roleIds: roles,
    actorId: actorId || null,
  })
  return {
    attempted: true,
    skipped: null,
    roleCount: roles.length,
    granted: Array.isArray(result && result.granted) ? result.granted.length : 0,
    alreadyGranted: Array.isArray(result && result.alreadyGranted) ? result.alreadyGranted.length : 0,
  }
}

// ── THE BOUNDED COUNT OF ONE PROJECT SHEET ────────────────────────────────────────────────────────

function cellData(row) {
  return isPlainObject(row) && isPlainObject(row.data) ? row.data : (isPlainObject(row) ? row : {})
}

/**
 * Rows / active rows / 采购未完成 / 仓库未完成 of ONE project's sheet, narrowed to that project's own
 * number through the binding the pull resolves. "Active" is the pull-target scan's rule
 * (`active !== false`, the fill view's reading); 未完成 is an ACTIVE row whose 完成 flag is not
 * strictly true. Pages are bounded exactly like the directory's scan; past the bound the counts are
 * a floor and `bounded` is true. DEGRADES, never throws: a sheet the host cannot read answers
 * `ready: false` and the overview row keeps the registry's last counts.
 */
async function countProjectSheetRows({ recordsApi, provisioning, projectId, row } = {}) {
  if (!recordsApi || typeof recordsApi.queryRecords !== 'function' || !row) return { ready: false }
  let bindings
  try {
    const binding = await buildProjectTargetBinding({ provisioning, projectId, target: row })
    bindings = {}
    for (const fieldId of PROJECT_SHEET_COUNT_FIELD_IDS) {
      const physical = optionalString(binding.fieldIdMap[fieldId])
      if (!physical) return { ready: false }
      bindings[fieldId] = physical
    }
  } catch (error) {
    return { ready: false }
  }
  let rowCount = 0
  let activeRowCount = 0
  let procurementOpenCount = 0
  let warehouseOpenCount = 0
  let bounded = true
  try {
    for (let page = 0; page < PULL_TARGET_MAX_PAGES; page += 1) {
      const pageRows = await recordsApi.queryRecords({
        sheetId: row.sheetId,
        filters: { [bindings.projectNo]: row.projectNo },
        limit: PULL_TARGET_PAGE_LIMIT,
        offset: page * PULL_TARGET_PAGE_LIMIT,
      })
      if (!Array.isArray(pageRows)) return { ready: false }
      for (const record of pageRows) {
        const data = cellData(record)
        rowCount += 1
        const active = data[bindings.active] !== false
        if (!active) continue
        activeRowCount += 1
        if (data[bindings.procurementDone] !== true) procurementOpenCount += 1
        if (data[bindings.warehouseDone] !== true) warehouseOpenCount += 1
      }
      if (pageRows.length < PULL_TARGET_PAGE_LIMIT) {
        bounded = false
        break
      }
    }
  } catch (error) {
    return { ready: false }
  }
  return { ready: true, bounded, rowCount, activeRowCount, procurementOpenCount, warehouseOpenCount }
}

/** Do freshly measured counts differ from what the registry row holds? (R7: only then is anything stamped.) */
function countsDifferFromRegistry(target, counts) {
  if (!counts || counts.ready !== true) return false
  return target.rowCount !== counts.rowCount
    || target.activeRowCount !== counts.activeRowCount
    || (target.countsBounded === true) !== (counts.bounded === true)
    || target.procurementOpenCount !== counts.procurementOpenCount
    || target.warehouseOpenCount !== counts.warehouseOpenCount
    || !target.countsAt
}

// ── THE PROJECTION ─────────────────────────────────────────────────────────────────────────────────

/**
 * ONE overview row, by logical field id, from: the registry row (`target`), its project-level texts
 * (`fields`), the bounded count just measured (`counts`, or null to keep the registry's own), the
 * ledger's pending count, and the derived deep link. `countsAt` is the 「截至」 of measured counts (the
 * caller passes the registry's own clock when the measurement changed nothing). Pure.
 */
function buildProjectOverviewRow({ target, fields, counts, pendingDecisionCount, todoViewId, locale, countsAt } = {}) {
  const archived = target.status === 'archived'
  const measured = counts && counts.ready === true ? counts : null
  const rowCount = measured ? measured.rowCount : target.rowCount
  const activeRowCount = measured ? measured.activeRowCount : target.activeRowCount
  const countsBounded = measured ? measured.bounded === true : target.countsBounded === true
  const procurementOpenCount = measured ? measured.procurementOpenCount : target.procurementOpenCount
  const warehouseOpenCount = measured ? measured.warehouseOpenCount : target.warehouseOpenCount
  const pending = nonNegativeInt(pendingDecisionCount)
  const missing = nonNegativeInt(target.missingComponentsCount)
  const posture = projectOverviewPosture({ archived, pendingDecisionCount: pending, missingComponentsCount: missing, pulledRowCount: nonNegativeInt(rowCount) })
  const resolvedLocale = locale === undefined ? resolveTemplateLabelLocale() : locale
  const zh = String(resolvedLocale).toLowerCase().startsWith('zh')
  const measuredAt = countsAt instanceof Date ? countsAt.toISOString() : (countsAt ? String(countsAt) : null)
  return {
    projectNo: target.projectNo,
    sheetLink: buildProjectOverviewDeepLink({ sheetId: target.sheetId, todoViewId }),
    posture: zh ? posture.zh : posture.en,
    postureKey: posture.key,
    status: target.status,
    responsibleLabel: fields && fields.responsibleLabel ? fields.responsibleLabel : null,
    note: fields && fields.note ? fields.note : null,
    plannedFinishOn: fields && fields.plannedFinishOn ? fields.plannedFinishOn : null,
    rowCount: rowCount === null || rowCount === undefined ? null : nonNegativeInt(rowCount),
    activeRowCount: activeRowCount === null || activeRowCount === undefined ? null : nonNegativeInt(activeRowCount),
    countsBounded,
    procurementOpenCount: procurementOpenCount === null || procurementOpenCount === undefined ? null : nonNegativeInt(procurementOpenCount),
    warehouseOpenCount: warehouseOpenCount === null || warehouseOpenCount === undefined ? null : nonNegativeInt(warehouseOpenCount),
    pendingDecisionCount: pending,
    missingComponentsCount: missing,
    lastPullAt: target.lastPullAt || null,
    lastPullOutcome: target.lastPullOutcome || null,
    countsAt: measured ? measuredAt : (target.countsAt || null),
  }
}

function readLogicalCell(record, key) {
  const value = cellData(record)[key]
  if (isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, 'value')) return value.value
  return value
}

/**
 * Fix round 1 (R7): the projection compared WITHOUT 「截至」 — a refresh that measured the same numbers
 * must not rewrite every row just because the clock moved.
 */
const PROJECTION_COMPARED_FIELD_IDS = Object.freeze(STOCK_PREPARATION_PROJECT_OVERVIEW_FIELD_IDS.filter((id) => id !== 'countsAt'))

function sameProjection(existing, next) {
  for (const key of PROJECTION_COMPARED_FIELD_IDS) {
    const before = readLogicalCell(existing, key)
    const after = next[key]
    if ((before === null || before === undefined ? null : before) !== (after === null || after === undefined ? null : after)) return false
  }
  return true
}

function requireOverviewStore(store) {
  const required = ['list', 'get', 'listProjectFields', 'getProjectFields', 'recordCounts', 'tryWithOverviewLock']
  const missing = required.filter((method) => !store || typeof store[method] !== 'function')
  if (missing.length) {
    throw new StockPreparationProjectOverviewError(501, 'STOCK_PREPARATION_PROJECT_TARGET_STORE_UNAVAILABLE', 'the project-sheet registry cannot serve the project overview here', { requiredMethods: missing })
  }
  return store
}

// ── FIX ROUND 2 (F3): THE OVERVIEW'S OWN WRITE PORT ───────────────────────────────────────────────────
//
// The host refuses a GENERIC record write (`records.createRecord` / `patchRecord` / `deleteRecord`) to the
// stamped overview for every plugin, this one included — that is the surface a pipeline / the multitable target
// adapter reaches with a sheet id from external-system config. The overview is written ONLY through
// `records.stockPreparationOverview`, the host port this plugin alone gets: it takes the staging PROJECT id and
// derives the overview sheet itself, re-checking ownership and the stamp before each write. Reads stay on the
// generic `queryRecords` (reading the overview is not refused).

/** The host's overview write port, or a values-free 503 before any IO (an older host). */
function requireOverviewWritePort(recordsApi) {
  const port = recordsApi && recordsApi.stockPreparationOverview
  const missing = ['createRecord', 'patchRecord', 'deleteRecord'].filter((method) => !port || typeof port[method] !== 'function')
  if (!recordsApi || typeof recordsApi.queryRecords !== 'function' || missing.length) {
    throw new StockPreparationProjectOverviewError(503, HOST_UNSUPPORTED_CODE, 'this host does not offer the project overview\'s own records write port; nothing was written', { objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID, reason: 'records_port_missing' })
  }
  return port
}

/**
 * A records surface with the GENERIC shape `createTargetScopedRecordsApi` expects, whose every WRITE goes to the
 * host's overview port for `projectId` (never naming a sheet), fenced to the overview sheet id the host reported.
 * Reads go to the generic `queryRecords`.
 */
function overviewWriteRecordsApi(recordsApi, { projectId, sheetId }) {
  const port = requireOverviewWritePort(recordsApi)
  const fence = (input) => {
    if (input && input.sheetId !== undefined && input.sheetId !== sheetId) {
      throw new StockPreparationProjectOverviewError(500, 'STOCK_PREPARATION_PROJECT_OVERVIEW_RECORDS_API_INVALID', 'an overview write tried to leave the overview sheet')
    }
  }
  const api = {
    queryRecords: (input) => recordsApi.queryRecords(input),
    async createRecord(input = {}) { fence(input); return port.createRecord({ projectId, data: input.data }) },
    async patchRecord(input = {}) { fence(input); return port.patchRecord({ projectId, recordId: input.recordId, changes: input.changes }) },
    async deleteRecord(input = {}) { fence(input); return port.deleteRecord({ projectId, recordId: input.recordId }) },
  }
  if (recordsApi.supportsFilterValueLists === true) api.supportsFilterValueLists = true
  return api
}

/** Delete one overview row through the overview write port, fenced to the overview sheet. */
async function deleteOverviewRow(writer, overviewSheetId, record) {
  await writer.deleteRecord({ sheetId: overviewSheetId, recordId: record.id })
}

/**
 * Count, stamp the registry (only on change), build the projection and write ONE project's overview row
 * — create when it has none, patch only when the projection (minus 「截至」) changed. `existingRecords`
 * are this project's rows in the overview, oldest first; every one after the first is a race residue and
 * is deleted. Runs under the caller's overview lock. `recordsApi` (generic, reads) counts the project sheet;
 * `writer` / `scoped` (the overview port) write the overview.
 */
async function writeProjectRow({ api, recordsApi, writer, scoped, store, tenant, projectId, overviewSheetId, target, fields, pendingDecisionCount, existingRecords, recount, locale, now, summary }) {
  let counts = { ready: false }
  if (recount) {
    counts = await countProjectSheetRows({ recordsApi, provisioning: api, projectId, row: target })
    if (counts.ready) {
      summary.countedCount += 1
      if (counts.bounded) summary.boundedCount += 1
    } else {
      summary.unreadableCount += 1
    }
  }
  const changed = countsDifferFromRegistry(target, counts)
  let measuredAt = target.countsAt
  if (changed) {
    measuredAt = now()
    await store.recordCounts({
      tenantId: tenant,
      projectNo: target.projectNo,
      rowCount: counts.rowCount,
      activeRowCount: counts.activeRowCount,
      countsBounded: counts.bounded === true,
      procurementOpenCount: counts.procurementOpenCount,
      warehouseOpenCount: counts.warehouseOpenCount,
      countsAt: measuredAt,
    })
  }
  const data = buildProjectOverviewRow({
    target,
    fields,
    counts,
    pendingDecisionCount,
    todoViewId: projectTodoViewId({ provisioning: api, projectId, objectId: target.objectId }),
    locale,
    countsAt: measuredAt,
  })
  const [keep, ...duplicates] = existingRecords
  for (const duplicate of duplicates) {
    await deleteOverviewRow(writer, overviewSheetId, duplicate)
    summary.rowsRemovedDuplicate += 1
  }
  if (!keep) {
    await scoped.createRecord({ data })
    summary.rowsCreated += 1
  } else if (sameProjection(keep, data)) {
    summary.rowsUnchanged += 1
  } else {
    await scoped.patchRecord({ recordId: keep.id, changes: data })
    summary.rowsUpdated += 1
  }
}

function emptySummary(projectCount = 0) {
  return {
    projectCount,
    countedCount: 0,
    unreadableCount: 0,
    boundedCount: 0,
    rowsCreated: 0,
    rowsUpdated: 0,
    rowsUnchanged: 0,
    rowsRemovedDuplicate: 0,
    rowsRemovedOrphan: 0,
  }
}

// ── FIX ROUND 2 (F4): NEVER WAIT FOR THE OVERVIEW LOCK WHILE HOLDING A CONNECTION ─────────────────────
//
// The overview lock (`store.tryWithOverviewLock`) is a TRY-lock: a writer that finds it busy gives up at once
// (its transaction ends, its pooled connection is released) instead of queueing with a connection held while
// the holder needs more of them. Two writer kinds, one tenant:
//   * the REFRESH (OPERATE route) — busy → 409 STOCK_PREPARATION_PROJECT_OVERVIEW_BUSY, nothing done, no wait;
//   * the PER-EVENT row update (archive / restore / project fields / pull outcome / confirm / create) — busy →
//     no wait either; its project is RECONCILED by whoever holds the lock in this process.
// IN-PROCESS, PER TENANT, BEFORE ANY CONNECTION: the writer state below (one per registry store, i.e. per
// plugin process) records which projects are DIRTY and whether a writer is RUNNING. An event marks its
// project dirty first; if a writer is running it returns `deferred` without touching the database at all
// (so in-process waiters hold no connection — not even a busy try). The running writer drains the dirty set
// INSIDE the lock after its own pass, and after the lock is released re-checks the set synchronously before
// it stops (JavaScript runs that check and the "not running" flip in one turn, so a mark is either seen by
// the holder or finds no holder and runs itself). A refresh in flight therefore re-projects every project an
// event touched while it ran, from the registry as it stands AFTER that event.
// ACROSS PROCESSES the database try-lock is the only coordination: a writer that loses it to another process
// leaves its projects dirty here — reconciled by this process's next overview writer — and the next refresh
// rebuilds everything (register R-37 states this limit).

const BUSY_CODE = 'STOCK_PREPARATION_PROJECT_OVERVIEW_BUSY'

function overviewBusyError() {
  return new StockPreparationProjectOverviewError(409, BUSY_CODE, 'another update of this tenant\'s project overview is running; nothing was done — try again in a moment', { objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID })
}

// S3 follow-up C: a refresh during which some project's overview write FAILED (in the full pass or in the drain
// of the projects events marked dirty while it ran) is not a fresh overview. It answers this typed, values-free
// 503 — the counts of what failed, never a value or a host message — instead of `fresh: true`; the projects that
// failed stay DIRTY (see `runOverviewWriter`) so this process's next overview writer retries them. The rows that
// were written stay written. `summary` (the run's counts, for the route's `incomplete` audit) and `cause` (the
// first failure, whose CODE alone the route may log) are non-enumerable: they never reach a response body.
const REFRESH_INCOMPLETE_CODE = 'STOCK_PREPARATION_PROJECT_OVERVIEW_REFRESH_INCOMPLETE'

function overviewRefreshIncompleteError({ failedProjectCount, summary, cause }) {
  const error = new StockPreparationProjectOverviewError(
    503,
    REFRESH_INCOMPLETE_CODE,
    'the project overview refresh could not bring every project up to date; the rows it wrote stand, the projects it could not write stay marked for the next update — refresh again in a moment',
    {
      objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID,
      failedProjectCount,
      projectCount: summary && Number.isInteger(summary.projectCount) ? summary.projectCount : 0,
    },
  )
  Object.defineProperty(error, 'summary', { value: summary || null, enumerable: false })
  Object.defineProperty(error, 'cause', { value: cause || null, enumerable: false })
  return error
}

/** How many projects (or project-less rows) of one writer run are still failed when it stops. */
function drainFailedCount(drain) {
  return drain.failed.size + drain.unkeyedFailureCount
}

const overviewWriterStatesByStore = new WeakMap()

/** The in-process writer state of ONE tenant's overview: `running` + the dirty projects (projectNo → flags). */
function overviewWriterState(store, tenant) {
  let byTenant = overviewWriterStatesByStore.get(store)
  if (!byTenant) {
    byTenant = new Map()
    overviewWriterStatesByStore.set(store, byTenant)
  }
  let state = byTenant.get(tenant)
  if (!state) {
    state = { running: false, dirty: new Map() }
    byTenant.set(tenant, state)
  }
  return state
}

function markOverviewProjectDirty(state, projectNo, { recount = false } = {}) {
  const previous = state.dirty.get(projectNo)
  state.dirty.set(projectNo, { recount: recount === true || Boolean(previous && previous.recount === true) })
}

/**
 * Run ONE writer for the tenant: take the try-lock, run `firstPass` (the refresh's rebuild; none for an event),
 * drain the dirty set inside the lock, release, and go round again while the set is not empty. Returns
 * `{ busy: true }` when the FIRST try-lock is busy (another process); a later busy try stops the loop and leaves
 * what is still dirty for the next writer here. The caller set nothing on `state.running`; this does.
 *
 * S3 follow-up C: `failed` (the drain's projectNo → flags of every project whose LAST attempt in this run failed)
 * is put BACK into the dirty set when the run stops — not while it runs (the drain loop would retry a persistent
 * failure forever) and not dropped (the `dirty.clear()` above already took it out): the next overview writer of
 * this tenant in this process retries it. Done in `finally`, before `running` flips, in the same turn.
 */
async function runOverviewWriter({ registry, tenant, state, firstPass, drainOne, failed = null }) {
  state.running = true
  try {
    let value
    for (let pass = 0; ; pass += 1) {
      if (pass > 0 && state.dirty.size === 0) break
      const attempt = await registry.tryWithOverviewLock({ tenantId: tenant }, async () => {
        const out = pass === 0 && typeof firstPass === 'function' ? await firstPass() : undefined
        while (state.dirty.size > 0) {
          const batch = [...state.dirty.entries()]
          state.dirty.clear()
          for (const [projectNo, flags] of batch) await drainOne(projectNo, flags)
        }
        return out
      })
      if (!attempt || attempt.acquired !== true) {
        if (pass === 0) return { busy: true }
        break
      }
      if (pass === 0) value = attempt.value
    }
    return { busy: false, value }
  } finally {
    if (failed) {
      for (const [projectNo, flags] of failed) markOverviewProjectDirty(state, projectNo, flags)
    }
    state.running = false
  }
}

/**
 * The per-project reconcile the per-event update and the refresh's drain share: this project's overview rows are
 * read, duplicates deleted, and the row created / patched only when its projection changed; a project that is
 * no longer registered has its rows removed. Failures are collected (the first is kept) so one project cannot
 * stop the others; the caller decides whether to surface it.
 *
 * S3 follow-up C: `failed` holds every project whose LAST attempt in this run failed (a later success in the same
 * run — an event re-marked it — takes it out again); `runOverviewWriter` puts them back into the dirty set when it
 * stops, and the refresh answers REFRESH_INCOMPLETE while any is left. `unkeyedFailureCount` counts failed deletes
 * of overview rows that carry no project number (nothing to re-mark; the next refresh retries them).
 */
function createOverviewProjectDrain({ api, recordsApi, writer, registry, tenant, projectId, sheet, locale, now }) {
  let scopedPromise = null
  const ctx = {
    summary: emptySummary(0),
    firstError: null,
    outcome: null,
    failed: new Map(),
    unkeyedFailureCount: 0,
    recordFailure(no, flags, error) {
      if (!ctx.firstError) ctx.firstError = error
      if (!no) {
        ctx.unkeyedFailureCount += 1
        return
      }
      const previous = ctx.failed.get(no)
      ctx.failed.set(no, { recount: (flags && flags.recount === true) || Boolean(previous && previous.recount === true) })
    },
    async drainOne(no, flags = {}) {
      try {
        if (!scopedPromise) {
          scopedPromise = createTargetScopedRecordsApi(writer, { sheetId: sheet.sheetId, objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID }, { provisioning: api, projectId })
        }
        const scoped = await scopedPromise
        ctx.summary.projectCount += 1
        const existing = await scoped.queryRecords({ filters: { projectNo: no }, limit: OVERVIEW_PROJECT_ROW_READ_LIMIT, offset: 0 })
        if (!Array.isArray(existing)) {
          throw new StockPreparationProjectOverviewError(500, 'STOCK_PREPARATION_PROJECT_OVERVIEW_RECORDS_API_INVALID', 'queryRecords must return an array')
        }
        const mine = existing.filter((record) => optionalString(readLogicalCell(record, 'projectNo')) === no)
        const target = await registry.get({ tenantId: tenant, projectNo: no })
        if (!target) {
          for (const record of mine) {
            await deleteOverviewRow(writer, sheet.sheetId, record)
            ctx.summary.rowsRemovedOrphan += 1
          }
          ctx.failed.delete(no)
          ctx.outcome = ctx.outcome || 'removed'
          return
        }
        const fields = await registry.getProjectFields({ tenantId: tenant, projectNo: no })
        let pendingDecisionCount = 0
        try {
          const pending = await pendingDecisionCountsByProjectNo(recordsApi, api, projectId, no)
          pendingDecisionCount = pending.byProjectNo.get(no) || 0
        } catch (error) {
          pendingDecisionCount = 0
        }
        await writeProjectRow({
          api,
          recordsApi,
          writer,
          scoped,
          store: registry,
          tenant,
          projectId,
          overviewSheetId: sheet.sheetId,
          target,
          fields,
          pendingDecisionCount,
          existingRecords: mine,
          recount: flags.recount === true,
          locale,
          now,
          summary: ctx.summary,
        })
        ctx.failed.delete(no)
        ctx.outcome = 'updated'
      } catch (error) {
        ctx.recordFailure(no, flags, error)
      }
    },
  }
  return ctx
}

/**
 * THE REFRESH (ADR §5, the `POST …/project-overview/refresh` leg; fix round 1 R3 / R6 / R7; fix round 2 F3 / F4).
 * Projects into an EXISTING stamped overview only (409 ABSENT otherwise — the PULL tier creates it). Under the
 * tenant's overview TRY-lock (busy → 409 BUSY, no wait, nothing done), within bounds:
 *   1. the registry rows of the tenant (≤ 200 projected; more is truncated and said);
 *   2. the ledger's pending counts, once for every project (degrades to zeros, `ledgerReady` says);
 *   3. the overview's own rows (bounded): rows of projects no longer registered (or without a project
 *      number) are deleted, and per project only the first row is kept — the rest are race residue;
 *   4. per registry row: count the project sheet (bounded), stamp the registry only when the counts
 *      changed, create or patch the overview row only when its projection (minus 「截至」) changed;
 *   5. (F4) the projects events marked dirty while the refresh ran are re-projected before the lock is
 *      released — from the registry as it stands after those events.
 * Every overview write goes through the host's overview port (F3). Returns a values-free summary. The caller
 * audits it (`project_overview_refresh`).
 * S3 follow-ups: (D) step 3 reads EVERY page before it deletes anything; (C) a project whose write fails in
 * step 3 / 4 / 5 does not stop the others, stays DIRTY for the next writer, and the refresh then throws the
 * typed 503 REFRESH_INCOMPLETE (counts only) instead of returning a summary the caller would call fresh.
 */
async function refreshProjectOverview({ provisioning, recordsApi, store, tenantId, projectId, locale, now = () => new Date() } = {}) {
  const api = requireProvisioning(provisioning)
  assertHostStampsSystemKind(api)
  const tenant = requiredString(tenantId, 'tenantId')
  const scopedProjectId = requiredString(projectId, 'projectId')
  const registry = requireOverviewStore(store)
  requireOverviewWritePort(recordsApi)
  const sheet = await findProjectOverviewSheet({ provisioning: api, projectId: scopedProjectId })
  if (!sheet) {
    throw new StockPreparationProjectOverviewError(409, ABSENT_CODE, 'the project overview has not been created yet; a puller creates it (it is also created with the first project sheet)', { objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID })
  }
  const writer = overviewWriteRecordsApi(recordsApi, { projectId: scopedProjectId, sheetId: sheet.sheetId })
  const state = overviewWriterState(registry, tenant)
  // In-process: another overview writer of this tenant is running — answer at once, without a connection.
  if (state.running) throw overviewBusyError()
  const drain = createOverviewProjectDrain({ api, recordsApi, writer, registry, tenant, projectId: scopedProjectId, sheet, locale, now })
  const run = await runOverviewWriter({
    registry,
    tenant,
    state,
    drainOne: drain.drainOne,
    failed: drain.failed,
    firstPass: async () => {
      // The refresh's own clock — 「截至」 of the facts this run looked at (a row keeps the clock of its
      // last CHANGED measurement, R7; this is when the overview was last checked against the registry).
      const refreshedAt = now()
      const allRows = await registry.list({ tenantId: tenant })
      const truncated = allRows.length > MAX_PROJECT_OVERVIEW_ROWS
      const rows = truncated ? allRows.slice(0, MAX_PROJECT_OVERVIEW_ROWS) : allRows
      const registeredNos = new Set(allRows.map((row) => row.projectNo))
      const fieldsByProjectNo = await registry.listProjectFields({ tenantId: tenant })
      let pending = { ready: false, byProjectNo: new Map() }
      try {
        pending = await pendingDecisionCountsByProjectNo(recordsApi, api, scopedProjectId, null)
      } catch (error) {
        pending = { ready: false, byProjectNo: new Map() }
      }
      const scoped = await createTargetScopedRecordsApi(writer, { sheetId: sheet.sheetId, objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID }, { provisioning: api, projectId: scopedProjectId })
      const summary = emptySummary(rows.length)
      // S3 follow-up D: READ EVERY PAGE FIRST (bounded: OVERVIEW_READ_MAX_PAGES × OVERVIEW_READ_PAGE_LIMIT, the
      // registry's 200-row cap plus room for race residue), THEN delete. Offset paging over a sheet this loop is
      // deleting from would skip the rows the deletes moved forward. A row seen twice (a host whose order moved
      // between pages) is taken once.
      const seenRecords = []
      const seenRecordIds = new Set()
      let overflow = false
      for (let page = 0; page < OVERVIEW_READ_MAX_PAGES; page += 1) {
        const batch = await scoped.queryRecords({ filters: {}, limit: OVERVIEW_READ_PAGE_LIMIT, offset: page * OVERVIEW_READ_PAGE_LIMIT })
        if (!Array.isArray(batch)) {
          throw new StockPreparationProjectOverviewError(500, 'STOCK_PREPARATION_PROJECT_OVERVIEW_RECORDS_API_INVALID', 'queryRecords must return an array')
        }
        for (const record of batch) {
          const recordId = isPlainObject(record) && record.id !== undefined && record.id !== null ? String(record.id) : null
          if (recordId !== null) {
            if (seenRecordIds.has(recordId)) continue
            seenRecordIds.add(recordId)
          }
          seenRecords.push(record)
        }
        if (batch.length < OVERVIEW_READ_PAGE_LIMIT) break
        if (page === OVERVIEW_READ_MAX_PAGES - 1) overflow = true
      }
      const byProjectNo = new Map()
      for (const record of seenRecords) {
        const no = optionalString(readLogicalCell(record, 'projectNo'))
        if (!no || !registeredNos.has(no)) {
          // S3 follow-up C: one row that cannot be deleted does not stop the rest; its project (if it names
          // one) stays dirty — the drain deletes an unregistered project's rows by number.
          try {
            await deleteOverviewRow(writer, sheet.sheetId, record)
            summary.rowsRemovedOrphan += 1
          } catch (error) {
            drain.recordFailure(no, { recount: false }, error)
          }
          continue
        }
        if (!byProjectNo.has(no)) byProjectNo.set(no, [])
        byProjectNo.get(no).push(record)
      }
      for (const target of rows) {
        const existingRecords = byProjectNo.get(target.projectNo) || []
        if (overflow && existingRecords.length === 0) {
          // Past the read bound this project's row may exist unseen: never create blind. The drain below (same
          // lock) reads THIS project's rows by its number and creates or patches exactly one.
          markOverviewProjectDirty(state, target.projectNo, { recount: true })
          continue
        }
        // S3 follow-up C: one project's failure does not stop the others; it is collected, the project stays
        // dirty, and the refresh answers REFRESH_INCOMPLETE instead of `fresh: true`.
        try {
          await writeProjectRow({
            api,
            recordsApi,
            writer,
            scoped,
            store: registry,
            tenant,
            projectId: scopedProjectId,
            overviewSheetId: sheet.sheetId,
            target,
            fields: fieldsByProjectNo.get(target.projectNo) || null,
            pendingDecisionCount: pending.byProjectNo.get(target.projectNo) || 0,
            existingRecords,
            recount: true,
            locale,
            now,
            summary,
          })
        } catch (error) {
          drain.recordFailure(target.projectNo, { recount: true }, error)
        }
      }
      return {
        sheetId: sheet.sheetId,
        activeViewId: sheet.activeViewId,
        archivedViewId: sheet.archivedViewId,
        truncated,
        overflow,
        ledgerReady: pending.ready === true,
        countsAt: refreshedAt instanceof Date ? refreshedAt.toISOString() : String(refreshedAt),
        ...summary,
      }
    },
  })
  if (run.busy) throw overviewBusyError()
  // S3 follow-up C: a project of this run (the full pass OR the drain of the events it absorbed) is still failed
  // → not fresh. Never swallowed into a success.
  const failedProjectCount = drainFailedCount(drain)
  if (failedProjectCount > 0) {
    throw overviewRefreshIncompleteError({ failedProjectCount, summary: run.value, cause: drain.firstError })
  }
  return run.value
}

/**
 * THE PER-EVENT UPDATE (fix round 1, R5; ADR §5 「插件在这些时刻对单个项目行做 upsert」; fix round 2 F3 / F4).
 * ONE project's overview row after a create, archive, restore, project-fields change, dry-run / apply outcome or
 * confirmation. A no-op (`outcome: 'overview_absent'`) when there is no overview. The project is marked DIRTY;
 * if this tenant's overview writer is already running in this process the call returns `deferred` at once (that
 * writer re-projects it before it stops, no connection taken here); otherwise this call becomes the writer:
 * try-lock (another process holds it → `busy`, the project stays dirty for this process's next writer), drain
 * every dirty project, release, re-check. `recount` re-measures the project sheet (the pull outcomes change the
 * rows; the others do not). BEST-EFFORT BY CONTRACT: the caller catches and logs; this never decides an event's
 * outcome. The first failure of the drain is rethrown for that log.
 */
async function updateProjectOverviewRow({ provisioning, recordsApi, store, tenantId, projectId, projectNo, recount = false, locale, now = () => new Date() } = {}) {
  const api = requireProvisioning(provisioning)
  const tenant = requiredString(tenantId, 'tenantId')
  const scopedProjectId = requiredString(projectId, 'projectId')
  const no = requiredString(projectNo, 'projectNo')
  const registry = requireOverviewStore(store)
  const sheet = await findProjectOverviewSheet({ provisioning: api, projectId: scopedProjectId })
  if (!sheet) return { outcome: 'overview_absent' }
  const writer = overviewWriteRecordsApi(recordsApi, { projectId: scopedProjectId, sheetId: sheet.sheetId })
  const state = overviewWriterState(registry, tenant)
  markOverviewProjectDirty(state, no, { recount })
  if (state.running) return { outcome: 'deferred', sheetId: sheet.sheetId }
  const drain = createOverviewProjectDrain({ api, recordsApi, writer, registry, tenant, projectId: scopedProjectId, sheet, locale, now })
  // S3 follow-up C: a project whose write failed is put back into the dirty set when the writer stops (it was taken
  // out by the drain) — the next overview writer of this tenant here retries it instead of it being dropped.
  const run = await runOverviewWriter({ registry, tenant, state, firstPass: null, drainOne: drain.drainOne, failed: drain.failed })
  if (run.busy) return { outcome: 'busy', sheetId: sheet.sheetId }
  if (drainFailedCount(drain) > 0) throw drain.firstError
  return { outcome: drain.outcome || 'updated', sheetId: sheet.sheetId, ...drain.summary }
}

module.exports = {
  STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID,
  STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND,
  STOCK_PREPARATION_PROJECT_OVERVIEW_FIELD_IDS,
  MAX_PROJECT_OVERVIEW_ROWS,
  PROJECT_OVERVIEW_REFRESH_COOLDOWN_MS,
  STOCK_PREPARATION_PROJECT_OVERVIEW_REFRESH_INCOMPLETE_CODE: REFRESH_INCOMPLETE_CODE,
  StockPreparationProjectOverviewError,
  projectOverviewPosture,
  buildProjectOverviewDeepLink,
  buildProjectOverviewDescriptor,
  buildProjectOverviewViewDescriptor,
  projectOverviewViewHandles,
  findProjectOverviewSheet,
  ensureProjectOverviewSheet,
  grantProjectOverviewRoles,
  countProjectSheetRows,
  buildProjectOverviewRow,
  refreshProjectOverview,
  updateProjectOverviewRow,
  __internals: {
    assertOverviewStamped,
    assertHostStampsSystemKind,
    mapHostOverviewError,
    countsDifferFromRegistry,
    projectTodoViewId,
    sameProjection,
    PROJECTION_COMPARED_FIELD_IDS,
    PROJECT_SHEET_COUNT_FIELD_IDS,
    STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
    HOST_UNSUPPORTED_CODE,
    NOT_STAMPED_CODE,
    ABSENT_CODE,
    // Fix round 2 (F3 / F4).
    BUSY_CODE,
    requireOverviewWritePort,
    overviewWriteRecordsApi,
    overviewWriterState,
    // S3 follow-ups (C / D).
    REFRESH_INCOMPLETE_CODE,
    OVERVIEW_READ_PAGE_LIMIT,
    OVERVIEW_READ_MAX_PAGES,
  },
}
