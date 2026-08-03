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

// ── module-source extraction (used by the drift pin) ─────────────────────────────────
// Brace-matched extraction of one function BODY (excluding the signature, so the
// parameter names themselves are not counted as reads). Self-tested below — an
// extractor that silently matches nothing reads as green, which is the whole failure
// mode this pin exists to avoid.
function functionBody(source, signature) {
  const start = source.indexOf(signature)
  assert.notEqual(start, -1, 'signature not found in module source: ' + signature)
  assert.equal(
    source.indexOf(signature, start + 1),
    -1,
    'signature is not unique in module source: ' + signature,
  )
  const open = source.indexOf('{', start + signature.length - 1)
  assert.notEqual(open, -1, 'no opening brace after signature: ' + signature)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, index)
    }
  }
  throw new Error('unbalanced braces after signature: ' + signature)
}

function memberReads(body, receiver) {
  const pattern = new RegExp('\\b' + receiver + '\\.([A-Za-z_$][A-Za-z0-9_$]*)', 'g')
  const found = new Set()
  let match = pattern.exec(body)
  while (match !== null) {
    found.add(match[1])
    match = pattern.exec(body)
  }
  return found
}

function sortedArray(set) {
  return [...set].sort()
}

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

  // ── 4. PROJECTION DRIFT PIN (side A) — nothing read may be missing from the list ───
  // Derived from the module's own source, never from a second hand-written list. If
  // normalizeExternalSystem() starts reading a ninth member, this REDs instead of the
  // member being silently dropped.
  const normalizeBody = functionBody(
    moduleSource,
    'function normalizeExternalSystem(raw, binding) {',
  )
  const reads = memberReads(normalizeBody, 'system')
  assert.deepEqual(
    sortedArray(reads),
    [...EXTERNAL_SYSTEM_PROJECTION_FIELDS].sort(),
    'members read off the projected external system have drifted from ' +
    'EXTERNAL_SYSTEM_PROJECTION_FIELDS',
  )

  // Extractor self-test: a regex that matches nothing would make the assertion above
  // pass vacuously for an empty list, and adding a read must actually be detected.
  assert.equal(reads.size, EXTERNAL_SYSTEM_PROJECTION_FIELDS.length)
  assert.ok(reads.size > 0)
  const driftedReads = memberReads(
    normalizeBody + '\n  const drift = system.projectId\n',
    'system',
  )
  assert.notDeepEqual(
    sortedArray(driftedReads),
    [...EXTERNAL_SYSTEM_PROJECTION_FIELDS].sort(),
    'the read-set extractor did not notice an added read — it is decorative',
  )

  // The raw record must be touched exactly once inside normalizeExternalSystem(), by
  // the projection itself. A future direct read off `raw` would bypass the projection
  // entirely and the read-set assertion above would not see it.
  const rawMentions = normalizeBody.match(/\braw\b/g) || []
  assert.deepEqual(
    rawMentions,
    ['raw'],
    'the raw external-system record is referenced more than once inside ' +
    'normalizeExternalSystem() — something reads it outside the projection',
  )
  // Same hazard one frame up: nothing may read a member off the un-projected value
  // before it reaches normalizeExternalSystem().
  assert.equal(
    /\bexternalSystem\s*\./.test(moduleSource),
    false,
    'a member is read directly off the un-projected externalSystem argument',
  )

  // ...and one frame DOWN. The projection function itself is the last place an unlisted
  // member could be smuggled in (`projected.extra = raw.projectId`), and the read-set
  // scan above never looks at its body. It must touch `raw` ONLY through
  // hasOwnProperty.call(raw, field) and raw[field] — never a dotted member access.
  const projectionBody = functionBody(
    moduleSource,
    'function projectExternalSystem(raw) {',
  )
  assert.equal(
    /\braw\s*\.\s*[A-Za-z_$]/.test(projectionBody),
    false,
    'projectExternalSystem() reads a named member off the raw record — that member would '
    + 'bypass EXTERNAL_SYSTEM_PROJECTION_FIELDS entirely',
  )
  assert.deepEqual(
    sortedArray(memberReads(projectionBody, 'projected')),
    [],
    'projectExternalSystem() writes or reads a NAMED member on the projection — every '
    + 'member must go through the EXTERNAL_SYSTEM_PROJECTION_FIELDS loop',
  )
  // Extractor self-test for this body too: an added dotted read must be detected.
  assert.equal(
    /\braw\s*\.\s*[A-Za-z_$]/.test(`${projectionBody}\n  projected.extra = raw.projectId\n`),
    true,
    'the projection-body scan did not notice a smuggled member read — it is decorative',
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
