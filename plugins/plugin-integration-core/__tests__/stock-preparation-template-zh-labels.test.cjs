'use strict'

/**
 * Chinese display names in the stock-preparation table templates.
 *
 * WHY THIS SUITE EXISTS. On the first customer-facing deployment every managed sheet was
 * created with the English template names (`Project No`, `Total Quantity`, `Stock
 * Preparation Status`, ...). The operator could not find the tables and, once found, could
 * not read them: 66 field headers and 4 sheet names were renamed BY HAND, directly against
 * that deployment's database. Nothing in the product prevented that from repeating at the
 * next customer, because the names live only in these templates.
 *
 * The four claims this suite holds, in the order a reviewer should read them:
 *
 *   1. COMPLETENESS + FROZEN IDS -- every field of both templates carries a Chinese name,
 *      the exact agreed one, and the SET OF IDS is pinned so a translation edit can never
 *      silently add or drop a column while looking like a wording change.
 *   2. LANGUAGE SELECTION, BOTH LEGS -- unset/`en` creates the English names, `zh-CN`
 *      creates the Chinese ones, and the two legs differ ONLY in the human display name.
 *   3. UNSET IS BYTE-IDENTICAL -- with no language setting, the produced descriptors and
 *      sheet structures hash to the digests captured from the pre-change base commit.
 *      Not a field count: the whole built object.
 *   4. NEVER RENAME AN EXISTING FIELD -- creation-time only. A deployment that already
 *      renamed its headers by hand (there is one) must not have them overwritten, in
 *      either language leg.
 */

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')

const {
  TEMPLATE_LABEL_LOCALE_ENV,
  TEMPLATE_LABEL_LOCALES,
  DEFAULT_TEMPLATE_LABEL_LOCALE,
  normalizeTemplateLabelLocale,
  resolveTemplateLabelLocale,
  pickTemplateLabel,
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE,
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
  buildSheetStructureFromTemplate,
  buildSheetStructureFromMvpTableTemplate,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-templates.cjs'))

const {
  StockPreparationTargetProvisioningError,
  buildStockPreparationTargetDescriptor,
  sandboxStockPreparationTemplate,
  ensureStockPreparationCanonicalTarget,
  repairStockPreparationCanonicalTarget,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-target-provisioning.cjs'))

const {
  buildTargetDescriptor: buildLedgerDescriptor,
  ensureConfirmationDecisionTarget,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-confirmation-decisions.cjs'))

// ---------------------------------------------------------------------------
// The agreed vocabulary. These strings were settled against the CUSTOMER'S OWN words on
// the live deployment, so they are pinned here literally rather than derived from the
// template: a future edit that "improves" one has to come through this file and say so.
//
// `componentCode` is 图号 on purpose and is NOT a translation of "Component Code": the
// customer's PLM calls the column `IdentityNo` 图号 and the legacy 备料 system used the
// same word. The table speaks the customer's vocabulary, not ours.
// ---------------------------------------------------------------------------
const MAIN_LABELS_ZH = Object.freeze({
  projectNo: '项目号',
  idempotencyKey: '唯一键',
  componentSourceId: '部件源ID',
  parentSourceId: '父件源ID',
  path: 'BOM路径',
  depth: 'BOM层级',
  componentCode: '图号',
  componentName: '名称',
  material: '材料',
  sourceVersion: '源版本',
  rawQuantity: '单层用量',
  totalQuantity: '总用量',
  active: '有效',
  lastPlmRefreshRunId: '最近刷新RunID',
  lastPlmRefreshAt: '最近刷新时间',
  lastPlmRefreshDecision: '最近刷新决定',
  lastPlmConflictSummary: '冲突摘要',
  materialType: '材料类型',
  blankType: '毛胚类型',
  stockPreparationStatus: '备料状态',
  demandDate: '需求日期',
  leadTimeDays: '提前周期(天)',
  notes: '备注',
  procurementReply: '采购回复',
  warehouseConfirmation: '仓库确认',
})

const LEDGER_LABELS_ZH = Object.freeze({
  decisionId: '裁决ID',
  stableDecisionKey: '稳定裁决键',
  projectNo: '项目号',
  rowIdentity: '行身份',
  conflictType: '冲突类型',
  inputFingerprint: '输入指纹',
  sourceRevision: '源修订',
  status: '状态',
  openedAt: '开启时间',
  resolutionAction: '处理动作',
  resolvedValue: '录入值',
  resolvedAuxValue: '录入辅助值',
  notes: '备注',
  confirmedBy: '确认人',
  confirmedAt: '确认时间',
  supersededAt: '作废时间',
})

const MAIN_SHEET_LABEL_ZH = '备料主表'
const LEDGER_SHEET_LABEL_ZH = '备料确认账本'
const SANDBOX_SHEET_LABEL_ZH = '备料主表(沙箱)'

/**
 * Digests of the BUILT objects, captured by running this exact computation against the
 * pre-change base commit (d4d7972897118fc1257d25f33174715339c2fa40). They are the
 * "unset language changes nothing" proof: not a field count, the whole structure --
 * every id, name, type, order, property and the sheet label -- serialised and hashed.
 */
const BASE_BUILT_DIGESTS = Object.freeze({
  mainStructure: '9c53cd88d2958afcabab6d5019f4c8ea2c9c4d9723c1b808d919015da9c45097',
  ledgerStructure: 'afaf79ff5ebefaa7d64d3d75e3e0c46b53f1eb0e11d8d70ae539106f1317c4e2',
  mvpStructures: '124852655168c65d6a1a34f03a1f85189c731d7b137b7d94f8a17133eb3c2e15',
  canonicalDescriptor: 'ce33abaf7b3c4352e62893770fe8654ef0075c11fc4c29779f623983d8237430',
  sandboxDescriptor: '93b98ea7e5c8dc9c09d9c4ab3a26efe23f28cbfc7e100d1faa89ec83d72a3d23',
})

const SANDBOX_OBJECT_ID = 'plm_stock_preparation_sandbox_demo'

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

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

/**
 * Run `fn` with the deployment language setting forced to `value` (`null` = genuinely
 * unset). The env is restored afterwards so the suite never depends on -- or leaks into --
 * the ambient environment it happens to run in.
 */
function withLocaleEnv(value, fn) {
  const restore = setLocaleEnv(value)
  try {
    return fn()
  } finally {
    restore()
  }
}

// The async twin. It must AWAIT before restoring: the provisioning entry points read the
// setting after their first await, so a synchronous `finally` would restore the env before
// the code under test ever looked at it -- and both legs would silently test English.
async function withLocaleEnvAsync(value, fn) {
  const restore = setLocaleEnv(value)
  try {
    return await fn()
  } finally {
    restore()
  }
}

// ---------------------------------------------------------------------------
// 1. COMPLETENESS + FROZEN IDS
// ---------------------------------------------------------------------------
function assertCompletenessAndFrozenIds() {
  const MAIN_IDS = Object.keys(MAIN_LABELS_ZH)
  const LEDGER_IDS = Object.keys(LEDGER_LABELS_ZH)

  // The id set is PINNED, in order. A translation edit that adds or drops a column while
  // looking like a wording change fails here rather than reaching a customer's database.
  assert.deepEqual(
    STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((f) => f.id),
    MAIN_IDS,
    'main table field ids are frozen (25), in order',
  )
  assert.equal(MAIN_IDS.length, 25, 'main table has exactly 25 fields')
  assert.deepEqual(
    STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE.fields.map((f) => f.id),
    LEDGER_IDS,
    'confirmation-decision ledger field ids are frozen (16), in order',
  )
  assert.equal(LEDGER_IDS.length, 16, 'ledger has exactly 16 fields')

  // Every field of both templates carries a Chinese name, and it is the agreed one.
  for (const [template, expected, name] of [
    [STOCK_PREPARATION_MAIN_TABLE_TEMPLATE, MAIN_LABELS_ZH, 'main'],
    [STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE, LEDGER_LABELS_ZH, 'ledger'],
  ]) {
    const missing = template.fields.filter((f) => typeof f.labelZh !== 'string' || f.labelZh.length === 0)
    assert.deepEqual(missing.map((f) => f.id), [], `${name}: every field has a Chinese label`)
    for (const field of template.fields) {
      assert.equal(field.labelZh, expected[field.id], `${name}.${field.id} Chinese label is the agreed one`)
      // Additive, never a replacement: the English name every existing reader uses survives.
      assert.equal(typeof field.label, 'string', `${name}.${field.id} keeps its English label`)
      assert.ok(field.label.length > 0, `${name}.${field.id} English label is non-empty`)
      assert.notEqual(field.label, field.labelZh, `${name}.${field.id} has two distinct names`)
    }
  }

  // 图号, not a translation of "Component Code" -- called out because it is the one entry a
  // future reader is most likely to "fix" back into a literal translation.
  assert.equal(
    STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.find((f) => f.id === 'componentCode').labelZh,
    '图号',
    'componentCode uses the customer PLM/legacy-备料 word 图号',
  )

  // Sheet-level display names.
  assert.equal(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.labelZh, MAIN_SHEET_LABEL_ZH)
  assert.equal(STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE.labelZh, LEDGER_SHEET_LABEL_ZH)

  // The nine frozen MVP tables are deliberately OUT of scope of this change; asserted so
  // that "every template got Chinese names" can never be believed by accident.
  for (const template of STOCK_PREPARATION_MVP_TABLE_TEMPLATES) {
    assert.equal(template.labelZh, undefined, `${template.objectId} is out of scope, unchanged`)
  }
}

// ---------------------------------------------------------------------------
// 2. LANGUAGE SELECTION -- BOTH LEGS
// ---------------------------------------------------------------------------
function assertLocaleNormalization() {
  assert.deepEqual([...TEMPLATE_LABEL_LOCALES], ['en', 'zh-CN'])
  assert.equal(DEFAULT_TEMPLATE_LABEL_LOCALE, 'en', 'the default is English, so unset changes nothing')

  // The spellings a human actually types into an env file all land on zh-CN.
  for (const spelling of ['zh-CN', 'zh-cn', 'zh_CN', ' ZH-CN ', 'zh', 'zh-Hans', 'zh-hans-cn']) {
    assert.equal(normalizeTemplateLabelLocale(spelling), 'zh-CN', `${JSON.stringify(spelling)} -> zh-CN`)
  }
  // Everything else -- unset, blank, a typo, another language -- falls back to English.
  // A mis-spelled DISPLAY LANGUAGE must never be able to block provisioning.
  for (const other of [undefined, null, '', '  ', 'en', 'en-US', 'zhh', 'chinese', 'fr', 42, {}]) {
    assert.equal(normalizeTemplateLabelLocale(other), 'en', `${JSON.stringify(other)} -> en`)
  }

  assert.equal(resolveTemplateLabelLocale({}), 'en', 'absent env -> en')
  assert.equal(resolveTemplateLabelLocale({ [TEMPLATE_LABEL_LOCALE_ENV]: 'zh-CN' }), 'zh-CN')
  assert.equal(resolveTemplateLabelLocale({ [TEMPLATE_LABEL_LOCALE_ENV]: 'nonsense' }), 'en')

  // pickTemplateLabel falls back to `label` whenever there is no Chinese name to use --
  // which is what keeps the nine MVP templates unaffected in the zh leg.
  assert.equal(pickTemplateLabel({ label: 'A', labelZh: '甲' }, 'zh-CN'), '甲')
  assert.equal(pickTemplateLabel({ label: 'A', labelZh: '甲' }, 'en'), 'A')
  assert.equal(pickTemplateLabel({ label: 'A' }, 'zh-CN'), 'A')
  assert.equal(pickTemplateLabel({ label: 'A', labelZh: '' }, 'zh-CN'), 'A')
}

function assertEnglishLeg() {
  // ENGLISH LEG. Unset is the state every deployment that exists today is in.
  withLocaleEnv(null, () => {
    assert.equal(resolveTemplateLabelLocale(), 'en', 'unset resolves to English')

    const descriptor = buildStockPreparationTargetDescriptor()
    assert.equal(descriptor.name, 'PLM Stock Preparation Main')
    const byId = new Map(descriptor.fields.map((f) => [f.id, f.name]))
    assert.equal(byId.get('projectNo'), 'Project No')
    assert.equal(byId.get('componentCode'), 'Component Code')
    assert.equal(byId.get('stockPreparationStatus'), 'Stock Preparation Status')
    for (const field of descriptor.fields) {
      assert.notEqual(field.name, MAIN_LABELS_ZH[field.id], `${field.id} is NOT created in Chinese when unset`)
    }

    // The confirmation-decision LEDGER's own descriptor builder, the one its provisioning
    // hands to ensureObject.
    const ledger = buildLedgerDescriptor()
    assert.equal(ledger.name, 'Stock Preparation Confirmation Decision')
    assert.equal(ledger.fields.find((f) => f.id === 'decisionId').name, 'Decision ID')
    for (const field of ledger.fields) {
      assert.notEqual(field.name, LEDGER_LABELS_ZH[field.id], `ledger.${field.id} is NOT created in Chinese when unset`)
    }

    // The SANDBOX keeps its English name too.
    assert.equal(
      buildStockPreparationTargetDescriptor({
        template: sandboxStockPreparationTemplate({ objectId: SANDBOX_OBJECT_ID }),
      }).name,
      'PLM Stock Preparation Sandbox',
    )
  })

  // An explicit `en` is the same leg as unset.
  withLocaleEnv('en', () => {
    assert.equal(buildStockPreparationTargetDescriptor().name, 'PLM Stock Preparation Main')
    assert.equal(buildLedgerDescriptor().name, 'Stock Preparation Confirmation Decision')
  })
}

function assertChineseLeg() {
  withLocaleEnv('zh-CN', () => {
    assert.equal(resolveTemplateLabelLocale(), 'zh-CN')

    // MAIN TABLE -- the sheet and all 25 columns are created readable.
    const descriptor = buildStockPreparationTargetDescriptor()
    assert.equal(descriptor.name, MAIN_SHEET_LABEL_ZH, 'main sheet is created as 备料主表')
    for (const field of descriptor.fields) {
      assert.equal(field.name, MAIN_LABELS_ZH[field.id], `${field.id} is created as its Chinese name`)
    }

    // LEDGER -- sheet and all 16 columns, both through the deployment setting alone...
    const ledger = buildLedgerDescriptor()
    assert.equal(ledger.name, LEDGER_SHEET_LABEL_ZH)
    for (const field of ledger.fields) {
      assert.equal(field.name, LEDGER_LABELS_ZH[field.id], `ledger.${field.id} is created as its Chinese name`)
    }
    // ...and through an explicit override.
    assert.equal(buildLedgerDescriptor({ locale: 'zh-CN' }).name, LEDGER_SHEET_LABEL_ZH)

    // SANDBOX -- keeps its sandbox marker in Chinese too. It must never be mistakable for
    // the production canonical table by an operator reading the sheet list.
    const sandbox = buildStockPreparationTargetDescriptor({
      template: sandboxStockPreparationTemplate({ objectId: SANDBOX_OBJECT_ID }),
    })
    assert.equal(sandbox.name, SANDBOX_SHEET_LABEL_ZH)
    assert.notEqual(sandbox.name, MAIN_SHEET_LABEL_ZH, 'the sandbox table cannot be read as the canonical one')
    assert.ok(sandbox.name.includes('沙箱'), 'the sandbox marker is part of the Chinese name')

    // The nine MVP tables have no Chinese names, so this leg leaves them in English.
    assert.equal(
      buildSheetStructureFromMvpTableTemplate(STOCK_PREPARATION_MVP_TABLE_TEMPLATES[0]).label,
      STOCK_PREPARATION_MVP_TABLE_TEMPLATES[0].label,
    )
  })
}

function assertLegsDifferOnlyInNames() {
  const en = withLocaleEnv(null, () => buildStockPreparationTargetDescriptor())
  const zh = withLocaleEnv('zh-CN', () => buildStockPreparationTargetDescriptor())

  assert.equal(zh.id, en.id, 'objectId does not depend on the display language')
  assert.equal(zh.description, en.description)
  assert.deepEqual(zh.fields.map((f) => f.id), en.fields.map((f) => f.id), 'ids are identical')
  assert.deepEqual(zh.fields.map((f) => f.type), en.fields.map((f) => f.type), 'types are identical')
  assert.deepEqual(zh.fields.map((f) => f.order), en.fields.map((f) => f.order), 'order is identical')
  assert.deepEqual(
    zh.fields.map((f) => f.property),
    en.fields.map((f) => f.property),
    'ownership/required/key/optionSource property is identical -- the language is display only',
  )
  // Strip the display names and the two descriptors are the same object.
  const strip = (d) => ({ ...d, name: null, fields: d.fields.map((f) => ({ ...f, name: null })) })
  assert.deepEqual(strip(zh), strip(en), 'the two legs differ in nothing but the human display names')
}

// ---------------------------------------------------------------------------
// 3. UNSET IS BYTE-IDENTICAL TO THE PRE-CHANGE BASE
// ---------------------------------------------------------------------------
function assertUnsetIsByteIdentical() {
  withLocaleEnv(null, () => {
    assert.equal(
      digest(buildSheetStructureFromTemplate(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)),
      BASE_BUILT_DIGESTS.mainStructure,
      'main sheet structure is byte-identical to base when the language is unset',
    )
    assert.equal(
      digest(buildSheetStructureFromMvpTableTemplate(STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE)),
      BASE_BUILT_DIGESTS.ledgerStructure,
      'ledger sheet structure is byte-identical to base when the language is unset',
    )
    assert.equal(
      digest(STOCK_PREPARATION_MVP_TABLE_TEMPLATES.map((t) => buildSheetStructureFromMvpTableTemplate(t))),
      BASE_BUILT_DIGESTS.mvpStructures,
      'the nine MVP sheet structures are byte-identical to base',
    )
    assert.equal(
      digest(buildStockPreparationTargetDescriptor()),
      BASE_BUILT_DIGESTS.canonicalDescriptor,
      'the canonical provisioning descriptor is byte-identical to base',
    )
    assert.equal(
      digest(buildStockPreparationTargetDescriptor({
        template: sandboxStockPreparationTemplate({ objectId: SANDBOX_OBJECT_ID }),
      })),
      BASE_BUILT_DIGESTS.sandboxDescriptor,
      'the sandbox provisioning descriptor is byte-identical to base',
    )
  })

  // Negative control on the digests themselves: they must be capable of failing. If the
  // zh leg hashed the same, every assertion above would be vacuous.
  withLocaleEnv('zh-CN', () => {
    assert.notEqual(
      digest(buildStockPreparationTargetDescriptor()),
      BASE_BUILT_DIGESTS.canonicalDescriptor,
      'the zh leg must NOT hash to the base digest, or the pin proves nothing',
    )
  })
}

// ---------------------------------------------------------------------------
// 4. NEVER RENAME AN EXISTING FIELD
// ---------------------------------------------------------------------------

// The deployment that already had its headers renamed BY HAND. `HAND_RENAMED_HEADERS` is
// what an operator typed straight into that database; the fakes below return it unchanged
// on every read, so any write that touched a pre-existing column shows up as a mutation.
const HAND_RENAMED_HEADERS = Object.freeze({
  projectNo: '项目号(手工改名)',
  componentCode: '零件图号',
  totalQuantity: '总数量',
  stockPreparationStatus: '备料进度',
})

function existingHeaderName(fieldId) {
  return HAND_RENAMED_HEADERS[fieldId] || `hand-renamed ${fieldId}`
}

function createEnsureContext({ sheetExists, missingFields = [] }) {
  const missing = new Set(missingFields)
  const calls = { ensureObject: [], findObjectSheet: 0 }
  const provisioning = {
    async findObjectSheet() {
      calls.findObjectSheet += 1
      return sheetExists ? { id: 'sheet_hand_renamed', baseId: 'base_x' } : null
    },
    async resolveFieldIds({ fieldIds }) {
      const out = {}
      for (const id of fieldIds || []) if (!missing.has(id)) out[id] = `fld_${id}`
      return out
    },
    async ensureObject(input) {
      calls.ensureObject.push(input)
      missing.clear()
      return { sheet: { id: 'sheet_created' } }
    },
  }
  return { context: { api: { multitable: { provisioning } } }, calls }
}

function createRepairContext({ missingFields = [], mutateOnWrite = false } = {}) {
  const missing = new Set(missingFields)
  const calls = { ensureMissingObjectFields: [], contentReads: [] }
  let mutated = false
  const tx = {
    async findObjectSheet() {
      return { id: 'sheet_hand_renamed' }
    },
    async resolveExistingObjectFieldIds({ fieldIds }) {
      const out = {}
      for (const id of fieldIds || []) if (!missing.has(id)) out[id] = `fld_${id}`
      return out
    },
    async readObjectFieldsContent({ fieldIds }) {
      calls.contentReads.push((fieldIds || []).slice())
      const out = {}
      for (const id of fieldIds || []) {
        out[id] = {
          name: mutated ? `OVERWRITTEN ${id}` : existingHeaderName(id),
          type: 'string',
          order: 0,
          property: {},
        }
      }
      return out
    },
    async ensureMissingObjectFields({ fields }) {
      calls.ensureMissingObjectFields.push(fields.map((f) => ({ id: f.id, name: f.name })))
      for (const f of fields) missing.delete(f.id)
      // POSITIVE CONTROL: a host that renamed pre-existing columns on the additive write.
      if (mutateOnWrite) mutated = true
      return { addedFieldIds: fields.map((f) => f.id), skippedExistingFieldIds: [] }
    },
  }
  const provisioning = {
    async runObjectFieldsRepairTransaction(fn) {
      return fn(tx)
    },
  }
  return { context: { api: { multitable: { provisioning } } }, calls }
}

async function assertNeverRenamesExistingFields() {
  // (a) ENSURE, on a deployment whose target already exists and is complete: it must be
  //     reported ready WITHOUT ever handing a descriptor to ensureObject. This is the
  //     hand-renamed deployment's actual protection -- a descriptor is where a new name
  //     would come from, and one is never built for an object that already exists.
  for (const locale of [null, 'zh-CN']) {
    const existing = createEnsureContext({ sheetExists: true })
    const result = await withLocaleEnvAsync(locale, () => ensureStockPreparationCanonicalTarget({
      context: existing.context,
      projectId: 'proj_hand_renamed',
      permission: 'admin',
    }))
    assert.equal(result.ready, true)
    assert.equal(result.mode, 'canonical_existing')
    assert.deepEqual(
      existing.calls.ensureObject,
      [],
      `locale=${locale}: an existing complete target is never re-described, so no column can be renamed`,
    )
  }

  // The same for the confirmation-decision LEDGER's provisioning entry point.
  for (const locale of [null, 'zh-CN']) {
    const existingLedger = createEnsureContext({ sheetExists: true })
    const ledgerResult = await withLocaleEnvAsync(locale, () => ensureConfirmationDecisionTarget({
      context: existingLedger.context,
      projectId: 'proj_hand_renamed',
      permission: 'admin',
    }))
    assert.equal(ledgerResult.ready, true)
    assert.equal(ledgerResult.created, false)
    assert.deepEqual(
      existingLedger.calls.ensureObject,
      [],
      `locale=${locale}: an existing ledger is never re-described either`,
    )
  }

  // Positive control for (a): ensureObject IS reachable, on a target that does not exist.
  // Without this, "ensureObject was called zero times" could pass on a broken fake.
  const fresh = createEnsureContext({ sheetExists: false })
  const created = await withLocaleEnvAsync('zh-CN', () => ensureStockPreparationCanonicalTarget({
    context: fresh.context,
    projectId: 'proj_fresh',
    permission: 'admin',
  }))
  assert.equal(created.mode, 'canonical_create')
  assert.equal(fresh.calls.ensureObject.length, 1, 'a MISSING target is created')
  assert.equal(
    fresh.calls.ensureObject[0].descriptor.name,
    MAIN_SHEET_LABEL_ZH,
    'and a freshly created one is created readable',
  )
  assert.equal(
    fresh.calls.ensureObject[0].descriptor.fields.find((f) => f.id === 'componentCode').name,
    MAIN_LABELS_ZH.componentCode,
    'down to the individual column headers',
  )

  // (b) REPAIR, in the Chinese leg, against the hand-renamed deployment. Repair adds the
  //     missing columns only; every pre-existing column -- including the four an operator
  //     renamed by hand -- is left exactly as it was. The missing set is plm_system-only
  //     because repair refuses to add a human_preserved column at all (REPAIR_HUMAN_FIELD_
  //     FORBIDDEN) -- a separate, pre-existing guard this change does not touch.
  const repairCtx = createRepairContext({ missingFields: ['depth', 'sourceVersion'] })
  const repaired = await withLocaleEnvAsync('zh-CN', () => repairStockPreparationCanonicalTarget({
    context: repairCtx.context,
    projectId: 'proj_hand_renamed',
    permission: 'admin',
  }))
  assert.equal(repaired.ready, true)
  assert.equal(repaired.mode, 'canonical_repaired')
  assert.equal(repairCtx.calls.ensureMissingObjectFields.length, 1, 'exactly one additive write')

  const submitted = repairCtx.calls.ensureMissingObjectFields[0]
  assert.deepEqual(
    submitted.map((f) => f.id).sort(),
    ['depth', 'sourceVersion'],
    'ONLY the missing columns were submitted -- no pre-existing column was in the write at all',
  )
  for (const fieldId of Object.keys(HAND_RENAMED_HEADERS)) {
    assert.ok(
      !submitted.some((f) => f.id === fieldId),
      `${fieldId} was renamed by hand on this deployment and must not appear in the write`,
    )
  }
  // The columns it DID add are created readable -- they are new, not renamed.
  assert.deepEqual(
    submitted.map((f) => f.name).sort(),
    [MAIN_LABELS_ZH.depth, MAIN_LABELS_ZH.sourceVersion].sort(),
    'the newly ADDED columns are created with their Chinese names',
  )

  // (c) POSITIVE CONTROL for the mutation guard itself. A host that DID rename the
  //     pre-existing columns during the additive write must be caught and rolled back.
  //     Without this, (b) could be passing because nothing checks.
  const mutating = createRepairContext({ missingFields: ['depth'], mutateOnWrite: true })
  let mutationError = null
  try {
    await withLocaleEnvAsync('zh-CN', () => repairStockPreparationCanonicalTarget({
      context: mutating.context,
      projectId: 'proj_hand_renamed',
      permission: 'admin',
    }))
  } catch (error) {
    mutationError = error
  }
  assert.ok(
    mutationError instanceof StockPreparationTargetProvisioningError,
    'a repair that renamed a pre-existing column must fail closed',
  )
  assert.equal(mutationError.code, 'REPAIR_MUTATED_EXISTING_FIELD')
  assert.equal(mutationError.status, 409)
}

async function main() {
  assertCompletenessAndFrozenIds()
  assertLocaleNormalization()
  assertEnglishLeg()
  assertChineseLeg()
  assertLegsDifferOnlyInNames()
  assertUnsetIsByteIdentical()
  await assertNeverRenamesExistingFields()

  console.log('stock-preparation-template-zh-labels.test.cjs OK')
}

main().catch((error) => {
  console.error('stock-preparation-template-zh-labels.test.cjs FAILED')
  console.error(error)
  process.exit(1)
})
