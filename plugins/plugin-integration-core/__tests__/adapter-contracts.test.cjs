'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const {
  AdapterContractError,
  AdapterValidationError,
  UnsupportedAdapterOperationError,
  assertAdapterContract,
  createAdapterRegistry,
  createReadResult,
  createUpsertResult,
  normalizeReadRequest,
  normalizeUpsertRequest,
  unsupportedAdapterOperation,
  hasTargetWriteLifecycle,
  assertTargetWriteLifecycle,
  createLookupResult,
  createApplyResult,
} = require(path.join(__dirname, '..', 'lib', 'contracts.cjs'))

function createCompleteAdapter() {
  return {
    async testConnection() { return { ok: true } },
    async listObjects() { return [] },
    async getSchema() { return { fields: [] } },
    async read() { return createReadResult({ records: [] }) },
    async upsert() { return createUpsertResult({ written: 0 }) },
  }
}

async function main() {
  // --- 1. Registry accepts complete adapter factories -------------------
  const registry = createAdapterRegistry()
  registry.registerAdapter('http', ({ system }) => ({
    ...createCompleteAdapter(),
    systemId: system.id,
  }))

  assert.deepEqual(registry.listAdapterKinds(), ['http'])
  const adapter = registry.createAdapter({
    id: 'sys_http',
    name: 'HTTP PLM',
    kind: 'http',
    config: { baseUrl: 'https://plm.example.test' },
  })
  assert.equal(adapter.systemId, 'sys_http')

  // --- 2. Registry rejects duplicate kinds unless replace is explicit ----
  let duplicate = null
  try {
    registry.registerAdapter('http', () => createCompleteAdapter())
  } catch (error) {
    duplicate = error
  }
  assert.ok(duplicate instanceof AdapterValidationError, 'duplicate adapter kind rejected')

  registry.registerAdapter('http', () => createCompleteAdapter(), { replace: true })
  assert.deepEqual(registry.listAdapterKinds(), ['http'])

  // --- 3. Factory output must satisfy the full adapter contract ----------
  registry.registerAdapter('broken', () => ({ testConnection: async () => ({ ok: true }) }))
  let broken = null
  try {
    registry.createAdapter({ kind: 'broken', config: {} })
  } catch (error) {
    broken = error
  }
  assert.ok(broken instanceof AdapterContractError, 'missing adapter methods rejected')
  assert.match(broken.message, /missing listObjects/)

  // --- 4. Unknown kinds throw a typed unsupported error ------------------
  let unknown = null
  try {
    registry.createAdapter({ kind: 'erp:k3-wise-webapi', config: {} })
  } catch (error) {
    unknown = error
  }
  assert.ok(unknown instanceof UnsupportedAdapterOperationError, 'unknown adapter kind rejected')

  // --- 5. Request/result normalizers keep runner inputs predictable ------
  const read = normalizeReadRequest({
    object: 'materials',
    limit: 50000,
    cursor: 'c1',
    filters: { status: 'approved' },
    watermark: { updated_at: '2026-04-24T00:00:00Z' },
    watermarkConfig: { type: 'updated_at', field: 'updated_at', tiebreaker: 'id' },
  })
  assert.equal(read.object, 'materials')
  assert.equal(read.limit, 10000, 'read limit is capped')
  assert.equal(read.cursor, 'c1')
  assert.deepEqual(read.filters, { status: 'approved' })
  assert.deepEqual(
    read.watermarkConfig,
    { type: 'updated_at', field: 'updated_at', tiebreaker: 'id' },
    'read normalizer preserves the resolved watermarkConfig payload for C3 adapters',
  )

  const upsert = normalizeUpsertRequest({
    object: 'materials',
    records: [{ code: 'A-01' }],
    keyFields: ['code'],
  })
  assert.deepEqual(upsert.records, [{ code: 'A-01' }])
  assert.deepEqual(upsert.keyFields, ['code'])
  assert.equal(upsert.mode, 'upsert')

  const readResult = createReadResult({ records: [{ code: 'A-01' }], nextCursor: null })
  assert.equal(readResult.done, true)
  assert.equal(readResult.records.length, 1)

  const upsertResult = createUpsertResult({ written: 1, results: [{ id: 'k3_1' }] })
  assert.equal(upsertResult.written, 1)
  assert.equal(upsertResult.failed, 0)
  const stringCounts = createUpsertResult({ written: '2', skipped: '1', failed: '0' })
  assert.equal(stringCounts.written, 2)
  assert.equal(stringCounts.skipped, 1)
  assert.equal(stringCounts.failed, 0)
  for (const [field, value] of [
    ['written', -1],
    ['written', 1.5],
    ['skipped', Number.POSITIVE_INFINITY],
    ['failed', Number.NaN],
  ]) {
    assert.throws(() => createUpsertResult({ [field]: value }), AdapterContractError, `${field}=${String(value)} rejected`)
  }

  // --- 6. Unsupported operation helper preserves typed failures ----------
  let unsupported = null
  try {
    await unsupportedAdapterOperation('http', 'stream')()
  } catch (error) {
    unsupported = error
  }
  assert.ok(unsupported instanceof UnsupportedAdapterOperationError, 'unsupported operation throws typed error')

  // --- 7. OPTIONAL target-write lifecycle: base 5-method contract UNCHANGED -
  // A complete adapter WITHOUT the optional capability still passes the contract
  // and is detected as not-opted-in (design-lock §6.1 acceptance #1).
  const plain = createCompleteAdapter()
  assertAdapterContract(plain, 'plain')
  assert.equal(hasTargetWriteLifecycle(plain), false, 'plain adapter is not opted in')
  assert.equal(assertTargetWriteLifecycle(plain, 'plain'), null, 'non-opt-in: nothing to assert')
  registry.registerAdapter('plain', () => createCompleteAdapter())
  registry.createAdapter({ kind: 'plain', config: {} }) // no throw — the capability is optional

  // --- 8. Opt-in target validates; a PARTIAL lifecycle is rejected ---------
  const optIn = {
    ...createCompleteAdapter(),
    targetWriteLifecycle: {
      async lookup() { return createLookupResult({ matches: [] }) },
      async apply() { return createApplyResult({ rows: [] }) },
    },
  }
  assert.equal(hasTargetWriteLifecycle(optIn), true)
  assert.ok(assertTargetWriteLifecycle(optIn, 'optIn'), 'full opt-in lifecycle validates')
  const partial = { ...createCompleteAdapter(), targetWriteLifecycle: { async lookup() { return createLookupResult({}) } } }
  assert.throws(() => assertTargetWriteLifecycle(partial, 'partial'), /missing apply/, 'partial lifecycle rejected')

  // --- 9. apply result status is ENUM-STRICT (design-lock §6.1 acceptance #2) -
  assert.throws(
    () => createApplyResult({ rows: [{ key: { id: 'a' }, status: 'definitely-wrong' }] }),
    /status must be one of/,
    'unknown apply status rejected',
  )
  const okApply = createApplyResult({
    rows: [{ key: { id: 'a' }, status: 'written' }, { key: { id: 'b' }, status: 'held' }],
    written: 1, held: 1,
  })
  assert.equal(okApply.rows.length, 2)
  assert.equal(okApply.rows[0].index, 0, 'row index defaults to position')

  // --- 10. VALUES-FREE across EVERY free-string vector (design-lock §6.1 acceptance #3) -
  // Plant PII/secret canaries INSIDE the key (a natural key can BE PII), inside the free-text
  // error (DB errors embed row values), as a raw revision token, and as metadata — the result
  // must carry ONLY opaque keyHash/revisionHash + enum status + code-only errorCode + number/
  // boolean/null metadata.
  const apply = createApplyResult({
    keyFields: ['id'],
    rows: [{
      key: { id: 'a', ssn: '123-45-6789', password: 'p@ss' },
      status: 'failed',
      errorCode: '42501', // all-digit Postgres SQLSTATE — a legitimate values-free code
      error: 'duplicate key violates unique constraint, DETAIL: (email)=(alice@example.com)',
    }],
    failed: 1,
  })
  const applyWire = JSON.stringify(apply)
  for (const leak of ['123-45-6789', 'p@ss', '"ssn"', '"key"', 'alice@example.com', 'duplicate key', '"error"']) {
    assert.ok(!applyWire.includes(leak), `apply result must not carry ${leak} (values-free)`)
  }
  assert.match(apply.rows[0].keyHash, /^[a-f0-9]{64}$/, 'apply row carries an opaque keyHash, not the raw key')
  assert.equal(apply.rows[0].errorCode, '42501', 'all-digit SQLSTATE code preserved')
  assert.equal(apply.rows[0].status, 'failed')
  assert.equal('error' in apply.rows[0], false, 'free-text error dropped from the result (values-free)')

  // errorCode is code-only: a data-shaped errorCode (email / part number / free text) is rejected.
  for (const badCode of ['alice@example.com', 'P-001', 'Customer Name', 'a-b']) {
    assert.throws(
      () => createApplyResult({ rows: [{ key: { id: 'a' }, status: 'failed', errorCode: badCode }], failed: 1 }),
      /stable code/,
      `data-shaped errorCode ${JSON.stringify(badCode)} rejected`,
    )
  }

  // metadata is number|boolean|null only — a nested object OR a free string (which could hide a
  // row value) is rejected; counts/flags/null are preserved.
  assert.throws(
    () => createApplyResult({ rows: [], metadata: { mode: 'append', leak: { col: 'submitted' } } }),
    /number\|boolean\|null \(values-free\)/,
    'nested apply metadata rejected',
  )
  assert.throws(
    () => createApplyResult({ rows: [], metadata: { customer: 'Acme Inc' } }),
    /number\|boolean\|null \(values-free\)/,
    'free-string apply metadata rejected (could carry a row value)',
  )
  const okMeta = createApplyResult({ rows: [], metadata: { matchedCount: 5, truncated: true, nothing: null } })
  assert.deepEqual(okMeta.metadata, { matchedCount: 5, truncated: true, nothing: null }, 'count/flag/null metadata preserved')

  const lookup = createLookupResult({
    keyFields: ['id'],
    matches: [{ key: { id: 'a', email: 'pii@example.test' }, exists: true, revision: 'Acme Corp Ltd rev-7' }],
  })
  const lookupWire = JSON.stringify(lookup)
  for (const leak of ['pii@example.test', '"email"', '"key"', 'Acme Corp Ltd', 'rev-7']) {
    assert.ok(!lookupWire.includes(leak), `lookup result must not carry ${leak} (values-free)`)
  }
  assert.match(lookup.matches[0].keyHash, /^[a-f0-9]{64}$/, 'lookup match carries an opaque keyHash')
  assert.match(lookup.matches[0].revisionHash, /^[a-f0-9]{64}$/, 'revision carried only as an opaque revisionHash')

  // revisionHash preserves EQUALITY so the dry-run→apply revision-fence still detects drift.
  const revV1a = createLookupResult({ matches: [{ key: { id: 'a' }, exists: true, revision: 'v1' }] }).matches[0].revisionHash
  const revV1b = createLookupResult({ matches: [{ key: { id: 'b' }, exists: true, revision: 'v1' }] }).matches[0].revisionHash
  const revV2 = createLookupResult({ matches: [{ key: { id: 'c' }, exists: true, revision: 'v2' }] }).matches[0].revisionHash
  assert.equal(revV1a, revV1b, 'equal revisions hash equal (fence sees no drift)')
  assert.notEqual(revV1a, revV2, 'different revisions hash different (fence sees drift)')
  assert.equal(
    createLookupResult({ matches: [{ key: { id: 'a' }, exists: false }] }).matches[0].revisionHash,
    null,
    'absent revision → null revisionHash',
  )
  assert.throws(
    () => createLookupResult({ matches: [], metadata: { nested: { x: 1 } } }),
    /number\|boolean\|null \(values-free\)/,
    'nested lookup metadata rejected',
  )

  console.log('✓ adapter-contracts: registry + normalizer + optional target-write lifecycle tests passed')
}

main().catch((err) => {
  console.error('✗ adapter-contracts FAILED')
  console.error(err)
  process.exit(1)
})
