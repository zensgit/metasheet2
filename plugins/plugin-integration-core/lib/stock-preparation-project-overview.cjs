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
// a row of the overview back into a project sheet, and the overview has no row events. Not a
// permission mechanism: the HOST makes the overview read-only for every person (system kind
// `stock_prep_overview`, stamped at provisioning; capability clamp in permission-service.ts), and
// this module REFUSES to use a sheet the host does not report as stamped — fail-closed, so an older
// host cannot leave an unclamped overview behind. The plugin's own records writes do not go through
// people's capabilities, which is how the projection can be written at all.
//
// WHEN IT IS WRITTEN. `POST …/project-overview/refresh` (OPERATE, ADR §5) rebuilds every row within
// bounds (at most the registry's 200 rows; each project's sheet read through at most
// PULL_TARGET_MAX_PAGES pages — past that the counts are a floor and `countsBounded` says so, ADR §5
// 「溢出时带「超过」」). The refresh ALSO stamps the registry's count columns (`recordCounts`) so the
// GET target, the list and the home cards carry the same numbers the overview shows. Nothing here
// runs on a timer; a write failure of the overview never fails a pull (the pull routes stamp
// `last_pull_*` through `recordPullOutcome` in a try/catch of their own).
//
// VALUES-FREE SURFACE. Refusals and the refresh summary carry ids, enums, counts and booleans. The
// three project-level texts travel ONLY into the overview cells and the project-fields response —
// never into an audit row, a refusal detail or a log line.

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
// Reading the overview back (to decide create vs patch) is bounded by the same number: two pages
// of the host's page size cover 200 rows with room to spare, and a third page means the sheet holds
// rows this plugin did not write.
const OVERVIEW_READ_PAGE_LIMIT = 500
const OVERVIEW_READ_MAX_PAGES = 2

// The main-template columns the per-project count reads (ADR §5): the project narrowing, the
// validity flag, and the two 「完成」 booleans whose NOT-true rows are the two 未完成 counts.
const PROJECT_SHEET_COUNT_FIELD_IDS = Object.freeze(['projectNo', 'active', 'procurementDone', 'warehouseDone'])

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
// row's sheet id and the host-derived view id — the refresh route hands it nothing from a request.
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
 * THE STAMP IS THE PRECONDITION. The host reports `systemKind` on the sheet it found or created;
 * anything but the overview kind — including a host too old to report one — refuses, because an
 * overview the host does not clamp is a second, writable copy of every project's numbers.
 */
function assertOverviewStamped(sheet, mode) {
  const kind = sheet && typeof sheet.systemKind === 'string' ? sheet.systemKind : null
  if (kind === STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND) return
  throw new StockPreparationProjectOverviewError(
    409,
    'STOCK_PREPARATION_PROJECT_OVERVIEW_NOT_STAMPED',
    mode === 'existing'
      ? 'the project overview sheet exists but the host does not report it as a stock-prep overview system sheet; it must be removed by an administrator before the overview can be refreshed'
      : 'the host created the project overview sheet without the stock-prep overview system kind; this host cannot make the overview read-only',
    { objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID, mode, reportedKind: kind === null ? 'none' : 'other' },
  )
}

/**
 * ENSURE-IF-ABSENT by the derived objectId: the overview is created ONCE per tenant staging project,
 * in the pair's base (one-way anchor, own-base.cjs), stamped `stock_prep_overview` by the host, with
 * its two views; a later call finds it and writes nothing. Refuses unless the host reports the stamp.
 */
async function ensureProjectOverviewSheet({ provisioning, projectId, tenantId, locale, env } = {}) {
  const api = requireProvisioning(provisioning)
  const scopedProjectId = requiredString(projectId, 'projectId')
  const existing = await api.findObjectSheet({ projectId: scopedProjectId, objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID })
  if (existing) {
    assertOverviewStamped(existing, 'existing')
    return {
      sheetId: String(existing.id),
      created: false,
      ...projectOverviewViewHandles({ provisioning: api, projectId: scopedProjectId }),
      ownBaseSource: 'unchanged',
    }
  }
  const ownBase = await resolveStockPreparationOwnBase({
    provisioning: api,
    projectId: scopedProjectId,
    objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID,
    tenantId,
    explicitBaseId: null,
    locale,
    env,
  })
  const ensured = await api.ensureObject({
    projectId: scopedProjectId,
    baseId: ownBase.baseId,
    descriptor: buildProjectOverviewDescriptor({ locale }),
    // The host-owned stamp (Q5). The plugin-scope wrapper admits it ONLY from this plugin, for this
    // objectId and this kind; the host writes it on INSERT and reports it back.
    systemKind: STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND,
  })
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
      await api.ensureView({ projectId: scopedProjectId, sheetId, descriptor: buildProjectOverviewViewDescriptor({ provisioning: api, projectId: scopedProjectId, view, locale }) })
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

// ── THE PROJECTION ─────────────────────────────────────────────────────────────────────────────────

/**
 * ONE overview row, by logical field id, from: the registry row (`target`), its project-level texts
 * (`fields`), the bounded count just measured (`counts`, or null to keep the registry's own), the
 * ledger's pending count, and the derived deep link. Pure.
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
    countsAt: measured ? (countsAt instanceof Date ? countsAt.toISOString() : String(countsAt)) : (target.countsAt || null),
  }
}

function readLogicalCell(record, key) {
  const value = cellData(record)[key]
  if (isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, 'value')) return value.value
  return value
}

function sameProjection(existing, next) {
  for (const key of STOCK_PREPARATION_PROJECT_OVERVIEW_FIELD_IDS) {
    const before = readLogicalCell(existing, key)
    const after = next[key]
    if ((before === null || before === undefined ? null : before) !== (after === null || after === undefined ? null : after)) return false
  }
  return true
}

/**
 * THE REFRESH (ADR §5 「谁更新、什么时候更新」, the `POST …/project-overview/refresh` leg). Within bounds:
 *   1. the registry rows of the tenant (≤ 200; more is truncated and said);
 *   2. ensure the overview sheet (stamped, with its views) — ensure-if-absent;
 *   3. the ledger's pending counts, once for every project (degrades to zeros, `ledgerReady` says);
 *   4. per row: count the project sheet (bounded), stamp the registry's count columns, build the
 *      projection, create or patch the overview row by `projectNo` (unchanged rows cost no write).
 * Returns a values-free summary. The caller audits it (`project_overview_refresh`).
 */
async function refreshProjectOverview({ provisioning, recordsApi, store, tenantId, projectId, locale, env, now = () => new Date() } = {}) {
  const api = requireProvisioning(provisioning)
  const tenant = requiredString(tenantId, 'tenantId')
  const scopedProjectId = requiredString(projectId, 'projectId')
  if (!store || typeof store.list !== 'function' || typeof store.listProjectFields !== 'function' || typeof store.recordCounts !== 'function') {
    throw new StockPreparationProjectOverviewError(501, 'STOCK_PREPARATION_PROJECT_TARGET_STORE_UNAVAILABLE', 'the project-sheet registry cannot serve the overview refresh here')
  }
  const allRows = await store.list({ tenantId: tenant })
  const truncated = allRows.length > MAX_PROJECT_OVERVIEW_ROWS
  const rows = truncated ? allRows.slice(0, MAX_PROJECT_OVERVIEW_ROWS) : allRows
  const sheet = await ensureProjectOverviewSheet({ provisioning: api, projectId: scopedProjectId, tenantId: tenant, locale, env })
  const fieldsByProjectNo = await store.listProjectFields({ tenantId: tenant })
  let pending = { ready: false, byProjectNo: new Map() }
  try {
    pending = await pendingDecisionCountsByProjectNo(recordsApi, api, scopedProjectId, null)
  } catch (error) {
    pending = { ready: false, byProjectNo: new Map() }
  }
  const scoped = await createTargetScopedRecordsApi(recordsApi, { sheetId: sheet.sheetId, objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID }, { provisioning: api, projectId: scopedProjectId })
  const existingByProjectNo = new Map()
  for (let page = 0; page < OVERVIEW_READ_MAX_PAGES; page += 1) {
    const batch = await scoped.queryRecords({ filters: {}, limit: OVERVIEW_READ_PAGE_LIMIT, offset: page * OVERVIEW_READ_PAGE_LIMIT })
    if (!Array.isArray(batch)) {
      throw new StockPreparationProjectOverviewError(500, 'STOCK_PREPARATION_PROJECT_OVERVIEW_RECORDS_API_INVALID', 'queryRecords must return an array')
    }
    for (const record of batch) {
      const no = optionalString(readLogicalCell(record, 'projectNo'))
      if (no && !existingByProjectNo.has(no)) existingByProjectNo.set(no, record)
    }
    if (batch.length < OVERVIEW_READ_PAGE_LIMIT) break
  }
  const countsAt = now()
  const summary = { projectCount: rows.length, countedCount: 0, unreadableCount: 0, boundedCount: 0, rowsCreated: 0, rowsUpdated: 0, rowsUnchanged: 0 }
  for (const target of rows) {
    const counts = await countProjectSheetRows({ recordsApi, provisioning: api, projectId: scopedProjectId, row: target })
    if (counts.ready) {
      summary.countedCount += 1
      if (counts.bounded) summary.boundedCount += 1
      await store.recordCounts({
        tenantId: tenant,
        projectNo: target.projectNo,
        rowCount: counts.rowCount,
        activeRowCount: counts.activeRowCount,
        countsBounded: counts.bounded === true,
        procurementOpenCount: counts.procurementOpenCount,
        warehouseOpenCount: counts.warehouseOpenCount,
        countsAt,
      })
    } else {
      summary.unreadableCount += 1
    }
    const data = buildProjectOverviewRow({
      target,
      fields: fieldsByProjectNo.get(target.projectNo) || null,
      counts,
      pendingDecisionCount: pending.byProjectNo.get(target.projectNo) || 0,
      todoViewId: projectTodoViewId({ provisioning: api, projectId: scopedProjectId, objectId: target.objectId }),
      locale,
      countsAt,
    })
    const existing = existingByProjectNo.get(target.projectNo)
    if (!existing) {
      await scoped.createRecord({ data })
      summary.rowsCreated += 1
    } else if (sameProjection(existing, data)) {
      summary.rowsUnchanged += 1
    } else {
      await scoped.patchRecord({ recordId: existing.id, changes: data })
      summary.rowsUpdated += 1
    }
  }
  return {
    sheetId: sheet.sheetId,
    sheetCreated: sheet.created === true,
    activeViewId: sheet.activeViewId,
    archivedViewId: sheet.archivedViewId,
    truncated,
    ledgerReady: pending.ready === true,
    countsAt: countsAt.toISOString(),
    ...summary,
  }
}

module.exports = {
  STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID,
  STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND,
  STOCK_PREPARATION_PROJECT_OVERVIEW_FIELD_IDS,
  MAX_PROJECT_OVERVIEW_ROWS,
  StockPreparationProjectOverviewError,
  projectOverviewPosture,
  buildProjectOverviewDeepLink,
  buildProjectOverviewDescriptor,
  buildProjectOverviewViewDescriptor,
  projectOverviewViewHandles,
  ensureProjectOverviewSheet,
  countProjectSheetRows,
  buildProjectOverviewRow,
  refreshProjectOverview,
  __internals: {
    assertOverviewStamped,
    projectTodoViewId,
    sameProjection,
    PROJECT_SHEET_COUNT_FIELD_IDS,
    STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  },
}
