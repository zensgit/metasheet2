'use strict'

// S6-A source authority — the external-system record is projected to the closed set of
// members this module reads BEFORE anything is canonicalised.
//
// WHY THIS FILE EXISTS AT ALL, stated before anything it asserts.
//
// The defect it pins survived every existing test because EVERY existing fixture
// hand-built `createdAt`/`updatedAt` as ISO strings. Production does not: the record
// reaching normalizeExternalSystem() is built by lib/external-systems.cjs's
// rowToAdapterExternalSystem() from a `pg` row, and with no `setTypeParser` anywhere in
// this repository, `pg` returns native JS `Date` for TIMESTAMPTZ. canonical-json.cjs
// refuses a `Date` (EXOTIC_OBJECT), so canonicalising the whole record refused every
// production-shaped record before a single field-set or identity check could run.
//
// So this file never hand-builds the record under test. It builds a pg-SHAPED ROW and
// runs it through the REAL, PRODUCTION rowToAdapterExternalSystem(), which is what makes
// it able to catch this class at all. Three arms, all required:
//
//   * production-shaped, Date-typed timestamps  -> must RESOLVE
//   * positive control, string timestamps        -> must ALSO RESOLVE
//       (without it, "everything passes" would be indistinguishable from "the
//        projection works")
//   * negative control, projection REMOVED       -> the Date-bearing record must REFUSE
//     again with SEALED_EXPORT_BINDING_UNQUALIFIED, while the string-timestamp record
//     still resolves in the same mutant
//       (without it, the fix is not shown to be what fixed it)
//
// Plus a two-sided mechanical pin on the projection list itself, so a future drift REDs
// instead of degrading quietly — see the PROJECTION DRIFT PIN section.

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')

const canonicalCodec = require('../lib/sealed-export/canonical-json.cjs')
const {
  SealedExportError,
} = require('../lib/sealed-export/failure-vocabulary.cjs')
const {
  __internals: externalSystemsInternals,
} = require('../lib/external-systems.cjs')
const {
  analyzeModuleSource,
  memberReadReport,
  occurrencesOf,
} = require('./support/sealed-export-member-read-scan.cjs')

const SOURCE_AUTHORITY_PATH = require.resolve(
  '../lib/sealed-export/stock-preparation-sqlserver-source-authority.cjs',
)
const sourceAuthority = require(SOURCE_AUTHORITY_PATH)
const {
  CANONICAL_OBJECT_VERSION,
  CONNECTOR_KIND,
  EXTERNAL_SYSTEM_PROJECTION_FIELDS,
  SOURCE_CONFIG_KEY,
  deriveStockPreparationSqlServerSourceAnchors,
  resolveStockPreparationSqlServerSource,
} = sourceAuthority

const IDENTITY_KEY = crypto
  .createHash('sha256')
  .update('s6a-source-authority-adapter-projection-test-key')
  .digest()

const TENANT_ID = 'tenant-s6a-projection'
const SYSTEM_ID = 'system-s6a-projection'
const SECRET = 'private-password-projection'

// ── production-shaped record construction ───────────────────────────────────────────
// A pg ROW, not an adapter record. The adapter record is produced by the real
// rowToAdapterExternalSystem() — the same function stock-preparation-runtime-core.cjs's
// loadSource() reaches through externalSystemRegistry.getExternalSystemForAdapter().
function pgRow(timestamp) {
  return {
    id: SYSTEM_ID,
    tenant_id: TENANT_ID,
    workspace_id: null,
    project_id: null,
    name: 'S6A SQL Server (projection fixture)',
    kind: CONNECTOR_KIND,
    role: 'source',
    config: {
      [SOURCE_CONFIG_KEY]: {
        database: 'PDM',
        encrypt: true,
        instanceName: null,
        port: 1433,
        server: 'sqlserver.internal',
        trustServerCertificate: false,
      },
    },
    capabilities: {},
    status: 'active',
    last_tested_at: null,
    last_error: null,
    created_at: timestamp,
    updated_at: timestamp,
  }
}

const ADAPTER_CREDENTIALS = Object.freeze({
  [SOURCE_CONFIG_KEY]: Object.freeze({
    password: SECRET,
    user: 'readonly_user',
  }),
})

function adapterRecord(timestamp) {
  return externalSystemsInternals.rowToAdapterExternalSystem(
    pgRow(timestamp),
    // structuredClone-free deep copy: each arm gets its own mutable credentials object,
    // so a poison arm cannot contaminate a later arm.
    JSON.parse(JSON.stringify(ADAPTER_CREDENTIALS)),
  )
}

function bindingDraft(overrides = {}) {
  return {
    approvedConfigVersionId: 'config-s6a-projection-v1',
    bindingVersion: 'binding-s6a-projection-v1',
    canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
    externalSystemId: SYSTEM_ID,
    objectKey: 'stock-preparation-bom',
    relationId: 'sqlserver.relation.rowid_payload.v1',
    tableRef: 'dbo.stock_prep_sealed_rows',
    tenantId: TENANT_ID,
    workspaceId: null,
    ...overrides,
  }
}

function enrolledBinding(draft, anchors) {
  return {
    ...draft,
    bindingId: 'binding-row-s6a-projection',
    configContentKey: anchors.configContentKey,
    expiresAt: '2099-01-01T00:00:00.000Z',
    roleBindingFingerprint: anchors.roleBindingFingerprint,
    systemContentKey: anchors.systemContentKey,
    tenantDomainBinding: anchors.tenantDomainBinding,
  }
}

function refuses(action, reason = 'SEALED_EXPORT_BINDING_UNQUALIFIED') {
  let caught = null
  try {
    action()
  } catch (error) {
    caught = error
  }
  assert.ok(
    caught instanceof SealedExportError,
    'expected a SealedExportError, got: ' + String(caught),
  )
  assert.equal(caught.reason, reason)
  // A refusal must never carry the credential into its own serialized form.
  assert.equal(JSON.stringify(caught).includes(SECRET), false)
  return caught
}

function sortedArray(set) {
  return [...set].sort()
}

// ── the drift pins ───────────────────────────────────────────────────────────────────
//
// WHAT REPLACED WHAT, and why, because the previous shape of this section was itself the
// defect. It extracted a function body by COUNTING BRACES over the raw module text and then
// applied regexes to the extracted string. That counter is not comment-aware, so a comment
// carrying one unbalanced brace truncated the body at that point and EVERYTHING BELOW IT
// BECAME UNPINNED. Proven by execution rather than argued: inserting
//
//     // the closing } of the config block above
//     connectionConfig.appName = String(system['name'] ?? 'metasheet')
//
// into normalizeExternalSystem() left this suite GREEN while the read was LIVE
// (`record.name === 'REAL SYSTEM NAME'`, `connectionConfig.appName === 'metasheet'` — the
// projected record has no `name`, which is exactly the drift the pin exists to catch). The
// DOTTED form after the same truncation was green too, so the truncation also defeated the
// pre-existing dotted read-set assertion. A cleverer counter is not the fix: enumerating
// lexical edge cases does not converge, and this repository has already paid for that lesson
// twice. The extraction is now a REAL PARSE — see support/sealed-export-member-read-scan.cjs.
//
// Each pin carries a stable `pinId`. Every pin has a companion self-test in ESCAPES below
// that applies a mutation to the module source in memory and asserts THAT pin fires, matched
// by strict equality on the id rather than by substring on the message — pins whose messages
// share words otherwise cover for each other. A pin that is deleted, renamed or weakened
// makes its own self-test RED, because nothing throws.
function pinFail(pinId, message) {
  const error = new Error('PIN ' + pinId + ': ' + message)
  error.pinId = pinId
  throw error
}

function pinEqual(pinId, actual, expected, message) {
  if (actual !== expected) {
    pinFail(pinId, message + ' (actual ' + String(actual) + ', expected ' + String(expected) + ')')
  }
}

function pinDeepEqual(pinId, actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    pinFail(
      pinId,
      message + '\n  actual:   ' + JSON.stringify(actual)
      + '\n  expected: ' + JSON.stringify(expected),
    )
  }
}

// The exact use multiset of each pinned receiver. Derived from the module as it stands and
// asserted whole: a receiver that only ever appears as a member-access receiver (plus its own
// declaration and value passes to the screening predicate) has a read set that is COMPLETE
// by construction, because there is no other syntax through which a member could be reached.
const SYSTEM_USES = Object.freeze([
  'call-argument|normalizeExternalSystem|canonicalCodec.__internals.isStrictPlainObject@0',
  'property-access-receiver|normalizeExternalSystem|config',
  'property-access-receiver|normalizeExternalSystem|config',
  'property-access-receiver|normalizeExternalSystem|credentials',
  'property-access-receiver|normalizeExternalSystem|credentials',
  'property-access-receiver|normalizeExternalSystem|id',
  'property-access-receiver|normalizeExternalSystem|kind',
  'property-access-receiver|normalizeExternalSystem|role',
  'property-access-receiver|normalizeExternalSystem|status',
  'property-access-receiver|normalizeExternalSystem|tenantId',
  'property-access-receiver|normalizeExternalSystem|workspaceId',
  'variable-name|normalizeExternalSystem|',
])
const NORMALIZE_RAW_USES = Object.freeze([
  'call-argument|normalizeExternalSystem|projectExternalSystem@0',
  'parameter|normalizeExternalSystem|',
])
const PROJECTION_RAW_USES = Object.freeze([
  'call-argument|projectExternalSystem|Object.prototype.hasOwnProperty.call@0',
  'call-argument|projectExternalSystem|canonicalCodec.__internals.isStrictPlainObject@0',
  'element-access-receiver|projectExternalSystem|<dynamic>',
  'parameter|projectExternalSystem|',
])
const PROJECTION_PROJECTED_USES = Object.freeze([
  'element-access-receiver|projectExternalSystem|<dynamic>',
  'other|projectExternalSystem|ReturnStatement',
  'variable-name|projectExternalSystem|',
])
// THE THIRD FRAME. `externalSystem` is the argument as it arrives — BEFORE the projection and
// BEFORE isStrictPlainObject() has screened anything — so a member read here is the only one
// in this module that can fire an accessor on a record nothing has vetted. A ban on member
// ACCESS would not close it: `const { name } = externalSystem`, `{ ...externalSystem }` and
// `JSON.stringify(externalSystem)` all read the record without one. The multiset is pinned
// instead, and the two call forms pin the CALLEE — "passed to some function" would admit
// JSON.stringify.
const EXTERNAL_SYSTEM_USES = Object.freeze([
  'binding-element|deriveStockPreparationSqlServerSourceAnchors|',
  'binding-element|resolveStockPreparationSqlServerSource|',
  'call-argument|deriveStockPreparationSqlServerSourceAnchors|normalizeExternalSystem@0',
  'shorthand-argument|resolveStockPreparationSqlServerSource|'
    + 'deriveStockPreparationSqlServerSourceAnchors@0',
])

function runProjectionPins(moduleText, options = {}) {
  const report = analyzeModuleSource({
    name: 'stock-preparation-sqlserver-source-authority.cjs',
    text: moduleText,
    parseOverride: options.parseOverride,
  })

  // 4.0 — the scan could READ its input. Checked first and separately: a scan that reports
  // "nothing found" because it could not parse is worse than no scan, so the report presents
  // `functions === null` (not an empty object) when it failed, and every pin below would
  // crash rather than pass vacuously if this door were removed.
  if (report.failures.length > 0 || report.functions === null || report.occurrences === null) {
    pinFail('report-clean', 'the module source could not be read: '
      + JSON.stringify(report.failures))
  }

  const normalize = report.functions.normalizeExternalSystem
  const projection = report.functions.projectExternalSystem
  if (normalize === undefined) pinFail('report-clean', 'normalizeExternalSystem() not found')
  if (projection === undefined) pinFail('report-clean', 'projectExternalSystem() not found')

  // 4.1 — nothing read may be missing from the list, and nothing listed may be unread.
  // Derived from the module's own parse, never from a second hand-written list. A
  // string-literal computed key names a member exactly as a dotted access does, so
  // `system['projectId']` lands in this same set: bracket drift is drift, not a syntax
  // question, which is what makes this assertion complete rather than dotted-only.
  const systemReads = memberReadReport(normalize, 'system')
  pinDeepEqual(
    'system-read-set',
    systemReads.static,
    sortedArray(EXTERNAL_SYSTEM_PROJECTION_FIELDS),
    'members read off the projected external system have drifted from '
    + 'EXTERNAL_SYSTEM_PROJECTION_FIELDS',
  )

  // 4.2 — a computed key that names no member statically cannot be checked against the list
  // at all, so it is refused outright rather than passed over in silence.
  pinDeepEqual(
    'system-dynamic-read',
    systemReads.dynamic.map((access) => access.keyIdentifier),
    [],
    'normalizeExternalSystem() reads a member off `system` through a computed key that names '
    + 'no member statically — such a read cannot be held against '
    + 'EXTERNAL_SYSTEM_PROJECTION_FIELDS at all',
  )

  // 4.3 — and the read set above is complete only because `system` is reachable no other way.
  pinDeepEqual(
    'system-uses',
    occurrencesOf(report, 'system', 'normalizeExternalSystem'),
    SYSTEM_USES,
    '`system` is used inside normalizeExternalSystem() in a way the read-set pin above does '
    + 'not model — destructuring, a spread, a value pass or an unreadable receiver could all '
    + 'reach a member without appearing as a member access',
  )

  // 4.4 — the raw record is touched exactly once inside normalizeExternalSystem(), by the
  // projection itself, and this pins WHAT it is passed to rather than only how often it
  // appears.
  pinDeepEqual(
    'normalize-raw-uses',
    occurrencesOf(report, 'raw', 'normalizeExternalSystem'),
    NORMALIZE_RAW_USES,
    'the raw external-system record is used inside normalizeExternalSystem() by something '
    + 'other than the single projectExternalSystem(raw) call — that use would bypass the '
    + 'projection entirely',
  )

  // 4.5 — one frame DOWN. The projection function is the last place an unlisted member could
  // be smuggled in, and the read-set scan above never looks at its body. It must touch `raw`
  // and `projected` only through the loop idiom — never a named member, dotted or bracketed.
  pinDeepEqual(
    'projection-member-reads',
    {
      raw: memberReadReport(projection, 'raw').static,
      projected: memberReadReport(projection, 'projected').static,
    },
    { raw: [], projected: [] },
    'projectExternalSystem() reads or writes a NAMED member on the raw record or on the '
    + 'projection — that member would bypass EXTERNAL_SYSTEM_PROJECTION_FIELDS entirely',
  )

  // 4.6 — the one bracket idiom the projection is allowed is the loop variable, and the loop
  // is pinned to the exported list. Without the second half, `for (const field of
  // SOURCE_CONFIG_FIELDS)` would keep `raw[field]` looking legitimate while projecting a
  // different set.
  pinDeepEqual(
    'projection-loop-idiom',
    {
      keys: sortedArray(new Set([
        ...memberReadReport(projection, 'raw').dynamic,
        ...memberReadReport(projection, 'projected').dynamic,
      ].map((access) => access.keyIdentifier))),
      forOf: projection.forOf,
    },
    {
      keys: ['field'],
      forOf: [{ bindingName: 'field', iterableName: 'EXTERNAL_SYSTEM_PROJECTION_FIELDS' }],
    },
    'projectExternalSystem() reaches a member through a computed key that is not the '
    + 'EXTERNAL_SYSTEM_PROJECTION_FIELDS loop variable',
  )

  // 4.7 — same completeness argument as 4.3, for the projection frame.
  pinDeepEqual(
    'projection-uses',
    {
      raw: occurrencesOf(report, 'raw', 'projectExternalSystem'),
      projected: occurrencesOf(report, 'projected', 'projectExternalSystem'),
    },
    { raw: PROJECTION_RAW_USES, projected: PROJECTION_PROJECTED_USES },
    '`raw` or `projected` is used inside projectExternalSystem() in a way the member-read '
    + 'pins above do not model',
  )

  // 4.8 — THE THIRD FRAME, upstream of both the projection and isStrictPlainObject().
  pinDeepEqual(
    'external-system-uses',
    occurrencesOf(report, 'externalSystem'),
    EXTERNAL_SYSTEM_USES,
    'the un-projected externalSystem argument is used somewhere other than its two parameter '
    + 'declarations, the normalizeExternalSystem(externalSystem, …) call and the value pass '
    + 'into deriveStockPreparationSqlServerSourceAnchors — a read here happens BEFORE the '
    + 'projection and BEFORE the record has been screened, so it can fire an accessor on a '
    + 'hostile record',
  )

  return report
}

// Each entry is an escape that was PROVEN to leave this suite green before the parse-based
// pins existed, or a neuter of a pin that must not be allowed to pass. `pin` is the id that
// must fire — asserted by strict equality, so no pin can be covered for by another.
function anchoredReplace(source, anchor, replacement) {
  assert.equal(
    source.split(anchor).length - 1,
    1,
    'mutation anchor is not present exactly once — the self-test would mutate the wrong '
    + 'thing (or nothing): ' + anchor,
  )
  return source.split(anchor).join(replacement)
}

const CRED_LINE =
  '    || !canonicalCodec.__internals.isStrictPlainObject(system.credentials)\n'
const PORT_LINE = '  if (endpoint.port !== null) connectionConfig.port = endpoint.port\n'
const DERIVE_BINDING_LINE = '  const binding = normalizeBindingDraft(rawBinding)\n'
const PROJECT_RETURN_LINE = '  return projected\n'
const PROJECT_LOOP_LINE = '  for (const field of EXTERNAL_SYSTEM_PROJECTION_FIELDS) {\n'
const TRUNCATING_COMMENT = '  // the closing } of the config block above\n'

const ESCAPES = Object.freeze([
  // (1) proven escape — a bracket read folded into a condition.
  {
    id: 'bracket-read-in-condition',
    pin: 'system-read-set',
    apply: (source) => anchoredReplace(
      source,
      CRED_LINE,
      CRED_LINE + "    || (system['projectId'] ?? 'd') === '__never__'\n",
    ),
  },
  // (2) proven escape — a bracket read smuggled into the returned connection config.
  {
    id: 'bracket-read-into-connection-config',
    pin: 'system-read-set',
    apply: (source) => anchoredReplace(
      source,
      PORT_LINE,
      PORT_LINE + "  connectionConfig.appName = String(system['name'] ?? 'metasheet')\n",
    ),
  },
  // (3) THE COMMENT-TRUNCATION ESCAPE. (2) preceded by a comment carrying one unbalanced
  // brace. Against the brace counter this was GREEN with the read LIVE.
  {
    id: 'bracket-read-after-truncating-comment',
    pin: 'system-read-set',
    apply: (source) => anchoredReplace(
      source,
      PORT_LINE,
      PORT_LINE + TRUNCATING_COMMENT
      + "  connectionConfig.appName = String(system['name'] ?? 'metasheet')\n",
    ),
  },
  // (4) the DOTTED variant after the same truncation — green too, which is how the
  // truncation defeated the pre-existing dotted read-set assertion as well.
  {
    id: 'dotted-read-after-truncating-comment',
    pin: 'system-read-set',
    apply: (source) => anchoredReplace(
      source,
      PORT_LINE,
      PORT_LINE + TRUNCATING_COMMENT
      + "  connectionConfig.appName = String(system.name ?? 'metasheet')\n",
    ),
  },
  // (5) THE THIRD FRAME — a bracket read off the un-projected, unscreened record.
  {
    id: 'third-frame-bracket-read',
    pin: 'external-system-uses',
    apply: (source) => anchoredReplace(
      source,
      DERIVE_BINDING_LINE,
      DERIVE_BINDING_LINE
      + "  const smuggled = externalSystem && externalSystem['name']\n  void smuggled\n",
    ),
  },
  // The third frame reached WITHOUT any member access — the forms a member-access ban would
  // have missed, and the reason the pin is a use multiset instead.
  {
    id: 'third-frame-destructure',
    pin: 'external-system-uses',
    apply: (source) => anchoredReplace(
      source,
      DERIVE_BINDING_LINE,
      DERIVE_BINDING_LINE + '  const { name } = externalSystem\n  void name\n',
    ),
  },
  {
    id: 'third-frame-spread',
    pin: 'external-system-uses',
    apply: (source) => anchoredReplace(
      source,
      DERIVE_BINDING_LINE,
      DERIVE_BINDING_LINE + '  const copy = { ...externalSystem }\n  void copy\n',
    ),
  },
  {
    id: 'third-frame-value-escape',
    pin: 'external-system-uses',
    apply: (source) => anchoredReplace(
      source,
      DERIVE_BINDING_LINE,
      DERIVE_BINDING_LINE + '  void JSON.stringify(externalSystem)\n',
    ),
  },
  // Plain dotted drift, the case the original regex did catch — it must still RED.
  {
    id: 'dotted-drift',
    pin: 'system-read-set',
    apply: (source) => anchoredReplace(
      source,
      PORT_LINE,
      PORT_LINE + '  connectionConfig.appName = String(system.projectId)\n',
    ),
  },
  // A computed key that names no member statically: not checkable against the list, so it
  // must be refused rather than skipped.
  {
    id: 'dynamic-key-read',
    pin: 'system-dynamic-read',
    apply: (source) => anchoredReplace(
      source,
      PORT_LINE,
      PORT_LINE + '  const key = String(endpoint.database)\n'
      + '  void system[key]\n',
    ),
  },
  // `system` reached through a shape the read-set model does not cover.
  {
    id: 'system-destructure',
    pin: 'system-uses',
    apply: (source) => anchoredReplace(
      source,
      PORT_LINE,
      PORT_LINE + '  const { ...rest } = system\n  void rest\n',
    ),
  },
  // A second use of the raw record inside normalizeExternalSystem, bypassing the projection.
  {
    id: 'normalize-raw-second-use',
    pin: 'normalize-raw-uses',
    apply: (source) => anchoredReplace(
      source,
      PORT_LINE,
      PORT_LINE + '  const bypass = raw\n  void bypass\n',
    ),
  },
  // One frame down: a named member smuggled through the projection, dotted…
  {
    id: 'projection-dotted-smuggle',
    pin: 'projection-member-reads',
    apply: (source) => anchoredReplace(
      source,
      PROJECT_RETURN_LINE,
      '  projected.extra = raw.projectId\n' + PROJECT_RETURN_LINE,
    ),
  },
  // …and bracketed, which the old string-stripping scan needed a separate assertion for.
  {
    id: 'projection-bracket-smuggle',
    pin: 'projection-member-reads',
    apply: (source) => anchoredReplace(
      source,
      PROJECT_RETURN_LINE,
      "  projected['extra'] = raw['projectId']\n" + PROJECT_RETURN_LINE,
    ),
  },
  // The loop idiom neutered: `raw[field]` still looks legitimate while a different set is
  // projected.
  {
    id: 'projection-loop-retargeted',
    pin: 'projection-loop-idiom',
    apply: (source) => anchoredReplace(
      source,
      PROJECT_LOOP_LINE,
      '  for (const field of SOURCE_CONFIG_FIELDS) {\n',
    ),
  },
])

function main() {
  const moduleSource = fs.readFileSync(SOURCE_AUTHORITY_PATH, 'utf8')

  // ── 0. the fixture really is the shape production produces ────────────────────────
  // Assert this BEFORE anything else: if the record under test is not the shape that
  // used to break, every arm below is worthless regardless of whether it passes.
  const dateRecord = adapterRecord(new Date('2026-07-31T00:00:00.000Z'))
  const stringRecord = adapterRecord('2026-07-31T00:00:00.000Z')
  assert.equal(dateRecord.createdAt instanceof Date, true)
  assert.equal(dateRecord.updatedAt instanceof Date, true)
  assert.equal(typeof stringRecord.createdAt, 'string')

  const wholeRecordCodec = canonicalCodec.tryFreezeCanonical(dateRecord)
  assert.equal(wholeRecordCodec.ok, false)
  assert.equal(wholeRecordCodec.violation, 'EXOTIC_OBJECT')
  // ... and the same record with string timestamps is inside the codec's domain, so the
  // refusal above is attributable to Date-ness, not to some other member.
  assert.equal(canonicalCodec.tryFreezeCanonical(stringRecord).ok, true)

  // The adapter record genuinely carries members outside the projection — otherwise
  // "the projection works" would be vacuous.
  const adapterMembers = new Set(Object.keys(dateRecord))
  for (const field of EXTERNAL_SYSTEM_PROJECTION_FIELDS) {
    assert.equal(
      adapterMembers.has(field),
      true,
      'adapter record is missing a projected member: ' + field,
    )
  }
  const outsideProjection = sortedArray(adapterMembers)
    .filter((member) => !EXTERNAL_SYSTEM_PROJECTION_FIELDS.includes(member))
  assert.ok(outsideProjection.length > 0)
  assert.ok(outsideProjection.includes('createdAt'))
  assert.ok(outsideProjection.includes('updatedAt'))

  // ── 1. THE REGRESSION ARM — production-shaped, Date-typed timestamps must resolve ──
  const draft = bindingDraft()
  const derivedFromDates = deriveStockPreparationSqlServerSourceAnchors({
    binding: draft,
    externalSystem: dateRecord,
    identityKey: IDENTITY_KEY,
  })
  const binding = enrolledBinding(draft, derivedFromDates.anchors)
  // resolveStockPreparationSqlServerSource is the entry point production actually calls
  // (stock-preparation-runtime-core.cjs's loadSource()), so the arm drives THAT, not
  // only the anchor-derivation helper underneath it.
  const resolvedFromDates = resolveStockPreparationSqlServerSource({
    binding,
    externalSystem: dateRecord,
    identityKey: IDENTITY_KEY,
  })
  assert.equal(resolvedFromDates.connectionConfig.password, SECRET)
  assert.equal(resolvedFromDates.connectionConfig.options.readOnlyIntent, true)
  assert.equal(resolvedFromDates.authority.tenantId, TENANT_ID)
  assert.equal(resolvedFromDates.authority.workspaceId, null)

  // ── 2. POSITIVE CONTROL — the same path with string timestamps must ALSO resolve ───
  const resolvedFromStrings = resolveStockPreparationSqlServerSource({
    binding,
    externalSystem: stringRecord,
    identityKey: IDENTITY_KEY,
  })
  // Same binding row, same anchors: the timestamps contribute nothing to any anchor,
  // which is exactly why projecting them away is value-preserving rather than a
  // silent change of what gets signed.
  assert.deepEqual(resolvedFromStrings.anchors, resolvedFromDates.anchors)
  assert.deepEqual(resolvedFromStrings.authority, resolvedFromDates.authority)

  // ── 3. NEGATIVE CONTROL — remove the projection, the Date record must REFUSE again ─
  // Compiled IN MEMORY. Nothing is written into lib/sealed-export/ — a mutant left on
  // disk is worse than no mutation test at all.
  const NEEDLE = 'ownedCanonical(projectExternalSystem(raw))'
  assert.equal(
    moduleSource.split(NEEDLE).length - 1,
    1,
    'the projection call site is not present exactly once — the negative control ' +
    'would mutate the wrong thing (or nothing)',
  )
  const mutatedSource = moduleSource.replace(NEEDLE, 'ownedCanonical(raw)')
  assert.notEqual(
    mutatedSource,
    moduleSource,
    'mutation produced a byte-identical module — the negative control would prove nothing',
  )
  const mutant = new Module(SOURCE_AUTHORITY_PATH, module)
  mutant.filename = SOURCE_AUTHORITY_PATH
  mutant.paths = Module._nodeModulePaths(path.dirname(SOURCE_AUTHORITY_PATH))
  mutant._compile(mutatedSource, SOURCE_AUTHORITY_PATH)
  const unprojected = mutant.exports

  refuses(() => unprojected.resolveStockPreparationSqlServerSource({
    binding,
    externalSystem: dateRecord,
    identityKey: IDENTITY_KEY,
  }))
  // ... and the SAME mutant still resolves the string-timestamp record. Without this,
  // the negative control could be firing because the mutant is broken in general.
  const mutantOnStrings = unprojected.resolveStockPreparationSqlServerSource({
    binding,
    externalSystem: stringRecord,
    identityKey: IDENTITY_KEY,
  })
  assert.deepEqual(mutantOnStrings.anchors, resolvedFromDates.anchors)

  // The real module, re-read from disk, is untouched by the mutation.
  assert.equal(fs.readFileSync(SOURCE_AUTHORITY_PATH, 'utf8'), moduleSource)

  // ── 4. PROJECTION DRIFT PIN — over a real parse of the module's own source ─────────
  // The pins themselves are defined above runProjectionPins(); this is where the REAL
  // module is held to them. It must pass, and every self-test below must fail — both
  // directions are required, because "everything passes" and "the pins are decorative"
  // are otherwise indistinguishable.
  const liveReport = runProjectionPins(moduleSource)
  assert.deepEqual(liveReport.failures, [])

  // 4a. SELF-TESTS. Every pin has at least one entry here. Each applies a mutation to the
  // module source IN MEMORY, and asserts the pin fires — matched on `pinId` by strict
  // equality, never on message text, so no pin can be covered for by another that happens
  // to share a word. Deleting, renaming or weakening a pin REDs its own self-test, because
  // then nothing throws.
  const firedPins = new Set()
  for (const escape of ESCAPES) {
    const mutated = escape.apply(moduleSource)
    assert.notEqual(
      mutated,
      moduleSource,
      'self-test mutation produced a byte-identical module — it would prove nothing: '
      + escape.id,
    )
    let caught = null
    try {
      runProjectionPins(mutated)
    } catch (error) {
      caught = error
    }
    assert.ok(
      caught !== null,
      'the drift pins did not notice a proven escape — they are decorative: ' + escape.id,
    )
    // Strict equality on the id, not a substring of the message: several pins share
    // vocabulary, and a substring match would let one pin's red be read as another's.
    assert.equal(
      caught.pinId,
      escape.pin,
      'escape ' + escape.id + ' fired the wrong pin (' + String(caught.pinId)
      + ' instead of ' + escape.pin + ') — an incidental red is not a pin',
    )
    firedPins.add(escape.pin)
  }

  // ...and every pin the battery declares is exercised by at least one self-test. A pin
  // nothing tests is exactly the defect this section exists to fix.
  assert.deepEqual(
    sortedArray(firedPins),
    [
      'external-system-uses',
      'normalize-raw-uses',
      'projection-loop-idiom',
      'projection-member-reads',
      'system-dynamic-read',
      'system-read-set',
      'system-uses',
    ],
    'a declared pin has no self-test proving it can fire',
  )

  // 4b. PARSE-FAILURE CONTROLS. A scanner that reports "zero findings" when it could not
  // read its input is worse than no scanner, so every way the read can fail must produce a
  // FAILURE and never an empty read set. `functions === null` rather than `{}` is what makes
  // that structural: a caller that skipped the failure check would crash, not pass.
  const parseControls = [
    {
      id: 'parser-throws',
      expect: 'SOURCE_PARSE_FAILED',
      parseOverride: () => { throw new Error('parser exploded') },
    },
    {
      id: 'parser-returns-non-object',
      expect: 'SOURCE_PARSE_FAILED',
      parseOverride: () => null,
    },
    {
      id: 'diagnostics-not-observable',
      expect: 'SOURCE_PARSE_UNVERIFIABLE',
      parseOverride: () => ({ forEachChild() {} }),
    },
    {
      id: 'source-not-walkable',
      expect: 'SOURCE_PARSE_UNVERIFIABLE',
      parseOverride: () => ({ parseDiagnostics: [] }),
    },
  ]
  for (const control of parseControls) {
    const report = analyzeModuleSource({
      name: 'control',
      text: moduleSource,
      parseOverride: control.parseOverride,
    })
    assert.deepEqual(
      report.failures.map((failure) => failure.checkId),
      [control.expect],
      'parse-failure control did not fail closed: ' + control.id,
    )
    // The load-bearing half: NOT an empty read set.
    assert.equal(report.functions, null, 'control ' + control.id + ' exposed functions')
    assert.equal(report.occurrences, null, 'control ' + control.id + ' exposed occurrences')
    let caught = null
    try {
      runProjectionPins(moduleSource, { parseOverride: control.parseOverride })
    } catch (error) {
      caught = error
    }
    assert.ok(caught !== null, 'control ' + control.id + ' did not red the pins')
    assert.equal(caught.pinId, 'report-clean')
  }

  // The same door with the REAL parser and genuinely unparseable text. Asserted separately
  // because the TypeScript JS parser is aggressively error-tolerant: if the sample below
  // parsed clean this control would be decorative, which is the very defect being fixed.
  const UNPARSEABLE = 'function projectExternalSystem(raw) {\n  const x = ((( ]]]\n'
  const unparseableReport = analyzeModuleSource({ name: 'control', text: UNPARSEABLE })
  assert.deepEqual(
    unparseableReport.failures.map((failure) => failure.checkId),
    ['SOURCE_PARSE_FAILED'],
    'unparseable source did not fail closed — it reported a clean, empty scan',
  )
  assert.equal(unparseableReport.functions, null)
  assert.equal(unparseableReport.occurrences, null)

  // Positive control for the controls: the SAME analyzer on the REAL source reads cleanly.
  // Without it, an analyzer that failed on everything would satisfy every assertion above.
  assert.deepEqual(liveReport.failures, [])
  assert.notEqual(liveReport.functions, null)
  assert.equal(typeof liveReport.functions.normalizeExternalSystem, 'object')
  assert.equal(typeof liveReport.functions.projectExternalSystem, 'object')

  // A missing source text is also a failure, not an empty scan.
  const noTextReport = analyzeModuleSource({ name: 'control' })
  assert.deepEqual(
    noTextReport.failures.map((failure) => failure.checkId),
    ['SOURCE_UNREADABLE'],
  )
  assert.equal(noTextReport.functions, null)

  // ...and an identifier lookup that finds nothing THROWS rather than returning an empty
  // multiset, so a renamed receiver cannot make a use-allowlist pin pass vacuously.
  assert.throws(
    () => occurrencesOf(liveReport, 'noSuchIdentifierAnywhere'),
    /never occurs in the source/,
  )
  assert.throws(
    () => occurrencesOf(liveReport, 'system', 'noSuchFunction'),
    /never occurs in/,
  )

  // ── 5. PROJECTION DRIFT PIN (side B) — nothing listed may be unread ────────────────
  // Iterates the EXPORTED list, never a literal copy of it: adding a ninth member makes
  // this loop run a ninth arm, and poisoning a member nothing reads produces no refusal,
  // so the new arm REDs. One uniform, canonical-SAFE poison for every field, so each
  // refusal is attributable to an identity/shape check rather than to the codec.
  const POISON = 's6a-projection-poison'
  assert.equal(canonicalCodec.tryCanonicalJson(POISON).ok, true)
  for (const field of EXTERNAL_SYSTEM_PROJECTION_FIELDS) {
    const poisoned = adapterRecord(new Date('2026-07-31T00:00:00.000Z'))
    poisoned[field] = POISON
    refuses(() => resolveStockPreparationSqlServerSource({
      binding,
      externalSystem: poisoned,
      identityKey: IDENTITY_KEY,
    }))
  }

  // Mirror image: poisoning a member OUTSIDE the projection — with a value the codec
  // refuses outright — must not disturb the walk. This is the defect itself, generalised
  // over every non-projected member rather than only createdAt/updatedAt.
  for (const field of outsideProjection) {
    const poisoned = adapterRecord(new Date('2026-07-31T00:00:00.000Z'))
    poisoned[field] = new Map([['exotic', 'value']])
    const stillResolves = resolveStockPreparationSqlServerSource({
      binding,
      externalSystem: poisoned,
      identityKey: IDENTITY_KEY,
    })
    assert.deepEqual(stillResolves.anchors, resolvedFromDates.anchors)
  }

  // ── 6. the container is still screened as strictly as before ──────────────────────
  // The projection reads whitelisted keys off `raw`, so the strict-plain-object
  // predicate MUST still run on the container first, or proxies/accessors/symbol keys
  // would slip past a check that used to be performed by canonicalising the whole
  // record.
  const hostileAccessor = adapterRecord(new Date('2026-07-31T00:00:00.000Z'))
  delete hostileAccessor.kind
  Object.defineProperty(hostileAccessor, 'kind', {
    configurable: true,
    enumerable: true,
    get() { return CONNECTOR_KIND },
  })
  refuses(() => resolveStockPreparationSqlServerSource({
    binding,
    externalSystem: hostileAccessor,
    identityKey: IDENTITY_KEY,
  }))

  const proxied = new Proxy(adapterRecord(new Date('2026-07-31T00:00:00.000Z')), {})
  refuses(() => resolveStockPreparationSqlServerSource({
    binding,
    externalSystem: proxied,
    identityKey: IDENTITY_KEY,
  }))

  const symbolKeyed = adapterRecord(new Date('2026-07-31T00:00:00.000Z'))
  symbolKeyed[Symbol('s6a')] = 'x'
  refuses(() => resolveStockPreparationSqlServerSource({
    binding,
    externalSystem: symbolKeyed,
    identityKey: IDENTITY_KEY,
  }))

  const nonEnumerable = adapterRecord(new Date('2026-07-31T00:00:00.000Z'))
  Object.defineProperty(nonEnumerable, 'hidden', {
    configurable: true,
    enumerable: false,
    value: 'x',
    writable: true,
  })
  refuses(() => resolveStockPreparationSqlServerSource({
    binding,
    externalSystem: nonEnumerable,
    identityKey: IDENTITY_KEY,
  }))

  refuses(() => resolveStockPreparationSqlServerSource({
    binding,
    externalSystem: null,
    identityKey: IDENTITY_KEY,
  }))

  // ── 7. nested exotics inside a PROJECTED member still refuse ──────────────────────
  // The projection narrows WHICH members are canonicalised, not HOW deeply. Everything
  // this module actually consumes still goes through the codec unchanged.
  const nestedExotic = adapterRecord(new Date('2026-07-31T00:00:00.000Z'))
  nestedExotic.config[SOURCE_CONFIG_KEY].instanceName = new Date('2026-07-31T00:00:00.000Z')
  refuses(() => resolveStockPreparationSqlServerSource({
    binding,
    externalSystem: nestedExotic,
    identityKey: IDENTITY_KEY,
  }))

  const nestedExoticCredentials = adapterRecord(new Date('2026-07-31T00:00:00.000Z'))
  nestedExoticCredentials.credentials[SOURCE_CONFIG_KEY].user =
    new Date('2026-07-31T00:00:00.000Z')
  refuses(() => resolveStockPreparationSqlServerSource({
    binding,
    externalSystem: nestedExoticCredentials,
    identityKey: IDENTITY_KEY,
  }))

  // ── 8. absent workspaceId keeps its pre-projection meaning ────────────────────────
  // The projection copies OWN properties only, so an absent workspaceId still reaches
  // the `?? null` comparison as undefined rather than being written into the projection
  // as an undefined value the codec would refuse.
  const withoutWorkspace = adapterRecord(new Date('2026-07-31T00:00:00.000Z'))
  delete withoutWorkspace.workspaceId
  const resolvedWithoutWorkspace = resolveStockPreparationSqlServerSource({
    binding,
    externalSystem: withoutWorkspace,
    identityKey: IDENTITY_KEY,
  })
  assert.deepEqual(resolvedWithoutWorkspace.anchors, resolvedFromDates.anchors)

  // An absent `credentials` member must still refuse, exactly as before.
  const withoutCredentials = adapterRecord(new Date('2026-07-31T00:00:00.000Z'))
  delete withoutCredentials.credentials
  refuses(() => resolveStockPreparationSqlServerSource({
    binding,
    externalSystem: withoutCredentials,
    identityKey: IDENTITY_KEY,
  }))

  console.log('sealed-export-s6a-source-authority-adapter-projection.test.cjs OK')
}

main()
