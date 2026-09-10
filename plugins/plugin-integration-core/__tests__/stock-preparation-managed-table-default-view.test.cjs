'use strict'

/**
 * Stock-preparation managed tables are USABLE the moment they are created.
 *
 * WHY THIS SUITE EXISTS. Provisioning created a sheet and its fields and stopped. It
 * created no VIEW -- and a multitable base renders each sheet's default view, so a sheet
 * with zero views cannot be opened AND blocks the whole base from opening. Measured by
 * direct query on the first real deployment:
 *
 *     pack-installed sandbox   views: 3   <- the customer pack creates role views
 *     confirmation ledger      views: 0   <- unopenable
 *     canonical main table     views: 0   <- unopenable
 *     second sandbox           views: 0   <- unopenable
 *
 * The base stayed unopenable until three grid views were inserted BY HAND. Nothing in the
 * product stopped that from repeating at the next customer.
 *
 * The five claims this suite holds:
 *
 *   1. CREATED WITH A VIEW -- a freshly created canonical target, sandbox target and
 *      confirmation ledger each get exactly one grid view.
 *   2. NEVER TOUCH EXISTING VIEWS -- a sheet that already has ANY view (the live
 *      pack-installed sandbox's three role views) is left completely alone: nothing is
 *      created, renamed, reordered or appended. Held against a fake standing in for it.
 *   3. IDEMPOTENT -- a re-ensure creates nothing.
 *   4. LANGUAGE, BOTH LEGS -- the view name comes from the templates through the same
 *      pickTemplateLabel/resolveTemplateLabelLocale mechanism as the sheet and column
 *      names. Unset locale keeps the English names.
 *   5. AN ALREADY-READY OBJECT IS PROVISIONED EXACTLY AS TODAY -- the ensure path that
 *      returns "already ready" makes NO write of any kind, so the live deployment's
 *      hand-renamed headers and hand-created views survive an ensure untouched.
 */

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  TEMPLATE_LABEL_LOCALE_ENV,
  STOCK_PREPARATION_DEFAULT_VIEW_LABELS,
  pickDefaultViewName,
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-templates.cjs'))

const {
  ensureStockPreparationCanonicalTarget,
  ensureStockPreparationSandboxTarget,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-target-provisioning.cjs'))

const {
  ensureConfirmationDecisionTarget,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-confirmation-decisions.cjs'))

const SANDBOX_OBJECT_ID = 'plm_stock_preparation_sandbox_demo'
const LEDGER_OBJECT_ID = 'plm_stock_preparation_confirmation_decision'

// The agreed view names, in both languages, pinned here so a wording edit is a visible
// change to this suite rather than a silent rename in a customer's database.
const EXPECTED_VIEW_NAMES = Object.freeze({
  records: Object.freeze({ en: 'All Records', zh: '全部记录' }),
  decisions: Object.freeze({ en: 'All Decisions', zh: '全部裁决' }),
})

function setLocaleEnv(value) {
  const had = Object.prototype.hasOwnProperty.call(process.env, TEMPLATE_LABEL_LOCALE_ENV)
  const previous = process.env[TEMPLATE_LABEL_LOCALE_ENV]
  if (value === null) delete process.env[TEMPLATE_LABEL_LOCALE_ENV]
  else process.env[TEMPLATE_LABEL_LOCALE_ENV] = value
  return () => {
    if (had) process.env[TEMPLATE_LABEL_LOCALE_ENV] = previous
    else delete process.env[TEMPLATE_LABEL_LOCALE_ENV]
  }
}

// The async twin of the zh-labels suite's helper: it must AWAIT before restoring, because
// the provisioning entry points read the setting after their first await.
async function withLocaleEnvAsync(value, fn) {
  const restore = setLocaleEnv(value)
  try {
    return await fn()
  } finally {
    restore()
  }
}

/**
 * A fake host whose `ensureObjectDefaultView` implements the SHIPPED primitive's contract:
 * the decision is taken on the sheet's view COUNT, and the write happens only from zero.
 * `views` is the per-sheet view list; the fake records every view-table mutation it makes,
 * so "existing views were left completely alone" is asserted against the list itself, not
 * against a call count.
 */
function createHostFake({ sheetExists = false, missingFields = [], views = {}, withDefaultViewApi = true } = {}) {
  const missing = new Set(missingFields)
  const viewsBySheet = {}
  for (const [sheetId, list] of Object.entries(views)) viewsBySheet[sheetId] = list.map((view) => ({ ...view }))
  const calls = { ensureObject: [], ensureObjectDefaultView: [], findObjectSheet: 0 }
  const sheetIdFor = (objectId) => `sheet_${objectId}`

  const provisioning = {
    async findObjectSheet({ objectId }) {
      calls.findObjectSheet += 1
      // Once ensureObject has run, the sheet exists -- the ledger re-inspects after its
      // create, exactly as the shipped code does against a real host.
      const created = calls.ensureObject.some((call) => call.descriptor.id === objectId)
      return sheetExists || created ? { id: sheetIdFor(objectId), baseId: 'base_legacy' } : null
    },
    async resolveFieldIds({ fieldIds }) {
      const out = {}
      for (const id of fieldIds || []) if (!missing.has(id)) out[id] = `fld_${id}`
      return out
    },
    async ensureObject(input) {
      calls.ensureObject.push(input)
      missing.clear()
      const sheetId = sheetIdFor(input.descriptor.id)
      if (!viewsBySheet[sheetId]) viewsBySheet[sheetId] = []
      return { sheet: { id: sheetId } }
    },
  }

  if (withDefaultViewApi) {
    provisioning.ensureObjectDefaultView = async ({ projectId, objectId, name, type }) => {
      calls.ensureObjectDefaultView.push({ projectId, objectId, name, type })
      const sheetId = sheetIdFor(objectId)
      const list = viewsBySheet[sheetId] || (viewsBySheet[sheetId] = [])
      // The shipped contract: any existing view at all and this writes NOTHING.
      if (list.length > 0) return { created: false, viewId: null, existingViewCount: list.length }
      const viewId = `view_${objectId}_default`
      list.push({ id: viewId, name, type: type || 'grid' })
      return { created: true, viewId, existingViewCount: 0 }
    }
  }

  return { context: { api: { multitable: { provisioning } } }, calls, viewsBySheet, sheetIdFor }
}

// ---------------------------------------------------------------------------
// 1 + 4. CREATED WITH A VIEW, in both language legs
// ---------------------------------------------------------------------------
async function assertCreatedTablesGetOneView() {
  for (const [locale, leg] of [[null, 'en'], ['zh-CN', 'zh']]) {
    // (a) canonical main table
    const canonical = createHostFake({ sheetExists: false })
    const canonicalResult = await withLocaleEnvAsync(locale, () => ensureStockPreparationCanonicalTarget({
      context: canonical.context,
      projectId: 'proj_fresh',
      permission: 'admin',
    }))
    assert.equal(canonicalResult.mode, 'canonical_create')
    assert.deepEqual(canonicalResult.defaultView, { created: true, skipped: null })
    assert.equal(canonical.calls.ensureObjectDefaultView.length, 1)
    assert.equal(canonical.calls.ensureObjectDefaultView[0].objectId, STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId)
    assert.equal(
      canonical.calls.ensureObjectDefaultView[0].name,
      EXPECTED_VIEW_NAMES.records[leg],
      `locale=${locale}: the canonical table's view is named in the same language as its columns`,
    )
    const canonicalViews = canonical.viewsBySheet[canonical.sheetIdFor(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId)]
    assert.equal(canonicalViews.length, 1, 'a created table has exactly one view -- it can be opened')
    assert.equal(canonicalViews[0].type, 'grid')

    // (b) sandbox target -- same view name family as the main table
    const sandbox = createHostFake({ sheetExists: false })
    const sandboxResult = await withLocaleEnvAsync(locale, () => ensureStockPreparationSandboxTarget({
      context: sandbox.context,
      projectId: 'proj_fresh',
      permission: 'admin',
      objectId: SANDBOX_OBJECT_ID,
    }))
    assert.deepEqual(sandboxResult.defaultView, { created: true, skipped: null })
    assert.equal(sandbox.calls.ensureObjectDefaultView.length, 1)
    assert.equal(sandbox.calls.ensureObjectDefaultView[0].objectId, SANDBOX_OBJECT_ID)
    assert.equal(sandbox.calls.ensureObjectDefaultView[0].name, EXPECTED_VIEW_NAMES.records[leg])

    // (c) confirmation-decision ledger -- its own name
    const ledger = createHostFake({ sheetExists: false })
    const ledgerResult = await withLocaleEnvAsync(locale, () => ensureConfirmationDecisionTarget({
      context: ledger.context,
      projectId: 'proj_fresh',
      permission: 'admin',
    }))
    assert.equal(ledgerResult.mode, 'confirmation_decision_created')
    assert.deepEqual(ledgerResult.defaultView, { created: true, skipped: null })
    assert.equal(ledger.calls.ensureObjectDefaultView.length, 1)
    assert.equal(ledger.calls.ensureObjectDefaultView[0].objectId, LEDGER_OBJECT_ID)
    assert.equal(
      ledger.calls.ensureObjectDefaultView[0].name,
      EXPECTED_VIEW_NAMES.decisions[leg],
      `locale=${locale}: the ledger's view carries the ledger's own name`,
    )
  }

  // The names come from the ONE locale mechanism, not from a second one invented here.
  assert.equal(withLocale(null, () => pickDefaultViewName('records')), EXPECTED_VIEW_NAMES.records.en)
  assert.equal(withLocale('zh-CN', () => pickDefaultViewName('records')), EXPECTED_VIEW_NAMES.records.zh)
  assert.equal(withLocale(null, () => pickDefaultViewName('decisions')), EXPECTED_VIEW_NAMES.decisions.en)
  assert.equal(withLocale('zh-CN', () => pickDefaultViewName('decisions')), EXPECTED_VIEW_NAMES.decisions.zh)
  // An explicit locale argument beats the env, exactly as the label builders do.
  assert.equal(withLocale('zh-CN', () => pickDefaultViewName('records', { locale: null })), EXPECTED_VIEW_NAMES.records.en)
  assert.equal(STOCK_PREPARATION_DEFAULT_VIEW_LABELS.records.labelZh, EXPECTED_VIEW_NAMES.records.zh)
  assert.equal(STOCK_PREPARATION_DEFAULT_VIEW_LABELS.decisions.labelZh, EXPECTED_VIEW_NAMES.decisions.zh)
  assert.throws(() => pickDefaultViewName('not-a-kind'), /unknown default view kind/)
}

function withLocale(value, fn) {
  const restore = setLocaleEnv(value)
  try {
    return fn()
  } finally {
    restore()
  }
}

// ---------------------------------------------------------------------------
// 2. NEVER TOUCH EXISTING VIEWS
// ---------------------------------------------------------------------------
async function assertExistingViewsAreNeverTouched() {
  // The live pack-installed sandbox: three role views the customer pack created. They must
  // not be touched, duplicated, renamed or reordered by provisioning.
  const packViews = [
    { id: 'view_pack_reader', name: '只读视图', type: 'grid' },
    { id: 'view_pack_operator', name: '操作员视图', type: 'grid' },
    { id: 'view_pack_admin', name: '管理员视图', type: 'grid' },
  ]
  const sheetId = `sheet_${SANDBOX_OBJECT_ID}`
  const before = JSON.stringify(packViews)

  // The sheet metadata is absent (this deployment's target was created by the pack, and the
  // ensure runs its create path), yet the sheet already carries the pack's three views.
  const host = createHostFake({ sheetExists: false, views: { [sheetId]: packViews } })
  const result = await ensureStockPreparationSandboxTarget({
    context: host.context,
    projectId: 'proj_pack_installed',
    permission: 'admin',
    objectId: SANDBOX_OBJECT_ID,
  })

  assert.equal(result.ready, true)
  assert.deepEqual(
    result.defaultView,
    { created: false, skipped: 'existing_views' },
    'a sheet that already has views gets NO fourth view',
  )
  assert.equal(
    JSON.stringify(host.viewsBySheet[sheetId]),
    before,
    'the pack-created role views are byte-identical: not appended to, renamed or reordered',
  )
}

// ---------------------------------------------------------------------------
// 3. IDEMPOTENT
// ---------------------------------------------------------------------------
async function assertReEnsureCreatesNothing() {
  const host = createHostFake({ sheetExists: false })
  const first = await ensureStockPreparationCanonicalTarget({
    context: host.context,
    projectId: 'proj_twice',
    permission: 'admin',
  })
  assert.deepEqual(first.defaultView, { created: true, skipped: null })

  // Second ensure against the SAME host. The target is now present and complete, so the
  // already-ready path takes it: no ensureObject, no view call, and still exactly one view.
  const second = await ensureStockPreparationCanonicalTarget({
    context: host.context,
    projectId: 'proj_twice',
    permission: 'admin',
  })
  assert.equal(second.mode, 'canonical_existing')
  assert.equal(second.defaultView, undefined)
  assert.equal(host.calls.ensureObject.length, 1, 'the second ensure describes nothing')
  assert.equal(host.calls.ensureObjectDefaultView.length, 1, 'the second ensure asks for no view work at all')
  const sheetId = host.sheetIdFor(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId)
  assert.equal(host.viewsBySheet[sheetId].length, 1, 'a re-ensure never produces a second view')

  // And a SECOND trip through the create path itself (the case a concurrent create or a
  // pack-created sheet produces: no sheet metadata yet, views already present) creates
  // nothing either -- the primitive decides on the view count, not on who called it.
  const racing = createHostFake({ sheetExists: false, views: { [sheetId]: [{ id: 'view_already', name: 'All Records', type: 'grid' }] } })
  const raced = await ensureStockPreparationCanonicalTarget({
    context: racing.context,
    projectId: 'proj_twice',
    permission: 'admin',
  })
  assert.deepEqual(raced.defaultView, { created: false, skipped: 'existing_views' })
  assert.equal(racing.viewsBySheet[sheetId].length, 1)
}

// ---------------------------------------------------------------------------
// 5. AN ALREADY-READY OBJECT IS PROVISIONED EXACTLY AS TODAY
// ---------------------------------------------------------------------------
async function assertAlreadyReadyObjectIsUntouched() {
  for (const locale of [null, 'zh-CN']) {
    // The live deployment: target exists, schema complete, headers renamed by hand, views
    // created by hand. The ensure must return ready WITHOUT writing anything at all --
    // no ensureObject (no column could be renamed) and no view write.
    const canonical = createHostFake({ sheetExists: true, views: { [`sheet_${STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId}`]: [{ id: 'view_by_hand', name: '手工建的视图', type: 'grid' }] } })
    const result = await withLocaleEnvAsync(locale, () => ensureStockPreparationCanonicalTarget({
      context: canonical.context,
      projectId: 'proj_hand_repaired',
      permission: 'admin',
    }))
    assert.equal(result.ready, true)
    assert.equal(result.mode, 'canonical_existing')
    assert.equal(result.defaultView, undefined, 'the already-ready path reports no view work, because it does none')
    assert.deepEqual(canonical.calls.ensureObject, [], 'an existing complete target is never re-described')
    assert.deepEqual(
      canonical.calls.ensureObjectDefaultView,
      [],
      `locale=${locale}: an already-ready object is provisioned EXACTLY as today -- the view primitive is never even called`,
    )
    assert.deepEqual(
      canonical.viewsBySheet[`sheet_${STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId}`],
      [{ id: 'view_by_hand', name: '手工建的视图', type: 'grid' }],
      'the hand-created view survives an ensure untouched',
    )

    // Same for the ledger's provisioning entry point.
    const ledger = createHostFake({ sheetExists: true, views: { [`sheet_${LEDGER_OBJECT_ID}`]: [{ id: 'view_by_hand', name: '手工建的视图', type: 'grid' }] } })
    const ledgerResult = await withLocaleEnvAsync(locale, () => ensureConfirmationDecisionTarget({
      context: ledger.context,
      projectId: 'proj_hand_repaired',
      permission: 'admin',
    }))
    assert.equal(ledgerResult.ready, true)
    assert.equal(ledgerResult.mode, 'confirmation_decision_existing')
    assert.equal(ledgerResult.defaultView, undefined)
    assert.deepEqual(ledger.calls.ensureObject, [])
    assert.deepEqual(ledger.calls.ensureObjectDefaultView, [])
  }
}

// ---------------------------------------------------------------------------
// A host WITHOUT the primitive still provisions, and the evidence stays values-free
// ---------------------------------------------------------------------------
async function assertOlderHostStillProvisions() {
  const host = createHostFake({ sheetExists: false, withDefaultViewApi: false })
  const result = await ensureStockPreparationCanonicalTarget({
    context: host.context,
    projectId: 'proj_old_host',
    permission: 'admin',
  })
  assert.equal(result.ready, true)
  assert.equal(result.mode, 'canonical_create')
  assert.deepEqual(
    result.defaultView,
    { created: false, skipped: 'api_unavailable' },
    'a plugin newer than its host still installs the tables it always installed, and says so',
  )

  // VALUES-FREE evidence: the reported view work carries booleans and a closed reason
  // vocabulary only -- never the view name, the view id or the sheet id.
  const reported = new Set()
  for (const fake of [
    createHostFake({ sheetExists: false, withDefaultViewApi: false }),
    createHostFake({ sheetExists: false }),
  ]) {
    const out = await ensureStockPreparationCanonicalTarget({
      context: fake.context,
      projectId: 'proj_vocab',
      permission: 'admin',
    })
    for (const key of Object.keys(out.defaultView)) reported.add(key)
    if (out.defaultView.skipped !== null) reported.add(`skipped:${out.defaultView.skipped}`)
  }
  assert.deepEqual(
    Array.from(reported).sort(),
    ['created', 'skipped', 'skipped:api_unavailable'].sort(),
    'the defaultView evidence is a closed, values-free shape',
  )
}

async function main() {
  await assertCreatedTablesGetOneView()
  await assertExistingViewsAreNeverTouched()
  await assertReEnsureCreatesNothing()
  await assertAlreadyReadyObjectIsUntouched()
  await assertOlderHostStillProvisions()

  console.log('stock-preparation-managed-table-default-view.test.cjs OK')
}

main().catch((error) => {
  console.error('stock-preparation-managed-table-default-view.test.cjs FAILED')
  console.error(error)
  process.exit(1)
})
